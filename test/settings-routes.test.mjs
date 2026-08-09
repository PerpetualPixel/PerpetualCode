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

const ORIGIN = 'https://miguelsgarcia4.github.io';
const PASS = 'test-owner-passphrase';

function makeEnv({ passphrase = PASS, store = new Map() } = {}) {
  return {
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8080`,
    OWNER_PASSPHRASE: passphrase,
    POTD_KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
    _store: store,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

function call(path, { method = 'GET', key, body } = {}) {
  const headers = { Origin: ORIGIN };
  if (key !== undefined) headers['X-Owner-Key'] = key;
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

test('GET /settings without a key is refused, never served openly', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings'), env, ctx);
  assert.equal(res.status, 401);
});

test('GET /settings with the right key returns null before anything is saved', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings', { key: PASS }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).settings, null);
});

test('PUT then GET round-trips the bankroll through the real routes', async () => {
  const env = makeEnv();
  const put = await worker.fetch(
    call('/settings', { method: 'PUT', key: PASS, body: { bankroll: { amount: 2500, unit: 50, displayMode: 'units', confirmed: true } } }),
    env, ctx,
  );
  assert.equal(put.status, 200);

  const res = await worker.fetch(call('/settings', { key: PASS }), env, ctx);
  const { settings } = await res.json();
  assert.equal(settings.bankroll.amount, 2500);
  assert.equal(settings.bankroll.unit, 50);
  assert.equal(settings.bankroll.displayMode, 'units');
  assert.equal(settings.bankroll.confirmed, true);
});

test('PUT /settings with a wrong key does not write anything', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    call('/settings', { method: 'PUT', key: 'nope', body: { bankroll: { amount: 999 } } }),
    env, ctx,
  );
  assert.equal(res.status, 401);
  assert.equal(env._store.size, 0);
});

test('/settings answers 503 (not 200, not a crash) when the deployment has no passphrase configured', async () => {
  const env = makeEnv({ passphrase: '' });
  const res = await worker.fetch(call('/settings', { key: 'anything' }), env, ctx);
  assert.equal(res.status, 503);
});

test('PUT /settings rejects a non-JSON body rather than storing garbage', async () => {
  const env = makeEnv();
  const req = new Request('https://worker.dev/settings', {
    method: 'PUT',
    headers: { Origin: ORIGIN, 'X-Owner-Key': PASS, 'Content-Type': 'application/json' },
    body: 'not json at all',
  });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 400);
  assert.equal(env._store.size, 0);
});

test('settings responses are marked no-store so a bankroll is never cached by an intermediary', async () => {
  const env = makeEnv();
  const res = await worker.fetch(call('/settings', { key: PASS }), env, ctx);
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
