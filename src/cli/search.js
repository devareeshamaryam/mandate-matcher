// Find firm IDs to put in config/firms.json:
//   npm run search -- "Barclays"                FCA firms (FRN)
//   npm run search -- "John Smith" --individual FCA individuals
//   npm run search -- "Julius Baer" --sfc       Hong Kong SFC firms (CE number)
//   npm run search -- "Julius Baer" --mas       Singapore MAS Financial Institutions Directory (FID id)
import 'dotenv/config';
import { createFcaClient } from '../sources/fcaClient.js';
import { createSfcSource } from '../sources/sfc.js';
import { createMasSource } from '../sources/mas.js';

const args = process.argv.slice(2);
const individual = args.includes('--individual');
const query = args.filter((a) => !a.startsWith('--')).join(' ');
if (!query) {
  console.error('Usage: npm run search -- "firm name" [--individual] [--sfc | --mas]');
  process.exit(1);
}

let rows;
if (args.includes('--mas')) {
  rows = (await createMasSource(process.env).search(query)).map((d) => ({ ref: d.id, name: d.name, licences: d.licences }));
} else if (args.includes('--sfc')) {
  const items = await createSfcSource(process.env).search(query, individual ? 'individual' : 'corporation');
  rows = items.map((d) => ({
    ref: d.ceref,
    name: d.name,
    type: d.isRi ? 'Registered Institution' : d.isCorp || !d.isIndi ? 'Licensed Corporation' : 'Individual',
    active: d.hasActiveLicence,
  }));
} else {
  const client = createFcaClient({ email: process.env.FCA_API_EMAIL, apiKey: process.env.FCA_API_KEY });
  const body = await client.search(query, individual ? 'individual' : 'firm');
  rows = (body?.Data || []).map((d) => ({
    ref: d['Reference Number'],
    name: d['Name'],
    status: d['Status'],
    type: d['Type of business or Individual'],
  }));
}
if (!rows.length) console.log('No results');
else console.table(rows);
