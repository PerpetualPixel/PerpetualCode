/**
 * The Ladder Challenge's math and selection rules.
 *
 * The bankroll compounds, so an error here doesn't cost one pick's worth of
 * accuracy the way a flat-staked tracker's would — it compounds too. These
 * tests pin the ladder to the shape it was specified as: the $20 → $360 climb
 * scaled from the $100 → $2,050 original, the skims that bank real profit on
 * the way up, the reset that puts a busted run back at the bottom rung, and
 * (since 2026-09-30) the NFL-parlay-per-kickoff-window rung: legs across a
 * window's games, one rung riding at a time, every player confirmed playing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ladderPlan,
  newLadderRun,
  settleLadderPlay,
  chooseLadderParlay,
  gradeLadderParlay,
  ladderSlotOf,
  ladderWindows,
  legAvailabilityBlocked,
  contradictsPick,
  runLadderDaily,
  runLadderGrading,
  getLadder,
  getLadderHistory,
  LADDER_BASE,
  LADDER_TARGET,
  LADDER_MIN_AMERICAN,
  LADDER_MAX_AMERICAN,
  LADDER_MIN_LEGS,
  LADDER_MAX_LEGS,
  LADDER_SLOTS,
} from '../worker/src/ladder.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';
import { seedTeamContextCacheForTests } from '../worker/src/team-form.js';

// Unit tests never touch the network: the tennis archive and the ESPN
// team-context memo are sealed empty (the honest degraded mode), and the
// football feed is injected per test.
seedTennisArchiveCacheForTests({ atp: null, wta: null });
seedTeamContextCacheForTests({});

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

// Sunday 2026-10-04, 11:00 ET: two hours before the early window kicks.
const NOW = Date.parse('2026-10-04T15:00:00Z');
const SUN_EARLY = '2026-10-04T17:00:00Z'; // 1:00pm ET
const SUN_LATE = '2026-10-04T20:25:00Z';  // 4:25pm ET
const SNF = '2026-10-05T00:20:00Z';       // 8:20pm ET Sunday
const MNF = '2026-10-06T00:15:00Z';       // 8:15pm ET Monday
const TNF = '2026-10-02T00:15:00Z';       // 8:15pm ET Thursday

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

const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'betrivers', 'espnbet', 'fanatics', 'hardrockbet'];

/**
 * One NFL game with a heavy home favourite: every registry book at
 * favoritePrice/awayPrice, book 0 hanging the outlier on the home side. At
 * the defaults (-500/+380, +90 outlier → -410 at DraftKings) each home leg
 * carries about +2% EV against the power-devigged consensus, and three of
 * them multiply to about +92 — squarely inside the ladder's band.
 */
function nflEvent(id, home, away, commenceIso, { favoritePrice = -500, awayPrice = 380, outlier = 90, sport = 'americanfootball_nfl' } = {}) {
  return {
    id,
    sport_key: sport,
    sport_title: 'NFL',
    commence_time: commenceIso,
    home_team: home,
    away_team: away,
    bookmakers: BOOKS.map((key, i) => ({
      key,
      title: key,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: home, price: favoritePrice + (i === 0 ? outlier : 0) },
          { name: away, price: awayPrice },
        ],
      }],
    })),
  };
}

/** A football-feed game with both starters confirmed and nobody of note out. */
function feedGame(event, { homeQb = 'Home Starter', awayQb = 'Away Starter', homeOut = '', awayOut = '', homeNotAvailable = '', season = 2026 } = {}) {
  const [home, away] = [event.home_team, event.away_team];
  return {
    league: 'nfl', sport_key: 'americanfootball_nfl', season, kickoff: event.commence_time,
    home, away, stage: 'locked',
    moneyline: null, spread: null,
    analysis: {
      availability: `${home} list ${homeQb} at quarterback and ${away} list ${awayQb} at quarterback.`,
      players: [
        { team: home, text: `QB ${homeQb} has been steady, adding roughly +1.0 points a game.${homeNotAvailable ? ` Not available: ${homeNotAvailable} (inactive) — that work is going elsewhere.` : ''}` },
        { team: away, text: `QB ${awayQb} has been steady, adding roughly +0.5 points a game.` },
      ],
      injuries: [
        { team: home, text: homeOut ? `Ruled out: ${homeOut}.` : '' },
        { team: away, text: awayOut ? `Ruled out: ${awayOut}.` : '' },
      ],
    },
  };
}

const feedFor = (events, overrides = {}) => ({ games: events.map((e) => feedGame(e, overrides[e.id] ?? {})) });

const EARLY = [
  nflEvent('e1', 'Buffalo Bills', 'New York Jets', SUN_EARLY),
  nflEvent('e2', 'Baltimore Ravens', 'Cleveland Browns', SUN_EARLY),
  nflEvent('e3', 'Philadelphia Eagles', 'New York Giants', SUN_EARLY),
];
const LATE = [
  nflEvent('l1', 'Kansas City Chiefs', 'Las Vegas Raiders', SUN_LATE),
  nflEvent('l2', 'San Francisco 49ers', 'Arizona Cardinals', SUN_LATE),
];
const NIGHT = [nflEvent('s1', 'Detroit Lions', 'Chicago Bears', SNF), nflEvent('m1', 'Dallas Cowboys', 'Washington Commanders', MNF)];
const SLATE = [...EARLY, ...LATE, ...NIGHT];

/** A completed scores-feed event for one fixture. */
const finalScore = (event, homeScore, awayScore) => ({
  id: event.id, completed: true, commence_time: event.commence_time,
  scores: [{ name: event.home_team, score: String(homeScore) }, { name: event.away_team, score: String(awayScore) }],
});

/* ---------------------------------------------------------------- */
/* Kickoff windows                                                   */
/* ---------------------------------------------------------------- */

test('kickoffs file into the NFL windows by ET weekday and hour', () => {
  assert.equal(ladderSlotOf(Date.parse(TNF)).key, 'TNF');
  assert.equal(ladderSlotOf(Date.parse(SUN_EARLY)).key, 'SUN_EARLY');
  assert.equal(ladderSlotOf(Date.parse('2026-10-04T13:30:00Z')).key, 'SUN_EARLY', 'a London 9:30am game is the early window');
  assert.equal(ladderSlotOf(Date.parse(SUN_LATE)).key, 'SUN_LATE');
  assert.equal(ladderSlotOf(Date.parse('2026-10-04T20:05:00Z')).key, 'SUN_LATE', '4:05 and 4:25 share the late window');
  assert.equal(ladderSlotOf(Date.parse(SNF)).key, 'SNF');
  assert.equal(ladderSlotOf(Date.parse(MNF)).key, 'MNF');
  assert.equal(ladderSlotOf(Date.parse('2026-12-19T21:30:00Z')).key, 'SAT');
});

test('ladderWindows groups unstarted NFL games by window, soonest first, and files each under its own ET date', () => {
  const started = nflEvent('old', 'A Team', 'B Team', '2026-10-04T13:30:00Z');
  const mlb = { ...nflEvent('mlb', 'C Team', 'D Team', SUN_EARLY), sport_key: 'baseball_mlb' };
  const windows = ladderWindows([...SLATE, started, mlb], NOW);
  assert.deepEqual(windows.map((w) => [w.slot.key, w.dateKey, w.events.length]), [
    ['SUN_EARLY', '2026-10-04', 3],
    ['SUN_LATE', '2026-10-04', 2],
    ['SNF', '2026-10-04', 1],
    ['MNF', '2026-10-05', 1],
  ]);
  assert.ok(windows.every((w) => w.events.every((e) => e.sport_key === 'americanfootball_nfl')), 'nothing but NFL');
});

/* ---------------------------------------------------------------- */
/* Building the parlay                                               */
/* ---------------------------------------------------------------- */

const leg = (id, decimal, prob, eventId = `g-${id}`) => ({ id, eventId, decimal, consensusProb: prob, ev: prob * decimal - 1, selection: id });

test('the parlay is 2-4 legs from distinct games, inside the band, ranked by the ticket\'s own EV', () => {
  assert.equal(LADDER_MIN_LEGS, 2);
  assert.equal(LADDER_MAX_LEGS, 4);
  assert.equal(LADDER_MIN_AMERICAN, -200);
  assert.equal(LADDER_MAX_AMERICAN, 100);
  // Three -400 favourites at 82%: 1.25^3 = 1.95 (+95), prob .55, EV +7.5%.
  const legs = [leg('a', 1.25, 0.82), leg('b', 1.25, 0.82), leg('c', 1.25, 0.82)];
  const parlay = chooseLadderParlay(legs, { minEv: 0.02 });
  assert.equal(parlay.legs.length, 3, 'three legs beat any pair on EV and still sit inside the band');
  assert.ok(parlay.american >= LADDER_MIN_AMERICAN && parlay.american <= LADDER_MAX_AMERICAN, `priced ${parlay.american}`);
  assert.ok(parlay.ev > 0.07);
});

test('never two legs from the same game, and nothing outside the band or below the edge floor', () => {
  // Two legs from one game (its moneyline and its spread) plus one more.
  const sameGame = [leg('ml', 1.25, 0.82, 'g-1'), leg('spread', 1.9, 0.53, 'g-1'), leg('other', 1.25, 0.82, 'g-2')];
  const parlay = chooseLadderParlay(sameGame, { minEv: 0 });
  assert.deepEqual(parlay.legs.map((l) => l.eventId).sort(), ['g-1', 'g-2']);
  assert.equal(new Set(parlay.legs.map((l) => l.eventId)).size, parlay.legs.length);

  // Two -110 legs multiply to +264: out of the band, so no ticket.
  assert.equal(chooseLadderParlay([leg('a', 1.909, 0.53), leg('b', 1.909, 0.53)]), null);
  // A single leg is not a parlay.
  assert.equal(chooseLadderParlay([leg('a', 1.6, 0.7)]), null);
  // In band, but the ticket's EV is under the floor.
  assert.equal(chooseLadderParlay([leg('a', 1.25, 0.79), leg('b', 1.25, 0.79), leg('c', 1.25, 0.79)], { minEv: 0.02 }), null);
  assert.equal(chooseLadderParlay([]), null);
});

test('among equal-EV tickets the one priced nearest -200 wins — the plan is built on 1.5x', () => {
  // Every leg here has the same prob×price (1.0954), so every pair carries
  // the same +20% EV: a+b lands on 1.5 (-200), c+d on 2.0 (+100), and a
  // mixed pair on 1.73. Three legs are out of the band.
  const near = [leg('a', Math.sqrt(1.5), Math.sqrt(0.8), 'g-1'), leg('b', Math.sqrt(1.5), Math.sqrt(0.8), 'g-2')];
  const far = [leg('c', Math.sqrt(2), Math.sqrt(0.6), 'g-3'), leg('d', Math.sqrt(2), Math.sqrt(0.6), 'g-4')];
  const parlay = chooseLadderParlay([...far, ...near], { minEv: 0 });
  assert.deepEqual(parlay.legs.map((l) => l.id).sort(), ['a', 'b']);
  assert.equal(parlay.american, -200);
});

/* ---------------------------------------------------------------- */
/* The availability gate                                             */
/* ---------------------------------------------------------------- */

const candidateFor = (event, { marketKey = 'h2h', outcomeName = event.home_team } = {}) => ({
  sportKey: 'americanfootball_nfl', home: event.home_team, away: event.away_team,
  commenceMs: Date.parse(event.commence_time), marketKey, outcomeName, eventId: event.id,
});

test('a team whose starting quarterback is ruled out is not a leg', () => {
  const feed = feedFor([EARLY[0]], { e1: { homeQb: 'Josh Allen', homeOut: 'Josh Allen (QB, inactive), Someone Else (WR, on injured reserve)' } });
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0]), feed, new Map()), /Josh Allen is ruled out/);
  // The other side is unaffected.
  assert.equal(legAvailabilityBlocked(candidateFor(EARLY[0], { outcomeName: EARLY[0].away_team }), feed, new Map()), null);
});

test('a key player listed as not available blocks the team; a total is gated on both teams', () => {
  const feed = feedFor([EARLY[0]], { e1: { homeNotAvailable: 'Star Receiver' } });
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0]), feed, new Map()), /Star Receiver.*not available/);
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0], { marketKey: 'totals', outcomeName: 'Over' }), feed, new Map()), /not available/);
  assert.equal(legAvailabilityBlocked(candidateFor(EARLY[0], { outcomeName: EARLY[0].away_team }), feed, new Map()), null);
});

test('no confirmed starting quarterback, a stale season, or no data at all blocks the leg', () => {
  const noQb = feedFor([EARLY[0]]);
  noQb.games[0].analysis.availability = `${EARLY[0].away_team} list Away Starter at quarterback.`;
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0]), noQb, new Map()), /no confirmed starting quarterback/);
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0]), feedFor([EARLY[0]], { e1: { season: 2025 } }), new Map()), /2025/);
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0]), { games: [] }, new Map()), /no availability data/);
  assert.match(legAvailabilityBlocked(candidateFor(EARLY[0]), null, null), /no availability data/);
});

test('with no feed entry, ESPN\'s injury list is the fallback and a healthy team passes', () => {
  const side = (name, outs) => ({ name, shortName: name, injuries: Array.from({ length: outs }, (_, i) => ({ name: `P${i}`, status: 'Out' })) });
  const c = candidateFor(EARLY[0]);
  const key = `${c.sportKey}|${c.home}|${c.away}`;
  const healthy = new Map([[key, { home: side(c.home, 2), away: side(c.away, 1) }]]);
  assert.equal(legAvailabilityBlocked(c, { games: [] }, healthy), null);
  const decimated = new Map([[key, { home: side(c.home, 9), away: side(c.away, 1) }]]);
  assert.match(legAvailabilityBlocked(c, { games: [] }, decimated), /9 players listed out/);
});

/* ---------------------------------------------------------------- */
/* Posting rungs                                                     */
/* ---------------------------------------------------------------- */

test('the early window posts a parlay of distinct in-band favourites, keyed to its window, with the bankroll riding', async () => {
  const { env, store } = makeKvStore();
  const result = await runLadderDaily(env, ctx, NOW, { fetchFullSlate: async () => SLATE, gridironFeed: feedFor(SLATE) });
  assert.equal(result.skipped, false, JSON.stringify(result));
  assert.equal(result.slot.key, 'SUN_EARLY');
  const { pick } = result.record;
  assert.equal(pick.marketKey, 'parlay');
  assert.ok(pick.legs.length >= LADDER_MIN_LEGS && pick.legs.length <= LADDER_MAX_LEGS);
  assert.ok(pick.american >= LADDER_MIN_AMERICAN && pick.american <= LADDER_MAX_AMERICAN, `priced ${pick.american}`);
  assert.equal(new Set(pick.legs.map((l) => l.eventId)).size, pick.legs.length, 'one leg per game');
  assert.ok(pick.legs.every((l) => EARLY.some((e) => e.id === l.eventId)), 'legs come from the window\'s games only');
  assert.ok(pick.legs.every((l) => l.book === 'draftkings'), 'every leg at the bettable outlier');
  assert.equal(result.record.stake, LADDER_BASE);
  assert.equal(result.record.toReturn, Math.round(LADDER_BASE * pick.decimal * 100) / 100);
  assert.ok(store.has('ladder:play:2026-10-04:SUN_EARLY'));
  assert.deepEqual(JSON.parse(store.get('ladder:plays:2026-10-04')).slots, ['SUN_EARLY']);
  assert.deepEqual(JSON.parse(store.get('ladder:state')).activePlay, { dateKey: '2026-10-04', slot: 'SUN_EARLY' });
});

test('only one rung rides at a time: the next window waits until the last rung settles, then posts from the games still to kick', async () => {
  const { env } = makeKvStore();
  const opts = { fetchFullSlate: async () => SLATE, gridironFeed: feedFor(SLATE) };
  const first = await runLadderDaily(env, ctx, NOW, opts);
  assert.equal(first.slot.key, 'SUN_EARLY');

  // 3:30pm ET: the early games are in but ungraded — the late window is
  // inside its lead time and still must not post.
  const midAfternoon = Date.parse('2026-10-04T19:30:00Z');
  const held = await runLadderDaily(env, ctx, midAfternoon, opts);
  assert.equal(held.skipped, true);
  assert.match(held.reason, /a rung is riding/);

  // The early games all land for the favourites → the rung wins.
  await runLadderGrading(env, ctx, midAfternoon, {
    fetchScoresFn: async () => ({ events: EARLY.map((e) => finalScore(e, 27, 10)) }),
  });
  const state = JSON.parse((await env.POTD_KV.get('ladder:state')));
  assert.equal(state.step, 2);
  assert.equal(state.activePlay, null);
  assert.ok(state.bankroll > LADDER_BASE, `bankroll compounded to ${state.bankroll}`);

  // Now the late window posts — from its unstarted games, staking the new bankroll.
  const second = await runLadderDaily(env, ctx, midAfternoon, opts);
  assert.equal(second.skipped, false, JSON.stringify(second));
  assert.equal(second.slot.key, 'SUN_LATE');
  assert.equal(second.record.step, 2);
  assert.equal(second.record.stake, state.bankroll);
  assert.ok(second.record.pick.legs.every((l) => LATE.some((e) => e.id === l.eventId)));

  // Both rungs are in the day's history, in order.
  const history = await getLadderHistory(env, { now: midAfternoon, days: 2 });
  assert.deepEqual(history.plays.map((p) => p.slot.key), ['SUN_EARLY', 'SUN_LATE']);
});

test('a losing leg busts the rung and the run restarts at the base', async () => {
  const { env } = makeKvStore();
  const opts = { fetchFullSlate: async () => SLATE, gridironFeed: feedFor(SLATE) };
  const posted = await runLadderDaily(env, ctx, NOW, opts);
  const lostLeg = posted.record.pick.legs[0];
  const later = Date.parse('2026-10-04T20:00:00Z');
  await runLadderGrading(env, ctx, later, {
    fetchScoresFn: async () => ({ events: EARLY.map((e) => finalScore(e, e.id === lostLeg.eventId ? 3 : 27, 10)) }),
  });
  const ladder = await getLadder(env, later);
  assert.equal(ladder.state.step, 1);
  assert.equal(ladder.state.bankroll, LADDER_BASE);
  assert.equal(ladder.play.pick.status, 'lost');
  assert.equal(ladder.play.pick.legs.find((l) => l.eventId === lostLeg.eventId).status, 'lost');
  const { runs } = await getLadderHistory(env, { now: later, days: 2 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].endedBy, 'loss');
  assert.equal(runs[0].lostAt.slot, 'Sunday early window');
});

test('a team with its quarterback out never becomes a leg, and a window with too few clean favourites holds and says why', async () => {
  const { env, store } = makeKvStore();
  // Bills' QB out, Ravens' star receiver unavailable: only the Eagles are
  // clean, and one leg is not a parlay.
  const feed = feedFor(SLATE, {
    e1: { homeQb: 'Josh Allen', homeOut: 'Josh Allen (QB, inactive)' },
    e2: { homeNotAvailable: 'Zay Flowers' },
  });
  const result = await runLadderDaily(env, ctx, NOW, { fetchFullSlate: async () => SLATE, gridironFeed: feed });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /Sunday early window: nothing builds/);
  assert.equal(result.rejected.availability, 2, 'the two gated home sides');
  assert.equal(JSON.parse(store.get('ladder:status:2026-10-04')).slot.key, 'SUN_EARLY');
  assert.equal(store.has('ladder:play:2026-10-04:SUN_EARLY'), false);

  // With the Bills' starter back the window builds.
  const healthy = feedFor(SLATE, { e2: { homeNotAvailable: 'Zay Flowers' } });
  const posted = await runLadderDaily(env, ctx, NOW, { fetchFullSlate: async () => SLATE, gridironFeed: healthy });
  assert.equal(posted.skipped, false);
  assert.ok(!posted.record.pick.legs.some((l) => l.eventId === 'e2'), 'the Ravens leg stays out');
});

test('no NFL on the slate holds; a window more than the lead time away waits and names itself', async () => {
  const { env } = makeKvStore();
  const mlbOnly = [{ ...nflEvent('x', 'A', 'B', SUN_EARLY), sport_key: 'baseball_mlb' }];
  const none = await runLadderDaily(env, ctx, NOW, { fetchFullSlate: async () => mlbOnly, gridironFeed: { games: [] } });
  assert.equal(none.skipped, true);
  assert.match(none.reason, /NFL parlays only/);

  const dawn = Date.parse('2026-10-04T09:00:00Z'); // 5am ET, eight hours before the 1pm games
  const early = await runLadderDaily(env, ctx, dawn, { fetchFullSlate: async () => SLATE, gridironFeed: feedFor(SLATE) });
  assert.equal(early.skipped, true);
  assert.match(early.reason, /next rung: Sunday early window/);
  assert.equal(early.next.slot.key, 'SUN_EARLY');
  const ladder = await getLadder(env, dawn);
  assert.equal(ladder.play, null);
  assert.equal(ladder.todayStatus.waiting, true);
});

test('preseason and non-NFL games never reach a rung, and a window is never drawn twice', async () => {
  const { env } = makeKvStore();
  const pre = [nflEvent('p1', 'A', 'B', SUN_EARLY, { sport: 'americanfootball_nfl_preseason' }), nflEvent('p2', 'C', 'D', SUN_EARLY, { sport: 'americanfootball_nfl_preseason' })];
  const result = await runLadderDaily(env, ctx, NOW, { fetchFullSlate: async () => pre, gridironFeed: feedFor(pre) });
  assert.equal(result.skipped, true);

  const opts = { fetchFullSlate: async () => SLATE, gridironFeed: feedFor(SLATE) };
  await runLadderDaily(env, ctx, NOW, opts);
  await runLadderGrading(env, ctx, Date.parse('2026-10-04T20:00:00Z'), {
    fetchScoresFn: async () => ({ events: EARLY.map((e) => finalScore(e, 27, 10)) }),
  });
  // Early is settled and played; the next draw is the late window, not early again.
  const next = await runLadderDaily(env, ctx, Date.parse('2026-10-04T20:00:00Z'), opts);
  assert.equal(next.slot.key, 'SUN_LATE');
});

/* ---------------------------------------------------------------- */
/* Grading a parlay                                                  */
/* ---------------------------------------------------------------- */

const parlayPick = () => ({
  suggested_stake: 20,
  decimal: 1.953,
  legs: EARLY.map((e) => ({
    pickId: e.id, eventId: e.id, home: e.home_team, away: e.away_team, marketKey: 'h2h',
    outcomeName: e.home_team, point: null, decimal: 1.25, status: 'pending',
  })),
});

test('a parlay stays open until every leg is in, loses the moment any leg loses, and pays the remaining legs when one pushes', () => {
  const open = gradeLadderParlay(parlayPick(), [finalScore(EARLY[0], 20, 10)]);
  assert.equal(open, null, 'two legs still pending');

  const lost = gradeLadderParlay(parlayPick(), [finalScore(EARLY[0], 20, 10), finalScore(EARLY[1], 3, 30)]);
  assert.equal(lost.won, false, 'a lost leg settles the ticket without waiting on the third game');
  assert.equal(lost.payout, -20);

  const won = gradeLadderParlay(parlayPick(), EARLY.map((e) => finalScore(e, 20, 10)));
  assert.equal(won.won, true);
  assert.ok(Math.abs(won.decimal - 1.953125) < 1e-9);
  assert.equal(won.payout, Math.round(20 * 0.953125 * 100) / 100);

  // A tied game voids that moneyline leg; the ticket pays the other two.
  const pushed = gradeLadderParlay(parlayPick(), [finalScore(EARLY[0], 20, 10), finalScore(EARLY[1], 17, 17), finalScore(EARLY[2], 20, 10)]);
  assert.equal(pushed.won, true);
  assert.ok(Math.abs(pushed.decimal - 1.5625) < 1e-9);
  assert.match(pushed.detail, /1 leg pushed/);

  const allVoid = gradeLadderParlay(parlayPick(), EARLY.map((e) => finalScore(e, 17, 17)));
  assert.equal(allVoid.void, true);
});

/* ---------------------------------------------------------------- */
/* The plan                                                          */
/* ---------------------------------------------------------------- */

test('the plan is the $100 ladder scaled to a $20 start, to the dollar', () => {
  const plan = ladderPlan();
  assert.equal(plan.base, 20);
  assert.equal(plan.target, 360);
  assert.deepEqual(
    plan.rungs.map((r) => [r.stake, r.returns, r.takeOut, r.carry]),
    [
      [20, 30, 0, 30],
      [30, 45, 5, 40],
      [40, 60, 0, 60],
      [60, 90, 0, 90],
      [90, 135, 15, 120],
      [120, 180, 0, 180],
      [180, 270, 30, 240],
      [240, 360, 0, 360],
    ],
  );
  assert.equal(plan.banked, 50);
  assert.equal(plan.final, 360);
  assert.equal(plan.totalValue, 410);
});

test('the plan terminates rather than spinning if the constants are nonsense', () => {
  const plan = ladderPlan({ base: 100, milestones: [], target: 10 });
  assert.equal(plan.rungs.length, 0);
  assert.equal(plan.final, 100);
});

/* ---------------------------------------------------------------- */
/* Settling a rung                                                   */
/* ---------------------------------------------------------------- */

const playAt = (stake, { decimal = 1.5, step = 1, runId = 'run-1' } = {}) => ({
  dateKey: '2026-10-04', runId, step, stake, slot: LADDER_SLOTS.SUN_EARLY,
  pick: { decimal, selection: 'A + B' },
});

test('a winning rung compounds the whole bankroll forward and clears the riding marker', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1', activePlay: { dateKey: '2026-10-04', slot: 'SUN_EARLY' } };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(20), { won: true }, NOW);
  assert.equal(next.bankroll, 30);
  assert.equal(next.banked, 0);
  assert.equal(next.step, 2);
  assert.equal(next.wins, 1);
  assert.equal(next.activePlay, null);
  assert.equal(finishedRun, null);
});

test('a ticket that paid a different price than posted (a pushed leg) compounds the price it paid', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1' };
  const { state: next } = settleLadderPlay(state, playAt(20, { decimal: 1.95 }), { won: true, decimal: 1.5625 }, NOW);
  assert.equal(next.bankroll, 31.25);
});

test('passing a milestone skims the excess into banked profit, and only ever once', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1', bankroll: 30, step: 2 };
  const { state: next } = settleLadderPlay(state, playAt(30, { step: 2 }), { won: true }, NOW);
  assert.equal(next.bankroll, 40);
  assert.equal(next.banked, 5);
  assert.deepEqual(next.skimmed, [40]);
  const { state: again } = settleLadderPlay({ ...next, step: 3 }, playAt(40, { step: 3 }), { won: true }, NOW);
  assert.equal(again.bankroll, 60, 'past the $40 mark already — nothing more comes off it');
  assert.equal(again.banked, 5);
});

test('a losing rung ends the run at the bottom and keeps only what was banked', () => {
  const state = {
    ...newLadderRun(NOW), runId: 'run-1', bankroll: 120, banked: 20, skimmed: [40], step: 6, wins: 5,
  };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(120, { step: 6 }), { won: false }, NOW);
  assert.equal(finishedRun.status, 'busted');
  assert.equal(finishedRun.endedBy, 'loss');
  assert.equal(finishedRun.lostAt.step, 6);
  assert.equal(finishedRun.lostAt.stake, 120);
  assert.equal(finishedRun.lostAt.slot, 'Sunday early window');
  assert.equal(finishedRun.totalValue, 20);
  assert.equal(next.bankroll, LADDER_BASE);
  assert.equal(next.step, 1);
  assert.equal(next.banked, 0);
  assert.equal(next.wins, 0);
  assert.equal(next.status, 'active');
  assert.notEqual(next.runId, 'run-1', 'a reset is a new run, not the old one rewound');
  assert.equal(next.previousRunId, 'run-1');
});

test('a void leaves the ladder exactly where it was, so the rung is replayed', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1', bankroll: 90, banked: 5, step: 5, wins: 3, activePlay: { dateKey: 'x', slot: 'SNF' } };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(90, { step: 5 }), { void: true }, NOW);
  assert.equal(finishedRun, null);
  assert.equal(next.bankroll, 90);
  assert.equal(next.step, 5);
  assert.equal(next.wins, 3);
  assert.equal(next.activePlay, null, 'a voided rung is not riding any more');
});

test('hitting the target completes the climb and starts a fresh one', () => {
  const state = {
    ...newLadderRun(NOW), runId: 'run-1', bankroll: 240, banked: 50, skimmed: [40, 120, 240], step: 8, wins: 7,
  };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(240, { step: 8 }), { won: true }, NOW);
  assert.equal(finishedRun.status, 'complete');
  assert.equal(finishedRun.endedBy, 'target');
  assert.equal(finishedRun.bankroll, 360);
  assert.equal(finishedRun.totalValue, 410);
  assert.equal(next.bankroll, LADDER_BASE);
  assert.equal(next.step, 1);
});

test('eight straight wins at -200 walk the real bankroll exactly along the plan', () => {
  const plan = ladderPlan();
  let state = { ...newLadderRun(NOW), runId: 'run-1' };
  let finished = null;
  for (const rung of plan.rungs) {
    assert.equal(state.bankroll, rung.stake, `rung ${rung.step} should stake the whole bankroll`);
    const settled = settleLadderPlay(state, playAt(state.bankroll, { step: rung.step }), { won: true }, NOW);
    finished = settled.finishedRun ?? finished;
    state = settled.state;
  }
  assert.ok(finished, 'the eighth win completes the climb');
  assert.equal(finished.bankroll, LADDER_TARGET);
  assert.equal(finished.banked, plan.banked);
  assert.equal(finished.wins, plan.rungs.length);
});

/* ---------------------------------------------------------------- */
/* Not arguing with the rest of the board                            */
/* ---------------------------------------------------------------- */

const postedPick = { eventId: 'e-1', marketKey: 'h2h', outcomeName: 'Bills', point: null };

test('the opposite side of a posted pick is a contradiction; the same side, a different market or a different game is not', () => {
  assert.equal(contradictsPick({ ...postedPick, outcomeName: 'Jets' }, postedPick), true);
  assert.equal(contradictsPick({ ...postedPick }, postedPick), false);
  assert.equal(contradictsPick({ eventId: 'e-1', marketKey: 'totals', outcomeName: 'Over', point: 44.5 }, postedPick), false);
  assert.equal(contradictsPick({ ...postedPick, eventId: 'e-2', outcomeName: 'Jets' }, postedPick), false);
  const total = { eventId: 'e-1', marketKey: 'totals', outcomeName: 'Over', point: 44.5 };
  assert.equal(contradictsPick({ ...total, point: 47.5 }, total), true);
});
