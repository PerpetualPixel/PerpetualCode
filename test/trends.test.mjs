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
import { buildTrends, buildLeagueChunk, runTrendsBuild, getTrends, TRENDS_TTL_MINUTES, TREND_ENABLED_SPORTS, TREND_SPORTS, GAME_HOURS, trendDayKeys, MAX_GAMES_PER_TICK, trendGamesFor } from '../worker/src/trends.js';
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
  assert.equal(main.over[0].american, -115, 'FanDuel is the best Over; Pinnacle is not a book the reader can bet');
  assert.equal(main.over[0].book, 'FanDuel');
  assert.deepEqual(main.over.map((q) => q.bookKey), ['fanduel', 'draftkings'], 'every registry book, best first');
  assert.equal(main.under[0].american, -110);
  assert.equal(main.bookCount, 2);
  const alt = lines.find((l) => l.point === 19.5);
  assert.equal(alt.under, null, 'a line only priced one way has one side');
  assert.equal(alt.id, 'n1:points:jalen brunson:19.5');
  // A deep link on the outcome rides on its quote; a book without one carries null.
  const linked = { bookmakers: [{ key: 'draftkings', title: 'DraftKings', link: 'https://dk/book', markets: [{ key: 'player_points_alternate', link: 'https://dk/market', outcomes: [{ name: 'Over', description: 'Jalen Brunson', point: 24.5, price: -120, link: 'https://dk/slip?line=1' }] }] }, { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_points_alternate', outcomes: [{ name: 'Over', description: 'Jalen Brunson', point: 24.5, price: -115 }] }] }] };
  const [line] = extractTrendLines(linked, game, markets);
  assert.equal(line.over.find((q) => q.bookKey === 'draftkings').link, 'https://dk/slip?line=1');
  assert.equal(line.over.find((q) => q.bookKey === 'fanduel').link, null);
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

// 22 games: the first 18 this season, the last 4 last season; BOS every third game.
const rowsFor = (values) => values.map((value, i) => ({
  value, date: NOW - (i + 1) * 864e5, season: i < 18 ? 2026 : 2025, opponent: i % 3 === 0 ? 'BOS' : `OPP${i}`, atVs: i % 2 ? '@' : 'vs', score: 'W 110-100',
}));

test('a trend row per side carries every period — L5/L10/L20, each season, head-to-head — with counts, averages and medians, the streak, the last 20 games and every book', () => {
  const [line] = extractTrendLines(odds, game, markets, { isRegistryBook: (k) => k !== 'pinnacle' }).filter((l) => l.point === 24.5);
  const values = [31, 28, 22, 27, 30, 19, 26, 25, 33, 20, 24, 29, 27, 31, 26, 22, 28, 30, 25, 27, 21, 35];
  const rows = trendRowsFor({ ...line, team: 'NYK', athleteId: '1', headshot: 'h.png' }, rowsFor(values), { opponent: 'bos' });
  assert.equal(rows.length, 2);
  const over = rows.find((r) => r.side === 'over');
  assert.equal(over.selection, 'Jalen Brunson Over 24.5 Pts');
  assert.equal(over.team, 'NYK');
  assert.equal(over.opponent, 'bos');
  assert.equal(over.headshot, 'h.png');
  assert.equal(over.games, 22);
  assert.deepEqual(over.seasons, [2026, 2025]);
  assert.equal(over.rates.l5, 0.8);
  assert.equal(over.rates.l10, 0.7);
  assert.equal(over.rates.l20, 0.75);
  assert.deepEqual(over.periods.l5, { rate: 0.8, hits: 4, games: 5, avg: 27.6, median: 28 });
  assert.equal(over.periods.s2026.games, 18);
  assert.equal(over.periods.s2025.games, 4);
  assert.equal(over.rates.s2025, 0.75, '25, 27, 21, 35 — three of four');
  // Head-to-head: games 0, 3, 6, 9, 12, 15, 18, 21 — values 31, 27, 26, 20, 27, 22, 25, 35 — six of eight clear 24.5.
  assert.deepEqual(over.periods.h2h, { rate: 0.75, hits: 6, games: 8, avg: 26.6, median: 26.5 });
  assert.equal(over.streak, 2, 'two straight hits before the 22');
  assert.equal(over.series.length, 20);
  assert.deepEqual(over.series[0], { value: 31, hit: 1, date: NOW - 864e5, season: 2026, opponent: 'BOS', atVs: 'vs', score: 'W 110-100', result: undefined });
  assert.deepEqual(over.quotes.map((q) => q.bookKey), ['fanduel', 'draftkings']);
  const under = rows.find((r) => r.side === 'under');
  assert.equal(under.rates.l10, 0.3);
  assert.equal(under.american, -110);
  // No opponent known: the head-to-head period is empty rather than wrong.
  assert.equal(trendRowsFor(line, rowsFor(values))[0].periods.h2h.games, 0);
});

test('sorting: by hit rate in the chosen period, ties to the better price; by odds; by kickoff; either direction; no rate sinks', () => {
  const r = (id, l10, l5, decimal, commenceMs) => ({ id, rates: { l10, l5 }, decimal, commenceMs, periods: { l10: { games: 10 }, l5: { games: 5 } } });
  const rows = [r('a', 0.7, 1, 1.9, 3), r('b', 0.9, 0.6, 1.3, 1), r('c', 0.9, 0.6, 1.5, 2), r('d', null, null, 1.2, 0)];
  assert.deepEqual(sortTrends(rows).map((x) => x.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(sortTrends(rows, { dir: 'asc' }).map((x) => x.id), ['a', 'c', 'b', 'd'], 'ascending still sinks the rateless row');
  assert.deepEqual(sortTrends(rows, { window: 'l5' }).map((x) => x.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(sortTrends(rows, { by: 'odds' }).map((x) => x.id), ['a', 'c', 'b', 'd'], 'longest price first');
  assert.deepEqual(sortTrends(rows, { by: 'odds', dir: 'asc' }).map((x) => x.id), ['d', 'b', 'c', 'a'], 'heaviest favourite first');
  assert.deepEqual(sortTrends(rows, { by: 'date' }).map((x) => x.id), ['d', 'b', 'c', 'a'], 'soonest kickoff first');
});

test('NBA and NFL only, every NBA prop market; the NFL keeps its week-ahead spec, rebuilt twice a day', async () => {
  assert.deepEqual(TREND_ENABLED_SPORTS, ['basketball_nba', 'americanfootball_nfl']);
  assert.equal(TREND_SPORTS.americanfootball_nfl.ttlMinutes, 720);
  assert.ok(['player_points', 'player_threes', 'player_points_rebounds_assists', 'player_blocks_steals', 'player_rebounds_assists_alternate'].every((k) => TREND_SPORTS.basketball_nba.markets[k]), 'main and alternate lines for every NBA stat');
  assert.equal(typeof TREND_SPORTS.basketball_nba.statRows, 'function');
  assert.deepEqual(trendDayKeys(NOW), ['2026-10-22', '2026-10-23'], 'today and tomorrow, ET');
  assert.equal(GAME_HOURS, 4);
  assert.ok(TREND_SPORTS.basketball_nba.priorGamelog && TREND_SPORTS.basketball_nba.headshot, 'the NBA reads last season and shows headshots too');
  assert.ok(TREND_SPORTS.icehockey_nhl.priorGamelog && TREND_SPORTS.icehockey_nhl.headshot);
  assert.equal(TREND_SPORTS.basketball_nba.headshot('123'), 'https://a.espncdn.com/i/headshots/nba/players/full/123.png');
  assert.ok(['player_pass_completions', 'player_rush_attempts', 'player_pass_tds', 'player_receptions_alternate'].every((k) => NFL_TREND_MARKETS[k]));
  const log = { names: ['completions', 'passingAttempts', 'passingYards', 'passingTouchdowns'], labels: ['CMP', 'ATT', 'YDS', 'TD'] };
  assert.equal(gamelogStatIndex(log, 'passCompletions'), 0);
  assert.equal(gamelogStatIndex(log, 'passAttempts'), 1);
  assert.equal(gamelogStatIndex(log, 'passTds'), 3);
  assert.equal(gamelogStatIndex({ names: ['rushingAttempts', 'rushingYards'], labels: ['CAR', 'YDS'] }, 'rushAttempts'), 0);
  // A Sunday game five days out is not today's or tomorrow's; a game that tipped off two hours ago still is; one over four hours ago is gone.
  const sunday = { id: 'f1', sport_key: 'americanfootball_nfl', commence_time: new Date(NOW + 5 * 24 * 3.6e6).toISOString() };
  const env = { POTD_KV: { async get() { return null; } } };
  assert.equal((await trendGamesFor('americanfootball_nfl', [sunday], env, ctx, NOW)).length, 0);
  const live = { id: 'f2', sport_key: 'americanfootball_nfl', commence_time: new Date(NOW - 2 * 3.6e6).toISOString() };
  const over = { id: 'f3', sport_key: 'americanfootball_nfl', commence_time: new Date(NOW - 5 * 3.6e6).toISOString() };
  assert.deepEqual((await trendGamesFor('americanfootball_nfl', [live, over], env, ctx, NOW)).map((g) => g.id), ['f2']);
  // Nothing caps the slate: every game inside the window is scanned, soonest first.
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, sport_key: 'americanfootball_nfl', commence_time: new Date(NOW + (25 - i) * 3.6e6).toISOString() }));
  const got = await trendGamesFor('americanfootball_nfl', many, env, ctx, NOW);
  assert.equal(got.length, 25);
  assert.equal(got[0].id, 'f24', 'soonest first');
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

test('buildTrends builds one league\'s rows from the feed and the game logs, with the player\'s team, sorted by L10 hit rate; the chunk builder stores them', async () => {
  const { env } = makeKvStore();
  const payload = await buildLeagueChunk('basketball_nba', [nbaGame], env, ctx, NOW, { deps });
  assert.equal(payload.games, 1);
  assert.equal(payload.pending, 0);
  assert.equal(payload.rows.length, 3, 'two sides of the main line, one of the alternate');
  assert.ok(KNICKS, 'the league map knows the Knicks');
  assert.ok(payload.rows.every((r) => r.team === KNICKS.toUpperCase() && r.games === 6));
  assert.equal(payload.rows[0].rates.l10, 1, 'the alternate Over 19.5 lands every game and leads');
  assert.equal(payload.rows[0].point, 19.5);
  assert.equal(payload.rows[0].opponent, espnAbbr('basketball_nba', 'Boston Celtics').toUpperCase(), 'the other team is the head-to-head opponent');
  assert.equal(payload.rows[0].periods.h2h.games, 6, 'every logged game here was against Boston');
  assert.equal(payload.rows[0].athleteId, '3934672');
  const stored = await getTrends(env, 'basketball_nba');
  assert.equal(stored.builtAt, NOW);
  assert.equal(stored.rows.length, 3);
  assert.deepEqual(stored.stamps, { n1: NOW }, 'each game remembers when its rows were built');
  assert.deepEqual(await getTrends(env, 'icehockey_nhl'), { sportKey: 'icehockey_nhl', title: 'NHL', builtAt: null, games: 0, pending: 0, rows: [], stamps: {} });
  assert.equal(await getTrends(env, 'baseball_mlb'), null);
  // The prior season is asked for by the END year of the current log's name.
  const asked = [];
  const withPrior = { ...deps, gamelog: async (id, c, season) => { asked.push(season ?? 'current'); return gamelog; } };
  await buildTrends('basketball_nba', [nbaGame], env, ctx, NOW, { ...withPrior, priorGamelog: TREND_SPORTS.basketball_nba.priorGamelog });
  assert.deepEqual(asked, ['current'], 'the spec\'s prior reader goes through the real fetcher, which the test deps replace');
});

test('a big slate builds a few games per tick, merges into what is stored, and drops games once they start', async () => {
  const { env } = makeKvStore();
  const games = Array.from({ length: 8 }, (_, i) => ({ ...nbaGame, id: `g${i}`, commence_time: new Date(NOW + (i + 1) * 3.6e6).toISOString() }));
  const first = await buildLeagueChunk('basketball_nba', games, env, ctx, NOW, { deps });
  assert.equal(first.games, MAX_GAMES_PER_TICK);
  assert.equal(first.pending, 8 - MAX_GAMES_PER_TICK);
  assert.equal(first.rows.length, 3 * MAX_GAMES_PER_TICK);
  assert.deepEqual(Object.keys(first.stamps), games.slice(0, MAX_GAMES_PER_TICK).map((g) => g.id), 'soonest games first');
  const second = await buildLeagueChunk('basketball_nba', games, env, ctx, NOW + 15 * 60e3, { deps });
  assert.equal(second.games, 8);
  assert.equal(second.pending, 0);
  assert.equal(second.rows.length, 24, 'the first chunk\'s rows are kept beside the new ones');
  assert.equal(await buildLeagueChunk('basketball_nba', games, env, ctx, NOW + 30 * 60e3, { deps }), null, 'nothing due: every game is fresh');
  // Two hours on, the first two games have tipped off: their rows stay up through play, and nothing is rebuilt.
  assert.equal(await buildLeagueChunk('basketball_nba', games, env, ctx, NOW + 2 * 3.6e6 + 1, { deps }), null);
  assert.equal((await getTrends(env, 'basketball_nba')).rows.length, 24, 'a game in play keeps its rows');
  // Five hours on, the first game is over: its rows go.
  assert.equal(await buildLeagueChunk('basketball_nba', games, env, ctx, NOW + 5 * 3.6e6 + 1, { deps }), null);
  const trimmed = await getTrends(env, 'basketball_nba');
  assert.equal(trimmed.games, 7);
  assert.equal(trimmed.rows.length, 21);
  assert.ok(trimmed.rows.every((r) => r.eventId !== 'g0'));
  // Past the league's TTL the stale games rebuild (eight hours on, every game has tipped off but the chunk still refreshes what is left), oldest stamp first.
  const nbaTtl = TREND_SPORTS.basketball_nba.ttlMinutes;
  const later = games.map((g, i) => ({ ...g, commence_time: new Date(NOW + (nbaTtl + 60 + i) * 60e3).toISOString() }));
  const rebuilt = await buildLeagueChunk('basketball_nba', later, env, ctx, NOW + (nbaTtl + 1) * 60e3, { deps });
  assert.equal(rebuilt.games, 8, 'every game is live again at its new time');
  assert.equal(rebuilt.rows.length, 24, 'six games rebuilt beside the two still-fresh ones');
  assert.equal(rebuilt.stamps.g0, NOW + (nbaTtl + 1) * 60e3);
  assert.equal(rebuilt.pending, 0);
});

test('runTrendsBuild builds one league\'s chunk per tick, the league checked longest ago first, and leaves fresh ones alone', async () => {
  const { env } = makeKvStore();
  const opts = { fetchFullSlate: async () => [nbaGame], deps: { basketball_nba: deps }, enabled: ['americanfootball_nfl', 'basketball_nba', 'icehockey_nhl'] };
  const first = await runTrendsBuild(env, ctx, NOW, opts);
  // The NFL and NHL have no games in the slate and no events list reachable, so the NBA builds.
  assert.equal(first.skipped, false);
  assert.equal(first.sportKey, 'basketball_nba');
  assert.equal(first.rows, 3);
  assert.equal(first.pending, 0);
  const again = await runTrendsBuild(env, ctx, NOW + 10 * 60e3, opts);
  assert.equal(again.skipped, true);
  const nbaTtl = TREND_SPORTS.basketball_nba.ttlMinutes;
  const laterGame = { ...nbaGame, commence_time: new Date(NOW + (nbaTtl + 120) * 60e3).toISOString() };
  const later = await runTrendsBuild(env, ctx, NOW + (nbaTtl + 1) * 60e3, { ...opts, fetchFullSlate: async () => [laterGame] });
  assert.equal(later.skipped, false);
  assert.equal(later.sportKey, 'basketball_nba');
  // Two leagues with work: each tick takes the one checked longest ago, so they alternate.
  const t0 = NOW + 2 * (nbaTtl + 1) * 60e3;
  const tomorrow = new Date(t0 + 12 * 3.6e6).toISOString();
  const two = { ...opts, fetchFullSlate: async () => [{ ...nbaGame, id: 'n2', commence_time: tomorrow }, { ...nbaGame, id: 'h1', sport_key: 'icehockey_nhl', commence_time: tomorrow }], deps: { basketball_nba: deps, icehockey_nhl: deps } };
  const a = await runTrendsBuild(env, ctx, t0, two);
  const b = await runTrendsBuild(env, ctx, t0 + 15 * 60e3, two);
  assert.deepEqual([a.sportKey, b.sportKey].sort(), ['basketball_nba', 'icehockey_nhl']);
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
  assert.equal((await getTrends(env, 'basketball_nba')).lastError, null);
});

test('a build keeps a diagnostic trace, and a game whose build came up empty retries after 30 minutes instead of the full TTL', async () => {
  const { env } = makeKvStore();
  const noPlayers = { ...deps, resolve: async () => null, roster: async () => ({ athletes: [{ items: [{ displayName: 'Someone Else' }] }] }) };
  const payload = await buildLeagueChunk('basketball_nba', [nbaGame], env, ctx, NOW, { deps: noPlayers });
  assert.equal(payload.rows.length, 0);
  assert.equal(payload.games, 1);
  assert.ok(payload.diag.some((l) => /Jalen Brunson: no roster match/.test(l) && /sample \[Someone Else\]/.test(l)), payload.diag.join('\n'));
  assert.ok(payload.diag.some((l) => /2 lines, 1 players/.test(l)));
  assert.equal(payload.diag.at(-1), 'rows built: 0');
  const opts = { fetchFullSlate: async () => [nbaGame], deps: { basketball_nba: noPlayers }, enabled: ['basketball_nba'] };
  assert.equal((await runTrendsBuild(env, ctx, NOW + 10 * 60e3, opts)).skipped, true, 'ten minutes on, still fresh');
  const retried = await runTrendsBuild(env, ctx, NOW + 31 * 60e3, opts);
  assert.equal(retried.skipped, false, 'an empty build is retried after half an hour');
  const full = await buildTrends('basketball_nba', [nbaGame], env, ctx, NOW, deps);
  assert.equal(full.diag.at(-1), 'rows built: 3');
});

test('an unreachable game log names the fetch failure, so a subrequest limit reads as one', async () => {
  const { env } = makeKvStore();
  const fetchDiag = { lastError: 'Too many subrequests for /apis/common/v3/sports/basketball/nba/athletes/3934672/gamelog' };
  const payload = await buildTrends('basketball_nba', [nbaGame], env, ctx, NOW, { ...deps, gamelog: async () => null, fetchDiag });
  assert.equal(payload.rows.length, 0);
  assert.ok(payload.diag.some((l) => /game log unreachable \(Too many subrequests/.test(l)), payload.diag.join('\n'));
});

test('the build keeps its hands off the odds credits the boards need: a spent quota or a refused call holds it', async () => {
  const { trendsCreditHold, TRENDS_CREDIT_FLOOR } = await import('../worker/src/trends.js');
  const { env } = makeKvStore();
  assert.equal(await trendsCreditHold(env, NOW), null, 'nothing recorded yet: build');
  await env.POTD_KV.put('odds:diag', JSON.stringify({ at: NOW - 60e3, ok: false, status: 401, detail: 'OUT_OF_USAGE_CREDITS' }));
  assert.match(await trendsCreditHold(env, NOW), /refused its last call \(HTTP 401\)/);
  assert.equal(await trendsCreditHold(env, NOW + 15 * 60e3), null, 'a tick on, try again');
  await env.POTD_KV.put('odds:diag', JSON.stringify({ at: NOW, ok: true, status: 200, remaining: String(TRENDS_CREDIT_FLOOR - 1) }));
  assert.match(await trendsCreditHold(env, NOW), /odds credits left, under the/);
  await env.POTD_KV.put('odds:diag', JSON.stringify({ at: NOW, ok: true, status: 200, remaining: '48000' }));
  assert.equal(await trendsCreditHold(env, NOW), null);
  const opts = { fetchFullSlate: async () => [nbaGame], deps: { basketball_nba: deps }, enabled: ['basketball_nba'] };
  await env.POTD_KV.put('odds:diag', JSON.stringify({ at: NOW, ok: true, status: 200, remaining: '10' }));
  assert.equal((await runTrendsBuild(env, ctx, NOW, opts)).skipped, true);
  assert.equal(TREND_SPORTS.basketball_nba.ttlMinutes, 480);
});
