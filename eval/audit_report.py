#!/usr/bin/env python
"""Non-photographic-reals audit report: per-category TNR @0.65 with Wilson
95% intervals + worst false positives. Reads the audit CSVs produced by
tools/bench.mjs. Usage: python eval/audit_report.py
"""
import csv
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "eval" / "results"
THR = 0.65

CATEGORIES = {
    "paintings (WikiArt, pre-AI era)": "audit_wikiart.csv",
    "web/UI screenshots (self-made)": "audit_webscreens.csv",
    "anime (selfie2anime, ~2019)": "audit_anime.csv",
    "memes (Hateful Memes, 2020)": "audit_memes.csv",
    "3D renders (Commons <2022)": "audit_render3d.csv",
    "game screenshots (Commons <2022)": "audit_gamescreens.csv",
}


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def main() -> None:
    print(f"{'category':42s} {'n':>5s} {'TNR@0.65':>9s} {'95% CI':>16s}")
    for name, fname in CATEGORIES.items():
        f = RESULTS / fname
        if not f.exists():
            print(f"{name:42s} {'—':>5s} {'pending':>9s}")
            continue
        rows = [r for r in csv.DictReader(open(f)) if r.get("score") and r["label"] == "real"]
        n = len(rows)
        ok = sum(float(r["score"]) < THR for r in rows)
        lo, hi = wilson(ok, n)
        print(f"{name:42s} {n:5d} {ok / n * 100:8.1f}% [{lo * 100:5.1f}%,{hi * 100:5.1f}%]")
        worst = sorted(rows, key=lambda r: -float(r["score"]))[:5]
        for w in worst:
            if float(w["score"]) >= THR:
                print(f"{'':42s}   FP {float(w['score']):.3f}  {w['name']}")


if __name__ == "__main__":
    main()
