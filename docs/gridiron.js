/**
 * Gridiron Engine feed — the NFL/NCAA prediction engine's own read on the
 * football games sitting on this app's odds board.
 *
 * The feed (https://perpetualpixel.github.io/NFL-NCAA-Football-Prediction-Engine/picks.json)
 * is rebuilt twice an hour by that engine's GitHub Pages run. It carries the
 * current week and the next one for both leagues: per game, the moneyline and
 * spread the model lands on, the tier, the *calibrated* win probability, the
 * market numbers the pick was priced against, and every breakdown paragraph
 * from the week page as plain text. Those pages are the same ones published
 * at .../nfl-w01.html and .../ncaa-w02.html; this reads the JSON beside them
 * rather than scraping the cards.
 *
 * Same shape as docs/capper-consensus.js (the MMA_Engine feed): pure
 * functions, a bounded -1..1 signal that scoreCandidate() already accepts,
 * null wherever there is no real data, and never a fabricated neutral.
 *
 * HOW MUCH THE SIGNAL IS ALLOWED TO MOVE, AND WHY IT IS NOT MORE
 * --------------------------------------------------------------
 * MMA gets its own ±25 swing because the cappers ARE that sport's
 * handicapping model here. Football is the opposite case, and the engine says
 * so itself in the feed's `disclosure`: measured across 2023-2025, its
 * optimal blend weight given the closing line is 0.00, its closing line value
 * is 34-39%, and its LARGEST disagreements with the market were its WORST
 * bets (NFL moneylines in the two most disagreeable buckets returned -44% and
 * -65%). A model like that is real evidence about who wins a football game
 * and no evidence at all that a price is wrong.
 *
 * So it enters as an ordinary qualitative signal inside the generic ±8
 * (QUALITATIVE.MAX_SWING) clamp, and its magnitude is DAMPED, not amplified,
 * as it strays above the price (see agreementFactor). Confirmation moves a
 * close call; disagreement is treated as the warning the engine's own
 * tracking says it is.
 */

import { clamp } from './engine.js';

export const GRIDIRON_FEED_URL =
  'https://perpetualpixel.github.io/NFL-NCAA-Football-Prediction-Engine/picks.json';

/** The two sport keys the feed speaks to, in The Odds API's own vocabulary. */
export const FOOTBALL_SPORT_KEYS = new Set([
  'americanfootball_nfl',
  'americanfootball_ncaaf',
]);

export const isFootball = (sportKey) => FOOTBALL_SPORT_KEYS.has(String(sportKey ?? ''));

/**
 * How much of the ±1 signal each tier is worth when the model and the market
 * agree. These track the engine's own published hit rates (Locks 93-94%,
 * Picks ~73-76%, Leans ~62-64%, Pass is a coin flip it declines to bet), NOT
 * how attractive the price is — that is what the app's own scoring is for.
 */
export const TIER_MAGNITUDE = { lock: 1, pick: 0.7, lean: 0.3, pass: 0 };

/**
 * Spread sides cap far below their moneyline equivalent. The engine's own
 * finding: its spread picks cover about half the time whatever tier the game
 * carries — "spread sides are always leans" — so an ATS agreement is worth a
 * nudge and never more.
 */
export const SPREAD_MAX_MAGNITUDE = 0.35;

/**
 * A book's number has to be close to the one the model priced against for its
 * spread call to transfer. Half a point either way is line shopping; two
 * points is a different bet, and at that distance the model's side may well
 * have flipped.
 */
export const SPREAD_POINT_TOLERANCE = 1;

/**
 * How far the model may sit above the price before its agreement stops
 * counting. Below START the signal is at full strength; from there it fades
 * linearly to nothing at FULL. Both numbers come from the engine's own
 * bucketing of model-minus-market probability against realised return: the
 * bucket where they roughly agree was about breakeven, and the two most
 * disagreeable ones were catastrophic.
 */
export const DISAGREEMENT = { START: 0.05, FULL: 0.15 };

/**
 * A feed game and an odds-board event have to be the same fixture, not just
 * the same two teams — college programmes meet again in a conference title
 * game, and the feed carries two weeks at once. Three days is wider than any
 * kickoff-time move and far narrower than a rematch.
 */
export const KICKOFF_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How the app's own form/injury/EPA signal and this one are combined when
 * both exist. The engine is a fitted, walk-forward-calibrated model of who
 * wins the game and gets the larger share; docs/qualitative.js's team signal
 * is a three-part heuristic over ESPN form, unavailability and EPA that the
 * engine does not have a view on (it reads different data). Neither is
 * discarded — that would throw away real evidence in favour of a preference.
 */
export const GRIDIRON_BLEND_WEIGHT = 0.6;

/* ── Team matching ──────────────────────────────────────────────────── */

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeTeam(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether two team names are the same team.
 *
 * Both sources name teams the same way in the ordinary case — the feed
 * publishes display names with mascots ("Seattle Seahawks", "Rutgers Scarlet
 * Knights"), which is how the odds market writes them too — so the common
 * path is plain equality. The tolerance beyond that is token containment, for
 * the qualifier one source carries and the other does not ("Miami Hurricanes"
 * / "Miami FL Hurricanes").
 *
 * Deliberately NOT tolerant of a partial word or a shared mascot: "Michigan
 * Wolverines" and "Michigan State Spartans" share a token and are different
 * programmes, and attaching one team's model read to another's game is worse
 * than attaching none. Anything this cannot resolve returns false, and the
 * candidate keeps its price-only score.
 */
export function teamsMatch(a, b) {
  const left = normalizeTeam(a);
  const right = normalizeTeam(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  const [small, large] = leftTokens.size <= rightTokens.size
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  // one name's words all appear in the other's, and the shorter one is not a
  // bare single word ("Miami" alone must not match "Miami Hurricanes" — that
  // is two different programmes on a college board)
  if (small.size < 2) return false;
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

/** Whether a feed game and a board candidate are the same fixture. */
export function gameMatches(game, candidate) {
  if (!game || !candidate) return false;
  if (game.sport_key !== candidate.sportKey) return false;

  const sameOrder = teamsMatch(game.home, candidate.home) && teamsMatch(game.away, candidate.away);
  // A neutral-site game can be listed with the sides the other way round;
  // both names still have to match, so this cannot pull in a different game.
  const swapped = teamsMatch(game.home, candidate.away) && teamsMatch(game.away, candidate.home);
  if (!sameOrder && !swapped) return false;

  const kickoff = Date.parse(game.kickoff ?? '');
  const commence = Number(candidate.commenceMs);
  if (Number.isFinite(kickoff) && Number.isFinite(commence)) {
    if (Math.abs(kickoff - commence) > KICKOFF_TOLERANCE_MS) return false;
  }
  return true;
}

/** The feed's entry for a candidate's game, or null. */
export function findGridironGame(feed, candidate) {
  if (!feed?.games?.length || !isFootball(candidate?.sportKey)) return null;
  return feed.games.find((game) => gameMatches(game, candidate)) ?? null;
}

/* ── Signal ─────────────────────────────────────────────────────────── */

/**
 * The damping factor for how far the model sits above the price, 1 down to 0.
 * A model that merely agrees with the market keeps its full say; one that
 * likes a side substantially more than the price does loses it, because that
 * is the exact region the engine's own tracking measures as its worst.
 *
 * `gap` is the feed's own signed model-minus-implied number. A NEGATIVE gap
 * (the price is more confident than the model) is not damped: nothing in the
 * engine's tracking says agreement-with-a-shorter-price does badly, and the
 * side is the same side either way.
 */
export function agreementFactor(gap) {
  if (!Number.isFinite(gap) || gap <= DISAGREEMENT.START) return 1;
  if (gap >= DISAGREEMENT.FULL) return 0;
  return 1 - (gap - DISAGREEMENT.START) / (DISAGREEMENT.FULL - DISAGREEMENT.START);
}

function tierMagnitude(tier) {
  return TIER_MAGNITUDE[String(tier ?? '').toLowerCase()] ?? 0;
}

/**
 * The -1..1 signal for one football candidate, or null.
 *
 * Moneylines read the feed's moneyline pick, spreads its spread pick. The
 * magnitude is the tier's, damped by how far the model strays above the price
 * (agreementFactor) when the candidate IS the model's side; an opposed
 * candidate takes the tier magnitude as a straight negative — a model this
 * confident in the other team is a caution about this one, and there is no
 * "disagreement bonus" to damp.
 *
 * Totals return null on purpose. The feed projects a scoreline, but the
 * engine publishes no totals record at all — nothing says how often that
 * projection beats a posted total — so it appears as research on the card
 * (see insights.js) and never as a grade. Anything else (props, alternate
 * markets) returns null for the same reason: the feed has no entry shaped
 * like it.
 */
export function gridironSignal(feed, candidate) {
  const game = findGridironGame(feed, candidate);
  if (!game) return null;
  // Feed v2 publishes every game the engine lists, including early leans made
  // more than a week out with no injury report behind them (`stage:
  // "pending"`). Those are the engine's read, but not yet its pick — its own
  // release rules withhold them from the tracker for exactly that reason —
  // so they reach the card as context (see gridironRecord) and never the
  // grade. Scoring a pre-injury-report lean would be betting on a number the
  // engine itself says will move.
  if (game.stage === 'pending') return null;

  if (candidate.marketKey === 'h2h') {
    const pick = game.moneyline;
    if (!pick?.selection) return null;
    const magnitude = tierMagnitude(pick.tier);
    if (!magnitude) return null;   // a Pass is the model declining to bet

    const aligned = teamsMatch(candidate.outcomeName, pick.selection);
    const opponent = candidate.outcomeName === candidate.home ? candidate.away : candidate.home;
    // The model's side must be one of the two teams; if it is neither, say
    // nothing rather than guess which way the read points.
    if (!aligned && !teamsMatch(opponent, pick.selection)) return null;

    const strength = aligned
      ? magnitude * agreementFactor(pick.agreement?.gap)
      : magnitude;
    return { signal: clamp(aligned ? strength : -strength, -1, 1), aligned, game, pick, market: 'h2h' };
  }

  if (candidate.marketKey === 'spreads') {
    const pick = game.spread;
    if (!pick?.selection || !Number.isFinite(Number(pick.point))) return null;
    const aligned = teamsMatch(candidate.outcomeName, pick.selection);
    const opponent = candidate.outcomeName === candidate.home ? candidate.away : candidate.home;
    if (!aligned && !teamsMatch(opponent, pick.selection)) return null;

    // The model priced its call against a specific number. The board's own
    // number for the same side has to be close to it, or this is a different
    // bet than the one the engine graded.
    const modelPoint = Number(pick.point);
    const boardPoint = Number(candidate.point);
    if (!Number.isFinite(boardPoint)) return null;
    const sameSidePoint = aligned ? modelPoint : -modelPoint;
    if (Math.abs(boardPoint - sameSidePoint) > SPREAD_POINT_TOLERANCE) return null;

    const magnitude = Math.min(tierMagnitude(pick.tier), SPREAD_MAX_MAGNITUDE);
    if (!magnitude) return null;
    return { signal: clamp(aligned ? magnitude : -magnitude, -1, 1), aligned, game, pick, market: 'spreads' };
  }

  return null;
}

/**
 * Blend the app's own qualitative signal with the engine's. Either may be
 * null; the result is null only when both are.
 */
export function blendGridironSignal(teamSignal, gridSignal) {
  const a = Number.isFinite(teamSignal) ? teamSignal : null;
  const b = Number.isFinite(gridSignal) ? gridSignal : null;
  if (a == null && b == null) return null;
  if (a == null) return clamp(b, -1, 1);
  if (b == null) return clamp(a, -1, 1);
  return clamp(GRIDIRON_BLEND_WEIGHT * b + (1 - GRIDIRON_BLEND_WEIGHT) * a, -1, 1);
}

/* ── Sizing: the one condition under which a Lock has paid ──────────── */

/**
 * How much better than the engine's own line the board's best price has to
 * be before a Lock moneyline earns extra units.
 *
 * Measured on the engine's 535 graded Lock moneylines (2023-25): at the line
 * the engine grades against they return -0.74%; at a price 1% better (in
 * decimal terms) they break even, and at 2% better they return +1.25%, with
 * college Locks positive in every one of the three seasons. No sizing rule
 * on its own gets there — the confident tiers lose less than the rest, but
 * they still pay the vig — so extra size is tied to the one thing that
 * actually moved the record: the price. A Lock at the engine's own number
 * or worse sizes like any other pick.
 *
 * At a typical Lock price this is small in American terms — 1% better than
 * -400 is about -381 — which is exactly the gap line-shopping across eight
 * books tends to find and the engine, grading one line, never sees.
 */
export const LOCK_PRICE_EDGE = { TWO_UNITS: 0.01, THREE_UNITS: 0.02 };

/** American odds -> decimal, or null for anything that is not a real price. */
export function americanToDecimalOrNull(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || Math.abs(a) < 100) return null;
  return a < 0 ? 1 + 100 / -a : 1 + a / 100;
}

/**
 * How much better (or worse) the board's price is than the engine's, as a
 * fraction of decimal odds: +0.02 means the bettor is paid 2% more per unit
 * than the line the engine graded. Null when either side has no real price.
 */
export function priceEdgeVsEngine(candidate, pick) {
  const board = Number(candidate?.decimal);
  const engine = americanToDecimalOrNull(pick?.price);
  if (!Number.isFinite(board) || board <= 1 || engine == null) return null;
  return board / engine - 1;
}

/**
 * The minimum units a football candidate should carry on the strength of the
 * engine's read, or null when it has not earned one: a Lock moneyline on the
 * engine's own side whose board price beats the engine's line by
 * LOCK_PRICE_EDGE. Two units at 1% better, three at 2% better. Every other
 * case — a Pick, a Lean, a spread, the other side, a Lock at a worse price —
 * returns null and sizes on the app's own score as it always has.
 *
 * The board's stake band still caps the result where it applies (Pixel's
 * Picks top out at 2.5u); this is a floor, never an override of the ceiling.
 */
export function lockStakeFloor(candidate, match) {
  if (!match || match.market !== 'h2h' || !match.aligned) return null;
  if (String(match.pick?.tier ?? '').toLowerCase() !== 'lock') return null;
  const edge = priceEdgeVsEngine(candidate, match.pick);
  if (edge == null) return null;
  if (edge >= LOCK_PRICE_EDGE.THREE_UNITS) return 3;
  if (edge >= LOCK_PRICE_EDGE.TWO_UNITS) return 2;
  return null;
}

/**
 * The feed entry flattened into what the UI renders, with `scored` saying
 * honestly whether it moved this candidate's grade. A totals candidate on a
 * game the engine covers gets the record with scored: false — the projected
 * scoreline is real context for that game, and claiming it graded the total
 * would not be.
 */
export function gridironRecord(game, feed, { market = null, aligned = null, signal = null, scored = false, priceEdge = null, stakeFloor = null } = {}) {
  if (!game) return null;
  const pick = market === 'spreads' ? game.spread : game.moneyline;
  return {
    league: game.league,
    weekLabel: game.week_label ?? null,
    url: game.url ?? null,
    stage: game.stage ?? null,
    locked: Boolean(game.locked),
    lockReason: game.lock_reason ?? null,
    waitingOn: game.waiting_on ?? null,
    selection: pick?.selection ?? null,
    tier: pick?.tier ?? null,
    tierLabel: game.moneyline?.tier_label ?? null,
    prob: pick?.prob ?? null,
    price: pick?.price ?? null,
    point: market === 'spreads' ? (pick?.point ?? null) : null,
    gap: pick?.agreement?.gap ?? null,
    impliedProb: pick?.agreement?.implied_prob ?? null,
    modelLine: game.model?.line ?? null,
    projectedScore: game.model?.projected_score ?? null,
    analysis: game.analysis ?? null,
    aligned,
    signal,
    scored,
    // How the board's best price compares to the engine's line, and the unit
    // floor that comparison earned (see lockStakeFloor) — null unless this is
    // a Lock moneyline on the engine's side at a better price.
    priceEdge,
    stakeFloor,
    generatedAt: feed?.generated_at ?? null,
    disclosure: feed?.disclosure ?? null,
  };
}

/**
 * The record for a candidate's GAME whatever its market — what the stats
 * drawer shows, since it opens on the best-scoring candidate of the three
 * markets, which may well be the total the signal deliberately skipped.
 */
export function gameGridironRecord(feed, candidate) {
  const game = findGridironGame(feed, candidate);
  return game ? gridironRecord(game, feed) : null;
}

/**
 * Re-score every football candidate the feed speaks to, attaching what was
 * found as `gridiron` so the UI can show its work. Every other candidate
 * passes through untouched. Returns a new array; never mutates the input.
 *
 * `scoreFor` is how a caller re-grades one candidate under a signal —
 * scoreCandidate's own `qualitative` option, so the swing lands inside the
 * generic ±QUALITATIVE.MAX_SWING clamp rather than beside it. Passed in
 * rather than imported so the browser's live board and the worker's locked
 * picks can each supply their own `now`.
 */
export function applyGridironFeed(candidates, feed, scoreFor) {
  if (!feed?.games?.length) return candidates;
  return candidates.map((c) => {
    if (!isFootball(c.sportKey)) return c;
    const match = gridironSignal(feed, c);
    if (!match) {
      const game = findGridironGame(feed, c);
      // Covered game, market the engine has no view on (a total): carry the
      // record for the card, change nothing about the grade.
      return game ? { ...c, gridiron: gridironRecord(game, feed) } : c;
    }
    const enriched = {
      ...c,
      gridiron: gridironRecord(match.game, feed, {
        market: match.market,
        aligned: match.aligned,
        signal: match.signal,
        scored: true,
        priceEdge: priceEdgeVsEngine(c, match.pick),
        stakeFloor: lockStakeFloor(c, match),
      }),
    };
    return Object.assign(enriched, scoreFor(enriched, match.signal));
  });
}

/* ── Feed fetching ──────────────────────────────────────────────────── */

let feedCache = null;
let feedFetchedAt = 0;
let inFlight = null;
export const FEED_TTL_MS = 5 * 60 * 1000;

/**
 * The last feed successfully fetched, or null before the first one lands.
 * Synchronous, for the same reason capper-consensus.js's is: the stats drawer
 * paints without awaiting anything, and a game's engine read should be in
 * that paint or not at all.
 */
export function cachedGridironFeed() {
  return feedCache;
}

/**
 * Fetch the feed, cached for five minutes — the engine rebuilds twice an
 * hour, and a pick locking inside the two-hour window is the one change worth
 * catching quickly. Every real request is cache-busted (`?t=` plus
 * `cache: 'no-store'`), because GitHub Pages' CDN will otherwise keep serving
 * the pre-build body long after a run finished.
 *
 * Returns the last good feed — or null if there has never been one — on any
 * failure. A football candidate's price-only score always stands on its own.
 *
 * A request already in flight is shared rather than duplicated. Unlike the
 * MMA feed, which one caller fetches for the whole board, this one is asked
 * for per candidate — a Sunday NFL slate re-scoring means dozens of
 * simultaneous calls, and without this each would open its own request for
 * the same file.
 */
export async function fetchGridironFeed(
  url = GRIDIRON_FEED_URL,
  { now = Date.now(), force = false } = {},
) {
  if (!force && feedCache && now - feedFetchedAt < FEED_TTL_MS) return feedCache;
  if (inFlight) return inFlight;
  const busted = `${url}${url.includes('?') ? '&' : '?'}t=${now}`;
  inFlight = (async () => {
    try {
      const res = await fetch(busted, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) return feedCache;
      const feed = await res.json();
      if (!Array.isArray(feed?.games)) return feedCache;
      feedCache = feed;
      feedFetchedAt = now;
      return feed;
    } catch {
      return feedCache;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
