import test from 'node:test';
import assert from 'node:assert/strict';

import { gradeBtts, gradeDoubleChance } from '../docs/soccer-markets.js';
import { gradePick } from '../docs/learning.js';
import { clearsMaxJuice, LOW_VARIANCE_MAX_AMERICAN } from '../docs/engine.js';

/* ---------------------------------------------------------------- */
/* BTTS                                                               */
/* ---------------------------------------------------------------- */

test('BTTS Yes wins when both teams score, loses otherwise', () => {
  assert.equal(gradeBtts({ outcomeName: 'Yes' }, 2, 1).won, true);
  assert.equal(gradeBtts({ outcomeName: 'Yes' }, 2, 0).won, false);
  assert.equal(gradeBtts({ outcomeName: 'Yes' }, 0, 0).won, false);
});

test('BTTS No wins when at least one side is shut out', () => {
  assert.equal(gradeBtts({ outcomeName: 'No' }, 2, 0).won, true);
  assert.equal(gradeBtts({ outcomeName: 'No' }, 0, 0).won, true);
  assert.equal(gradeBtts({ outcomeName: 'No' }, 1, 1).won, false);
});

/* ---------------------------------------------------------------- */
/* Double Chance                                                      */
/* ---------------------------------------------------------------- */

const dcPick = (outcomeName) => ({ home: 'Inter Miami CF', away: 'Orlando City SC', outcomeName });

test('a home-or-draw label wins on a home win or a draw, loses on an away win', () => {
  const label = 'Inter Miami CF or Draw';
  assert.equal(gradeDoubleChance(dcPick(label), 2, 1).won, true);  // home win
  assert.equal(gradeDoubleChance(dcPick(label), 1, 1).won, true);  // draw
  assert.equal(gradeDoubleChance(dcPick(label), 0, 1).won, false); // away win
});

test('a draw-or-away label wins on a draw or an away win, loses on a home win', () => {
  const label = 'Draw or Orlando City SC';
  assert.equal(gradeDoubleChance(dcPick(label), 1, 1).won, true);
  assert.equal(gradeDoubleChance(dcPick(label), 0, 1).won, true);
  assert.equal(gradeDoubleChance(dcPick(label), 2, 1).won, false);
});

test('a home-or-away label wins on either team winning, loses on a draw', () => {
  const label = 'Inter Miami CF or Orlando City SC';
  assert.equal(gradeDoubleChance(dcPick(label), 2, 1).won, true);
  assert.equal(gradeDoubleChance(dcPick(label), 0, 1).won, true);
  assert.equal(gradeDoubleChance(dcPick(label), 1, 1).won, false);
});

test('handles the slash-separated label convention too, not just "or"', () => {
  assert.equal(gradeDoubleChance(dcPick('Inter Miami CF/Draw'), 2, 1).won, true);
});

test('a label that does not resolve to two recognized outcomes voids rather than guessing', () => {
  const out = gradeDoubleChance(dcPick('Some Unrecognized Label'), 2, 1);
  assert.equal(out.void, true);
  assert.match(out.reason, /did not resolve/);
});

/* ---------------------------------------------------------------- */
/* Wired through gradePick (docs/learning.js)                         */
/* ---------------------------------------------------------------- */

test('gradePick routes btts/double_chance through to the soccer settlement, with a real payout', () => {
  const score = { completed: true, scores: [{ name: 'Inter Miami CF', score: '2' }, { name: 'Orlando City SC', score: '1' }] };
  const bttsPick = {
    sportKey: 'soccer_usa_mls', marketKey: 'btts', outcomeName: 'Yes',
    home: 'Inter Miami CF', away: 'Orlando City SC', decimal: 1.8, suggested_stake: 20,
  };
  const out = gradePick(bttsPick, score);
  assert.equal(out.won, true);
  assert.equal(out.payout, (1.8 - 1) * 20);

  const dcOut = gradePick({ ...bttsPick, marketKey: 'double_chance', outcomeName: 'Inter Miami CF or Draw' }, score);
  assert.equal(dcOut.won, true);
});

/* ---------------------------------------------------------------- */
/* Low-variance max-juice cap                                         */
/* ---------------------------------------------------------------- */

test('clearsMaxJuice enforces the tighter cap only for low-variance markets', () => {
  assert.equal(clearsMaxJuice({ marketKey: 'btts', american: -135 }), true);
  assert.equal(clearsMaxJuice({ marketKey: 'btts', american: -140 }), false);
  assert.equal(clearsMaxJuice({ marketKey: 'pitcher_strikeouts', american: -150 }), false);
  // Existing team markets are untouched by this cap, even at heavier juice.
  assert.equal(clearsMaxJuice({ marketKey: 'h2h', american: -220 }), true);
  assert.equal(clearsMaxJuice({ marketKey: 'spreads', american: -240 }), true);
});

test('the low-variance cap constant matches the agreed -135', () => {
  assert.equal(LOW_VARIANCE_MAX_AMERICAN, -135);
});
