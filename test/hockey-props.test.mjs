/**
 * NHL prop legs (worker/src/hockey-props.js): the pure halves — finding
 * in-band shots/points/assists lines, reading the game log by key (never
 * shots by label), the current-season rule, and grading off the boxscore's
 * `shotsTotal` column rather than the "SOG"-labelled shootout one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNhlPropCandidates,
  parseNhlGamelogValues,
  nhlBoxscoreRows,
  propLegFrom,
  gradeNhlPropLeg,
  PROP_GATES,
  NHL_ALT_MARKETS,
} from '../worker/src/hockey-props.js';
import { currentSeasonBlocks, seasonColumnValues } from '../docs/prop-legs.js';

const NOW = Date.parse('2026-10-19T15:00:00Z');
const game = { eventId: 'h1', commenceMs: NOW + 3.6e6 * 5, home: 'Toronto Maple Leafs', away: 'Boston Bruins' };

const odds = (books) => ({
  bookmakers: books.map(([key, price]) => ({
    key, title: key, last_update: new Date(NOW - 600000).toISOString(),
    markets: [
      { key: 'player_shots_on_goal', outcomes: [
        { name: 'Over', description: 'Auston Matthews', point: 1.5, price },
        { name: 'Over', description: 'Auston Matthews', point: 3.5, price: -105 },
        { name: 'Under', description: 'Auston Matthews', point: 1.5, price: 210 },
      ] },
      { key: 'player_points_alternate', outcomes: [{ name: 'Over', description: 'Mitch Marner', point: 0.5, price: -260 }] },
      { key: 'player_assists', outcomes: [{ name: 'Over', description: 'Morgan Rielly', point: 0.5, price: -140 }, { name: 'Over', description: 'Morgan Rielly', point: 1.5, price: 150 }] },
    ],
  })),
});

test('shots, points and assists lines inside the band become candidates, main and alternate markets alike', () => {
  const out = extractNhlPropCandidates(odds([['draftkings', -320], ['fanduel', -300]]), game, { now: NOW });
  assert.deepEqual(out.map((c) => c.selection).sort(), ['Auston Matthews 2+ SOG', 'Auston Matthews 4+ SOG', 'Mitch Marner 1+ Pts', 'Morgan Rielly 1+ Ast']);
  const sog = out.find((c) => c.statKey === 'shots');
  assert.equal(sog.sportKey, 'icehockey_nhl');
  assert.equal(sog.sportTitle, 'NHL');
  assert.equal(sog.american, -300);
  assert.equal(sog.need, 2);
  assert.equal(out.find((c) => c.playerName === 'Morgan Rielly' && c.point === 1.5), undefined, 'the +150 line is lighter than the band');
  assert.deepEqual(Object.keys(NHL_ALT_MARKETS), ['player_shots_on_goal_alternate', 'player_points_alternate', 'player_assists_alternate']);
});

const gamelog = {
  names: ['goals', 'assists', 'points', 'plusMinus', 'shotsTotal'],
  labels: ['G', 'A', 'PTS', '+/-', 'S'],
  events: {
    a: { gameDate: '2026-10-08T23:00Z' }, b: { gameDate: '2026-10-10T23:00Z' }, c: { gameDate: '2026-10-12T23:00Z' },
    d: { gameDate: '2026-10-14T23:00Z' }, e: { gameDate: '2026-10-16T23:00Z' }, f: { gameDate: '2026-10-18T23:00Z' },
    old: { gameDate: '2026-04-10T23:00Z' },
  },
  seasonTypes: [
    { displayName: '2025-26 Regular Season', categories: [{ events: [{ eventId: 'old', stats: ['2', '1', '3', '1', '9'] }] }] },
    { displayName: '2026-27 Preseason', categories: [{ events: [{ eventId: 'pre', stats: ['0', '0', '0', '0', '1'] }] }] },
    { displayName: '2026-27 Regular Season', categories: [{ events: [
      { eventId: 'a', stats: ['1', '0', '1', '1', '4'] }, { eventId: 'c', stats: ['0', '1', '1', '0', '5'] },
      { eventId: 'b', stats: ['0', '0', '0', '-1', '3'] }, { eventId: 'd', stats: ['2', '0', '2', '2', '6'] },
      { eventId: 'e', stats: ['0', '1', '1', '0', '4'] }, { eventId: 'f', stats: ['1', '1', '2', '1', '3'] },
    ] }] },
  ],
};

test('the game log is read by key, current season only, most recent first', () => {
  assert.deepEqual(parseNhlGamelogValues(gamelog, 'shots'), [3, 4, 6, 5, 3, 4], 'last season and preseason are left out');
  assert.deepEqual(parseNhlGamelogValues(gamelog, 'points'), [2, 1, 2, 1, 0, 1]);
  assert.deepEqual(parseNhlGamelogValues({ ...gamelog, names: ['goals', 'assists', 'x', 'y', 'z'] }, 'points'), [2, 1, 2, 1, 0, 1], 'points fall back to goals + assists');
  assert.deepEqual(parseNhlGamelogValues({ ...gamelog, names: undefined }, 'shots'), [], 'shots are never read by label');
  assert.deepEqual(currentSeasonBlocks(gamelog.seasonTypes).map((b) => b.displayName), ['2026-27 Regular Season']);
  assert.deepEqual(seasonColumnValues({ seasonTypes: [] }, 0), []);
});

test('a 2+ shots line a shooter clears every night is a leg; five games is one short', () => {
  const [sog] = extractNhlPropCandidates(odds([['draftkings', -320], ['fanduel', -300]]), game, { now: NOW }).filter((c) => c.statKey === 'shots');
  const leg = propLegFrom(sog, parseNhlGamelogValues(gamelog, 'shots'));
  assert.ok(leg);
  assert.equal(leg.profile.games, 6);
  assert.equal(leg.profile.season, 1);
  assert.equal(leg.profile.avgSeason, 4.2);
  assert.ok(leg.consensusProb > 0.75);
  assert.equal(propLegFrom(sog, [4, 5, 3, 6, 4]), null);
  assert.equal(PROP_GATES.MIN_GAMES, 6);
});

const summary = {
  header: { competitions: [{ status: { type: { completed: true } } }] },
  boxscore: { players: [{
    statistics: [
      { name: 'forwards', keys: ['goals', 'assists', 'plusMinus', 'shotsTotal', 'shootoutGoals'], labels: ['G', 'A', '+/-', 'S', 'SOG'],
        athletes: [{ athlete: { displayName: 'Auston Matthews' }, stats: ['1', '1', '2', '5', '0'] }, { athlete: { displayName: 'Scratched Guy' }, stats: [] }] },
      { name: 'defenses', keys: ['goals', 'assists', 'plusMinus', 'shotsTotal', 'shootoutGoals'], labels: ['G', 'A', '+/-', 'S', 'SOG'],
        athletes: [{ athlete: { displayName: 'Morgan Rielly' }, stats: ['0', '2', '1', '2', '0'] }] },
      { name: 'goalies', keys: ['saves'], labels: ['SV'], athletes: [{ athlete: { displayName: 'Goalie' }, stats: ['30'] }] },
    ],
  }] },
};

test('boxscore rows read shots from shotsTotal, never the SOG-labelled shootout column, and points as goals + assists', () => {
  const rows = nhlBoxscoreRows(summary);
  assert.deepEqual(rows.find((r) => r.name === 'Auston Matthews'), { name: 'Auston Matthews', shots: 5, goals: 1, assists: 1, points: 2 });
  assert.deepEqual(rows.find((r) => r.name === 'Morgan Rielly'), { name: 'Morgan Rielly', shots: 2, goals: 0, assists: 2, points: 2 });
  assert.equal(rows.find((r) => r.name === 'Scratched Guy'), undefined);
  assert.equal(rows.find((r) => r.name === 'Goalie'), undefined);
  assert.deepEqual(gradeNhlPropLeg({ statKey: 'shots', point: 1.5, need: 2 }, rows[0]), { won: true, actual: 5 });
  assert.deepEqual(gradeNhlPropLeg({ statKey: 'assists', point: 1.5, need: 2 }, rows[0]), { won: false, actual: 1 });
  assert.equal(gradeNhlPropLeg({ statKey: 'shots', point: 1.5, need: 2 }, null).void, true);
});
