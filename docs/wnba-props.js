/**
 * WNBA player props: Points + Rebounds + Assists (PRA) and Rebounds+Assists.
 *
 * Pure functions only — mirrors docs/nfl-props.js's shape and the same
 * simplifications: no pregame "resolve the starter" step (whichever player
 * the odds market prices is trusted, matched by name against the boxscore
 * at grading time), settled straight from ESPN's public boxscore (confirmed
 * live: points/rebounds/assists are separate numeric columns, unlike NFL's
 * combined "21/34" string).
 *
 * The spec's original ask also wanted this scoped to "28+ mins projected"
 * starters — dropped by explicit decision (see the conversation that shipped
 * this file): no pregame minutes-projection feed exists anywhere in this
 * codebase or a free equivalent, and a fabricated projection would be worse
 * than no filter at all. This tracks the market without that gate.
 */

import { devig, impliedProb, americanToDecimal, decimalToAmerican } from './engine.js';

export const WNBA_PROP_MARKET_LABELS = {
  player_points_rebounds_assists: 'Points + Rebounds + Assists',
  player_rebounds_assists: 'Rebounds + Assists',
};

function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/**
 * Grade one tracked PRA/Reb+Ast pick against that player's own completed-
 * game boxscore line. `boxscoreRow` is `{ points, rebounds, assists }` (all
 * already-parsed numbers) or `null` if the player never appears in the
 * boxscore — did not play (DNP-CD, inactive, scratched). Mirrors
 * docs/mlb-props.js's gradePitcherProp / docs/nfl-props.js's gradeQbProp
 * contract exactly.
 */
export function gradeWnbaProp(pick, boxscoreRow) {
  if (!boxscoreRow) return voidResult('player did not appear in the final boxscore — did not play');

  const { points, rebounds, assists } = boxscoreRow;
  if (![points, rebounds, assists].every(Number.isFinite)) {
    return voidResult('boxscore stat line was missing or unparseable');
  }

  const actual = pick.marketKey === 'player_points_rebounds_assists'
    ? points + rebounds + assists
    : rebounds + assists;

  if (actual === pick.point) return voidResult('push — landed exactly on the line');
  const won = pick.outcomeName === 'Over' ? actual > pick.point : actual < pick.point;
  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout, actual };
}

/* ---------------------------------------------------------------- */
/* Risk policy — same numbers/reasoning as the other prop modules'          */
/* ---------------------------------------------------------------- */

export const WNBA_PROP_MAX_STAKE_FRACTION = 0.01;
export const WNBA_PROP_MIN_BOOKS = 3;
export const WNBA_PROP_MAX_SPREAD_PCT = 6;
export const WNBA_PROP_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

export function wnbaPropLiquidityBlock(candidate, now = Date.now()) {
  const quotes = candidate?.quotes ?? [];
  if (quotes.length < WNBA_PROP_MIN_BOOKS) {
    return `only ${quotes.length} book${quotes.length === 1 ? '' : 's'} pricing this (need ${WNBA_PROP_MIN_BOOKS})`;
  }
  const probs = quotes.map((q) => (Number.isFinite(q?.decimal) && q.decimal > 1 ? 100 / q.decimal : null)).filter((p) => p !== null);
  if (probs.length >= 2) {
    const spread = Math.max(...probs) - Math.min(...probs);
    if (spread > WNBA_PROP_MAX_SPREAD_PCT) {
      return `books disagree by ${spread.toFixed(1)} probability points (max ${WNBA_PROP_MAX_SPREAD_PCT})`;
    }
  }
  const updatedAt = candidate?.updatedMs;
  if (Number.isFinite(updatedAt) && now - updatedAt > WNBA_PROP_MAX_QUOTE_AGE_MS) {
    return `quote is ${Math.round((now - updatedAt) / 60000)} minutes stale`;
  }
  return null;
}

export function capWnbaPropStake(stakeFraction) {
  return Math.min(stakeFraction, WNBA_PROP_MAX_STAKE_FRACTION);
}

/* ---------------------------------------------------------------- */
/* Candidate discovery                                               */
/* ---------------------------------------------------------------- */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same shape/reasoning as docs/nfl-props.js's buildQbPropCandidates — see that module's header. */
export function buildWnbaPropCandidates(game, bookmakers, { now = Date.now() } = {}) {
  if (!Number.isFinite(game?.commenceMs) || game.commenceMs <= now) return [];

  const pool = new Map();

  for (const book of bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      if (!WNBA_PROP_MARKET_LABELS[market.key]) continue;
      const outcomes = market.outcomes ?? [];

      const pairs = new Map();
      for (const outcome of outcomes) {
        const playerName = outcome.description;
        if (!playerName || outcome.point == null) continue;
        const pairKey = `${normalizeName(playerName)}|${outcome.point}`;
        if (!pairs.has(pairKey)) pairs.set(pairKey, { playerName, point: outcome.point, sides: {} });
        pairs.get(pairKey).sides[outcome.name] = outcome;
      }

      const updatedMs = new Date(market.last_update ?? book.last_update ?? game.commenceMs).getTime();

      for (const { playerName, point, sides } of pairs.values()) {
        const over = sides.Over;
        const under = sides.Under;
        if (!over || !under) continue;

        const { fair, vig } = devig([over.price, under.price]);
        for (const [i, outcome] of [over, under].entries()) {
          const key = `${market.key}|${normalizeName(playerName)}|${point}|${outcome.name}`;
          if (!pool.has(key)) {
            pool.set(key, { marketKey: market.key, point, playerName, outcomeName: outcome.name, quotes: [] });
          }
          pool.get(key).quotes.push({
            book: book.title ?? book.key,
            bookKey: book.key,
            american: outcome.price,
            decimal: americanToDecimal(outcome.price),
            fairProb: fair[i],
            vig,
            updatedMs: Number.isFinite(updatedMs) ? updatedMs : now,
          });
        }
      }
    }
  }

  const candidates = [];
  for (const entry of pool.values()) {
    const { quotes } = entry;
    if (quotes.length < 2) continue;

    const best = quotes.reduce((a, b) => (b.decimal > a.decimal ? b : a));
    const others = quotes.filter((q) => q !== best);
    if (!others.length) continue;

    const consensusProb = median(others.map((q) => q.fairProb));
    const disagreement = stdev(others.map((q) => q.fairProb));
    const ev = consensusProb * (best.decimal - 1) - (1 - consensusProb);
    const avgProb = quotes.reduce((a, q) => a + impliedProb(q.american), 0) / quotes.length;
    const shopGain = avgProb - impliedProb(best.american);

    candidates.push({
      id: `${game.eventId}:${entry.marketKey}:${normalizeName(entry.playerName)}:${entry.point}:${entry.outcomeName}`,
      eventId: game.eventId,
      espnEventId: game.espnEventId,
      sportKey: game.sportKey,
      sportTitle: game.sportTitle,
      commenceMs: game.commenceMs,
      home: game.home,
      away: game.away,
      marketKey: entry.marketKey,
      marketLabel: WNBA_PROP_MARKET_LABELS[entry.marketKey],
      playerName: entry.playerName,
      outcomeName: entry.outcomeName,
      point: entry.point,
      selection: `${entry.playerName} ${entry.outcomeName} ${entry.point} ${entry.marketKey === 'player_points_rebounds_assists' ? 'PRA' : 'Reb+Ast'}`,
      american: best.american,
      decimal: best.decimal,
      book: best.book,
      updatedMs: best.updatedMs,
      bookCount: quotes.length,
      quotes: [...quotes].sort((a, b) => b.decimal - a.decimal).map((q) => ({
        book: q.book, bookKey: q.bookKey, american: q.american, decimal: q.decimal, updatedMs: q.updatedMs,
      })),
      consensusProb,
      fairAmerican: decimalToAmerican(1 / consensusProb),
      ev,
      disagreement,
      shopGain,
    });
  }
  return candidates;
}
