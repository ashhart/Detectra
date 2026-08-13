// Unit tests for the metadata forensics module — synthetic fixtures built
// byte-by-byte, no image files needed. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMetadata, fuseSignals } from '../extension/src/lib/meta.js';

const enc = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function pngWithText(key, text) {
  const data = [...enc(key), 0, ...enc(text)];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    ...u32(13), ...enc('IHDR'), ...new Array(13).fill(0), 0, 0, 0, 0, // fake IHDR + CRC
    ...u32(data.length), ...enc('tEXt'), ...data, 0, 0, 0, 0, // tEXt + CRC
    ...u32(0), ...enc('IEND'), 0, 0, 0, 0,
  ]);
}

function jpegWithExifSoftware(software) {
  const sw = software + '\0';
  // TIFF: II*\0, IFD@8, one entry (0x0131 Software, ASCII), value after IFD
  const tiff = [
    ...enc('II'), 42, 0, 8, 0, 0, 0, // header, IFD offset 8 (LE)
    1, 0, // 1 entry
    0x31, 0x01, 2, 0, ...[sw.length, 0, 0, 0], ...[26, 0, 0, 0], // tag/type/count/offset
    0, 0, 0, 0, // next IFD
    ...enc(sw),
  ];
  const seg = [...enc('Exif'), 0, 0, ...tiff];
  const len = seg.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...seg, 0xff, 0xd9]);
}

function jpegWithXMP(xml) {
  const seg = [...enc('http://ns.adobe.com/xap/1.0/'), 0, ...enc(xml)];
  const len = seg.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...seg, 0xff, 0xd9]);
}

test('PNG parameters chunk → sd-parameters signal', () => {
  const { signals } = scanMetadata(pngWithText('parameters', 'Steps: 20, Sampler: Euler a, CFG scale: 7'));
  assert.ok(signals.some((s) => s.id === 'sd-parameters' && s.kind === 'ai'));
});

test('PNG ComfyUI workflow chunk → comfyui-workflow signal', () => {
  const { signals } = scanMetadata(pngWithText('workflow', '{"1":{"class_type":"KSampler","inputs":{}}}'));
  assert.ok(signals.some((s) => s.id === 'comfyui-workflow' && s.kind === 'ai'));
});

test('EXIF Software=Midjourney → exif-ai-software signal', () => {
  const { signals } = scanMetadata(jpegWithExifSoftware('Midjourney v7'));
  assert.ok(signals.some((s) => s.id === 'exif-ai-software' && s.kind === 'ai'));
});

test('EXIF camera software stays silent', () => {
  const { signals } = scanMetadata(jpegWithExifSoftware('Adobe Lightroom 7.1'));
  assert.equal(signals.filter((s) => s.kind === 'ai').length, 0);
});

test('XMP digitalSourceType trainedAlgorithmicMedia → iptc-ai', () => {
  const xml = '<x:xmpmeta><rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></x:xmpmeta>';
  const { signals } = scanMetadata(jpegWithXMP(xml));
  assert.ok(signals.some((s) => s.id === 'iptc-ai' && s.kind === 'ai'));
});

test('clean bytes produce no AI signals', () => {
  const { signals } = scanMetadata(new Uint8Array(4096));
  assert.equal(signals.filter((s) => s.kind === 'ai').length, 0);
});

test('fusion: hard AI evidence raises to ≥0.97, never lowers', () => {
  const aiSig = [{ id: 'sd-parameters', kind: 'ai', label: '', detail: '' }];
  assert.equal(fuseSignals(0.2, aiSig), 0.97);
  assert.equal(fuseSignals(0.995, aiSig), 0.995);
  assert.equal(fuseSignals(0.4, []), 0.4);
  assert.equal(fuseSignals(0.4, [{ id: 'camera-exif', kind: 'real', label: '', detail: '' }]), 0.4);
});
