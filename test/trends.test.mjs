/**
 * Trends (docs/trends.js): every line on a game, both sides, with the
 * player's real hit rate at that number — the pure maths behind the
 * Trends tab. Pins the extraction (best registry price per side, one
 * entry per player + stat + number), the hit flags (a push counts for
 * neither side), the window rates, and the ordering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTrendLines, hitFlags, hitRate, trendRowsFor, sortTrends, overNeed, underNeed } from '../docs/trends.js';
import { buildTrends, runTrendsBuild, getTrends, TRENDS_TTL_MINUTES, TREND_ENABLED_SPORTS, TREND_SPORTS, trendGamesFor } from '../worker/src/trends.js';
import { gamelogStatIndex, NFL_TREND_MARKETS } from '../worker/src/football-props.js';
import { espnAbbr } from '../docs/team-logos.js';

const NOW = Date.parse('2026-10-22T15:00:00Z');
const ctx = { waitUntil: (p) => p };
const game = { eventId: 'n1', sportKey: 'basketball_nba', sportTitle: 'NBA', commenceMs: NOW + 5 * 3.6e6, home: 'New York Knicks', away: 'Boston Celtics' };
const markets = { player_points_alternate: { stat: 'points', label: 'Pts', marketLabel: 'Points' } };
const odds = {
  bookmakers: [
    { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'player_points_alternate', outcomes: [
      { name: 'Over', description: 'Jalen Brunson', point: 24.5, price: -120 },
      { name: 'Under', description: 'Jalen Brunson', point: 24.5, price: -110 },
      { name: 'Over', description: 'Jalen Brunson', point: 19.5, price: -300 },
    ] }] },
    { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_points_alternate', outcomes: [
      { name: 'Over', description: 'Jalen Brunson', point: 24.5, price: -115 },
      { name: 'Under', description: 'Jalen Brunson', point: 24.5, price: -118 },
    ] }] },
    { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'player_points_alternate', outcomes: [
      { name: 'Over', description: 'Jalen Brunson', point: 24.5, price: 100 },
    ] }] },
  ],
};

test('every line on a game is extracted once per player, stat and number, with the best registry price per side', () => {
  const lines = extractTrendLines(odds, game, markets, { isRegistryBook: (k) => k !== 'pinnacle' });
  assert.equal(lines.length, 2);
  const main = lines.find((l) => l.point === 24.5);
  assert.equal(main.over.american, -115, 'FanDuel is the best Over; Pinnacle is not a book the reader can bet');
  assert.equal(main.over.book, 'FanDuel');
  assert.equal(main.under.american, -110);
  assert.equal(main.bookCount, 2);
  const alt = lines.find((l) => l.point === 19.5);
  assert.equal(alt.under, null, 'a line only priced one way has one side');
  assert.equal(alt.id, 'n1:points:jalen brunson:19.5');
});

test('hit flags: a .5 line splits cleanly, an integer line pushes on the number, and pushes count for neither side', () => {
  const rows = [30, 25, 24, 18, 26].map((value) => ({ value }));
  assert.deepEqual(hitFlags(rows, 24.5, 'over'), [1, 1, 0, 0, 1]);
  assert.deepEqual(hitFlags(rows, 24.5, 'under'), [0, 0, 1, 1, 0]);
  assert.deepEqual(hitFlags(rows, 24, 'over'), [1, 1, null, 0, 1]);
  assert.deepEqual(hitFlags(rows, 24, 'under'), [0, 0, null, 1, 0]);
  assert.equal(hitRate([1, 1, null, 0]), 0.667);
  assert.equal(hitRate([null]), null);
  assert.equal(hitRate([1, 0, 1, 1, 1, 0], 5), 0.8);
  assert.equal(overNeed(24.5), 25); assert.equal(overNeed(24), 25);
  assert.equal(underNeed(24.5), 24); assert.equal(underNeed(24), 23);
});

const rowsFor = (values) => values.map((value, i) => ({ value, date: NOW - (i + 1) * 864e5, opponent: `OPP${i}`, atVs: i % 2 ? '@' : 'vs' }));

test('a trend row per side carries the rates per window, the averages, the streak and the last 20 games as bars', () => {
  const [line] = extractTrendLines(odds, game, markets, { isRegistryBook: (k) => k !== 'pinnacle' }).filter((l) => l.point === 24.5);
  const values = [31, 28, 22, 27, 30, 19, 26, 25, 33, 20, 24, 29, 27, 31, 26, 22, 28, 30, 25, 27, 21, 35];
  const rows = trendRowsFor({ ...line, team: 'NYK' }, rowsFor(values));
  assert.equal(rows.length, 2);
  const over = rows.find((r) => r.side === 'over');
  assert.equal(over.selection, 'Jalen Brunson Over 24.5 Pts');
  assert.equal(over.team, 'NYK');
  assert.equal(over.games, 22);
  assert.equal(over.rates.l5, 0.8);
  assert.equal(over.rates.l10, 0.7);
  assert.equal(over.rates.l20, 0.75);
  assert.equal(over.rates.season, Math.round((16 / 22) * 1000) / 1000);
  assert.equal(over.avg.l5, 27.6);
  assert.equal(over.streak, 2, 'two straight hits before the 22');
  assert.equal(over.series.length, 20);
  assert.deepEqual(over.series[0], { value: 31, hit: 1, date: NOW - 864e5, opponent: 'OPP0', atVs: 'vs' });
  const under = rows.find((r) => r.side === 'under');
  assert.equal(under.rates.l10, 0.3);
  assert.equal(under.american, -110);
});

test('sorting: by hit rate in the chosen window, ties to the better price; by odds, the heaviest favourite first; no rate sinks', () => {
  const r = (id, l10, l5, decimal, games = 10) => ({ id, rates: { l10, l5 }, decimal, games });
  const rows = [r('a', 0.7, 1, 1.9), r('b', 0.9, 0.6, 1.3), r('c', 0.9, 0.6, 1.5), r('d', null, null, 1.2)];
  assert.deepEqual(sortTrends(rows).map((x) => x.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(sortTrends(rows, { window: 'l5' }).map((x) => x.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(sortTrends(rows, { by: 'odds' }).map((x) => x.id), ['d', 'b', 'c', 'a']);
});

test('NFL first: it is the only league enabled, scanned a week ahead with the volume props beside the yardage ladders', async () => {
  assert.deepEqual(TREND_ENABLED_SPORTS, ['americanfootball_nfl']);
  assert.equal(TREND_SPORTS.americanfootball_nfl.lookaheadHours, 168);
  assert.ok(['player_pass_completions', 'player_rush_attempts', 'player_pass_tds', 'player_receptions_alternate'].every((k) => NFL_TREND_MARKETS[k]));
  const log = { names: ['completions', 'passingAttempts', 'passingYards', 'passingTouchdowns'], labels: ['CMP', 'ATT', 'YDS', 'TD'] };
  assert.equal(gamelogStatIndex(log, 'passCompletions'), 0);
  assert.equal(gamelogStatIndex(log, 'passAttempts'), 1);
  assert.equal(gamelogStatIndex(log, 'passTds'), 3);
  assert.equal(gamelogStatIndex({ names: ['rushingAttempts', 'rushingYards'], labels: ['CAR', 'YDS'] }, 'rushAttempts'), 0);
  // A Sunday game five days out is inside the football lookahead; the same game is outside a 30-hour league's.
  const sunday = { id: 'f1', sport_key: 'americanfootball_nfl', commence_time: new Date(NOW + 5 * 24 * 3.6e6).toISOString() };
  const env = { POTD_KV: { async get() { return null; } } };
  assert.equal((await trendGamesFor('americanfootball_nfl', [sunday], env, ctx, NOW)).length, 1);
});

/* ---------------------------------------------------------------- */
/* The worker build                                                  */
/* ---------------------------------------------------------------- */

function makeKvStore() {
  const store = new Map();
  return { store, env: { POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
const gamelog = {
  names: ['minutes', 'rebounds', 'assists', 'points'],
  events: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`e${i}`, { gameDate: new Date(NOW - (i + 1) * 864e5).toISOString(), opponent: { abbreviation: 'BOS' }, atVs: '@' }])),
  seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ events: Array.from({ length: 6 }, (_, i) => ({ eventId: `e${i}`, stats: ['34', '5', '7', String(20 + i * 2)] })) }] }],
};
const nbaGame = { id: 'n1', sport_key: 'basketball_nba', commence_time: new Date(NOW + 5 * 3.6e6).toISOString(), home_team: 'New York Knicks', away_team: 'Boston Celtics' };
const KNICKS = espnAbbr('basketball_nba', 'New York Knicks');
const deps = {
  fetchOdds: async () => odds,
  resolve: async (name, abbrs) => (abbrs[0] === KNICKS ? '3934672' : null),
  gamelog: async () => gamelog,
};

test('buildTrends stores one league\'s rows from the feed and the game logs, with the player\'s team, sorted by L10 hit rate', async () => {
  const { env } = makeKvStore();
  const payload = await buildTrends('basketball_nba', [nbaGame], env, ctx, NOW, deps);
  assert.equal(payload.games, 1);
  assert.equal(payload.rows.length, 3, 'two sides of the main line, one of the alternate');
  assert.ok(KNICKS, 'the league map knows the Knicks');
  assert.ok(payload.rows.every((r) => r.team === KNICKS.toUpperCase() && r.games === 6));
  assert.equal(payload.rows[0].rates.l10, 1, 'the alternate Over 19.5 lands every game and leads');
  assert.equal(payload.rows[0].point, 19.5);
  const stored = await getTrends(env, 'basketball_nba');
  assert.equal(stored.builtAt, NOW);
  assert.equal(stored.rows.length, 3);
  assert.deepEqual(await getTrends(env, 'icehockey_nhl'), { sportKey: 'icehockey_nhl', title: 'NHL', builtAt: null, games: 0, rows: [] });
  assert.equal(await getTrends(env, 'baseball_mlb'), null);
});

test('runTrendsBuild rebuilds one stale league per tick and leaves fresh ones alone', async () => {
  const { env } = makeKvStore();
  const opts = { fetchFullSlate: async () => [nbaGame], deps: { basketball_nba: deps }, enabled: ['americanfootball_nfl', 'basketball_nba', 'icehockey_nhl'] };
  const first = await runTrendsBuild(env, ctx, NOW, opts);
  // The NFL and NHL have no games in the slate and no events list reachable, so the NBA builds.
  assert.equal(first.skipped, false);
  assert.equal(first.sportKey, 'basketball_nba');
  assert.equal(first.rows, 3);
  const again = await runTrendsBuild(env, ctx, NOW + 10 * 60e3, opts);
  assert.equal(again.skipped, true);
  const later = await runTrendsBuild(env, ctx, NOW + (TRENDS_TTL_MINUTES + 1) * 60e3, opts);
  assert.equal(later.skipped, false);
  assert.equal(later.sportKey, 'basketball_nba');
});

test('a build that throws is written down for /trends to show, and the next tick tries again', async () => {
  const { env } = makeKvStore();
  const broken = { ...deps, fetchOdds: async () => { throw new Error('feed down'); } };
  const r = await runTrendsBuild(env, ctx, NOW, { fetchFullSlate: async () => [nbaGame], deps: { basketball_nba: broken }, enabled: ['basketball_nba'] });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'build failed');
  const stored = await getTrends(env, 'basketball_nba');
  assert.equal(stored.builtAt, null);
  assert.match(stored.lastError, /feed down/);
  const fixed = await runTrendsBuild(env, ctx, NOW + 60e3, { fetchFullSlate: async () => [nbaGame], deps: { basketball_nba: deps }, enabled: ['basketball_nba'] });
  assert.equal(fixed.skipped, false);
  assert.equal((await getTrends(env, 'basketball_nba')).lastError, undefined);
});
