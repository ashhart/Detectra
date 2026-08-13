// Detectra — end-to-end test: launches real Chrome with the built extension,
// serves a test page of images over localhost, and reads back the
// data-detectra-score attributes the content script stamps on each image.
// This is the same surface an automated benchmark (like the bounty
// maintainers') would use.
//
// Usage:
//   node tools/e2e.mjs                # built-in page from CF sample images
//   node tools/e2e.mjs DIR            # serve DIR (expects images inside)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'extension', 'dist');

// Branded Chrome dropped --load-extension; use Chrome for Testing
// (npx @puppeteer/browsers install chrome@stable --path tools/browsers).
function findChromeForTesting() {
  const base = path.join(root, 'tools', 'browsers', 'chrome');
  if (!existsSync(base)) return null;
  for (const v of readdirSync(base).sort().reverse()) {
    const p = path.join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
    const linux = path.join(base, v, 'chrome-linux64', 'chrome');
    if (existsSync(linux)) return linux;
  }
  return null;
}
const chromePath = findChromeForTesting();
if (!chromePath) throw new Error('run: npx @puppeteer/browsers install chrome@stable --path tools/browsers');

// ---- tiny static server --------------------------------------------------
const serveDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'tools/demo-images');
const exts = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const images = readdirSync(serveDir).filter((f) => exts[path.extname(f).toLowerCase()]);
if (!images.length) throw new Error(`no images in ${serveDir}`);

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/' || u === '/index.html') {
    const body = `<!doctype html><meta charset="utf-8"><title>Detectra e2e</title>
<style>body{display:flex;flex-wrap:wrap;gap:16px;font-family:system-ui}</style>
${images.map((f) => `<figure><img src="/${encodeURIComponent(f)}" width="384"><figcaption>${f}</figcaption></figure>`).join('\n')}`;
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    return;
  }
  const f = path.join(serveDir, path.basename(u));
  if (existsSync(f) && exts[path.extname(f).toLowerCase()]) {
    res.writeHead(200, { 'content-type': exts[path.extname(f).toLowerCase()] }).end(readFileSync(f));
  } else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---- browser -------------------------------------------------------------
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'detectra-profile-'));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  userDataDir,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-first-run',
    '--window-size=1400,1000',
  ],
});

// Capture console output from every extension context (SW + offscreen) for debugging.
async function tapTarget(target) {
  try {
    if (!target.url().startsWith('chrome-extension://')) return;
    const session = await target.createCDPSession();
    await session.send('Runtime.enable');
    session.on('Runtime.consoleAPICalled', (e) => {
      const text = e.args.map((a) => a.value ?? a.description ?? '').join(' ');
      console.log(`[ext:${target.type()}]`, text);
    });
    session.on('Runtime.exceptionThrown', (e) => {
      console.log(`[ext:${target.type()}:EXC]`, e.exceptionDetails?.exception?.description || JSON.stringify(e.exceptionDetails));
    });
  } catch { /* target may be gone */ }
}
browser.on('targetcreated', tapTarget);
for (const t of await browser.targets()) await tapTarget(t);

try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto(pageUrl, { waitUntil: 'networkidle2' });

  await page.waitForFunction(
    () => {
      const imgs = [...document.images].filter((i) => i.naturalWidth >= 128 && i.naturalHeight >= 128);
      return imgs.length > 0 && imgs.every((i) => i.dataset.detectraScore || i.dataset.detectraError);
    },
    { timeout: 90_000, polling: 500 }
  );

  const results = await page.evaluate(() =>
    [...document.images]
      .filter((i) => i.naturalWidth >= 128)
      .map((i) => ({
        src: decodeURIComponent(i.src.split('/').pop()),
        score: i.dataset.detectraScore ?? null,
        verdict: i.dataset.detectraVerdict ?? null,
        error: i.dataset.detectraError ?? null,
      }))
  );
  console.table(results);
  const scored = results.filter((r) => r.score != null);
  console.log(`scored ${scored.length}/${results.length} images`);
  process.exitCode = scored.length === results.length ? 0 : 1;
} catch (e) {
  console.error('E2E FAILED:', e.message);
  // Diagnostics: list targets, then open the extension popup as a tab and
  // read its status card (popup.js renders engine/model/status live).
  const targets = await browser.targets();
  for (const t of targets) console.log('  target:', t.type(), t.url());
  const extTarget = targets.find((t) => t.url().startsWith('chrome-extension://'));
  if (extTarget) {
    const extId = new URL(extTarget.url()).host;
    const diag = await browser.newPage();
    diag.on('console', (m) => console.log('[popup]', m.text()));
    diag.on('pageerror', (err) => console.log('[popup:ERR]', err.message));
    await diag.goto(`chrome-extension://${extId}/popup.html`);
    await new Promise((r) => setTimeout(r, 4000));
    const status = await diag.evaluate(() => ({
      engine: document.getElementById('engine')?.textContent,
      model: document.getElementById('model')?.textContent,
      status: document.getElementById('status')?.textContent,
    }));
    console.log('popup status:', JSON.stringify(status));
    const engineStatus = await diag.evaluate(
      () => chrome.runtime.sendMessage({ target: 'bg', type: 'engine-status' }).catch((e) => ({ error: String(e) }))
    );
    console.log('engine log:');
    for (const line of engineStatus?.log ?? []) console.log('  ', line);
  } else {
    console.log('NO EXTENSION TARGET FOUND — extension did not load');
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
