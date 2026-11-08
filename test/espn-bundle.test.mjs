/**
 * The runner's ESPN records in KV, read by the Trends build and Pixel's
 * Picks in place of ESPN itself (worker/src/espn-bundle.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleKey, bundleIndexKey, loadBundleTeams, loadBundleIndex, bundlePlayer, bundleDeps, bundleLine } from '../worker/src/espn-bundle.js';

const NOW = Date.parse('2026-10-27T18:00:00Z');
const log = (pts) => ({ names: ['points'], labels: ['PTS'], displayNames: ['Points'], seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ events: pts.map((p, i) => ({ eventId: `e${i}`, stats: [String(p)] })) }] }], events: Object.fromEntries(pts.map((_, i) => [`e${i}`, { gameDate: `2026-10-${20 + i}T00:00Z` }])) });
const bos = { sportKey: 'basketball_nba', team: 'BOS', builtAt: NOW - 3.6e6, players: [
  { id: '4066457', name: 'Derrick White', position: 'G', injuries: [], log: log([20, 18]) },
  { id: '3917376', name: 'Jaylen Brown', position: 'F', injuries: [{ status: 'Day-To-Day', detail: 'Knee' }], log: log([30, 27]) },
] };
const store = new Map([[bundleKey('basketball_nba', 'bos'), JSON.stringify(bos)], [bundleIndexKey('basketball_nba'), JSON.stringify({ builtAt: NOW - 3.6e6, teams: ['BOS'] })]]);
const env = { POTD_KV: { async get(k) { return store.get(k) ?? null; } } };

test('team records are read by abbreviation in either case; a missing team is absent, not null', async () => {
  const teams = await loadBundleTeams(env, 'basketball_nba', ['bos', 'BKN']);
  assert.deepEqual([...teams.keys()], ['BOS']);
  assert.equal(teams.get('BOS').players.length, 2);
  assert.deepEqual(await loadBundleIndex(env, 'basketball_nba'), { builtAt: NOW - 3.6e6, teams: ['BOS'] });
  assert.equal(await loadBundleIndex(env, 'americanfootball_nfl'), null);
  assert.equal((await bundlePlayer(env, 'basketball_nba', 'BOS', 3917376)).name, 'Jaylen Brown');
  assert.equal(await bundlePlayer(env, 'basketball_nba', 'BOS', '1'), null);
});

test('the trace line says which teams the bundle holds and how old it is', async () => {
  const teams = await loadBundleTeams(env, 'basketball_nba', ['bos', 'bkn']);
  assert.equal(bundleLine(teams, ['bos', 'bkn'], NOW), 'espn bundle: 1 of 2 teams, 2 players, oldest 1.0h, missing [BKN]');
  assert.match(bundleLine(new Map(), ['bkn'], NOW), /^espn bundle: none of \[BKN\] in KV/);
  const stale = new Map([['BOS', { ...bos, builtAt: NOW - 40 * 3.6e6 }]]);
  assert.match(bundleLine(stale, ['bos'], NOW), /oldest 40\.0h \(stale\)/);
});

test('the build\'s readers answer from the bundle: a bundled team is authoritative, an unbundled team falls through to the league\'s own', async () => {
  const calls = [];
  const spec = {
    normalizeName: (n) => String(n).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(),
    resolve: async (name, abbrs) => { calls.push(`resolve ${name} ${abbrs}`); return name === 'Cam Thomas' ? '4432174' : null; },
    gamelog: async (id) => { calls.push(`gamelog ${id}`); return log([1]); },
    priorGamelog: async (id) => { calls.push(`prior ${id}`); return null; },
    roster: async (abbr) => { calls.push(`roster ${abbr}`); return { athletes: [] }; },
  };
  const teams = await loadBundleTeams(env, 'basketball_nba', ['bos', 'bkn']);
  const deps = bundleDeps(teams, spec);
  assert.equal(await deps.resolve('Derrick  White', ['bos'], null), '4066457', 'matched through the league\'s normalizer');
  assert.equal(await deps.resolve('Nobody Here', ['bos'], null), null, 'a name missing from a bundled roster is unresolved');
  assert.deepEqual(calls, [], 'a bundled team never sends the build to ESPN');
  assert.equal(await deps.resolve('Cam Thomas', ['bkn'], null), '4432174', 'an unbundled team uses the league\'s own resolver');
  assert.deepEqual(calls, ['resolve Cam Thomas bkn']);
  assert.equal((await deps.gamelog('4066457', null)).seasonTypes[0].categories[0].events.length, 2, 'a bundled log comes from KV');
  assert.equal(await deps.priorGamelog('4066457', null, NOW, null), null, 'a bundled log already carries last season');
  await deps.gamelog('4432174', null);
  await deps.priorGamelog('4432174', null, NOW, null);
  assert.deepEqual(calls.slice(1), ['gamelog 4432174', 'prior 4432174']);
  const roster = await deps.roster('BOS', null);
  assert.deepEqual(roster.athletes[0].items.map((a) => a.displayName), ['Derrick White', 'Jaylen Brown']);
});

test('the injury report: a listed player is tagged out or questionable by his status, an unlisted or playing one is not, and the tag rides on rows by athlete id', async () => {
  const { loadInjuries, injuryFor, withInjuries, injuriesKey } = await import('../worker/src/espn-bundle.js');
  const report = { builtAt: 5, players: {
    1: { name: 'A', team: 'BOS', status: 'Out', detail: 'Knee' }, 2: { name: 'B', team: 'BOS', status: 'Day-To-Day', detail: 'Ankle' }, 3: { name: 'C', team: 'BOS', status: 'Questionable', detail: '' },
    4: { name: 'D', team: 'BOS', status: 'Doubtful', detail: 'Back' }, 5: { name: 'E', team: 'BOS', status: 'Injured Reserve', detail: 'Hamstring' }, 6: { name: 'F', team: 'BOS', status: 'Active', detail: '' },
  } };
  assert.deepEqual(injuryFor(report, 1), { status: 'Out', detail: 'Knee', level: 'out', date: null });
  assert.equal(injuryFor(report, '2').level, 'questionable');
  assert.equal(injuryFor(report, 3).level, 'questionable');
  assert.equal(injuryFor(report, 4).level, 'out');
  assert.equal(injuryFor(report, 5).level, 'out');
  assert.equal(injuryFor(report, 6), null, 'a status that says he plays is no tag');
  assert.equal(injuryFor(report, 99), null);
  assert.deepEqual(withInjuries([{ athleteId: '1', x: 1 }, { athleteId: '9' }], report).map((r) => r.injury?.level ?? null), ['out', null]);
  const store = new Map([[injuriesKey('basketball_nba'), JSON.stringify(report)]]);
  const env = { POTD_KV: { async get(k) { return store.get(k) ?? null; } } };
  assert.equal((await loadInjuries(env, 'basketball_nba')).builtAt, 5);
  assert.deepEqual(await loadInjuries(env, 'americanfootball_nfl'), { builtAt: null, players: {} });
});

test('the roles record: starter flags read from an NBA box score and a soccer lineup, a league without flags yields none, the tag rides on rows by athlete id', async () => {
  const { startersFromSummary, roleFor, withRoles, loadRoles, rolesKey } = await import('../worker/src/espn-bundle.js');
  const nba = { boxscore: { players: [{ team: { abbreviation: 'BOS' }, statistics: [{ athletes: [
    { athlete: { id: 1, displayName: 'A' }, starter: true, stats: ['30'] }, { athlete: { id: 2, displayName: 'B' }, starter: false, stats: ['8'] }, { athlete: { id: 3, displayName: 'C' }, starter: false, didNotPlay: true, stats: [] },
  ] }] }, { team: { abbreviation: 'NYK' }, statistics: [{ athletes: [{ athlete: { id: 4, displayName: 'D' }, starter: true, stats: ['20'] }] }] }] } };
  assert.deepEqual(startersFromSummary(nba).map((p) => `${p.team}:${p.id}:${p.starter}`), ['BOS:1:true', 'BOS:2:false', 'BOS:3:false', 'NYK:4:true']);
  const soccer = { rosters: [{ team: { abbreviation: 'ARS' }, roster: [{ athlete: { id: 7, displayName: 'G' }, starter: true }, { athlete: { id: 8, displayName: 'H' }, starter: false, subbedIn: true }] }] };
  assert.deepEqual(startersFromSummary(soccer).map((p) => `${p.id}:${p.starter}`), ['7:true', '8:false']);
  const nfl = { boxscore: { players: [{ team: { abbreviation: 'PHI' }, statistics: [{ athletes: [{ athlete: { id: 9, displayName: 'Q' }, stats: ['300'] }] }] }] } };
  assert.deepEqual(startersFromSummary(nfl), [], 'no flag, no entry: the NFL is not read as all bench');
  const record = { builtAt: 5, games: {}, players: { 1: { name: 'A', team: 'BOS', starter: true, date: '2026-11-07T00:00Z' }, 2: { name: 'B', team: 'BOS', starter: false, date: '2026-11-07T00:00Z' } } };
  assert.deepEqual(roleFor(record, 1, Date.parse('2026-11-07T00:00Z')), { starter: true, team: 'BOS', date: '2026-11-07T00:00Z', source: 'box', today: true });
  assert.equal(roleFor(record, '2').starter, false); assert.equal(roleFor(record, 99), null);
  assert.deepEqual(withRoles([{ athleteId: '1' }, { athleteId: '2' }, { athleteId: '9' }], record).map((r) => r.role?.starter ?? null), [true, false, null]);
  const store = new Map([[rolesKey('basketball_nba'), JSON.stringify(record)]]);
  const env = { POTD_KV: { async get(k) { return store.get(k) ?? null; } } };
  assert.equal((await loadRoles(env, 'basketball_nba')).builtAt, 5);
  assert.deepEqual(await loadRoles(env, 'americanfootball_nfl'), { builtAt: null, games: {}, players: {} });
});

test('a posted lineup from the core roster: nothing until a starter is flagged, then every entry; the role says today and its source', async () => {
  const { startersFromRoster, roleFor } = await import('../worker/src/espn-bundle.js');
  const unposted = { entries: [{ playerId: 1, active: false, starter: false, didNotPlay: true }, { playerId: 2, active: false, starter: false, didNotPlay: true }] };
  assert.deepEqual(startersFromRoster(unposted), [], 'all false is a lineup not yet posted, not a whole bench');
  assert.deepEqual(startersFromRoster({ entries: [{ playerId: 1 }, { playerId: 2 }] }), [], 'a day out the entries carry no flag');
  const posted = { entries: [{ playerId: 3202, active: true, starter: true, displayName: 'Durant' }, { playerId: 3136777, active: false, starter: false, displayName: 'X' }] };
  assert.deepEqual(startersFromRoster(posted).map((p) => `${p.id}:${p.starter}`), ['3202:true', '3136777:false']);
  const now = Date.parse('2026-11-08T01:00:00Z'); // 8 PM ET on the 7th
  const record = { players: { 1: { starter: true, team: 'HOU', date: '2026-11-08T02:00Z', source: 'lineup' }, 2: { starter: false, team: 'BOS', date: '2026-11-07T00:30Z', source: 'box' } } };
  const a = roleFor(record, 1, now); assert.equal(a.today, true); assert.equal(a.source, 'lineup');
  const b = roleFor(record, 2, now); assert.equal(b.today, false, 'last night in the East'); assert.equal(b.source, 'box');
});
