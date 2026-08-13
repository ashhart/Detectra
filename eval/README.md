# Detectra evaluation methodology

All headline numbers are measured **through the real extension** — Chrome for
Testing with the built MV3 extension loaded, canvas preprocessing, WebGPU
inference, fusion and calibration exactly as a user gets them
(`tools/bench.mjs`). Python-side scores exist only for model development and
are never quoted.

## Decision threshold

An image is called AI when the displayed confidence ≥ **0.65**. The threshold
is fixed first; calibration adapts the model to it, never the reverse:
Platt scaling (`p' = sigmoid(a·logit + b)`) is fit by logistic regression on a
calibration pool, then `b` is shifted so 0.65 coincides with the
balanced-accuracy-optimal raw threshold of that pool (`eval/calibrate.py`).
Calibration is fitted on a random half of the pool and verified on the other
half before use.

## Split discipline

- **WildRF test** is never used for training, calibration, threshold or model
  selection — it is read only to report final numbers.
- **Generator holdouts:** GPT-4o and Ideogram images never enter training;
  they measure unseen-generator generalization.
- **Even/odd source splits:** where a source feeds both training and
  evaluation, even-indexed files may be trained on; odd-indexed files are
  reserved for evaluation (`eval/make_eval_split.py`). The two halves come
  from the same fetch and never overlap.
- **Frozen baselines:** each released model's raw per-image scores and a
  manifest (ONNX SHA-256, calibration constants, git commit, metrics) are
  frozen under `eval/results/baseline-*/` so regressions are detectable.

## Leakage controls

- Training data and evaluation data are drawn from disjoint index ranges of
  each source (even/odd) or from entirely disjoint sources.
- The non-photographic-reals audit (below) uses sources first downloaded
  *after* the audited model was trained and calibrated — leakage is impossible
  by construction for those numbers.
- Near-duplicate risk across sources is limited by construction (different
  hosts and eras); no fuzzy dedup pass is currently applied across sources —
  a known limitation, documented rather than hidden.

## Datasets

Reals: COCO val2017, WildRF (Reddit/X/Facebook, platform-compressed),
WikiArt paintings (pre-AI by era), self-rendered webpage screenshots,
Wikimedia Commons Blender renders and game screenshots (uploads < 2022-01-01),
hand-drawn anime (selfie2anime), meme composites (Hateful Memes, 2020;
evaluated locally, not redistributed).

Fakes: Rapidata per-generator preference sets (GPT-4o, Ideogram, Recraft,
HiDream) and the 700k FLUX/SD3/MJ/DALL·E-3 set, Midjourney and DALL·E-3
community sets, Flux-dev/SD3.5 from open-image-preferences,
CommunityForensics-Small replay slice, WildRF fakes.

## Robustness ("mangled") variants

Each eval image re-encoded with random 0.5–0.9× downscale + JPEG q60–88
(seeded, reproducible) to simulate web re-hosting. Reported separately —
never averaged into the pristine numbers.

## Non-photographic-reals audit

TNR is reported **per category** (paintings, anime, renders, game
screenshots, memes, web screenshots) with Wilson 95% intervals, never as one
blended average. Worst false positives are inspected visually and
characterized in the audit notes.
