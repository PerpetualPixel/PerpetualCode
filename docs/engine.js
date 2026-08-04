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
};

const MARKET_LABELS = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };

/** Action Network league slugs, keyed by The Odds API sport_key. */
const ACTION_NETWORK_SLUGS = {
  americanfootball_nfl: 'nfl',
  americanfootball_ncaaf: 'ncaaf',
  basketball_nba: 'nba',
  basketball_ncaab: 'ncaab',
  basketball_wnba: 'wnba',
  baseball_mlb: 'mlb',
  icehockey_nhl: 'nhl',
  mma_mixed_martial_arts: 'mma',
  soccer_epl: 'soccer',
  soccer_uefa_champs_league: 'soccer',
  soccer_usa_mls: 'soccer',
};

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
 * Strip the bookmaker's margin from a set of mutually exclusive prices.
 *
 * Raw implied probabilities sum to more than 1 — that surplus is the vig.
 * We rescale proportionally so they sum to 1, which is the standard
 * multiplicative method. It slightly over-corrects heavy favorites relative to
 * Shin's method, but it needs no solver and is what most public models use.
 */
export function devig(americanOdds) {
  const raw = americanOdds.map(impliedProb);
  const overround = raw.reduce((a, b) => a + b, 0);
  return {
    fair: raw.map((p) => p / overround),
    // e.g. 0.045 => the book is charging 4.5% on this market.
    vig: overround - 1,
  };
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
  if (marketKey === 'totals') {
    return `${name} ${point} — ${event.away_team} @ ${event.home_team}`;
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
          });
        });
      }
    }

    for (const [key, entry] of pool) {
      const { quotes } = entry;
      if (quotes.length < RULES.MIN_BOOKS) continue;

      // Best price = highest decimal payout. This is the line-shopping winner.
      const best = quotes.reduce((a, b) => (b.decimal > a.decimal ? b : a));

      // Benchmark against the REST of the market, so the outlier we're about to
      // bet doesn't get to vote on whether it's a good bet.
      const others = quotes.filter((q) => q !== best);
      const consensusProb = median(others.map((q) => q.fairProb));
      const disagreement = stdev(others.map((q) => q.fairProb));

      // Expected value per $1 staked, at the best price, under consensus.
      const ev = consensusProb * (best.decimal - 1) - (1 - consensusProb);

      // What line shopping alone bought us, in probability terms.
      const avgProb =
        quotes.reduce((a, q) => a + impliedProb(q.american), 0) / quotes.length;
      const shopGain = avgProb - impliedProb(best.american);

      candidates.push({
        id: `${event.id}:${key}`,
        eventId: event.id,
        sportKey: event.sport_key,
        sportTitle: event.sport_title,
        league: ACTION_NETWORK_SLUGS[event.sport_key] ?? null,
        commenceMs,
        home: event.home_team,
        away: event.away_team,
        marketKey: entry.marketKey,
        marketLabel: MARKET_LABELS[entry.marketKey],
        selection: describe(event, entry.marketKey, entry.outcome),
        american: best.american,
        decimal: best.decimal,
        book: best.book,
        updatedMs: best.updatedMs,
        bookCount: quotes.length,
        consensusProb,
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

/**
 * Composite 0–100 grade. Edge dominates; everything else is confidence that
 * the edge is real rather than an artifact of a thin or stale market.
 */
export function scoreCandidate(c, { now = Date.now() } = {}) {
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
  };

  const score =
    100 *
    (0.45 * parts.edge +
      0.18 * parts.liquidity +
      0.15 * parts.agreement +
      0.14 * parts.shopping +
      0.08 * parts.freshness);

  return { score, parts };
}

/** Human-readable "why this is sharp", built from the numbers we actually used. */
export function explain(c) {
  const evPct = (c.ev * 100).toFixed(1);
  const lines = [];

  // Below half a point of EV there is no edge worth claiming out loud.
  lines.push(
    c.ev >= 0.005
      ? `The market's own no-vig consensus makes this a ${(c.consensusProb * 100).toFixed(1)}% shot — fair value ${formatAmerican(c.fairAmerican)}. You're getting ${formatAmerican(c.american)}, worth about ${evPct}% per dollar.`
      : `Consensus fair value is ${formatAmerican(c.fairAmerican)} and the best price is ${formatAmerican(c.american)}, so this is priced close to fair (${evPct}% per dollar). It's here on market quality, not on a pricing mistake.`,
  );

  lines.push(
    `${c.bookCount} books are on this exact number and ${c.book} is the outlier — line shopping alone is worth ${(c.shopGain * 100).toFixed(1)} points of win probability over the field average.`,
  );

  lines.push(
    c.disagreement < 0.015
      ? `The rest of the market is tightly clustered (±${(c.disagreement * 100).toFixed(1)}%), which is what makes one book hanging a better price meaningful rather than noisy.`
      : `Books disagree by ±${(c.disagreement * 100).toFixed(1)}% here, so the edge is real but softer — this is a smaller-stake spot.`,
  );

  lines.push(
    `Typical vig on this market is ${(c.medianVig * 100).toFixed(1)}%; taking the best number is how you beat the hold over a season.`,
  );

  return lines;
}

/* ------------------------------------------------------------------ */
/* Slate construction                                                  */
/* ------------------------------------------------------------------ */

const inBand = (a) => a >= RULES.MIN_AMERICAN && a <= RULES.MAX_AMERICAN;
const canStandAlone = (a) => a >= RULES.SINGLE_FLOOR && a <= RULES.MAX_AMERICAN;
const needsPartner = (a) => a >= RULES.MIN_AMERICAN && a < RULES.SINGLE_FLOOR;

export function actionNetworkUrl(candidate) {
  return candidate.league
    ? `https://www.actionnetwork.com/${candidate.league}/odds`
    : 'https://www.actionnetwork.com/odds';
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
function findPartner(anchor, pool) {
  const eligible = pool.filter(
    (c) => c.eventId !== anchor.eventId && inBand(c.american),
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
function buildPick(anchor, pool) {
  if (canStandAlone(anchor.american)) {
    return {
      type: 'single',
      legs: [anchor],
      american: anchor.american,
      score: anchor.score,
    };
  }

  const paired = findPartner(anchor, pool);
  if (!paired) return null; // No legal way to show this one — drop it.

  return {
    type: 'combo',
    legs: [anchor, paired.partner],
    american: paired.combined.american,
    score: (anchor.score + paired.partner.score) / 2,
    // Why the pairing exists, in the spec's own terms.
    pairReason: `${formatAmerican(anchor.american)} is shorter than -150, so it's paired to bring the ticket to ${formatAmerican(paired.combined.american)} — closer to even money.`,
  };
}

/**
 * Generate a slate of 1–2 picks.
 *
 * @param candidates scored candidates from buildCandidates + scoreCandidate
 * @param opts.exclude  candidate ids already shown this session
 * @param opts.rng      injectable randomness, for tests
 */
export function generateSlate(candidates, { exclude = new Set(), rng = Math.random } = {}) {
  const pool = candidates.filter((c) => inBand(c.american));
  const fresh = pool.filter((c) => !exclude.has(c.id));
  // Once everything has been shown, recycle rather than dead-end.
  const source = fresh.length >= 2 ? fresh : pool;

  const picks = [];
  const usedEvents = new Set();
  const target = source.length > 3 && rng() > 0.4 ? 2 : 1;

  const working = [...source].sort((a, b) => b.score - a.score);

  while (picks.length < target && working.length) {
    const idx = weightedPick(working.slice(0, 25), rng);
    const [anchor] = working.splice(idx, 1);
    // Don't show two picks on the same game — that's one opinion, not two.
    if (usedEvents.has(anchor.eventId)) continue;

    const pick = buildPick(anchor, working);
    if (!pick) continue;

    pick.legs.forEach((leg) => usedEvents.add(leg.eventId));
    // A partner used in a combo shouldn't reappear as its own pick.
    pick.legs.slice(1).forEach((leg) => {
      const i = working.findIndex((c) => c.id === leg.id);
      if (i >= 0) working.splice(i, 1);
    });
    picks.push(pick);
  }

  return { picks, poolSize: pool.length, generatedAt: Date.now() };
}

/** Full pipeline: raw API events -> scored, sorted candidates. */
export function analyze(events, { now = Date.now() } = {}) {
  return buildCandidates(events, { now })
    .map((c) => ({ ...c, ...scoreCandidate(c, { now }) }))
    .sort((a, b) => b.score - a.score);
}
