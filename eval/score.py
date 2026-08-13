#!/usr/bin/env python
"""Detectra eval harness — score images with the exported ONNX model.

Replicates the extension's preprocessing exactly:
  Resize(shortest edge → 440, bilinear) → CenterCrop(384) → [0,1]
  → ImageNet-normalize → 1x3x384x384 float32 → sigmoid(logit) = P(AI).

Usage:
  python eval/score.py IMG [IMG...]                 # print per-image scores
  python eval/score.py --dir DATA_DIR               # DATA_DIR/{real,ai}/** → balanced accuracy @0.65
  python eval/score.py --dir DATA_DIR --csv out.csv # also dump per-image csv
"""
import argparse
import csv
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "extension" / "models" / "model.onnx"
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".avif"}


def preprocess(path: Path, resize: int = 440, crop: int = 384) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = resize / min(w, h)
    img = img.resize((max(crop, round(w * scale)), max(crop, round(h * scale))), Image.BILINEAR)
    w, h = img.size
    left, top = (w - crop) // 2, (h - crop) // 2
    img = img.crop((left, top, left + crop, top + crop))
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None]


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + np.exp(-x))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="*")
    ap.add_argument("--dir", help="labeled dir with real/ and ai|fake/ subdirs")
    ap.add_argument("--model", default=str(MODEL))
    ap.add_argument("--threshold", type=float, default=0.65)
    ap.add_argument("--csv")
    args = ap.parse_args()

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name

    def score(p: Path) -> float:
        return sigmoid(float(np.ravel(sess.run(None, {iname: preprocess(p)})[0])[0]))

    rows = []
    if args.dir:
        base = Path(args.dir)
        for sub, label in [("real", 0), ("ai", 1), ("fake", 1)]:
            d = base / sub
            if not d.is_dir():
                continue
            for f in sorted(d.rglob("*")):
                if f.suffix.lower() in EXTS:
                    try:
                        rows.append((str(f.relative_to(base)), label, score(f)))
                    except Exception as e:
                        print(f"skip {f}: {e}", file=sys.stderr)
        ai = [r for r in rows if r[1] == 1]
        real = [r for r in rows if r[1] == 0]
        t = args.threshold
        tpr = sum(r[2] >= t for r in ai) / max(1, len(ai))
        tnr = sum(r[2] < t for r in real) / max(1, len(real))
        print(f"n={len(rows)} (ai={len(ai)}, real={len(real)})  threshold={t}")
        print(f"TPR (AI detected)  {tpr:.4f}")
        print(f"TNR (real kept)    {tnr:.4f}")
        print(f"balanced accuracy  {(tpr + tnr) / 2:.4f}")
    else:
        for name in args.images:
            p = Path(name)
            s = score(p)
            rows.append((name, None, s))
            print(f"{s:.4f}  {'AI' if s >= args.threshold else 'real/unsure'}  {name}")

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["file", "label", "p_ai"])
            w.writerows(rows)
        print(f"wrote {args.csv}")


if __name__ == "__main__":
    main()
