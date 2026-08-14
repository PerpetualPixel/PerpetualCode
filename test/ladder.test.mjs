/**
 * The Ladder Challenge's math and selection rules.
 *
 * The bankroll compounds, so an error here doesn't cost one pick's worth of
 * accuracy the way a flat-staked tracker's would — it compounds too. These
 * tests pin the ladder to the shape it was specified as: the $20 → $360 climb
 * scaled from the $100 → $2,050 original, the skims that bank real profit on
 * the way up, and the reset that puts a busted run back at the bottom rung.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ladderPlan,
  newLadderRun,
  settleLadderPlay,
  chooseLadderPlay,
  contradictsPick,
  LADDER_BASE,
  LADDER_TARGET,
} from '../worker/src/ladder.js';

const NOW = Date.parse('2026-08-14T18:00:00Z');

/* ---------------------------------------------------------------- */
/* The plan                                                          */
/* ---------------------------------------------------------------- */

test('the plan is the $100 ladder scaled to a $20 start, to the dollar', () => {
  const plan = ladderPlan();
  assert.equal(plan.base, 20);
  assert.equal(plan.target, 360);
  assert.deepEqual(
    plan.rungs.map((r) => [r.stake, r.returns, r.takeOut, r.carry]),
    [
      [20, 30, 0, 30],
      [30, 45, 5, 40],
      [40, 60, 0, 60],
      [60, 90, 0, 90],
      [90, 135, 15, 120],
      [120, 180, 0, 180],
      [180, 270, 30, 240],
      [240, 360, 0, 360],
    ],
  );
  // Take out $50 on the way up, finish holding $360 — $410 total value on a
  // $20 start, the same 20.5x the original ladder pays.
  assert.equal(plan.banked, 50);
  assert.equal(plan.final, 360);
  assert.equal(plan.totalValue, 410);
});

test('the plan terminates rather than spinning if the constants are nonsense', () => {
  // A target below the base has no rungs to climb; the bounded loop is what
  // keeps that from hanging a Worker request.
  const plan = ladderPlan({ base: 100, milestones: [], target: 10 });
  assert.equal(plan.rungs.length, 0);
  assert.equal(plan.final, 100);
});

/* ---------------------------------------------------------------- */
/* Settling a rung                                                   */
/* ---------------------------------------------------------------- */

/** A settled play at the given stake and price. */
const playAt = (stake, { decimal = 1.5, step = 1, runId = 'run-1' } = {}) => ({
  dateKey: '2026-08-14', runId, step, stake,
  pick: { decimal, selection: 'Someone -200' },
});

test('a winning rung compounds the whole bankroll forward', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1' };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(20), { won: true }, NOW);
  assert.equal(next.bankroll, 30);
  assert.equal(next.banked, 0);
  assert.equal(next.step, 2);
  assert.equal(next.wins, 1);
  assert.equal(finishedRun, null);
});

test('passing a milestone skims the excess into banked profit', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1', bankroll: 30, step: 2 };
  const { state: next } = settleLadderPlay(state, playAt(30, { step: 2 }), { won: true }, NOW);
  // 30 -> 45, first pass of the $40 milestone: $5 out, $40 carried.
  assert.equal(next.bankroll, 40);
  assert.equal(next.banked, 5);
  assert.deepEqual(next.skimmed, [40]);
});

test('a milestone is only ever skimmed once', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1', bankroll: 40, banked: 5, skimmed: [40], step: 3 };
  const { state: next } = settleLadderPlay(state, playAt(40, { step: 3 }), { won: true }, NOW);
  assert.equal(next.bankroll, 60, 'past the $40 mark already — nothing more comes off it');
  assert.equal(next.banked, 5);
});

test('a losing rung ends the run at the bottom and keeps only what was banked', () => {
  const state = {
    ...newLadderRun(NOW), runId: 'run-1', bankroll: 120, banked: 20, skimmed: [40], step: 6, wins: 5,
  };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(120, { step: 6 }), { won: false }, NOW);

  assert.equal(finishedRun.status, 'busted');
  assert.equal(finishedRun.endedBy, 'loss');
  assert.equal(finishedRun.lostAt.step, 6);
  assert.equal(finishedRun.lostAt.stake, 120);
  // The $120 riding is gone; the $20 already skimmed out is the run's whole
  // value. That's the argument for skimming at all.
  assert.equal(finishedRun.totalValue, 20);

  assert.equal(next.bankroll, LADDER_BASE);
  assert.equal(next.step, 1);
  assert.equal(next.banked, 0);
  assert.equal(next.wins, 0);
  assert.equal(next.status, 'active');
  assert.notEqual(next.runId, 'run-1', 'a reset is a new run, not the old one rewound');
  assert.equal(next.previousRunId, 'run-1');
});

test('a void leaves the ladder exactly where it was, so the rung is replayed', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1', bankroll: 90, banked: 5, step: 5, wins: 3 };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(90, { step: 5 }), { void: true }, NOW);
  assert.equal(finishedRun, null);
  assert.equal(next.bankroll, 90);
  assert.equal(next.step, 5);
  assert.equal(next.wins, 3);
});

test('hitting the target completes the climb and starts a fresh one', () => {
  const state = {
    ...newLadderRun(NOW), runId: 'run-1', bankroll: 240, banked: 50, skimmed: [40, 120, 240], step: 8, wins: 7,
  };
  const { state: next, finishedRun } = settleLadderPlay(state, playAt(240, { step: 8 }), { won: true }, NOW);

  assert.equal(finishedRun.status, 'complete');
  assert.equal(finishedRun.endedBy, 'target');
  assert.equal(finishedRun.bankroll, 360);
  assert.equal(finishedRun.totalValue, 410);
  assert.equal(next.bankroll, LADDER_BASE, 'banked and restarted, per the agreed behavior');
  assert.equal(next.step, 1);
});

test('eight straight wins at -200 walk the real bankroll exactly along the plan', () => {
  const plan = ladderPlan();
  let state = { ...newLadderRun(NOW), runId: 'run-1' };
  let finished = null;

  for (const rung of plan.rungs) {
    assert.equal(state.bankroll, rung.stake, `rung ${rung.step} should stake the whole bankroll`);
    const settled = settleLadderPlay(state, playAt(state.bankroll, { step: rung.step }), { won: true }, NOW);
    finished = settled.finishedRun ?? finished;
    state = settled.state;
  }

  assert.ok(finished, 'the eighth win completes the climb');
  assert.equal(finished.bankroll, LADDER_TARGET);
  assert.equal(finished.banked, plan.banked);
  assert.equal(finished.wins, plan.rungs.length);
});

test('a real price that is not exactly -200 moves the real bankroll, not the plan', () => {
  const state = { ...newLadderRun(NOW), runId: 'run-1' };
  // -175 pays 1.571…, so $20 returns $31.43 — the ladder tracks the money it
  // actually made, not the $30 the plan drew.
  const { state: next } = settleLadderPlay(state, playAt(20, { decimal: 1.5714 }), { won: true }, NOW);
  assert.equal(next.bankroll, 31.43);
  assert.equal(ladderPlan().rungs[0].carry, 30, 'the plan itself is untouched');
});

/* ---------------------------------------------------------------- */
/* Choosing the day's rung                                           */
/* ---------------------------------------------------------------- */

const cand = (id, score, american) => ({
  id, score, american, eventId: `e-${id}`, marketKey: 'h2h', outcomeName: id, point: null,
});

test('the best-scoring candidate wins when nothing is close to it', () => {
  const chosen = chooseLadderPlay([cand('a', 60, -180), cand('b', 75, -240), cand('c', 55, -200)]);
  assert.equal(chosen.id, 'b');
});

test('a near-tie on score breaks toward the price closest to -200', () => {
  // The ladder's whole math is 1.5x; among plays the algorithm rates the
  // same, the one that actually pays 1.5x is the right rung.
  const chosen = chooseLadderPlay([cand('a', 75, -245), cand('b', 74, -205), cand('c', 73, -170)]);
  assert.equal(chosen.id, 'b');
});

test('a clearly better score is not given away to a prettier price', () => {
  const chosen = chooseLadderPlay([cand('a', 80, -245), cand('b', 68, -200)]);
  assert.equal(chosen.id, 'a');
});

test('an empty field chooses nothing rather than reaching outside it', () => {
  assert.equal(chooseLadderPlay([]), null);
});

/* ---------------------------------------------------------------- */
/* Not arguing with the rest of the board                            */
/* ---------------------------------------------------------------- */

const posted = { eventId: 'e-1', marketKey: 'h2h', outcomeName: 'Lakers', point: null };

test('the opposite side of a posted pick is a contradiction', () => {
  assert.equal(contradictsPick({ ...posted, outcomeName: 'Celtics' }, posted), true);
});

test('the same side as a posted pick is not — the ladder may double a Pixel\'s Pick', () => {
  assert.equal(contradictsPick({ ...posted }, posted), false);
});

test('a different market on the same game is not a contradiction', () => {
  // "Over 21.5" and "Lakers ML" can both be right; excluding the whole event
  // would thin the ladder's pool for no honest reason.
  assert.equal(
    contradictsPick({ eventId: 'e-1', marketKey: 'totals', outcomeName: 'Over', point: 21.5 }, posted),
    false,
  );
});

test('the other number on the same side of a total is a contradiction', () => {
  const total = { eventId: 'e-1', marketKey: 'totals', outcomeName: 'Over', point: 21.5 };
  assert.equal(contradictsPick({ ...total, point: 24.5 }, total), true);
  assert.equal(contradictsPick({ ...total }, total), false);
});

test('a different game is never a contradiction', () => {
  assert.equal(contradictsPick({ ...posted, eventId: 'e-2', outcomeName: 'Celtics' }, posted), false);
});
