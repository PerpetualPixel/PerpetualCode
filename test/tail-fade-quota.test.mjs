import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeQuota,
  getQuotaUsage,
  resolveQuotaIdentity,
  etDate,
  DAILY_LIMIT_AUTHENTICATED,
  DAILY_LIMIT_ANONYMOUS,
} from '../worker/src/tail-fade-quota.js';

const NOW = Date.parse('2026-08-16T18:00:00Z'); // 2pm ET

function makeEnv({ store = new Map(), failing = false } = {}) {
  return {
    store,
    env: {
      OWNER_PASSPHRASE: 'the-owner-key',
      POTD_KV: {
        async get(key) {
          if (failing) throw new Error('KV down');
          return store.get(key) ?? null;
        },
        async put(key, value) {
          if (failing) throw new Error('KV down');
          store.set(key, value);
        },
      },
    },
  };
}

/** A request with whatever identifying headers the case needs. */
function req(headers = {}) {
  return { headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null } };
}

const asUser = (userId) => async () => ({ userId });
const asAnon = async () => null;

/* ---------------------------------------------------------------- */
/* Identity                                                          */
/* ---------------------------------------------------------------- */

test('the owner key grants an exempt identity', async () => {
  const { env } = makeEnv();
  const identity = await resolveQuotaIdentity(req({ 'X-Owner-Key': 'the-owner-key' }), env, {
    authenticate: asAnon,
  });
  assert.equal(identity.kind, 'owner');
  assert.equal(identity.exempt, true);
  assert.equal(identity.limit, Infinity);
});

test('the owner check runs before the database, so a D1 outage cannot lock the owner out', async () => {
  // The owner is who debugs this feature; a limit that depends on the same
  // infrastructure being healthy is a limit that bites exactly when it must not.
  const { env } = makeEnv();
  const identity = await resolveQuotaIdentity(req({ 'X-Owner-Key': 'the-owner-key' }), env, {
    authenticate: async () => { throw new Error('D1 unavailable'); },
  });
  assert.equal(identity.exempt, true);
});

test('a wrong owner key does not grant exemption', async () => {
  const { env } = makeEnv();
  const identity = await resolveQuotaIdentity(req({ 'X-Owner-Key': 'not-the-key' }), env, {
    authenticate: asAnon,
  });
  assert.notEqual(identity.kind, 'owner');
  assert.equal(identity.exempt, false);
});

test('an unconfigured OWNER_PASSPHRASE never exempts anyone', async () => {
  // Fails closed: without a configured secret there is no way to tell the
  // owner from any visitor, and an empty-matches-empty bug would exempt all.
  const identity = await resolveQuotaIdentity(
    req({ 'X-Owner-Key': '' }), { OWNER_PASSPHRASE: '' }, { authenticate: asAnon },
  );
  assert.equal(identity.exempt, false);
});

test('a signed-in user is counted by account id, not by address', async () => {
  const { env } = makeEnv();
  const identity = await resolveQuotaIdentity(req({ 'CF-Connecting-IP': '1.2.3.4' }), env, {
    authenticate: asUser(42),
  });
  assert.equal(identity.kind, 'user');
  assert.equal(identity.id, 'u:42');
  assert.equal(identity.limit, DAILY_LIMIT_AUTHENTICATED);
});

test('an anonymous visitor falls back to IP with a smaller allowance', async () => {
  const { env } = makeEnv();
  const identity = await resolveQuotaIdentity(req({ 'CF-Connecting-IP': '1.2.3.4' }), env, {
    authenticate: asAnon,
  });
  assert.equal(identity.kind, 'anonymous');
  assert.equal(identity.id, 'ip:1.2.3.4');
  assert.equal(identity.limit, DAILY_LIMIT_ANONYMOUS);
  assert.ok(DAILY_LIMIT_ANONYMOUS < DAILY_LIMIT_AUTHENTICATED,
    'an IP is a coarse bucket, so getting it wrong should cost less');
});

test('an auth lookup failure falls back to anonymous rather than becoming a free pass', async () => {
  const { env } = makeEnv();
  const identity = await resolveQuotaIdentity(req({ 'CF-Connecting-IP': '9.9.9.9' }), env, {
    authenticate: async () => { throw new Error('D1 unavailable'); },
  });
  assert.equal(identity.kind, 'anonymous');
  assert.equal(identity.exempt, false);
});

/* ---------------------------------------------------------------- */
/* Consuming                                                         */
/* ---------------------------------------------------------------- */

test('a signed-in user gets exactly the daily allowance, then is refused', async () => {
  const { env } = makeEnv();
  const request = req({ 'CF-Connecting-IP': '1.1.1.1' });
  const opts = { now: NOW, authenticate: asUser(7) };

  for (let i = 1; i <= DAILY_LIMIT_AUTHENTICATED; i++) {
    const result = await consumeQuota(request, env, opts);
    assert.equal(result.allowed, true, `call ${i} should be allowed`);
    assert.equal(result.used, i);
    assert.equal(result.remaining, DAILY_LIMIT_AUTHENTICATED - i);
  }

  const over = await consumeQuota(request, env, opts);
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 0);
  assert.match(over.message, /reset at midnight ET/i);
  assert.match(over.message, /typing a bet in/i, 'the refusal must name the path that still works');
});

test('an anonymous visitor is refused after the smaller allowance, and told signing in helps', async () => {
  const { env } = makeEnv();
  const request = req({ 'CF-Connecting-IP': '2.2.2.2' });
  const opts = { now: NOW, authenticate: asAnon };
  for (let i = 0; i < DAILY_LIMIT_ANONYMOUS; i++) {
    assert.equal((await consumeQuota(request, env, opts)).allowed, true);
  }
  const over = await consumeQuota(request, env, opts);
  assert.equal(over.allowed, false);
  assert.match(over.message, /sign in/i);
});

test('the owner is never refused, however many times they read a slip', async () => {
  const { env } = makeEnv();
  const request = req({ 'X-Owner-Key': 'the-owner-key' });
  for (let i = 0; i < DAILY_LIMIT_AUTHENTICATED * 5; i++) {
    const result = await consumeQuota(request, env, { now: NOW, authenticate: asAnon });
    assert.equal(result.allowed, true, `owner refused on call ${i + 1}`);
    assert.equal(result.exempt, true);
  }
});

test('the owner consumes no counter at all, so exemption leaves no residue', async () => {
  const { env, store } = makeEnv();
  await consumeQuota(req({ 'X-Owner-Key': 'the-owner-key' }), env, { now: NOW, authenticate: asAnon });
  assert.equal(store.size, 0);
});

test('two users do not share an allowance', async () => {
  const { env } = makeEnv();
  const request = req({ 'CF-Connecting-IP': '3.3.3.3' });
  for (let i = 0; i < DAILY_LIMIT_AUTHENTICATED; i++) {
    await consumeQuota(request, env, { now: NOW, authenticate: asUser(1) });
  }
  assert.equal((await consumeQuota(request, env, { now: NOW, authenticate: asUser(1) })).allowed, false);
  assert.equal((await consumeQuota(request, env, { now: NOW, authenticate: asUser(2) })).allowed, true,
    'a second account on the same address has its own allowance');
});

test('the allowance resets on the next ET day', async () => {
  const { env } = makeEnv();
  const request = req({ 'CF-Connecting-IP': '4.4.4.4' });
  const opts = { now: NOW, authenticate: asUser(5) };
  for (let i = 0; i < DAILY_LIMIT_AUTHENTICATED; i++) await consumeQuota(request, env, opts);
  assert.equal((await consumeQuota(request, env, opts)).allowed, false);

  const tomorrow = { now: NOW + 86400000, authenticate: asUser(5) };
  const fresh = await consumeQuota(request, env, tomorrow);
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.used, 1);
});

test('counters are keyed on the ET calendar day, matching every other surface', () => {
  // 3am UTC on the 17th is still the 16th in ET — a user mid-evening must
  // not silently get a second allowance because UTC rolled over.
  assert.equal(etDate(Date.parse('2026-08-17T03:00:00Z')), '2026-08-16');
  assert.equal(etDate(Date.parse('2026-08-17T05:00:00Z')), '2026-08-17');
});

/* ---------------------------------------------------------------- */
/* Degradation                                                       */
/* ---------------------------------------------------------------- */

test('a KV outage fails OPEN rather than denying a paid feature to everyone', async () => {
  // The per-minute burst limiter still sits in front of the route, so the
  // exposure of failing open here is bounded rather than unlimited.
  const { env } = makeEnv({ failing: true });
  const result = await consumeQuota(req({ 'CF-Connecting-IP': '5.5.5.5' }), env, {
    now: NOW, authenticate: asUser(9),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.degraded, true);
});

test('a write failure still allows the request rather than losing it', async () => {
  const store = new Map();
  const env = {
    OWNER_PASSPHRASE: 'k',
    POTD_KV: {
      async get(key) { return store.get(key) ?? null; },
      async put() { throw new Error('write failed'); },
    },
  };
  const result = await consumeQuota(req({ 'CF-Connecting-IP': '6.6.6.6' }), env, {
    now: NOW, authenticate: asUser(3),
  });
  assert.equal(result.allowed, true);
});

/* ---------------------------------------------------------------- */
/* Reading usage without spending it                                 */
/* ---------------------------------------------------------------- */

test('getQuotaUsage reports remaining without consuming any', async () => {
  const { env } = makeEnv();
  const request = req({ 'CF-Connecting-IP': '7.7.7.7' });
  const opts = { now: NOW, authenticate: asUser(11) };
  await consumeQuota(request, env, opts);
  await consumeQuota(request, env, opts);

  const first = await getQuotaUsage(request, env, opts);
  const second = await getQuotaUsage(request, env, opts);
  assert.equal(first.used, 2);
  assert.equal(first.remaining, DAILY_LIMIT_AUTHENTICATED - 2);
  assert.deepEqual(first, second, 'reading the allowance must not spend it');
});

test('getQuotaUsage reports the owner as exempt with no numbers to display', async () => {
  const { env } = makeEnv();
  const usage = await getQuotaUsage(req({ 'X-Owner-Key': 'the-owner-key' }), env, {
    now: NOW, authenticate: asAnon,
  });
  assert.equal(usage.exempt, true);
  assert.equal(usage.limit, null);
  assert.equal(usage.remaining, null);
});

test('a fresh user sees the full allowance', async () => {
  const { env } = makeEnv();
  const usage = await getQuotaUsage(req({ 'CF-Connecting-IP': '8.8.8.8' }), env, {
    now: NOW, authenticate: asUser(99),
  });
  assert.equal(usage.used, 0);
  assert.equal(usage.remaining, DAILY_LIMIT_AUTHENTICATED);
});
