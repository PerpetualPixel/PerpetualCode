/**
 * Two of the five Pixel's Picks run as 2-leg moneyline combos.
 *
 * This is the engine's original spec finally applied to that board: a
 * favourite priced shorter than -150 cannot stand alone at a sensible number,
 * so it takes a partner from another game and the ticket lands near +100 —
 * safer legs, plus-money price.
 *
 * The risk worth testing is not the arithmetic, it's the invariants: a board
 * that promises five plays must still post five, a partner must never be
 * reused or contradict, and a parlay must never be stored as if it were its
 * anchor leg alone (which would record the wrong price and grade as a single).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairShortPricedPicks } from '../docs/engine.js';
import { pickRecordFrom } from '../worker/src/tracking.js';

const cand = (id, american, { score = 70, marketKey = 'h2h', eventId = id } = {}) => ({
  id, eventId, american, score, marketKey,
  selection: `${id} to win`, outcomeName: id, sportKey: 'baseball_mlb',
  decimal: american > 0 ? 1 + american / 100 : 1 + 100 / -american,
  home: `${id} Home`, away: `${id} Away`, commenceMs: Date.parse('2026-09-02T23:00:00Z'),
  book: 'fanduel', marketLabel: 'Moneyline', consensusProb: 0.6,
});
const single = (c) => ({ type: 'single', legs: [c], american: c.american, score: c.score });
const ML = (c) => c.marketKey === 'h2h';

test('a short-priced favourite is paired into a plus-money ticket', () => {
  const [pick] = pairShortPricedPicks([single(cand('A', -200))], [cand('P', -170)], { max: 2 });
  assert.equal(pick.type, 'combo');
  assert.equal(pick.legs.length, 2);
  // -200 with -170 is +138: the whole point, a safe pair that pays plus money.
  assert.ok(pick.american > 0, `combined should be plus money, got ${pick.american}`);
  assert.ok(pick.decimal > 2);
  assert.match(pick.pairReason, /closer to even money/);
});

test('a leg that can stand alone is never paired', () => {
  // -120 and +130 are both fine as they are; pairing them would be padding.
  for (const price of [-120, -150, 130]) {
    const [pick] = pairShortPricedPicks([single(cand('A', price))], [cand('P', -170)], { max: 2 });
    assert.equal(pick.type, 'single', `${price} should stand alone`);
  }
});

test('the board never shrinks: no legal partner leaves the pick a single', () => {
  const board = [single(cand('A', -200)), single(cand('B', -180)), single(cand('C', -120))];
  const out = pairShortPricedPicks(board, [], { max: 2 });
  assert.equal(out.length, 3);
  assert.equal(out.filter((p) => p.type === 'combo').length, 0);
});

test('at most `max` combos are made, strongest picks first', () => {
  const board = [single(cand('A', -200)), single(cand('B', -180)), single(cand('C', -190))];
  const pool = [cand('P1', -170), cand('P2', -160), cand('P3', -155)];
  assert.equal(pairShortPricedPicks(board, pool, { max: 1 }).filter((p) => p.type === 'combo').length, 1);
  assert.equal(pairShortPricedPicks(board, pool, { max: 2 }).filter((p) => p.type === 'combo').length, 2);
});

test('isEligible gates BOTH ends, so an ML combo never welds on a total', () => {
  const total = cand('T', -170, { marketKey: 'totals' });
  const [pick] = pairShortPricedPicks([single(cand('A', -200))], [total], { max: 2, isEligible: ML });
  assert.equal(pick.type, 'single', 'a total must not become the partner of a moneyline');

  // And an anchor the caller wouldn't have picked as a partner isn't paired either.
  const anchorTotal = single(cand('A', -200, { marketKey: 'totals' }));
  assert.equal(pairShortPricedPicks([anchorTotal], [cand('P', -170)], { max: 2, isEligible: ML })[0].type, 'single');
});

test('a partner is never a pick already on the board, nor reused across combos', () => {
  const onBoard = cand('B', -180);
  const board = [single(cand('A', -200)), single(onBoard)];
  const out = pairShortPricedPicks(board, [onBoard, cand('P1', -170), cand('P2', -165)], { max: 2 });
  const legIds = out.flatMap((p) => p.legs.map((l) => l.id));
  assert.equal(new Set(legIds).size, legIds.length, `a leg was used twice: ${legIds}`);
});

test('a partner never comes from a game already spoken for', () => {
  // Same eventId as the anchor: taking both sides of one game as a "parlay"
  // is the worst possible pairing, and it must be impossible, not unlikely.
  const sameGame = cand('P', -170, { eventId: 'A' });
  const [pick] = pairShortPricedPicks([single(cand('A', -200))], [sameGame], { max: 2 });
  assert.equal(pick.type, 'single');
});

/* ---------------------------------------------------------------- */
/* The tracked record                                                */
/* ---------------------------------------------------------------- */

test('a combo is recorded as ONE ticket at the COMBINED price, carrying both legs', () => {
  const [combo] = pairShortPricedPicks([single(cand('A', -200))], [cand('P', -170)], { max: 2 });
  const rec = pickRecordFrom(combo, '2026-09-02', Date.now());

  assert.equal(rec.type, 'combo');
  assert.equal(rec.legs.length, 2);
  // The price stored is the TICKET's, not the anchor leg's — recording -200
  // here would misstate the bet and pay out the wrong amount.
  assert.equal(rec.american, combo.american);
  assert.ok(rec.american > 0);
  assert.equal(rec.decimal, combo.decimal);
  assert.match(rec.selection, /A to win \+ P to win/);
  // Its id must not collide with the same anchor appearing as a single.
  assert.equal(rec.pickId, 'A+P');
  assert.notEqual(rec.pickId, 'A');
  // Both legs start unsettled, and neither carries its own payout — a parlay
  // pays once, off the ticket.
  assert.deepEqual(rec.legs.map((l) => l.status), ['pending', 'pending']);
  assert.ok(rec.legs.every((l) => l.payout === undefined));
  // CLV spans two markets, so it has no single close to track.
  assert.equal(rec.clv, null);
});

test('a single is recorded exactly as before — no combo fields, CLV intact', () => {
  const rec = pickRecordFrom(single(cand('A', -120)), '2026-09-02', Date.now());
  assert.equal(rec.type, undefined);
  assert.equal(rec.legs, undefined);
  assert.equal(rec.pickId, 'A');
  assert.equal(rec.american, -120);
  assert.ok(rec.clv, 'a single must keep its CLV record');
  assert.equal(rec.clv.openAmerican, -120);
});
