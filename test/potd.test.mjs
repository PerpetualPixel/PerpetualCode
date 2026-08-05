import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPhase, runPotdPhase, getPotd } from '../worker/src/potd.js';

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

function makeKvStore() {
  const store = new Map();
  return {
    store,
    env: {
      POTD_KV: {
        async get(key) { return store.get(key) ?? null; },
        async put(key, value) { store.set(key, value); },
      },
    },
  };
}

const ctx = { waitUntil: (p) => p };

/** A single-market h2h event, deep enough to clear RULES.MIN_SCORE. */
function makeEvent(id, commenceIso, { sport = 'basketball_nba', sportTitle = 'NBA', outlier = 35 } = {}) {
  const nowRef = Date.parse('2026-08-05T12:00:00Z');
  const books = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
  return {
    id,
    sport_key: sport,
    sport_title: sportTitle,
    commence_time: commenceIso,
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: books.map((key, i) => ({
      key,
      title: key,
      last_update: new Date(nowRef - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(nowRef - 600000).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: -140 + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: 120 },
        ],
      }],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* currentPhase — DST self-correction                                 */
/* ---------------------------------------------------------------- */

test('currentPhase resolves the correct ET hour across both DST offsets', () => {
  // EST (winter, UTC-5): 8am ET = 13:00 UTC, 7pm ET = 00:00 UTC next day.
  assert.equal(currentPhase(Date.parse('2026-01-15T13:00:00Z')), 'morning');
  assert.equal(currentPhase(Date.parse('2026-01-15T00:00:00Z')), 'evening-early');
  assert.equal(currentPhase(Date.parse('2026-01-15T12:00:00Z')), null);

  // EDT (summer, UTC-4): 8am ET = 12:00 UTC, 7pm ET = 23:00 UTC.
  assert.equal(currentPhase(Date.parse('2026-07-15T12:00:00Z')), 'morning');
  assert.equal(currentPhase(Date.parse('2026-07-15T23:00:00Z')), 'evening-early');
  // The winter UTC hour for 8am ET is a no-op in summer — proves this isn't a
  // hardcoded UTC hour that would silently drift wrong for half the year.
  assert.equal(currentPhase(Date.parse('2026-07-15T13:00:00Z')), null);
});

/* ---------------------------------------------------------------- */
/* runPotdPhase — selection                                           */
/* ---------------------------------------------------------------- */

const MORNING_NOW = Date.parse('2026-08-05T12:00:00Z'); // 8am ET Aug 5 (EDT)
const EVENING_NOW = Date.parse('2026-08-05T23:00:00Z'); // 7pm ET Aug 5 (EDT)

test('morning picks the best-graded candidate from today, from the cutoff hour on', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('weak', '2026-08-05T18:00:00Z', { outlier: 10 }),  // 2pm ET today, weaker edge
    makeEvent('strong', '2026-08-05T20:00:00Z', { outlier: 40 }), // 4pm ET today, stronger edge
  ];
  const result = await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });
  assert.equal(result.skipped, false);
  assert.match(result.pick.id, /^strong:/, 'must pick the higher-scoring candidate, not just the first');
});

test('morning excludes an early-today game before the cutoff hour', async () => {
  const { env } = makeKvStore();
  // 6am ET Aug 5 — before MORNING_CUTOFF_HOUR (9), should be excluded from the
  // morning window even though it's the right calendar date.
  const events = [makeEvent('early', '2026-08-05T10:00:00Z')];
  const result = await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });
  assert.equal(result.skipped, true);
});

test('morning excludes games on other calendar dates', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('yesterday', '2026-08-04T20:00:00Z'),
    makeEvent('tomorrow', '2026-08-06T20:00:00Z'),
  ];
  const result = await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });
  assert.equal(result.skipped, true);
});

test('evening-early targets only tomorrow\'s early games, not tomorrow\'s normal ones', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('tomorrow-early', '2026-08-06T10:00:00Z'), // 6am ET Aug 6 — eligible
    makeEvent('tomorrow-normal', '2026-08-06T20:00:00Z'), // 4pm ET Aug 6 — not eligible here
  ];
  const result = await runPotdPhase('evening-early', { env, ctx, now: EVENING_NOW, fetchBoard: async () => events });
  assert.equal(result.skipped, false);
  assert.match(result.pick.id, /^tomorrow-early:/);
  assert.equal(result.dateKey, '2026-08-06');
});

test('a candidate below the confidence floor is never selected', async () => {
  const { env } = makeKvStore();
  // outlier: 0 — a thin, un-sharp market that shouldn't clear RULES.MIN_SCORE.
  const events = [makeEvent('weak', '2026-08-05T18:00:00Z', { outlier: 0 })];
  const result = await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });
  assert.equal(result.skipped, true);
});

test('an empty board skips cleanly without writing to KV', async () => {
  const { env, store } = makeKvStore();
  const result = await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => [] });
  assert.equal(result.skipped, true);
  assert.equal(store.size, 0);
});

/* ---------------------------------------------------------------- */
/* runPotdPhase — idempotency                                         */
/* ---------------------------------------------------------------- */

test('a date already generated is never regenerated or re-fetched', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('a', '2026-08-05T18:00:00Z')];

  const first = await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });
  assert.equal(first.skipped, false);

  const second = await runPotdPhase('morning', {
    env, ctx, now: MORNING_NOW,
    fetchBoard: async () => { throw new Error('must not fetch — the date is already generated'); },
  });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already generated');
});

test('an evening-early pick for tomorrow blocks the next morning run from overwriting it', async () => {
  const { env } = makeKvStore();
  const earlyEvents = [makeEvent('early-bird', '2026-08-06T10:00:00Z')];
  const evening = await runPotdPhase('evening-early', {
    env, ctx, now: EVENING_NOW, fetchBoard: async () => earlyEvents,
  });
  assert.equal(evening.skipped, false);
  assert.equal(evening.dateKey, '2026-08-06');

  // The next morning (Aug 6, 8am ET) must not overwrite what last night wrote.
  const nextMorningNow = Date.parse('2026-08-06T12:00:00Z');
  const morning = await runPotdPhase('morning', {
    env, ctx, now: nextMorningNow,
    fetchBoard: async () => { throw new Error('must not fetch — evening-early already claimed this date'); },
  });
  assert.equal(morning.skipped, true);
  assert.equal(morning.reason, 'already generated');
});

/* ---------------------------------------------------------------- */
/* runPotdPhase — write-up shape                                      */
/* ---------------------------------------------------------------- */

test('the stored record carries a headline, price, and at least the price-case section', async () => {
  const { env, store } = makeKvStore();
  const events = [makeEvent('a', '2026-08-05T18:00:00Z')];
  await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });

  const record = JSON.parse(store.get('potd:2026-08-05'));
  assert.equal(record.date, '2026-08-05');
  assert.equal(record.phase, 'morning');
  assert.match(record.writeup.headline, /^a Home to win/);
  const priceCase = record.writeup.sections.find((s) => s.title === 'The Market & Price Case');
  assert.ok(priceCase);
  // The Market & Price Case is the extensive version (explainExtensive) —
  // several distinct sentences, not the compact card's single bullet.
  assert.ok(priceCase.bullets.length >= 3, `expected several price bullets, got ${priceCase.bullets.length}`);
  assert.ok(typeof record.writeup.stake === 'number' && record.writeup.stake >= 0);
});

test('sections only appear for tiers that actually have content', async () => {
  const { env, store } = makeKvStore();
  const events = [makeEvent('a', '2026-08-05T18:00:00Z')];
  await runPotdPhase('morning', { env, ctx, now: MORNING_NOW, fetchBoard: async () => events });

  const record = JSON.parse(store.get('potd:2026-08-05'));
  // No worker-side research source is wired into this fixture (no real ESPN
  // fetch happens for a mocked NBA event), so only the price case should
  // appear — never an empty "Primary Personnel" or "Supporting Cast" heading
  // with nothing under it.
  const titles = record.writeup.sections.map((s) => s.title);
  assert.deepEqual(titles, ['The Market & Price Case']);
});

/* ---------------------------------------------------------------- */
/* getPotd — read path                                                */
/* ---------------------------------------------------------------- */

test('getPotd returns today\'s record when present', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-05', JSON.stringify({ date: '2026-08-05', pick: { selection: 'Today' } }));
  const potd = await getPotd(env, MORNING_NOW);
  assert.equal(potd.pick.selection, 'Today');
  assert.equal(potd.stale, undefined);
});

test('getPotd falls back to yesterday, labelled stale, when today has nothing', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-04', JSON.stringify({ date: '2026-08-04', pick: { selection: 'Yesterday' } }));
  const potd = await getPotd(env, MORNING_NOW);
  assert.equal(potd.pick.selection, 'Yesterday');
  assert.equal(potd.stale, true);
});

test('getPotd returns null when nothing has ever been generated', async () => {
  const { env } = makeKvStore();
  const potd = await getPotd(env, MORNING_NOW);
  assert.equal(potd, null);
});
