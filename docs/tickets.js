/**
 * Anchor + partner tickets — the shape every Pixel's Pick and the Play of
 * the Day now take (2026-10-05 product direction).
 *
 * The direction, in its own words: two-leg parlays have been the most
 * profitable thing on the board. One leg is SAFE — "very bottom level", a
 * player-prop line far below the player's normal output (10+ points for a
 * 15-20 a night scorer), or the market's own heavy favourite. The second
 * leg is a moneyline or something similar. The two together price between
 * -200 and +100, and more often than not BOTH land — which is more value
 * than a +100 straight that lands half the time.
 *
 * What this module does with that:
 *
 * - A leg pool is anything the engine already grades: game markets
 *   (moneyline, spread, total) from analyze(), plus player-prop legs built
 *   by the worker (worker/src/football-props.js) with a hit-rate profile
 *   from the player's real game log. Every leg must be bettable at a book
 *   the reader can use and carry a real edge at its price — the same bar
 *   the boards have always held.
 * - A ticket is exactly two legs from two different games, never arguing
 *   with each other, whose combined price lands inside TICKET_BAND and
 *   whose combined probability clears TICKET_MIN_PROB ("more often than
 *   not both hit"). At least one leg is an ANCHOR: a prop line the player
 *   clears at a rate the gates accept, or a side the market itself reads
 *   at ANCHOR_MIN_PROB or better.
 * - Tickets are ranked by their own expected value — the product of the
 *   legs' probabilities against the combined price — so the board posts
 *   the pairs whose price most underrates the chance that both land.
 *
 * Sports are restricted to the ones the direction named: NFL, NCAA
 * football, MMA, and tennis (ATP, WTA, Challenger). See TICKET_SPORTS.
 *
 * Pure: no network, no DOM, no KV. Shared by the browser and the worker
 * the same way docs/engine.js is, and testable on its own.
 */

import { contradicts, decimalToAmerican, formatAmerican, suggestedStake } from './engine.js';

/**
 * The leagues a ticket may draw legs from. NCAA football is further
 * restricted upstream to Power 4 matchups (docs/ncaaf-conferences.js), and
 * NFL to the regular season, exactly as the boards already were.
 */
export const TICKET_SPORTS = {
  keys: new Set(['americanfootball_nfl', 'americanfootball_ncaaf', 'mma_mixed_martial_arts']),
  prefixes: ['tennis_'],
};

export function isTicketSport(sportKey) {
  const key = String(sportKey ?? '');
  return TICKET_SPORTS.keys.has(key) || TICKET_SPORTS.prefixes.some((p) => key.startsWith(p));
}

/** Combined price the ticket must land in: -200 to +100. */
export const TICKET_BAND = { MIN_AMERICAN: -200, MAX_AMERICAN: 100 };

/**
 * The safe leg. By the market's own read a side at 72% is about -257 fair;
 * the heavy favourites and deep alternate lines the direction describes sit
 * at or past this. A prop leg qualifies as an anchor through its hit-rate
 * gates instead (see worker/src/football-props.js), so its stored
 * consensusProb — the shrunk blended hit rate — is what this reads.
 */
export const ANCHOR_MIN_PROB = 0.72;

/**
 * The partner is "a moneyline or something similar": still a favourite-side
 * read, never a coin flip. With an anchor at ~1.3 decimal the band's +100
 * ceiling already forces the partner under ~1.54 (about -185), so this
 * floor mostly matters for a lighter anchor paired with a dog.
 */
export const PARTNER_MIN_PROB = 0.55;

/** "More often than not both of these legs will hit." */
export const TICKET_MIN_PROB = 0.5;

/**
 * Totals only "if confident enough": a game total is the one market here
 * with no team or player on the hook, so it is held to a stricter read
 * than a side before it can be a leg at all.
 */
export const TOTALS_MIN_PROB = 0.62;

/** The game markets a leg may come from; props arrive with kind: 'prop'. */
const GAME_MARKETS = new Set(['h2h', 'spreads', 'totals']);

/** Combined decimal/American price of a set of legs — a parlay multiplies. */
export function ticketPrice(legs) {
  const decimal = legs.reduce((d, l) => d * l.decimal, 1);
  return { decimal, american: decimalToAmerican(decimal) };
}

/** Joint probability of every leg landing, treating legs as independent (they come from different games). */
export function ticketProb(legs) {
  return legs.reduce((p, l) => p * l.consensusProb, 1);
}

/** Whether a leg is anchor-grade: a gated prop line, or a side the market reads at ANCHOR_MIN_PROB+. */
export function isAnchorLeg(leg) {
  if (leg?.kind === 'prop') return true;
  return Number.isFinite(leg?.consensusProb) && leg.consensusProb >= ANCHOR_MIN_PROB;
}

/**
 * Whether an engine candidate may be a leg at all. Prop legs are gated
 * where they're built (hit rate, edge, liquidity) and pass through here
 * on their sport alone; game-market legs must clear the board's own bars:
 * a ticket-sport game, a bettable price, the edge floor, the Kelly floor,
 * the conviction floor, and a favourite-side read for the partner role.
 */
export function legEligible(c, { minEv = 0, minKelly = 0, minScore = 0 } = {}) {
  if (!c || !isTicketSport(c.sportKey)) return false;
  if (!Number.isFinite(c.decimal) || c.decimal <= 1) return false;
  if (!Number.isFinite(c.consensusProb) || c.consensusProb <= 0 || c.consensusProb >= 1) return false;
  if (c.kind === 'prop') return c.bettable !== false;
  if (!GAME_MARKETS.has(c.marketKey)) return false;
  if (c.bettable === false) return false;
  if (!(c.ev > minEv)) return false;
  if (suggestedStake(c) < minKelly) return false;
  if (Number.isFinite(c.score) && c.score < minScore) return false;
  if (c.consensusProb < PARTNER_MIN_PROB) return false;
  if (c.marketKey === 'totals' && c.consensusProb < TOTALS_MIN_PROB) return false;
  return true;
}

/** A leg's one-line role note for the ticket's pairReason. */
function describeLeg(leg) {
  if (leg.kind === 'prop' && leg.profile) {
    const p = leg.profile;
    return `${leg.selection} has landed in ${Math.round(p.season * 100)}% of ${p.games} games (${Math.round(p.l10 * 100)}% of the last 10)`;
  }
  return `${leg.selection} reads ${Math.round(leg.consensusProb * 100)}% by the market`;
}

/**
 * Build up to `count` anchor + partner tickets from a leg pool.
 *
 * Every cross-game, non-contradicting pair is priced; a pair is a ticket
 * when it lands inside the band, clears the joint-probability floor, and
 * holds at least one anchor-grade leg. Tickets are ranked by expected
 * value (joint probability against the combined price), then by joint
 * probability, and taken greedily so no two tickets share a game or a leg
 * and no ticket touches a game in `usedEventIds` (the day's other boards).
 *
 * Legs are ordered anchor first on the ticket so the record's "anchor leg"
 * fields (eventId, sportKey, home/away — see tracking.js's pickRecordFrom)
 * point at the safe side of the ticket.
 */
export function buildTickets(legs, {
  count = 1,
  usedEventIds = new Set(),
  minAmerican = TICKET_BAND.MIN_AMERICAN,
  maxAmerican = TICKET_BAND.MAX_AMERICAN,
  minProb = TICKET_MIN_PROB,
  minEv = 0,
} = {}) {
  const pool = (legs ?? []).filter((l) => l && !usedEventIds.has(l.eventId)
    && Number.isFinite(l.decimal) && l.decimal > 1
    && Number.isFinite(l.consensusProb) && l.consensusProb > 0 && l.consensusProb < 1);
  const minDecimal = 1 + 100 / -minAmerican; // -200 -> 1.5
  const maxDecimal = maxAmerican > 0 ? 1 + maxAmerican / 100 : 1 + 100 / -maxAmerican; // +100 -> 2.0

  const pairs = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      if (a.eventId === b.eventId || contradicts(a, b)) continue;
      if (!isAnchorLeg(a) && !isAnchorLeg(b)) continue;
      // The safer leg leads: a gated prop line over a market read, else the
      // higher probability — so the record's anchor fields point at the leg
      // the ticket is built around.
      const safety = (l) => (l.kind === 'prop' ? 1 : 0) + l.consensusProb;
      const anchorFirst = safety(a) >= safety(b) ? [a, b] : [b, a];
      const { decimal, american } = ticketPrice(anchorFirst);
      if (decimal < minDecimal - 1e-9 || decimal > maxDecimal + 1e-9) continue;
      const prob = ticketProb(anchorFirst);
      if (prob < minProb) continue;
      const ev = prob * decimal - 1;
      if (ev < minEv) continue;
      pairs.push({ legs: anchorFirst, decimal, american, prob, ev });
    }
  }
  pairs.sort((x, y) => (y.ev - x.ev) || (y.prob - x.prob));

  const tickets = [];
  const takenEvents = new Set(usedEventIds);
  const takenLegs = new Set();
  for (const pair of pairs) {
    if (tickets.length >= count) break;
    if (pair.legs.some((l) => takenEvents.has(l.eventId) || takenLegs.has(l.id))) continue;
    pair.legs.forEach((l) => { takenEvents.add(l.eventId); takenLegs.add(l.id); });
    const [anchor, partner] = pair.legs;
    tickets.push({
      type: 'combo',
      legs: pair.legs,
      american: pair.american,
      decimal: Math.round(pair.decimal * 1000) / 1000,
      prob: Math.round(pair.prob * 1e4) / 1e4,
      ev: Math.round(pair.ev * 1e4) / 1e4,
      // A ticket's conviction is its legs' average grade — same as the
      // board's existing combos — so the unit band reads it unchanged.
      score: pair.legs.reduce((s, l) => s + (Number.isFinite(l.score) ? l.score : 0), 0) / pair.legs.length,
      meetsStandard: true,
      anchorId: anchor.id,
      pairReason: `Anchor: ${describeLeg(anchor)}. Partner: ${describeLeg(partner)}. `
        + `Together ${formatAmerican(pair.american)} with a ${Math.round(pair.prob * 100)}% chance both land.`,
    });
  }
  return tickets;
}
