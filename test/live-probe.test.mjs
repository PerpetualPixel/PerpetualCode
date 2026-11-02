import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLiveEvent, summariseProps, runLiveProbe, liveProbeKey } from '../worker/src/live-probe.js';

test('the probe finds its game on the feed either way round, summarises what each book posts, and keeps one snapshot a tick inside its window', async () => {
  const events = [{ id: 'x1', home_team: 'Dallas Cowboys', away_team: 'New York Giants' }, { id: 'e1', home_team: 'Washington Commanders', away_team: 'Philadelphia Eagles', commence_time: '2026-11-02T01:20:00Z' }];
  assert.equal(pickLiveEvent(events, ['Philadelphia Eagles', 'Washington Commanders']).id, 'e1');
  assert.equal(pickLiveEvent(events, ['Philadelphia Eagles', 'Miami Dolphins']), null);
  const payload = { bookmakers: [
    { key: 'draftkings', last_update: 't', markets: [{ key: 'player_rush_yds_alternate', last_update: 't', outcomes: [{ name: 'Over', description: 'Saquon Barkley', point: 59.5, price: -150 }, { name: 'Over', description: 'Saquon Barkley', point: 69.5, price: 110 }, { name: 'Over', description: 'Jacory Croskey-Merritt', point: 39.5, price: -120 }] }] },
    { key: 'fanduel', last_update: 't', markets: [] },
  ] };
  const snap = summariseProps(payload, 5);
  assert.equal(snap.booksPosting, 1);
  assert.deepEqual([snap.books[0].markets[0].outcomes, snap.books[0].markets[0].players, snap.books[0].markets[0].sample[0].player], [3, 2, 'Saquon Barkley']);
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const cfg = { sportKey: 'americanfootball_nfl', teams: ['Philadelphia Eagles', 'Washington Commanders'], from: 100, until: 1000 };
  let calls = 0;
  const deps = { config: cfg, events: async () => events, props: async () => { calls++; return payload; } };
  assert.equal((await runLiveProbe(env, {}, 50, { deps })).skipped, true, 'before the window');
  const r = await runLiveProbe(env, {}, 200, { deps });
  assert.deepEqual([r.skipped, r.eventId, r.booksPosting, r.markets], [false, 'e1', 1, 1]);
  await runLiveProbe(env, {}, 300, { deps });
  const log = JSON.parse(m.get(liveProbeKey('e1')));
  assert.equal(log.snapshots.length, 2); assert.equal(calls, 2); assert.equal(log.home, 'Washington Commanders');
  assert.equal((await runLiveProbe(env, {}, 2000, { deps })).skipped, true, 'after the window');
});
