/**
 * WNBA and NBA alternate-line player props as ticket legs (docs/tickets.js)
 * — the shape of the winning slips this design was handed: "Allisha Gray
 * 2+ assists" at -320, "Tiffany Hayes 5+ points" at -500, "Sabrina Ionescu
 * 12+ points" — deep comfort-zone lines checked against the player's real
 * game log, exactly the way the Prop Play of the Day already argues its
 * legs (worker/src/prop-play.js) and the NFL module does for football
 * (worker/src/football-props.js). The pure parts are shared in
 * docs/prop-legs.js; this file knows the basketball markets, ESPN paths
 * and boxscore shape.
 *
 * Cost: one per-event odds call per game (3 markets x 1 region) at the 2am
 * draw, bounded by MAX_GAMES_SCANNED per league; ESPN calls are free.
 */

import { bookIdFor } from '../../docs/engine.js';
import { normalizeName } from '../../docs/wnba-props.js';
import { espnAbbr } from '../../docs/team-logos.js';
import {
  extractAltCandidates,
  propLegFrom as sharedPropLegFrom,
  clearsPropGates as sharedClearsPropGates,
  gradePropLeg,
} from '../../docs/prop-legs.js';
import { UPSTREAM, REGIONS } from './odds.js';

/** The two leagues, with ESPN's path for each. */
export const BASKETBALL_SPORTS = {
  basketball_wnba: { espn: 'wnba', title: 'WNBA' },
  basketball_nba: { espn: 'nba', title: 'NBA' },
};
export const isBasketballSport = (sportKey) => Boolean(BASKETBALL_SPORTS[sportKey]);

/** The alternate markets scanned, the stat each settles on, and how a leg names it. */
export const BASKETBALL_ALT_MARKETS = {
  player_points_alternate: { stat: 'points', label: 'Pts', marketLabel: 'Points (alt)' },
  player_rebounds_alternate: { stat: 'rebounds', label: 'Reb', marketLabel: 'Rebounds (alt)' },
  player_assists_alternate: { stat: 'assists', label: 'Ast', marketLabel: 'Assists (alt)' },
};
export const BASKETBALL_ALT_MARKETS_PARAM = Object.keys(BASKETBALL_ALT_MARKETS).join(',');

/**
 * Conviction gates from the game log. A basketball season is long, so the
 * sample floor is higher than football's four: six games before a rate is
 * read at all, then the same 75% season / 80% last-five bars.
 */
export const PROP_GATES = { MIN_GAMES: 6, MIN_SEASON_RATE: 0.75, MIN_L5_RATE: 0.8, MIN_BOOKS: 2 };

export const MAX_GAMES_SCANNED = 6;
export const MAX_GAMELOG_LOOKUPS = 20;

const ESPN_BASE = 'https://site.web.api.espn.com/apis';
const ROSTER_TTL = 3600 * 6;
const GAMELOG_TTL = 3600 * 3;
const SCHEDULE_TTL = 3600 * 6;
const SUMMARY_TTL = 900;
const ODDS_TTL = 3600;

const siteUrl = (sportKey) => `${ESPN_BASE}/site/v2/sports/basketball/${BASKETBALL_SPORTS[sportKey].espn}`;
const gamelogUrl = (sportKey, athleteId) => `${ESPN_BASE}/common/v3/sports/basketball/${BASKETBALL_SPORTS[sportKey].espn}/athletes/${athleteId}/gamelog`;

/* ---------------------------------------------------------------- */
/* Pure                                                              */
/* ---------------------------------------------------------------- */

export function extractBasketballAltCandidates(eventOdds, game, { now = Date.now() } = {}) {
  const title = BASKETBALL_SPORTS[game.sportKey]?.title ?? game.sportTitle;
  return extractAltCandidates(eventOdds, { ...game, sportTitle: game.sportTitle ?? title }, BASKETBALL_ALT_MARKETS, {
    now, minBooks: PROP_GATES.MIN_BOOKS, isRegistryBook: (key) => Boolean(bookIdFor(key)), normalizeName,
  });
}

export const clearsPropGates = (profile) => sharedClearsPropGates(profile, PROP_GATES);
export const propLegFrom = (candidate, values) => sharedPropLegFrom(candidate, values, PROP_GATES);
export const gradeBasketballPropLeg = gradePropLeg;

const GAMELOG_LABEL = { points: 'PTS', rebounds: 'REB', assists: 'AST' };
const GAMELOG_NAMES = { points: ['points'], rebounds: ['rebounds', 'totalRebounds'], assists: ['assists'] };

/**
 * The player's per-game values for one stat, most recent first. ESPN's
 * basketball game log carries one PTS/REB/AST column each, so the short
 * label is unambiguous; the camelCase key is still read first.
 */
export function parseBasketballGamelogValues(gamelog, statKey) {
  const names = Array.isArray(gamelog?.names) ? gamelog.names : [];
  const labels = Array.isArray(gamelog?.labels) ? gamelog.labels : [];
  let idx = names.findIndex((n) => GAMELOG_NAMES[statKey]?.includes(n));
  if (idx < 0) idx = labels.indexOf(GAMELOG_LABEL[statKey]);
  if (idx < 0) return [];
  const eventMeta = gamelog?.events ?? {};
  const rows = [];
  for (const seasonType of gamelog?.seasonTypes ?? []) {
    if (/preseason/i.test(String(seasonType?.displayName ?? ''))) continue;
    for (const category of seasonType?.categories ?? []) {
      for (const event of category?.events ?? []) {
        const value = Number(event?.stats?.[idx]);
        if (!Number.isFinite(value)) continue;
        const meta = eventMeta[event.eventId] ?? {};
        rows.push({ value, date: Date.parse(meta.gameDate ?? '') || 0 });
      }
    }
  }
  rows.sort((x, y) => y.date - x.date);
  return rows.map((r) => r.value);
}

/**
 * Per-player final rows from an ESPN basketball summary: points, rebounds,
 * assists. The boxscore's single statistics block lists every player who
 * dressed, with a DNP flagged on the athlete rather than by absence — a
 * player who did not play is left out so the leg voids as a book would.
 */
export function basketballBoxscoreRows(summary) {
  const rows = [];
  for (const team of summary?.boxscore?.players ?? []) {
    for (const stat of team.statistics ?? []) {
      const keys = Array.isArray(stat.keys) ? stat.keys : [];
      const labels = Array.isArray(stat.labels) ? stat.labels : Array.isArray(stat.names) ? stat.names : [];
      const col = (key, label) => { const i = keys.indexOf(key); return i >= 0 ? i : labels.indexOf(label); };
      const idx = { points: col('points', 'PTS'), rebounds: col('rebounds', 'REB'), assists: col('assists', 'AST') };
      for (const athlete of stat.athletes ?? []) {
        const name = athlete.athlete?.displayName;
        if (!name) continue;
        if (athlete.didNotPlay === true || !Array.isArray(athlete.stats) || !athlete.stats.length) continue;
        const row = { name };
        for (const [k, i] of Object.entries(idx)) {
          if (i < 0) continue;
          const value = Number(athlete.stats[i]);
          if (Number.isFinite(value)) row[k] = value;
        }
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
  const cacheKey = cache ? new Request(`https://pixel-pick.cache/basketball-props/${encodeURIComponent(url)}`) : null;
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

async function fetchAltProps(sportKey, oddsEventId, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events/${oddsEventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', BASKETBALL_ALT_MARKETS_PARAM);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');
  return cachedJson(url.toString(), ODDS_TTL, ctx);
}

async function resolveAthleteId(sportKey, playerName, teamAbbrs, ctx) {
  const target = normalizeName(playerName);
  for (const abbr of teamAbbrs) {
    if (!abbr) continue;
    const roster = await cachedJson(`${siteUrl(sportKey)}/teams/${abbr.toLowerCase()}/roster`, ROSTER_TTL, ctx);
    for (const group of roster?.athletes ?? []) {
      const items = Array.isArray(group?.items) ? group.items : Array.isArray(group) ? group : [group];
      for (const athlete of items) {
        if (athlete?.displayName && normalizeName(athlete.displayName) === target) return athlete.id;
      }
    }
  }
  return null;
}

/** ESPN's event id for a matchup, via the home team's schedule — needed at grading time. */
export async function resolveBasketballEspnEventId(sportKey, home, away, ctx) {
  const homeAbbr = espnAbbr(sportKey, home);
  const awayAbbr = espnAbbr(sportKey, away);
  if (!homeAbbr || !awayAbbr) return null;
  const schedule = await cachedJson(`${siteUrl(sportKey)}/teams/${homeAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const match = (schedule?.events ?? []).find((e) => {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.completed) return false;
    return comp?.competitors?.some((c) => c.team?.abbreviation?.toLowerCase() === awayAbbr.toLowerCase());
  });
  return match?.id ?? null;
}

/** The final per-player rows for a game, or null while it isn't final. */
export async function fetchFinalBasketballStats(sportKey, espnEventId, ctx) {
  if (!espnEventId || !BASKETBALL_SPORTS[sportKey]) return null;
  const summary = await cachedJson(`${siteUrl(sportKey)}/summary?event=${espnEventId}`, SUMMARY_TTL, ctx);
  if (!summary?.header?.competitions?.[0]?.status?.type?.completed) return null;
  return basketballBoxscoreRows(summary);
}

/**
 * Gated prop legs for a set of WNBA/NBA games (Odds API event objects).
 * Same shape as the NFL collector: safest line first per player + stat,
 * one game-log lookup each, every skip traced.
 */
export async function collectBasketballPropLegs(games, env, ctx, now = Date.now(), { trace = [] } = {}) {
  const legs = [];
  for (const sportKey of Object.keys(BASKETBALL_SPORTS)) {
    const scanned = (games ?? [])
      .filter((g) => g?.sport_key === sportKey && new Date(g.commence_time).getTime() > now)
      .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
      .slice(0, MAX_GAMES_SCANNED);
    if (!scanned.length) continue;

    let candidates = [];
    for (const game of scanned) {
      const odds = await fetchAltProps(sportKey, game.id, env, ctx);
      const extracted = extractBasketballAltCandidates(odds, {
        eventId: game.id, sportKey, sportTitle: game.sport_title ?? BASKETBALL_SPORTS[sportKey].title,
        commenceMs: new Date(game.commence_time).getTime(), home: game.home_team, away: game.away_team,
      }, { now });
      trace.push(`${game.away_team} @ ${game.home_team}: ${extracted.length} safe-band alternates`);
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

    const espnEventIds = new Map();
    for (const c of shortlist) {
      const abbrs = [espnAbbr(sportKey, c.home), espnAbbr(sportKey, c.away)];
      const athleteId = await resolveAthleteId(sportKey, c.playerName, abbrs, ctx);
      if (!athleteId) { trace.push(`${c.playerName}: no roster match`); continue; }
      const gamelog = await cachedJson(gamelogUrl(sportKey, athleteId), GAMELOG_TTL, ctx);
      const values = parseBasketballGamelogValues(gamelog, c.statKey);
      if (!values.length) { trace.push(`${c.playerName}: no ${c.statKey} in the game log`); continue; }
      const leg = propLegFrom(c, values);
      if (!leg) { trace.push(`${c.selection}: gates or edge missed`); continue; }
      if (!espnEventIds.has(c.eventId)) espnEventIds.set(c.eventId, await resolveBasketballEspnEventId(sportKey, c.home, c.away, ctx));
      legs.push({ ...leg, espnEventId: espnEventIds.get(c.eventId) ?? null });
    }
    trace.push(`${BASKETBALL_SPORTS[sportKey].title} prop legs qualified: ${legs.length}`);
  }
  return legs;
}

/**
 * The league's upcoming games from the Odds API's (credit-free) events
 * list, as the same event objects the slate carries — for a prop league
 * the Full Slate doesn't fetch. Null-safe: an outage lists nothing.
 */
export async function listBasketballGames(sportKey, env, ctx) {
  if (!BASKETBALL_SPORTS[sportKey]) return [];
  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('dateFormat', 'iso');
  const list = await cachedJson(url.toString(), ODDS_TTL, ctx);
  return Array.isArray(list) ? list.filter((g) => g?.id && g?.commence_time) : [];
}
