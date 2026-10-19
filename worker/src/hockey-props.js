/**
 * NHL player props as ticket legs (docs/tickets.js) — shots on goal,
 * points and assists, at the low lines a skater clears most nights: 2+
 * shots for a winger who averages four, 1+ point for a first-line centre.
 * Same shape as the football and basketball modules: the pure prop maths
 * live in docs/prop-legs.js; this file knows the hockey markets, ESPN's
 * paths and the boxscore's column keys.
 *
 * A trap this module inherits from worker/src/nhl-props.js: ESPN's hockey
 * boxscore has a column LABELLED "SOG" whose machine key is shootoutGoals.
 * The real shots-on-goal column is keyed `shotsTotal` (label "S"). Every
 * column here is read by key first, and shots never by label.
 *
 * Cost: one per-event odds call per game at the 2am draw, bounded by
 * MAX_GAMES_SCANNED; ESPN calls are free and cached.
 */

import { bookIdFor } from '../../docs/engine.js';
import { normalizeName } from '../../docs/nhl-props.js';
import { espnAbbr } from '../../docs/team-logos.js';
import {
  extractAltCandidates,
  propLegFrom as sharedPropLegFrom,
  clearsPropGates as sharedClearsPropGates,
  gradePropLeg,
  seasonColumnValues,
} from '../../docs/prop-legs.js';
import { UPSTREAM, REGIONS } from './odds.js';

export const NHL_SPORT_KEY = 'icehockey_nhl';

/** The markets scanned, the stat each settles on, and how a leg names it. */
export const NHL_PROP_MARKETS = {
  player_shots_on_goal: { stat: 'shots', label: 'SOG', marketLabel: 'Shots on Goal' },
  player_points: { stat: 'points', label: 'Pts', marketLabel: 'Points' },
  player_assists: { stat: 'assists', label: 'Ast', marketLabel: 'Assists' },
};
/**
 * The alternate-line markets, asked for first: they carry the deep lines
 * the boards want. A feed that rejects the alternate keys (an unknown
 * market fails the whole call) is asked again for the main lines alone,
 * which already run 1.5 / 2.5 / 3.5 across books.
 */
export const NHL_ALT_MARKETS = {
  player_shots_on_goal_alternate: NHL_PROP_MARKETS.player_shots_on_goal,
  player_points_alternate: NHL_PROP_MARKETS.player_points,
  player_assists_alternate: NHL_PROP_MARKETS.player_assists,
};
const ALL_MARKETS = { ...NHL_PROP_MARKETS, ...NHL_ALT_MARKETS };
const MARKET_PARAMS = [
  Object.keys(ALL_MARKETS).join(','),
  Object.keys(NHL_PROP_MARKETS).join(','),
];

/** Conviction gates from the game log — same bars as basketball: six games before a rate is read. */
export const PROP_GATES = { MIN_GAMES: 6, MIN_SEASON_RATE: 0.75, MIN_L5_RATE: 0.8, MIN_BOOKS: 2 };

export const MAX_GAMES_SCANNED = 8;
export const MAX_GAMELOG_LOOKUPS = 24;

const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/hockey/nhl';
const ESPN_GAMELOG = 'https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes';
const ROSTER_TTL = 3600 * 6;
const GAMELOG_TTL = 3600 * 3;
const SCHEDULE_TTL = 3600 * 6;
const SUMMARY_TTL = 900;
const ODDS_TTL = 3600;

/* ---------------------------------------------------------------- */
/* Pure                                                              */
/* ---------------------------------------------------------------- */

export function extractNhlPropCandidates(eventOdds, game, { now = Date.now() } = {}) {
  return extractAltCandidates(eventOdds, { sportKey: NHL_SPORT_KEY, sportTitle: 'NHL', ...game }, ALL_MARKETS, {
    now, minBooks: PROP_GATES.MIN_BOOKS, isRegistryBook: (key) => Boolean(bookIdFor(key)), normalizeName,
  });
}

export const clearsPropGates = (profile) => sharedClearsPropGates(profile, PROP_GATES);
export const propLegFrom = (candidate, values) => sharedPropLegFrom(candidate, values, PROP_GATES);
export const gradeNhlPropLeg = gradePropLeg;

/** Column keys per stat; shots is never read by label (see the header). */
const GAMELOG_NAMES = { shots: ['shotsTotal', 'shots'], points: ['points'], assists: ['assists'] };
const GAMELOG_LABEL = { points: 'PTS', assists: 'A' };

/**
 * The player's per-game values for one stat, most recent first, current
 * season only (docs/prop-legs.js). Points fall back to goals + assists
 * when the log carries no points column.
 */
export function parseNhlGamelogValues(gamelog, statKey) {
  const names = Array.isArray(gamelog?.names) ? gamelog.names : [];
  const labels = Array.isArray(gamelog?.labels) ? gamelog.labels : [];
  let idx = names.findIndex((n) => GAMELOG_NAMES[statKey]?.includes(n));
  if (idx < 0 && GAMELOG_LABEL[statKey]) idx = labels.indexOf(GAMELOG_LABEL[statKey]);
  if (idx >= 0) return seasonColumnValues(gamelog, idx);
  if (statKey === 'points') {
    const g = names.indexOf('goals');
    const a = names.indexOf('assists');
    if (g < 0 || a < 0) return [];
    const goals = seasonColumnValues(gamelog, g);
    const assists = seasonColumnValues(gamelog, a);
    return goals.length === assists.length ? goals.map((v, i) => v + assists[i]) : [];
  }
  return [];
}

/**
 * Per-skater final rows from an ESPN hockey summary: shots, goals, assists
 * and points, forwards and defencemen alike. A skater absent from both
 * blocks (a scratch) has no row, so the leg voids as a book would.
 */
export function nhlBoxscoreRows(summary) {
  const rows = [];
  for (const team of summary?.boxscore?.players ?? []) {
    for (const block of team.statistics ?? []) {
      const name = String(block?.name ?? '').toLowerCase();
      if (name !== 'forwards' && name !== 'defenses' && name !== 'defensemen' && name !== 'skaters') continue;
      const keys = Array.isArray(block.keys) ? block.keys : [];
      const idx = {
        shots: keys.indexOf('shotsTotal'),
        goals: keys.indexOf('goals'),
        assists: keys.indexOf('assists'),
        points: keys.indexOf('points'),
      };
      for (const athlete of block.athletes ?? []) {
        const displayName = athlete.athlete?.displayName;
        if (!displayName || !Array.isArray(athlete.stats) || !athlete.stats.length) continue;
        const row = { name: displayName };
        for (const [k, i] of Object.entries(idx)) {
          if (i < 0) continue;
          const value = Number(athlete.stats[i]);
          if (Number.isFinite(value)) row[k] = value;
        }
        if (!Number.isFinite(row.points) && Number.isFinite(row.goals) && Number.isFinite(row.assists)) row.points = row.goals + row.assists;
        rows.push(row);
      }
    }
  }
  return rows;
}

/* ---------------------------------------------------------------- */
/* Impure: fetching                                                  */
/* ---------------------------------------------------------------- */

async function cachedJson(url, ttl, ctx) {
  const cache = globalThis.caches?.default ?? null;
  const cacheKey = cache ? new Request(`https://pixel-pick.cache/hockey-props/${encodeURIComponent(url)}`) : null;
  try {
    const hit = cache ? await cache.match(cacheKey) : null;
    if (hit) return hit.json();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.text();
    if (cache) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      })));
    }
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function fetchNhlProps(oddsEventId, env, ctx) {
  for (const markets of MARKET_PARAMS) {
    const url = new URL(`${UPSTREAM}/sports/${NHL_SPORT_KEY}/events/${oddsEventId}/odds`);
    url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
    url.searchParams.set('regions', REGIONS);
    url.searchParams.set('markets', markets);
    url.searchParams.set('oddsFormat', 'american');
    url.searchParams.set('dateFormat', 'iso');
    const odds = await cachedJson(url.toString(), ODDS_TTL, ctx);
    if (odds) return odds;
  }
  return null;
}

async function resolveNhlAthleteId(playerName, teamAbbrs, ctx) {
  const target = normalizeName(playerName);
  for (const abbr of teamAbbrs) {
    if (!abbr) continue;
    const roster = await cachedJson(`${ESPN_SITE}/teams/${abbr.toLowerCase()}/roster`, ROSTER_TTL, ctx);
    for (const group of roster?.athletes ?? []) {
      const items = Array.isArray(group?.items) ? group.items : Array.isArray(group) ? group : [group];
      for (const athlete of items) {
        if (athlete?.displayName && normalizeName(athlete.displayName) === target) return athlete.id;
      }
    }
  }
  return null;
}

export async function resolveNhlEspnEventId(home, away, ctx) {
  const homeAbbr = espnAbbr(NHL_SPORT_KEY, home);
  const awayAbbr = espnAbbr(NHL_SPORT_KEY, away);
  if (!homeAbbr || !awayAbbr) return null;
  const schedule = await cachedJson(`${ESPN_SITE}/teams/${homeAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const match = (schedule?.events ?? []).find((e) => {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.completed) return false;
    return comp?.competitors?.some((c) => c.team?.abbreviation?.toLowerCase() === awayAbbr.toLowerCase());
  });
  return match?.id ?? null;
}

/** The final per-skater rows for a game, or null while it isn't final. */
export async function fetchFinalNhlStats(espnEventId, ctx) {
  if (!espnEventId) return null;
  const summary = await cachedJson(`${ESPN_SITE}/summary?event=${espnEventId}`, SUMMARY_TTL, ctx);
  if (!summary?.header?.competitions?.[0]?.status?.type?.completed) return null;
  return nhlBoxscoreRows(summary);
}

/** Gated prop legs for a set of NHL games (Odds API event objects) — same shape as the other collectors. */
export async function collectNhlPropLegs(games, env, ctx, now = Date.now(), { trace = [] } = {}) {
  const scanned = (games ?? [])
    .filter((g) => g?.sport_key === NHL_SPORT_KEY && new Date(g.commence_time).getTime() > now)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, MAX_GAMES_SCANNED);
  if (!scanned.length) return [];

  let candidates = [];
  for (const game of scanned) {
    const odds = await fetchNhlProps(game.id, env, ctx);
    const extracted = extractNhlPropCandidates(odds, {
      eventId: game.id, commenceMs: new Date(game.commence_time).getTime(), home: game.home_team, away: game.away_team,
    }, { now });
    trace.push(`${game.away_team} @ ${game.home_team}: ${extracted.length} in-band hockey lines`);
    candidates = candidates.concat(extracted);
  }

  candidates.sort((x, y) => x.decimal - y.decimal);
  const seen = new Set();
  const shortlist = [];
  for (const c of candidates) {
    const key = `${normalizeName(c.playerName)}|${c.statKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shortlist.push(c);
    if (shortlist.length >= MAX_GAMELOG_LOOKUPS) break;
  }

  const legs = [];
  const espnEventIds = new Map();
  for (const c of shortlist) {
    const abbrs = [espnAbbr(NHL_SPORT_KEY, c.home), espnAbbr(NHL_SPORT_KEY, c.away)];
    const athleteId = await resolveNhlAthleteId(c.playerName, abbrs, ctx);
    if (!athleteId) { trace.push(`${c.playerName}: no roster match`); continue; }
    const gamelog = await cachedJson(`${ESPN_GAMELOG}/${athleteId}/gamelog`, GAMELOG_TTL, ctx);
    const values = parseNhlGamelogValues(gamelog, c.statKey);
    if (!values.length) { trace.push(`${c.playerName}: no ${c.statKey} in the game log`); continue; }
    const leg = propLegFrom(c, values);
    if (!leg) { trace.push(`${c.selection}: gates or edge missed`); continue; }
    if (!espnEventIds.has(c.eventId)) espnEventIds.set(c.eventId, await resolveNhlEspnEventId(c.home, c.away, ctx));
    legs.push({ ...leg, espnEventId: espnEventIds.get(c.eventId) ?? null });
  }
  trace.push(`NHL prop legs qualified: ${legs.length}`);
  return legs;
}
