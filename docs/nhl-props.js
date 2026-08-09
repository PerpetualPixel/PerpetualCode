/**
 * NHL player props: Shots on Goal (SOG).
 *
 * Pure functions only — mirrors docs/nfl-props.js / docs/wnba-props.js's
 * shape and simplifications (no pregame starter-resolution step, matched by
 * name against the boxscore at grading time).
 *
 * ── A settlement-shape trap this avoids, found only by checking the real   ──
 * ── response rather than trusting the obvious-looking column label       ──
 * ESPN's NHL boxscore has a column labeled "SOG" — but its machine key is
 * `shootoutGoals`, not shots on goal (confirmed against the team-level
 * summary block, which spells both out: `shotsTotal` labeled "S" = 26 team
 * shots that game, `shootoutGoals` labeled "SOG" = 0). The real shots-on-
 * goal column is the one labeled "S", keyed `shotsTotal`. Settling this
 * market off the "SOG"-labeled column would have graded every shots prop
 * against shootout goals — near-always zero — the kind of silent, wrong-
 * unit bug docs/tennis-tiers.js's games-vs-sets fix exists to warn about,
 * caught here before it ever shipped instead of after.
 *
 * The "1st line/1st PP unit" eligibility filter from the original spec is
 * dropped by explicit decision: line-combination data (who's playing which
 * forward line or power-play unit tonight) isn't available from ESPN's
 * stats API or any other free source wired into this codebase.
 */

import { devig, impliedProb, americanToDecimal, decimalToAmerican } from './engine.js';

export const NHL_PROP_MARKET_LABELS = {
  player_shots_on_goal: 'Shots on Goal',
};

function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/**
 * Grade one tracked SOG pick. `boxscoreRow` is `{ shotsOnGoal }` (already
 * parsed as a number) or `null` if the skater never appears in either
 * team's forwards/defensemen boxscore rows — a healthy scratch, or a
 * goalie mistakenly priced (shouldn't happen, but voids rather than crashes
 * either way).
 */
export function gradeNhlProp(pick, boxscoreRow) {
  if (!boxscoreRow) return voidResult('player did not appear in the final boxscore — did not play');
  const actual = boxscoreRow.shotsOnGoal;
  if (!Number.isFinite(actual)) return voidResult('boxscore stat was missing or unparseable');
  if (actual === pick.point) return voidResult('push — landed exactly on the line');
  const won = pick.outcomeName === 'Over' ? actual > pick.point : actual < pick.point;
  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout, actual };
}

/* ---------------------------------------------------------------- */
/* Risk policy — same numbers/reasoning as the other prop modules'          */
/* ---------------------------------------------------------------- */

export const NHL_PROP_MAX_STAKE_FRACTION = 0.01;
export const NHL_PROP_MIN_BOOKS = 3;
export const NHL_PROP_MAX_SPREAD_PCT = 6;
export const NHL_PROP_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

export function nhlPropLiquidityBlock(candidate, now = Date.now()) {
  const quotes = candidate?.quotes ?? [];
  if (quotes.length < NHL_PROP_MIN_BOOKS) {
    return `only ${quotes.length} book${quotes.length === 1 ? '' : 's'} pricing this (need ${NHL_PROP_MIN_BOOKS})`;
  }
  const probs = quotes.map((q) => (Number.isFinite(q?.decimal) && q.decimal > 1 ? 100 / q.decimal : null)).filter((p) => p !== null);
  if (probs.length >= 2) {
    const spread = Math.max(...probs) - Math.min(...probs);
    if (spread > NHL_PROP_MAX_SPREAD_PCT) {
      return `books disagree by ${spread.toFixed(1)} probability points (max ${NHL_PROP_MAX_SPREAD_PCT})`;
    }
  }
  const updatedAt = candidate?.updatedMs;
  if (Number.isFinite(updatedAt) && now - updatedAt > NHL_PROP_MAX_QUOTE_AGE_MS) {
    return `quote is ${Math.round((now - updatedAt) / 60000)} minutes stale`;
  }
  return null;
}

export function capNhlPropStake(stakeFraction) {
  return Math.min(stakeFraction, NHL_PROP_MAX_STAKE_FRACTION);
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
export function buildNhlPropCandidates(game, bookmakers, { now = Date.now() } = {}) {
  if (!Number.isFinite(game?.commenceMs) || game.commenceMs <= now) return [];

  const pool = new Map();

  for (const book of bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      if (!NHL_PROP_MARKET_LABELS[market.key]) continue;
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
      marketLabel: NHL_PROP_MARKET_LABELS[entry.marketKey],
      playerName: entry.playerName,
      outcomeName: entry.outcomeName,
      point: entry.point,
      selection: `${entry.playerName} ${entry.outcomeName} ${entry.point} SOG`,
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
