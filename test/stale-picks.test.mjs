/**
 * The stuck-pick watchdog (worker/src/stale-picks.js).
 *
 * The thing being guarded against is subtle: a pending pick whose game
 * finished hours ago looks IDENTICAL, in every stored field, to one whose
 * game simply hasn't started. Only wall-clock separates them, which is why
 * these tests pin the boundary behavior precisely rather than just checking
 * that something gets flagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStalePicks, runStalePickAudit, getStalePickReport, STALE_AFTER_HOURS } from '../worker/src/stale-picks.js';

const NOW = Date.parse('2026-08-16T12:00:00Z');
const HOUR = 3600000;
const ctx = { waitUntil: (p) => p };

function makeKvStore() {
  const store = new Map();
  return {
    store,
    env: {
      POTD_KV: {
        async get(key) { return store.get(key) ?? null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
      },
    },
  };
}

/** ET calendar date for an instant — mirrors each tracker module's own etDate. */
function etDateOf(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Seeds one Full Slate pick straight into KV — Full Slate is used as the
 * representative tracker here because every source in SOURCES is read
 * through the same {status, commenceMs} contract, so the staleness rule
 * itself is what these tests are pinning, not one module's key layout.
 */
function seedFullSlatePick(store, { pickId, commenceMs, status = 'pending', dateKey }) {
  const dk = dateKey ?? etDateOf(commenceMs ?? NOW);
  const existing = store.get(`slate:${dk}:manifest`);
  const pickIds = existing ? JSON.parse(existing).pickIds : [];
  store.set(`slate:${dk}:manifest`, JSON.stringify({ date: dk, pickIds: [...pickIds, pickId] }));
  store.set(`slate:${dk}:pick:${pickId}`, JSON.stringify({
    pickId,
    dateKey: dk,
    eventId: `ev-${pickId}`,
    sportKey: 'baseball_mlb',
    marketKey: 'h2h',
    home: 'Home Team',
    away: 'Away Team',
    selection: 'Home Team ML',
    outcomeName: 'Home Team',
    decimal: 1.9,
    suggested_stake: 20,
    commenceMs,
    status,
    result: status === 'pending' ? null : { payout: 18 },
  }));
}

test('a pending pick whose game has not started yet is never flagged', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'future', commenceMs: NOW + 6 * HOUR });

  const report = await findStalePicks(env, NOW);
  assert.equal(report.staleCount, 0);
});

test('a pending pick still inside the staleness window is not flagged — a long game is not a stuck one', async () => {
  const { env, store } = makeKvStore();
  // Started 3h ago: well past tip-off, nowhere near the 8h threshold.
  seedFullSlatePick(store, { pickId: 'inprogress', commenceMs: NOW - 3 * HOUR });

  const report = await findStalePicks(env, NOW);
  assert.equal(report.staleCount, 0, 'flagging a still-playing game would train the reader to ignore this');
});

test('a pending pick past the staleness window is flagged, most-overdue first', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'stuck-recent', commenceMs: NOW - 10 * HOUR });
  seedFullSlatePick(store, { pickId: 'stuck-worst', commenceMs: NOW - 30 * HOUR });

  const report = await findStalePicks(env, NOW);
  assert.equal(report.staleCount, 2);
  assert.deepEqual(
    report.stale.map((s) => s.pickId),
    ['stuck-worst', 'stuck-recent'],
    'the worst backlog belongs at the top of the list',
  );
  assert.equal(report.stale[0].hoursSinceStart, 30);
  assert.equal(report.stale[0].tracker, 'fullslate');
  assert.equal(report.stale[0].matchup, 'Away Team @ Home Team');
});

test('an already-graded pick is never flagged no matter how old', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'settled', commenceMs: NOW - 40 * HOUR, status: 'won' });

  const report = await findStalePicks(env, NOW);
  assert.equal(report.staleCount, 0);
});

test('the staleness boundary is exact — one hour either side of the threshold', async () => {
  const { env, store } = makeKvStore();
  // Just INSIDE the window (7h old, threshold 8h) — not yet stuck.
  seedFullSlatePick(store, { pickId: 'inside', commenceMs: NOW - (STALE_AFTER_HOURS - 1) * HOUR });
  let report = await findStalePicks(env, NOW);
  assert.equal(report.staleCount, 0);

  // Just PAST it (9h old) — stuck.
  const fresh = makeKvStore();
  seedFullSlatePick(fresh.store, { pickId: 'past', commenceMs: NOW - (STALE_AFTER_HOURS + 1) * HOUR });
  report = await findStalePicks(fresh.env, NOW);
  assert.equal(report.staleCount, 1);
});

test('a pending pick with no usable start time is reported separately, never guessed at', async () => {
  const { env, store } = makeKvStore();
  // Prop Play stores commenceMs: null when its first leg carried no start
  // time — unjudgeable either way, so it must not be silently dropped NOR
  // counted as stuck.
  seedFullSlatePick(store, { pickId: 'nostart', commenceMs: null, dateKey: etDateOf(NOW) });

  const report = await findStalePicks(env, NOW);
  assert.equal(report.staleCount, 0, 'never assumed broken');
  assert.equal(report.unknownStart.length, 1, 'never silently dropped either');
  assert.equal(report.unknownStart[0].pickId, 'nostart');
});

test('the threshold is configurable, so a caller can tighten or widen the scan', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'p', commenceMs: NOW - 5 * HOUR });

  assert.equal((await findStalePicks(env, NOW)).staleCount, 0, 'not stale at the 8h default');
  assert.equal(
    (await findStalePicks(env, NOW, { staleAfterHours: 4 })).staleCount, 1,
    'the same pick is stale under a 4h threshold',
  );
});

test('per-tracker counts are reported, so a backlog can be traced to its source', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'stuck', commenceMs: NOW - 20 * HOUR });
  seedFullSlatePick(store, { pickId: 'fine', commenceMs: NOW + 2 * HOUR });

  const report = await findStalePicks(env, NOW);
  assert.equal(report.byTracker.fullslate.pending, 2);
  assert.equal(report.byTracker.fullslate.stale, 1);
});

test('findStalePicks writes nothing — it is a detector, not a fixer', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'stuck', commenceMs: NOW - 20 * HOUR });
  const dk = etDateOf(NOW - 20 * HOUR);
  const before = store.get(`slate:${dk}:pick:stuck`);

  await findStalePicks(env, NOW);

  assert.equal(store.get(`slate:${dk}:pick:stuck`), before, 'the stored pick must be byte-identical after a scan');
});

test('runStalePickAudit caches its report for the read endpoint to serve', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'stuck', commenceMs: NOW - 20 * HOUR });

  assert.equal(await getStalePickReport(env), null, 'null before the first tick — a real answer, not an error');

  const written = await runStalePickAudit(env, ctx, NOW);
  assert.equal(written.staleCount, 1);

  const readBack = await getStalePickReport(env);
  assert.equal(readBack.staleCount, 1);
  assert.equal(readBack.stale[0].pickId, 'stuck');
  assert.equal(readBack.checkedAt, NOW);
});

test('one tracker throwing does not blind the watchdog to every other one', async () => {
  const { env, store } = makeKvStore();
  seedFullSlatePick(store, { pickId: 'stuck', commenceMs: NOW - 20 * HOUR });

  // The ladder's own state read is the one that throws here; Full Slate's
  // stuck pick must still surface.
  const broken = {
    POTD_KV: {
      async get(key) {
        if (String(key).startsWith('ladder')) throw new Error('KV exploded');
        return env.POTD_KV.get(key);
      },
      put: env.POTD_KV.put,
      delete: env.POTD_KV.delete,
    },
  };

  const report = await findStalePicks(broken, NOW);
  assert.equal(report.staleCount, 1, 'the healthy trackers still report');
  assert.ok(report.errors.length >= 1, 'and the broken one is named rather than silently skipped');
});
