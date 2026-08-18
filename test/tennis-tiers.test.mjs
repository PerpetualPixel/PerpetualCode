import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER_1, TIER_2, TIER_CHALLENGER,
  tennisTier, canonicalSlug, matchIdentity, dedupeTennisEvents,
  isMarketAllowedForTier, tierLiquidityBlock, capStakeForTier,
  TIER_2_MIN_BOOKS, surfaceOfEvent,
} from '../docs/tennis-tiers.js';
import { gradePick, summarizePicks } from '../docs/learning.js';

/* ---------------------------------------------------------------- */
/* Tier classification                                               */
/* ---------------------------------------------------------------- */

test('Grand Slams and Masters 1000 classify as TIER_1 on both tours', () => {
  assert.equal(tennisTier('tennis_atp_wimbledon'), TIER_1);
  assert.equal(tennisTier('tennis_wta_us_open'), TIER_1);
  assert.equal(tennisTier('tennis_atp_shanghai_masters'), TIER_1);
  assert.equal(tennisTier('tennis_wta_wuhan_open'), TIER_1);
});

test('the same tournament can be a different tier on each tour', () => {
  // Dubai, Doha and Beijing are WTA 1000s but only ATP 500/250s — tier is not
  // derivable from the tournament slug alone.
  assert.equal(tennisTier('tennis_wta_dubai_championships'), TIER_1);
  assert.equal(tennisTier('tennis_atp_dubai_championships'), TIER_2);
  assert.equal(tennisTier('tennis_wta_qatar_open'), TIER_1);
  assert.equal(tennisTier('tennis_atp_qatar_open'), TIER_2);
  assert.equal(tennisTier('tennis_wta_china_open'), TIER_1);
  assert.equal(tennisTier('tennis_atp_china_open'), TIER_2);
});

test('500/250-level events classify as TIER_2', () => {
  assert.equal(tennisTier('tennis_atp_barcelona_open'), TIER_2);
  assert.equal(tennisTier('tennis_atp_halle_open'), TIER_2);
  assert.equal(tennisTier('tennis_wta_charleston_open'), TIER_2);
});

test('an unrecognized tournament falls to TIER_2, never TIER_1', () => {
  // Guessing low costs a tighter market and a smaller stake; guessing high
  // would put full size behind an unknown event.
  assert.equal(tennisTier('tennis_atp_some_new_500'), TIER_2);
});

test('Challenger-level events classify as TIER_CHALLENGER from key or title', () => {
  assert.equal(tennisTier('tennis_atp_challenger_phoenix'), TIER_CHALLENGER);
  assert.equal(tennisTier('tennis_wta_125_tampico'), TIER_CHALLENGER);
  assert.equal(tennisTier('tennis_atp_someplace', 'ATP Challenger 100 Someplace'), TIER_CHALLENGER);
});

test('non-tennis sports have no tier, so the policy never applies to them', () => {
  assert.equal(tennisTier('baseball_mlb'), null);
  assert.equal(tennisTier('mma_mixed_martial_arts'), null);
  assert.equal(isMarketAllowedForTier('totals', null), true);
  assert.equal(capStakeForTier(0.04, null), 0.04);
});

/* ---------------------------------------------------------------- */
/* Co-sanctioned / renamed deduplication                             */
/* ---------------------------------------------------------------- */

test('aliases collapse to one canonical tournament', () => {
  for (const key of ['tennis_atp_national_bank_open', 'tennis_atp_rogers_cup', 'tennis_atp_montreal', 'tennis_atp_toronto']) {
    assert.equal(canonicalSlug(key), 'canadian_open', key);
  }
});

test('the same match under two tournament names has one identity', () => {
  const a = { sportKey: 'tennis_atp_canadian_open', home: 'Alex de Minaur', away: 'Cameron Norrie', commenceMs: Date.UTC(2026, 7, 8, 18, 0) };
  const b = { sportKey: 'tennis_atp_national_bank_open', home: 'Alex de Minaur', away: 'Cameron Norrie', commenceMs: Date.UTC(2026, 7, 8, 18, 25) };
  assert.equal(matchIdentity(a), matchIdentity(b));
});

test('identity survives home/away being reported in the opposite order', () => {
  const a = { sportKey: 'tennis_atp_canadian_open', home: 'A Player', away: 'B Player', commenceMs: 1 };
  const b = { sportKey: 'tennis_atp_canadian_open', home: 'B Player', away: 'A Player', commenceMs: 1 };
  assert.equal(matchIdentity(a), matchIdentity(b));
});

test('two genuinely different matches keep separate identities', () => {
  const a = { sportKey: 'tennis_atp_canadian_open', home: 'A Player', away: 'B Player', commenceMs: 1 };
  const b = { sportKey: 'tennis_atp_canadian_open', home: 'A Player', away: 'C Player', commenceMs: 1 };
  assert.notEqual(matchIdentity(a), matchIdentity(b));
});

test('dedupe keeps the richer listing and leaves non-tennis events alone', () => {
  const thin = { sportKey: 'tennis_atp_montreal', home: 'A', away: 'B', commenceMs: 1, bookmakers: [{}, {}] };
  const rich = { sportKey: 'tennis_atp_canadian_open', home: 'A', away: 'B', commenceMs: 1, bookmakers: [{}, {}, {}, {}, {}] };
  const mlb = { sportKey: 'baseball_mlb', home: 'Mets', away: 'Pirates', commenceMs: 1 };

  const out = dedupeTennisEvents([thin, rich, mlb]);
  assert.equal(out.length, 2);
  assert.ok(out.includes(mlb));
  assert.equal(out.find((e) => e.sportKey?.startsWith('tennis')).bookmakers.length, 5);
});

/* ---------------------------------------------------------------- */
/* Market policy and risk caps                                       */
/* ---------------------------------------------------------------- */

test('TIER_2 and Challenger are moneyline-only; TIER_1 keeps the wider board', () => {
  assert.equal(isMarketAllowedForTier('h2h', TIER_2), true);
  assert.equal(isMarketAllowedForTier('spreads', TIER_2), false);
  assert.equal(isMarketAllowedForTier('totals', TIER_2), false);
  assert.equal(isMarketAllowedForTier('spreads', TIER_CHALLENGER), false);
  assert.equal(isMarketAllowedForTier('spreads', TIER_1), true);
});

test('stake caps: TIER_2 at 0.5%, Challenger at 0.25%, TIER_1 uncapped by tier', () => {
  assert.equal(capStakeForTier(0.04, TIER_2), 0.005);
  assert.equal(capStakeForTier(0.04, TIER_CHALLENGER), 0.0025);
  assert.equal(capStakeForTier(0.04, TIER_1), 0.04);
  // A already-small Kelly fraction is not inflated up to the cap.
  assert.equal(capStakeForTier(0.001, TIER_2), 0.001);
});

test('TIER_2 liquidity guard blocks thin books, wide disagreement, and stale quotes', () => {
  const now = Date.now();
  const quote = (decimal) => ({ decimal });
  const deep = [quote(2.0), quote(2.01), quote(1.99), quote(2.0), quote(2.02)];

  assert.equal(tierLiquidityBlock({ quotes: deep, lastUpdateMs: now }, TIER_2, now), null);

  assert.match(
    tierLiquidityBlock({ quotes: deep.slice(0, TIER_2_MIN_BOOKS - 1), lastUpdateMs: now }, TIER_2, now),
    /book/,
  );
  assert.match(
    tierLiquidityBlock({ quotes: [quote(1.6), quote(2.6), quote(2.0), quote(2.1)], lastUpdateMs: now }, TIER_2, now),
    /disagree/,
  );
  assert.match(
    tierLiquidityBlock({ quotes: deep, lastUpdateMs: now - 45 * 60 * 1000 }, TIER_2, now),
    /stale/,
  );
});

test('TIER_1 is exempt from the liquidity guard', () => {
  assert.equal(tierLiquidityBlock({ quotes: [{ decimal: 2 }] }, TIER_1, Date.now()), null);
});

/* ---------------------------------------------------------------- */
/* Tennis settlement                                                 */
/* ---------------------------------------------------------------- */

const tennisPick = (over = {}) => ({
  sportKey: 'tennis_atp_canadian_open',
  home: 'Alex de Minaur', away: 'Cameron Norrie',
  outcomeName: 'Alex de Minaur', marketKey: 'h2h', point: null,
  decimal: 2.0, suggested_stake: 20,
  ...over,
});
const sets = (h, a) => ({
  completed: true,
  scores: [{ name: 'Alex de Minaur', score: String(h) }, { name: 'Cameron Norrie', score: String(a) }],
});

test('a completed tennis match settles on sets won', () => {
  assert.equal(gradePick(tennisPick(), sets(2, 1)).won, true);
  assert.equal(gradePick(tennisPick(), sets(1, 2)).won, false);
});

test('retirement after at least one completed set settles to the advancing player', () => {
  const out = gradePick(tennisPick(), sets(1, 0));
  assert.equal(out.won, true);
  assert.equal(out.retired, true);
  assert.equal(gradePick(tennisPick(), sets(0, 1)).won, false);
});

test('a walkover with no completed set is voided, not graded', () => {
  const out = gradePick(tennisPick(), sets(0, 0));
  assert.equal(out.void, true);
  assert.equal(out.payout, 0);
  assert.match(out.reason, /walkover/);
});

test('a retirement with sets level is voided — there is no advancing player to settle to', () => {
  assert.equal(gradePick(tennisPick(), sets(1, 1)).void, true);
});

test('tennis spreads and totals are voided, never graded against the wrong unit', () => {
  // The regression this exists to prevent: the feed prices these in GAMES
  // (-4.5, 21.5) but scores in SETS (0/1/2). Grading 2 sets against a -4.5
  // games line recorded a loss on a covered bet, and every total graded
  // Under because 3 sets is always below 21.5 games.
  const spread = gradePick(tennisPick({ marketKey: 'spreads', point: -4.5 }), sets(2, 1));
  assert.equal(spread.void, true);
  assert.match(spread.reason, /games/);

  const total = gradePick(tennisPick({ marketKey: 'totals', outcomeName: 'Over', point: 21.5 }), sets(2, 1));
  assert.equal(total.void, true);
});

test('non-tennis grading is unchanged by the tennis path', () => {
  const mlb = {
    sportKey: 'baseball_mlb', home: 'Mets', away: 'Pirates',
    outcomeName: 'Mets', marketKey: 'h2h', point: null, decimal: 2.0, suggested_stake: 20,
  };
  const score = { completed: true, scores: [{ name: 'Mets', score: '5' }, { name: 'Pirates', score: '3' }] };
  assert.equal(gradePick(mlb, score).won, true);
  assert.equal(gradePick({ ...mlb, marketKey: 'spreads', point: -1.5 }, score).won, true);
  assert.equal(gradePick({ ...mlb, marketKey: 'totals', outcomeName: 'Over', point: 7.5 }, score).won, true);
});

test('a push now settles as a void instead of sitting pending forever', () => {
  const mlb = {
    sportKey: 'baseball_mlb', home: 'Mets', away: 'Pirates',
    outcomeName: 'Mets', marketKey: 'spreads', point: -2, decimal: 2.0, suggested_stake: 20,
  };
  const score = { completed: true, scores: [{ name: 'Mets', score: '5' }, { name: 'Pirates', score: '3' }] };
  const out = gradePick(mlb, score);
  assert.equal(out.void, true);
  assert.equal(out.payout, 0);
  assert.match(out.reason, /push/);
});

test('an unfinished match still returns null and stays pending', () => {
  assert.equal(gradePick(tennisPick(), { completed: false, scores: [] }), null);
});

test('voids are excluded from win rate, ROI, and money at risk', () => {
  const base = { suggested_stake: 20 };
  const summary = summarizePicks([
    { ...base, status: 'won', result: { payout: 20 } },
    { ...base, status: 'lost', result: { payout: -20 } },
    { ...base, status: 'void', result: { payout: 0 } },
    { ...base, status: 'pending' },
  ]);
  assert.equal(summary.graded, 2);   // the void is not part of the graded sample
  assert.equal(summary.voided, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.staked, 40);  // the void's stake was never at risk
  assert.equal(summary.roi, 0);
});

/* ---------------------------------------------------------------- */
/* Surface lookup                                                     */
/* ---------------------------------------------------------------- */

test('surfaceOfEvent names the surface for tournaments this app can be confident about', () => {
  assert.equal(surfaceOfEvent('tennis_atp_wimbledon'), 'Grass');
  assert.equal(surfaceOfEvent('tennis_wta_french_open'), 'Clay');
  assert.equal(surfaceOfEvent('tennis_atp_italian_open'), 'Clay');
  assert.equal(surfaceOfEvent('tennis_wta_us_open'), 'Hard');
  assert.equal(surfaceOfEvent('tennis_atp_canadian_open'), 'Hard');
});

test('surfaceOfEvent resolves aliases the same as canonicalSlug does', () => {
  // Roland Garros trades under its own name in some feeds — same tournament as french_open.
  assert.equal(surfaceOfEvent('tennis_atp_roland_garros'), 'Clay');
});

test('surfaceOfEvent returns null rather than guessing for an unlisted (typically TIER_2) tournament', () => {
  assert.equal(surfaceOfEvent('tennis_atp_some_250_event'), null);
  assert.equal(surfaceOfEvent(null), null);
});
