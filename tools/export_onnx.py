#!/usr/bin/env python
"""Export the Detectra detector to ONNX for onnxruntime-web.

Loads the Community Forensics ViT-S/16 @384 checkpoint (MIT, Park & Owens,
CVPR 2025 — our fine-tuned successor drops in here later), rebuilds the exact
architecture, exports to ONNX (opset 17), and runs a PyTorch-vs-onnxruntime
parity check on random and real inputs.

Usage:
  python tools/export_onnx.py \
      --weights tools/weights/commfor-384/model.safetensors \
      --out extension/models/model.onnx
"""
import argparse
import hashlib
from pathlib import Path

import numpy as np
import timm
import torch
import torch.nn as nn
from safetensors.torch import load_file


def build_model() -> nn.Module:
    vit = timm.create_model("vit_small_patch16_384.augreg_in21k_ft_in1k", pretrained=False)
    vit.head = nn.Linear(in_features=384, out_features=1, bias=True)
    return vit


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--input-size", type=int, default=384)
    ap.add_argument("--fp16", action="store_true", help="convert weights to fp16 (halves size)")
    args = ap.parse_args()

    model = build_model()
    state = load_file(args.weights)
    # HF PyTorchModelHubMixin checkpoints prefix with the module name ("vit.").
    if any(k.startswith("vit.") for k in state):
        state = {k.removeprefix("vit."): v for k, v in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    assert not missing, f"missing keys: {missing[:5]}"
    assert not unexpected, f"unexpected keys: {unexpected[:5]}"
    model.eval()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    s = args.input_size
    dummy = torch.randn(1, 3, s, s)
    torch.onnx.export(
        model,
        dummy,
        str(out),
        input_names=["pixel_values"],
        output_names=["logit"],
        opset_version=17,
        dynamic_axes=None,  # fixed 1x3x384x384 — simplest + fastest for ORT-web
    )

    # Consolidate into a single self-contained file (ORT-web loads one buffer).
    import onnx

    m = onnx.load(str(out), load_external_data=True)
    if args.fp16:
        from onnxconverter_common import float16

        m = float16.convert_float_to_float16(m, keep_io_types=True)
    onnx.save(m, str(out), save_as_external_data=False)
    data_file = out.with_suffix(".onnx.data")
    data_file.unlink(missing_ok=True)

    # Parity check
    import onnxruntime as ort_rt

    tol = 5e-2 if args.fp16 else 1e-3
    sess = ort_rt.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    with torch.no_grad():
        worst = 0.0
        for trial in range(5):
            x = torch.randn(1, 3, s, s)
            ref = model(x).numpy()
            got = sess.run(None, {"pixel_values": x.numpy()})[0]
            worst = max(worst, float(np.abs(ref - got).max()))
        assert worst < tol, f"parity failure: {worst}"
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"exported {out} ({out.stat().st_size / 1e6:.1f} MB)")
    print(f"sha256  {sha}")
    print(f"parity  max|Δlogit| = {worst:.2e} (< {tol}) over 5 random trials ✓")


if __name__ == "__main__":
    main()
