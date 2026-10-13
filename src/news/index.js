import fs from 'node:fs/promises';
import { fetchFeed, loadSeen, saveSeen, normaliseTitle } from './feeds.js';
import { extractMoves } from './extract.js';
import { buildIndex, matchFirm, matchPerson } from './match.js';
import { log, nowIso } from '../util.js';

const HIRING_PUSH_THRESHOLD = 3; // moves into the same firm within the seen window (60 days)

/**
 * News people-moves pipeline: feeds -> new items -> keyword prefilter -> Claude extraction -> matching.
 * Returns { moves, unparsed, error, commit } — call commit() after the sheet write succeeds so items
 * are only marked as seen once they are safely stored.
 */
export async function runNews(env, state, { useAi = true } = {}) {
  const config = JSON.parse(await fs.readFile(env.NEWS_CONFIG || './config/news.json', 'utf8'));
  const seen = await loadSeen();
  const runAt = nowIso();
  const maxAge = Date.now() - (config.maxAgeDays || 14) * 86400000;
  const moveRe = new RegExp(config.moveKeywords, 'i');
  const errors = [];

  // 1. Collect + dedupe
  const fresh = [];
  const titles = new Set();
  for (const feed of config.feeds) {
    try {
      const items = await fetchFeed(feed);
      let kept = 0;
      for (const it of items) {
        const key = normaliseTitle(it.title);
        if (seen.items[it.id] || titles.has(key)) continue;
        if (it.publishedAt && Date.parse(it.publishedAt) < maxAge) continue;
        titles.add(key);
        fresh.push(it);
        kept++;
      }
      log(`  news: ${feed.name} ${items.length} items, ${kept} new`);
    } catch (err) {
      errors.push(`${feed.name}: ${err.message}`);
      log(`  news: ${feed.name} FAILED ${err.message}`);
    }
  }

  // 2. Cheap keyword prefilter before any API call
  const candidates = fresh.filter((it) => moveRe.test(`${it.title} ${it.description}`));
  log(`  news: ${fresh.length} new items, ${candidates.length} look like people moves`);

  // 3. Extraction
  const { results, unparsed, error } = useAi
    ? await extractMoves(candidates, env)
    : { results: new Map(), unparsed: candidates.map((_, i) => i), error: 'AI extraction skipped (--no-ai)' };
  if (error) errors.push(error);

  // 4. Matching + signals
  const index = buildIndex(state, config.firmAliases || {});
  const recentInto = new Map();
  for (const m of seen.moves || []) if (m.toKey) recentInto.set(m.toKey, (recentInto.get(m.toKey) || 0) + 1);

  const moves = [];
  candidates.forEach((it, i) => {
    const x = results.get(i);
    if (!x?.is_move) return;
    const people = x.people.length ? x.people : [{ name: null, role: null, from_firm: null, to_firm: null }];
    for (const p of people) {
      const watchedFrom = matchFirm(index, p.from_firm);
      const watchedTo = matchFirm(index, p.to_firm);
      const registerMatches = matchPerson(index, p.name);
      const toKey = watchedTo ? `${watchedTo.source}:${watchedTo.id}` : p.to_firm?.toLowerCase() || null;
      if (toKey) recentInto.set(toKey, (recentInto.get(toKey) || 0) + 1);
      moves.push({
        detectedAt: runAt,
        publishedAt: it.publishedAt,
        source: it.source,
        title: it.title,
        link: it.link,
        person: p.name,
        role: p.role,
        fromFirm: p.from_firm,
        toFirm: p.to_firm,
        teamSize: x.team_size,
        market: x.market,
        seniority: x.seniority,
        note: x.signal_note,
        watchedFrom,
        watchedTo,
        registerMatches,
        toKey,
      });
    }
  });
  // Same person + destination reported by several headlines -> one move listing every source.
  const unique = new Map();
  for (const m of moves) {
    const key = m.person ? `${m.person.toLowerCase().replace(/[^a-z]/g, '')}|${(m.toFirm || '').toLowerCase()}` : `${m.link}|${unique.size}`;
    const prev = unique.get(key);
    if (!prev) unique.set(key, m);
    else if (!prev.source.split(', ').includes(m.source)) prev.source += `, ${m.source}`;
  }
  moves.length = 0;
  moves.push(...unique.values());

  for (const m of moves) {
    const signals = [];
    if (m.toFirm) signals.push('Warm candidate');
    if (m.fromFirm) signals.push('Seat vacated');
    if (m.toKey && recentInto.get(m.toKey) >= HIRING_PUSH_THRESHOLD) signals.push('Hiring push');
    m.signals = signals;
    m.watched = Boolean(m.watchedFrom || m.watchedTo);
  }

  const unparsedItems = unparsed.map((i) => candidates[i]).filter(Boolean);

  async function commit() {
    for (const it of fresh) {
      // Items that could not be classified stay unseen so the next run retries them.
      const idx = candidates.indexOf(it);
      if (idx !== -1 && unparsed.includes(idx)) continue;
      seen.items[it.id] = runAt;
    }
    seen.moves = [...(seen.moves || []), ...moves.map((m) => ({ at: runAt, toKey: m.toKey }))];
    await saveSeen(seen);
  }

  return { moves, unparsed: unparsedItems, error: errors.length ? errors.join('; ') : null, commit };
}
