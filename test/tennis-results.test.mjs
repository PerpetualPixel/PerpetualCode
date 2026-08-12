import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSetScore, matchHomeIndex, gradeTennisGameMarket, liveSetsLabel } from '../docs/tennis-results.js';
import { tennisMatchDecided } from '../docs/learning.js';
import { hasSecondarySettlementSource, TIER_1, TIER_2 } from '../docs/tennis-tiers.js';

/* ---------------------------------------------------------------- */
/* Score-string parsing                                              */
/* ---------------------------------------------------------------- */

test('parses a comma-separated games score into per-set pairs', () => {
  assert.deepEqual(parseSetScore('7-6,6-1'), [[7, 6], [6, 1]]);
  assert.deepEqual(parseSetScore('6-3,4-6,7-5'), [[6, 3], [4, 6], [7, 5]]);
});

test('tolerates a trailing tiebreak annotation without treating it as games', () => {
  assert.deepEqual(parseSetScore('7-6(4),6-1'), [[7, 6], [6, 1]]);
});

test('rejects malformed or incomplete score strings rather than guessing', () => {
  assert.equal(parseSetScore(''), null);
  assert.equal(parseSetScore(null), null);
  assert.equal(parseSetScore('6-3,retired'), null);
  assert.equal(parseSetScore('walkover'), null);
});

/* ---------------------------------------------------------------- */
/* Player-side matching                                              */
/* ---------------------------------------------------------------- */

test('matches home by normalized name regardless of API ordering', () => {
  const pick = { home: 'Daniil Medvedev', away: 'Kamil Majchrzak' };
  assert.equal(matchHomeIndex(pick, ['Kamil Majchrzak', 'Daniil Medvedev']), 1);
  assert.equal(matchHomeIndex(pick, ['Daniil Medvedev', 'Kamil Majchrzak']), 0);
});

test('refuses to match when the name is ambiguous or absent', () => {
  const pick = { home: 'Daniil Medvedev', away: 'Kamil Majchrzak' };
  assert.equal(matchHomeIndex(pick, ['Someone Else', 'Another Player']), null);
  assert.equal(matchHomeIndex(pick, ['Daniil Medvedev', 'Daniil Medvedev']), null);
});

/* ---------------------------------------------------------------- */
/* Settlement                                                         */
/* ---------------------------------------------------------------- */

const propPick = (over = {}) => ({
  sportKey: 'tennis_atp_wimbledon', marketKey: 'totals', outcomeName: 'Over', point: 21.5,
  home: 'Daniil Medvedev', away: 'Kamil Majchrzak', decimal: 1.91, suggested_stake: 20,
  ...over,
});

const apiResult = (over = {}) => ({
  participantNames: ['Kamil Majchrzak', 'Daniil Medvedev'],
  score: '7-6,6-1',
  status: 'Ended',
  ...over,
});

test('grades a total from real games, not the games/sets bug this exists to fix', () => {
  // 7+6+6+1 = 20 total games.
  const under = gradeTennisGameMarket(propPick({ outcomeName: 'Under', point: 21.5 }), apiResult());
  assert.equal(under.won, true);
  const over = gradeTennisGameMarket(propPick({ outcomeName: 'Over', point: 19.5 }), apiResult());
  assert.equal(over.won, true);
});

test('grades a spread on the correct side by matched player, not URL order', () => {
  // Medvedev (home) games: 6+1=7. Majchrzak (away) games: 7+6=13.
  const pick = propPick({ marketKey: 'spreads', outcomeName: 'Daniil Medvedev', point: 5.5 });
  const out = gradeTennisGameMarket(pick, apiResult());
  assert.equal(out.won, false); // 7 + 5.5 - 13 = -0.5, doesn't cover
});

test('an exact total push voids with a clear reason', () => {
  const out = gradeTennisGameMarket(propPick({ point: 20 }), apiResult());
  assert.equal(out.void, true);
  assert.match(out.reason, /push/);
});

test('returns null (not a void) when the match is not marked Ended', () => {
  assert.equal(gradeTennisGameMarket(propPick(), apiResult({ status: 'InProgress' })), null);
});

test('returns null when the score string does not parse', () => {
  assert.equal(gradeTennisGameMarket(propPick(), apiResult({ score: 'retired' })), null);
});

test('returns null when neither participant name matches the pick', () => {
  assert.equal(gradeTennisGameMarket(propPick(), apiResult({ participantNames: ['A', 'B'] })), null);
});

test('h2h picks are left to the free grader — this module only handles spreads/totals', () => {
  assert.equal(gradeTennisGameMarket(propPick({ marketKey: 'h2h' }), apiResult()), null);
});

/* ---------------------------------------------------------------- */
/* tennisMatchDecided (docs/learning.js)                              */
/* ---------------------------------------------------------------- */

const decidePick = { home: 'A', away: 'B' };
const sets = (h, a) => ({ completed: true, scores: [{ name: 'A', score: String(h) }, { name: 'B', score: String(a) }] });

test('tennisMatchDecided reports a clean decided result', () => {
  assert.deepEqual(tennisMatchDecided(decidePick, sets(2, 1)), { decided: true, homeSets: 2, awaySets: 1 });
});

test('tennisMatchDecided reports a retirement as not decided, so no budget is spent on it', () => {
  assert.equal(tennisMatchDecided(decidePick, sets(1, 0)).decided, false);
});

test('tennisMatchDecided returns null for an unfinished match', () => {
  assert.equal(tennisMatchDecided(decidePick, { completed: false, scores: [] }), null);
});

/* ---------------------------------------------------------------- */
/* Tier scoping                                                       */
/* ---------------------------------------------------------------- */

test('the second source is only ever attempted for TIER_1 markets — spreads, totals, and h2h', () => {
  assert.equal(hasSecondarySettlementSource('tennis_atp_wimbledon', 'spreads'), true);
  assert.equal(hasSecondarySettlementSource('tennis_atp_wimbledon', 'totals'), true);
  // h2h was added later, deliberately: the free /scores feed can mark a
  // match completed:true with no set data at all, which voids a pick that
  // had a real winner — the second source rescues exactly that case (see
  // tennis-tiers.js's hasSecondarySettlementSource comment). Budget safety
  // lives in settleTennisGameMarket, which skips h2h whenever the free
  // source already decided it cleanly.
  assert.equal(hasSecondarySettlementSource('tennis_atp_wimbledon', 'h2h'), true);
  assert.equal(hasSecondarySettlementSource('tennis_atp_some_new_500', 'spreads'), false); // TIER_2
  assert.equal(hasSecondarySettlementSource('baseball_mlb', 'spreads'), false);
});

// -- liveSetsLabel: the live card's sets chip --------------------------------

test('liveSetsLabel renders sets for an explicitly in-progress match', () => {
  assert.equal(liveSetsLabel({
    completed: false,
    scores: [{ name: 'A. Player', score: '1' }, { name: 'B. Player', score: '0' }],
  }), '1–0 sets');
  assert.equal(liveSetsLabel({
    completed: false,
    scores: [{ name: 'A', score: '2' }, { name: 'B', score: '2' }],
  }), '2–2 sets', 'a live fifth set is the deepest valid in-progress state');
});

test('liveSetsLabel refuses everything it cannot vouch for', () => {
  // completed:true is a finished match (finishedDetailHtml territory), and an
  // absent event / absent flag is unknown — neither is "live", so no chip.
  assert.equal(liveSetsLabel({ completed: true, scores: [{ name: 'A', score: '2' }, { name: 'B', score: '0' }] }), null);
  assert.equal(liveSetsLabel(null), null);
  assert.equal(liveSetsLabel({ scores: [{ name: 'A', score: '1' }, { name: 'B', score: '0' }] }), null);
  // The feed frequently posts no scores at all while a match runs.
  assert.equal(liveSetsLabel({ completed: false, scores: [] }), null);
  assert.equal(liveSetsLabel({ completed: false, scores: null }), null);
  assert.equal(liveSetsLabel({ completed: false, scores: [{ name: 'A', score: '1' }] }), null);
  assert.equal(liveSetsLabel({ completed: false, scores: [{ name: 'A', score: 'X' }, { name: 'B', score: '0' }] }), null);
  // Five completed sets can't be in progress — whatever these numbers are,
  // they aren't a live set count, so refuse rather than mislabel them.
  assert.equal(liveSetsLabel({ completed: false, scores: [{ name: 'A', score: '4' }, { name: 'B', score: '1' }] }), null);
});
