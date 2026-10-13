import path from 'node:path';
import * as cheerio from 'cheerio';
import { sleep } from '../util.js';

/**
 * Dubai Financial Services Authority (DIFC) Public Register.
 * https://www.dfsa.ae/public-register
 *
 * The site sits behind Cloudflare, which refuses scripted HTTP clients and headless browsers (403),
 * but serves a normal Chrome window fine. So this source drives the locally installed Chrome
 * (visible window, no stealth tricks) and parses the server-rendered HTML:
 *   /public-register/firms?keywords=<name>     firm search -> firm page links
 *   /public-register/firms/<slug>              firm details + "Individuals" tab: every Authorised / Key
 *                                              Individual with effective and withdrawn dates
 *   /public-register/individuals/<slug>        functions held at each DIFC firm (cross-firm history)
 * Firm id in config/firms.json = DFSA reference number (e.g. F000001). Optional "slug" skips the search.
 * If Cloudflare ever shows a challenge, the run fails for DFSA with a clear message rather than trying to get round it.
 */

const BASE = 'https://www.dfsa.ae/public-register';

export function createDfsaSource(env) {
  const minIntervalMs = Number(env.DFSA_MIN_INTERVAL_MS || 1500);
  let ctxPromise = null;
  let lastRequestAt = 0;
  const firmNames = new Map(); // DFSA ref -> firm name, used to tell "this firm" apart in a person's history

  async function getPage() {
    ctxPromise ??= (async () => {
      const { chromium } = await import('playwright-core');
      const ctx = await chromium.launchPersistentContext(path.resolve('data/chrome-dfsa'), {
        channel: env.DFSA_BROWSER_CHANNEL || 'chrome',
        headless: false,
        viewport: { width: 1100, height: 800 },
      });
      return ctx;
    })();
    const ctx = await ctxPromise;
    return ctx.pages()[0] || ctx.newPage();
  }

  async function load(url, attempt = 0) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const page = await getPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    if (res?.status() === 403 || /Attention Required|Just a moment/i.test(title)) {
      if (attempt < 1) {
        await sleep(10000);
        return load(url, attempt + 1);
      }
      throw new Error(`DFSA blocked by Cloudflare at ${url} (status ${res?.status()}, "${title}")`);
    }
    if (!res?.ok()) throw new Error(`DFSA ${res?.status()} for ${url}`);
    return cheerio.load(await page.content());
  }

  const text = ($, el) => $(el).text().replace(/\s+/g, ' ').trim();

  async function findFirmUrl(cfg) {
    if (cfg.slug) return `${BASE}/firms/${cfg.slug}`;
    const $ = await load(`${BASE}/firms?keywords=${encodeURIComponent(cfg.searchName || cfg.name || cfg.id)}`);
    const links = [...new Set($('a[href*="/public-register/firms/"]').map((_, a) => $(a).attr('href')).get())];
    for (const href of links.slice(0, 8)) {
      const $f = await load(href);
      if (firmDetails($f)['DFSA Reference Number'] === cfg.id) return href;
    }
    throw new Error(`DFSA firm ${cfg.id} not found searching "${cfg.searchName || cfg.name}" (add "slug" to firms.json)`);
  }

  function firmDetails($) {
    const out = {};
    $('#firms .table-row').first().find('.col').each((_, c) => {
      const label = text($, $(c).find('p.small').first()).replace(/:$/, '');
      const value = text($, $(c).find('p').not('.small').first());
      if (label) out[label] = value;
    });
    return out;
  }

  async function fetchFirm(cfg) {
    const url = await findFirmUrl(cfg);
    const $ = await load(url);
    const d = firmDetails($);
    const name = text($, $('.pr-title h2').first()) || d['Name'] || cfg.name;
    firmNames.set(cfg.id, name);
    return {
      source: 'dfsa',
      id: cfg.id,
      name,
      status: /withdrawn/i.test($('#firms').text()) && !d['Date of Licence'] ? 'Withdrawn' : 'Licensed',
      type: d['Legal Status'] || '',
      companiesHouseNo: '',
      statusDate: d['Date of Licence'] || '',
      address: d['Address'] || '',
      url,
      _html: $.html(), // reused by fetchEmployees so the firm page is loaded once per run
    };
  }

  async function fetchEmployees(cfg, firm) {
    const $ = firm?._html ? cheerio.load(firm._html) : await load(firm?.url || (await findFirmUrl(cfg)));
    if (firm) delete firm._html;

    // One row per appointment -> group by DFSA reference number.
    const people = new Map();
    $('#individuals a[href*="/public-register/individuals/"]').each((_, a) => {
      const cols = $(a).find('.col').map((_, c) => text($, c)).get();
      const [name, ref, type, effective, withdrawn] = cols;
      if (!ref) return;
      const p = people.get(ref) || { ref, name, url: $(a).attr('href'), current: [], past: [] };
      (/withdrawn/i.test(type) || withdrawn ? p.past : p.current).push({ type: type.replace(/\s*\(Withdrawn\)/i, ''), effective, withdrawn });
      people.set(ref, p);
    });

    return [...people.values()].map((p) => {
      const active = p.current.length > 0;
      const latest = active ? p.current : p.past;
      const lastWithdrawn = p.past.map((r) => r.withdrawn).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      return {
        source: 'dfsa',
        firmId: cfg.id,
        personId: p.ref,
        name: p.name.replace(/^(Mr|Mrs|Ms|Miss|Dr)\s+/i, ''),
        status: active ? 'Active' : `Withdrawn${lastWithdrawn ? ` ${lastWithdrawn}` : ''}`,
        roleCategory: singular(latest[0]?.type),
        currentRoles: latest.map((r) => `${singular(r.type)} (since ${r.effective})`).join('; '),
        previousFirms: '',
        url: p.url,
      };
    });
  }

  /** Functions held (SEO, Licensed Director, Senior Manager, ...) and other DIFC firms from the person's page. */
  async function enrichEmployee(emp) {
    const $ = await load(emp.url);
    const appointments = [];
    $('#individuals .table-row').each((_, r) => {
      const f = {};
      $(r).find('.col').each((_, c) => {
        const ps = $(c).find('p');
        if (ps.length >= 2) f[text($, ps[0])] = text($, ps[1]);
      });
      if (f['Firm Name']) appointments.push(f);
    });
    const firmName = firmNames.get(emp.firmId);
    const here = appointments.filter((a) => !a['Withdrawal Date'] && (!firmName || a['Firm Name'] === firmName));
    const elsewhere = [...new Set(appointments.map((a) => a['Firm Name']).filter((n) => n && n !== (firmName || here[0]?.['Firm Name'])))];
    const functions = [...new Set(here.flatMap((a) => (a['Functions'] || '').split(',').map((s) => s.trim())).filter(Boolean))];
    return {
      ...emp,
      roleCategory: functions[0] || emp.roleCategory,
      currentRoles: functions.length ? `${functions.join(', ')} (since ${here[0]?.['Effective Date'] || '?'})` : emp.currentRoles,
      previousFirms: elsewhere.join('; '),
    };
  }

  async function close() {
    if (ctxPromise) await (await ctxPromise).close().catch(() => {});
    ctxPromise = null;
  }

  return { name: 'dfsa', fetchFirm, fetchEmployees, enrichEmployee, close };
}

const singular = (type = '') => type.replace(/Individuals\b/, 'Individual').trim();
