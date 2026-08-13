#!/usr/bin/env python
"""Fit Detectra's score calibration from browser-pipeline benchmark output.

Reads eval/results/browser_scores.csv (from tools/bench.mjs, needs the logit
column), fits Platt scaling p' = sigmoid(a·logit + b) by logistic regression,
then shifts b so that the 0.65 decision threshold lands
exactly on the balanced-accuracy-optimal raw threshold.

Honesty guard: fits on a random half, reports before/after balanced accuracy
on the held-out half. Writes {a, b} into extension/static/models.json.

Usage:
  python eval/calibrate.py [--csv eval/results/browser_scores.csv] [--apply]
"""
import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def balanced_accuracy(logits, labels, thr_logit):
    ai = labels == 1
    tpr = (logits[ai] >= thr_logit).mean() if ai.any() else 0.0
    tnr = (logits[~ai] < thr_logit).mean() if (~ai).any() else 0.0
    return (tpr + tnr) / 2, tpr, tnr


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=str(ROOT / "eval/results/browser_scores.csv"))
    ap.add_argument("--threshold", type=float, default=0.65)
    ap.add_argument("--apply", action="store_true", help="write result into models.json")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    import csv as csvmod

    logits, labels = [], []
    with open(args.csv) as fh:
        for row in csvmod.DictReader(fh):
            if row["logit"]:
                logits.append(float(row["logit"]))
                labels.append(1 if row["label"] == "ai" else 0)
    logits = np.array(logits)
    labels = np.array(labels)
    print(f"n={len(logits)} (ai={labels.sum()}, real={(1 - labels).sum()})")

    rng = np.random.default_rng(args.seed)
    idx = rng.permutation(len(logits))
    fit_idx, test_idx = idx[: len(idx) // 2], idx[len(idx) // 2 :]

    # -- Platt scaling on the fit half -------------------------------------
    from sklearn.linear_model import LogisticRegression

    lr = LogisticRegression(C=1e6)  # essentially unregularized 1-D fit
    lr.fit(logits[fit_idx, None], labels[fit_idx])
    a = float(lr.coef_[0][0])
    b_platt = float(lr.intercept_[0])

    # -- find BA-optimal raw threshold on the fit half ---------------------
    cand = np.unique(logits[fit_idx])
    bas = [balanced_accuracy(logits[fit_idx], labels[fit_idx], t)[0] for t in cand]
    t_star = float(cand[int(np.argmax(bas))])

    # -- pin: sigmoid(a·t* + b) == threshold -------------------------------
    logit_thr = np.log(args.threshold / (1 - args.threshold))
    b = float(logit_thr - a * t_star)
    print(f"Platt a={a:.4f} b={b_platt:.4f}; BA-optimal raw logit threshold t*={t_star:.4f}")
    print(f"pinned b={b:.4f} so that p'({t_star:.3f}) = {args.threshold}")

    # -- held-out report ----------------------------------------------------
    def report(name, thr_logit):
        ba, tpr, tnr = balanced_accuracy(logits[test_idx], labels[test_idx], thr_logit)
        print(f"  {name:32s} BA={ba * 100:6.2f}%  TPR={tpr * 100:6.2f}%  TNR={tnr * 100:6.2f}%")

    print("held-out half @0.65 decision threshold:")
    report("uncalibrated (a=1,b=0)", logit_thr)  # p >= .65  <=>  logit >= logit_thr
    report("calibrated", t_star)  # p' >= .65  <=>  logit >= t*

    if args.apply:
        mpath = ROOT / "extension/static/models.json"
        manifest = json.loads(mpath.read_text())
        manifest["calibration"] = {"a": round(a, 6), "b": round(b, 6)}
        mpath.write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"applied to {mpath}")


if __name__ == "__main__":
    main()
