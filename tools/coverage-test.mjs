// Coverage test: verifies Detectra analyzes images delivered every way a page
// can deliver them — plain <img>, open shadow DOM, same-origin iframe,
// CSS background-image, and small (64px+) images.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'extension', 'dist');
const demo = path.join(root, 'tools', 'demo-images');
const imgs = readdirSync(demo).filter((f) => f.endsWith('.png'));

const chromeBase = path.join(root, 'tools', 'browsers', 'chrome');
const chromePath = readdirSync(chromeBase).sort().reverse()
  .map((v) => path.join(chromeBase, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
  .find(existsSync);

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8">
<style>div.bg{width:300px;height:300px;background:url('/img/${imgs[3]}') center/cover}</style>
<h1>coverage</h1>
<img id="plain" src="/img/${imgs[0]}" width="300">
<img id="small" src="/img/${imgs[1]}" width="80" height="80">
<div id="shadow-host"></div>
<div id="bg" class="bg"></div>
<iframe id="frame" src="/frame" width="360" height="340"></iframe>
<script>
  const sr = document.getElementById('shadow-host').attachShadow({mode:'open'});
  sr.innerHTML = '<img id="shadowed" src="/img/${imgs[2]}" width="300">';
</script>`);
    return;
  }
  if (u === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><img id="framed" src="/img/${imgs[0]}" width="300">`);
    return;
  }
  const m = u.match(/^\/img\/(.+)$/);
  if (m) {
    const f = path.join(demo, path.basename(m[1]));
    if (existsSync(f)) return void res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(f));
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-cov-')),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle2' });

  const read = () =>
    page.evaluate(() => {
      const attr = (el) => el?.dataset.detectraScore ?? null;
      const frameDoc = document.getElementById('frame').contentDocument;
      return {
        plain: attr(document.getElementById('plain')),
        small: attr(document.getElementById('small')),
        shadowed: attr(document.getElementById('shadow-host').shadowRoot.getElementById('shadowed')),
        bg: attr(document.getElementById('bg')),
        framed: frameDoc ? attr(frameDoc.getElementById('framed')) : 'NO FRAME ACCESS',
      };
    });

  let result;
  for (let i = 0; i < 40; i++) {
    result = await read();
    if (Object.values(result).every((v) => v)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.table(result);
  const missing = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('MISSING COVERAGE:', missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log('full coverage ✓');
  }
} finally {
  await browser.close();
  server.close();
}
