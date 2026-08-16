import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTeamFormSignal,
  teamUnderdogBlocked,
  loadTeamContextsFor,
  seedTeamContextCacheForTests,
  fixtureKey,
  TEAM_DOG_MIN_SIGNAL,
  MAX_CONTEXT_FETCHES,
} from '../worker/src/team-form.js';
import { QUALITATIVE } from '../docs/engine.js';

const NOW = Date.parse('2026-08-16T16:00:00Z');
const ctx = { waitUntil: (p) => p };

/** One ESPN-shaped side, as worker/src/context.js's sideOf() builds it. */
function side(name, { wins = 3, losses = 2, out = 0 } = {}) {
  return {
    id: name,
    name,
    shortName: name,
    lastFive: [
      ...Array.from({ length: wins }, () => ({ result: 'W' })),
      ...Array.from({ length: losses }, () => ({ result: 'L' })),
    ],
    injuries: Array.from({ length: out }, (_, i) => ({ name: `${name} player ${i}`, status: 'Out' })),
  };
}

function context(homeSpec, awaySpec) {
  return { home: side('Atlanta Dream', homeSpec), away: side('Indiana Fever', awaySpec) };
}

/** A scored candidate, as docs/engine.js's analyze() emits one. */
function candidate({
  sportKey = 'basketball_wnba',
  marketKey = 'h2h',
  outcomeName = 'Indiana Fever',
  consensusProb = 0.40,
  score = 60,
} = {}) {
  return {
    eventId: 'g1',
    sportKey,
    marketKey,
    outcomeName,
    home: 'Atlanta Dream',
    away: 'Indiana Fever',
    consensusProb,
    score,
    ev: 0.02,
    bookCount: 8,
    disagreement: 0.01,
    shopGain: 0.01,
    american: 150,
    commenceMs: NOW + 3 * 3.6e6,
    updatedMs: NOW - 6e5,
  };
}

/* ---------------------------------------------------------------- */
/* teamUnderdogBlocked                                               */
/* ---------------------------------------------------------------- */

test('teamUnderdogBlocked: blocks a moneyline underdog whose form does not back the upset', () => {
  assert.equal(teamUnderdogBlocked(candidate(), TEAM_DOG_MIN_SIGNAL - 0.01), true);
});

test('teamUnderdogBlocked: allows a moneyline underdog the form actually backs', () => {
  assert.equal(teamUnderdogBlocked(candidate(), TEAM_DOG_MIN_SIGNAL), false);
  assert.equal(teamUnderdogBlocked(candidate(), 0.6), false);
});

test('teamUnderdogBlocked: no signal is NOT a block — the deliberate inversion of the tennis gate', () => {
  // A missing ESPN context for a major-league fixture is a fetch failure or
  // a name mismatch, not evidence about the game. Tennis blocks here because
  // an absent player is itself informative; this must not.
  assert.equal(teamUnderdogBlocked(candidate(), null), false);
  assert.equal(teamUnderdogBlocked(candidate(), undefined), false);
  assert.equal(teamUnderdogBlocked(candidate(), NaN), false);
});

test('teamUnderdogBlocked: never blocks a market favorite, however poor its form', () => {
  assert.equal(teamUnderdogBlocked(candidate({ consensusProb: 0.5 }), -0.9), false);
  assert.equal(teamUnderdogBlocked(candidate({ consensusProb: 0.72 }), -0.9), false);
});

test('teamUnderdogBlocked: spreads and totals pass through — covering is not an upset call', () => {
  assert.equal(teamUnderdogBlocked(candidate({ marketKey: 'spreads' }), -0.9), false);
  assert.equal(teamUnderdogBlocked(candidate({ marketKey: 'totals' }), -0.9), false);
});

/* ---------------------------------------------------------------- */
/* applyTeamFormSignal                                               */
/* ---------------------------------------------------------------- */

test('applyTeamFormSignal: drops an unbacked moneyline underdog entirely', () => {
  // Fever 2-3, Dream 4-1 → the dog is the WORSE side; nothing backs the upset.
  const contexts = new Map([[fixtureKey(candidate()), context({ wins: 4, losses: 1 }, { wins: 2, losses: 3 })]]);
  const out = applyTeamFormSignal([candidate()], contexts, { now: NOW });
  assert.equal(out.length, 0);
});

test('applyTeamFormSignal: keeps a form-backed underdog and re-scores it upward', () => {
  // Fever 4-1, Dream 1-4 → formDiff = 0.8 - 0.2 = +0.6, well past the bar.
  const contexts = new Map([[fixtureKey(candidate()), context({ wins: 1, losses: 4 }, { wins: 4, losses: 1 })]]);
  const [kept] = applyTeamFormSignal([candidate({ score: 60 })], contexts, { now: NOW });
  assert.ok(kept, 'a backed underdog survives the gate');
  assert.ok(Math.abs(kept.formSignal - 0.6) < 1e-9, `expected +0.6 signal, got ${kept.formSignal}`);
  assert.ok(kept.score > 60, 'the swing is applied, not merely recorded');
  assert.ok(kept.score <= 60 + QUALITATIVE.MAX_SWING + 1e-9, 'and stays inside the capped swing');
});

test('applyTeamFormSignal: a favorite with poor form is re-scored DOWNWARD, never dropped', () => {
  const fav = candidate({ outcomeName: 'Atlanta Dream', consensusProb: 0.62, score: 60 });
  const contexts = new Map([[fixtureKey(fav), context({ wins: 1, losses: 4 }, { wins: 4, losses: 1 })]]);
  const [kept] = applyTeamFormSignal([fav], contexts, { now: NOW });
  assert.ok(kept, 'favorites are never gated out');
  assert.ok(kept.formSignal < 0);
  assert.ok(kept.score < 60, 'a favorite in bad form should grade worse, not the same');
});

test('applyTeamFormSignal: injuries alone can carry the signal when form is unavailable', () => {
  const noForm = (name, out) => ({ id: name, name, shortName: name, lastFive: [], injuries: Array.from({ length: out }, (_, i) => ({ name: `${name} ${i}`, status: 'Out' })) });
  const contexts = new Map([[fixtureKey(candidate()), { home: noForm('Atlanta Dream', 3), away: noForm('Indiana Fever', 0) }]]);
  const [kept] = applyTeamFormSignal([candidate()], contexts, { now: NOW });
  assert.ok(kept, 'three unavailable players on the favorite backs the dog');
  assert.ok(kept.formSignal > 0);
});

test('applyTeamFormSignal: no context means pure price — unchanged score, no gate', () => {
  const before = candidate({ score: 60 });
  const [kept] = applyTeamFormSignal([before], new Map(), { now: NOW });
  assert.ok(kept, 'an unresolvable fixture must not cost the candidate its slot');
  assert.equal(kept.score, 60);
  assert.equal(kept.formSignal, null);
});

test('applyTeamFormSignal: totals are untouched — Over/Under has no side to attach form to', () => {
  const total = candidate({ marketKey: 'totals', outcomeName: 'Under', consensusProb: 0.48, score: 60 });
  const contexts = new Map([[fixtureKey(total), context({ wins: 1, losses: 4 }, { wins: 4, losses: 1 })]]);
  const [kept] = applyTeamFormSignal([total], contexts, { now: NOW });
  assert.equal(kept.score, 60);
  assert.equal(kept.formSignal, undefined, 'not even a null marker — it passes through as-is');
});

test('applyTeamFormSignal: tennis, MMA and NHL pass through untouched', () => {
  // Tennis and MMA have their own evidence layers applied by the caller;
  // NHL has no page at all on this ESPN host (context.js LEAGUE_PATHS).
  const others = [
    candidate({ sportKey: 'tennis_atp_canadian_open', score: 61 }),
    candidate({ sportKey: 'mma_mixed_martial_arts', score: 62 }),
    candidate({ sportKey: 'icehockey_nhl', score: 63 }),
  ];
  const out = applyTeamFormSignal(others, new Map(), { now: NOW });
  assert.deepEqual(out.map((c) => c.score), [61, 62, 63]);
  assert.deepEqual(out.map((c) => c.formSignal), [undefined, undefined, undefined]);
});

test('applyTeamFormSignal: a malformed context degrades to pure price rather than throwing', () => {
  const contexts = new Map([[fixtureKey(candidate()), { home: null, away: 'not an object' }]]);
  const out = applyTeamFormSignal([candidate({ score: 60 })], contexts, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 60);
});

/* ---------------------------------------------------------------- */
/* loadTeamContextsFor                                               */
/* ---------------------------------------------------------------- */

test('loadTeamContextsFor: one fetch per fixture, not per candidate', async () => {
  seedTeamContextCacheForTests(null);
  let calls = 0;
  const markets = ['h2h', 'spreads', 'totals'].map((marketKey) => candidate({ marketKey }));
  await loadTeamContextsFor(markets, ctx, {
    now: NOW,
    fetchFn: async () => { calls++; return context(); },
  });
  assert.equal(calls, 1, 'three markets on one game share one context');
  seedTeamContextCacheForTests({});
});

test('loadTeamContextsFor: skips sports with no ESPN league mapping, costing zero fetches', async () => {
  seedTeamContextCacheForTests(null);
  let calls = 0;
  const none = [
    candidate({ sportKey: 'icehockey_nhl' }),
    candidate({ sportKey: 'mma_mixed_martial_arts' }),
    candidate({ sportKey: 'tennis_atp_canadian_open' }),
  ];
  const out = await loadTeamContextsFor(none, ctx, { now: NOW, fetchFn: async () => { calls++; return context(); } });
  assert.equal(calls, 0);
  assert.equal(out.size, 0);
  seedTeamContextCacheForTests({});
});

test('loadTeamContextsFor: honours the fetch cap and spends it on the highest-scoring fixtures', async () => {
  seedTeamContextCacheForTests(null);
  const fetched = [];
  // 5 distinct fixtures, ascending score; a cap of 2 should take the top two.
  const many = [10, 20, 30, 40, 50].map((score, i) => ({
    ...candidate({ score }), home: `Home ${i}`, away: `Away ${i}`,
  }));
  const out = await loadTeamContextsFor(many, ctx, {
    now: NOW,
    max: 2,
    fetchFn: async ({ home }) => { fetched.push(home); return context(); },
  });
  assert.equal(fetched.length, 2);
  assert.deepEqual(fetched.sort(), ['Home 3', 'Home 4'], 'the two best-scoring games got the budget');
  assert.equal(out.size, 5, 'every fixture still gets an answer');
  assert.equal(out.get('basketball_wnba|Home 0|Away 0'), null, 'the ones over the cap resolve to null, not to a guess');
  seedTeamContextCacheForTests({});
});

test('loadTeamContextsFor: default cap is MAX_CONTEXT_FETCHES', async () => {
  seedTeamContextCacheForTests(null);
  let calls = 0;
  const many = Array.from({ length: MAX_CONTEXT_FETCHES + 5 }, (_, i) => ({
    ...candidate(), home: `H${i}`, away: `A${i}`,
  }));
  await loadTeamContextsFor(many, ctx, { now: NOW, fetchFn: async () => { calls++; return context(); } });
  assert.equal(calls, MAX_CONTEXT_FETCHES);
  seedTeamContextCacheForTests({});
});

test('loadTeamContextsFor: memoizes across calls, so batches in one tick share a fixture', async () => {
  seedTeamContextCacheForTests(null);
  let calls = 0;
  const fetchFn = async () => { calls++; return context(); };
  await loadTeamContextsFor([candidate()], ctx, { now: NOW, fetchFn });
  await loadTeamContextsFor([candidate()], ctx, { now: NOW, fetchFn });
  await loadTeamContextsFor([candidate()], ctx, { now: NOW, fetchFn });
  assert.equal(calls, 1, 'three selection batches, one fetch');
  seedTeamContextCacheForTests({});
});

test('loadTeamContextsFor: memoizes a null too — an unmatched fixture is not retried all day', async () => {
  seedTeamContextCacheForTests(null);
  let calls = 0;
  const fetchFn = async () => { calls++; return null; };
  await loadTeamContextsFor([candidate()], ctx, { now: NOW, fetchFn });
  const out = await loadTeamContextsFor([candidate()], ctx, { now: NOW, fetchFn });
  assert.equal(calls, 1);
  assert.equal(out.get(fixtureKey(candidate())), null);
  seedTeamContextCacheForTests({});
});

test('loadTeamContextsFor: a throwing fetch resolves to null instead of losing the board', async () => {
  seedTeamContextCacheForTests(null);
  const out = await loadTeamContextsFor([candidate()], ctx, {
    now: NOW,
    fetchFn: async () => { throw new Error('ESPN down'); },
  });
  assert.equal(out.get(fixtureKey(candidate())), null);
  seedTeamContextCacheForTests({});
});

test('seedTeamContextCacheForTests: seeding seals the memo — an unseeded fixture never fetches', async () => {
  seedTeamContextCacheForTests({ 'basketball_wnba|Atlanta Dream|Indiana Fever': context() });
  let calls = 0;
  const out = await loadTeamContextsFor(
    [candidate(), { ...candidate(), home: 'Other Home', away: 'Other Away' }],
    ctx,
    { now: NOW, fetchFn: async () => { calls++; return context(); } },
  );
  assert.equal(calls, 0, 'the seal is what keeps unit tests off the network');
  assert.ok(out.get('basketball_wnba|Atlanta Dream|Indiana Fever'), 'the seeded fixture resolves');
  assert.equal(out.get('basketball_wnba|Other Home|Other Away'), null, 'and an unseeded one degrades honestly');
  seedTeamContextCacheForTests({});
});
