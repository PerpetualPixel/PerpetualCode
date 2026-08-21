/**
 * Route-level tests for /admin/redraw-today, driving the Worker's own fetch
 * handler the same way test/settings-routes.test.mjs does.
 *
 * What's actually under test here is the guard-and-clear half: the auth
 * gate, the generation-hour and already-underway refusals, exactly which
 * keys a redraw drops, and the settled-ladder-rung exception. The redraw
 * itself runs against a stubbed-empty slate — the four generators have
 * their own extensive coverage in potd/prop-play/tracking/ladder tests, and
 * repeating it through the route would only re-test them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';

const ORIGIN = 'https://miguelsgarcia4.github.io';
const PASS = 'test-owner-passphrase';
const DATE = '2026-08-21';
// 5am ET — after the 2am batch hour, which is the whole situation this
// endpoint exists for: a worker deployed too late to draw the day itself.
const AT_5AM_ET = Date.parse('2026-08-21T09:00:00Z');
const AT_1AM_ET = Date.parse('2026-08-21T05:00:00Z');
const LATER_TODAY = Date.parse('2026-08-21T23:00:00Z');
const ALREADY_STARTED = Date.parse('2026-08-21T08:00:00Z');

function pick(id, commenceMs = LATER_TODAY) {
  return {
    pickId: id, dateKey: DATE, eventId: id.split(':')[0], selection: `${id} to win`,
    commenceMs, status: 'pending', stakeUnits: 2, suggested_stake: 50,
  };
}

/** A day with all four boards already drawn, as the old worker left them. */
function drawnDay({ commenceMs = LATER_TODAY, ladderStatus = 'pending' } = {}) {
  const ids = ['e1:h2h', 'e2:h2h', 'e3:h2h', 'e4:h2h', 'e5:h2h'];
  const store = new Map();
  store.set(`track:${DATE}:top5`, JSON.stringify({ date: DATE, pickIds: ids }));
  for (const id of ids) store.set(`track:${DATE}:pick:${id}`, JSON.stringify(pick(id, commenceMs)));
  store.set(`potd:${DATE}`, JSON.stringify({ date: DATE, pick: pick('p1:h2h', commenceMs) }));
  store.set(`propplay:${DATE}`, JSON.stringify({
    date: DATE,
    legs: [{ label: 'A Player 15+ points', commence: new Date(commenceMs).toISOString() }],
  }));
  store.set(`ladder:play:${DATE}`, JSON.stringify({
    dateKey: DATE, pick: { ...pick('l1:h2h', commenceMs), status: ladderStatus },
  }));
  store.set(`ladder:status:${DATE}`, JSON.stringify({ dateKey: DATE, reason: 'stale hold' }));
  return store;
}

function makeEnv(store) {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    OWNER_PASSPHRASE: PASS,
    POTD_KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    },
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

function call({ key = PASS, body } = {}) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (key !== null) headers['X-Owner-Key'] = key;
  return new Request('https://worker.dev/admin/redraw-today', {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
}

/**
 * Freezes the clock and stubs the network, since the route reads Date.now()
 * directly and the generators would otherwise reach for the Odds API. An
 * empty slate means they post nothing, which is fine — this file is about
 * what gets cleared, not what gets drawn.
 */
async function redraw(store, { at = AT_5AM_ET, ...opts } = {}) {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  Date.now = () => at;
  globalThis.fetch = async () => new Response('[]', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  // Same always-miss stub test/odds.test.mjs uses — the Workers cache API
  // the slate fetch reaches for doesn't exist under plain Node.
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  try {
    return await worker.fetch(call(opts), makeEnv(store), ctx);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
}

test('redraw is refused without the owner key — it deletes real tracked picks', async () => {
  const store = drawnDay();
  const res = await redraw(store, { key: null });
  assert.equal(res.status, 401);
  assert.ok(store.has(`potd:${DATE}`), 'nothing cleared on a refused call');
});

test('redraw before the generation hour is refused, leaving yesterday-still-current boards alone', async () => {
  const store = drawnDay();
  const res = await redraw(store, { at: AT_1AM_ET });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /generation hour/);
  assert.equal(store.size, drawnDay().size, 'nothing cleared');
});

test('redraw clears all four boards once past the generation hour', async () => {
  const store = drawnDay();
  const res = await redraw(store);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.dateKey, DATE);
  assert.equal(body.cleared.top5, 5, 'all five Pixel\'s Picks records dropped');
  assert.equal(body.cleared.potd, true);
  assert.equal(body.cleared.propPlay, true);
  assert.equal(body.cleared.ladder, true);

  // Every old pick record is gone, and the manifest runTop5Batch rewrites
  // indexes none of them — the day is drawn afresh, not topped up around
  // the board the previous build left behind.
  for (const id of ['e1:h2h', 'e2:h2h', 'e3:h2h', 'e4:h2h', 'e5:h2h']) {
    assert.equal(store.has(`track:${DATE}:pick:${id}`), false, `${id} still stored`);
    const manifest = JSON.parse(store.get(`track:${DATE}:top5`) ?? '{"pickIds":[]}');
    assert.equal(manifest.pickIds.includes(id), false, `${id} still indexed`);
  }
  // Nothing is redrawn onto them here because the stubbed slate is empty,
  // which makes "cleared" observable on its own.
  assert.equal(store.has(`potd:${DATE}`), false);
  assert.equal(store.has(`propplay:${DATE}`), false);
  assert.equal(store.has(`ladder:play:${DATE}`), false);
  // The stale hold reason is dropped — else /ladder would explain a
  // freshly-drawn rung with the previous run's "why there's nothing today".
  const ladderStatus = JSON.parse(store.get(`ladder:status:${DATE}`) ?? 'null');
  assert.notEqual(ladderStatus?.reason, 'stale hold');
});

test('redraw is refused once a game has started, naming what would have been lost', async () => {
  const store = drawnDay({ commenceMs: ALREADY_STARTED });
  const res = await redraw(store);
  assert.equal(res.status, 409);

  const body = await res.json();
  assert.match(body.error, /already underway/);
  assert.ok(body.started.some((s) => s.startsWith("Pixel's Picks:")));
  assert.ok(body.started.some((s) => s.startsWith('Play of the Day:')));
  assert.ok(body.started.some((s) => s.startsWith('Prop Play:')));
  assert.ok(body.started.some((s) => s.startsWith('Ladder:')));
  assert.ok(store.has(`potd:${DATE}`), 'refused means nothing was deleted');
  assert.ok(store.has(`track:${DATE}:pick:e1:h2h`));
});

test('force overrides the already-underway refusal', async () => {
  const store = drawnDay({ commenceMs: ALREADY_STARTED });
  const res = await redraw(store, { body: { force: true } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).forced, true);
  assert.equal(store.has(`potd:${DATE}`), false);
});

test('a settled ladder rung is kept — clearing it would compound the climb twice', async () => {
  const store = drawnDay({ ladderStatus: 'won' });
  const res = await redraw(store);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.cleared.ladder, false);
  assert.match(body.drawn.ladder.reason, /already graded/);
  assert.ok(store.has(`ladder:play:${DATE}`), 'the graded rung survives the redraw');
  // The rest of the day still redraws around it.
  assert.equal(store.has(`potd:${DATE}`), false);
  assert.equal(body.cleared.top5, 5);
});
