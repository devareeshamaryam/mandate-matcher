import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = path.resolve('data/state.json');

/** Local snapshot used to diff runs: { "<source>:<firmId>": { firm, employees: { personId: emp }, updatedAt } } */
export async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}
