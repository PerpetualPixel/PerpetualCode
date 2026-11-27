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

test('a short favourite is a parlay piece, and one priced as won is a lean with no bet in it', () => {
  const piece = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -400, b: 280 } });
  assert.equal(piece.kind, 'lean');
  assert.equal(piece.how, 'parlay');
  const won = lowerCall({ a: 'A One', b: 'B Two', ml: { a: -1200, b: 650 } });
  assert.equal(won.kind, 'lean');
  assert.equal(won.how, 'short');
  assert.equal(won.name, 'A One');
  assert.ok(won.why.some((w) => /no bet in it/.test(w)));
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
  assert.deepEqual(log.tally.short, { wins: 0, losses: 0 });
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

// --- read against the rankings ---
import { rankShare, LOWER_APART } from '../worker/src/tennis-lower.js';
const RANKS = { at: NOW, atp: { 'kimmer coppejans': [210, 280], 'dali blanch': [420, 120], 'a one': [300, 190], 'b two': [310, 185], 'star back': [900, 20], 'steady pro': [250, 240] }, wta: {} };
const mm = (a, b, ml, open = null) => ({ tour: 'atp', a, b, ml: { a: ml[0], b: ml[1] }, open: open ? { a: open[0], b: open[1] } : null });

test('the ranking\'s share is the points set against each other, a handful of points saying little', () => {
  assert.equal(rankShare(100, 100), 0.5);
  assert.ok(rankShare(280, 120) > 0.64 && rankShare(280, 120) < 0.7);
  assert.ok(rankShare(12, 3) < 0.63);
  assert.ok(rankShare(0, 0) === 0.5);
  assert.ok(Math.abs(rankShare(280, 120) + rankShare(120, 280) - 1) < 1e-9);
});

test('with both players ranked the read is the ranking and the price together, and says so', () => {
  const c = lowerCall(mm('Kimmer Coppejans', 'Dali Blanch', [-140, 110]), RANKS);
  assert.equal(c.kind, 'lean');
  assert.equal(c.basis, 'rank');
  assert.equal(c.side, 'a');
  assert.deepEqual(c.ranks, { a: { rank: 210, points: 280 }, b: { rank: 420, points: 120 } });
  // The price alone has him 55%, short of a lean; the ranking's 67% carries the read over the bar.
  assert.ok(c.market < 0.57 && c.rankShare > 0.64);
  assert.ok(Math.abs(c.share - (c.market + c.rankShare) / 2) < 0.002);
  assert.equal(c.value, true);
  assert.ok(c.edge >= 0.02);
  assert.ok(c.why.some((w) => /Rankings: Kimmer Coppejans #210 \(280 points\), Dali Blanch #420 \(120\)/.test(w)));
  assert.ok(c.why.some((w) => /points? of room/.test(w)));
  // The same price with no rankings: too close to call.
  assert.equal(lowerCall(mm('Kimmer Coppejans', 'Dali Blanch', [-140, 110])).reason, 'close');
});

test('a favourite the ranking does not back any more than the price has no room, and is still a lean', () => {
  const c = lowerCall(mm('Kimmer Coppejans', 'Dali Blanch', [-240, 180]), RANKS);
  assert.equal(c.kind, 'lean');
  assert.equal(c.basis, 'rank');
  assert.equal(c.value, false);
  assert.ok(c.edge < 0);
  assert.ok(c.why.some((w) => /the book's cut/.test(w)));
});

test('the price and the ranking far apart is no lean: the price knows something', () => {
  // The ranking has Steady Pro a heavy favourite on points; the price makes Star Back the favourite.
  const c = lowerCall(mm('Star Back', 'Steady Pro', [-200, 150]), RANKS);
  assert.equal(c.kind, 'none');
  assert.equal(c.reason, 'apart');
  assert.match(c.text, /the price has Star Back 6\d%, the rankings Steady Pro/);
  assert.ok(Math.abs(c.rankShare - (1 - rankShare(20, 240))) < 0.01 || Math.abs(c.rankShare - rankShare(20, 240)) < 0.01);
  assert.ok(LOWER_APART > 0.1);
});

test('a player the list does not have leaves the price as the whole read', () => {
  const c = lowerCall(mm('Kimmer Coppejans', 'Unknown Qualifier', [-190, 145]), RANKS);
  assert.equal(c.kind, 'lean');
  assert.equal(c.basis, 'price');
  assert.equal(c.value, false);
  assert.ok(c.why.some((w) => /No ranking on file for Unknown Qualifier/.test(w)));
  const noPrice = lowerCall({ tour: 'atp', a: 'Kimmer Coppejans', b: 'Dali Blanch', ml: null }, RANKS);
  assert.equal(noPrice.reason, 'unpriced');
  assert.match(noPrice.text, /The rankings favour Kimmer Coppejans/);
});

test('a lean with room is counted on its own tally when the draw settles it', () => {
  let log = mergeLower(null, [ev('1', 'Monastir Challenger 2026', 'Kimmer Coppejans', 'Dali Blanch', 1, [-140, 110])], NOW, RANKS);
  assert.equal(log.matches['1'].call.basis, 'rank');
  assert.equal(log.matches['1'].call.value, true);
  log = mergeLower(log, [ev('5', 'Monastir Challenger 2026', 'Kimmer Coppejans', 'A One', 26, [-150, 115])], NOW + 6 * H, RANKS);
  assert.deepEqual(log.tally.value, { wins: 1, losses: 0, units: 0.71 });
  assert.deepEqual(log.tally.straight, { wins: 1, losses: 0, units: 0.71 });
  const board = lowerBoard(log, NOW + 6 * H, RANKS);
  assert.equal(board.ranksAt, NOW);
  assert.equal(board.matches[0].call.basis, 'rank');
});
