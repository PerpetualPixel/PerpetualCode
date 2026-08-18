import test from 'node:test';
import assert from 'node:assert/strict';

import {
  currentNflSeason,
  parseNflTeamWeekCsv,
  aggregateNflEfficiency,
  nflEpaDifferential,
  fetchNflEfficiency,
  NFL_TEAM_BY_ABBR,
} from '../worker/src/nfl-efficiency.js';

/* ---------------------------------------------------------------- */
/* Season selection                                                   */
/* ---------------------------------------------------------------- */

test('currentNflSeason keys by the start year, rolling over in August', () => {
  assert.equal(currentNflSeason(Date.UTC(2026, 6, 15)), 2025); // mid-July: last season's file is the latest complete one
  assert.equal(currentNflSeason(Date.UTC(2026, 7, 1)), 2026); // August 1: new season's file
  assert.equal(currentNflSeason(Date.UTC(2027, 0, 15)), 2026); // January: still last fall's season
});

/* ---------------------------------------------------------------- */
/* CSV parsing                                                        */
/* ---------------------------------------------------------------- */

const HEADER = 'season,week,team,season_type,game_id,opponent_team,passing_epa,rushing_epa,attempts,carries';

test('parseNflTeamWeekCsv reads the columns it actually needs and ignores the rest', () => {
  const csv = [
    HEADER,
    '2025,1,ARI,REG,g1,NO,1.5,1.1,29,27',
    '2025,1,NO,REG,g1,ARI,-0.5,-0.2,30,20',
  ].join('\n');
  const rows = parseNflTeamWeekCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { team: 'ARI', opponent: 'NO', week: 1, offEpa: 1.5 + 1.1, offPlays: 29 + 27 });
});

test('parseNflTeamWeekCsv skips rows with missing or non-numeric required fields', () => {
  const csv = [HEADER, '2025,1,ARI,REG,g1,NO,,1.1,29,27', '2025,1,,REG,g1,ARI,-0.5,-0.2,30,20'].join('\n');
  assert.equal(parseNflTeamWeekCsv(csv).length, 0);
});

test('parseNflTeamWeekCsv returns [] for a file missing the columns this needs', () => {
  assert.deepEqual(parseNflTeamWeekCsv('a,b,c\n1,2,3'), []);
  assert.deepEqual(parseNflTeamWeekCsv(''), []);
  assert.deepEqual(parseNflTeamWeekCsv(null), []);
});

/* ---------------------------------------------------------------- */
/* Aggregation                                                        */
/* ---------------------------------------------------------------- */

test('aggregateNflEfficiency computes offense from a team\'s own rows and defense by mirroring the opponent\'s', () => {
  const rows = [
    // ARI plays NO in week 1, KC in week 2.
    { team: 'ARI', opponent: 'NO', week: 1, offEpa: 10, offPlays: 50 }, // ARI offense: 0.2 EPA/play
    { team: 'NO', opponent: 'ARI', week: 1, offEpa: -5, offPlays: 50 }, // NO offense that week: -0.1 EPA/play (this is what ARI's defense allowed)
    { team: 'ARI', opponent: 'KC', week: 2, offEpa: 6, offPlays: 60 },
    { team: 'KC', opponent: 'ARI', week: 2, offEpa: 12, offPlays: 60 }, // KC offense: 0.2 EPA/play allowed by ARI's defense
  ];
  const eff = aggregateNflEfficiency(rows);
  const ari = eff['Arizona Cardinals'];
  assert.equal(ari.games, 2);
  // ARI offense: (10+6)/(50+60) = 16/110
  assert.ok(Math.abs(ari.offEpaPerPlay - 16 / 110) < 1e-9);
  // ARI defense allowed: mirrors NO's and KC's offensive rows in those same games: (-5+12)/(50+60) = 7/110
  assert.ok(Math.abs(ari.defEpaPerPlayAllowed - 7 / 110) < 1e-9);
});

test('aggregateNflEfficiency only keeps the most recent rollingGames per team', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    team: 'ARI', opponent: 'NO', week: i + 1, offEpa: i, offPlays: 10,
  }));
  const eff = aggregateNflEfficiency(rows, { rollingGames: 3 });
  assert.equal(eff['Arizona Cardinals'].games, 3); // weeks 8, 9, 10 only
  // offEpa for weeks 8,9,10 = 7+8+9=24 over 30 plays
  assert.ok(Math.abs(eff['Arizona Cardinals'].offEpaPerPlay - 24 / 30) < 1e-9);
});

test('aggregateNflEfficiency maps abbreviations to full team names for all 32 teams', () => {
  assert.equal(Object.keys(NFL_TEAM_BY_ABBR).length, 32);
  const rows = [{ team: 'KC', opponent: 'LV', week: 1, offEpa: 5, offPlays: 50 }];
  const eff = aggregateNflEfficiency(rows);
  assert.ok('Kansas City Chiefs' in eff);
});

/* ---------------------------------------------------------------- */
/* Matchup differential                                               */
/* ---------------------------------------------------------------- */

test('nflEpaDifferential compares each side\'s offense against the OTHER side\'s actual defense', () => {
  const efficiency = {
    'Team A': { offEpaPerPlay: 0.15, defEpaPerPlayAllowed: -0.10 }, // strong offense, strong defense
    'Team B': { offEpaPerPlay: -0.05, defEpaPerPlayAllowed: 0.10 }, // weak offense, weak defense
  };
  const diff = nflEpaDifferential(efficiency, 'Team A', 'Team B');
  assert.ok(diff > 0, 'the stronger team on both sides of the ball must favor positively');
  assert.ok(diff <= 1 && diff >= -1, 'clamped to -1..1');
  // Symmetry: B's view of the same matchup must be the exact negation.
  const reverse = nflEpaDifferential(efficiency, 'Team B', 'Team A');
  assert.ok(Math.abs(diff + reverse) < 1e-9);
});

test('nflEpaDifferential returns null when either team is missing or incomplete', () => {
  const efficiency = {
    'Team A': { offEpaPerPlay: 0.1, defEpaPerPlayAllowed: -0.1 },
    'Team C': { offEpaPerPlay: 0.1 }, // no defEpaPerPlayAllowed yet — early season
  };
  assert.equal(nflEpaDifferential(efficiency, 'Team A', 'Team B'), null); // Team B not in the file at all
  assert.equal(nflEpaDifferential(efficiency, 'Team A', 'Team C'), null); // Team C incomplete
  assert.equal(nflEpaDifferential(null, 'Team A', 'Team B'), null);
});

test('nflEpaDifferential compared against itself is 0, not null — a real, well-defined "no edge" answer', () => {
  const efficiency = { 'Team A': { offEpaPerPlay: 0.1, defEpaPerPlayAllowed: -0.1 } };
  assert.equal(nflEpaDifferential(efficiency, 'Team A', 'Team A'), 0);
});

test('nflEpaDifferential clamps a wildly lopsided matchup to the -1..1 band rather than overflowing', () => {
  const efficiency = {
    'Team A': { offEpaPerPlay: 5, defEpaPerPlayAllowed: -5 },
    'Team B': { offEpaPerPlay: -5, defEpaPerPlayAllowed: 5 },
  };
  assert.equal(nflEpaDifferential(efficiency, 'Team A', 'Team B'), 1);
  assert.equal(nflEpaDifferential(efficiency, 'Team B', 'Team A'), -1);
});

/* ---------------------------------------------------------------- */
/* Fetch                                                              */
/* ---------------------------------------------------------------- */

test('fetchNflEfficiency returns null on a failed or unreachable fetch, never throws', async () => {
  const failing = async () => ({ ok: false, status: 404 });
  assert.equal(await fetchNflEfficiency({ fetchFn: failing }), null);

  const throwing = async () => { throw new Error('network down'); };
  assert.equal(await fetchNflEfficiency({ fetchFn: throwing }), null);
});

test('fetchNflEfficiency parses and aggregates a real fetch response end to end', async () => {
  const csv = [HEADER, '2025,1,ARI,REG,g1,NO,1.5,1.1,29,27', '2025,1,NO,REG,g1,ARI,-0.5,-0.2,30,20'].join('\n');
  const fetchFn = async () => ({ ok: true, text: async () => csv });
  const result = await fetchNflEfficiency({ season: 2025, fetchFn });
  assert.equal(result.season, 2025);
  assert.ok(result.teams['Arizona Cardinals']);
  assert.ok(Number.isFinite(result.updatedAt));
});
