import { createFcaSource } from './fca.js';
import { createHtmlSource } from './html.js';
import { createSfcSource } from './sfc.js';
import { createFsraSource } from './fsra.js';
import { createDfsaSource } from './dfsa.js';

// Register new sources (APIs or scrapers) here.
const factories = {
  fca: createFcaSource,
  sfc: createSfcSource,
  fsra: createFsraSource,
  dfsa: createDfsaSource,
  html: createHtmlSource,
};

export function createSources(env) {
  const cache = {};
  function getSource(name) {
    if (!factories[name]) throw new Error(`Unknown source "${name}". Known: ${Object.keys(factories).join(', ')}`);
    cache[name] ??= factories[name](env);
    return cache[name];
  }
  // Releases anything a source holds open (e.g. the DFSA browser window).
  getSource.closeAll = async () => {
    await Promise.all(Object.values(cache).map((s) => s.close?.().catch(() => {})));
  };
  return getSource;
}
