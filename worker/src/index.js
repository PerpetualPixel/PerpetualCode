/**
 * Pixel Pick odds proxy.
 *
 * Sits between the static app and The Odds API so the API key lives as a
 * Cloudflare secret and never reaches the browser. It also does the two things
 * that keep a 500-credit/month free tier viable:
 *
 *   1. Edge-caches upstream responses, so repeated "Generate Picks" taps cost
 *      nothing. Odds don't move meaningfully inside the cache window anyway.
 *   2. Refuses to fan out beyond an allowlist of leagues, so a stray query
 *      string can't burn the month's quota in one request.
 */

const UPSTREAM = 'https://api.the-odds-api.com/v4';

// Leagues this proxy will spend credits on. Each entry is one upstream call.
const ALLOWED_SPORTS = new Set([
  'upcoming',
  'americanfootball_nfl',
  'americanfootball_ncaaf',
  'basketball_nba',
  'basketball_wnba',
  'basketball_ncaab',
  'baseball_mlb',
  'icehockey_nhl',
  'mma_mixed_martial_arts',
  'soccer_epl',
  'soccer_usa_mls',
]);

// Game markets only. Player props need The Odds API's Business tier, and each
// prop market is billed per event, which would exhaust a free plan immediately.
const MARKETS = 'h2h,spreads,totals';
const REGIONS = 'us';
const MAX_SPORTS_PER_REQUEST = 4;
const DEFAULT_CACHE_SECONDS = 300;

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  // Only echo an origin we were configured to trust; no wildcard fallback.
  const allow = allowed.includes(origin) ? origin : allowed[0] ?? '';

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Fetch one sport, served from the edge cache when possible. */
async function fetchSport(sport, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${sport}/odds`);
  url.searchParams.set('apiKey', env.ODDS_API_KEY);
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const ttl = Number(env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  // Cache key must not contain the secret, so key on the sport alone.
  const cacheKey = new Request(
    `https://pixel-pick.cache/odds/${sport}?markets=${MARKETS}&regions=${REGIONS}`,
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return { events: await cached.json(), cached: true, quota: null };
  }

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    const detail = await upstream.text();
    return { error: { sport, status: upstream.status, detail: detail.slice(0, 300) } };
  }

  const events = await upstream.json();
  const quota = {
    remaining: upstream.headers.get('x-requests-remaining'),
    used: upstream.headers.get('x-requests-used'),
    lastCost: upstream.headers.get('x-requests-last'),
  };

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(events), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  return { events, cached: false, quota };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
    }
    if (!env.ODDS_API_KEY) {
      return json(
        { error: 'Proxy is missing ODDS_API_KEY. Set it with: wrangler secret put ODDS_API_KEY' },
        { status: 500, headers: cors },
      );
    }

    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== '/odds') {
      return json({ error: 'Not found. Try GET /odds?sports=upcoming' }, { status: 404, headers: cors });
    }

    const requested = (searchParams.get('sports') ?? 'upcoming')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => ALLOWED_SPORTS.has(s));

    if (!requested.length) {
      return json(
        { error: 'No valid sports requested.', allowed: [...ALLOWED_SPORTS] },
        { status: 400, headers: cors },
      );
    }

    // Hard cap the fan-out: each sport is a separate billed upstream call.
    const sports = [...new Set(requested)].slice(0, MAX_SPORTS_PER_REQUEST);

    const results = await Promise.all(sports.map((s) => fetchSport(s, env, ctx)));

    const events = [];
    const errors = [];
    let quota = null;
    let allCached = true;

    for (const result of results) {
      if (result.error) {
        errors.push(result.error);
        continue;
      }
      events.push(...result.events);
      if (!result.cached) allCached = false;
      if (result.quota?.remaining != null) quota = result.quota;
    }

    // Every upstream call failed — surface it rather than pretending we're empty.
    if (!events.length && errors.length) {
      return json({ error: 'Upstream odds request failed', errors }, { status: 502, headers: cors });
    }

    return json(
      { events, sports, cached: allCached, quota, errors, fetchedAt: new Date().toISOString() },
      {
        headers: {
          ...cors,
          'Cache-Control': `public, max-age=${env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}`,
        },
      },
    );
  },
};
