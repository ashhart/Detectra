// Build the "webscreens" audit-reals category: screenshots of well-known
// public webpages rendered locally in a bare Chrome (no extension loaded).
// Guaranteed non-AI-generated imagery of the screenshot/UI/web-graphics kind.
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'eval', 'data', 'calib-reals-ws', 'real');
mkdirSync(out, { recursive: true });

const chromeBase = path.join(root, 'tools', 'browsers', 'chrome');
const chromePath = readdirSync(chromeBase).sort().reverse()
  .map((v) => path.join(chromeBase, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
  .find(existsSync);

const SITES = [
  'https://en.wikipedia.org/wiki/Astronomy',
  'https://en.wikipedia.org/wiki/Cooking',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://github.com/microsoft/vscode',
  'https://www.w3.org/TR/CSS22/',
  'https://archive.org/details/texts',
  'https://en.wikipedia.org/wiki/Photography',
  'https://en.wikipedia.org/wiki/Renaissance',
  'https://developer.mozilla.org/en-US/docs/Web/CSS',
  'https://github.com/torvalds/linux',
  'https://stackoverflow.com/questions',
  'https://news.ycombinator.com',
  'https://www.gutenberg.org/ebooks/1342',
  'https://www.openstreetmap.org/#map=13/48.8566/2.3522',
  'https://archive.org/details/movies',
  'https://lite.duckduckgo.com/lite/?q=weather',
  'https://www.w3.org/TR/css-grid-1/',
  'https://commons.wikimedia.org/wiki/Main_Page',
];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-shots-')),
  args: ['--no-first-run', '--window-size=1440,1000', '--hide-scrollbars'],
});

let n = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  for (const url of SITES) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
      await new Promise((r) => setTimeout(r, 1200));
      // full viewport + three tiles (simulates cropped screenshot sharing)
      await page.screenshot({ path: path.join(out, `webscreens_${String(n++).padStart(5, '0')}.png`) });
      for (const clip of [
        { x: 0, y: 0, width: 720, height: 500 },
        { x: 720, y: 0, width: 720, height: 500 },
        { x: 200, y: 300, width: 900, height: 600 },
      ]) {
        await page.screenshot({ path: path.join(out, `webscreens_${String(n++).padStart(5, '0')}.png`), clip });
      }
      await page.evaluate(() => window.scrollBy(0, 900));
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(out, `webscreens_${String(n++).padStart(5, '0')}.png`) });
      console.log(url, '→ 5 shots');
    } catch (e) {
      console.warn('skip', url, e.message);
    }
  }
} finally {
  await browser.close();
}
console.log(`webscreens: ${n} images → ${out}`);
