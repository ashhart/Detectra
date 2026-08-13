// Training webscreens: site list fully DISJOINT from the audit and calibration
// screenshot sets (those share URLs with each other — documented). Two
// viewports + scroll positions for variety. Output: eval/data/val/ws_reals/real
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'eval', 'data', 'val', 'ws_reals', 'real');
mkdirSync(out, { recursive: true });

const chromeBase = path.join(root, 'tools', 'browsers', 'chrome');
const chromePath = readdirSync(chromeBase).sort().reverse()
  .map((v) => path.join(chromeBase, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
  .find(existsSync);

const SITES = [
  'https://en.wikipedia.org/wiki/Ocean',
  'https://en.wikipedia.org/wiki/Mathematics',
  'https://en.wikipedia.org/wiki/Architecture',
  'https://en.wikipedia.org/wiki/Music_theory',
  'https://en.wiktionary.org/wiki/serendipity',
  'https://en.wikivoyage.org/wiki/Tokyo',
  'https://docs.python.org/3/tutorial/index.html',
  'https://www.rust-lang.org/learn',
  'https://developer.apple.com/documentation/swift',
  'https://www.npmjs.com/package/react',
  'https://www.kernel.org',
  'https://www.gnu.org/software/emacs/',
  'https://arxiv.org/abs/2411.04125',
  'https://www.nasa.gov/humans-in-space/',
  'https://www.weather.gov',
  'https://openlibrary.org/subjects/science',
  'https://www.gutenberg.org/ebooks/84',
  'https://developer.mozilla.org/en-US/docs/Web/HTML',
  'https://github.com/rust-lang/rust',
  'https://github.com/python/cpython',
  'https://gitlab.com/explore',
  'https://lite.duckduckgo.com/lite/?q=history+of+printing',
];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-trainshots-')),
  args: ['--no-first-run', '--hide-scrollbars'],
});

let n = 0;
const shot = (page) => page.screenshot({ path: path.join(out, `wstrain_${String(n++).padStart(5, '0')}.png`) });
try {
  const page = await browser.newPage();
  for (const vp of [{ width: 1440, height: 1000 }, { width: 1024, height: 820 }]) {
    await page.setViewport(vp);
    for (const url of SITES) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
        await new Promise((r) => setTimeout(r, 900));
        await shot(page);
        for (const clip of [
          { x: 0, y: 0, width: Math.floor(vp.width / 2), height: 480 },
          { x: Math.floor(vp.width / 3), y: 200, width: Math.floor(vp.width / 2), height: 520 },
        ]) {
          await page.screenshot({ path: path.join(out, `wstrain_${String(n++).padStart(5, '0')}.png`), clip });
        }
        for (let s = 0; s < 2; s++) {
          await page.evaluate(() => window.scrollBy(0, 850));
          await new Promise((r) => setTimeout(r, 350));
          await shot(page);
        }
      } catch (e) {
        console.warn('skip', url, e.message);
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`ws train: ${n} → ${out}`);
