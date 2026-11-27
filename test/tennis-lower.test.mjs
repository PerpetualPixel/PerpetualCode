import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerTierOf, lowerTourOf, lowerShares, lowerCall, winnerFromDraw, mergeLower, lowerBoard, LOWER_GIVE_UP_MS, LOWER_KEEP_MS } from '../worker/src/tennis-lower.js';

const H = 3600e3;
const NOW = Date.parse('2026-11-27T06:00:00Z');
const ev = (id, comp, a, b, startH, ml, extra = {}) => ({ id, comp, compId: comp, a, b, start: NOW + startH * H, inPlay: false, ml: ml ? { a: ml[0], b: ml[1], market: `m${id}`, selA: `${id}a`, selB: `${id}b` } : null, ...extra });

test('a competition is read by its name: Challenger, ITF and the 125s, never a tour event or an exhibition', () => {
  assert.equal(lowerTierOf('Monastir Challenger 2026'), 'challenger');
  assert.equal(lowerTierOf('ITF W15 Antalya TUR'), 'itf');
  assert.equal(lowerTierOf('WTA Buenos Aires 125K'), '125');
  assert.equal(lowerTierOf('UTR Men Newport Beach USA'), null);
  assert.equal(lowerTierOf("Men's Australian Open 2027"), null);
  assert.equal(lowerTierOf('ATP Finals'), null);
  assert.equal(lowerTourOf('ITF W35 Heraklion GRE'), 'wta');
  assert.equal(lowerTourOf('ITF M15 Monastir TUN'), 'atp');
  assert.equal(lowerTourOf('Hersonissos Challenger 2026'), 'atp');
  assert.equal(lowerTourOf('WTA Buenos Aires 125K'), 'wta');
});

test('the shares are the two prices with the cut out', () => {
  const s = lowerShares({ a: -200, b: 150 });
  assert.ok(Math.abs(s.a + s.b - 1) < 1e-9);
  assert.ok(Math.abs(s.a - 0.625) < 0.001);
  assert.ok(Math.abs(s.cut - (2 / 3 + 0.4 - 1)) < 1e-9);
  assert.equal(lowerShares({ a: -200 }), null);
  assert.equal(lowerShares(null), null);
});

test('a clear favourite at a price to take alone is a straight lean', () => {
  const c = lowerCall({ a: 'Kimmer Coppejans', b: 'Dali Blanch', ml: { a: -190, b: 145 }, open: { a: -190, b: 145 } });
  assert.equal(c.kind, 'lean');
  assert.equal(c.side, 'a');
  assert.equal(c.name, 'Kimmer Coppejans');
  assert.equal(c.how, 'straight');
  assert.equal(c.american, -190);
  assert.ok(c.share > 0.6 && c.share < 0.65);
  assert.ok(c.why.some((w) => /half a unit at most/.test(w)));
});

test('the favourite on the second side is leaned the same way', () => {
  const c = lowerCall({ a: 'A One', b: 'B Two', ml: { a: 170, b: -220 } });
  assert.equal(c.kind, 'lean');
  assert.equal(c.side, 'b');
  assert.equal(c.name, 'B Two');
  assert.equal(c.opponent, 'A One');
});

test('a short favourite is a parlay piece, and one priced as won is no lean', () => {
  const piece = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -400, b: 280 } });
  assert.equal(piece.kind, 'lean');
  assert.equal(piece.how, 'parlay');
  const won = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -1200, b: 650 } });
  assert.equal(won.kind, 'none');
  assert.equal(won.reason, 'short');
});

test('a match the book has near even is too close to call', () => {
  const c = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -125, b: -105 } });
  assert.equal(c.kind, 'none');
  assert.equal(c.reason, 'close');
  assert.match(c.text, /Too close to call/);
});

test('a favourite whose price has drifted is left alone, and one that has shortened says so', () => {
  const drift = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -150, b: 115 }, open: { a: -230, b: 175 } });
  assert.equal(drift.kind, 'none');
  assert.equal(drift.reason, 'drift');
  const steam = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -230, b: 175 }, open: { a: -160, b: 125 } });
  assert.equal(steam.kind, 'lean');
  assert.ok(steam.why.some((w) => /the money agrees/.test(w)));
});

test('no price and a wide cut are no lean, with the reason', () => {
  assert.equal(lowerCall({ a: 'A One', b: 'B Two', ml: null }).reason, 'unpriced');
  assert.equal(lowerCall({ a: 'A One', b: 'B Two', ml: { a: -300, b: 140 } }).reason, 'cut');
});

test('the winner is the player listed again later in the same tournament', () => {
  const m = { id: '1', compId: 'c', a: 'A One', b: 'B Two', start: 100 };
  assert.equal(winnerFromDraw(m, [m, { id: '2', compId: 'c', a: 'C Three', b: 'B Two', start: 200 }]), 'b');
  assert.equal(winnerFromDraw(m, [m, { id: '2', compId: 'c', a: 'A One', b: 'C Three', start: 200 }]), 'a');
  // Another tournament, an earlier match, and the same two listed again say nothing.
  assert.equal(winnerFromDraw(m, [m, { id: '2', compId: 'other', a: 'A One', b: 'C Three', start: 200 }]), null);
  assert.equal(winnerFromDraw(m, [m, { id: '2', compId: 'c', a: 'A One', b: 'C Three', start: 50 }]), null);
  assert.equal(winnerFromDraw(m, [m, { id: '2', compId: 'c', a: 'A One', b: 'B Two', start: 200 }]), null);
  // Both listed later (a lucky loser): not decided.
  assert.equal(winnerFromDraw(m, [m, { id: '2', compId: 'c', a: 'A One', b: 'C Three', start: 200 }, { id: '3', compId: 'c', a: 'B Two', b: 'D Four', start: 200 }]), null);
});

test('a read of the page is folded into the log, and the board lists what is still to come', () => {
  const log = mergeLower(null, [
    ev('1', 'Monastir Challenger 2026', 'Kimmer Coppejans', 'Dali Blanch', 4, [-190, 145]),
    ev('2', 'ITF W15 Antalya TUR', 'Selina Dal', 'Seo Choi', 3, [-115, -115]),
    ev('3', 'UTR Men Newport Beach USA', 'X Ray', 'Y Zed', 3, [-200, 150]),
    ev('4', 'ITF M15 Monastir TUN', 'Kael Shah', 'Kris van Wyk', 5, null),
  ], NOW);
  assert.deepEqual(Object.keys(log.matches).sort(), ['1', '2', '4']);
  assert.equal(log.matches['1'].call.kind, 'lean');
  assert.equal(log.matches['1'].tour, 'atp');
  assert.equal(log.matches['2'].tour, 'wta');
  const board = lowerBoard(log, NOW);
  assert.deepEqual(board.matches.map((m) => m.id), ['2', '1', '4']);
  assert.equal(board.matches[1].call.kind, 'lean');
  assert.match(board.matches[1].call.link, /marketId=m1&selectionId=1a/);
  assert.equal(board.matches[0].call.reason, 'close');
  assert.equal(board.matches[0].call.link, null);
  assert.equal(board.matches[2].call.reason, 'unpriced');
});

test('a started match keeps its last price before the start, and leaves the board', () => {
  let log = mergeLower(null, [ev('1', 'Monastir Challenger 2026', 'A One', 'B Two', 1, [-190, 145])], NOW);
  // In play an hour on, the page's price is the live one: the pre-match price stands.
  log = mergeLower(log, [ev('1', 'Monastir Challenger 2026', 'A One', 'B Two', 1, [450, -700], { inPlay: true })], NOW + 1.2 * H);
  assert.equal(log.matches['1'].ml.a, -190);
  assert.equal(log.matches['1'].call.american, -190);
  assert.equal(log.matches['1'].live, true);
  assert.equal(lowerBoard(log, NOW + 1.2 * H).matches.length, 0);
});

test('a price that moves before the start keeps the first one seen as the open', () => {
  let log = mergeLower(null, [ev('1', 'Monastir Challenger 2026', 'A One', 'B Two', 5, [-160, 125])], NOW);
  log = mergeLower(log, [ev('1', 'Monastir Challenger 2026', 'A One', 'B Two', 5, [-230, 175])], NOW + H);
  assert.deepEqual(log.matches['1'].open, { a: -160, b: 125 });
  assert.equal(log.matches['1'].ml.a, -230);
  assert.ok(lowerBoard(log, NOW + H).matches[0].call.moved > 0.03);
});

test('a lean is graded when the draw shows who went through, and goes on the tally once', () => {
  let log = mergeLower(null, [
    ev('1', 'Monastir Challenger 2026', 'A One', 'B Two', 1, [-190, 145]),
    ev('2', 'Monastir Challenger 2026', 'C Three', 'D Four', 1, [-400, 280]),
    ev('3', 'Monastir Challenger 2026', 'E Five', 'F Six', 1, [-115, -115]),
  ], NOW);
  // The next day: A plays D, and E plays on.
  const next = [ev('5', 'Monastir Challenger 2026', 'A One', 'D Four', 26, [-190, 145]), ev('6', 'Monastir Challenger 2026', 'G Seven', 'E Five', 26, [-150, 115])];
  log = mergeLower(log, next, NOW + 6 * H);
  assert.equal(log.matches['1'].result, 'a');
  assert.equal(log.matches['1'].call.result, 'win');
  assert.equal(log.matches['2'].result, 'b');
  assert.equal(log.matches['2'].call.result, 'loss');
  assert.equal(log.matches['3'].result, 'a');
  assert.equal(log.matches['3'].call.result, undefined);
  assert.deepEqual(log.tally.straight, { wins: 1, losses: 0, units: 0.53 });
  assert.deepEqual(log.tally.parlay, { wins: 0, losses: 1 });
  // Read again: nothing is counted twice.
  log = mergeLower(log, next, NOW + 7 * H);
  assert.deepEqual(log.tally.straight, { wins: 1, losses: 0, units: 0.53 });
  const board = lowerBoard(log, NOW + 7 * H);
  assert.equal(board.recent.length, 2);
  assert.ok(board.matches.find((m) => m.id === '5').call.why.some((w) => /Here this week: A One 1 win, D Four 1/.test(w)));
});

test('a match with no later round is given up on, and old matches fall off the log', () => {
  let log = mergeLower(null, [ev('1', 'Monastir Challenger 2026', 'A One', 'B Two', 1, [-190, 145])], NOW);
  log = mergeLower(log, [], NOW + H + LOWER_GIVE_UP_MS + H);
  assert.equal(log.matches['1'].result, 'unknown');
  assert.equal(log.tally.straight.wins + log.tally.straight.losses, 0);
  log = mergeLower(log, [], NOW + H + LOWER_KEEP_MS + H);
  assert.deepEqual(log.matches, {});
});
