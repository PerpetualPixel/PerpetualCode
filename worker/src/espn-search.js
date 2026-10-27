/**
 * ESPN's search API as a second way to find a player's id, and a probe of
 * which ESPN endpoints the worker can reach.
 *
 * On 2026-10-27 the Trends trace showed every roster lookup refused with
 * an HTML 403 from site.web.api.espn.com's /apis/site/v2 roster path —
 * from a Cloudflare Worker only; a GitHub runner fetches the same URL
 * fine — so no player could be matched to a game log and every build
 * ended with zero rows. The search endpoint lives on a different path
 * and answers a name with the player's id and league; it is tried when
 * the roster is unreachable or has no match. Free, cached six hours.
 */

const SEARCH = 'https://site.web.api.espn.com/apis/search/v2';
const SEARCH_TTL = 3600 * 6;

async function cachedJson(url, ttl, ctx) {
  const cache = globalThis.caches?.default ?? null;
  const cacheKey = cache ? new Request(`https://pixel-pick.cache/espn-search/${encodeURIComponent(url)}`) : null;
  try {
    const hit = cache ? await cache.match(cacheKey) : null;
    if (hit) return hit.json();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.text();
    if (cache) ctx?.waitUntil?.(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } })));
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The ESPN athlete id for `name` in `league` ('nfl', 'nba', 'nhl'), by
 * search: the first player result whose name normalizes to the same
 * string and whose league matches. `normalizeName` is the league's own
 * (the same one the roster resolver uses), so "Pat Mahomes" and
 * "Patrick Mahomes" meet where that resolver would meet them.
 */
export async function searchAthleteId(name, league, ctx, { normalizeName = (n) => String(n ?? '').toLowerCase().trim() } = {}) {
  const target = normalizeName(name);
  if (!target) return null;
  const url = `${SEARCH}?limit=10&query=${encodeURIComponent(String(name).trim())}`;
  const data = await cachedJson(url, SEARCH_TTL, ctx);
  const groups = Array.isArray(data?.results) ? data.results : [];
  for (const group of groups) {
    if (group?.type && group.type !== 'player') continue;
    for (const item of group?.contents ?? []) {
      const slug = String(item?.defaultLeagueSlug ?? item?.league ?? '').toLowerCase();
      if (slug && slug !== league) continue;
      if (item?.id && normalizeName(item.displayName ?? item.name) === target) return String(item.id);
    }
  }
  return null;
}

/**
 * One line for the Trends trace: the HTTP status the worker gets from
 * each ESPN endpoint the build depends on, so a block on one path is
 * told apart from a block on all of them.
 */
export async function probeEspn(ctx) {
  const targets = {
    roster: 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/det/roster',
    search: `${SEARCH}?limit=1&query=Jared%20Goff`,
    gamelog: 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/16760/gamelog',
    core: 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/8/athletes?limit=1',
    cdn: 'https://cdn.espn.com/core/nfl/team/roster/_/name/det?xhr=1',
  };
  const parts = await Promise.all(Object.entries(targets).map(async ([k, url]) => {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      return `${k} ${res.status}`;
    } catch (e) {
      return `${k} ${String(e?.message ?? e).slice(0, 40)}`;
    }
  }));
  void ctx;
  return `espn probe: ${parts.join(', ')}`;
}
