// Offscreen documents are hidden pages: requestAnimationFrame callbacks never
// fire there, but onnxruntime-web's WebGPU path awaits rAF during session
// creation. Replace it with a timer-driven equivalent before ORT initializes.
// (Must be imported BEFORE onnxruntime-web.)
if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
  const raf = (cb) => setTimeout(() => cb(performance.now()), 8);
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
