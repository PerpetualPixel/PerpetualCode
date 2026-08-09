/**
 * NFL starting-QB props: Pass Completions and Pass Attempts.
 *
 * Pure functions only — no DOM, no network — same boundary as
 * docs/mlb-props.js, which this mirrors closely. The two impure pieces (the
 * per-event odds fetch, the post-game boxscore fetch) live in
 * worker/src/nfl-props.js.
 *
 * ── Why this one, and not the other props still pending research ────────
 * Verified live against ESPN's public boxscore (same technique used for
 * MLB): the passing stat line is reported as one combined string, e.g.
 * "21/34" — completions/attempts — trivially split, no new data source
 * needed beyond what mlb-props.js already proved reachable from this
 * Worker. Unlike MLB, no separate pregame "resolve the starter" step is
 * needed here: whichever player The Odds API's own market prices IS the
 * subject, matched by name against the boxscore at grading time — NFL
 * starting QBs are known well ahead of a book posting a prop on one, unlike
 * a probable pitcher.
 */

import { devig, impliedProb, americanToDecimal, decimalToAmerican } from './engine.js';

export const NFL_PROP_MARKET_LABELS = {
  player_pass_completions: 'Pass Completions',
  player_pass_attempts: 'Pass Attempts',
};

/** "21/34" -> { completions: 21, attempts: 34 }. Returns null for anything that doesn't cleanly parse — a QB who didn't play has no line at all, not a malformed one, so this should rarely fire; when it does, fail closed rather than guess. */
export function parsePassingLine(value) {
  const m = String(value ?? '').trim().match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  return { completions: Number(m[1]), attempts: Number(m[2]) };
}

function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/**
 * Grade one tracked QB-prop pick against that QB's own completed-game
 * boxscore line. `boxscoreRow` is `{ passingLine: "21/34" }` or `null` if
 * the named player never appears in the passing boxscore at all — the
 * signal for "didn't play" (benched, injured pregame, inactive) rather than
 * a real 0-attempt outing. Mirrors docs/mlb-props.js's gradePitcherProp
 * contract exactly: `{won,payout}` | `{void,reason,payout}` | never a
 * fabricated result for someone who didn't take a snap.
 */
export function gradeQbProp(pick, boxscoreRow) {
  if (!boxscoreRow) return voidResult('player did not appear in the final passing boxscore — did not play');

  const parsed = parsePassingLine(boxscoreRow.passingLine);
  if (!parsed) return voidResult('boxscore passing line was missing or unparseable');

  const actual = pick.marketKey === 'player_pass_attempts' ? parsed.attempts : parsed.completions;
  if (actual === pick.point) return voidResult('push — landed exactly on the line');

  const won = pick.outcomeName === 'Over' ? actual > pick.point : actual < pick.point;
  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout, actual };
}

/* ---------------------------------------------------------------- */
/* Risk policy — same numbers and reasoning as docs/mlb-props.js's own      */
/* (duplicated rather than imported cross-sport, matching this codebase's   */
/* established convention of small, parallel modules — see                 */
/* full-slate-tracking.js's own header comment on that choice)             */
/* ---------------------------------------------------------------- */

export const NFL_PROP_MAX_STAKE_FRACTION = 0.01;
export const NFL_PROP_MIN_BOOKS = 3;
export const NFL_PROP_MAX_SPREAD_PCT = 6;
export const NFL_PROP_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

export function nflPropLiquidityBlock(candidate, now = Date.now()) {
  const quotes = candidate?.quotes ?? [];
  if (quotes.length < NFL_PROP_MIN_BOOKS) {
    return `only ${quotes.length} book${quotes.length === 1 ? '' : 's'} pricing this (need ${NFL_PROP_MIN_BOOKS})`;
  }
  const probs = quotes.map((q) => (Number.isFinite(q?.decimal) && q.decimal > 1 ? 100 / q.decimal : null)).filter((p) => p !== null);
  if (probs.length >= 2) {
    const spread = Math.max(...probs) - Math.min(...probs);
    if (spread > NFL_PROP_MAX_SPREAD_PCT) {
      return `books disagree by ${spread.toFixed(1)} probability points (max ${NFL_PROP_MAX_SPREAD_PCT})`;
    }
  }
  const updatedAt = candidate?.updatedMs;
  if (Number.isFinite(updatedAt) && now - updatedAt > NFL_PROP_MAX_QUOTE_AGE_MS) {
    return `quote is ${Math.round((now - updatedAt) / 60000)} minutes stale`;
  }
  return null;
}

export function capNflPropStake(stakeFraction) {
  return Math.min(stakeFraction, NFL_PROP_MAX_STAKE_FRACTION);
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

/** Exported for worker/src/nfl-props.js's own grading-time name match against the boxscore — kept as one shared copy within this sport's own pure/impure pair, unlike the deliberate cross-sport duplication elsewhere. */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Build one game's QB-prop candidates from its raw per-event odds response
 * (bookmakers[].markets[], one flat outcomes array per book bundling every
 * priced player's Over/Under together — same shape as MLB's player props,
 * see docs/mlb-props.js's own header for why that needs re-pairing before
 * devigging). No known-starters allowlist is passed in here (unlike MLB):
 * whichever player name the market itself prices is trusted as the subject
 * and carried straight through to grading, where the boxscore match (or
 * non-match, voiding) is the safety net against a bad name.
 */
export function buildQbPropCandidates(game, bookmakers, { now = Date.now() } = {}) {
  if (!Number.isFinite(game?.commenceMs) || game.commenceMs <= now) return [];

  const pool = new Map();

  for (const book of bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      if (!NFL_PROP_MARKET_LABELS[market.key]) continue;
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
      marketLabel: NFL_PROP_MARKET_LABELS[entry.marketKey],
      playerName: entry.playerName,
      outcomeName: entry.outcomeName,
      point: entry.point,
      selection: `${entry.playerName} ${entry.outcomeName} ${entry.point} ${entry.marketKey === 'player_pass_attempts' ? 'Att' : 'Comp'}`,
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
