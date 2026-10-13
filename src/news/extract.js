import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';

const MODEL = 'claude-haiku-4-5';
// Small batches: with large ones the model occasionally skips entries.
const CHUNK = 15;

const Person = z.object({
  name: z.string().nullable(),
  role: z.string().nullable(),
  from_firm: z.string().nullable(),
  to_firm: z.string().nullable(),
});

const Extraction = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      is_move: z.boolean(),
      people: z.array(Person),
      team_size: z.number().int().nullable(),
      market: z.enum(['Singapore', 'Hong Kong', 'UAE', 'UK', 'Switzerland', 'Other', 'Unknown']),
      seniority: z.enum(['C-suite', 'MD/Head', 'Director', 'RM/Banker', 'Unknown']),
      signal_note: z.string(),
    }),
  ),
});

// Kept byte-identical between runs so it can be cached.
const SYSTEM = `You extract people moves in private banking and wealth management from news headlines and short summaries.

For each numbered item return one entry with the same index:
- is_move: true only if the item reports a person or team being hired, appointed, promoted, joining, leaving, retiring or being replaced. Product launches, partnerships, results, market commentary, regulation and fund news are false.
- people: one entry per named person (name null when the item gives no name, e.g. "hires duo from EFG"). role = the new role if stated, else the role mentioned. from_firm = the firm they left or come from ("ex-UBS", "from EFG", "Julius Baer veteran"). to_firm = the firm they join or are appointed at. Use null for anything not stated. Never guess or add facts that are not in the text.
- team_size: number of people when a group move is described ("duo" = 2, "trio" = 3, "team of five" = 5), else null.
- market: the booking centre / location the role covers, from the text. Unknown if not stated.
- seniority: C-suite (CEO, CIO, COO, CFO, chairman), MD/Head (managing director, head of, market head, regional head), Director, RM/Banker (relationship manager, banker, adviser), else Unknown.
- signal_note: at most 12 words of useful context, e.g. "joins Global South Asia team" or "replaces retiring APAC head". Empty string if none.
For items that are not moves, return is_move false, people [], team_size null, market Unknown, seniority Unknown, signal_note "".`;

/**
 * Sends headlines to Claude in chunks and returns { results: Map<index, extraction>, unparsed: index[], error }.
 * Never throws: an API problem degrades to "unparsed" so the register part of the run is unaffected.
 */
export async function extractMoves(items, env = process.env) {
  const results = new Map();
  const unparsed = [];
  if (!items.length) return { results, unparsed, error: null };
  if (!env.ANTHROPIC_API_KEY) return { results, unparsed: items.map((_, i) => i), error: 'ANTHROPIC_API_KEY not set' };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let error = null;

  /** Classifies the given item indexes; returns the indexes the model did not return. */
  async function classify(indexes) {
    const prompt = indexes
      .map((i) => `[${i}] ${items[i].title}${items[i].description ? `\nSummary: ${items[i].description}` : ''}`)
      .join('\n\n');
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Return exactly ${indexes.length} entries, one for each index.\n\n${prompt}` }],
      output_config: { format: zodOutputFormat(Extraction) },
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      error ??= `Claude returned no structured output (${response.stop_reason})`;
      return indexes;
    }
    for (const entry of response.parsed_output.items) if (indexes.includes(entry.index)) results.set(entry.index, entry);
    return indexes.filter((i) => !results.has(i));
  }

  for (let start = 0; start < items.length; start += CHUNK) {
    let pending = items.slice(start, start + CHUNK).map((_, i) => start + i);
    try {
      pending = await classify(pending);
      if (pending.length) pending = await classify(pending); // one retry for skipped entries
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) error = 'Anthropic API key rejected';
      else if (err instanceof Anthropic.RateLimitError) error ??= 'Anthropic rate limit hit';
      else if (err instanceof Anthropic.APIError) error ??= `Anthropic API error ${err.status}: ${err.message}`;
      else error ??= `News extraction failed: ${err.message}`;
      unparsed.push(...pending);
      if (err instanceof Anthropic.AuthenticationError) {
        for (let i = start + CHUNK; i < items.length; i++) unparsed.push(i);
        break;
      }
      continue;
    }
    unparsed.push(...pending);
  }
  return { results, unparsed, error };
}
