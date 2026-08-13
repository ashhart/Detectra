// Detectra — metadata forensics.
// Pure functions over raw image bytes. No network, no DOM.
// Extracts provenance signals: C2PA/JUMBF manifests, PNG text chunks
// (Stable Diffusion WebUI / ComfyUI / NovelAI), EXIF Software tags, XMP
// markers, and the IPTC digitalSourceType "trainedAlgorithmicMedia" flag.
//
// Design rule (documented for benchmark honesty): metadata can PROVE an image
// is AI (a signed C2PA manifest from a generator, an embedded SD prompt), but
// its absence proves nothing, and camera EXIF is spoofable. So AI evidence
// raises the final score; "real" evidence is surfaced as context only.

const AI_GENERATOR_MARKERS = [
  // C2PA claim generators / softwareAgent strings, EXIF Software, XMP CreatorTool
  'midjourney', 'dall-e', 'dall·e', 'dalle', 'openai', 'gpt-4o', 'chatgpt',
  'adobe firefly', 'firefly', 'stable diffusion', 'stablediffusion', 'sdxl',
  'stability ai', 'stability.ai', 'flux', 'black forest labs', 'ideogram',
  'recraft', 'imagen', 'gemini', 'grok', 'aurora', 'novelai', 'comfyui',
  'invokeai', 'automatic1111', 'sd-webui', 'fooocus', 'draw things',
  'leonardo.ai', 'leonardo ai', 'krea', 'luma', 'reve', 'seedream', 'kling',
  'wan2', 'hidream', 'playground ai', 'bing image creator', 'designer.microsoft',
];

const IPTC_AI_SOURCETYPES = [
  'trainedalgorithmicmedia', // IPTC standard marker for generative AI
  'compositewithtrainedalgorithmicmedia',
  'algorithmicmedia',
];

const latin1 = new TextDecoder('latin1');

function u32(b, o) { return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; }
function ascii(b, o, n) { return latin1.decode(b.subarray(o, o + n)); }

// ---------------------------------------------------------------- PNG ------

function scanPNG(u8, out) {
  let o = 8; // skip signature
  while (o + 12 <= u8.length) {
    const len = u32(u8, o);
    const type = ascii(u8, o + 4, 4);
    const dataStart = o + 8;
    if (len > u8.length - dataStart) break;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const raw = u8.subarray(dataStart, dataStart + Math.min(len, 1 << 20));
      const nul = raw.indexOf(0);
      const key = nul > 0 ? latin1.decode(raw.subarray(0, nul)).toLowerCase() : '';
      const text = latin1.decode(raw.subarray(nul + 1)); // compressed for zTXt; string-scan still often works on keys
      if (key === 'parameters' && /steps:|sampler:|cfg scale:/i.test(text)) {
        out.push(sig('sd-parameters', 'ai', 'Stable Diffusion parameters embedded',
          `PNG "parameters" chunk with generation settings (${trim(text, 80)})`));
      } else if ((key === 'prompt' || key === 'workflow') && /"class_type"|"inputs"/.test(text)) {
        out.push(sig('comfyui-workflow', 'ai', 'ComfyUI workflow embedded',
          `PNG "${key}" chunk contains a ComfyUI node graph`));
      } else if (key === 'software' && /novelai/i.test(text)) {
        out.push(sig('novelai', 'ai', 'NovelAI software tag', trim(text, 80)));
      } else if (key === 'xml:com.adobe.xmp') {
        scanXMPText(text, out);
      }
    } else if (type === 'caBX') {
      out.push(sig('c2pa-present', 'info', 'C2PA provenance manifest found',
        'PNG caBX chunk (JUMBF) — scanning claim generator'));
      scanC2PABytes(u8.subarray(dataStart, dataStart + Math.min(len, 1 << 21)), out);
    } else if (type === 'eXIf') {
      scanTIFF(u8.subarray(dataStart, dataStart + len), out);
    }
    o = dataStart + len + 4; // skip CRC
  }
}

// --------------------------------------------------------------- JPEG ------

function scanJPEG(u8, out) {
  let o = 2;
  while (o + 4 <= u8.length) {
    if (u8[o] !== 0xff) { o++; continue; }
    const marker = u8[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    if (marker === 0xda) break; // start of scan — entropy data follows
    const len = (u8[o + 2] << 8) | u8[o + 3];
    const seg = u8.subarray(o + 4, o + 2 + len);
    if (marker === 0xe1) {
      const head = ascii(seg, 0, Math.min(32, seg.length));
      if (head.startsWith('Exif\x00\x00')) scanTIFF(seg.subarray(6), out);
      else if (head.includes('ns.adobe.com/xap')) scanXMPText(latin1.decode(seg), out);
    } else if (marker === 0xeb) {
      // APP11 JUMBF — where C2PA lives in JPEG
      const s = latin1.decode(seg.subarray(0, Math.min(seg.length, 64)));
      if (s.includes('JP') || s.includes('jumb') || s.includes('c2pa')) {
        out.push(sig('c2pa-present', 'info', 'C2PA provenance manifest found',
          'JPEG APP11 JUMBF box — scanning claim generator'));
        scanC2PABytes(seg, out);
      }
    } else if (marker === 0xed) {
      // APP13 Photoshop IRB / IPTC-IIM
      const s = latin1.decode(seg).toLowerCase();
      for (const t of IPTC_AI_SOURCETYPES) {
        if (s.includes(t)) {
          out.push(sig('iptc-ai', 'ai', 'IPTC digitalSourceType marks generative AI', t));
          break;
        }
      }
    }
    o += 2 + len;
  }
}

// ------------------------------------------------- minimal TIFF/EXIF -------

function scanTIFF(t, out) {
  if (t.length < 14) return;
  const le = ascii(t, 0, 2) === 'II';
  const rd16 = (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const rd32 = (o) =>
    (le
      ? t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)
      : (t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0;
  const readIFD = (off, tags) => {
    if (off + 2 > t.length) return;
    const n = rd16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) return;
      const tag = rd16(e);
      const type = rd16(e + 2);
      const count = rd32(e + 4);
      let vo = e + 8;
      const size = (type === 2 ? 1 : type === 3 ? 2 : type === 4 ? 4 : 1) * count;
      if (size > 4) vo = rd32(e + 8);
      if (tags[tag]) tags[tag]({ type, count, valueOffset: vo });
    }
  };
  const str = (v) => {
    if (v.valueOffset + v.count > t.length) return '';
    return latin1.decode(t.subarray(v.valueOffset, v.valueOffset + v.count)).replace(/\0+$/, '').trim();
  };
  const found = { software: '', make: '', model: '', hasMakerNote: false, hasDateTimeOriginal: false };
  let exifOff = 0;
  readIFD(rd32(4), {
    0x0131: (v) => (found.software = str(v)),
    0x010f: (v) => (found.make = str(v)),
    0x0110: (v) => (found.model = str(v)),
    0x8769: (v) => (exifOff = v.valueOffset),
  });
  if (exifOff) {
    readIFD(exifOff, {
      0x927c: () => (found.hasMakerNote = true),
      0x9003: () => (found.hasDateTimeOriginal = true),
    });
  }
  const sw = found.software.toLowerCase();
  const hit = AI_GENERATOR_MARKERS.find((m) => sw.includes(m));
  if (hit) {
    out.push(sig('exif-ai-software', 'ai', `EXIF Software: ${found.software}`, `matches AI generator "${hit}"`));
  }
  if ((found.make || found.model) && found.hasMakerNote && !hit) {
    out.push(sig('camera-exif', 'real', `Camera EXIF: ${[found.make, found.model].filter(Boolean).join(' ')}`,
      `MakerNote present${found.hasDateTimeOriginal ? ', capture timestamp present' : ''} — context only (EXIF is spoofable)`));
  }
}

// ------------------------------------------------------- XMP / C2PA -------

function scanXMPText(s, out) {
  const l = s.toLowerCase();
  for (const t of IPTC_AI_SOURCETYPES) {
    if (l.includes('digitalsourcetype') && l.includes(t)) {
      out.push(sig('iptc-ai', 'ai', 'XMP digitalSourceType marks generative AI', t));
      break;
    }
  }
  const creator = l.match(/creatortool[^<>"]{0,10}[>"']([^<"']{1,80})/);
  const hay = creator ? creator[1] : l;
  const hit = AI_GENERATOR_MARKERS.find((m) => hay.includes(m));
  if (hit) out.push(sig('xmp-ai', 'ai', 'XMP metadata names an AI generator', `"${hit}"`));
  if (l.includes('midjourney') || /job id:\s*[0-9a-f-]{36}/.test(l)) {
    out.push(sig('xmp-midjourney', 'ai', 'Midjourney job metadata found', 'XMP description contains prompt/Job ID'));
  }
}

function scanC2PABytes(seg, out) {
  const s = latin1.decode(seg.subarray(0, Math.min(seg.length, 1 << 20))).toLowerCase();
  const hit = AI_GENERATOR_MARKERS.find((m) => s.includes(m));
  if (hit) {
    out.push(sig('c2pa-ai', 'ai', 'C2PA manifest names an AI generator', `claim generator matches "${hit}"`));
  } else if (/leica|nikon|sony|canon|truepic|capture/.test(s)) {
    out.push(sig('c2pa-camera', 'real', 'C2PA manifest suggests hardware capture', 'context only'));
  }
}

// --------------------------------------------------------- fallback --------

function scanGenericStrings(u8, out) {
  // Cheap final sweep over head+tail for anything the structured parsers missed
  // (WebP/AVIF metadata boxes, stray XMP, etc.)
  const cap = 1 << 20;
  const head = latin1.decode(u8.subarray(0, Math.min(cap, u8.length))).toLowerCase();
  const tail = u8.length > cap ? latin1.decode(u8.subarray(u8.length - cap)).toLowerCase() : '';
  const hay = head + '\n' + tail;
  if (!out.some((s) => s.id.startsWith('c2pa')) && (hay.includes('c2pa.claim') || hay.includes('c2pa_manifest'))) {
    out.push(sig('c2pa-present', 'info', 'C2PA provenance manifest found', 'unstructured scan'));
    const hit = AI_GENERATOR_MARKERS.find((m) => hay.includes(m));
    if (hit) out.push(sig('c2pa-ai', 'ai', 'C2PA manifest names an AI generator', `"${hit}"`));
  }
  if (!out.some((s) => s.id === 'iptc-ai')) {
    for (const t of IPTC_AI_SOURCETYPES) {
      if (hay.includes('digitalsourcetype') && hay.includes(t)) {
        out.push(sig('iptc-ai', 'ai', 'digitalSourceType marks generative AI', t));
        break;
      }
    }
  }
}

// ----------------------------------------------------------- public --------

function sig(id, kind, label, detail) {
  return { id, kind, label, detail };
}
function trim(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Scan raw image bytes for provenance signals.
 * @param {Uint8Array} u8
 * @returns {{signals: Array<{id:string,kind:'ai'|'real'|'info',label:string,detail:string}>}}
 */
export function scanMetadata(u8) {
  const out = [];
  try {
    if (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50) scanPNG(u8, out);
    else if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) scanJPEG(u8, out);
    scanGenericStrings(u8, out);
  } catch (e) {
    out.push(sig('meta-error', 'info', 'Metadata scan failed', String(e?.message || e)));
  }
  // de-dupe by id
  const seen = new Set();
  return { signals: out.filter((s) => !seen.has(s.id) && seen.add(s.id)) };
}

/**
 * Fuse the neural probability with metadata evidence.
 * AI-proving evidence raises the score to at least 0.97; nothing lowers it.
 */
export function fuseSignals(neuralP, signals) {
  const hardAI = signals.some((s) => s.kind === 'ai');
  return hardAI ? Math.max(neuralP, 0.97) : neuralP;
}
