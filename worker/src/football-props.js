/**
 * NFL alternate-line player props as ticket legs (docs/tickets.js).
 *
 * The anchor leg the direction describes — "a player to get 10 points when
 * they average 15 to 20" — is an ALTERNATE line deep in a player's comfort
 * zone, not the ~-110 main line. For football that is 50+ receiving yards
 * for a receiver who averages 80, 3+ receptions for a back who catches 5 a
 * game, 10+ rushing yards for a quarterback who scrambles. This module
 * finds those lines, checks each one against the player's real ESPN game
 * log (docs/prop-legs.js: hit rate this season and over the last five
 * games, shrunk toward the price's own implied probability, and required
 * to beat it), and hands the survivors to the ticket builder as legs.
 *
 * Every number on a leg is measured: the hit-rate profile comes from the
 * game log, the price from the books, and grading reads the final boxscore
 * for the exact stat. Nothing is projected or guessed; a player whose game
 * log can't be found, or whose stat the log doesn't carry, is skipped.
 *
 * Cost: one per-event odds call per game (4 markets x 1 region) at the 2am
 * draw, bounded by MAX_GAMES_SCANNED; every ESPN call is free and cached.
 */

import { bookIdFor } from '../../docs/engine.js';
import { normalizeName } from '../../docs/nfl-props.js';
import { espnAbbr } from '../../docs/team-logos.js';
import {
  extractAltCandidates,
  propLegFrom as sharedPropLegFrom,
  clearsPropGates as sharedClearsPropGates,
  gradePropLeg,
} from '../../docs/prop-legs.js';
import { UPSTREAM, REGIONS } from './odds.js';

export { PROP_LEG_DECIMAL } from '../../docs/prop-legs.js';

export const NFL_SPORT_KEY = 'americanfootball_nfl';

/** The alternate markets scanned, the stat each settles on, and how a leg names it. */
export const NFL_ALT_MARKETS = {
  player_pass_yds_alternate: { stat: 'passYds', label: 'Pass Yds', marketLabel: 'Passing Yards (alt)' },
  player_rush_yds_alternate: { stat: 'rushYds', label: 'Rush Yds', marketLabel: 'Rushing Yards (alt)' },
  player_reception_yds_alternate: { stat: 'recYds', label: 'Rec Yds', marketLabel: 'Receiving Yards (alt)' },
  player_receptions_alternate: { stat: 'receptions', label: 'Rec', marketLabel: 'Receptions (alt)' },
};
export const NFL_ALT_MARKETS_PARAM = Object.keys(NFL_ALT_MARKETS).join(',');

/**
 * Conviction gates from the player's game log. An NFL season is seventeen
 * games, so the sample is small by design: four games is the least a hit
 * rate can be read from at all (one game short of that is a streak, not a
 * rate), and the recent-form window is the last five.
 */
export const PROP_GATES = { MIN_GAMES: 4, MIN_SEASON_RATE: 0.75, MIN_L5_RATE: 0.8, MIN_BOOKS: 2 };

export const MAX_GAMES_SCANNED = 10;
export const MAX_GAMELOG_LOOKUPS = 24;

const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_GAMELOG = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes';
const ROSTER_TTL = 3600 * 6;
const GAMELOG_TTL = 3600 * 3;
const SCHEDULE_TTL = 3600 * 6;
const SUMMARY_TTL = 900;
const ODDS_TTL = 3600;

/* ---------------------------------------------------------------- */
/* Pure                                                              */
/* ---------------------------------------------------------------- */

/** Every safe-band Over alternate from one game's per-event odds payload — see docs/prop-legs.js's extractAltCandidates. */
export function extractNflAltCandidates(eventOdds, game, { now = Date.now() } = {}) {
  return extractAltCandidates(eventOdds, { sportKey: NFL_SPORT_KEY, sportTitle: 'NFL', ...game }, NFL_ALT_MARKETS, {
    now, minBooks: PROP_GATES.MIN_BOOKS, isRegistryBook: (key) => Boolean(bookIdFor(key)), normalizeName,
  });
}

export const clearsPropGates = (profile) => sharedClearsPropGates(profile, PROP_GATES);
export const propLegFrom = (candidate, values) => sharedPropLegFrom(candidate, values, PROP_GATES);
export const gradeNflPropLeg = gradePropLeg;

const GAMELOG_NAMES = {
  passYds: ['passingYards'],
  rushYds: ['rushingYards'],
  recYds: ['receivingYards'],
  receptions: ['receptions'],
};
const GAMELOG_DISPLAY = {
  passYds: /^passing yards$/i,
  rushYds: /^rushing yards$/i,
  recYds: /^receiving yards$/i,
  receptions: /^receptions$/i,
};
const GAMELOG_LABEL = { passYds: 'YDS', rushYds: 'YDS', recYds: 'YDS', receptions: 'REC' };

/**
 * Which column of the game log carries `statKey`. ESPN's common/v3 game
 * log lists one flat stat row per game with parallel `names` (camelCase
 * keys), `displayNames` and `labels` arrays describing the columns. The
 * keys are read first, the display names second, and the short labels
 * only when exactly one column carries the label — a running back's log
 * has a rushing YDS and a receiving YDS, and guessing between them would
 * grade the wrong stat. -1 when the stat can't be located; the candidate
 * is then skipped rather than scored on the wrong column.
 */
export function gamelogStatIndex(gamelog, statKey) {
  const names = Array.isArray(gamelog?.names) ? gamelog.names : [];
  const display = Array.isArray(gamelog?.displayNames) ? gamelog.displayNames : [];
  const labels = Array.isArray(gamelog?.labels) ? gamelog.labels : [];
  let idx = names.findIndex((n) => (GAMELOG_NAMES[statKey] ?? []).includes(n));
  if (idx < 0 && GAMELOG_DISPLAY[statKey]) idx = display.findIndex((d) => GAMELOG_DISPLAY[statKey].test(String(d ?? '')));
  if (idx < 0) {
    const hits = labels.map((l, i) => (l === GAMELOG_LABEL[statKey] ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) [idx] = hits;
  }
  return idx;
}

/**
 * The player's per-game values for one stat, most recent first, regular
 * season (and postseason) only — a preseason line says nothing about a
 * starter's workload. An unexpected payload yields [] and the candidate is
 * skipped, never guessed.
 */
export function parseNflGamelogValues(gamelog, statKey) {
  const idx = gamelogStatIndex(gamelog, statKey);
  if (idx < 0) return [];
  const eventMeta = gamelog?.events ?? {};
  const rows = [];
  for (const seasonType of gamelog?.seasonTypes ?? []) {
    if (/preseason/i.test(String(seasonType?.displayName ?? ''))) continue;
    for (const category of seasonType?.categories ?? []) {
      for (const event of category?.events ?? []) {
        const value = Number(String(event?.stats?.[idx] ?? '').replace(/,/g, ''));
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
 * Per-player final stat rows from an ESPN game summary: passing, rushing
 * and receiving yards and receptions, merged by player across the three
 * boxscore categories (a running back appears under both rushing and
 * receiving). Reads each category's own `keys` first and its short labels
 * second — within one category a YDS label is unambiguous.
 */
export function nflBoxscoreRows(summary) {
  const byName = new Map();
  for (const team of summary?.boxscore?.players ?? []) {
    for (const category of team.statistics ?? []) {
      const name = String(category.name ?? category.type ?? '').toLowerCase();
      const keys = Array.isArray(category.keys) ? category.keys : [];
      const labels = Array.isArray(category.labels) ? category.labels : Array.isArray(category.names) ? category.names : [];
      const col = (key, label) => {
        const i = keys.indexOf(key);
        return i >= 0 ? i : labels.indexOf(label);
      };
      let fields;
      if (name === 'passing') fields = { passYds: col('passingYards', 'YDS') };
      else if (name === 'rushing') fields = { rushYds: col('rushingYards', 'YDS') };
      else if (name === 'receiving') fields = { recYds: col('receivingYards', 'YDS'), receptions: col('receptions', 'REC') };
      else continue;
      for (const athlete of category.athletes ?? []) {
        const displayName = athlete.athlete?.displayName;
        if (!displayName) continue;
        const key = normalizeName(displayName);
        const row = byName.get(key) ?? { name: displayName };
        for (const [stat, i] of Object.entries(fields)) {
          if (i < 0) continue;
          const value = Number(String(athlete.stats?.[i] ?? '').replace(/,/g, ''));
          if (Number.isFinite(value)) row[stat] = value;
        }
        byName.set(key, row);
      }
    }
  }
  return [...byName.values()];
}

/* ---------------------------------------------------------------- */
/* Impure: fetching                                                  */
/* ---------------------------------------------------------------- */

async function cachedJson(url, ttl, ctx) {
  // The Cache API only exists in the Workers runtime; without it (tests, a
  // local node run) the fetch is simply uncached.
  const cache = globalThis.caches?.default ?? null;
  const cacheKey = cache ? new Request(`https://pixel-pick.cache/football-props/${encodeURIComponent(url)}`) : null;
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

async function fetchNflAltProps(oddsEventId, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${NFL_SPORT_KEY}/events/${oddsEventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', NFL_ALT_MARKETS_PARAM);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');
  return cachedJson(url.toString(), ODDS_TTL, ctx);
}

/** ESPN athlete id for a player on either team, through the (free, cached) rosters. */
async function resolveNflAthleteId(playerName, teamAbbrs, ctx) {
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

/** ESPN's event id for a matchup, via the home team's schedule — needed at grading time. */
export async function resolveNflEspnEventId(home, away, ctx) {
  const homeAbbr = espnAbbr(NFL_SPORT_KEY, home);
  const awayAbbr = espnAbbr(NFL_SPORT_KEY, away);
  if (!homeAbbr || !awayAbbr) return null;
  const schedule = await cachedJson(`${ESPN_SITE}/teams/${homeAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const match = (schedule?.events ?? []).find((e) => {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.completed) return false;
    return comp?.competitors?.some((c) => c.team?.abbreviation?.toLowerCase() === awayAbbr.toLowerCase());
  });
  return match?.id ?? null;
}

/**
 * The final per-player stat rows for a game, or null while it isn't final.
 * One summary fetch per game per grading pass (cached across the pass by
 * the caller); the rows carry every stat any leg on the game could need.
 */
export async function fetchFinalNflStats(espnEventId, ctx) {
  if (!espnEventId) return null;
  const summary = await cachedJson(`${ESPN_SITE}/summary?event=${espnEventId}`, SUMMARY_TTL, ctx);
  if (!summary?.header?.competitions?.[0]?.status?.type?.completed) return null;
  return nflBoxscoreRows(summary);
}

/**
 * Gated prop legs for a set of NFL games (Odds API event objects), ready
 * for the ticket builder. Safest line first per player + stat — the
 * deepest comfort-zone threshold is the one that clears the gates, exactly
 * as the Prop Play found for basketball — then one game-log lookup each,
 * bounded by MAX_GAMELOG_LOOKUPS. `trace` records every skip reason for
 * the debug route.
 */
export async function collectNflPropLegs(games, env, ctx, now = Date.now(), { trace = [] } = {}) {
  const scanned = (games ?? [])
    .filter((g) => g?.sport_key === NFL_SPORT_KEY && new Date(g.commence_time).getTime() > now)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, MAX_GAMES_SCANNED);
  if (!scanned.length) return [];

  let candidates = [];
  for (const game of scanned) {
    const odds = await fetchNflAltProps(game.id, env, ctx);
    const extracted = extractNflAltCandidates(odds, {
      eventId: game.id, sportKey: game.sport_key, sportTitle: game.sport_title ?? 'NFL',
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

  const legs = [];
  const espnEventIds = new Map();
  for (const c of shortlist) {
    const abbrs = [espnAbbr(NFL_SPORT_KEY, c.home), espnAbbr(NFL_SPORT_KEY, c.away)];
    const athleteId = await resolveNflAthleteId(c.playerName, abbrs, ctx);
    if (!athleteId) { trace.push(`${c.playerName}: no roster match`); continue; }
    const gamelog = await cachedJson(`${ESPN_GAMELOG}/${athleteId}/gamelog`, GAMELOG_TTL, ctx);
    const values = parseNflGamelogValues(gamelog, c.statKey);
    if (!values.length) { trace.push(`${c.playerName}: no ${c.statKey} in the game log`); continue; }
    const leg = propLegFrom(c, values);
    if (!leg) { trace.push(`${c.selection}: gates or edge missed`); continue; }
    if (!espnEventIds.has(c.eventId)) espnEventIds.set(c.eventId, await resolveNflEspnEventId(c.home, c.away, ctx));
    legs.push({ ...leg, espnEventId: espnEventIds.get(c.eventId) ?? null });
  }
  trace.push(`NFL prop legs qualified: ${legs.length}`);
  return legs;
}
