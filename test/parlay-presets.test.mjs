import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanParlaySettings, parlaySnapshot, applyParlaySnapshot, parlaySlotName, cleanParlayStore, withParlaySlot, PARLAY_SLOTS, passesHitBars, l20Floor, hitBarText, nextMinScore } from '../docs/parlay-presets.js';

test('a snapshot keeps the settings a user means and drops the day\'s choices; junk falls back to the defaults', () => {
  const state = { sports: new Set(['basketball_nba', 'americanfootball_nfl']), book: 'fanduel', legs: 6, minL5: 4, minL10: 7, l20: true, season: true, minH2H: 0.7, minScore: 4, stats: new Set(['points', 'anyTd']), odds: [-400, 250], games: new Set(['g1']), side: 'over', team: 'BOS', starters: true, ufcProps: new Set(), amount: 25, built: [{}], rows: { x: [] } };
  const snap = parlaySnapshot(state);
  assert.deepEqual(snap, { sports: ['basketball_nba', 'americanfootball_nfl'], book: 'fanduel', legs: 6, minL5: 4, minL10: 7, l20: true, season: true, minH2H: 0.7, minScore: 4, stats: ['points', 'anyTd'], odds: [-400, 250], side: 'over', starters: true, noRed: false, ufcProps: [], amount: 25 });
  // Leaving out red-flagged players is a setting like the rest: kept when on, off for anything else.
  assert.equal(parlaySnapshot({ ...state, noRed: true }).noRed, true);
  assert.equal(parlaySnapshot({ ...state, noRed: 'yes' }).noRed, false);
  assert.equal('games' in snap || 'team' in snap || 'built' in snap, false);
  const junk = cleanParlaySettings({ sports: ['<x>'], book: 'bookie', legs: 99, minL5: 9, minL10: -3, l20: 'yes', odds: [500, -500], side: 'sideways', stats: ['ok', 'no way!'], amount: 'abc' });
  assert.deepEqual([junk.sports, junk.book, junk.legs, junk.minL5, junk.minL10, junk.l20, junk.odds, junk.side, junk.stats, junk.amount], [['basketball_nba'], 'draftkings', 25, 5, 0, false, [-500, 500], 'both', ['ok'], 10]);
  assert.equal('minL20' in snap || 'minL20' in junk, false, 'the single last-20 bar is gone from what is kept');
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

test('settings saved under the single last-20 bar come back as the same floor on the new bars', () => {
  // 14+ of 20 was 70%: 7+ of 10 with the Last 20 button on asks for the same 14 of 20.
  const old = cleanParlaySettings({ sports: ['basketball_nba'], minL20: 14, season: true });
  assert.deepEqual([old.minL5, old.minL10, old.l20, old.season], [0, 7, true, true]);
  assert.equal(l20Floor(old), 0.7);
  assert.deepEqual((({ minL5, minL10, l20 }) => [minL5, minL10, l20])(cleanParlaySettings({ minL20: 10 })), [0, 5, true]);
  // No bar set then: none set now. And once the new fields are there, an old number left behind is ignored.
  assert.deepEqual((({ minL5, minL10, l20 }) => [minL5, minL10, l20])(cleanParlaySettings({ minL20: 0 })), [0, 0, false]);
  assert.deepEqual((({ minL5, minL10, l20 }) => [minL5, minL10, l20])(cleanParlaySettings({ minL20: 14, minL5: 3, minL10: 0, l20: false })), [3, 0, false]);
  // A slot saved before the change loads the same way through the store.
  const store = cleanParlayStore({ last: { minL20: 12 }, presets: [{ name: 'Old', settings: { minL20: 16 } }] });
  assert.deepEqual([store.last.minL10, store.last.l20, store.presets[0].settings.minL10, store.presets[0].settings.l20], [6, true, 8, true]);
});

test('passesHitBars: each bar is a floor on its own window, judged as a rate; the Last 20 button follows the Last 10 bar', () => {
  const windows = (w5, w10, w20) => (n) => ({ 5: w5, 10: w10, 20: w20 })[n];
  const w = (hits, games) => ({ hits, games });
  const leg = windows(w(4, 5), w(6, 10), w(11, 20));
  const bars = (minL5, minL10, l20) => ({ minL5, minL10, l20 });
  assert.equal(passesHitBars(bars(0, 0, false), leg), true, 'no bar set: everything passes');
  assert.deepEqual([passesHitBars(bars(4, 0, false), leg), passesHitBars(bars(5, 0, false), leg)], [true, false]);
  assert.deepEqual([passesHitBars(bars(0, 6, false), leg), passesHitBars(bars(0, 7, false), leg)], [true, false]);
  assert.equal(passesHitBars(bars(4, 7, false), leg), false, 'both bars must clear');
  // The button alone asks for half of the last 20; with the Last 10 bar set it asks for that bar's rate.
  assert.deepEqual([l20Floor(bars(0, 0, true)), l20Floor(bars(5, 0, true)), l20Floor(bars(0, 6, true))], [0.5, 0.5, 0.6]);
  assert.equal(passesHitBars(bars(0, 0, true), leg), true, '11 of 20 is over half');
  assert.equal(passesHitBars(bars(0, 6, true), leg), false, '6+ of 10 with the button on needs 12 of 20');
  assert.equal(passesHitBars(bars(0, 6, true), windows(w(4, 5), w(6, 10), w(12, 20))), true);
  // A young season: the floor is a rate, so 4+ of 5 passes at 3 of 3 and fails at 2 of 3; no games at all never passes a set bar.
  assert.deepEqual([passesHitBars(bars(4, 0, false), windows(w(3, 3))), passesHitBars(bars(4, 0, false), windows(w(2, 3))), passesHitBars(bars(1, 0, false), windows(w(0, 0)))], [true, false, false]);
  assert.deepEqual([hitBarText(0, 5), hitBarText(4, 5), hitBarText(7, 10)], ['Any', '4+ of 5 (80%)', '7+ of 10 (70%)']);
});

test('the score stars take halves: a second tap on a star adds the half, a third takes it off, and a saved half is kept', () => {
  assert.equal(nextMinScore(2, 4), 4, 'a tap on another star sets that many');
  assert.equal(nextMinScore(4, 4), 4.5, 'a second tap on the same star adds the half');
  assert.equal(nextMinScore(4.5, 4), 4, 'a third takes it off');
  assert.equal(nextMinScore(4.5, 5), 5);
  assert.equal(nextMinScore(5, 5), 5, 'five is the top: no 5.5');
  assert.deepEqual([nextMinScore(1, 1), nextMinScore(1.5, 2), nextMinScore(3.5, 3), nextMinScore(3, '3'), nextMinScore(2, 9), nextMinScore(2, 'x')], [1.5, 2, 3, 3.5, 5, 1]);
  // Saved settings keep a half and round anything else to the nearest one.
  assert.deepEqual([4.5, 4, 4.3, 4.74, 0, 9, undefined].map((v) => cleanParlaySettings({ minScore: v }).minScore), [4.5, 4, 4.5, 4.5, 1, 5, 2]);
});
