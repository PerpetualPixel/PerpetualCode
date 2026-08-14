/**
 * Route-level tests for /settings and the disabled /top5-reset, driving the
 * Worker's own fetch handler directly. Complements test/settings.test.mjs,
 * which covers the storage module in isolation — these cover the wiring that
 * module tests can't see: path/method matching, the auth gate's status codes,
 * and the CORS headers a browser preflight depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import { generateJWT } from '../worker/src/auth-email.js';

const ORIGIN = 'https://miguelsgarcia4.github.io';
const PASS = 'test-owner-passphrase';
const JWT_SECRET = 'test-jwt-secret';

// /settings authenticates with a per-account JWT now (see worker/src/
// index.js's /settings route and settings.js's own module header — the
// X-Owner-Key check these tests originally exercised is "no longer used by
// /settings"), so the fixture mints a real signed token and stubs the D1
// session-epoch lookup authenticateRequest performs.
const TOKEN = generateJWT({ userId: 'test-user', epoch: 0 }, JWT_SECRET);

function makeEnv({ passphrase = PASS, store = new Map(), userRow = { session_epoch: 0 } } = {}) {
  return {
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8080`,
    OWNER_PASSPHRASE: passphrase,
    JWT_SECRET,
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => userRow }) }),
    },
    POTD_KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
    _store: store,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

function call(path, { method = 'GET', key, token, body } = {}) {
  const headers = { Origin: ORIGIN };
  if (key !== undefined) headers['X-Owner-Key'] = key;
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://worker.dev${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/* ---------------------------------------------------------------- */
/* /settings                                                         */
/* ---------------------------------------------------------------- */

test('GET /settings without credentials is refused, never served openly', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings'), env, ctx);
  assert.equal(res.status, 401);
});

test('GET /settings with a valid account token returns null before anything is saved', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings', { token: TOKEN }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).settings, null);
});

test('PUT then GET round-trips the bankroll through the real routes', async () => {
  const env = makeEnv();
  const put = await worker.fetch(
    call('/settings', { method: 'PUT', token: TOKEN, body: { bankroll: { amount: 2500, unit: 50, displayMode: 'units', confirmed: true } } }),
    env, ctx,
  );
  assert.equal(put.status, 200);

  const res = await worker.fetch(call('/settings', { token: TOKEN }), env, ctx);
  const { settings } = await res.json();
  assert.equal(settings.bankroll.amount, 2500);
  assert.equal(settings.bankroll.unit, 50);
  assert.equal(settings.bankroll.displayMode, 'units');
  assert.equal(settings.bankroll.confirmed, true);
});

test('PUT /settings with a forged token does not write anything', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    call('/settings', { method: 'PUT', token: 'not-a-real-token', body: { bankroll: { amount: 999 } } }),
    env, ctx,
  );
  assert.equal(res.status, 401);
  assert.equal(env._store.size, 0);
});

test('the old X-Owner-Key no longer opens /settings — auth is per-account now', async () => {
  // The owner passphrase predates accounts and still gates the admin
  // routes, but /settings is per-user data keyed by the JWT's userId; the
  // shared key must not read anyone's bankroll.
  const env = makeEnv();
  const res = await worker.fetch(call('/settings', { key: PASS }), env, ctx);
  assert.equal(res.status, 401);
});

test('a valid-signature token for a deleted account is refused', async () => {
  // authenticateRequest checks the account still exists (and its session
  // epoch) in D1 — a token that outlives its account dies with it.
  const env = makeEnv({ userRow: null });
  const res = await worker.fetch(call('/settings', { token: TOKEN }), env, ctx);
  assert.equal(res.status, 401);
});

test('PUT /settings rejects a non-JSON body rather than storing garbage', async () => {
  const env = makeEnv();
  const req = new Request('https://worker.dev/settings', {
    method: 'PUT',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: 'not json at all',
  });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 400);
  assert.equal(env._store.size, 0);
});

test('settings responses are marked no-store so a bankroll is never cached by an intermediary', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings', { token: TOKEN }), env, ctx);
  assert.match(res.headers.get('Cache-Control') ?? '', /no-store/);
});

/* ---------------------------------------------------------------- */
/* CORS — a browser can't reach /settings without these              */
/* ---------------------------------------------------------------- */

test('preflight advertises PUT and X-Owner-Key, which the browser requires before sending either', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings', { method: 'OPTIONS' }), env, ctx);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Methods') ?? '', /PUT/);
  assert.match(res.headers.get('Access-Control-Allow-Headers') ?? '', /X-Owner-Key/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

/* ---------------------------------------------------------------- */
/* /top5-reset stays closed                                          */
/* ---------------------------------------------------------------- */

test('POST /top5-reset is refused — an open reset could wipe all tracking', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/top5-reset', { method: 'POST' }), env, ctx);
  assert.equal(res.status, 403);
});

test('/top5-reset stays closed even when a valid owner key is supplied', async () => {
  // The reset is disabled outright, not merely owner-gated: re-enabling is a
  // deliberate code change, so no credential should open it.
  const env = makeEnv();
  const res = await worker.fetch(call('/top5-reset', { method: 'POST', key: PASS }), env, ctx);
  assert.equal(res.status, 403);
});

/* ---------------------------------------------------------------- */
/* Owner-gated admin routes                                          */
/* ---------------------------------------------------------------- */

/**
 * These exercise the route WIRING, not the sweep's logic (that lives in
 * test/tennis-espn.test.mjs and test/full-slate-tracking.test.mjs).
 *
 * Worth having because a route body is the one place a plain
 * ReferenceError can ship green: /admin/regrade-tennis originally read
 * `url.searchParams`, but the fetch handler destructures only `pathname`
 * from the request URL, so `url` was never defined. Every module test
 * passed and the endpoint 500'd on its first real call.
 */
const ADMIN_ROUTES = ['/admin/regrade-tennis', '/admin/grade-now'];

for (const path of ADMIN_ROUTES) {
  test(`${path} rejects a wrong owner key`, async () => {
    const res = await worker.fetch(call(path, { method: 'POST', key: 'nope' }), makeEnv(), ctx);
    assert.equal(res.status, 401);
  });

  test(`${path} runs to a real response with a valid key`, async () => {
    const res = await worker.fetch(call(path, { method: 'POST', key: PASS }), makeEnv(), ctx);
    const body = await res.json();
    // The sweep itself finds nothing in an empty KV — the point is that the
    // handler executes end to end instead of throwing.
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, undefined, `handler threw: ${body.error}`);
  });
}

test('/admin/regrade-tennis reads its resume offset from the query string', async () => {
  const res = await worker.fetch(
    call('/admin/regrade-tennis?offset=88&days=90', { method: 'POST', key: PASS }),
    makeEnv(),
    ctx,
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  // Starting at day 88 of a 90-day range leaves 2 days to walk, so the
  // range completes and the caller is told there's nothing left.
  assert.equal(body.regraded.fullSlate.daysWalked, 2);
  assert.equal(body.nextOffsetDays, null);
  assert.equal(body.done, true);
});
