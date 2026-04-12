// ─── Extract mode elements ───
const els = {
  statusText: document.getElementById('statusText'),
  progressPct: document.getElementById('progressPct'),
  progressBar: document.getElementById('progressBar'),
  actionText: document.getElementById('actionText'),
  recordsCount: document.getElementById('recordsCount'),
  eventsCount: document.getElementById('eventsCount'),
  exportsCount: document.getElementById('exportsCount'),
  pageLimit: document.getElementById('pageLimit'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  exportBtn: document.getElementById('exportBtn'),
  hint: document.getElementById('hint')
};

// ─── Verify mode elements ───
const vEls = {
  statusText: document.getElementById('vStatusText'),
  progressPct: document.getElementById('vProgressPct'),
  progressBar: document.getElementById('vProgressBar'),
  processed: document.getElementById('vProcessed'),
  still: document.getElementById('vStill'),
  moved: document.getElementById('vMoved'),
  csvFile: document.getElementById('csvFile'),
  csvInfo: document.getElementById('csvInfo'),
  startBtn: document.getElementById('verifyStartBtn'),
  stopBtn: document.getElementById('verifyStopBtn'),
  hint: document.getElementById('vHint'),
};

// ─── Mode toggle ───
const modeExtractBtn = document.getElementById('modeExtract');
const modeVerifyBtn = document.getElementById('modeVerify');
const extractPanel = document.getElementById('extractPanel');
const verifyPanel = document.getElementById('verifyPanel');

let currentMode = 'extract';
let activeTabId = null;
let pollTimer = null;
let csvText = null;

modeExtractBtn.addEventListener('click', () => switchMode('extract'));
modeVerifyBtn.addEventListener('click', () => switchMode('verify'));

function switchMode(mode) {
  currentMode = mode;
  modeExtractBtn.classList.toggle('active', mode === 'extract');
  modeVerifyBtn.classList.toggle('active', mode === 'verify');
  extractPanel.style.display = mode === 'extract' ? '' : 'none';
  verifyPanel.style.display = mode === 'verify' ? '' : 'none';
}

// ─── Extract mode (unchanged) ───
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

function renderStatus(state) {
  const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
  els.statusText.textContent = state.statusText || 'Idle';
  els.progressPct.textContent = `${progress}%`;
  els.progressBar.style.width = `${progress}%`;
  els.actionText.textContent = `Action: ${state.currentAction || 'idle'}`;

  els.recordsCount.textContent = String(state.records || 0);
  els.eventsCount.textContent = String(state.events || 0);
  els.exportsCount.textContent = String(state.exports || 0);

  els.startBtn.disabled = !!state.active;
  els.stopBtn.disabled = !state.active;
  els.exportBtn.disabled = (state.records || 0) === 0;
  els.pageLimit.disabled = !!state.active;

  if (state.active && typeof state.targetPages === 'number' && Number.isFinite(state.targetPages) && state.targetPages > 0) {
    els.pageLimit.value = String(state.targetPages);
  }

  if (state.active) {
    const pageText = state.targetPages > 1
      ? ` Running page ${state.currentPage || 1}/${state.targetPages}.`
      : '';
    els.hint.textContent = `Extraction is running. Keep Sales Navigator open until export completes.${pageText}`;
  } else if ((state.exports || 0) > 0) {
    els.hint.textContent = 'Export completed. Files are saved in your Downloads folder.';
  } else {
    els.hint.textContent = 'Open a LinkedIn Sales Navigator page, then click START EXTRACTION.';
  }
}

async function requestStatus() {
  if (activeTabId == null) return;
  if (currentMode === 'extract') {
    const res = await chrome.runtime.sendMessage({ type: 'XTRACTARR_STATUS', tabId: activeTabId });
    if (res?.ok) renderStatus(res);
  } else {
    const res = await chrome.runtime.sendMessage({ type: 'VERIFY_STATUS' });
    if (res?.ok) renderVerifyStatus(res);
  }
}

async function startExtraction() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  activeTabId = tab.id;

  if (!String(tab.url || '').includes('linkedin.com/sales/')) {
    els.hint.textContent = 'Please open a LinkedIn Sales Navigator page first.';
    return;
  }

  const requestedPages = Math.max(1, Math.min(50, Number(els.pageLimit.value || 50) || 50));
  els.pageLimit.value = String(requestedPages);

  const res = await chrome.runtime.sendMessage({
    type: 'XTRACTARR_START',
    tabId: activeTabId,
    pageUrl: tab.url,
    maxPages: requestedPages
  });
  if (res?.ok) renderStatus(res);
}

async function stopExtraction() {
  if (activeTabId == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'XTRACTARR_STOP', tabId: activeTabId });
  if (res?.ok) renderStatus(res);
}

async function exportNow() {
  if (activeTabId == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'XTRACTARR_EXPORT_NOW', tabId: activeTabId });
  if (res?.ok) renderStatus(res);
}

// ─── Verify mode ───
function handleCsvText(text, label) {
  csvText = text;
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  const count = Math.max(0, lines.length - 1);
  vEls.csvInfo.textContent = `${label} — ${count} contacts found`;
  vEls.startBtn.disabled = count === 0;
}

function readCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => handleCsvText(ev.target.result, file.name);
  reader.readAsText(file);
}

// Hidden file input (fallback for click-to-browse)
vEls.csvFile.addEventListener('change', (e) => readCsvFile(e.target.files[0]));

// Drop zone
const dropZone = document.getElementById('csvDropZone');

dropZone.addEventListener('click', () => {
  // Open file picker via hidden input — may crash on some Linux WMs
  // Using a small delay helps with popup focus issues
  setTimeout(() => vEls.csvFile.click(), 100);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = '#4f9';
  dropZone.style.background = 'rgba(68,255,153,0.08)';
});

dropZone.addEventListener('dragleave', () => {
  dropZone.style.borderColor = '#555';
  dropZone.style.background = '';
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = '#555';
  dropZone.style.background = '';
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.csv')) readCsvFile(file);
});

// Paste CSV text anywhere in the popup
document.addEventListener('paste', (e) => {
  const text = e.clipboardData.getData('text');
  if (text && text.includes(',')) {
    handleCsvText(text, 'Pasted CSV');
  }
});

async function getCsrfToken() {
  // Get CSRF token from the active LinkedIn tab
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const m = document.cookie.match(/JSESSIONID="?([^";]+)/);
        return m ? m[1] : null;
      }
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function startVerification() {
  if (!csvText) {
    vEls.hint.textContent = 'Please upload a CSV file first.';
    return;
  }

  const csrfToken = await getCsrfToken();
  if (!csrfToken) {
    vEls.hint.textContent = 'Could not get session token. Open any LinkedIn page in a tab first.';
    return;
  }

  vEls.startBtn.disabled = true;
  vEls.stopBtn.disabled = false;
  vEls.csvFile.disabled = true;
  vEls.hint.textContent = 'Verification running... Results will download when complete.';

  const res = await chrome.runtime.sendMessage({
    type: 'VERIFY_START',
    csvText,
    csrfToken,
  });

  if (!res?.ok) {
    vEls.hint.textContent = `Error: ${res?.error || 'Unknown error'}`;
    vEls.startBtn.disabled = false;
    vEls.stopBtn.disabled = true;
    vEls.csvFile.disabled = false;
  }
}

async function stopVerification() {
  await chrome.runtime.sendMessage({ type: 'VERIFY_STOP' });
  vEls.stopBtn.disabled = true;
}

function renderVerifyStatus(state) {
  const total = state.total || 0;
  const current = state.current || 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  vEls.progressPct.textContent = `${pct}%`;
  vEls.progressBar.style.width = `${pct}%`;
  vEls.processed.textContent = String(current);

  // Count statuses from results
  const results = state.results || 0;
  // We'll get detailed counts via the results array length and status
  // For now show processed count
  if (state.running) {
    vEls.statusText.textContent = `Verifying ${current}/${total}...`;
    vEls.hint.textContent = `Processing contact ${current} of ${total}. Keep LinkedIn open.`;
    vEls.startBtn.disabled = true;
    vEls.stopBtn.disabled = false;
  } else if (current > 0 && current >= total) {
    vEls.statusText.textContent = 'Complete!';
    vEls.hint.textContent = 'Verification complete! Results CSV saved to Downloads.';
    vEls.startBtn.disabled = !csvText;
    vEls.stopBtn.disabled = true;
    vEls.csvFile.disabled = false;
    vEls.progressBar.style.width = '100%';
    vEls.progressPct.textContent = '100%';
  } else if (state.error) {
    vEls.statusText.textContent = 'Error';
    vEls.hint.textContent = `Error: ${state.error}`;
    vEls.startBtn.disabled = !csvText;
    vEls.stopBtn.disabled = true;
    vEls.csvFile.disabled = false;
  } else {
    vEls.statusText.textContent = 'Ready';
  }
}

vEls.startBtn.addEventListener('click', startVerification);
vEls.stopBtn.addEventListener('click', stopVerification);

// ─── Init ───
async function init() {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;

  els.startBtn.addEventListener('click', startExtraction);
  els.stopBtn.addEventListener('click', stopExtraction);
  els.exportBtn.addEventListener('click', exportNow);

  await requestStatus();
  pollTimer = setInterval(requestStatus, 1000);
}

window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

init().catch((err) => {
  els.hint.textContent = `Popup error: ${String(err)}`;
});
