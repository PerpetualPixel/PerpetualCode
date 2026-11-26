import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLiveSlips, slipKey, slipNumbers, liveSlipHash, parseLiveHash, LIVE_HASH_PREFIX } from '../docs/live-slips.js';

const leg = (player, stat, point, label = stat) => ({ player, stat, label, point, price: -280 });
const slip = (bookId, american, legs) => ({ bookId, book: bookId, american, legs });

test('the same players and stats at several books are one bet, the best price leading', () => {
  const a = [leg('Kevin Huerter', 'points', 9.5, 'Pts'), leg('Isaiah Joe', 'rebounds', 2.5, 'Reb'), leg('Ausar Thompson', 'assists', 3.5, 'Ast')];
  const slips = [
    slip('draftkings', 141, a),
    slip('caesars', 167, [a[2], a[0], a[1]]), // the same three, in another order
    slip('fanduel', 120, [leg('Kevin Huerter', 'points', 10.5, 'Pts'), a[1], a[2]]), // the same bet at another number
    slip('betmgm', 110, [leg('Cade Cunningham', 'points', 19.5, 'Pts'), a[1], a[2]]), // other players: another bet
  ];
  const groups = groupLiveSlips(slips);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].slips.map((s) => [s.bookId, s.american, s.differs]), [['caesars', 167, false], ['draftkings', 141, false], ['fanduel', 120, true]]);
  assert.equal(groups[0].lead.bookId, 'caesars', 'the best-priced book\'s slip is the one drawn');
  assert.deepEqual(groups[1].slips.map((s) => s.bookId), ['betmgm']);
  assert.equal(slipKey(slips[0]), slipKey(slips[1]));
  assert.notEqual(slipKey(slips[0]), slipKey(slips[3]));
  assert.equal(slipNumbers(slips[2]), '10.5+ Pts · 2.5+ Reb · 3.5+ Ast');
});

test('the board\'s order stands, and an empty board is no bets', () => {
  const one = slip('fanduel', 100, [leg('A', 'points', 9.5)]); const two = slip('fanduel', 200, [leg('B', 'points', 9.5)]);
  assert.deepEqual(groupLiveSlips([one, two]).map((g) => g.lead.legs[0].player), ['A', 'B'], 'the board\'s best stays first, whatever its price');
  assert.deepEqual(groupLiveSlips([]), []); assert.deepEqual(groupLiveSlips(null), []);
  assert.deepEqual(groupLiveSlips([{ bookId: 'x', legs: [] }]), []);
});

test('a Discord post\'s link names one slip by league, game and key, and the app reads it back; anything else is no link', () => {
  const slip = { legs: [{ player: 'Kris Dunn', stat: 'rebounds', point: 4.5 }, { player: 'Jaylen Wells', stat: 'points', point: 7.5 }] };
  const hash = liveSlipHash('nba', '401810393', slip);
  assert.ok(hash.startsWith(LIVE_HASH_PREFIX));
  assert.equal(hash, `#live/nba/401810393/${encodeURIComponent(slipKey(slip))}`);
  assert.deepEqual(parseLiveHash(hash), { league: 'nba', gameId: '401810393', key: slipKey(slip) });
  assert.equal(liveSlipHash('nba', '401810393', slipKey(slip)), hash, 'a key is taken as given');
  assert.equal(liveSlipHash('nba', '', slip), '');
  assert.equal(liveSlipHash('nba', '1', { legs: [] }), '');
  for (const h of ['', '#', '#live', '#live/nba', '#live/nba/1', '#other/nba/1/x', '#live/nba/1/%E0%A4%A']) assert.equal(parseLiveHash(h), null, `${h} is not a slip link`);
});
