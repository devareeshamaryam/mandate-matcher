import fs from 'node:fs/promises';
import { createSources } from './sources/index.js';
import { diffEmployees } from './diff.js';
import { loadState, saveState } from './storage/state.js';
import { createSheetsStore } from './storage/sheets.js';
import { sendSlackSummary } from './notify/slack.js';
import { runNews } from './news/index.js';
import { isActiveStatus, log, nowIso } from './util.js';

export async function runOnce(env = process.env) {
  const runAt = nowIso();
  const firms = (JSON.parse(await fs.readFile(env.FIRMS_CONFIG || './config/firms.json', 'utf8')))
    .filter((f) => f.enabled !== false);
  const getSource = createSources(env);
  const enrichMode = (env.ENRICH_MODE || 'new').toLowerCase();
  const state = await loadState();
  const results = [];

  for (const cfg of firms) {
    const key = `${cfg.source}:${cfg.id}`;
    const prev = state[key];
    try {
      const source = getSource(cfg.source);
      log(`Checking ${key} ...`);
      const firm = await source.fetchFirm(cfg);
      let employees = await source.fetchEmployees(cfg, firm);

      const baseline = !prev;
      const prevEmployees = prev?.employees || {};

      // Carry forward first-seen dates and earlier enrichment, so we only re-query people when needed.
      employees = employees.map((e) => {
        const old = prevEmployees[e.personId];
        return {
          ...e,
          currentRoles: e.currentRoles || old?.currentRoles || '',
          previousFirms: e.previousFirms || old?.previousFirms || '',
          // An enriched role (e.g. DFSA "Senior Manager") beats the list's generic label ("Authorised Individual").
          roleCategory: old?.roleCategory && (old.enriched || !e.currentRoles) ? old.roleCategory : e.roleCategory,
          enriched: old?.enriched || false,
          firstSeen: old?.firstSeen || runAt,
          lastSeen: runAt,
        };
      });

      const diff = baseline ? { added: [], revoked: [], changed: [] } : diffEmployees(prevEmployees, employees);

      if (source.enrichEmployee && enrichMode !== 'none') {
        const addedIds = new Set(diff.added.map((e) => e.personId));
        const targets = enrichMode === 'all' ? employees : employees.filter((e) => addedIds.has(e.personId));
        log(`  enriching ${targets.length} people`);
        for (const t of targets) {
          try {
            Object.assign(t, await source.enrichEmployee(t), { enriched: true });
          } catch (err) {
            log(`  enrich failed for ${t.personId}: ${err.message}`);
          }
        }
        // keep diff entries in sync with enriched data
        const byId = Object.fromEntries(employees.map((e) => [e.personId, e]));
        diff.added = diff.added.map((e) => byId[e.personId] || e);
      }

      const activeCount = employees.filter((e) => isActiveStatus(e.status)).length;
      state[key] = {
        firm,
        employees: Object.fromEntries(employees.map((e) => [e.personId, e])),
        lastRun: { at: runAt, added: diff.added.length, revoked: diff.revoked.length },
      };
      results.push({ firm, diff, baseline, activeCount });
      log(`  ${firm.name}: ${activeCount} active, +${diff.added.length} / -${diff.revoked.length} / ~${diff.changed.length}${baseline ? ' (baseline)' : ''}`);
    } catch (err) {
      log(`  FAILED ${key}: ${err.message}`);
      results.push({ firm: prev?.firm || { source: cfg.source, id: cfg.id, name: cfg.name, url: cfg.url || '' }, error: err.message });
    }
  }

  await getSource.closeAll();

  const movers = detectMovers(results);
  if (movers.length) log(`Movers between watched firms: ${movers.length}`);

  // News feeds never break the register part of the run.
  let news = null;
  if (env.NEWS_ENABLED !== 'false') {
    log('Checking news feeds ...');
    try {
      news = await runNews(env, state);
      log(`  news: ${news.moves.length} moves, ${news.unparsed.length} unclassified${news.error ? ` (${news.error})` : ''}`);
    } catch (err) {
      news = { moves: [], unparsed: [], error: err.message, commit: async () => {} };
      log(`  news FAILED: ${err.message}`);
    }
  }

  if (env.GOOGLE_SHEET_ID) {
    log('Writing Google Sheet ...');
    await createSheetsStore({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    }).write(state, results.filter((r) => !r.error), runAt, movers, news?.moves || []);
  } else {
    log('GOOGLE_SHEET_ID not set - skipping Google Sheets');
  }

  // Save state only after the sheet write succeeded, so a failed write is retried next run.
  await saveState(state);
  await news?.commit();

  if (env.SLACK_WEBHOOK_URL) {
    log('Sending Slack summary ...');
    await sendSlackSummary(env.SLACK_WEBHOOK_URL, results, {
      movers,
      news,
      sheetUrl: env.GOOGLE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${env.GOOGLE_SHEET_ID}` : undefined,
    });
  } else {
    log('SLACK_WEBHOOK_URL not set - skipping Slack');
  }

  return { results, movers };
}

/** Same person (same register ID) revoked at one watched firm and added at another in this run. */
function detectMovers(results) {
  const left = new Map();
  for (const r of results) {
    for (const e of r.diff?.revoked || []) left.set(`${e.source}:${e.personId}`, { firm: r.firm, emp: e });
  }
  const movers = [];
  for (const r of results) {
    for (const e of r.diff?.added || []) {
      const from = left.get(`${e.source}:${e.personId}`);
      if (from && from.firm.id !== r.firm.id) movers.push({ emp: e, fromFirm: from.firm, toFirm: r.firm });
    }
  }
  return movers;
}
