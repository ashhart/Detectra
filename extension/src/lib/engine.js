// Detectra — inference engine (context-agnostic module).
// Owns the neural network session (ONNX Runtime Web: WebGPU with WASM
// fallback), image fetching + decoding, preprocessing that mirrors the
// training pipeline exactly, metadata forensics, and score fusion.
// Hosted in the extension SERVICE WORKER: hidden offscreen documents starve
// GPU work indefinitely (shader compiles never finish), while extension
// service workers get full WebGPU access on Chrome 124+.

// The ".bundle" build embeds the WASM JS glue statically — required in
// service workers, where dynamic import() (used by the regular builds to
// load the glue) is forbidden.
import * as ort from '../../../node_modules/onnxruntime-web/dist/ort.bundle.min.mjs';
import { scanMetadata, fuseSignals } from './meta.js';

const MODEL_CACHE = 'detectra-models-v1';
const MAX_BYTES = 40 * 1024 * 1024; // refuse to fetch >40MB images
const state = {
  session: null,
  engine: null, // 'webgpu' | 'wasm'
  model: null, // entry from models.json
  calibration: { a: 1, b: 0 },
  status: 'boot', // boot | downloading | loading | ready | error
  progress: 0,
  error: null,
  cache: new Map(), // url -> result (LRU-ish, capped)
  timings: [],
  log: [], // boot/diagnostic ring buffer, surfaced via engine-status
};

function dlog(...args) {
  const line = `${(performance.now() / 1000).toFixed(1)}s ${args.map(String).join(' ')}`;
  state.log.push(line);
  if (state.log.length > 50) state.log.shift();
  console.log('[detectra]', ...args);
}

// ------------------------------------------------------------ model --------

async function loadManifest() {
  const res = await fetch(chrome.runtime.getURL('models.json'));
  const manifest = await res.json();
  state.model = manifest.models[0];
  state.calibration = manifest.calibration ?? { a: 1, b: 0 };
  const stored = await chrome.storage.local.get('calibration');
  if (stored?.calibration) state.calibration = stored.calibration;
}

async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getModelBytes() {
  const m = state.model;
  // Dev convenience: a model file bundled into the unpacked build wins.
  if (m.devLocal) {
    try {
      const r = await fetch(chrome.runtime.getURL(m.devLocal));
      if (r.ok) return await r.arrayBuffer();
    } catch { /* fall through to download */ }
  }
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(m.url);
  if (hit) return await hit.arrayBuffer();

  // One-time download of public weights (allowed by bounty rules at setup).
  setStatus('downloading', 0);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || m.bytes || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) setStatus('downloading', got / total);
  }
  const buf = await new Blob(chunks).arrayBuffer();
  if (m.sha256 && m.sha256 !== 'TBD') {
    const digest = await sha256hex(buf);
    if (digest !== m.sha256) throw new Error(`model checksum mismatch: ${digest}`);
  }
  await cache.put(m.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
  return buf;
}

let sessionPromise = null;

/** Single-flight session boot — concurrent callers share one promise.
 *  (Two interleaved creates on the WebGPU backend → "Session mismatch".) */
function ensureSession() {
  sessionPromise ??= createSession().catch((e) => {
    sessionPromise = null; // allow retry after failure
    throw e;
  });
  return sessionPromise;
}

async function createSession() {
  if (state.session) return state.session;
  dlog('engine boot; webgpu available:', 'gpu' in navigator);
  await loadManifest();
  const t0 = performance.now();
  const bytes = await getModelBytes();
  dlog(`model bytes: ${(bytes.byteLength / 1e6).toFixed(1)}MB in ${Math.round(performance.now() - t0)}ms`);
  setStatus('loading', 1);

  // Provide the WASM binary directly: setting wasmPaths would make ORT
  // dynamic-import its JS glue, which service workers forbid. The .bundle
  // build embeds the glue; with wasmBinary set, nothing is imported at
  // runtime.
  ort.env.wasm.wasmBinary = await (
    await fetch(chrome.runtime.getURL('vendor/ort/ort-wasm-simd-threaded.jsep.wasm'))
  ).arrayBuffer();
  // Service workers cannot spawn Workers — single-threaded WASM fallback.
  ort.env.wasm.numThreads = typeof document === 'undefined' ? 1 : Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  ort.env.wasm.proxy = false;

  const attempts = [
    ['webgpu', { executionProviders: ['webgpu'] }],
    ['wasm', { executionProviders: ['wasm'] }],
  ];
  let lastErr;
  for (const [name, opts] of attempts) {
    if (name === 'webgpu' && !('gpu' in navigator)) continue;
    try {
      const t = performance.now();
      state.session = await ort.InferenceSession.create(bytes, {
        ...opts,
        graphOptimizationLevel: 'all',
      });
      state.engine = name;
      dlog(`session created (${name}) in ${Math.round(performance.now() - t)}ms`);
      break;
    } catch (e) {
      dlog(`WARN EP ${name} failed:`, e);
      lastErr = e;
    }
  }
  if (!state.session) throw new Error(`no execution provider available: ${lastErr}`);

  // Warm-up: first run compiles WebGPU shaders / instantiates WASM.
  const s = state.model.inputSize;
  const tw = performance.now();
  await state.session.run({ [state.session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * s * s), [1, 3, s, s]) });
  dlog(`warmup in ${Math.round(performance.now() - tw)}ms`);
  setStatus('ready', 1);
  return state.session;
}

// ------------------------------------------------------- preprocess --------

/**
 * Mirror of the model's eval transform:
 *   Resize(shortest edge → cfg.resize, bilinear) → CenterCrop(cfg.inputSize)
 *   → [0,1] → Normalize(ImageNet mean/std) → float32 CHW.
 */
function preprocess(bitmap) {
  const { resize, inputSize: crop, mean, std } = state.model;
  const scale = resize / Math.min(bitmap.width, bitmap.height);
  const w = Math.max(crop, Math.round(bitmap.width * scale));
  const h = Math.max(crop, Math.round(bitmap.height * scale));

  const c1 = new OffscreenCanvas(w, h);
  const g1 = c1.getContext('2d', { willReadFrequently: true });
  g1.imageSmoothingEnabled = true;
  g1.imageSmoothingQuality = 'high';
  g1.drawImage(bitmap, 0, 0, w, h);

  const sx = Math.floor((w - crop) / 2);
  const sy = Math.floor((h - crop) / 2);
  return imageDataToTensor(g1.getImageData(sx, sy, crop, crop), mean, std, crop);
}

function imageDataToTensor({ data }, mean, std, crop) {
  const out = new Float32Array(3 * crop * crop);
  const n = crop * crop;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    out[i] = (r - mean[0]) / std[0];
    out[n + i] = (g - mean[1]) / std[1];
    out[2 * n + i] = (b - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, crop, crop]);
}

/** Cut a square region of the bitmap and resize it to the model input. */
function preprocessRegion(bitmap, rx, ry, rs) {
  const { inputSize: crop, mean, std } = state.model;
  const c = new OffscreenCanvas(crop, crop);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, rx, ry, rs, rs, 0, 0, crop, crop);
  return imageDataToTensor(g.getImageData(0, 0, crop, crop), mean, std, crop);
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// ---------------------------------------------------------- analyze --------

async function fetchBytes(src) {
  const res = await fetch(src, { credentials: 'omit' });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length'));
  if (len && len > MAX_BYTES) throw new Error('image too large');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('image too large');
  return buf;
}

let queue = Promise.resolve();

async function analyze({ url, dataUrl }) {
  const key = url || `data:${dataUrl?.length}:${dataUrl?.slice(-64)}`;
  if (state.cache.has(key)) return { ...state.cache.get(key), cached: true };

  await ensureSession();
  const t0 = performance.now();

  const buf = await fetchBytes(dataUrl || url);
  const u8 = new Uint8Array(buf);
  const { signals } = scanMetadata(u8);

  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none' });
  } catch {
    throw new Error('undecodable image');
  }
  if (bitmap.width < 32 || bitmap.height < 32) {
    bitmap.close();
    throw new Error('image too small to analyze');
  }

  const tensor = preprocess(bitmap);
  bitmap.close();

  // Serialize inference — one image at a time through the GPU/WASM session.
  const run = () => state.session.run({ [state.session.inputNames[0]]: tensor });
  const result = await (queue = queue.then(run, run));
  const logit = result[state.session.outputNames[0]].data[0];

  const pRaw = sigmoid(logit);
  const { a, b } = state.calibration;
  const pCal = sigmoid(a * logit + b);
  const p = fuseSignals(pCal, signals);

  const ms = Math.round(performance.now() - t0);
  state.timings.push(ms);
  if (state.timings.length > 200) state.timings.shift();

  const out = {
    ok: true,
    p, // final fused, calibrated probability that the image is AI-generated
    pRaw, // uncalibrated model output (transparency)
    logit,
    signals,
    engine: state.engine,
    ms,
    model: state.model.id,
  };
  state.cache.set(key, out);
  if (state.cache.size > 1000) state.cache.delete(state.cache.keys().next().value);
  return out;
}

/**
 * Explainability: score a 3×3 grid of overlapping square regions so the UI
 * can show WHERE the detector sees generator artifacts. ~9 extra inferences,
 * only ever run on demand (hover), never during page scanning.
 */
async function explain({ url, dataUrl }) {
  await ensureSession();
  const buf = await fetchBytes(dataUrl || url);
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none' });
  } catch {
    throw new Error('undecodable image');
  }
  const N = 3;
  const side = Math.min(bitmap.width, bitmap.height);
  const rs = Math.round(side * 0.5); // tile covers half the short side
  const stepX = (bitmap.width - rs) / (N - 1);
  const stepY = (bitmap.height - rs) / (N - 1);
  const grid = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const tensor = preprocessRegion(bitmap, Math.round(gx * stepX), Math.round(gy * stepY), rs);
      const run = () => state.session.run({ [state.session.inputNames[0]]: tensor });
      const result = await (queue = queue.then(run, run));
      const logit = result[state.session.outputNames[0]].data[0];
      const { a, b } = state.calibration;
      grid.push(sigmoid(a * logit + b));
    }
  }
  bitmap.close();
  return { ok: true, grid, n: N };
}

// ---------------------------------------------------------- plumbing -------

function setStatus(status, progress) {
  state.status = status;
  state.progress = progress;
  chrome.runtime
    .sendMessage({ target: 'broadcast', type: 'engine-status', ...statusPayload() })
    .catch(() => {});
}

function statusPayload() {
  const t = state.timings;
  return {
    status: state.status,
    progress: state.progress,
    engine: state.engine,
    model: state.model?.id,
    error: state.error,
    avgMs: t.length ? Math.round(t.reduce((x, y) => x + y, 0) / t.length) : null,
    analyzed: state.cache.size,
    log: state.log,
  };
}

export { ensureSession, analyze, explain, statusPayload };

export function setCalibration(calibration) {
  state.calibration = calibration;
  state.cache.clear();
}

export function noteError(e) {
  state.error = String(e?.message || e);
  if (state.status !== 'ready') setStatus('error', 0);
}
