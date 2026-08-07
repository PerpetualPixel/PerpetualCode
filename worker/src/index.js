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
import {
  fetchTeamStats,
  fetchRecentSchedule,
  fetchLeagueStats,
  refreshMlbLeagueStats,
  fetchSituationalSplits,
  rankTeamStats,
  fetchHeadToHead,
  fetchStartingPitchers,
  fetchPitcherOutings,
} from './mlb-stats.js';
import { POTD_HOUR, runPotdDaily, runPotdClvSnapshot, runPotdGrading, getPotd, getPotdHistory } from './potd.js';
import { getOrGenerateAnalysis } from './analysis.js';
import {
  UPSTREAM,
  REGIONS,
  DEFAULT_CACHE_SECONDS,
  isAllowedSport,
  ALLOWED_SPORTS,
  fetchSport,
  fetchScores,
  fetchCatalogue,
} from './odds.js';
import {
  runTop5Batch,
  runClvSnapshot,
  runGrading,
  getTop5,
  getAllTrackedPicks,
  resetAllTracking,
  fetchFullSlateEvents,
  TOP5_BATCH_HOUR,
} from './tracking.js';

// Each sport is a separate billed call: 3 markets x 1 region = 3 credits apiece.
// Three is the ceiling the app's league picker enforces, repeated here because
// the browser is not where a spend limit belongs.
const MAX_SPORTS_PER_REQUEST = 3;
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
  const { sports, cached, error } = await fetchCatalogue(env, ctx);
  if (error) {
    return json(
      { error: 'Could not load the sports catalogue', status: error.status },
      { status: 502, headers: cors },
    );
  }
  return json({ sports, cached: Boolean(cached) }, { headers: cors });
}

export { QuotaManager };

const MORNING_PREWARM_HOUR = 4; // 4am ET
const MLB_LEAGUE_STATS_HOUR = 3; // 3am ET

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
   * etHour checks the actual ET wall-clock hour, so every gated task below
   * self-corrects across DST without a UTC cron needing hand-maintenance
   * twice a year.
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

    // 3am ET: refresh the league-wide MLB batting/pitching snapshot "View
    // Stats" ranks every team against. Has to run standalone, with nothing
    // else in the same invocation — fetching all 30 teams alongside a live
    // request's own schedule/situational calls blew Cloudflare's per-
    // invocation subrequest cap (confirmed live). The result is one KV blob;
    // a live /mlb-stats request only ever reads it, never re-fetches it.
    if (etHour(now) === MLB_LEAGUE_STATS_HOUR) {
      ctx.waitUntil(refreshMlbLeagueStats(env, ctx));
    }

    // 2am ET: the day's locked Pixel's Picks — same engine, same sharp
    // standard and EV/Kelly floor as always, just run once server-side
    // instead of live per-request so the board never changes after the
    // fact (the client's Pixel's Picks tab now renders this same set — see
    // docs/app.js's loadPixelPicks()). runTop5Batch is itself idempotent
    // per ET day (checks its own manifest key), so a retried or overlapping
    // tick can't double-generate.
    if (etHour(now) === TOP5_BATCH_HOUR) {
      ctx.waitUntil(runTop5Batch(env, ctx, now));
    }

    // Every hour: refresh the closing-line snapshot for whatever's still
    // pending and not yet underway, and grade whatever now has a completed
    // score. Both are safe to run every tick — CLV only touches games that
    // haven't started, grading only touches picks still pending — so
    // there's no "already ran today" gate needed the way the 6am batch has.
    // Same reasoning applies to Play of the Day's own CLV/grading below.
    ctx.waitUntil(runClvSnapshot(env, ctx, now));
    ctx.waitUntil(runGrading(env, ctx, now));
    ctx.waitUntil(runPotdClvSnapshot(env, ctx, now));
    ctx.waitUntil(runPotdGrading(env, ctx, now));

    // 2am ET: the single Play of the Day pick — scans the same full slate
    // the Top 5 batch does (fetchFullSlateEvents), restricted to a
    // moneyline-friendly -200..+150 band. runPotdDaily is itself idempotent
    // per ET day (checks its own KV key), so a retried or overlapping tick
    // can't double-generate.
    if (etHour(now) === POTD_HOUR) {
      ctx.waitUntil(
        runPotdDaily(env, ctx, now, { fetchFullSlate: () => fetchFullSlateEvents(env, ctx) }),
      );
    }
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
        // The side this app's own pricing already picked — the model builds
        // its case around this rather than independently guessing (see
        // worker/src/analysis.js), so the write-up can never disagree with
        // the pick shown next to it.
        outcomeName: searchParams.get('outcomeName') ?? '',
      };
      if (!candidate.eventId || !candidate.sportKey || !candidate.home || !candidate.away || !candidate.outcomeName) {
        return json({ analysis: null, reason: 'missing eventId/sportKey/home/away/outcomeName' }, { headers: cors });
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

    // Every Play of the Day pick still in KV (up to 90 days) — the raw
    // material for the Tracking Dashboard's Play of the Day section.
    // Read-only, KV only, no odds credit.
    if (pathname === '/potd-history') {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, { status: 405, headers: cors });
      }
      try {
        const picks = await getPotdHistory(env);
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Today's server-side tracked Top 5 — written by the scheduled() cron's
    // 6am batch, updated by its hourly CLV/grading passes, read-only here.
    // Independent of the client's own browser-local IndexedDB tracking (see
    // docs/learning.js) — this is the one shared history that exists
    // whether or not anyone has the app open.
    if (pathname === '/top5' && request.method === 'GET') {
      try {
        const picks = await getTop5(env);
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Every tracked pick still in KV (up to 90 days) — the raw material for
    // the client's calibration/audit reporting view (Brier score, CLV
    // correlation, segmented accuracy). Read-only, KV only, no odds credit.
    if (pathname === '/top5-history' && request.method === 'GET') {
      try {
        const picks = await getAllTrackedPicks(env);
        return json(
          { picks },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return json({ picks: [], reason: String(error).slice(0, 120) }, { headers: cors });
      }
    }

    // Explicit, user-triggered wipe of the server-side Top 5 tracking
    // history — the counterpart to the client's local "Archive & Reset"
    // button. Never run on a schedule; only ever hit by that button.
    if (pathname === '/top5-reset' && request.method === 'POST') {
      try {
        const result = await resetAllTracking(env);
        return json({ ...result }, { headers: cors });
      } catch (error) {
        return json({ error: String(error).slice(0, 120) }, { status: 500, headers: cors });
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
      // The opponent, for the Starting Pitchers section (both teams' probable
      // starter for this specific matchup) and, once the client opens the
      // Head-to-Head tab, for scanning the requesting team's whole-season
      // schedule for their meetings — sent on every call since it's cheap
      // (same schedule fetch either way), but headToHead itself only
      // computed when explicitly asked for.
      const opponentAbbr = searchParams.get('opponent') ?? '';
      const wantHeadToHead = searchParams.get('h2h') === '1';

      if (!teamAbbr) {
        return json({ error: 'team parameter required' }, { status: 400, headers: cors });
      }

      try {
        const [teamStats, leagueStats, recentSchedule, situational, headToHead, startingPitchers] = await Promise.all([
          fetchTeamStats(teamAbbr, ctx),
          fetchLeagueStats(env),
          fetchRecentSchedule(teamAbbr, ctx),
          fetchSituationalSplits(teamAbbr, ctx),
          wantHeadToHead && opponentAbbr ? fetchHeadToHead(teamAbbr, opponentAbbr, ctx) : Promise.resolve(null),
          opponentAbbr ? fetchStartingPitchers(teamAbbr, opponentAbbr, ctx) : Promise.resolve(null),
        ]);

        // Ranked server-side against all 30 teams so the client only ever
        // gets {value, rank} pairs, not the full league's raw numbers.
        const rankedStats = teamStats ? rankTeamStats(teamStats, leagueStats) : null;

        return json(
          { teamStats: rankedStats, recentSchedule, situational, headToHead, startingPitchers },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json(
          { error: String(error).slice(0, 120) },
          { status: 500, headers: cors },
        );
      }
    }

    // A single pitcher's last 5 real outings — lazy-loaded only once the
    // client opens that drilldown, same reasoning as head-to-head above.
    if (pathname === '/mlb-pitcher-outings' && request.method === 'GET') {
      const { searchParams } = new URL(request.url);
      const playerId = searchParams.get('player') ?? '';
      if (!playerId) {
        return json({ error: 'player parameter required' }, { status: 400, headers: cors });
      }
      try {
        const outings = await fetchPitcherOutings(playerId, ctx);
        return json(
          { outings },
          { headers: { ...cors, 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch (error) {
        return json({ outings: [], reason: String(error).slice(0, 120) }, { headers: cors });
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
