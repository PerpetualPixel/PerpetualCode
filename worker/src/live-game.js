/**
 * The in-game read of a game's lines from the score and the clock, for
 * the sports where goals come one at a time: hockey and soccer.
 *
 * Goals to the whistle are Poisson per team at a rate that blends the
 * sport's scoring with the game's own pace, over the time left. Hockey
 * sends a regulation tie to overtime as a coin flip, with the overtime or
 * shootout goal counting one, the way the books settle (the moneyline and
 * the total include overtime; the puck line settles on the official
 * score, where an overtime win is a one-goal win). Soccer ends at the
 * whistle: the draw is its own side of the moneyline, and the total,
 * both teams to score and draw no bet read off the same outcomes.
 *
 * Every line on the board is then priced against the model: the book's
 * price de-vigged against the other side(s) of the same line gives the
 * chance the book is charging for; the read keeps a line only where the
 * model's chance beats it by MIN_EDGE and the bet pays at the price
 * (positive EV), and ranks what is left by EV. Shown, not tracked, like
 * the slips.
 */
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';

/** League average goals per team per game. Hockey 2025-26 ran near 3.0; the big European leagues and the Champions League near 1.4 to 1.5. */
export const NHL_GOALS_PER_TEAM = 3.05;
export const SOCCER_GOALS_PER_TEAM = 1.45;
const SPORT = {
  nhl: { base: NHL_GOALS_PER_TEAM, max: 12, overtime: true, markets: ['h2h', 'spreads', 'totals'] },
  soccer: { base: SOCCER_GOALS_PER_TEAM, max: 9, overtime: false, markets: ['h2h', 'totals', 'btts', 'draw_no_bet'] },
};
const PACE_WEIGHT = 0.35;
export const MIN_EDGE = 0.04;
export const READ_PRICE = [-250, 250];
/** The read runs from this far in to this far in: too early there is no pace, too late the books have pulled the lines. */
export const READ_WINDOW = [0.1, 0.95];

export function poisson(lambda, k) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}
const table = (lambda, max) => { const t = []; let acc = 0; for (let k = 0; k < max; k++) { t.push(poisson(lambda, k)); acc += t[k]; } t.push(Math.max(0, 1 - acc)); return t; };

/** Goals a team is expected to add to the whistle: the sport's rate blended with its pace so far, over the time left. */
export function remainingRate(goalsSoFar, elapsed, { base = NHL_GOALS_PER_TEAM, weight = PACE_WEIGHT } = {}) {
  const left = Math.max(0, 1 - elapsed);
  const pace = elapsed >= 0.2 ? Math.min(goalsSoFar / elapsed, base * 2.5) : base;
  return ((1 - weight) * base + weight * pace) * left;
}

/**
 * The outcomes of the rest of the game: every (home goals, away goals)
 * pair the two teams can add, with its chance, read as the final margin
 * and total at the whistle. `tie` is level at the whistle: overtime in
 * hockey, the draw in soccer.
 */
export function hockeyOutcomes({ homeGoals, awayGoals, elapsed, sport = 'nhl' }) {
  const { base, max } = SPORT[sport] ?? SPORT.nhl;
  const ph = table(remainingRate(homeGoals, elapsed, { base }), max);
  const pa = table(remainingRate(awayGoals, elapsed, { base }), max);
  const out = [];
  for (let h = 0; h < ph.length; h++) for (let a = 0; a < pa.length; a++) {
    const p = ph[h] * pa[a]; if (p < 1e-12) continue;
    const H = homeGoals + h; const A = awayGoals + a;
    out.push({ p, margin: H - A, total: H + A, tie: H === A, home: H, away: A });
  }
  return out;
}
export const gameOutcomes = hockeyOutcomes;

/**
 * The chance of each bet from the outcomes: side is 'home', 'away' or
 * (soccer) 'draw' for the moneyline, 'home' or 'away' for the spread and
 * draw no bet, 'over' or 'under' for the total, 'yes' or 'no' for both
 * teams to score. `overtime` says a tie goes to a coin flip (hockey).
 */
export function chance(outcomes, market, side, point = null, { overtime = true } = {}) {
  let p = 0;
  let home = 0; let away = 0;
  for (const o of outcomes) {
    const m = side === 'away' ? -o.margin : o.margin;
    if (market === 'h2h') {
      if (side === 'draw') { if (o.tie) p += o.p; }
      else if (o.tie) { if (overtime) p += o.p * 0.5; }
      else if (m > 0) p += o.p;
    } else if (market === 'spreads') {
      // Hockey: a regulation tie is a one-goal game either way after overtime, so the side covers +1.5 or better and never -1.5.
      if (o.tie) p += (overtime ? (point > 1 ? 1 : point > -1 ? 0.5 : 0) : (point > 0 ? 1 : 0)) * o.p;
      else if (m + point > 0) p += o.p;
    } else if (market === 'totals') {
      const total = o.total + (o.tie && overtime ? 1 : 0);
      if (side === 'over' ? total > point : total < point) p += o.p;
    } else if (market === 'btts') {
      const both = o.home > 0 && o.away > 0;
      if (side === 'yes' ? both : !both) p += o.p;
    } else if (market === 'draw_no_bet') {
      if (o.margin > 0) home += o.p; else if (o.margin < 0) away += o.p;
    }
  }
  if (market === 'draw_no_bet') { const live = home + away; return live ? (side === 'home' ? home : away) / live : 0; }
  return p;
}

/** The chance the book is charging for at a price, de-vigged against the other side(s) of the same line when the book posts them. */
export const impliedChance = (decimal, others = []) => {
  const list = Array.isArray(others) ? others.filter(Boolean) : others ? [others] : [];
  if (!list.length) return 1 / decimal;
  return (1 / decimal) / (1 / decimal + list.reduce((s, d) => s + 1 / d, 0));
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (p) => `${Math.round(p * 100)}%`;
const inRange = (x, [lo, hi]) => x >= lo && x <= hi;
const LABEL = { h2h: 'Moneyline', spreads: 'Puck line', totals: 'Total', btts: 'Both teams to score', draw_no_bet: 'Draw no bet' };

/**
 * Every line on the board with an edge: the model's chance against the
 * book's, per book, grouped by selection and ranked by EV. `game` is
 * { home, away } by full name with { homeAbbr, awayAbbr, score, elapsed,
 * sport ('nhl' or 'soccer'), minutes (the game's length, for the clock) }.
 */
export function gameReads(payload, game, { minEdge = MIN_EDGE } = {}) {
  const { home, away, homeAbbr, awayAbbr, score = {}, elapsed = 0, sport = 'nhl', minutes = sport === 'soccer' ? 90 : 60 } = game;
  const spec = SPORT[sport] ?? SPORT.nhl;
  if (!home || !away || !inRange(elapsed, READ_WINDOW)) return [];
  const homeGoals = num(score[homeAbbr]) ?? 0; const awayGoals = num(score[awayAbbr]) ?? 0;
  const outcomes = hockeyOutcomes({ homeGoals, awayGoals, elapsed, sport });
  const opts = { overtime: spec.overtime };
  const sideOf = (name) => { const n = String(name ?? '').toLowerCase(); return n === String(home).toLowerCase() ? 'home' : n === String(away).toLowerCase() ? 'away' : n; };
  const lead = homeGoals - awayGoals;
  const leader = lead > 0 ? homeAbbr : lead < 0 ? awayAbbr : null;
  const clockLeft = `${Math.max(0, Math.round((1 - elapsed) * minutes))} min left`;
  const projected = homeGoals + awayGoals + remainingRate(homeGoals, elapsed, { base: spec.base }) + remainingRate(awayGoals, elapsed, { base: spec.base });
  const groups = new Map();
  for (const b of payload?.bookmakers ?? []) {
    const bookId = bookIdFor(b.key) ?? b.key;
    for (const m of b.markets ?? []) {
      const market = m.key === 'alternate_spreads' ? 'spreads' : m.key === 'alternate_totals' ? 'totals' : m.key;
      if (!spec.markets.includes(market)) continue;
      const outcomesOf = m.outcomes ?? [];
      for (const o of outcomesOf) {
        const side = sideOf(o.name);
        if (!['home', 'away', 'draw', 'over', 'under', 'yes', 'no'].includes(side)) continue;
        if (market === 'h2h' && side === 'draw' && spec.overtime) continue;
        if (!Number.isFinite(o.price) || !inRange(o.price, READ_PRICE)) continue;
        const point = market === 'spreads' || market === 'totals' ? num(o.point) : null;
        if ((market === 'spreads' || market === 'totals') && point == null) continue;
        // The other side(s) of this line at this book: the two other results of a three-way moneyline, the mirrored spread, the same total the other way, no against yes.
        const others = outcomesOf.filter((x) => x !== o && sideOf(x.name) !== side && Number.isFinite(x.price) && (
          market === 'spreads' ? num(x.point) === -point : market === 'totals' ? num(x.point) === point : true));
        const dec = americanToDecimal(o.price);
        const model = chance(outcomes, market, side, point, opts);
        const implied = impliedChance(dec, others.map((x) => americanToDecimal(x.price)));
        const edge = model - implied;
        const ev = model * (dec - 1) - (1 - model);
        if (edge < minEdge || ev <= 0) continue;
        const team = side === 'home' ? home : side === 'away' ? away : null;
        const abbr = side === 'home' ? homeAbbr : side === 'away' ? awayAbbr : null;
        const key = `${market}:${side}:${point ?? ''}`;
        const selection = market === 'h2h' ? (side === 'draw' ? 'Draw' : `${team} to win`)
          : market === 'spreads' ? `${team} ${point > 0 ? '+' : ''}${point}`
          : market === 'totals' ? `${side === 'over' ? 'Over' : 'Under'} ${point} goals`
          : market === 'btts' ? `Both teams to score: ${side === 'yes' ? 'yes' : 'no'}`
          : `${team} draw no bet`;
        const state = leader ? `${leader} up ${Math.abs(lead)}` : 'level';
        const why = market === 'totals' || market === 'btts'
          ? `${homeGoals + awayGoals} goal${homeGoals + awayGoals === 1 ? '' : 's'} so far, ${projected.toFixed(1)} projected, ${clockLeft}: ${pct(model)} ${market === 'btts' ? (side === 'yes' ? 'both score' : 'one side blanks') : `to go ${side}`}, ${pct(implied)} at the price`
          : `${state}, ${clockLeft}: ${pct(model)} ${market === 'h2h' ? (side === 'draw' ? 'to end level' : 'to win') : market === 'spreads' ? 'to cover' : 'to win with the draw void'}, ${pct(implied)} at the price`;
        if (!groups.has(key)) groups.set(key, { key, market, label: LABEL[market], side, team, abbr, point, selection, model, why, lines: [] });
        groups.get(key).lines.push({ bookId, book: SPORTSBOOKS[bookId]?.name ?? b.key, price: o.price, decimal: dec, implied: Math.round(implied * 1000) / 1000, edge: Math.round(edge * 1000) / 1000, ev: Math.round(ev * 1000) / 1000, link: o.link ?? null });
      }
    }
  }
  const reads = [...groups.values()].map((g) => {
    const lines = g.lines.sort((x, y) => y.ev - x.ev || y.price - x.price);
    return { ...g, model: Math.round(g.model * 1000) / 1000, best: lines[0], lines };
  });
  return reads.sort((x, y) => y.best.ev - x.best.ev).slice(0, 8);
}
