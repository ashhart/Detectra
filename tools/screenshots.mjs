// Capture README screenshots: badges on a demo page, forensics hover panel,
// and the popup dashboard. Writes to docs/.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'extension', 'dist');
const docs = path.join(root, 'docs');
mkdirSync(docs, { recursive: true });

const chromeBase = path.join(root, 'tools', 'browsers', 'chrome');
const chromePath = readdirSync(chromeBase).sort().reverse()
  .map((v) => path.join(chromeBase, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
  .find(existsSync);

// Demo page: 3 AI images (CF samples) + 3 real photos (COCO val)
const aiDir = path.join(root, 'third_party/community-forensics/test_images');
const realDir = path.join(root, 'eval/data/val/real');
const ai = readdirSync(aiDir).filter((f) => f.endsWith('.png')).slice(0, 3).map((f) => path.join(aiDir, f));
const real = readdirSync(realDir).filter((f) => /\.(jpg|jpeg|png)$/.test(f)).slice(4, 7).map((f) => path.join(realDir, f));
const files = [...ai.slice(0, 2), real[0], ai[2], real[1], real[2]];

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8">
<title>Detectra demo</title>
<style>
 body{margin:0;padding:28px;background:#f4f5f7;font-family:system-ui}
 h2{margin:0 0 18px;font-weight:650;color:#1c1e26}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:1080px}
 img{width:100%;height:230px;object-fit:cover;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.12)}
</style>
<h2>Is it real? Detectra decides — locally.</h2>
<div class="grid">${files.map((f, i) => `<img src="/img/${i}">`).join('')}</div>`);
    return;
  }
  const m = u.match(/^\/img\/(\d+)$/);
  if (m && files[+m[1]]) {
    const f = files[+m[1]];
    const ct = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'content-type': ct }).end(readFileSync(f));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-shot-')),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run', '--window-size=1200,860', '--hide-scrollbars'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1160, height: 800, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => [...document.images].every((i) => i.dataset.detectraScore || i.dataset.detectraError),
    { timeout: 120_000, polling: 500 }
  );
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(docs, 'badges.png') });

  // Hover the first AI badge → forensics panel + heatmap
  const box = await page.evaluate(() => {
    const img = [...document.images].find((i) => Number(i.dataset.detectraScore) >= 0.65);
    const r = img.getBoundingClientRect();
    return { x: r.right - 40, y: r.top + 14 };
  });
  await page.mouse.move(box.x, box.y);
  await new Promise((r) => setTimeout(r, 2500)); // panel + heatmap inference
  await page.screenshot({ path: path.join(docs, 'panel.png') });

  // Popup
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const extId = new URL(sw.url()).host;
  const popup = await browser.newPage();
  await popup.setViewport({ width: 340, height: 560, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await new Promise((r) => setTimeout(r, 1500));
  await popup.screenshot({ path: path.join(docs, 'popup.png') });

  console.log('screenshots →', docs);
} finally {
  await browser.close();
  server.close();
}
