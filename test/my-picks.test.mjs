import test from 'node:test';
import assert from 'node:assert/strict';
import { drawMyTicket, getMyPicks, myPicksKey } from '../worker/src/my-picks.js';
import { cleanPicks, getSettings, putSettings, PICK_PREF_DEFAULTS } from '../worker/src/settings.js';

const NOW = Date.parse('2026-10-27T15:00:00Z'); // 11am ET Oct 27
const DATE = '2026-10-27';
const ctx = { waitUntil: (p) => p };
function makeKvStore() {
  const store = new Map();
  return { store, env: { POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
const period = (rate, games) => ({ rate, hits: Math.round(rate * games), games, avg: 12, median: 12 });
const dec = (american) => (american < 0 ? 1 + 100 / -american : 1 + american / 100);
let n = 0;
/** A Trends row: its score comes from the rates (1.0 everywhere is five stars; a thin head to head and a miss or two pull it down). */
function row(player, { rate = 1, h2hRate = 1, books = { draftkings: -200 }, commenceMs = NOW + 8 * 3.6e6, point = 9.5, side = 'over', statKey = 'points', eventId = 'g1', team = 'CHA', injury = null, alt = false } = {}) {
  n++;
  const quotes = Object.entries(books).map(([bookKey, price]) => ({ bookKey, book: bookKey, american: price, decimal: dec(price), link: `https://${bookKey}.example/${n}` }));
  const series = Array.from({ length: 20 }, (_, i) => ({ value: 10 + (i % 5), hit: i < Math.round(rate * 20) ? 1 : 0, date: NOW - (i + 1) * 864e5, opponent: 'ORL' }));
  return {
    id: `r${n}`, eventId, sportKey: 'basketball_nba', sportTitle: 'NBA', commenceMs, home: 'Charlotte Hornets', away: 'Orlando Magic',
    playerName: player, team, opponent: 'ORL', athleteId: String(n), headshot: null, statKey, statLabel: 'Pts', marketLabel: alt ? 'Points (alt)' : 'Points', point, side,
    selection: `${player} ${side === 'over' ? 'Over' : 'Under'} ${point} Pts`, american: quotes[0].american, decimal: quotes[0].decimal, book: 'DraftKings', quotes,
    seasons: [2026, 2025], rates: { l20: rate, h2h: h2hRate, s2026: rate }, periods: { l5: period(rate, 5), l10: period(rate, 10), l20: period(rate, 20), h2h: period(h2hRate, 3), s2026: period(rate, 5) }, series, injury,
  };
}

test('the settings keep the book, the floor by halves between two and five, and the legs between one and six, and a field left out keeps what is stored', () => {
  assert.equal(cleanPicks(null), null, 'unset until saved once');
  assert.deepEqual((({ book, minScore, legs }) => ({ book, minScore, legs }))(cleanPicks({})), PICK_PREF_DEFAULTS);
  const saved = cleanPicks({ book: 'FanDuel', minScore: 4.3, legs: 9 });
  assert.deepEqual([saved.book, saved.minScore, saved.legs], ['fanduel', 4.5, 6]);
  const kept = cleanPicks({ legs: 1 }, saved);
  assert.deepEqual([kept.book, kept.minScore, kept.legs], ['fanduel', 4.5, 1]);
  const bad = cleanPicks({ book: 'bodog', minScore: 'x', legs: 0 }, saved);
  assert.deepEqual([bad.book, bad.minScore, bad.legs], ['fanduel', 4.5, 1]);
});

test('the account record carries the pick settings beside the bankroll and the books, and a bankroll save leaves them alone', async () => {
  const { env } = makeKvStore();
  await putSettings(env, { picks: { book: 'caesars', minScore: 3.5, legs: 3 } }, 'u1');
  await putSettings(env, { bankroll: { amount: 500, unit: 10 } }, 'u1');
  const s = await getSettings(env, 'u1');
  assert.deepEqual([s.picks.book, s.picks.minScore, s.picks.legs, s.bankroll.amount], ['caesars', 3.5, 3, 500]);
  assert.equal((await getSettings(env, 'u2')), null);
});

test('the draw takes the best legs at the user\'s book over the floor, one per player, different games first, and says why when nothing clears', () => {
  const rows = [
    row('Five Star', { books: { draftkings: -180, fanduel: -170 } }),
    row('Five Star', { books: { draftkings: -300 }, statKey: 'rebounds', point: 6.5 }), // the same player again: never twice on a ticket
    row('Other Game', { books: { draftkings: -220 }, eventId: 'g2', team: 'BOS' }),
    row('Same Game', { books: { draftkings: -150 } }),
    row('Weak Line', { rate: 0.7, h2hRate: 0.33, books: { draftkings: -110 } }),
    row('Out Man', { books: { draftkings: -200 }, injury: { status: 'Out', level: 'out' } }),
    row('No Book', { books: { betmgm: -200 } }),
    row('Too Heavy', { books: { draftkings: -600 } }),
    row('Started', { books: { draftkings: -200 }, commenceMs: NOW - 3.6e6 }),
  ];
  const two = drawMyTicket(rows, { book: 'draftkings', minScore: 4, legs: 2 }, DATE, NOW);
  assert.equal(two.bet.type, 'parlay');
  assert.deepEqual(two.bet.legs.map((l) => l.playerName), ['Same Game', 'Other Game'], 'five stars at the better price first, then a leg from another game before a second from the same one');
  assert.equal(two.bet.bookId, 'draftkings');
  assert.equal(two.bet.american, 142, '-150 and -220 make +142');
  assert.equal(two.bet.short, null);
  assert.deepEqual(two.bet.prefs, { book: 'draftkings', minScore: 4, legs: 2 });
  const four = drawMyTicket(rows, { book: 'draftkings', minScore: 4, legs: 4 }, DATE, NOW);
  assert.deepEqual(four.bet.legs.map((l) => l.playerName), ['Same Game', 'Other Game', 'Five Star'], 'the third leg comes from a game already on the ticket');
  assert.match(four.bet.short, /3 of the 4 legs/);
  const one = drawMyTicket(rows, { book: 'draftkings', minScore: 4, legs: 1 }, DATE, NOW);
  assert.equal(one.bet.type, 'straight');
  assert.equal(one.bet.legs[0].playerName, 'Same Game');
  assert.equal(one.bet.link, one.bet.legs[0].link, 'a straight carries its own slip link');
  const fd = drawMyTicket(rows, { book: 'fanduel', minScore: 4, legs: 2 }, DATE, NOW);
  assert.deepEqual(fd.bet.legs.map((l) => [l.playerName, l.american]), [['Five Star', -170]]);
  assert.match(fd.bet.short, /1 of the 2/);
  const none = drawMyTicket(rows, { book: 'betrivers', minScore: 4, legs: 2 }, DATE, NOW);
  assert.equal(none.bet, null);
  assert.match(none.reason, /BetRivers has not priced/);
  const floor = drawMyTicket(rows, { book: 'betmgm', minScore: 5, legs: 2 }, DATE, NOW);
  assert.equal(floor.bet.legs[0].playerName, 'No Book');
  const tooHigh = drawMyTicket([row('Weak Line', { rate: 0.7, h2hRate: 0.33, books: { betmgm: -110 } })], { book: 'betmgm', minScore: 4, legs: 2 }, DATE, NOW);
  assert.equal(tooHigh.bet, null);
  assert.match(tooHigh.reason, /clears 4 stars/);
});

test('a PrizePicks ticket is a lineup of two to six projections at the play\'s own multiplier, never on an alternate number', () => {
  const rows = [
    row('A', { books: { prizepicks: -137 } }),
    row('B', { books: { prizepicks: -137 }, eventId: 'g2', team: 'BOS' }),
    row('C', { books: { prizepicks: -137 }, eventId: 'g3', team: 'MIA' }),
    row('Alt', { books: { prizepicks: -137 }, eventId: 'g4', team: 'DET', alt: true }),
  ];
  const lineup = drawMyTicket(rows, { book: 'prizepicks', minScore: 4, legs: 1 }, DATE, NOW);
  assert.deepEqual([lineup.bet.shape, lineup.bet.play, lineup.bet.decimal, lineup.bet.legs.length], ['power2', 'PrizePicks 2-pick Power Play', 3, 2], 'one leg asked for becomes a two-pick');
  const three = drawMyTicket(rows, { book: 'prizepicks', minScore: 4, legs: 3 }, DATE, NOW);
  assert.deepEqual([three.bet.shape, three.bet.decimal, three.bet.legs.map((l) => l.playerName)], ['flex3', 2.25, ['A', 'B', 'C']], 'the alternate number never rides');
  const four = drawMyTicket(rows, { book: 'prizepicks', minScore: 4, legs: 4 }, DATE, NOW);
  assert.equal(four.bet.legs.length, 3);
});

test('the user\'s ticket is drawn once a day, redrawn only before a leg starts, graded when read, and kept with its record', async () => {
  const { env, store } = makeKvStore();
  const rows = [row('Five Star', { books: { draftkings: -180 } }), row('Other Game', { books: { draftkings: -220 }, eventId: 'g2', team: 'BOS' })];
  const prefs = { book: 'draftkings', minScore: 4, legs: 2 };
  const unset = await getMyPicks(env, ctx, 'u1', NOW, { prefs: null, deps: { rowsFor: async () => rows } });
  assert.equal(unset.today, null);
  assert.equal(store.has(myPicksKey('u1')), false, 'nothing stored while the settings are unset');
  const first = await getMyPicks(env, ctx, 'u1', NOW, { prefs, deps: { rowsFor: async () => rows } });
  assert.equal(first.today.id, `${DATE}:mine`);
  assert.equal(first.today.legs.length, 2);
  const again = await getMyPicks(env, ctx, 'u1', NOW + 60e3, { prefs, deps: { rowsFor: async () => [] } });
  assert.equal(again.today.postedAt, first.today.postedAt, 'the same ticket on the next read, whatever the board does');
  const redrawn = await getMyPicks(env, ctx, 'u1', NOW + 120e3, { prefs: { ...prefs, legs: 1 }, redraw: true, deps: { rowsFor: async () => rows } });
  assert.equal(redrawn.redrawn, true);
  assert.equal(redrawn.today.type, 'straight');
  const late = await getMyPicks(env, ctx, 'u1', NOW + 9 * 3.6e6, { prefs, redraw: true, deps: { rowsFor: async () => rows } });
  assert.equal(late.redrawn, false);
  assert.match(late.reason, /has started/);
  assert.equal(late.today.type, 'straight', 'the ticket stands once a leg has tipped');
  const graded = await getMyPicks(env, ctx, 'u1', NOW + 12 * 3.6e6, { prefs, deps: { rowsFor: async () => [], actual: async () => 14 } });
  assert.deepEqual([graded.today.status, graded.today.result, graded.today.legs[0].actual], ['graded', 'win', 14]);
  assert.deepEqual(graded.record, { wins: 1, losses: 0, pushes: 0, voids: 0, units: 0.56, risked: 1, roi: 0.56 });
  const nextDay = await getMyPicks(env, ctx, 'u1', NOW + 24 * 3.6e6, { prefs, deps: { rowsFor: async () => [] } });
  assert.equal(nextDay.today, null);
  assert.match(nextDay.reason, /No games left/);
  assert.equal(nextDay.history.length, 1);
  assert.equal((await getMyPicks(env, ctx, 'u2', NOW, { prefs, deps: { rowsFor: async () => [] } })).record.risked, 0, 'another account sees nothing of it');
});
