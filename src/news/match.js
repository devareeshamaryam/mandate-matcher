// Only legal forms are dropped; words like "Bank" or "Singapore" are part of names ("Bank of Singapore").
const LEGAL_FORMS = /\b(ltd|limited|plc|ag|sa|llc|inc|pjsc|n a|co|company|corp|corporation|difc branch)\b/g;

export function normaliseFirm(name = '', aliases = {}) {
  let n = name.trim();
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (n.toLowerCase() === alias.toLowerCase()) n = canonical;
  }
  return n
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(Middle East)", "(DIFC Branch)", "(Suisse)"
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Privée -> privee
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(LEGAL_FORMS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Trailing generic/location words: "HSBC Bank Middle East" and "HSBC Singapore" both reduce to the brand "hsbc".
const TRAILING_GENERIC = new Set(['bank', 'banking', 'private', 'global', 'wealth', 'management', 'wm', 'pb', 'international',
  'asia', 'pacific', 'apac', 'hong', 'kong', 'singapore', 'middle', 'east', 'europe', 'uk', 'suisse', 'switzerland', 'group',
  'holdings', 'dubai', 'abu', 'dhabi', 'difc', 'adgm', 'japan', 'china']);

/** Brand key, or null when stripping would leave something ambiguous like "bank of". */
function brandKey(key) {
  const tokens = key.split(' ');
  while (tokens.length > 1 && TRAILING_GENERIC.has(tokens[tokens.length - 1])) tokens.pop();
  const brand = tokens.join(' ');
  if (brand.length < 3 || /\b(of|and|the)$/.test(brand) || TRAILING_GENERIC.has(brand)) return null;
  return brand;
}

const normalisePerson = (name = '') =>
  name.toLowerCase().replace(/\b(mr|mrs|ms|miss|dr)\b/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((t) => t.length > 1).sort().join(' ');

/** Builds lookups once per run from the register snapshot (data/state.json). */
export function buildIndex(state, aliases) {
  const firms = new Map(); // normalised name -> [{source, id, name}]
  const brands = new Map(); // brand key -> {source, id, name}
  const people = new Map(); // normalised person -> [{source, firm, status, url}]
  for (const { firm, employees } of Object.values(state)) {
    const key = normaliseFirm(firm.name, aliases);
    const ref = { source: firm.source, id: firm.id, name: firm.name };
    if (key) firms.set(key, [...(firms.get(key) || []), ref]);
    const brand = key && brandKey(key);
    if (brand && !brands.has(brand)) brands.set(brand, ref);
    for (const e of Object.values(employees || {})) {
      const pk = normalisePerson(e.name);
      if (!pk) continue;
      people.set(pk, [...(people.get(pk) || []), { source: e.source, firm: firm.name, status: e.status, url: e.url }]);
    }
  }
  return { firms, brands, people, aliases };
}

/**
 * A news firm is "watched" if it equals a watched firm's name, or one is a whole-word prefix of the other:
 * "HSBC" ~ "HSBC Private Bank (Suisse) SA", "Julius Baer Singapore" ~ "Julius Baer (Middle East) Ltd".
 * Prefix-only (not "contains") so "UBS Singapore" never matches "Bank of Singapore".
 */
export function matchFirm(index, name) {
  if (!name) return null;
  const key = normaliseFirm(name, index.aliases);
  if (key.length < 3) return null;
  if (index.firms.has(key)) return index.firms.get(key)[0];
  for (const [k, v] of index.firms) {
    if (k.length >= 3 && (k.startsWith(`${key} `) || key.startsWith(`${k} `))) return v[0];
  }
  // Brand level: "HSBC Hong Kong" ~ "HSBC Bank Middle East"; aliases also apply to the brand ("Citi Wealth" -> "Citi" -> Citibank).
  const brand = brandKey(key);
  if (!brand) return null;
  if (index.brands.has(brand)) return index.brands.get(brand);
  const aliased = normaliseFirm(brand, index.aliases);
  if (aliased !== brand) return matchFirm(index, aliased);
  return null;
}

export function matchPerson(index, name) {
  if (!name) return [];
  return index.people.get(normalisePerson(name)) || [];
}
