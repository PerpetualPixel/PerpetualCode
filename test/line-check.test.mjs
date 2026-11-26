import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineFlags, lineVerdict, looksTooGood, baseWindow } from '../docs/line-check.js';
import { teammateChanges, lineupFlags, lineCheck } from '../worker/src/line-check.js';

const DAY = 864e5; const T0 = Date.parse('2026-11-24T00:00:00Z');
const series = (values, opp = () => 'DEN') => values.map((v, i) => ({ value: v, date: T0 - (i + 1) * 3 * DAY, opponent: opp(i), atVs: 'vs' }));
const period = (values, point, over = true) => { const hits = values.filter((v) => (over ? v > point : v < point)).length; const avg = Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10; return { rate: hits / values.length, hits, games: values.length, avg, median: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] }; };
const rowOf = (values, point, american, over = {}) => ({ id: 'r1', sportKey: 'americanfootball_nfl', playerName: 'Michael Pittman Jr.', athleteId: '10', team: 'PIT', opponent: 'DEN', statKey: 'receptions', statLabel: 'Receptions', point, side: 'over', american, series: series(values, over.opp), periods: { l5: period(values.slice(0, 5), point), l10: period(values.slice(0, 10), point), l20: period(values.slice(0, 20), point), ...(over.periods ?? {}) }, ...over.row });

test('the owner\'s screenshot: 19 of 20 at -108, the last five down to two catches, and a game against his own team in the sample', () => {
  // Newest first, as the sheet's chart reads right to left.
  const values = [2, 2, 3, 2, 2, 4, 3, 9, 1, 5, 2, 9, 8, 7, 2, 5, 5, 6, 4, 6];
  const row = rowOf(values, 1.5, -108, { opp: (i) => (i === 15 ? 'PIT' : ['CIN', 'HOU', 'SF', 'JAX', 'KC'][i % 5]) });
  assert.equal(baseWindow(row).games, 20); assert.equal(looksTooGood(row), true);
  const flags = lineFlags(row);
  const by = Object.fromEntries(flags.map((f) => [f.key, f]));
  assert.match(by.price.text, /19 of 20 is 95%, but -108 says about 52%\. Books rarely leave 43 points on the table/);
  assert.equal(by.price.tone, 'warn');
  assert.match(by.form.text, /2\.2 a game over the last five, against 4\.4 over the last 20/);
  assert.match(by.margin.text, /4 of the last five cleared by the minimum or missed \(2, 2, 3, 2, 2\); the line is 1\.5/);
  assert.match(by.team.text, /At least 5 of these 20 games were for another team \(he played against PIT in that stretch\)/);
  assert.equal(by.team.tone, 'warn');
  assert.deepEqual(lineVerdict(flags, { tooGood: true }).key, 'careful');
  assert.match(lineVerdict(flags).text, /3 things to weigh/);
});

test('a line the price agrees with has nothing against it; a gap nothing explains is said to be unexplained', () => {
  const steady = rowOf(Array(20).fill(6), 3.5, -1200);
  const flags = lineFlags(steady);
  assert.deepEqual(flags.map((f) => [f.key, f.tone]), [['price', 'good']]);
  assert.equal(looksTooGood(steady), false);
  assert.equal(lineVerdict(flags).key, 'fair');
  const odd = rowOf(Array(20).fill(6), 3.5, -110);
  assert.deepEqual(lineFlags(odd).map((f) => f.key), ['price']);
  assert.equal(lineVerdict(lineFlags(odd), { tooGood: looksTooGood(odd) }).key, 'unexplained');
});

test('minutes down, an injury listing, a bench role, a bad record against the opponent and a small sample are each flagged', () => {
  const base = rowOf(Array(20).fill(22), 17.5, -120);
  const tones = (row) => Object.fromEntries(lineFlags(row).map((f) => [f.key, f.tone]));
  assert.equal(tones({ ...base, mins: { l3: 22.3, l10: 31, last: 21 } }).minutes, 'bad');
  assert.match(lineFlags({ ...base, mins: { l3: 22.3, l10: 31, last: 21 } }).find((f) => f.key === 'minutes').text, /22\.3 a game over the last three, 31 over the last ten/);
  assert.equal(tones({ ...base, mins: { l3: 30, l10: 31, last: 14 } }).minutes, 'warn');
  assert.equal(tones({ ...base, injury: { status: 'Out', detail: 'ankle' } }).injury, 'bad');
  assert.equal(tones({ ...base, injury: { status: 'Questionable' } }).injury, 'warn');
  assert.equal(tones({ ...base, role: { starter: false, today: true } }).role, 'warn');
  assert.equal(tones({ ...base, periods: { ...base.periods, h2h: { rate: 1 / 3, hits: 1, games: 3 } } }).opponent, 'warn');
  assert.equal(lineVerdict(lineFlags({ ...base, injury: { status: 'Out' } })).key, 'trap');
  const few = rowOf([20, 22, 21], 17.5, -120); few.periods = { l5: period([20, 22, 21], 17.5) };
  assert.equal(tones(few).sample, 'warn');
  // An under reads the other way: a recent run up is the warning, and fewer minutes are not.
  const under = { ...rowOf([9, 9, 8, 9, 9, 5, 5, 4, 5, 5, 5, 4, 5, 5, 5, 4, 5, 5, 5, 4], 9.5, -105), side: 'under' };
  under.periods = { l5: period([9, 9, 8, 9, 9], 9.5, false), l10: period(under.series.slice(0, 10).map((g) => g.value), 9.5, false), l20: period(under.series.map((g) => g.value), 9.5, false) };
  const u = Object.fromEntries(lineFlags({ ...under, mins: { l3: 20, l10: 30, last: 20 } }).map((f) => [f.key, f]));
  assert.match(u.form.title, /Trending up/); assert.equal(u.minutes.tone, 'info');
});

// A team of four over its last eight games (every third day), newest first.
const teamDays = Array.from({ length: 8 }, (_, i) => T0 - (i + 1) * 3 * DAY);
const games = (avg, missing = []) => teamDays.map((date, i) => (missing.includes(i) ? null : { date, value: avg })).filter(Boolean);
const nbaRow = { id: 'r2', sportKey: 'basketball_nba', playerName: 'Trey Murphy III', athleteId: '1', team: 'NO', opponent: 'DEN', home: 'New Orleans Pelicans', away: 'Denver Nuggets', statKey: 'points', statLabel: 'Points', point: 17.5, side: 'over', american: -120, series: series(Array(20).fill(24)), periods: { l5: period(Array(5).fill(24), 17.5), l10: period(Array(10).fill(24), 17.5), l20: period(Array(20).fill(24), 17.5) } };
const team = (ingramMissing) => ({ players: [
  { id: '1', name: 'Trey Murphy III', games: games(24) },
  { id: '2', name: 'Brandon Ingram', games: games(23, ingramMissing) },
  { id: '3', name: 'Role Player', games: games(6) },
  { id: '4', name: 'Another Starter', games: games(12) },
] });
const gamesOf = (p) => p.games;

test('the owner\'s example: a teammate who missed a run of games and is back is the flag that makes it a trap', async () => {
  // Ingram missed five of the seven before the last game, and played the last one.
  const changes = teammateChanges(nbaRow, team([1, 2, 3, 4, 5]), { players: {} }, { gamesOf });
  assert.deepEqual(changes.map((c) => [c.name, c.kind, c.missed, c.of, c.without]), [['Brandon Ingram', 'back', 5, 7, 5]]);
  const flags = await lineupFlags({}, nbaRow, {}, { deps: { team: async () => team([1, 2, 3, 4, 5]), report: async () => ({ players: {} }), context: async () => null, gamesOf } });
  assert.equal(flags.length, 1);
  assert.deepEqual([flags[0].tone, flags[0].title], ['bad', 'Brandon Ingram is back']);
  assert.match(flags[0].text, /He missed 5 of the team's 7 games before the last one and averages 23 points\. 5 of this player's last 8 came without him, so the record flatters the role he has tonight\./);
  const out = await lineCheck({}, 'basketball_nba', 'r2', {}, { deps: { row: nbaRow, team: async () => team([1, 2, 3, 4, 5]), report: async () => ({ players: {} }), context: async () => null, gamesOf } });
  assert.equal(out.verdict.key, 'trap'); assert.equal(out.tooGood, true);
  assert.ok(out.flags.some((f) => f.key === 'price') && out.flags.some((f) => f.key === 'back:Brandon Ingram'));
  // For an under the same return cuts the other way, and is said as information.
  const under = await lineupFlags({}, { ...nbaRow, side: 'under' }, {}, { deps: { team: async () => team([1, 2, 3, 4, 5]), report: async () => ({ players: {} }), context: async () => null, gamesOf } });
  assert.equal(under[0].tone, 'info');
});

test('a teammate still missing is "may be back" unless the report has him out; a full-strength team and a small-number teammate raise nothing; a lopsided game is a blowout risk', async () => {
  const run = (missing, report = { players: {} }, context = null) => lineupFlags({}, nbaRow, {}, { deps: { team: async () => team(missing), report: async () => report, context: async () => context, gamesOf } });
  const due = await run([0, 1, 2, 3]);
  assert.deepEqual([due[0].tone, due[0].title], ['warn', 'Brandon Ingram may be back']);
  assert.match(due[0].text, /missed the team's last 4 games and is not listed as out\. 4 of this player's last 8 came without him/);
  const out = await run([0, 1, 2, 3], { players: { 2: { name: 'Brandon Ingram', team: 'NO', status: 'Out' } } });
  assert.deepEqual([out[0].tone, out[0].title], ['info', 'Brandon Ingram is out']);
  assert.deepEqual(await run([]), [], 'everyone has played: nothing to say');
  assert.deepEqual(await run([3]), [], 'one missed game is not a run');
  // The role player missing games is no change to a 24-point scorer's line.
  const roleOut = await lineupFlags({}, nbaRow, {}, { deps: { team: async () => ({ players: [...team([]).players.slice(0, 2), { id: '3', name: 'Role Player', games: games(6, [1, 2, 3, 4, 5]) }, team([]).players[3]] }), report: async () => ({ players: {} }), context: async () => null, gamesOf } });
  assert.deepEqual(roleOut, []);
  const blow = await run([], { players: {} }, { projection: { home: 84, away: 16 } });
  assert.deepEqual([blow[0].key, blow[0].tone], ['blowout', 'warn']); assert.match(blow[0].text, /84% favourite/);
  // No stored team: the line's own flags still come back.
  const bare = await lineCheck({}, 'basketball_nba', 'r2', {}, { deps: { row: nbaRow, team: async () => null, report: async () => ({ players: {} }), context: async () => null } });
  assert.ok(bare.flags.some((f) => f.key === 'price'));
});

// --- The red flags on a list of lines (2026-11-26: the Parlay Builder's "leave out red flags") ---
import { redFlags, teammateFlags, RED_CHECK_LINES } from '../worker/src/line-check.js';

test('red flags for a list of lines: only the reasons to stay off, one read for the list, and a line off the board is not checked', async () => {
  const murphy = nbaRow;
  const under = { ...nbaRow, id: 'r3', side: 'under' };
  // A player on the other team, whose lineup has not changed.
  const clean = { ...nbaRow, id: 'r4', playerName: 'Another Starter', athleteId: '4', team: 'DEN', opponent: 'NO', periods: { l5: period(Array(5).fill(12), 9.5), l10: period(Array(10).fill(12), 9.5), l20: period(Array(20).fill(12), 9.5) }, point: 9.5, series: series(Array(20).fill(12), () => 'LAL') };
  let reads = 0;
  const deps = { trends: async () => { reads++; return { rows: [murphy, under, clean] }; }, report: async () => ({ players: {} }), roles: async () => null, teams: async () => new Map([['NO', team([1, 2, 3, 4, 5])]]), gamesOf };
  const out = await redFlags({}, 'basketball_nba', ['r2', 'r3', 'r4', 'gone', 'r2'], {}, { now: 5, deps });
  assert.equal(reads, 1);
  assert.deepEqual([out.sportKey, out.at, out.checked], ['basketball_nba', 5, ['r2', 'r3', 'r4']]);
  // Ingram back is a reason to stay off the over; on the under it is information, and the price flag is a warning: neither is red.
  assert.deepEqual(Object.keys(out.flags), ['r2']);
  assert.deepEqual(out.flags.r2.map((f) => [f.key, f.title]), [['back:Brandon Ingram', 'Brandon Ingram is back']]);
  assert.deepEqual(Object.keys(out.flags.r2[0]).sort(), ['key', 'text', 'title']);
  // The same flag the card shows.
  assert.equal(teammateFlags(murphy, team([1, 2, 3, 4, 5]), { players: {} }, { gamesOf })[0].text, out.flags.r2[0].text);
  // A player listed out is red off the line itself, with no team record to hand.
  const listed = await redFlags({}, 'basketball_nba', ['r4'], {}, { deps: { ...deps, report: async () => ({ players: { 4: { name: 'Another Starter', team: 'DEN', status: 'Out' } } }), teams: async () => new Map() } });
  assert.deepEqual(listed.flags.r4.map((f) => f.key), ['injury']);
  // No more than the limit is checked in one go, and nothing asked is nothing checked.
  const many = Array.from({ length: RED_CHECK_LINES + 5 }, (_, i) => ({ ...clean, id: `m${i}` }));
  const capped = await redFlags({}, 'basketball_nba', many.map((r) => r.id), {}, { deps: { ...deps, trends: async () => ({ rows: many }) } });
  assert.equal(capped.checked.length, RED_CHECK_LINES);
  assert.deepEqual((await redFlags({}, 'basketball_nba', [], {}, { deps })).checked, []);
});
