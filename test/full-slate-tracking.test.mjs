import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runFullSlateBatch,
  runFullSlateClvSnapshot,
  runFullSlateGrading,
  getFullSlateTracked,
  getAllFullSlateTracked,
  resetFullSlateTracking,
} from '../worker/src/full-slate-tracking.js';

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

/** A single-market h2h event — deep enough to clear RULES.MIN_SCORE with outlier>=35, a thin near-coin-flip line with outlier=0. */
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

/** A game with BOTH an h2h and a spreads market on it, so the "one pick per game" logic has two real candidates to choose between. */
function makeMultiMarketEvent(id, { hoursOut = 6, h2hOutlier = 0, spreadOutlier = 0 } = {}) {
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
      markets: [
        {
          key: 'h2h',
          last_update: new Date(NOW - 600000).toISOString(),
          outcomes: [
            { name: `${id} Home`, price: -140 + (i === 0 ? h2hOutlier : 0) },
            { name: `${id} Away`, price: 120 },
          ],
        },
        {
          key: 'spreads',
          last_update: new Date(NOW - 600000).toISOString(),
          outcomes: [
            { name: `${id} Home`, price: -110 + (i === 0 ? spreadOutlier : 0), point: -1.5 },
            { name: `${id} Away`, price: -110, point: 1.5 },
          ],
        },
      ],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* runFullSlateBatch                                                 */
/* ---------------------------------------------------------------- */

test('runFullSlateBatch tracks exactly one pick per game, even when a game has multiple markets', async () => {
  const { env } = makeKvStore();
  // The spread market has a much bigger outlier price, so it should score
  // higher and win the "one pick per game" slot for this event.
  const events = [makeMultiMarketEvent('multi', { h2hOutlier: 5, spreadOutlier: 60 })];

  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.equal(result.gameCount, 1);
  assert.equal(result.count, 1, 'only one pick should be stored for this one game, not one per market');

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].marketKey, 'spreads', 'the higher-scoring market (spreads) should be the one tracked');
});

test('runFullSlateBatch tracks the h2h side instead when it is the stronger candidate', async () => {
  const { env } = makeKvStore();
  const events = [makeMultiMarketEvent('multi2', { h2hOutlier: 60, spreadOutlier: 5 })];

  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].marketKey, 'h2h');
});

test('runFullSlateBatch has no odds-band or score floor — a near-coin-flip game still gets a tracked pick', async () => {
  const { env } = makeKvStore();
  // outlier: 0 means every book quotes the exact same price — a thin,
  // near-zero-edge line that topPicks()'s EV/Kelly floor would reject.
  const events = [makeEvent('thin', { outlier: 0 })];

  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'a game with essentially no edge should still be tracked — Full Slate has no floor');

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].meetsStandard, true, 'Full Slate picks always carry meetsStandard: true — there is no standard to fail here');
});

test('runFullSlateBatch tracks a game topPicks() would reject on price alone (outside -250..+150)', async () => {
  const { env } = makeKvStore();
  const events = [{
    id: 'longshot',
    sport_key: 'baseball_mlb',
    sport_title: 'MLB',
    commence_time: new Date(NOW + 6 * 3.6e6).toISOString(),
    home_team: 'Longshot Home',
    away_team: 'Longshot Away',
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: 'Longshot Home', price: -900 },
          { name: 'Longshot Away', price: 600 + (i === 0 ? 100 : 0) },
        ],
      }],
    })),
  }];

  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'price band is a Pixel\'s Picks/POTD concept, not a Full Slate one');
});

test('runFullSlateBatch never picks a team-sport game that isn\'t happening today', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('far-out', { outlier: 40, hoursOut: 24 * 140, sport: 'americanfootball_nfl', sportTitle: 'NFL' }),
    makeEvent('today', { outlier: 20, hoursOut: 6 }),
  ];
  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.gameCount, 1);

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.ok(picks.every((p) => p.pickId.startsWith('today:')));
});

test('runFullSlateBatch honors MMA\'s today-or-early-tomorrow eligibility window, same as Pixel\'s Picks', async () => {
  const { env } = makeKvStore();
  const events = [
    // ~30h out, well past tomorrow's early-morning cutoff — not eligible.
    makeEvent('late-mma', { outlier: 30, hoursOut: 30, sport: 'mma_mixed_martial_arts', sportTitle: 'MMA' }),
    makeEvent('today-mlb', { outlier: 20, hoursOut: 6 }),
  ];
  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.gameCount, 1);
});

test('runFullSlateBatch stores picks with a flat unit stake', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('flat', { outlier: 35 })];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks[0].suggested_stake, 20);
});

test('runFullSlateBatch only runs once per ET day', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('a', { outlier: 35 })];

  const first = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(first.skipped, false);

  const second = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(second.skipped, true);
});

/* ---------------------------------------------------------------- */
/* runFullSlateClvSnapshot / runFullSlateGrading / history / reset   */
/* ---------------------------------------------------------------- */

test('runFullSlateClvSnapshot updates closeAmerican when the price has moved', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('clv', { outlier: 35, hoursOut: 6 })];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const movedEvents = [makeEvent('clv', { outlier: 55, hoursOut: 5 })];
  const result = await runFullSlateClvSnapshot(env, ctx, NOW + 3600000, {
    fetchSportFn: async () => ({ events: movedEvents }),
  });
  assert.equal(result.updated, 1);
});

test('runFullSlateGrading grades a completed pick won/lost via the shared gradePick()', async () => {
  const { env } = makeKvStore();
  // buildCandidates() only tracks future games (commenceMs > now), so the
  // pick has to be generated against a game that hasn't started yet — grade
  // it at a later "now", after the game would be over.
  const events = [makeEvent('grade', { outlier: 35, hoursOut: 2 })];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const [pick] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  const scoreEvents = [{
    id: 'grade',
    completed: true,
    scores: [
      { name: 'grade Home', score: pick.outcomeName === 'grade Home' ? '5' : '2' },
      { name: 'grade Away', score: pick.outcomeName === 'grade Away' ? '5' : '2' },
    ],
  }];
  const result = await runFullSlateGrading(env, ctx, NOW + 6 * 3.6e6, {
    fetchScoresFn: async () => ({ events: scoreEvents }),
  });
  assert.equal(result.graded, 1);

  const [graded] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(graded.status, 'won');
  assert.ok(graded.result.payout > 0);
});

test('getAllFullSlateTracked spans multiple days, resetFullSlateTracking clears every one', async () => {
  const { env } = makeKvStore();
  const day2Now = NOW + 86400000;
  const day2Event = {
    ...makeEvent('day2', { outlier: 35 }),
    // makeEvent's commence_time is relative to the file-level NOW constant —
    // override it here so day2's game is actually upcoming relative to
    // day2Now, not 18 hours in day2Now's past.
    commence_time: new Date(day2Now + 6 * 3.6e6).toISOString(),
  };
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('day1', { outlier: 35 })] });
  await runFullSlateBatch(env, ctx, day2Now, { fetchFullSlate: async () => [day2Event] });

  const all = await getAllFullSlateTracked(env, { now: NOW + 86400000, days: 5 });
  assert.equal(all.length, 2);

  const { deleted } = await resetFullSlateTracking(env, { now: NOW + 86400000, days: 5 });
  assert.equal(deleted, 2);

  const afterReset = await getAllFullSlateTracked(env, { now: NOW + 86400000, days: 5 });
  assert.equal(afterReset.length, 0);
});
