import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePassingLine,
  gradeQbProp,
  buildQbPropCandidates,
  nflPropLiquidityBlock,
  capNflPropStake,
  NFL_PROP_MAX_STAKE_FRACTION,
  NFL_PROP_MIN_BOOKS,
} from '../docs/nfl-props.js';

/* ---------------------------------------------------------------- */
/* Passing-line parsing                                               */
/* ---------------------------------------------------------------- */

test('parses a combined completions/attempts string', () => {
  assert.deepEqual(parsePassingLine('21/34'), { completions: 21, attempts: 34 });
  assert.deepEqual(parsePassingLine('0/1'), { completions: 0, attempts: 1 });
});

test('rejects malformed passing lines rather than guessing', () => {
  assert.equal(parsePassingLine(''), null);
  assert.equal(parsePassingLine(null), null);
  assert.equal(parsePassingLine('DNP'), null);
});

/* ---------------------------------------------------------------- */
/* Settlement                                                         */
/* ---------------------------------------------------------------- */

const propPick = (over = {}) => ({
  marketKey: 'player_pass_attempts', outcomeName: 'Over', point: 30.5,
  decimal: 1.91, suggested_stake: 20,
  ...over,
});

test('grades pass attempts and completions from the combined boxscore line', () => {
  assert.equal(gradeQbProp(propPick(), { passingLine: '21/34' }).won, true);  // 34 > 30.5
  assert.equal(gradeQbProp(propPick({ point: 40.5 }), { passingLine: '21/34' }).won, false);
  const compPick = propPick({ marketKey: 'player_pass_completions', point: 19.5 });
  assert.equal(gradeQbProp(compPick, { passingLine: '21/34' }).won, true); // 21 > 19.5
});

test('an exact push voids rather than grading either side', () => {
  const out = gradeQbProp(propPick({ point: 34 }), { passingLine: '21/34' });
  assert.equal(out.void, true);
  assert.match(out.reason, /push/);
});

test('a QB absent from the boxscore voids — never invents a result for someone who did not play', () => {
  const out = gradeQbProp(propPick(), null);
  assert.equal(out.void, true);
  assert.match(out.reason, /did not play/);
});

test('an unparseable boxscore line voids instead of guessing', () => {
  const out = gradeQbProp(propPick(), { passingLine: 'DNP' });
  assert.equal(out.void, true);
});

test('a real win computes payout the same way every other market does', () => {
  const out = gradeQbProp(propPick(), { passingLine: '21/34' });
  assert.equal(out.payout, (propPick().decimal - 1) * 20);
});

/* ---------------------------------------------------------------- */
/* Liquidity guard and stake cap                                      */
/* ---------------------------------------------------------------- */

test('the liquidity guard blocks thin, disagreeing, or stale prop prices', () => {
  const now = Date.now();
  const quote = (decimal) => ({ decimal });
  const deep = [quote(1.9), quote(1.91), quote(1.88), quote(1.92)];
  assert.equal(nflPropLiquidityBlock({ quotes: deep, updatedMs: now }, now), null);
  assert.match(nflPropLiquidityBlock({ quotes: deep.slice(0, NFL_PROP_MIN_BOOKS - 1), updatedMs: now }, now), /book/);
  assert.match(nflPropLiquidityBlock({ quotes: deep, updatedMs: now - 45 * 60 * 1000 }, now), /stale/);
});

test('the stake cap matches the agreed policy', () => {
  assert.equal(capNflPropStake(0.04), NFL_PROP_MAX_STAKE_FRACTION);
  assert.equal(capNflPropStake(0.001), 0.001);
});

/* ---------------------------------------------------------------- */
/* Candidate discovery                                               */
/* ---------------------------------------------------------------- */

function baseGame(over = {}) {
  return {
    eventId: 'evt1', espnEventId: 'espn1', sportKey: 'americanfootball_nfl', sportTitle: 'NFL',
    commenceMs: Date.now() + 3 * 3600 * 1000,
    home: 'Kansas City Chiefs', away: 'Buffalo Bills',
    ...over,
  };
}

function bookmakersWithLine({ price = { over: -115, under: -105 }, books = 4, player = 'Patrick Mahomes', marketKey = 'player_pass_attempts', point = 32.5 } = {}) {
  return Array.from({ length: books }, (_, i) => ({
    key: `book${i}`, title: `Book ${i}`, last_update: new Date().toISOString(),
    markets: [{
      key: marketKey, last_update: new Date().toISOString(),
      outcomes: [
        { name: 'Over', description: player, point, price: price.over + i },
        { name: 'Under', description: player, point, price: price.under - i },
        { name: 'Over', description: 'Josh Allen', point: 31.5, price: -110 },
        { name: 'Under', description: 'Josh Allen', point: 31.5, price: -110 },
      ],
    }],
  }));
}

test('builds a candidate per player per stat, pairing Over/Under from the same book before devigging — no starter allowlist needed', () => {
  const candidates = buildQbPropCandidates(baseGame(), bookmakersWithLine());
  const mahomes = candidates.filter((c) => c.playerName === 'Patrick Mahomes');
  assert.equal(mahomes.length, 2); // Over and Under
  assert.ok(mahomes[0].bookCount >= NFL_PROP_MIN_BOOKS);
  // A second player bundled into the same flat outcomes array (as the real
  // API does) is correctly kept separate rather than pooled with the first.
  const allen = candidates.filter((c) => c.playerName === 'Josh Allen');
  assert.equal(allen.length, 2);
  assert.equal(allen[0].point, 31.5);
});

test('a player thinly covered by only one book is dropped — nothing to benchmark against', () => {
  const bookmakers = bookmakersWithLine();
  // Give a third player a line in only the first book.
  bookmakers[0].markets[0].outcomes.push(
    { name: 'Over', description: 'Backup QB', point: 5.5, price: -120 },
    { name: 'Under', description: 'Backup QB', point: 5.5, price: -110 },
  );
  const candidates = buildQbPropCandidates(baseGame(), bookmakers);
  assert.equal(candidates.filter((c) => c.playerName === 'Backup QB').length, 0);
});

test('an already-started game produces no candidates', () => {
  const game = baseGame({ commenceMs: Date.now() - 1000 });
  assert.deepEqual(buildQbPropCandidates(game, bookmakersWithLine()), []);
});

test('a line with only one book pricing it is dropped', () => {
  assert.deepEqual(buildQbPropCandidates(baseGame(), bookmakersWithLine({ books: 1 })), []);
});
