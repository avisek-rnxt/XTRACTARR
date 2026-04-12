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

// ─── VERIFY CONTACTS FEATURE ────────────────────────────────────────────

const verifyState = {
  running: false,
  contacts: [],
  results: [],
  current: 0,
  total: 0,
  error: null,
};

function normalizeCompany(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[.,\-–—]/g, ' ')
    .replace(/\b(inc\.?|incorporated|llc|ltd\.?|limited|corp\.?|corporation|pvt\.?|private|co\.?|company|group|holdings|technologies|technology|tech|solutions|services|consulting|plc|& co\.?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function companiesMatch(stored, current) {
  if (!stored || !current) return { match: false, ratio: 0 };
  const a = normalizeCompany(stored);
  const b = normalizeCompany(current);
  if (!a || !b) return { match: false, ratio: 0 };
  if (a === b) return { match: true, ratio: 1.0 };
  // No-space comparison (e.g., "Research NXT" vs "ResearchNXT")
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return { match: true, ratio: 0.95 };
  // Simple similarity ratio (Dice coefficient on bigrams)
  const bigrams = (s) => { const b = []; for (let i = 0; i < s.length - 1; i++) b.push(s.slice(i, i + 2)); return b; };
  const bg1 = bigrams(a), bg2 = bigrams(b);
  const set2 = new Set(bg2);
  const inter = bg1.filter(b => set2.has(b)).length;
  const ratio = (2 * inter) / (bg1.length + bg2.length) || 0;
  return { match: ratio >= 0.8, ratio };
}

async function doSalesSearch(keywords, csrfToken) {
  const token = normalizeCsrfToken(csrfToken);
  const encoded = encodeURIComponent(keywords);
  const url = `${LINKEDIN_BASE}/sales-api/salesApiPeopleSearch?q=peopleSearchQuery&query=(keywords:${encoded})&count=10&start=0`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'csrf-token': token, 'x-restli-protocol-version': '2.0.0' },
    credentials: 'include'
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.elements || [];
}

function matchFromElements(elements, slug, salesNavId, name) {
  if (elements.length === 0) return null;

  // Priority 1: Match by Sales Nav ID in entityUrn (most accurate for SN links)
  if (salesNavId) {
    const key = parseSalesNavKey(salesNavId);
    const idToMatch = key ? key.profileId : salesNavId;
    for (const el of elements) {
      const urn = el.entityUrn || '';
      if (urn.includes(idToMatch)) return parseSalesElement(el);
    }
  }

  // Priority 2: Match by public profile slug (via publicIdentifier or flagshipProfileUrl)
  if (slug) {
    const slugLower = slug.toLowerCase();
    for (const el of elements) {
      const pubId = (el.publicIdentifier || '').toLowerCase();
      const flagship = (el.flagshipProfileUrl || '').toLowerCase();
      if ((pubId && pubId === slugLower) || flagship.includes(`/in/${slugLower}`)) {
        return parseSalesElement(el);
      }
    }
  }

  // Priority 3: Match by exact name
  if (name) {
    const nameLower = name.toLowerCase();
    for (const el of elements) {
      const full = (el.fullName || '').toLowerCase();
      if (full === nameLower) return parseSalesElement(el);
    }
  }

  return null;
}

async function searchPersonByName(name, slug, salesNavId, company, csrfToken) {
  if (!name || !csrfToken) return null;
  try {
    // Attempt 1: Search with name + company
    console.log('[VERIFYARR] Searching for:', name, 'company:', company, 'slug:', slug);
    if (company) {
      const elements = await doSalesSearch(`${name} ${company}`, csrfToken);
      console.log('[VERIFYARR] Search (name+company) results:', elements.length);
      const matched = matchFromElements(elements, slug, salesNavId, name);
      if (matched && matched.company) return matched;
    }

    // Attempt 2: Search with just name (company may be outdated)
    const elements = await doSalesSearch(name, csrfToken);
    console.log('[VERIFYARR] Search (name only) results:', elements.length);
    const matched = matchFromElements(elements, slug, salesNavId, name);
    if (matched) return matched;

    // Last resort: first result from name-only search
    if (elements.length > 0) return parseSalesElement(elements[0]);

    return null;
  } catch { return null; }
}

function parseSalesElement(el) {
  if (!el) return null;
  const first = el.firstName || '';
  const last = el.lastName || '';
  const full = el.fullName || `${first} ${last}`.trim();
  const headline = el.headline || '';
  const positions = el.currentPositions || [];
  const current = positions.length > 0 ? positions[0] : null;
  let company = current ? (current.companyName || '') : '';
  let title = current ? (current.title || '') : '';
  // Fallback: extract company from headline ("Title at Company")
  if (!company && headline) {
    const atMatch = headline.match(/\bat\s+(.+)/i);
    if (atMatch) {
      company = atMatch[1].trim();
      if (!title) title = headline.split(/\bat\b/i)[0].trim();
    }
  }
  return { fullName: full, headline, company, title };
}

function extractSlug(url) {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? m[1].replace(/\/$/, '') : null;
}

function extractSalesNavId(url) {
  if (!url) return null;
  // Matches /sales/lead/ACwAAA... or /sales/people/ACwAAA...
  const m = url.match(/linkedin\.com\/sales\/(?:lead|people)\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Parse Sales Nav URL parts: "ACwAAA...,NAME_SEARCH,mGwU" → { profileId, authType, authToken }
function parseSalesNavKey(salesNavId) {
  if (!salesNavId) return null;
  const parts = salesNavId.split(',');
  const key = { profileId: parts[0] };
  if (parts.length >= 3) {
    key.authType = parts[1];
    key.authToken = parts[2];
  }
  return key;
}

const PROFILE_DECORATION = '(entityUrn,firstName,lastName,fullName,headline,flagshipProfileUrl,defaultPosition,positions*(companyName,current,title,companyUrn,startedOn,endedOn))';

// Unwrap Voyager text fields — the dash API returns { text: "value" } objects instead of plain strings
function voyagerText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field.text) return field.text;
  return '';
}

// Voyager API: direct profile lookup by /in/ slug
async function fetchVoyagerProfile(slug, csrfToken) {
  const token = normalizeCsrfToken(csrfToken);
  if (!slug || !token) return null;

  const url = `${LINKEDIN_BASE}/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.TopCardSupplementary-167`;
  try {
    console.log('[VERIFYARR] Voyager lookup for slug:', slug);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'csrf-token': token, 'x-restli-protocol-version': '2.0.0' },
      credentials: 'include'
    });
    console.log('[VERIFYARR] Voyager response:', res.status);
    if (!res.ok) return null;

    const data = await res.json();
    const elements = data.elements || [];
    if (elements.length === 0) return null;

    const profile = elements[0];
    const firstName = voyagerText(profile.firstName);
    const lastName = voyagerText(profile.lastName);
    const fullName = `${firstName} ${lastName}`.trim();
    const headline = voyagerText(profile.headline);

    // Extract profileId from entityUrn (e.g. "urn:li:fsd_profile:ACwAAA..." → "ACwAAA...")
    let profileId = '';
    const urn = profile.entityUrn || '';
    const urnMatch = urn.match(/fsd_profile:(.+)/);
    if (urnMatch) profileId = urnMatch[1];

    // Extract current position from profileTopPosition
    let company = '', title = '';
    const topPositions = profile.profileTopPosition?.elements || [];
    for (const pos of topPositions) {
      const companyName = voyagerText(pos.companyName);
      if (companyName) {
        company = companyName;
        title = voyagerText(pos.title);
        break;
      }
    }

    // Fallback: extract from headline
    if (!company && headline) {
      const atMatch = headline.match(/\bat\s+(.+)/i);
      if (atMatch) {
        company = atMatch[1].trim();
        if (!title) title = headline.split(/\bat\b/i)[0].trim();
      }
    }

    return { fullName, headline, company, title, profileId };
  } catch (err) {
    console.warn('[VERIFYARR] Voyager fetch error:', err);
    return null;
  }
}

async function fetchSalesNavProfile(salesNavId, csrfToken) {
  // Directly call the Sales Navigator API to get profile data
  const token = normalizeCsrfToken(csrfToken);
  if (!salesNavId || !token) return null;

  const key = parseSalesNavKey(salesNavId);
  if (!key) return null;

  // Build the REST.li key — include authType/authToken if available
  let keyStr = `profileId:${key.profileId}`;
  if (key.authType && key.authToken) {
    keyStr += `,authType:${key.authType},authToken:${key.authToken}`;
  }

  const encodedDecoration = encodeURIComponent(PROFILE_DECORATION).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const url = `${LINKEDIN_BASE}/sales-api/salesApiProfiles/(${keyStr})?decoration=${encodedDecoration}`;
  try {
    console.log('[VERIFYARR] Fetching Sales Nav profile:', key.profileId);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'csrf-token': token, 'x-restli-protocol-version': '2.0.0' },
      credentials: 'include'
    });
    console.log('[VERIFYARR] Sales Nav profile response:', res.status);
    if (!res.ok) return null;

    const data = await res.json();
    return parseSalesProfileData(data);
  } catch (err) {
    console.warn('[VERIFYARR] Sales Nav profile fetch error:', err);
    return null;
  }
}

// Parse profile API response — uses defaultPosition or positions array
function parseSalesProfileData(data) {
  if (!data) return null;
  const fullName = data.fullName || `${data.firstName || ''} ${data.lastName || ''}`.trim();
  const headline = data.headline || '';
  // defaultPosition is the fastest path
  const dp = data.defaultPosition;
  if (dp && dp.current && dp.companyName) {
    return { fullName, headline, company: dp.companyName, title: dp.title || '' };
  }
  // Fallback to positions array
  const positions = data.positions || [];
  const current = positions.find(p => p.current === true) || positions.find(p => !p.endedOn) || null;
  return {
    fullName,
    headline,
    company: current ? (current.companyName || '') : '',
    title: current ? (current.title || '') : '',
  };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

function parseContactsCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[_\-]+/g, ' ').trim());

  const colMap = {};
  const nameAliases = ['name', 'full name', 'fullname', 'contact name'];
  const companyAliases = ['company', 'company name', 'organization'];
  const linkedinAliases = ['linkedin', 'linkedin url', 'linkedin link', 'profile url', 'sales nav url', 'sales navigator url'];
  const emailAliases = ['email', 'email address'];

  headers.forEach((h, i) => {
    if (nameAliases.includes(h)) colMap.name = i;
    else if (companyAliases.includes(h)) colMap.company = i;
    else if (linkedinAliases.includes(h)) colMap.linkedin = i;
    else if (emailAliases.includes(h)) colMap.email = i;
  });

  if (colMap.name === undefined || colMap.company === undefined || colMap.linkedin === undefined) {
    return [];
  }

  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const name = cols[colMap.name] || '';
    const company = cols[colMap.company] || '';
    let linkedin = cols[colMap.linkedin] || '';
    const email = colMap.email !== undefined ? (cols[colMap.email] || '') : '';
    if (!name || !linkedin) continue;
    if (!linkedin.startsWith('http')) linkedin = 'https://' + linkedin;
    linkedin = linkedin.replace(/\/$/, '');
    contacts.push({ name, company, linkedin, email });
  }
  return contacts;
}

function verifyResultsToCsv(results) {
  const headers = ['Name', 'Original Company', 'Email', 'LinkedIn URL', 'Status', 'Current Company', 'Current Title', 'LinkedIn Name', 'Confidence', 'Strategy', 'Fetched Via'];
  const rows = [headers.join(',')];
  for (const r of results) {
    const row = [
      r.name, r.originalCompany, r.email, r.linkedin,
      r.status, r.currentCompany, r.currentTitle, r.linkedinName, r.confidence, r.strategy, r.fetchedVia
    ].map(csvEscape).join(',');
    rows.push(row);
  }
  return rows.join('\n');
}

async function runVerification(csrfToken) {
  verifyState.running = true;
  verifyState.results = [];
  verifyState.current = 0;
  verifyState.error = null;
  const contacts = verifyState.contacts;
  verifyState.total = contacts.length;

  for (let i = 0; i < contacts.length; i++) {
    if (!verifyState.running) break;
    verifyState.current = i + 1;
    const contact = contacts[i];
    const slug = extractSlug(contact.linkedin);

    let result = {
      name: contact.name,
      originalCompany: contact.company,
      email: contact.email,
      linkedin: contact.linkedin,
      status: 'Unknown',
      currentCompany: '',
      currentTitle: '',
      linkedinName: '',
      confidence: 'low',
      fetchedVia: '',
      strategy: '',
    };

    const salesNavId = extractSalesNavId(contact.linkedin);
    let parsed = null;

    // Strategy 1a: Direct Voyager API lookup by /in/ slug (most accurate for /in/ links)
    if (slug && !salesNavId) {
      parsed = await fetchVoyagerProfile(slug, csrfToken);
      if (parsed && parsed.company) {
        result.fetchedVia = `${LINKEDIN_BASE}/voyager/api/identity/dash/profiles?memberIdentity=${slug}`;
        result.strategy = '1';
        // Voyager decoration may omit name/title — supplement via Sales Nav API using profileId
        if (parsed.profileId && (!parsed.fullName || !parsed.title)) {
          console.log('[VERIFYARR] Voyager missing name/title, supplementing via Sales Nav for:', parsed.profileId);
          const snParsed = await fetchSalesNavProfile(parsed.profileId, csrfToken);
          if (snParsed) {
            if (!parsed.fullName && snParsed.fullName) parsed.fullName = snParsed.fullName;
            if (!parsed.title && snParsed.title) parsed.title = snParsed.title;
            if (!parsed.headline && snParsed.headline) parsed.headline = snParsed.headline;
          }
        }
      }
    }

    // Strategy 1b: Direct Sales Nav API call (most accurate for SN links)
    if (!parsed || !parsed.company) {
      if (salesNavId) {
        parsed = await fetchSalesNavProfile(salesNavId, csrfToken);
        if (parsed && parsed.company) {
          const pKey = parseSalesNavKey(salesNavId);
          result.fetchedVia = `${LINKEDIN_BASE}/sales-api/salesApiProfiles/(profileId:${pKey ? pKey.profileId : salesNavId})`;
          result.strategy = '1';
        }
      }
    }

    // Strategy 2: Fallback to Sales Nav name search
    if (!parsed || !parsed.company) {
      const searchResult = await searchPersonByName(contact.name, slug, salesNavId, contact.company, csrfToken);
      if (searchResult) {
        parsed = searchResult;
        result.fetchedVia = `${LINKEDIN_BASE}/sales-api/salesApiPeopleSearch (keyword: ${contact.name} ${contact.company})`;
        result.strategy = '2';
      }
    }
    if (parsed) {
      result.linkedinName = parsed.fullName;
      result.currentTitle = parsed.title || parsed.headline;
      if (parsed.company) {
        result.currentCompany = parsed.company;
        const { match, ratio } = companiesMatch(contact.company, parsed.company);
        if (match) {
          result.status = 'Still there';
          result.confidence = ratio > 0.9 ? 'high' : 'low';
        } else {
          result.status = 'Moved on';
          result.confidence = 'high';
        }
      }
    }

    verifyState.results.push(result);

    // Delay between requests (2.5s + random jitter)
    if (i < contacts.length - 1 && verifyState.running) {
      await new Promise(r => setTimeout(r, 2500 + Math.random() * 1000));
    }
  }

  // Export results
  if (verifyState.results.length > 0) {
    const csv = verifyResultsToCsv(verifyState.results);
    const csvUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    const ts = formatTimestamp();
    await chrome.downloads.download({ url: csvUrl, filename: `contact-verify-${ts}.csv`, saveAs: false, conflictAction: 'uniquify' });
  }

  verifyState.running = false;
}

// ─── END VERIFY CONTACTS ────────────────────────────────────────────────

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
  // ─── Verify contacts messages ───
  if (message?.type === 'VERIFY_START') {
    const contacts = parseContactsCSV(message.csvText || '');
    if (contacts.length === 0) {
      sendResponse({ ok: false, error: 'No valid contacts found in CSV. Need columns: Name, Company, LinkedIn URL' });
      return true;
    }
    // Get CSRF token from content script cookie
    const csrfToken = message.csrfToken || '';
    if (!csrfToken) {
      sendResponse({ ok: false, error: 'No CSRF token. Open a LinkedIn page first.' });
      return true;
    }
    verifyState.contacts = contacts;
    runVerification(csrfToken).catch(err => { verifyState.error = String(err); verifyState.running = false; });
    sendResponse({ ok: true, total: contacts.length });
    return true;
  }

  if (message?.type === 'VERIFY_STATUS') {
    sendResponse({
      ok: true,
      running: verifyState.running,
      current: verifyState.current,
      total: verifyState.total,
      results: verifyState.results.length,
      error: verifyState.error,
    });
    return true;
  }

  if (message?.type === 'VERIFY_STOP') {
    verifyState.running = false;
    sendResponse({ ok: true });
    return true;
  }

  // ─── Extraction messages ───
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
