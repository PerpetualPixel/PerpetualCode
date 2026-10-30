/**
 * The UFC side's data, from a runner ESPN answers (the worker is refused;
 * see worker/src/espn-bundle.js): every UFC card ESPN lists over the next
 * two months with its bouts in order, each fighter's profile and fight
 * history, finished bouts' results, and an index of every fighter seen on
 * a UFC card in the last year for the Fighters search. Written to the
 * worker's KV; worker/src/ufc-card.js reads it.
 *
 *   node scripts/ufc-card.mjs                # the next cards, their fighters, results
 *   node scripts/ufc-card.mjs --dry-run      # fetch and report, write nothing
 *   node scripts/ufc-card.mjs --dump         # print ESPN's raw shapes for one event and one athlete
 *   node scripts/ufc-card.mjs --index        # also rebuild the year-long fighter index (weekly)
 */
import { readKv, writeKv } from './lib/kv.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DUMP = args.includes('--dump');
const INDEX = args.includes('--index');
const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc';
const ATHLETE = 'https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/athletes';
const CONCURRENCY = 6;
const say = (...a) => console.log(...a);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) { say(`  ! ${url}: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return null;
}
async function pool(items, worker, size = CONCURRENCY) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); } }));
  return out;
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

const now = Date.now();
const board = await getJson(`${SITE}/scoreboard?dates=${ymd(now - 2 * 864e5)}-${ymd(now + 60 * 864e5)}`);
const events = board?.events ?? [];
say(`${events.length} UFC events on ESPN's board for the next two months`);
for (const e of events) say(`  ${e.date}  ${e.name}  (${e.id}) ${e.competitions?.length ?? 0} bouts, status ${e.status?.type?.name ?? '?'}`);

if (DUMP) {
  const e = events[0];
  const trim = (o) => JSON.stringify(o, (k, v) => (k === 'links' || k === 'logos' ? undefined : v)).slice(0, 6000);
  say('\n=== event keys', Object.keys(e ?? {}));
  say('=== event (trimmed)', trim({ ...e, competitions: undefined }));
  say('=== competition[0]', trim(e?.competitions?.[0]));
  say('=== competition[last]', trim(e?.competitions?.at(-1)));
  const id = e?.competitions?.[0]?.competitors?.[0]?.athlete?.id;
  const a = id ? await getJson(`${ATHLETE}/${id}?enable=history`) : null;
  say('=== athlete keys', Object.keys(a ?? {}), Object.keys(a?.athlete ?? {}));
  say('=== athlete (trimmed)', trim({ ...a, eventsMap: undefined, athlete: { ...a?.athlete, links: undefined } }));
  const first = Object.values(a?.eventsMap ?? {})[0];
  say('=== eventsMap[0]', trim(first));
  const yearBoard = await getJson(`${SITE}/scoreboard?dates=${ymd(now - 365 * 864e5)}-${ymd(now - 300 * 864e5)}`);
  say('=== a year back: events', yearBoard?.events?.length, 'first', yearBoard?.events?.[0]?.name);
  process.exit(0);
}
say('(parsing not written yet; run with --dump first)');
