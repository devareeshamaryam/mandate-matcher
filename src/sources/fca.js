import { createFcaClient } from './fcaClient.js';

/**
 * FCA Register source.
 * Every source returns the same normalised shapes:
 *   firm:     { source, id, name, status, type, companiesHouseNo, statusDate, address, url }
 *   employee: { source, firmId, personId, name, status, roleCategory, currentRoles, previousFirms, url }
 */
export function createFcaSource(env) {
  const client = createFcaClient({
    email: env.FCA_API_EMAIL,
    apiKey: env.FCA_API_KEY,
    minIntervalMs: Number(env.FCA_MIN_INTERVAL_MS || 250),
  });

  async function fetchFirm(cfg) {
    const body = await client.getFirm(cfg.id);
    const f = body?.Data?.[0] || {};
    let address = '';
    try {
      const addr = (await client.getFirmAddress(cfg.id))?.Data?.[0] || {};
      // (sic) the FCA API spells one key "Address LIne 3"
      address = [addr['Address Line 1'], addr['Address Line 2'], addr['Address LIne 3'] ?? addr['Address Line 3'],
        addr['Address Line 4'], addr['Town'], addr['Postcode'], addr['Country']]
        .filter(Boolean)
        .join(', ');
    } catch {
      // address is nice-to-have
    }
    return {
      source: 'fca',
      id: String(cfg.id),
      name: f['Organisation Name'] || cfg.name || '',
      status: f['Status'] || '',
      type: f['Business Type'] || '',
      companiesHouseNo: f['Companies House Number'] || '',
      statusDate: f['Status Effective Date'] || '',
      address,
      url: `https://register.fca.org.uk/s/firm?id=${cfg.id}`,
    };
  }

  async function fetchEmployees(cfg) {
    const rows = await client.getFirmIndividuals(cfg.id);
    return rows.map((r) => ({
      source: 'fca',
      firmId: String(cfg.id),
      personId: r.IRN,
      name: r.Name || '',
      status: r.Status || '',
      roleCategory: roleCategoryFromStatus(r.Status),
      currentRoles: '',
      previousFirms: '',
      url: `https://register.fca.org.uk/s/individual?id=${r.IRN}`,
    }));
  }

  /** Adds controlled functions (roles) and cross-firm history. One extra API call per person. */
  async function enrichEmployee(emp) {
    const body = await client.getIndividualControlledFunctions(emp.personId);
    const { current, previous } = parseControlledFunctions(body?.Data);
    const here = current.filter((c) => !c.firmFrn || c.firmFrn === emp.firmId);
    const otherFirms = new Set(
      [...previous, ...current]
        .filter((c) => c.firmFrn && c.firmFrn !== emp.firmId)
        .map((c) => c.firm)
        .filter(Boolean),
    );
    return {
      ...emp,
      currentRoles: unique(here.map((c) => c.role)).join('; '),
      previousFirms: [...otherFirms].join('; '),
      roleCategory: categorise(here.map((c) => c.role)) || emp.roleCategory,
    };
  }

  return { name: 'fca', fetchFirm, fetchEmployees, enrichEmployee, client };
}

function roleCategoryFromStatus(status = '') {
  if (/approved/i.test(status)) return 'Approved Person';
  if (/certified/i.test(status)) return 'Certified Person';
  return status;
}

function categorise(roles) {
  const r = roles.join(' ');
  if (/\bSMF\d+/i.test(r)) return 'Senior Manager (SMF)';
  if (/\bCF\d+/i.test(r)) return 'Approved Person (CF)';
  if (/certif/i.test(r)) return 'Certified Person';
  return '';
}

/**
 * CF payload looks like:
 *   Data: [ { Current: { "(1)SMF3 Executive Director": { "Name", "Firm Name", "Effective Date", "End Date", "URL" } } },
 *           { Previous: { ... } } ]
 * Parsed defensively because the shape varies between records.
 */
function parseControlledFunctions(data) {
  const current = [];
  const previous = [];
  for (const block of Array.isArray(data) ? data : [data]) {
    if (!block || typeof block !== 'object') continue;
    for (const [bucketName, bucket] of Object.entries(block)) {
      const target = /prev/i.test(bucketName) ? previous : current;
      for (const [key, entry] of Object.entries(bucket || {})) {
        if (!entry || typeof entry !== 'object') continue;
        target.push({
          role: entry['Name'] || key.replace(/^\(\d+\)/, ''),
          firm: entry['Firm Name'] || '',
          firmFrn: (String(entry['URL'] || '').match(/Firm\/(\d+)/) || [])[1] || '',
          from: entry['Effective Date'] || '',
          to: entry['End Date'] || '',
        });
      }
    }
  }
  return { current, previous };
}

const unique = (arr) => [...new Set(arr.filter(Boolean))];
