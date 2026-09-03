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
import { pairShortPricedPicks, buildBankrollBuilder, applyBankrollBuilders } from '../docs/engine.js';
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

/* ---------------------------------------------------------------- */
/* Bankroll builders — 2-3 favourites stacked to plus money          */
/* ---------------------------------------------------------------- */

const fav = (id, american, prob) => ({
  ...cand(id, american), consensusProb: prob,
});

test('favourites are stacked only until the ticket pays plus money', () => {
  // Two -200s already clear +100, so a third leg would be risk bought for
  // nothing — every extra leg is another way to lose.
  const t = buildBankrollBuilder(fav('A', -200, 0.67), [fav('B', -200, 0.67), fav('C', -180, 0.64)], { isEligible: ML });
  assert.equal(t.legs.length, 2);
  assert.ok(t.american >= 100, `ticket must pay plus money, got ${t.american}`);
});

test('a third leg is added only when two cannot reach plus money', () => {
  const t = buildBankrollBuilder(fav('A', -250, 0.71), [fav('B', -250, 0.71), fav('C', -250, 0.71)], { isEligible: ML });
  assert.equal(t.legs.length, 3);
  assert.ok(t.american >= 100);
});

test('legs are taken safest-first, not in pool order', () => {
  const t = buildBankrollBuilder(fav('A', -200, 0.67), [fav('LONG', -120, 0.55), fav('SAFE', -190, 0.66)], { isEligible: ML });
  assert.equal(t.legs[1].id, 'SAFE');
});

test('a ticket never exceeds its board\'s own price ceiling', () => {
  // The bug the board's existing tests caught: without a ceiling, stacking
  // produced a +779 longshot parlay calling itself a bankroll builder.
  const over = buildBankrollBuilder(fav('A', -120, 0.55), [fav('B', -120, 0.55)], { isEligible: ML, maxAmerican: 150 });
  assert.equal(over, null, 'a ticket past the ceiling is no ticket');
  const under = buildBankrollBuilder(fav('A', -200, 0.67), [fav('B', -200, 0.67)], { isEligible: ML, maxAmerican: 150 });
  assert.ok(under && under.american <= 150);
});

test('a ticket that cannot reach plus money is not built at all', () => {
  const t = buildBankrollBuilder(fav('A', -900, 0.9), [fav('B', -900, 0.9), fav('C', -900, 0.9)], { isEligible: ML });
  assert.equal(t, null);
});

test('never two legs from the same game, nor contradicting legs', () => {
  const sameGame = { ...fav('B', -200, 0.67), eventId: 'A' };
  assert.equal(buildBankrollBuilder(fav('A', -200, 0.67), [sameGame], { isEligible: ML }), null);
});

test('applyBankrollBuilders keeps the board full and carries its flags', () => {
  const board = [
    { type: 'single', legs: [fav('A', -200, 0.67)], american: -200, score: 70, meetsStandard: true, flagReason: null },
    { type: 'single', legs: [fav('B', -190, 0.66)], american: -190, score: 68, meetsStandard: false, flagReason: 'thin day' },
    { type: 'single', legs: [fav('C', -120, 0.55)], american: -120, score: 66, meetsStandard: true, flagReason: null },
  ];
  const pool = [fav('P1', -200, 0.67), fav('P2', -195, 0.66)];
  const out = applyBankrollBuilders(board, pool, { max: 2, isEligible: ML, maxAmerican: 150 });

  assert.equal(out.length, 3, 'a board promising three plays still posts three');
  assert.equal(out.filter((p) => p.type === 'combo').length, 2);
  // meetsStandard/flagReason live on the PICK, not its legs — building a
  // ticket around the anchor dropped them, and a record with meetsStandard
  // undefined is neither standard nor flagged to every ROI summary.
  assert.equal(out[0].meetsStandard, true);
  assert.equal(out[1].meetsStandard, false);
  assert.equal(out[1].flagReason, 'thin day');
  // No leg is used twice across the board.
  const ids = out.flatMap((p) => p.legs.map((l) => l.id));
  assert.equal(new Set(ids).size, ids.length);
});

/* ---------------------------------------------------------------- */
/* Play of the Day: favourites first                                 */
/* ---------------------------------------------------------------- */

test('POTD picks the best FAVOURITE, not the best-scoring underdog', async () => {
  const { chooseShowcasePick } = await import('../worker/src/potd.js');

  // Score measures how clean a number is (liquidity, book agreement, shop
  // gain, freshness), never how likely the bet is to land. The +145 dog
  // outscores everything here and must still not lead the day.
  const pool = [
    { id: 'dog', american: 145, score: 88 },
    { id: 'fav', american: -165, score: 74 },
    { id: 'pickem', american: -105, score: 80 },
  ];
  assert.equal(chooseShowcasePick(pool).id, 'fav');

  // Among favourites, score still decides — this only narrows the pool.
  const twoFavs = [{ id: 'lo', american: -160, score: 70 }, { id: 'hi', american: -140, score: 82 }];
  assert.equal(chooseShowcasePick(twoFavs).id, 'hi');

  // A slate with no favourite still posts a pick: the board runs every day.
  const noFavs = [{ id: 'dog', american: 145, score: 88 }, { id: 'pickem', american: -105, score: 80 }];
  assert.equal(chooseShowcasePick(noFavs).id, 'dog');

  assert.equal(chooseShowcasePick([]), null);
  assert.equal(chooseShowcasePick(null), null);
});
