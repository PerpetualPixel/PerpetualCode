import test from 'node:test';
import assert from 'node:assert/strict';

import { authorize, getSettings, putSettings } from '../worker/src/settings.js';

/** Minimal in-memory stand-in for the KV namespace binding. */
function makeEnv({ passphrase = 'correct horse battery staple', store = new Map() } = {}) {
  return {
    OWNER_PASSPHRASE: passphrase,
    POTD_KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
    _store: store,
  };
}

const req = (key) => new Request('https://x/settings', { headers: key == null ? {} : { 'X-Owner-Key': key } });

/* ---------------------------------------------------------------- */
/* authorize                                                         */
/* ---------------------------------------------------------------- */

test('authorize accepts the configured passphrase', () => {
  const env = makeEnv();
  assert.equal(authorize(req('correct horse battery staple'), env).ok, true);
});

test('authorize rejects a wrong passphrase with 401', () => {
  const env = makeEnv();
  const result = authorize(req('wrong'), env);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('authorize rejects a missing header rather than treating it as empty-equals-empty', () => {
  const env = makeEnv();
  assert.equal(authorize(req(null), env).ok, false);
});

test('a near-miss passphrase (prefix, or one extra char) is rejected', () => {
  const env = makeEnv();
  assert.equal(authorize(req('correct horse battery stapl'), env).ok, false);
  assert.equal(authorize(req('correct horse battery staplex'), env).ok, false);
  assert.equal(authorize(req('Correct horse battery staple'), env).ok, false);
});

// HTTP strips leading/trailing whitespace from header values in transit, so
// edge whitespace can't be a meaningful part of the passphrase. authorize()
// trims BOTH sides to make that explicit — otherwise a secret stored with a
// stray trailing space could never be matched by any request at all.
test('edge whitespace is not significant, and cannot lock the owner out', () => {
  assert.equal(authorize(req('  hunter2  '), makeEnv({ passphrase: 'hunter2' })).ok, true);
  assert.equal(authorize(req('hunter2'), makeEnv({ passphrase: 'hunter2  ' })).ok, true);
  // A whitespace-only secret is still "unset", not a passphrase of spaces.
  assert.equal(authorize(req('   '), makeEnv({ passphrase: '   ' })).status, 503);
});

test('authorize fails closed with 503 when OWNER_PASSPHRASE is unset — never defaults to public', () => {
  const env = makeEnv({ passphrase: '' });
  const result = authorize(req('anything'), env);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  // Critically: an empty supplied key must not match an empty configured one.
  assert.equal(authorize(req(''), env).ok, false);
  assert.equal(authorize(req(null), env).ok, false);
});

/* ---------------------------------------------------------------- */
/* get/put                                                           */
/* ---------------------------------------------------------------- */

test('getSettings returns null before anything has been saved', async () => {
  assert.equal(await getSettings(makeEnv()), null);
});

test('putSettings round-trips through getSettings', async () => {
  const env = makeEnv();
  await putSettings(env, { bankroll: { amount: 1000, unit: 20, displayMode: 'units', confirmed: true } });
  const got = await getSettings(env);
  assert.equal(got.bankroll.amount, 1000);
  assert.equal(got.bankroll.unit, 20);
  assert.equal(got.bankroll.displayMode, 'units');
  assert.equal(got.bankroll.confirmed, true);
});

test('settings are stored under the identity-scoped key, ready for per-user profiles', async () => {
  const env = makeEnv();
  await putSettings(env, { bankroll: { amount: 5 } });
  assert.ok(env._store.has('settings:owner'));

  // A second identity must not collide with the owner's record.
  await putSettings(env, { bankroll: { amount: 77 } }, 'user:abc');
  assert.ok(env._store.has('settings:user:abc'));
  assert.equal((await getSettings(env)).bankroll.amount, 5);
  assert.equal((await getSettings(env, 'user:abc')).bankroll.amount, 77);
});

test('garbage numbers are coerced to 0 rather than persisted as NaN/Infinity/negative', async () => {
  const env = makeEnv();
  await putSettings(env, { bankroll: { amount: 'abc', unit: -50 } });
  const got = await getSettings(env);
  assert.equal(got.bankroll.amount, 0);
  assert.equal(got.bankroll.unit, 0);

  await putSettings(env, { bankroll: { amount: Infinity } });
  assert.equal((await getSettings(env)).bankroll.amount, 0);
});

test('an unknown displayMode falls back to dollars instead of being stored verbatim', async () => {
  const env = makeEnv();
  await putSettings(env, { bankroll: { displayMode: 'bitcoin' } });
  assert.equal((await getSettings(env)).bankroll.displayMode, 'dollars');
});

test('extra client-supplied fields are dropped, not written into the record', async () => {
  const env = makeEnv();
  await putSettings(env, { bankroll: { amount: 10, isAdmin: true }, evil: 'x' });
  const stored = JSON.parse(env._store.get('settings:owner'));
  assert.equal(stored.evil, undefined);
  assert.equal(stored.bankroll.isAdmin, undefined);
  assert.equal(stored.bankroll.amount, 10);
});

test('a corrupt KV record reads as unset rather than throwing', async () => {
  const store = new Map([['settings:owner', '{not json']]);
  assert.equal(await getSettings(makeEnv({ store })), null);
});

test('confirmed is strictly boolean — a truthy string does not silently enable dollar conversion', async () => {
  const env = makeEnv();
  await putSettings(env, { bankroll: { confirmed: 'yes' } });
  assert.equal((await getSettings(env)).bankroll.confirmed, false);
});
