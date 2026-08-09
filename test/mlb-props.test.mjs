import test from 'node:test';
import assert from 'node:assert/strict';

import {
  outsFromInnings,
  gradePitcherProp,
  buildPitcherPropCandidates,
  propLiquidityBlock,
  capPropStake,
  PROP_MAX_STAKE_FRACTION,
  PROP_MIN_BOOKS,
} from '../docs/mlb-props.js';

/* ---------------------------------------------------------------- */
/* Innings-pitched decoding                                          */
/* ---------------------------------------------------------------- */

test('outsFromInnings decodes MLB dotted notation, not decimal thirds', () => {
  assert.equal(outsFromInnings('6.0'), 18);
  assert.equal(outsFromInnings('6.1'), 19);
  assert.equal(outsFromInnings('6.2'), 20);
  assert.equal(outsFromInnings('0.1'), 1);
  assert.equal(outsFromInnings('0.2'), 2);
  assert.equal(outsFromInnings(7), 21); // a bare number, no fractional part
});

test('outsFromInnings rejects malformed input rather than guessing', () => {
  assert.equal(outsFromInnings('6.3'), null); // MLB notation never uses .3+
  assert.equal(outsFromInnings('abc'), null);
  assert.equal(outsFromInnings(null), null);
  assert.equal(outsFromInnings(undefined), null);
});

/* ---------------------------------------------------------------- */
/* Settlement                                                         */
/* ---------------------------------------------------------------- */

const propPick = (over = {}) => ({
  marketKey: 'pitcher_strikeouts', outcomeName: 'Over', point: 6.5,
  decimal: 1.91, suggested_stake: 20,
  ...over,
});

test('a pitcher clearing the line settles as a win, missing it as a loss', () => {
  assert.equal(gradePitcherProp(propPick(), { strikeouts: 9 }).won, true);
  assert.equal(gradePitcherProp(propPick(), { strikeouts: 4 }).won, false);
  assert.equal(gradePitcherProp(propPick({ outcomeName: 'Under' }), { strikeouts: 4 }).won, true);
});

test('an exact push voids rather than grading either side', () => {
  const out = gradePitcherProp(propPick({ point: 7 }), { strikeouts: 7 });
  assert.equal(out.void, true);
  assert.match(out.reason, /push/);
});

test('pitcher_outs settles on the decoded innings notation', () => {
  const pick = propPick({ marketKey: 'pitcher_outs', point: 17.5 });
  assert.equal(gradePitcherProp(pick, { ip: '6.0' }).won, true);  // 18 outs > 17.5
  assert.equal(gradePitcherProp(pick, { ip: '5.2' }).won, false); // 17 outs < 17.5
});

test('a pitcher absent from the boxscore voids — never invents a result for someone who never played', () => {
  const out = gradePitcherProp(propPick(), null);
  assert.equal(out.void, true);
  assert.equal(out.payout, 0);
  assert.match(out.reason, /scratched|not played/);
});

test('an unparseable boxscore stat voids instead of guessing', () => {
  const out = gradePitcherProp(propPick({ marketKey: 'pitcher_outs' }), { ip: 'DNP' });
  assert.equal(out.void, true);
});

test('a real win computes payout the same way every other market does', () => {
  const out = gradePitcherProp(propPick(), { strikeouts: 9 });
  assert.equal(out.payout, (propPick().decimal - 1) * 20);
});

/* ---------------------------------------------------------------- */
/* Liquidity guard and stake cap                                     */
/* ---------------------------------------------------------------- */

test('the liquidity guard blocks thin, disagreeing, or stale prop prices', () => {
  const now = Date.now();
  const quote = (decimal) => ({ decimal });
  const deep = [quote(1.9), quote(1.91), quote(1.88), quote(1.92)];

  assert.equal(propLiquidityBlock({ quotes: deep, updatedMs: now }, now), null);
  assert.match(propLiquidityBlock({ quotes: deep.slice(0, PROP_MIN_BOOKS - 1), updatedMs: now }, now), /book/);
  assert.match(
    propLiquidityBlock({ quotes: [quote(1.3), quote(3.0), quote(1.9), quote(2.0)], updatedMs: now }, now),
    /disagree/,
  );
  assert.match(propLiquidityBlock({ quotes: deep, updatedMs: now - 45 * 60 * 1000 }, now), /stale/);
});

test('the stake cap sits between full Kelly and the thin-tennis-tier caps', () => {
  assert.equal(capPropStake(0.04), PROP_MAX_STAKE_FRACTION);
  assert.equal(capPropStake(0.001), 0.001);
  assert.ok(PROP_MAX_STAKE_FRACTION > 0.005 && PROP_MAX_STAKE_FRACTION < 0.05);
});

/* ---------------------------------------------------------------- */
/* Candidate discovery                                               */
/* ---------------------------------------------------------------- */

function baseGame(over = {}) {
  return {
    eventId: 'evt1', espnEventId: 'espn1', sportKey: 'baseball_mlb', sportTitle: 'MLB',
    commenceMs: Date.now() + 3 * 3600 * 1000,
    home: 'New York Yankees', away: 'Atlanta Braves',
    pitchers: [{ playerId: '32081', name: 'Gerrit Cole' }, { playerId: '30948', name: 'Chris Sale' }],
    ...over,
  };
}

function bookmakersWithLine({ price = { over: -115, under: -105 }, books = 4, player = 'Gerrit Cole', marketKey = 'pitcher_strikeouts', point = 6.5 } = {}) {
  return Array.from({ length: books }, (_, i) => ({
    key: `book${i}`,
    title: `Book ${i}`,
    last_update: new Date().toISOString(),
    markets: [{
      key: marketKey,
      last_update: new Date().toISOString(),
      outcomes: [
        { name: 'Over', description: player, point, price: price.over + i },
        { name: 'Under', description: player, point, price: price.under - i },
        // A second player bundled into the same flat outcomes array, as the real API does.
        { name: 'Over', description: 'Chris Sale', point: 5.5, price: -110 },
        { name: 'Under', description: 'Chris Sale', point: 5.5, price: -110 },
      ],
    }],
  }));
}

test('builds a candidate per player per stat, pairing Over/Under from the same book before devigging', () => {
  const candidates = buildPitcherPropCandidates(baseGame(), bookmakersWithLine());
  const coleK = candidates.find((c) => c.playerId === '32081' && c.marketKey === 'pitcher_strikeouts');
  assert.ok(coleK);
  assert.equal(coleK.point, 6.5);
  assert.ok(coleK.bookCount >= PROP_MIN_BOOKS);
  assert.ok(coleK.consensusProb > 0 && coleK.consensusProb < 1);
  // Both sides of the same line should appear as separate candidates.
  const sides = candidates.filter((c) => c.playerId === '32081' && c.marketKey === 'pitcher_strikeouts').map((c) => c.outcomeName);
  assert.deepEqual(sides.sort(), ['Over', 'Under']);
});

test('an outcome for a player who is not one of the two known starters is dropped, not guessed', () => {
  const bookmakers = bookmakersWithLine();
  bookmakers[0].markets[0].outcomes.push(
    { name: 'Over', description: 'Some Reliever Nobody Expected', point: 1.5, price: -120 },
    { name: 'Under', description: 'Some Reliever Nobody Expected', point: 1.5, price: -110 },
  );
  const candidates = buildPitcherPropCandidates(baseGame(), bookmakers);
  assert.ok(!candidates.some((c) => c.playerName === 'Some Reliever Nobody Expected'));
});

test('name matching is accent/punctuation-insensitive', () => {
  const game = baseGame({ pitchers: [{ playerId: '999', name: 'Luis García Jr.' }] });
  const bookmakers = bookmakersWithLine({ player: 'Luis Garcia Jr', marketKey: 'pitcher_strikeouts' });
  const candidates = buildPitcherPropCandidates(game, bookmakers);
  assert.ok(candidates.some((c) => c.playerId === '999'));
});

test('a game with no known starters produces no candidates', () => {
  const game = baseGame({ pitchers: [] });
  assert.deepEqual(buildPitcherPropCandidates(game, bookmakersWithLine()), []);
});

test('an already-started game produces no candidates', () => {
  const game = baseGame({ commenceMs: Date.now() - 1000 });
  assert.deepEqual(buildPitcherPropCandidates(game, bookmakersWithLine()), []);
});

test('a line with only one book pricing it is dropped — nothing to benchmark against', () => {
  const candidates = buildPitcherPropCandidates(baseGame(), bookmakersWithLine({ books: 1 }));
  assert.deepEqual(candidates, []);
});
