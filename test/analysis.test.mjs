import test from 'node:test';
import assert from 'node:assert/strict';

import {
  quickTakeCap, analysisCacheKey, getOrGenerateAnalysis, tennisFactSheet,
  baseballFactSheet, pitcherRecentForm, firstPitchLine, ordinal, mlbAbbr, inningsNotation,
} from '../worker/src/analysis.js';

const EPOCH = Date.UTC(2000, 0, 1);
const day = (iso) => Math.round((Date.parse(iso) - EPOCH) / 86400000);

/**
 * quickTakeCap and analysisCacheKey are the two pure pieces of the
 * POTD/audit/default three-way split — everything else in this module makes
 * a real Anthropic call, which these tests don't attempt to mock. What
 * matters most here, and what a regression would most easily break, is that
 * the three variants never collide: same event/pick must never resolve to
 * the same cache key or the same bullet cap across variants, because that's
 * exactly the class of bug that would make one surface's write-up silently
 * leak onto another (see the module's own comments on this).
 */

test('quickTakeCap: default caps at 4, POTD and audit both cap at 8', () => {
  assert.equal(quickTakeCap(false, false), 4);
  assert.equal(quickTakeCap(true, false), 8);
  assert.equal(quickTakeCap(false, true), 8);
});

test('quickTakeCap: POTD wins if both flags are somehow set', () => {
  assert.equal(quickTakeCap(true, true), 8);
});

test('analysisCacheKey: three variants for the same event/pick never collide', () => {
  const base = { dateKey: '2026-08-17', eventId: 'evt1', outcomeName: 'Iga Swiatek' };
  const game = analysisCacheKey({ ...base, isPotd: false, isAudit: false });
  const potd = analysisCacheKey({ ...base, isPotd: true, isAudit: false });
  const audit = analysisCacheKey({ ...base, isPotd: false, isAudit: true });

  assert.notEqual(game, potd);
  assert.notEqual(game, audit);
  assert.notEqual(potd, audit);
  // Each carries its own namespace prefix, not just a differing suffix, so a
  // careless prefix match elsewhere in the codebase can't accidentally
  // treat one variant's keys as another's.
  assert.match(game, /^analysis:/);
  assert.match(potd, /^potd-analysis:/);
  assert.match(audit, /^audit-analysis:/);
});

test('analysisCacheKey: same variant/event/pick is stable (a real cache key, not a random one)', () => {
  const base = { dateKey: '2026-08-17', eventId: 'evt1', outcomeName: 'Iga Swiatek', isPotd: false, isAudit: true };
  assert.equal(analysisCacheKey(base), analysisCacheKey({ ...base }));
});

test('analysisCacheKey: different pick on the same event is a different key (per-pick, not per-game)', () => {
  const key = (outcomeName) => analysisCacheKey({
    dateKey: '2026-08-17', eventId: 'evt1', outcomeName, isPotd: false, isAudit: true,
  });
  assert.notEqual(key('Iga Swiatek'), key('Yulia Putintseva'));
});

test('getOrGenerateAnalysis: isAudit still returns null with no ANTHROPIC_API_KEY configured, same as every other variant', async () => {
  const env = { POTD_KV: { async get() { return null; }, async put() {} } };
  const ctx = { waitUntil: (p) => p };
  const candidate = {
    eventId: 'evt1', sportKey: 'tennis_atp_us_open', sportTitle: 'ATP US Open',
    home: 'Elena Rybakina', away: 'Marta Kostyuk', outcomeName: 'Over',
  };
  const result = await getOrGenerateAnalysis(candidate, env, ctx, Date.parse('2026-08-17T12:00:00Z'), { isAudit: true });
  assert.equal(result, null);
});

/* ---------------------------------------------------------------- */
/* tennisFactSheet — the LLM "known facts" block                     */
/* ---------------------------------------------------------------- */

// Fields: [day, surface, court, round, winner, loser, wRank, lRank, retired,
//          sets, tbWinnerSets, tbLoserSets]
const TENNIS_DATA = {
  tour: 'atp',
  seasons: [2026],
  surfaces: ['Hard', 'Clay'],
  courts: ['Outdoor'],
  rounds: ['R1'],
  players: ['Alpha A.', 'Bravo B.', 'Opp1 O.', 'Opp2 O.', 'Opp3 O.', 'Opp4 O.', 'Opp5 O.', 'Opp6 O.'],
  matches: [
    [day('2026-07-01'), 0, 0, 0, 0, 2, 10, 50, 0, 2, 0, 0],
    [day('2026-07-02'), 0, 0, 0, 0, 3, 10, 50, 0, 3, 1, 0],
    [day('2026-07-03'), 0, 0, 0, 0, 4, 10, 50, 0, 3, 0, 1],
    [day('2026-07-04'), 0, 0, 0, 0, 5, 10, 50, 0, 2, 0, 0],
    [day('2026-07-05'), 0, 0, 0, 6, 0, 50, 10, 0, 2, 0, 0],
    [day('2026-07-06'), 0, 0, 0, 0, 1, 10, 20, 0, 3, 1, 0],
  ],
};

test('tennisFactSheet adds surface form, tiebreak record, and grind load for a tournament with a known surface', () => {
  const sheet = tennisFactSheet(TENNIS_DATA, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open'); // US Open -> Hard
  assert.match(sheet, /on Hard:/);
  assert.match(sheet, /in tiebreaks/);
  assert.match(sheet, /averaged .* sets/);
});

test('tennisFactSheet skips surface-form lines entirely for a tournament with no known surface', () => {
  const sheet = tennisFactSheet(TENNIS_DATA, 'Alpha A.', 'Bravo B.', 'tennis_atp_some_250_event');
  // The surface-form line's own distinct shape ("<name> on <Surface>: ..."),
  // not the generic recent-form line's parenthetical "(Hard, R1)" mentions.
  assert.doesNotMatch(sheet, /on Hard:/);
  assert.doesNotMatch(sheet, /on Clay:/);
  // Non-surface facts are unaffected by an unknown tournament.
  assert.match(sheet, /recent form/);
  assert.match(sheet, /in tiebreaks/);
});

test('tennisFactSheet still always states the head-to-head situation, even absent', () => {
  const sheet = tennisFactSheet(TENNIS_DATA, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open');
  assert.match(sheet, /Head-to-head/);
});

test('tennisFactSheet returns null when the archive has no matches at all', () => {
  assert.equal(tennisFactSheet({ matches: [] }, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open'), null);
  assert.equal(tennisFactSheet(null, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open'), null);
});

/* ---------------------------------------------------------------- */
/* baseballFactSheet — the MLB "known facts" block                   */
/* ---------------------------------------------------------------- */

/**
 * The bug these cover: an MLB pick could render with no write-up at all.
 * The baseball branch built its fact sheet from starters plus a W-L record
 * and nothing else, and a null fact sheet makes getOrGenerateAnalysis return
 * null — so a game with no probable starter posted yet, or an unmapped team
 * name, silently produced no analysis on the card. What it DID produce was
 * two lines of context behind a prompt that asks the model to weigh recent
 * form and day/night context, neither of which was ever in the sheet.
 */

const PITCHER = {
  playerId: '1', name: 'Ace Alpha', throws: 'R', wins: 12, losses: 6,
  era: 3.12, whip: 1.05, ip: '165.1', strikeouts: 210, walks: 38,
};
const OUTINGS = [
  { ip: '7.0', earnedRuns: 1, strikeouts: 9, walks: 1, homeRuns: 0 },
  { ip: '6.2', earnedRuns: 2, strikeouts: 7, walks: 2, homeRuns: 1 },
];
const RANKED = {
  offense: {
    battingAvg: { value: 0.268, rank: 4 }, obpSlugging: { value: 0.782, rank: 3 },
    runs: { value: 640, rank: 2 }, homeRuns: { value: 198, rank: 1 },
  },
  defense: { era: { value: 3.55, rank: 6 }, whip: { value: 1.18, rank: 5 } },
};

test('baseballFactSheet carries the starters, their recent-form ERA, and ranked team stats', () => {
  const sheet = baseballFactSheet({
    pitchers: { away: PITCHER, home: null, date: '2026-08-24T23:05:00Z' },
    awaySplits: { season: '78-52', lastTen: '7-3', home: '42-22', away: '36-30' },
    awayStats: RANKED,
    awayOutings: OUTINGS,
    headToHead: [],
  }, 'New York Yankees', 'Boston Red Sox');

  assert.match(sheet, /Ace Alpha/);
  assert.match(sheet, /3\.12 ERA/);          // season line
  assert.match(sheet, /Recent form/);         // the line the prompt asks for
  assert.match(sheet, /\.782 OPS \(3rd of 30\)/); // ranked, not just raw
  assert.match(sheet, /7-3 in their last 10/);
  // A starter ESPN hasn't posted yet is stated plainly, never invented.
  assert.match(sheet, /Boston Red Sox starter: not yet announced/);
});

test('baseballFactSheet returns null only when nothing at all resolved', () => {
  // Both starters unannounced and no other source resolving is not context —
  // the caller needs that signal to fall back to the generic ESPN sheet.
  assert.equal(baseballFactSheet({ pitchers: { away: null, home: null } }, 'A', 'B'), null);
  assert.equal(baseballFactSheet(null, 'A', 'B'), null);
  assert.equal(baseballFactSheet({}, 'A', 'B'), null);
  // But a sheet with real splits and no starters is still real context.
  assert.ok(baseballFactSheet({ awaySplits: { season: '78-52' } }, 'A', 'B'));
});

test('baseballFactSheet states an empty season series as an explicit absence, not silence', () => {
  const sheet = baseballFactSheet({
    awaySplits: { season: '78-52' }, headToHead: [],
  }, 'New York Yankees', 'Boston Red Sox');
  // Same reasoning as tennis's head-to-head line: silence invites the model
  // to fill the gap, an explicit "no meetings" does not.
  assert.match(sheet, /no completed meetings/);
  assert.match(sheet, /not evidence about either side/);
});

test('pitcherRecentForm reads ".1"/".2" innings as thirds, not decimals', () => {
  // 6.2 IP is six innings and two outs (20 outs), not 6.2 innings. Treating
  // it as a decimal understates the workload and so overstates the ERA.
  const form = pitcherRecentForm([{ ip: '6.2', earnedRuns: 2, strikeouts: 7, walks: 2, homeRuns: 1 }]);
  assert.equal(form.starts, 1);
  assert.ok(Math.abs(form.innings - 20 / 3) < 1e-9);
  assert.ok(Math.abs(form.era - (2 * 9) / (20 / 3)) < 1e-9);
});

test('pitcherRecentForm computes ERA from real totals, not an average of per-game ERAs', () => {
  // 1 ER in 9 IP and 5 ER in 1 IP is 6 ER in 10 IP (5.40), not the mean of
  // the two individual game ERAs (1.00 and 45.00).
  const form = pitcherRecentForm([
    { ip: '9.0', earnedRuns: 1 },
    { ip: '1.0', earnedRuns: 5 },
  ]);
  assert.ok(Math.abs(form.era - 5.4) < 1e-9);
  assert.equal(form.innings, 10);
});

test('pitcherRecentForm returns null for an empty or unusable log', () => {
  assert.equal(pitcherRecentForm([]), null);
  assert.equal(pitcherRecentForm(null), null);
  assert.equal(pitcherRecentForm([{ ip: null, earnedRuns: 3 }]), null);
});

test('firstPitchLine labels day and night games off the ET hour', () => {
  // 23:05Z is 7:05pm ET in August; 17:05Z is 1:05pm ET.
  assert.match(firstPitchLine('2026-08-24T23:05:00Z'), /night game/);
  assert.match(firstPitchLine('2026-08-24T17:05:00Z'), /day game/);
  assert.equal(firstPitchLine('not a date'), null);
  assert.equal(firstPitchLine(null), null);
});

test('ordinal handles the teens, which are the ranks a naive suffix gets wrong', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(30), '30th');
  assert.equal(ordinal(null), null);
});

test('mlbAbbr resolves every spelling of the Athletics to the one current ESPN slug', () => {
  // The franchise relocated and ESPN's slug moved from "oak" to "ath"; an
  // unmapped name means no fact sheet, which is how a pick loses its write-up.
  assert.equal(mlbAbbr('Athletics'), 'ath');
  assert.equal(mlbAbbr('Oakland Athletics'), 'ath');
  assert.equal(mlbAbbr('Sacramento Athletics'), 'ath');
  assert.equal(mlbAbbr('Not A Team'), null);
});

test('inningsNotation writes outs as baseball thirds, never a decimal', () => {
  // 41 outs is thirteen innings and two outs. Rendering it "13.7" (the plain
  // decimal) is the tell that a write-up was not produced by anyone who
  // follows the sport, which is exactly the voice this text is meant to have.
  assert.equal(inningsNotation(41), '13.2');
  assert.equal(inningsNotation(28), '9.1');
  assert.equal(inningsNotation(27), '9.0');
  assert.equal(inningsNotation(0), '0.0');
  assert.equal(inningsNotation(-1), null);
  assert.equal(inningsNotation(null), null);
});

test('baseballFactSheet writes rate stats without a leading zero, and ERA with one', () => {
  const sheet = baseballFactSheet({
    awayStats: {
      offense: { battingAvg: { value: 0.268, rank: 4 }, obpSlugging: { value: 0.782, rank: 3 } },
      defense: { era: { value: 3.55, rank: 6 }, fieldingPercentage: { value: 0.987, rank: 8 } },
    },
  }, 'New York Yankees', 'Boston Red Sox');
  assert.match(sheet, /\.268 AVG/);
  assert.match(sheet, /\.782 OPS/);
  assert.match(sheet, /\.987 fielding pct/);
  assert.doesNotMatch(sheet, /0\.268/);
  // ERA is not a leading-zero-dropped stat; it keeps its whole number.
  assert.match(sheet, /3\.55 team ERA/);
});

test('baseballFactSheet reports recent-form innings in thirds, not as a decimal', () => {
  const sheet = baseballFactSheet({
    pitchers: { away: PITCHER, home: null },
    awayOutings: OUTINGS, // 7.0 + 6.2 = 41 outs = 13.2 IP
  }, 'New York Yankees', 'Boston Red Sox');
  assert.match(sheet, /13\.2 IP/);
  assert.doesNotMatch(sheet, /13\.7 IP/);
});
