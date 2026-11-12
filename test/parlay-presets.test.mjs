import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanParlaySettings, parlaySnapshot, applyParlaySnapshot, parlaySlotName, cleanParlayStore, withParlaySlot, PARLAY_SLOTS } from '../docs/parlay-presets.js';

test('a snapshot keeps the settings a user means and drops the day\'s choices; junk falls back to the defaults', () => {
  const state = { sports: new Set(['basketball_nba', 'americanfootball_nfl']), book: 'fanduel', legs: 6, minL20: 14, season: true, minH2H: 0.7, minScore: 4, stats: new Set(['points', 'anyTd']), odds: [-400, 250], games: new Set(['g1']), side: 'over', team: 'BOS', starters: true, ufcProps: new Set(), amount: 25, built: [{}], rows: { x: [] } };
  const snap = parlaySnapshot(state);
  assert.deepEqual(snap, { sports: ['basketball_nba', 'americanfootball_nfl'], book: 'fanduel', legs: 6, minL20: 14, season: true, minH2H: 0.7, minScore: 4, stats: ['points', 'anyTd'], odds: [-400, 250], side: 'over', starters: true, ufcProps: [], amount: 25 });
  assert.equal('games' in snap || 'team' in snap || 'built' in snap, false);
  const junk = cleanParlaySettings({ sports: ['<x>'], book: 'bookie', legs: 99, minL20: -3, odds: [500, -500], side: 'sideways', stats: ['ok', 'no way!'], amount: 'abc' });
  assert.deepEqual([junk.sports, junk.book, junk.legs, junk.minL20, junk.odds, junk.side, junk.stats, junk.amount], [['basketball_nba'], 'draftkings', 25, 0, [-500, 500], 'both', ['ok'], 10]);
  assert.equal(cleanParlaySettings(null), null);
});

test('applying a snapshot restores the sets and clears the ticket; a slot names itself from what it holds', () => {
  const target = { sports: new Set(['tennis']), stats: new Set(), games: new Set(['g9']), team: 'NYK', built: [{ a: 1 }], locked: new Set(['x']), seen: new Set(['y']), rows: { keep: [1] } };
  applyParlaySnapshot(target, { sports: ['americanfootball_nfl'], book: 'fanatics', legs: 10, stats: ['rushRecYds'], odds: [-800, 800], starters: true });
  assert.deepEqual([[...target.sports], target.book, target.legs, [...target.stats], target.starters, [...target.games], target.team, target.built, target.locked.size, target.rows.keep.length], [['americanfootball_nfl'], 'fanatics', 10, ['rushRecYds'], true, [], '', null, 0, 1]);
  assert.equal(parlaySlotName({ sports: ['basketball_nba', 'americanfootball_nfl'], legs: 4, book: 'fanduel' }), 'NBA + NFL · 4 legs · FanDuel');
});

test('the store holds the last settings and three slots; a slot saves, renames, clears, and an index out of range is ignored', () => {
  let store = cleanParlayStore(null);
  assert.deepEqual(store, { last: null, presets: [null, null, null] });
  store = withParlaySlot(store, 1, { sports: ['icehockey_nhl'], legs: 3, book: 'betmgm' }, { now: 5 });
  assert.equal(store.presets[1].name, 'NHL · 3 legs · BetMGM'); assert.equal(store.presets[1].savedAt, 5); assert.equal(store.presets[0], null);
  store = withParlaySlot(store, 0, { sports: ['tennis'], legs: 2 }, { name: '  Sunday   lotto  ', now: 6 });
  assert.equal(store.presets[0].name, 'Sunday lotto');
  assert.equal(withParlaySlot(store, PARLAY_SLOTS, { legs: 2 }).presets.filter(Boolean).length, 2);
  store = withParlaySlot(store, 1, null);
  assert.equal(store.presets[1], null);
  const round = cleanParlayStore(JSON.parse(JSON.stringify({ ...store, last: { legs: 5, book: 'caesars' }, extra: 1, presets: [...store.presets, { name: 'fourth' }] })));
  assert.equal(round.presets.length, 3); assert.equal(round.last.legs, 5); assert.equal('extra' in round, false);
});
