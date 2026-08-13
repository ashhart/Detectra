#!/usr/bin/env python
"""Generate Detectra extension icons — an eye/lens glyph on a dark rounded tile."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "static" / "assets"
OUT.mkdir(parents=True, exist_ok=True)


def draw(size: int) -> Image.Image:
    s = size * 4  # supersample
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = s * 0.22
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=(16, 18, 24, 255))
    # iris: gradient rings (teal -> blue)
    cx, cy = s / 2, s / 2
    for i, (rad, col) in enumerate(
        [(0.34, (79, 124, 255, 255)), (0.26, (125, 211, 252, 255)), (0.165, (13, 15, 20, 255)), (0.10, (52, 211, 153, 255))]
    ):
        d.ellipse([cx - s * rad, cy - s * rad, cx + s * rad, cy + s * rad], fill=col)
    # scan slash
    w = s * 0.055
    d.line([s * 0.18, s * 0.82, s * 0.82, s * 0.18], fill=(251, 113, 133, 255), width=int(w))
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(OUT / f"icon{size}.png")
print(f"icons written to {OUT}")
