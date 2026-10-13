import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { sleep } from '../util.js';

/**
 * Monetary Authority of Singapore - Financial Institutions Directory (FID).
 * https://eservices.mas.gov.sg/fid
 *
 * Plain server-rendered HTML, no API key or captcha:
 *   /fid/institution?term=<name>     search -> /fid/institution/detail/<id>-<SLUG> links
 *   /fid/institution/detail/<id>     firm page: licence types + activities, contact, and "Key Personnel"
 *                                    (CEO / Branch Manager / Head of Treasury etc. as notified to MAS)
 * Firm id in config/firms.json = the numeric FID id (e.g. 3457 for Bank Julius Baer & Co. Ltd.).
 *
 * Only key personnel are listed here, not all representatives. The Representatives Register (/rr)
 * sits behind Cloudflare Turnstile and is deliberately not automated.
 */

const BASE = 'https://eservices.mas.gov.sg/fid';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

export function createMasSource(env) {
  const minIntervalMs = Number(env.MAS_MIN_INTERVAL_MS || 1000);
  let lastRequestAt = 0;
  const pages = new Map(); // firm id -> parsed detail page, so fetchFirm + fetchEmployees share one request

  async function load(path, attempt = 0) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await fetch(`${BASE}/${path}`, { headers: { 'User-Agent': UA } });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(3000 * 2 ** attempt);
      return load(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`MAS ${res.status} for ${path}`);
    return cheerio.load(await res.text());
  }

  // The bare "/detail/<id>" routes to a different page, so a slug is always appended (any slug works).
  const detailPath = (cfg) => `institution/detail/${String(cfg.id)}-${slugify(cfg.name) || 'FIRM'}`;

  async function detail(cfg) {
    const id = String(cfg.id);
    if (!pages.has(id)) pages.set(id, await load(detailPath(cfg)));
    return pages.get(id);
  }

  async function fetchFirm(cfg) {
    const id = String(cfg.id);
    const $ = await detail(cfg);
    const name = clean($('main h1').first().text());
    if (!name) throw new Error(`MAS firm ${id} not found`);

    const licences = $('.category .inner > h3').map((_, h) => clean($(h).text())).get();
    const activities = $('.category h4').map((_, h) => clean($(h).text())).get();
    return {
      source: 'mas',
      id,
      name,
      status: licences.length ? 'Licensed' : '',
      type: licences.join('; '),
      companiesHouseNo: '',
      statusDate: '',
      address: clean($('.contact td.font-resize').last().text()),
      incorporated: clean($('main .title > p').first().text()),
      licences: unique(activities).join('; '),
      url: `${BASE}/${detailPath(cfg)}`,
    };
  }

  async function fetchEmployees(cfg) {
    const id = String(cfg.id);
    const $ = await detail(cfg);
    pages.delete(id); // fresh fetch next run

    const byId = new Map();
    $('.key-personnel .personnel').each((_, el) => {
      const role = clean($(el).find('h3').first().text());
      $(el).find('td span').each((__, span) => {
        const name = clean($(span).text());
        if (!name) return;
        // No person IDs on the directory: key on the normalised name within this firm.
        const personId = crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12);
        const existing = byId.get(personId);
        if (existing) {
          existing.currentRoles = unique([...existing.currentRoles.split('; '), role]).join('; ');
          return;
        }
        byId.set(personId, {
          source: 'mas',
          firmId: id,
          personId,
          name,
          status: 'Active',
          roleCategory: 'Key Personnel',
          currentRoles: role,
          previousFirms: '',
          url: `${BASE}/${detailPath(cfg)}`,
        });
      });
    });
    return [...byId.values()];
  }

  async function search(text) {
    const $ = await load(`institution?term=${encodeURIComponent(text)}&count=0`);
    return $('.result-list .inner').map((_, el) => {
      const href = $(el).find('a[href*="/institution/detail/"]').first().attr('href') || '';
      return {
        id: href.match(/detail\/(\d+)/)?.[1] || '',
        name: clean($(el).find('h3').first().text()),
        licences: $(el).find('.category li').map((__, li) => clean($(li).text())).get().join('; '),
      };
    }).get().filter((r) => r.id);
  }

  return { name: 'mas', fetchFirm, fetchEmployees, search };
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const unique = (arr) => [...new Set(arr.filter(Boolean))];
const slugify = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
