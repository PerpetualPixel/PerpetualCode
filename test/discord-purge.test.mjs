/**
 * The live channels' sweep (worker/src/discord-purge.js): a posted card is marked, and 15 minutes later the sweep
 * deletes it through its channel's webhook and drops the mark, against a fake KV that lists with metadata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markForPurge, purgeLiveCards, purgeKey, SHOW_MS, PURGE_A_SWEEP, PURGE_PREFIX, PURGE_CHANNELS } from '../worker/src/discord-purge.js';

const LIVE = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const LEANS = 'https://discord.com/api/webhooks/323456789012345678/yyyDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const NBA = 'https://discord.com/api/webhooks/423456789012345678/nbaDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const NOW = Date.parse('2026-11-28T20:00:00Z');

function makeEnv(extra = {}) {
  const store = new Map();
  const kv = {
    async get(k) { return store.get(k)?.value ?? null; },
    async put(k, value, opts = {}) { store.set(k, { value, metadata: opts.metadata ?? null }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...store.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true }; },
  };
  return { store, env: { DISCORD_LIVE_WEBHOOK: LIVE, DISCORD_LIVE_LEAN_WEBHOOK: LEANS, DISCORD_LIVE_BASKETBALL_WEBHOOK: NBA, ...extra, POTD_KV: kv } };
}
function fakeDiscord(reply = null) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, method: init?.method }); const status = reply?.(url, calls.length) ?? 204; return { ok: status >= 200 && status < 300, status }; };
  return { calls, fetch };
}

test('a posted card is marked with its channel, id and time; nothing is marked without an id or for an unknown channel', async () => {
  const { env, store } = makeEnv();
  assert.equal(await markForPurge(env, 'tennis-live', '900000000000000001', NOW), true);
  assert.deepEqual(store.get(purgeKey('tennis-live', '900000000000000001')).metadata, { channel: 'tennis-live', messageId: '900000000000000001', at: NOW });
  assert.equal(await markForPurge(env, 'nba', 800000000000000001n.toString(), NOW), true);
  assert.equal(await markForPurge(env, 'tennis-live', null, NOW), false);
  assert.equal(await markForPurge(env, 'results', '1', NOW), false);
  assert.equal(store.size, 2);
  assert.ok(purgeKey('nfl', '5').startsWith(PURGE_PREFIX));
  assert.deepEqual(Object.keys(PURGE_CHANNELS), ['tennis-live', 'tennis-leans', 'nba', 'nfl']);
  assert.equal(SHOW_MS, 15 * 60e3);
});

test('the sweep deletes each card 15 minutes after it went up, through its own channel, and drops the mark; one not yet due waits', async () => {
  const { env, store } = makeEnv();
  await markForPurge(env, 'tennis-live', '111', NOW - SHOW_MS);
  await markForPurge(env, 'tennis-leans', '222', NOW - SHOW_MS - 60e3);
  await markForPurge(env, 'nba', '333', NOW - 14 * 60e3);
  const d = fakeDiscord();
  assert.deepEqual(await purgeLiveCards(env, NOW, { deps: { fetch: d.fetch } }), { due: 2, deleted: 2, failed: 0, waiting: 1 });
  assert.deepEqual(d.calls.map((c) => [c.method, c.url]).sort(), [['DELETE', `${LEANS}/messages/222`], ['DELETE', `${LIVE}/messages/111`]].sort());
  assert.deepEqual([...store.keys()], [purgeKey('nba', '333')], 'the deleted ones are unmarked; the one still showing waits');
  // A minute on: the third is due and goes, to its own channel.
  assert.deepEqual(await purgeLiveCards(env, NOW + 60e3, { deps: { fetch: d.fetch } }), { due: 1, deleted: 1, failed: 0, waiting: 0 });
  assert.deepEqual(d.calls.at(-1), { method: 'DELETE', url: `${NBA}/messages/333` });
  assert.equal(store.size, 0);
  // Nothing marked: nothing asked of Discord.
  assert.deepEqual(await purgeLiveCards(env, NOW + 120e3, { deps: { fetch: d.fetch } }), { due: 0, deleted: 0, failed: 0, waiting: 0 });
  assert.equal(d.calls.length, 3);
});

test('a message already gone is let go; one Discord would not delete is tried again next minute; no answer is a try too', async () => {
  const { env, store } = makeEnv();
  await markForPurge(env, 'tennis-live', '111', NOW - SHOW_MS);
  await markForPurge(env, 'tennis-live', '222', NOW - SHOW_MS);
  const flaky = fakeDiscord((url, n) => (url.endsWith('/111') ? 404 : n <= 2 ? 500 : 204));
  assert.deepEqual(await purgeLiveCards(env, NOW, { deps: { fetch: flaky.fetch } }), { due: 2, deleted: 1, failed: 1, waiting: 0 });
  assert.deepEqual([...store.keys()], [purgeKey('tennis-live', '222')]);
  assert.deepEqual(await purgeLiveCards(env, NOW + 60e3, { deps: { fetch: flaky.fetch } }), { due: 1, deleted: 1, failed: 0, waiting: 0 });
  assert.equal(store.size, 0);
  const down = makeEnv();
  await markForPurge(down.env, 'nba', '333', NOW - SHOW_MS);
  assert.deepEqual(await purgeLiveCards(down.env, NOW, { deps: { fetch: async () => { throw new Error('timeout'); } } }), { due: 1, deleted: 0, failed: 1, waiting: 0 });
  assert.equal(down.store.size, 1, 'kept for the next minute');
});

test('a mark for a channel no longer set up is dropped, a broken mark too, and a sweep takes only so many; without a KV that lists it does nothing', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_BASKETBALL_WEBHOOK: '' });
  await markForPurge(env, 'nba', '333', NOW - SHOW_MS);
  store.set(`${PURGE_PREFIX}junk`, { value: '1', metadata: null });
  const d = fakeDiscord();
  assert.deepEqual(await purgeLiveCards(env, NOW, { deps: { fetch: d.fetch } }), { due: 1, deleted: 0, failed: 0, waiting: 0 });
  assert.equal(d.calls.length, 0);
  assert.equal(store.size, 0, 'both marks are gone');

  const many = makeEnv();
  for (let i = 0; i < PURGE_A_SWEEP + 5; i++) await markForPurge(many.env, 'tennis-live', String(1000 + i), NOW - SHOW_MS);
  const d2 = fakeDiscord();
  const r = await purgeLiveCards(many.env, NOW, { deps: { fetch: d2.fetch } });
  assert.deepEqual([r.due, r.deleted, d2.calls.length, many.store.size], [PURGE_A_SWEEP + 5, PURGE_A_SWEEP, PURGE_A_SWEEP, 5]);
  assert.equal((await purgeLiveCards(many.env, NOW + 60e3, { deps: { fetch: d2.fetch } })).deleted, 5);

  const plain = { POTD_KV: { async get() { return null; }, async put() {}, async delete() {} } };
  assert.deepEqual(await purgeLiveCards(plain, NOW), { due: 0, deleted: 0, failed: 0, waiting: 0 });
  assert.equal(await markForPurge({}, 'nba', '1', NOW), false);
});
