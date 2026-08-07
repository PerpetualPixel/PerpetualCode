import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runTop5Batch,
  runClvSnapshot,
  runGrading,
  getTop5,
  getAllTrackedPicks,
  resetAllTracking,
  TOP5_COUNT,
} from '../worker/src/tracking.js';

/* ---------------------------------------------------------------- */
/* Fixtures — same shape as test/potd.test.mjs's, kept independent   */
/* since each test file owns its own fixture rather than sharing one */
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
const NOW = Date.parse('2026-08-05T12:00:00Z'); // 8am ET Aug 5 (EDT)

const BOOKS = ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'BetRivers', 'ESPN BET', 'Fanatics', 'Hard Rock Bet'];
const BOOK_KEYS = {
  DraftKings: 'draftkings', FanDuel: 'fanduel', BetMGM: 'betmgm', Caesars: 'williamhill_us',
  BetRivers: 'betrivers', 'ESPN BET': 'espnbet', Fanatics: 'fanatics', 'Hard Rock Bet': 'hardrockbet',
};

/** A single-market h2h event, deep enough to clear RULES.MIN_SCORE and (with outlier>=35) the EV/Kelly floor. */
function makeEvent(id, { hoursOut = 6, outlier = 35, sport = 'baseball_mlb', sportTitle = 'MLB' } = {}) {
  return {
    id,
    sport_key: sport,
    sport_title: sportTitle,
    commence_time: new Date(NOW + hoursOut * 3.6e6).toISOString(),
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: -140 + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: 120 },
        ],
      }],
    })),
  };
}

/**
 * A real, genuinely positive-EV underdog priced well outside the sharp
 * standard's -250/+250 band (a real away-side price around +320, one
 * outlier book a little better) — clears clearsEdgeBar (real EV/Kelly) but
 * fails the main pool's odds-range filter, so it can only ever surface as a
 * guaranteeCount() fallback pick, never a "real" one. Used to exercise the
 * meetsStandard: false / flagReason path without relying on a knife-edge
 * score/EV combination (score and EV are too correlated in this scoring
 * model to reliably land "clears EV but not score" from a single dial).
 */
function makeOutOfRangeEvent(id, { hoursOut = 6 } = {}) {
  return {
    id,
    sport_key: 'baseball_mlb',
    sport_title: 'MLB',
    commence_time: new Date(NOW + hoursOut * 3.6e6).toISOString(),
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: -400 },
          { name: `${id} Away`, price: i === 0 ? 350 : 260 },
        ],
      }],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* runTop5Batch                                                      */
/* ---------------------------------------------------------------- */

test('runTop5Batch stores at most TOP5_COUNT picks, all clearing the EV/Kelly floor', async () => {
  const { env } = makeKvStore();
  const events = Array.from({ length: 8 }, (_, i) => makeEvent(`g${i}`, { outlier: 35 }));

  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.ok(result.count <= TOP5_COUNT, `expected at most ${TOP5_COUNT}, got ${result.count}`);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, result.count);
  for (const p of picks) {
    assert.equal(p.status, 'pending');
    assert.equal(p.suggested_stake, 20);
    // Real edges clearing the sharp standard outright, not padding.
    assert.equal(p.meetsStandard, true);
    assert.equal(p.flagReason, null);
  }
});

test('runTop5Batch pads to 5 with flagged picks on a thin day, real picks stay unflagged', async () => {
  const { env } = makeKvStore();
  // Two real sharp edges (inside the -250/+250 band) plus one real-EV
  // underdog priced outside that band — clears the EV/Kelly floor but not
  // the odds range, so it can only ever fill a guaranteeCount() slot.
  const events = [
    makeEvent('sharp1', { outlier: 35 }),
    makeEvent('sharp2', { outlier: 40 }),
    makeOutOfRangeEvent('longshot'),
  ];

  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const flagged = picks.filter((p) => p.meetsStandard === false);
  const clean = picks.filter((p) => p.meetsStandard === true);
  assert.equal(flagged.length, 1, 'the out-of-range pick should be the one padded/flagged slot');
  assert.match(flagged[0].pickId, /^longshot:/);
  assert.ok(typeof flagged[0].flagReason === 'string' && flagged[0].flagReason.length > 0);
  assert.equal(clean.length, 2);
  for (const p of clean) {
    assert.equal(p.flagReason, null);
  }
});

test('runTop5Batch never surfaces a -EV or dust-edge candidate, even to fill toward 5', async () => {
  const { env } = makeKvStore();
  // Same "thin consensus, small outlier" pattern as the engine.test.mjs
  // regression test — clears MIN_SCORE on liquidity/agreement alone, but is
  // -EV once the vig is paid.
  const events = [makeEvent('juicy', { outlier: 10 })];

  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 0, 'a -EV-only slate must produce zero tracked picks, not a padded 5');
});

test('runTop5Batch only runs once per ET day', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('a', { outlier: 35 })];

  const first = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(first.skipped, false);

  const second = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(second.skipped, true);
});

/* ---------------------------------------------------------------- */
/* runClvSnapshot                                                     */
/* ---------------------------------------------------------------- */

test('runClvSnapshot updates closeAmerican when the price has moved, leaves it when it hasn\'t', async () => {
  const { env } = makeKvStore();
  const original = makeEvent('a', { outlier: 35, hoursOut: 6 });
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => [original] });

  const [before] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(before.clv.closeAmerican, before.clv.openAmerican);

  // The exact same event, but the outlier book's price has moved further.
  const moved = makeEvent('a', { outlier: 60, hoursOut: 6 });
  const r1 = await runClvSnapshot(env, ctx, NOW + 3.6e6, { fetchSportFn: async () => ({ events: [moved] }) });
  assert.equal(r1.updated, 1);

  const [after] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.notEqual(after.clv.closeAmerican, after.clv.openAmerican);

  // A second snapshot against the identical price is a no-op.
  const r2 = await runClvSnapshot(env, ctx, NOW + 2 * 3.6e6, { fetchSportFn: async () => ({ events: [moved] }) });
  assert.equal(r2.updated, 0);
});

/* ---------------------------------------------------------------- */
/* runGrading                                                         */
/* ---------------------------------------------------------------- */

test('runGrading grades a completed h2h pick won/lost via the shared gradePick()', async () => {
  const { env } = makeKvStore();
  // buildCandidates() only tracks future games (commenceMs > now), so the
  // pick has to be generated against a game that hasn't started yet —
  // grading itself doesn't care about commence time, only pending status,
  // so a "now" a few hours later (after the game would be over) is enough.
  const event = makeEvent('a', { outlier: 35, hoursOut: 2 });
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => [event] });

  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  // The tracked pick is whichever side scored highest — grade it as the winner either way.
  const scoreEvent = {
    id: 'a',
    completed: true,
    scores: [
      { name: 'a Home', score: pick.outcomeName === 'a Home' ? '5' : '2' },
      { name: 'a Away', score: pick.outcomeName === 'a Away' ? '5' : '2' },
    ],
  };

  const result = await runGrading(env, ctx, NOW + 6 * 3.6e6, { fetchScoresFn: async () => ({ events: [scoreEvent] }) });
  assert.equal(result.graded, 1);

  const [graded] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(graded.status, 'won');
  assert.ok(graded.result.payout > 0);
});

test('runGrading leaves a pick pending when no completed score is available yet', async () => {
  const { env } = makeKvStore();
  const event = makeEvent('a', { outlier: 35, hoursOut: 2 });
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => [event] });

  const result = await runGrading(env, ctx, NOW + 3.6e6, { fetchScoresFn: async () => ({ events: [] }) });
  assert.equal(result.graded, 0);

  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(pick.status, 'pending');
});

/* ---------------------------------------------------------------- */
/* getAllTrackedPicks / resetAllTracking                              */
/* ---------------------------------------------------------------- */

test('getAllTrackedPicks spans multiple days, resetAllTracking clears every one', async () => {
  const { env } = makeKvStore();
  const day1 = NOW;
  const day2 = NOW + 86400000;

  await runTop5Batch(env, ctx, day1, { fetchFullSlate: async () => [makeEvent('d1', { outlier: 35 })] });
  await runTop5Batch(env, ctx, day2, { fetchFullSlate: async () => [makeEvent('d2', { outlier: 35, hoursOut: 30 })] });

  const all = await getAllTrackedPicks(env, { now: day2, days: 5 });
  assert.equal(all.length, 2);

  const { deleted } = await resetAllTracking(env, { now: day2, days: 5 });
  assert.equal(deleted, 2);

  const afterReset = await getAllTrackedPicks(env, { now: day2, days: 5 });
  assert.equal(afterReset.length, 0);
});
