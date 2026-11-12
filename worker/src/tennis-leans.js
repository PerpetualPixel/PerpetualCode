/**
 * The Tennis tab's leans (2026-11-12: "display only the matches worth
 * betting and who to lean and how, moneyline, spread, to win a set, take
 * straight or parlay ... add suggestions like 'take Taylor Fritz ML and
 * parlay it with Jessica Pegula', add the why as well. And sort the plays
 * provided by confidence with the best play on top").
 *
 * A match is worth betting when one of its priced legs (the Parlay
 * Builder's, worker/src/tennis-picks.js builderLegs: the model's share at
 * every number against the best price on the board) clears the lean bar:
 * the read gives it LEAN_MIN_PROB or better, the price asks for at least
 * LEAN_MIN_EDGE less than that, and the side carries no flag for injury,
 * fatigue or rust. The lean is the side; the how is the market on that
 * side with the most room for its chance:
 *
 *   ml            the moneyline
 *   set_spread    +1.5 "to win a set", -1.5 "in straight sets"
 *   set1_ml       the first set
 *   games_spread  the game spread
 *
 * A price of STRAIGHT_FLOOR or longer is played straight, sized by its
 * chance (half a unit to two); a shorter one is a parlay piece, and the
 * suggestions pair it with the next most confident lean at a book that
 * prices both. A total or an aces line that clears a stricter bar rides
 * along on the card, and leads it when the match has no side to lean.
 * A straight lean at CONVICTION_PROB with CONVICTION_EDGE of room on a
 * full read is high conviction: those are the tennis Pixel's Picks.
 *
 * Pure: legs in, leans out.
 */
import { americanToDecimal } from '../../docs/engine.js';
import { suggestedUnits } from '../../docs/trends.js';

export const LEAN_MIN_PROB = 0.55;
export const LEAN_MIN_EDGE = 0.02;
/** Shorter than the first is no bet at all; longer than the second is a flyer, not a lean. */
export const LEAN_PRICE = [-700, 250];
/** A price shorter than this is not taken alone: it is a parlay piece. */
export const STRAIGHT_FLOOR = -250;
/** High conviction is the bar the tab was first held to (2026-11-06: "very picky ... only display high conviction"): 74% with seven points of room. */
export const CONVICTION_PROB = 0.74;
export const CONVICTION_EDGE = 0.07;
/** The bar for a total or an aces line: no side behind it, so more room is asked. */
export const EXTRA_MIN_PROB = 0.66;
export const EXTRA_MIN_EDGE = 0.05;
export const SIDE_MARKETS = ['ml', 'set_spread', 'set1_ml', 'games_spread'];
export const EXTRA_MARKETS = ['games_total', 'set1_total', 'sets_total', 'aces'];
export const MAX_SUGGESTIONS = 3;
/** A parlay suggestion is offered only while its legs together stay this likely. */
export const PAIR_MIN_PROB = 0.4;

const pct = (x) => `${Math.round(x * 100)}%`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const round3 = (x) => Math.round(x * 1000) / 1000;
const americanOfDecimal = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const bestQuote = (leg) => [...(leg.quotes ?? [])].sort((x, y) => y.american - x.american)[0] ?? null;

/** A leg in a few words, the way a bettor says it: "Taylor Fritz ML", "Holger Rune to win a set". */
export function shortSelection(leg) {
  switch (leg.market) {
    case 'ml': return `${leg.name} ML`;
    case 'set_spread': return leg.point > 0 ? `${leg.name} to win a set` : `${leg.name} in straight sets`;
    case 'set1_ml': return `${leg.name} 1st set`;
    case 'games_spread': return `${leg.name} ${signed(leg.point)} games`;
    default: return leg.selection;
  }
}

/** How a lean is played, in words. */
export function howText(leg, how, units) {
  const market = leg.market === 'ml' ? 'Moneyline' : leg.market === 'set_spread' ? (leg.point > 0 ? 'To win a set (+1.5 sets)' : 'In straight sets (-1.5 sets)') : leg.market === 'set1_ml' ? 'First set winner' : leg.market === 'games_spread' ? `Game spread ${signed(leg.point)}` : leg.label ?? leg.market;
  return how === 'straight' ? `${market}, straight for ${units}u` : `${market}, as a parlay leg: too short to take alone`;
}

const clears = (leg, minProb, minEdge) => {
  const q = bestQuote(leg);
  return Boolean(q) && leg.prob >= minProb && leg.edge >= minEdge && q.american >= LEAN_PRICE[0] && q.american <= LEAN_PRICE[1] && !(leg.flags ?? []).length;
};
const room = (leg) => leg.edge * leg.prob;

/** A leg trimmed to what a card shows and a slip needs. */
function legView(leg) {
  const q = bestQuote(leg);
  return { id: leg.id, market: leg.market, label: leg.label, side: leg.side ?? null, name: leg.name ?? null, selection: leg.selection, short: shortSelection(leg), point: leg.point ?? null, sideWord: leg.sideWord ?? null, prob: leg.prob, implied: leg.implied, edge: leg.edge, bookId: q?.bookId ?? null, book: q?.book ?? null, american: q?.american ?? null, link: q?.link ?? null, quotes: leg.quotes ?? [], consistency: leg.consistency ?? null };
}

/**
 * The lean on one match from its priced legs, or null when nothing on it
 * is worth a bet. `read` is the match read's summary: {pMarket, pModel,
 * pFinal} as player A's share, `thin` when a serve profile was missing,
 * `flags: {a, b}`.
 */
export function leanFor(legs, { read = {} } = {}) {
  const sides = (legs ?? []).filter((l) => SIDE_MARKETS.includes(l.market) && l.side && clears(l, LEAN_MIN_PROB, LEAN_MIN_EDGE));
  const extras = (legs ?? []).filter((l) => EXTRA_MARKETS.includes(l.market) && clears(l, EXTRA_MIN_PROB, EXTRA_MIN_EDGE));
  const straight = (l) => bestQuote(l).american >= STRAIGHT_FLOOR;
  // The side: the straight play with the most room for its chance; failing one, the best parlay piece.
  const main = [...sides.filter(straight)].sort((x, y) => room(y) - room(x))[0] ?? [...sides].sort((x, y) => room(y) - room(x))[0] ?? [...extras].sort((x, y) => room(y) - room(x))[0] ?? null;
  if (!main) return null;
  const q = bestQuote(main);
  const how = q.american >= STRAIGHT_FLOOR ? 'straight' : 'parlay';
  const units = how === 'straight' ? suggestedUnits({ prob: main.prob }) : null;
  const thin = Boolean(read.thin);
  const conviction = how === 'straight' && !thin && main.prob >= CONVICTION_PROB && main.edge >= CONVICTION_EDGE ? 'high' : 'lean';
  const side = main.side ?? null;
  const share = (p) => (p == null || !side ? null : side === 'a' ? p : 1 - p);
  const why = [];
  if (side && read.pFinal != null) why.push(`${main.name} ${pct(share(read.pFinal))} to win by the read${read.pModel != null && read.pMarket != null ? `: the model's own ${pct(share(read.pModel))}, the market's ${pct(share(read.pMarket))}, blended` : ''}`);
  // The moneyline leg's own first line says the same share again: the read's line above stands for it.
  for (const [i, w] of (main.why ?? []).entries()) if (!(i === 0 && main.market === 'ml' && why.length) && !why.includes(w)) why.push(w);
  why.push(`${q.book} has it at ${signed(q.american)}, which asks for ${pct(main.implied)}; the read gives ${pct(main.prob)}, ${Math.round(main.edge * 100)} points of room`);
  if ((main.opponentFlags ?? []).length) why.push(`${main.opponent} is flagged for ${main.opponentFlags.join(' and ')}`);
  if (thin) why.push(`No serve numbers on file for ${read.thinNames ?? 'one of the players'}: this read is the market's price moved by form alone, so it is sized as a lean, never a high-conviction play`);
  why.push(how === 'straight'
    ? `Played straight: ${signed(q.american)} pays enough alone, ${units}u at ${pct(main.prob)}`
    : `Too short to take alone at ${signed(q.american)}: use it as a parlay leg`);
  const alternates = sides.filter((l) => l !== main && l.side === side).sort((x, y) => room(y) - room(x)).slice(0, 3).map(legView);
  const also = extras.filter((l) => l !== main).sort((x, y) => room(y) - room(x)).slice(0, 2).map(legView);
  return {
    matchId: main.matchId, tour: main.tour, event: main.event, round: main.round, commenceMs: main.commenceMs, a: main.a, b: main.b,
    side, name: main.name ?? null, opponent: main.opponent ?? null, confidence: main.prob, how, units, conviction, thin,
    howText: howText(main, how, units), main: legView(main), alternates, also, why,
    opponentFlags: main.opponentFlags ?? [], pMarket: read.pMarket ?? null, pModel: read.pModel ?? null, pFinal: read.pFinal ?? null,
  };
}

/** The match's best aces line at a price, or null: the stricter bar, a price worth taking alone, the server unflagged. */
export function propFor(legs) {
  const best = (legs ?? []).filter((l) => l.market === 'aces' && clears(l, EXTRA_MIN_PROB, EXTRA_MIN_EDGE) && bestQuote(l).american >= STRAIGHT_FLOOR).sort((x, y) => room(y) - room(x))[0];
  if (!best) return null;
  const q = bestQuote(best);
  return { ...legView(best), units: suggestedUnits({ prob: best.prob }), why: [...(best.why ?? []), `${q.book} has it at ${signed(q.american)}, which asks for ${pct(best.implied)}; the read gives ${pct(best.prob)}, ${Math.round(best.edge * 100)} points of room`] };
}

/** The leans in the order the tab shows them: the most likely to land first, the roomier one on a tie. */
export const sortLeans = (leans) => [...leans].sort((x, y) => y.confidence - x.confidence || y.main.edge - x.main.edge || x.commenceMs - y.commenceMs);

/** A set of legs priced as one ticket at the book that carries every one of them best; null when no book does. */
export function priceTogether(legs) {
  const books = new Map();
  for (const [i, leg] of legs.entries()) for (const q of leg.quotes ?? []) { if (!books.has(q.bookId)) books.set(q.bookId, { bookId: q.bookId, book: q.book, legs: new Map() }); const b = books.get(q.bookId); if (!b.legs.has(i) || q.american > b.legs.get(i).american) b.legs.set(i, q); }
  const full = [...books.values()].filter((b) => b.legs.size === legs.length).map((b) => ({ ...b, dec: [...b.legs.values()].reduce((d, q) => d * americanToDecimal(q.american), 1) })).sort((x, y) => y.dec - x.dec)[0];
  if (!full) return null;
  return { bookId: full.bookId, book: full.book, decimal: Math.round(full.dec * 1000) / 1000, american: americanOfDecimal(full.dec), quotes: legs.map((_, i) => full.legs.get(i)) };
}

/**
 * The parlay suggestions from the day's leans, the user's own example the
 * shape of them: every parlay piece paired with the most confident other
 * lean, then the two (and the three) most confident leans together. Each
 * is priced at one book, with its chance as the product of its legs (the
 * matches are separate events). At most MAX_SUGGESTIONS, none repeated.
 */
export function pairSuggestions(leans, now = Date.now()) {
  const ready = sortLeans(leans).filter((l) => l.commenceMs > now && l.main.side);
  const out = []; const seen = new Set();
  const offer = (group, lead) => {
    if (group.length < 2 || new Set(group.map((l) => l.matchId)).size !== group.length) return;
    const key = group.map((l) => l.main.id).sort().join('|'); if (seen.has(key)) return;
    const prob = group.reduce((p, l) => p * l.main.prob, 1); if (prob < PAIR_MIN_PROB) return;
    const priced = priceTogether(group.map((l) => l.main)); if (!priced) return;
    const implied = 1 / priced.decimal;
    seen.add(key);
    const [first, ...rest] = group;
    out.push({
      id: `pair:${key}`, lead,
      text: `Take ${first.main.short} and parlay it with ${rest.map((l) => l.main.short).join(' and ')}`,
      legs: group.map((l, i) => ({ matchId: l.matchId, tour: l.tour, a: l.a, b: l.b, event: l.event, commenceMs: l.commenceMs, selection: l.main.selection, short: l.main.short, prob: l.main.prob, american: priced.quotes[i].american, link: priced.quotes[i].link ?? null })),
      bookId: priced.bookId, book: priced.book, american: priced.american, decimal: priced.decimal, prob: round3(prob), implied: round3(implied), edge: round3(prob - implied),
      why: [
        ...group.map((l, i) => `${l.main.short} at ${signed(priced.quotes[i].american)}: ${pct(l.main.prob)} by the read, ${Math.round(l.main.edge * 100)} points over its price${l.how === 'parlay' ? '; too short to take alone' : ''}`),
        `Together ${pct(prob)} to land at ${signed(priced.american)} (${priced.book}); that price asks for ${pct(implied)}`,
      ],
    });
  };
  // Each parlay piece with the most confident other lean.
  for (const piece of ready.filter((l) => l.how === 'parlay')) { const partner = ready.find((l) => l.matchId !== piece.matchId); if (partner) offer([piece, partner], 'piece'); }
  if (ready.length >= 2) offer(ready.slice(0, 2), 'top');
  if (ready.length >= 3) offer(ready.slice(0, 3), 'top');
  return out.slice(0, MAX_SUGGESTIONS);
}
