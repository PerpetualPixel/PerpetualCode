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
  analyze,
  generateSlate,
  contradicts,
  confidenceColor,
  bookOffers,
  bookIdFor,
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
