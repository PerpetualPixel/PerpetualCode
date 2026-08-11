import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  surnamesMatch,
  findConsensusPick,
  capperConsensusSignal,
  applyCapperConsensus,
  fetchCapperConsensus,
  fightConsensusRecord,
  fightConsensusComments,
  consensusRescore,
  totalsSideOf,
  MMA_CONSENSUS_SWING,
  FEED_TTL_MS,
} from '../docs/capper-consensus.js';
import { scoreCandidate } from '../docs/engine.js';

const NOW = Date.parse('2026-08-11T12:00:00Z');

const FEED = {
  schema_version: 1,
  generated_at: '2026-08-11T07:28:17+00:00',
  picks: [
    {
      fight: 'Ian Machado Garry vs Islam Makhache', // truncated, as captions produce
      market: 'moneyline',
      selection: 'Islam Makhachev',
      consensus_pct: 100.0,
      strength: 8.0,
      tier: 'strong',
      pick_count: 3,
    },
    {
      fight: 'Mansour Abdul-Malik vs Dustin Stoltzfu',
      market: 'moneyline',
      selection: 'Mansour Abdul-Malik',
      consensus_pct: 100.0,
      strength: 8.5,
      tier: 'strong',
      pick_count: 4,
    },
    {
      // Non-moneyline entries must never match an h2h candidate.
      fight: 'Ian Machado Garry vs Islam Makhache',
      market: 'method_of_victory',
      selection: 'Islam Makhachev by submission',
      consensus_pct: 100.0,
      strength: 7.0,
      tier: 'lean',
      pick_count: 2,
      comments: [
        { capper: 'BetSlam with Sam', comment: 'Grappling gap is too wide.', confidence: 8 },
      ],
    },
    {
      fight: 'Ian Machado Garry vs Islam Makhache',
      market: 'over_under',
      market_label: 'Over / Under',
      selection: 'Fight does not go the distance',
      consensus_pct: 100.0,
      strength: 6.0,
      tier: 'lean',
      pick_count: 1,
      comments: [
        { capper: 'We Want Picks (Jacob)', comment: 'Islam finds a sub late.', confidence: 7 },
      ],
    },
  ],
};

function mmaCandidate(overrides = {}) {
  return {
    sportKey: 'mma_mixed_martial_arts',
    marketKey: 'h2h',
    home: 'Islam Makhachev',
    away: 'Ian Garry',
    outcomeName: 'Islam Makhachev',
    commenceMs: NOW + 24 * 3.6e6,
    updatedMs: NOW - 0.25 * 3.6e6,
    ev: 0.02,
    bookCount: 5,
    disagreement: 0.01,
    shopGain: 0.01,
    ...overrides,
  };
}

test('normalizeName strips punctuation and case', () => {
  assert.equal(normalizeName('  Mansour ABDUL-MALIK! '), 'mansour abdul-malik');
});

test('surnamesMatch handles caption truncation', () => {
  assert.ok(surnamesMatch('Islam Makhachev', 'Islam Makhache'));
  assert.ok(surnamesMatch('Dustin Stoltzfus', 'Dustin Stoltzfu'));
  assert.ok(!surnamesMatch('Jon Jones', 'Jose Aldo'));
});

test('short surnames require an exact match', () => {
  assert.ok(surnamesMatch('Deiveson Figueiredo', 'Figueiredo'));
  assert.ok(!surnamesMatch('Jung Yu', 'Zhang Yun'));
});

test('findConsensusPick requires both fighters to match', () => {
  const found = findConsensusPick(FEED, mmaCandidate());
  assert.equal(found.selection, 'Islam Makhachev');

  // Same surname, different opponent — must not match.
  const wrongFight = mmaCandidate({ away: 'Charles Oliveira', home: 'Islam Makhachev' });
  assert.equal(findConsensusPick(FEED, wrongFight), null);
});

test('signal is positive when the candidate is the consensus side', () => {
  const match = capperConsensusSignal(FEED, mmaCandidate());
  assert.ok(match.aligned);
  assert.equal(match.signal, 0.8); // strength 8.0 / 10
});

test('signal is negative for the opposite corner', () => {
  const match = capperConsensusSignal(FEED, mmaCandidate({ outcomeName: 'Ian Garry' }));
  assert.ok(!match.aligned);
  assert.equal(match.signal, -0.8);
});

test('unmatchable markets and unknown fights return null', () => {
  assert.equal(capperConsensusSignal(FEED, mmaCandidate({ marketKey: 'spreads' })), null);
  assert.equal(
    capperConsensusSignal(FEED, mmaCandidate({ home: 'Jon Jones', away: 'Stipe Miocic', outcomeName: 'Jon Jones' })),
    null,
  );
});

/* --- rounds totals: the feed's over_under entries carry a signal too --- */

test('totalsSideOf reads direction from capper phrasing', () => {
  assert.deepEqual(totalsSideOf('Fight does not go the distance'), { side: 'Under', point: null });
  assert.deepEqual(totalsSideOf("Fight doesn't go the distance"), { side: 'Under', point: null });
  assert.deepEqual(totalsSideOf('Fight goes the distance'), { side: 'Over', point: null });
  assert.deepEqual(totalsSideOf('Fight goes to a decision'), { side: 'Over', point: null });
  assert.deepEqual(totalsSideOf('Under 2.5 rounds'), { side: 'Under', point: 2.5 });
  assert.deepEqual(totalsSideOf('Over 1.5'), { side: 'Over', point: 1.5 });
  assert.equal(totalsSideOf('Islam Makhachev by submission'), null);
  assert.equal(totalsSideOf(''), null);
});

test('a totals candidate gets a signed signal from the over_under entry', () => {
  const under = capperConsensusSignal(FEED, mmaCandidate({ marketKey: 'totals', outcomeName: 'Under', point: 4.5 }));
  assert.ok(under.aligned);
  assert.equal(under.signal, 0.6); // strength 6.0 / 10

  const over = capperConsensusSignal(FEED, mmaCandidate({ marketKey: 'totals', outcomeName: 'Over', point: 4.5 }));
  assert.ok(!over.aligned);
  assert.equal(over.signal, -0.6);
});

test('a point-specific consensus only speaks to its exact line', () => {
  const feed = {
    picks: [{
      fight: 'Ian Machado Garry vs Islam Makhache',
      market: 'over_under',
      selection: 'Under 2.5 rounds',
      strength: 6.0,
      tier: 'lean',
      pick_count: 1,
    }],
  };
  const exact = capperConsensusSignal(feed, mmaCandidate({ marketKey: 'totals', outcomeName: 'Under', point: 2.5 }));
  assert.ok(exact.aligned);
  assert.equal(
    capperConsensusSignal(feed, mmaCandidate({ marketKey: 'totals', outcomeName: 'Under', point: 4.5 })),
    null,
  );
});

test('applyCapperConsensus rescores matched MMA candidates only', () => {
  // Pre-scored, as analyze() delivers them in the real flow.
  const scored = (c) => ({ ...c, ...scoreCandidate(c, { now: NOW }) });
  const aligned = scored(mmaCandidate());
  const opposed = scored(mmaCandidate({ outcomeName: 'Ian Garry' }));
  const unmatched = scored(mmaCandidate({ home: 'Jon Jones', away: 'Stipe Miocic', outcomeName: 'Jon Jones' }));
  const nonMma = scored({ ...mmaCandidate(), sportKey: 'basketball_nba' });

  const [a, b, c, d] = applyCapperConsensus([aligned, opposed, unmatched, nonMma], FEED, { now: NOW });

  assert.ok(a.capperConsensus.aligned);
  assert.equal(a.capperConsensus.selection, 'Islam Makhachev');
  assert.ok(!b.capperConsensus.aligned);
  assert.equal(c.capperConsensus, undefined);
  assert.equal(d.capperConsensus, undefined);

  // The swing is real and symmetric: aligned scores above unmatched, opposed below.
  assert.ok(a.score > c.score);
  assert.ok(b.score < c.score);
  assert.ok(a.score - b.score <= 2 * MMA_CONSENSUS_SWING + 1e-9);
  // And decisive: a strong consensus moves the grade far beyond the generic
  // ±8 qualitative clamp — this is the number that lets the cappers' side
  // out-rank a same-fight market with merely cleaner price liquidity.
  assert.ok(a.score - c.score > 8);

  // Inputs are never mutated.
  assert.equal(aligned.capperConsensus, undefined);
  assert.equal(aligned.score, unmatched.score);
});

test('applyCapperConsensus passes through on an empty feed', () => {
  const candidates = [mmaCandidate()];
  assert.equal(applyCapperConsensus(candidates, null), candidates);
  assert.equal(applyCapperConsensus(candidates, { picks: [] }), candidates);
});

/* --- the fight's consensus, for a drawer opened on any market --- */

test('a market the feed cannot grade still resolves its fight, marked as not scored', () => {
  // Full Slate's "More info" can open on a market the feed has no entry
  // shaped like (a spread) — the fight's moneyline consensus still shows,
  // it just never claims to have moved that pick's grade.
  const spread = mmaCandidate({ marketKey: 'spreads' });
  assert.equal(capperConsensusSignal(FEED, spread), null); // no swing, correctly

  const record = fightConsensusRecord(FEED, spread);
  assert.equal(record.selection, 'Islam Makhachev');
  assert.equal(record.pickCount, 3);
  assert.equal(record.scored, false); // never claims it moved this grade
  assert.equal(record.aligned, null); // a spread is neither with nor against
});

/* --- capper comments: the WHY behind the consensus --- */

test('consensusRecord carries the feed entry comments', () => {
  const [c] = applyCapperConsensus([mmaCandidate()], FEED, { now: NOW });
  assert.deepEqual(c.capperConsensus.comments, []); // moneyline entry has none in this fixture
  const totals = applyCapperConsensus(
    [mmaCandidate({ marketKey: 'totals', outcomeName: 'Under', point: 4.5 })], FEED, { now: NOW },
  )[0];
  assert.equal(totals.capperConsensus.comments.length, 1);
  assert.equal(totals.capperConsensus.comments[0].capper, 'We Want Picks (Jacob)');
});

test('fightConsensusComments aggregates every market entry, labelled and deduped', () => {
  const comments = fightConsensusComments(FEED, mmaCandidate());
  assert.equal(comments.length, 2);
  const byCapper = Object.fromEntries(comments.map((c) => [c.capper, c]));
  assert.equal(byCapper['BetSlam with Sam'].selection, 'Islam Makhachev by submission');
  assert.equal(byCapper['We Want Picks (Jacob)'].marketLabel, 'Over / Under');

  // The same comment attached to two entries reads once.
  const dupFeed = {
    picks: [
      { fight: 'A Aa vs B Bb', market: 'moneyline', selection: 'A Aa', comments: [{ capper: 'X', comment: 'same' }] },
      { fight: 'A Aa vs B Bb', market: 'method_of_victory', selection: 'A Aa by KO', comments: [{ capper: 'X', comment: 'same' }] },
    ],
  };
  const cand = mmaCandidate({ home: 'A Aa', away: 'B Bb', outcomeName: 'A Aa' });
  assert.equal(fightConsensusComments(dupFeed, cand).length, 1);
});

test('consensusRescore applies the full MMA swing outside the qualitative clamp', () => {
  const c = { ...mmaCandidate(), ...scoreCandidate(mmaCandidate(), { now: NOW }) };
  const base = scoreCandidate(c, { now: NOW }).score;
  const up = consensusRescore(c, 1, { now: NOW });
  const down = consensusRescore(c, -1, { now: NOW });
  assert.equal(up.score, Math.min(100, base + MMA_CONSENSUS_SWING));
  assert.equal(down.score, Math.max(0, base - MMA_CONSENSUS_SWING));
});

test('the scored record from applyCapperConsensus is marked as such', () => {
  const [c] = applyCapperConsensus([mmaCandidate()], FEED, { now: NOW });
  assert.equal(c.capperConsensus.scored, true);
  assert.equal(c.capperConsensus.aligned, true);
});

test('fightConsensusRecord is null for an unknown fight or a missing feed', () => {
  const unknown = mmaCandidate({ home: 'Jon Jones', away: 'Stipe Miocic', outcomeName: 'Jon Jones' });
  assert.equal(fightConsensusRecord(FEED, unknown), null);
  assert.equal(fightConsensusRecord(null, mmaCandidate()), null);
});

/* --- fetching: freshness is the whole point after a weekly.bat push --- */

// The module's feed cache is process-wide, so each test starts from a clock
// far enough ahead of the last one that the previous test's entry is stale.
let clock = 1_000_000;
function nextWindow() {
  clock += 10 * FEED_TTL_MS;
  return clock;
}

function stubFetch(bodies) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, json: async () => bodies[Math.min(calls.length - 1, bodies.length - 1)] };
  };
  return calls;
}

test('every request is cache-busted and bypasses the HTTP cache', async () => {
  const calls = stubFetch([FEED]);
  const now = nextWindow();
  await fetchCapperConsensus('https://example.test/picks.json', { now });
  assert.equal(calls[0].url, `https://example.test/picks.json?t=${now}`);
  assert.equal(calls[0].opts.cache, 'no-store');
});

test('a second call inside the TTL is served from memory', async () => {
  const calls = stubFetch([FEED]);
  const now = nextWindow();
  await fetchCapperConsensus('https://example.test/a.json', { now });
  await fetchCapperConsensus('https://example.test/a.json', { now: now + FEED_TTL_MS - 1 });
  assert.equal(calls.length, 1);
});

test('force refetches inside the TTL and picks up a newer feed', async () => {
  const pushed = { ...FEED, generated_at: '2026-08-11T09:00:00+00:00' };
  const calls = stubFetch([FEED, pushed]);
  const now = nextWindow();
  await fetchCapperConsensus('https://example.test/b.json', { now });
  const fresh = await fetchCapperConsensus('https://example.test/b.json', { now: now + 500, force: true });
  assert.equal(calls.length, 2);
  assert.equal(fresh.generated_at, pushed.generated_at);
  assert.notEqual(calls[0].url, calls[1].url); // distinct busters, or the CDN replays the old body
});

test('a failed refetch keeps the last good feed rather than blanking the board', async () => {
  stubFetch([FEED]);
  const now = nextWindow();
  const good = await fetchCapperConsensus('https://example.test/c.json', { now });
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  const after = await fetchCapperConsensus('https://example.test/c.json', { now: now + 500, force: true });
  assert.equal(after, good);
});
