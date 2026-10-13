export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Statuses that mean a person is no longer active at the firm.
const INACTIVE_STATUS = /no longer|revoked|withdrawn|inactive|lapsed|removed|cancelled|ceased|prohibit/i;

export function isActiveStatus(status) {
  return !INACTIVE_STATUS.test(status || '');
}
