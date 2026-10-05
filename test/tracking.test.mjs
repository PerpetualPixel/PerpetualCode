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
import { seedTeamContextCacheForTests } from '../worker/src/team-form.js';
// Same reasoning for team sports: seeding SEALS the memo, so no fixture in
// these slates reaches cdn.espn.com. An empty seed is the honest degraded
// mode — no context, so no form re-score and no underdog gate, exactly what
// an unreachable ESPN produces in production.
seedTeamContextCacheForTests({});

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

/**
 * An NFL game with a heavy home favourite: every registry book at
 * favoritePrice/dogPrice, book 0 `outlier` better on the home side. At the
 * defaults (-320/+255, +60) the home side reads 74.5% by the market at a
 * -260 best price with ~3% EV — an anchor-grade leg (docs/tickets.js) —
 * and two of them pair to a -109 ticket that lands 56% of the time.
 */
function makeFav(id, { hoursOut = 2, favoritePrice = -320, dogPrice = 255, outlier = 60, sport = 'americanfootball_nfl', sportTitle = 'NFL', lastUpdate = NOW - 600000 } = {}) {
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
          { name: `${id} Home`, price: favoritePrice + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: dogPrice },
        ],
      }],
    })),
  };
}
const favs = (n, opts = {}) => Array.from({ length: n }, (_, i) => makeFav(`g${i}`, opts));
const finalScore = (id, homeScore, awayScore) => ({
  id, completed: true, scores: [{ name: `${id} Home`, score: String(homeScore) }, { name: `${id} Away`, score: String(awayScore) }],
});
const tennisFav = (id, opts = {}) => makeFav(id, { sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open', ...opts });

/* ---------------------------------------------------------------- */
/* runTop5Batch — anchor + partner tickets                            */
/* ---------------------------------------------------------------- */

test('runTop5Batch posts anchor + partner tickets: two legs from two games, -200..+100 together, every leg clearing the floor', async () => {
  const { env } = makeKvStore();
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(8) });
  assert.equal(result.skipped, false);
  assert.equal(result.count, 4, 'eight anchor-grade legs make four disjoint tickets');

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 4);
  const games = new Set();
  for (const p of picks) {
    assert.equal(p.type, 'combo');
    assert.equal(p.legs.length, 2);
    assert.equal(p.status, 'pending');
    assert.ok(p.american >= -200 && p.american <= 100, `ticket priced ${p.american}`);
    assert.ok(p.consensusProb > 0.5 && p.consensusProb < 1, `joint probability ${p.consensusProb}`);
    assert.ok(p.ev > 0.02, `ticket EV ${p.ev}`);
    assert.equal(p.anchorId, p.legs[0].legId);
    assert.ok(p.pairReason.includes('Anchor:') && p.pairReason.includes('Partner:'));
    for (const leg of p.legs) {
      assert.equal(leg.status, 'pending');
      assert.equal(games.has(leg.eventId), false, `${leg.eventId} appears on two tickets`);
      games.add(leg.eventId);
    }
    // Confidence-scaled 1-2.5U band at $25/1U (2026-08-21 direction).
    assert.ok(p.stakeUnits >= 1 && p.stakeUnits <= 2.5, `units in [1, 2.5], got ${p.stakeUnits}`);
    assert.equal(p.suggested_stake, p.stakeUnits * 25);
    assert.equal(p.meetsStandard, true);
    assert.equal(p.flagReason, null);
    // A ticket spans two markets, so it carries no closing line.
    assert.equal(p.clv, null);
  }
});

test('a lone -260 leg is neither a ticket nor a straight play — heavier than the band, it posts nothing', async () => {
  const { env } = makeKvStore();
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => [makeFav('solo')] });
  assert.equal(result.skipped, false);
  assert.equal(result.count, 0);
});

test('a favourite standing inside the band on its own fills a slot as a straight play when no ticket takes it', async () => {
  const { env } = makeKvStore();
  // -160/+140 with one book at -125: 1.8x, read 60% by the market, +8% EV —
  // the -146 moneyline on the winning slips. Nothing pairs with it inside
  // the band (1.8 x anything favourite-side lands past +100), so it posts
  // as the straight play it is, beside the ticket the two chalks make.
  const events = [makeFav('g0'), makeFav('g1'), makeFav('light', { favoritePrice: -160, dogPrice: 140, outlier: 35 })];
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 2);
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const single = picks.find((p) => p.type !== 'combo');
  assert.ok(single, 'a straight play posted');
  assert.equal(single.eventId, 'light');
  assert.equal(single.american, -125);
  assert.equal(single.legs, undefined, 'a straight play is stored in the single-pick shape');
  assert.match(single.singleReason, /^Straight play: .* -125 stands inside the band/);
  assert.ok(single.clv, 'a moneyline single tracks its closing line');
  assert.equal(single.meetsStandard, true);
});

const wnbaProp = (id, playerName, { eventId = 'w1', statKey = 'points', american = -320, decimal = 1.3125, prob = 0.81, need = 12, point = 11.5, hoursOut = 2 } = {}) => ({
  id: `${eventId}:player_${statKey}_alternate:${playerName.toLowerCase()}:${point}:Over`, kind: 'prop', eventId,
  sportKey: 'basketball_wnba', sportTitle: 'WNBA', commenceMs: NOW + hoursOut * 3.6e6, home: `${eventId} Home`, away: `${eventId} Away`,
  marketKey: `player_${statKey}_alternate`, marketLabel: `${statKey} (alt)`, statKey, playerName,
  outcomeName: 'Over', point, need, selection: `${playerName} ${need}+ ${statKey}`, american, decimal, book: 'DraftKings',
  bookKey: 'draftkings', bettable: true, consensusProb: prob, ev: Math.round((prob * decimal - 1) * 1e4) / 1e4, score: 88, espnEventId: '7' + id.length,
  profile: { games: 20, season: 0.9, l10: 0.9, l5: 1, streak: 6, avgSeason: 18.4, avgL5: 19.2 }, edge: 0.05,
});

test("two WNBA players' props from one game post as a same game parlay", async () => {
  const { env } = makeKvStore();
  const astier = wnbaProp('a', 'Pauline Astier', { statKey: 'rebounds', american: -500, decimal: 1.2, prob: 0.87, need: 2, point: 1.5 });
  const ionescu = wnbaProp('b', 'Sabrina Ionescu');
  // No slate game at all: the prop legs arrive from the dispatcher alone.
  const result = await runTop5Batch(env, ctx, NOW, {
    fetchFullSlate: async () => [],
    fetchPropLegs: async () => [astier, ionescu],
  });
  assert.equal(result.count, 1);
  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(pick.type, 'combo');
  assert.equal(pick.sameGame, true);
  assert.equal(pick.american, -174);
  assert.deepEqual(pick.legs.map((l) => l.playerName), ['Pauline Astier', 'Sabrina Ionescu']);
  assert.ok(pick.legs.every((l) => l.sportKey === 'basketball_wnba' && l.kind === 'prop'));
  assert.match(pick.pairReason, /^Same game parlay\./);
});

test('a light alternate line posts as a straight player-prop play, settles off the boxscore and sits out CLV', async () => {
  const { env } = makeKvStore();
  // 10+ alt rushing yards at -132: a partner-grade read, no anchor to pair with.
  const stroud = {
    ...wnbaProp('s', 'C.J. Stroud', { eventId: 'g1', statKey: 'rushYds', american: -132, decimal: 1.758, prob: 0.62, need: 10, point: 9.5 }),
    sportKey: 'americanfootball_nfl', sportTitle: 'NFL', marketKey: 'player_rush_yds_alternate', marketLabel: 'Rushing Yards (alt)',
  };
  const result = await runTop5Batch(env, ctx, NOW, {
    fetchFullSlate: async () => [makeFav('g1', { outlier: 0 })],
    fetchPropLegs: async () => [stroud],
  });
  assert.equal(result.count, 1);
  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(pick.type, undefined);
  assert.equal(pick.kind, 'prop');
  assert.equal(pick.playerName, 'C.J. Stroud');
  assert.equal(pick.need, 10);
  assert.equal(pick.statKey, 'rushYds');
  assert.equal(pick.american, -132);
  assert.equal(pick.clv, null, 'an alternate line has no closing line in the featured feed');
  assert.equal(pick.profile.games, 20);
  // The grading pass reads the boxscore through the stats reader; with ESPN
  // unreachable the play stays pending rather than grading off a score.
  const graded = await runGrading(env, ctx, NOW + 6 * 3.6e6, { fetchScoresFn: async () => ({ events: [finalScore('g1', 27, 10)] }) });
  assert.equal(graded.graded, 0);
  assert.equal((await getTop5(env, { dateKey: '2026-08-05' }))[0].status, 'pending');
});

test('game legs come from NFL, NCAA football, MMA and tennis; a basketball moneyline is never a leg', async () => {
  const { env } = makeKvStore();
  const events = [
    ...favs(4, { sport: 'baseball_mlb', sportTitle: 'MLB' }),
    ...favs(2, { sport: 'basketball_nba', sportTitle: 'NBA' }).map((e) => ({ ...e, id: `nba-${e.id}` })),
    makeFav('nfl-a'), makeFav('nfl-b'),
  ];
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0].legs.map((l) => l.sportKey), ['americanfootball_nfl', 'americanfootball_nfl']);
});

test('runTop5Batch never picks a team-sport game that isn\'t happening today (e.g. NFL season odds posted months out)', async () => {
  const { env } = makeKvStore();
  const events = [
    // A real NFL line, priced months ahead of kickoff — must never surface
    // as "today's lock."
    makeFav('nfl-far-out', { hoursOut: 24 * 140 }),
    makeFav('today-a'), makeFav('today-b'),
  ];
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const legEvents = picks.flatMap((p) => p.legs.map((l) => l.eventId));
  assert.ok(!legEvents.includes('nfl-far-out'), 'the far-out NFL game must never be a leg');
  assert.deepEqual(legEvents.sort(), ['today-a', 'today-b']);
});

test('runTop5Batch excludes a team-sport game on tomorrow\'s date too, not just far-future ones', async () => {
  const { env } = makeKvStore();
  const events = [makeFav('tomorrow-a', { hoursOut: 30 }), makeFav('tomorrow-b', { hoursOut: 30 })]; // ~30h out crosses into the next ET day
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 0, 'nothing today qualifies, so no picks should be stored even though tomorrow has a real edge');
});

test('runTop5Batch tennis next-day carve-out: a match rolling just past midnight (before 2am ET) is eligible, an ordinary tomorrow-afternoon match is not', async () => {
  // Positive: 11pm ET Aug 5, with two matches at 1am ET Aug 6 — a night
  // session rolling past midnight, inside the midnight-2am ET carve-out.
  {
    const { env } = makeKvStore();
    const lateNow = Date.parse('2026-08-06T03:00:00Z'); // 11pm ET Aug 5
    const events = [
      tennisFav('tennis-1am-a', { hoursOut: 17, lastUpdate: lateNow - 600000 }), // NOW + 17h = 1am ET Aug 6
      tennisFav('tennis-1am-b', { hoursOut: 17, lastUpdate: lateNow - 600000 }),
    ];
    const result = await runTop5Batch(env, ctx, lateNow, { fetchFullSlate: async () => events });
    assert.equal(result.count, 1, 'matches rolling just past midnight stay on today\'s board');
    const picks = await getTop5(env, { dateKey: '2026-08-05' });
    assert.equal(picks.length, 1, 'and the ticket is stored under TODAY\'s date, not tomorrow\'s');
  }
  // Negative: an ordinary tomorrow-2pm-ET match must NOT be on today's
  // board — this was a real bug ("eligible all day tomorrow"), removed per
  // explicit product direction; only midnight-2am ET next-day starts count.
  {
    const { env } = makeKvStore();
    const events = [tennisFav('tennis-tomorrow-a', { hoursOut: 30 }), tennisFav('tennis-tomorrow-b', { hoursOut: 30 })]; // NOW + 30h = 2pm ET Aug 6
    const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
    assert.equal(result.count, 0, 'an ordinary next-afternoon match belongs on tomorrow\'s board, not today\'s');
  }
});

test('a ticket never reaches outside the band: a -1800 chalk and a +350 longshot are never legs', async () => {
  const { env } = makeKvStore();
  // The chalk reads ~94% and would be a fine anchor on its own, but no
  // partner here brings a 1.06x leg inside -200..+100; the longshot has no
  // favourite-side read at all. Neither may appear on any ticket.
  const chalk = makeFav('chalk', { favoritePrice: -1800, dogPrice: 1200, outlier: 300 });
  const longshot = makeOutOfRangeEvent('longshot');
  longshot.sport_key = 'americanfootball_nfl';
  longshot.sport_title = 'NFL';
  const events = [makeFav('a'), makeFav('b'), chalk, longshot];
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  const legEvents = picks.flatMap((p) => p.legs.map((l) => l.eventId));
  assert.ok(!legEvents.includes('chalk') && !legEvents.includes('longshot'), `legs were ${legEvents}`);
  for (const p of picks) assert.ok(p.american >= -200 && p.american <= 100, `${p.pickId} priced ${p.american} is outside the band`);
});

test('a -EV-only slate posts an EMPTY board — never a flagged filler', async () => {
  const { env } = makeKvStore();
  // Every book at the same price: the best price IS the consensus, so once
  // the hold is paid there is no edge left on either leg.
  const result = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(4, { outlier: 0 }) });
  assert.equal(result.skipped, false);
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 0, 'nothing clears the edge floor, so nothing posts');
});

test('runTop5Batch only skips once the board already has TOP5_COUNT picks', async () => {
  const { env } = makeKvStore();
  const events = favs(10);
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
 * (which would discard its grading progress).
 */
test('runTop5Batch tops up a short board on a later call instead of staying stuck', async () => {
  const { env } = makeKvStore();
  const thinEvents = favs(4);
  const first = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => thinEvents });
  assert.equal(first.skipped, false);
  assert.equal(first.count, 2, 'four legs make two tickets, short of the board');
  const firstPickIds = (await getTop5(env, { dateKey: '2026-08-05' })).map((p) => p.pickId);

  const fullEvents = favs(10);
  const second = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => fullEvents });
  assert.equal(second.skipped, false);
  assert.equal(second.count, TOP5_COUNT);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, TOP5_COUNT);
  for (const id of firstPickIds) {
    assert.ok(picks.some((p) => p.pickId === id), `original pick ${id} should be preserved, not replaced`);
  }
  const games = picks.flatMap((p) => p.legs.map((l) => l.eventId));
  assert.equal(new Set(games).size, games.length, 'a top-up must not reuse a game an earlier ticket holds');

  const third = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => fullEvents });
  assert.equal(third.skipped, true);
});

/**
 * Regression test for a real incident: the self-healing top-up above only
 * excluded a fresh candidate pool by exact pickId, not by the game it
 * belongs to — a later top-up call, seeing a fuller/different candidate set
 * than the first call, could legitimately score the OTHER side of a game
 * that already had a pick highest and add it as a second, contradictory
 * pick. A board must never carry two tickets touching the same game.
 */
test('runTop5Batch never adds a pick for a game that already has one, even on a later top-up call', async () => {
  const { env } = makeKvStore();
  const first = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(4) });
  assert.equal(first.count, 2);
  const lockedGames = new Set((await getTop5(env, { dateKey: '2026-08-05' })).flatMap((p) => p.legs.map((l) => l.eventId)));
  assert.deepEqual([...lockedGames].sort(), ['g0', 'g1', 'g2', 'g3']);

  // Second call (a later tick): g0 now shows its edge on the AWAY side —
  // the odds moved — alongside six fresh games. The g0 away side must NOT
  // be added as a leg beside the already-locked g0 ticket.
  const awayEdgeG0 = makeFav('g0');
  for (const [i, book] of awayEdgeG0.bookmakers.entries()) {
    book.markets[0].outcomes = [
      { name: 'g0 Home', price: 255 },
      { name: 'g0 Away', price: -320 + (i === 0 ? 60 : 0) },
    ];
  }
  const secondEvents = [awayEdgeG0, ...Array.from({ length: 6 }, (_, i) => makeFav(`g${i + 4}`))];
  const second = await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => secondEvents });
  assert.equal(second.skipped, false);

  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const games = picks.flatMap((p) => p.legs.map((l) => l.eventId));
  assert.equal(games.filter((g) => g === 'g0').length, 1, 'g0 is on exactly one ticket');
  assert.equal(new Set(games).size, games.length);
});

test('runTop5Batch excludes candidates from a segment the weekly algorithm health review has paused', async () => {
  const { env } = makeKvStore();
  await env.POTD_KV.put('algo:paused', JSON.stringify([{ key: 'americanfootball_nfl|h2h', pausedAt: NOW, reason: 'test' }]));
  const events = [makeFav('nfl-a'), makeFav('nfl-b'), tennisFav('atp-a'), tennisFav('atp-b')];
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const legs = picks.flatMap((p) => p.legs);
  assert.ok(legs.length > 0, 'the non-paused tennis segment still posts');
  assert.ok(legs.every((l) => l.sportKey !== 'americanfootball_nfl'), 'the paused NFL moneyline segment must never be a leg');
});

test('runTop5Batch uses the tuned EV floor from algo:config, not the shipped default, when one is stored', async () => {
  const { env } = makeKvStore();
  // A floor above the ~3% edge each default fixture leg carries, which the
  // shipped default (RULES.MIN_EV_PCT, 2%) lets through.
  await env.POTD_KV.put('algo:config', JSON.stringify({
    MIN_EV_PCT: TUNABLE_BOUNDS.MIN_EV_PCT.max,
    MIN_KELLY_FRACTION: TUNABLE_BOUNDS.MIN_KELLY_FRACTION.min,
    MIN_SCORE: TUNABLE_BOUNDS.MIN_SCORE.min,
  }));
  const events = favs(2);
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal((await getTop5(env, { dateKey: '2026-08-05' })).length, 0, 'the tuned floor must keep these legs off the board entirely');

  const fresh = makeKvStore();
  await runTop5Batch(fresh.env, ctx, NOW, { fetchFullSlate: async () => events });
  const defaultPicks = await getTop5(fresh.env, { dateKey: '2026-08-05' });
  assert.equal(defaultPicks.length, 1);
  assert.equal(defaultPicks[0].meetsStandard, true);
});

test('an NFL prop leg anchors a ticket when the games offer one', async () => {
  const { env } = makeKvStore();
  // One gated prop leg from a game the slate carries, plus one favourite
  // from another game: the prop leads the ticket.
  const propLeg = {
    id: 'g1:player_receptions_alternate:some player:3.5:Over', kind: 'prop', eventId: 'g1',
    sportKey: 'americanfootball_nfl', sportTitle: 'NFL', commenceMs: NOW + 2 * 3.6e6, home: 'g1 Home', away: 'g1 Away',
    marketKey: 'player_receptions_alternate', marketLabel: 'Receptions (alt)', statKey: 'receptions', playerName: 'Some Player',
    outcomeName: 'Over', point: 3.5, need: 4, selection: 'Some Player 4+ Rec', american: -380, decimal: 1.263, book: 'DraftKings',
    bookKey: 'draftkings', bettable: true, consensusProb: 0.86, ev: 0.086, score: 92, espnEventId: '401',
    profile: { games: 5, season: 1, l10: 1, l5: 1, streak: 5, avgSeason: 6.2, avgL5: 6.4 }, edge: 0.07,
  };
  const events = [makeFav('g0'), makeFav('g1', { outlier: 0 })]; // g1's own moneyline carries no edge; only its prop does
  const result = await runTop5Batch(env, ctx, NOW, {
    fetchFullSlate: async () => events,
    fetchPropLegs: async (games) => (games.some((g) => g.id === 'g1') ? [propLeg] : []),
  });
  assert.equal(result.count, 1);
  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(pick.legs[0].kind, 'prop');
  assert.equal(pick.legs[0].playerName, 'Some Player');
  assert.equal(pick.legs[0].espnEventId, '401');
  assert.equal(pick.legs[0].need, 4);
  assert.deepEqual(pick.legs[0].profile.games, 5);
  assert.equal(pick.legs[1].eventId, 'g0');
  assert.ok(pick.american >= -200 && pick.american <= 100);
  assert.match(pick.pairReason, /has landed in 100% of 5 games/);
});

/* ---------------------------------------------------------------- */
/* runClvSnapshot                                                     */
/* ---------------------------------------------------------------- */

test('runClvSnapshot leaves tickets alone — a parlay has no single closing line', async () => {
  const { env } = makeKvStore();
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(2) });
  const [before] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(before.clv, null);
  const moved = favs(2, { outlier: 90 });
  const r = await runClvSnapshot(env, ctx, NOW + 0.5 * 3.6e6, { fetchSportFn: async () => ({ events: moved }) });
  assert.equal(r.updated, 0);
});

/* ---------------------------------------------------------------- */
/* runGrading                                                         */
/* ---------------------------------------------------------------- */

test('runGrading settles a ticket leg by leg: both favourites win, the ticket wins at its combined price', async () => {
  const { env } = makeKvStore();
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(2) });
  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  const games = pick.legs.map((l) => l.eventId);

  const result = await runGrading(env, ctx, NOW + 6 * 3.6e6, {
    fetchScoresFn: async () => ({ events: games.map((g) => finalScore(g, 27, 10)) }),
  });
  assert.equal(result.graded, 1);
  const [graded] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(graded.status, 'won');
  assert.ok(graded.legs.every((l) => l.status === 'won'));
  assert.ok(Math.abs(graded.result.payout - (graded.decimal - 1) * graded.suggested_stake) < 1e-6);
});

test('one losing leg loses the ticket, and the record shows which leg missed', async () => {
  const { env } = makeKvStore();
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(2) });
  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  const [anchorGame, partnerGame] = pick.legs.map((l) => l.eventId);

  await runGrading(env, ctx, NOW + 6 * 3.6e6, {
    fetchScoresFn: async () => ({ events: [finalScore(anchorGame, 27, 10), finalScore(partnerGame, 3, 30)] }),
  });
  const [graded] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(graded.status, 'lost');
  assert.equal(graded.legs[0].status, 'won');
  assert.equal(graded.legs[1].status, 'lost');
  assert.equal(graded.result.payout, -graded.suggested_stake);
});

test('runGrading leaves a ticket pending while any leg has no completed score', async () => {
  const { env } = makeKvStore();
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(2) });
  const [pick] = await getTop5(env, { dateKey: '2026-08-05' });
  const [anchorGame] = pick.legs.map((l) => l.eventId);

  const result = await runGrading(env, ctx, NOW + 3.6e6, { fetchScoresFn: async () => ({ events: [finalScore(anchorGame, 27, 10)] }) });
  assert.equal(result.graded, 0);
  const [still] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(still.status, 'pending');
});

test('a prop leg is graded off the final boxscore', async () => {
  const { env } = makeKvStore();
  const propLeg = {
    id: 'g1:player_receptions_alternate:some player:3.5:Over', kind: 'prop', eventId: 'g1',
    sportKey: 'americanfootball_nfl', sportTitle: 'NFL', commenceMs: NOW + 2 * 3.6e6, home: 'g1 Home', away: 'g1 Away',
    marketKey: 'player_receptions_alternate', marketLabel: 'Receptions (alt)', statKey: 'receptions', playerName: 'Some Player',
    outcomeName: 'Over', point: 3.5, need: 4, selection: 'Some Player 4+ Rec', american: -380, decimal: 1.263, book: 'DraftKings',
    bookKey: 'draftkings', bettable: true, consensusProb: 0.86, ev: 0.086, score: 92, espnEventId: '401',
    profile: { games: 5, season: 1, l10: 1, l5: 1, streak: 5, avgSeason: 6.2, avgL5: 6.4 }, edge: 0.07,
  };
  await runTop5Batch(env, ctx, NOW, {
    fetchFullSlate: async () => [makeFav('g0'), makeFav('g1', { outlier: 0 })],
    fetchPropLegs: async () => [propLeg],
  });
  // The grading pass reads the prop leg's game through the shared stats
  // reader; the test's ESPN is unreachable, so the leg stays pending and
  // so does the ticket, even with the partner's game final.
  const pending = await runGrading(env, ctx, NOW + 6 * 3.6e6, { fetchScoresFn: async () => ({ events: [finalScore('g0', 27, 10)] }) });
  assert.equal(pending.graded, 0);
  const [still] = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(still.status, 'pending');
});

/* ---------------------------------------------------------------- */
/* getAllTrackedPicks / resetAllTracking                              */
/* ---------------------------------------------------------------- */

test('getAllTrackedPicks spans multiple days, resetAllTracking clears every one', async () => {
  const { env } = makeKvStore();
  const day1 = NOW;
  const day2 = NOW + 86400000;

  await runTop5Batch(env, ctx, day1, { fetchFullSlate: async () => favs(2) });
  // Day 2's games: 2h out from day2's own "now" (26h from the fixture's NOW
  // anchor), with quotes fresh as of day2.
  await runTop5Batch(env, ctx, day2, { fetchFullSlate: async () => [makeFav('d2a', { hoursOut: 26, lastUpdate: day2 - 600000 }), makeFav('d2b', { hoursOut: 26, lastUpdate: day2 - 600000 })] });

  const all = await getAllTrackedPicks(env, { now: day2, days: 5 });
  assert.equal(all.length, 2);

  const { deleted } = await resetAllTracking(env, { now: day2, days: 5 });
  assert.equal(deleted, 2);

  const afterReset = await getAllTrackedPicks(env, { now: day2, days: 5 });
  assert.equal(afterReset.length, 0);
});

/* ---------------------------------------------------------------- */
/* The board                                                          */
/* ---------------------------------------------------------------- */

test('a day spread across many hours still produces a full board of tickets', async () => {
  const { env } = makeKvStore();
  // Ten games spread from 10am to 11:30pm ET. The whole day is drawable at
  // the generation hour, so the first tick fills the board; later ticks
  // leave it alone.
  const events = Array.from({ length: 10 }, (_, i) => makeFav(`g${i}`, { hoursOut: 2 + i * 1.5, outlier: 60 + i }));
  let now = NOW;
  for (let tick = 0; tick < 40; tick++) {
    await runTop5Batch(env, ctx, now, {
      fetchFullSlate: async () => events.filter((e) => Date.parse(e.commence_time) > now),
    });
    now += 30 * 60000;
  }
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 5, `expected a full board, got ${picks.length}`);
  const games = picks.flatMap((p) => p.legs.map((l) => l.eventId));
  assert.equal(new Set(games).size, 10, 'ten distinct games across five tickets');
  for (const p of picks) {
    assert.ok(p.american >= -200 && p.american <= 100, `${p.pickId} priced ${p.american} is outside the band`);
  }
});

test('the richest pair leads the board', async () => {
  const { env } = makeKvStore();
  // One standout (a bigger outlier is more edge), plus ordinary favourites.
  const events = [makeFav('standout', { outlier: 85 }), makeFav('a'), makeFav('b'), makeFav('c')];
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.ok(picks[0].legs.some((l) => l.eventId === 'standout'), 'the standout is on the first ticket');
});

test('the board never takes the opposite side of a Full Slate or PoTD pick', async () => {
  const { env, store } = makeKvStore();
  const events = [makeFav('shared'), makeFav('other-a'), makeFav('other-b')];

  // The Full Slate already called this game's moneyline the other way.
  store.set('slate:2026-08-05:manifest', JSON.stringify({ date: '2026-08-05', pickIds: ['p1'] }));
  store.set('slate:2026-08-05:pick:p1', JSON.stringify({
    pickId: 'p1', eventId: 'shared', marketKey: 'h2h', outcomeName: 'shared Away', status: 'pending',
  }));

  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  const legs = picks.flatMap((p) => p.legs);
  assert.ok(!legs.some((l) => l.eventId === 'shared' && l.outcomeName !== 'shared Away'), 'picked the opposite side of a published Full Slate call');
});

test('a Play of the Day ticket\'s games are both off the table for Pixel\'s Picks', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-05', JSON.stringify({ date: '2026-08-05', pick: {
    type: 'combo', pickId: 'x+y', status: 'pending', eventId: 'g0', marketKey: 'h2h', outcomeName: 'g0 Home',
    legs: [{ eventId: 'g0', marketKey: 'h2h', outcomeName: 'g0 Home' }, { eventId: 'g1', marketKey: 'h2h', outcomeName: 'g1 Home' }],
  } }));
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => favs(4) });
  const picks = await getTop5(env, { dateKey: '2026-08-05' });
  const games = picks.flatMap((p) => p.legs.map((l) => l.eventId)).sort();
  assert.deepEqual(games, ['g2', 'g3']);
});

test('agreeing with another board is allowed — only the opposite side is barred', () => {
  const published = new Set(['ev1|h2h|Team A']);
  assert.equal(contradictsPublishedBoard({ eventId: 'ev1', marketKey: 'h2h', outcomeName: 'Team A' }, published), false);
  assert.equal(contradictsPublishedBoard({ eventId: 'ev1', marketKey: 'h2h', outcomeName: 'Team B' }, published), true);
  // A different market on the same game is a separate bet, not a contradiction.
  assert.equal(contradictsPublishedBoard({ eventId: 'ev1', marketKey: 'totals', outcomeName: 'Over' }, published), false);
});

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
