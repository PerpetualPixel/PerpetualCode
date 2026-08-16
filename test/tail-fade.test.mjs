import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditLegs,
  readLeg,
  matchStrength,
  normalizeSelection,
  findPostedMatch,
  TAIL,
  FADE,
  NO_READ,
  MATCH_MIN,
} from '../docs/tail-fade.js';
import { RULES } from '../docs/engine.js';

/** A posted pick, as docs/app.js's registerPostedPicks records one. */
function posted({
  surfaceLabel = 'Play of the Day',
  selection = 'Atlanta Dream to win',
  marketKey = 'h2h',
  american = -150,
  score = 72,
  home = 'Atlanta Dream',
  away = 'Indiana Fever',
  reasons = null,
  sections = null,
} = {}) {
  return { surfaceLabel, selection, marketKey, american, score, home, away, reasons, sections };
}

/** A live candidate, as docs/engine.js's analyze() emits one. */
function candidate({
  selection = 'Atlanta Dream to win',
  marketKey = 'h2h',
  score = 72,
  ev = 0.02,
  consensusProb = 0.6,
  american = -150,
  eventId = 'g1',
} = {}) {
  return {
    eventId,
    selection,
    marketKey,
    marketLabel: 'Moneyline',
    outcomeName: selection.split(' to win')[0],
    home: 'Atlanta Dream',
    away: 'Indiana Fever',
    sportKey: 'basketball_wnba',
    score,
    ev,
    consensusProb,
    american,
    fairAmerican: -140,
    book: 'DraftKings',
    bookCount: 8,
    disagreement: 0.01,
    commenceMs: Date.parse('2026-08-16T23:00:00Z'),
  };
}

const leg = (selection, american = null) => ({ selection, american, source: 'text' });

/* ---------------------------------------------------------------- */
/* The regression this module exists for                             */
/* ---------------------------------------------------------------- */

test('THE BUG: pasting our own Play of the Day returns TAIL, not FADE', () => {
  // The replaced mock computed `tail = avgAmerican > -125`. Play of the Day
  // is drawn from a -200..+150 band, so every POTD priced heavier than -125
  // came back FADE — deterministically, and with no reference to the pick.
  // -150 is squarely inside that broken range and is the exact case
  // reported.
  const audit = auditLegs([leg('Atlanta Dream to win', -150)], {
    postedPicks: [posted({ american: -150 })],
    candidates: [candidate({ american: -150 })],
  });
  assert.equal(audit.verdict, TAIL);
  assert.match(audit.summary, /already posted/i);
});

test('THE BUG: heavy juice alone never decides the verdict', () => {
  // -300 is heavier still. Under the old rule this was a guaranteed FADE.
  const audit = auditLegs([leg('Atlanta Dream to win', -300)], {
    postedPicks: [posted({ american: -300 })],
    candidates: [],
  });
  assert.equal(audit.verdict, TAIL, 'the price is not the verdict');
});

test('a posted pick is TAIL at every price in the Play of the Day band', () => {
  for (const american of [-200, -175, -150, -125, -110, 100, 150]) {
    const audit = auditLegs([leg('Atlanta Dream to win', american)], {
      postedPicks: [posted({ american })],
      candidates: [],
    });
    assert.equal(audit.verdict, TAIL, `expected TAIL at ${american}`);
  }
});

/* ---------------------------------------------------------------- */
/* Posted-pick matching                                              */
/* ---------------------------------------------------------------- */

test('a prop leg posted inside the Prop Play parlay is recognised as ours', () => {
  const audit = auditLegs([leg("A'ja Wilson 24+ points", -118)], {
    postedPicks: [posted({
      surfaceLabel: 'Prop Play of the Day',
      selection: "A'ja Wilson 24+ points",
      marketKey: 'prop',
      score: null,
    })],
    candidates: [],
  });
  assert.equal(audit.verdict, TAIL);
  assert.match(audit.summary, /Prop Play of the Day/);
});

test('the opposite side of a posted pick is FADE, and says which pick it contradicts', () => {
  const audit = auditLegs([leg('Indiana Fever to win', 130)], {
    postedPicks: [posted({ selection: 'Atlanta Dream to win' })],
    candidates: [],
  });
  assert.equal(audit.verdict, FADE);
  assert.match(audit.summary, /opposite side of our own Play of the Day/i);
  assert.match(audit.summary, /Atlanta Dream to win/);
});

test('a prop naming a team is NOT treated as the opposite of that team\'s moneyline', () => {
  const match = findPostedMatch(
    leg("Indiana Fever team total over 82.5"),
    [posted({ selection: "A'ja Wilson 24+ points", marketKey: 'prop' })],
  );
  assert.equal(match, null, 'only two-outcome team markets have an "other side"');
});

test('terse input still matches — "Aces ML" against "Las Vegas Aces to win"', () => {
  assert.ok(matchStrength('Aces ML', 'Las Vegas Aces to win') < MATCH_MIN,
    'one word of four is correctly too weak on its own');
  assert.ok(matchStrength('Las Vegas Aces ML', 'Las Vegas Aces to win') >= MATCH_MIN,
    'naming the team in full is enough, even with the shorthand "ML"');
});

test('matching ignores case, punctuation and accents', () => {
  assert.equal(normalizeSelection("A'ja Wilson — Over 24.5!"), 'a ja wilson over 24 5');
  assert.ok(matchStrength("a'ja wilson 24+ points", "A'ja Wilson 24+ Points") >= MATCH_MIN);
});

/* ---------------------------------------------------------------- */
/* Engine-grounded verdicts for bets we did not post                 */
/* ---------------------------------------------------------------- */

test('an unposted leg that clears the engine bar is TAIL', () => {
  const audit = auditLegs([leg('Atlanta Dream to win')], {
    postedPicks: [],
    candidates: [candidate({ score: RULES.MIN_SCORE + 10, ev: 0.03 })],
  });
  assert.equal(audit.verdict, TAIL);
  assert.match(audit.summary, new RegExp(String(RULES.MIN_SCORE)).source ? /clears the same bar/i : /./);
});

test('an unposted leg below the confidence bar is FADE, citing the real grade', () => {
  const audit = auditLegs([leg('Atlanta Dream to win')], {
    postedPicks: [],
    candidates: [candidate({ score: RULES.MIN_SCORE - 15, ev: 0.03 })],
  });
  assert.equal(audit.verdict, FADE);
  assert.match(audit.summary, /below the \d+ confidence bar/i);
});

test('an unposted leg with no positive expected value is FADE even when it grades well', () => {
  const audit = auditLegs([leg('Atlanta Dream to win')], {
    postedPicks: [],
    candidates: [candidate({ score: RULES.MIN_SCORE + 20, ev: -0.01 })],
  });
  assert.equal(audit.verdict, FADE);
  assert.match(audit.summary, /no positive expected value/i);
});

test('confidence tracks the real grade rather than the number of legs', () => {
  const strong = auditLegs([leg('Atlanta Dream to win')], {
    postedPicks: [], candidates: [candidate({ score: 90, ev: 0.05 })],
  });
  const weak = auditLegs([leg('Atlanta Dream to win')], {
    postedPicks: [], candidates: [candidate({ score: 55, ev: 0.01 })],
  });
  assert.equal(strong.confidence, 9);
  assert.ok(weak.confidence < strong.confidence);
});

/* ---------------------------------------------------------------- */
/* NO READ — the honest third answer                                 */
/* ---------------------------------------------------------------- */

test('a bet matching nothing on the board returns NO READ, not a guess', () => {
  const audit = auditLegs([leg('Some Team nobody has priced', -110)], {
    postedPicks: [],
    candidates: [candidate()],
  });
  assert.equal(audit.verdict, NO_READ);
  assert.equal(audit.confidence, 0, 'no confidence number at all, rather than a low one');
  assert.match(audit.summary, /nothing here to check them against/i);
});

test('NO READ is returned rather than TAIL when the board is simply empty', () => {
  const audit = auditLegs([leg('Atlanta Dream to win', -150)], { postedPicks: [], candidates: [] });
  assert.equal(audit.verdict, NO_READ);
});

test('a partly-matched slip is judged on the matched legs and says so', () => {
  const audit = auditLegs(
    [leg('Atlanta Dream to win'), leg('Something entirely unpriced')],
    { postedPicks: [], candidates: [candidate({ score: 80, ev: 0.03 })] },
  );
  assert.equal(audit.verdict, TAIL);
  assert.equal(audit.unmatchedCount, 1);
  assert.ok(audit.risk.some((r) => /could not be matched/i.test(r)));
});

/* ---------------------------------------------------------------- */
/* Multi-leg behaviour                                               */
/* ---------------------------------------------------------------- */

test('one bad leg fades the whole slip — a parlay is only as good as its worst leg', () => {
  const audit = auditLegs(
    [leg('Atlanta Dream to win'), leg('Indiana Fever +3.5')],
    {
      postedPicks: [],
      candidates: [
        candidate({ score: 85, ev: 0.04 }),
        candidate({ selection: 'Indiana Fever +3.5', marketKey: 'spreads', score: 40, ev: 0.001, eventId: 'g2' }),
      ],
    },
  );
  assert.equal(audit.verdict, FADE);
});

test('confidence on a multi-leg slip is the weakest leg, not the average', () => {
  const audit = auditLegs(
    [leg('Atlanta Dream to win'), leg('Indiana Fever +3.5')],
    {
      postedPicks: [],
      candidates: [
        candidate({ score: 90, ev: 0.04 }),
        candidate({ selection: 'Indiana Fever +3.5', marketKey: 'spreads', score: 60, ev: 0.02, eventId: 'g2' }),
      ],
    },
  );
  assert.equal(audit.confidence, 6);
});

test('a parlay reports the market\'s own joint probability as a real risk', () => {
  const audit = auditLegs(
    [leg('Atlanta Dream to win'), leg('Indiana Fever +3.5')],
    {
      postedPicks: [],
      candidates: [
        candidate({ score: 80, ev: 0.03, consensusProb: 0.6 }),
        candidate({ selection: 'Indiana Fever +3.5', marketKey: 'spreads', score: 80, ev: 0.03, consensusProb: 0.5, eventId: 'g2' }),
      ],
    },
  );
  // 0.6 * 0.5 = 30.0%
  assert.ok(audit.risk.some((r) => r.includes('30.0%')), audit.risk.join(' | '));
});

test('two legs on the same game are flagged as correlated', () => {
  const audit = auditLegs(
    [leg('Atlanta Dream to win'), leg('Atlanta Dream -3.5')],
    {
      postedPicks: [],
      candidates: [
        candidate({ score: 80, ev: 0.03, eventId: 'same' }),
        candidate({ selection: 'Atlanta Dream -3.5', marketKey: 'spreads', score: 80, ev: 0.03, eventId: 'same' }),
      ],
    },
  );
  assert.ok(audit.risk.some((r) => /correlated/i.test(r)));
});

/* ---------------------------------------------------------------- */
/* No invented numbers                                               */
/* ---------------------------------------------------------------- */

test('an unmatched leg gets a stated absence, never a fabricated statistic', () => {
  // The replaced mock emitted "hit in 7 of its last 10 (70%)" and
  // "usage up to 28.9%" as literal constants regardless of the input. The
  // bar now is that a leg with no market behind it produces no numbers.
  const audit = auditLegs([leg('Totally unpriced thing')], { postedPicks: [], candidates: [] });
  assert.deepEqual(audit.statistical, [
    'Totally unpriced thing: not on the current board, so no market read is available.',
  ]);
  assert.ok(!audit.statistical.some((s) => /\d/.test(s)), 'no digits at all where there is no data');
  assert.ok(!audit.contextual.some((s) => /\d+%/.test(s)));
});

test('the posted pick\'s own reasoning is reused rather than paraphrased', () => {
  const audit = auditLegs([leg('Atlanta Dream to win')], {
    postedPicks: [posted({ reasons: ['Dream are 8-2 at home since the break.'] })],
    candidates: [],
  });
  assert.ok(audit.contextual.some((c) => c.includes('8-2 at home since the break')));
});

test('a worse price than the board offers is reported as a real cost', () => {
  const audit = auditLegs([leg('Atlanta Dream to win', -200)], {
    postedPicks: [],
    candidates: [candidate({ american: -150, score: 80, ev: 0.03 })],
  });
  assert.ok(
    audit.statistical.some((s) => /worse than the board's best price/i.test(s)),
    audit.statistical.join(' | '),
  );
});

test('readLeg reports an unmatched leg as unknown, never as fade', () => {
  const r = readLeg(leg('nothing like any market'), { postedPicks: [], candidates: [candidate()] });
  assert.equal(r.stance, 'unknown');
  assert.equal(r.confidence, null);
});
