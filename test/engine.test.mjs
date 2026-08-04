import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES,
  americanToDecimal,
  decimalToAmerican,
  combineLegs,
  devig,
  buildCandidates,
  analyze,
  generateSlate,
} from '../docs/engine.js';

const HOUR = 3.6e6;
const NOW = Date.parse('2026-08-04T12:00:00Z');

/* ---------------------------------------------------------------- */
/* Odds conversion                                                    */
/* ---------------------------------------------------------------- */

test('american <-> decimal round trips at the +100 pivot and beyond', () => {
  assert.equal(americanToDecimal(100), 2);
  assert.equal(americanToDecimal(-100), 2);
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(americanToDecimal(-200), 1.5);

  for (const a of [-250, -200, -150, -110, 100, 120, 150]) {
    assert.equal(decimalToAmerican(americanToDecimal(a)), a, `round trip ${a}`);
  }
});

test('devig removes the hold and returns probabilities summing to 1', () => {
  // Standard -110 / -110 market: 4.76% hold.
  const { fair, vig } = devig([-110, -110]);
  assert.ok(Math.abs(fair[0] + fair[1] - 1) < 1e-12);
  assert.ok(Math.abs(fair[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(vig - 0.0476) < 0.001);

  // Three-way market (soccer) also normalises.
  const threeWay = devig([150, 220, 180]);
  assert.equal(threeWay.fair.length, 3);
  assert.ok(Math.abs(threeWay.fair.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

/* ---------------------------------------------------------------- */
/* The core spec rule: -250..-151 must be paired toward +100          */
/* ---------------------------------------------------------------- */

test('combining two short-priced legs moves the ticket toward +100', () => {
  // -200 and -200 individually; together they clear even money.
  const combined = combineLegs([-200, -200]);
  assert.equal(combined.american, 125);
  assert.ok(
    Math.abs(combined.american - 100) < Math.abs(-200 - 100),
    'combined price must be closer to +100 than the anchor leg',
  );
});

test('a combo is allowed to exceed the +150 single-bet cap', () => {
  const combined = combineLegs([-160, -160]);
  assert.ok(combined.american > RULES.MAX_AMERICAN);
});

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const BOOKS = ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'BetRivers'];

/** Build an event whose h2h market sits at the requested prices. */
function makeEvent(id, homePrice, awayPrice, { hoursOut = 6, sport = 'basketball_nba' } = {}) {
  return {
    id,
    sport_key: sport,
    sport_title: 'NBA',
    commence_time: new Date(NOW + hoursOut * HOUR).toISOString(),
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: BOOKS.map((title, i) => ({
      key: title.toLowerCase(),
      title,
      last_update: new Date(NOW - 10 * 60 * 1000).toISOString(),
      markets: [
        {
          key: 'h2h',
          last_update: new Date(NOW - 10 * 60 * 1000).toISOString(),
          outcomes: [
            // One book (index 0) hangs a slightly better home price — the outlier.
            { name: `${id} Home`, price: homePrice + (i === 0 ? 10 : 0) },
            { name: `${id} Away`, price: awayPrice },
          ],
        },
      ],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* Candidate extraction                                               */
/* ---------------------------------------------------------------- */

test('candidates carry the best price and a consensus that excludes that book', () => {
  const [candidate] = buildCandidates([makeEvent('g1', -140, 120)], { now: NOW })
    .filter((c) => c.selection.startsWith('g1 Home'));

  // Book 0 offers -130 vs -140 elsewhere; best price should be the -130.
  assert.equal(candidate.american, -130);
  assert.equal(candidate.book, 'DraftKings');
  assert.equal(candidate.bookCount, BOOKS.length);
  // Consensus is drawn from the other four books only.
  assert.ok(candidate.consensusProb > 0.5 && candidate.consensusProb < 0.6);
  assert.ok(candidate.shopGain > 0, 'line shopping gain should be positive');
});

test('started and thinly-priced games are excluded', () => {
  const started = makeEvent('past', -140, 120, { hoursOut: -2 });
  assert.equal(buildCandidates([started], { now: NOW }).length, 0);

  const thin = makeEvent('thin', -140, 120);
  thin.bookmakers = thin.bookmakers.slice(0, 2); // below MIN_BOOKS
  assert.equal(buildCandidates([thin], { now: NOW }).length, 0);
});

/* ---------------------------------------------------------------- */
/* Slate construction                                                 */
/* ---------------------------------------------------------------- */

const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

test('every displayed leg respects the -250..+150 band', () => {
  const events = [
    makeEvent('a', -140, 120),
    makeEvent('b', -200, 170),
    makeEvent('c', -110, -110),
    makeEvent('d', -300, 240), // out of band on both sides
    makeEvent('e', -180, 155),
  ];
  const candidates = analyze(events, { now: NOW });

  for (let seed = 1; seed <= 50; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    assert.ok(picks.length >= 1 && picks.length <= 2, '1 to 2 picks displayed');
    for (const pick of picks) {
      for (const leg of pick.legs) {
        assert.ok(
          leg.american >= RULES.MIN_AMERICAN && leg.american <= RULES.MAX_AMERICAN,
          `leg ${leg.american} outside band`,
        );
      }
    }
  }
});

test('a leg priced -250..-151 is never shown alone, and its combo nears +100', () => {
  const events = [
    makeEvent('a', -220, 185),
    makeEvent('b', -210, 175),
    makeEvent('c', -230, 190),
    makeEvent('d', -240, 195),
  ];
  const candidates = analyze(events, { now: NOW });
  // Confirm the fixture actually produces short-priced anchors.
  assert.ok(candidates.some((c) => c.american > -250 && c.american < -150));

  let combosSeen = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    for (const pick of picks) {
      if (pick.type === 'single') {
        assert.ok(
          pick.american >= RULES.SINGLE_FLOOR,
          `single at ${pick.american} should have required a partner`,
        );
      } else {
        combosSeen++;
        assert.equal(pick.legs.length, 2);
        const anchor = pick.legs[0].american;
        assert.ok(
          Math.abs(pick.american - 100) < Math.abs(anchor - 100),
          `combo ${pick.american} is not closer to +100 than anchor ${anchor}`,
        );
      }
    }
  }
  assert.ok(combosSeen > 0, 'expected short-priced anchors to produce combos');
});

test('combo legs come from different games', () => {
  const candidates = analyze(
    [makeEvent('a', -220, 185), makeEvent('b', -210, 175), makeEvent('c', -190, 160)],
    { now: NOW },
  );

  for (let seed = 1; seed <= 40; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    for (const pick of picks.filter((p) => p.type === 'combo')) {
      assert.notEqual(pick.legs[0].eventId, pick.legs[1].eventId);
    }
    // Two displayed picks should also be two different games.
    if (picks.length === 2) {
      const events = picks.flatMap((p) => p.legs.map((l) => l.eventId));
      assert.equal(new Set(events).size, events.length);
    }
  }
});

test('poolSize reports every bet available at generation time', () => {
  const candidates = analyze([makeEvent('a', -140, 120), makeEvent('b', -200, 170)], {
    now: NOW,
  });
  const inBand = candidates.filter((c) => c.american >= -250 && c.american <= 150);
  const { poolSize } = generateSlate(candidates, { rng: seeded(7) });
  assert.equal(poolSize, inBand.length);
  assert.ok(poolSize > 0);
});

test('exclusions turn the slate over between taps', () => {
  const events = Array.from({ length: 8 }, (_, i) => makeEvent(`g${i}`, -130, 115));
  const candidates = analyze(events, { now: NOW });

  const seen = new Set();
  let novel = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { picks } = generateSlate(candidates, { exclude: seen, rng: seeded(seed) });
    for (const pick of picks) {
      if (!seen.has(pick.legs[0].id)) novel++;
      pick.legs.forEach((l) => seen.add(l.id));
    }
  }
  assert.ok(novel >= 5, `expected mostly new picks across taps, got ${novel}`);
});

test('an empty or unpriced slate degrades gracefully', () => {
  assert.deepEqual(generateSlate([], { rng: seeded(1) }).picks, []);
  assert.equal(analyze([], { now: NOW }).length, 0);
  assert.equal(analyze(undefined, { now: NOW }).length, 0);
});
