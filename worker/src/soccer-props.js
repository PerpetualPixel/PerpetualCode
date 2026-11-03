/**
 * Soccer player props for Trends: shots, shots on target, assists and
 * goals (the anytime-scorer market read as Over 0.5 goals), on the five
 * big European leagues the odds feed prices player props for (the
 * Champions League has none; it reaches the Live tab through its game
 * lines instead). One Trends league per competition, all built from
 * soccerSpec() below, so each keeps its own feed key, ESPN slug and
 * team map.
 *
 * ESPN shapes, read live on 2026-11-03:
 *   game log   common/v3/sports/soccer/{slug}/athletes/{id}/gamelog, names
 *              totalGoals, goalAssists, totalShots, shotsOnTarget (and
 *              fouls, offsides, cards); the season "2026-27 English Premier
 *              League" is keyed by its first year, so last season is
 *              ?season={year - 1}.
 *   roster     teams/{id}/roster by the club's numeric id (the
 *              abbreviation path answers nothing for soccer), a flat
 *              athletes list; docs/team-logos.js's SOCCER_IDS carries the
 *              ids behind the abbreviations the cards show.
 *   summary    rosters[].roster[] with stats [{ name, value }]: totalShots,
 *              shotsOnTarget, totalGoals, goalAssists, saves, appearances.
 */
import { bookIdFor } from '../../docs/engine.js';
import { normalizeName } from '../../docs/nhl-props.js';
import { seasonYearOf } from '../../docs/prop-legs.js';
import { soccerTeamId, SOCCER_SLUGS } from '../../docs/team-logos.js';
import { UPSTREAM, TREND_BOOKMAKERS } from './odds.js';

/** The competitions with player props on the feed, by its sport key. */
export const SOCCER_LEAGUES = {
  soccer_epl: { slug: 'eng.1', title: 'Premier League', short: 'EPL' },
  soccer_spain_la_liga: { slug: 'esp.1', title: 'La Liga', short: 'La Liga' },
  soccer_italy_serie_a: { slug: 'ita.1', title: 'Serie A', short: 'Serie A' },
  soccer_germany_bundesliga: { slug: 'ger.1', title: 'Bundesliga', short: 'Bundesliga' },
  soccer_france_ligue_one: { slug: 'fra.1', title: 'Ligue 1', short: 'Ligue 1' },
};
export const SOCCER_PROP_KEYS = Object.keys(SOCCER_LEAGUES);
export const isSoccerKey = (sportKey) => String(sportKey ?? '').startsWith('soccer_');

/** The markets scanned, the stat each settles on, and how a leg names it. Goals come from the anytime-scorer market, read as Over 0.5. */
export const SOCCER_PROP_MARKETS = {
  player_shots: { stat: 'shots', label: 'Shots', marketLabel: 'Shots' },
  player_shots_on_target: { stat: 'shotsOnTarget', label: 'SOT', marketLabel: 'Shots on Target' },
  player_assists: { stat: 'assists', label: 'Ast', marketLabel: 'Assists' },
  player_goals: { stat: 'goals', label: 'G', marketLabel: 'Goals' },
};
export const SOCCER_ALT_MARKETS = {
  player_shots_alternate: SOCCER_PROP_MARKETS.player_shots,
  player_shots_on_target_alternate: SOCCER_PROP_MARKETS.player_shots_on_target,
  player_assists_alternate: SOCCER_PROP_MARKETS.player_assists,
};
export const SOCCER_TREND_MARKETS = { ...SOCCER_PROP_MARKETS, ...SOCCER_ALT_MARKETS };
/** What the feed is asked for: the Over/Under markets by name, and the anytime scorer, which becomes player_goals below. */
const FEED_MARKETS = 'player_shots,player_shots_on_target,player_assists,player_shots_alternate,player_shots_on_target_alternate,player_assists_alternate,player_goal_scorer_anytime';

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_GAMELOG = 'https://site.web.api.espn.com/apis/common/v3/sports/soccer';
const ROSTER_TTL = 3600 * 6;
const GAMELOG_TTL = 3600 * 3;
const ODDS_TTL = 3600 * 3;

const GAMELOG_NAMES = { shots: ['totalShots'], shotsOnTarget: ['shotsOnTarget'], assists: ['goalAssists'], goals: ['totalGoals'] };
const GAMELOG_LABEL = { shots: 'SHOT', shotsOnTarget: 'SOG', assists: 'A', goals: 'G' };

/** Which game-log column carries `statKey`, by key first, then by label; -1 when absent. */
export function soccerStatIndex(gamelog, statKey) {
  const names = Array.isArray(gamelog?.names) ? gamelog.names : [];
  const labels = Array.isArray(gamelog?.labels) ? gamelog.labels : [];
  const idx = names.findIndex((n) => GAMELOG_NAMES[statKey]?.includes(n));
  if (idx >= 0) return idx;
  return GAMELOG_LABEL[statKey] ? labels.indexOf(GAMELOG_LABEL[statKey]) : -1;
}

/**
 * The anytime-scorer market as a goals line: each "Yes" on a player is
 * that player Over 0.5 goals at the price, under player_goals, so the
 * Trends reader treats it like any other Over.
 */
export function goalsFromAnytimeScorer(odds) {
  if (!Array.isArray(odds?.bookmakers)) return odds;
  return {
    ...odds,
    bookmakers: odds.bookmakers.map((b) => ({
      ...b,
      markets: (b.markets ?? []).map((m) => (m.key !== 'player_goal_scorer_anytime' ? m : {
        ...m,
        key: 'player_goals',
        outcomes: (m.outcomes ?? []).filter((o) => String(o.name).toLowerCase() === 'yes' && o.description).map((o) => ({ ...o, name: 'Over', point: 0.5 })),
      })),
    })),
  };
}

/** The last fetch this module could not complete, for a Trends diagnostic line. */
export const fetchDiag = { lastError: null };
const noteFetchError = (url, what) => { fetchDiag.lastError = `${what} for ${new URL(url).pathname.slice(0, 80)}`; };

async function cachedJson(url, ttl, ctx) {
  const cache = globalThis.caches?.default ?? null;
  const cacheKey = cache ? new Request(`https://pixel-pick.cache/soccer-props/${encodeURIComponent(url)}`) : null;
  try {
    const hit = cache ? await cache.match(cacheKey) : null;
    if (hit) return hit.json();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) { noteFetchError(url, `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 80)}`); return null; }
    const body = await res.text();
    if (cache) ctx?.waitUntil?.(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } })));
    return JSON.parse(body);
  } catch (e) {
    noteFetchError(url, String(e?.message ?? e).slice(0, 120));
    return null;
  }
}

export async function fetchSoccerProps(sportKey, oddsEventId, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events/${oddsEventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('bookmakers', TREND_BOOKMAKERS);
  url.searchParams.set('markets', FEED_MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');
  url.searchParams.set('includeLinks', 'true');
  const odds = await cachedJson(url.toString(), ODDS_TTL, ctx);
  return odds ? goalsFromAnytimeScorer(odds) : null;
}

/** The club's roster by its id (the abbreviation path answers nothing for soccer). */
export async function fetchSoccerRoster(sportKey, abbr, ctx) {
  const id = soccerTeamId(sportKey, abbr);
  if (!id) return null;
  return cachedJson(`${ESPN_SITE}/${SOCCER_SLUGS[sportKey]}/teams/${id}/roster`, ROSTER_TTL, ctx);
}

export async function resolveSoccerAthleteId(sportKey, playerName, teamAbbrs, ctx) {
  const target = normalizeName(playerName);
  for (const abbr of teamAbbrs) {
    if (!abbr) continue;
    const roster = await fetchSoccerRoster(sportKey, abbr, ctx);
    const list = Array.isArray(roster?.athletes) ? roster.athletes.flatMap((g) => (Array.isArray(g?.items) ? g.items : [g])) : [];
    for (const athlete of list) {
      if (athlete?.displayName && normalizeName(athlete.displayName) === target) return athlete.id;
      if (athlete?.fullName && normalizeName(athlete.fullName) === target) return athlete.id;
    }
  }
  return null;
}

export async function fetchSoccerGamelog(sportKey, athleteId, ctx, season = null) {
  return cachedJson(`${ESPN_GAMELOG}/${SOCCER_SLUGS[sportKey]}/athletes/${athleteId}/gamelog${season ? `?season=${season}` : ''}`, GAMELOG_TTL, ctx);
}

export const soccerHeadshotUrl = (athleteId) => (athleteId ? `https://a.espncdn.com/i/headshots/soccer/players/full/${athleteId}.png` : null);

/** Last season's key from a log: the season is named by its first year ("2026-27"), so last season is that year less one. */
export const soccerPriorSeason = (log) => { const y = seasonYearOf(log?.seasonTypes?.[0]?.displayName); return y ? y - 1 : null; };

/** The Trends league for one competition (worker/src/trends.js's TREND_SPORTS). */
export function soccerSpec(sportKey) {
  const league = SOCCER_LEAGUES[sportKey];
  return {
    title: league.title,
    // A round is a weekend (or a midweek), and the lines post days out: rebuilt twice a day, seven credits a match.
    ttlMinutes: 720,
    markets: SOCCER_TREND_MARKETS,
    normalizeName,
    fetchOdds: (eventId, env, ctx) => fetchSoccerProps(sportKey, eventId, env, ctx),
    resolve: (name, abbrs, ctx) => resolveSoccerAthleteId(sportKey, name, abbrs, ctx),
    roster: (abbr, ctx) => fetchSoccerRoster(sportKey, abbr, ctx),
    gamelog: (athleteId, ctx) => fetchSoccerGamelog(sportKey, athleteId, ctx),
    priorGamelog: (athleteId, ctx, now, log) => { const y = soccerPriorSeason(log); return y ? fetchSoccerGamelog(sportKey, athleteId, ctx, y) : null; },
    headshot: soccerHeadshotUrl,
    statIndex: soccerStatIndex,
    fetchDiag,
    isRegistryBook: (key) => Boolean(bookIdFor(key)),
  };
}
