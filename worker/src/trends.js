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
import { ODDS_DIAG_KEY } from './odds.js';
import { etParts, etDatePlusDays } from './potd.js';
import { probeEspn } from './espn-search.js';
import { extractTrendLines, trendRowsFor, sortTrends } from '../../docs/trends.js';
import { normalizeName as normalizeNflName } from '../../docs/nfl-props.js';
import { normalizeName as normalizeNbaName } from '../../docs/wnba-props.js';
import { normalizeName as normalizeNhlName } from '../../docs/nhl-props.js';
import {
  NFL_SPORT_KEY, NFL_TREND_MARKETS, fetchNflAltProps, resolveNflAthleteId, fetchNflGamelog, gamelogStatIndex, nflHeadshotUrl, fetchNflRoster,
  fetchDiag as nflFetchDiag,
} from './football-props.js';
import {
  NBA_TREND_MARKETS, fetchNbaTrendProps, resolveAthleteId, fetchBasketballGamelog, basketballStatIndex, basketballStatRows, basketballHeadshotUrl,
  fetchDiag as nbaFetchDiag,
} from './basketball-props.js';
import {
  NHL_SPORT_KEY, NHL_PROP_MARKETS, NHL_ALT_MARKETS, fetchNhlProps, resolveNhlAthleteId, fetchNhlGamelog, nhlStatIndex, nhlHeadshotUrl,
  fetchDiag as nhlFetchDiag,
} from './hockey-props.js';
import { seasonYearOf } from '../../docs/prop-legs.js';
import { listLeagueGames } from './prop-legs.js';

/** How long a game's rows are served before the tick rebuilds them (a league may set its own). */
export const TRENDS_TTL_MINUTES = 180;
/**
 * A game stays on the tab through play and leaves this long after tip-off
 * (2026-10-27 direction: props before and during games, gone once the
 * game is over): the longest NBA or NFL game is done inside four hours.
 * No scores call is spent to know it.
 */
export const GAME_HOURS = 4;
/** The two ET dates a game may fall on to be shown: today and tomorrow. */
export function trendDayKeys(now) {
  return [etParts(now).date, etDatePlusDays(now, 1)];
}
/**
 * How many games one tick builds. A game costs one odds call plus a
 * roster and two game logs per player, so six games is a few hundred
 * subrequests — well inside the Workers limit — and a 25-game night
 * fills in over a handful of ticks rather than failing as one.
 */
export const MAX_GAMES_PER_TICK = 6;
/**
 * The leagues Trends builds and shows: NBA and NFL (2026-10-27 direction:
 * "the trends to cover NFL and NBA only"). The NHL reader stays wired and
 * tested and joins this list when the direction says so. NBA first: it is
 * the league the tab opens on when both have rows.
 */
export const TREND_ENABLED_SPORTS = ['basketball_nba', NFL_SPORT_KEY];
export const MAX_PLAYERS_PER_GAME = 40;
/** Rows with fewer logged games than this have no rate worth sorting on. */
const MIN_GAMES = 3;
/** A game whose build found no rows is tried again this soon, rather than after the league's full TTL. */
export const RETRY_EMPTY_MINUTES = 30;
/** How many diagnostic lines a build keeps for /trends to show. */
const MAX_DIAG = 60;
const MAX_ROWS = 2000;
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
    // Today's and tomorrow's games (trendGamesFor), rebuilt twice a day:
    // a Sunday slate at 8 markets a game is about 130 credits a build.
    ttlMinutes: 720,
    normalizeName: normalizeNflName,
    fetchOdds: (eventId, env, ctx) => fetchNflAltProps(eventId, env, ctx, Object.keys(NFL_TREND_MARKETS).join(',')),
    resolve: (name, abbrs, ctx) => resolveNflAthleteId(name, abbrs, ctx),
    gamelog: (athleteId, ctx) => fetchNflGamelog(athleteId, ctx),
    // Last season too, so L20 and the prior-season period can reach back
    // past September the way every prop tool's do. A football season year
    // is the year it kicks off in, so "last season" is simply year - 1.
    priorGamelog: (athleteId, ctx, now) => fetchNflGamelog(athleteId, ctx, new Date(now).getUTCFullYear() - 1),
    headshot: nflHeadshotUrl,
    roster: (abbr, ctx) => fetchNflRoster(abbr, ctx),
    fetchDiag: nflFetchDiag,
    statIndex: gamelogStatIndex,
  },
  [NBA_KEY]: {
    title: 'NBA',
    // Today's and tomorrow's games (trendGamesFor), rebuilt three times a
    // day: 23 markets a game is 23 credits a game per build, and the
    // month's credits ran out on 2026-10-25 building every three hours.
    ttlMinutes: 480,
    markets: NBA_TREND_MARKETS,
    normalizeName: normalizeNbaName,
    fetchOdds: (eventId, env, ctx) => fetchNbaTrendProps(eventId, env, ctx),
    // Threes, field goals and the combined stats are not one column of the
    // log: basketballStatRows reads the made count of a "made-attempted"
    // column and sums a combo's parts game by game.
    statRows: (log, statKey) => basketballStatRows(log, statKey, { allSeasons: true }),
    resolve: (name, abbrs, ctx) => resolveAthleteId(NBA_KEY, name, abbrs, ctx),
    gamelog: (athleteId, ctx) => fetchBasketballGamelog(NBA_KEY, athleteId, ctx),
    // ESPN keys a basketball season by the year it ENDS (2025-26 is
    // season=2026), and names it "2026-27": the first year in the current
    // log's name is exactly the prior season's key.
    priorGamelog: (athleteId, ctx, now, log) => { const y = seasonYearOf(log?.seasonTypes?.[0]?.displayName); return y ? fetchBasketballGamelog(NBA_KEY, athleteId, ctx, y) : null; },
    headshot: (athleteId) => basketballHeadshotUrl(NBA_KEY, athleteId),
    statIndex: basketballStatIndex,
    fetchDiag: nbaFetchDiag,
  },
  [NHL_SPORT_KEY]: {
    title: 'NHL',
    markets: { ...NHL_PROP_MARKETS, ...NHL_ALT_MARKETS },
    normalizeName: normalizeNhlName,
    fetchOdds: (eventId, env, ctx) => fetchNhlProps(eventId, env, ctx),
    resolve: (name, abbrs, ctx) => resolveNhlAthleteId(name, abbrs, ctx),
    gamelog: (athleteId, ctx) => fetchNhlGamelog(athleteId, ctx),
    // Same end-year convention as basketball.
    priorGamelog: (athleteId, ctx, now, log) => { const y = seasonYearOf(log?.seasonTypes?.[0]?.displayName); return y ? fetchNhlGamelog(athleteId, ctx, y) : null; },
    headshot: nhlHeadshotUrl,
    statIndex: nhlStatIndex,
    fetchDiag: nhlFetchDiag,
  },
};
export const TREND_SPORT_KEYS = Object.keys(TREND_SPORTS);

const trendsKey = (sportKey) => `trends:${sportKey}`;

/**
 * Stored rows for a league: { sportKey, title, builtAt, games, pending,
 * rows, stamps, diag } — `stamps` is when each game's rows were built,
 * `pending` how many games in the lookahead still wait for a tick. Empty
 * when never built.
 */
export async function getTrends(env, sportKey) {
  const spec = TREND_SPORTS[sportKey];
  if (!spec) return null;
  const raw = await env.POTD_KV.get(trendsKey(sportKey));
  if (raw) return JSON.parse(raw);
  return { sportKey, title: spec.title, builtAt: null, games: 0, pending: 0, rows: [], stamps: {} };
}

/** The games a league shows: today's and tomorrow's (ET), not yet over, soonest first, from the slate or the events list. */
export async function trendGamesFor(sportKey, events, env, ctx, now) {
  const days = new Set(trendDayKeys(now));
  const inWindow = (g) => {
    const ms = Date.parse(g?.commence_time ?? '');
    return Number.isFinite(ms) && ms + GAME_HOURS * 3.6e6 > now && days.has(etParts(ms).date);
  };
  let games = (events ?? []).filter((g) => g?.sport_key === sportKey && inWindow(g));
  if (!games.length) games = (await listLeagueGames(sportKey, env, ctx)).filter(inWindow);
  return games.sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
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
  // What the build saw at each stage, for /trends to show: a build that
  // ends with no rows needs to say where the rows went, and the worker's
  // logs are not something the tab (or its owner) can read.
  const diag = [];
  const note = (line) => { if (diag.length < MAX_DIAG) diag.push(line); };
  const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 12).join(',') : String(o));
  let unresolvedLogged = 0;
  let shortLogged = 0;
  // Which ESPN endpoints this Worker can reach, once per build: the
  // 2026-10-27 trace showed the roster path refused with a 403 while a
  // runner fetched it fine, and the next block will look the same.
  note(await (spec.probe ? spec.probe(ctx) : probeEspn(ctx)));
  for (const game of games) {
    const odds = await spec.fetchOdds(game.id, env, ctx);
    if (!odds) { note(`${game.away_team} @ ${game.home_team}: no odds payload (${spec.fetchDiag?.lastError ?? 'no error recorded'})`); continue; }
    scanned++;
    if (!Array.isArray(odds.bookmakers) || !odds.bookmakers.length) note(`${game.away_team} @ ${game.home_team}: payload has no bookmakers (keys: ${keysOf(odds)})`);
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
    const marketKeys = [...new Set((odds.bookmakers ?? []).flatMap((b) => (b.markets ?? []).map((m) => m.key)))];
    note(`${game.away_team} @ ${game.home_team}: ${lines.length} lines, ${byPlayer.size} players, books [${(odds.bookmakers ?? []).map((b) => b.key).join(',')}], markets [${marketKeys.join(',')}], abbrs ${abbrs.away ?? '?'}/${abbrs.home ?? '?'}`);
    for (const [, playerLines] of players) {
      const name = playerLines[0].playerName;
      let team = null;
      let athleteId = await spec.resolve(name, [abbrs.home], ctx);
      if (athleteId) team = abbrs.home;
      else { athleteId = await spec.resolve(name, [abbrs.away], ctx); if (athleteId) team = abbrs.away; }
      team = team ? String(team).toUpperCase() : null;
      if (!athleteId) {
        if (unresolvedLogged++ < 3) {
          const roster = spec.roster ? await spec.roster(abbrs.home ?? abbrs.away, ctx).catch(() => null) : undefined;
          const groups = Array.isArray(roster?.athletes) ? roster.athletes : [];
          const sample = groups.flatMap((g) => (Array.isArray(g?.items) ? g.items : [])).slice(0, 3).map((a) => a?.displayName).join(' | ');
          note(`${name}: no roster match (${abbrs.away ?? '?'}/${abbrs.home ?? '?'}); roster ${roster === undefined ? 'not checked' : roster === null ? `unreachable (${spec.fetchDiag?.lastError ?? 'no error recorded'})` : `keys ${keysOf(roster)}, ${groups.length} groups, sample [${sample}]`}`);
        }
        continue;
      }
      const gamelog = await spec.gamelog(athleteId, ctx);
      // The module's last fetch failure is the reason — "Too many
      // subrequests" and an HTTP status look identical from here otherwise.
      if (!gamelog) { note(`${name} (${athleteId}): game log unreachable (${spec.fetchDiag?.lastError ?? 'no error recorded'})`); continue; }
      const prior = spec.priorGamelog ? await Promise.resolve(spec.priorGamelog(athleteId, ctx, now, gamelog)).catch(() => null) : null;
      const merged = prior?.seasonTypes?.length
        ? { ...gamelog, seasonTypes: [...(gamelog.seasonTypes ?? []), ...prior.seasonTypes], events: { ...(prior.events ?? {}), ...(gamelog.events ?? {}) } }
        : gamelog;
      const opponent = team && abbrs.home && abbrs.away
        ? String(team === String(abbrs.home).toUpperCase() ? abbrs.away : abbrs.home).toUpperCase()
        : null;
      const headshot = spec.headshot ? spec.headshot(athleteId) : null;
      const rowsByStat = new Map();
      for (const line of playerLines) {
        if (!rowsByStat.has(line.statKey)) {
          rowsByStat.set(line.statKey, spec.statRows
            ? spec.statRows(merged, line.statKey)
            : seasonColumnRows(merged, spec.statIndex(merged, line.statKey), { allSeasons: true }));
        }
        const statRows = rowsByStat.get(line.statKey);
        if (statRows.length < MIN_GAMES) {
          if (shortLogged++ < 3) note(`${name}: ${line.statKey} has ${statRows.length} logged games; column ${spec.statIndex(merged, line.statKey)}; log keys ${keysOf(merged)}; names [${(merged.names ?? []).slice(0, 10).join(',')}]; seasons [${(merged.seasonTypes ?? []).map((s) => s?.displayName).join(' / ')}]`);
          continue;
        }
        rows.push(...trendRowsFor({ ...line, team, athleteId, headshot }, statRows, { opponent }));
      }
    }
  }
  note(`rows built: ${rows.length}`);
  return { sportKey, title: spec.title, builtAt: now, games: scanned, rows: sortTrends(rows, { window: 'l20' }), diag };
}

/**
 * Build the next chunk of one league: the games in its lookahead whose
 * rows are missing or older than the TTL, soonest first, up to
 * MAX_GAMES_PER_TICK, merged into what's stored. Games that have started
 * or left the lookahead drop out. Returns the stored payload, or null
 * when nothing was due.
 */
export async function buildLeagueChunk(sportKey, events, env, ctx, now = Date.now(), { deps, limit = MAX_GAMES_PER_TICK } = {}) {
  const stored = await getTrends(env, sportKey);
  const ttl = (TREND_SPORTS[sportKey]?.ttlMinutes ?? TRENDS_TTL_MINUTES) * 60e3;
  const games = await trendGamesFor(sportKey, events, env, ctx, now);
  const live = new Set(games.map((g) => g.id));
  const stamps = Object.fromEntries(Object.entries(stored.stamps ?? {}).filter(([id]) => live.has(id)));
  // A game that has tipped off keeps the rows it has (the books pull
  // pregame props at tip, so there is nothing new to fetch) and leaves
  // the tab once it is over; only unstarted games are rebuilt.
  const due = games.filter((g) => Date.parse(g.commence_time) > now && (!Number.isFinite(stamps[g.id]) || now - stamps[g.id] >= ttl));
  const keepRows = (stored.rows ?? []).filter((r) => live.has(r.eventId));
  if (!due.length) {
    if (!games.length || keepRows.length !== (stored.rows ?? []).length || stored.pending) {
      const payload = { ...stored, builtAt: stored.builtAt ?? now, checkedAt: now, games: Object.keys(stamps).length, pending: 0, rows: keepRows, stamps, lastError: null };
      await env.POTD_KV.put(trendsKey(sportKey), JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
    }
    return null;
  }
  const chunk = due.slice(0, limit);
  const built = await buildTrends(sportKey, chunk, env, ctx, now, deps);
  const chunkIds = new Set(chunk.map((g) => g.id));
  for (const g of chunk) {
    // A game that yielded nothing is retried sooner than the TTL: the
    // diagnostics say why, and half an hour is long enough to read them.
    const gotRows = built.rows.some((r) => r.eventId === g.id);
    stamps[g.id] = gotRows ? now : now - ttl + RETRY_EMPTY_MINUTES * 60e3;
  }
  const rows = sortTrends([...keepRows.filter((r) => !chunkIds.has(r.eventId)), ...built.rows], { window: 'l20' }).slice(0, MAX_ROWS);
  const payload = {
    sportKey, title: built.title, builtAt: now, checkedAt: now,
    games: Object.keys(stamps).length, pending: due.length - chunk.length,
    rows, stamps, diag: built.diag, lastError: null,
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
/**
 * Odds API credits the Trends build leaves for the boards: a build is
 * skipped while the feed's last call reported fewer remaining, or refused
 * the call outright within the last hour (a spent quota, a bad key). The
 * boards post from one slate fetch a tick; Trends is the big spender.
 */
export const TRENDS_CREDIT_FLOOR = 300;

/** Why the build should not spend right now, or null. */
export async function trendsCreditHold(env, now = Date.now()) {
  const raw = await env.POTD_KV.get(ODDS_DIAG_KEY).catch(() => null);
  if (!raw) return null;
  const diag = JSON.parse(raw);
  // One tick, not an hour: a refused call costs no credits, and a key
  // changed in the dashboard should be tried on the next tick, not after
  // the last refusal ages out.
  if (diag.ok === false && now - (diag.at ?? 0) < 14 * 60e3) return `the odds feed refused its last call (HTTP ${diag.status})`;
  const remaining = Number(diag.remaining);
  if (diag.ok && Number.isFinite(remaining) && remaining < TRENDS_CREDIT_FLOOR) return `${remaining} odds credits left, under the ${TRENDS_CREDIT_FLOOR} the boards keep`;
  return null;
}

export async function runTrendsBuild(env, ctx, now = Date.now(), { fetchFullSlate = async () => [], deps, enabled = TREND_ENABLED_SPORTS } = {}) {
  const hold = await trendsCreditHold(env, now);
  if (hold) return { skipped: true, reason: hold };
  // The league checked longest ago goes first, so three leagues share the
  // ticks evenly; one chunk per tick keeps every tick inside its budget.
  const stored = await Promise.all(enabled.map((k) => getTrends(env, k)));
  const order = stored.sort((a, b) => (a.checkedAt ?? a.builtAt ?? 0) - (b.checkedAt ?? b.builtAt ?? 0)).map((s) => s.sportKey);
  const events = await fetchFullSlate();
  for (const sportKey of order) {
    // A build that throws is written down where /trends can show it — a
    // silent failure looks exactly like a league with no games, and the
    // worker's logs are not something the tab can read.
    try {
      const payload = await buildLeagueChunk(sportKey, events, env, ctx, now, { deps: deps?.[sportKey] });
      if (payload) return { skipped: false, sportKey, games: payload.games, pending: payload.pending, rows: payload.rows.length };
    } catch (e) {
      const s = await getTrends(env, sportKey);
      const lastError = `${new Date(now).toISOString()}: ${String(e?.stack ?? e).slice(0, 400)}`;
      await env.POTD_KV.put(trendsKey(sportKey), JSON.stringify({ ...s, lastError, checkedAt: now }), { expirationTtl: KV_TTL_SECONDS });
      console.error(`Trends build failed for ${sportKey}:`, e);
      return { skipped: true, sportKey, reason: 'build failed', error: lastError };
    }
  }
  return { skipped: true, reason: 'every game in every lookahead is fresh' };
}
