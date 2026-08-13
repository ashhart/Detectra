#!/usr/bin/env python
"""Fine-tune the Detectra detector on modern generators with web-realism aug.

Starts from the Community Forensics ViT-S/16 @384 checkpoint and fine-tunes on:
  - modern-generator fakes (HiDream, Recraft, Midjourney, DALL-E 3, Flux/SD3.5,
    WildRF-train fakes) — the generators that defeat existing detectors
  - reals: COCO + WildRF-train reals
  - a replay slice of CommunityForensics-Small to preserve the base model's
    breadth across 4,800 generators (guards against catastrophic forgetting)

Holdout discipline: rapid_4o and rapid_ideogram are NEVER trained on — they are
the unseen-generator validation. WildRF test is never touched by training or
calibration.

Web-realism augmentation (applied on the fly):
  random JPEG (q 30–95, sometimes twice), random downscale-upscale chains with
  random interpolation, random crop to 384, flips.

Usage:
  tools/.venv/bin/python tools/train.py --epochs 2 --batch 16
  tools/.venv/bin/python tools/train.py --dry-run   # one batch sanity check
"""
import argparse
import io
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from export_onnx import build_model  # noqa: E402

EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
HOLDOUT_PREFIXES = ("rapid_4o", "rapid_ideogram")  # never trained on


# ----------------------------------------------------------- data -----------

import re

def collect(split_dirs, even_only=False):
    """[(path, label)] from {dir: label} mapping, skipping holdouts.

    even_only: for dirs shared with the benchmark (eval/data/val), take only
    even-indexed files per source — odd indices stay unseen for evaluation
    (see eval/make_eval_split.py). Contamination guard.
    """
    items = []
    for d, label in split_dirs.items():
        d = Path(d)
        if not d.is_dir():
            print(f"  WARN missing dir {d}")
            continue
        for f in d.rglob("*"):
            if f.suffix.lower() not in EXTS or f.name.startswith(HOLDOUT_PREFIXES):
                continue
            if even_only:
                m = re.search(r"_(\d+)\.\w+$", f.name)
                if m and int(m.group(1)) % 2 == 1:
                    continue
            items.append((f, label))
    return items


class WebRealismDataset(Dataset):
    def __init__(self, items, crop=384, train=True):
        self.items = items
        self.crop = crop
        self.train = train

    def __len__(self):
        return len(self.items)

    def _augment(self, img: Image.Image) -> Image.Image:
        rng = random
        # random resize chain (web images get thumbnailed/re-upscaled)
        if rng.random() < 0.7:
            w, h = img.size
            s = rng.uniform(0.35, 1.0)
            interp = rng.choice([Image.NEAREST, Image.BILINEAR, Image.BICUBIC, Image.LANCZOS])
            img = img.resize((max(64, int(w * s)), max(64, int(h * s))), interp)
            if rng.random() < 0.5:
                interp2 = rng.choice([Image.BILINEAR, Image.BICUBIC])
                img = img.resize((w, h), interp2)
        # JPEG recompression, occasionally double
        for _ in range(1 + (rng.random() < 0.25)):
            if rng.random() < 0.8:
                buf = io.BytesIO()
                img.convert("RGB").save(buf, "JPEG", quality=rng.randint(30, 95))
                buf.seek(0)
                img = Image.open(buf)
        return img

    def __getitem__(self, i):
        path, label = self.items[i]
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            return self[(i + 1) % len(self)]
        crop = self.crop
        if self.train:
            img = self._augment(img)
            # resize shortest edge to [crop, crop*1.35] then random crop
            w, h = img.size
            target = random.randint(crop, int(crop * 1.35))
            sc = target / min(w, h)
            img = img.resize((max(crop, round(w * sc)), max(crop, round(h * sc))), Image.BILINEAR)
            w, h = img.size
            x = random.randint(0, w - crop)
            y = random.randint(0, h - crop)
            img = img.crop((x, y, x + crop, y + crop))
            if random.random() < 0.5:
                img = img.transpose(Image.FLIP_LEFT_RIGHT)
        else:
            w, h = img.size
            sc = 440 / min(w, h)
            img = img.resize((max(crop, round(w * sc)), max(crop, round(h * sc))), Image.BILINEAR)
            w, h = img.size
            img = img.crop(((w - crop) // 2, (h - crop) // 2, (w - crop) // 2 + crop, (h - crop) // 2 + crop))
        x = np.asarray(img, dtype=np.float32) / 255.0
        x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        return torch.from_numpy(x.transpose(2, 0, 1)), torch.tensor([float(label)])


# ----------------------------------------------------------- train ----------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(ROOT / "tools/weights/commfor-384/model.safetensors"))
    ap.add_argument("--out", default=str(ROOT / "tools/weights/detectra-ft"))
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--replay-dir", default=str(ROOT / "eval/data/cf_replay"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"device: {device}")

    train_items = collect({
        ROOT / "eval/data/val/ai": 1,          # modern gens (minus holdouts)
        ROOT / "eval/data/val/real": 0,        # COCO
        ROOT / "eval/data/val/art_reals/real": 0,  # human art — TNR guard
    }, even_only=True)                          # odd indices reserved for eval
    train_items += collect({
        ROOT / "eval/data/WildRF/train/1_fake": 1,
        ROOT / "eval/data/WildRF/train/0_real": 0,
    })
    replay = collect({Path(args.replay_dir) / "ai": 1, Path(args.replay_dir) / "real": 0})
    train_items += replay
    random.seed(7)
    random.shuffle(train_items)
    n_ai = sum(1 for _, l in train_items if l == 1)
    print(f"train: {len(train_items)} images ({n_ai} ai / {len(train_items) - n_ai} real; replay {len(replay)})")

    val_items = collect({
        ROOT / "eval/data/WildRF/val/1_fake": 1,
        ROOT / "eval/data/WildRF/val/0_real": 0,
    })
    # holdout generators go in explicitly (collect() filters them from train)
    for f in (ROOT / "eval/data/val/ai").glob("rapid_4o_*"):
        val_items.append((f, 1))
    for f in (ROOT / "eval/data/val/ai").glob("rapid_ideogram_*"):
        val_items.append((f, 1))
    # odd-indexed human art (never trained) — watch the art-TNR blind spot
    import re as _re
    for f in (ROOT / "eval/data/val/art_reals/real").glob("*.jpg"):
        m = _re.search(r"_(\d+)\.", f.name)
        if m and int(m.group(1)) % 2 == 1:
            val_items.append((f, 0))
    print(f"val: {len(val_items)} images")

    model = build_model()
    from safetensors.torch import load_file, save_file

    state = load_file(args.weights)
    if any(k.startswith("vit.") for k in state):
        state = {k.removeprefix("vit."): v for k, v in state.items()}
    model.load_state_dict(state, strict=True)
    model.to(device).train()

    dl = DataLoader(WebRealismDataset(train_items), batch_size=args.batch, shuffle=True,
                    num_workers=6, drop_last=True, persistent_workers=True)
    vdl = DataLoader(WebRealismDataset(val_items, train=False), batch_size=args.batch,
                     shuffle=False, num_workers=4)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = len(dl) * args.epochs
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=steps)
    lossfn = nn.BCEWithLogitsLoss()

    def validate():
        model.eval()
        logits, labels = [], []
        with torch.no_grad():
            for x, y in vdl:
                out = model(x.to(device)).float().cpu()
                logits.append(out)
                labels.append(y)
        model.train()
        lg = torch.cat(logits).squeeze(1).numpy()
        lb = torch.cat(labels).squeeze(1).numpy()
        p = 1 / (1 + np.exp(-lg))
        ths = np.quantile(p, np.linspace(0.02, 0.98, 97))
        bas = [((p[lb == 1] >= t).mean() + (p[lb == 0] < t).mean()) / 2 for t in ths]
        i = int(np.argmax(bas))
        ba65 = ((p[lb == 1] >= 0.65).mean() + (p[lb == 0] < 0.65).mean()) / 2
        print(f"  val BA@0.65={ba65:.4f}  BA@opt({ths[i]:.2f})={bas[i]:.4f}")
        return bas[i]

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    best = 0.0
    print("pre-finetune validation:")
    best = validate()

    step = 0
    t0 = time.time()
    for ep in range(args.epochs):
        for x, y in dl:
            out = model(x.to(device))
            loss = lossfn(out, y.to(device))
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            step += 1
            if step % 25 == 0:
                ips = step * args.batch / (time.time() - t0)
                print(f"ep{ep} step {step}/{steps} loss={loss.item():.4f} ({ips:.1f} img/s)", flush=True)
            if args.dry_run and step >= 2:
                print("dry-run OK")
                return
            if step % 400 == 0:
                ba = validate()
                if ba > best:
                    best = ba
                    save_file({f"vit.{k}": v.cpu() for k, v in model.state_dict().items()},
                              str(outdir / "model.safetensors"))
                    print(f"  saved checkpoint (BA {ba:.4f})")
        ba = validate()
        if ba > best:
            best = ba
            save_file({f"vit.{k}": v.cpu() for k, v in model.state_dict().items()},
                      str(outdir / "model.safetensors"))
            print(f"  saved checkpoint (BA {ba:.4f})")
    print(f"done; best val BA={best:.4f}; weights in {outdir}")


if __name__ == "__main__":
    main()
