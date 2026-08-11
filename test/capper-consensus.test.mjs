import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  surnamesMatch,
  findConsensusPick,
  capperConsensusSignal,
  applyCapperConsensus,
} from '../docs/capper-consensus.js';
import { QUALITATIVE, scoreCandidate } from '../docs/engine.js';

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

test('non-h2h candidates and unknown fights return null', () => {
  assert.equal(capperConsensusSignal(FEED, mmaCandidate({ marketKey: 'totals' })), null);
  assert.equal(
    capperConsensusSignal(FEED, mmaCandidate({ home: 'Jon Jones', away: 'Stipe Miocic', outcomeName: 'Jon Jones' })),
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
  assert.ok(a.score - b.score <= 2 * QUALITATIVE.MAX_SWING + 1e-9);

  // Inputs are never mutated.
  assert.equal(aligned.capperConsensus, undefined);
  assert.equal(aligned.score, unmatched.score);
});

test('applyCapperConsensus passes through on an empty feed', () => {
  const candidates = [mmaCandidate()];
  assert.equal(applyCapperConsensus(candidates, null), candidates);
  assert.equal(applyCapperConsensus(candidates, { picks: [] }), candidates);
});
