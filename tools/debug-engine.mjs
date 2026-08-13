// Open the extension's offscreen.html as a visible tab and stream its console.
// Direct window into engine boot: EP selection, session create, warmup timing.
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'extension', 'dist');

function findChromeForTesting() {
  const base = path.join(root, 'tools', 'browsers', 'chrome');
  for (const v of readdirSync(base).sort().reverse()) {
    const p = path.join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  throw new Error('no chrome for testing');
}

const browser = await puppeteer.launch({
  executablePath: findChromeForTesting(),
  headless: false,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-dbg-')),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m.text()));
  page.on('pageerror', (e) => console.log('[ERR]', e.message));
  await page.goto(`chrome-extension://${extId}/offscreen.html`);
  console.log('--- offscreen.html open; gpu?', await page.evaluate(() => 'gpu' in navigator));
  if (await page.evaluate(() => 'gpu' in navigator)) {
    console.log('--- adapter:', await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      return a ? (a.info ? JSON.stringify(a.info) : 'adapter ok') : 'NO ADAPTER';
    }));
  }
  // Give the engine up to 5 minutes; logs will show where time goes.
  await new Promise((r) => setTimeout(r, 90_000));
} finally {
  await browser.close();
}
