/**
 * NFL alternate-line prop legs (worker/src/football-props.js) — the pure
 * halves: finding safe-band lines in a per-event odds payload, reading a
 * player's game log without guessing the column, gating a line on its
 * measured hit rate, and grading it off the final boxscore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNflAltCandidates,
  gamelogStatIndex,
  parseNflGamelogValues,
  propLegFrom,
  clearsPropGates,
  nflBoxscoreRows,
  gradeNflPropLeg,
  PROP_GATES,
} from '../worker/src/football-props.js';
import { isAnchorLeg, legEligible } from '../docs/tickets.js';

const NOW = Date.parse('2026-10-04T15:00:00Z');
const game = { eventId: 'e1', sportKey: 'americanfootball_nfl', sportTitle: 'NFL', commenceMs: NOW + 3.6e6 * 2, home: 'Buffalo Bills', away: 'New York Jets' };

const altOdds = (books) => ({
  bookmakers: books.map(([key, price]) => ({
    key, title: key, last_update: new Date(NOW - 600000).toISOString(),
    markets: [{
      key: 'player_reception_yds_alternate',
      outcomes: [
        { name: 'Over', description: 'Khalil Shakir', point: 49.5, price },
        { name: 'Over', description: 'Khalil Shakir', point: 74.5, price: 110 },
        { name: 'Over', description: 'Dalton Kincaid', point: 29.5, price: -700 },
      ],
    }],
  })),
});

test('safe-band Over alternates are extracted once per player and line, best registry price first', () => {
  const out = extractNflAltCandidates(altOdds([['draftkings', -400], ['fanduel', -380], ['pinnacle', -360]]), game, { now: NOW });
  assert.equal(out.length, 1, 'the +110 line is too light and the -700 too heavy');
  const [c] = out;
  assert.equal(c.kind, 'prop');
  assert.equal(c.playerName, 'Khalil Shakir');
  assert.equal(c.point, 49.5);
  assert.equal(c.need, 50);
  assert.equal(c.selection, 'Khalil Shakir 50+ Rec Yds');
  assert.equal(c.american, -380, 'Pinnacle is a reference book, not a price the reader can take');
  assert.equal(c.bookCount, 3);
  assert.equal(c.id, 'e1:player_reception_yds_alternate:khalil shakir:49.5:Over');
});

test('a line only one book prices, or priced only at books the reader cannot bet, is not a candidate', () => {
  assert.equal(extractNflAltCandidates(altOdds([['draftkings', -400]]), game, { now: NOW }).length, 0);
  assert.equal(extractNflAltCandidates(altOdds([['pinnacle', -400], ['offshore', -380]]), game, { now: NOW }).length, 0);
  assert.equal(extractNflAltCandidates(altOdds([['draftkings', -400], ['fanduel', -380]]), { ...game, commenceMs: NOW - 1 }, { now: NOW }).length, 0, 'a started game has no legs');
});

test('the game-log column is found by key, then display name, and by short label only when unambiguous', () => {
  const rb = { names: ['rushingAttempts', 'rushingYards', 'receptions', 'receivingYards'], labels: ['CAR', 'YDS', 'REC', 'YDS'] };
  assert.equal(gamelogStatIndex(rb, 'rushYds'), 1);
  assert.equal(gamelogStatIndex(rb, 'recYds'), 3);
  assert.equal(gamelogStatIndex(rb, 'receptions'), 2);
  const display = { displayNames: ['Receptions', 'Receiving Targets', 'Receiving Yards'], labels: ['REC', 'TGTS', 'YDS'] };
  assert.equal(gamelogStatIndex(display, 'recYds'), 2);
  const labelsOnly = { labels: ['REC', 'TGTS', 'YDS', 'AVG'] };
  assert.equal(gamelogStatIndex(labelsOnly, 'recYds'), 2, 'one YDS column is unambiguous');
  assert.equal(gamelogStatIndex({ labels: ['CAR', 'YDS', 'REC', 'YDS'] }, 'recYds'), -1, 'two YDS columns with no keys is a guess, so no column');
  assert.equal(gamelogStatIndex(null, 'recYds'), -1);
});

const gamelog = {
  names: ['receptions', 'receivingYards'],
  events: { g1: { gameDate: '2026-09-07T17:00Z' }, g2: { gameDate: '2026-09-14T17:00Z' }, g3: { gameDate: '2026-09-21T17:00Z' }, g4: { gameDate: '2026-09-28T17:00Z' }, p1: { gameDate: '2026-08-20T23:00Z' } },
  seasonTypes: [
    { displayName: '2026 Preseason', categories: [{ events: [{ eventId: 'p1', stats: ['1', '12'] }] }] },
    { displayName: '2026 Regular Season', categories: [{ events: [
      { eventId: 'g2', stats: ['6', '71'] }, { eventId: 'g1', stats: ['5', '62'] }, { eventId: 'g4', stats: ['7', '88'] }, { eventId: 'g3', stats: ['4', '55'] },
    ] }] },
  ],
};

test('game-log values come back most recent first, regular season only', () => {
  assert.deepEqual(parseNflGamelogValues(gamelog, 'recYds'), [88, 55, 71, 62]);
  assert.deepEqual(parseNflGamelogValues(gamelog, 'receptions'), [7, 4, 6, 5]);
  assert.deepEqual(parseNflGamelogValues(gamelog, 'rushYds'), [], 'a stat the log does not carry yields nothing, not zeros');
});

test('a line the player clears every week with an edge over its price becomes an anchor leg', () => {
  const [c] = extractNflAltCandidates(altOdds([['draftkings', -300], ['fanduel', -280]]), game, { now: NOW });
  const legA = propLegFrom(c, [88, 55, 71, 62]);
  assert.ok(legA, 'four of four at 50+ clears the gates, and 100% beats -280 by more than the edge floor');
  assert.equal(legA.profile.games, 4);
  assert.equal(legA.profile.season, 1);
  assert.ok(legA.consensusProb > 1 / legA.decimal, 'the leg claims more than the price implies');
  assert.ok(legA.ev > 0);
  assert.ok(legA.score >= 90);
  assert.equal(isAnchorLeg(legA), true);
  assert.equal(legEligible(legA, { minEv: 0.02, minKelly: 0.005, minScore: 50 }), true);

  // The same line for a player who misses it half the time is no leg at all.
  assert.equal(propLegFrom(c, [88, 35, 71, 40]), null);
  // Three games is a streak, not a rate.
  assert.equal(propLegFrom(c, [88, 71, 62]), null);
  assert.equal(clearsPropGates(null), false);
  assert.equal(PROP_GATES.MIN_GAMES, 4);
});

test('a line that clears the gates but not its own price has no edge and is dropped', () => {
  // -650 implies 86.7%; a player landing it 80% of the time is paying to take it.
  const heavy = extractNflAltCandidates(altOdds([['draftkings', -650], ['fanduel', -600]]), game, { now: NOW });
  assert.equal(heavy.length, 1);
  assert.equal(propLegFrom(heavy[0], [88, 55, 71, 62, 48]), null);
});

const summary = {
  header: { competitions: [{ status: { type: { completed: true } } }] },
  boxscore: { players: [{
    statistics: [
      { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'passingTouchdowns'], labels: ['C/ATT', 'YDS', 'TD'],
        athletes: [{ athlete: { displayName: 'Josh Allen' }, stats: ['24/33', '287', '2'] }] },
      { name: 'rushing', keys: ['rushingAttempts', 'rushingYards'], labels: ['CAR', 'YDS'],
        athletes: [{ athlete: { displayName: 'James Cook' }, stats: ['18', '94'] }, { athlete: { displayName: 'Josh Allen' }, stats: ['5', '31'] }] },
      { name: 'receiving', labels: ['REC', 'YDS', 'AVG'],
        athletes: [{ athlete: { displayName: 'Khalil Shakir' }, stats: ['6', '58', '9.7'] }, { athlete: { displayName: 'James Cook' }, stats: ['3', '22', '7.3'] }] },
    ],
  }] },
};

test('boxscore rows merge a player\'s categories and read labels when a category has no keys', () => {
  const rows = nflBoxscoreRows(summary);
  const cook = rows.find((r) => r.name === 'James Cook');
  assert.deepEqual(cook, { name: 'James Cook', rushYds: 94, recYds: 22, receptions: 3 });
  const allen = rows.find((r) => r.name === 'Josh Allen');
  assert.equal(allen.passYds, 287);
  assert.equal(allen.rushYds, 31);
  const shakir = rows.find((r) => r.name === 'Khalil Shakir');
  assert.deepEqual(shakir, { name: 'Khalil Shakir', recYds: 58, receptions: 6 });
});

test('a prop leg grades off the exact stat: a win, a loss, a real zero, and a did-not-play void', () => {
  const rows = nflBoxscoreRows(summary);
  const shakir = rows.find((r) => r.name === 'Khalil Shakir');
  assert.deepEqual(gradeNflPropLeg({ statKey: 'recYds', point: 49.5, need: 50 }, shakir), { won: true, actual: 58 });
  assert.deepEqual(gradeNflPropLeg({ statKey: 'recYds', point: 74.5, need: 75 }, shakir), { won: false, actual: 58 });
  // A back who played but never caught a pass has a row (rushing) and a real zero in receptions.
  const noCatch = { name: 'Backup Back', rushYds: 12 };
  assert.deepEqual(gradeNflPropLeg({ statKey: 'receptions', point: 1.5, need: 2 }, noCatch), { won: false, actual: 0 });
  assert.equal(gradeNflPropLeg({ statKey: 'recYds', point: 49.5, need: 50 }, null).void, true);
  // An integer line landed on exactly pushes.
  assert.equal(gradeNflPropLeg({ statKey: 'receptions', point: 6, need: 7 }, shakir).void, true);
});
