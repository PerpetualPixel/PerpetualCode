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
import { TUNABLE_BOUNDS } from '../worker/src/algo-health.js';

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

test('runTop5Batch never picks a team-sport game that isn\'t happening today (e.g. NFL season odds posted months out)', async () => {
  const { env } = makeKvStore();
  const events = [
    // A real NFL line, priced months ahead of kickoff — must never surface
    // as "today's lock."
    makeEvent('nfl-far-out', { outlier: 40, hoursOut: 24 * 140, sport: 'americanfootball_nfl', sportTitle: 'NFL' }),
    makeEvent('mlb-today', { outlier: 35, hoursOut: 6 }),
  ];

  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.ok(picks.every((p) => p.sportKey !== 'americanfootball_nfl'), 'the far-out NFL game must never be picked');
  assert.ok(picks.some((p) => p.pickId.startsWith('mlb-today:')), 'the same-day MLB game should still be picked');
});

test('runTop5Batch excludes a team-sport game on tomorrow\'s date too, not just far-future ones', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('tomorrow', { outlier: 40, hoursOut: 30 })]; // ~30h out crosses into the next ET day
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 0, 'nothing today qualifies, so no picks should be stored even though tomorrow has a real edge');
});

test('runTop5Batch includes a tennis match on tomorrow\'s date, unlike a team sport — a round spans two calendar days', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('tomorrow-tennis', { outlier: 40, hoursOut: 30, sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open' })];
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'tomorrow is still the same drawn round for tennis, so it should be eligible');
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

test('runTop5Batch only skips once the board already has TOP5_COUNT picks', async () => {
  const { env } = makeKvStore();
  const events = Array.from({ length: 8 }, (_, i) => makeEvent(`g${i}`, { outlier: 35 }));

  const first = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(first.skipped, false);
  assert.equal(first.count, TOP5_COUNT);

  const second = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already generated today');
});

/**
 * Regression test for a real incident: an earlier version of runTop5Batch
 * locked in whatever it got on the very first call (checking only "does a
 * manifest exist," not "does it have TOP5_COUNT picks"), so a degraded run
 * that only found one qualifying game stayed stuck at 1 pick for the rest of
 * the day with no way to recover short of manual intervention. It's now
 * self-healing: short of TOP5_COUNT, a later call tops up around whatever's
 * already stored instead of skipping, and never replaces an existing pick
 * (which would discard its grading/CLV progress).
 */
test('runTop5Batch tops up a short board on a later call instead of staying stuck', async () => {
  const { env } = makeKvStore();
  const thinEvents = [makeEvent('g0', { outlier: 35 })];
  const first = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => thinEvents });
  assert.equal(first.skipped, false);
  assert.ok(first.count < TOP5_COUNT, 'the thin slate should not have reached TOP5_COUNT');
  const firstPickIds = (await getTop5(env, { dateKey: '2026-08-05' })).map((p) => p.pickId);

  const fullEvents = Array.from({ length: 8 }, (_, i) => makeEvent(`g${i}`, { outlier: 35 }));
  const second = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => fullEvents });
  assert.equal(second.skipped, false);
  assert.equal(second.count, TOP5_COUNT);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, TOP5_COUNT);
  for (const id of firstPickIds) {
    assert.ok(picks.some((p) => p.pickId === id), `original pick ${id} should be preserved, not replaced`);
  }

  const third = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => fullEvents });
  assert.equal(third.skipped, true);
});

/**
 * Regression test for a real incident: the self-healing top-up above only
 * excluded a fresh candidate pool by exact pickId, not by the game it
 * belongs to — a later top-up call, seeing a fuller/different candidate set
 * than the first call, could legitimately score the OTHER side of a game
 * that already had a pick highest and add it as a second, contradictory
 * pick. Live: "Pittsburgh Pirates to win" (from an earlier degraded run)
 * and "New York Mets to win" (added by a later top-up on the same
 * Mets @ Pirates game) both ended up locked in side by side. A board must
 * never carry two picks for the same event.
 */
test('runTop5Batch never adds a pick for a game that already has one, even on a later top-up call', async () => {
  const { env } = makeKvStore();
  // First call: only "g0" is available, and it clears the bar on its HOME
  // side (matching makeEvent's own outlier convention) — one pick locked in.
  const firstEvents = [makeEvent('g0', { outlier: 35 })];
  const first = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => firstEvents });
  assert.equal(first.count, 1);
  const lockedPick = (await getTop5(env, { dateKey: '2026-08-05' }))[0];
  assert.match(lockedPick.pickId, /^g0:/);

  // Second call (a later tick): a fuller slate where "g0" now shows a real
  // edge on its AWAY side instead — simulating the odds having moved, or a
  // fuller fetch surfacing a candidate the first call never saw. This must
  // NOT be added alongside the already-locked g0 pick.
  const awayEdgeG0 = {
    id: 'g0',
    sport_key: 'baseball_mlb',
    sport_title: 'MLB',
    commence_time: new Date(NOW + 6 * 3.6e6).toISOString(),
    home_team: 'g0 Home',
    away_team: 'g0 Away',
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: 'g0 Home', price: 120 },
          { name: 'g0 Away', price: -140 + (i === 0 ? 35 : 0) },
        ],
      }],
    })),
  };
  const secondEvents = [
    awayEdgeG0,
    ...Array.from({ length: 7 }, (_, i) => makeEvent(`g${i + 1}`, { outlier: 35 })),
  ];
  const second = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => secondEvents });
  assert.equal(second.skipped, false);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const g0Picks = picks.filter((p) => p.eventId === 'g0');
  assert.equal(g0Picks.length, 1, 'only the original g0 pick should exist, never a second contradictory one');
  assert.equal(g0Picks[0].pickId, lockedPick.pickId);
  // No two picks on the whole board should ever share an eventId.
  assert.equal(new Set(picks.map((p) => p.eventId)).size, picks.length);
});

test('runTop5Batch excludes candidates from a segment the weekly algorithm health review has paused', async () => {
  const { env } = makeKvStore();
  await env.POTD_KV.put('algo:paused', JSON.stringify([{ key: 'baseball_mlb|h2h', pausedAt: NOW, reason: 'test' }]));

  const events = [
    makeEvent('paused-sport', { outlier: 35, sport: 'baseball_mlb', sportTitle: 'MLB' }),
    makeEvent('active-sport', { outlier: 35, sport: 'basketball_wnba', sportTitle: 'WNBA' }),
  ];

  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });

  assert.ok(picks.every((p) => p.sportKey !== 'baseball_mlb'), 'the paused MLB segment must never be picked');
  assert.ok(picks.some((p) => p.pickId.startsWith('active-sport:')), 'the non-paused WNBA segment should still be picked');
});

test('runTop5Batch uses the tuned EV floor from algo:config, not the shipped default, when one is stored', async () => {
  const { env } = makeKvStore();
  // Tuned floor well above what a modest +100/-140 edge (outlier: 20) clears
  // but the shipped default (RULES.MIN_EV_PCT, ~1.5%) would allow through.
  await env.POTD_KV.put('algo:config', JSON.stringify({
    MIN_EV_PCT: TUNABLE_BOUNDS.MIN_EV_PCT.max,
    MIN_KELLY_FRACTION: TUNABLE_BOUNDS.MIN_KELLY_FRACTION.min,
    MIN_SCORE: TUNABLE_BOUNDS.MIN_SCORE.min,
  }));

  const events = [makeEvent('modest-edge', { outlier: 20 })];
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });

  assert.equal(picks.length, 0, 'a modest edge that clears the shipped default should not clear a tightened floor');
  assert.equal(result.count, 0);
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
