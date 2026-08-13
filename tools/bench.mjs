// Detectra — browser-side batch benchmark.
// Scores a labeled dataset THROUGH the real extension pipeline (Chrome for
// Testing + service-worker WebGPU inference + canvas preprocessing), so the
// numbers reflect exactly what an external evaluator would measure.
//
// Usage:
//   node tools/bench.mjs [dataDir] [--batch 150] [--out eval/results/browser_scores.csv]
// dataDir defaults to eval/data/val and must contain real/ and ai/ subdirs.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'extension', 'dist');
const args = process.argv.slice(2);
const dataDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(root, 'eval', 'data', 'val'));
const batchSize = Number(args[args.indexOf('--batch') + 1]) || 150;
const outCsv = args.includes('--out')
  ? path.resolve(args[args.indexOf('--out') + 1])
  : path.join(root, 'eval', 'results', 'browser_scores.csv');
const THRESHOLD = 0.65;

const exts = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

// ---- collect labeled files ----------------------------------------------
const files = [];
for (const label of ['real', 'ai']) {
  const d = path.join(dataDir, label);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (exts[path.extname(f).toLowerCase()]) files.push({ label, f });
  }
}
if (!files.length) throw new Error(`no labeled images under ${dataDir}`);
console.log(`benchmarking ${files.length} images (${files.filter((x) => x.label === 'ai').length} ai / ${files.filter((x) => x.label === 'real').length} real)`);

// ---- static server -------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const m = u.match(/^\/page\/(\d+)$/);
  if (m) {
    const start = Number(m[1]) * batchSize;
    const slice = files.slice(start, start + batchSize);
    const body = `<!doctype html><meta charset="utf-8"><title>bench ${m[1]}</title>
<style>img{width:200px;height:auto;margin:2px}</style>
${slice.map(({ label, f }) => `<img src="/img/${label}/${encodeURIComponent(f)}" data-label="${label}" data-name="${f}">`).join('\n')}`;
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    return;
  }
  const im = u.match(/^\/img\/(real|ai)\/(.+)$/);
  if (im) {
    const f = path.join(dataDir, im[1], path.basename(im[2]));
    if (existsSync(f)) {
      res.writeHead(200, { 'content-type': exts[path.extname(f).toLowerCase()] || 'application/octet-stream' }).end(readFileSync(f));
      return;
    }
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- browser -------------------------------------------------------------
function findChrome() {
  const b = path.join(root, 'tools', 'browsers', 'chrome');
  return readdirSync(b).sort().reverse()
    .flatMap((v) => [
      path.join(b, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(b, v, 'chrome-linux64', 'chrome'),
    ])
    .find(existsSync);
}
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: false,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-bench-')),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run', '--window-size=1200,900'],
  protocolTimeout: 600_000,
});

const rows = [];
try {
  const page = await browser.newPage();
  const nPages = Math.ceil(files.length / batchSize);
  for (let i = 0; i < nPages; i++) {
    const t0 = Date.now();
    await page.goto(`${base}/page/${i}`, { waitUntil: 'domcontentloaded' });
    // Salvage partial pages: a single stuck image must not sink the run.
    await page
      .waitForFunction(
        () => [...document.images].every((im) => im.dataset.detectraScore || im.dataset.detectraError),
        { timeout: 120_000, polling: 700 }
      )
      .catch(() => console.warn(`  page ${i}: timeout — collecting partial results`));
    const batch = await page.evaluate(() =>
      [...document.images].map((im) => ({
        name: im.dataset.name,
        label: im.dataset.label,
        score: im.dataset.detectraScore ? Number(im.dataset.detectraScore) : null,
        logit: im.dataset.detectraLogit ? Number(im.dataset.detectraLogit) : null,
        error: im.dataset.detectraError ?? null,
      }))
    );
    rows.push(...batch);
    const done = rows.filter((r) => r.score != null).length;
    console.log(`page ${i + 1}/${nPages}: ${batch.length} imgs in ${((Date.now() - t0) / 1000).toFixed(1)}s (${done}/${files.length} scored)`);
  }
} finally {
  await browser.close();
  server.close();
}

// ---- metrics -------------------------------------------------------------
const scored = rows.filter((r) => r.score != null);
const ai = scored.filter((r) => r.label === 'ai');
const real = scored.filter((r) => r.label === 'real');
const tpr = ai.filter((r) => r.score >= THRESHOLD).length / ai.length;
const tnr = real.filter((r) => r.score < THRESHOLD).length / real.length;
console.log(`\n=== browser-pipeline results (threshold ${THRESHOLD}) ===`);
console.log(`scored ${scored.length}/${rows.length} (${rows.length - scored.length} errors)`);
console.log(`TPR ${(tpr * 100).toFixed(2)}%  TNR ${(tnr * 100).toFixed(2)}%  balanced accuracy ${((tpr + tnr) * 50).toFixed(2)}%`);

// per-source breakdown (source = filename prefix before last _NNNNN)
const bySource = {};
for (const r of scored) {
  const src = `${r.name.replace(/_\d+\.\w+$/, '').split('_')[0]} (${r.label})`;
  (bySource[src] ??= []).push(r);
}
console.log('\nper-source accuracy at 0.65:');
for (const [src, rs] of Object.entries(bySource).sort()) {
  const isAI = rs[0].label === 'ai';
  const correct = rs.filter((r) => (isAI ? r.score >= THRESHOLD : r.score < THRESHOLD)).length;
  console.log(`  ${src.padEnd(24)} ${((correct / rs.length) * 100).toFixed(1).padStart(6)}%  (n=${rs.length})`);
}

// sweep: where would the best threshold be?
let best = { t: 0, ba: 0 };
for (let t = 0.05; t < 1; t += 0.01) {
  const tp = ai.filter((r) => r.score >= t).length / ai.length;
  const tn = real.filter((r) => r.score < t).length / real.length;
  const ba = (tp + tn) / 2;
  if (ba > best.ba) best = { t, ba };
}
console.log(`\nbest threshold ${best.t.toFixed(2)} → balanced accuracy ${(best.ba * 100).toFixed(2)}% (calibration target: map this to 0.65)`);

mkdirSync(path.dirname(outCsv), { recursive: true });
writeFileSync(outCsv, 'name,label,score,logit,error\n' + rows.map((r) => `${r.name},${r.label},${r.score ?? ''},${r.logit ?? ''},${JSON.stringify(r.error ?? '')}`).join('\n'));
console.log(`wrote ${outCsv}`);
