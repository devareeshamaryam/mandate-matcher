import { google } from 'googleapis';

const TABS = {
  companies: {
    title: 'Companies',
    header: ['Source', 'Firm ID', 'Name', 'Status', 'Type', 'Companies House No', 'Status Date', 'Address',
      'Active Employees', 'Added (last run)', 'Revoked (last run)', 'Register URL', 'Last Checked'],
  },
  employees: {
    title: 'Employees',
    header: ['Source', 'Firm ID', 'Firm Name', 'Person ID', 'Name', 'Status', 'Role Category', 'Current Roles',
      'Previous Firms', 'First Seen', 'Last Seen', 'Profile URL'],
  },
  changes: {
    title: 'Changes',
    header: ['Detected At', 'Change', 'Source', 'Firm ID', 'Firm Name', 'Person ID', 'Name', 'Status',
      'Role Category', 'Detail', 'Profile URL'],
  },
  news: {
    title: 'News Moves',
    header: ['Detected At', 'Published', 'Source', 'Headline', 'Link', 'Person', 'Role', 'From Firm', 'To Firm',
      'Market', 'Seniority', 'Team Size', 'Signal', 'Watched Firm', 'Register Match', 'Note'],
  },
};

export function createSheetsStore({ spreadsheetId, keyFile }) {
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  async function ensureTabs() {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
    const requests = Object.values(TABS)
      .filter((t) => !existing.has(t.title))
      .map((t) => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } }));
    if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  async function replaceTab({ title, header }, rows) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${title}'` });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] },
    });
  }

  async function appendTab({ title, header }, rows) {
    const first = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title}'!A1:A1` });
    const values = first.data.values?.length ? rows : [header, ...rows];
    if (!values.length) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  }

  /** Writes the full current picture (Companies + Employees) and appends this run's changes. */
  async function write(state, results, runAt, movers = [], newsMoves = []) {
    await ensureTabs();

    const companyRows = Object.values(state).map(({ firm, employees, lastRun }) => [
      firm.source, firm.id, firm.name, firm.status, firm.type, firm.companiesHouseNo, firm.statusDate, firm.address,
      Object.keys(employees).length, lastRun?.added ?? '', lastRun?.revoked ?? '', firm.url, lastRun?.at ?? '',
    ]);

    const employeeRows = Object.values(state).flatMap(({ firm, employees }) =>
      Object.values(employees).map((e) => [
        e.source, e.firmId, firm.name, e.personId, e.name, e.status, e.roleCategory, e.currentRoles,
        e.previousFirms, e.firstSeen, e.lastSeen, e.url,
      ]),
    );

    const changeRows = results.flatMap(({ firm, diff, baseline }) => {
      if (baseline) return [];
      const row = (kind, e, detail) => [
        runAt, kind, firm.source, firm.id, firm.name, e.personId, e.name, e.status, e.roleCategory, detail, e.url,
      ];
      return [
        ...diff.added.map((e) => row('ADDED', e, e.currentRoles)),
        ...diff.revoked.map((e) => row('REVOKED', e, e.reason)),
        ...diff.changed.map((e) => row('CHANGED', e, `${e.from} -> ${e.to}`)),
      ];
    });

    for (const { emp, fromFirm, toFirm } of movers) {
      changeRows.push([runAt, 'MOVED', toFirm.source, toFirm.id, toFirm.name, emp.personId, emp.name, emp.status,
        emp.roleCategory, `${fromFirm.name} -> ${toFirm.name}`, emp.url]);
    }

    await replaceTab(TABS.companies, companyRows);
    await replaceTab(TABS.employees, employeeRows);
    await appendTab(TABS.changes, changeRows);

    const newsRows = newsMoves.map((m) => [
      m.detectedAt, m.publishedAt, m.source, m.title, m.link, m.person || '', m.role || '', m.fromFirm || '',
      m.toFirm || '', m.market, m.seniority, m.teamSize ?? '', m.signals.join(', '),
      [m.watchedFrom?.name, m.watchedTo?.name].filter(Boolean).join(' -> '),
      m.registerMatches.map((r) => `${r.source.toUpperCase()}: ${r.firm} (${r.status})`).join('; '),
      m.note || '',
    ]);
    await appendTab(TABS.news, newsRows);
  }

  return { write };
}
