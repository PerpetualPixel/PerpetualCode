import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditLegs,
  matchStrength,
  normalizeSelection,
  findPostedMatch,
  isTakeSide,
  isFadeSide,
  MODE_SLATE,
  MODE_PARLAY,
  NO_READ,
  MATCH_MIN,
} from '../docs/tail-fade.js';
import { STRONG_FADE, LEAN_PASS } from '../docs/take-or-fade.js';
import { RULES } from '../docs/engine.js';

const NOW = Date.parse('2026-08-16T18:00:00Z');

/** A posted pick, as docs/app.js's registerPostedPicks records one. */
function posted({
  surfaceLabel = 'Play of the Day',
  selection = 'Atlanta Dream to win',
  marketKey = 'h2h',
  american = -150,
  score = 72,
  home = 'Atlanta Dream',
  away = 'Indiana Fever',
} = {}) {
  return { surfaceLabel, selection, marketKey, american, score, home, away };
}

/** A live candidate, as docs/engine.js's analyze() emits one. */
function candidate({
  selection = 'Atlanta Dream to win',
  marketKey = 'h2h',
  // `edge` is the fixture's real control: the engine computes EV itself as
  // consensusProb x decimal - 1, so a probability inconsistent with the
  // price would describe a bet that cannot exist. -150 implies 60%, so
  // consensusProb = 0.60 + edge/decimal gives the intended EV exactly.
  edge = 0,
  consensusProb = undefined,
  american = -150,
  eventId = 'g1',
  disagreement = 0.008,
  bookCount = 8,
  shopGain = 0.02,
  sportKey = 'basketball_wnba',
  formSignal = undefined,
  point = undefined,
  profile = undefined,
} = {}) {
  return {
    eventId,
    selection,
    marketKey,
    marketLabel: 'Moneyline',
    outcomeName: selection.replace(/ to win$/, ''),
    home: 'Atlanta Dream',
    away: 'Indiana Fever',
    sportKey,
    consensusProb: consensusProb ?? (1 / dec(american)) + edge / dec(american),
    american,
    decimal: dec(american),
    fairAmerican: -140,
    book: 'DraftKings',
    bookCount,
    disagreement,
    shopGain,
    commenceMs: NOW + 6 * 3.6e6,
    updatedMs: NOW - 6e5,
    formSignal,
    point,
    profile,
  };
}

const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

const leg = (selection, american = null, extra = {}) => ({ selection, american, source: 'text', ...extra });
const run = (legs, opts = {}) => auditLegs(legs, { now: NOW, ...opts });

/* ---------------------------------------------------------------- */
/* The regression this module exists for                             */
/* ---------------------------------------------------------------- */

test('THE BUG: pasting our own Play of the Day never grades below TAKE', () => {
  // The replaced version computed `tail = avgAmerican > -125`. Play of the
  // Day is drawn from a -200..+150 band, so every POTD priced heavier than
  // -125 came back FADE — deterministically, with no reference to the pick.
  // -150 is squarely inside that broken range and is the exact case
  // reported.
  const audit = run([leg('Atlanta Dream to win', -150)], {
    postedPicks: [posted({ american: -150 })],
    candidates: [candidate({ american: -150 })],
  });
  assert.ok(isTakeSide(audit.verdict), `expected a take, got ${audit.verdict}`);
  assert.match(audit.summary, /already on our own board/i);
});

test('THE BUG: heavy juice alone never decides the verdict', () => {
  // -300 is heavier still. Under the old rule this was a guaranteed FADE.
  const audit = run([leg('Atlanta Dream to win', -300)], {
    postedPicks: [posted({ american: -300 })],
    candidates: [],
  });
  assert.ok(isTakeSide(audit.verdict), 'the price is not the verdict');
});

test('a posted pick stays a take at every price in the Play of the Day band', () => {
  for (const american of [-200, -175, -150, -125, -110, 100, 150]) {
    const audit = run([leg('Atlanta Dream to win', american)], {
      postedPicks: [posted({ american })],
      candidates: [candidate({ american })],
    });
    assert.ok(isTakeSide(audit.verdict), `expected a take at ${american}, got ${audit.verdict}`);
  }
});

test('the posted-pick floor holds even when the raw pillars would fade it', () => {
  // A deliberately awful candidate: negative EV, wide disagreement, thin
  // book count. Left to itself the engine grades this STRONG FADE. Because
  // the selection pipeline already applied every one of those same gates
  // before publishing it, the two halves of the app disagreeing here would
  // be an arithmetic bug, not a second opinion.
  const audit = run([leg('Atlanta Dream to win', -150)], {
    postedPicks: [posted()],
    candidates: [candidate({ edge: -0.09, disagreement: 0.09, bookCount: 3, shopGain: 0, consensusProb: 0.28 })],
  });
  assert.ok(isTakeSide(audit.verdict), `floor did not hold: ${audit.verdict}`);
});

/* ---------------------------------------------------------------- */
/* Posted-pick matching                                              */
/* ---------------------------------------------------------------- */

test('a prop leg posted inside the Prop Play parlay is recognised as ours', () => {
  const audit = run([leg("A'ja Wilson 24+ points", -118)], {
    postedPicks: [posted({
      surfaceLabel: 'Prop Play of the Day',
      selection: "A'ja Wilson 24+ points",
      marketKey: 'prop',
      score: null,
    })],
    candidates: [],
  });
  assert.ok(isTakeSide(audit.verdict));
  assert.match(audit.summary, /Prop Play of the Day/);
});

test('the opposite side of a posted pick fades, and names the pick it contradicts', () => {
  const audit = run([leg('Indiana Fever to win', 130)], {
    postedPicks: [posted({ selection: 'Atlanta Dream to win' })],
    candidates: [],
  });
  assert.ok(isFadeSide(audit.verdict));
  assert.match(audit.summary, /opposite side of a bet this app has published/i);
});

test('the opposite-side ceiling holds even when the raw pillars would take it', () => {
  const audit = run([leg('Indiana Fever to win', 130)], {
    postedPicks: [posted({ selection: 'Atlanta Dream to win' })],
    candidates: [candidate({ selection: 'Indiana Fever to win', edge: 0.08, consensusProb: 0.55, formSignal: 0.6 })],
  });
  assert.ok(isFadeSide(audit.verdict), `ceiling did not hold: ${audit.verdict}`);
});

test('a prop naming a team is NOT treated as the opposite of that team\'s moneyline', () => {
  const match = findPostedMatch(
    leg('Indiana Fever team total over 82.5'),
    [posted({ selection: "A'ja Wilson 24+ points", marketKey: 'prop' })],
  );
  assert.equal(match, null, 'only two-outcome team markets have an "other side"');
});

test('terse input still matches — the asymmetric coverage rule', () => {
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
/* NO READ — the honest third answer                                 */
/* ---------------------------------------------------------------- */

test('a bet matching nothing on the board returns NO READ, not a guess', () => {
  const audit = run([leg('Some Team nobody has priced', -110)], {
    postedPicks: [],
    candidates: [candidate()],
  });
  assert.equal(audit.verdict, NO_READ);
  assert.match(audit.summary, /nothing here to check them against/i);
});

test('NO READ is returned rather than a take when the board is simply empty', () => {
  const audit = run([leg('Atlanta Dream to win', -150)], { postedPicks: [], candidates: [] });
  assert.equal(audit.verdict, NO_READ);
});

test('an unmatched leg carries no confidence number and no invented statistics', () => {
  // The replaced version emitted "hit in 7 of its last 10 (70%)" and
  // "usage up to 28.9%" as literal constants regardless of input.
  const audit = run([leg('Totally unpriced thing')], { postedPicks: [], candidates: [] });
  const [read] = audit.reads;
  assert.equal(read.verdict, NO_READ);
  assert.equal(read.confidence, null);
  assert.equal(read.tps, null);
  assert.deepEqual(read.signals, [], 'no signals at all where there is no data');
});

test('a partly-matched slip is judged on the matched legs and says so', () => {
  const audit = run(
    [leg('Atlanta Dream to win'), leg('Something entirely unpriced')],
    { postedPicks: [], candidates: [candidate({ edge: 0.05, shopGain: 0.03 })] },
  );
  assert.equal(audit.unmatchedCount, 1);
  assert.match(audit.summary, /could not be matched/i);
});

/* ---------------------------------------------------------------- */
/* Per-leg grading, in both modes                                    */
/* ---------------------------------------------------------------- */

test('every leg is graded individually, in slate mode AND in parlay mode', () => {
  // The user's ask: paste ten legs, grade each one. Both modes must return
  // a per-leg read; the mode changes only what the headline verdict means.
  const legs = Array.from({ length: 10 }, (_, i) => leg(`Team ${i} to win`));
  const candidates = legs.map((l, i) => candidate({
    selection: l.selection, eventId: `g${i}`, ev: i < 5 ? 0.04 : -0.02,
  }));
  for (const mode of [MODE_SLATE, MODE_PARLAY]) {
    const audit = run(legs, { postedPicks: [], candidates, mode });
    assert.equal(audit.reads.length, 10, `${mode}: every leg gets its own read`);
    assert.ok(audit.reads.every((r) => r.verdict !== NO_READ), `${mode}: all ten matched`);
    assert.ok(audit.reads.every((r) => Number.isFinite(r.tps)), `${mode}: all ten scored`);
  }
});

test('a leg with no positive expected value fades regardless of how well it scores', () => {
  const audit = run([leg('Atlanta Dream to win')], {
    postedPicks: [],
    candidates: [candidate({ edge: -0.01, disagreement: 0.005, bookCount: 10, shopGain: 0.04 })],
  });
  assert.ok(isFadeSide(audit.reads[0].verdict), audit.reads[0].verdict);
});

test('a strongly negative expectation is STRONG FADE, not merely FADE', () => {
  const audit = run([leg('Atlanta Dream to win')], {
    postedPicks: [], candidates: [candidate({ edge: -0.12 })],
  });
  assert.equal(audit.reads[0].verdict, STRONG_FADE);
});

test('the price the USER holds is graded, not the best price on the board', () => {
  // Found in browser verification: four favourites entered at -150 all
  // graded as no-edge, because the value in that slate lived at a -105
  // outlier one book was hanging. That is correct and is the whole point —
  // a bet is only as good as the number you actually got.
  const c = candidate({ american: -105, edge: 0.17 });
  const atTheirPrice = run([leg('Atlanta Dream to win', -150)], { postedPicks: [], candidates: [c] });
  const atTheBoardPrice = run([leg('Atlanta Dream to win', -105)], { postedPicks: [], candidates: [c] });
  assert.ok(atTheirPrice.reads[0].ev < atTheBoardPrice.reads[0].ev,
    'a worse price must grade worse, however good the market is');
  assert.ok(isFadeSide(atTheirPrice.reads[0].verdict));
  assert.ok(isTakeSide(atTheBoardPrice.reads[0].verdict));
  assert.ok(
    atTheirPrice.reads[0].signals.some((sg) => /worse than the board's best price/i.test(sg.text)),
    'and the gap is named rather than silently absorbed',
  );
});

test('a leg entered with no price is graded at the board\'s best, which is what enrichment fills', () => {
  const c = candidate({ american: -105, edge: 0.17 });
  const audit = run([leg('Atlanta Dream to win', null)], { postedPicks: [], candidates: [c] });
  assert.ok(isTakeSide(audit.reads[0].verdict));
});

/* ---------------------------------------------------------------- */
/* Parlay mode                                                       */
/* ---------------------------------------------------------------- */

test('parlay: one bad leg fades the ticket but the good legs are still surfaced', () => {
  // The explicit ask: "if any legs are bad, it's a fade but still provides
  // feedback and guidance on good legs".
  const audit = run(
    [leg('Atlanta Dream to win'), leg('Chicago Sky to win')],
    {
      postedPicks: [],
      candidates: [
        candidate({ edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 }),
        candidate({ selection: 'Chicago Sky to win', eventId: 'g2', edge: -0.05 }),
      ],
      mode: MODE_PARLAY,
    },
  );
  assert.ok(isFadeSide(audit.verdict));
  assert.equal(audit.badLegs.length, 1);
  assert.equal(audit.solidLegs.length, 1);
  assert.equal(audit.solidLegs[0].leg.selection, 'Atlanta Dream to win');
  assert.match(audit.summary, /worth taking straight instead/i);
});

test('parlay: opposite sides of the same game is a STRONG FADE that says why', () => {
  const audit = run(
    [leg('Atlanta Dream to win'), leg('Indiana Fever to win')],
    {
      postedPicks: [],
      candidates: [
        candidate({ edge: 0.04 }),
        candidate({ selection: 'Indiana Fever to win', eventId: 'g1', edge: 0.04, consensusProb: 0.4 }),
      ],
      mode: MODE_PARLAY,
    },
  );
  assert.equal(audit.verdict, STRONG_FADE);
  assert.ok(audit.findings.some((f) => f.kind === 'conflict'));
  assert.match(audit.summary, /cannot win as constructed/i);
});

test('parlay: same-side legs on one game are flagged as synergy, not punished', () => {
  const audit = run(
    [leg('Atlanta Dream to win'), leg('Atlanta Dream -3.5')],
    {
      postedPicks: [],
      candidates: [
        candidate({ edge: 0.04 }),
        candidate({ selection: 'Atlanta Dream -3.5', marketKey: 'spreads', eventId: 'g1', edge: 0.04 }),
      ],
      mode: MODE_PARLAY,
    },
  );
  const synergy = audit.findings.find((f) => f.kind === 'synergy');
  assert.ok(synergy, 'one game script carries both');
  assert.match(synergy.text, /higher than multiplying/i);
});

test('parlay: two props on the same game are flagged as cannibalization', () => {
  const audit = run(
    [leg("A'ja Wilson 24+ points", -118, { profile: { season: 0.8, l10: 0.8, l5: 0.8 } }),
      leg('Chelsea Gray 6+ assists', -120, { profile: { season: 0.8, l10: 0.8, l5: 0.8 } })],
    {
      postedPicks: [],
      candidates: [
        candidate({ selection: "A'ja Wilson 24+ points", marketKey: 'prop', edge: 0.03 }),
        candidate({ selection: 'Chelsea Gray 6+ assists', marketKey: 'prop', eventId: 'g1', edge: 0.03 }),
      ],
      mode: MODE_PARLAY,
    },
  );
  assert.ok(audit.findings.some((f) => f.kind === 'cannibalization'));
});

test('parlay: the ticket reports the independent joint probability and combined price', () => {
  const audit = run(
    [leg('Atlanta Dream to win'), leg('Chicago Sky to win')],
    {
      postedPicks: [],
      candidates: [
        candidate({ consensusProb: 0.6, american: -150, edge: 0.04 }),
        candidate({ selection: 'Chicago Sky to win', eventId: 'g2', consensusProb: 0.5, american: 100, edge: 0.04 }),
      ],
      mode: MODE_PARLAY,
    },
  );
  assert.ok(Math.abs(audit.jointProb - 0.30) < 1e-9, `expected 0.30, got ${audit.jointProb}`);
  // 1.6667 x 2.0 = 3.333 decimal = +233
  assert.ok(Math.abs(audit.combinedDecimal - 3.3333) < 0.001);
  assert.equal(audit.combinedAmerican, 233);
});

/* ---------------------------------------------------------------- */
/* Slate mode                                                        */
/* ---------------------------------------------------------------- */

test('slate: legs are sorted into bet-straight, marginal and avoid', () => {
  const audit = run(
    [leg('Good Team to win'), leg('Bad Team to win')],
    {
      postedPicks: [],
      candidates: [
        candidate({ selection: 'Good Team to win', eventId: 'g1', edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 }),
        candidate({ selection: 'Bad Team to win', eventId: 'g2', edge: -0.05 }),
      ],
      mode: MODE_SLATE,
    },
  );
  assert.equal(audit.straights.length, 1);
  assert.equal(audit.straights[0].leg.selection, 'Good Team to win');
  assert.equal(audit.avoid.length, 1);
  assert.equal(audit.avoid[0].leg.selection, 'Bad Team to win');
});

test('slate: a suggested parlay takes one leg per game, so the product stays honest', () => {
  // Two of these are the same game. Every correlation effect lives inside a
  // single game, so one-per-game is what makes the independent product a
  // fair statement rather than a wrong one.
  const audit = run(
    [leg('A to win'), leg('A -3.5'), leg('B to win')],
    {
      postedPicks: [],
      candidates: [
        candidate({ selection: 'A to win', eventId: 'g1', edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 }),
        candidate({ selection: 'A -3.5', marketKey: 'spreads', eventId: 'g1', edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 }),
        candidate({ selection: 'B to win', eventId: 'g2', edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 }),
      ],
      mode: MODE_SLATE,
    },
  );
  assert.equal(audit.parlayable.length, 2, 'the two legs on game 1 collapse to one');
  const events = new Set(audit.parlayable.map((r) => r.candidate.eventId));
  assert.equal(events.size, audit.parlayable.length);
});

test('slate: a single clearing leg is told to bet straight rather than parlayed', () => {
  const audit = run([leg('Only Good Leg to win')], {
    postedPicks: [],
    candidates: [candidate({ selection: 'Only Good Leg to win', edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 })],
    mode: MODE_SLATE,
  });
  assert.equal(audit.suggestedTicket, null);
  assert.match(audit.summary, /bet it straight/i);
});

test('the same legs give different answers under the two modes', () => {
  // The point of the toggle. One weak leg among strong ones is survivable
  // on a slate (bet the others) and fatal to a parlay (it needs them all).
  const legs = [leg('Strong to win'), leg('Weak to win')];
  const candidates = [
    candidate({ selection: 'Strong to win', eventId: 'g1', edge: 0.05, shopGain: 0.035, disagreement: 0.005, bookCount: 10 }),
    candidate({ selection: 'Weak to win', eventId: 'g2', edge: -0.04 }),
  ];
  const slate = run(legs, { postedPicks: [], candidates, mode: MODE_SLATE });
  const parlay = run(legs, { postedPicks: [], candidates, mode: MODE_PARLAY });
  assert.ok(isTakeSide(slate.verdict), 'a slate still has one bet worth making');
  assert.ok(isFadeSide(parlay.verdict), 'the ticket needs the weak leg, so it dies');
  assert.notEqual(slate.verdict, parlay.verdict);
});
