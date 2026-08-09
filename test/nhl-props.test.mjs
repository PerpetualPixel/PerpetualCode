import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gradeNhlProp,
  buildNhlPropCandidates,
  nhlPropLiquidityBlock,
  capNhlPropStake,
  NHL_PROP_MAX_STAKE_FRACTION,
  NHL_PROP_MIN_BOOKS,
} from '../docs/nhl-props.js';

/* ---------------------------------------------------------------- */
/* Settlement                                                         */
/* ---------------------------------------------------------------- */

const propPick = (over = {}) => ({
  marketKey: 'player_shots_on_goal', outcomeName: 'Over', point: 2.5,
  decimal: 1.91, suggested_stake: 20,
  ...over,
});

test('grades shots on goal directly from the parsed stat', () => {
  assert.equal(gradeNhlProp(propPick(), { shotsOnGoal: 4 }).won, true);
  assert.equal(gradeNhlProp(propPick(), { shotsOnGoal: 2 }).won, false);
  assert.equal(gradeNhlProp(propPick({ outcomeName: 'Under' }), { shotsOnGoal: 1 }).won, true);
});

test('an exact push voids rather than grading either side', () => {
  const out = gradeNhlProp(propPick({ point: 3 }), { shotsOnGoal: 3 });
  assert.equal(out.void, true);
  assert.match(out.reason, /push/);
});

test('a skater absent from the boxscore voids — never invents a result for someone who did not play', () => {
  const out = gradeNhlProp(propPick(), null);
  assert.equal(out.void, true);
  assert.match(out.reason, /did not play/);
});

test('a non-numeric boxscore stat voids instead of guessing', () => {
  assert.equal(gradeNhlProp(propPick(), { shotsOnGoal: NaN }).void, true);
});

test('a real win computes payout the same way every other market does', () => {
  const out = gradeNhlProp(propPick(), { shotsOnGoal: 4 });
  assert.equal(out.payout, (propPick().decimal - 1) * 20);
});

/**
 * This is the regression test for the S-vs-SOG mixup found while building
 * this module: ESPN's NHL boxscore has a column LABELED "SOG" that is
 * actually shootoutGoals (near-always 0/1), not shots on goal — the real
 * shots-on-goal column is labeled "S", keyed shotsTotal. This test doesn't
 * exercise the worker's own column lookup (that lives in
 * worker/src/nhl-props.js, against a live shape, not mocked here) — it
 * pins the CONTRACT gradeNhlProp expects: `shotsOnGoal` must already be the
 * real shot count by the time it reaches this function, so grading a skater
 * with a normal, real shot total doesn't get treated as a near-automatic
 * Under the way it would if shootoutGoals were passed in by mistake.
 */
test('a realistic shot count (not a shootout-goals-sized number) grades correctly', () => {
  // A real, unremarkable NHL game: skater with 4 shots on goal, 0 shootout
  // goals. If the wrong column were ever wired in upstream, this would look
  // like "0 shots" and every Over prop would lose regardless of the line.
  const out = gradeNhlProp(propPick({ point: 2.5 }), { shotsOnGoal: 4 });
  assert.equal(out.won, true);
});

/* ---------------------------------------------------------------- */
/* Liquidity guard and stake cap                                      */
/* ---------------------------------------------------------------- */

test('the liquidity guard blocks thin, disagreeing, or stale prop prices', () => {
  const now = Date.now();
  const quote = (decimal) => ({ decimal });
  const deep = [quote(1.9), quote(1.91), quote(1.88), quote(1.92)];
  assert.equal(nhlPropLiquidityBlock({ quotes: deep, updatedMs: now }, now), null);
  assert.match(nhlPropLiquidityBlock({ quotes: deep.slice(0, NHL_PROP_MIN_BOOKS - 1), updatedMs: now }, now), /book/);
});

test('the stake cap matches the agreed policy', () => {
  assert.equal(capNhlPropStake(0.04), NHL_PROP_MAX_STAKE_FRACTION);
});

/* ---------------------------------------------------------------- */
/* Candidate discovery                                               */
/* ---------------------------------------------------------------- */

function baseGame(over = {}) {
  return {
    eventId: 'evt1', espnEventId: 'espn1', sportKey: 'icehockey_nhl', sportTitle: 'NHL',
    commenceMs: Date.now() + 3 * 3600 * 1000,
    home: 'Toronto Maple Leafs', away: 'Boston Bruins',
    ...over,
  };
}

function bookmakersWithLine({ books = 4, player = 'Auston Matthews', point = 3.5 } = {}) {
  return Array.from({ length: books }, (_, i) => ({
    key: `book${i}`, title: `Book ${i}`, last_update: new Date().toISOString(),
    markets: [{
      key: 'player_shots_on_goal', last_update: new Date().toISOString(),
      outcomes: [
        { name: 'Over', description: player, point, price: i === 0 ? -100 : -120 },
        { name: 'Under', description: player, point, price: -105 - i },
      ],
    }],
  }));
}

test('builds a candidate per player, pairing Over/Under from the same book before devigging', () => {
  const candidates = buildNhlPropCandidates(baseGame(), bookmakersWithLine());
  const matthews = candidates.filter((c) => c.playerName === 'Auston Matthews');
  assert.equal(matthews.length, 2);
  assert.ok(matthews[0].bookCount >= NHL_PROP_MIN_BOOKS);
});

test('an already-started game produces no candidates', () => {
  const game = baseGame({ commenceMs: Date.now() - 1000 });
  assert.deepEqual(buildNhlPropCandidates(game, bookmakersWithLine()), []);
});

test('a line with only one book pricing it is dropped', () => {
  assert.deepEqual(buildNhlPropCandidates(baseGame(), bookmakersWithLine({ books: 1 })), []);
});
