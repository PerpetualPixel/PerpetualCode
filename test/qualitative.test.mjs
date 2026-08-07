import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tennisQualitativeSignal,
  teamQualitativeSignal,
  supportsQualitativeSignal,
} from '../docs/qualitative.js';

const EPOCH = Date.UTC(2000, 0, 1);
const day = (iso) => Math.round((Date.parse(iso) - EPOCH) / 86400000);
const F = { DAY: 0, SURFACE: 1, COURT: 2, ROUND: 3, WINNER: 4, LOSER: 5, WRANK: 6, LRANK: 7, RETIRED: 8 };

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: got ${actual}, expected ${expected}`);

/* ---------------------------------------------------------------- */
/* Tennis                                                             */
/* ---------------------------------------------------------------- */

// Mirrors test/insights.test.mjs's ARCHIVE fixture shape.
const THIN_ARCHIVE = {
  tour: 'test',
  seasons: [2026],
  surfaces: ['Hard'],
  courts: ['Outdoor'],
  rounds: ['1st Round'],
  players: ['Alpha A.', 'Bravo B.'],
  matches: [
    [day('2026-07-01'), 0, 0, 0, 0, 1, 10, 20, 0], // Alpha beats Bravo
  ],
};

test('tennisQualitativeSignal returns null when neither player has enough recent matches and no H2H exists', () => {
  const archive = { ...THIN_ARCHIVE, players: ['Alpha A.', 'Bravo B.', 'Charlie C.', 'Delta D.'] };
  // Alpha vs. a player who's never appeared in the archive at all.
  assert.equal(tennisQualitativeSignal(archive, 'Aaron Alpha', 'Delta D.'), null);
});

test('tennisQualitativeSignal falls back to form alone (no dilution) when head-to-head is unavailable', () => {
  const archive = {
    ...THIN_ARCHIVE,
    players: ['Alpha A.', 'Bravo B.', 'Ghost G.'],
    matches: [
      // Alpha: 3-0 recent, all vs. Ghost (never plays Bravo).
      [day('2026-07-01'), 0, 0, 0, 0, 2, 10, 90, 0],
      [day('2026-07-05'), 0, 0, 0, 0, 2, 10, 90, 0],
      [day('2026-07-10'), 0, 0, 0, 0, 2, 10, 90, 0],
      // Bravo: 0-3 recent, all vs. Ghost.
      [day('2026-07-02'), 0, 0, 0, 2, 1, 90, 20, 0],
      [day('2026-07-06'), 0, 0, 0, 2, 1, 90, 20, 0],
      [day('2026-07-11'), 0, 0, 0, 2, 1, 90, 20, 0],
    ],
  };
  const signal = tennisQualitativeSignal(archive, 'Aaron Alpha', 'Ben Bravo');
  // formDiff = 1.0 - 0.0 = 1.0, no H2H to blend in.
  close(signal, 1, 'form-only signal');
});

test('the Osaka/Mertens shape: a single head-to-head meeting is confidence-discounted, not treated as certainty', () => {
  const archive = {
    tour: 'wta',
    seasons: [2026],
    surfaces: ['Hard', 'Grass'],
    courts: ['Outdoor'],
    rounds: ['1st Round', 'Semifinal', 'Quarterfinal'],
    players: ['Osaka N.', 'Mertens E.', 'Krueger A.', 'Cocciaretto E.', 'Eala A.', 'Noskova L.'],
    matches: [
      // Osaka: recent hard-court form, 2 wins then a semifinal loss.
      [day('2026-07-20'), 0, 0, 0, 0, 2, 10, 40, 0], // beat Krueger
      [day('2026-07-22'), 0, 0, 0, 0, 3, 10, 45, 0], // beat Cocciaretto
      [day('2026-07-24'), 0, 0, 1, 4, 0, 30, 10, 0], // lost to Eala, SF
      // Mertens: worse recent form.
      [day('2026-07-18'), 0, 0, 0, 5, 1, 25, 15, 0], // lost to Noskova
      [day('2026-07-16'), 1, 0, 0, 5, 1, 25, 15, 0], // lost to Noskova
      // Head-to-head: Osaka's only meeting with Mertens, on grass — Osaka won.
      [day('2025-07-01'), 1, 0, 0, 0, 1, 8, 18, 0],
    ],
  };

  const signal = tennisQualitativeSignal(archive, 'Naomi Osaka', 'Elise Mertens');
  assert.ok(signal > 0, 'signal must favor Osaka');

  // Recent form pulls in every match in the archive, including the head-to-
  // head meeting itself: Osaka is 3-1 (Krueger, Cocciaretto, Mertens; lost to
  // Eala) = 3/4, Mertens is 0-3 (lost to Noskova twice, lost to Osaka) = 0/3.
  const formDiff = 3 / 4 - 0 / 3;
  // h2hDiff at full confidence (uncapped) would be (1-0)/1 = 1 -- the discounted
  // contribution must be smaller than treating a single meeting as certain.
  const fullConfidenceSignal = 0.65 * formDiff + 0.35 * 1;
  assert.ok(signal < fullConfidenceSignal, 'a single meeting must be confidence-discounted, not full weight');

  // Confidence for 1 meeting is 1/5, so h2hDiff = 0.2 * (1-0)/1 = 0.2.
  close(signal, 0.65 * formDiff + 0.35 * 0.2, 'blended signal with discounted H2H');
});

test('supportsQualitativeSignal excludes totals, includes everything else', () => {
  assert.equal(supportsQualitativeSignal('totals'), false);
  assert.equal(supportsQualitativeSignal('h2h'), true);
  assert.equal(supportsQualitativeSignal('spreads'), true);
  assert.equal(supportsQualitativeSignal('alternate_spreads'), true);
});

/* ---------------------------------------------------------------- */
/* Team sports                                                        */
/* ---------------------------------------------------------------- */

// Identical shape to test/insights.test.mjs's CONTEXT fixture.
const CONTEXT = {
  seriesSummary: 'LAA lead series 2-1',
  home: {
    name: 'Baltimore Orioles', shortName: 'Orioles', isHome: true,
    overallRecord: '54-58', homeRecord: '30-29', awayRecord: '24-29',
    lastFive: 'LWWLL'.split('').map((result) => ({ result })),
    atsRecord: '30-28', injuries: [
      { name: 'Samuel Basallo', status: '10-Day-IL' },
      { name: 'Chris Bassitt', status: '60-Day-IL' },
      { name: 'Someone Fine', status: 'Day-To-Day' },
    ],
  },
  away: {
    name: 'Los Angeles Angels', shortName: 'Angels', isHome: false,
    overallRecord: '43-69', homeRecord: '25-33', awayRecord: '18-36',
    lastFive: 'LLLLW'.split('').map((result) => ({ result })),
    atsRecord: '52-58', injuries: [],
  },
};

test('teamQualitativeSignal blends form and injuries, which pull in opposite directions here', () => {
  // Orioles: better recent form (2/5 vs 1/5) but 2 unavailable players against
  // the Angels' zero -- the injury penalty should partly offset the form edge.
  const oriolesSignal = teamQualitativeSignal(CONTEXT, 'Baltimore Orioles');
  const formDiff = 2 / 5 - 1 / 5; // 0.2
  const injuryDiff = (0 - 2) / 3; // theirOut - myOut, capped at maxInjuryDiff=3
  close(oriolesSignal, 0.65 * formDiff + 0.35 * injuryDiff, 'Orioles blended signal');
  assert.ok(oriolesSignal < formDiff, 'the injury penalty must pull the signal down from form alone');

  // The Angels side is the exact mirror image.
  const angelsSignal = teamQualitativeSignal(CONTEXT, 'Los Angeles Angels');
  close(angelsSignal, -oriolesSignal, 'Angels signal must be the exact negation of the Orioles signal');
});

test('teamQualitativeSignal returns null for no context or an unmatched team name', () => {
  assert.equal(teamQualitativeSignal(null, 'Baltimore Orioles'), null);
  assert.equal(teamQualitativeSignal(CONTEXT, 'Some Team Not Playing'), null);
});

test('teamQualitativeSignal returns null when neither side has enough form or any injury data', () => {
  const thin = {
    home: { name: 'Home Team', lastFive: [{ result: 'W' }], injuries: [] },
    away: { name: 'Away Team', lastFive: [{ result: 'L' }], injuries: [] },
  };
  assert.equal(teamQualitativeSignal(thin, 'Home Team'), null);
});
