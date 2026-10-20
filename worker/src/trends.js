/**
 * Trends — the worker side of docs/trends.js. Once every few hours per
 * league, every player-prop line on the day's games is pulled from the
 * odds feed, each player's current-season game log from ESPN, and the
 * rows (hit rate per window, per-game bars, best price) are stored in KV
 * for /trends to serve instantly. The browser does the filtering and
 * sorting; the worker only builds.
 *
 * Cost: one per-event odds call per game (the alternate markets, which
 * carry every line) — about 3 credits a game, so a 10-game NBA night is
 * ~30 credits a build and ~8 builds a day at TRENDS_TTL_MINUTES. Every
 * ESPN call is free and cached. The build runs inside the scheduled tick,
 * one league per tick, and is bounded by MAX_GAMES and MAX_PLAYERS_PER_GAME
 * so it never nears the Workers subrequest limit.
 */

import { bookIdFor } from '../../docs/engine.js';
import { espnAbbr } from '../../docs/team-logos.js';
import { seasonColumnRows } from '../../docs/prop-legs.js';
import { extractTrendLines, trendRowsFor, sortTrends } from '../../docs/trends.js';
import { normalizeName as normalizeNflName } from '../../docs/nfl-props.js';
import { normalizeName as normalizeNbaName } from '../../docs/wnba-props.js';
import { normalizeName as normalizeNhlName } from '../../docs/nhl-props.js';
import {
  NFL_SPORT_KEY, NFL_TREND_MARKETS, fetchNflAltProps, resolveNflAthleteId, fetchNflGamelog, gamelogStatIndex, nflHeadshotUrl,
} from './football-props.js';
import {
  BASKETBALL_ALT_MARKETS, fetchAltProps, resolveAthleteId, fetchBasketballGamelog, basketballStatIndex,
} from './basketball-props.js';
import {
  NHL_SPORT_KEY, NHL_PROP_MARKETS, NHL_ALT_MARKETS, fetchNhlProps, resolveNhlAthleteId, fetchNhlGamelog, nhlStatIndex,
} from './hockey-props.js';
import { listLeagueGames } from './prop-legs.js';

/** How long a league's rows are served before the tick rebuilds them (a league may set its own). */
export const TRENDS_TTL_MINUTES = 180;
/** Games are scanned this far ahead — tonight's slate and tomorrow's early games (a league may set its own). */
export const LOOKAHEAD_HOURS = 30;
export const MAX_GAMES = 16;
/**
 * The leagues Trends builds and shows today. NFL first (2026-10-19
 * direction): the NBA and NHL readers are wired and tested and join this
 * list when the direction says so — one line, no deploy of anything else.
 */
export const TREND_ENABLED_SPORTS = [NFL_SPORT_KEY];
export const MAX_PLAYERS_PER_GAME = 24;
/** Rows with fewer logged games than this have no rate worth sorting on. */
const MIN_GAMES = 3;
const MAX_ROWS = 500;
const KV_TTL_SECONDS = 86400 * 2;

const NBA_KEY = 'basketball_nba';

/** Each league's own feed, roster and game-log readers. */
export const TREND_SPORTS = {
  [NFL_SPORT_KEY]: {
    title: 'NFL',
    markets: NFL_TREND_MARKETS,
    // A football week is one slate: lines for Sunday post by Tuesday, so
    // the whole week is scanned and refreshed every six hours — lines move
    // on injury news, and six hours keeps a Sunday row from quoting
    // Tuesday's number.
    lookaheadHours: 7 * 24,
    ttlMinutes: 360,
    normalizeName: normalizeNflName,
    fetchOdds: (eventId, env, ctx) => fetchNflAltProps(eventId, env, ctx, Object.keys(NFL_TREND_MARKETS).join(',')),
    resolve: (name, abbrs, ctx) => resolveNflAthleteId(name, abbrs, ctx),
    gamelog: (athleteId, ctx) => fetchNflGamelog(athleteId, ctx),
    // Last season too, so L20 and the prior-season period can reach back
    // past September the way every prop tool's do. A football season year
    // is the year it kicks off in, so "last season" is simply year - 1.
    priorGamelog: (athleteId, ctx, now) => fetchNflGamelog(athleteId, ctx, new Date(now).getUTCFullYear() - 1),
    headshot: nflHeadshotUrl,
    statIndex: gamelogStatIndex,
  },
  [NBA_KEY]: {
    title: 'NBA',
    markets: BASKETBALL_ALT_MARKETS,
    normalizeName: normalizeNbaName,
    fetchOdds: (eventId, env, ctx) => fetchAltProps(NBA_KEY, eventId, env, ctx),
    resolve: (name, abbrs, ctx) => resolveAthleteId(NBA_KEY, name, abbrs, ctx),
    gamelog: (athleteId, ctx) => fetchBasketballGamelog(NBA_KEY, athleteId, ctx),
    statIndex: basketballStatIndex,
  },
  [NHL_SPORT_KEY]: {
    title: 'NHL',
    markets: { ...NHL_PROP_MARKETS, ...NHL_ALT_MARKETS },
    normalizeName: normalizeNhlName,
    fetchOdds: (eventId, env, ctx) => fetchNhlProps(eventId, env, ctx),
    resolve: (name, abbrs, ctx) => resolveNhlAthleteId(name, abbrs, ctx),
    gamelog: (athleteId, ctx) => fetchNhlGamelog(athleteId, ctx),
    statIndex: nhlStatIndex,
  },
};
export const TREND_SPORT_KEYS = Object.keys(TREND_SPORTS);

const trendsKey = (sportKey) => `trends:${sportKey}`;

/** Stored rows for a league: { sportKey, title, builtAt, games, rows } — empty when never built. */
export async function getTrends(env, sportKey) {
  const spec = TREND_SPORTS[sportKey];
  if (!spec) return null;
  const raw = await env.POTD_KV.get(trendsKey(sportKey));
  if (raw) return JSON.parse(raw);
  return { sportKey, title: spec.title, builtAt: null, games: 0, rows: [] };
}

/** The games a league's build scans: unstarted, inside the lookahead, soonest first, from the slate or the events list. */
export async function trendGamesFor(sportKey, events, env, ctx, now) {
  const lookahead = TREND_SPORTS[sportKey]?.lookaheadHours ?? LOOKAHEAD_HOURS;
  const inWindow = (g) => {
    const ms = Date.parse(g?.commence_time ?? '');
    return Number.isFinite(ms) && ms > now && ms - now <= lookahead * 3.6e6;
  };
  let games = (events ?? []).filter((g) => g?.sport_key === sportKey && inWindow(g));
  if (!games.length) games = (await listLeagueGames(sportKey, env, ctx)).filter(inWindow);
  return games.sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time)).slice(0, MAX_GAMES);
}

/**
 * Build one league's rows. `deps` lets the tests supply the odds and ESPN
 * readers; production uses the league's own. Returns the stored payload.
 */
export async function buildTrends(sportKey, games, env, ctx, now = Date.now(), deps = {}) {
  const spec = { ...TREND_SPORTS[sportKey], ...deps };
  const isRegistryBook = (key) => Boolean(bookIdFor(key));
  const rows = [];
  let scanned = 0;
  for (const game of games) {
    const odds = await spec.fetchOdds(game.id, env, ctx);
    if (!odds) continue;
    scanned++;
    const meta = {
      eventId: game.id, sportKey, sportTitle: spec.title, commenceMs: Date.parse(game.commence_time),
      home: game.home_team, away: game.away_team,
    };
    const lines = extractTrendLines(odds, meta, spec.markets, { isRegistryBook, normalizeName: spec.normalizeName });
    // One game log per player; the deepest-priced lines first so a capped
    // game keeps the players the books are surest about.
    const byPlayer = new Map();
    for (const line of lines) {
      const key = spec.normalizeName(line.playerName);
      if (!byPlayer.has(key)) byPlayer.set(key, []);
      byPlayer.get(key).push(line);
    }
    const players = [...byPlayer.entries()].slice(0, MAX_PLAYERS_PER_GAME);
    const abbrs = { home: espnAbbr(sportKey, game.home_team), away: espnAbbr(sportKey, game.away_team) };
    for (const [, playerLines] of players) {
      const name = playerLines[0].playerName;
      let team = null;
      let athleteId = await spec.resolve(name, [abbrs.home], ctx);
      if (athleteId) team = abbrs.home;
      else { athleteId = await spec.resolve(name, [abbrs.away], ctx); if (athleteId) team = abbrs.away; }
      team = team ? String(team).toUpperCase() : null;
      if (!athleteId) continue;
      const gamelog = await spec.gamelog(athleteId, ctx);
      if (!gamelog) continue;
      const prior = spec.priorGamelog ? await spec.priorGamelog(athleteId, ctx, now).catch(() => null) : null;
      const merged = prior?.seasonTypes?.length
        ? { ...gamelog, seasonTypes: [...(gamelog.seasonTypes ?? []), ...prior.seasonTypes], events: { ...(prior.events ?? {}), ...(gamelog.events ?? {}) } }
        : gamelog;
      const opponent = team && abbrs.home && abbrs.away
        ? String(team === String(abbrs.home).toUpperCase() ? abbrs.away : abbrs.home).toUpperCase()
        : null;
      const headshot = spec.headshot ? spec.headshot(athleteId) : null;
      const rowsByStat = new Map();
      for (const line of playerLines) {
        if (!rowsByStat.has(line.statKey)) rowsByStat.set(line.statKey, seasonColumnRows(merged, spec.statIndex(merged, line.statKey), { allSeasons: true }));
        const statRows = rowsByStat.get(line.statKey);
        if (statRows.length < MIN_GAMES) continue;
        rows.push(...trendRowsFor({ ...line, team, athleteId, headshot }, statRows, { opponent }));
      }
    }
  }
  const payload = {
    sportKey,
    title: spec.title,
    builtAt: now,
    games: scanned,
    rows: sortTrends(rows, { window: 'l10' }).slice(0, MAX_ROWS),
  };
  await env.POTD_KV.put(trendsKey(sportKey), JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
  return payload;
}

/**
 * The scheduled entry: rebuild the one league whose rows are the stalest
 * and older than the TTL, when it has games inside the lookahead. One
 * league per tick spreads the odds credits and the ESPN calls across the
 * hour instead of spending them all at once. `fetchFullSlate` supplies the
 * day's events (already fetched by the boards' own batch).
 */
export async function runTrendsBuild(env, ctx, now = Date.now(), { fetchFullSlate = async () => [], deps, enabled = TREND_ENABLED_SPORTS } = {}) {
  const stored = await Promise.all(enabled.map((k) => getTrends(env, k)));
  const ttl = (k) => (TREND_SPORTS[k]?.ttlMinutes ?? TRENDS_TTL_MINUTES) * 60e3;
  const due = stored
    .filter((s) => !s.builtAt || now - s.builtAt >= ttl(s.sportKey))
    .sort((a, b) => (a.builtAt ?? 0) - (b.builtAt ?? 0));
  if (!due.length) return { skipped: true, reason: 'every league is fresh' };
  const events = await fetchFullSlate();
  for (const s of due) {
    // A build that throws is written down where /trends can show it — a
    // silent failure looks exactly like a league with no games, and the
    // worker's logs are not something the tab can read.
    try {
      const games = await trendGamesFor(s.sportKey, events, env, ctx, now);
      if (!games.length) {
        // Nothing to scan: mark it checked so the next tick moves on to the
        // next league rather than asking the same empty question every 15 min.
        await env.POTD_KV.put(trendsKey(s.sportKey), JSON.stringify({ ...s, builtAt: now, games: 0, rows: s.rows ?? [], lastError: null, note: 'no game inside the lookahead' }), { expirationTtl: KV_TTL_SECONDS });
        continue;
      }
      const payload = await buildTrends(s.sportKey, games, env, ctx, now, deps?.[s.sportKey]);
      return { skipped: false, sportKey: s.sportKey, games: payload.games, rows: payload.rows.length };
    } catch (e) {
      const lastError = `${new Date(now).toISOString()}: ${String(e?.stack ?? e).slice(0, 400)}`;
      await env.POTD_KV.put(trendsKey(s.sportKey), JSON.stringify({ ...s, lastError, checkedAt: now }), { expirationTtl: KV_TTL_SECONDS });
      console.error(`Trends build failed for ${s.sportKey}:`, e);
      return { skipped: true, sportKey: s.sportKey, reason: 'build failed', error: lastError };
    }
  }
  return { skipped: true, reason: 'no league has a game inside the lookahead' };
}
