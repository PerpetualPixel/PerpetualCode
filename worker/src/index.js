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

const MARKETS = 'h2h,spreads,totals';
const REGIONS = 'us';
const MAX_SPORTS_PER_REQUEST = 4;
const DEFAULT_CACHE_SECONDS = 300;
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

async function handleOdds(request, env, ctx) {
  const cors = corsHeaders(request, env);
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

  const { pathname, searchParams } = new URL(request.url);
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
      remaining: quotaStatus.remaining - 1,
      used: quotaStatus.used + 1,
    },
    {
      headers: {
        ...cors,
        'Cache-Control': `public, max-age=${env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}`,
      },
    },
  );
}

export { QuotaManager };

export default {
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

    if (pathname === '/odds') {
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
      return handleOdds(request, env, ctx);
    }

    return json(
      { error: 'Not found. Try POST /api/auth/signup or GET /odds (with auth)' },
      { status: 404, headers: cors },
    );
  },
};
