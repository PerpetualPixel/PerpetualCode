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
  // Nothing below this grade is shown at all. The board is meant to be the best
  // available, not a ranked list of everything — a 40 is not a pick, it's a coin
  // flip with extra steps.
  MIN_SCORE: 50,
};

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
  if (marketKey === 'alternate_spreads') {
    // Same game-margin axis as 'spreads', just a wider ladder — labelled
    // distinctly only so it's visibly a different market key on the board,
    // not because it's a different kind of bet.
    return `${name} ${point > 0 ? `+${point}` : point} (alt)`;
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
          })),
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

/**
 * The price bullet — one line covering value against the market.
 *
 * Deliberately singular. Everything else on the card comes from insights.js,
 * which reads actual form, head-to-head and injury data; four bullets of odds
 * arithmetic was three bullets of restating the same edge.
 */
export function explain(c) {
  const evPct = (c.ev * 100).toFixed(1);

  const value =
    c.ev >= 0.005
      ? `The market's own no-vig consensus makes this a ${(c.consensusProb * 100).toFixed(1)}% shot — fair value ${formatAmerican(c.fairAmerican)}. You're getting ${formatAmerican(c.american)} at ${c.book}, worth about ${evPct}% per dollar.`
      : `Consensus fair value is ${formatAmerican(c.fairAmerican)} and the best price is ${formatAmerican(c.american)} at ${c.book} — priced close to fair (${evPct}% per dollar), so it's here on market quality rather than a pricing mistake.`;

  const context =
    c.disagreement < 0.015
      ? `${c.bookCount} books are on this exact number and the rest are tightly clustered (±${(c.disagreement * 100).toFixed(1)}%), which is what makes one book hanging a better price meaningful rather than noisy.`
      : `${c.bookCount} books are on this number but they disagree by ±${(c.disagreement * 100).toFixed(1)}%, so the edge is real but softer — a smaller-stake spot.`;

  return [`${value} ${context}`];
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
    pairReason: `${formatAmerican(anchor.american)} is shorter than -150, so it's paired to bring the ticket to ${formatAmerican(paired.combined.american)} — closer to even money.`,
  };
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
 * The best `count` individual bets across every sport currently on the board,
 * ranked purely by grade — no per-sport quota, no auto-pairing short prices
 * into a combo. That combo behavior in generateSlate() suits a 1-2 pick board
 * where the app is choosing for you; here the point is the opposite — hand
 * back a pool of straight, single-leg bets at their own real prices so the
 * user builds their own parlays or straights out of them.
 *
 * Odds range and confidence floor are both caller-supplied rather than fixed
 * at RULES' defaults, because the UI exposes both as adjustable controls: a
 * thin board (MMA on a quiet night, say) is a real state the user should be
 * able to widen into rather than stare at an empty list.
 */
export function topPicks(
  candidates,
  {
    count = 8,
    oddsMin = RULES.MIN_AMERICAN,
    oddsMax = RULES.MAX_AMERICAN,
    minScore = RULES.MIN_SCORE,
    exclude = new Set(),
  } = {},
) {
  const inRange = (a) => a >= oddsMin && a <= oddsMax;
  const pool = candidates.filter((c) => inRange(c.american) && c.score >= minScore);
  const fresh = pool.filter((c) => !exclude.has(c.id));
  // Once everything in range has been shown this session, recycle rather than
  // hand back fewer than the user asked for.
  const source = fresh.length >= count ? fresh : pool;

  const scores = pool.map((c) => c.score);
  const sorted = [...source].sort((a, b) => b.score - a.score);

  const picks = [];
  const usedLegs = [];
  for (const c of sorted) {
    if (picks.length >= count) break;
    // A higher-scored leg already on the board wins any contradiction; the
    // sort order means we never reach the loser first.
    if (usedLegs.some((leg) => contradicts(leg, c))) continue;
    usedLegs.push(c);
    picks.push({
      type: 'single',
      legs: [c],
      american: c.american,
      score: c.score,
      percentile: percentileOf(c.score, scores),
    });
  }

  return { picks, poolSize: pool.length, generatedAt: Date.now() };
}
