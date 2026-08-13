// Detectra — background service worker: hosts the inference engine.
// WebGPU is available to extension service workers (Chrome 124+); hidden
// offscreen documents starve GPU work, so the engine lives here. The model
// session is rebuilt after service-worker teardown (~1s) — model bytes stay
// in Cache Storage so that costs no network traffic.

import { ensureSession, analyze, explain, statusPayload, setCalibration, noteError } from './lib/engine.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'detectra-analyze',
    title: 'Analyze image with Detectra',
    contexts: ['image'],
  });
  // Kick the one-time model download so the extension is ready (and fully
  // offline-capable) as soon as possible after install.
  boot();
});
chrome.runtime.onStartup.addListener(boot);

function boot() {
  ensureSession().catch((e) => noteError(e));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'detectra-analyze' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'analyze-src', srcUrl: info.srcUrl }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return undefined;
  (async () => {
    switch (msg.type) {
      case 'analyze':
        sendResponse(await analyze(msg));
        break;
      case 'explain':
        sendResponse(await explain(msg));
        break;
      case 'ensure-model':
        await ensureSession();
        sendResponse({ ok: true, ...statusPayload() });
        break;
      case 'engine-status':
        sendResponse({ ok: true, ...statusPayload() });
        break;
      case 'set-calibration':
        await chrome.storage.local.set({ calibration: msg.calibration });
        setCalibration(msg.calibration);
        sendResponse({ ok: true });
        break;
      case 'open-lab':
        await chrome.tabs.create({ url: chrome.runtime.getURL('lab.html') });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: `unknown message: ${msg.type}` });
    }
  })().catch((e) => {
    noteError(e);
    sendResponse({ ok: false, error: String(e?.message || e) });
  });
  return true; // async response
});

// Lazy boot on any wake-up (covers analyze-after-teardown).
boot();
