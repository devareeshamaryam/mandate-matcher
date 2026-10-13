import { sleep } from '../util.js';

/**
 * Abu Dhabi Global Market (ADGM) FSRA Public Register.
 * https://www.adgm.com/public-registers/fsra
 *
 * No API key or captcha. The site's own pages call these JSON endpoints:
 *   POST /api/fsrac/firms/listing/filter          firm search (permission number, status, address, page URL)
 *   GET  <firm pageUrl>                           holds the internal page id (<input name="pageId">)
 *   POST /api/fsrac/firm/approved-person/filter   every approved person at the firm, current AND withdrawn roles
 *   GET  <individual profileUrl>                  holds individualid + anti-forgery token
 *   POST /IndividualDetailPage/Get{Current,Withdrawn}RolesAfterFilterationPagination   cross-firm role history
 * Firm id in config/firms.json = the FSP / permission number (e.g. 250098).
 */

const BASE = 'https://www.adgm.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

// Most senior role wins when someone holds several.
const SENIORITY = ['Senior Executive Officer(SEO)', 'Licensed Director and SEO', 'Co-Senior Executive Officer', 'Licensed Director',
  'Board Member', 'Chief', 'Head of', 'Senior Manager', 'Responsible Officer', 'Compliance Officer and MLRO', 'Compliance Officer',
  'MLRO', 'Finance Officer', 'Risk Officer', 'Key Individual', 'Approved Person'];

export function createFsraSource(env) {
  const minIntervalMs = Number(env.FSRA_MIN_INTERVAL_MS || 500);
  let lastRequestAt = 0;

  async function request(path, { json, headers = {}, method } = {}, attempt = 0) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await fetch(BASE + path, {
      method: method || (json ? 'POST' : 'GET'),
      headers: { 'User-Agent': UA, ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers },
      body: json ? JSON.stringify(json) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(3000 * 2 ** attempt);
      return request(path, { json, headers, method }, attempt + 1);
    }
    if (!res.ok) throw new Error(`FSRA ${res.status} for ${path}`);
    return res;
  }

  async function searchFirms(query, itemsPerPage = 50) {
    const res = await request('/api/fsrac/firms/listing/filter', {
      json: { sortBy: '', searchQuery: query, companyType: '', assetClass: '', regulatedActivities: '', itemsPerPage, currentPage: 1, firmStatus: '', recognitionStatus: '' },
    });
    return (await res.json()).firmListingVM || [];
  }

  async function fetchFirm(cfg) {
    const permission = String(cfg.id);
    const hits = await searchFirms(cfg.searchName || cfg.name || permission);
    const f = hits.find((h) => h.permissionNumber === permission) || (await searchFirms(permission)).find((h) => h.permissionNumber === permission);
    if (!f) throw new Error(`FSRA firm with permission number ${permission} not found`);

    const html = await (await request(f.pageUrl)).text();
    const pageId = (html.match(/name="pageId"\s+value="(\d+)"/) || html.match(/FirmId=(\d+)/) || [])[1];
    if (!pageId) throw new Error(`FSRA page id not found on ${f.pageUrl}`);

    return {
      source: 'fsra',
      id: permission,
      pageId: Number(pageId),
      name: f.company,
      status: f.companyStatus || '',
      type: f.legalStatus || 'Financial Firm',
      companiesHouseNo: f.firmID || '',
      statusDate: f.withdrawnDate || f.fspDate || '',
      address: f.address || '',
      url: BASE + f.pageUrl,
    };
  }

  async function fetchEmployees(cfg, firm) {
    const rows = [];
    for (let page = 1; page < 200; page++) {
      const res = await request('/api/fsrac/firm/approved-person/filter', {
        json: { sortBy: 'effectivedate#desc', searchQuery: '', itemsPerPage: 100, currentPage: page, currentPageId: firm.pageId },
      });
      const data = await res.json();
      rows.push(...(data.approvedPersonVM || []));
      if (!data.approvedPersonVM?.length || rows.length >= data.totalItems) break;
    }

    // One row per role -> one record per person.
    const people = new Map();
    for (const r of rows) {
      const p = people.get(r.referenceNumber) || { ref: r.referenceNumber, name: r.name, url: r.profileUrl, current: [], withdrawn: [] };
      (r.isCurrentRole && !r.withdrawnDate ? p.current : p.withdrawn).push(r);
      people.set(r.referenceNumber, p);
    }

    return [...people.values()].map((p) => {
      const active = p.current.length > 0;
      const roles = active ? p.current : p.withdrawn;
      const lastWithdrawn = p.withdrawn.map((r) => r.withdrawnDate).filter(Boolean).sort().pop();
      return {
        source: 'fsra',
        firmId: firm.id,
        personId: p.ref,
        name: (p.name || '').trim(),
        status: active ? 'Active' : `Withdrawn${lastWithdrawn ? ` ${lastWithdrawn}` : ''}`,
        roleCategory: mostSenior(roles.map((r) => r.role)),
        currentRoles: roles.map((r) => `${r.role}${r.effectiveDate ? ` (since ${r.effectiveDate})` : ''}`).join('; '),
        previousFirms: '',
        url: BASE + p.url,
      };
    });
  }

  /** Cross-firm history from the individual's profile (current + withdrawn roles at every ADGM firm). */
  async function enrichEmployee(emp) {
    const pageRes = await request(new URL(emp.url).pathname);
    const html = await pageRes.text();
    const cookie = (pageRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const individualid = Number((html.match(/individualid\s*:\s*(\d+)/) || [])[1]);
    const token = (html.match(/__csrfToken\s*=\s*'([^']+)'/) || [])[1];
    if (!individualid || !token) return emp;

    const roles = [];
    for (const kind of ['Current', 'Withdrawn']) {
      const res = await request(`/IndividualDetailPage/Get${kind}RolesAfterFilterationPagination`, {
        json: { individualid, sortby: '', resultsperpage: 100, currentpage: 1, query: '' },
        headers: { Cookie: cookie, RequestVerificationToken: token, 'X-Requested-With': 'XMLHttpRequest' },
      });
      roles.push(...((await res.json()).individualRoles || []));
    }
    // Firm URLs end in "-<permission number>", e.g. .../julius-baer-abu-dhabi-ltd-250098
    const isThisFirm = (r) => (r.firmUrl || '').endsWith(`-${emp.firmId}`);
    const others = [...new Set(roles.filter((r) => !isThisFirm(r)).map((r) => r.firmName).filter(Boolean))];
    return { ...emp, previousFirms: others.join('; ') };
  }

  return { name: 'fsra', fetchFirm, fetchEmployees, enrichEmployee, searchFirms };
}

function mostSenior(roles) {
  for (const key of SENIORITY) {
    const hit = roles.find((r) => r.startsWith(key));
    if (hit) return hit;
  }
  return roles[0] || 'Approved Person';
}
