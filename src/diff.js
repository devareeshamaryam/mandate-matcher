import { isActiveStatus } from './util.js';

/**
 * Compares the previous employee snapshot with the current one.
 *   added:   person newly listed at the firm
 *   revoked: person dropped off the firm's list, or their status turned inactive
 *   changed: still active, but status / role category changed
 */
export function diffEmployees(previousById = {}, current = []) {
  const currentById = Object.fromEntries(current.map((e) => [e.personId, e]));
  const added = [];
  const revoked = [];
  const changed = [];

  for (const emp of current) {
    const prev = previousById[emp.personId];
    const activeNow = isActiveStatus(emp.status);
    if (!prev || !isActiveStatus(prev.status)) {
      if (activeNow) added.push(emp);
      continue;
    }
    if (!activeNow) {
      revoked.push({ ...emp, reason: `Status changed to "${emp.status}"` });
    } else if (prev.status !== emp.status || prev.roleCategory !== emp.roleCategory) {
      changed.push({ ...emp, from: prev.status, to: emp.status });
    }
  }

  for (const [id, prev] of Object.entries(previousById)) {
    if (!currentById[id] && isActiveStatus(prev.status)) {
      revoked.push({ ...prev, reason: 'No longer listed at firm' });
    }
  }

  return { added, revoked, changed };
}
