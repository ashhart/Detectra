// Detectra — Forensics Lab.
// Batch evaluation UI: drop labeled folders (real/ + ai|fake/) and get
// balanced accuracy at the 65% threshold, per-image scores and CSV export.
// Lets anyone reproduce evaluation results locally.

const AI_THRESHOLD = 0.65;
const rows = []; // {name, label:'real'|'ai'|null, p, pRaw, signals, ms, err, thumb}

const $ = (s) => document.querySelector(s);
const drop = $('#drop');
const dirInput = $('#file-input');
const flatInput = $('#file-input-flat');

drop.addEventListener('click', (e) => (e.shiftKey ? flatInput : dirInput).click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const files = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res));
      if (f.type.startsWith('image/')) files.push({ file: f, path: `${path}${f.name}` });
    } else if (entry.isDirectory) {
      const rd = entry.createReader();
      for (;;) {
        const batch = await new Promise((res) => rd.readEntries(res));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${path}${entry.name}/`);
      }
    }
  };
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  for (const en of entries) await walk(en, '');
  if (!entries.length) {
    for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) files.push({ file: f, path: f.name });
  }
  run(files);
});
dirInput.addEventListener('change', () =>
  run([...dirInput.files].filter((f) => f.type.startsWith('image/')).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))));
flatInput.addEventListener('change', () =>
  run([...flatInput.files].filter((f) => f.type.startsWith('image/')).map((f) => ({ file: f, path: f.name }))));

function inferLabel(path) {
  const p = path.toLowerCase();
  if (/(^|\/)(real|reals|nature|photo|photos)(\/|_)/.test(p)) return 'real';
  if (/(^|\/)(ai|fake|fakes|generated|synthetic)(\/|_)/.test(p)) return 'ai';
  return null;
}

const fileToDataUrl = (f) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(f);
  });

async function run(files) {
  if (!files.length) return;
  $('#results').style.display = 'table';
  $('#toolbar').style.display = 'block';
  const tbody = $('#results tbody');
  for (const { file, path } of files) {
    const dataUrl = await fileToDataUrl(file);
    const row = { name: path, label: inferLabel(path), p: null, pRaw: null, signals: [], ms: null, err: null, thumb: dataUrl };
    rows.push(row);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><img class="thumb" src="${dataUrl}"></td><td>${esc(path)}</td>
      <td>${row.label ?? '–'}</td><td><span class="pill err">…</span></td>
      <td class="num">…</td><td class="num">…</td><td>–</td><td class="num">…</td>`;
    tbody.appendChild(tr);
    try {
      const res = await chrome.runtime.sendMessage({ target: 'bg', type: 'analyze', dataUrl });
      if (!res?.ok) throw new Error(res?.error || 'no response');
      Object.assign(row, { p: res.p, pRaw: res.pRaw, signals: res.signals, ms: res.ms });
      const verdict = res.p >= AI_THRESHOLD ? 'ai' : res.p <= 0.35 ? 'real' : 'unsure';
      tr.children[3].innerHTML = `<span class="pill ${verdict}">${verdict.toUpperCase()}</span>`;
      tr.children[4].textContent = `${(res.p * 100).toFixed(1)}%`;
      tr.children[5].textContent = `${(res.pRaw * 100).toFixed(1)}%`;
      tr.children[6].textContent = res.signals?.length ? res.signals.map((s) => s.id).join(', ') : '–';
      tr.children[7].textContent = res.ms ?? '';
    } catch (err) {
      row.err = String(err?.message || err);
      tr.children[3].innerHTML = `<span class="pill err">error</span>`;
      tr.children[6].textContent = row.err;
    }
    summarize();
  }
}

function summarize() {
  const done = rows.filter((r) => r.p != null);
  const labeled = done.filter((r) => r.label);
  const el = $('#summary');
  el.style.display = 'grid';
  let cells = `
    <div class="stat"><div class="n">${done.length}</div><div class="l">images analyzed</div></div>
    <div class="stat"><div class="n bad">${done.filter((r) => r.p >= AI_THRESHOLD).length}</div><div class="l">called AI (≥65%)</div></div>`;
  if (labeled.length) {
    const ai = labeled.filter((r) => r.label === 'ai');
    const real = labeled.filter((r) => r.label === 'real');
    const tpr = ai.length ? ai.filter((r) => r.p >= AI_THRESHOLD).length / ai.length : 0;
    const tnr = real.length ? real.filter((r) => r.p < AI_THRESHOLD).length / real.length : 0;
    const ba = ai.length && real.length ? (tpr + tnr) / 2 : null;
    cells += `
      <div class="stat"><div class="n ${tpr >= 0.75 ? 'ok' : 'warn'}">${(tpr * 100).toFixed(1)}%</div><div class="l">AI detected (TPR, n=${ai.length})</div></div>
      <div class="stat"><div class="n ${tnr >= 0.75 ? 'ok' : 'warn'}">${(tnr * 100).toFixed(1)}%</div><div class="l">real kept (TNR, n=${real.length})</div></div>
      <div class="stat"><div class="n ${ba != null && ba >= 0.75 ? 'ok' : 'bad'}">${ba != null ? (ba * 100).toFixed(1) + '%' : '–'}</div><div class="l">balanced accuracy @65%</div></div>`;
  }
  el.innerHTML = cells;
}

$('#export').onclick = () => {
  const head = 'file,label,ai_confidence,neural_raw,verdict_at_65,signals,ms,error\n';
  const body = rows
    .map((r) =>
      [
        csv(r.name), r.label ?? '', r.p?.toFixed(4) ?? '', r.pRaw?.toFixed(4) ?? '',
        r.p != null ? (r.p >= AI_THRESHOLD ? 'ai' : 'real') : '',
        csv((r.signals || []).map((s) => s.id).join('; ')), r.ms ?? '', csv(r.err ?? ''),
      ].join(','))
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
  a.download = 'detectra-results.csv';
  a.click();
};

$('#clear').onclick = () => {
  rows.length = 0;
  $('#results tbody').innerHTML = '';
  $('#summary').style.display = 'none';
  $('#results').style.display = 'none';
  $('#toolbar').style.display = 'none';
};

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
function csv(s) { return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
