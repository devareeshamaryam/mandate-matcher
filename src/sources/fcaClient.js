import { sleep } from '../util.js';

const BASE_URL = 'https://register.fca.org.uk/services/V0.1';

/**
 * Thin client for the FCA Financial Services Register API.
 * Docs: https://register.fca.org.uk/Developer/s/
 */
export function createFcaClient({ email, apiKey, minIntervalMs = 250 }) {
  if (!email || !apiKey) {
    throw new Error('FCA_API_EMAIL and FCA_API_KEY must both be set in .env');
  }
  let lastRequestAt = 0;

  async function get(pathOrUrl, attempt = 0) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
    const res = await fetch(url, {
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': apiKey,
        Accept: 'application/json',
      },
    });

    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(2000 * 2 ** attempt);
      return get(pathOrUrl, attempt + 1);
    }
    if (!res.ok) {
      throw new Error(`FCA API ${res.status} for ${url}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    if (body?.Message && /invalid|unauthori[sz]ed/i.test(body.Message) && !body.Data) {
      throw new Error(`FCA API rejected request (${body.Status}): ${body.Message}`);
    }
    return body;
  }

  /** Follows FCA pagination (ResultInfo.Next or ?pgnp=N) and returns all Data rows. */
  async function getAllPages(path) {
    const rows = [];
    let page = 1;
    let url = path;
    const seen = new Set();
    while (page <= 1000) {
      const body = await get(url);
      const data = Array.isArray(body?.Data) ? body.Data : [];
      rows.push(...data);
      seen.add(url);

      const info = body?.ResultInfo || {};
      const total = Number(info.total_count || 0);
      if (!data.length) break;
      page += 1;
      if (info.Next && !seen.has(info.Next)) {
        url = info.Next;
      } else if (total && rows.length < total) {
        url = `${path}${path.includes('?') ? '&' : '?'}pgnp=${page}`;
      } else {
        break;
      }
    }
    return rows;
  }

  return {
    get,
    getAllPages,
    getFirm: (frn) => get(`/Firm/${encodeURIComponent(frn)}`),
    getFirmAddress: (frn) => get(`/Firm/${encodeURIComponent(frn)}/Address`),
    getFirmIndividuals: (frn) => getAllPages(`/Firm/${encodeURIComponent(frn)}/Individuals`),
    getIndividual: (irn) => get(`/Individuals/${encodeURIComponent(irn)}`),
    getIndividualControlledFunctions: (irn) => get(`/Individuals/${encodeURIComponent(irn)}/CF`),
    search: (q, type = 'firm') => get(`/Search?q=${encodeURIComponent(q)}&type=${type}`),
  };
}
