/**
 * NBA alternate-line prop legs (worker/src/basketball-props.js) and
 * the shared prop-leg maths (docs/prop-legs.js) — the pure halves: finding
 * lines in the -650..+100 band, reading a game log, gating on hit rate,
 * grading off the boxscore with a DNP voiding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBasketballAltCandidates,
  parseBasketballGamelogValues,
  basketballBoxscoreRows,
  propLegFrom,
  gradeBasketballPropLeg,
  PROP_GATES,
  BASKETBALL_SPORTS,
} from '../worker/src/basketball-props.js';
import { PROP_LEG_DECIMAL, needFor, propEdge, hitProfile } from '../docs/prop-legs.js';
import { isAnchorLeg, legEligible, singleEligible } from '../docs/tickets.js';

const NOW = Date.parse('2026-10-04T15:00:00Z');
const game = { eventId: 'w1', sportKey: 'basketball_nba', commenceMs: NOW + 3.6e6 * 4, home: 'New York Liberty', away: 'Connecticut Sun' };

const altOdds = (books) => ({
  bookmakers: books.map(([key, price]) => ({
    key, title: key, last_update: new Date(NOW - 600000).toISOString(),
    markets: [
      { key: 'player_points_alternate', outcomes: [
        { name: 'Over', description: 'Sabrina Ionescu', point: 11.5, price },
        { name: 'Over', description: 'Sabrina Ionescu', point: 19.5, price: 125 },
        { name: 'Under', description: 'Sabrina Ionescu', point: 11.5, price: 240 },
      ] },
      { key: 'player_rebounds_alternate', outcomes: [
        { name: 'Over', description: 'Pauline Astier', point: 1.5, price: -500 },
        { name: 'Over', description: 'Breanna Stewart', point: 3.5, price: -700 },
      ] },
      { key: 'player_assists_alternate', outcomes: [
        { name: 'Over', description: 'Allisha Gray', point: 1.5, price: -132 },
      ] },
    ],
  })),
});

test('the prop band runs -650 to +100: a -132 line is a candidate, +125 and -700 are not', () => {
  assert.ok(Math.abs(PROP_LEG_DECIMAL.MIN - (1 + 100 / 650)) < 1e-9);
  assert.equal(PROP_LEG_DECIMAL.MAX, 2);
  const out = extractBasketballAltCandidates(altOdds([['draftkings', -320], ['fanduel', -300]]), game, { now: NOW });
  assert.deepEqual(out.map((c) => c.selection).sort(), ['Allisha Gray 2+ Ast', 'Pauline Astier 2+ Reb', 'Sabrina Ionescu 12+ Pts']);
  const ionescu = out.find((c) => c.playerName === 'Sabrina Ionescu');
  assert.equal(ionescu.sportTitle, 'NBA');
  assert.equal(ionescu.statKey, 'points');
  assert.equal(ionescu.need, 12);
  assert.equal(ionescu.american, -300, 'the best registry price');
  assert.equal(ionescu.id, 'w1:player_points_alternate:sabrina ionescu:11.5:Over');
  assert.equal(extractBasketballAltCandidates(altOdds([['draftkings', -320]]), game, { now: NOW }).length, 0, 'one book is not a market');
});

test('needFor rounds a .5 line up and makes an integer line be beaten', () => {
  assert.equal(needFor(11.5), 12);
  assert.equal(needFor(12), 13);
});

const gamelog = {
  names: ['minutes', 'rebounds', 'assists', 'points'],
  labels: ['MIN', 'REB', 'AST', 'PTS'],
  events: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`e${i}`, { gameDate: `2026-07-${String(10 + i).padStart(2, '0')}T23:00Z` }])),
  seasonTypes: [
    { displayName: '2026 Preseason', categories: [{ events: [{ eventId: 'pre', stats: ['12', '1', '0', '4'] }] }] },
    { displayName: '2026 Regular Season', categories: [{ events: [
      { eventId: 'e0', stats: ['31', '5', '6', '14'] }, { eventId: 'e3', stats: ['33', '4', '7', '19'] },
      { eventId: 'e1', stats: ['30', '6', '5', '16'] }, { eventId: 'e2', stats: ['29', '3', '8', '11'] },
      { eventId: 'e4', stats: ['34', '5', '6', '22'] }, { eventId: 'e5', stats: ['28', '7', '4', '15'] },
      { eventId: 'e6', stats: ['32', '4', '9', '18'] }, { eventId: 'e7', stats: ['30', '5', '6', '13'] },
    ] }] },
  ],
};

test('game-log values come back most recent first, regular season only, by key or label', () => {
  assert.deepEqual(parseBasketballGamelogValues(gamelog, 'points'), [13, 18, 15, 22, 19, 11, 16, 14]);
  assert.deepEqual(parseBasketballGamelogValues({ ...gamelog, names: undefined }, 'rebounds'), [5, 4, 7, 5, 4, 3, 6, 5]);
  assert.deepEqual(parseBasketballGamelogValues(gamelog, 'steals'), []);
});

test('a line the player clears most nights with an edge over its price is a leg; the gates need six games', () => {
  const [ionescu] = extractBasketballAltCandidates(altOdds([['draftkings', -320], ['fanduel', -300]]), game, { now: NOW })
    .filter((c) => c.playerName === 'Sabrina Ionescu');
  const values = parseBasketballGamelogValues(gamelog, 'points');
  const leg = propLegFrom(ionescu, values);
  assert.ok(leg, '7 of 8 at 12+ (and 5 of 5 recently) clears 75%/80% and beats -300');
  assert.equal(leg.profile.games, 8);
  assert.ok(Math.abs(leg.profile.season - 7 / 8) < 1e-9);
  assert.equal(leg.profile.l5, 1);
  assert.equal(leg.profile.avgSeason, 16);
  assert.ok(leg.consensusProb > 1 / leg.decimal);
  assert.equal(isAnchorLeg(leg), true);
  assert.equal(legEligible(leg, { minEv: 0.02, minKelly: 0.005, minScore: 50 }), true);
  assert.equal(propLegFrom(ionescu, values.slice(0, 5)), null, 'five games is short of the basketball floor');
  assert.equal(PROP_GATES.MIN_GAMES, 6);
  // Shrinkage: a perfect short sample does not claim 100%.
  assert.ok(propEdge(hitProfile([20, 20, 20, 20, 20, 20], 12), 1.3333) < 1 - 0.75);
});

test('a -132 line the player clears is a partner or a straight play, not an anchor', () => {
  const [gray] = extractBasketballAltCandidates(altOdds([['draftkings', -132], ['fanduel', -130]]), game, { now: NOW })
    .filter((c) => c.playerName === 'Allisha Gray');
  // 8 of 10 and 4 of the last 5: a real edge over -130, but shrunk toward the price it reads 68%, short of anchor grade.
  const leg = propLegFrom(gray, [3, 2, 4, 1, 5, 1, 3, 2, 4, 2]);
  assert.ok(leg.consensusProb > 0.6 && leg.consensusProb < 0.72, `reads ${leg.consensusProb}`);
  assert.ok(leg);
  assert.equal(isAnchorLeg(leg), false);
  assert.equal(legEligible(leg, {}), true);
  assert.equal(singleEligible(leg, { minEv: 0.02 }), true);
});

const summary = {
  header: { competitions: [{ status: { type: { completed: true } } }] },
  boxscore: { players: [{
    statistics: [{
      keys: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'rebounds', 'assists', 'points'],
      labels: ['MIN', 'FG', 'REB', 'AST', 'PTS'],
      athletes: [
        { athlete: { displayName: 'Sabrina Ionescu' }, stats: ['33', '6-14', '4', '7', '17'] },
        { athlete: { displayName: 'Pauline Astier' }, stats: ['14', '1-3', '2', '1', '2'] },
        { athlete: { displayName: 'Injured Player' }, didNotPlay: true, stats: [] },
      ],
    }],
  }] },
};

test('boxscore rows carry points, rebounds and assists; a DNP has no row and voids', () => {
  const rows = basketballBoxscoreRows(summary);
  assert.deepEqual(rows.find((r) => r.name === 'Sabrina Ionescu'), { name: 'Sabrina Ionescu', rebounds: 4, assists: 7, points: 17 });
  assert.equal(rows.find((r) => r.name === 'Injured Player'), undefined);
  const astier = rows.find((r) => r.name === 'Pauline Astier');
  assert.deepEqual(gradeBasketballPropLeg({ statKey: 'rebounds', point: 1.5, need: 2 }, astier), { won: true, actual: 2 });
  assert.deepEqual(gradeBasketballPropLeg({ statKey: 'points', point: 11.5, need: 12 }, astier), { won: false, actual: 2 });
  assert.equal(gradeBasketballPropLeg({ statKey: 'points', point: 11.5, need: 12 }, null).void, true);
  assert.equal(gradeBasketballPropLeg({ statKey: 'rebounds', point: 2, need: 3 }, astier).void, true, 'landed exactly on an integer line');
});

test('the NBA maps to its ESPN path', () => {
  assert.deepEqual(Object.keys(BASKETBALL_SPORTS), ['basketball_nba']);
  assert.equal(BASKETBALL_SPORTS.basketball_nba.espn, 'nba');
});

test('the early-season bridge tops a short current season up from the end of last season, and names the prior season by its end year', async () => {
  const { bridgeSeasonValues, priorSeasonKey, BRIDGE_GAMES } = await import('../docs/prop-legs.js');
  assert.equal(BRIDGE_GAMES, 10);
  assert.deepEqual(bridgeSeasonValues([25, 22], [30, 28, 27, 26, 24, 23, 21, 20, 19, 18, 17], { minGames: 6 }), { values: [25, 22, 30, 28, 27, 26, 24, 23, 21, 20], bridged: 8 });
  assert.deepEqual(bridgeSeasonValues([], [30, 28], { minGames: 6 }), { values: [30, 28], bridged: 2 });
  assert.deepEqual(bridgeSeasonValues([1, 2, 3, 4, 5, 6], [9, 9], { minGames: 6 }), { values: [1, 2, 3, 4, 5, 6], bridged: 0 }, 'a season at the gate borrows nothing');
  assert.equal(priorSeasonKey({ seasonTypes: [{ displayName: '2026-27 Regular Season' }, { displayName: '2026-27 Preseason' }] }), 2026);
  assert.equal(priorSeasonKey(null, Date.parse('2026-10-20T12:00:00Z')), 2026, 'October: the season that ended this year');
  assert.equal(priorSeasonKey({}, Date.parse('2027-03-01T12:00:00Z')), 2026, 'March: last year\'s key');
});

test('basketballStatRows reads plain columns, the made count of made-attempted columns, and sums a combined stat game by game', async () => {
  const { basketballStatRows, NBA_TREND_MARKETS, NBA_TREND_MARKET_PARAMS } = await import('../worker/src/basketball-props.js');
  const log = {
    names: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'totalRebounds', 'assists', 'blocks', 'steals', 'turnovers', 'points'],
    labels: ['MIN', 'FG', '3PT', 'REB', 'AST', 'BLK', 'STL', 'TO', 'PTS'],
    events: { e1: { gameDate: '2026-10-25T00:00Z', opponent: { abbreviation: 'BOS' } }, e2: { gameDate: '2026-10-23T00:00Z', opponent: { abbreviation: 'PHI' } } },
    seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ events: [
      { eventId: 'e2', stats: ['34', '8-15', '3-7', '5', '7', '1', '2', '3', '21'] },
      { eventId: 'e1', stats: ['36', '10-18', '4-9', '6', '9', '0', '1', '2', '28'] },
    ] }] }],
  };
  assert.deepEqual(basketballStatRows(log, 'points').map((r) => r.value), [28, 21], 'most recent first');
  assert.deepEqual(basketballStatRows(log, 'threes').map((r) => r.value), [4, 3], 'the made count');
  assert.deepEqual(basketballStatRows(log, 'fgm').map((r) => r.value), [10, 8]);
  assert.deepEqual(basketballStatRows(log, 'pra').map((r) => r.value), [43, 33]);
  assert.deepEqual(basketballStatRows(log, 'ra').map((r) => r.value), [15, 12]);
  assert.deepEqual(basketballStatRows(log, 'stocks').map((r) => r.value), [1, 3]);
  assert.equal(basketballStatRows(log, 'pra')[0].opponent, 'BOS', 'a combined row keeps the game\'s files');
  assert.deepEqual(basketballStatRows({ ...log, names: log.names.filter((n) => n !== 'assists'), labels: log.labels.filter((l) => l !== 'AST') }, 'pa'), [], 'a combo missing a part is empty, never summed short');
  assert.equal(Object.keys(NBA_TREND_MARKETS).length, 23);
  assert.equal(NBA_TREND_MARKET_PARAMS.length, 2, 'the full list, then the core eight');
  assert.ok(NBA_TREND_MARKET_PARAMS[1].split(',').every((k) => NBA_TREND_MARKETS[k]));
});
