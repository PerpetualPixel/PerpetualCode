/**
 * The live tennis model (2026-11-12 direction: "live tennis plays to take
 * a ML or to win a set based off of probability, momentum, player
 * performances"). Pure: no fetches, no KV.
 *
 * What a live match gives the app is its score, game by game (ESPN's
 * scoreboard carries the sets and the games in them; it carries no serve
 * statistics and does not say who is serving, and the stat sites that do
 * refuse a runner). So the read is built from three things:
 *
 *   the state    the sets won and the games in the set in play, turned
 *                into a chance of the set and of the match exactly, from
 *                each player's chance of winning a point on serve
 *   the match    the games in the order they were won: who serves is
 *                worked out from them (holds are far likelier than
 *                breaks, so the serve order with fewer breaks is the
 *                true one), and each player's holds and breaks today
 *                move his serve number off the pre-match one
 *   momentum     the same holds and breaks weigh more the later they
 *                came, so a player who has taken over the match reads
 *                that way before the set score shows it
 *
 * The pre-match serve numbers come from the Tennis tab's own read of the
 * match; without one they are solved from the live price the first time
 * the match is seen.
 */
import { TOUR_AVG } from './tennis-model.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** The chance the server wins a game from his chance of winning a point on serve. */
export function holdProb(p) {
  const q = 1 - p;
  return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * ((p * p) / (1 - 2 * p * q));
}

/** The point chance that gives a hold chance (the inverse of holdProb). */
export function pointProbFor(hold) {
  let lo = 0.2; let hi = 0.97;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (holdProb(mid) < hold) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** The chance A wins a tiebreak to seven, by two, from the two serve-point chances and who serves its first point. */
export function tiebreakProb(pA, pB, aServesFirst = true) {
  const memo = new Map();
  const f = (i, j) => {
    if (i >= 7 && i - j >= 2) return 1;
    if (j >= 7 && j - i >= 2) return 0;
    if (i === j && i >= 6) { const x = pA * (1 - pB); const y = (1 - pA) * pB; return x / (x + y); }
    const k = i * 32 + j;
    if (memo.has(k)) return memo.get(k);
    const n = i + j;
    // The first point is one player's; after it the serve changes every two points.
    const firstServes = Math.floor((n + 1) / 2) % 2 === 0;
    const win = (firstServes === aServesFirst) ? pA : 1 - pB;
    const v = win * f(i + 1, j) + (1 - win) * f(i, j + 1);
    memo.set(k, v);
    return v;
  };
  return f(0, 0);
}

const setDone = (a, b) => ((a >= 6 || b >= 6) && Math.abs(a - b) >= 2) || a === 7 || b === 7;

/**
 * How a set ends from a score with one player due to serve: {aA, aB, bA,
 * bB}, the chance A (a) or B (b) wins it and that A (A) or B (B) serves
 * first in the next set. The serve passes every game, the tiebreak
 * counting as one.
 */
export function setOutcome(pA, pB, gA = 0, gB = 0, aServes = true) {
  const hA = holdProb(pA); const hB = holdProb(pB);
  const memo = new Map();
  const f = (a, b, s) => {
    if (setDone(a, b)) { const o = { aA: 0, aB: 0, bA: 0, bB: 0 }; o[(a > b ? 'a' : 'b') + (s ? 'A' : 'B')] = 1; return o; }
    if (a === 6 && b === 6) { const t = tiebreakProb(pA, pB, s); return s ? { aA: 0, aB: t, bA: 0, bB: 1 - t } : { aA: t, aB: 0, bA: 1 - t, bB: 0 }; }
    const k = (a * 8 + b) * 2 + (s ? 1 : 0);
    if (memo.has(k)) return memo.get(k);
    const w = s ? hA : 1 - hB;
    const x = f(a + 1, b, !s); const y = f(a, b + 1, !s);
    const o = { aA: w * x.aA + (1 - w) * y.aA, aB: w * x.aB + (1 - w) * y.aB, bA: w * x.bA + (1 - w) * y.bA, bB: w * x.bB + (1 - w) * y.bB };
    memo.set(k, o);
    return o;
  };
  return f(gA, gB, aServes);
}

/**
 * The chance A wins the match, and the set in play, from the score:
 * {match, set, nextSet}. `aServes` is who serves the next game; null
 * when it is not known, and the two cases are averaged. `nextSet` is the
 * chance A wins a set started fresh.
 */
export function liveMatchProb({ pA, pB, setsA = 0, setsB = 0, gA = 0, gB = 0, aServes = null, bestOf = 3 }) {
  const need = bestOf === 5 ? 3 : 2;
  const memo = new Map();
  const fresh = (sA, sB, s) => {
    if (sA >= need) return 1;
    if (sB >= need) return 0;
    const k = (sA * 4 + sB) * 2 + (s ? 1 : 0);
    if (memo.has(k)) return memo.get(k);
    const o = setOutcome(pA, pB, 0, 0, s);
    const v = o.aA * fresh(sA + 1, sB, true) + o.aB * fresh(sA + 1, sB, false) + o.bA * fresh(sA, sB + 1, true) + o.bB * fresh(sA, sB + 1, false);
    memo.set(k, v);
    return v;
  };
  const from = (s) => {
    if (setsA >= need) return { match: 1, set: 1 };
    if (setsB >= need) return { match: 0, set: 0 };
    const o = setOutcome(pA, pB, gA, gB, s);
    return { match: o.aA * fresh(setsA + 1, setsB, true) + o.aB * fresh(setsA + 1, setsB, false) + o.bA * fresh(setsA, setsB + 1, true) + o.bB * fresh(setsA, setsB + 1, false), set: o.aA + o.aB };
  };
  const cases = aServes === null ? [from(true), from(false)] : [from(aServes)];
  const mean = (k) => cases.reduce((s, c) => s + c[k], 0) / cases.length;
  const next = [setOutcome(pA, pB, 0, 0, true), setOutcome(pA, pB, 0, 0, false)];
  return { match: mean('match'), set: mean('set'), nextSet: (next[0].aA + next[0].aB + next[1].aA + next[1].aB) / 2 };
}

/**
 * The pair of serve-point chances that puts the model's match chance on
 * a target from a score: the tour's average serve for both, moved apart
 * until the state reads the target. For a match with no pre-match read.
 */
export function serveFromMarket(target, { tour = 'atp', setsA = 0, setsB = 0, gA = 0, gB = 0, bestOf = 3 } = {}) {
  const base = (TOUR_AVG[tour] ?? TOUR_AVG.atp).serve;
  const t = clamp(target, 0.02, 0.98);
  let lo = -0.2; let hi = 0.2;
  for (let i = 0; i < 40; i++) {
    const d = (lo + hi) / 2;
    const p = liveMatchProb({ pA: clamp(base + d, 0.35, 0.9), pB: clamp(base - d, 0.35, 0.9), setsA, setsB, gA, gB, bestOf }).match;
    if (p < t) lo = d; else hi = d;
  }
  const d = (lo + hi) / 2;
  return { pA: clamp(base + d, 0.35, 0.9), pB: clamp(base - d, 0.35, 0.9) };
}

/**
 * The games so far, carried forward from one look at the score to the
 * next: `prev` is {sets, games}, `sets` the score now ([[a, b], ...]).
 * Each game is {s: set index, w: 'a' | 'b', tb?: 1, g?: 1}; `g` marks a
 * game whose place in the order is not known (two or more games landed
 * between looks, or the match was first seen under way), which still
 * counts for whose serve it is but not as a hold or a break. A score
 * that went backwards (a correction) starts the match's record again.
 */
export function advanceTimeline(prev, sets) {
  const old = prev?.sets ?? [];
  let games = [...(prev?.games ?? [])];
  const back = old.some((s, i) => !sets[i] || sets[i][0] < s[0] || sets[i][1] < s[1]);
  const before = back ? [] : old;
  if (back) games = [];
  for (let i = 0; i < sets.length; i++) {
    const [a, b] = sets[i]; const [pa, pb] = before[i] ?? [0, 0];
    const da = a - pa; const db = b - pb;
    if (da + db === 0) continue;
    const tb = (a === 7 && b === 6) || (a === 6 && b === 7);
    if (da + db === 1) { games.push({ s: i, w: da ? 'a' : 'b', ...(tb ? { tb: 1 } : {}) }); continue; }
    for (let k = 0; k < da; k++) games.push({ s: i, w: 'a', g: 1 });
    for (let k = 0; k < db; k++) games.push({ s: i, w: 'b', g: 1 });
    // The last of a block that ended the set in a tiebreak was the tiebreak.
    if (tb) games[games.length - 1] = { ...games[games.length - 1], tb: 1 };
  }
  return { sets: sets.map(([a, b]) => [a, b]), games };
}

/** How much a game counts toward today's form, by how many games ago it was: the last game whole, each one before it a little less. */
export const FORM_DECAY = 0.93;
/** The pre-match serve number stands in as this many service games of evidence. */
export const PRIOR_SERVICE_GAMES = 12;
/** The furthest a match can move a player's serve-point chance off the pre-match one. */
export const MAX_SERVE_SHIFT = 0.05;

/**
 * Who has been serving, from the games in order: the serve passes every
 * game, so there are two orders, and the one with fewer breaks of serve
 * among the games whose order is known is taken. Returns {first: 'a' |
 * 'b' | null, sure, aServesNext, a: {served, held}, b: {served, held},
 * breaks: [{set, by, index}], weighted: {a: {served, held}, b: {...}}}.
 * `first` is null until the two orders differ by a break.
 */
export function serveRead(games) {
  const list = games ?? [];
  const count = (first) => {
    const side = { a: { served: 0, held: 0 }, b: { served: 0, held: 0 } };
    const weighted = { a: { served: 0, held: 0 }, b: { served: 0, held: 0 } };
    const breaks = [];
    list.forEach((gm, i) => {
      if (gm.g || gm.tb) return;
      const server = (i % 2 === 0) === (first === 'a') ? 'a' : 'b';
      const held = gm.w === server;
      const weight = FORM_DECAY ** (list.length - 1 - i);
      side[server].served++; weighted[server].served += weight;
      if (held) { side[server].held++; weighted[server].held += weight; } else breaks.push({ set: gm.s, by: gm.w, index: i });
    });
    return { side, weighted, breaks };
  };
  const asA = count('a'); const asB = count('b');
  const known = list.filter((gm) => !gm.g && !gm.tb).length;
  const diff = asB.breaks.length - asA.breaks.length;
  const first = !known || diff === 0 ? null : diff > 0 ? 'a' : 'b';
  if (!first) return { first: null, sure: false, aServesNext: null, a: { served: 0, held: 0 }, b: { served: 0, held: 0 }, breaks: [], weighted: { a: { served: 0, held: 0 }, b: { served: 0, held: 0 } }, known };
  const pick = first === 'a' ? asA : asB;
  return { first, sure: Math.abs(diff) >= 2, aServesNext: (list.length % 2 === 0) === (first === 'a'), a: pick.side.a, b: pick.side.b, breaks: pick.breaks, weighted: pick.weighted, known };
}

/**
 * Today's serve numbers: each player's pre-match serve-point chance
 * moved by his holds today, the later games weighing more, the
 * pre-match number standing in as PRIOR_SERVICE_GAMES of evidence.
 */
export function updatedServe(pA, pB, read) {
  const move = (p, w) => {
    if (!w || !(w.served > 0)) return p;
    const prior = holdProb(p);
    const hold = clamp((w.held + PRIOR_SERVICE_GAMES * prior) / (w.served + PRIOR_SERVICE_GAMES), 0.2, 0.99);
    return clamp(pointProbFor(hold), p - MAX_SERVE_SHIFT, p + MAX_SERVE_SHIFT);
  };
  return { pA: move(pA, read?.weighted?.a), pB: move(pB, read?.weighted?.b) };
}

/**
 * Momentum in plain numbers: the games each has won of the last eight,
 * the run the last game's winner is on, and the breaks of serve in the
 * set in play. {last: {a, b, of}, streak: {side, n}, setBreaks: {a, b}}.
 */
export function momentumOf(games, read = null) {
  const list = games ?? [];
  const recent = list.slice(-8);
  const last = { a: recent.filter((gm) => gm.w === 'a').length, b: recent.filter((gm) => gm.w === 'b').length, of: recent.length };
  let n = 0; const side = list.at(-1)?.w ?? null;
  // A run only counts through games whose order is known.
  for (let i = list.length - 1; i >= 0 && list[i].w === side && !list[i].g; i--) n++;
  const set = list.at(-1)?.s ?? 0;
  const setBreaks = { a: 0, b: 0 };
  for (const br of read?.breaks ?? []) if (br.set === set) setBreaks[br.by]++;
  return { last, streak: { side, n }, setBreaks };
}

/** The sets each has won and the games of the set in play, from the scoreboard's sets. */
export function scoreState(sets) {
  let setsA = 0; let setsB = 0; let gA = 0; let gB = 0;
  (sets ?? []).forEach(([a, b], i) => {
    if (setDone(a, b)) { if (a > b) setsA++; else setsB++; } else if (i === sets.length - 1) { gA = a; gB = b; }
  });
  const inSet = (sets ?? []).length && !setDone(...sets.at(-1));
  return { setsA, setsB, gA, gB, setNumber: setsA + setsB + 1, inSet: Boolean(inSet), tiebreak: gA === 6 && gB === 6 };
}

const americanOf = (prob) => { const p = clamp(prob, 0.01, 0.99); return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100); };

/**
 * The whole read of one match in play: the chances (the model's from the
 * score and today's serving, the market's from the live price, and the
 * two blended), the serve record, the momentum, and the lines that say
 * why. `serve` is the pre-match pair {pA, pB}; `market` the live
 * de-vigged chance of A, or null.
 */
export function liveRead({ sets, games, serve, market = null, bestOf = 3, modelWeight = 0.5, names = { a: 'A', b: 'B' } }) {
  const state = scoreState(sets);
  const read = serveRead(games);
  const today = updatedServe(serve.pA, serve.pB, read);
  const now = liveMatchProb({ pA: today.pA, pB: today.pB, ...state, aServes: read.aServesNext, bestOf });
  // The same score with the pre-match serving: what the players' form today adds or takes.
  const flat = liveMatchProb({ pA: serve.pA, pB: serve.pB, ...state, aServes: read.aServesNext, bestOf });
  const blended = market != null ? modelWeight * now.match + (1 - modelWeight) * market : now.match;
  const momentum = momentumOf(games, read);
  const why = [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const line = (sets ?? []).map(([a, b]) => `${a}-${b}`).join(' ') || '0-0';
  why.push(`Score ${line}: from here the model gives ${names.a} ${pct(now.match)} to win the match${state.inSet ? ` and ${pct(now.set)} to win the set in play` : ''}.`);
  if (read.first) {
    const holds = (s, n) => `${n} has held ${s.held} of ${s.served} service game${s.served === 1 ? '' : 's'}`;
    why.push(`${holds(read.a, names.a)}; ${holds(read.b, names.b)}${read.sure ? '' : ' (the serve order is read from the games and is not certain yet)'}.`);
    const shift = now.match - flat.match;
    if (Math.abs(shift) >= 0.02) why.push(`Serving today moves ${shift > 0 ? names.a : names.b} up ${Math.round(Math.abs(shift) * 100)} point${Math.round(Math.abs(shift) * 100) === 1 ? '' : 's'} on what the score alone says.`);
  } else why.push('The serve order is not clear from the games seen yet, so the read is from the score and the pre-match serve numbers alone.');
  if (momentum.last.of >= 4) why.push(`Last ${momentum.last.of} games: ${names.a} ${momentum.last.a}, ${names.b} ${momentum.last.b}${momentum.streak.n >= 3 ? `; ${names[momentum.streak.side]} has won the last ${momentum.streak.n}` : ''}.`);
  if (market != null) why.push(`The live price gives ${names.a} ${pct(market)}; the read splits the difference at ${pct(blended)}.`);
  const apart = market != null && Math.abs(now.match - market) > LIVE_MAX_GAP;
  if (apart) why.push(`The model and the live price are more than ${Math.round(LIVE_MAX_GAP * 100)} points apart, so there is no moneyline play: the price may be stale, or the match holds something the score does not show.`);
  return {
    state, serve: { pre: serve, today, first: read.first, sure: read.sure, aServesNext: read.aServesNext, a: read.a, b: read.b, breaks: read.breaks.length },
    model: { match: now.match, set: now.set, nextSet: now.nextSet }, market, prob: blended, apart, momentum, why,
    fair: { match: americanOf(blended), set: americanOf(now.set) },
  };
}

/** The bars a live play has to clear. */
export const LIVE_ML_PROB = 0.6;
export const LIVE_ML_EDGE = 0.05;
export const LIVE_ML_PRICE = [-350, 250];
export const LIVE_SET_PROB = [0.66, 0.9];
export const LIVE_SET_MARGIN = 0.04;
/** The prices a book's set winner is taken at. */
export const LIVE_SET_PRICE = [-450, 250];
export const LIVE_MIN_GAMES = 4;
/**
 * The furthest the model and the live price can sit apart and still make
 * a moneyline play. A live price is sharp: past this, either the price
 * is stale or the match holds something the score does not show (an
 * injury, a medical timeout), and neither is a bet.
 */
export const LIVE_MAX_GAP = 0.2;

/** Units by confidence: the likelier the play, the more units (docs/trends.js suggestedUnits, kept in step). */
export const liveUnits = (prob) => (prob >= 0.8 ? 2 : prob >= 0.7 ? 1.5 : prob >= 0.6 ? 1 : 0.5);

/**
 * The plays a read supports: the moneyline when the blended chance
 * clears the bar, beats the live price by the edge and a book prices it
 * in range; the set in play when one player's chance of it sits in the
 * band (not so short there is no price worth taking). A set has no live
 * price in the feed, so its play names the price to take it at or
 * better. Nothing during a tiebreak, or before enough games are in.
 *
 * `quotes` is {a: [{bookId, book, american, link}], b: [...]}, the live
 * moneyline. Returns [{market: 'live_ml' | 'live_set', side, set?, prob,
 * edge?, american?, bookId?, book?, link?, playable?, units, selection}].
 */
export function livePlays(read, { quotes = { a: [], b: [] }, names = { a: 'A', b: 'B' }, gamesSeen = 0 } = {}) {
  const out = [];
  const { state } = read;
  if (state.tiebreak || gamesSeen < LIVE_MIN_GAMES) return out;
  const side = read.prob >= 0.5 ? 'a' : 'b';
  const prob = side === 'a' ? read.prob : 1 - read.prob;
  const marketSide = read.market == null ? null : side === 'a' ? read.market : 1 - read.market;
  const best = [...(quotes[side] ?? [])].filter((q) => Number.isFinite(q.american) && q.american >= LIVE_ML_PRICE[0] && q.american <= LIVE_ML_PRICE[1]).sort((x, y) => y.american - x.american)[0] ?? null;
  if (best && marketSide != null && !read.apart && prob >= LIVE_ML_PROB && prob - marketSide >= LIVE_ML_EDGE) {
    out.push({ market: 'live_ml', side, prob: Math.round(prob * 1000) / 1000, edge: Math.round((prob - marketSide) * 1000) / 1000, american: best.american, bookId: best.bookId, book: best.book, link: best.link ?? null, units: liveUnits(prob), selection: `${names[side]} to win the match (live)` });
  }
  if (state.inSet && state.gA + state.gB >= 2) {
    const setSide = read.model.set >= 0.5 ? 'a' : 'b';
    const setProb = setSide === 'a' ? read.model.set : 1 - read.model.set;
    if (setProb >= LIVE_SET_PROB[0] && setProb <= LIVE_SET_PROB[1]) {
      out.push({ market: 'live_set', side: setSide, set: state.setNumber, prob: Math.round(setProb * 1000) / 1000, playable: americanOf(setProb - LIVE_SET_MARGIN), units: liveUnits(setProb), selection: `${names[setSide]} to win set ${state.setNumber}` });
    }
  }
  return out;
}
