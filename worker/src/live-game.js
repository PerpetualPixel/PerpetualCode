/**
 * The in-game read of a hockey game's lines: moneyline, puck line and
 * total, from the score and the clock. Goals to the whistle are Poisson
 * per team at a rate that blends the league's scoring with the game's own
 * pace; a tie at the end of regulation goes to overtime as a coin flip,
 * and the overtime or shootout goal counts one, the way the books settle
 * (the moneyline and the total include overtime; the puck line settles on
 * the official score, where an overtime win is a one-goal win).
 *
 * Every line on the board is then priced against the model: the book's
 * price de-vigged against its other side gives the chance the book is
 * charging for; the read keeps a line only where the model's chance
 * beats it by MIN_EDGE and the bet pays at the price (positive EV), and
 * ranks what is left by EV. Shown, not tracked, like the slips.
 */
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';

/** League average goals per team per game; the game's own pace pulls on it from a fifth of the way in. */
export const NHL_GOALS_PER_TEAM = 3.05;
const PACE_WEIGHT = 0.35;
const MAX_GOALS = 12;
export const MIN_EDGE = 0.04;
export const READ_PRICE = [-250, 250];
/** The read runs from this far in to this far in: too early there is no pace, too late the books have pulled the lines. */
export const READ_WINDOW = [0.1, 0.95];

export function poisson(lambda, k) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}
const table = (lambda) => { const t = []; let acc = 0; for (let k = 0; k < MAX_GOALS; k++) { t.push(poisson(lambda, k)); acc += t[k]; } t.push(Math.max(0, 1 - acc)); return t; };

/** Goals a team is expected to add to the whistle: the league rate blended with its pace so far, over the time left. */
export function remainingRate(goalsSoFar, elapsed, { base = NHL_GOALS_PER_TEAM, weight = PACE_WEIGHT } = {}) {
  const left = Math.max(0, 1 - elapsed);
  const pace = elapsed >= 0.2 ? Math.min(goalsSoFar / elapsed, base * 2.5) : base;
  return ((1 - weight) * base + weight * pace) * left;
}

/**
 * The outcomes of the rest of the game: every (home goals, away goals)
 * pair the two teams can add, with its chance, read as the final margin
 * and total in regulation. `tie` is a regulation tie, settled in overtime.
 */
export function hockeyOutcomes({ homeGoals, awayGoals, elapsed }) {
  const ph = table(remainingRate(homeGoals, elapsed));
  const pa = table(remainingRate(awayGoals, elapsed));
  const out = [];
  for (let h = 0; h < ph.length; h++) for (let a = 0; a < pa.length; a++) {
    const p = ph[h] * pa[a]; if (p < 1e-12) continue;
    const H = homeGoals + h; const A = awayGoals + a;
    out.push({ p, margin: H - A, total: H + A, tie: H === A });
  }
  return out;
}

/** The chance of each bet from the outcomes: side is 'home' or 'away' for the moneyline and spread, 'over' or 'under' for the total. */
export function chance(outcomes, market, side, point = null) {
  let p = 0;
  for (const o of outcomes) {
    const m = side === 'away' ? -o.margin : o.margin;
    if (market === 'h2h') p += o.tie ? o.p * 0.5 : m > 0 ? o.p : 0;
    else if (market === 'spreads') {
      // A regulation tie is a one-goal game either way after overtime, so the side covers +1.5 or better and never -1.5.
      if (o.tie) p += (point > 1 ? 1 : point > -1 ? 0.5 : 0) * o.p;
      else if (m + point > 0) p += o.p;
    } else if (market === 'totals') {
      const total = o.total + (o.tie ? 1 : 0);
      if (side === 'over' ? total > point : total < point) p += o.p;
    }
  }
  return p;
}

/** The chance the book is charging for at a price, de-vigged against the other side of the same line when the book posts it. */
export const impliedChance = (decimal, otherDecimal = null) => (otherDecimal ? (1 / decimal) / (1 / decimal + 1 / otherDecimal) : 1 / decimal);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (p) => `${Math.round(p * 100)}%`;
const clockLeft = (elapsed) => { const m = Math.max(0, Math.round((1 - elapsed) * 60)); return `${m} min left`; };
const inRange = (x, [lo, hi]) => x >= lo && x <= hi;

/**
 * Every line on the board with an edge: the model's chance against the
 * book's, per book, grouped by selection and ranked by EV. `game` is
 * { home, away } by full name with { homeAbbr, awayAbbr, score, elapsed }.
 */
export function gameReads(payload, game, { minEdge = MIN_EDGE } = {}) {
  const { home, away, homeAbbr, awayAbbr, score = {}, elapsed = 0 } = game;
  if (!home || !away || !inRange(elapsed, READ_WINDOW)) return [];
  const homeGoals = num(score[homeAbbr]) ?? 0; const awayGoals = num(score[awayAbbr]) ?? 0;
  const outcomes = hockeyOutcomes({ homeGoals, awayGoals, elapsed });
  const sideOf = (name) => (String(name).toLowerCase() === String(home).toLowerCase() ? 'home' : String(name).toLowerCase() === String(away).toLowerCase() ? 'away' : String(name).toLowerCase());
  const lead = homeGoals - awayGoals;
  const leader = lead > 0 ? homeAbbr : lead < 0 ? awayAbbr : null;
  const projected = homeGoals + awayGoals + remainingRate(homeGoals, elapsed) + remainingRate(awayGoals, elapsed);
  const groups = new Map();
  for (const b of payload?.bookmakers ?? []) {
    const bookId = bookIdFor(b.key) ?? b.key;
    for (const m of b.markets ?? []) {
      const market = m.key === 'alternate_spreads' ? 'spreads' : m.key === 'alternate_totals' ? 'totals' : m.key;
      if (!['h2h', 'spreads', 'totals'].includes(market)) continue;
      const outcomesOf = m.outcomes ?? [];
      for (const o of outcomesOf) {
        const side = sideOf(o.name);
        if (!['home', 'away', 'over', 'under'].includes(side)) continue;
        if (!Number.isFinite(o.price) || !inRange(o.price, READ_PRICE)) continue;
        const point = market === 'h2h' ? null : num(o.point); if (market !== 'h2h' && point == null) continue;
        const other = outcomesOf.find((x) => x !== o && (market === 'h2h' ? sideOf(x.name) !== side : market === 'spreads' ? sideOf(x.name) !== side && num(x.point) === -point : sideOf(x.name) !== side && num(x.point) === point));
        const dec = americanToDecimal(o.price);
        const model = chance(outcomes, market, side, point);
        const implied = impliedChance(dec, other && Number.isFinite(other.price) ? americanToDecimal(other.price) : null);
        const edge = model - implied;
        const ev = model * (dec - 1) - (1 - model);
        if (edge < minEdge || ev <= 0) continue;
        const team = side === 'home' ? home : side === 'away' ? away : null;
        const abbr = side === 'home' ? homeAbbr : side === 'away' ? awayAbbr : null;
        const key = `${market}:${side}:${point ?? ''}`;
        const selection = market === 'h2h' ? `${team} to win` : market === 'spreads' ? `${team} ${point > 0 ? '+' : ''}${point}` : `${side === 'over' ? 'Over' : 'Under'} ${point} goals`;
        const why = market === 'totals'
          ? `${homeGoals + awayGoals} goals so far, ${projected.toFixed(1)} projected, ${clockLeft(elapsed)}: ${pct(model)} to go ${side}, ${pct(implied)} at the price`
          : `${leader ? `${leader} up ${Math.abs(lead)}` : 'level'}, ${clockLeft(elapsed)}: ${pct(model)} to ${market === 'h2h' ? 'win' : 'cover'}, ${pct(implied)} at the price`;
        if (!groups.has(key)) groups.set(key, { key, market, label: market === 'h2h' ? 'Moneyline' : market === 'spreads' ? 'Puck line' : 'Total', side, team, abbr, point, selection, model, why, lines: [] });
        const g = groups.get(key);
        g.lines.push({ bookId, book: SPORTSBOOKS[bookId]?.name ?? b.key, price: o.price, decimal: dec, implied: Math.round(implied * 1000) / 1000, edge: Math.round(edge * 1000) / 1000, ev: Math.round(ev * 1000) / 1000, link: o.link ?? null });
      }
    }
  }
  const reads = [...groups.values()].map((g) => {
    const lines = g.lines.sort((x, y) => y.ev - x.ev || y.price - x.price);
    return { ...g, model: Math.round(g.model * 1000) / 1000, best: lines[0], lines };
  });
  return reads.sort((x, y) => y.best.ev - x.best.ev).slice(0, 8);
}
