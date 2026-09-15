import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichMmaEvents,
  fetchSport,
  regionsFor,
  REGIONS,
  TENNIS_REGIONS,
  DEFAULT_SHARP_BOOKMAKERS,
  sharpBookmakersFor,
  mergeSharpQuotes,
} from '../worker/src/odds.js';

/**
 * Regression coverage for a real production bug: enrichMmaEvents used to call
 * getUfcEventDetails once per fight, and each call independently re-fetched
 * both ESPN scoreboards (no request coalescing across the concurrent
 * Promise.all). On a full ~65-fight MMA slate that fanned out to ~130
 * subrequests in one Worker invocation, blowing through Cloudflare's
 * per-invocation subrequest limit — every fight silently fell back to
 * "Card - MM/DD" grouping instead of its real event name. The fix hoists the
 * schedule fetch above the per-fight loop so it happens once per request
 * no matter how many fights are on the slate.
 */

const ctx = { waitUntil: (p) => p };

function makeEspnEvent(name, fights) {
  return {
    name,
    competitions: fights.map(([a, b]) => ({
      competitors: [{ athlete: { displayName: a } }, { athlete: { displayName: b } }],
    })),
  };
}

function makeOddsEvent(id, homeTeam, awayTeam, commenceIso) {
  return { id, home_team: homeTeam, away_team: awayTeam, commence_time: commenceIso };
}

test('enrichMmaEvents fetches the ESPN schedule once, not once per fight', async () => {
  let fetchCalls = 0;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      text: async () => JSON.stringify({
        events: [makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']])],
      }),
    };
  };

  // A 20-fight slate — big enough that the old per-fight fetch pattern would
  // have made 40 outbound calls (20 fights x 2 promotions).
  const slate = (n) => Array.from({ length: n }, (_, i) =>
    makeOddsEvent(`fight-${i}`, 'Mateusz Gamrot', 'Quillan Salkilld', '2026-08-08T00:00:00Z'),
  );

  await enrichMmaEvents(slate(20), ctx);
  const twenty = fetchCalls;
  fetchCalls = 0;
  await enrichMmaEvents(slate(2), ctx);
  const two = fetchCalls;

  // The cost is fixed per slate, not per fight: two league-directory reads
  // (see discoverMmaLeagues) plus one scoreboard per discovered promotion —
  // here just the seeded UFC + PFL, since this stub answers every URL with a
  // scoreboard body that carries no league list.
  assert.equal(twenty, 4, `expected 4 total fetches (2 directories + 2 promotions), got ${twenty}`);
  assert.equal(two, twenty, 'fetch count must not scale with slate size');
});

test('enrichMmaEvents still tags every fight with the real event name from the shared schedule', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const isPfl = String(url).includes('/mma/pfl/');
    const events = isPfl
      ? [makeEspnEvent('PFL Charlotte: Battle vs. Rosta', [['Trey Waters', 'Trukon Carson']])]
      : [makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']])];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };

  const events = [
    makeOddsEvent('a', 'Mateusz Gamrot', 'Quillan Salkilld', '2026-08-08T00:00:00Z'),
    makeOddsEvent('b', 'Trey Waters', 'Trukon Carson', '2026-08-07T23:00:00Z'),
  ];

  const enriched = await enrichMmaEvents(events, ctx);
  assert.equal(enriched.find((e) => e.id === 'a').ufc_event.event, 'UFC Fight Night: Gamrot vs Salkilld');
  assert.equal(enriched.find((e) => e.id === 'b').ufc_event.event, 'PFL Charlotte: Battle vs. Rosta');
});

test('enrichMmaEvents falls back to date grouping for every fight when both scoreboards fail, without retrying per fight', async () => {
  let fetchCalls = 0;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: false, status: 500 };
  };

  const events = Array.from({ length: 10 }, (_, i) =>
    makeOddsEvent(`fight-${i}`, 'Someone', 'Else', '2026-08-09T20:00:00Z'),
  );

  const enriched = await enrichMmaEvents(events, ctx);
  assert.ok(enriched.every((e) => e.ufc_event.event === 'Card - 08/09'));
  // Everything failing (both league directories, then both seeded
  // promotions' scoreboards) is still one attempt each for the whole slate —
  // no per-fight retry storm.
  assert.equal(fetchCalls, 4, `a total failure should still only attempt 4 fetches, got ${fetchCalls}`);
});

/* --- tennis region expansion --------------------------------------------- */

/**
 * Lower-tier tennis is priced mostly by international books until close to
 * start, so those matches came back with too few US books to clear
 * RULES.MIN_BOOKS and rendered as all-dash rows. regionsFor widens the book
 * set for tennis keys only — team sports stay on `us` so the per-region API
 * cost isn't paid across the whole slate.
 */
test('regionsFor widens tennis keys and leaves team sports on us', () => {
  assert.equal(regionsFor('tennis_wta_cincinnati'), TENNIS_REGIONS);
  assert.equal(regionsFor('tennis_atp_canadian_open'), TENNIS_REGIONS);
  // us AND uk/eu: the US books carry the prices a reader can bet (without
  // them every tennis pick's best price was at 1xBet or Pinnacle), the
  // uk/eu books carry the sharp anchor and the depth for lower-tier draws.
  assert.equal(TENNIS_REGIONS, 'us,uk,eu');

  for (const key of ['baseball_mlb', 'americanfootball_nfl', 'mma_mixed_martial_arts', 'soccer_usa_mls']) {
    assert.equal(regionsFor(key), REGIONS);
  }
});

test('fetchSport requests the widened regions for a tennis key', async () => {
  const requested = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      async json() { return []; },
      headers: { get: () => null },
    };
  };

  await fetchSport('tennis_wta_cincinnati', { ODDS_API_KEY: 'k' }, ctx);
  assert.equal(requested.length, 1, 'tennis makes no second sharp-quote call — its regions already carry Pinnacle');
  const url = new URL(requested[0]);
  assert.equal(url.searchParams.get('regions'), 'us,uk,eu');
});

test('fetchSport keeps team sports on the us region', async () => {
  const requested = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return { ok: true, async json() { return []; }, headers: { get: () => null } };
  };

  await fetchSport('baseball_mlb', { ODDS_API_KEY: 'k' }, ctx);
  assert.equal(new URL(requested[0]).searchParams.get('regions'), 'us');
});

test('fetchSport caches tennis under a region-specific key (no us-only collision)', async () => {
  const puts = [];
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(key) { puts.push(String(key.url ?? key)); },
    },
  };
  globalThis.fetch = async () => ({ ok: true, async json() { return []; }, headers: { get: () => null } });

  await fetchSport('tennis_wta_cincinnati', { ODDS_API_KEY: 'k' }, ctx);
  assert.ok(puts.length >= 1);
  assert.ok(puts[0].includes('regions=us,uk,eu'), `cache key should carry the tennis regions, got ${puts[0]}`);
});

/* ---------------------------------------------------------------- */
/* Sharp anchor quotes                                               */
/* ---------------------------------------------------------------- */

test('sharpBookmakersFor asks for Pinnacle on US-region sports, never on tennis, and can be switched off', () => {
  assert.equal(DEFAULT_SHARP_BOOKMAKERS, 'pinnacle');
  assert.equal(sharpBookmakersFor({}, 'baseball_mlb'), 'pinnacle');
  assert.equal(sharpBookmakersFor({}, 'americanfootball_nfl'), 'pinnacle');
  // Tennis already pulls uk/eu, where Pinnacle lives — a second call would
  // pay again for quotes the first already returned.
  assert.equal(sharpBookmakersFor({}, 'tennis_wta_cincinnati'), null);
  assert.equal(sharpBookmakersFor({ SHARP_BOOKMAKERS: '' }, 'baseball_mlb'), null);
  assert.equal(sharpBookmakersFor({ SHARP_BOOKMAKERS: 'pinnacle, betfair_ex_eu' }, 'baseball_mlb'), 'pinnacle,betfair_ex_eu');
});

test('mergeSharpQuotes folds the sharp book onto the matching event and drops events nobody can bet', () => {
  const events = [
    { id: 'a', bookmakers: [{ key: 'draftkings', markets: [] }] },
    { id: 'b', bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h' }] }] },
  ];
  const sharp = [
    { id: 'a', bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h' }] }] },
    { id: 'b', bookmakers: [{ key: 'pinnacle', markets: [{ key: 'spreads' }] }] },
    { id: 'zzz', bookmakers: [{ key: 'pinnacle', markets: [] }] },
  ];
  const out = mergeSharpQuotes(events, sharp);
  assert.equal(out.length, 2, 'an event only the sharp book prices is not added');
  assert.deepEqual(out[0].bookmakers.map((b) => b.key), ['draftkings', 'pinnacle']);
  // Already present (a region carried it): left exactly as it was.
  assert.equal(out[1].bookmakers.length, 1);
  assert.equal(out[1].bookmakers[0].markets[0].key, 'h2h');
  assert.equal(mergeSharpQuotes(events, []), events);
});

test('fetchSport pulls the sharp quotes as a second, separately-cached request and merges them', async () => {
  const requested = [];
  const puts = [];
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(key) { puts.push(String(key.url ?? key)); },
    },
  };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const u = new URL(url);
    const body = u.searchParams.get('bookmakers') === 'pinnacle'
      ? [{ id: 'e1', bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', markets: [] }] }]
      : [{ id: 'e1', bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [] }] }];
    return { ok: true, async json() { return body; }, headers: { get: () => null } };
  };

  const { events } = await fetchSport('baseball_mlb', { ODDS_API_KEY: 'k' }, ctx);
  assert.equal(requested.length, 2);
  const [board, sharp] = requested.map((r) => new URL(r));
  assert.equal(board.searchParams.get('regions'), 'us');
  assert.equal(board.searchParams.has('bookmakers'), false);
  assert.equal(sharp.searchParams.get('bookmakers'), 'pinnacle');
  assert.equal(sharp.searchParams.has('regions'), false, 'bookmakers takes priority over regions upstream — never send both');
  assert.deepEqual(events[0].bookmakers.map((b) => b.key), ['draftkings', 'pinnacle']);
  // The soft board is cached WITHOUT the sharp quotes, under its own key.
  assert.ok(puts.some((p) => p.includes('/odds/baseball_mlb')));
  assert.ok(puts.some((p) => p.includes('/sharp/baseball_mlb')));
});

test('a failed sharp fetch degrades to the soft board alone', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    if (new URL(url).searchParams.has('bookmakers')) throw new Error('upstream down');
    return { ok: true, async json() { return [{ id: 'e1', bookmakers: [{ key: 'fanduel', markets: [] }] }]; }, headers: { get: () => null } };
  };
  const { events } = await fetchSport('baseball_mlb', { ODDS_API_KEY: 'k' }, ctx);
  assert.deepEqual(events[0].bookmakers.map((b) => b.key), ['fanduel']);
});

test('an empty odds board is cached for hours, a live one for CACHE_SECONDS', async () => {
  const { EMPTY_BOARD_CACHE_SECONDS } = await import('../worker/src/odds.js');
  const cacheControls = [];
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(key, res) { cacheControls.push(res.headers.get('Cache-Control')); },
    },
  };
  let body = [];
  globalThis.fetch = async () => ({ ok: true, async json() { return body; }, headers: { get: () => null } });

  // Out-of-season sport: empty answer, held for hours — The Odds API bills
  // the same for an empty board as a full one.
  await fetchSport('icehockey_nhl', { ODDS_API_KEY: 'k' }, ctx);
  assert.equal(cacheControls[0], `max-age=${EMPTY_BOARD_CACHE_SECONDS}`);

  // In-season: normal TTL.
  body = [{ id: 'e1', bookmakers: [] }];
  await fetchSport('baseball_mlb', { ODDS_API_KEY: 'k', CACHE_SECONDS: '1800' }, ctx);
  assert.equal(cacheControls[1], 'max-age=1800');
});
