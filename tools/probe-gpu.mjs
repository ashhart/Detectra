// Probe WebGPU adapter availability in each extension context:
// service worker vs offscreen document. Decides where the engine should live.
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'extension', 'dist');
const base = path.join(root, 'tools', 'browsers', 'chrome');
const chromePath = readdirSync(base).sort().reverse()
  .map((v) => path.join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
  .find(existsSync);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'detectra-probe-')),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
});

const PROBE = `(async () => {
  if (!('gpu' in navigator)) return 'no navigator.gpu';
  const t = setTimeout(() => {}, 0);
  const adapter = await Promise.race([
    navigator.gpu.requestAdapter(),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 5000)),
  ]);
  if (adapter === 'TIMEOUT') return 'requestAdapter TIMEOUT (5s)';
  if (!adapter) return 'adapter: null';
  const d = await Promise.race([
    adapter.requestDevice(),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 5000)),
  ]);
  return d === 'TIMEOUT' ? 'requestDevice TIMEOUT' : 'DEVICE OK (' + (adapter.info?.architecture || '?') + ')';
})()`;

try {
  for (const type of ['service_worker', 'background_page']) {
    const target = await browser.waitForTarget((t) => t.type() === type, { timeout: 20000 }).catch(() => null);
    if (!target) { console.log(`${type}: not found`); continue; }
    const session = await target.createCDPSession();
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: PROBE,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log(`${type}:`, exceptionDetails ? exceptionDetails.text : result.value);
  }
} finally {
  await browser.close();
}
