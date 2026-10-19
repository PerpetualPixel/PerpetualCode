/**
 * The Ladder Challenge's math and selection rules.
 *
 * The bankroll compounds, so an error here doesn't cost one pick's worth of
 * accuracy the way a flat-staked tracker's would — it compounds too. These
 * tests pin the ladder to the shape it was specified as: the $20 → $360 climb
 * scaled from the $100 → $2,050 original, the skims that bank real profit on
 * the way up, the reset that puts a busted run back at the bottom rung, and
 * (since 2026-10-19) the daily low-level props rung: two or three deep
 * player-prop lines, one rung riding at a time, a player who doesn't play
 * dropping out rather than losing the ticket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ladderPlan,
  newLadderRun,
  settleLadderPlay,
  chooseLadderParlay,
  gradeLadderParlay,
  ladderLegRejection,
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
  LADDER_SLOT,
} from '../worker/src/ladder.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';
import { seedTeamContextCacheForTests } from '../worker/src/team-form.js';

// Unit tests never touch the network: the tennis archive and the ESPN
// team-context memo are sealed empty (the honest degraded mode), and the
// prop legs and boxscores are injected per test.
seedTennisArchiveCacheForTests({ atp: null, wta: null });
seedTeamContextCacheForTests({});

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

// Monday 2026-10-19, 11:00 ET: the day's games are tonight.
const NOW = Date.parse('2026-10-19T15:00:00Z');
const TONIGHT = '2026-10-19T23:00:00Z'; // 7:00pm ET
const SUN_EARLY = '2026-10-18T17:00:00Z';

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

/** A game on tonight's slate, as the Odds API lists it. */
function game(id, sport, home, away, commenceIso = TONIGHT) {
  return { id, sport_key: sport, sport_title: sport === 'basketball_nba' ? 'NBA' : sport === 'icehockey_nhl' ? 'NHL' : 'NFL', commence_time: commenceIso, home_team: home, away_team: away, bookmakers: [] };
}
const NFL = [game('e1', 'americanfootball_nfl', 'Buffalo Bills', 'New York Jets', SUN_EARLY), game('e2', 'americanfootball_nfl', 'Baltimore Ravens', 'Cleveland Browns', SUN_EARLY), game('e3', 'americanfootball_nfl', 'Philadelphia Eagles', 'New York Giants', SUN_EARLY)];
const EARLY = NFL;
const TONIGHT_GAMES = [game('n1', 'basketball_nba', 'Boston Celtics', 'New York Knicks'), game('h1', 'icehockey_nhl', 'Toronto Maple Leafs', 'Boston Bruins'), game('n2', 'basketball_nba', 'Denver Nuggets', 'Phoenix Suns')];

/**
 * A gated prop leg as the prop pipeline hands it over: a line at `need`
 * for a player averaging `avg`, cleared in `season` of games and `l5` of
 * the last five, priced `american`. The defaults are the direction's own
 * example — a player who gets 7 rebounds a game picked to get 4.
 */
function propLeg(id, playerName, {
  eventId = 'n1', sportKey = 'basketball_nba', sportTitle = 'NBA', statKey = 'rebounds', need = 4, point = 3.5,
  avg = 7, season = 0.9, l5 = 1, games = 10, american = -250, prob = 0.82, commenceMs = Date.parse(TONIGHT), espnEventId = '401',
} = {}) {
  const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / -american;
  const g = TONIGHT_GAMES.find((x) => x.id === eventId) ?? TONIGHT_GAMES[0];
  return {
    id: `${eventId}:player_${statKey}_alternate:${playerName.toLowerCase()}:${point}:Over`, kind: 'prop', eventId,
    sportKey, sportTitle, commenceMs, home: g.home_team, away: g.away_team,
    marketKey: `player_${statKey}_alternate`, marketLabel: `${statKey} (alt)`, statKey, playerName,
    outcomeName: 'Over', point, need, selection: `${playerName} ${need}+ ${statKey}`, american, decimal, book: 'DraftKings',
    bookKey: 'draftkings', bettable: true, consensusProb: prob, ev: Math.round((prob * decimal - 1) * 1e4) / 1e4, score: 88, espnEventId,
    profile: { games, season, l10: season, l5, streak: 4, avgSeason: avg, avgL5: avg },
    edge: Math.round((prob - 1 / decimal) * 1e4) / 1e4,
  };
}

/** A completed scores-feed event for one fixture (the legacy NFL parlay grader). */
const finalScore = (event, homeScore, awayScore) => ({
  id: event.id, completed: true, commence_time: event.commence_time,
  scores: [{ name: event.home_team, score: String(homeScore) }, { name: event.away_team, score: String(awayScore) }],
});

/** A final boxscore reader: rows per (sportKey, espnEventId), null while a game isn't in. */
const statsReader = (rowsByEvent) => async (sportKey, espnEventId) => rowsByEvent[espnEventId] ?? null;

/* ---------------------------------------------------------------- */
/* The bar a leg must clear                                          */
/* ---------------------------------------------------------------- */

test('a rung leg is a line at 60% of the season average or lower, cleared in 85% of games and 80% of the last five, priced -500..-150', () => {
  assert.equal(ladderLegRejection(propLeg('a', 'Jokic'), { now: NOW }), null);
  assert.match(ladderLegRejection(propLeg('a', 'Jokic', { need: 5, point: 4.5 }), { now: NOW }), /above 60% of the 7 season average/);
  assert.match(ladderLegRejection(propLeg('a', 'Jokic', { season: 0.8 }), { now: NOW }), /80% of games this season/);
  assert.match(ladderLegRejection(propLeg('a', 'Jokic', { l5: 0.6 }), { now: NOW }), /last five/);
  assert.match(ladderLegRejection(propLeg('a', 'Jokic', { american: -130 }), { now: NOW }), /outside/);
  assert.match(ladderLegRejection(propLeg('a', 'Jokic', { american: -600 }), { now: NOW }), /outside/);
  assert.match(ladderLegRejection(propLeg('a', 'Jokic', { commenceMs: NOW - 1 }), { now: NOW }), /started/);
  assert.match(ladderLegRejection({ kind: 'game', consensusProb: 0.8, decimal: 1.3 }, { now: NOW }), /not a player prop/);
});

/* ---------------------------------------------------------------- */
/* Building the parlay                                               */
/* ---------------------------------------------------------------- */

test('the parlay is 2-3 legs, never two on one player, inside the band, ranked by the ticket\'s own EV', () => {
  const legs = [
    propLeg('a', 'Nikola Jokic', { eventId: 'n2' }),
    propLeg('b', 'Jayson Tatum', { eventId: 'n1', statKey: 'points', need: 12, point: 11.5, avg: 27, american: -300, prob: 0.85 }),
    propLeg('c', 'Jayson Tatum', { eventId: 'n1', statKey: 'rebounds', need: 4, point: 3.5, avg: 8.5, american: -250, prob: 0.82 }),
    propLeg('d', 'Auston Matthews', { eventId: 'h1', sportKey: 'icehockey_nhl', sportTitle: 'NHL', statKey: 'shots', need: 2, point: 1.5, avg: 4.2, american: -280, prob: 0.84 }),
  ];
  const parlay = chooseLadderParlay(legs);
  assert.ok(parlay);
  assert.ok(parlay.legs.length >= LADDER_MIN_LEGS && parlay.legs.length <= LADDER_MAX_LEGS);
  assert.ok(parlay.american >= LADDER_MIN_AMERICAN && parlay.american <= LADDER_MAX_AMERICAN, `priced ${parlay.american}`);
  const players = parlay.legs.map((l) => l.playerName);
  assert.equal(new Set(players).size, players.length, 'one player, one leg');
  assert.ok(parlay.ev > 0);
  // Two players from one game are fine; one player twice never is.
  const sameGame = chooseLadderParlay([legs[1], propLeg('e', 'Jaylen Brown', { eventId: 'n1', statKey: 'points', need: 12, point: 11.5, avg: 24, american: -280, prob: 0.83 })]);
  assert.ok(sameGame);
  assert.equal(chooseLadderParlay([legs[1], legs[2]]), null);
  // Nothing outside the band: two -500s pay -150, heavier than -200's 1.5x? No — 1.2 x 1.2 = 1.44, under 1.5.
  assert.equal(chooseLadderParlay([propLeg('x', 'A', { american: -500 }), propLeg('y', 'B', { eventId: 'n2', american: -500 })]), null);
});

/* ---------------------------------------------------------------- */
/* Posting a rung                                                    */
/* ---------------------------------------------------------------- */

const tonightLegs = () => [
  propLeg('a', 'Nikola Jokic', { eventId: 'n2', espnEventId: '402' }),
  propLeg('b', 'Jayson Tatum', { eventId: 'n1', statKey: 'points', need: 12, point: 11.5, avg: 27, american: -300, prob: 0.85, espnEventId: '401' }),
  propLeg('d', 'Auston Matthews', { eventId: 'h1', sportKey: 'icehockey_nhl', sportTitle: 'NHL', statKey: 'shots', need: 2, point: 1.5, avg: 4.2, american: -280, prob: 0.84, espnEventId: '403' }),
  // Too shallow for a rung: a line at 80% of the average.
  propLeg('z', 'Shallow Line', { eventId: 'n2', statKey: 'assists', need: 8, point: 7.5, avg: 10, american: -200, prob: 0.7 }),
];
const opts = (legs = tonightLegs()) => ({ fetchFullSlate: async () => TONIGHT_GAMES, fetchPropLegs: async () => legs });

test('the day\'s rung is a props parlay of deep lines across tonight\'s NBA and NHL games, with the bankroll riding', async () => {
  const { env } = makeKvStore();
  const result = await runLadderDaily(env, ctx, NOW, opts());
  assert.equal(result.skipped, false, JSON.stringify(result));
  assert.equal(result.slot.key, LADDER_SLOT.key);
  const { record } = result;
  assert.equal(record.step, 1);
  assert.equal(record.stake, LADDER_BASE);
  assert.ok(record.pick.legs.length >= 2);
  assert.ok(record.pick.legs.every((l) => l.kind === 'prop' && l.profile && l.espnEventId));
  assert.ok(!record.pick.legs.some((l) => l.playerName === 'Shallow Line'), 'a line above 60% of the average never rides');
  assert.ok(record.pick.american >= LADDER_MIN_AMERICAN && record.pick.american <= LADDER_MAX_AMERICAN);
  assert.ok(Math.abs(record.toReturn - LADDER_BASE * record.pick.decimal) < 0.02);
  assert.match(record.pick.marketLabel, /props parlay/);

  const ladder = await getLadder(env, NOW);
  assert.equal(ladder.play.pick.pickId, record.pick.pickId);
  assert.equal(ladder.state.activePlay.slot, LADDER_SLOT.key);
  assert.equal(ladder.legs.max, LADDER_MAX_LEGS);
  assert.equal(ladder.comfortRatio, 0.6);
});

test('only one rung rides at a time, and one a day: the next posts tomorrow once today\'s has settled', async () => {
  const { env } = makeKvStore();
  await runLadderDaily(env, ctx, NOW, opts());
  const again = await runLadderDaily(env, ctx, NOW + 3.6e6, opts());
  assert.equal(again.skipped, true);
  assert.match(again.reason, /a rung is riding/);

  // Every leg lands: the rung wins, the bankroll compounds, and the same day still holds.
  const rows = { 401: [{ name: 'Jayson Tatum', points: 20, rebounds: 7, assists: 5 }], 402: [{ name: 'Nikola Jokic', points: 25, rebounds: 12, assists: 9 }], 403: [{ name: 'Auston Matthews', shots: 4, goals: 1, assists: 0, points: 1 }] };
  const graded = await runLadderGrading(env, ctx, NOW + 8 * 3.6e6, { propStatsFor: statsReader(rows), fetchScoresFn: async () => ({ events: [] }) });
  assert.equal(graded.graded, true);
  const after = await getLadder(env, NOW + 8 * 3.6e6);
  assert.equal(after.play.pick.status, 'won');
  assert.equal(after.state.step, 2);
  assert.ok(after.state.bankroll > LADDER_BASE);
  const sameDay = await runLadderDaily(env, ctx, NOW + 8 * 3.6e6, opts());
  assert.match(sameDay.reason, /already been played/);
  // Tomorrow's rung rides the compounded bankroll.
  const tomorrow = Date.parse('2026-10-20T15:00:00Z');
  const next = await runLadderDaily(env, ctx, tomorrow, { fetchFullSlate: async () => TONIGHT_GAMES.map((g) => ({ ...g, commence_time: '2026-10-20T23:00:00Z' })), fetchPropLegs: async () => tonightLegs().map((l) => ({ ...l, commenceMs: Date.parse('2026-10-20T23:00:00Z') })) });
  assert.equal(next.skipped, false, JSON.stringify(next));
  assert.equal(next.record.step, 2);
  assert.ok(Math.abs(next.record.stake - after.state.bankroll) < 0.01);
});

test('a player who does not play drops out and the ticket pays the rest; a missed line busts the run', async () => {
  const { env } = makeKvStore();
  const { record } = await runLadderDaily(env, ctx, NOW, opts());
  const [a, b] = record.pick.legs;
  const rows = {};
  for (const leg of record.pick.legs) rows[leg.espnEventId] = leg === a ? [] : [{ name: leg.playerName, points: 99, rebounds: 99, assists: 99, shots: 99 }];
  await runLadderGrading(env, ctx, NOW + 8 * 3.6e6, { propStatsFor: statsReader(rows), fetchScoresFn: async () => ({ events: [] }) });
  const after = await getLadder(env, NOW + 8 * 3.6e6);
  assert.equal(after.play.pick.status, 'won');
  assert.equal(after.play.pick.legs.find((l) => l.pickId === a.pickId).status, 'void');
  assert.match(after.play.pick.result.detail, /1 leg voided and dropped out/);
  assert.ok(after.play.paidDecimal < record.pick.decimal, 'paid at the remaining legs\' price');

  const bust = makeKvStore();
  const posted = await runLadderDaily(bust.env, ctx, NOW, opts());
  const missRows = {};
  for (const leg of posted.record.pick.legs) missRows[leg.espnEventId] = [{ name: leg.playerName, points: 0, rebounds: 0, assists: 0, shots: 0 }];
  await runLadderGrading(bust.env, ctx, NOW + 8 * 3.6e6, { propStatsFor: statsReader(missRows), fetchScoresFn: async () => ({ events: [] }) });
  const busted = await getLadder(bust.env, NOW + 8 * 3.6e6);
  assert.equal(busted.play.pick.status, 'lost');
  assert.equal(busted.state.step, 1);
  assert.equal(busted.state.bankroll, LADDER_BASE);
  const history = await getLadderHistory(bust.env, { now: NOW + 8 * 3.6e6, days: 2 });
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, 'busted');
  assert.equal(history.plays.length, 1);
  assert.equal(history.plays[0].pick.result.payout, -LADDER_BASE);
});

test('a leg the boards already posted never rides, and a day with nothing deep enough holds and says why', async () => {
  const { env } = makeKvStore();
  const legs = tonightLegs();
  const top5 = [{ type: 'combo', legs: [{ legId: legs[0].id, eventId: 'n2', kind: 'prop', playerName: 'Nikola Jokic', statKey: 'rebounds', outcomeName: 'Over', point: 3.5 }] }];
  const result = await runLadderDaily(env, ctx, NOW, { ...opts(legs), getTop5Picks: async () => top5 });
  assert.equal(result.skipped, false);
  assert.ok(!result.record.pick.legs.some((l) => l.playerName === 'Nikola Jokic'));

  const thin = makeKvStore();
  const hold = await runLadderDaily(thin.env, ctx, NOW, opts([propLeg('z', 'Shallow Line', { need: 8, point: 7.5, avg: 10 })]));
  assert.equal(hold.skipped, true);
  assert.match(hold.reason, /deep enough for a rung/);
  assert.equal(hold.eligibleLegs, 0);
  const none = await runLadderDaily(makeKvStore().env, ctx, NOW, opts([]));
  assert.match(none.reason, /no player-prop line/);
  assert.equal((await getLadder(thin.env, NOW)).todayStatus.reason, hold.reason);
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
  assert.match(pushed.detail, /1 leg voided/);

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
  dateKey: '2026-10-04', runId, step, stake, slot: LADDER_SLOT,
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
  assert.equal(finishedRun.lostAt.slot, LADDER_SLOT.label);
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
