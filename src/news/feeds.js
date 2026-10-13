import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const SEEN_FILE = path.resolve('data/news-seen.json');
const SEEN_TTL_DAYS = 60;

/** Reads one RSS/Atom feed. Only headline, link, short summary and date are kept — article pages are never fetched. */
export async function fetchFeed({ name, url }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${name} feed ${res.status}`);
  const $ = cheerio.load(await res.text(), { xml: true });

  const items = $('item').length ? $('item') : $('entry');
  return items
    .map((_, el) => {
      const node = $(el);
      const link = node.find('link').first().attr('href') || node.find('link').first().text().trim();
      const title = clean(node.find('title').first().text());
      const description = clean(node.find('description, summary, content').first().text()).slice(0, 400);
      const date = node.find('pubDate, published, updated, dc\\:date').first().text().trim();
      return {
        id: node.find('guid, id').first().text().trim() || link,
        source: name,
        title,
        link,
        description,
        publishedAt: date ? new Date(date).toISOString() : '',
      };
    })
    .get()
    .filter((i) => i.title && i.link);
}

/** Strips HTML and decodes entities (feeds double-encode things like &#038;). */
function clean(s = '') {
  const decoded = cheerio.load(`<p>${s}</p>`).text();
  return cheerio.load(`<p>${decoded}</p>`).text().replace(/\s+/g, ' ').trim();
}

export const normaliseTitle = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export async function loadSeen() {
  try {
    return JSON.parse(await fs.readFile(SEEN_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { items: {}, moves: [] };
    throw err;
  }
}

export async function saveSeen(seen) {
  const cutoff = Date.now() - SEEN_TTL_DAYS * 86400000;
  for (const [id, at] of Object.entries(seen.items)) if (Date.parse(at) < cutoff) delete seen.items[id];
  seen.moves = (seen.moves || []).filter((m) => Date.parse(m.at) >= cutoff);
  await fs.mkdir(path.dirname(SEEN_FILE), { recursive: true });
  await fs.writeFile(`${SEEN_FILE}.tmp`, JSON.stringify(seen, null, 2));
  await fs.rename(`${SEEN_FILE}.tmp`, SEEN_FILE);
}
