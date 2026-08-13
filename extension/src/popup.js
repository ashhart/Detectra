// Detectra — popup dashboard.
const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderStatus(s) {
  if (!s) return;
  $('engine').textContent = s.engine === 'webgpu' ? '⚡ WebGPU' : s.engine === 'wasm' ? '🧮 WASM' : '…';
  $('model').textContent = s.model || '…';
  $('speed').textContent = s.avgMs ? `${s.avgMs} ms/image` : '–';
  const st = $('status');
  const bar = $('bar');
  if (s.status === 'ready') { st.textContent = 'ready'; st.className = 'v ok'; bar.style.display = 'none'; }
  else if (s.status === 'downloading') {
    st.textContent = `downloading model ${Math.round((s.progress || 0) * 100)}%`;
    st.className = 'v warn';
    bar.style.display = 'block';
    $('fill').style.width = `${Math.round((s.progress || 0) * 100)}%`;
  } else if (s.status === 'error') { st.textContent = s.error || 'error'; st.className = 'v bad'; }
  else { st.textContent = s.status; st.className = 'v warn'; }
}

async function refreshStats() {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'page-stats' });
    if (s?.ok) {
      $('s-total').textContent = s.total;
      $('s-ai').textContent = s.ai;
      $('s-real').textContent = s.real;
      $('s-unsure').textContent = s.unsure;
    }
  } catch { /* page without content script (chrome://, store) */ }
}

async function refreshSiteToggle() {
  const tab = await activeTab();
  const host = tab?.url ? new URL(tab.url).hostname : '';
  const { siteDisabled = {} } = await chrome.storage.local.get('siteDisabled');
  $('toggle-site').textContent = siteDisabled[host] ? `Enable on ${host}` : `Disable on this site`;
  return host;
}

$('rescan').onclick = async () => {
  const tab = await activeTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => {});
  setTimeout(refreshStats, 800);
};

$('toggle-site').onclick = async () => {
  const host = await refreshSiteToggle();
  const { siteDisabled = {} } = await chrome.storage.local.get('siteDisabled');
  siteDisabled[host] = !siteDisabled[host];
  if (!siteDisabled[host]) delete siteDisabled[host];
  await chrome.storage.local.set({ siteDisabled });
  const tab = await activeTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'set-enabled', enabled: !siteDisabled[host] }).catch(() => {});
  refreshSiteToggle();
};

$('open-lab').onclick = () => chrome.runtime.sendMessage({ target: 'bg', type: 'open-lab' });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'broadcast' && msg.type === 'engine-status') renderStatus(msg);
});

(async function init() {
  refreshSiteToggle();
  refreshStats();
  const s = await chrome.runtime.sendMessage({ target: 'bg', type: 'engine-status' }).catch(() => null);
  renderStatus(s);
  if (!s || s.status === 'boot' || s.status === 'error') {
    // Nudge the engine (also (re)starts a failed model download).
    chrome.runtime.sendMessage({ target: 'bg', type: 'ensure-model' }).then(renderStatus).catch(() => {});
  }
  setInterval(refreshStats, 2000);
})();
