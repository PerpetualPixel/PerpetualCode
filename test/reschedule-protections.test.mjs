/**
 * Regression tests for the match-reschedule protections, born from a live
 * incident chain (Aug 2026): tennis order-of-play moved matches after their
 * picks locked in, which produced (1) picks filed under the wrong ET day,
 * (2) the same match tracked TWICE — once on opposite sides (Rafael Jodar
 * -105 AND Arthur Fils +100), and (3) unplayed matches reading as stuck
 * grades because their stored commenceMs was a stale lock-time snapshot.
 *
 * Every scenario here mirrors one of those real incident shapes. The
 * protections under test:
 * - runFullSlateGrading/runGrading refresh commenceMs from the live score
 *   feed and refuse to grade a pick whose fresh time moved to another day
 *   (the resync re-buckets it first).
 * - runFullSlateDateResync/runTop5DateResync move misfiled pending picks to
 *   their real day (KV key + manifest + the record's own dateKey field) and
 *   collapse duplicate picks on one event to the earliest lock.
 * - The admin migrations additionally repair graded history's dates and
 *   relabel stale dateKey fields, but NEVER collapse a duplicate group that
 *   carries a graded result.
 * - runPotdDaily refuses to re-feature a match already featured on a recent
 *   day whose start time has since moved into today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runFullSlateGrading,
  runFullSlateDateResync,
  migrateFullSlatePickDates,
  getFullSlateTracked,
} from '../worker/src/full-slate-tracking.js';
import {
  runGrading,
  runTop5DateResync,
  migrateTop5PickDates,
  getTop5,
} from '../worker/src/tracking.js';
import { runPotdDaily } from '../worker/src/potd.js';

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
// Aug 11, 2:00 PM ET — the moment the live incident was diagnosed.
const NOW = Date.parse('2026-08-11T18:00:00.000Z');

const GEN_EARLY = Date.parse('2026-08-09T11:00:00Z'); // Aug 9  7:00 AM ET
const GEN_LATE = Date.parse('2026-08-10T06:00:00Z');  // Aug 10 2:00 AM ET
const STALE_START = Date.parse('2026-08-10T22:00:00.000Z'); // Aug 10 6:00 PM ET
const FRESH_START = Date.parse('2026-08-11T18:00:00.000Z'); // Aug 11 2:00 PM ET

function makePick(eventId, { dateKey, commenceMs, generatedAt = GEN_EARLY, outcomeName = 'Rafael Jodar', home = 'Rafael Jodar', away = 'Arthur Fils', status = 'pending' }) {
  return {
    pickId: `${eventId}:h2h|${outcomeName}|`, dateKey, eventId,
    sportKey: 'tennis_atp_canadian_open', home, away, marketKey: 'h2h',
    outcomeName, point: null, selection: `${outcomeName} to win`,
    american: -105, decimal: 1.95, book: 'DraftKings', score: 60,
    consensusProb: 0.55, commenceMs, suggested_stake: 20, generatedAt,
    status, clv: { openAmerican: -105, closeAmerican: -105, updatedAt: generatedAt },
    result: status === 'pending' ? null : { payout: 19.05, roiPercent: 95 },
    meetsStandard: true, flagReason: null,
  };
}

async function seedSlate(env, dateKey, picks, { now = NOW } = {}) {
  for (const p of picks) {
    await env.POTD_KV.put(`slate:${dateKey}:pick:${p.pickId}`, JSON.stringify(p));
  }
  await env.POTD_KV.put(`slate:${dateKey}:manifest`, JSON.stringify({
    date: dateKey, generatedAt: now, pickIds: picks.map((p) => p.pickId),
  }));
}

async function seedTop5(env, dateKey, picks, { now = NOW } = {}) {
  for (const p of picks) {
    await env.POTD_KV.put(`track:${dateKey}:pick:${p.pickId}`, JSON.stringify(p));
  }
  await env.POTD_KV.put(`track:${dateKey}:top5`, JSON.stringify({
    date: dateKey, generatedAt: now, pickIds: picks.map((p) => p.pickId),
  }));
}

/* ---------------------------------------------------------------- */
/* Full Slate: commence refresh + wrong-day grading block + resync   */
/* ---------------------------------------------------------------- */

test('Full Slate grading refreshes a stale commence time, refuses to grade the unplayed match, and the resync re-buckets it', async () => {
  const { env } = makeKvStore();
  await seedSlate(env, '2026-08-10', [makePick('ev1', { dateKey: '2026-08-10', commenceMs: STALE_START })]);

  const scoreEvents = [{
    id: 'ev1', sport_key: 'tennis_atp_canadian_open',
    commence_time: new Date(FRESH_START).toISOString(),
    home_team: 'Rafael Jodar', away_team: 'Arthur Fils',
    completed: false, scores: null,
  }];

  const g = await runFullSlateGrading(env, ctx, NOW, {
    fetchScoresFn: async () => ({ events: scoreEvents }),
    fetchMmaResultsFn: async () => [],
  });
  assert.equal(g.rescheduled, 1, 'the stale commence time must be refreshed from the feed');
  assert.equal(g.graded, 0, 'an unplayed match must never be graded');

  const r = await runFullSlateDateResync(env, ctx, NOW, { days: 2 });
  assert.equal(r.moved, 1, 'the resync must move the pick to its real day');

  const aug10 = await getFullSlateTracked(env, { dateKey: '2026-08-10' });
  assert.equal(aug10.length, 0);
  const aug11 = await getFullSlateTracked(env, { dateKey: '2026-08-11' });
  assert.equal(aug11.length, 1);
  assert.equal(aug11[0].dateKey, '2026-08-11', 'the record\'s own dateKey field must be rewritten, not just its KV key');
  assert.equal(aug11[0].status, 'pending');
});

test('Full Slate grading treats an intra-day time shift as a refresh only — grading proceeds, nothing moves days', async () => {
  const { env } = makeKvStore();
  const storedStart = Date.parse('2026-08-11T16:30:00Z'); // Aug 11 12:30 PM ET
  const feedStart = Date.parse('2026-08-11T18:00:00Z');   // Aug 11  2:00 PM ET
  await seedSlate(env, '2026-08-11', [makePick('ev2', { dateKey: '2026-08-11', commenceMs: storedStart })]);

  const later = feedStart + 3 * 3.6e6;
  const scoreEvents = [{
    id: 'ev2', sport_key: 'tennis_atp_canadian_open',
    commence_time: new Date(feedStart).toISOString(),
    home_team: 'Rafael Jodar', away_team: 'Arthur Fils',
    completed: true,
    scores: [{ name: 'Rafael Jodar', score: '2' }, { name: 'Arthur Fils', score: '1' }],
  }];

  const g = await runFullSlateGrading(env, ctx, later, {
    fetchScoresFn: async () => ({ events: scoreEvents }),
    fetchMmaResultsFn: async () => [],
  });
  assert.equal(g.rescheduled, 1);
  assert.equal(g.graded, 1, 'a same-day shift must not block grading');

  const aug11 = await getFullSlateTracked(env, { dateKey: '2026-08-11' });
  assert.equal(aug11.length, 1);
  assert.equal(aug11[0].status, 'won');
  assert.equal(aug11[0].commenceMs, feedStart);
});

/* ---------------------------------------------------------------- */
/* Full Slate: duplicate collapse + graded-history safety            */
/* ---------------------------------------------------------------- */

test('Full Slate resync collapses opposite-side duplicates to the earliest lock, keeper inherits the corrected time', async () => {
  const { env } = makeKvStore();
  const earlySlot = Date.parse('2026-08-10T16:30:00Z');
  const lateSlot = Date.parse('2026-08-10T22:00:00Z');
  await seedSlate(env, '2026-08-10', [
    makePick('ev3', { dateKey: '2026-08-10', commenceMs: earlySlot, generatedAt: GEN_EARLY, outcomeName: 'Rafael Jodar' }),
    makePick('ev3', { dateKey: '2026-08-10', commenceMs: lateSlot, generatedAt: GEN_LATE, outcomeName: 'Arthur Fils' }),
  ]);

  const r = await runFullSlateDateResync(env, ctx, NOW, { days: 2 });
  assert.equal(r.collapsed, 1);

  const aug10 = await getFullSlateTracked(env, { dateKey: '2026-08-10' });
  assert.equal(aug10.length, 1, 'exactly one pick must survive');
  assert.equal(aug10[0].selection, 'Rafael Jodar to win', 'the keeper is the lock the algorithm committed to FIRST');
  assert.equal(aug10[0].commenceMs, lateSlot, 'the keeper inherits the newest duplicate\'s corrected start time');
});

test('no automatic or admin repair ever deletes a duplicate group carrying a graded result', async () => {
  const { env } = makeKvStore();
  await seedSlate(env, '2026-08-10', [
    makePick('ev4', { dateKey: '2026-08-10', commenceMs: STALE_START, generatedAt: GEN_EARLY, outcomeName: 'Rafael Jodar', status: 'won' }),
    makePick('ev4', { dateKey: '2026-08-10', commenceMs: STALE_START, generatedAt: GEN_LATE, outcomeName: 'Arthur Fils' }),
  ]);

  const migrationNow = Date.parse('2026-08-10T23:00:00Z');
  const result = await migrateFullSlatePickDates(env, ctx, migrationNow, { days: 1 });
  assert.equal(result.collapsed.length, 0);
  assert.equal(result.skippedGraded.length, 1, 'the graded group must be reported, never touched');

  const aug10 = await getFullSlateTracked(env, { dateKey: '2026-08-10' });
  assert.equal(aug10.length, 2, 'both picks survive untouched');
});

test('the admin migration relabels a pick whose KV key already moved but whose own dateKey field is stale', async () => {
  // The first live migration moved storage keys without touching the
  // embedded dateKey field the client actually groups by — a "successful"
  // run that changed nothing on screen. This guards the relabel pass that
  // closed that gap.
  const { env } = makeKvStore();
  const stale = makePick('ev5', { dateKey: '2026-08-10', commenceMs: FRESH_START });
  await seedSlate(env, '2026-08-11', [stale]); // physically filed under Aug 11 already

  const result = await migrateFullSlatePickDates(env, ctx, NOW, { days: 3 });
  assert.equal(result.misdated.length, 0, 'storage location is already correct');
  assert.equal(result.relabeled.length, 1, 'the stale embedded dateKey must be caught');

  const aug11 = await getFullSlateTracked(env, { dateKey: '2026-08-11' });
  assert.equal(aug11[0].dateKey, '2026-08-11');
});

/* ---------------------------------------------------------------- */
/* Pixel's Picks: same protections, plus the freed slot               */
/* ---------------------------------------------------------------- */

test('Pixel\'s Picks grading refreshes stale times, blocks wrong-day grading, and the resync re-buckets', async () => {
  const { env } = makeKvStore();
  await seedTop5(env, '2026-08-10', [makePick('ev6', { dateKey: '2026-08-10', commenceMs: STALE_START })]);

  const scoreEvents = [{
    id: 'ev6', sport_key: 'tennis_atp_canadian_open',
    commence_time: new Date(FRESH_START).toISOString(),
    home_team: 'Rafael Jodar', away_team: 'Arthur Fils',
    completed: false, scores: null,
  }];

  const g = await runGrading(env, ctx, NOW, {
    fetchScoresFn: async () => ({ events: scoreEvents }),
    fetchMmaResultsFn: async () => [],
  });
  assert.equal(g.rescheduled, 1);
  assert.equal(g.graded, 0);

  const r = await runTop5DateResync(env, ctx, NOW, { days: 2 });
  assert.equal(r.moved, 1);

  const aug11 = await getTop5(env, { dateKey: '2026-08-11' });
  assert.equal(aug11.length, 1);
  assert.equal(aug11[0].dateKey, '2026-08-11');
  assert.equal(aug11[0].status, 'pending');
});

test('Pixel\'s Picks resync collapses an opposite-side duplicate and frees the board slot', async () => {
  const { env, store } = makeKvStore();
  const earlySlot = Date.parse('2026-08-10T16:30:00Z');
  const lateSlot = Date.parse('2026-08-10T22:00:00Z');
  await seedTop5(env, '2026-08-10', [
    makePick('ev7', { dateKey: '2026-08-10', commenceMs: earlySlot, generatedAt: GEN_EARLY, outcomeName: 'Rafael Jodar' }),
    makePick('ev7', { dateKey: '2026-08-10', commenceMs: lateSlot, generatedAt: GEN_LATE, outcomeName: 'Arthur Fils' }),
  ]);

  const r = await runTop5DateResync(env, ctx, NOW, { days: 2 });
  assert.equal(r.collapsed, 1);

  const aug10 = await getTop5(env, { dateKey: '2026-08-10' });
  assert.equal(aug10.length, 1);
  assert.equal(aug10[0].selection, 'Rafael Jodar to win');

  // The board caps at TOP5_COUNT — the freed manifest slot is what lets the
  // next batch tick top up with a genuinely different game.
  const manifest = JSON.parse(store.get('track:2026-08-10:top5'));
  assert.equal(manifest.pickIds.length, 1, 'the duplicate\'s manifest slot must be freed');
});

test('Pixel\'s Picks admin migration reports graded duplicate groups without touching them', async () => {
  const { env } = makeKvStore();
  await seedTop5(env, '2026-08-10', [
    makePick('ev8', { dateKey: '2026-08-10', commenceMs: STALE_START, generatedAt: GEN_EARLY, outcomeName: 'Rafael Jodar', status: 'won' }),
    makePick('ev8', { dateKey: '2026-08-10', commenceMs: STALE_START, generatedAt: GEN_LATE, outcomeName: 'Arthur Fils', status: 'lost' }),
  ]);

  const migrationNow = Date.parse('2026-08-10T23:00:00Z');
  const result = await migrateTop5PickDates(env, ctx, migrationNow, { days: 1 });
  assert.equal(result.collapsed.length, 0);
  assert.equal(result.skippedGraded.length, 1);

  const aug10 = await getTop5(env, { dateKey: '2026-08-10' });
  assert.equal(aug10.length, 2);
});

/* ---------------------------------------------------------------- */
/* Play of the Day: cross-day re-feature guard                        */
/* ---------------------------------------------------------------- */

test('POTD refuses to re-feature yesterday\'s match after its start time moved into today', async () => {
  const { env } = makeKvStore();
  const EVENT = 'ev9';
  await env.POTD_KV.put('potd:2026-08-10', JSON.stringify({
    date: '2026-08-10',
    generatedAt: GEN_LATE,
    pick: {
      pickId: `${EVENT}:h2h|Rafael Jodar|`, dateKey: '2026-08-10', eventId: EVENT,
      sportKey: 'tennis_atp_canadian_open', marketKey: 'h2h', outcomeName: 'Rafael Jodar',
      selection: 'Rafael Jodar to win', american: -105, decimal: 1.95, score: 60,
      home: 'Rafael Jodar', away: 'Arthur Fils', commenceMs: STALE_START,
      book: 'DraftKings', consensusProb: 0.55, suggested_stake: 20,
      status: 'pending', clv: { openAmerican: -105, closeAmerican: -105, updatedAt: GEN_LATE },
      result: null,
    },
  }));

  // Today's feed: the same match, rescheduled to today, richly priced — it
  // would absolutely qualify without the guard.
  const BOOKS = [
    ['draftkings', 'DraftKings'], ['fanduel', 'FanDuel'], ['betmgm', 'BetMGM'],
    ['williamhill_us', 'Caesars'], ['betrivers', 'BetRivers'], ['espnbet', 'ESPN BET'],
    ['fanatics', 'Fanatics'], ['hardrockbet', 'Hard Rock Bet'],
  ];
  const feedEvent = {
    id: EVENT,
    sport_key: 'tennis_atp_canadian_open',
    sport_title: 'ATP Canadian Open',
    commence_time: new Date(NOW + 3 * 3.6e6).toISOString(),
    home_team: 'Rafael Jodar',
    away_team: 'Arthur Fils',
    bookmakers: BOOKS.map(([key, title], i) => ({
      key, title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: 'Rafael Jodar', price: -140 + (i === 0 ? 40 : 0) },
          { name: 'Arthur Fils', price: 120 },
        ],
      }],
    })),
  };

  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [feedEvent] });
  const todayRaw = await env.POTD_KV.get('potd:2026-08-11');
  if (todayRaw) {
    assert.notEqual(JSON.parse(todayRaw).pick?.eventId, EVENT, 'a match already featured yesterday must never be today\'s Play of the Day too');
  }
  assert.ok(result.skipped, 'with the only candidate already featured, the day is skipped');
});
