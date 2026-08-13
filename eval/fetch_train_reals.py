#!/usr/bin/env python
"""Authenticated pulls of non-photographic REAL training data (v2 mix).

Uses HF_TOKEN from the environment (Authorization header sent to HF domains
only). Targets:
  eval/data/val/art_reals/real    WikiArt continuation → 2400 total
  eval/data/val/anime_reals/real  selfie2anime imageB rows ≥300 → 2000
                                  (audit's anime category used the stream head;
                                  rows <300 are excluded here. Same-source
                                  train/eval split — documented limitation.)
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKEN = os.environ.get("HF_TOKEN", "")
UA = "DetectraEval/1.0 (github.com/ashhart/Detectra)"


def get(url, timeout=60):
    headers = {"User-Agent": UA}
    host = urllib.parse.urlparse(url).netloc
    if TOKEN and (host.endswith("huggingface.co") or host.endswith("hf.co")):
        headers["Authorization"] = f"Bearer {TOKEN}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout).read()


def rows(dataset, offset, length=100, config="default", split="train"):
    url = (f"https://datasets-server.huggingface.co/rows?dataset={urllib.parse.quote(dataset, safe='')}"
           f"&config={config}&split={split}&offset={offset}&length={length}")
    return json.loads(get(url))["rows"]


def pull(dataset, image_key, out: Path, target, start_offset=0, prefix=None):
    out.mkdir(parents=True, exist_ok=True)
    prefix = prefix or out.parent.name
    got = len([f for f in out.iterdir() if f.suffix in (".jpg", ".png", ".webp")])
    print(f"[{prefix}] have {got}, target {target}")
    offset = start_offset
    fails = 0
    while got < target and fails < 8:
        try:
            page = rows(dataset, offset)
            fails = 0
        except Exception as e:
            fails += 1
            print(f"  page {offset}: {e}; wait {20 * fails}s", flush=True)
            time.sleep(20 * fails)
            continue
        if not page:
            break
        for r in page:
            img = r["row"].get(image_key)
            if not img or not isinstance(img, dict) or not img.get("src"):
                continue
            try:
                data = get(img["src"])
            except Exception:
                time.sleep(1)
                continue
            ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ("webp" if data[:4] == b"RIFF" else "jpg")
            (out / f"{prefix}_{got:05d}.{ext}").write_bytes(data)
            got += 1
            if got % 100 == 0:
                print(f"  {got}", flush=True)
            if got >= target:
                break
            time.sleep(0.15)
        offset += 100
    print(f"[{prefix}] done: {got}")


if __name__ == "__main__":
    if not TOKEN:
        print("WARN: no HF_TOKEN — expect throttling", file=sys.stderr)
    pull("huggan/wikiart", "image", ROOT / "eval/data/val/art_reals/real", 2400,
         start_offset=6000, prefix="wikiart")
    pull("huggan/selfie2anime", "imageB", ROOT / "eval/data/val/anime_reals/real", 2000,
         start_offset=300, prefix="animetrain")
