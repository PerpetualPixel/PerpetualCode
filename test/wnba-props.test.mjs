import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gradeWnbaProp,
  buildWnbaPropCandidates,
  wnbaPropLiquidityBlock,
  capWnbaPropStake,
  WNBA_PROP_MAX_STAKE_FRACTION,
  WNBA_PROP_MIN_BOOKS,
} from '../docs/wnba-props.js';

/* ---------------------------------------------------------------- */
/* Settlement                                                         */
/* ---------------------------------------------------------------- */

const propPick = (over = {}) => ({
  marketKey: 'player_points_rebounds_assists', outcomeName: 'Over', point: 30.5,
  decimal: 1.91, suggested_stake: 20,
  ...over,
});

test('grades PRA as the sum of all three stats', () => {
  const row = { points: 22, rebounds: 6, assists: 3 }; // PRA = 31
  assert.equal(gradeWnbaProp(propPick(), row).won, true);
  assert.equal(gradeWnbaProp(propPick({ point: 35.5 }), row).won, false);
});

test('grades Rebounds+Assists as just those two, ignoring points', () => {
  const row = { points: 40, rebounds: 3, assists: 2 }; // Reb+Ast = 5, points irrelevant
  const pick = propPick({ marketKey: 'player_rebounds_assists', point: 4.5 });
  assert.equal(gradeWnbaProp(pick, row).won, true);
  assert.equal(gradeWnbaProp({ ...pick, point: 10.5 }, row).won, false);
});

test('an exact push voids rather than grading either side', () => {
  const row = { points: 20, rebounds: 6, assists: 4 }; // PRA = 30
  const out = gradeWnbaProp(propPick({ point: 30 }), row);
  assert.equal(out.void, true);
  assert.match(out.reason, /push/);
});

test('a player absent from the boxscore voids — never invents a result for someone who did not play', () => {
  const out = gradeWnbaProp(propPick(), null);
  assert.equal(out.void, true);
  assert.match(out.reason, /did not play/);
});

test('a boxscore row with a non-numeric stat voids instead of guessing', () => {
  const out = gradeWnbaProp(propPick(), { points: 20, rebounds: NaN, assists: 4 });
  assert.equal(out.void, true);
});

test('a real win computes payout the same way every other market does', () => {
  const out = gradeWnbaProp(propPick(), { points: 22, rebounds: 6, assists: 3 });
  assert.equal(out.payout, (propPick().decimal - 1) * 20);
});

/* ---------------------------------------------------------------- */
/* Liquidity guard and stake cap                                      */
/* ---------------------------------------------------------------- */

test('the liquidity guard blocks thin, disagreeing, or stale prop prices', () => {
  const now = Date.now();
  const quote = (decimal) => ({ decimal });
  const deep = [quote(1.9), quote(1.91), quote(1.88), quote(1.92)];
  assert.equal(wnbaPropLiquidityBlock({ quotes: deep, updatedMs: now }, now), null);
  assert.match(wnbaPropLiquidityBlock({ quotes: deep.slice(0, WNBA_PROP_MIN_BOOKS - 1), updatedMs: now }, now), /book/);
});

test('the stake cap matches the agreed policy', () => {
  assert.equal(capWnbaPropStake(0.04), WNBA_PROP_MAX_STAKE_FRACTION);
});

/* ---------------------------------------------------------------- */
/* Candidate discovery                                               */
/* ---------------------------------------------------------------- */

function baseGame(over = {}) {
  return {
    eventId: 'evt1', espnEventId: 'espn1', sportKey: 'basketball_wnba', sportTitle: 'WNBA',
    commenceMs: Date.now() + 3 * 3600 * 1000,
    home: 'Las Vegas Aces', away: 'New York Liberty',
    ...over,
  };
}

function bookmakersWithLine({ price = { over: -100, under: -120 }, books = 4, player = "A'ja Wilson", marketKey = 'player_points_rebounds_assists', point = 38.5 } = {}) {
  return Array.from({ length: books }, (_, i) => ({
    key: `book${i}`, title: `Book ${i}`, last_update: new Date().toISOString(),
    markets: [{
      key: marketKey, last_update: new Date().toISOString(),
      outcomes: [
        { name: 'Over', description: player, point, price: i === 0 ? price.over : -120 },
        { name: 'Under', description: player, point, price: price.under - i },
      ],
    }],
  }));
}

test('builds a candidate per player per stat, pairing Over/Under from the same book before devigging', () => {
  const candidates = buildWnbaPropCandidates(baseGame(), bookmakersWithLine());
  const wilson = candidates.filter((c) => c.playerName === "A'ja Wilson");
  assert.equal(wilson.length, 2);
  assert.ok(wilson[0].bookCount >= WNBA_PROP_MIN_BOOKS);
});

test('an already-started game produces no candidates', () => {
  const game = baseGame({ commenceMs: Date.now() - 1000 });
  assert.deepEqual(buildWnbaPropCandidates(game, bookmakersWithLine()), []);
});

test('a line with only one book pricing it is dropped', () => {
  assert.deepEqual(buildWnbaPropCandidates(baseGame(), bookmakersWithLine({ books: 1 })), []);
});
