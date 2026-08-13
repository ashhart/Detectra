#!/usr/bin/env python
"""Assemble the Detectra validation set from public sources.

Builds eval/data/val/{real,ai}/<source>_<idx>.<ext> with a manifest CSV.
Sources are streamed from Hugging Face where possible and subsampled; an honest in-house proxy,
weighted toward the modern generators (Flux, Midjourney, DALL-E 3, 4o) that
defeat most existing detectors, plus web-realistic real photos.

Usage:
  python eval/build_dataset.py --list            # show source registry
  python eval/build_dataset.py --per-source 300  # build (default 300/source)
  python eval/build_dataset.py --only mj_v6,coco # subset of sources
"""
import argparse
import csv
import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "eval" / "data" / "val"

# --------------------------------------------------------------------------
# Source registry. Each entry: (name, label, loader) where loader yields PIL
# Images (or raw bytes). Keep entries independent — one failing source must
# not sink the build.
# --------------------------------------------------------------------------


def hf_stream(dataset, split="train", config=None, image_keys=("image", "img", "jpg", "png"), **kw):
    from datasets import load_dataset

    ds = load_dataset(dataset, config, split=split, streaming=True, **kw)
    for row in ds:
        for k in image_keys:
            v = row.get(k)
            if v is not None:
                yield v  # yield every matching key (pairs count twice)


def coco_val(n):
    """COCO val2017 — canonical real-photo distribution."""
    import urllib.request
    import zipfile

    zpath = ROOT / "eval" / "data" / "val2017.zip"
    if not zpath.exists():
        print("  downloading COCO val2017 (815MB)…")
        urllib.request.urlretrieve("http://images.cocodataset.org/zips/val2017.zip", zpath)
    with zipfile.ZipFile(zpath) as z:
        names = [m for m in z.namelist() if m.endswith(".jpg")]
        step = max(1, len(names) // n)
        for name in names[::step][:n]:
            yield z.read(name)


def cf_small(label):
    """Replay slice of CommunityForensics-Small (CC-BY-4.0, research use):
    preserves the base model's breadth during fine-tuning.
    NOTE: image_data streams as raw encoded-image bytes (the datasets-server
    preview shows base64 only because JSON can't carry binary)."""
    from datasets import load_dataset

    want = str(label)
    ds = load_dataset("OwensLab/CommunityForensics-Small", split="train", streaming=True)
    for row in ds:
        if str(row.get("label")) == want and row.get("image_data"):
            yield bytes(row["image_data"])


SOURCES = {
    # ---- real ------------------------------------------------------------
    "coco": ("real", coco_val),
    # ---- replay (written under cf_replay/, not val/) ---------------------
    "cfreplay_ai": ("cf_replay/ai", lambda n: cf_small(1)),
    "cfreplay_real": ("cf_replay/real", lambda n: cf_small(0)),
    # ---- AI: modern generators (the hard cases) --------------------------
    # Rapidata preference sets: image1/image2 pairs, both AI-generated.
    "rapid_4o": ("ai", lambda n: hf_stream("Rapidata/OpenAI-4o_t2i_human_preference", image_keys=("image1", "image2"))),
    "rapid_ideogram": ("ai", lambda n: hf_stream("Rapidata/Ideogram-V2_t2i_human_preference", image_keys=("image1", "image2"))),
    "rapid_recraft": ("ai", lambda n: hf_stream("Rapidata/Recraft-V2_t2i_human_preference", image_keys=("image1", "image2"))),
    "rapid_hidream": ("ai", lambda n: hf_stream("Rapidata/Hidream_t2i_human_preference", image_keys=("image1", "image2"))),
    "midjourney": ("ai", lambda n: hf_stream("ehristoforu/midjourney-images")),
    "dalle3": ("ai", lambda n: hf_stream("OpenDatasets/dalle-3-dataset")),
    "flux_sd35": ("ai", lambda n: hf_stream("data-is-better-together/open-image-preferences-v1", split="cleaned", image_keys=("image_quality_dev", "image_quality_sd"))),
    "rapid_700k": ("ai", lambda n: hf_stream("Rapidata/700k_Human_Preference_Dataset_FLUX_SD3_MJ_DALLE3", split="train_0001", image_keys=("image1", "image2"))),
}


def save_image(obj, dest: Path) -> bool:
    try:
        if isinstance(obj, (bytes, bytearray)):
            img = Image.open(io.BytesIO(obj))
        elif isinstance(obj, Image.Image):
            img = obj
        elif isinstance(obj, dict) and "bytes" in obj:
            img = Image.open(io.BytesIO(obj["bytes"]))
        else:
            return False
        img.load()
        if img.width < 200 or img.height < 200:
            return False
        # Preserve original encoding where we have bytes; else save PNG for
        # generator outputs (lossless) — perturbation study handles the
        # "web-realistic" recompression axis separately in score.py.
        if isinstance(obj, (bytes, bytearray)):
            ext = (Image.open(io.BytesIO(obj)).format or "png").lower()
            dest.with_suffix(f".{ext}").write_bytes(obj)
        else:
            img.convert("RGB").save(dest.with_suffix(".png"))
        return True
    except Exception:
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-source", type=int, default=300)
    ap.add_argument("--only", help="comma-separated source names")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for name, (label, _) in SOURCES.items():
            print(f"{name:12s} {label}")
        return

    only = set(args.only.split(",")) if args.only else None
    manifest = []
    for name, (label, loader) in SOURCES.items():
        if only and name not in only:
            continue
        outdir = OUT / label
        outdir.mkdir(parents=True, exist_ok=True)
        print(f"[{name}] → {label}/ (target {args.per_source})")
        got = 0
        try:
            for obj in loader(args.per_source):
                dest = outdir / f"{name}_{got:05d}"
                if save_image(obj, dest):
                    manifest.append((name, label, dest.name))
                    got += 1
                    if got % 50 == 0:
                        print(f"  {got}…", flush=True)
                if got >= args.per_source:
                    break
        except Exception as e:
            print(f"  SOURCE FAILED after {got}: {type(e).__name__}: {e}", file=sys.stderr)
        print(f"  done: {got}")

    with open(OUT / "manifest.csv", "a", newline="") as fh:
        csv.writer(fh).writerows(manifest)
    print(f"\ntotal new: {len(manifest)} → {OUT}")


if __name__ == "__main__":
    main()
