/**
 * A ticket at every book (docs/book-ways.js): the same number where the
 * book prices it, else the nearest easier number on the board, never a
 * harder one; a leg the book lacks is dropped and said; the versions are
 * ordered complete first; and the words a card and Playbook get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legAtBook, ticketAtBooks, bookWayNote, lineWord, bookIdOf, bookNameOf, toAmerican, LINEUP_BOOKS } from '../docs/book-ways.js';

const dec = (a) => (a < 0 ? 1 + 100 / -a : 1 + a / 100);
const q = (bookKey, american, id = 'x') => ({ bookKey, book: bookKey, american, decimal: dec(american), link: `https://${bookKey}.example/${id}` });
const leg = (over = {}) => ({ id: 'e1:points:mitchell:14.5', eventId: 'e1', sportKey: 'basketball_nba', playerName: 'Donovan Mitchell', statKey: 'points', statLabel: 'Pts', point: 14.5, side: 'over', selection: 'Donovan Mitchell Over 14.5 Pts', home: 'New York Knicks', away: 'Cleveland Cavaliers', quotes: [q('fanatics', -2000, 'a'), q('draftkings', -1800, 'b')], ...over });
const row = (point, quotes, over = {}) => ({ id: `e1:points:mitchell:${point}`, eventId: 'e1', sportKey: 'basketball_nba', playerName: 'Donovan Mitchell', statKey: 'points', statLabel: 'Pts', point, side: 'over', selection: `Donovan Mitchell Over ${point} Pts`, quotes, ...over });

test('legAtBook: the same number at the book\'s own price, else the nearest easier number it prices, never a harder one, else nothing', () => {
  const rows = [row(12.5, [q('fanduel', -3000, 'c')]), row(13.5, [q('fanduel', -2500, 'd'), q('williamhill_us', -2400, 'e')]), row(16.5, [q('fanduel', -500, 'f')]), row(14.5, [q('betmgm', -1900, 'g')])];
  assert.deepEqual(legAtBook(leg(), 'draftkings', rows), { bookId: 'draftkings', point: 14.5, selection: 'Donovan Mitchell Over 14.5 Pts', american: -1800, decimal: 1.0556, link: 'https://draftkings.example/b', moved: false, from: null, playerName: 'Donovan Mitchell', statKey: 'points', statLabel: 'Pts', game: 'Cleveland Cavaliers @ New York Knicks', legId: 'e1:points:mitchell:14.5' });
  const fd = legAtBook(leg(), 'fanduel', rows);
  assert.deepEqual([fd.point, fd.american, fd.link, fd.moved, fd.from, fd.selection], [13.5, -2500, 'https://fanduel.example/d', true, 14.5, 'Donovan Mitchell Over 13.5 Pts'], 'the nearest lower number, not the lowest, and never the 16.5');
  assert.equal(legAtBook(leg(), 'caesars', rows).point, 13.5, 'the feed\'s williamhill_us is Caesars');
  assert.equal(legAtBook(leg(), 'betmgm', rows).moved, false, 'the same number found on the board counts as the same number');
  assert.equal(legAtBook(leg(), 'bet365', rows), null);
  // An Under moves up, never down.
  const under = leg({ side: 'under', point: 20.5, selection: 'Donovan Mitchell Under 20.5 Pts', quotes: [] });
  const urows = [row(19.5, [q('fanduel', -200)], { side: 'under' }), row(22.5, [q('fanduel', -400)], { side: 'under' }), row(24.5, [q('fanduel', -600)], { side: 'under' })];
  assert.deepEqual([legAtBook(under, 'fanduel', urows).point, legAtBook(under, 'fanduel', urows).moved], [22.5, true]);
  // Another player's or another game's row is not this line.
  assert.equal(legAtBook(leg({ quotes: [] }), 'fanduel', [row(13.5, [q('fanduel', -2500)], { playerName: 'Ty Jerome' }), row(13.5, [q('fanduel', -2500)], { eventId: 'e2' })]), null);
});

test('ticketAtBooks: every other priced book, complete versions first, the dropped legs named, pick\'em apps and the ticket\'s own book left out', () => {
  const jerome = leg({ id: 'e1:assists:jerome:2.5', playerName: 'Ty Jerome', statKey: 'assists', statLabel: 'Ast', point: 2.5, selection: 'Ty Jerome Over 2.5 Ast', quotes: [q('fanatics', -1700), q('prizepicks', -119), q('betmgm', -1500, 'j')] });
  const rows = [row(13.5, [q('fanduel', -2500, 'd')])];
  const ways = ticketAtBooks([leg(), jerome], rows, { exclude: 'fanatics' });
  assert.deepEqual(ways.map((w) => [w.bookId, w.book, w.complete, w.moved, w.dropped.map((d) => d.selection), w.legs.map((l) => l.point)]), [
    ['betmgm', 'BetMGM', false, 0, ['Donovan Mitchell Over 14.5 Pts'], [2.5]],
    ['draftkings', 'DraftKings', false, 0, ['Ty Jerome Over 2.5 Ast'], [14.5]],
    ['fanduel', 'FanDuel', false, 1, ['Ty Jerome Over 2.5 Ast'], [13.5]],
  ].map((x) => x), 'none is complete: each book has one of the two; the better price first among equals');
  assert.ok(!ways.some((w) => w.bookId === 'prizepicks' || w.bookId === 'fanatics'));
  assert.equal(ways[1].american, -1800);
  // With the Jerome line on the board at FanDuel too, FanDuel is complete and leads.
  const full = ticketAtBooks([leg(), jerome], [...rows, { ...jerome, id: 'e1:assists:jerome:1.5', point: 1.5, selection: 'Ty Jerome Over 1.5 Ast', quotes: [q('fanduel', -3000, 'k')] }], { exclude: 'fanatics' });
  assert.deepEqual([full[0].bookId, full[0].complete, full[0].moved, full[0].legs.map((l) => [l.point, l.from])], ['fanduel', true, 2, [[13.5, 14.5], [1.5, 2.5]]]);
  assert.equal(full[0].decimal, Math.round(full[0].legs.reduce((d, l) => d * l.decimal, 1) * 10000) / 10000, 'the kept legs multiplied');
  assert.equal(full[0].american, toAmerican(full[0].decimal));
  assert.deepEqual(ticketAtBooks([], rows), []);
  assert.deepEqual(ticketAtBooks([leg({ quotes: [] })], [], { exclude: 'fanatics' }), [], 'no quotes and no board: no other book');
  assert.deepEqual(ticketAtBooks([leg()], [], { books: ['draftkings', 'bet365'] }).map((w) => w.bookId), ['draftkings'], 'a given list is honoured');
});

test('the words: a moved leg says both numbers, a dropped leg is named, a version as drawn says nothing', () => {
  const way = { legs: [{ playerName: 'Donovan Mitchell', statLabel: 'Pts', point: 13.5, from: 14.5, moved: true }, { playerName: 'Ty Jerome', statLabel: 'Ast', point: 2.5, moved: false }], dropped: [{ selection: 'Evan Mobley Over 7.5 Reb' }] };
  assert.equal(bookWayNote(way), 'Mitchell Pts 14+ instead of 15+ · without Evan Mobley Over 7.5 Reb');
  assert.equal(bookWayNote({ legs: [{ moved: false }], dropped: [] }), '');
  assert.deepEqual([lineWord(14.5), lineWord(15), lineWord(20.5, 'under'), lineWord(21, 'under')], ['15+', '16+', 'under 21', 'under 21']);
  assert.deepEqual([bookIdOf('williamhill_us'), bookIdOf('underdog'), bookIdOf(''), bookNameOf('caesars'), bookNameOf('underdog'), bookNameOf('zzz')], ['caesars', 'underdog', null, 'Caesars', 'Underdog', 'zzz']);
  assert.deepEqual(LINEUP_BOOKS, ['prizepicks', 'underdog', 'sleeper']);
});

// --- Every sportsbook's row (2026-11-26: a ticket the feed had at Hard Rock alone was whole at DraftKings and Fanatics) ---
import { ticketBookRows, TICKET_BOOKS } from '../docs/book-ways.js';

test('every sportsbook gets a row: the feed\'s whole versions, its partial ones asking Playbook for the whole ticket, and the books it has nothing for', () => {
  const q = (bookId, american, link = `https://book.example/${bookId}`) => ({ bookId, american, decimal: american > 0 ? 1 + american / 100 : 1 + 100 / -american, link });
  // The ticket of 2026-11-26, at Hard Rock: the feed had the first leg there alone.
  const williams = { id: 'e1:passTds:caleb williams:2.5:under', playerName: 'Caleb Williams', statKey: 'passTds', statLabel: 'Pass TD', point: 2.5, side: 'under', selection: 'Caleb Williams Under 2.5 Pass TD', away: 'Chicago Bears', home: 'Detroit Lions', eventId: 'e1', quotes: [q('hardrock', -225)] };
  const worthy = { id: 'e2:receptions:xavier worthy:1.5:over', playerName: 'Xavier Worthy', statKey: 'receptions', statLabel: 'Rec', point: 1.5, side: 'over', selection: 'Xavier Worthy Over 1.5 Rec', away: 'Kansas City Chiefs', home: 'Buffalo Bills', eventId: 'e2', quotes: [q('hardrock', -230), q('fanatics', -235), q('caesars', -240), q('prizepicks', -137)] };
  const legs = [williams, worthy];
  const ways = ticketAtBooks(legs, [], { exclude: 'hardrock' });
  assert.deepEqual(ways.map((w) => [w.bookId, w.complete, w.legs.length]), [['fanatics', false, 1], ['caesars', false, 1]]);
  const rows = ticketBookRows(legs, ways, { exclude: 'hardrock' });
  // The feed's rows first, then every other sportsbook; the ticket's own book and the pick'em apps are not rows.
  assert.deepEqual(rows.map((r) => r.bookId), ['fanatics', 'caesars', 'draftkings', 'fanduel', 'betmgm', 'bet365', 'betrivers', 'espnbet']);
  assert.ok(!rows.some((r) => r.bookId === 'hardrock' || r.bookId === 'prizepicks'));
  const fanatics = rows[0];
  assert.deepEqual([fanatics.unpriced, fanatics.complete, fanatics.legs.length, fanatics.dropped.map((d) => d.selection)], [false, false, 1, ['Caleb Williams Under 2.5 Pass TD']]);
  // Playbook is asked for the whole ticket, in the ticket's order, each leg with its game.
  assert.deepEqual(fanatics.ask, [{ selection: 'Caleb Williams Under 2.5 Pass TD', game: 'Chicago Bears @ Detroit Lions' }, { selection: 'Xavier Worthy Over 1.5 Rec', game: 'Kansas City Chiefs @ Buffalo Bills' }]);
  const dk = rows.find((r) => r.bookId === 'draftkings');
  assert.deepEqual([dk.unpriced, dk.complete, dk.legs, dk.american, dk.book], [true, false, [], null, 'DraftKings']);
  assert.deepEqual(dk.ask, fanatics.ask);
  assert.equal(dk.dropped.length, 2);
});

test('a book whose number was moved is asked for its own number, and a whole version asks for what it holds', () => {
  const q = (bookId, american) => ({ bookId, american, decimal: 1.5, link: `https://book.example/${bookId}` });
  const a = { id: 'a', playerName: 'Ty Jerome', statKey: 'assists', statLabel: 'Ast', point: 3.5, side: 'over', selection: 'Ty Jerome Over 3.5 Ast', away: 'A', home: 'B', eventId: 'e1', sportKey: 'basketball_nba', quotes: [q('draftkings', -150), q('fanduel', -160)] };
  const b = { id: 'b', playerName: 'Tyrese Maxey', statKey: 'points', statLabel: 'Pts', point: 19.5, side: 'over', selection: 'Tyrese Maxey Over 19.5 Pts', away: 'C', home: 'D', eventId: 'e2', sportKey: 'basketball_nba', quotes: [q('draftkings', -200)] };
  // FanDuel has Maxey at a lower number on the board.
  const board = [{ statKey: 'points', playerName: 'Tyrese Maxey', eventId: 'e2', sportKey: 'basketball_nba', side: 'over', point: 17.5, selection: 'Tyrese Maxey Over 17.5 Pts', quotes: [q('fanduel', -300)] }];
  const ways = ticketAtBooks([a, b], board, { exclude: 'draftkings' });
  const rows = ticketBookRows([a, b], ways, { exclude: 'draftkings', books: ['fanduel', 'draftkings', 'betmgm'] });
  assert.deepEqual(rows.map((r) => [r.bookId, r.complete, r.unpriced]), [['fanduel', true, false], ['betmgm', false, true]]);
  assert.deepEqual(rows[0].ask.map((l) => l.selection), ['Ty Jerome Over 3.5 Ast', 'Tyrese Maxey Over 17.5 Pts']);
  assert.deepEqual(ticketBookRows([], ways), []);
  assert.deepEqual(ticketBookRows([a, b], null, { exclude: 'draftkings', books: [] }), []);
  assert.ok(TICKET_BOOKS.includes('fanatics') && TICKET_BOOKS.includes('espnbet') && !TICKET_BOOKS.includes('prizepicks'));
});
