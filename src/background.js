const sessions = new Map();
const captureEnabledTabs = new Set();

const PROFILE_PATH_MARKER = '/sales/lead/';
const SEARCH_PATH_MARKER = '/sales/search/people';
const LIST_PATH_MARKER = '/sales/lists/people/';
const LINKEDIN_BASE = 'https://www.linkedin.com';
const COMPANY_DECORATION = '(entityUrn,employeeCount,employeeCountRange,name,pictureInfo,companyPictureDisplayImage,description,industry,location,headquarters,website,revenueRange,type,yearFounded,flagshipCompanyUrl)';

console.log('[XTRACTARR][BG] Service worker loaded');

function createSession(pageUrl = '') {
  return {
    rawEvents: [],
    records: new Map(),
    companies: new Map(),
    pendingCompanies: new Set(),
    idleTimer: null,
    lastExportedRecordCount: 0,
    pageUrl,
    csrfToken: '',
    startedAt: Date.now(),
    lastExportAt: null,
    exportCount: 0,
    maxPages: 1,
    currentPage: 1,
    pageAdvanceTimer: null,
    pageAdvanceInFlight: false,
    autoMode: false,
    currentAction: 'idle',
    nextActionAt: null
  };
}

function resetSession(tabId, pageUrl = '') {
  const old = sessions.get(tabId);
  clearSessionTimers(old);
  sessions.set(tabId, createSession(pageUrl));
  return sessions.get(tabId);
}

function clearSessionTimers(session) {
  if (!session) return;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (session.pageAdvanceTimer) {
    clearTimeout(session.pageAdvanceTimer);
    session.pageAdvanceTimer = null;
  }
  session.nextActionAt = null;
}

function getTabSession(tabId) {
  if (!sessions.has(tabId)) {
    sessions.set(tabId, createSession(''));
  }
  return sessions.get(tabId);
}

function safeJsonParse(input) {
  if (typeof input !== 'string' || !input) return null;
  try { return JSON.parse(input); } catch { return null; }
}

function parseId(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return String(raw);
  const str = String(raw);
  if (str.includes(':')) {
    const last = str.split(':').pop();
    return last || str;
  }
  return str;
}

function parseLinkedinPublicUrl(entityUrn) {
  if (!entityUrn || typeof entityUrn !== 'string') return null;
  const m = entityUrn.match(/\(([^)]+)\)/);
  if (!m || !m[1]) return null;
  return `https://www.linkedin.com/sales/people/${m[1]}`;
}

function parseCompanyImage(companyPictureDisplayImage) {
  if (!companyPictureDisplayImage || typeof companyPictureDisplayImage !== 'object') return null;
  const root = companyPictureDisplayImage.rootUrl || '';
  const artifacts = Array.isArray(companyPictureDisplayImage.artifacts) ? companyPictureDisplayImage.artifacts : [];
  if (!root || artifacts.length === 0) return null;
  const best = [...artifacts].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best?.fileIdentifyingUrlPathSegment ? `${root}${best.fileIdentifyingUrlPathSegment}` : null;
}

function parseDomainFromWebsite(website) {
  if (!website || typeof website !== 'string') return null;
  try {
    const withProto = website.startsWith('http') ? website : `https://${website}`;
    const host = new URL(withProto).hostname.replace(/^www\./i, '');
    return host || null;
  } catch {
    return null;
  }
}

function extractText(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const priorityKeys = ['displayName', 'localizedName', 'name', 'label', 'text', 'value', 'city', 'country'];
    for (const k of priorityKeys) {
      if (value[k] != null) {
        const nested = extractText(value[k]);
        if (nested) return nested;
      }
    }
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function normalizeCsrfToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/^"+|"+$/g, '');
}

function getCompanyIdFromPath(path) {
  if (!path || typeof path !== 'string') return null;
  const m = path.match(/\/sales-api\/salesApiCompanies\/([^/?]+)/);
  return m?.[1] ? parseId(m[1]) : null;
}

function parseCompanyPayload(obj, fallbackCompanyId) {
  if (!obj || typeof obj !== 'object') return null;
  const id = parseId(obj.entityUrn || fallbackCompanyId);
  if (!id) return null;
  return {
    companyId: id,
    companyName: extractText(obj.name || null),
    companyWebsite: extractText(obj.website || null),
    companyDomain: parseDomainFromWebsite(extractText(obj.website || null)),
    companyEmployeeCount: extractText(obj.employeeCount ?? null),
    companyEmployeeCountRange: extractText(obj.employeeCountRange || obj.employeeDisplayCount || null),
    companyFounded: obj.yearFounded ?? null,
    companyIndustry: extractText(obj.industry || null),
    companyType: extractText(obj.type || null),
    companyHeadquarters: extractText(obj.headquarters || obj.location || null),
    companyRevenueRange: extractText(obj.revenueRange || null),
    companyCrunchbaseUrl: extractText(obj.crunchbaseUrl || null),
    companyLogoUrl: parseCompanyImage(obj.companyPictureDisplayImage || obj.pictureInfo || null),
    companyLinkedinUrl: extractText(obj.flagshipCompanyUrl) || (id ? `${LINKEDIN_BASE}/company/${id}` : null)
  };
}

function buildRecordFromSalesElement(el) {
  if (!el || typeof el !== 'object') return null;

  const first = el.firstName || null;
  const last = el.lastName || null;
  const full = el.fullName || [first, last].filter(Boolean).join(' ') || null;
  const current = Array.isArray(el.currentPositions) && el.currentPositions.length > 0 ? el.currentPositions[0] : null;

  const id = parseId(el.objectUrn || el.entityUrn || el.profileId || el.memberUrn || el.urn);
  if (!id) return null;

  return {
    id,
    objectUrn: el.objectUrn || null,
    entityUrn: el.entityUrn || null,
    firstName: first,
    lastName: last,
    fullName: full,
    headline: el.headline || null,
    location: el.geoRegion || el.location || null,
    profileUrl: parseLinkedinPublicUrl(el.entityUrn),
    imageUrl: el.imgUrl || null,
    currentPosition: current
      ? { title: current.title || null, companyName: current.companyName || null, companyUrn: parseId(current.companyUrn || null) }
      : null,
    companyLinkedinID: current ? parseId(current.companyUrn || null) : null,
    degree: el.degree || null,
    pendingInvitation: !!el.pendingInvitation,
    sourceTimestamp: Date.now()
  };
}

function mergeRecord(existing, incoming) {
  if (!existing) return incoming;
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  if (existing.currentPosition && incoming.currentPosition) {
    out.currentPosition = {
      ...existing.currentPosition,
      ...Object.fromEntries(Object.entries(incoming.currentPosition).filter(([, v]) => v != null && v !== ''))
    };
  }
  if (existing.company && incoming.company) {
    out.company = {
      ...existing.company,
      ...Object.fromEntries(Object.entries(incoming.company).filter(([, v]) => v != null && v !== ''))
    };
  }
  return out;
}

function upsertRecordsFromPayload(session, payloadObj) {
  let countAdded = 0;
  const pushRecord = (obj) => {
    const parsed = buildRecordFromSalesElement(obj);
    if (!parsed) return;
    const prev = session.records.get(parsed.id);
    session.records.set(parsed.id, mergeRecord(prev, parsed));
    if (!prev) countAdded += 1;
  };

  if (!payloadObj || typeof payloadObj !== 'object') return 0;
  if (Array.isArray(payloadObj.elements)) payloadObj.elements.forEach(pushRecord);
  if (payloadObj.objectUrn || payloadObj.firstName || payloadObj.lastName) pushRecord(payloadObj);
  if (payloadObj.data && typeof payloadObj.data === 'object' && Array.isArray(payloadObj.data.elements)) {
    payloadObj.data.elements.forEach(pushRecord);
  }
  return countAdded;
}

function mergeCompany(existing, incoming) {
  if (!existing) return incoming;
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

function upsertCompanyFromPayload(session, payloadObj, path) {
  const fallbackId = getCompanyIdFromPath(path);
  const parsed = parseCompanyPayload(payloadObj, fallbackId);
  if (!parsed || !parsed.companyId) return false;
  const prev = session.companies.get(parsed.companyId);
  session.companies.set(parsed.companyId, mergeCompany(prev, parsed));
  return true;
}

function attachCompanyDataToRecords(session) {
  for (const [id, record] of session.records.entries()) {
    const companyId = parseId(record.companyLinkedinID || record.currentPosition?.companyUrn);
    if (!companyId) continue;
    const company = session.companies.get(companyId);
    if (!company) continue;
    session.records.set(id, mergeRecord(record, { companyLinkedinID: companyId, company }));
  }
}

function formatTimestamp(dt = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
}

function formatAddedOn(ts) {
  const d = new Date(ts || Date.now());
  return d.toString().replace(/\sGMT.*$/, '');
}

async function fetchCompanyFromLinkedin(companyId, csrfToken) {
  const token = normalizeCsrfToken(csrfToken);
  if (!companyId || !token) return null;
  const encodedDecoration = encodeURIComponent(COMPANY_DECORATION).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const url = `${LINKEDIN_BASE}/sales-api/salesApiCompanies/${companyId}?decoration=${encodedDecoration}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'csrf-token': token, 'x-restli-protocol-version': '2.0.0' },
    credentials: 'include'
  });
  if (!res.ok) return null;
  return res.json();
}

async function enrichMissingCompanies(session) {
  if (!session || !session.csrfToken) return;
  const candidateIds = new Set();
  for (const record of session.records.values()) {
    const companyId = parseId(record.companyLinkedinID || record.currentPosition?.companyUrn);
    if (!companyId) continue;
    if (session.companies.has(companyId) || session.pendingCompanies.has(companyId)) continue;
    candidateIds.add(companyId);
  }
  for (const companyId of candidateIds) {
    session.pendingCompanies.add(companyId);
    try {
      const companyObj = await fetchCompanyFromLinkedin(companyId, session.csrfToken);
      if (companyObj) upsertCompanyFromPayload(session, companyObj, `/sales-api/salesApiCompanies/${companyId}`);
    } catch (err) {
      console.warn('[XTRACTARR][BG] Company enrich failed', { companyId, err: String(err) });
    } finally {
      session.pendingCompanies.delete(companyId);
    }
  }
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function recordsToCsv(records) {
  const headers = [
    'Name', 'First name', 'Last name', 'Title', 'Linkedin', 'Location', 'Added On',
    'Company Name', 'Company Domain', 'Company Website', 'Company Employee Count', 'Company Employee Count Range',
    'Company Founded', 'Company Industry', 'Company Type', 'Company Headquarters', 'Company Revenue Range',
    'Company Crunchbase Url', 'Company Logo Url', 'Profile ID', 'Entity URN', 'Company LinkedIn ID', 'Connection Degree', 'Pending Invitation'
  ];

  const rows = [headers.join(',')];
  for (const r of records) {
    const row = [
      r.fullName ?? '',
      r.firstName ?? '',
      r.lastName ?? '',
      r.headline ?? r.currentPosition?.title ?? '',
      r.profileUrl ?? '',
      r.location ?? '',
      formatAddedOn(r.sourceTimestamp),
      r.company?.companyName ?? r.currentPosition?.companyName ?? '',
      r.company?.companyDomain ?? '',
      r.company?.companyWebsite ?? '',
      r.company?.companyEmployeeCount ?? '',
      r.company?.companyEmployeeCountRange ?? '',
      r.company?.companyFounded ?? '',
      r.company?.companyIndustry ?? '',
      r.company?.companyType ?? '',
      r.company?.companyHeadquarters ?? '',
      r.company?.companyRevenueRange ?? '',
      r.company?.companyCrunchbaseUrl ?? '',
      r.company?.companyLogoUrl ?? '',
      r.id ?? '',
      r.entityUrn ?? '',
      r.companyLinkedinID ?? '',
      r.degree ?? '',
      r.pendingInvitation ?? ''
    ].map(csvEscape).join(',');
    rows.push(row);
  }
  return rows.join('\n');
}

async function exportSession(tabId, reason) {
  const session = sessions.get(tabId);
  if (!session) return false;
  clearSessionTimers(session);
  session.currentAction = 'finalizing export';

  await enrichMissingCompanies(session);
  attachCompanyDataToRecords(session);

  const recordCount = session.records.size;
  if (recordCount === 0 || recordCount === session.lastExportedRecordCount) return false;

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      reason,
      tabId,
      pageUrl: session.pageUrl,
      recordCount,
      rawEventCount: session.rawEvents.length
    },
    records: Array.from(session.records.values()),
    rawEvents: session.rawEvents
  };

  const timestamp = formatTimestamp();
  const json = JSON.stringify(payload, null, 2);
  const jsonUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  const jsonFilename = `xtractarr-export-${timestamp}.json`;
  const csv = recordsToCsv(payload.records);
  const csvUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const csvFilename = `xtractarr-export-${timestamp}.csv`;

  await chrome.downloads.download({ url: jsonUrl, filename: jsonFilename, saveAs: false, conflictAction: 'uniquify' });
  await chrome.downloads.download({ url: csvUrl, filename: csvFilename, saveAs: false, conflictAction: 'uniquify' });

  session.lastExportedRecordCount = recordCount;
  session.lastExportAt = Date.now();
  session.exportCount += 1;
  session.autoMode = false;
  session.pageAdvanceInFlight = false;
  session.currentAction = 'completed';
  captureEnabledTabs.delete(tabId);

  console.log('[XTRACTARR][BG] Export complete', { tabId, reason, recordCount, jsonFilename, csvFilename });
  return true;
}

function scheduleIdleExport(tabId, delayMs, reason) {
  const session = sessions.get(tabId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);

  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    exportSession(tabId, reason).catch((err) => {
      console.error('[XTRACTARR][BG] Idle export failed', { tabId, reason, err: String(err) });
    });
  }, delayMs);
}

function isSearchApiPath(path) {
  if (!path || typeof path !== 'string') return false;
  return path.includes('/sales-api/salesApiPeopleSearch') || path.includes('/sales-api/salesApiLeadSearch');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTabMessageWithRetry(tabId, message) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    if (res?.ok) return res;
  } catch (err) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/contentScript.v2.js'] });
      const retry = await chrome.tabs.sendMessage(tabId, message);
      if (retry?.ok) return retry;
    } catch (retryErr) {
      return { ok: false, error: String(retryErr || err) };
    }
  }
  return { ok: false, error: 'no_response_from_content_script', moved: false };
}

function schedulePageAdvance(tabId) {
  const session = sessions.get(tabId);
  if (!session || !session.autoMode || !captureEnabledTabs.has(tabId)) return;
  if (session.pageAdvanceTimer) clearTimeout(session.pageAdvanceTimer);
  session.currentAction = 'page captured, preparing next';

  session.pageAdvanceTimer = setTimeout(async () => {
    session.pageAdvanceTimer = null;
    const live = sessions.get(tabId);
    if (!live || !live.autoMode || !captureEnabledTabs.has(tabId)) return;
    if (live.pageAdvanceInFlight) return;
    live.nextActionAt = null;

    if (live.currentPage >= live.maxPages) {
      live.currentAction = 'reached target pages';
      const exported = await exportSession(tabId, 'max_pages_reached');
      if (!exported) {
        live.autoMode = false;
        live.currentAction = 'stopped (no new records)';
        captureEnabledTabs.delete(tabId);
      }
      return;
    }

    live.pageAdvanceInFlight = true;
    live.currentAction = 'scrolling to page bottom';
    try {
      const scrolled = await sendTabMessageWithRetry(tabId, { type: 'XTRACTARR_SCROLL_BOTTOM' });
      if (!scrolled?.ok) {
        live.currentAction = 'scroll failed';
        const exported = await exportSession(tabId, 'scroll_error');
        if (!exported) {
          live.autoMode = false;
          live.currentAction = 'stopped (error)';
          captureEnabledTabs.delete(tabId);
        }
        return;
      }

      live.currentAction = 'waiting 2.0s';
      live.nextActionAt = Date.now() + 2000;
      await wait(2000);
      live.nextActionAt = null;

      live.currentAction = 'moving to next page';
      const next = await sendTabMessageWithRetry(tabId, { type: 'XTRACTARR_NEXT_PAGE' });
      if (next?.moved) {
        live.currentPage += 1;
        live.currentAction = `loading page ${live.currentPage}`;
      } else {
        live.currentAction = 'no next page found';
        const exported = await exportSession(tabId, 'no_next_page');
        if (!exported) {
          live.autoMode = false;
          live.currentAction = 'stopped (no new records)';
          captureEnabledTabs.delete(tabId);
        }
      }
    } catch (err) {
      console.error('[XTRACTARR][BG] Auto page advance failed', { tabId, err: String(err) });
      live.currentAction = 'pagination error';
      const exported = await exportSession(tabId, 'auto_pagination_error');
      if (!exported) {
        live.autoMode = false;
        live.currentAction = 'stopped (error)';
        captureEnabledTabs.delete(tabId);
      }
    } finally {
      live.pageAdvanceInFlight = false;
    }
  }, 250);
}

function classifyPage(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const p = u.pathname || '';
    if (p.includes(PROFILE_PATH_MARKER)) return 'profile';
    if (p.includes(SEARCH_PATH_MARKER)) return 'search';
    if (p.includes(LIST_PATH_MARKER)) return 'list';
    return 'other';
  } catch {
    return 'other';
  }
}

function progressFromSession(tabId) {
  const session = sessions.get(tabId);
  const active = captureEnabledTabs.has(tabId);
  if (!session) {
    return { active: false, progress: 0, statusText: 'Idle', records: 0, events: 0, exports: 0, lastExportAt: null };
  }

  const records = session.records.size;
  const events = session.rawEvents.length;
  const now = Date.now();
  let progress = 0;
  let statusText = 'Idle';
  let currentAction = session.currentAction || 'idle';

  if (active) {
    if (session.autoMode) {
      const maxPages = Math.max(1, Number(session.maxPages || 1));
      const currentPage = Math.max(1, Number(session.currentPage || 1));
      const pageProgressBase = Math.max(0, currentPage - 1) / maxPages;
      const pageProgress = Math.floor(pageProgressBase * 100);
      progress = Math.max(1, Math.min(98, pageProgress + (events > 0 ? 2 : 0)));
      statusText = `Extracting page ${Math.min(currentPage, maxPages)} of ${maxPages}...`;
      if (session.nextActionAt && session.nextActionAt > now) {
        const remaining = Math.max(0, (session.nextActionAt - now) / 1000);
        currentAction = `waiting ${remaining.toFixed(1)}s`;
      }
    } else {
      progress = Math.min(95, events * 4 + Math.min(records, 10) * 2);
      statusText = records > 0 ? 'Collecting Sales Navigator data...' : 'Waiting for LinkedIn data...';
      if (records > 0) currentAction = 'capturing results';
    }
  } else if (session.exportCount > 0) {
    progress = 100;
    statusText = 'Completed and exported';
    currentAction = 'completed';
  }

  return {
    active,
    progress,
    statusText,
    records,
    events,
    exports: session.exportCount,
    lastExportAt: session.lastExportAt,
    pageUrl: session.pageUrl || '',
    currentPage: session.currentPage || 1,
    targetPages: session.maxPages || 1,
    currentAction
  };
}

async function handlePopupMessage(message) {
  const { tabId } = message;
  if (typeof tabId !== 'number') {
    return { ok: false, error: 'tabId is required' };
  }

  if (message.type === 'XTRACTARR_START') {
    const session = resetSession(tabId, message.pageUrl || '');
    const maxPages = Math.max(1, Math.min(50, Number(message.maxPages || 1) || 1));
    session.maxPages = maxPages;
    session.currentPage = 1;
    session.autoMode = maxPages > 1;
    session.currentAction = 'reloading page';
    clearSessionTimers(session);
    captureEnabledTabs.add(tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/contentScript.v2.js']
      });
    } catch (err) {
      console.warn('[XTRACTARR][BG] executeScript failed', { tabId, err: String(err) });
    }
    try {
      // Trigger fresh Sales Navigator API requests so page-1 data is captured right after START.
      await chrome.tabs.reload(tabId, { bypassCache: true });
    } catch (err) {
      console.warn('[XTRACTARR][BG] tabs.reload failed', { tabId, err: String(err) });
    }
    console.log('[XTRACTARR][BG] Started extraction', { tabId, pageUrl: session.pageUrl });
    return {
      ok: true,
      statusText: session.autoMode
        ? `Reloading page 1 of ${session.maxPages}...`
        : 'Reloading page to capture current results...',
      ...progressFromSession(tabId)
    };
  }

  if (message.type === 'XTRACTARR_STOP') {
    captureEnabledTabs.delete(tabId);
    const session = sessions.get(tabId);
    clearSessionTimers(session);
    if (session) {
      session.autoMode = false;
      session.pageAdvanceInFlight = false;
      session.currentAction = 'stopped by user';
    }
    return { ok: true, ...progressFromSession(tabId) };
  }

  if (message.type === 'XTRACTARR_EXPORT_NOW') {
    try {
      const exported = await exportSession(tabId, 'manual_popup_export');
      return { ok: true, exported, ...progressFromSession(tabId) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  if (message.type === 'XTRACTARR_STATUS') {
    return { ok: true, ...progressFromSession(tabId) };
  }

  return { ok: false, error: 'Unknown popup message type' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'XTRACTARR_START' || message?.type === 'XTRACTARR_STOP' || message?.type === 'XTRACTARR_STATUS' || message?.type === 'XTRACTARR_EXPORT_NOW') {
    handlePopupMessage(message).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (!message || message.type !== 'SN_CAPTURE' || !sender.tab || typeof sender.tab.id !== 'number') {
    return;
  }

  const tabId = sender.tab.id;
  if (!captureEnabledTabs.has(tabId)) {
    sendResponse({ ok: true, ignored: true, reason: 'not_started' });
    return true;
  }

  const session = getTabSession(tabId);
  session.pageUrl = message.pageUrl || sender.tab.url || session.pageUrl || '';
  if (message.csrfToken) {
    session.csrfToken = normalizeCsrfToken(message.csrfToken);
  }

  const payload = message.payload || {};
  const bodyObj = safeJsonParse(payload.body);
  session.currentAction = session.autoMode ? 'processing page data' : 'capturing results';

  session.rawEvents.push({
    ts: payload.ts || Date.now(),
    source: payload.source || null,
    method: payload.method || null,
    url: payload.url || null,
    path: payload.path || null,
    status: payload.status || null,
    truncated: !!payload.truncated,
    parsed: bodyObj
  });

  upsertRecordsFromPayload(session, bodyObj);
  if (payload.path && payload.path.includes('/sales-api/salesApiCompanies/')) {
    upsertCompanyFromPayload(session, bodyObj, payload.path);
  }

  attachCompanyDataToRecords(session);
  enrichMissingCompanies(session).then(() => attachCompanyDataToRecords(session)).catch(() => {});

  const pageType = classifyPage(session.pageUrl);
  if (session.autoMode && (pageType === 'search' || pageType === 'list') && isSearchApiPath(payload.path)) {
    schedulePageAdvance(tabId);
  } else if (pageType === 'profile') {
    scheduleIdleExport(tabId, 1600, 'profile_capture_complete');
  } else if (pageType === 'search' || pageType === 'list') {
    scheduleIdleExport(tabId, 4500, 'search_or_list_idle');
  }

  sendResponse({ ok: true, recordCount: session.records.size, rawEvents: session.rawEvents.length });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  if (!tab || !tab.url || !tab.url.includes('linkedin.com/sales/')) return;

  const enabled = captureEnabledTabs.has(tabId);
  const session = sessions.get(tabId);
  if (enabled && session) {
    clearSessionTimers(session);
    session.pageUrl = tab.url;
    if (session.autoMode) {
      session.currentAction = `loading page ${session.currentPage}`;
    }
    return;
  }

  resetSession(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  captureEnabledTabs.delete(tabId);
  const session = sessions.get(tabId);
  clearSessionTimers(session);
  sessions.delete(tabId);
});
