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

let activeTabId = null;
let pollTimer = null;

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
  const res = await chrome.runtime.sendMessage({ type: 'XTRACTARR_STATUS', tabId: activeTabId });
  if (res?.ok) renderStatus(res);
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
