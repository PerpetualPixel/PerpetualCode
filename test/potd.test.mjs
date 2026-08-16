import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POTD_HOUR,
  runPotdDaily,
  runPotdClvSnapshot,
  runPotdGrading,
  getPotd,
  getPotdHistory,
} from '../worker/src/potd.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';

// The tennis form gate (docs/qualitative.js) reads the static archive; unit
// tests must never hit the network, and a null archive is the honest
// degraded mode (favorites pass unscored, unsupported dogs are blocked).
seedTennisArchiveCacheForTests({ atp: null, wta: null });
import { seedTeamContextCacheForTests } from '../worker/src/team-form.js';
// Same reasoning for team sports: seeding SEALS the memo, so no fixture in
// these slates reaches cdn.espn.com. An empty seed is the honest degraded
// mode — no context, so no form re-score and no underdog gate, exactly what
// an unreachable ESPN produces in production.
seedTeamContextCacheForTests({});

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
        async delete(key) { store.delete(key); },
      },
    },
  };
}

const ctx = { waitUntil: (p) => p };
const NOW = Date.parse('2026-08-05T07:00:00Z'); // 3am ET Aug 5 (EDT) — after POTD_HOUR

/**
 * A single-market h2h event, deep enough to clear RULES.MIN_SCORE.
 *
 * Today-fixture commence times sit ~2h after NOW — INSIDE each sport's
 * per-game lock lead window (tracking.js's PICK_LEAD_HOURS: 3h MLB, 2.5h
 * default) — because runPotdDaily only finalizes once every eligible game's
 * own window has opened (scheduleStillOpen). These tests predate that
 * per-game timing; the original 4pm-ET fixtures now (correctly) leave the
 * whole day "still comparing" at the tests' 3am-ET NOW.
 */
function makeEvent(id, commenceIso, { sport = 'basketball_nba', sportTitle = 'NBA', outlier = 35, favoritePrice = -140, lastUpdate = NOW - 600000 } = {}) {
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
      last_update: new Date(lastUpdate).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(lastUpdate).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: favoritePrice + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: 120 },
        ],
      }],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* runPotdDaily — odds band                                          */
/* ---------------------------------------------------------------- */

test('POTD_HOUR is 2am ET', () => {
  assert.equal(POTD_HOUR, 2);
});

test('picks the best in-band candidate even when an out-of-band one scores higher', async () => {
  const { env } = makeKvStore();
  const events = [
    // A huge apparent edge, but the price itself (+560) is way outside the
    // -200..+150 band this module enforces.
    makeEvent('longshot', '2026-08-05T09:00:00Z', { outlier: 700, favoritePrice: -140 }),
    // Well within band, real edge.
    makeEvent('sane', '2026-08-05T09:30:00Z', { outlier: 20, favoritePrice: -140 }),
  ];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.match(result.pick.pickId, /^sane:/);
  assert.ok(result.pick.american >= -200 && result.pick.american <= 150);
});

test('a day with nothing in the -200..+150 band posts nothing', async () => {
  const { env, store } = makeKvStore();
  // Both sides of this game are far outside the band (heavy favorite / big dog).
  const events = [makeEvent('lopsided', '2026-08-05T09:00:00Z', { outlier: 10, favoritePrice: -400 })];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
  // The band filter empties the pool, so the day ends with nothing
  // actionable — the specific 'in odds band' reason string predates the
  // pool-based selection flow.
  assert.equal(result.reason, 'no qualifying candidate remained actionable today');
  assert.equal(store.size, 0);
});

test('a candidate whose segment the weekly algorithm health review has paused is skipped, even if it scores best', async () => {
  const { env } = makeKvStore();
  await env.POTD_KV.put('algo:paused', JSON.stringify([{ key: 'basketball_nba|h2h', pausedAt: NOW, reason: 'test' }]));

  const events = [
    // Would otherwise win outright on score/edge, but its sport+market is paused.
    makeEvent('paused-sport', '2026-08-05T09:00:00Z', { outlier: 60, favoritePrice: -140, sport: 'basketball_nba', sportTitle: 'NBA' }),
    makeEvent('active-sport', '2026-08-05T09:30:00Z', { outlier: 20, favoritePrice: -140, sport: 'baseball_mlb', sportTitle: 'MLB' }),
  ];

  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.match(result.pick.pickId, /^active-sport:/);
});

test('a candidate below the confidence floor is never selected', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('weak', '2026-08-05T09:00:00Z', { outlier: 0 })];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
});

test('an exhibition-format game is never selected even if it scores well', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('allstar', '2026-08-05T09:00:00Z', { sport: 'basketball_nba' })];
  events[0].home_team = 'Team LeBron';
  events[0].away_team = 'Team Giannis';
  events[0].bookmakers.forEach((b) => b.markets[0].outcomes.forEach((o) => {
    o.name = o.name.includes('Home') ? 'Team LeBron' : 'Team Giannis';
  }));
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
});

/* ---------------------------------------------------------------- */
/* runPotdDaily — eligibility window                                 */
/* ---------------------------------------------------------------- */

test('excludes games on other calendar dates', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('yesterday', '2026-08-04T20:00:00Z'),
    makeEvent('tomorrow', '2026-08-06T20:00:00Z'),
  ];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
});

test('tennis next-day carve-out: a just-past-midnight match is eligible, an ordinary tomorrow match is not', async () => {
  // Positive: 11pm ET Aug 5 with a 1am ET Aug 6 match — a night session
  // rolling past midnight, inside the midnight-2am ET carve-out and its own
  // 2.5h lock window.
  {
    const { env } = makeKvStore();
    const lateNow = Date.parse('2026-08-06T03:00:00Z'); // 11pm ET Aug 5
    const events = [
      makeEvent('tennis-1am', '2026-08-06T05:00:00Z', {
        sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open',
        lastUpdate: lateNow - 600000,
      }),
    ];
    const result = await runPotdDaily(env, ctx, lateNow, { fetchFullSlate: async () => events });
    assert.equal(result.skipped, false, 'a match rolling just past midnight can be today\'s Play of the Day');
  }
  // Negative: an ordinary tomorrow-4pm-ET match must NOT be selectable as
  // TODAY's Play of the Day. POTD previously had NO hour cutoff at all here
  // (it accepted the entire next day) — this is the regression test for
  // that fix; only midnight-2am ET next-day starts count, per explicit
  // product direction.
  {
    const { env } = makeKvStore();
    const events = [
      makeEvent('tomorrow-tennis-pm', '2026-08-06T20:00:00Z', { sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open' }),
    ];
    const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
    assert.equal(result.skipped, true, 'an ordinary tomorrow match must never be today\'s Play of the Day');
  }
});

test('excludes a game that has already started', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('underway', '2026-08-05T06:00:00Z')]; // before NOW (7am UTC)
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
});

test('an empty slate skips cleanly without writing to KV', async () => {
  const { env, store } = makeKvStore();
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [] });
  assert.equal(result.skipped, true);
  assert.equal(store.size, 0);
});

/* ---------------------------------------------------------------- */
/* runPotdDaily — idempotency                                        */
/* ---------------------------------------------------------------- */

test('a date already generated is never regenerated', async () => {
  const { env, store } = makeKvStore();
  const events = [makeEvent('a', '2026-08-05T09:00:00Z')];

  const first = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(first.skipped, false);
  const storedAfterFirst = store.get('potd:2026-08-05');

  const second = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already generated');
  assert.equal(store.get('potd:2026-08-05'), storedAfterFirst);
});

/* ---------------------------------------------------------------- */
/* runPotdDaily — write-up + tracking fields                         */
/* ---------------------------------------------------------------- */

test('the stored record carries a headline, price, and tracking fields', async () => {
  const { env, store } = makeKvStore();
  const events = [makeEvent('a', '2026-08-05T09:00:00Z')];
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });

  const record = JSON.parse(store.get('potd:2026-08-05'));
  assert.equal(record.date, '2026-08-05');
  assert.match(record.writeup.headline, /^a Home to win/);
  // The quantitative price case is no longer a writeup section (it duplicated
  // the dedicated book-price table) — confirm it's gone rather than present.
  assert.equal(record.writeup.sections.find((s) => s.title === 'The Market & Price Case'), undefined);

  assert.equal(record.pick.status, 'pending');
  // 5U play (product direction): FLAT_UNIT_STAKE 20 x 5 — the Play of the
  // Day and the Prop Play are the two flagship 5-unit plays.
  assert.equal(record.pick.suggested_stake, 100);
  assert.equal(record.pick.dateKey, '2026-08-05');
  assert.equal(record.pick.clv.openAmerican, record.pick.american);
  assert.equal(record.pick.result, null);
});

test('the writeup carries american and quotes for the client\'s book price table, and degrades cleanly with no sharp-analysis fields when ANTHROPIC_API_KEY is unset', async () => {
  const { env, store } = makeKvStore();
  const events = [makeEvent('a', '2026-08-05T09:00:00Z')];
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });

  const record = JSON.parse(store.get('potd:2026-08-05'));
  // makeEvent's own bookmakers array (8 books) flows through to quotes.
  assert.equal(record.writeup.american, record.pick.american);
  assert.ok(Array.isArray(record.writeup.quotes));
  assert.equal(record.writeup.quotes.length, 8);

  // No ANTHROPIC_API_KEY in this test's env — getOrGenerateAnalysis returns
  // null immediately, and buildRecord must still post the pick with the
  // sharp-analysis fields simply absent, never throwing or blocking.
  assert.equal(record.writeup.analysis, null);
  assert.equal(record.writeup.reasons, null);
  assert.equal(record.writeup.devilsAdvocate, null);
});

/* ---------------------------------------------------------------- */
/* runPotdClvSnapshot                                                 */
/* ---------------------------------------------------------------- */

test('runPotdClvSnapshot updates closeAmerican when the price has moved', async () => {
  const { env } = makeKvStore();
  const original = makeEvent('a', '2026-08-05T09:00:00Z', { outlier: 20 });
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [original] });

  const before = await getPotd(env, NOW);
  assert.equal(before.pick.clv.closeAmerican, before.pick.clv.openAmerican);

  const moved = makeEvent('a', '2026-08-05T09:00:00Z', { outlier: 40 });
  const r1 = await runPotdClvSnapshot(env, ctx, NOW + 3.6e6, { fetchSportFn: async () => ({ events: [moved] }) });
  assert.equal(r1.updated, true);

  const after = await getPotd(env, NOW);
  assert.notEqual(after.pick.clv.closeAmerican, after.pick.clv.openAmerican);

  // Identical price again, still pregame (game is at NOW+2h) — a no-op.
  const r2 = await runPotdClvSnapshot(env, ctx, NOW + 1.5 * 3.6e6, { fetchSportFn: async () => ({ events: [moved] }) });
  assert.equal(r2.updated, false);
});

test('runPotdClvSnapshot is a no-op once the game has started', async () => {
  const { env } = makeKvStore();
  const original = makeEvent('a', '2026-08-05T09:00:00Z', { outlier: 20 });
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [original] });

  const wayLater = Date.parse('2026-08-06T02:00:00Z'); // after the game's commence time
  const moved = makeEvent('a', '2026-08-05T09:00:00Z', { outlier: 40 });
  const result = await runPotdClvSnapshot(env, ctx, wayLater, { fetchSportFn: async () => ({ events: [moved] }) });
  assert.equal(result.updated, false);
});

/* ---------------------------------------------------------------- */
/* runPotdGrading                                                     */
/* ---------------------------------------------------------------- */

test('runPotdGrading grades a completed pick won/lost via the shared gradePick()', async () => {
  const { env } = makeKvStore();
  const event = makeEvent('a', '2026-08-05T09:00:00Z'); // 2 hours after NOW
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [event] });

  const before = await getPotd(env, NOW);
  const scoreEvent = {
    id: 'a',
    completed: true,
    scores: [
      { name: 'a Home', score: before.pick.outcomeName === 'a Home' ? '5' : '2' },
      { name: 'a Away', score: before.pick.outcomeName === 'a Away' ? '5' : '2' },
    ],
  };

  const result = await runPotdGrading(env, ctx, NOW + 6 * 3.6e6, { fetchScoresFn: async () => ({ events: [scoreEvent] }) });
  assert.equal(result.graded, true);

  const after = await getPotd(env, NOW);
  assert.equal(after.pick.status, 'won');
  assert.ok(after.pick.result.payout > 0);
});

test('runPotdGrading leaves a pick pending when no completed score is available yet', async () => {
  const { env } = makeKvStore();
  const event = makeEvent('a', '2026-08-05T09:00:00Z');
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [event] });

  const result = await runPotdGrading(env, ctx, NOW + 3.6e6, { fetchScoresFn: async () => ({ events: [] }) });
  assert.equal(result.graded, false);

  const potd = await getPotd(env, NOW);
  assert.equal(potd.pick.status, 'pending');
});

/* ---------------------------------------------------------------- */
/* getPotd — read path                                                */
/* ---------------------------------------------------------------- */

test('getPotd returns today\'s record when present', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-05', JSON.stringify({ date: '2026-08-05', pick: { selection: 'Today' } }));
  const potd = await getPotd(env, NOW);
  assert.equal(potd.pick.selection, 'Today');
  assert.equal(potd.stale, undefined);
});

test('getPotd falls back to yesterday, labelled stale, when today has nothing', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-04', JSON.stringify({ date: '2026-08-04', pick: { selection: 'Yesterday' } }));
  const potd = await getPotd(env, NOW);
  assert.equal(potd.pick.selection, 'Yesterday');
  assert.equal(potd.stale, true);
});

test('getPotd returns null when nothing has ever been generated', async () => {
  const { env } = makeKvStore();
  const potd = await getPotd(env, NOW);
  assert.equal(potd, null);
});

/* ---------------------------------------------------------------- */
/* getPotdHistory                                                     */
/* ---------------------------------------------------------------- */

test('getPotdHistory walks multiple days and returns one pick per day generated', async () => {
  const { env } = makeKvStore();
  const day1 = NOW;
  const day2 = NOW + 86400000;

  await runPotdDaily(env, ctx, day1, { fetchFullSlate: async () => [makeEvent('d1', '2026-08-05T09:00:00Z')] });
  // d2: 2h after day2's own "now", quote fresh as of day2 — inside its lock window.
  await runPotdDaily(env, ctx, day2, { fetchFullSlate: async () => [makeEvent('d2', '2026-08-06T09:00:00Z', { lastUpdate: day2 - 600000 })] });

  const history = await getPotdHistory(env, { now: day2, days: 5 });
  assert.equal(history.length, 2);
  assert.ok(history.every((p) => p.dateKey && p.status === 'pending'));
});

test('getPotdHistory skips days with nothing generated', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('d1', '2026-08-05T09:00:00Z')] });

  const history = await getPotdHistory(env, { now: NOW, days: 5 });
  assert.equal(history.length, 1);
});

test('getPotdHistory skips a pre-migration record with no tracking fields', async () => {
  const { env, store } = makeKvStore();
  // Shape the old two-phase/per-sport system wrote: a write-up-only pick
  // with no status/clv/result/dateKey at all.
  store.set('potd:2026-08-04', JSON.stringify({
    date: '2026-08-04',
    pick: { id: 'old:h2h|Foo|', selection: 'Foo to win', american: 500 },
  }));
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('d1', '2026-08-05T09:00:00Z')] });

  const history = await getPotdHistory(env, { now: NOW, days: 5 });
  assert.equal(history.length, 1);
  assert.equal(history[0].dateKey, '2026-08-05');
});
