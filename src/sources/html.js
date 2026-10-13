import * as cheerio from 'cheerio';
import crypto from 'node:crypto';

/**
 * Generic scraping source for registers / team pages with no API.
 * Configure per firm in config/firms.json:
 *   { "source": "html", "id": "...", "name": "...", "url": "...",
 *     "selectors": { "row": ".member", "name": ".name", "role": ".title", "link": "a" } }
 * For JS-rendered or paginated sites, write a dedicated source in this folder
 * with the same fetchFirm / fetchEmployees interface.
 */
export function createHtmlSource() {
  async function load(url) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MandateMatcherBot/1.0)' },
    });
    if (!res.ok) throw new Error(`Scrape ${res.status} for ${url}`);
    return cheerio.load(await res.text());
  }

  async function fetchFirm(cfg) {
    return {
      source: 'html',
      id: String(cfg.id),
      name: cfg.name || cfg.id,
      status: '',
      type: '',
      companiesHouseNo: cfg.companiesHouseNo || '',
      statusDate: '',
      address: '',
      url: cfg.url,
    };
  }

  async function fetchEmployees(cfg) {
    const s = cfg.selectors || {};
    const $ = await load(cfg.url);
    const people = [];
    $(s.row).each((_, el) => {
      const row = $(el);
      const name = (s.name ? row.find(s.name).first().text() : row.text()).trim().replace(/\s+/g, ' ');
      if (!name) return;
      const role = s.role ? row.find(s.role).first().text().trim().replace(/\s+/g, ' ') : '';
      const href = s.link ? row.find(s.link).first().attr('href') : '';
      people.push({
        source: 'html',
        firmId: String(cfg.id),
        // No stable ID on most pages: use the profile link, else a hash of the name.
        personId: href || crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12),
        name,
        status: 'Listed',
        roleCategory: role,
        currentRoles: role,
        previousFirms: '',
        url: href ? new URL(href, cfg.url).toString() : cfg.url,
      });
    });
    return people;
  }

  return { name: 'html', fetchFirm, fetchEmployees };
}
