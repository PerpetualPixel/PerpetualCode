import {
  generateTOTPSecret,
  verifyTOTPToken,
  getTOTPToken,
  hashPassword,
  verifyPassword,
  generateId,
  generateJWT,
  verifyJWT,
  getTOTPQRCode,
} from './auth.js';
import { QuotaManager } from './quota.js';
import { fetchContext, hasContext } from './context.js';
import { fetchWeather, hasVenue } from './weather.js';
import { fetchMmaContext } from './mma.js';
import { fetchBaseballContext } from './baseball.js';
import { fetchTeamStats, fetchRecentSchedule } from './mlb-stats.js';
import { getUfcEventDetails } from './ufc-events.js';
import { currentPhase, runPotdPhase, getPotd, getPotdBySport } from './potd.js';
import { getOrGenerateAnalysis } from './analysis.js';

const UPSTREAM = 'https://api.the-odds-api.com/v4';

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

// Tennis is keyed per tournament (tennis_atp_canadian_open, and a different key
// next week), so an exact allowlist would go stale every few days. Prefixes let
// the tour through without opening the door to arbitrary sport keys.
const ALLOWED_SPORT_PREFIXES = ['tennis_atp_', 'tennis_wta_'];

function isAllowedSport(key) {
  return (
    ALLOWED_SPORTS.has(key) ||
    ALLOWED_SPORT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

const MARKETS = 'h2h,spreads,totals';
const REGIONS = 'us';
// Each sport is a separate billed call: 3 markets x 1 region = 3 credits apiece.
// Three is the ceiling the app's league picker enforces, repeated here because
// the browser is not where a spend limit belongs.
const MAX_SPORTS_PER_REQUEST = 3;
const DEFAULT_CACHE_SECONDS = 900;
// The sports catalogue is free to fetch and changes on the order of days.
const SPORTS_LIST_CACHE_SECONDS = 3600;
const FREE_TIER_DAILY_LIMIT = 3;

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  const allow = allowed.includes(origin) ? origin : allowed[0] ?? '';

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

async function enrichMmaEvents(events, ctx) {
  if (!events || !Array.isArray(events)) return events;

  const enriched = await Promise.all(
    events.map(async (event) => {
      const commenceMs = event.commence_time
        ? new Date(event.commence_time).getTime()
        : null;
      const eventDetails = await getUfcEventDetails(
        event.home_team,
        event.away_team,
        commenceMs,
      );
      return eventDetails ? { ...event, ufc_event: eventDetails } : event;
    }),
  );

  return enriched;
}

async function enrichBaseballEvents(events, ctx) {
  if (!events || !Array.isArray(events)) return events;

  const enriched = await Promise.all(
    events.map(async (event) => {
      // Try to extract pitcher info from bookmaker data if available
      // Odds API doesn't include pitchers, so we'll note that for manual future enhancement
      const baseballContext = await fetchBaseballContext(
        {
          awayTeam: event.away_team,
          homeTeam: event.home_team,
          awayPitcher: null, // TODO: Pull from external source when available
          homePitcher: null,
        },
        ctx,
      );
      return baseballContext
        ? { ...event, baseball_context: baseballContext }
        : event;
    }),
  );

  return enriched;
}

async function fetchSport(sport, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${sport}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const ttl = Number(env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  const cacheKey = new Request(
    `https://pixel-pick.cache/odds/${sport}?markets=${MARKETS}&regions=${REGIONS}`,
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    let events = await cached.json();
    if (sport === 'mma_mixed_martial_arts') {
      events = await enrichMmaEvents(events, ctx);
    } else if (sport === 'baseball_mlb') {
      events = await enrichBaseballEvents(events, ctx);
    }
    return { events, cached: true, quota: null };
  }

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    const detail = await upstream.text();
    return { error: { sport, status: upstream.status, detail: detail.slice(0, 300) } };
  }

  let events = await upstream.json();
  const quota = {
    remaining: upstream.headers.get('x-requests-remaining'),
    used: upstream.headers.get('x-requests-used'),
    lastCost: upstream.headers.get('x-requests-last'),
  };

  if (sport === 'mma_mixed_martial_arts') {
    events = await enrichMmaEvents(events, ctx);
  } else if (sport === 'baseball_mlb') {
    events = await enrichBaseballEvents(events, ctx);
  }

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

/**
 * Completed/live scores for a sport, used to grade tracked picks client-side.
 * `daysFrom=3` is the widest lookback The Odds API's scores endpoint takes —
 * plenty, since picks are graded the same day or the next. Cached for 5
 * minutes regardless of CACHE_SECONDS: scores don't need odds-tap freshness,
 * and this keeps repeated "check results" taps from burning credits.
 */
async function fetchScores(sport, env, ctx) {
  const ttl = 300;
  const cacheKey = new Request(`https://pixel-pick.cache/scores/${sport}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return { events: await cached.json(), cached: true };

  const url = new URL(`${UPSTREAM}/sports/${sport}/scores`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('daysFrom', '3');
  url.searchParams.set('dateFormat', 'iso');

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    const detail = await upstream.text();
    return { error: { sport, status: upstream.status, detail: detail.slice(0, 300) } };
  }

  const events = await upstream.json();

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(events), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  return { events, cached: false };
}

async function handleScores(request, env, ctx, cors) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get('sports') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isAllowedSport);

  if (!requested.length) {
    return json({ error: 'No valid sports requested.' }, { status: 400, headers: cors });
  }

  const sports = [...new Set(requested)];
  const results = await Promise.all(sports.map((s) => fetchScores(s, env, ctx)));

  const events = [];
  const errors = [];
  for (const result of results) {
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    events.push(...result.events);
  }

  if (!events.length && errors.length) {
    return json({ error: 'Upstream scores request failed', errors }, { status: 502, headers: cors });
  }

  return json(
    { events, sports, errors },
    { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
  );
}

/**
 * A tennis event's alternate_spreads market — a wider ladder of game-margin
 * handicaps than the featured 'spreads' market carries, not a sets-won
 * market. (There isn't one: The Odds API's own docs describe
 * alternate_spreads as "all available point spread outcomes" — the same
 * game-margin axis, just denser — and a live match's ladder ran to ±9.5,
 * which is impossible as a sets margin in any tennis format, best-of-3 or
 * best-of-5.)
 *
 * The Odds API doesn't carry this on the featured board endpoint at all
 * (confirmed by direct probe: /odds only ever returns h2h, spreads, totals
 * for tennis). It only shows up on the per-event endpoint, which is billed
 * per event (1 credit/market/region here) rather than per league — which is
 * why this is its own route, called lazily and only for a bounded few
 * matches already on the board, not folded into fetchSport's per-league pull.
 */
async function fetchTennisAltSpread(sportKey, eventId, env, ctx) {
  const ttl = 3600; // an alternate-spread price doesn't need per-tap freshness
  const cacheKey = new Request(
    `https://pixel-pick.cache/altspread/${sportKey}/${eventId}`,
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return { event: await cached.json(), cached: true };

  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events/${eventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', 'alternate_spreads');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const upstream = await fetch(url.toString());
  if (!upstream.ok) return { event: null, cached: false };

  const event = await upstream.json();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(event), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );
  return { event, cached: false };
}

function jwtSecret() {
  // In production, use a secret from env.SECRET
  return 'pixel-pick-dev-secret-change-in-production';
}

async function handleSignup(request, env) {
  try {
    const { email, password, phone } = await request.json();

    if (!email || !password || !phone) {
      return json({ error: 'email, password, and phone required' }, { status: 400 });
    }

    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (user) {
      return json({ error: 'Email already registered' }, { status: 409 });
    }

    const id = generateId();
    const passwordHash = await hashPassword(password);
    const totpSecret = generateTOTPSecret();

    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, phone_number, totp_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, email, passwordHash, phone, totpSecret, Date.now(), Date.now())
      .run();

    const otpauth = getTOTPQRCode(email, totpSecret);

    return json({ userId: id, qrCode: otpauth, totpSecret }, { status: 201 });
  } catch (e) {
    console.error('Signup error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

async function handleVerify2FA(request, env) {
  try {
    const { userId, totp } = await request.json();

    if (!userId || !totp) {
      return json({ error: 'userId and totp required' }, { status: 400 });
    }

    const user = await env.DB.prepare('SELECT totp_secret, verified FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!user) {
      return json({ error: 'User not found' }, { status: 404 });
    }

    if (user.verified) {
      return json({ error: 'User already verified' }, { status: 400 });
    }

    if (!verifyTOTPToken(user.totp_secret, totp)) {
      return json({ error: 'Invalid TOTP code' }, { status: 401 });
    }

    await env.DB.prepare('UPDATE users SET verified = 1, updated_at = ? WHERE id = ?')
      .bind(Date.now(), userId)
      .run();

    return json({ ok: true });
  } catch (e) {
    console.error('Verify 2FA error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

async function handleSignin(request, env) {
  try {
    const { email, password, totp } = await request.json();

    if (!email || !password) {
      return json({ error: 'email and password required' }, { status: 400 });
    }

    const user = await env.DB.prepare(
      'SELECT id, password_hash, totp_secret, verified FROM users WHERE email = ?',
    )
      .bind(email)
      .first();

    if (!user) {
      return json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const pwValid = await verifyPassword(password, user.password_hash);
    if (!pwValid) {
      return json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (!user.verified) {
      return json({ error: 'Email not verified', userId: user.id }, { status: 403 });
    }

    if (!totp) {
      return json({ error: 'TOTP code required', userId: user.id, needsTOTP: true }, { status: 403 });
    }

    if (!verifyTOTPToken(user.totp_secret, totp)) {
      return json({ error: 'Invalid TOTP code' }, { status: 401 });
    }

    const token = generateJWT(
      { userId: user.id, email, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
      jwtSecret(),
    );

    return json({ token, userId: user.id });
  } catch (e) {
    console.error('Signin error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

async function handleMe(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyJWT(token, jwtSecret());

  if (!payload) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const user = await env.DB.prepare('SELECT id, email, phone_number FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();

    if (!user) {
      return json({ error: 'User not found' }, { status: 404 });
    }

    return json({ id: user.id, email: user.email, phone: user.phone_number });
  } catch (e) {
    console.error('Me error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

/** Sign-in is only enforced once REQUIRE_AUTH is switched on in wrangler.toml. */
const authRequired = (env) => String(env.REQUIRE_AUTH ?? '') === 'true';

async function handleOdds(request, env, ctx) {
  const cors = corsHeaders(request, env);

  if (!authRequired(env)) {
    return respondWithOdds(request, env, ctx, cors, null);
  }

  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyJWT(token, jwtSecret());

  if (!payload) {
    return json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  // Check quota via Durable Object
  const quotaId = env.QUOTA_MANAGER.idFromName(payload.userId);
  const quotaObj = env.QUOTA_MANAGER.get(quotaId);

  const checkRes = await quotaObj.fetch(
    new Request('http://quota/check', {
      method: 'POST',
      body: JSON.stringify({ userId: payload.userId, limit: FREE_TIER_DAILY_LIMIT }),
    }),
  );
  const quotaStatus = await checkRes.json();

  if (!quotaStatus.allowed) {
    return json(
      { error: 'Daily quota exceeded', remaining: 0, used: quotaStatus.used },
      { status: 429, headers: cors },
    );
  }

  // Increment usage
  await quotaObj.fetch(
    new Request('http://quota/increment', {
      method: 'POST',
      body: JSON.stringify({ userId: payload.userId }),
    }),
  );

  return respondWithOdds(request, env, ctx, cors, quotaStatus);
}

/** The actual odds fan-out, shared by the authed and open paths. */
async function respondWithOdds(request, env, ctx, cors, quotaStatus) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get('sports') ?? 'upcoming')
    .split(',')
    .map((s) => s.trim())
    .filter(isAllowedSport);

  if (!requested.length) {
    return json(
      { error: 'No valid sports requested.', allowed: [...ALLOWED_SPORTS] },
      { status: 400, headers: cors },
    );
  }

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

  if (!events.length && errors.length) {
    return json({ error: 'Upstream odds request failed', errors }, { status: 502, headers: cors });
  }

  return json(
    {
      events,
      sports,
      cached: allCached,
      quota,
      errors,
      fetchedAt: new Date().toISOString(),
      ...(quotaStatus
        ? { remaining: quotaStatus.remaining - 1, used: quotaStatus.used + 1 }
        : {}),
    },
    {
      headers: {
        ...cors,
        'Cache-Control': `public, max-age=${env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}`,
      },
    },
  );
}

/**
 * The catalogue of leagues the app may request. The Odds API bills nothing for
 * this endpoint, so the picker can be populated on page load without touching
 * the credit budget — and it stays correct as tournaments come and go.
 */
async function handleSports(env, ctx, cors) {
  const cacheKey = new Request('https://pixel-pick.cache/sports');
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return json({ sports: await cached.json(), cached: true }, { headers: cors });
  }

  const url = new URL(`${UPSTREAM}/sports`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    return json(
      { error: 'Could not load the sports catalogue', status: upstream.status },
      { status: 502, headers: cors },
    );
  }

  const sports = (await upstream.json())
    .filter((s) => s.active && !s.has_outrights && isAllowedSport(s.key))
    .map(({ key, title, group }) => ({ key, title, group }));

  // 'upcoming' is synthetic — it isn't in the catalogue but it is requestable,
  // and it's the cheapest way to see what starts next across everything.
  sports.unshift({ key: 'upcoming', title: 'Next up (all sports)', group: 'Any' });

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(sports), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${SPORTS_LIST_CACHE_SECONDS}`,
        },
      }),
    ),
  );

  return json({ sports, cached: false }, { headers: cors });
}

export { QuotaManager };

const MORNING_PREWARM_HOUR = 4; // 4am ET

/** ET wall-clock hour for a given instant — same self-correcting-across-DST
 * approach as potd.js's own etParts, kept local since this is the only other
 * place in the worker that needs an ET hour rather than a UTC one. */
function etHour(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  return Number(fmt.format(ms)) % 24;
}

export default {
  /**
   * Fires hourly (see wrangler.toml's [triggers]) — most ticks are a no-op.
   * currentPhase / etHour check the actual ET wall-clock hour, so both self-
   * correct across DST without a UTC cron needing hand-maintenance twice a
   * year.
   */
  async scheduled(event, env, ctx) {
    const now = event.scheduledTime ?? Date.now();

    // 4am ET: pre-warm the 'upcoming' board (the same "next games across
    // every sport" pull the Full Slate/Pixel Picks tabs make on their own
    // first tap) so it's already cached before anyone's awake, rather than
    // the very first user of the day paying for a cold fetch. This is a
    // cache warm, not a bigger pull than normal — it fetches exactly what
    // 'upcoming' already means, once, and normal on-demand 15-minute
    // caching carries the rest of the day exactly as it does today.
    if (etHour(now) === MORNING_PREWARM_HOUR) {
      ctx.waitUntil(fetchSport('upcoming', env, ctx));
    }

    const phase = currentPhase(now);
    if (!phase) return;

    ctx.waitUntil(
      runPotdPhase(phase, {
        env,
        ctx,
        now,
        fetchBoard: async () => {
          const { events, error } = await fetchSport('upcoming', env, ctx);
          if (error) throw new Error(`PoTD board fetch failed: ${JSON.stringify(error)}`);
          return events;
        },
      }),
    );
  },

  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    if (pathname === '/api/auth/signup' && request.method === 'POST') {
      const res = await handleSignup(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/verify-2fa' && request.method === 'POST') {
      const res = await handleVerify2FA(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/signin' && request.method === 'POST') {
      const res = await handleSignin(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const res = await handleMe(request, env);
      return new Response(res.body, { status: res.status, headers: { ...cors, ...Object.fromEntries(res.headers) } });
    }

    if (pathname === '/context') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const sportKey = searchParams.get('sport') ?? '';

      if (!hasContext(sportKey)) {
        return json({ context: null, reason: 'unsupported sport' }, { headers: cors });
      }

      try {
        const context = await fetchContext(
          {
            sportKey,
            home: searchParams.get('home') ?? '',
            away: searchParams.get('away') ?? '',
          },
          ctx,
        );
        return json(
          { context },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=900' } },
        );
      } catch (error) {
        // Context is a bonus, never a blocker: a card without it is still a card.
        return json({ context: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Live venue weather for one NFL/MLB fixture, from the National Weather
    // Service — free, no key, no odds credit. Only ever asked for the two
    // outdoor US sports this app has a venue table for; every other sport
    // (and a game further out than NWS forecasts reach) gets null, not a
    // guess.
    if (pathname === '/weather') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const sportKey = searchParams.get('sport') ?? '';
      const homeTeam = searchParams.get('home') ?? '';
      const commenceMs = Number(searchParams.get('commenceMs') ?? '');

      if (!hasVenue(sportKey) || !homeTeam || !Number.isFinite(commenceMs)) {
        return json({ weather: null, reason: 'unsupported sport or missing params' }, { headers: cors });
      }

      try {
        const weather = await fetchWeather({ sportKey, homeTeam, commenceMs }, ctx);
        return json(
          { weather },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=1800' } },
        );
      } catch (error) {
        return json({ weather: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // MMA fighter research (UFC/PFL/DWCS — the Odds API bundles all of them
    // under one key, with no way to tell them apart at that layer). Free —
    // it reads Sherdog, not the odds feed.
    // AI-written matchup analysis, one per game per ET calendar day — see
    // analysis.js for the full design. Free to the client (reads/writes KV,
    // never touches the odds feed); the real cost is the model call itself,
    // which only happens on that game's first request of the day.
    if (pathname === '/analysis') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const candidate = {
        eventId: searchParams.get('eventId') ?? '',
        sportKey: searchParams.get('sportKey') ?? '',
        sportTitle: searchParams.get('sportTitle') ?? '',
        home: searchParams.get('home') ?? '',
        away: searchParams.get('away') ?? '',
      };
      if (!candidate.eventId || !candidate.sportKey || !candidate.home || !candidate.away) {
        return json({ analysis: null, reason: 'missing eventId/sportKey/home/away' }, { headers: cors });
      }
      try {
        const analysis = await getOrGenerateAnalysis(candidate, env, ctx);
        return json(
          { analysis },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ analysis: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    if (pathname === '/mma-context') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      try {
        const context = await fetchMmaContext(
          {
            fighterA: searchParams.get('a') ?? '',
            fighterB: searchParams.get('b') ?? '',
          },
          ctx,
        );
        return json(
          { context },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ context: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Today's Play of the Day — written by the scheduled() cron, read-only
    // here. Free: reads KV, never touches the odds feed on this path.
    if (pathname === '/potd') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      try {
        const potd = await getPotd(env);
        return json(
          { potd },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ potd: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // One Play of the Day per major sport, alongside the single pick above —
    // same read-only KV path, same free cost.
    if (pathname === '/potd-by-sport') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      try {
        const bySport = await getPotdBySport(env);
        return json(
          { bySport },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ bySport: {}, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Tennis alternate-spread ladder for one match already on the board.
    // Costs a real odds credit (unlike /context and /mma-context) — app.js
    // calls this for only a small, score-ranked slice of the tennis matches
    // it already has, never the whole tour.
    if (pathname === '/tennis-alt-spread') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      const { searchParams } = new URL(request.url);
      const sportKey = searchParams.get('sport') ?? '';
      const eventId = searchParams.get('eventId') ?? '';

      if (!isAllowedSport(sportKey) || !/^tennis_/.test(sportKey) || !eventId) {
        return json({ event: null, reason: 'invalid sport or eventId' }, { headers: cors });
      }

      try {
        const { event } = await fetchTennisAltSpread(sportKey, eventId, env, ctx);
        return json(
          { event },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ event: null, reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // MLB team stats endpoint
    if (pathname === '/mlb-stats' && request.method === 'GET') {
      const { searchParams } = new URL(request.url);
      const teamAbbr = searchParams.get('team') ?? '';

      if (!teamAbbr) {
        return json({ error: 'team parameter required' }, { status: 400, headers: cors });
      }

      try {
        const [teamStats, recentSchedule] = await Promise.all([
          fetchTeamStats(teamAbbr, ctx),
          fetchRecentSchedule(teamAbbr, ctx),
        ]);

        return json(
          { teamStats, recentSchedule },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json(
          { error: String(error).slice(0, 120) },
          { status: 500, headers: cors },
        );
      }
    }

    // Learning endpoints: archive picks and record outcomes
    if (pathname === '/api/learning/archive-pick' && request.method === 'POST') {
      try {
        const pick = await request.json();
        const pickId = `pick:${pick.eventId}:${pick.sportKey}`;
        const archive = {
          ...pick,
          timestamp: Date.now(),
        };
        ctx.waitUntil(env.POTD_KV.put(pickId, JSON.stringify(archive), { expirationTtl: 86400 * 365 }));
        return json({ archived: true }, { status: 201, headers: cors });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 400, headers: cors });
      }
    }

    if (pathname === '/api/learning/record-outcome' && request.method === 'POST') {
      try {
        const { eventId, sportKey, result } = await request.json();
        if (!eventId || !sportKey || !result) {
          return json({ error: 'eventId, sportKey, result required' }, { status: 400, headers: cors });
        }
        const pickId = `pick:${eventId}:${sportKey}`;
        const archived = await env.POTD_KV.get(pickId);
        if (!archived) {
          return json({ error: 'Pick not found' }, { status: 404, headers: cors });
        }
        const pick = JSON.parse(archived);
        pick.result = result;
        pick.resolvedAt = Date.now();
        ctx.waitUntil(env.POTD_KV.put(pickId, JSON.stringify(pick), { expirationTtl: 86400 * 365 }));
        return json({ recorded: true }, { status: 200, headers: cors });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 400, headers: cors });
      }
    }

    if (pathname === '/api/learning/calibration' && request.method === 'GET') {
      try {
        // Placeholder: would need to scan picks from KV
        return json(
          {
            note: 'Calibration requires picks database integration',
            overallAccuracy: null,
            sampleSize: 0,
          },
          { status: 200, headers: cors },
        );
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
      }
    }

    if (pathname === '/odds' || pathname === '/sports' || pathname === '/scores') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      if (!env.ODDS_API_KEY) {
        return json(
          { error: 'Proxy is missing ODDS_API_KEY. Set it with: wrangler secret put ODDS_API_KEY' },
          { status: 500, headers: cors },
        );
      }
      if (pathname === '/sports') return handleSports(env, ctx, cors);
      if (pathname === '/scores') return handleScores(request, env, ctx, cors);
      return handleOdds(request, env, ctx);
    }

    return json(
      { error: 'Not found. Try GET /sports or GET /odds?sports=upcoming' },
      { status: 404, headers: cors },
    );
  },
};
