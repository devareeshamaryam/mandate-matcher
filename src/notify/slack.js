const MAX_NAMES = 15;

export async function sendSlackSummary(webhookUrl, results, { sheetUrl, movers = [], news = null } = {}) {
  if (!webhookUrl) return;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Mandate Matcher - register update' } },
  ];

  if (movers.length) {
    const lines = movers.slice(0, MAX_NAMES).map(({ emp, fromFirm, toFirm }) =>
      `• <${emp.url}|${emp.name}>: ${fromFirm.name} → *${toFirm.name}* (warm candidate; seat vacated at ${fromFirm.name})`);
    if (movers.length > MAX_NAMES) lines.push(`_...and ${movers.length - MAX_NAMES} more (see Google Sheet)_`);
    blocks.push(section(`:arrows_counterclockwise: *Movers between watched firms (${movers.length})*\n${lines.join('\n')}`));
  }

  // Before the per-firm sections so it survives the 50-block cap.
  if (news) blocks.push(...newsBlocks(news));

  const changed = results.filter((r) => r.error || r.baseline || hasChanges(r.diff));
  if (!changed.length) {
    blocks.push(section(`No joiners or leavers across ${results.length} watched firm(s).`));
  }

  for (const r of changed) {
    const title = `*<${r.firm.url}|${r.firm.name || r.firm.id}>* (${r.firm.source.toUpperCase()} ${r.firm.id})`;
    if (r.error) {
      blocks.push(section(`${title}\n:warning: Failed: ${r.error}`));
      continue;
    }
    if (r.baseline) {
      blocks.push(section(`${title}\n:seedling: Baseline captured - ${r.activeCount} active people. Changes will be reported from the next run.`));
      continue;
    }
    const { added, revoked, changed: moved } = r.diff;
    let text = `${title}\n:busts_in_silhouette: ${r.activeCount} active  |  :large_green_circle: +${added.length} added  |  :red_circle: -${revoked.length} revoked`;
    if (moved.length) text += `  |  :large_yellow_circle: ${moved.length} status changes`;
    if (added.length) text += `\n*Added:*\n${list(added, (e) => [e.currentRoles || e.roleCategory, e.previousFirms && `ex ${e.previousFirms}`])}`;
    if (revoked.length) text += `\n*Revoked / left:*\n${list(revoked, (e) => [e.roleCategory, e.reason])}`;
    if (moved.length) text += `\n*Status changes:*\n${list(moved, (e) => [`${e.from} -> ${e.to}`])}`;
    blocks.push({ type: 'divider' }, section(text));
  }

  if (sheetUrl) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${sheetUrl}|Open Google Sheet>` }] });

  // Slack allows max 50 blocks per message.
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Mandate Matcher register update', blocks: blocks.slice(0, 50) }),
  });
  if (!res.ok) throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
}

const hasChanges = (d) => d && (d.added.length || d.revoked.length || d.changed.length);

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SIGNAL_ICONS = { 'Warm candidate': ':fire:', 'Seat vacated': ':chair:', 'Hiring push': ':chart_with_upwards_trend:' };

/** "People moves in the news": grouped by market, watched-firm moves first, max MAX_NAMES lines. */
function newsBlocks({ moves = [], unparsed = [], error }) {
  const blocks = [];
  if (moves.length) {
    const sorted = [...moves].sort((a, b) => Number(b.watched) - Number(a.watched));
    const byMarket = new Map();
    for (const m of sorted.slice(0, MAX_NAMES)) byMarket.set(m.market, [...(byMarket.get(m.market) || []), m]);

    const parts = [];
    for (const [market, ms] of byMarket) {
      parts.push(`*${esc(market)} (${ms.length})*`);
      for (const m of ms) {
        const who = m.person ? `*${esc(m.person)}*` : m.teamSize ? `*Team of ${m.teamSize}*` : '*Unnamed*';
        const route = [m.fromFirm && esc(m.fromFirm), m.toFirm && `*${esc(m.toFirm)}*`].filter(Boolean).join(' → ');
        const icons = m.signals.map((s) => SIGNAL_ICONS[s]).filter(Boolean).join('');
        let line = `${m.watched ? ':star: ' : '• '}${who}${route ? `: ${route}` : ''}${m.role ? ` (${esc(m.role)})` : ''} ${icons} · <${m.link}|${esc(m.source)}>`;
        if (m.registerMatches.length) {
          line += `\n      _also on register: ${m.registerMatches.slice(0, 2).map((r) => `${r.source.toUpperCase()} ${esc(r.firm)} (${esc(r.status)})`).join('; ')}_`;
        }
        parts.push(line);
      }
    }
    if (moves.length > MAX_NAMES) parts.push(`_...and ${moves.length - MAX_NAMES} more in the "News Moves" tab_`);
    blocks.push({ type: 'divider' }, section(`:newspaper: *People moves in the news (${moves.length})*\n${parts.join('\n')}`));
  }
  if (error) {
    blocks.push(section(`:warning: News feeds: ${esc(error)}${unparsed.length ? ` - ${unparsed.length} headline(s) will be retried next run` : ''}`));
  }
  return blocks;
}

function section(text) {
  // Slack section text limit is 3000 chars.
  return { type: 'section', text: { type: 'mrkdwn', text: text.length > 2990 ? `${text.slice(0, 2987)}...` : text } };
}

function list(people, details) {
  const lines = people.slice(0, MAX_NAMES).map((e) => {
    const extra = details(e).filter(Boolean).join(' - ');
    return `• <${e.url}|${e.name}>${extra ? ` - ${extra}` : ''}`;
  });
  if (people.length > MAX_NAMES) lines.push(`_...and ${people.length - MAX_NAMES} more (see Google Sheet)_`);
  return lines.join('\n');
}
