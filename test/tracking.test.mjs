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
  contradictsPublishedBoard,
  runBoardReview,
} from '../worker/src/tracking.js';
import { TUNABLE_BOUNDS } from '../worker/src/algo-health.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';

// The tennis form gate (docs/qualitative.js) reads the static archive; unit
// tests must never hit the network, and a null archive is the honest
// degraded mode (favorites pass unscored, unsupported dogs are blocked).
seedTennisArchiveCacheForTests({ atp: null, wta: null });

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

/**
 * A single-market h2h event, deep enough to clear RULES.MIN_SCORE and (with
 * outlier>=35) the EV/Kelly floor.
 *
 * hoursOut defaults to 2, INSIDE every sport's per-game lock lead time
 * (PICK_LEAD_HOURS: 3h for MLB/WNBA, 2.5h tennis/MMA) — these tests were
 * originally written against the old "lock the whole day at 2am" behavior
 * with games 6h out, and when per-game lock timing landed, every batch call
 * started (correctly) waiting on games whose windows hadn't opened yet,
 * which read as 40+ test failures. A test that wants a game the batch must
 * WAIT on passes an explicit larger hoursOut instead.
 */
function makeEvent(id, { hoursOut = 2, outlier = 35, sport = 'baseball_mlb', sportTitle = 'MLB', lastUpdate = NOW - 600000 } = {}) {
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
      last_update: new Date(lastUpdate).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(lastUpdate).toISOString(),
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
function makeOutOfRangeEvent(id, { hoursOut = 2 } = {}) {
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
    // 2U per Pixel's Pick (product direction — see pickRecordFrom).
    assert.equal(p.suggested_stake, 40);
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
    makeEvent('mlb-today', { outlier: 35 }),
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

test('runTop5Batch tennis next-day carve-out: a match rolling just past midnight (before 2am ET) is eligible, an ordinary tomorrow-afternoon match is not', async () => {
  // Positive: 11pm ET Aug 5, with a match at 1am ET Aug 6 — a night session
  // rolling past midnight, inside the midnight-2am ET carve-out, and late
  // enough that its own 2.5h lock lead window is open.
  {
    const { env } = makeKvStore();
    const lateNow = Date.parse('2026-08-06T03:00:00Z'); // 11pm ET Aug 5
    const events = [makeEvent('tennis-1am', {
      outlier: 40, hoursOut: 17, // NOW + 17h = 1am ET Aug 6
      sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open',
      lastUpdate: lateNow - 600000,
    })];
    const result = await runTop5Batch(env, ctx, lateNow, { fetchFullSlate: async () => events });
    assert.equal(result.count, 1, 'a match rolling just past midnight stays on today\'s board');
    const picks = await getTop5(env, { dateKey: '2026-08-05' });
    assert.equal(picks.length, 1, 'and it is stored under TODAY\'s date, not tomorrow\'s');
  }
  // Negative: an ordinary tomorrow-2pm-ET match must NOT be on today's
  // board — this was a real bug ("eligible all day tomorrow"), removed per
  // explicit product direction; only midnight-2am ET next-day starts count.
  {
    const { env } = makeKvStore();
    const events = [makeEvent('tennis-tomorrow-pm', {
      outlier: 40, hoursOut: 30, // NOW + 30h = 2pm ET Aug 6
      sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open',
    })];
    const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
    assert.equal(result.count, 0, 'an ordinary next-afternoon match belongs on tomorrow\'s board, not today\'s');
  }
});

test('runTop5Batch refuses to pad with a price outside the hard band', async () => {
  const { env } = makeKvStore();
  // Two real sharp edges plus a +350 longshot that clears the EV/Kelly floor
  // but sits outside Pixel's Picks' hard price band.
  //
  // This used to be padded onto the board as a flagged fallback slot, because
  // guaranteeCount relaxed the odds range without limit — it only LABELLED
  // the price as out of band and posted it anyway. That is the same hole a
  // -1800 favorite came through on the live board, against a board that
  // advertises "-200 or better."
  //
  // The count promise and the price band genuinely conflict on a thin day,
  // and the band wins: a short board is recoverable, a board whose stated
  // standard is a lie is not.
  const events = [
    makeEvent('sharp1', { outlier: 35 }),
    makeEvent('sharp2', { outlier: 40 }),
    makeOutOfRangeEvent('longshot'),
  ];

  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 2, 'the day only had two candidates inside the band');
  assert.ok(!picks.some((p) => p.pickId.startsWith('longshot:')), 'the +350 must never reach the board');
  for (const p of picks) {
    assert.ok(p.american >= -200 && p.american <= 150, `${p.pickId} priced ${p.american} is outside the hard band`);
  }
});

test('a heavy favorite is never posted, even to fill a slot', async () => {
  const { env } = makeKvStore();
  // The reported failure in its own right: "I don't want a -1800."
  const heavy = makeOutOfRangeEvent('chalk');
  for (const book of heavy.bookmakers) {
    book.markets[0].outcomes = [
      { name: 'chalk Home', price: -1800 },
      { name: 'chalk Away', price: 1200 },
    ];
  }
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => [heavy] });
  assert.equal(result.skipped, false);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.ok(picks.every((p) => p.american >= -200), 'nothing worse than -200 may be posted');
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
    commence_time: new Date(NOW + 2 * 3.6e6).toISOString(),
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
  const original = makeEvent('a', { outlier: 35 }); // 2h out — inside the lock window at NOW
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => [original] });

  const [before] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(before.clv.closeAmerican, before.clv.openAmerican);

  // The exact same event, but the outlier book's price has moved further.
  // Snapshots run while the game (NOW+2h) is still pregame.
  const moved = makeEvent('a', { outlier: 60 });
  const r1 = await runClvSnapshot(env, ctx, NOW + 0.5 * 3.6e6, { fetchSportFn: async () => ({ events: [moved] }) });
  assert.equal(r1.updated, 1);

  const [after] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.notEqual(after.clv.closeAmerican, after.clv.openAmerican);

  // A second snapshot against the identical price is a no-op.
  const r2 = await runClvSnapshot(env, ctx, NOW + 3.6e6, { fetchSportFn: async () => ({ events: [moved] }) });
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
  // d2: 2h out from day2's own "now" (26h from the fixture's NOW anchor),
  // with a quote fresh as of day2 — inside its own lock window on day2.
  await runTop5Batch(env, ctx, day2, { fetchFullSlate: async () => [makeEvent('d2', { outlier: 35, hoursOut: 26, lastUpdate: day2 - 600000 })] });

  const all = await getAllTrackedPicks(env, { now: day2, days: 5 });
  assert.equal(all.length, 2);

  const { deleted } = await resetAllTracking(env, { now: day2, days: 5 });
  assert.equal(deleted, 2);

  const afterReset = await getAllTrackedPicks(env, { now: day2, days: 5 });
  assert.equal(afterReset.length, 0);
});

/* ---------------------------------------------------------------- */
/* The 5-pick minimum                                                */
/* ---------------------------------------------------------------- */

/** An event N hours from NOW, priced with a real edge so it's a live candidate. */
function eventAtHour(id, hoursOut, outlier = 35) {
  return makeEvent(id, { hoursOut, outlier });
}

/**
 * The reported failure, reproduced end to end: "time and time again I need
 * this to be 5 minimum but I come back and find only 1 or 2."
 *
 * The board waited until every one of today's games had reached its lock
 * window before drawing, so it could compare the whole day. That trigger
 * fires ~3h before the day's LAST game — and the draw pool only contains
 * games that haven't started. On a day spread from early afternoon to late
 * evening, the entire afternoon was unbettable by the time the draw ran.
 */
test('a day spread across many hours still produces a full board', async () => {
  const { env } = makeKvStore();
  // Eight games at 2h intervals — the shape of a real MLB slate. Under the
  // old all-or-nothing draw, only the last couple were still bettable when
  // the board was finally allowed to pick.
  const events = Array.from({ length: 8 }, (_, i) => eventAtHour(`g${i}`, 2 + i * 2, 35 + i));

  // Walk the day tick by tick, exactly as the cron does.
  let now = NOW;
  for (let tick = 0; tick < 40; tick++) {
    await runTop5Batch(env, ctx, now, {
      fetchFullSlate: async () => events.filter((e) => Date.parse(e.commence_time) > now),
    });
    now += 30 * 60000; // 30 minutes
  }

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 5, `expected a full board, got ${picks.length}`);
  // Five distinct games, all inside the price band — a board padded by
  // double-picking one game, or by reaching for a price the band forbids,
  // would satisfy the count while defeating the point of it.
  assert.equal(new Set(picks.map((p) => p.eventId)).size, 5, 'the board double-picked a game to reach five');
  for (const p of picks) {
    assert.ok(p.american >= -200 && p.american <= 150, `${p.pickId} priced ${p.american} is outside the hard band`);
  }
});

test('a strong number is locked when it appears rather than left to expire', async () => {
  const { env } = makeKvStore();
  // One standout early game, plus later ones that keep the day "still open"
  // so the old code would have kept waiting until the early one had started.
  const events = [
    eventAtHour('early-standout', 2.6, 90),
    eventAtHour('late1', 10),
    eventAtHour('late2', 12),
  ];
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.ok(picks.some((p) => p.pickId.startsWith('early-standout:')),
    'the standout should be taken on sight, not lost to its own start time');
});

test('the board never takes the opposite side of a Full Slate or PoTD pick', async () => {
  const { env, store } = makeKvStore();
  const events = [eventAtHour('shared', 2.5, 40), eventAtHour('other', 3)];

  // The Full Slate already called this game's moneyline the other way.
  store.set('slate:2026-08-05:manifest', JSON.stringify({ date: '2026-08-05', pickIds: ['p1'] }));
  store.set('slate:2026-08-05:pick:p1', JSON.stringify({
    pickId: 'p1', eventId: 'shared', marketKey: 'h2h', outcomeName: 'shared Away', status: 'pending',
  }));

  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });

  const conflicting = picks.filter(
    (p) => p.eventId === 'shared' && p.marketKey === 'h2h' && p.outcomeName !== 'shared Away',
  );
  assert.equal(conflicting.length, 0, 'picked the opposite side of a published Full Slate call');
});

test('agreeing with another board is allowed — only the opposite side is barred', () => {
  const published = new Set(['ev1|h2h|Team A']);
  assert.equal(contradictsPublishedBoard({ eventId: 'ev1', marketKey: 'h2h', outcomeName: 'Team A' }, published), false);
  assert.equal(contradictsPublishedBoard({ eventId: 'ev1', marketKey: 'h2h', outcomeName: 'Team B' }, published), true);
  // A different market on the same game is a separate bet, not a contradiction.
  assert.equal(contradictsPublishedBoard({ eventId: 'ev1', marketKey: 'totals', outcomeName: 'Over' }, published), false);
  assert.equal(contradictsPublishedBoard({ eventId: 'ev2', marketKey: 'h2h', outcomeName: 'Team B' }, published), false);
});

/* ---------------------------------------------------------------- */
/* The 3-of-5 standard                                               */
/* ---------------------------------------------------------------- */

/** Seeds a fully-settled Pixel's Picks day with a given win/loss split. */
function seedSettledDay(store, dateKey, results) {
  const ids = results.map((_, i) => `p${i}`);
  store.set(`track:${dateKey}:top5`, JSON.stringify({ date: dateKey, pickIds: ids }));
  results.forEach((status, i) => {
    store.set(`track:${dateKey}:pick:p${i}`, JSON.stringify({
      pickId: `p${i}`, dateKey, eventId: `ev${i}`, sportKey: 'baseball_mlb',
      marketKey: 'h2h', outcomeName: 'Home', suggested_stake: 20, status,
      result: { payout: status === 'won' ? 18 : -20 },
    }));
  });
}

const YESTERDAY = '2026-08-04';

test('a board that misses 3 of 5 raises its own conviction floor', async () => {
  const { env, store } = makeKvStore();
  seedSettledDay(store, YESTERDAY, ['won', 'lost', 'lost', 'lost', 'lost']);

  const verdict = await runBoardReview(env, ctx, NOW);
  assert.equal(verdict.met, false);
  assert.equal(verdict.wins, 1);
  assert.equal(verdict.required, 3);
  assert.ok(verdict.scoreBump > 0, 'a missed standard must tighten the floor');
});

test('a board that meets the standard earns its ground back', async () => {
  const { env, store } = makeKvStore();
  store.set('track:board-review', JSON.stringify({ scoreBump: 6, lastReviewedDate: null, history: [] }));
  seedSettledDay(store, YESTERDAY, ['won', 'won', 'won', 'lost', 'lost']);

  const verdict = await runBoardReview(env, ctx, NOW);
  assert.equal(verdict.met, true);
  assert.ok(verdict.scoreBump < 6, 'meeting the standard must relax the floor');
});

test('the floor is capped, so a cold streak cannot shut the board down', async () => {
  const { env, store } = makeKvStore();
  store.set('track:board-review', JSON.stringify({ scoreBump: 99, lastReviewedDate: null, history: [] }));
  seedSettledDay(store, YESTERDAY, ['lost', 'lost', 'lost', 'lost', 'lost']);

  const verdict = await runBoardReview(env, ctx, NOW);
  assert.ok(verdict.scoreBump <= 8, `bump ${verdict.scoreBump} exceeded the cap`);
});

test('a day still carrying pending picks is not judged', async () => {
  const { env, store } = makeKvStore();
  seedSettledDay(store, YESTERDAY, ['won', 'lost', 'lost', 'lost', 'lost']);
  // One still unsettled — grading it as a miss would invent a failure out of
  // a day that simply hasn't finished.
  const raw = JSON.parse(store.get(`track:${YESTERDAY}:pick:p4`));
  raw.status = 'pending';
  store.set(`track:${YESTERDAY}:pick:p4`, JSON.stringify(raw));

  const verdict = await runBoardReview(env, ctx, NOW);
  assert.equal(verdict.skipped, true);
});

test('voids count toward neither half of the ratio', async () => {
  const { env, store } = makeKvStore();
  // 3 wins, 1 loss, 1 void -> 4 decided, requires ceil(0.6*4) = 3. Met.
  seedSettledDay(store, YESTERDAY, ['won', 'won', 'won', 'lost', 'void']);

  const verdict = await runBoardReview(env, ctx, NOW);
  assert.equal(verdict.decided, 4, 'the void must not be counted as a decided pick');
  assert.equal(verdict.met, true, 'a walkover is not a miss the board should pay for');
});

test('the review runs once per day, not once per tick', async () => {
  const { env, store } = makeKvStore();
  seedSettledDay(store, YESTERDAY, ['lost', 'lost', 'lost', 'lost', 'lost']);

  const first = await runBoardReview(env, ctx, NOW);
  const second = await runBoardReview(env, ctx, NOW);
  assert.equal(first.skipped, undefined);
  assert.equal(second.skipped, true, 'a second run the same day must not compound the adjustment');
});
