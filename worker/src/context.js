/**
 * Team-sport context, proxied from ESPN.
 *
 * The odds feed carries prices only, so the records, form, head-to-head and
 * injury lines on a pick card come from here. ESPN's site API is free and
 * unauthenticated but undocumented — it is not covered by an SLA and could
 * change shape without notice, which is why every field below is read
 * defensively and a missing section degrades to a shorter card rather than an
 * error.
 *
 * Tennis is deliberately absent: ESPN's tennis athletes carry no ids and its
 * tennis summary endpoint returns 400, so there is nothing to proxy. That sport
 * is served by the static archive built in scripts/build-tennis-data.mjs.
 */

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

/** The Odds API sport_key -> ESPN league path. */
const LEAGUE_PATHS = {
  baseball_mlb: 'baseball/mlb',
  americanfootball_nfl: 'football/nfl',
  americanfootball_ncaaf: 'football/college-football',
  basketball_nba: 'basketball/nba',
  basketball_wnba: 'basketball/wnba',
  basketball_ncaab: 'basketball/mens-college-basketball',
  icehockey_nhl: 'hockey/nhl',
  soccer_epl: 'soccer/eng.1',
  soccer_usa_mls: 'soccer/usa.1',
};

export const hasContext = (sportKey) => Boolean(LEAGUE_PATHS[sportKey]);

const SCOREBOARD_TTL = 600;   // fixtures shift rarely
const SUMMARY_TTL = 1800;     // records and injuries move a few times a day

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cache-through JSON fetch, keyed on the upstream URL. */
async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/espn/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;

  const body = await response.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  try { return JSON.parse(body); } catch { return null; }
}

/** Score how well an ESPN competitor matches a name from the odds feed. */
function teamScore(competitor, wanted) {
  const team = competitor?.team ?? {};
  const candidates = [team.displayName, team.shortDisplayName, team.name, team.abbreviation]
    .filter(Boolean)
    .map(fold);
  const target = fold(wanted);
  if (!target) return 0;

  if (candidates.includes(target)) return 3;
  if (candidates.some((c) => c && (target.includes(c) || c.includes(target)))) return 2;

  // Fall back to word overlap so "LA Angels" still reaches "Los Angeles Angels".
  const targetWords = new Set(target.split(' '));
  const overlap = candidates
    .flatMap((c) => c.split(' '))
    .filter((w) => w.length > 2 && targetWords.has(w)).length;
  return overlap ? 1 : 0;
}

/** Locate the ESPN event for a fixture named by the odds feed. */
function findEvent(scoreboard, home, away) {
  let best = null;

  for (const event of scoreboard?.events ?? []) {
    for (const competition of event.competitions ?? []) {
      const competitors = competition.competitors ?? [];
      if (competitors.length < 2) continue;

      const homeSide = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
      const awaySide = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];

      // Try both orientations: the two feeds don't always agree on which side
      // is nominally home, and a neutral-site game has no real home at all.
      const straight = teamScore(homeSide, home) + teamScore(awaySide, away);
      const swapped = teamScore(homeSide, away) + teamScore(awaySide, home);
      const score = Math.max(straight, swapped);

      // Both sides must contribute; one strong match is a coincidence.
      if (score >= 4 && (!best || score > best.score)) {
        best = { event, competition, homeSide, awaySide, score };
      }
    }
  }
  return best;
}

const recordOfType = (competitor, type) =>
  (competitor?.records ?? []).find((r) => r.type === type)?.summary ?? null;

function lastFiveFor(summary, teamId) {
  const block = (summary?.lastFiveGames ?? []).find((b) => String(b.team?.id) === String(teamId));
  return (block?.events ?? [])
    .map((game) => ({
      result: game.gameResult ?? null,
      score: game.score ?? null,
      opponent: game.opponent?.abbreviation ?? game.opponent?.displayName ?? null,
      atVs: game.atVs ?? null,
      date: game.gameDate ?? null,
    }))
    .filter((g) => g.result);
}

function injuriesFor(summary, teamId) {
  const block = (summary?.injuries ?? []).find((b) => String(b.team?.id) === String(teamId));
  return (block?.injuries ?? [])
    .map((entry) => ({
      name: entry.athlete?.displayName ?? entry.athlete?.shortName ?? null,
      status: entry.status ?? null,
      date: entry.date ?? null,
    }))
    .filter((p) => p.name && p.status);
}

function atsFor(summary, teamId) {
  const block = (summary?.againstTheSpread ?? []).find(
    (b) => String(b.team?.id) === String(teamId),
  );
  // MLB returns an empty records array — it prices run lines, not spreads.
  const overall = (block?.records ?? []).find((r) => /overall|total/i.test(r.type ?? r.name ?? ''));
  return overall?.summary ?? (block?.records ?? [])[0]?.summary ?? null;
}

function sideOf(summary, competitor, isHome) {
  const team = competitor?.team ?? {};
  const id = team.id;
  return {
    id,
    name: team.displayName ?? null,
    shortName: team.shortDisplayName ?? team.name ?? team.displayName ?? null,
    isHome,
    overallRecord: recordOfType(competitor, 'total'),
    homeRecord: recordOfType(competitor, 'home'),
    awayRecord: recordOfType(competitor, 'road') ?? recordOfType(competitor, 'away'),
    lastFive: lastFiveFor(summary, id),
    atsRecord: atsFor(summary, id),
    injuries: injuriesFor(summary, id),
  };
}

/**
 * Normalised context bundle for one fixture, or null when ESPN has nothing we
 * can confidently tie to it. Null is a valid, expected answer — the card simply
 * shows fewer bullets.
 */
export async function fetchContext({ sportKey, home, away }, ctx) {
  const league = LEAGUE_PATHS[sportKey];
  if (!league || !home || !away) return null;

  const scoreboard = await cachedJson(`${ESPN}/${league}/scoreboard`, SCOREBOARD_TTL, ctx);
  const found = findEvent(scoreboard, home, away);
  if (!found) return null;

  const summary = await cachedJson(
    `${ESPN}/${league}/summary?event=${found.event.id}`, SUMMARY_TTL, ctx,
  );
  if (!summary) return null;

  const projection = summary.predictor
    ? {
        home: summary.predictor.homeTeam?.gameProjection ?? null,
        away: summary.predictor.awayTeam?.gameProjection ?? null,
      }
    : null;

  return {
    league,
    espnEventId: found.event.id,
    home: sideOf(summary, found.homeSide, true),
    away: sideOf(summary, found.awaySide, false),
    seriesSummary: summary.seasonseries?.[0]?.summary ?? null,
    projection,
  };
}
