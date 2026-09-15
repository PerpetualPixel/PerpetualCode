/**
 * Pixel Pick — pick engine.
 *
 * Pure functions only: no DOM, no network. Everything here is deterministic
 * given (events, rng), which is what makes it testable in test/engine.test.mjs.
 *
 * The model is the one a sharp bettor actually runs:
 *   1. De-vig each book's prices to get that book's honest opinion.
 *   2. Build a consensus fair probability from the market, EXCLUDING the book
 *      offering the best price (otherwise the outlier contaminates its own
 *      benchmark and every bet looks like +EV).
 *   3. Grade the best available price against that consensus.
 * Everything else — liquidity, agreement between books, line-shopping gain,
 * freshness — is a confidence weight on top of that edge.
 */

/**
 * NFL preseason, identified by SPORT KEY rather than by any field on the
 * event. The Odds API keys preseason as its own sport
 * (`americanfootball_nfl_preseason`) and its events carry no `season_type`
 * field to read — an earlier version of this checked `event.season_type`
 * and was silently dead code, since analyze() builds candidates from an
 * explicit field list that never carried such a field anyway.
 *
 * Matched by pattern, not by a literal string: the key only exists while
 * preseason is actually live, and the exact suffix is discovered from the
 * free /sports catalogue rather than hardcoded here (see
 * populateDynamicGroups in docs/app.js and fullSlateSportKeys in
 * worker/src/tracking.js — the same "discover, don't hardcode" approach
 * tennis's per-tournament keys already use). If the key never appears, this
 * simply never matches and nothing changes.
 */
export function isNflPreseasonKey(sportKey) {
  return typeof sportKey === 'string'
    && sportKey.startsWith('americanfootball_nfl')
    && sportKey.includes('preseason');
}

/**
 * The candidate/event form of isNflPreseasonKey. Reads both shapes because
 * both reach this: analyzed candidates carry `sportKey`, raw feed events
 * carry `sport_key`.
 *
 * Preseason belongs on the Full Slate as part of the raw record, but never
 * in Pixel's Picks or Play of the Day: starters play a series or two, roster
 * churn is total, and the result says almost nothing about either team —
 * exactly the high-variance, low-information game those two curated surfaces
 * exist to avoid.
 */
export function isNflPreseason(candidate) {
  return isNflPreseasonKey(candidate?.sportKey ?? candidate?.sport_key);
}

export const RULES = {
  // Hard price band from the spec.
  MIN_AMERICAN: -250,
  MAX_AMERICAN: 150,
  // A leg priced -150 or better can stand on its own.
  SINGLE_FLOOR: -150,
  // Anything from -250 to -151 must be paired to drag the price toward +100.
  PAIR_TARGET_AMERICAN: 100,
  // Below this many books pricing the exact same number, consensus is noise.
  MIN_BOOKS: 3,
  // Nothing below this grade is shown at all. The board is meant to be the best
  // available, not a ranked list of everything — a 40 is not a pick, it's a coin
  // flip with extra steps.
  MIN_SCORE: 50,
  // scoreCandidate()'s composite grade can clear MIN_SCORE on liquidity,
  // agreement, and freshness alone even with almost no real edge — a 51%
  // win read on a -117 line scores fine on "how clean is this number" while
  // still being a -EV bet once the vig is paid. Pixel Picks opts into this
  // as a hard floor (see topPicks' minEv) so scoring well isn't enough on
  // its own; the price has to actually be worth taking.
  //
  // Raised from 1.5% to 2% (2026-09-15) alongside the power de-vig and the
  // sharp anchor below: a 1.5% read against a soft-book median was inside
  // the noise of the estimate itself, and the graded record showed it.
  MIN_EV_PCT: 0.02,
  // Below this, suggestedStake()'s quarter-Kelly fraction is a rounding
  // error, not a bet — the $1.48-on-$1000 pattern this exists to cut off.
  MIN_KELLY_FRACTION: 0.0025,
};

/**
 * A second, TIGHTER price ceiling for the low-variance markets added on top
 * of this app's original team-market board (player props, MLS's BTTS/
 * double-chance) — does not touch RULES.MIN_AMERICAN (-250), which stays
 * "the hard price band from the spec" for h2h/spreads/totals/
 * alternate_spreads exactly as before. Heavy juice on a bet whose entire
 * pitch is being low-variance defeats the point of it: -140 or worse is
 * paying too much to lay off risk on a market that's supposed to already be
 * the safer play.
 */
export const LOW_VARIANCE_MAX_AMERICAN = -135;
export const LOW_VARIANCE_MARKETS = new Set([
  'btts', 'double_chance',
  'pitcher_outs', 'pitcher_strikeouts',
  'player_pass_completions', 'player_pass_attempts',
  'player_points_rebounds_assists', 'player_rebounds_assists',
  'player_shots_on_goal',
]);

/** True for every candidate EXCEPT a low-variance-market one priced worse than LOW_VARIANCE_MAX_AMERICAN. */
export function clearsMaxJuice(candidate) {
  if (!LOW_VARIANCE_MARKETS.has(candidate.marketKey)) return true;
  return candidate.american >= LOW_VARIANCE_MAX_AMERICAN;
}

const MARKET_LABELS = {
  h2h: 'Moneyline',
  spreads: 'Spread',
  totals: 'Total',
  // NOT a set-spread market, despite the name this app first shipped it
  // under. The Odds API's own docs describe alternate_spreads as "all
  // available point spread outcomes" — the same game-margin axis as the
  // featured 'spreads' market, just a denser ladder. Confirmed the hard way:
  // a real match's ladder went to ±9.5, which is impossible as a sets margin
  // in any tennis format (max is 2 in best-of-3, 3 in best-of-5). There is no
  // genuine sets-won market in this feed. Still a real, useful addition on
  // its own terms — more game-handicap points than the featured board offers
  // — just not what "sets" would imply.
  alternate_spreads: 'Alt Spread',
  // Soccer-only, MLS's own low-variance alternative to a 3-way moneyline
  // (see docs/soccer-markets.js) — both settle straight from the same free
  // final score every other market here already uses, no new data source.
  btts: 'Both Teams to Score',
  double_chance: 'Double Chance',
};

/* ------------------------------------------------------------------ */
/* Sportsbooks                                                         */
/* ------------------------------------------------------------------ */

/**
 * Books we can surface a button for. `keys` are the bookmaker keys The Odds API
 * actually returns — some books are keyed by their legacy owner (Caesars still
 * comes back as `williamhill_us`), so the mapping is explicit rather than
 * assumed.
 */
export const SPORTSBOOKS = {
  fanduel:    { name: 'FanDuel',    color: '#1493ff', url: 'https://sportsbook.fanduel.com/',    keys: ['fanduel'] },
  draftkings: { name: 'DraftKings', color: '#53d337', url: 'https://sportsbook.draftkings.com/', keys: ['draftkings'] },
  betmgm:     { name: 'BetMGM',     color: '#d4af37', url: 'https://sports.betmgm.com/',          keys: ['betmgm'] },
  bet365:     { name: 'bet365',     color: '#1f9e77', url: 'https://www.bet365.com/',             keys: ['bet365'] },
  fanatics:   { name: 'Fanatics',   color: '#e0454f', url: 'https://sportsbook.fanatics.com/',    keys: ['fanatics'] },
  hardrock:   { name: 'Hard Rock',  color: '#9b6ef3', url: 'https://app.hardrock.bet/',           keys: ['hardrockbet', 'hardrock'] },
  kalshi:     { name: 'Kalshi',     color: '#00d09c', url: 'https://kalshi.com/',                 keys: ['kalshi'] },
  caesars:    { name: 'Caesars',    color: '#c8aa6e', url: 'https://sportsbook.caesars.com/',     keys: ['williamhill_us', 'caesars'] },
  betrivers:  { name: 'BetRivers',  color: '#2b7fd4', url: 'https://betrivers.com/',              keys: ['betrivers'] },
  espnbet:    { name: 'ESPN BET',   color: '#ff2e4d', url: 'https://espnbet.com/',                keys: ['espnbet'] },
};

/** Pre-selected on first run; the user can change this in the UI. */
export const DEFAULT_BOOKS = [
  'fanduel', 'draftkings', 'betmgm', 'bet365', 'kalshi', 'hardrock', 'fanatics',
];

const BOOK_BY_API_KEY = new Map();
for (const [id, meta] of Object.entries(SPORTSBOOKS)) {
  for (const key of meta.keys) BOOK_BY_API_KEY.set(key, id);
}

/** Map a raw Odds API bookmaker key to a registry id, or null if we don't list it. */
export function bookIdFor(apiKey) {
  return BOOK_BY_API_KEY.get(String(apiKey ?? '').toLowerCase()) ?? null;
}

/**
 * Sharp reference books: price-makers whose de-vigged line is the best free
 * estimate of a game's true probability that exists. They are the ANCHOR of
 * the consensus, never a bet — Pinnacle does not take US customers, and
 * its price is the benchmark the rest of the market is graded against.
 *
 * Why this exists: the consensus used to be the median of the soft US books
 * with the best-priced one removed. Soft books copy each other and lag the
 * sharp market by minutes to hours, so "one book hangs a better number than
 * the median of the others" very often meant "one book has moved toward
 * where Pinnacle already is and the rest have not" — a bet AGAINST the
 * sharp read, dressed as an edge. Grading the outlier against Pinnacle
 * instead asks the right question: is this price better than the best
 * estimate of the truth, not better than the slowest books on the board.
 * This is the standard positive-EV method (a soft book's price against a
 * sharp de-vigged line), and it is what the graded record was missing.
 *
 * The worker's odds fetch pulls these separately (worker/src/odds.js's
 * sharp-quote merge) so they arrive in the same `bookmakers[]` list every
 * other quote does; buildCandidates recognises them by key.
 */
export const SHARP_BOOK_KEYS = new Set([
  'pinnacle',
  // The exchanges: a back price on Betfair or Matchbook is set by the
  // market itself, and in the tracked record they showed up as the "best
  // price" on 118 Full Slate picks a US reader could never have taken.
  // Reference, not bet, same as Pinnacle.
  'betfair_ex_eu', 'betfair_ex_uk', 'betfair_ex_au', 'matchbook',
]);

export function isSharpBook(bookKey) {
  return SHARP_BOOK_KEYS.has(String(bookKey ?? '').toLowerCase());
}

/**
 * How much of the consensus the sharp anchor carries when one is present;
 * the soft-book median supplies the rest. Not 1.0, because a single sharp
 * quote can itself be stale for a few minutes and the soft median is a real,
 * if noisier, second read — and not lower, because the whole point is that
 * the sharp line is the estimate worth trusting.
 */
export const SHARP_ANCHOR_WEIGHT = 0.7;

/**
 * Best quote per registry book for one candidate. A book missing from the
 * result isn't pricing this exact line, which is what greys its button out.
 */
export function bookOffers(candidate) {
  const byBook = new Map();
  for (const quote of candidate?.quotes ?? []) {
    const id = bookIdFor(quote.bookKey);
    if (!id) continue;
    const existing = byBook.get(id);
    if (!existing || quote.decimal > existing.decimal) byBook.set(id, quote);
  }
  return byBook;
}

/* ------------------------------------------------------------------ */
/* Odds conversion                                                     */
/* ------------------------------------------------------------------ */

export function americanToDecimal(american) {
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

export function decimalToAmerican(decimal) {
  // Decimal 2.0 is the +100 / -100 pivot; round away from it consistently.
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : Math.round(-100 / (decimal - 1));
}

export function impliedProb(american) {
  return 1 / americanToDecimal(american);
}

export function formatAmerican(american) {
  return american > 0 ? `+${american}` : `${american}`;
}

/** Parlay two or more legs by multiplying decimal prices. */
export function combineLegs(americanOdds) {
  const decimal = americanOdds.reduce((acc, a) => acc * americanToDecimal(a), 1);
  return { decimal, american: decimalToAmerican(decimal) };
}

/* ------------------------------------------------------------------ */
/* De-vigging                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which de-vig method strips a book's margin. 'power' is the default;
 * 'multiplicative' is kept for comparison and for degenerate inputs.
 *
 * Why power and not the proportional rescale this app shipped with: the
 * multiplicative method spreads the vig evenly across every outcome, and
 * books do not charge it that way. The favourite-longshot bias is one of the
 * best-replicated findings in betting markets — longshots are overpriced
 * relative to their true chance — so a proportional rescale systematically
 * OVERSTATES the underdog's fair probability and understates the
 * favourite's. On a -300/+240 line that is about 1.5 points handed to the
 * dog, which at +240 is roughly 5% of phantom expected value: more than
 * three times this app's entire EV floor, on the side of the market this
 * engine's outlier hunt already lands on most often. That is the structural
 * reason the graded record showed +120-and-longer underdogs winning 29.6%
 * with negative closing-line value.
 *
 * The power method raises every implied probability to the same exponent k
 * (k > 1 when the book holds a margin) and solves for the k that makes them
 * sum to 1. Because p^k shrinks small probabilities proportionally more
 * than large ones, it takes the margin mostly out of the longshot — the
 * shape the empirical bias has. It is the method Pinnacle's own writing on
 * de-vigging recommends over the proportional one, and it needs no market
 * assumptions beyond "the book is one consistent price-maker."
 */
export const DEVIG_METHOD = 'power';

/**
 * Strip the bookmaker's margin from a set of mutually exclusive prices.
 *
 * Raw implied probabilities sum to more than 1 — that surplus is the vig.
 * `fair` sums to exactly 1 under either method; `vig` is the overround the
 * book was charging (0.045 => 4.5%). See DEVIG_METHOD for why the power
 * method is the default.
 */
export function devig(americanOdds, { method = DEVIG_METHOD } = {}) {
  const raw = americanOdds.map(impliedProb);
  const overround = raw.reduce((a, b) => a + b, 0);
  const vig = overround - 1;
  const multiplicative = () => ({ fair: raw.map((p) => p / overround), vig });

  // The power solve needs at least two real probabilities strictly inside
  // (0, 1); anything else (a one-sided market, a malformed price) falls back
  // to the proportional rescale rather than to a solver that cannot converge.
  if (method !== 'power' || raw.length < 2 || !(overround > 0)
    || raw.some((p) => !(p > 0 && p < 1))) {
    return multiplicative();
  }

  // f(k) = Σ p_i^k − 1 is strictly decreasing in k on (0, ∞), f(1) = vig,
  // so the root sits above 1 for a positive hold and below it for a
  // negative one (an arbitrage across books never arrives here, since each
  // book is de-vigged on its own, but a stale one-book market can). Bisect:
  // 200 halvings of a [0.05, 20] bracket is far past double precision, and
  // the loop exits early once the bracket collapses.
  const f = (k) => raw.reduce((sum, p) => sum + p ** k, 0) - 1;
  let lo = 0.05;
  let hi = 20;
  if (!(f(lo) > 0 && f(hi) < 0)) return multiplicative();
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const powered = raw.map((p) => p ** k);
  // Renormalise the last few ulps so the outcomes sum to exactly 1 — every
  // consumer (two-way consensus sums, EV) is entitled to that invariant.
  const total = powered.reduce((a, b) => a + b, 0);
  return { fair: powered.map((p) => p / total), vig };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function norm(x, lo, hi) {
  return clamp01((x - lo) / (hi - lo));
}

/** General-purpose clamp, exported so qualitative.js's -1..1 signal can use the exact same clamping as scoreCandidate() does when it applies that signal. */
export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/* ------------------------------------------------------------------ */
/* Candidate extraction                                                */
/* ------------------------------------------------------------------ */

/**
 * An "outcome key" identifies the same bet across books. The point matters:
 * Celtics -3 and Celtics -3.5 are different bets and must not be pooled.
 */
function outcomeKey(marketKey, outcome) {
  const point = outcome.point ?? '';
  return `${marketKey}|${outcome.name}|${point}`;
}

function describe(event, marketKey, outcome) {
  const { name, point } = outcome;
  if (marketKey === 'h2h') return `${name} to win`;
  if (marketKey === 'spreads') {
    return `${name} ${point > 0 ? `+${point}` : point}`;
  }
  if (marketKey === 'alternate_spreads') {
    // Same game-margin axis as 'spreads', just a wider ladder — labelled
    // distinctly only so it's visibly a different market key on the board,
    // not because it's a different kind of bet.
    return `${name} ${point > 0 ? `+${point}` : point} (alt)`;
  }
  if (marketKey === 'totals') {
    return `${name} ${point} (${event.away_team} @ ${event.home_team})`;
  }
  return `${name}${point != null ? ` ${point}` : ''}`;
}

/**
 * Flatten the API payload into one candidate per distinct bet, carrying the
 * best available price and the market context needed to grade it.
 */
export function buildCandidates(events, { now = Date.now() } = {}) {
  const candidates = [];

  for (const event of events ?? []) {
    const commenceMs = new Date(event.commence_time).getTime();
    // Already started or unparseable — not actionable.
    if (!Number.isFinite(commenceMs) || commenceMs <= now) continue;

    // key -> { quotes: [...] } gathered across every book.
    const pool = new Map();

    for (const book of event.bookmakers ?? []) {
      for (const market of book.markets ?? []) {
        if (!MARKET_LABELS[market.key]) continue;
        const outcomes = market.outcomes ?? [];
        // De-vig needs the full mutually exclusive set from this one book.
        if (outcomes.length < 2) continue;

        const { fair, vig } = devig(outcomes.map((o) => o.price));
        const updatedMs = new Date(
          market.last_update ?? book.last_update ?? event.commence_time,
        ).getTime();

        outcomes.forEach((outcome, i) => {
          const key = outcomeKey(market.key, outcome);
          if (!pool.has(key)) {
            pool.set(key, { marketKey: market.key, outcome, quotes: [] });
          }
          pool.get(key).quotes.push({
            book: book.title ?? book.key,
            bookKey: book.key,
            american: outcome.price,
            decimal: americanToDecimal(outcome.price),
            fairProb: fair[i],
            vig,
            updatedMs: Number.isFinite(updatedMs) ? updatedMs : now,
            // Deep link straight to the bet slip. Only present on The Odds API's
            // paid tiers (includeLinks); null on free, where we fall back to the
            // book's front door.
            link: outcome.link ?? market.link ?? book.link ?? null,
          });
        });
      }
    }

    for (const [key, entry] of pool) {
      const { quotes } = entry;
      // MMA markets (especially PFL) are often thin with fewer books — require
      // only 1 book minimum, while other sports require the standard 3.
      const isMmaMarket = event.sport_key === 'mma_mixed_martial_arts';
      const minBooks = isMmaMarket ? 1 : RULES.MIN_BOOKS;
      // Sharp reference quotes (see SHARP_BOOK_KEYS) anchor the consensus and
      // are never the bet; everything else is a soft, bettable price.
      const sharp = quotes.filter((q) => isSharpBook(q.bookKey));
      const soft = quotes.filter((q) => !isSharpBook(q.bookKey));
      if (soft.length < minBooks) continue;

      // Best price = highest decimal payout among books the user can actually
      // bet at: the registry (SPORTSBOOKS) when any of them prices the line,
      // else any soft book (thin MMA cards, a book the registry doesn't list
      // yet). The tracked record grades at this price, so it has to be a
      // price a reader could have taken — an offshore outlier is not that,
      // and an outlier from a sharper offshore book is more often the RIGHT
      // number than a mispriced one, which made the soft median look wrong
      // in exactly the wrong direction.
      const registry = soft.filter((q) => bookIdFor(q.bookKey));
      const bettable = registry.length ? registry : soft;
      const best = bettable.reduce((a, b) => (b.decimal > a.decimal ? b : a));
      // Whether that best price is one the reader can take (a registry
      // book). The curated boards refuse to post a pick that isn't: in the
      // live record (2026-08-08 to 09-15) Pixel's Picks priced at a registry
      // book went 24-19 for +24.7% ROI while those priced at an offshore or
      // EU book went 35-42 for -10% and those at a sharp book 6-8 for -25%,
      // and the edge-vs-consensus read only predicted results at registry
      // prices at all. A pick nobody can bet is not a pick; it is a record
      // of a number.
      const isBettable = registry.length > 0;

      // Benchmark against the REST of the market, so the outlier we're about to
      // bet doesn't get to vote on whether it's a good bet.
      //
      // Unless it's the only book pricing the side at all — which the MMA
      // minBooks=1 exception above deliberately allows, and which leaves
      // `others` empty. median([]) is NaN, and that NaN propagated straight
      // through consensusProb into the slate row as a literal "NaN%" next to
      // the fighter's name (confirmed live on thinly-priced MMA cards:
      // Richie Lewis, Rasul Magomedov, Sidney Outlaw). The lone book's own
      // de-vigged number is the only market read that exists for that side,
      // so it stands in as the consensus. It cannot manufacture an edge:
      // when the benchmark and the bet are the same price, EV reduces to
      // 1/overround − 1, which is always negative — a single-book side still
      // fails the EV floor exactly as it did while NaN, it just displays an
      // honest probability instead of a broken one.
      const others = soft.filter((q) => q !== best);
      const benchmark = others.length ? others : soft;
      const marketProb = median(benchmark.map((q) => q.fairProb));
      // With a sharp anchor on the board, the consensus is mostly its
      // de-vigged line (SHARP_ANCHOR_WEIGHT), with the soft median as the
      // remainder; without one, the soft median stands alone exactly as it
      // always has. `anchor` records which, so the tracked record can
      // measure the two regimes separately.
      const sharpProb = sharp.length ? median(sharp.map((q) => q.fairProb)) : null;
      const consensusProb = sharpProb != null
        ? SHARP_ANCHOR_WEIGHT * sharpProb + (1 - SHARP_ANCHOR_WEIGHT) * marketProb
        : marketProb;
      const anchor = sharpProb != null ? 'sharp' : 'market';
      // Still measured across `others` only: one book cannot disagree with
      // itself, and stdev([]) is already 0 — the same "no measurable
      // disagreement" a perfectly aligned multi-book market reports.
      const disagreement = stdev(others.map((q) => q.fairProb));

      // Expected value per $1 staked, at the best price, under consensus.
      const ev = consensusProb * (best.decimal - 1) - (1 - consensusProb);

      // What line shopping alone bought us, in probability terms.
      const avgProb =
        soft.reduce((a, q) => a + impliedProb(q.american), 0) / soft.length;
      const shopGain = avgProb - impliedProb(best.american);

      candidates.push({
        id: `${event.id}:${key}`,
        eventId: event.id,
        sportKey: event.sport_key,
        sportTitle: event.sport_title,
        commenceMs,
        home: event.home_team,
        away: event.away_team,
        // MMA-only card enrichment (see worker/src/odds.js's enrichMmaEvents)
        // — carried through to the Full Slate tracked-pick record
        // (worker/src/tracking.js's pickRecordFrom) so a fight's card name
        // survives even after its odds/market (and this field along with
        // it) disappear from the feed, which for MMA happens the moment it
        // starts. undefined on every non-MMA event.
        ufc_event: event.ufc_event,
        marketKey: entry.marketKey,
        marketLabel: MARKET_LABELS[entry.marketKey],
        // The outcome's own name and point straight from the API (a team
        // name or "Over"/"Under"; the spread/total number or null for a
        // moneyline) — kept separately from `selection` (which already has
        // the point folded into display text) so a consumer can match a
        // candidate back to a specific side of a market, or read its raw
        // number, without parsing that display string.
        outcomeName: entry.outcome.name,
        point: entry.outcome.point ?? null,
        selection: describe(event, entry.marketKey, entry.outcome),
        american: best.american,
        decimal: best.decimal,
        book: best.book,
        bookKey: best.bookKey,
        bettable: isBettable,
        updatedMs: best.updatedMs,
        bookCount: soft.length,
        // Every book on this exact line, best price first — this is what the
        // per-book buttons render from.
        quotes: [...quotes]
          .sort((a, b) => b.decimal - a.decimal)
          .map((q) => ({
            book: q.book,
            bookKey: q.bookKey,
            american: q.american,
            decimal: q.decimal,
            updatedMs: q.updatedMs,
            link: q.link,
            // A reference quote, shown for what it is: not a price to take.
            sharp: isSharpBook(q.bookKey),
          })),
        consensusProb,
        // 'sharp' when a SHARP_BOOK_KEYS quote anchored consensusProb, else
        // 'market'. sharpProb/marketProb are the two inputs, kept so the
        // tracked record can compare the regimes; marketProb is what the
        // consensus WOULD have been under the old soft-median-only rule.
        anchor,
        sharpProb,
        marketProb,
        fairAmerican: decimalToAmerican(1 / consensusProb),
        ev,
        disagreement,
        shopGain,
        medianVig: median(quotes.map((q) => q.vig)),
      });
    }
  }

  return candidates;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

// Max points (of the 0-100 grade) a fully one-sided qualitative signal (see
// docs/qualitative.js) can swing a candidate's score, either direction.
// norm(c.ev, -0.03, 0.06) below means a fully-confident candidate earns
// roughly 11 score-points per 1pp of EV, so an 8-point swing is worth well
// under 1pp of EV — enough to flip a genuinely close price call but far
// short of overturning a real edge. Tunable; sanity-check against real slates.
export const QUALITATIVE = { MAX_SWING: 8 };

/**
 * How the confidence factors combine into the multiplier on the edge — see
 * scoreCandidate. CONFIDENCE_FLOOR is what a candidate with NO supporting
 * confidence keeps of its edge score; the rest is earned. Weights sum to 1.
 */
export const SCORE_CONFIDENCE = {
  FLOOR: 0.55,
  WEIGHTS: { liquidity: 0.35, agreement: 0.25, shopping: 0.15, freshness: 0.10, anchor: 0.15 },
};

/**
 * Score penalty for long-shot candidates — sized from this app's own graded
 * record, not theory. The 30-day window that motivated it: +120-and-longer
 * underdogs were 57% of all graded picks (54 of 95) and won 16/54 (29.6%)
 * with negative closing-line value, while near-pickem prices (-119 to +119)
 * went 17/27 with +0.97pts CLV. The cause is structural: the edge component
 * hunts the one book hanging an outlier price against consensus, and in a
 * two-outcome market that outlier almost always lives on the LESS likely
 * side — so a pure-price board systematically over-fills with long shots,
 * each individually "+EV," collectively a sub-third win rate. The tennis
 * form gate (docs/qualitative.js) closed this hole for tennis by demanding
 * real evidence behind an upset call; this is the sport-agnostic
 * counterpart for everywhere no such evidence source exists.
 *
 * Shape: zero penalty at or above START win probability, growing linearly
 * to MAX_DROP at FULL. Deliberately one-sided — a penalty on unlikely
 * winners, never a bonus for heavy favorites (the record shows near-pickem
 * is the sharp band, not heavy chalk; rewarding chalk would just replace
 * one structural tilt with another). START sits below the ~0.47-0.53 zone
 * where spreads/totals live by construction, so those markets are
 * untouched; a +120 moneyline (~0.44) grazes it, a +150 (~0.39) loses
 * about 5 points, a +200 (~0.31) nearly the full 12 — enough that a long
 * shot has to carry a genuinely large, clean edge to clear MIN_SCORE at
 * all, not merely an outlier price.
 */
export const UNDERDOG_PROB_PENALTY = { START: 0.45, FULL: 0.30, MAX_DROP: 12 };

/**
 * Composite 0–100 grade. Edge dominates; everything else is confidence that
 * the edge is real rather than an artifact of a thin or stale market.
 *
 * Structurally: score = 100 · edge · (FLOOR + (1 − FLOOR) · confidence),
 * minus the long-shot penalty, plus the qualitative swing. The confidence
 * factors MULTIPLY the edge; they never add to it. This app shipped with an
 * additive blend (45% edge, 55% liquidity/agreement/shopping/freshness),
 * under which a bet with ZERO expected value and a tidy, liquid, fresh
 * number scored about 70 — twenty points clear of the floor — and the
 * boards that ranked by score kept choosing the cleanest number over the
 * most profitable one. "How clean is this number" is a reason to trust an
 * edge, not a substitute for having one: a zero-EV candidate now scores at
 * most 33 whatever its market quality, and a real edge is worth more when
 * the market around it is deep, tight, fresh and sharp-anchored.
 *
 * `qualitative` is an optional -1..1 signal (recent form / head-to-head /
 * injuries — see docs/qualitative.js) applied as a small, capped swing on
 * top of the price-only score, never folded into the weighted average
 * above: averaging would need a 0 (no data) to land at the average's
 * midpoint alongside genuinely neutral results, silently bumping every
 * candidate with no qualitative data at all. Applied additively instead,
 * "no data" and "computed neutral" both contribute exactly 0 — every
 * existing caller that doesn't pass `qualitative` gets byte-for-byte the
 * same score this function has always produced.
 */
export function scoreCandidate(c, { now = Date.now(), qualitative = 0 } = {}) {
  const hoursOut = (c.commenceMs - now) / 3.6e6;
  const hoursStale = (now - c.updatedMs) / 3.6e6;

  const parts = {
    // -3% to +6% EV spans terrible to genuinely strong.
    edge: norm(c.ev, -0.03, 0.06),
    // More books pricing the same number = a consensus worth trusting.
    liquidity: norm(c.bookCount, RULES.MIN_BOOKS, 10),
    // Tight agreement elsewhere makes an outlier price meaningful.
    agreement: 1 - norm(c.disagreement, 0.005, 0.05),
    // Pure line-shopping gain vs the field.
    shopping: norm(c.shopGain, 0, 0.04),
    // Prefer lines quoted recently, on games close enough to be priced sharply.
    freshness: (1 - norm(hoursStale, 0.5, 12)) * (1 - norm(hoursOut, 24, 168)),
    // A consensus anchored to a sharp book (see SHARP_BOOK_KEYS) is a far
    // better estimate of the truth than a soft-book median; the edge it
    // implies deserves more trust. 0 when no anchor was available.
    anchor: c.anchor === 'sharp' ? 1 : 0,
    // Recent form / head-to-head / injuries — see docs/qualitative.js. 0
    // when there's no usable data for this candidate.
    qualitative: clamp(qualitative, -1, 1),
  };

  const w = SCORE_CONFIDENCE.WEIGHTS;
  parts.confidence =
    w.liquidity * parts.liquidity +
    w.agreement * parts.agreement +
    w.shopping * parts.shopping +
    w.freshness * parts.freshness +
    w.anchor * parts.anchor;

  const priceScore =
    100 * parts.edge * (SCORE_CONFIDENCE.FLOOR + (1 - SCORE_CONFIDENCE.FLOOR) * parts.confidence);

  // Long-shot penalty (see UNDERDOG_PROB_PENALTY above) — subtracted from
  // the composite rather than folded into the weighted average, same
  // reasoning as the qualitative swing: a candidate with no consensusProb
  // (never the case for analyze()'s own output, but this function is also
  // called on re-scores) contributes exactly 0, not a phantom mid-value.
  const probPenalty = Number.isFinite(c.consensusProb)
    ? UNDERDOG_PROB_PENALTY.MAX_DROP *
      norm(
        UNDERDOG_PROB_PENALTY.START - c.consensusProb,
        0,
        UNDERDOG_PROB_PENALTY.START - UNDERDOG_PROB_PENALTY.FULL,
      )
    : 0;

  const score = clamp(priceScore - probPenalty + QUALITATIVE.MAX_SWING * parts.qualitative, 0, 100);

  return { score, parts };
}

/**
 * The price bullet — one line covering value against the market.
 *
 * Deliberately singular. Everything else on the card comes from insights.js,
 * which reads actual form, head-to-head and injury data; four bullets of odds
 * arithmetic was three bullets of restating the same edge.
 */
/** How the card names its benchmark: the sharp anchor when one set it, else the soft-book consensus. */
function consensusLabel(c) {
  return c.anchor === 'sharp'
    ? 'The sharp market\'s no-vig line (Pinnacle-anchored)'
    : 'The market\'s own no-vig consensus';
}

export function explain(c) {
  const evPct = (c.ev * 100).toFixed(1);

  const value =
    c.ev >= 0.005
      ? `${consensusLabel(c)} makes this a ${(c.consensusProb * 100).toFixed(1)}% shot, fair value ${formatAmerican(c.fairAmerican)}. You're getting ${formatAmerican(c.american)} at ${c.book}, worth about ${evPct}% per dollar.`
      : `Consensus fair value is ${formatAmerican(c.fairAmerican)} and the best price is ${formatAmerican(c.american)} at ${c.book}, priced close to fair (${evPct}% per dollar), so it's here on market quality rather than a pricing mistake.`;

  const context =
    c.disagreement < 0.015
      ? `${c.bookCount} books are on this exact number and the rest are tightly clustered (±${(c.disagreement * 100).toFixed(1)}%), which is what makes one book hanging a better price meaningful rather than noisy.`
      : `${c.bookCount} books are on this number but they disagree by ±${(c.disagreement * 100).toFixed(1)}%, so the edge is real but softer, a smaller-stake spot.`;

  return [`${value} ${context}`];
}

/**
 * The extensive version of explain(), for a pick card's "More Info" panel —
 * every real signal scoreCandidate() actually weighs, each its own sentence,
 * rather than the compact card's single deliberately-terse bullet.
 * Verbalizes two numbers that are already computed for every candidate but
 * never stated anywhere on the compact card: the line-shopping gain
 * (shopGain) and how fresh the quote is relative to kickoff — both real
 * inputs to the grade, not new analysis invented for this tier.
 */
export function explainExtensive(c, { now = Date.now() } = {}) {
  const evPct = (c.ev * 100).toFixed(1);
  const shopPct = (c.shopGain * 100).toFixed(1);
  const hoursStale = (now - c.updatedMs) / 3.6e6;
  const hoursOut = (c.commenceMs - now) / 3.6e6;

  const bullets = [];

  const anchorNote = c.anchor === 'sharp'
    ? ' Anchored to the sharp market (Pinnacle), with the soft-book median as a second read.'
    : '';
  bullets.push(
    c.ev >= 0.005
      ? `No-vig consensus: ${(c.consensusProb * 100).toFixed(1)}% to win, which prices out to a fair value of ${formatAmerican(c.fairAmerican)}.${anchorNote} The best available price is ${formatAmerican(c.american)} at ${c.book}, a gap worth about ${evPct}% of expected value per dollar staked.`
      : `No-vig consensus: ${(c.consensusProb * 100).toFixed(1)}% to win, fair value ${formatAmerican(c.fairAmerican)}.${anchorNote} The best price, ${formatAmerican(c.american)} at ${c.book}, sits close to that fair number (${evPct}% per dollar); this pick is here on market quality and agreement, not a mispriced number.`,
  );

  bullets.push(
    c.disagreement < 0.015
      ? `${c.bookCount} books quote this exact line, clustered within ±${(c.disagreement * 100).toFixed(1)}% of each other, a tight consensus, which is what makes the one book paying more than the rest meaningful instead of noise.`
      : `${c.bookCount} books quote this line but disagree by ±${(c.disagreement * 100).toFixed(1)}%, a wider spread than a tight market shows; the edge is real but softer, and sized accordingly.`,
  );

  if (c.shopGain > 0.001) {
    bullets.push(
      `Line shopping alone is worth about ${shopPct}pp here: the average price across every book quoting this line implies a shorter number than the ${formatAmerican(c.american)} actually available at ${c.book}. Taking the field average instead of the best price would have given back real edge.`,
    );
  }

  bullets.push(
    hoursStale < 1
      ? `This price was last updated under an hour ago, ${hoursOut.toFixed(0)} hours before kickoff, a live, current number, not a stale one carried over from an earlier board.`
      : `This price was last updated ${hoursStale.toFixed(0)} hours ago, ${hoursOut.toFixed(0)} hours before kickoff. ${hoursOut < 24 ? 'Still close enough to game time to trust.' : 'Worth a recheck closer to kickoff; lines move, and this one has room to before it does.'}`,
  );

  return bullets;
}

/* ------------------------------------------------------------------ */
/* Slate construction                                                  */
/* ------------------------------------------------------------------ */

const inBand = (a) => a >= RULES.MIN_AMERICAN && a <= RULES.MAX_AMERICAN;
const canStandAlone = (a) => a >= RULES.SINGLE_FLOOR && a <= RULES.MAX_AMERICAN;
const needsPartner = (a) => a >= RULES.MIN_AMERICAN && a < RULES.SINGLE_FLOOR;

/* ------------------------------------------------------------------ */
/* Confidence colour                                                   */
/* ------------------------------------------------------------------ */

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;

  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return rgb.map((v) => Math.round((v + m) * 255));
}

/**
 * Confidence colour for a grade, amber at `floor` through to green at 100.
 * Interpolated around the hue wheel rather than straight through RGB — a
 * linear RGB blend from amber to green passes through a muddy olive, whereas
 * amber -> yellow -> lime -> green reads as one continuous ramp. Nothing here
 * goes red: anything that bad never reaches the board.
 *
 * `floor` defaults to RULES.MIN_SCORE but the UI's confidence slider can move
 * it — the ramp is always anchored to whatever floor is actually in effect,
 * not the fixed default, so amber still means "just cleared the bar" even
 * when that bar has been dragged down to 20.
 */
export function confidenceColor(score, floor = RULES.MIN_SCORE) {
  const t = clamp01((score - floor) / (100 - floor));
  const [r, g, b] = hslToRgb(
    43 + (142 - 43) * t,   // amber hue -> green hue
    (96 + (69 - 96) * t) / 100,
    (56 + (58 - 56) * t) / 100,
  );
  return `rgb(${r}, ${g}, ${b})`;
}

/* ------------------------------------------------------------------ */
/* Contradictions                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two legs contradict when they're the same market on the same game — one side
 * winning requires the other to lose, so showing both is the board arguing with
 * itself. Different markets on the same game are fine: a team can lose outright
 * and still cover, and a total is independent of who wins.
 */
export function contradicts(a, b) {
  return a.eventId === b.eventId && a.marketKey === b.marketKey;
}

/** Share of the qualifying pool this grade beats, 0–100. */
function percentileOf(score, scores) {
  if (!scores.length) return 0;
  return (scores.filter((s) => s <= score).length / scores.length) * 100;
}

/**
 * Weighted sample without replacement. Higher-scored candidates surface more
 * often, but the pool still turns over between taps so the user sees a genuinely
 * new set rather than the same top two forever.
 */
function weightedPick(pool, rng) {
  const weights = pool.map((c) => Math.pow(Math.max(c.score, 1), 3));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return pool.length - 1;
}

/**
 * For a leg priced -250..-151, find the partner that drags the combined price
 * closest to +100. Partners must come from a different game — two legs of the
 * same event are correlated, and a parlay price assumes they are not.
 */
function findPartner(anchor, pool, usedLegs = []) {
  const eligible = pool.filter(
    (c) =>
      c.eventId !== anchor.eventId &&
      inBand(c.american) &&
      // A partner must not argue with anything already on the board. Without
      // this, pick #1 can take one side of a game and pick #2 can quietly pull
      // the other side in as its partner leg.
      !usedLegs.some((leg) => contradicts(leg, c)),
  );
  if (!eligible.length) return null;

  let best = null;
  for (const partner of eligible) {
    const combined = combineLegs([anchor.american, partner.american]);
    // How close the parlay lands to the +100 target.
    const proximity =
      1 - norm(Math.abs(combined.american - RULES.PAIR_TARGET_AMERICAN), 0, 150);
    // Balance hitting the target against the partner being a good bet itself.
    const rank = 0.6 * proximity + 0.4 * (partner.score / 100);
    if (!best || rank > best.rank) best = { partner, combined, rank };
  }
  return best;
}

/**
 * Build one displayed pick from an anchor candidate: either a straight bet, or
 * a two-leg combo when the anchor's price requires a partner.
 */
function buildPick(anchor, pool, usedLegs = []) {
  if (canStandAlone(anchor.american)) {
    return {
      type: 'single',
      legs: [anchor],
      american: anchor.american,
      score: anchor.score,
    };
  }

  const paired = findPartner(anchor, pool, usedLegs);
  if (!paired) return null; // No legal way to show this one — drop it.

  return {
    type: 'combo',
    legs: [anchor, paired.partner],
    american: paired.combined.american,
    score: (anchor.score + paired.partner.score) / 2,
    // Why the pairing exists, in the spec's own terms.
    pairReason: `${formatAmerican(anchor.american)} is shorter than -150, so it's paired to bring the ticket to ${formatAmerican(paired.combined.american)}, closer to even money.`,
  };
}

/**
 * A "bankroll builder": two or three moneyline favourites from different
 * games, stacked until the TICKET pays plus money.
 *
 * The shape asked for directly (2026-09-02): favourites are individually
 * likely but pay little, so legs are added until the combined price clears
 * +100 and the ticket pays more than it risks. Legs are taken safest-first
 * (highest consensus win probability), so the ticket reaches plus money on
 * the fewest, likeliest legs rather than on longer prices.
 *
 * Honest about what this is: stacking favourites does NOT reduce risk. Each
 * leg must land, so a 2-leg ticket of two ~67% favourites cashes ~45% of the
 * time and needs ~42% to break even at +138 — a thinner edge than either leg
 * alone, with the vig paid twice. It converts "wins often, pays little" into
 * "wins under half the time, pays more". That is a deliberate product
 * choice, recorded here so the next reader doesn't mistake it for a claim
 * that parlays are safer than their legs.
 *
 * Returns null rather than a bad ticket: fewer than two legs, or three legs
 * that still can't reach plus money, means no bankroll builder exists for
 * this anchor and the caller keeps whatever it had.
 */
export function buildBankrollBuilder(anchor, pool, {
  minAmerican = RULES.PAIR_TARGET_AMERICAN,
  // The ticket still answers to its board's own price ceiling. Without this a
  // "bankroll builder" could stack its way to +779 and be a longshot parlay
  // wearing the name — which is exactly what happened the first time this ran
  // against the existing board tests, and why they exist.
  maxAmerican = Infinity,
  maxLegs = 3,
  isEligible = () => true,
} = {}) {
  if (!anchor || !isEligible(anchor)) return null;

  // Safest first: a leg's consensus probability is the market's own read on
  // how likely it is, which is exactly the axis "safer" should mean here.
  // Falling back to the price itself keeps a candidate that never carried a
  // consensus from sorting to the bottom by accident.
  const safety = (c) => (Number.isFinite(c.consensusProb) ? c.consensusProb : impliedProb(c.american));
  const usedEventIds = new Set([anchor.eventId]);
  const legs = [anchor];
  let combined = combineLegs([anchor.american]);

  const queue = pool
    .filter((c) => isEligible(c) && c.eventId !== anchor.eventId)
    .sort((a, b) => safety(b) - safety(a));

  for (const c of queue) {
    if (legs.length >= maxLegs || combined.american >= minAmerican) break;
    // One leg per game, and never a leg that argues with one already on the
    // ticket — a "parlay" holding both sides of anything cannot all land.
    if (usedEventIds.has(c.eventId) || legs.some((l) => contradicts(l, c))) continue;
    legs.push(c);
    usedEventIds.add(c.eventId);
    combined = combineLegs(legs.map((l) => l.american));
  }

  // Under the target is not a bankroll builder; over the board's ceiling is a
  // different bet than the board promises. Either way, no ticket.
  if (legs.length < 2) return null;
  if (combined.american < minAmerican || combined.american > maxAmerican) return null;

  return {
    type: 'combo',
    legs,
    american: combined.american,
    decimal: combined.decimal,
    score: legs.reduce((sum, l) => sum + l.score, 0) / legs.length,
    pairReason: `${legs.length} favourites stacked (${legs.map((l) => formatAmerican(l.american)).join(', ')}) so the ticket pays ${formatAmerican(combined.american)} instead of laying heavy juice on any one of them.`,
  };
}

/**
 * Convert up to `max` of a finished board's singles into bankroll builders
 * (see buildBankrollBuilder), strongest pick first.
 *
 * Board-level bookkeeping the per-ticket builder can't do on its own: a leg
 * already on the board is never pulled in as someone else's partner, no two
 * tickets share a game, and a pick with no legal ticket keeps whatever it
 * had. A board promising five plays still posts five afterwards.
 */
export function applyBankrollBuilders(picks, pool, { max = 2, ...opts } = {}) {
  const claimed = new Set(picks.flatMap((p) => p.legs.map((l) => l.id)));
  const claimedEvents = new Set(picks.flatMap((p) => p.legs.map((l) => l.eventId)));
  let made = 0;

  return picks.map((pick) => {
    if (made >= max || pick.type !== 'single') return pick;
    const anchor = pick.legs[0];
    const available = pool.filter((c) => !claimed.has(c.id) && !claimedEvents.has(c.eventId));
    const ticket = buildBankrollBuilder(anchor, available, opts);
    if (!ticket) return pick;

    made += 1;
    for (const leg of ticket.legs) {
      claimed.add(leg.id);
      claimedEvents.add(leg.eventId);
    }
    // The board's own classification of this slot rides along. topPicks sets
    // meetsStandard/flagReason on the pick, not on its legs, so building a
    // ticket around the anchor would otherwise silently drop them — and a
    // record with meetsStandard undefined is neither a standard pick nor a
    // flagged one, which every win-rate and ROI summary reads by that field.
    return { ...ticket, meetsStandard: pick.meetsStandard, flagReason: pick.flagReason ?? null };
  });
}

/**
 * Turn up to `max` short-priced singles on a finished board into two-leg
 * combos, using the same pairing rule buildPick has always applied: a leg
 * priced -151 or shorter can't stand alone at a sensible price, so it takes
 * a partner from another game to drag the ticket toward +100.
 *
 * Exported so the curated boards can opt in. topPicks() deliberately returns
 * singles — it ranks candidates, it doesn't construct tickets — and every
 * caller that wants combos wants a different number of them, so the choice
 * belongs to the caller rather than being baked into the ranking.
 *
 * `pool` is the remaining candidate pool a partner may be drawn from; a
 * partner is never a candidate already on the board, never the same game as
 * its own anchor, and never contradicts a leg already committed (findPartner
 * enforces the last two). Picks are considered strongest-first, so when only
 * some can be paired it's the best of them that get the treatment.
 *
 * Anything that can't find a legal partner stays exactly as it was — a
 * single. This never drops a pick: a board that promised five plays still
 * has five afterwards.
 */
export function pairShortPricedPicks(picks, pool, { max = 2, isEligible = () => true } = {}) {
  const onBoard = new Set(picks.flatMap((p) => p.legs.map((l) => l.id)));
  const usedEventIds = new Set(picks.flatMap((p) => p.legs.map((l) => l.eventId)));
  const usedLegs = picks.flatMap((p) => p.legs);
  let made = 0;

  return picks.map((pick) => {
    if (made >= max) return pick;
    // Only a single whose own price is too short to stand alone is a
    // candidate for pairing; a leg already at -140 or +120 is fine as it is.
    if (pick.type !== 'single' || !needsPartner(pick.legs[0].american)) return pick;

    const anchor = pick.legs[0];
    // isEligible gates BOTH ends of the ticket, so a caller asking for
    // moneyline combos gets two moneylines and not a moneyline welded to a
    // total. Applied to the anchor too, not just the partner — pairing a leg
    // the caller wouldn't have chosen as a partner makes no sense.
    if (!isEligible(anchor)) return pick;
    const eligible = pool.filter(
      (c) => !onBoard.has(c.id) && !usedEventIds.has(c.eventId) && isEligible(c),
    );
    const paired = findPartner(anchor, eligible, usedLegs);
    if (!paired) return pick;

    made += 1;
    onBoard.add(paired.partner.id);
    usedEventIds.add(paired.partner.eventId);
    usedLegs.push(paired.partner);
    return {
      type: 'combo',
      legs: [anchor, paired.partner],
      american: paired.combined.american,
      decimal: paired.combined.decimal,
      score: (anchor.score + paired.partner.score) / 2,
      pairReason: `${formatAmerican(anchor.american)} is shorter than ${formatAmerican(RULES.SINGLE_FLOOR)}, so it's paired with ${paired.partner.selection} to bring the ticket to ${formatAmerican(paired.combined.american)}, closer to even money.`,
    };
  });
}

/**
 * Generate a slate of 1–2 picks.
 *
 * @param candidates    scored candidates from buildCandidates + scoreCandidate
 * @param opts.exclude  candidate ids already shown this session
 * @param opts.rng      injectable randomness, for tests
 * @param opts.minScore grade floor; defaults to RULES.MIN_SCORE
 */
export function generateSlate(
  candidates,
  { exclude = new Set(), rng = Math.random, minScore = RULES.MIN_SCORE } = {},
) {
  const pool = candidates.filter((c) => inBand(c.american) && c.score >= minScore);
  const fresh = pool.filter((c) => !exclude.has(c.id));
  // Once everything has been shown, recycle rather than dead-end.
  const source = fresh.length >= 2 ? fresh : pool;

  const picks = [];
  // Every leg already committed to this slate, so nothing that follows can
  // contradict one. Tracking legs rather than events lets a game appear twice
  // across different markets while still blocking both sides of one market.
  const usedLegs = [];
  const target = source.length > 3 && rng() > 0.4 ? 2 : 1;

  const working = [...source].sort((a, b) => b.score - a.score);

  while (picks.length < target && working.length) {
    const idx = weightedPick(working.slice(0, 25), rng);
    const [anchor] = working.splice(idx, 1);
    // Anchors arrive in weighted-score order, so the survivor of a clash is the
    // better-graded one and the loser is simply never reached.
    if (usedLegs.some((leg) => contradicts(leg, anchor))) continue;

    const pick = buildPick(anchor, working, usedLegs);
    if (!pick) continue;

    usedLegs.push(...pick.legs);
    // A partner used in a combo shouldn't reappear as its own pick.
    pick.legs.slice(1).forEach((leg) => {
      const i = working.findIndex((c) => c.id === leg.id);
      if (i >= 0) working.splice(i, 1);
    });
    picks.push(pick);
  }

  // Grade each pick against the board it came from, so "78" means something
  // relative to tonight rather than in the abstract.
  const scores = pool.map((c) => c.score);
  for (const pick of picks) pick.percentile = percentileOf(pick.score, scores);

  return { picks, poolSize: pool.length, generatedAt: Date.now() };
}

/** Full pipeline: raw API events -> scored, sorted candidates. */
export function analyze(events, { now = Date.now() } = {}) {
  return buildCandidates(events, { now })
    .map((c) => ({ ...c, ...scoreCandidate(c, { now }) }))
    .sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------ */
/* Top-N straight-bet slate                                            */
/* ------------------------------------------------------------------ */

/**
 * Up to `count` individual bets across every sport currently on the board,
 * ranked purely by grade — no per-sport quota, no auto-pairing short prices
 * into a combo. That combo behavior in generateSlate() suits a 1-2 pick board
 * where the app is choosing for you; here the point is the opposite — hand
 * back a pool of straight, single-leg bets at their own real prices so the
 * user builds their own parlays or straights out of them.
 *
 * Odds range and confidence floor are both caller-supplied rather than fixed
 * at RULES' defaults, because the UI exposes both as adjustable controls: a
 * thin board (MMA on a quiet night, say) is a real state the user should be
 * able to widen into rather than stare at an empty list. minEv/minKelly are
 * different in kind, not degree — they're opt-in (default: no floor, so
 * existing callers are unaffected) but once set they're a hard rejection,
 * never a "widen to see it" control: a candidate that clears the odds band
 * and score floor by scoring well on liquidity/agreement/freshness alone can
 * still have almost no real edge (a 51% read on -117 juice scores fine
 * despite being -EV once the vig is paid), and no amount of widening the
 * band makes that a bet worth taking. Below `count` real results back is the
 * honest outcome on a day that doesn't have `count` genuine edges — this
 * never pads the board out with one that doesn't clear the bar just to hit
 * a number.
 */
export function topPicks(
  candidates,
  {
    count = 8,
    oddsMin = RULES.MIN_AMERICAN,
    oddsMax = RULES.MAX_AMERICAN,
    minScore = RULES.MIN_SCORE,
    // Opt-in, both default to "no floor" — existing callers (and the test
    // suite) build fixtures that pass purely on score/odds-range and don't
    // need to also clear a real edge threshold. Pixel Picks turns these on
    // because a candidate can score above minScore on liquidity/agreement/
    // freshness alone with almost no real EV (a 51% read on -117 juice, the
    // exact "51/100 confidence on a -EV line" pattern that motivated this) —
    // score is "how clean is this number," not "is this worth taking."
    minEv = -Infinity,
    minKelly = 0,
    exclude = new Set(),
    // Opt-in only — existing callers (and the test suite) rely on an empty
    // board being a real, visible state when nothing clears the bar. Pixel
    // Picks turns this on because it promises exactly `count` locks every
    // time; everything else keeps the "empty is honest" behaviour.
    guaranteeCount = false,
    // There is deliberately NO tier below guaranteeCount. One existed
    // (`lastResortFill`, 2026-08-21 to 2026-09-15): it filled the remaining
    // slots with the edge bar relaxed so the board never posted short. Every
    // pick it produced was, by this engine's own numbers, a losing bet
    // before kickoff, and it was posting them on precisely the days the
    // market offered nothing. A short board is the honest output of a day
    // with no edge; a full board of -EV bets is a guaranteed loss dressed as
    // a promise kept. The edge bar (minEv/minKelly) is now the one thing no
    // tier of this function relaxes.
    // Sport keys the user has said they'd rather see more of. This is a soft
    // sort nudge, not a filter — it can move a close call to the front of the
    // queue, never invent or hide a grade.
    preferredSportKeys = null,
    // Board-composition cap on +120-and-longer underdogs (the same >= +120
    // boundary the daily learning's own odds band calls 'dog'). Evidence
    // behind the default: with no cap, that band was 57% of all graded
    // picks and won 29.6% of them (see UNDERDOG_PROB_PENALTY's numbers) —
    // the score penalty fixes the ranking, this fixes the worst case where
    // a slate's top scores STILL all happen to be long shots. Two of a
    // five-pick board keeps genuinely strong dogs pickable without letting
    // them be the board's identity again. The guaranteeCount fallback below
    // deliberately does NOT enforce it: those slots are already visibly
    // flagged as outside the sharp standard, and a thin day shouldn't
    // produce a short board just because what's left is dog-priced.
    maxDogs = 2,
    // A bound NOTHING crosses — not even the guaranteeCount fallback below,
    // which relaxes `oddsMin`/`oddsMax` and until now relaxed them without
    // limit. That's how a board promising "-200 or better" could post a
    // -1800 favorite: the fallback didn't check the price at all, it just
    // LABELLED the pick "odds outside -200/+250" and posted it anyway.
    // Reported from the live board, and the reason these exist separately
    // from the soft band: a short board is recoverable, a 90%-implied
    // favorite dressed as a value play is not.
    hardOddsMin = -Infinity,
    hardOddsMax = Infinity,
    // Refuse any candidate whose best price is not at a registry book (see
    // buildCandidates' `bettable`). Off by default so the browser's own
    // research board still shows every priced line; the curated, tracked
    // boards turn it on, because their record is a promise about bets a
    // reader can place.
    requireBettable = false,
  } = {},
) {
  const DOG_AMERICAN = 120;
  const inRange = (a) => a >= oddsMin && a <= oddsMax;
  const withinHardBounds = (a) => a >= hardOddsMin && a <= hardOddsMax;
  // A hard floor, unlike the odds band and score — a candidate that's
  // genuinely not worth the stake should never surface, not even flagged as
  // a non-standard fallback pick (see guaranteeCount below).
  const clearsEdgeBar = (c) => c.ev > minEv && suggestedStake(c) >= minKelly;
  // A hard rejection in the same category as clearsEdgeBar, deliberately NOT
  // part of the relaxable odds/score band: NFL preseason is never a Pixel
  // Picks lock, so it must also be unavailable to the guaranteeCount
  // fallback below, which pads a thin board from the raw candidate list.
  // Filtering only `pool` would leave exactly that hole — a quiet day's
  // padding could post the preseason game this is meant to keep out.
  const isPickable = (c) => !isNflPreseason(c) && (!requireBettable || c.bettable !== false);
  const pool = candidates.filter(
    (c) => inRange(c.american) && withinHardBounds(c.american) && c.score >= minScore && clearsEdgeBar(c) && isPickable(c),
  );

  const fresh = pool.filter((c) => !exclude.has(c.id));
  // Once everything in range has been shown this session, recycle rather than
  // hand back fewer than the user asked for.
  const source = fresh.length >= count ? fresh : pool;

  const scores = pool.map((c) => c.score);

  // A modest nudge — enough to reorder near-ties toward a preferred sport,
  // never enough to put a real 55 ahead of a real 90. Sort key only; the
  // score shown to the user is always the real, un-nudged grade.
  const PREFERENCE_BONUS = 6;
  const sortKey = (c) =>
    c.score + (preferredSportKeys?.size && preferredSportKeys.has(c.sportKey) ? PREFERENCE_BONUS : 0);

  const sorted = [...source].sort((a, b) => sortKey(b) - sortKey(a));

  const picks = [];
  const usedLegs = [];
  let dogCount = 0;
  for (const c of sorted) {
    if (picks.length >= count) break;
    // Game-level conflict resolution: reject if same game already on board
    // (different markets on same game cannibalize each other)
    if (usedLegs.some((leg) => leg.eventId === c.eventId)) continue;
    // Market-level conflict: reject if exact same market already on board
    if (usedLegs.some((leg) => contradicts(leg, c))) continue;
    // Board-composition cap — see maxDogs above.
    if (c.american >= DOG_AMERICAN && dogCount >= maxDogs) continue;
    if (c.american >= DOG_AMERICAN) dogCount++;
    usedLegs.push(c);
    picks.push({
      type: 'single',
      legs: [c],
      american: c.american,
      score: c.score,
      percentile: percentileOf(c.score, scores),
      meetsStandard: true,
    });
  }

  // Pixel Picks promises `count` locks every time it runs. When the sharp
  // board (odds range + confidence floor) can't fill it, the remaining slots
  // come from the full candidate pool — still real, gradeable prices, just
  // outside the sharp standard — and are flagged so the UI can say so rather
  // than quietly passing them off as locks. clearsEdgeBar still applies here
  // even though everything else relaxes: a demonstrably -EV or dust-sized
  // edge isn't "non-standard," it's just a bad bet, and flagging it as a
  // fallback lock wouldn't make it a better one.
  if (guaranteeCount && picks.length < count) {
    const fallbackSorted = [...candidates]
      .filter((c) => !usedLegs.includes(c) && clearsEdgeBar(c) && withinHardBounds(c.american) && isPickable(c))
      .sort((a, b) => sortKey(b) - sortKey(a));

    for (const c of fallbackSorted) {
      if (picks.length >= count) break;
      if (usedLegs.some((leg) => leg.eventId === c.eventId)) continue;
      if (usedLegs.some((leg) => contradicts(leg, c))) continue;
      usedLegs.push(c);

      const reasons = [];
      if (!inRange(c.american)) reasons.push(`odds outside ${formatAmerican(oddsMin)}/${formatAmerican(oddsMax)}`);
      if (c.score < minScore) reasons.push(`confidence below ${Math.round(minScore)}`);

      picks.push({
        type: 'single',
        legs: [c],
        american: c.american,
        score: c.score,
        percentile: percentileOf(c.score, scores),
        meetsStandard: false,
        flagReason: reasons.length ? reasons.join(', ') : 'outside standard criteria',
      });
    }
  }

  return { picks, poolSize: pool.length, generatedAt: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Tracked-board unit staking                                          */
/* ------------------------------------------------------------------ */

/**
 * What one unit is worth in the tracked record's own dollar figures ($25/1U
 * per explicit product direction, 2026-08-21). Display leans on UNITS, not
 * this number — every user runs a different dollar unit — but the tracked
 * history needs one consistent dollar basis for its Net $ / ROI math, and
 * this is it.
 */
export const UNIT_DOLLARS = 25;

/**
 * Per-board unit ranges, per explicit product direction: the boards form a
 * conviction hierarchy — the Play of the Day (the slate's #1) carries the
 * most, 3 to 5 units; the Prop Play and each Pixel's Pick carry 1 to 2.5.
 * Within each band the algorithm's own confidence score decides where a
 * pick lands (see stakeUnitsForScore); the ladder is absent deliberately,
 * since it stakes its whole compounding bankroll and units don't apply.
 */
export const STAKE_BANDS = {
  // Play of the Day was 3-to-5 units ($75-$125). Capped to 1-to-3 (2026-08-26
  // direction): nothing this app posts risks more than 3 units / $75, and a
  // POTD that only just clears the standard now sizes like any other single
  // pick rather than starting at what used to be the old band's floor.
  potd: { min: 1, max: 3 },
  pixel: { min: 1, max: 2.5 },
  prop: { min: 1, max: 2.5 },
};

/** No board may size a single play above this, whatever its band says. */
export const MAX_STAKE_UNITS = 3;

/**
 * Maps a 0-100 confidence score onto a board's unit band, in half-unit
 * steps. The score range that spreads the band is [50, 85]: 50 is
 * RULES.MIN_SCORE (the floor a standard pick must clear — a pick at the
 * floor carries the band's minimum), and 85+ is reserved for the genuinely
 * elite grades that earn the top of the band. Anything below the floor
 * (flagged fallback picks) pins to the minimum: a pick that didn't clear
 * the standard never carries extra size.
 */
export function stakeUnitsForScore(score, { min, max }) {
  const LO = 50, HI = 85;
  const t = Math.max(0, Math.min(1, ((Number(score) || 0) - LO) / (HI - LO)));
  const units = Math.round((min + t * (max - min)) * 2) / 2;
  // The cap is enforced here, not just in the band table, so a band edited
  // later (or a caller passing its own min/max) can never quietly reintroduce
  // a stake above the ceiling. Half-unit rounding already happened above, so
  // clamping cannot produce an off-step size.
  return Math.min(units, MAX_STAKE_UNITS);
}

/* ------------------------------------------------------------------ */
/* Bankroll staking (Kelly Criterion)                                  */
/* ------------------------------------------------------------------ */

export const KELLY = {
  // Quarter-Kelly: full Kelly maximizes long-run growth but produces
  // white-knuckle variance, and is only correct if the win probability going
  // in is exactly right — which a devigged market consensus is a good
  // estimate of, not a guarantee of. A fraction trades some growth for a
  // meaningfully smoother ride, which is the standard professional practice
  // this app's own reference framework recommends over full Kelly.
  FRACTION: 0.25,
  // Full Kelly can still suggest an oversized stake when the market happens
  // to be very thin or the estimate is off in one book's favor. This caps any
  // single bet regardless of what the formula says — protection against
  // model error, not a claim that the math is wrong.
  MAX_STAKE: 0.05,
};

/**
 * The Kelly Criterion's optimal bet fraction: f* = (b·p − q) / b, where b is
 * net decimal odds, p is true win probability, and q = 1 − p. Returns 0
 * rather than a negative fraction — this app never suggests betting the
 * other side of a number it graded, it just says "no edge, no stake."
 */
export function kellyFraction(winProb, decimalOdds) {
  const b = decimalOdds - 1;
  if (b <= 0 || !(winProb > 0) || winProb >= 1) return 0;
  const f = (b * winProb - (1 - winProb)) / b;
  return Math.max(0, f);
}

/**
 * Suggested stake as a fraction of bankroll for one graded candidate, using
 * its own no-vig consensus as the win-probability input — the same number
 * scoreCandidate()'s `ev` field is already built from, so a stake size and an
 * EV% are always talking about the same edge.
 */
export function suggestedStake(candidate, { fraction = KELLY.FRACTION } = {}) {
  const full = kellyFraction(candidate.consensusProb, candidate.decimal);
  return Math.min(full * fraction, KELLY.MAX_STAKE);
}

/**
 * Suggested stake for a completed parlay ticket. Legs are assumed
 * independent — the same assumption combineLegs() already makes when
 * multiplying their decimal odds, and findPartner() enforces it structurally
 * by refusing two legs from the same game — so the ticket's true win
 * probability is just the product of each leg's own consensus probability.
 */
export function suggestedParlayStake(legs, combinedDecimal, { fraction = KELLY.FRACTION } = {}) {
  const combinedProb = legs.reduce((p, leg) => p * leg.consensusProb, 1);
  const full = kellyFraction(combinedProb, combinedDecimal);
  return Math.min(full * fraction, KELLY.MAX_STAKE);
}
