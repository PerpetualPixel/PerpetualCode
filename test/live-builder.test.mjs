import test from 'node:test';
import assert from 'node:assert/strict';
import { builderLegs, boardLegs, builderView, toggleLeg, legId, legLine, sameLine, BUILDER_GAME_LEGS } from '../docs/live-builder.js';

const cand = (bookId, player, stat, point, price, over = {}) => ({ bookId, book: bookId === 'fanduel' ? 'FanDuel' : 'DraftKings', market: 'm', stat, label: stat === 'rushingYards' ? 'Rush Yds' : stat === 'receptions' ? 'Rec' : 'Rec Yds', player, team: 'GB', athleteId: '9', point, price, decimal: 1.5, current: 4, pace: 9, cushion: 0.4, link: `https://book.example/${bookId}/${point}`, ...over });

test('one book\'s legs of a game: that book only, one row a player, stat and number at its best price, the widest cushion first', () => {
  const candidates = [
    cand('fanduel', 'Chris Brooks', 'rushingYards', 4.5, -280, { cushion: 0.9 }),
    cand('draftkings', 'Chris Brooks', 'rushingYards', 4.5, -260, { cushion: 0.9 }),
    cand('fanduel', 'Chris Brooks', 'rushingYards', 4.5, -250, { cushion: 0.9 }),
    cand('fanduel', 'Chris Brooks', 'rushingYards', 9.5, -140, { cushion: 0.3 }),
    cand('fanduel', 'Davis Allen', 'receptions', 2.5, -235, { cushion: 1.2 }),
    cand('fanduel', 'No Number', 'receptions', NaN, -200),
  ];
  const legs = builderLegs(candidates, 'fanduel');
  assert.deepEqual(legs.map((l) => [l.player, l.point, l.price]), [['Davis Allen', 2.5, -235], ['Chris Brooks', 4.5, -250], ['Chris Brooks', 9.5, -140]]);
  assert.deepEqual(Object.keys(legs[0]).sort(), ['book', 'bookId', 'current', 'cushion', 'label', 'link', 'pace', 'player', 'point', 'price', 'stat', 'team']);
  assert.deepEqual(builderLegs(candidates, 'betmgm'), []);
  assert.deepEqual(builderLegs(candidates, null), []);
  assert.deepEqual(builderLegs(null, 'fanduel'), []);
  const many = Array.from({ length: 50 }, (_, n) => cand('fanduel', `Player ${n}`, 'receptions', 2.5, -200));
  assert.equal(builderLegs(many, 'fanduel').length, BUILDER_GAME_LEGS);
});

const game = (id, legs, over = {}) => ({ espnEventId: id, name: 'Los Angeles Rams at Green Bay Packers', league: 'nfl', elapsed: 0.5, tick: { state: 'in', detail: '15:00 - 3rd' }, legs, ...over });
const leg = (player, stat, point, price, current, over = {}) => ({ bookId: 'fanduel', book: 'FanDuel', player, team: 'GB', stat, label: stat === 'rushingYards' ? 'Rush Yds' : 'Rec', point, price, current, pace: current * 2, cushion: 0.3, link: `https://sportsbook.fanduel.com/addToBetslip?marketId=${point}&selectionId=${current}`, ...over });

test('the board at a book: the in-play games\' legs there, the furthest ahead of pace first', () => {
  const games = [
    game('g1', [leg('Chris Brooks', 'rushingYards', 4.5, -280, 4), leg('Kyren Williams', 'receptions', 5.5, -245, 4), leg('Other Book', 'receptions', 1.5, -200, 1, { bookId: 'draftkings' })]),
    game('g2', [leg('Davis Allen', 'receptions', 2.5, -235, 2)], { elapsed: 0.4 }),
    game('g3', [leg('Not Started', 'receptions', 2.5, -235, 2)], { tick: { state: 'pre' } }),
  ];
  const board = boardLegs(games, 'fanduel');
  // 4 against 4.5 at the half is 4 / 2.25 = 178%; 2 against 2.5 at 40% is 200%; 4 against 5.5 at the half is 145%.
  assert.deepEqual(board.map((r) => [r.player, r.pacePct, r.gameId]), [['Davis Allen', 200, 'g2'], ['Chris Brooks', 178, 'g1'], ['Kyren Williams', 145, 'g1']]);
  assert.equal(board[0].id, 'g2|davis allen|receptions|2.5');
  assert.equal(board[0].paceLevel, 'ahead');
  assert.ok(Math.abs(board[1].decimal - (1 + 100 / 280)) < 1e-9);
  assert.deepEqual(boardLegs(games, 'betmgm'), []);
  assert.deepEqual(boardLegs(null, 'fanduel'), []);
});

test('ticks: a parlay is priced from two legs, a second number of one line is blocked, and a full ticket takes no more', () => {
  const games = [game('g1', [leg('Chris Brooks', 'rushingYards', 4.5, -280, 4), leg('Chris Brooks', 'rushingYards', 9.5, -140, 4), leg('Kyren Williams', 'receptions', 5.5, -245, 4)]), game('g2', [leg('Davis Allen', 'receptions', 2.5, -235, 2)])];
  const board = boardLegs(games, 'fanduel');
  const row = (player, point) => board.find((r) => r.player === player && r.point === point);
  let picked = toggleLeg([], row('Chris Brooks', 4.5), board);
  assert.equal(builderView(board, picked).price, null, 'one leg is not a parlay');
  picked = toggleLeg(picked, row('Davis Allen', 2.5), board);
  const view = builderView(board, picked);
  assert.deepEqual(view.live.map((l) => l.player), ['Chris Brooks', 'Davis Allen']);
  const dec = (1 + 100 / 280) * (1 + 100 / 235);
  assert.ok(Math.abs(view.price.decimal - dec) < 1e-3);
  assert.equal(view.price.american, Math.round(-100 / (dec - 1)));
  assert.equal(view.sameGame, false);
  assert.deepEqual(view.rows.map((r) => [r.player, r.point, r.checked, r.blocked]).sort(), [['Chris Brooks', 4.5, true, null], ['Chris Brooks', 9.5, false, 'line'], ['Davis Allen', 2.5, true, null], ['Kyren Williams', 5.5, false, null]].sort());
  // The blocked number does not go on; the same game's other player does, and the ticket says it is a same-game one.
  assert.equal(toggleLeg(picked, row('Chris Brooks', 9.5), board), picked);
  const three = toggleLeg(picked, row('Kyren Williams', 5.5), board);
  assert.equal(builderView(board, three).sameGame, true);
  // Full at two: the third row is blocked and a tap leaves the ticks alone; a ticked row still comes off.
  const full = builderView(board, picked, { maxLegs: 2 });
  assert.equal(full.full, true);
  assert.equal(full.rows.find((r) => r.player === 'Kyren Williams').blocked, 'full');
  assert.equal(toggleLeg(picked, row('Kyren Williams', 5.5), board, { maxLegs: 2 }), picked);
  assert.deepEqual(toggleLeg(picked, row('Chris Brooks', 4.5), board, { maxLegs: 2 }).map((p) => p.player), ['Davis Allen']);
  assert.equal(toggleLeg(picked, null, board), picked);
});

test('a ticked leg the board no longer has stays on the list as gone, off the price, and gives way to another number of its line', () => {
  const before = boardLegs([game('g1', [leg('Chris Brooks', 'rushingYards', 4.5, -280, 4), leg('Kyren Williams', 'receptions', 5.5, -245, 4), leg('Davis Allen', 'receptions', 2.5, -235, 2)])], 'fanduel');
  let picked = [];
  for (const r of before) picked = toggleLeg(picked, r, before);
  assert.equal(picked.length, 3);
  // The next read: Brooks got there (his 4.5 is gone, a 9.5 is up) and Williams's price moved.
  const after = boardLegs([game('g1', [leg('Chris Brooks', 'rushingYards', 9.5, -150, 6), leg('Kyren Williams', 'receptions', 5.5, -300, 5), leg('Davis Allen', 'receptions', 2.5, -235, 2)])], 'fanduel');
  const view = builderView(after, picked);
  assert.deepEqual(view.chosen.map((c) => [c.player, c.point, c.gone, c.price]).sort(), [['Chris Brooks', 4.5, true, -280], ['Davis Allen', 2.5, false, -235], ['Kyren Williams', 5.5, false, -300]].sort());
  assert.equal(view.live.length, 2);
  assert.ok(Math.abs(view.price.decimal - (1 + 100 / 300) * (1 + 100 / 235)) < 1e-3, 'priced at the prices now, without the leg that is gone');
  assert.equal(view.rows.find((r) => r.player === 'Chris Brooks').blocked, null, 'the gone number does not block the new one');
  const next = toggleLeg(picked, after.find((r) => r.player === 'Chris Brooks'), after);
  assert.deepEqual(next.map((p) => [p.player, p.point]).sort(), [['Chris Brooks', 9.5], ['Davis Allen', 2.5], ['Kyren Williams', 5.5]].sort());
});

test('a pick\'em lineup pays its own table, and has no price past six', () => {
  const legs = Array.from({ length: 7 }, (_, n) => leg(`Player ${n}`, 'receptions', 2.5, -137, 2, { bookId: 'prizepicks', book: 'PrizePicks' }));
  const board = boardLegs([game('g1', legs)], 'prizepicks');
  let picked = [];
  for (const r of board.slice(0, 3)) picked = toggleLeg(picked, r, board, { maxLegs: 6 });
  assert.deepEqual(builderView(board, picked, { maxLegs: 6, pickem: true }).price, { decimal: 5, american: 400 });
  for (const r of board.slice(3)) picked = toggleLeg(picked, r, board, { maxLegs: 6 });
  assert.equal(picked.length, 6, 'the seventh does not go on');
  assert.deepEqual(builderView(board, picked, { maxLegs: 6, pickem: true }).price, { decimal: 25, american: 2400 });
});

test('ids and lines', () => {
  assert.equal(legLine({ player: ' Chris Brooks ', stat: 'rushingYards' }), 'chris brooks|rushingyards');
  assert.equal(legId('g1', { player: 'Chris Brooks', stat: 'rushingYards', point: 4.5 }), 'g1|chris brooks|rushingyards|4.5');
  assert.equal(sameLine({ gameId: 'g1', player: 'A', stat: 's' }, { gameId: 'g1', player: 'a', stat: 'S' }), true);
  assert.equal(sameLine({ gameId: 'g1', player: 'A', stat: 's' }, { gameId: 'g2', player: 'A', stat: 's' }), false);
  assert.equal(sameLine(null, { gameId: 'g1' }), false);
});

// --- The Live tab's wiring (docs/app.js, docs/styles.css, worker/src/index.js) ---
import fs from 'node:fs';
const app = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../docs/styles.css', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');

test('the Live tab: the mode asks the board for one book\'s legs, a change of book asks first, and a link to a slip lands on the slips', () => {
  assert.match(app, /if \(liveBuilder\.on && liveBuilder\.book\) url\.searchParams\.set\('legs', liveBuilder\.book\);/);
  assert.match(app, /if \(seq !== liveState\.seq\) return;/, 'a read a newer one has overtaken draws nothing');
  assert.match(app, /window\.confirm\('Changing sportsbooks will reset your parlay selection\. Continue\?'\)/);
  assert.match(app, /Please select a single sportsbook to start building your custom parlay\./);
  assert.match(app, /liveBuilder\.on = false; \/\/ the slip a link names is on the slips view/);
  // The button is the book's own one link for the ticked legs, and is off under two legs.
  assert.match(app, /const all = n >= BUILDER_MIN_LEGS \? combinedSlipLink\(book, view\.live\.map\(\(l\) => l\.link\)\) : null;/);
  assert.match(app, /<button type="button" class="lb-cta" disabled>Create parlay link for \$\{esc\(name\)\}<\/button>/);
});

test('the worker gives legs only for a book on the live list', () => {
  assert.match(worker, /const legsBook = asked && LIVE_BOOKS\.includes\(asked\) \? asked : null;/);
  assert.match(worker, /getLiveBoard\(env, now, \{ ctx, legsBook \}\)/);
});

test('the styles: the ticket sits beside the board only with room for it, and the button is not drawn as a link', () => {
  assert.match(css, /@container lbwrap \(min-width: 900px\) \{\s*\.lb \{ grid-template-columns: minmax\(0, 1fr\) 320px; \}/);
  assert.match(css, /@container lbboard \(min-width: 640px\)/);
  assert.match(css, /#liveView a\.lb-cta, #liveView a\.lb-cta:hover, #liveView a\.lb-cta:visited \{ color: #fff; text-decoration: none; \}/);
  assert.match(css, /\.lb-panel \{ position: sticky; bottom: calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\);/);
});

test('a tick is drawn in place: the board is not redrawn, the tapped row stays where it is, and nothing is focused by hand', () => {
  // 2026-11-26, the owner, on a phone: "When I click the check boxes, the screen jumps to the top ... The screen should not move".
  const at = app.indexOf('function liveBuilderToggle(id) {');
  const toggle = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(toggle, /if \(!liveBuilderRefresh\(\)\) \{ renderLive\(\); return; \}/, 'the whole tab is drawn only when there is no board to draw onto');
  assert.match(toggle, /const shift = tapped\.getBoundingClientRect\(\)\.top - top; if \(Math\.abs\(shift\) >= 1\) window\.scrollBy\(0, shift\);/);
  assert.doesNotMatch(toggle, /\.focus\(/, 'the box that was tapped is still the same box: no focus call to scroll to');
  const rat = app.indexOf('function liveBuilderRefresh() {');
  const refresh = app.slice(rat, app.indexOf('\n}\n', rat));
  assert.doesNotMatch(refresh, /liveBody\.innerHTML/);
  assert.match(refresh, /if \(panel\) panel\.outerHTML = liveBuilderPanel\(view, book\);/, 'only the ticket is drawn again');
  // The ticket's own buttons, and the minute's re-read, leave the page where it is.
  assert.match(app, /if \(lbRemove\) \{ liveBuilder\.picked = liveBuilder\.picked\.filter\(\(p\) => p\.id !== lbRemove\.dataset\.lbRemove\); liveBuilderRedraw\(\); return; \}/);
  assert.match(app, /if \(Math\.abs\(window\.scrollY - scrollY\) > 1\) window\.scrollTo\(window\.scrollX, scrollY\);/);
  // The hidden box is held inside its own label.
  assert.match(css, /\.lb-check \{ position: relative;/);
  assert.match(css, /\.lb-check input \{ position: absolute; left: 0; top: 0; width: 1px; height: 1px;/);
});
