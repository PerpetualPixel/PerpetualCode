/**
 * Shared loader for the flattened tennis history datasets the site ships as
 * static assets (docs/data/tennis-{atp,wta}.json, built by
 * scripts/build-tennis-data.mjs from tennis-data.co.uk).
 *
 * The same fetch-and-cache pattern lived copy-pasted in potd.js and
 * analysis.js; this is the one canonical copy, added when the pick batches
 * themselves (tracking.js / full-slate-tracking.js / potd.js) started
 * needing the archive for the tennis form gate (docs/qualitative.js's
 * applyTennisFormSignal), not just the insight write-ups.
 *
 * Module-scope cache: survives across requests in the same isolate. A fetch
 * failure caches null for the isolate's lifetime — the archive is an
 * enrichment, never a dependency, and hammering a failing origin from a
 * cron that runs every tick would be worse than degrading.
 */

import { isTennis } from '../../docs/insights.js';

const TENNIS_ARCHIVE_BASE = 'https://perpetualpicks.com/data'; // canonical URL directly — the miguelsgarcia4.github.io host 301-redirects here anyway (GitHub Pages' own custom-domain redirect), an extra hop worth skipping

let tennisArchiveCache = null;

/**
 * Test hook: pre-seed the module cache (e.g. { atp: null, wta: null }) so
 * unit tests exercising the pick batches never reach for the network. A
 * seeded null is the honest degraded mode — favorites pass the form gate
 * unscored, unsupported dogs are blocked — exactly what a live fetch
 * failure produces.
 */
export function seedTennisArchiveCacheForTests(cache) {
  tennisArchiveCache = cache;
}

export async function loadTennisArchive(sportKey) {
  const tour = /wta/i.test(sportKey) ? 'wta' : 'atp';
  tennisArchiveCache ??= {};
  if (tour in tennisArchiveCache) return tennisArchiveCache[tour];
  try {
    const r = await fetch(`${TENNIS_ARCHIVE_BASE}/tennis-${tour}.json`);
    if (!r.ok) console.error(`Tennis archive fetch (${tour}) returned ${r.status}`);
    tennisArchiveCache[tour] = r.ok ? await r.json() : null;
  } catch (e) {
    console.error(`Tennis archive fetch (${tour}) failed:`, e);
    tennisArchiveCache[tour] = null;
  }
  return tennisArchiveCache[tour];
}

/**
 * The { atp?, wta? } archive bundle applyTennisFormSignal() takes, fetching
 * only the tours actually present in the candidate list — a slate with no
 * tennis on it costs zero fetches.
 */
export async function loadTennisArchivesFor(candidates) {
  const tours = new Set(
    (candidates ?? [])
      .filter((c) => isTennis(c.sportKey))
      .map((c) => (/wta/i.test(c.sportKey) ? 'wta' : 'atp')),
  );
  const archives = {};
  await Promise.all(
    [...tours].map(async (tour) => {
      archives[tour] = await loadTennisArchive(tour === 'wta' ? 'tennis_wta' : 'tennis_atp');
    }),
  );
  return archives;
}
