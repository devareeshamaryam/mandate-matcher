import { sleep } from '../util.js';

/**
 * Hong Kong SFC Public Register of Licensed Persons and Registered Institutions.
 * https://apps.sfc.hk/publicregWeb/
 *
 * No API key or captcha. Firm pages embed their people lists as JSON in <script> vars:
 *   Licensed Corporation (LC):    /corp/{CE}/ro  -> rorawData  (Responsible Officers)
 *                                 /corp/{CE}/rep -> reprawData (Licensed Representatives)
 *   Registered Institution (RI):  /ri/{CE}/eo    -> eoData     (Executive Officers only; a bank's
 *                                                               relevant individuals sit on the HKMA register)
 *   Individual history:           /indi/{CE}/licenceRecord -> licRecordData
 * Only currently licensed people are listed, so someone dropping off a firm's list = licence ended there.
 */

const BASE = 'https://apps.sfc.hk/publicregWeb';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

// SFO regulated activity types
const ACTIVITIES = {
  1: 'Dealing in Securities', 2: 'Dealing in Futures Contracts', 3: 'Leveraged FX Trading',
  4: 'Advising on Securities', 5: 'Advising on Futures Contracts', 6: 'Advising on Corporate Finance',
  7: 'Automated Trading Services', 8: 'Securities Margin Financing', 9: 'Asset Management',
  10: 'Credit Rating Services', 11: 'Dealing in OTC Derivatives', 12: 'Client Clearing for OTC Derivatives',
  13: 'Depositary of Relevant CIS',
};
const ROLE_NAMES = { RO: 'Responsible Officer', RE: 'Licensed Representative', EO: 'Executive Officer' };

export function createSfcSource(env) {
  const minIntervalMs = Number(env.SFC_MIN_INTERVAL_MS || 600);
  let cookie = '';
  let lastRequestAt = 0;

  async function startSession() {
    const res = await fetch(`${BASE}/searchByName?locale=en`, { headers: { 'User-Agent': UA } });
    await res.text();
    cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  }

  async function request(path, init = {}, attempt = 0) {
    if (!cookie) await startSession();
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await fetch(`${BASE}/${path}`, {
      ...init,
      headers: { 'User-Agent': UA, Cookie: cookie, Referer: `${BASE}/searchByName?locale=en`, ...init.headers },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(3000 * 2 ** attempt);
      cookie = '';
      return request(path, init, attempt + 1);
    }
    if (!res.ok) throw new Error(`SFC ${res.status} for ${path}`);
    return res.text();
  }

  async function searchJson(params) {
    const body = await request('searchByNameJson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ licstatus: 'active', lictype: 'all', searchlang: 'en', page: 1, start: 0, limit: 50, ...params }),
    });
    try {
      return JSON.parse(body).items || [];
    } catch {
      cookie = ''; // session expired: the server answers with the HTML search page
      throw new Error('SFC search returned HTML instead of JSON (session expired?)');
    }
  }

  async function pageVar(path, varName) {
    const html = await request(path);
    return extractJsVar(html, varName) || [];
  }

  async function fetchFirm(cfg) {
    const ce = String(cfg.id).toUpperCase();
    const hits = await searchJson({ searchbyoption: 'byname', entityType: 'corporation', searchtext: cfg.searchName || cfg.name || ce });
    const hit = hits.find((h) => h.ceref === ce) || {};
    const kind = cfg.kind || (hit.isRi ? 'ri' : 'corp');
    return {
      source: 'sfc',
      id: ce,
      kind,
      name: hit.name || cfg.name || ce,
      status: hit.hasActiveLicence === 'Y' ? 'Active' : hit.hasActiveLicence ? 'Inactive' : '',
      type: kind === 'ri' ? 'Registered Institution' : 'Licensed Corporation',
      companiesHouseNo: '',
      statusDate: '',
      address: hit.address?.fullAddress || '',
      licences: (hit.raDetails || []).map((r) => r.actDesc).join('; '),
      url: `${BASE}/${kind}/${ce}/details`,
    };
  }

  async function fetchEmployees(cfg, firm) {
    const ce = String(cfg.id).toUpperCase();
    const kind = firm?.kind || cfg.kind || 'corp';
    const lists = kind === 'ri'
      ? [['EO', await pageVar(`ri/${ce}/eo`, 'eoData')]]
      : [['RO', await pageVar(`corp/${ce}/ro`, 'rorawData')], ['RE', await pageVar(`corp/${ce}/rep`, 'reprawData')]];

    const byId = new Map();
    for (const [role, people] of lists) {
      for (const p of people) {
        if (!p?.ceRef) continue;
        const activities = (p.regulatedActivities || []).map((a) => ACTIVITIES[a.actType] || a.actDesc).filter(Boolean);
        const existing = byId.get(p.ceRef);
        if (existing) {
          // A Responsible Officer is usually also listed as a Representative; keep the senior role.
          existing.currentRoles = unique([...existing.currentRoles.split('; '), ...activities]).join('; ');
          continue;
        }
        byId.set(p.ceRef, {
          source: 'sfc',
          firmId: ce,
          personId: p.ceRef,
          name: p.fullName || [p.entityName, p.entityOtherName].filter(Boolean).join(' '),
          status: 'Active',
          roleCategory: ROLE_NAMES[role],
          currentRoles: unique(activities).join('; '),
          previousFirms: '',
          url: `${BASE}/indi/${p.ceRef}/details`,
        });
      }
    }
    return [...byId.values()];
  }

  /** Adds licence history: other firms the person has been licensed with, and since when they are here. */
  async function enrichEmployee(emp) {
    const records = await pageVar(`indi/${emp.personId}/licenceRecord`, 'licRecordData');
    const otherFirms = unique(records.filter((r) => r.prinCeRef && r.prinCeRef !== emp.firmId).map((r) => r.prinCeName));
    const startsHere = records
      .filter((r) => r.prinCeRef === emp.firmId)
      .flatMap((r) => r.effectivePeriodList || [])
      .map((p) => Date.parse(p.effectiveDate))
      .filter(Number.isFinite);
    const since = startsHere.length ? new Date(Math.min(...startsHere)).toISOString().slice(0, 10) : '';
    return {
      ...emp,
      previousFirms: otherFirms.join('; '),
      currentRoles: since ? `${emp.currentRoles} (licensed here since ${since})` : emp.currentRoles,
    };
  }

  async function search(text, entityType = 'corporation') {
    return searchJson({ searchbyoption: 'byname', entityType, searchtext: text });
  }

  return { name: 'sfc', fetchFirm, fetchEmployees, enrichEmployee, search };
}

/** Pulls `var <name> = <JSON>;` out of a page, scanning brackets so nested data and strings are handled. */
export function extractJsVar(html, name) {
  const m = new RegExp(`var\\s+${name}\\s*=\\s*`).exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  const open = html[i];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (ch === '\\') j++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(html.slice(i, j + 1));
  }
  return null;
}

const unique = (arr) => [...new Set(arr.filter(Boolean))];
