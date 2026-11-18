import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { hashPassword, generateJWT, verifyPassword } from '../worker/src/auth-email.js';
import { SERVER_ERROR, LOGIN_MAX_FAILURES } from '../worker/src/auth-handlers.js';
import { consumeQuota, getQuotaUsage, DAILY_LIMIT_ANONYMOUS, DAILY_LIMIT_AUTHENTICATED, DAILY_LIMIT_SITE } from '../worker/src/tail-fade-quota.js';
import { makeEnv, req, linkToken } from './helpers/worker-env.mjs';

// Turnstile's verifier says yes; nothing else reaches the network.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('turnstile/v0/siteverify')) {
      return new Response(JSON.stringify({ success: true, action: 'signup', hostname: 'perpetualpicks.com' }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`no network in tests: ${url}`);
  };
});
after(() => { globalThis.fetch = realFetch; });

const waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
let nextIp = 1;
/** Each call from its own address unless one is given, so the per-address throttle is not what a test trips over. */
const call = async (env, path, opts = {}) => {
  const res = await worker.fetch(req(path, { ip: `198.51.100.${nextIp++ % 250 + 1}`, ...opts }), env, ctx);
  await Promise.all(waits.splice(0));
  let body = null; try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
};
const env0 = (extra = {}) => makeEnv({ TURNSTILE_SECRET: 't', ...extra });
const rows = (env) => env.DB.prepare('SELECT * FROM users ORDER BY created_at').all().then((r) => r.results);
const byEmail = (env, email) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
const signUp = (env, o = {}) => call(env, '/api/auth/register', { body: { email: 'new@example.com', username: 'newuser', password: 'a good password', turnstileToken: 'tt', ...o } });
async function account(env, { id = 'u1', email = 'owner@example.com', username = 'owner1', password = 'correct horse', verified = 1 } = {}) {
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, username, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, email, await hashPassword(password), username, verified, Date.now(), Date.now()).run();
  return { id, email, username, password, token: generateJWT({ userId: id, email, epoch: 0 }, env.JWT_SECRET) };
}
const login = (env, identifier, password, opts) => call(env, '/api/auth/login', { body: { identifier, password }, ...opts });

test('signing up: the address is checked and lower-cased, and the answer does not say who is registered', async () => {
  const env = env0();
  assert.equal((await signUp(env, { email: 'not-an-email' })).status, 400);
  assert.equal((await signUp(env, { password: 'short' })).status, 400);
  assert.equal((await signUp(env, { password: 'x'.repeat(201) })).status, 400);

  const first = await signUp(env, { email: ' New@Example.COM ' });
  assert.equal(first.status, 201);
  assert.equal((await rows(env)).length, 1);
  assert.equal((await rows(env))[0].email, 'new@example.com');
  assert.deepEqual(env.sent.map((m) => [m.to, /Verify/.test(m.subject)]), [['new@example.com', true]]);

  // Verify it, then somebody signs up with the same address again (any capitals).
  await call(env, '/api/auth/verify-email', { body: { token: linkToken(env, 'new@example.com', 'token') } });
  const before = await byEmail(env, 'new@example.com');
  const again = await signUp(env, { email: 'NEW@example.com', username: 'someoneelse', password: 'another password' });
  assert.deepEqual([again.status, again.body], [first.status, first.body], 'the same answer as a new address gets');
  const after = await byEmail(env, 'new@example.com');
  assert.equal((await rows(env)).length, 1);
  assert.deepEqual([after.password_hash, after.username, after.email_verified], [before.password_hash, 'newuser', 1], 'and the account is untouched');
  const notice = env.sent.at(-1);
  assert.equal(notice.to, 'new@example.com'); assert.match(notice.subject, /already have/);
  assert.doesNotMatch(notice.text, /token=/, 'the notice carries no link that does anything');
  // The owner is not told on every attempt.
  for (let i = 0; i < 6; i++) await signUp(env, { username: `again${i}` });
  assert.equal(env.sent.filter((m) => /already have/.test(m.subject)).length, 4);

  // A username somebody has is still said to be taken.
  const taken = await signUp(env, { email: 'third@example.com', username: 'newuser' });
  assert.equal(taken.status, 409); assert.match(taken.body.error, /username/);
});

test('an address or a username nobody verified cannot be sat on', async () => {
  const env = env0();
  // A stranger signs up with someone else's address and the username they wanted.
  await signUp(env, { email: 'victim@example.com', username: 'thename', password: 'the strangers password' });
  const squat = await byEmail(env, 'victim@example.com');

  // While that link is alive, the owner signing up takes the row: their password, their username, a new link to their inbox.
  const r = await signUp(env, { email: 'victim@example.com', username: 'victim1', password: 'the owners password' });
  assert.equal(r.status, 201);
  let row = await byEmail(env, 'victim@example.com');
  assert.equal((await rows(env)).length, 1);
  assert.equal(row.id, squat.id); assert.equal(row.username, 'victim1');
  assert.equal(await verifyPassword('the owners password', row.password_hash), true);
  assert.equal(await verifyPassword('the strangers password', row.password_hash), false);
  assert.notEqual(row.verification_token, squat.verification_token, 'the stranger-era link is dead');

  // A username held by an unverified account whose link has run out is free again.
  await signUp(env, { email: 'squatter@example.net', username: 'wanted', password: 'whatever it is' });
  assert.equal((await signUp(env, { email: 'real@example.org', username: 'wanted' })).status, 409, 'not while its link is alive');
  await env.DB.prepare('UPDATE users SET verification_token_expires = ? WHERE username = ?').bind(Date.now() - 1000, 'wanted').run();
  assert.equal((await signUp(env, { email: 'real@example.org', username: 'wanted' })).status, 201);
  assert.equal(await byEmail(env, 'squatter@example.net'), null, 'the stale row is gone');
  assert.equal((await byEmail(env, 'real@example.org')).username, 'wanted');

  // And so is a stale address: the next sign-up with it is a fresh account.
  await env.DB.prepare('UPDATE users SET verification_token_expires = ? WHERE email = ?').bind(Date.now() - 1000, 'victim@example.com').run();
  await signUp(env, { email: 'victim@example.com', username: 'victim2', password: 'a third password' });
  row = await byEmail(env, 'victim@example.com');
  assert.notEqual(row.id, squat.id); assert.equal(row.username, 'victim2');
});

test('a verification link can be asked for again, and a password reset proves the mailbox', async () => {
  const env = env0();
  await signUp(env, { email: 'late@example.com', username: 'lateuser', password: 'first password' });
  const firstToken = linkToken(env, 'late@example.com', 'token');

  // Signing in before verifying says so (to the right password only).
  assert.equal((await login(env, 'late@example.com', 'wrong password')).status, 401);
  const unverified = await login(env, 'late@example.com', 'first password');
  assert.deepEqual([unverified.status, unverified.body.needsVerification], [403, true]);

  // Ask again, by email or by username: a new link, the old one dead.
  const answer = await call(env, '/api/auth/resend-verification', { body: { identifier: 'lateuser' } });
  assert.equal(answer.status, 200);
  const secondToken = linkToken(env, 'late@example.com', 'token');
  assert.notEqual(secondToken, firstToken);
  assert.equal((await call(env, '/api/auth/verify-email', { body: { token: firstToken } })).status, 404);
  // The same answer for a name that matches nothing, and for an account already verified; nothing is sent.
  const sentBefore = env.sent.length;
  assert.deepEqual((await call(env, '/api/auth/resend-verification', { body: { identifier: 'nobody@example.com' } })).body, answer.body);
  await account(env, { id: 'v', email: 'done@example.com', username: 'doneuser' });
  assert.deepEqual((await call(env, '/api/auth/resend-verification', { body: { identifier: 'done@example.com' } })).body, answer.body);
  assert.equal(env.sent.length, sentBefore);
  // A handful an hour to one address, however often it is asked for.
  for (let i = 0; i < 8; i++) await call(env, '/api/auth/resend-verification', { body: { identifier: 'late@example.com' } });
  assert.equal(env.sent.filter((m) => m.to === 'late@example.com' && /Verify/.test(m.subject)).length, 4);

  // Never verified, but the owner resets the password from their inbox: that verifies it.
  await call(env, '/api/auth/forgot-password', { body: { identifier: 'late@example.com' } });
  const reset = await call(env, '/api/auth/reset-password', { body: { token: linkToken(env, 'late@example.com', 'resetToken'), newPassword: 'the owners own password' } });
  assert.equal(reset.status, 200);
  const row = await byEmail(env, 'late@example.com');
  assert.deepEqual([row.email_verified, row.verification_token], [1, null]);
  const ok = await login(env, 'Late@Example.com', 'the owners own password');
  assert.equal(ok.status, 200, 'and the email matches whatever its capitals');
  assert.equal((await login(env, 'late@example.com', 'first password')).status, 401);
});

test('wrong passwords are counted per account, from any address', async () => {
  const env = env0();
  const u = await account(env);

  // Seven wrong, then the right one: in, and the count is wiped.
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) assert.equal((await login(env, u.email, `guess ${i}`)).status, 401);
  assert.equal((await login(env, u.email, u.password)).status, 200);
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) assert.equal((await login(env, u.email, `guess ${i}`)).status, 401);
  assert.equal((await login(env, u.email, u.password)).status, 200);

  // Eight wrong, each from a different address: the name is locked, for the right password too.
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) assert.equal((await login(env, u.email, `guess ${i}`)).status, 401);
  const locked = await login(env, u.email, u.password);
  assert.equal(locked.status, 429); assert.match(locked.body.error, /Too many failed sign-in attempts/);
  assert.equal((await login(env, ' OWNER@example.com ', u.password)).status, 429, 'whatever its capitals or spaces');
  // Knocking on a locked name does not add to it, and another account is not touched.
  const other = await account(env, { id: 'u2', email: 'other@example.com', username: 'other1' });
  assert.equal((await login(env, other.email, other.password)).status, 200);

  // A name that belongs to nobody locks the same way: the lock says nothing about who is registered.
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) assert.equal((await login(env, 'ghost@example.com', `guess ${i}`)).status, 401);
  assert.equal((await login(env, 'ghost@example.com', 'anything')).status, 429);

  // Resetting the password from the inbox lifts the lock.
  await call(env, '/api/auth/forgot-password', { body: { identifier: u.email } });
  await call(env, '/api/auth/reset-password', { body: { token: linkToken(env, u.email, 'resetToken'), newPassword: 'a new password' } });
  assert.equal((await login(env, u.email, 'a new password')).status, 200);
});

test('a reset link is sent again, not replaced, and one account gets a few an hour', async () => {
  const env = env0();
  const u = await account(env);
  const generic = await call(env, '/api/auth/forgot-password', { body: { identifier: 'nobody@example.com' } });
  assert.equal(env.sent.length, 0);

  const first = await call(env, '/api/auth/forgot-password', { body: { identifier: u.email } });
  assert.deepEqual(first, generic, 'the same answer whether or not the account exists');
  const token = linkToken(env, u.email, 'resetToken');
  // Asked for again (by anyone, by username): the same link, so the one in the inbox still works.
  await call(env, '/api/auth/forgot-password', { body: { identifier: u.username } });
  assert.equal(linkToken(env, u.email, 'resetToken'), token);
  assert.equal((await byEmail(env, u.email)).password_reset_token, token);
  // Three an hour to one account, however many times it is asked for.
  for (let i = 0; i < 6; i++) await call(env, '/api/auth/forgot-password', { body: { identifier: u.email } });
  assert.equal(env.sent.filter((m) => /Reset/.test(m.subject)).length, 3);
  // The link in the inbox still works after all that.
  assert.equal((await call(env, '/api/auth/reset-password', { body: { token, newPassword: 'a new password' } })).status, 200);
  assert.equal((await call(env, '/api/auth/reset-password', { body: { token, newPassword: 'another password' } })).status, 404, 'once');

  // A link with little time left is replaced by a fresh one.
  const env2 = env0();
  const v = await account(env2);
  await call(env2, '/api/auth/forgot-password', { body: { identifier: v.email } });
  const old = linkToken(env2, v.email, 'resetToken');
  await env2.DB.prepare('UPDATE users SET password_reset_token_expires = ? WHERE id = ?').bind(Date.now() + 60 * 1000, v.id).run();
  await call(env2, '/api/auth/forgot-password', { body: { identifier: v.email } });
  assert.notEqual(linkToken(env2, v.email, 'resetToken'), old);
});

test('Sign out ends that session on the server, and only that one', async () => {
  const env = env0();
  const u = await account(env);
  const here = (await login(env, u.email, u.password)).body.token;
  // A second session a second later (a token carries its expiry to the second).
  const there = generateJWT({ userId: u.id, email: u.email, epoch: 0, device: 'other' }, env.JWT_SECRET);
  const me = (token) => call(env, '/api/auth/me', { method: 'GET', token });
  assert.equal((await me(here)).status, 200); assert.equal((await me(there)).status, 200);

  assert.equal((await call(env, '/api/auth/logout', { token: here })).status, 200);
  assert.equal((await me(here)).status, 401, 'the signed-out token is dead');
  assert.equal((await me(there)).status, 200, 'the other device is still in');
  assert.equal((await call(env, '/api/account/email', { token: here, body: { newEmail: 'x@example.net', currentPassword: u.password } })).status, 401);
  // No token, or a made-up one: the same answer, nothing stored.
  const size = env.POTD_KV.store.size;
  assert.equal((await call(env, '/api/auth/logout', {})).status, 200);
  assert.equal((await call(env, '/api/auth/logout', { token: 'not.a.token' })).status, 200);
  assert.equal(env.POTD_KV.store.size, size);
});

test('the routes that ask for the current password count wrong ones per account', async () => {
  const env = env0();
  const u = await account(env);
  const tries = [];
  for (let i = 0; i < 3; i++) tries.push((await call(env, '/api/account/password', { method: 'PUT', token: u.token, body: { currentPassword: `guess ${i}`, newPassword: 'whatever new one' } })).status);
  for (let i = 0; i < 3; i++) tries.push((await call(env, '/api/account/email', { token: u.token, body: { newEmail: 'x@example.net', currentPassword: `guess ${i}` } })).status);
  for (let i = 0; i < 2; i++) tries.push((await call(env, '/api/account', { method: 'DELETE', token: u.token, body: { currentPassword: `guess ${i}` } })).status);
  assert.deepEqual(tries, Array(8).fill(401));
  // Eight wrong between them: all three refuse now, the right password included.
  assert.equal((await call(env, '/api/account/password', { method: 'PUT', token: u.token, body: { currentPassword: u.password, newPassword: 'whatever new one' } })).status, 429);
  assert.equal((await call(env, '/api/account/email', { token: u.token, body: { newEmail: 'x@example.net', currentPassword: u.password } })).status, 429);
  assert.equal((await call(env, '/api/account', { method: 'DELETE', token: u.token, body: { currentPassword: u.password } })).status, 429);
  assert.ok(await byEmail(env, u.email), 'and the account is still there');

  // An account may ask for five email changes a day.
  const env2 = env0();
  const v = await account(env2);
  const changes = [];
  for (let i = 0; i < 7; i++) changes.push((await call(env2, '/api/account/email', { token: v.token, body: { newEmail: `n${i}@example.net`, currentPassword: v.password } })).status);
  assert.deepEqual(changes, [200, 200, 200, 200, 200, 429, 429]);
});

test('what broke on this side is not described to the caller', async () => {
  const env = env0();
  const res = await worker.fetch(new Request('https://worker.test/api/auth/login', { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.200' }, body: '{not json' }), env, ctx);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: SERVER_ERROR });
  // A deployment with no signing secret says nothing about how to set one.
  const u = await account(env);
  const broken = { ...env, JWT_SECRET: undefined };
  const r = await call(broken, '/api/auth/login', { body: { identifier: u.email, password: u.password } });
  assert.deepEqual([r.status, r.body], [500, { error: SERVER_ERROR }]);
});

test('the slip reader counts its reads in one step, per visitor and for the whole site', async () => {
  const NOW = Date.parse('2026-11-18T18:00:00Z');
  const anon = (ip) => ({ headers: { get: (n) => (n === 'CF-Connecting-IP' ? ip : null) } });
  const asUser = (userId) => ({ authenticate: async () => ({ userId }), now: NOW });

  // Twenty at once from one address: three get through, not twenty.
  let env = makeEnv();
  let results = await Promise.all(Array.from({ length: 20 }, () => consumeQuota(anon('203.0.113.9'), env, { now: NOW })));
  assert.equal(results.filter((r) => r.allowed).length, DAILY_LIMIT_ANONYMOUS);
  const refused = results.find((r) => !r.allowed);
  assert.equal(refused.remaining, 0); assert.match(refused.message, /Sign in for 10 a day/);
  assert.deepEqual(await getQuotaUsage(anon('203.0.113.9'), env, { now: NOW }).then((q) => [q.used, q.limit, q.remaining]), [3, 3, 0]);
  // An IPv6 visitor is one visitor across their /64.
  results = [];
  for (let i = 0; i < 5; i++) results.push(await consumeQuota(anon(`2001:db8:1:2::${i + 1}`), env, { now: NOW }));
  assert.equal(results.filter((r) => r.allowed).length, DAILY_LIMIT_ANONYMOUS);
  // A signed-in account has its own, larger allowance, and the next ET day starts again.
  results = await Promise.all(Array.from({ length: 15 }, () => consumeQuota(anon('203.0.113.9'), env, asUser('u1'))));
  assert.equal(results.filter((r) => r.allowed).length, DAILY_LIMIT_AUTHENTICATED);
  assert.equal((await consumeQuota(anon('203.0.113.9'), env, { now: NOW + 86400000 })).allowed, true);
  // The owner is never counted.
  const ownerEnv = makeEnv({ OWNER_PASSPHRASE: 'the-owner-key' });
  const owner = { headers: { get: (n) => (n === 'X-Owner-Key' ? 'the-owner-key' : null) } };
  for (let i = 0; i < 12; i++) assert.equal((await consumeQuota(owner, ownerEnv, { now: NOW })).exempt, true);

  // Fresh addresses all day: the site as a whole stops at its ceiling.
  env = makeEnv();
  let allowed = 0; let last = null;
  for (let i = 0; i < DAILY_LIMIT_SITE + 5; i++) {
    last = await consumeQuota(anon(`10.${Math.floor(i / 250)}.${i % 250}.1`), env, { now: NOW });
    if (last.allowed) allowed += 1;
  }
  assert.equal(allowed, DAILY_LIMIT_SITE);
  assert.match(last.message, /across every visitor/);
});

test('the slip reader route knows a signed-in visitor, and refuses an oversized body unread', async () => {
  const env = env0({ ANTHROPIC_API_KEY: 'k' });
  const u = await account(env);
  const anonQuota = await call(env, '/tail-fade/quota', { method: 'GET', ip: '203.0.113.77' });
  assert.deepEqual([anonQuota.body.kind, anonQuota.body.limit], ['anonymous', DAILY_LIMIT_ANONYMOUS]);
  const userQuota = await call(env, '/tail-fade/quota', { method: 'GET', ip: '203.0.113.77', token: u.token });
  assert.deepEqual([userQuota.body.kind, userQuota.body.limit], ['user', DAILY_LIMIT_AUTHENTICATED]);

  const res = await worker.fetch(new Request('https://worker.test/tail-fade/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.78', 'Content-Length': String(40 * 1024 * 1024) }, body: '{}',
  }), env, ctx);
  assert.equal(res.status, 413);
  assert.equal((await call(env, '/tail-fade/quota', { method: 'GET', ip: '203.0.113.78' })).body.used, 0, 'and no read was spent on it');
});
