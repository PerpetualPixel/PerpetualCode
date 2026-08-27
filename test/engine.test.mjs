import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES,
  SPORTSBOOKS,
  americanToDecimal,
  decimalToAmerican,
  combineLegs,
  devig,
  buildCandidates,
  scoreCandidate,
  isNflPreseason,
  isNflPreseasonKey,
  QUALITATIVE,
  UNDERDOG_PROB_PENALTY,
  analyze,
  generateSlate,
  topPicks,
  KELLY,
  kellyFraction,
  suggestedStake,
  suggestedParlayStake,
  contradicts,
  confidenceColor,
  bookOffers,
  bookIdFor,
  explain,
  explainExtensive,
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

// A deeper market with a bigger outlier, so candidates clear RULES.MIN_SCORE.
// The thin 5-book / +10-outlier fixture above grades in the 40s by design —
// realistic, but below the floor, so it can't drive slate tests any more.
const DEEP_BOOKS = [...BOOKS, 'ESPN BET', 'Fanatics', 'Hard Rock Bet'];
const SHARP = { outlier: 35, books: DEEP_BOOKS };

/** Book title -> the key The Odds API would return for it. */
const BOOK_KEYS = {
  DraftKings: 'draftkings',
  FanDuel: 'fanduel',
  BetMGM: 'betmgm',
  Caesars: 'williamhill_us', // Caesars still ships under its old owner's key.
  BetRivers: 'betrivers',
  'ESPN BET': 'espnbet',
  Fanatics: 'fanatics',
  'Hard Rock Bet': 'hardrockbet',
};

/** Build an event whose h2h market sits at the requested prices. */
function makeEvent(
  id,
  homePrice,
  awayPrice,
  {
    hoursOut = 6,
    sport = 'basketball_nba',
    sportTitle = 'NBA',
    outlier = 10,
    // A second book hanging the best price on the *other* side, so both sides of
    // the game grade well. Without this the underdog always scores badly and
    // never gets picked, which hides same-game bugs.
    awayOutlier = 0,
    books = BOOKS,
  } = {},
) {
  return {
    id,
    sport_key: sport,
    sport_title: sportTitle,
    commence_time: new Date(NOW + hoursOut * HOUR).toISOString(),
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: books.map((title, i) => ({
      key: BOOK_KEYS[title] ?? title.toLowerCase(),
      title,
      last_update: new Date(NOW - 10 * 60 * 1000).toISOString(),
      markets: [
        {
          key: 'h2h',
          last_update: new Date(NOW - 10 * 60 * 1000).toISOString(),
          outcomes: [
            // One book (index 0) hangs a better home price — the outlier.
            { name: `${id} Home`, price: homePrice + (i === 0 ? outlier : 0) },
            { name: `${id} Away`, price: awayPrice + (i === 1 ? awayOutlier : 0) },
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

test('a single-book MMA fight gets a real consensus probability, not NaN', () => {
  // MMA is allowed through on one book (thin PFL/regional cards are often
  // priced by a single sportsbook), which left nothing to benchmark
  // against: median([]) is NaN, and it rendered beside the fighter's name
  // as a literal "NaN%" — confirmed live on Richie Lewis, Rasul Magomedov
  // and Sidney Outlaw.
  const fight = makeEvent('mma1', -110, -110, { sport: 'mma_mixed_martial_arts', sportTitle: 'MMA' });
  fight.bookmakers = fight.bookmakers.slice(0, 1);

  const candidates = buildCandidates([fight], { now: NOW });
  assert.equal(candidates.length, 2, 'both fighters still priced off the one book');

  for (const c of candidates) {
    assert.ok(Number.isFinite(c.consensusProb), `consensusProb must be a real number, got ${c.consensusProb}`);
    assert.ok(c.consensusProb > 0 && c.consensusProb < 1);
    assert.ok(Number.isFinite(c.fairAmerican), `fairAmerican must be a real number, got ${c.fairAmerican}`);
    assert.ok(Number.isFinite(c.ev));
    // The lone book is both the benchmark and the bet, so EV collapses to
    // the vig — negative. A single-book side must never be able to invent
    // an edge for itself out of its own price.
    assert.ok(c.ev < 0, `single-book EV should be negative (the vig), got ${c.ev}`);
    assert.equal(c.bookCount, 1);
  }

  // Both sides de-vigged against each other still sum to a whole market.
  const total = candidates.reduce((sum, c) => sum + c.consensusProb, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `two-way consensus should sum to 1, got ${total}`);
});

test('a multi-book market still benchmarks against the other books only', () => {
  // Guards the fix above from over-reaching: the moment a second book
  // exists, the bet's own price is excluded from its own benchmark again.
  const [candidate] = buildCandidates([makeEvent('g2', -140, 120)], { now: NOW })
    .filter((c) => c.selection.startsWith('g2 Home'));
  const ownFairProb = candidate.quotes[0].american;
  assert.equal(ownFairProb, -130, 'fixture: book 0 hangs the outlier best price');
  // -130 de-vigged would sit above the consensus the other four books make.
  assert.ok(candidate.consensusProb < 1 / americanToDecimal(-130));
});

/* ---------------------------------------------------------------- */
/* Per-book quotes — what the sportsbook buttons render from           */
/* ---------------------------------------------------------------- */

test('candidates keep every book on the line, best price first', () => {
  const [candidate] = buildCandidates([makeEvent('g1', -140, 120)], { now: NOW })
    .filter((c) => c.selection.startsWith('g1 Home'));

  assert.equal(candidate.quotes.length, BOOKS.length);
  // Sorted best-first, so quotes[0] is the price the card headlines.
  assert.equal(candidate.quotes[0].american, candidate.american);
  for (let i = 1; i < candidate.quotes.length; i++) {
    assert.ok(
      candidate.quotes[i - 1].decimal >= candidate.quotes[i].decimal,
      'quotes must be sorted best price first',
    );
  }
  // Free-tier payloads carry no deep links; the field exists and is null.
  assert.equal(candidate.quotes[0].link, null);
});

test('book offers map API keys onto the registry, including renamed books', () => {
  assert.equal(bookIdFor('williamhill_us'), 'caesars');
  assert.equal(bookIdFor('FanDuel'), 'fanduel', 'key match is case-insensitive');
  assert.equal(bookIdFor('some_offshore_book'), null);

  const [candidate] = buildCandidates([makeEvent('g1', -140, 120)], { now: NOW })
    .filter((c) => c.selection.startsWith('g1 Home'));

  const offers = bookOffers(candidate);
  assert.equal(offers.get('draftkings').american, -130);
  assert.equal(offers.get('caesars').american, -140);
  // A book the user selected but that isn't on this line has no offer, which is
  // what greys its button out rather than hiding it.
  assert.equal(offers.get('kalshi'), undefined);
});

test('every registry book has the fields the UI renders', () => {
  for (const [id, meta] of Object.entries(SPORTSBOOKS)) {
    assert.ok(meta.name, `${id} needs a name`);
    assert.match(meta.color, /^#[0-9a-f]{6}$/i, `${id} needs a hex colour`);
    assert.match(meta.url, /^https:\/\//, `${id} needs an https url`);
    assert.ok(meta.keys.length, `${id} needs at least one API key`);
  }
});

/* ---------------------------------------------------------------- */
/* Confidence colour                                                  */
/* ---------------------------------------------------------------- */

test('confidence ramps amber to green with nothing red', () => {
  const rgb = (score) => confidenceColor(score).match(/\d+/g).map(Number);

  const floor = rgb(RULES.MIN_SCORE);
  const top = rgb(100);

  // Amber at the floor: red-dominant, almost no blue.
  assert.ok(floor[0] > floor[1] && floor[2] < 80, `expected amber, got ${floor}`);
  // Green at the top: green-dominant.
  assert.ok(top[1] > top[0], `expected green, got ${top}`);

  // Blue climbs steadily as the ramp turns from amber to green. Red is not
  // monotonic — it bottoms out around 90 and rises a little to meet the target
  // green's own red channel — so the invariant that matters is that the colour
  // never darkens into a warning: green stays bright the whole way.
  let prevBlue = floor[2];
  for (let s = RULES.MIN_SCORE + 5; s <= 100; s += 5) {
    const [r, g, b] = rgb(s);
    assert.ok(b >= prevBlue, `blue should not fall at ${s}`);
    assert.ok(g >= floor[1], `green channel dimmed at ${s} — reads as a warning`);
    assert.ok(r < 255 && g > 100, `${s} should never render as red`);
    prevBlue = b;
  }

  // Red gives way to green across the range as a whole.
  assert.ok(top[0] < floor[0] - 100, 'red should drop substantially by 100');

  // Out-of-range scores clamp rather than producing nonsense channels.
  assert.deepEqual(rgb(0), floor);
  assert.deepEqual(rgb(140), top);
});

/* ---------------------------------------------------------------- */
/* Scoring — qualitative swing                                        */
/* ---------------------------------------------------------------- */

test('scoreCandidate with no qualitative argument matches today\'s price-only formula exactly', () => {
  const [c] = buildCandidates(
    [makeEvent('a', -140, 120, { ...SHARP, sport: 'americanfootball_nfl' })],
    { now: NOW },
  );
  const withDefault = scoreCandidate(c, { now: NOW });
  const explicitZero = scoreCandidate(c, { now: NOW, qualitative: 0 });
  assert.equal(withDefault.score, explicitZero.score);
  assert.equal(withDefault.parts.qualitative, 0);
});

test('a full +1/-1 qualitative signal swings the score by exactly QUALITATIVE.MAX_SWING before clamping', () => {
  const [c] = buildCandidates(
    // A mid-pack price so the swing has room to move without hitting 0 or 100.
    [makeEvent('a', -140, 120, { ...SHARP, outlier: 15, sport: 'americanfootball_nfl' })],
    { now: NOW },
  );
  const base = scoreCandidate(c, { now: NOW }).score;
  const up = scoreCandidate(c, { now: NOW, qualitative: 1 }).score;
  const down = scoreCandidate(c, { now: NOW, qualitative: -1 }).score;
  assert.ok(Math.abs(up - (base + QUALITATIVE.MAX_SWING)) < 1e-9);
  assert.ok(Math.abs(down - (base - QUALITATIVE.MAX_SWING)) < 1e-9);
});

test('score stays clamped to [0, 100] even when the qualitative swing would push it past the bounds', () => {
  // Deliberately extreme, well inside the sharp band, everything maxed out —
  // priceScore alone should already be sitting near the top of the range.
  const [strong] = buildCandidates(
    [makeEvent('a', -140, 120, { ...SHARP, outlier: 40, sport: 'americanfootball_nfl' })],
    { now: NOW },
  );
  const high = scoreCandidate(strong, { now: NOW, qualitative: 1 });
  assert.ok(high.score <= 100);

  // A synthetic worst-case candidate (bypassing buildCandidates/makeEvent,
  // which can't easily produce a near-zero price score) shouldn't go
  // negative on a -1 qualitative signal either.
  const weak = {
    ev: -0.03, bookCount: RULES.MIN_BOOKS, disagreement: 0.05, shopGain: 0,
    commenceMs: NOW + 200 * HOUR, updatedMs: NOW - 20 * HOUR,
  };
  const low = scoreCandidate(weak, { now: NOW, qualitative: -1 });
  assert.ok(low.score >= 0);
});

test('a modest qualitative signal flips a close price call but cannot flip a lopsided one', () => {
  // Two candidates a few score-points apart — small enough for MAX_SWING=8 to close the gap.
  const [closeA] = buildCandidates(
    [makeEvent('a', -140, 120, { ...SHARP, outlier: 10, sport: 'americanfootball_nfl' })],
    { now: NOW },
  );
  const [closeB] = buildCandidates(
    [makeEvent('b', -140, 120, { ...SHARP, outlier: 12, sport: 'americanfootball_nfl' })],
    { now: NOW },
  );
  const a1 = scoreCandidate(closeA, { now: NOW }).score;
  const b1 = scoreCandidate(closeB, { now: NOW }).score;
  assert.ok(Math.abs(a1 - b1) < QUALITATIVE.MAX_SWING, 'fixture must actually be close enough to flip');
  const bBoosted = scoreCandidate(closeB, { now: NOW, qualitative: b1 < a1 ? 1 : -1 }).score;
  assert.ok((bBoosted > a1) !== (b1 > a1), 'a modest signal must be able to flip a close ranking');

  // A deliberately lopsided pair — full MAX_SWING in the trailing side's favor still can't catch up.
  const [lopsidedStrong] = buildCandidates(
    [makeEvent('c', -140, 120, { ...SHARP, outlier: 40, sport: 'americanfootball_nfl' })],
    { now: NOW },
  );
  const lopsidedWeak = {
    ev: -0.03, bookCount: RULES.MIN_BOOKS, disagreement: 0.05, shopGain: 0,
    commenceMs: NOW + 200 * HOUR, updatedMs: NOW - 20 * HOUR,
  };
  const strongScore = scoreCandidate(lopsidedStrong, { now: NOW }).score;
  const weakBoosted = scoreCandidate(lopsidedWeak, { now: NOW, qualitative: 1 }).score;
  assert.ok(weakBoosted < strongScore, 'a full qualitative signal must not overturn a real, lopsided price edge');
});

/* ---------------------------------------------------------------- */
/* Contradictions                                                     */
/* ---------------------------------------------------------------- */

test('contradicts flags both sides of one market, not different markets', () => {
  const homeML = { eventId: 'g1', marketKey: 'h2h' };
  const awayML = { eventId: 'g1', marketKey: 'h2h' };
  const awaySpread = { eventId: 'g1', marketKey: 'spreads' };
  const otherGame = { eventId: 'g2', marketKey: 'h2h' };

  // One side winning requires the other to lose.
  assert.equal(contradicts(homeML, awayML), true);
  // A team can lose outright and still cover, so this pairing is allowed.
  assert.equal(contradicts(homeML, awaySpread), false);
  assert.equal(contradicts(homeML, otherGame), false);
});

/* ---------------------------------------------------------------- */
/* Slate construction                                                 */
/* ---------------------------------------------------------------- */

/**
 * Seeded RNG. The seed is hashed before the first draw on purpose: feeding a
 * small integer straight into the LCG makes the *first* value land in a narrow
 * band (0.24–0.39 for seeds 1–400), and generateSlate spends its first draw
 * deciding whether to show one pick or two. Without the hash every seeded run
 * produced a single pick, and no test could ever observe a two-pick slate.
 */
const seeded = (seed) => {
  let s = Math.imul(seed, 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** Every leg on the board, across every displayed pick. */
const allLegs = (picks) => picks.flatMap((p) => p.legs);

test('every displayed leg respects the -250..+150 band', () => {
  const events = [
    makeEvent('a', -140, 120, SHARP),
    makeEvent('b', -200, 170, SHARP),
    makeEvent('c', -110, -110, SHARP),
    makeEvent('d', -300, 240, SHARP), // out of band on both sides
    makeEvent('e', -180, 155, SHARP),
  ];
  const candidates = analyze(events, { now: NOW });

  for (let seed = 1; seed <= 50; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    assert.ok(picks.length >= 1 && picks.length <= 2, '1 to 2 picks displayed');
    for (const leg of allLegs(picks)) {
      assert.ok(
        leg.american >= RULES.MIN_AMERICAN && leg.american <= RULES.MAX_AMERICAN,
        `leg ${leg.american} outside band`,
      );
    }
  }
});

test('nothing below the confidence floor reaches the board', () => {
  const events = [
    makeEvent('a', -140, 120, SHARP),
    makeEvent('b', -200, 170, SHARP),
    makeEvent('c', -110, -110, SHARP),
  ];
  const candidates = analyze(events, { now: NOW });
  // The fixture must actually contain sub-floor candidates for this to bite.
  assert.ok(candidates.some((c) => c.score < RULES.MIN_SCORE));

  for (let seed = 1; seed <= 40; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    for (const leg of allLegs(picks)) {
      assert.ok(leg.score >= RULES.MIN_SCORE, `leg graded ${leg.score.toFixed(1)}`);
    }
  }

  // A board where nothing qualifies returns nothing rather than lowering itself.
  const weak = analyze([makeEvent('w', -140, 120)], { now: NOW });
  assert.equal(generateSlate(weak, { rng: seeded(1) }).picks.length, 0);
  assert.equal(generateSlate(weak, { rng: seeded(1) }).poolSize, 0);
});

test('a leg priced -250..-151 is never shown alone, and its combo nears +100', () => {
  const events = [
    makeEvent('a', -220, 185, SHARP),
    makeEvent('b', -210, 175, SHARP),
    makeEvent('c', -230, 190, SHARP),
    makeEvent('d', -240, 195, SHARP),
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
    [
      makeEvent('a', -220, 185, SHARP),
      makeEvent('b', -210, 175, SHARP),
      makeEvent('c', -190, 160, SHARP),
    ],
    { now: NOW },
  );

  for (let seed = 1; seed <= 40; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    for (const pick of picks.filter((p) => p.type === 'combo')) {
      assert.notEqual(pick.legs[0].eventId, pick.legs[1].eventId);
    }
  }
});

test('the board never argues with itself, including via combo partners', () => {
  // Regression fixture, tuned to the exact shape that used to break:
  //
  //   X  — the underdog is the best-graded bet on the board, so pick #1 takes
  //        it, leaving X's short-priced favourite loose in the pool.
  //   s* — anchors in the -250..-151 band, so pick #2 must go looking for a
  //        partner, and a short favourite is precisely what scores best there.
  //
  // The old slate builder blocked a used game from supplying another *anchor*
  // but never checked partners, so pick #2 quietly pulled X's favourite in and
  // the board showed both sides of X winning.
  const events = [makeEvent('X', -165, 135, { ...SHARP, outlier: 0, awayOutlier: 45 })];
  for (let i = 0; i < 6; i++) {
    events.push(makeEvent(`s${i}`, -225 - i * 4, 150 - i, { ...SHARP, outlier: 45 }));
  }
  for (let i = 0; i < 3; i++) {
    events.push(makeEvent(`f${i}`, -120 - i, 102 + i, { ...SHARP, outlier: 8 }));
  }
  const candidates = analyze(events, { now: NOW });

  let twoPickSlates = 0;
  let combosSeen = 0;

  for (let seed = 1; seed <= 600; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    if (picks.length === 2) twoPickSlates++;
    combosSeen += picks.filter((p) => p.type === 'combo').length;

    const legs = allLegs(picks);
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        assert.equal(
          contradicts(legs[i], legs[j]),
          false,
          `seed ${seed}: "${legs[i].selection}" contradicts "${legs[j].selection}"`,
        );
      }
    }
  }

  // Guards against the test quietly going vacuous: a board that never shows two
  // picks, or never builds a combo, cannot contradict itself no matter what the
  // slate builder does.
  assert.ok(twoPickSlates > 50, `expected two-pick slates, saw ${twoPickSlates}`);
  assert.ok(combosSeen > 50, `expected combos to be built, saw ${combosSeen}`);
});

test('picks report where they rank against the board they came from', () => {
  const events = [
    makeEvent('a', -140, 120, SHARP),
    makeEvent('b', -200, 170, SHARP),
    makeEvent('c', -110, -110, SHARP),
    makeEvent('e', -180, 155, SHARP),
  ];
  const candidates = analyze(events, { now: NOW });

  for (let seed = 1; seed <= 30; seed++) {
    const { picks } = generateSlate(candidates, { rng: seeded(seed) });
    for (const pick of picks) {
      assert.ok(
        pick.percentile >= 0 && pick.percentile <= 100,
        `percentile ${pick.percentile} out of range`,
      );
    }
  }
});

test('poolSize reports every qualifying bet at generation time', () => {
  const candidates = analyze(
    [makeEvent('a', -140, 120, SHARP), makeEvent('b', -200, 170, SHARP)],
    { now: NOW },
  );
  const qualifying = candidates.filter(
    (c) =>
      c.american >= RULES.MIN_AMERICAN &&
      c.american <= RULES.MAX_AMERICAN &&
      c.score >= RULES.MIN_SCORE,
  );
  const { poolSize } = generateSlate(candidates, { rng: seeded(7) });
  assert.equal(poolSize, qualifying.length);
  assert.ok(poolSize > 0);
});

test('exclusions turn the slate over between taps', () => {
  const events = Array.from({ length: 8 }, (_, i) =>
    makeEvent(`g${i}`, -130, 115, SHARP),
  );
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

/* ---------------------------------------------------------------- */
/* topPicks — flat, cross-sport, user-adjustable ranking               */
/* ---------------------------------------------------------------- */

test('topPicks returns straight bets only, never an auto-paired combo', () => {
  // -220 is well short of SINGLE_FLOOR (-150) — generateSlate would pair this
  // with a partner leg. topPicks must show it as its own single-leg pick at
  // its own real price instead, so the user can build their own parlay.
  const candidates = analyze(
    [makeEvent('a', -220, 185, SHARP), makeEvent('b', -210, 175, SHARP)],
    { now: NOW },
  );
  const { picks } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500 });
  assert.ok(picks.length > 0);
  for (const pick of picks) {
    assert.equal(pick.type, 'single');
    assert.equal(pick.legs.length, 1);
    assert.equal(pick.american, pick.legs[0].american);
  }
});

test('topPicks ranks purely by score, highest first, regardless of sport', () => {
  const candidates = analyze(
    [
      makeEvent('a', -140, 120, { ...SHARP, sport: 'baseball_mlb', sportTitle: 'MLB' }),
      makeEvent('b', -180, 155, { ...SHARP, sport: 'americanfootball_nfl', sportTitle: 'NFL' }),
      makeEvent('c', -110, -110, { ...SHARP, sport: 'mma_mixed_martial_arts', sportTitle: 'MMA' }),
    ],
    { now: NOW },
  );
  const { picks } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, count: 8 });
  const scores = picks.map((p) => p.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'must be sorted descending');
});

test('topPicks caps at `count` even when more qualify', () => {
  const events = Array.from({ length: 12 }, (_, i) => makeEvent(`g${i}`, -130, 115, SHARP));
  const candidates = analyze(events, { now: NOW });
  const { picks, poolSize } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, count: 8 });
  assert.ok(poolSize > 8, 'fixture must produce more than 8 qualifiers to test the cap');
  assert.equal(picks.length, 8);
});

test('topPicks respects a caller-supplied odds range and confidence floor', () => {
  const candidates = analyze(
    [
      makeEvent('a', -140, 120, SHARP), // in -250..150
      makeEvent('b', -700, 550, SHARP), // needs the widened range to qualify
    ],
    { now: NOW },
  );

  const narrow = topPicks(candidates, { oddsMin: -250, oddsMax: 150, minScore: 0 });
  assert.ok(narrow.picks.every((p) => p.american >= -250 && p.american <= 150));

  const widened = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0 });
  assert.ok(
    widened.picks.some((p) => p.american < -250 || p.american > 150),
    'widening the range must surface the -700/+550 leg the default band excludes',
  );

  // A confidence floor above every candidate's grade empties the slate — the
  // whole point of an adjustable floor is that this is a real, expected state.
  const strict = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 99.9 });
  assert.deepEqual(strict.picks, []);
});

test('topPicks with minEv/minKelly rejects a score-clearing but -EV or dust-edge candidate', () => {
  // A near-coin-flip line (-117 vs -108) with a small outlier still clears
  // MIN_SCORE (50) on liquidity/agreement/freshness alone despite negative
  // EV — this is the exact "51/100 confidence on -117 juice" pattern real
  // users hit: the composite score says "clean number," not "worth taking."
  const juicy = makeEvent('juicy', -117, -108, { ...SHARP, outlier: 10 });
  const real = makeEvent('real', -140, 120, SHARP); // genuine ~9.7% EV edge
  const candidates = analyze([juicy, real], { now: NOW });

  // Without opting in, both still surface — existing callers are unaffected.
  const unfiltered = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0, count: 8 });
  assert.ok(unfiltered.picks.some((p) => p.legs[0].eventId === 'juicy'));

  // Opted in, the -EV score-clearer is rejected even though it clears
  // MIN_SCORE; the genuine-edge candidate still comes through.
  const filtered = topPicks(candidates, {
    oddsMin: -1000, oddsMax: 500, minScore: 0, count: 8,
    minEv: RULES.MIN_EV_PCT, minKelly: RULES.MIN_KELLY_FRACTION,
  });
  assert.ok(
    !filtered.picks.some((p) => p.legs[0].eventId === 'juicy'),
    'a -EV candidate must never surface once minEv is set, regardless of score',
  );
  assert.ok(filtered.picks.some((p) => p.legs[0].eventId === 'real'));
});

test('topPicks never shows both sides of the same game and market', () => {
  const candidates = analyze(
    [makeEvent('a', -140, 120, { ...SHARP, awayOutlier: 45 })],
    { now: NOW },
  );
  const { picks } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, count: 8 });
  const legs = picks.map((p) => p.legs[0]);
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      assert.ok(!contradicts(legs[i], legs[j]), 'both sides of one market must not both appear');
    }
  }
});

test('topPicks recycles exclusions once fewer than `count` remain fresh', () => {
  const events = Array.from({ length: 4 }, (_, i) => makeEvent(`g${i}`, -130, 115, SHARP));
  const candidates = analyze(events, { now: NOW });
  const allIds = new Set(candidates.map((c) => c.id));

  const { picks } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, count: 8, exclude: allIds });
  // Every candidate has been "seen", but the pool is thinner than 8 — recycle
  // rather than hand back an empty board.
  assert.ok(picks.length > 0);
});

/* ---------------------------------------------------------------- */
/* Kelly Criterion staking                                             */
/* ---------------------------------------------------------------- */

test('kellyFraction matches the textbook formula by hand', () => {
  // p=0.55, decimal 2.0 (b=1): f* = (1*0.55 - 0.45)/1 = 0.10
  assert.ok(Math.abs(kellyFraction(0.55, 2.0) - 0.10) < 1e-9);

  // p=0.7, decimal 3.0 (b=2): f* = (2*0.7 - 0.3)/2 = 0.55
  assert.ok(Math.abs(kellyFraction(0.7, 3.0) - 0.55) < 1e-9);
});

test('kellyFraction never suggests betting a negative edge', () => {
  // p=0.4, decimal 2.0 (b=1): raw formula gives -0.2 — must clamp to 0.
  assert.equal(kellyFraction(0.4, 2.0), 0);
});

test('kellyFraction handles degenerate inputs without throwing', () => {
  assert.equal(kellyFraction(0.6, 1), 0);    // decimal 1.0 => b=0, no payout at all
  assert.equal(kellyFraction(0.6, 0.5), 0);  // decimal below 1 is not a real price
  assert.equal(kellyFraction(0, 2.0), 0);    // certain loss
  assert.equal(kellyFraction(1, 2.0), 0);    // "certain win" — degenerate, not a real market
});

test('suggestedStake applies the quarter-Kelly fraction from RULES.KELLY', () => {
  const candidate = { consensusProb: 0.55, decimal: 2.0 };
  const full = kellyFraction(0.55, 2.0); // 0.10
  const stake = suggestedStake(candidate);
  assert.ok(Math.abs(stake - full * KELLY.FRACTION) < 1e-9);
  assert.ok(stake < full, 'the fractional stake must be smaller than full Kelly');
});

test('suggestedStake is capped even when full Kelly would suggest far more', () => {
  // p=0.7, decimal 3.0 => full Kelly 0.55, quarter-Kelly 0.1375 — well above
  // the 5% cap, which must win.
  const candidate = { consensusProb: 0.7, decimal: 3.0 };
  assert.equal(suggestedStake(candidate), KELLY.MAX_STAKE);
});

test('suggestedStake is zero for a candidate with no real edge', () => {
  const candidate = { consensusProb: 0.4, decimal: 2.0 };
  assert.equal(suggestedStake(candidate), 0);
});

test('suggestedParlayStake multiplies leg probabilities as independent events', () => {
  const legs = [{ consensusProb: 0.6 }, { consensusProb: 0.6 }];
  const combinedDecimal = 4.0; // e.g. two +100 legs parlayed
  const expectedProb = 0.6 * 0.6; // 0.36
  const expectedFull = kellyFraction(expectedProb, combinedDecimal);
  const stake = suggestedParlayStake(legs, combinedDecimal);
  assert.ok(Math.abs(stake - Math.min(expectedFull * KELLY.FRACTION, KELLY.MAX_STAKE)) < 1e-9);
});

/* ---------------------------------------------------------------- */
/* explain / explainExtensive — the price-case bullets                  */
/* ---------------------------------------------------------------- */

test('explain returns exactly one bullet mentioning the fair value and best price', () => {
  const [candidate] = analyze([makeEvent('a', -140, 120, SHARP)], { now: NOW });
  const bullets = explain(candidate);
  assert.equal(bullets.length, 1);
  assert.match(bullets[0], new RegExp(candidate.book));
});

test('explainExtensive covers the same ground as explain, in more than one bullet', () => {
  const [candidate] = analyze([makeEvent('a', -140, 120, SHARP)], { now: NOW });
  const bullets = explainExtensive(candidate, { now: NOW });
  assert.ok(bullets.length >= 3, `expected several bullets, got ${bullets.length}`);
  assert.ok(bullets.some((b) => b.includes(candidate.book)));
  assert.ok(bullets.some((b) => /books quote this/.test(b)), 'must cover book agreement');
  assert.ok(bullets.some((b) => /kickoff/.test(b)), 'must cover freshness relative to game time');
});

test('explainExtensive states the line-shopping gain when there is one, and omits it when there is none', () => {
  const withGap = { shopGain: 0.03, ev: 0.02, consensusProb: 0.55, fairAmerican: -110, american: 120, book: 'FanDuel', bookCount: 6, disagreement: 0.01, updatedMs: NOW - 600000, commenceMs: NOW + 6 * 3.6e6 };
  const withoutGap = { ...withGap, shopGain: 0 };
  assert.ok(explainExtensive(withGap, { now: NOW }).some((b) => /shopping alone/i.test(b)));
  assert.ok(!explainExtensive(withoutGap, { now: NOW }).some((b) => /shopping alone/i.test(b)));
});

test('explainExtensive distinguishes a fresh line from a stale one relative to kickoff', () => {
  const base = { ev: 0.02, consensusProb: 0.55, fairAmerican: -110, american: 120, book: 'FanDuel', bookCount: 6, disagreement: 0.01, shopGain: 0 };

  // Near kickoff (6h out): staleness still reads as trustworthy.
  const nearGame = explainExtensive({ ...base, updatedMs: NOW - 20 * 3.6e6, commenceMs: NOW + 6 * 3.6e6 }, { now: NOW });
  assert.ok(nearGame.some((b) => /20 hours ago/.test(b)));
  assert.ok(nearGame.some((b) => /Still close enough/.test(b)));

  // Same staleness, but kickoff is days away: worth a recheck before betting.
  const farGame = explainExtensive({ ...base, updatedMs: NOW - 20 * 3.6e6, commenceMs: NOW + 72 * 3.6e6 }, { now: NOW });
  assert.ok(farGame.some((b) => /Worth a recheck/.test(b)), 'a line stale relative to a far-off kickoff should suggest rechecking');

  const fresh = explainExtensive({ ...base, updatedMs: NOW - 30 * 60000, commenceMs: NOW + 6 * 3.6e6 }, { now: NOW });
  assert.ok(fresh.some((b) => /under an hour ago/.test(b)));
});

/* ---------------------------------------------------------------- */
/* Tennis alternate spread (alternate_spreads) — a wider game-margin      */
/* ladder than the featured 'spreads' market, NOT a sets-won market.     */
/* The Odds API's own docs describe it as "all available point spread    */
/* outcomes" for the same axis, and a live match's ladder ran to ±9.5 —  */
/* impossible as a sets margin in any tennis format. Confirmed the hard  */
/* way after first shipping this mislabeled as "Set Spread".             */
/* ---------------------------------------------------------------- */

/** A single-event alternate_spreads payload, shaped like the worker's
 * /tennis-alt-spread response — the same event shape buildCandidates already
 * reads, just with only one market present. */
function makeAltSpreadEvent(id, favPoint, dogPoint, { hoursOut = 6, books = DEEP_BOOKS } = {}) {
  return {
    id,
    sport_key: 'tennis_atp_test_open',
    sport_title: 'ATP Test Open',
    commence_time: new Date(NOW + hoursOut * HOUR).toISOString(),
    home_team: `${id} Favorite`,
    away_team: `${id} Underdog`,
    bookmakers: books.map((title, i) => ({
      key: BOOK_KEYS[title] ?? title.toLowerCase(),
      title,
      last_update: new Date(NOW - 10 * 60 * 1000).toISOString(),
      markets: [
        {
          key: 'alternate_spreads',
          last_update: new Date(NOW - 10 * 60 * 1000).toISOString(),
          outcomes: [
            { name: `${id} Favorite`, price: favPoint.price + (i === 0 ? 35 : 0), point: favPoint.point },
            { name: `${id} Underdog`, price: dogPoint.price, point: dogPoint.point },
          ],
        },
      ],
    })),
  };
}

test('an alternate-spread candidate is labelled distinctly from a game spread', () => {
  const [event] = buildCandidates(
    [makeAltSpreadEvent('m', { price: -900, point: -1.5 }, { price: 550, point: 1.5 })],
    { now: NOW },
  );
  assert.equal(event.marketKey, 'alternate_spreads');
  assert.equal(event.marketLabel, 'Alt Spread');
  assert.match(event.selection, /\(alt\)$/, 'an alternate-spread selection must read distinctly from a game spread');
});

test('a tennis event can carry both a featured and an alternate spread without colliding', () => {
  const gameSpread = makeEvent('m', -140, 120, { ...SHARP, sport: 'tennis_atp_test_open' });
  const altSpread = makeAltSpreadEvent('m', { price: -900, point: -1.5 }, { price: 550, point: 1.5 });
  const candidates = analyze([gameSpread, altSpread], { now: NOW });

  const marketKeys = new Set(candidates.map((c) => c.marketKey));
  assert.ok(marketKeys.has('h2h'));
  assert.ok(marketKeys.has('alternate_spreads'));

  // The two markets must never be treated as contradicting one another —
  // they're different bets on the same match, not opposite sides of one.
  const h2h = candidates.filter((c) => c.marketKey === 'h2h');
  const alt = candidates.filter((c) => c.marketKey === 'alternate_spreads');
  for (const a of h2h) for (const b of alt) assert.ok(!contradicts(a, b));
});

test('topPicks can surface an alternate-spread pick alongside picks from other markets', () => {
  const altSpread = makeAltSpreadEvent('m', { price: -900, point: -1.5 }, { price: 550, point: 1.5 });
  const other = makeEvent('n', -140, 120, SHARP);
  const candidates = analyze([altSpread, other], { now: NOW });

  // minScore: 0 — this checks that topPicks doesn't structurally exclude the
  // market, not that this particular fixture grades highly.
  const { picks } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0, count: 8 });
  assert.ok(picks.some((p) => p.legs[0].marketKey === 'alternate_spreads'));
});

/* ---------------------------------------------------------------- */
/* League filtering — the UI narrows the board client-side             */
/* ---------------------------------------------------------------- */

test('candidates carry the league identity the filter groups on', () => {
  const candidates = analyze(
    [
      makeEvent('m', -140, 120, { ...SHARP, sport: 'baseball_mlb', sportTitle: 'MLB' }),
      makeEvent('t', -140, 120, { ...SHARP, sport: 'tennis_wta', sportTitle: 'WTA' }),
    ],
    { now: NOW },
  );

  const leagues = new Set(candidates.map((c) => c.sportKey));
  assert.deepEqual([...leagues].sort(), ['baseball_mlb', 'tennis_wta']);

  // Filtering to one league is a plain predicate on the board we already hold.
  const mlbOnly = candidates.filter((c) => c.sportKey === 'baseball_mlb');
  assert.ok(mlbOnly.length > 0);
  assert.ok(mlbOnly.every((c) => c.sportTitle === 'MLB'));
});

/* ---------------------------------------------------------------- */
/* Long-shot probability penalty + board dog cap                      */
/* ---------------------------------------------------------------- */

test('scoreCandidate penalizes low-probability sides and leaves near-50/50 markets alone', () => {
  const base = {
    ev: 0.03, bookCount: 8, disagreement: 0.006, shopGain: 0.02,
    commenceMs: NOW + 6 * HOUR, updatedMs: NOW - 0.25 * HOUR,
  };
  const coinflip = scoreCandidate({ ...base, consensusProb: 0.5 }, { now: NOW }).score;
  const spreadish = scoreCandidate({ ...base, consensusProb: 0.48 }, { now: NOW }).score;
  const modestDog = scoreCandidate({ ...base, consensusProb: 0.44 }, { now: NOW }).score;
  const longShot = scoreCandidate({ ...base, consensusProb: 0.31 }, { now: NOW }).score;

  assert.equal(coinflip, spreadish, 'the ~0.47-0.53 zone spreads/totals live in must be untouched');
  assert.ok(coinflip - modestDog < 1.5, 'a +120-ish dog is grazed, not hammered');
  assert.ok(modestDog > longShot, 'the penalty must deepen as win probability falls');
  const expectedDrop =
    UNDERDOG_PROB_PENALTY.MAX_DROP *
    ((UNDERDOG_PROB_PENALTY.START - 0.31) / (UNDERDOG_PROB_PENALTY.START - UNDERDOG_PROB_PENALTY.FULL));
  assert.ok(
    Math.abs(coinflip - longShot - expectedDrop) < 1e-9,
    `a 31% shot should lose ~${expectedDrop.toFixed(1)} points, lost ${(coinflip - longShot).toFixed(1)}`,
  );
});

test('the penalty saturates at FULL, and a candidate with no consensusProb is untouched', () => {
  const base = {
    ev: 0.03, bookCount: 8, disagreement: 0.006, shopGain: 0.02,
    commenceMs: NOW + 6 * HOUR, updatedMs: NOW - 0.25 * HOUR,
  };
  const atFull = scoreCandidate({ ...base, consensusProb: UNDERDOG_PROB_PENALTY.FULL }, { now: NOW }).score;
  const beyond = scoreCandidate({ ...base, consensusProb: 0.2 }, { now: NOW }).score;
  assert.equal(atFull, beyond, 'penalty must cap at MAX_DROP, not keep growing');

  // No consensusProb (a synthetic/re-scored candidate) contributes exactly 0
  // penalty — same "no data is 0, never a phantom value" rule the
  // qualitative swing follows.
  const missing = scoreCandidate(base, { now: NOW }).score;
  const at50 = scoreCandidate({ ...base, consensusProb: 0.5 }, { now: NOW }).score;
  assert.equal(missing, at50);
});

test('topPicks caps +120-and-longer dogs at maxDogs, favorites fill the rest', () => {
  // Four games whose OUTLIER side is the home underdog (+150 base, book 0
  // hangs +185) and three whose outlier side is a favorite.
  const events = [
    ...Array.from({ length: 4 }, (_, i) => makeEvent(`dog${i}`, 150, -180, SHARP)),
    ...Array.from({ length: 3 }, (_, i) => makeEvent(`fav${i}`, -140, 120, SHARP)),
  ];
  const candidates = analyze(events, { now: NOW });

  const board = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0, count: 5 });
  const dogs = board.picks.filter((p) => p.american >= 120);
  assert.ok(dogs.length <= 2, `default cap is 2, board carried ${dogs.length} dogs`);
  assert.equal(board.picks.length, 5, 'the cap must not shorten the board while favorites remain');

  const none = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0, count: 5, maxDogs: 0 });
  assert.ok(none.picks.every((p) => p.american < 120), 'maxDogs: 0 must exclude every dog');

  const uncapped = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0, count: 7, maxDogs: Infinity });
  assert.ok(
    uncapped.picks.filter((p) => p.american >= 120).length >= 4,
    'maxDogs: Infinity must restore the uncapped behavior',
  );
});

/* ------------------------------------------------------------------ */
/* NFL preseason                                                       */
/* ------------------------------------------------------------------ */

test('isNflPreseasonKey matches the preseason key and not the regular season', () => {
  assert.equal(isNflPreseasonKey('americanfootball_nfl_preseason'), true);
  assert.equal(isNflPreseasonKey('americanfootball_nfl'), false);
  assert.equal(isNflPreseasonKey('americanfootball_ncaaf'), false);
  assert.equal(isNflPreseasonKey('baseball_mlb'), false);
  // Never throws on the shapes that legitimately reach it.
  assert.equal(isNflPreseasonKey(undefined), false);
  assert.equal(isNflPreseasonKey(null), false);
});

test('isNflPreseason reads both candidate (sportKey) and raw event (sport_key) shapes', () => {
  // The bug this replaces: the old helper read a `season_type` field that
  // analyze() never carries onto candidates, so it was always false.
  assert.equal(isNflPreseason({ sportKey: 'americanfootball_nfl_preseason' }), true);
  assert.equal(isNflPreseason({ sport_key: 'americanfootball_nfl_preseason' }), true);
  assert.equal(isNflPreseason({ sportKey: 'americanfootball_nfl' }), false);
  assert.equal(isNflPreseason({}), false);

  // The real integration point: a candidate straight out of analyze() must
  // be recognised, since that is the only shape topPicks ever sees.
  const [candidate] = analyze(
    [makeEvent('pre', -140, 120, { ...SHARP, sport: 'americanfootball_nfl_preseason', sportTitle: 'NFL Preseason' })],
    { now: NOW },
  );
  assert.equal(isNflPreseason(candidate), true, 'analyze() output must be recognised as preseason');
});

test('topPicks never returns an NFL preseason pick', () => {
  const candidates = analyze(
    [
      makeEvent('pre', -140, 120, { ...SHARP, sport: 'americanfootball_nfl_preseason', sportTitle: 'NFL Preseason' }),
      makeEvent('reg', -140, 120, { ...SHARP, sport: 'americanfootball_nfl', sportTitle: 'NFL' }),
    ],
    { now: NOW },
  );
  const { picks } = topPicks(candidates, { oddsMin: -1000, oddsMax: 500, minScore: 0, count: 8 });

  assert.ok(picks.length > 0, 'the regular-season game must still be pickable');
  assert.ok(
    picks.every((p) => !isNflPreseason(p.legs[0])),
    'no preseason game may appear on the board',
  );
});

test('the guaranteeCount fallback cannot pad a thin board with NFL preseason', () => {
  // Regression: the fallback builds from the RAW candidate list, so filtering
  // only the main pool left preseason reachable on exactly the quiet day the
  // padding exists for — Pixel's Picks runs with guaranteeCount: true.
  const candidates = analyze(
    [makeEvent('pre', -140, 120, { ...SHARP, sport: 'americanfootball_nfl_preseason', sportTitle: 'NFL Preseason' })],
    { now: NOW },
  );
  assert.ok(candidates.length > 0, 'fixture must produce candidates for the fallback to reach for');

  const { picks } = topPicks(candidates, {
    oddsMin: -1000, oddsMax: 500, minScore: 0, count: 5, guaranteeCount: true,
  });
  assert.equal(picks.length, 0, 'a board with only preseason available must come back empty, not padded');
});

test('analyze() still yields preseason candidates — Full Slate keeps them', () => {
  // Full Slate is built from analyze() directly (worker/src/full-slate-tracking.js),
  // never topPicks, and is the one surface preseason IS meant to appear on.
  const candidates = analyze(
    [makeEvent('pre', -140, 120, { ...SHARP, sport: 'americanfootball_nfl_preseason', sportTitle: 'NFL Preseason' })],
    { now: NOW },
  );
  assert.ok(candidates.length > 0, 'analyze() must not filter preseason out');
  assert.ok(candidates.every((c) => c.sportKey === 'americanfootball_nfl_preseason'));
});

/* ---------------------------------------------------------------- */
/* stakeUnitsForScore — the 2026-08-21 confidence-scaled unit bands   */
/* ---------------------------------------------------------------- */

test('stakeUnitsForScore spans each board band from its floor to its ceiling', async () => {
  const { stakeUnitsForScore, STAKE_BANDS, UNIT_DOLLARS } = await import('../docs/engine.js');
  // At or below the MIN_SCORE floor: the band minimum, never less.
  // Play of the Day's band was 3-to-5 units and is now 1-to-3 (2026-08-26),
  // so a POTD that only just clears the standard sizes like any other pick.
  assert.equal(stakeUnitsForScore(50, STAKE_BANDS.potd), 1);
  assert.equal(stakeUnitsForScore(12, STAKE_BANDS.potd), 1);
  assert.equal(stakeUnitsForScore(50, STAKE_BANDS.pixel), 1);
  // At the elite end: the band maximum, never more.
  assert.equal(stakeUnitsForScore(85, STAKE_BANDS.potd), 3);
  assert.equal(stakeUnitsForScore(99, STAKE_BANDS.potd), 3);
  assert.equal(stakeUnitsForScore(99, STAKE_BANDS.pixel), 2.5);
  // In between: inside the band, in half-unit steps.
  const mid = stakeUnitsForScore(68, STAKE_BANDS.pixel);
  assert.ok(mid > 1 && mid < 2.5, `mid-band units, got ${mid}`);
  assert.equal(mid * 2, Math.round(mid * 2), 'half-unit steps only');
  // The tracked record's dollar basis.
  assert.equal(UNIT_DOLLARS, 25);
});

test('no board can size a single play above 3 units / $75', async () => {
  const { stakeUnitsForScore, STAKE_BANDS, MAX_STAKE_UNITS, UNIT_DOLLARS } = await import('../docs/engine.js');
  assert.equal(MAX_STAKE_UNITS, 3);
  assert.equal(MAX_STAKE_UNITS * UNIT_DOLLARS, 75);

  // Every shipped band, across the whole score range, stays at or under it.
  for (const [board, band] of Object.entries(STAKE_BANDS)) {
    for (let score = 0; score <= 100; score += 1) {
      const units = stakeUnitsForScore(score, band);
      assert.ok(units <= MAX_STAKE_UNITS, `${board} sized ${units}u at score ${score}`);
      assert.ok(units >= 1, `${board} sized ${units}u at score ${score}`);
      assert.equal(units * 2, Math.round(units * 2), 'half-unit steps only');
    }
  }

  // The cap is enforced in the function, not just by the band table, so a
  // band edited later cannot quietly reintroduce an oversized stake.
  assert.equal(stakeUnitsForScore(100, { min: 4, max: 9 }), MAX_STAKE_UNITS);
});
