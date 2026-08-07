import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  gradeAts,
  gradeTotal,
  rankAgainstLeague,
  rankTeamStats,
} from '../worker/src/mlb-stats.js';

/* ---------------------------------------------------------------- */
/* parseLine                                                          */
/* ---------------------------------------------------------------- */

test('parseLine strips the o/u prefix ESPN uses for totals', () => {
  assert.equal(parseLine('o7'), 7);
  assert.equal(parseLine('u7.5'), 7.5);
});

test('parseLine passes a plain spread number through unchanged', () => {
  assert.equal(parseLine('-1.5'), -1.5);
  assert.equal(parseLine('+1.5'), 1.5);
});

test('parseLine returns null for anything that is not a real line', () => {
  assert.equal(parseLine(undefined), null);
  assert.equal(parseLine(null), null);
  assert.equal(parseLine('EVEN'), null);
});

/* ---------------------------------------------------------------- */
/* gradeAts / gradeTotal — verified against a real game: NYM (away,      */
/* +1.5) beat CLE (home, -1.5) 13-6 on 2026-08-06, confirmed live against */
/* the exact numbers a reference app already shows for this same game.    */
/* ---------------------------------------------------------------- */

test('gradeAts grades the real NYM/CLE 8/6 game correctly for both sides', () => {
  // NYM (away) scored 13, getting +1.5.
  assert.equal(gradeAts(13, 6, 1.5), 'W');
  // CLE (home) scored 6, laying -1.5.
  assert.equal(gradeAts(6, 13, -1.5), 'L');
});

test('gradeAts is a push when the margin exactly matches the line', () => {
  // Team wins by exactly 1.5 against a -1.5 line -> margin is 0.
  assert.equal(gradeAts(7, 5.5, -1.5), 'push');
});

test('gradeAts returns null when the line or either score is missing', () => {
  assert.equal(gradeAts(13, 6, null), null);
  assert.equal(gradeAts(null, 6, -1.5), null);
  assert.equal(gradeAts(13, null, -1.5), null);
});

test('gradeTotal grades the real NYM/CLE 8/6 game correctly (19 runs vs. a 7 line)', () => {
  assert.equal(gradeTotal(6, 13, 7), 'O');
});

test('gradeTotal is a push when the total exactly matches the line', () => {
  assert.equal(gradeTotal(4, 3, 7), 'push');
});

test('gradeTotal is Under when the total falls short of the line', () => {
  assert.equal(gradeTotal(1, 2, 7), 'U');
});

test('gradeTotal returns null when the line or either score is missing', () => {
  assert.equal(gradeTotal(6, 13, null), null);
  assert.equal(gradeTotal(null, 13, 7), null);
});

/* ---------------------------------------------------------------- */
/* rankAgainstLeague / rankTeamStats                                  */
/* ---------------------------------------------------------------- */

test('rankAgainstLeague ranks 1st when higher is better and this is the max', () => {
  assert.equal(rankAgainstLeague(0.300, [0.250, 0.260, 0.280], true), 1);
});

test('rankAgainstLeague ranks 1st when lower is better and this is the min (e.g. ERA)', () => {
  assert.equal(rankAgainstLeague(2.50, [3.00, 3.50, 4.00], false), 1);
});

test('rankAgainstLeague counts strictly-better values, so ties share the better rank', () => {
  // Two teams tied at the top (both better than this one) -> this one is 3rd.
  assert.equal(rankAgainstLeague(0.250, [0.300, 0.300, 0.200], true), 3);
});

test('rankAgainstLeague returns null when the value or the league list is missing', () => {
  assert.equal(rankAgainstLeague(null, [0.250, 0.260], true), null);
  assert.equal(rankAgainstLeague(0.250, [], true), null);
  assert.equal(rankAgainstLeague(0.250, null, true), null);
});

test('rankTeamStats ranks every offense/defense stat against the league, direction-aware', () => {
  const teamStats = {
    offense: { battingAvg: 0.260, homeRuns: 150 },
    defense: { era: 3.80 },
  };
  const leagueStats = [
    { offense: { battingAvg: 0.240, homeRuns: 140 }, defense: { era: 4.00 } },
    { offense: { battingAvg: 0.270, homeRuns: 160 }, defense: { era: 3.50 } },
    { offense: { battingAvg: 0.260, homeRuns: 150 }, defense: { era: 3.80 } }, // the team itself
  ];

  const ranked = rankTeamStats(teamStats, leagueStats);
  // battingAvg 0.260: one team (0.270) is better -> rank 2.
  assert.deepEqual(ranked.offense.battingAvg, { value: 0.260, rank: 2 });
  // homeRuns 150: one team (160) is better -> rank 2.
  assert.deepEqual(ranked.offense.homeRuns, { value: 150, rank: 2 });
  // era 3.80, lower is better: one team (3.50) is better -> rank 2.
  assert.deepEqual(ranked.defense.era, { value: 3.80, rank: 2 });
});

test('rankTeamStats returns null for a team with no stats at all', () => {
  assert.equal(rankTeamStats(null, []), null);
});
