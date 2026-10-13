// Dry run of the news pipeline — prints results, writes nothing (no Sheet, no Slack, no seen-file).
//   npm run news -- --no-ai     fetch + prefilter only (no API key needed)
//   npm run news                with Claude extraction
import 'dotenv/config';
import { runNews } from './index.js';
import { loadState } from '../storage/state.js';

const useAi = !process.argv.includes('--no-ai');
const { moves, unparsed, error } = await runNews(process.env, await loadState(), { useAi });

for (const m of moves) {
  const who = m.person || (m.teamSize ? `Team of ${m.teamSize}` : '(unnamed)');
  const route = `${m.fromFirm || '?'} -> ${m.toFirm || '?'}`;
  console.log(`${m.watched ? '*' : ' '} [${m.market}] ${who} | ${m.role || '-'} | ${route} | ${m.seniority} | ${m.signals.join(', ')}`);
  console.log(`    ${m.source}: ${m.title}`);
  if (m.registerMatches.length) console.log(`    register: ${m.registerMatches.map((r) => `${r.source.toUpperCase()} ${r.firm} (${r.status})`).join('; ')}`);
}
console.log(`\n${moves.length} moves extracted, ${unparsed.length} headlines not classified${error ? `\nNote: ${error}` : ''}`);
if (!useAi) unparsed.forEach((it) => console.log(`  - ${it.source}: ${it.title}`));
