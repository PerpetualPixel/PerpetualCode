/**
 * Tennis tournament tiering, deduplication, and per-tier risk policy.
 *
 * Pure functions only — no DOM, no network — so this runs unmodified in the
 * browser (docs/app.js) and in the Worker (worker/src/*), same as
 * docs/learning.js and docs/insights.js.
 *
 * ── What the upstream feed actually carries ──────────────────────────────
 * Audited live against The Odds API's catalogue before this was written,
 * because the tiering below is only meaningful for events that exist:
 *
 *   - ~22 ATP and ~21 WTA MAIN TOUR tournaments, keyed one-per-event
 *     (tennis_atp_canadian_open, and a different key next week).
 *   - ZERO Challenger coverage. No ATP Challenger 50/75/100/125, no WTA 125.
 *     Not filtered out by this app — absent from the provider entirely.
 *   - Partial main-tour coverage: the Slams, all nine ATP Masters 1000, the
 *     WTA 1000s, and a subset of 500s. Most 250s are not carried.
 *
 * So TIER_2 here means "the 500/250-level events the feed DOES carry," not
 * "the Challenger tour." A Challenger tier is defined below and wired
 * through the policy engine so the day a feed carries them nothing needs
 * rethinking — but it will not match anything today, and pretending
 * otherwise would be the kind of silent no-op that reads as working.
 *
 * ── Why tiering matters for risk ─────────────────────────────────────────
 * Lower-tier tennis is thinly priced: fewer books, wider spreads, staler
 * lines, and a much higher retirement rate. The same nominal edge is worth
 * less there, so tier drives both which markets are eligible and how much
 * the staking model is allowed to put behind one.
 */

export const TIER_1 = 'TIER_1';
export const TIER_2 = 'TIER_2';
/** Defined and wired through, but unreachable with the current provider — see the module header. */
export const TIER_CHALLENGER = 'TIER_CHALLENGER';

/**
 * The event slug shared by an ATP and WTA tournament of the same name —
 * i.e. the sport key with its `tennis_atp_` / `tennis_wta_` prefix removed.
 * Tier is NOT derivable from the slug alone: Dubai, Doha (Qatar) and Beijing
 * (China Open) are WTA 1000s but only ATP 500/250s, so the tour has to be
 * part of the lookup.
 */
const ATP_TIER_1_SLUGS = new Set([
  // Grand Slams
  'aus_open', 'australian_open', 'french_open', 'wimbledon', 'us_open',
  // All nine ATP Masters 1000
  'indian_wells', 'miami_open', 'monte_carlo_masters', 'madrid_open',
  'italian_open', 'canadian_open', 'cincinnati_open', 'shanghai_masters',
  'paris_masters',
]);

const WTA_TIER_1_SLUGS = new Set([
  // Grand Slams
  'aus_open', 'australian_open', 'french_open', 'wimbledon', 'us_open',
  // WTA 1000s — note Dubai/Qatar/China are 1000-level on this tour but not on the ATP side
  'indian_wells', 'miami_open', 'madrid_open', 'italian_open',
  'canadian_open', 'cincinnati_open', 'china_open', 'wuhan_open',
  'qatar_open', 'dubai_championships',
]);

/** Substrings that mark a key or title as Challenger-level, on either tour. */
const CHALLENGER_MARKERS = ['challenger', '_ch_', 'itf', 'wta_125', '125k'];

export function isTennisKey(sportKey) {
  return String(sportKey ?? '').startsWith('tennis_');
}

/** 'atp' | 'wta' | null, from the sport key's own prefix. */
export function tourOf(sportKey) {
  const key = String(sportKey ?? '');
  if (key.startsWith('tennis_atp')) return 'atp';
  if (key.startsWith('tennis_wta')) return 'wta';
  return null;
}

/** The tournament slug: sport key minus its tour prefix. */
export function slugOf(sportKey) {
  return String(sportKey ?? '').replace(/^tennis_(atp|wta)_?/, '');
}

/**
 * Operational tier for one tennis event. Returns null for non-tennis, so
 * callers can use this as both a classifier and a "does this apply" check.
 *
 * Challenger detection reads the title as well as the key, since a feed that
 * ever does carry them may name them in either place.
 */
export function tennisTier(sportKey, title = '') {
  if (!isTennisKey(sportKey)) return null;

  const haystack = `${sportKey} ${title}`.toLowerCase();
  if (CHALLENGER_MARKERS.some((m) => haystack.includes(m))) return TIER_CHALLENGER;

  const tour = tourOf(sportKey);
  const slug = slugOf(sportKey);
  const tier1 = tour === 'wta' ? WTA_TIER_1_SLUGS : ATP_TIER_1_SLUGS;
  // Unknown slugs fall to TIER_2 deliberately: an unrecognized tournament is
  // far more likely to be a 250 the feed just added than a Slam, and the
  // failure mode of guessing low (tighter markets, smaller stake) is much
  // cheaper than guessing high.
  return tier1.has(slug) ? TIER_1 : TIER_2;
}

/* ---------------------------------------------------------------- */
/* Co-sanctioned / renamed event deduplication                       */
/* ---------------------------------------------------------------- */

/**
 * Tournaments that trade under several names — sponsor names, host-city
 * names, and the governing body's own name for the same week. Each entry
 * maps every alias to one canonical slug so the same match arriving under
 * two names collapses to one event.
 *
 * The Canadian Open is the standard example and the reason this exists: it
 * is variously "National Bank Open", "Rogers Cup", "ATP Montreal" and "ATP
 * Toronto" (the men's and women's draws swap cities annually), all one
 * tournament week.
 */
const TOURNAMENT_ALIASES = new Map(Object.entries({
  national_bank_open: 'canadian_open',
  rogers_cup: 'canadian_open',
  montreal: 'canadian_open',
  toronto: 'canadian_open',
  us_open_tennis: 'us_open',
  roland_garros: 'french_open',
  australian_open: 'aus_open',
  western_southern_open: 'cincinnati_open',
  bnp_paribas_open: 'indian_wells',
  mutua_madrid_open: 'madrid_open',
  internazionali_ditalia: 'italian_open',
  rome_masters: 'italian_open',
  beijing_open: 'china_open',
}));

/** One tournament's canonical slug, with aliases resolved. */
export function canonicalSlug(sportKey) {
  const slug = slugOf(sportKey);
  return TOURNAMENT_ALIASES.get(slug) ?? slug;
}

/**
 * A stable identity for one MATCH, independent of which tournament name it
 * arrived under. Player names are order-normalized so a feed listing the
 * same match with home/away swapped doesn't read as two events.
 *
 * Deliberately not the event id: co-sanctioned listings carry DIFFERENT ids
 * for the same match, which is exactly the case the existing by-event-id
 * dedupe (docs/app.js's fetchSingleLeague) cannot catch.
 */
export function matchIdentity(event) {
  const tour = tourOf(event?.sportKey ?? event?.sport_key) ?? 'x';
  const slug = canonicalSlug(event?.sportKey ?? event?.sport_key);
  const players = [event?.home ?? event?.home_team ?? '', event?.away ?? event?.away_team ?? '']
    .map((n) => String(n).trim().toLowerCase())
    .sort();
  // Day-level, not timestamp-level: two listings of one match routinely
  // disagree by minutes on start time, which would defeat an exact match.
  const day = Number.isFinite(event?.commenceMs)
    ? new Date(event.commenceMs).toISOString().slice(0, 10)
    : String(event?.commence_time ?? '').slice(0, 10);
  return `${tour}|${slug}|${players.join('~')}|${day}`;
}

/**
 * Collapse co-sanctioned/renamed duplicates in an event list, keeping the
 * richest listing of each match (most bookmakers) rather than whichever
 * arrived first — the duplicate is usually the thinner of the two.
 */
export function dedupeTennisEvents(events) {
  const byIdentity = new Map();
  const passthrough = [];

  for (const event of events ?? []) {
    const key = event?.sportKey ?? event?.sport_key;
    if (!isTennisKey(key)) {
      passthrough.push(event);
      continue;
    }
    const identity = matchIdentity(event);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, event);
      continue;
    }
    const bookCount = (e) => (e?.bookmakers?.length ?? 0);
    if (bookCount(event) > bookCount(existing)) byIdentity.set(identity, event);
  }

  return [...passthrough, ...byIdentity.values()];
}

/* ---------------------------------------------------------------- */
/* Per-tier risk policy                                              */
/* ---------------------------------------------------------------- */

/**
 * Maximum fraction of bankroll one pick may risk, by tier. TIER_1 defers to
 * the existing ¼-Kelly model (docs/engine.js's suggestedStake, itself capped
 * at 5%); the lower tiers impose a hard ceiling on top of it.
 */
export const TIER_MAX_STAKE_FRACTION = {
  [TIER_1]: null,   // no extra cap — ¼-Kelly and its own 5% ceiling govern
  [TIER_2]: 0.005,  // 0.5% of bankroll
  [TIER_CHALLENGER]: 0.0025, // 0.25% — thinnest markets, highest retirement rate
};

/**
 * Markets eligible for tracking, by tier.
 *
 * TIER_2 and Challenger are moneyline-ONLY, which is narrower than "mainlines
 * (moneyline and game spreads)" for a concrete, verified reason: this feed
 * prices tennis spreads and totals in GAMES (−4.5, 21.5) while its /scores
 * endpoint reports SETS (0/1/2). There is no games-level result available to
 * settle a games-level line against, so a tracked tennis spread or total
 * cannot be graded correctly at all — see gradeTennis() in docs/learning.js,
 * which now voids them rather than grading them against the wrong unit.
 * Admitting a market we cannot settle would put fabricated results into the
 * tracked record and, through it, into the daily learning loop.
 *
 * TIER_1 keeps spreads/totals eligible for *display* on the Full Slate, but
 * the same settlement guard applies — the difference is that a TIER_1 match
 * is worth showing every price for, not that its games line is settleable.
 */
export const TIER_MARKETS = {
  [TIER_1]: new Set(['h2h', 'spreads', 'totals', 'alternate_spreads']),
  [TIER_2]: new Set(['h2h']),
  [TIER_CHALLENGER]: new Set(['h2h']),
};

/**
 * Whether a tennis market can be SETTLED at all with this pipeline —
 * independent of tier, because it's a data constraint rather than a risk
 * policy. Only the moneyline can: spreads and totals are priced in games
 * while /scores reports sets, with no games-level result anywhere to settle
 * them against (see gradeTennis in docs/learning.js). Tracking one would
 * write a guaranteed void into the record instead of a real result, so
 * every surface that picks one candidate per match should use this to reach
 * for the moneyline rather than the highest-scoring unsettleable line.
 */
export function isSettleableTennisMarket(marketKey) {
  return marketKey === 'h2h';
}

/** Whether one market is eligible to be TRACKED (i.e. bet and graded) at this tier. */
export function isMarketAllowedForTier(marketKey, tier) {
  if (!tier) return true; // non-tennis — this policy doesn't apply
  return (TIER_MARKETS[tier] ?? TIER_MARKETS[TIER_2]).has(marketKey);
}

/**
 * Liquidity guardrail for the lower tiers: thin books, wide disagreement, or
 * a stale quote all mean the "edge" is more likely a pricing artifact than a
 * real one. TIER_1 is exempt — those markets are deep enough that the
 * engine's own book-count and agreement weights already handle it.
 *
 * Returns null when the candidate is fine, or a short reason string when it
 * should be held back.
 */
export const TIER_2_MIN_BOOKS = 4;
export const TIER_2_MAX_SPREAD_PCT = 4.5; // best vs worst implied probability, in points
export const TIER_2_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

export function tierLiquidityBlock(candidate, tier, now = Date.now()) {
  if (tier !== TIER_2 && tier !== TIER_CHALLENGER) return null;

  const quotes = candidate?.quotes ?? [];
  if (quotes.length < TIER_2_MIN_BOOKS) {
    return `only ${quotes.length} book${quotes.length === 1 ? '' : 's'} pricing this (need ${TIER_2_MIN_BOOKS})`;
  }

  const probs = quotes.map((q) => (Number.isFinite(q?.decimal) && q.decimal > 1 ? 100 / q.decimal : null)).filter((p) => p !== null);
  if (probs.length >= 2) {
    const spread = Math.max(...probs) - Math.min(...probs);
    if (spread > TIER_2_MAX_SPREAD_PCT) {
      return `books disagree by ${spread.toFixed(1)} probability points (max ${TIER_2_MAX_SPREAD_PCT})`;
    }
  }

  const updatedAt = candidate?.lastUpdateMs ?? candidate?.updatedAt;
  if (Number.isFinite(updatedAt) && now - updatedAt > TIER_2_MAX_QUOTE_AGE_MS) {
    return `quote is ${Math.round((now - updatedAt) / 60000)} minutes stale`;
  }

  return null;
}

/**
 * Apply the tier's stake ceiling to a ¼-Kelly fraction from
 * docs/engine.js's suggestedStake(). Returns the fraction unchanged at
 * TIER_1 and for non-tennis.
 */
export function capStakeForTier(stakeFraction, tier) {
  const cap = TIER_MAX_STAKE_FRACTION[tier];
  if (!Number.isFinite(cap)) return stakeFraction;
  return Math.min(stakeFraction, cap);
}
