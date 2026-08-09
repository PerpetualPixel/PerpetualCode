/**
 * MLB starting-pitcher props: candidate discovery and settlement.
 *
 * Pure functions only — no DOM, no network — same boundary as
 * docs/engine.js and docs/tennis-tiers.js. The two impure pieces this
 * depends on (the per-event odds fetch, and the post-game boxscore fetch)
 * live in worker/src/mlb-props.js and are passed in here as plain data.
 *
 * ── Why pitcher props, specifically ──────────────────────────────────────
 * Verified live against ESPN's public boxscore endpoint before this was
 * written (the same one worker/src/mlb-stats.js's fetchStartingPitchers
 * already calls pregame for probables): the completed-game boxscore reports
 * a pitcher's innings pitched and strikeouts directly, keyed by the same
 * ESPN athlete id the pregame probable carries. That's a real, existing
 * settlement path — unlike NBA/NFL player props, which have no equivalent
 * per-player stat source wired anywhere in this codebase yet.
 *
 * MLB reports innings pitched in its own dotted notation, not decimal
 * thirds: "6.0" is 6 full innings (18 outs), "6.1" is 6 innings + 1 out
 * (19 outs), "6.2" is 6 innings + 2 outs (20 outs). outsFromInnings() below
 * decodes that directly rather than treating the fractional part as a real
 * decimal (6.1 is NOT 6 and 1/3 as a float).
 *
 * ── Why moneyline-style devigging still applies ──────────────────────────
 * The Odds API's player-prop response bundles every player's Over/Under for
 * a stat into one flat outcomes array per book, unlike the team markets
 * docs/engine.js's buildCandidates() reads (where a market's own outcomes
 * ARE the mutually exclusive pair). Here the Over/Under pair for one player
 * has to be picked back out of that flat array before it can be devigged —
 * see poolByBook() below. Once paired, the math is identical to the rest of
 * the app: devig each book's own Over/Under, benchmark the best price
 * against the consensus of the rest, same EV and score formulas from
 * docs/engine.js (scoreCandidate is reused directly, not reimplemented).
 */

import { devig, impliedProb, americanToDecimal, decimalToAmerican } from './engine.js';

export const PROP_MARKET_LABELS = {
  pitcher_outs: 'Pitcher Outs',
  pitcher_strikeouts: 'Pitcher Strikeouts',
};

/* ---------------------------------------------------------------- */
/* Innings-pitched decoding                                          */
/* ---------------------------------------------------------------- */

/**
 * Decode ESPN's boxscore innings-pitched notation into outs recorded.
 * Returns null for anything that isn't the expected "N", "N.1", or "N.2"
 * shape — malformed input should void a pick, never guess.
 */
export function outsFromInnings(ip) {
  const s = String(ip ?? '').trim();
  const m = s.match(/^(\d+)(?:\.(\d))?$/);
  if (!m) return null;
  const wholeInnings = Number(m[1]);
  const extraOuts = m[2] ? Number(m[2]) : 0;
  if (extraOuts > 2) return null; // MLB notation only ever uses .0/.1/.2
  return wholeInnings * 3 + extraOuts;
}

/* ---------------------------------------------------------------- */
/* Settlement                                                         */
/* ---------------------------------------------------------------- */

function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/**
 * Grade one tracked pitcher-prop pick against that pitcher's own completed-
 * game boxscore line.
 *
 * `boxscoreRow` is `{ ip, strikeouts }` read from the athlete's row in the
 * game's final boxscore, or `null` if that pitcher never appears in it at
 * all — the standard signal for a scratch (someone else started) or a fully
 * postponed game. Both void rather than grade: inventing a result for a
 * pitcher who never actually threw a pitch in this game would be exactly
 * the kind of fabricated-result bug docs/learning.js's tennis fix exists to
 * prevent.
 *
 * Returns the same shape docs/learning.js's gradePick does — `{won,payout}`,
 * `{void,reason,payout}`, or `null` (not yet final) — so the worker's
 * grading loop can treat both settlement paths identically.
 */
export function gradePitcherProp(pick, boxscoreRow) {
  if (!boxscoreRow) return voidResult('pitcher did not appear in the final boxscore — scratched or game not played');

  const actual = pick.marketKey === 'pitcher_outs'
    ? outsFromInnings(boxscoreRow.ip)
    : Number(boxscoreRow.strikeouts);

  if (!Number.isFinite(actual)) return voidResult('boxscore stat was missing or unparseable');
  if (actual === pick.point) return voidResult('push — landed exactly on the line');

  const won = pick.outcomeName === 'Over' ? actual > pick.point : actual < pick.point;
  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout, actual };
}

/* ---------------------------------------------------------------- */
/* Risk policy                                                       */
/* ---------------------------------------------------------------- */

/**
 * Below full quarter-Kelly's 5% ceiling but above the thin-tennis-tier caps
 * (docs/tennis-tiers.js) — these are professionally modeled, actively
 * multi-booked markets, not a Challenger event with three books guessing.
 * The cap exists for the risk mainline team markets don't carry: an early
 * exit (injury, blowout pull, a short bullpen game) swings a pitcher prop
 * far harder than one batter's plate appearance swings a team spread.
 */
export const PROP_MAX_STAKE_FRACTION = 0.01;

export const PROP_MIN_BOOKS = 3;
export const PROP_MAX_SPREAD_PCT = 6; // best vs worst implied probability, in points — wider than tennis's 4.5, since prop books disagree more even when each is honest
export const PROP_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

/**
 * Same purpose as docs/tennis-tiers.js's tierLiquidityBlock: catch a thin,
 * disagreeing, or stale price before it's mistaken for a real edge. Returns
 * null when the candidate is fine, or a short reason string otherwise.
 */
export function propLiquidityBlock(candidate, now = Date.now()) {
  const quotes = candidate?.quotes ?? [];
  if (quotes.length < PROP_MIN_BOOKS) {
    return `only ${quotes.length} book${quotes.length === 1 ? '' : 's'} pricing this (need ${PROP_MIN_BOOKS})`;
  }

  const probs = quotes.map((q) => (Number.isFinite(q?.decimal) && q.decimal > 1 ? 100 / q.decimal : null)).filter((p) => p !== null);
  if (probs.length >= 2) {
    const spread = Math.max(...probs) - Math.min(...probs);
    if (spread > PROP_MAX_SPREAD_PCT) {
      return `books disagree by ${spread.toFixed(1)} probability points (max ${PROP_MAX_SPREAD_PCT})`;
    }
  }

  const updatedAt = candidate?.updatedMs;
  if (Number.isFinite(updatedAt) && now - updatedAt > PROP_MAX_QUOTE_AGE_MS) {
    return `quote is ${Math.round((now - updatedAt) / 60000)} minutes stale`;
  }

  return null;
}

export function capPropStake(stakeFraction) {
  return Math.min(stakeFraction, PROP_MAX_STAKE_FRACTION);
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

/** Case/punctuation/diacritic-insensitive name compare — "Luis Garcia Jr." vs "Luis García Jr" should still match. */
function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Build one game's pitcher-prop candidates from its raw per-event odds
 * response (The Odds API's `/events/{id}/odds` shape: bookmakers[].markets[]
 * where one market's outcomes bundle EVERY priced player's Over and Under
 * together) and the two known starters for that game.
 *
 * `game`: { eventId, sportKey, sportTitle, home, away, commenceMs,
 *           espnEventId, pitchers: [{ playerId, name }, ...] }
 * `bookmakers`: the raw array from the per-event odds response.
 *
 * A prop outcome whose player name doesn't confidently match one of the two
 * known starters is dropped, not guessed at — grading a stat against the
 * wrong player would be a correctness failure, not a missed opportunity.
 */
export function buildPitcherPropCandidates(game, bookmakers, { now = Date.now() } = {}) {
  if (!Number.isFinite(game?.commenceMs) || game.commenceMs <= now) return [];
  const pitchers = game.pitchers ?? [];
  if (!pitchers.length) return [];

  const byNormalizedName = new Map(pitchers.map((p) => [normalizeName(p.name), p]));
  const matchPitcher = (description) => byNormalizedName.get(normalizeName(description)) ?? null;

  // pool key -> { marketKey, point, pitcher, side, quotes: [...] }
  const pool = new Map();

  for (const book of bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      if (!PROP_MARKET_LABELS[market.key]) continue;
      const outcomes = market.outcomes ?? [];

      // Group this one book's flat outcome list into per-player Over/Under
      // pairs before devigging — see the module header. Keyed by player+
      // point since a book occasionally offers more than one line per
      // player (rare, but two different lines must not be pooled together).
      const pairs = new Map();
      for (const outcome of outcomes) {
        const pitcher = matchPitcher(outcome.description);
        if (!pitcher || outcome.point == null) continue;
        const pairKey = `${pitcher.playerId}|${outcome.point}`;
        if (!pairs.has(pairKey)) pairs.set(pairKey, { pitcher, point: outcome.point, sides: {} });
        pairs.get(pairKey).sides[outcome.name] = outcome;
      }

      const updatedMs = new Date(market.last_update ?? book.last_update ?? game.commenceMs).getTime();

      for (const { pitcher, point, sides } of pairs.values()) {
        const over = sides.Over;
        const under = sides.Under;
        if (!over || !under) continue; // need both sides from this book to devig honestly

        const { fair, vig } = devig([over.price, under.price]);
        for (const [i, outcome] of [over, under].entries()) {
          const key = `${market.key}|${pitcher.playerId}|${point}|${outcome.name}`;
          if (!pool.has(key)) {
            pool.set(key, { marketKey: market.key, point, pitcher, outcomeName: outcome.name, quotes: [] });
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
    if (quotes.length < 2) continue; // devig needs the rest of the market to benchmark against

    const best = quotes.reduce((a, b) => (b.decimal > a.decimal ? b : a));
    const others = quotes.filter((q) => q !== best);
    if (!others.length) continue;

    const consensusProb = median(others.map((q) => q.fairProb));
    const disagreement = stdev(others.map((q) => q.fairProb));
    const ev = consensusProb * (best.decimal - 1) - (1 - consensusProb);
    const avgProb = quotes.reduce((a, q) => a + impliedProb(q.american), 0) / quotes.length;
    const shopGain = avgProb - impliedProb(best.american);

    candidates.push({
      id: `${game.eventId}:${entry.marketKey}:${entry.pitcher.playerId}:${entry.point}:${entry.outcomeName}`,
      eventId: game.eventId,
      espnEventId: game.espnEventId,
      sportKey: game.sportKey,
      sportTitle: game.sportTitle,
      commenceMs: game.commenceMs,
      home: game.home,
      away: game.away,
      marketKey: entry.marketKey,
      marketLabel: PROP_MARKET_LABELS[entry.marketKey],
      playerId: entry.pitcher.playerId,
      playerName: entry.pitcher.name,
      outcomeName: entry.outcomeName,
      point: entry.point,
      selection: `${entry.pitcher.name} ${entry.outcomeName} ${entry.point} ${entry.marketKey === 'pitcher_outs' ? 'outs' : 'Ks'}`,
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
