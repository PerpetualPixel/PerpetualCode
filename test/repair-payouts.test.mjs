/**
 * Repairing settled picks whose stored payout is missing or NaN.
 *
 * The live case this exists for: Gregory Rodrigues at +180 on 2026-08-22
 * graded WIN and rendered "$NaN" in the tracker, and the day it belonged to
 * showed $0.00 net because summarizePicks coalesces a missing payout to 0.
 * Fixing the grader (worker/src/ufc-events.js's gradeMmaStraight) stops new
 * ones, but grading only ever visits PENDING picks, so an already-settled
 * record keeps its bad payout forever unless something repairs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  needsPayoutRepair, settlementBasis, repairedResult, repairMissingPayouts,
} from '../worker/src/repair-payouts.js';

const RODRIGUES = {
  pickId: 'p1',
  dateKey: '2026-08-22',
  sportKey: 'mma_mixed_martial_arts',
  marketKey: 'mma_straight',
  selection: 'Gregory Rodrigues',
  outcomeName: 'Gregory Rodrigues',
  away: 'Gregory Rodrigues',
  home: 'Anthony Hernandez',
  american: 180,
  decimal: 2.8,
  suggested_stake: 25,
  stakeUnits: 1,
  status: 'won',
  // Exactly what KV holds after a grader returned no payout: JSON.stringify
  // drops the undefined `payout` key, and NaN roiPercent becomes null.
  result: { roiPercent: null },
};

test('needsPayoutRepair spots a settled pick with no usable payout, and leaves good ones alone', () => {
  assert.equal(needsPayoutRepair(RODRIGUES), true);
  assert.equal(needsPayoutRepair({ ...RODRIGUES, result: { payout: 45 } }), false);
  // A legitimate zero is a real payout, not a missing one.
  assert.equal(needsPayoutRepair({ ...RODRIGUES, status: 'void', result: { payout: 0 } }), false);
  // A void with NO payout is exactly as broken on screen as a win with none.
  assert.equal(needsPayoutRepair({ ...RODRIGUES, status: 'void', result: {} }), true);
  // Pending picks have no result yet and are not this function's business.
  assert.equal(needsPayoutRepair({ ...RODRIGUES, status: 'pending', result: null }), false);
  assert.equal(needsPayoutRepair(null), false);
});

test('repairedResult rebuilds the +180 win: $25 stake pays $45, ROI +180%', () => {
  const fixed = repairedResult(RODRIGUES);
  assert.ok(Math.abs(fixed.payout - 45) < 1e-9);
  assert.ok(Math.abs(fixed.roiPercent - 180) < 1e-9);
});

test('repairedResult forfeits the stake on a loss and returns it on a void', () => {
  assert.equal(repairedResult({ ...RODRIGUES, status: 'lost' }).payout, -25);
  assert.deepEqual(repairedResult({ ...RODRIGUES, status: 'void' }), { payout: 0, roiPercent: 0 });
});

test('settlementBasis falls back to american when decimal is missing or unusable', () => {
  // The other way a stored payout goes NaN: the record never carried a
  // decimal, so the grader's (decimal - 1) * stake evaluated to NaN.
  const noDecimal = { ...RODRIGUES, decimal: undefined };
  assert.ok(Math.abs(settlementBasis(noDecimal).decimal - 2.8) < 1e-9);
  // A decimal of 1 or 0 would make every win pay nothing — a different wrong
  // answer, not a missing one — so it is treated as unusable too.
  assert.ok(Math.abs(settlementBasis({ ...RODRIGUES, decimal: 1 }).decimal - 2.8) < 1e-9);
  assert.ok(Math.abs(repairedResult(noDecimal).payout - 45) < 1e-9);
});

test('settlementBasis reconstructs the stake from units when suggested_stake is absent', () => {
  const noStake = { ...RODRIGUES, suggested_stake: undefined, stakeUnits: 2 };
  assert.equal(settlementBasis(noStake).stake, 50); // 2 units x $25
  assert.ok(Math.abs(repairedResult(noStake).payout - 90) < 1e-9);
});

test('repairedResult refuses to guess when the record carries no stake or no price', () => {
  assert.equal(repairedResult({ ...RODRIGUES, suggested_stake: undefined, stakeUnits: undefined }), null);
  assert.equal(repairedResult({ ...RODRIGUES, decimal: undefined, american: undefined }), null);
});

/* ---------------------------------------------------------------- */
/* The sweep                                                         */
/* ---------------------------------------------------------------- */

/** Minimal in-memory KV with just the get/put this module uses. */
function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

const DAY = '2026-08-22';
const AT = Date.parse('2026-08-22T18:00:00Z');

test('repairMissingPayouts is a dry run by default and writes nothing', async () => {
  const kv = fakeKv({
    [`track:${DAY}:top5`]: JSON.stringify({ pickIds: ['p1'] }),
    [`track:${DAY}:pick:p1`]: JSON.stringify(RODRIGUES),
  });
  const out = await repairMissingPayouts({ POTD_KV: kv }, { waitUntil: (p) => p }, AT, { days: 1 });

  assert.equal(out.apply, false);
  assert.equal(out.repairedCount, 1);
  assert.ok(Math.abs(out.repaired[0].payout - 45) < 1e-9);
  assert.equal(out.repaired[0].selection, 'Gregory Rodrigues');
  // Nothing written: the stored record is still the broken one.
  assert.equal(JSON.parse(kv.store.get(`track:${DAY}:pick:p1`)).result.payout, undefined);
});

test('repairMissingPayouts with apply:true writes the payout and stamps provenance', async () => {
  const kv = fakeKv({
    [`track:${DAY}:top5`]: JSON.stringify({ pickIds: ['p1'] }),
    [`track:${DAY}:pick:p1`]: JSON.stringify(RODRIGUES),
  });
  const out = await repairMissingPayouts({ POTD_KV: kv }, { waitUntil: (p) => p }, AT, { days: 1, apply: true });

  assert.equal(out.repairedCount, 1);
  const saved = JSON.parse(kv.store.get(`track:${DAY}:pick:p1`));
  assert.ok(Math.abs(saved.result.payout - 45) < 1e-9);
  assert.ok(Math.abs(saved.result.roiPercent - 180) < 1e-9);
  // The outcome itself is untouched — this repairs arithmetic, never a verdict.
  assert.equal(saved.status, 'won');
  // A settled record that changed after the fact must say why.
  assert.equal(saved.result.repairedAt, AT);
  assert.match(saved.result.repairedReason, /payout was missing or NaN/);
});

test('repairMissingPayouts sweeps Full Slate and Play of the Day, not just Pixel\'s Picks', async () => {
  const kv = fakeKv({
    [`slate:${DAY}:manifest`]: JSON.stringify({ pickIds: ['s1'] }),
    [`slate:${DAY}:pick:s1`]: JSON.stringify({ ...RODRIGUES, pickId: 's1' }),
    // POTD is stored as one record per day with the pick nested inside it,
    // rather than a manifest plus one key per pick.
    [`potd:${DAY}`]: JSON.stringify({ date: DAY, pick: { ...RODRIGUES, pickId: 'potd1' } }),
  });
  const out = await repairMissingPayouts({ POTD_KV: kv }, { waitUntil: (p) => p }, AT, { days: 1, apply: true });

  assert.equal(out.repairedCount, 2);
  assert.deepEqual(out.repaired.map((r) => r.store).sort(), ['potd', 'slate']);
  assert.ok(Math.abs(JSON.parse(kv.store.get(`slate:${DAY}:pick:s1`)).result.payout - 45) < 1e-9);
  assert.ok(Math.abs(JSON.parse(kv.store.get(`potd:${DAY}`)).pick.result.payout - 45) < 1e-9);
});

test('repairMissingPayouts reports unfixable records instead of writing a guessed number', async () => {
  const broken = { ...RODRIGUES, suggested_stake: undefined, stakeUnits: undefined };
  const kv = fakeKv({
    [`track:${DAY}:top5`]: JSON.stringify({ pickIds: ['p1'] }),
    [`track:${DAY}:pick:p1`]: JSON.stringify(broken),
  });
  const out = await repairMissingPayouts({ POTD_KV: kv }, { waitUntil: (p) => p }, AT, { days: 1, apply: true });

  assert.equal(out.repairedCount, 0);
  assert.equal(out.unfixable.length, 1);
  assert.match(out.unfixable[0].reason, /no usable stake or price/);
  assert.equal(JSON.parse(kv.store.get(`track:${DAY}:pick:p1`)).result.payout, undefined);
});

test('repairMissingPayouts leaves already-correct picks completely alone', async () => {
  const good = { ...RODRIGUES, result: { payout: 45, roiPercent: 180 } };
  const kv = fakeKv({
    [`track:${DAY}:top5`]: JSON.stringify({ pickIds: ['p1'] }),
    [`track:${DAY}:pick:p1`]: JSON.stringify(good),
  });
  const out = await repairMissingPayouts({ POTD_KV: kv }, { waitUntil: (p) => p }, AT, { days: 1, apply: true });

  assert.equal(out.repairedCount, 0);
  assert.equal(out.checked, 1);
  // Byte-identical: no repairedAt stamp on a record that needed nothing.
  assert.equal(kv.store.get(`track:${DAY}:pick:p1`), JSON.stringify(good));
});
