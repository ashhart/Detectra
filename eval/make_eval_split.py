#!/usr/bin/env python
"""Build eval/data/val-eval: the benchmark half of the val pool.

Training (tools/train.py) uses only EVEN-indexed files per source; this
script symlinks the ODD-indexed complement — plus every image of the
held-out generators (rapid_4o, rapid_ideogram), which are never trained on —
into val-eval/{real,ai} for contamination-free benchmarking.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "eval/data/val"
DST = ROOT / "eval/data/val-eval"
HOLDOUTS = ("rapid_4o", "rapid_ideogram")
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

n = 0
for cls in ("real", "ai"):
    out = DST / cls
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():
        old.unlink()
    for f in sorted((SRC / cls).iterdir()):
        if f.suffix.lower() not in EXTS:
            continue
        m = re.search(r"_(\d+)\.\w+$", f.name)
        odd = m and int(m.group(1)) % 2 == 1
        holdout = f.name.startswith(HOLDOUTS)
        if odd or holdout:
            (out / f.name).symlink_to(f.resolve())
            n += 1
print(f"val-eval: {n} images")
