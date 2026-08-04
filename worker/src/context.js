/**
 * Team-sport context, proxied from ESPN.
 *
 * The odds feed carries prices only, so the records, form, head-to-head and
 * injury lines on a pick card come from here.
 *
 * Deliberately NOT using site.api.espn.com: it 403s every request from a
 * Cloudflare Worker specifically (confirmed live — identical requests succeed
 * from a normal machine), evidently blocking Cloudflare's shared egress IP
 * ranges. cdn.espn.com is the same underlying ESPN data — a scoreboard at
 * /core/{league}/scoreboard and a game detail at /core/{league}/game, both
 * with ?xhr=1 — reachable from Workers and carrying the identical sections
 * (lastFiveGames, injuries, seasonseries, predictor) under different wrapper
 * keys (content.sbData.events, gamepackageJSON).
 *
 * This is still an unofficial, undocumented ESPN surface — not covered by any
 * SLA and free to change shape without notice — so every field below is read
 * defensively and a missing section degrades to a shorter card, never an error.
 *
 * Tennis is deliberately absent: ESPN's tennis athletes carry no ids and its
 * tennis endpoints reject requests outright, so there is nothing to proxy.
 * That sport is served by the static archive built in
 * scripts/build-tennis-data.mjs.
 */

const ESPN_CDN = 'https://cdn.espn.com/core';

/**
 * The Odds API sport_key -> cdn.espn.com's league slug. This is a different,
 * shorter path than the old site.api.espn.com convention (`mlb`, not
 * `baseball/mlb`) — verified live against each sport's current scoreboard.
 *
 * NHL is deliberately absent: cdn.espn.com 404s that path outright, including
 * with an explicit in-season date, while every other sport here returns 200 —
 * this isn't the August off-season, ESPN just doesn't build that page on this
 * host. Fixing it would mean a third ESPN surface; not worth it for a league
 * outside what this app targets. An NHL bet still gets its price bullet, just
 * no research bullets, same as any fixture that can't be matched.
 */
const LEAGUE_PATHS = {
  baseball_mlb: 'mlb',
  americanfootball_nfl: 'nfl',
  americanfootball_ncaaf: 'college-football',
  basketball_nba: 'nba',
  basketball_wnba: 'wnba',
  basketball_ncaab: 'mens-college-basketball',
  soccer_epl: 'eng.1',
  soccer_usa_mls: 'usa.1',
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

/**
 * Cache-through JSON fetch, keyed on the upstream URL.
 *
 * A browser User-Agent is not defeating any protection here — cdn.espn.com
 * serves this to anonymous requests either way — but Workers' default fetch
 * sends none at all, and leaving it off is one more way this looks like
 * automated traffic to whatever is watching.
 */
async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/espn/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
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

  const scoreboardPage = await cachedJson(
    `${ESPN_CDN}/${league}/scoreboard?xhr=1`, SCOREBOARD_TTL, ctx,
  );
  // The scoreboard events live several levels deep in the page's own JSON —
  // this endpoint is a webpage's data blob, not a purpose-built API response.
  const scoreboard = scoreboardPage?.content?.sbData ?? null;
  const found = findEvent(scoreboard, home, away);
  if (!found) return null;

  // Soccer has no /game detail page on this host at all — confirmed 404 even
  // against a live in-season MLS match, not just an off-calendar friendly.
  // Rather than lose the pick's research entirely, fall through to
  // scoreboard-only data: still a real record, just without form, H2H or
  // injuries. sideOf() below reads every summary field defensively for
  // exactly this reason.
  const gamePage = await cachedJson(
    `${ESPN_CDN}/${league}/game?xhr=1&gameId=${found.event.id}`, SUMMARY_TTL, ctx,
  );
  const summary = gamePage?.gamepackageJSON ?? null;

  const projection = summary?.predictor
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
    seriesSummary: summary?.seasonseries?.[0]?.summary ?? null,
    projection,
  };
}
