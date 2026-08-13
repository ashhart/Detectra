#!/usr/bin/env python
"""Assemble the timestamped pre-AI 'difficult reals' audit set, per category.

Categories → eval/data/audit-reals/<category>/real/:
  anime        huggan/selfie2anime (hand-drawn anime faces, dataset era ~2019)
  memes        limjiayi/hateful_memes_expanded (FB 2020 meme composites; local
               eval only, not redistributed)
  render3d     Wikimedia Commons Category:Blender_renders, uploads < 2022
  gamescreens  Wikimedia Commons Category:Video_game_screenshots, uploads < 2022

WikiArt paintings are already in eval/data/val/art_reals (audited separately).
Every image is 'real' in the benchmark sense: not diffusion/GAN-generated.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "eval" / "data" / "audit-reals"
UA = {"User-Agent": "DetectraEval/1.0 (TNR audit; contact via github.com/ashhart/Detectra)"}


def get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def rows_api(dataset, image_key, n, config="default", split="train", per_page_cap=50):
    got = 0
    for offset in range(0, 4000, 100):
        if got >= n:
            break
        url = (f"https://datasets-server.huggingface.co/rows?dataset={urllib.parse.quote(dataset, safe='')}"
               f"&config={config}&split={split}&offset={offset}&length=100")
        try:
            rows = json.loads(get(url))["rows"]
        except Exception as e:
            print(f"  page {offset} failed: {e}", file=sys.stderr)
            time.sleep(2)
            continue
        if not rows:
            break
        for r in rows[:per_page_cap]:
            img = r["row"].get(image_key)
            if not img or not isinstance(img, dict) or not img.get("src"):
                continue
            try:
                yield get(img["src"])
                got += 1
                time.sleep(0.3)  # stay under datasets-server rate limits
            except Exception:
                time.sleep(2)
            if got >= n:
                break


def commons_category(category, n, before="2022-01-01T00:00:00Z"):
    """Files from a Wikimedia Commons category uploaded before `before`.
    Polite pacing + backoff: Commons 429s aggressively on burst traffic."""
    base = "https://commons.wikimedia.org/w/api.php"
    cont = ""
    got = 0
    fails = 0
    time.sleep(90)  # Commons clamps on burst traffic; arrive slowly
    while got < n and fails < 10:
        q = (f"{base}?action=query&generator=categorymembers&gcmtitle=Category:{urllib.parse.quote(category)}"
             f"&gcmtype=file&gcmlimit=50&prop=imageinfo&iiprop=url|timestamp|size&format=json&maxlag=5{cont}")
        try:
            j = json.loads(get(q))
            # maxlag exceeded comes back as HTTP 200 with an error object —
            # treating it as an empty category silently kills the crawl.
            if "error" in j:
                raise RuntimeError(j["error"].get("code", "api-error"))
            fails = 0
        except Exception as e:
            fails += 1
            wait = 30 * fails
            print(f"  commons query failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        pages = (j.get("query") or {}).get("pages", {})
        for p in pages.values():
            ii = (p.get("imageinfo") or [{}])[0]
            ts, url, w = ii.get("timestamp", ""), ii.get("url", ""), ii.get("width", 0)
            if not url or ts >= before or w < 300:
                continue
            # Commons serves signed URLs with query strings (&ut=…) — judge the
            # format by the file TITLE, not the URL tail.
            if not p.get("title", "").lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                continue
            try:
                yield get(url)
                got += 1
                time.sleep(0.4)
            except Exception:
                time.sleep(2)
            if got >= n:
                return
        c = j.get("continue")
        if not c:
            return
        cont = "&" + "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in c.items())
        time.sleep(1.5)


def memes_files(n):
    """hateful_memes_expanded stores 'img' as a repo-relative path; fetch the
    raw files via resolve/ URLs (follows CDN redirect)."""
    got = 0
    for offset in range(0, 4000, 100):
        if got >= n:
            break
        url = (f"https://datasets-server.huggingface.co/rows?dataset=limjiayi%2Fhateful_memes_expanded"
               f"&config=default&split=train&offset={offset}&length=100")
        try:
            rows = json.loads(get(url))["rows"]
        except Exception as e:
            print(f"  page {offset} failed: {e}", file=sys.stderr)
            time.sleep(30)
            continue
        for r in rows:
            rel = r["row"].get("img")
            if not rel:
                continue
            try:
                req = urllib.request.Request(
                    f"https://huggingface.co/datasets/limjiayi/hateful_memes_expanded/resolve/main/{rel}",
                    headers=UA)
                yield urllib.request.urlopen(req, timeout=60).read()  # urlopen follows redirects
                got += 1
                time.sleep(0.5)
            except Exception:
                time.sleep(3)
            if got >= n:
                break
        time.sleep(2)


CATEGORIES = {
    "anime": lambda n: rows_api("huggan/selfie2anime", "imageB", n),
    "memes": memes_files,
    "render3d": lambda n: commons_category("Blender_(software)", n),
    "gamescreens": lambda n: commons_category("Video_game_screenshots", n),
}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 250
    only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    for name, loader in CATEGORIES.items():
        if only and name not in only:
            continue
        out = OUT / name / "real"
        out.mkdir(parents=True, exist_ok=True)
        got = len(list(out.iterdir()))
        if got >= n:
            print(f"[{name}] already {got}")
            continue
        print(f"[{name}] target {n}")
        for data in loader(n - got):
            (out / f"{name}_{got:05d}.img").write_bytes(data)
            # fix extension from magic bytes
            ext = "jpg"
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                ext = "png"
            elif data[:4] == b"RIFF":
                ext = "webp"
            (out / f"{name}_{got:05d}.img").rename(out / f"{name}_{got:05d}.{ext}")
            got += 1
            if got % 50 == 0:
                print(f"  {got}", flush=True)
        print(f"  done: {got}")


if __name__ == "__main__":
    main()
