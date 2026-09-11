/**
 * The Gridiron Engine feed as this app consumes it: which board candidate a
 * feed game attaches to, how much it is allowed to move a grade, and where it
 * deliberately says nothing.
 *
 * The load-bearing assertions here are the restraints, not the enrichment.
 * The engine publishes that it does not beat the closing line and that its
 * biggest disagreements with the market were its worst bets, so a test suite
 * that only proved "agreement raises the score" would be happy with a version
 * of this feature that loses money.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTeam,
  teamsMatch,
  gameMatches,
  findGridironGame,
  gridironSignal,
  agreementFactor,
  blendGridironSignal,
  gridironRecord,
  gameGridironRecord,
  applyGridironFeed,
  fetchGridironFeed,
  isFootball,
  TIER_MAGNITUDE,
  SPREAD_MAX_MAGNITUDE,
  DISAGREEMENT,
  KICKOFF_TOLERANCE_MS,
  FEED_TTL_MS,
} from '../docs/gridiron.js';
import { scoreCandidate, QUALITATIVE } from '../docs/engine.js';
import { buildInsights, insightTexts, gridironInsights } from '../docs/insights.js';

const KICKOFF = '2026-09-13T17:00:00Z';
const NOW = Date.parse('2026-09-11T12:00:00Z');

function game(over = {}) {
  return {
    league: 'nfl',
    sport_key: 'americanfootball_nfl',
    game_id: '2026_02_NE_SEA',
    season: 2026, week: 2, week_label: 'Week 2',
    home: 'Seattle Seahawks', away: 'New England Patriots',
    home_key: 'SEA', away_key: 'NE',
    neutral: false,
    kickoff: KICKOFF,
    stage: 'lean', locked: false, lock_reason: null,
    waiting_on: 'final injury report',
    url: 'https://perpetualpixel.github.io/NFL-NCAA-Football-Prediction-Engine/nfl-w02.html#g-2026_02_NE_SEA',
    model: {
      margin: 4.4, line: 'Seattle Seahawks -4.5', home_win_prob: 0.63,
      projected_score: { home: 24.4, away: 20.1, total: 44.5 },
    },
    market: {
      spread_line: 3.5, total_line: 44.5,
      home_moneyline: -185, away_moneyline: 154, source: 'ESPN',
    },
    moneyline: {
      selection: 'Seattle Seahawks', tier: 'pick', tier_label: 'Pick',
      prob: 0.72, model_prob: 0.63, price: -185, ev: 0.02,
      agreement: { model_prob: 0.72, implied_prob: 0.649, gap: 0.071 },
    },
    spread: {
      selection: 'Seattle Seahawks', point: -3.5, tier: 'lean',
      prob: 0.53, model_prob: 0.527, price: -105, price_assumed: false,
      ev: -0.02, edge: 0.9,
    },
    analysis: {
      confidence: ['Seattle Seahawks is a Pick: the calibrated chance of winning is 72%.'],
      script: ['The power ratings see a meaningful but not overwhelming edge for Seattle.'],
      injuries: [
        { team: 'Seattle Seahawks', text: 'Out: Devon Witherspoon (CB, hamstring).' },
        { team: 'New England Patriots', text: 'no availability data published for this team.' },
      ],
      form: [{ team: 'Seattle Seahawks', text: 'Won 3 of their last 5.' }],
      players: [],
      conditions: 'Played indoors, so weather is not a factor.',
      availability: null,
      movement: null,
      factors: [{
        title: 'Seattle passing vs New England pass defense',
        verdict: 'a clear edge', tone: 'good', winner: 'Seattle Seahawks',
        text: "Seattle's passing attack grades A- (5th of 32). That is a clear edge for Seattle.",
      }],
    },
    ...over,
  };
}

const feed = (games = [game()]) => ({
  feed_version: 1,
  generated_at: '2026-09-11T11:47:00Z',
  disclosure: 'Tiers report how often plays like this have won, not that the price is good.',
  leagues: {},
  games,
});

function candidate(over = {}) {
  return {
    id: 'evt:h2h:SEA',
    eventId: 'evt',
    sportKey: 'americanfootball_nfl',
    commenceMs: Date.parse(KICKOFF),
    home: 'Seattle Seahawks',
    away: 'New England Patriots',
    marketKey: 'h2h',
    marketLabel: 'Moneyline',
    outcomeName: 'Seattle Seahawks',
    point: null,
    selection: 'Seattle Seahawks to win',
    american: -180,
    decimal: 1.5556,
    consensusProb: 0.64,
    ev: 0.004,
    disagreement: 0.02,
    shopGain: 0.01,
    updatedMs: NOW,
    bookCount: 8,
    quotes: [],
    ...over,
  };
}

/* ── Matching ────────────────────────────────────────────────────────── */

test('team names compare on their words, not their punctuation', () => {
  assert.equal(normalizeTeam('Texas A&M Aggies'), 'texas a m aggies');
  assert.ok(teamsMatch('Texas A&M Aggies', 'Texas A&M Aggies'));
  // one source carries a qualifier the other does not
  assert.ok(teamsMatch('Miami Hurricanes', 'Miami FL Hurricanes'));
});

test('teams that merely share a word are not the same team', () => {
  assert.equal(teamsMatch('Michigan Wolverines', 'Michigan State Spartans'), false);
  assert.equal(teamsMatch('New York Giants', 'New York Jets'), false);
  // a bare school name must not swallow a programme with a mascot: college
  // boards carry both "Miami" spellings for two different schools
  assert.equal(teamsMatch('Miami', 'Miami Hurricanes'), false);
  assert.equal(teamsMatch('', 'Seattle Seahawks'), false);
});

test('a feed game matches only the same fixture', () => {
  assert.ok(gameMatches(game(), candidate()));
  // right teams, wrong league key
  assert.equal(gameMatches(game(), candidate({ sportKey: 'americanfootball_ncaaf' })), false);
  // a neutral-site listing can invert home and away; both names still match
  assert.ok(gameMatches(game(), candidate({
    home: 'New England Patriots', away: 'Seattle Seahawks',
  })));
  // the same two teams meeting again months later is a different game
  assert.equal(gameMatches(game(), candidate({
    commenceMs: Date.parse(KICKOFF) + KICKOFF_TOLERANCE_MS + 1,
  })), false);
  // a kickoff time that merely moved is still the same game
  assert.ok(gameMatches(game(), candidate({ commenceMs: Date.parse(KICKOFF) + 36e5 })));
});

test('findGridironGame ignores every sport the feed does not cover', () => {
  assert.equal(isFootball('mma_mixed_martial_arts'), false);
  assert.equal(findGridironGame(feed(), candidate({ sportKey: 'baseball_mlb' })), null);
  assert.equal(findGridironGame(null, candidate()), null);
  assert.equal(findGridironGame(feed(), candidate()).game_id, '2026_02_NE_SEA');
});

/* ── Signal ──────────────────────────────────────────────────────────── */

test("a moneyline on the engine's own side carries its tier, damped by how far it strays above the price", () => {
  const match = gridironSignal(feed(), candidate());
  assert.equal(match.aligned, true);
  // gap 0.071 sits between START and FULL, so the Pick's 0.7 is partly damped
  const expected = TIER_MAGNITUDE.pick * agreementFactor(0.071);
  assert.ok(Math.abs(match.signal - expected) < 1e-9);
  assert.ok(match.signal < TIER_MAGNITUDE.pick);
});

test('the model agreeing with the price keeps its full say', () => {
  assert.equal(agreementFactor(0), 1);
  assert.equal(agreementFactor(DISAGREEMENT.START), 1);
  // a price MORE confident than the model is not a disagreement to damp
  assert.equal(agreementFactor(-0.2), 1);
  assert.equal(agreementFactor(DISAGREEMENT.FULL), 0);
  assert.ok(agreementFactor(0.1) > 0 && agreementFactor(0.1) < 1);
});

test('a pick the model only likes because it disagrees with the market says nothing', () => {
  // the engine's own tracking: its widest disagreements were its worst bets
  const wild = game({
    moneyline: {
      ...game().moneyline,
      prob: 0.9, tier: 'lock', tier_label: 'Lock',
      agreement: { model_prob: 0.9, implied_prob: 0.649, gap: 0.251 },
    },
  });
  const match = gridironSignal(feed([wild]), candidate());
  assert.equal(match.signal, 0);
  assert.equal(match.aligned, true);
});

test('the other side of the engine’s pick is marked down, at the tier’s full weight', () => {
  const match = gridironSignal(feed(), candidate({
    outcomeName: 'New England Patriots',
    selection: 'New England Patriots to win',
  }));
  assert.equal(match.aligned, false);
  // no damping on opposition: there is no disagreement bonus to take away
  assert.equal(match.signal, -TIER_MAGNITUDE.pick);
});

test('a Pass is the model declining to bet, and moves nothing', () => {
  const passing = game({ moneyline: { ...game().moneyline, tier: 'pass', prob: 0.51 } });
  assert.equal(gridironSignal(feed([passing]), candidate()), null);
});

test('a total gets no signal at all, however well the engine covers the game', () => {
  const total = candidate({
    marketKey: 'totals', outcomeName: 'Over', point: 44.5, selection: 'Over 44.5',
  });
  assert.equal(gridironSignal(feed(), total), null);
  // but the game's read is still attached, flagged as not having graded it
  const [enriched] = applyGridironFeed([total], feed(), () => ({}));
  assert.equal(enriched.gridiron.scored, false);
  assert.equal(enriched.gridiron.projectedScore.total, 44.5);
});

test('a spread only counts when the board is on the number the model priced', () => {
  const spread = candidate({
    marketKey: 'spreads', outcomeName: 'Seattle Seahawks', point: -3.5,
    selection: 'Seattle Seahawks -3.5',
  });
  const match = gridironSignal(feed(), spread);
  assert.equal(match.market, 'spreads');
  // the engine's own finding: its spread sides cover about half the time, so
  // an ATS agreement is capped well under its moneyline equivalent
  assert.equal(match.signal, Math.min(TIER_MAGNITUDE.lean, SPREAD_MAX_MAGNITUDE));

  // two points off the number the model graded is a different bet
  assert.equal(gridironSignal(feed(), { ...spread, point: -5.5 }), null);
  // the other side at the mirrored number is a real opposition
  const other = gridironSignal(feed(), {
    ...spread, outcomeName: 'New England Patriots', point: 3.5,
  });
  assert.ok(other.signal < 0);
});

test('an unmatched selection is passed over rather than guessed at', () => {
  const strange = game({ moneyline: { ...game().moneyline, selection: 'Denver Broncos' } });
  assert.equal(gridironSignal(feed([strange]), candidate()), null);
});

/* ── Blending and scoring ────────────────────────────────────────────── */

test('the engine and the app’s own form signal are blended, never replaced', () => {
  assert.equal(blendGridironSignal(null, null), null);
  assert.equal(blendGridironSignal(0.4, null), 0.4);
  assert.equal(blendGridironSignal(null, -0.5), -0.5);
  const blended = blendGridironSignal(-0.5, 0.5);
  // both were heard: the result sits between them, not at either
  assert.ok(blended > -0.5 && blended < 0.5);
});

test('the swing stays inside the generic qualitative clamp', () => {
  const c = candidate();
  const base = scoreCandidate(c, { now: NOW, qualitative: 0 });
  const [enriched] = applyGridironFeed([c], feed(), (cand, signal) =>
    scoreCandidate(cand, { now: NOW, qualitative: signal }));
  assert.ok(enriched.score > base.score);
  // MMA's consensus gets its own ±25 because the cappers ARE that sport's
  // model here; a model that does not beat the market does not get that.
  assert.ok(enriched.score - base.score <= QUALITATIVE.MAX_SWING + 1e-9);
  assert.equal(enriched.gridiron.scored, true);
  assert.equal(enriched.gridiron.aligned, true);
  assert.equal(enriched.gridiron.disclosure, feed().disclosure);
});

test('candidates the feed says nothing about are returned untouched', () => {
  const mma = candidate({ sportKey: 'mma_mixed_martial_arts', home: 'A B', away: 'C D' });
  const uncovered = candidate({
    home: 'Chicago Bears', away: 'Green Bay Packers', outcomeName: 'Chicago Bears',
  });
  const out = applyGridironFeed([mma, uncovered], feed(), () => {
    throw new Error('must not re-score a candidate the feed does not cover');
  });
  assert.equal(out[0], mma);
  assert.equal(out[1], uncovered);
});

test('the drawer can read a game’s record whatever market it opened on', () => {
  const record = gameGridironRecord(feed(), candidate({ marketKey: 'totals', outcomeName: 'Over' }));
  assert.equal(record.selection, 'Seattle Seahawks');
  assert.equal(record.scored, false);
  assert.equal(record.stage, 'lean');
  assert.equal(record.waitingOn, 'final injury report');
  assert.equal(gridironRecord(null, feed()), null);
});

/* ── Bullets ─────────────────────────────────────────────────────────── */

test('the card quotes the engine rather than paraphrasing it', () => {
  const texts = insightTexts(gridironInsights(game(), 'Seattle Seahawks'));
  assert.ok(texts.some((t) => t.includes('72% to win outright')));
  assert.ok(texts.some((t) => t.includes('The price implies 65%')));
  assert.ok(texts.some((t) => t.includes('Projected score: Seattle Seahawks 24.4')));
  // the engine's own matchup sentence, verbatim
  assert.ok(texts.some((t) => t === game().analysis.factors[0].text));
  // a lean is labelled a lean
  assert.ok(texts.some((t) => t.includes('not its final pick')));
});

test('a card whose bet the engine contradicts says so', () => {
  const texts = insightTexts(gridironInsights(game(), 'New England Patriots'));
  assert.ok(texts.some((t) => t.includes('the other side of this game')));
});

test('only the side the bet names has its injury report shown, and "nothing published" is not a bullet', () => {
  const texts = insightTexts(gridironInsights(game(), 'Seattle Seahawks'));
  assert.ok(texts.some((t) => t.includes('Devon Witherspoon')));
  assert.equal(texts.some((t) => t.includes('no availability data')), false);
});

test('a locked pick is reported as final', () => {
  const locked = game({ stage: 'locked', locked: true, lock_reason: 'final injury report in' });
  const texts = insightTexts(gridironInsights(locked, 'Seattle Seahawks'));
  assert.ok(texts.some((t) => t.includes('locked (final injury report in)')));
  assert.equal(texts.some((t) => t.includes('not its final pick')), false);
});

test('buildInsights carries the engine bullets after the ESPN ones, and none without a feed', () => {
  const leg = { ...candidate(), selection: 'Seattle Seahawks to win' };
  const without = insightTexts(buildInsights(leg, { context: null }));
  const withFeed = insightTexts(buildInsights(leg, { context: null, gridiron: game() }));
  assert.deepEqual(without, []);
  assert.ok(withFeed.length > 0);
  assert.ok(withFeed[0].startsWith('Gridiron Engine projects'));
});

test('no engine bullets are invented for a game it has not published', () => {
  assert.deepEqual(gridironInsights(null, 'Seattle Seahawks'), []);
  const bare = game({ model: {}, moneyline: null, spread: null, analysis: {} });
  assert.deepEqual(gridironInsights(bare, 'Seattle Seahawks').filter((b) => b.tier === 'personnel'), []);
});

/* ── Fetching ────────────────────────────────────────────────────────── */

let clock = NOW;
const nextWindow = () => (clock += FEED_TTL_MS * 2);

function stubFetch(bodies) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, json: async () => bodies[Math.min(calls.length - 1, bodies.length - 1)] };
  };
  return calls;
}

test('every request is cache-busted and bypasses the HTTP cache', async () => {
  const calls = stubFetch([feed()]);
  const now = nextWindow();
  await fetchGridironFeed('https://example.test/picks.json', { now });
  assert.equal(calls[0].url, `https://example.test/picks.json?t=${now}`);
  assert.equal(calls[0].opts.cache, 'no-store');
});

test('a second call inside the TTL is served from memory', async () => {
  const calls = stubFetch([feed()]);
  const now = nextWindow();
  await fetchGridironFeed('https://example.test/a.json', { now });
  await fetchGridironFeed('https://example.test/a.json', { now: now + FEED_TTL_MS - 1 });
  assert.equal(calls.length, 1);
});

test('a failed fetch keeps the last good feed rather than blanking the board', async () => {
  stubFetch([feed()]);
  const now = nextWindow();
  const good = await fetchGridironFeed('https://example.test/b.json', { now });
  globalThis.fetch = async () => { throw new Error('offline'); };
  const after = await fetchGridironFeed('https://example.test/b.json', { now: now + 500, force: true });
  assert.equal(after, good);
});

test('a body that is not this feed is refused', async () => {
  stubFetch([{ picks: [] }]);   // the MMA feed's shape, not this one
  const now = nextWindow();
  const before = await fetchGridironFeed('https://example.test/c.json', { now, force: true });
  assert.equal(before?.games?.length, 1); // still the last good feed, not the wrong one
});

test('simultaneous callers share one request rather than one each', async () => {
  const calls = stubFetch([feed()]);
  const now = nextWindow();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => fetchGridironFeed('https://example.test/d.json', { now })),
  );
  assert.equal(calls.length, 1);
  assert.ok(results.every((r) => r === results[0]));
});

test('an early lean with no injury report behind it is context, never a grade', () => {
  // feed v2 publishes `stage: "pending"` reads made more than a week out
  const early = game({ stage: 'pending', locked: false, waiting_on: null });
  assert.equal(gridironSignal(feed([early]), candidate()), null);
  const [enriched] = applyGridironFeed([candidate()], feed([early]), () => {
    throw new Error('a pending read must not re-score the candidate');
  });
  assert.equal(enriched.gridiron.scored, false);
  assert.equal(enriched.gridiron.stage, 'pending');
});
