/**
 * Anchor + partner tickets — the shape every Pixel's Pick and the Play of
 * the Day take (2026-10-05 product direction), and the straight plays that
 * fill the board beside them.
 *
 * The direction, in its own words: two-leg parlays have been the most
 * profitable thing on the board. One leg is SAFE — "very bottom level", a
 * player-prop line far below the player's normal output (10+ points for a
 * 15-20 a night scorer), or the market's own heavy favourite. The second
 * leg is a moneyline or something similar. The two together price between
 * -200 and +100, and more often than not BOTH land — which is more value
 * than a +100 straight that lands half the time.
 *
 * The winning slips handed over with it (2026-10-05) set the texture: a
 * WNBA alt-prop pair across two games (2+ assists at -320 with 5+ points at
 * -500, -174 together), two MMA favourites (-149 together), a SAME-GAME pair
 * of two players' props (2+ rebounds with 12+ points, -168), and straight
 * plays in the same band — a 10+ alt rushing yards at -132, a moneyline at
 * -146.
 *
 * What this module does with that:
 *
 * - A leg pool is anything the engine already grades: game markets
 *   (moneyline, spread, total) from analyze() in the game-market sports,
 *   plus player-prop legs built by the worker (worker/src/prop-legs.js:
 *   NFL, WNBA and NBA alternate lines) with a hit-rate profile from the
 *   player's real game log. Every leg must be bettable at a book the reader
 *   can use and carry a real edge at its price — the bar the boards have
 *   always held.
 * - A ticket is exactly two legs, never arguing with each other, whose
 *   combined price lands inside TICKET_BAND and whose combined probability
 *   clears TICKET_MIN_PROB ("more often than not both hit"). At least one
 *   leg is an ANCHOR — a leg read at ANCHOR_MIN_PROB or better, whether
 *   that read is the market's (a heavy favourite) or the game log's (a
 *   deep alternate line). The two legs come from two games, except that
 *   two players' props from ONE game may pair as a same-game parlay.
 * - Tickets are ranked by their own expected value — the product of the
 *   legs' probabilities against the combined price — so the board posts
 *   the pairs whose price most underrates the chance that both land.
 * - When the day offers fewer tickets than the board has slots, legs that
 *   stand inside the band on their own fill the rest as straight plays,
 *   ranked the same way (see buildBoard).
 *
 * Pure: no network, no DOM, no KV. Shared by the browser and the worker
 * the same way docs/engine.js is, and testable on its own.
 */

import { contradicts, decimalToAmerican, formatAmerican, suggestedStake } from './engine.js';

/**
 * The leagues a GAME-MARKET leg (moneyline, spread, total) may come from —
 * the ones the direction named. NCAA football is further restricted
 * upstream to Power 4 matchups (docs/ncaaf-conferences.js), and NFL to the
 * regular season, exactly as the boards already were.
 */
export const TICKET_SPORTS = {
  keys: new Set(['americanfootball_nfl', 'americanfootball_ncaaf', 'mma_mixed_martial_arts']),
  prefixes: ['tennis_'],
};

/**
 * The leagues a PLAYER-PROP leg may come from: football's alternate yardage
 * and reception lines, and basketball's alternate points, rebounds and
 * assists — the WNBA lines the winning slips were built on, and the NBA's
 * once its season is on. Basketball supplies props only: its moneylines
 * were never part of the direction.
 */
export const PROP_SPORTS = new Set(['americanfootball_nfl', 'basketball_wnba', 'basketball_nba']);

export function isGameLegSport(sportKey) {
  const key = String(sportKey ?? '');
  return TICKET_SPORTS.keys.has(key) || TICKET_SPORTS.prefixes.some((p) => key.startsWith(p));
}

export function isPropLegSport(sportKey) {
  return PROP_SPORTS.has(String(sportKey ?? ''));
}

/** Whether a sport supplies the boards any leg at all. */
export function isTicketSport(sportKey) {
  return isGameLegSport(sportKey) || isPropLegSport(sportKey);
}

/** Combined price the ticket must land in: -200 to +100. A straight play fills a slot inside the same band. */
export const TICKET_BAND = { MIN_AMERICAN: -200, MAX_AMERICAN: 100 };

/**
 * The safe leg. By the market's own read a side at 72% is about -257 fair;
 * the heavy favourites and deep alternate lines the direction describes sit
 * at or past this. A prop leg's read is its shrunk game-log hit rate
 * (docs/prop-legs.js) stored as consensusProb — a -320 alternate the
 * player clears every night reads well past this; a -132 alternate does
 * not, and is a partner or a straight play, never the anchor.
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

/** Joint probability of every leg landing, treating legs as independent. */
export function ticketProb(legs) {
  return legs.reduce((p, l) => p * l.consensusProb, 1);
}

/** Whether a leg is anchor-grade: read at ANCHOR_MIN_PROB or better, by the market or by the game log. */
export function isAnchorLeg(leg) {
  return Number.isFinite(leg?.consensusProb) && leg.consensusProb >= ANCHOR_MIN_PROB;
}

/**
 * Whether an engine candidate may be a leg at all. Prop legs are gated
 * where they're built (hit rate, edge, liquidity) and pass through here
 * on their sport, bettability and a favourite-side read; game-market legs
 * must clear the board's own bars: a game-market sport, a bettable price,
 * the edge floor, the Kelly floor, the conviction floor, and a
 * favourite-side read for the partner role.
 */
export function legEligible(c, { minEv = 0, minKelly = 0, minScore = 0 } = {}) {
  if (!c) return false;
  if (!Number.isFinite(c.decimal) || c.decimal <= 1) return false;
  if (!Number.isFinite(c.consensusProb) || c.consensusProb <= 0 || c.consensusProb >= 1) return false;
  if (c.kind === 'prop') return isPropLegSport(c.sportKey) && c.bettable !== false && c.consensusProb >= PARTNER_MIN_PROB;
  if (!isGameLegSport(c.sportKey)) return false;
  if (!GAME_MARKETS.has(c.marketKey)) return false;
  if (c.bettable === false) return false;
  if (!(c.ev > minEv)) return false;
  if (suggestedStake(c) < minKelly) return false;
  if (Number.isFinite(c.score) && c.score < minScore) return false;
  if (c.consensusProb < PARTNER_MIN_PROB) return false;
  if (c.marketKey === 'totals' && c.consensusProb < TOTALS_MIN_PROB) return false;
  return true;
}

const foldPlayer = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Whether two legs may share a ticket. Legs from different games pair
 * unless they argue (docs/engine.js's contradicts). Legs from ONE game pair
 * only when both are player props on two different players — the same-game
 * parlay the winning slips carried (one player's rebounds with another's
 * points). One player's two stats, or a prop with its own game's side or
 * total, move together and are never a pair.
 */
export function legsConflict(a, b) {
  if (a.eventId !== b.eventId) return contradicts(a, b);
  if (a.kind !== 'prop' || b.kind !== 'prop') return true;
  return foldPlayer(a.playerName) === foldPlayer(b.playerName);
}

/** A leg's one-line role note for the ticket's pairReason. */
function describeLeg(leg) {
  if (leg.kind === 'prop' && leg.profile) {
    const p = leg.profile;
    return `${leg.selection} has landed in ${Math.round(p.season * 100)}% of ${p.games} games (${Math.round(p.l10 * 100)}% of the last 10)`;
  }
  return `${leg.selection} reads ${Math.round(leg.consensusProb * 100)}% by the market`;
}

function bandDecimals(minAmerican, maxAmerican) {
  const minDecimal = minAmerican > 0 ? 1 + minAmerican / 100 : 1 + 100 / -minAmerican; // -200 -> 1.5
  const maxDecimal = maxAmerican > 0 ? 1 + maxAmerican / 100 : 1 + 100 / -maxAmerican; // +100 -> 2.0
  return { minDecimal, maxDecimal };
}

const inBand = (decimal, { minDecimal, maxDecimal }) => decimal >= minDecimal - 1e-9 && decimal <= maxDecimal + 1e-9;

/** The leg pool a board draws from: real prices, real probabilities, games the day hasn't used. */
function drawable(legs, usedEventIds) {
  return (legs ?? []).filter((l) => l && !usedEventIds.has(l.eventId)
    && Number.isFinite(l.decimal) && l.decimal > 1
    && Number.isFinite(l.consensusProb) && l.consensusProb > 0 && l.consensusProb < 1);
}

/**
 * Build up to `count` anchor + partner tickets from a leg pool.
 *
 * Every non-conflicting pair (see legsConflict) is priced; a pair is a
 * ticket when it lands inside the band, clears the joint-probability
 * floor, and holds at least one anchor-grade leg. Tickets are ranked by
 * expected value (joint probability against the combined price), then by
 * joint probability, and taken greedily so no two tickets share a game or
 * a leg and no ticket touches a game in `usedEventIds` (the day's other
 * boards).
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
  const pool = drawable(legs, usedEventIds);
  const band = bandDecimals(minAmerican, maxAmerican);

  const pairs = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      if (a.id === b.id || legsConflict(a, b)) continue;
      if (!isAnchorLeg(a) && !isAnchorLeg(b)) continue;
      // The safer leg leads — the higher read, a gated prop line ahead of a
      // market read when they tie — so the record's anchor fields point at
      // the leg the ticket is built around.
      const safety = (l) => l.consensusProb + (l.kind === 'prop' ? 1e-6 : 0);
      const anchorFirst = safety(a) >= safety(b) ? [a, b] : [b, a];
      const { decimal, american } = ticketPrice(anchorFirst);
      if (!inBand(decimal, band)) continue;
      const prob = ticketProb(anchorFirst);
      if (prob < minProb) continue;
      const ev = prob * decimal - 1;
      if (ev < minEv) continue;
      pairs.push({ legs: anchorFirst, decimal, american, prob, ev, sameGame: a.eventId === b.eventId });
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
      sameGame: pair.sameGame,
      pairReason: `${pair.sameGame ? 'Same game parlay. ' : ''}Anchor: ${describeLeg(anchor)}. Partner: ${describeLeg(partner)}. `
        + `Together ${formatAmerican(pair.american)} with a ${Math.round(pair.prob * 100)}% chance both land.`,
    });
  }
  return tickets;
}

/**
 * Whether a leg stands on its own as a straight play: priced inside the
 * band, a favourite-side read, and worth more than its price says — the
 * -132 alternate rushing line and the -146 moneyline on the winning slips.
 */
export function singleEligible(leg, {
  minAmerican = TICKET_BAND.MIN_AMERICAN,
  maxAmerican = TICKET_BAND.MAX_AMERICAN,
  minProb = PARTNER_MIN_PROB,
  minEv = 0,
} = {}) {
  if (!leg || !Number.isFinite(leg.decimal) || !Number.isFinite(leg.consensusProb)) return false;
  if (!inBand(leg.decimal, bandDecimals(minAmerican, maxAmerican))) return false;
  if (leg.consensusProb < minProb) return false;
  const ev = Number.isFinite(leg.ev) ? leg.ev : leg.consensusProb * leg.decimal - 1;
  return ev >= minEv;
}

/**
 * A board of `count` plays: every ticket the pool makes first, then — when
 * the day offers fewer tickets than slots — the best legs standing inside
 * the band on their own, as straight plays, ranked by expected value then
 * probability. No two plays share a game. Each straight play carries the
 * leg's own fields with `type: 'single'` and `legs: [leg]`, the shape the
 * record builder and the cards already read for a single.
 */
export function buildBoard(legs, {
  count = 1,
  usedEventIds = new Set(),
  minAmerican = TICKET_BAND.MIN_AMERICAN,
  maxAmerican = TICKET_BAND.MAX_AMERICAN,
  minProb = TICKET_MIN_PROB,
  minEv = 0,
} = {}) {
  const tickets = buildTickets(legs, { count, usedEventIds, minAmerican, maxAmerican, minProb, minEv });
  if (tickets.length >= count) return tickets;

  const taken = new Set([...usedEventIds, ...tickets.flatMap((t) => t.legs.map((l) => l.eventId))]);
  const singles = drawable(legs, taken)
    .filter((l) => singleEligible(l, { minAmerican, maxAmerican, minEv }))
    .map((l) => ({ leg: l, ev: Number.isFinite(l.ev) ? l.ev : l.consensusProb * l.decimal - 1 }))
    .sort((x, y) => (y.ev - x.ev) || (y.leg.consensusProb - x.leg.consensusProb));

  const board = [...tickets];
  for (const { leg } of singles) {
    if (board.length >= count) break;
    if (taken.has(leg.eventId)) continue;
    taken.add(leg.eventId);
    board.push({
      ...leg,
      type: 'single',
      legs: [leg],
      meetsStandard: true,
      prob: leg.consensusProb,
      singleReason: `Straight play: ${describeLeg(leg)}; ${formatAmerican(Number.isFinite(leg.american) ? leg.american : decimalToAmerican(leg.decimal))} stands inside the band on its own.`,
    });
  }
  return board;
}
