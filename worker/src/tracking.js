/**
 * Server-side Pixel's Picks daily tracked picks (internally still named
 * "Top 5" throughout this file/KV keys — the count/timing changed, the name
 * didn't, to avoid a wide rename across every call site): a 2am ET batch
 * that runs the existing engine (unmodified — same topPicks()) against the
 * full slate and stores the result in KV so it survives independent of any
 * one user's browser and never changes after the fact — this is now the
 * single source of truth the Pixel's Picks tab itself renders (docs/app.js's
 * loadPixelPicks()), not just a background tracker; an hourly CLV snapshot
 * for whatever's still pending; and a grading pass (also hourly, not just at
 * a single nightly instant — see runGrading's own note) that fetches scores
 * and grades via the exact same gradePick() the client's own "Check
 * Results" button uses.
 *
 * The EV/Kelly/score floor isn't the fixed docs/engine.js RULES constant
 * anymore — it's read fresh from worker/src/algo-health.js's getAlgoConfig()
 * on every run, which starts at exactly those RULES defaults and can only
 * ever be tightened (never loosened below them) by the weekly algorithm
 * health review. Candidates in a segment that review has paused are also
 * excluded here, before topPicks() ever sees them.
 *
 * This is deliberately a *second*, independent tracking record from the
 * browser-local IndexedDB one in docs/learning.js — that one is per-device
 * and stays that way; this one exists specifically so Pixel's Picks has a
 * single, server-side, always-on history that doesn't depend on anyone
 * having the app open.
 */
import { analyze, topPicks, clearsMaxJuice } from '../../docs/engine.js';
import { isPower4Matchup } from '../../docs/ncaaf-conferences.js';
import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { CONFIG } from '../../docs/config.js';
import { fetchSport, fetchScores, fetchCatalogue, UPSTREAM, REGIONS, DEFAULT_CACHE_SECONDS } from './odds.js';
import { getAlgoConfig, getPausedSegments, isSegmentPaused } from './algo-health.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import {
  tennisTier,
  dedupeTennisEvents,
  isMarketAllowedForTier,
  tierLiquidityBlock,
  hasSecondarySettlementSource,
} from '../../docs/tennis-tiers.js';
import { settleTennisGameMarket } from './tennis-results.js';

export const TOP5_COUNT = 5;
// Matches docs/learning.js's own FLAT_UNIT_STAKE — duplicated rather than
// imported because that module's exported constant sits alongside
// IndexedDB-touching functions this file never calls; importing just the
// one pure function (gradePick) and this one number keeps the boundary
// between "browser-only" and "safe to run in the Worker" obvious at a
// glance rather than relying on nothing-happens-to-call-the-unsafe-part.
const FLAT_UNIT_STAKE = 20;
const KV_TTL_SECONDS = 86400 * 90; // 90 days — long enough for weeks of calibration data, not forever

const FIXED_SPORT_KEYS = [
  'baseball_mlb',
  'americanfootball_nfl',
  'americanfootball_ncaaf',
  'basketball_wnba',
  'mma_mixed_martial_arts',
  'soccer_usa_mls',
  'icehockey_nhl',
];

/** ET calendar date (YYYY-MM-DD) for a given instant — the day boundary every tracked pick is keyed on. */
function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** ET wall-clock hour for a given instant, DST-safe (same approach as index.js's own etHour / potd.js's etParts). */
function etHour(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  return Number(fmt.format(ms)) % 24;
}

// How far into the next calendar day a fight still counts as "tonight's
// card" for Pixel's Picks — a main event can start after midnight local
// time and still be part of the same show that started at a normal hour.
// Matches docs/app.js's own (now-removed) client-side isPixelPicksMmaFight —
// ported here since Pixel's Picks is now selected once, server-side, rather
// than re-filtered live on every client render.
const MMA_NEXT_DAY_CUTOFF_HOUR = 6;

/**
 * MMA cards get announced and sell tickets weeks out, so every other part of
 * this app (Full Slate, Parlay Builder) shows them on a much longer horizon
 * — but Pixel's Picks should never surface a pick for a fight that isn't
 * actually happening soon. Eligible if it starts on today's ET calendar
 * date, or before MMA_NEXT_DAY_CUTOFF_HOUR the morning after (a late main
 * event that started on-schedule but rolled past midnight).
 */
function isEligibleMmaFight(commenceMs, now) {
  const today = etDate(now);
  const commenceDate = etDate(commenceMs);
  if (commenceDate === today) return true;
  const tomorrow = etDate(now + 86400000);
  return commenceDate === tomorrow && etHour(commenceMs) < MMA_NEXT_DAY_CUTOFF_HOUR;
}

// How far into the next calendar day a tennis match still counts as part of
// tonight's round for Pixel's Picks — same idea and same value as MMA's own
// MMA_NEXT_DAY_CUTOFF_HOUR above, for the same reason: a night session match
// can roll past midnight ET and still be part of the round already
// underway. Deliberately NOT the "eligible all day tomorrow" window this
// used to be — that let a match scheduled for a completely ordinary
// tomorrow-afternoon start time (e.g. 3pm ET the next day) onto a board
// that's supposed to be today's picks, which read as a real bug even though
// the Odds API genuinely does split some rounds across two calendar days.
const TENNIS_NEXT_DAY_CUTOFF_HOUR = 6;

/**
 * A tennis round can still be running past midnight ET (a night session
 * pushed late, or simply a late start), and the Odds API only ever lists
 * the round that's actually been drawn — the next round's matchups don't
 * exist in the feed at all until the current one finishes — so there's no
 * risk of this reaching into a future round early. Eligible if it starts
 * today, or before TENNIS_NEXT_DAY_CUTOFF_HOUR tomorrow morning (a match
 * that rolled just past midnight); NOT eligible for an ordinary tomorrow-
 * afternoon start, which belongs on tomorrow's board, not today's.
 */
function isEligibleTennisMatch(commenceMs, now) {
  const today = etDate(now);
  const commenceDate = etDate(commenceMs);
  if (commenceDate === today) return true;
  const tomorrow = etDate(now + 86400000);
  return commenceDate === tomorrow && etHour(commenceMs) < TENNIS_NEXT_DAY_CUTOFF_HOUR;
}

/**
 * How long before a game's own commence time its pick is worth locking in
 * for tracked history — a sport-tuned lead time, not one global hour for
 * the whole slate. Team sports wait for roughly the point where the pieces
 * that actually move a sharp line (starting lineup/pitcher, late injury
 * news, weather) are meaningfully known; individual sports (tennis, MMA)
 * have no comparable "lineup" concept, so their price would be about as
 * final an hour out as it is a day out on data grounds alone — but every
 * value here has a SECOND floor on top of that: index.js's notification
 * logic promises opted-in users at least an hour's email notice before a
 * locked pick's game starts, and checks run hourly, so a lock can land
 * anywhere up to ~1h after its own window opens before the next tick
 * catches it. Every lead time here is set so that even in that worst case
 * (lead_hours − 1h of tick slack), there's still comfortable daylight
 * above the 2h "notify now, waiting further risks missing the 1h floor"
 * threshold (see NOTIFY_URGENCY_HOURS in index.js) — which is also what
 * makes bundling every locked pick into one "board's complete" email the
 * common case rather than the exception. Every value here is a judgment
 * call, not a measured optimum.
 */
const PICK_LEAD_HOURS = {
  baseball_mlb: 3,
  americanfootball_nfl: 3,
  americanfootball_ncaaf: 3,
  basketball_wnba: 3,
  icehockey_nhl: 3,
  soccer_usa_mls: 2.5,
  mma_mixed_martial_arts: 2.5,
};
// Any sport not listed above — a conservative default rather than no wait at all.
const DEFAULT_LEAD_HOURS = 2.5;

function leadHoursFor(sportKey) {
  // Tennis has no lineup-style factor to wait on for data-quality reasons,
  // but still needs the same notification-safety floor as everything else
  // — see PICK_LEAD_HOURS's own comment.
  if (isTennis(sportKey)) return 2.5;
  return PICK_LEAD_HOURS[sportKey] ?? DEFAULT_LEAD_HOURS;
}

/**
 * Whether a candidate's own game is now close enough to lock its pick in
 * for tracked history (Full Slate) or to be eligible to claim a Pixel's
 * Picks/Play of the Day slot (see runTop5Batch/potd.js's runPotdDaily) —
 * see PICK_LEAD_HOURS for the per-sport reasoning. This is checked in
 * ADDITION to (not instead of) each tracker's existing "is this today's
 * game" eligibility window — a candidate must be both today's (or
 * tomorrow-early, for tennis/MMA's own carve-outs) AND past its own lead
 * time before it's lockable.
 */
export function isPickWindowOpen(candidate, now) {
  return now >= candidate.commenceMs - leadHoursFor(candidate.sportKey) * 3600000;
}

/**
 * Every raw sport key the client's own League Groups cover: the fixed keys
 * plus whatever tennis_atp_/tennis_wta_ tournaments the catalogue says are
 * live this week — the same "discover, don't hardcode" approach the
 * client's own populateTennisGroups() uses, so a tour switching tournaments
 * doesn't silently drop tennis from the batch.
 */
async function fullSlateSportKeys(env, ctx) {
  const { sports } = await fetchCatalogue(env, ctx);
  const tennisKeys = (sports ?? [])
    .map((s) => s.key)
    .filter((k) => k.startsWith('tennis_atp_') || k.startsWith('tennis_wta_'));
  return [...FIXED_SPORT_KEYS, ...tennisKeys];
}

// MLS's low-variance alternative markets (docs/soccer-markets.js) — not
// part of the shared MARKETS constant every other sport's featured pull
// uses, since requesting them for every sport would spend credits on
// markets no other sport prices. A second, small featured-endpoint call
// scoped to MLS alone (2 markets x 1 region = 2 credits), merged onto the
// matching MLS events by book before analyze() ever sees them — so BTTS/
// double-chance flow through the exact same generic candidate-building and
// selection pipeline every other market already does, no special-casing
// needed downstream. fetchFullSlateEvents only runs ~1-2x/day in practice
// (see its callers), so this stays negligible.
const MLS_EXTRA_MARKETS = 'btts,double_chance';

async function fetchMlsExtraMarkets(env, ctx) {
  const ttl = Number(env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  const cacheKey = new Request(`https://pixel-pick.cache/odds/soccer_usa_mls?markets=${MLS_EXTRA_MARKETS}&regions=${REGIONS}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${UPSTREAM}/sports/soccer_usa_mls/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', MLS_EXTRA_MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  try {
    const upstream = await fetch(url.toString());
    if (!upstream.ok) return [];
    const body = await upstream.text();
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    })));
    return JSON.parse(body);
  } catch {
    return [];
  }
}

/** Merges each MLS event's extra-market bookmaker entries into the matching base event, by book key, appending rather than replacing that book's existing markets. */
function mergeExtraMarkets(baseEvents, extraEvents) {
  const extraById = new Map(extraEvents.map((e) => [e.id, e]));
  for (const event of baseEvents) {
    const extra = extraById.get(event.id);
    if (!extra) continue;
    for (const extraBook of extra.bookmakers ?? []) {
      let book = event.bookmakers?.find((b) => b.key === extraBook.key);
      if (!book) {
        book = { key: extraBook.key, title: extraBook.title, last_update: extraBook.last_update, markets: [] };
        event.bookmakers = event.bookmakers ?? [];
        event.bookmakers.push(book);
      }
      book.markets.push(...(extraBook.markets ?? []));
    }
  }
  return baseEvents;
}

/** Every event across the full slate, merged — sports that failed to fetch just contribute nothing rather than failing the whole batch. */
export async function fetchFullSlateEvents(env, ctx) {
  const keys = await fullSlateSportKeys(env, ctx);
  const results = await Promise.all(keys.map((k) => fetchSport(k, env, ctx)));
  const events = [];
  for (const r of results) {
    if (r.events) events.push(...r.events);
  }
  if (keys.includes('soccer_usa_mls')) {
    mergeExtraMarkets(events, await fetchMlsExtraMarkets(env, ctx));
  }
  // Collapse co-sanctioned / renamed tennis listings (Canadian Open ==
  // National Bank Open == ATP Montreal) to one event apiece. The existing
  // by-event-id dedupe elsewhere can't catch these: the same match arrives
  // under DIFFERENT ids when it's listed under two names.
  return dedupeTennisEvents(events);
}

/**
 * Exported so worker/src/full-slate-tracking.js can reuse the exact same
 * record shape — the specific field list here (pickId/dateKey/eventId/
 * sportKey/marketKey/consensusProb/clv/meetsStandard/etc) is what every
 * shared dashboard rendering helper (groupTop5ByDay, renderTop5DayBlock,
 * summarizePicks, top5ClvPct) depends on; duplicating this mapping in a
 * second file would risk the two trackers' records silently drifting apart.
 */
export function pickRecordFrom(pick, dateKey, now) {
  const leg = pick.legs[0];
  return {
    pickId: leg.id,
    dateKey,
    eventId: leg.eventId,
    sportKey: leg.sportKey,
    home: leg.home,
    away: leg.away,
    // MMA-only card enrichment, carried from analyze()'s candidate (see
    // docs/engine.js) — undefined for every non-MMA pick. Lets the client
    // group a fight under its real UFC/PFL card even in a session that
    // never saw it while still priced (see docs/app.js's buildSlateGames
    // trackedOnlyGames tier), since the Odds API drops this enrichment
    // along with the fight's market the moment it starts.
    ufc_event: leg.ufc_event,
    marketKey: leg.marketKey,
    outcomeName: leg.outcomeName,
    point: leg.point ?? null,
    selection: leg.selection,
    american: leg.american,
    decimal: leg.decimal,
    book: leg.book,
    score: pick.score,
    // Daily-learning provenance (worker/src/daily-learning.js): when a
    // learned reliability weight adjusted this candidate's score before
    // selection, rawScore is the engine's unadjusted grade and learnWeight
    // the multiplier applied. Both null when no learning touched it. Stored
    // so "did the learning layer actually help" stays measurable — the
    // record shows what the engine said AND what the learner did to it.
    rawScore: leg.rawScore ?? null,
    learnWeight: leg.learnWeight ?? null,
    // Operational tier (docs/tennis-tiers.js) — TIER_1 / TIER_2 /
    // TIER_CHALLENGER for tennis, null for every other sport. Stored so the
    // tracked record can be sliced by tier later without re-deriving it from
    // a sport key whose tournament may no longer be in the catalogue.
    tier: tennisTier(leg.sportKey) ?? null,
    // The model's own estimated win probability (already computed by
    // scoreCandidate() as the no-vig consensus, excluding the best-price
    // book so the price we're grading doesn't vote on its own fairness) —
    // stored so the calibration report can compare it against actual
    // outcome frequency (a real Brier score), rather than only having the
    // 0-100 composite score, which blends in liquidity/agreement/freshness
    // and isn't itself a probability.
    consensusProb: leg.consensusProb,
    commenceMs: leg.commenceMs,
    suggested_stake: FLAT_UNIT_STAKE,
    generatedAt: now,
    status: 'pending',
    clv: { openAmerican: leg.american, closeAmerican: leg.american, updatedAt: now },
    result: null,
    // Whether this pick actually cleared the sharp standard, or is a
    // guaranteeCount() fallback filling out the board on a thin day (see
    // docs/engine.js's topPicks()) — callers computing win-rate/ROI/CLV
    // summaries must exclude flagged picks; the day-by-day history still
    // shows them, just visibly marked with flagReason.
    meetsStandard: pick.meetsStandard,
    flagReason: pick.flagReason ?? null,
  };
}

/**
 * Snapshots every newly-lockable, structurally-eligible candidate into
 * today's Top5 accumulation pool — same mechanism and same reasoning as
 * potd.js's updatePotdPool: an early game's odds vanish once it starts,
 * long before an evening game's own window even opens, so comparing the
 * whole day's candidates fairly means freezing each one's data the moment
 * it becomes trustworthy rather than re-reading live prices later. Stores
 * the raw candidate (score/EV/Kelly/odds-band filtering happens once, at
 * final-selection time in runTop5Batch, against the pool — not here).
 */
async function updateTop5Pool(env, ctx, dateKey, lockable, now) {
  const poolKey = `track:${dateKey}:pool`;
  const raw = await env.POTD_KV.get(poolKey);
  const pool = raw ? JSON.parse(raw) : { date: dateKey, entries: [] };
  const known = new Set(pool.entries.map((e) => e.id));
  const fresh = lockable.filter((c) => !known.has(c.id));
  if (!fresh.length) return pool;
  pool.entries.push(...fresh.map((c) => ({ ...c, capturedAt: now })));
  ctx.waitUntil(env.POTD_KV.put(poolKey, JSON.stringify(pool), { expirationTtl: KV_TTL_SECONDS }));
  return pool;
}

/**
 * Runs hourly (see index.js's scheduled()), all day — not a single 2am
 * batch anymore. Every structurally-eligible candidate (day window, segment
 * not paused, tennis tier, max-juice, NCAAF Power 4) whose own game has
 * reached its own reasonable pre-game lock time (isPickWindowOpen/
 * PICK_LEAD_HOURS) gets captured into today's pool the moment it's first
 * seen (see updateTop5Pool). The 5 real slots aren't filled from that pool
 * immediately, though — same reasoning as Play of the Day's own pool (see
 * potd.js's runPotdDaily): locking a slot the instant something clears the
 * bar would bias toward an early-afternoon game over a stronger evening one
 * whose window just hasn't opened yet. Instead this waits until
 * stillUpcoming goes false (every one of today's eligible games has had its
 * own window open, so the pool is as complete as it's going to get), then
 * runs the existing, unmodified topPicks() — same sharp standard (-250/+250,
 * confidence floor) and EV/Kelly edge floor as always — against whatever in
 * the pool is still actionable (hasn't started), filling as many of the
 * remaining slots as genuinely qualify. guaranteeCount only kicks in at
 * that same final moment, padding with a flagged (meetsStandard: false)
 * pick rather than shrinking below 5 on a thin day — never on an
 * intermediate tick, where padding would burn a slot a later game might
 * have earned instead. Once posted, a pick doesn't move even if the market
 * does — it's an editorial call made at a point in time, not a live-
 * repriced one.
 *
 * Self-healing, not one-shot: this used to hard-skip the instant a manifest
 * existed at all, which meant a degraded run (e.g. a partial/truncated
 * full-slate fetch from a Cloudflare subrequest hiccup) could lock in fewer
 * than TOP5_COUNT picks for the rest of the day with no way to recover — a
 * real incident this exact code hit once already. Now it only skips once the
 * board actually has TOP5_COUNT picks; short of that, it tops up around
 * whatever's already stored (excluding those pickIds from the fresh
 * candidate pool so nothing gets picked twice) rather than replacing it, so
 * an already-tracked pick's grading/CLV state is never discarded. Cheap to
 * call every tick regardless: the manifest read is a single KV get, and the
 * real full-slate fetch only happens when the board is actually short.
 */
export async function runTop5Batch(
  env,
  ctx,
  now = Date.now(),
  // Injected for testability, same reasoning as potd.js's runPotdDaily
  // taking fetchFullSlate as a parameter — lets tests supply a fixed event
  // list instead of needing to mock the network.
  { fetchFullSlate = () => fetchFullSlateEvents(env, ctx) } = {},
) {
  const dateKey = etDate(now);
  const manifestKey = `track:${dateKey}:top5`;
  const existingRaw = await env.POTD_KV.get(manifestKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;
  const existingPickIds = existing?.pickIds ?? [];
  const needed = TOP5_COUNT - existingPickIds.length;
  if (needed <= 0) return { skipped: true, reason: 'already generated today', dateKey };

  // The weekly algorithm health review (worker/src/algo-health.js) can
  // tighten these floors within pre-approved bounds, and can pause a
  // sport+bet-type segment entirely, based on that segment's real graded
  // history — both read fresh here so a Monday-morning review takes effect
  // on the very next batch, not just future ones.
  const [algoConfig, pausedSegments, learningProfile] = await Promise.all([
    getAlgoConfig(env),
    getPausedSegments(env),
    // The daily learning review's reliability weights (worker/src/
    // daily-learning.js), refreshed each morning before this batch runs —
    // multiplied into candidate scores below so a segment or odds band
    // that's been misfiring needs a visibly better number to make the
    // board. The Full Slate tracker deliberately does NOT read this: it
    // keeps recording the unadjusted engine so tomorrow's learning is
    // drawn from unbiased evidence.
    getLearningProfile(env),
  ]);

  const events = await fetchFullSlate();
  // Team sports post odds for games weeks or months out (an NFL regular-
  // season line can go up in August) — without this, "today's locks" could
  // silently include a game that isn't happening for months. Restricted to
  // today's ET calendar date, same day boundary the pick itself is stored
  // under; MMA and tennis each keep their own separate today-or-tomorrow
  // window (see isEligibleMmaFight/isEligibleTennisMatch) since a late MMA
  // main event can roll past midnight and a tennis round routinely spans
  // two calendar days.
  // A candidate's own id is always `${eventId}:${marketKey}|...` (see
  // docs/engine.js's analyze()) — the event id is everything before the
  // first colon. Topping up must exclude every candidate from a game that
  // already has a stored pick, not just that exact leg: topPicks() below
  // only ever protects against picking both sides of the same game within
  // ONE of its own calls (its own usedLegs/contradicts check, scoped to a
  // single invocation) — it has no memory of a previous call's picks. Without
  // this, a topped-up board could legitimately contain "Team A to win" from
  // the first run and "Team B to win" (the same game's other side) from a
  // later top-up run — a real incident this exact gap produced live
  // (Pittsburgh Pirates AND New York Mets both picked to win the same game).
  const existingEventIds = new Set(existingPickIds.map((id) => id.split(':')[0]));
  const eligibleToday = applyLearningToCandidates(
    analyze(events, { now })
      .filter((c) => {
        if (isMma(c.sportKey)) return isEligibleMmaFight(c.commenceMs, now);
        if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
        return etDate(c.commenceMs) === dateKey;
      })
      .filter((c) => !isSegmentPaused(c, pausedSegments))
      // Tennis tier policy (docs/tennis-tiers.js): lower-tier events are
      // moneyline-only, and must clear a book-count / line-dispersion /
      // staleness check before they're eligible at all. Non-tennis
      // candidates pass through untouched.
      .filter((c) => {
        const tier = tennisTier(c.sportKey);
        if (!tier) return true;
        if (!isMarketAllowedForTier(c.marketKey, tier)) return false;
        return !tierLiquidityBlock(c, tier, now);
      })
      // Low-variance markets (player props, MLS's BTTS/double-chance) get
      // their own tighter price ceiling — see docs/engine.js's
      // LOW_VARIANCE_MAX_AMERICAN. Every other market is untouched.
      .filter(clearsMaxJuice)
      // NCAAF: only Power 4 vs. Power 4 matchups (docs/ncaaf-conferences.js)
      // are eligible here — a Power 4 team's early-season buy game against a
      // Group-of-5/FCS opponent is exactly the lopsided, high-variance game
      // this app's low-variance framing exists to avoid. Every other sport
      // passes through untouched. Full Slate deliberately does NOT apply
      // this (see its own comment) — it stays the unfiltered raw record.
      .filter((c) => c.sportKey !== 'americanfootball_ncaaf' || isPower4Matchup(c.home, c.away))
      .filter((c) => !existingEventIds.has(c.eventId)),
    learningProfile,
  );

  // Split by whether each candidate's own game has reached its lock time —
  // see this function's own comment for why only "lockable" candidates get
  // captured into the pool this tick, and why the real slots wait for
  // stillUpcoming to go false before drawing from it.
  const lockable = eligibleToday.filter((c) => isPickWindowOpen(c, now));
  const stillUpcoming = eligibleToday.some((c) => !isPickWindowOpen(c, now));
  await updateTop5Pool(env, ctx, dateKey, lockable, now);

  if (stillUpcoming) {
    return { skipped: true, reason: "still comparing today's games", dateKey, added: 0 };
  }

  const poolRaw = await env.POTD_KV.get(`track:${dateKey}:pool`);
  const pool = poolRaw ? JSON.parse(poolRaw).entries : [];
  // Already-locked events are excluded same as the live eligibility filter
  // above (existingEventIds) — a pool entry can predate today's most recent
  // lock. Anything whose game has since started can't be posted anymore;
  // it stays in the pool's own history, just never becomes a real pick.
  const stillActionable = pool.filter((c) => c.commenceMs > now && !existingEventIds.has(c.eventId));

  const slate = topPicks(stillActionable, {
    count: needed,
    oddsMin: CONFIG.ODDS_MIN_DEFAULT,
    oddsMax: CONFIG.ODDS_MAX_DEFAULT,
    minScore: algoConfig.MIN_SCORE,
    minEv: algoConfig.MIN_EV_PCT,
    minKelly: algoConfig.MIN_KELLY_FRACTION,
    guaranteeCount: true,
  });

  // Belt-and-suspenders alongside the existingEventIds filter above: even
  // though topPicks() can't return two same-event candidates from a single
  // call, and the filter already stops it from seeing an event a prior call
  // already used, a same-game clash between two picks WITHIN slate.picks
  // itself would still be a real, visible contradiction on the board if it
  // ever happened — so it's checked here directly against the actual
  // eventIds, not assumed from the upstream filters holding. A leg whose
  // game is already spoken for (by an existing pick or an earlier leg in
  // this same slate) is dropped rather than written.
  const usedEventIds = new Set(existingEventIds);
  const newPickIds = [];
  for (const pick of slate.picks) {
    const eventId = pick.legs[0].eventId;
    if (usedEventIds.has(eventId)) continue;
    usedEventIds.add(eventId);
    const record = pickRecordFrom(pick, dateKey, now);
    newPickIds.push(record.pickId);
    ctx.waitUntil(
      env.POTD_KV.put(`track:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }

  const pickIds = [...existingPickIds, ...newPickIds];
  ctx.waitUntil(
    env.POTD_KV.put(manifestKey, JSON.stringify({ date: dateKey, generatedAt: now, pickIds }), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );

  return { skipped: false, dateKey, count: pickIds.length, added: newPickIds.length, poolSize: slate.poolSize };
}

async function loadTrackedPicks(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`track:${dateKey}:top5`);
  if (!manifestRaw) return { pickIds: [], picks: [] };
  const { pickIds } = JSON.parse(manifestRaw);
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`track:${dateKey}:pick:${id}`)));
  return { pickIds, picks: stored.filter(Boolean).map((r) => JSON.parse(r)) };
}

/**
 * Refresh the closing-line snapshot for whatever today's tracked picks are
 * still pending and not yet underway — the same "freshest price seen before
 * the game goes off the board" approximation docs/app.js's own
 * updateClvSnapshots() uses client-side, just running on a timer here
 * instead of on every Generate tap. Re-derives each pick's current price by
 * re-running analyze() on that sport's fresh events and matching by the
 * candidate id already stored as pickId — the same id scheme
 * buildCandidates() always produces for the same event/market/outcome/point,
 * so this needs no separate price-lookup logic of its own.
 */
export async function runClvSnapshot(
  env,
  ctx,
  now = Date.now(),
  { fetchSportFn = (s) => fetchSport(s, env, ctx) } = {},
) {
  const dateKey = etDate(now);
  const { picks } = await loadTrackedPicks(env, dateKey);
  const pending = picks.filter((p) => p.status === 'pending' && p.commenceMs > now);
  if (!pending.length) return { checked: picks.length, updated: 0 };

  const sportsNeeded = [...new Set(pending.map((p) => p.sportKey))];
  const fetched = await Promise.all(sportsNeeded.map((s) => fetchSportFn(s)));
  const candidatesBySport = new Map(
    sportsNeeded.map((s, i) => [s, analyze(fetched[i].events ?? [], { now })]),
  );

  let updated = 0;
  for (const pick of pending) {
    const fresh = (candidatesBySport.get(pick.sportKey) ?? []).find((c) => c.id === pick.pickId);
    if (!fresh || fresh.american === pick.clv.closeAmerican) continue;
    pick.clv = { ...pick.clv, closeAmerican: fresh.american, updatedAt: now };
    updated++;
    ctx.waitUntil(
      env.POTD_KV.put(`track:${dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }
  return { checked: picks.length, updated };
}

// How many ET calendar days back grading looks for still-pending picks —
// not just today's. A late MMA main event can still be "pending" well after
// the ET date has rolled over to tomorrow (a 10pm ET start plus prelims can
// run past 2am), and this pass used to only ever load today's dateKey's
// manifest — the instant the date rolled, last night's still-pending picks
// were silently never looked at again by any future tick, stuck pending
// indefinitely even once a real result existed. 2 days (today + yesterday)
// comfortably covers any single card crossing midnight; each pick record
// already stores its own dateKey (see pickRecordFrom), so grading several
// days' worth together and writing each graded pick back under its own
// original dateKey is safe — nothing needs to move between days.
const GRADING_LOOKBACK_DAYS = 2;

/**
 * Grades whatever's pending and has a completed score available, via the
 * exact same gradePick() the client's own "Check Results" button already
 * uses. Deliberately runs on every tick (every 20 minutes — see
 * worker/src/index.js's scheduled()) rather than being gated to a single
 * "11:59pm" instant — grading is idempotent (it only ever touches still-
 * pending picks) and strictly better run more often: a pick from an early-
 * afternoon game gets graded within 20 minutes instead of sitting "pending"
 * until midnight for no reason. Looks back GRADING_LOOKBACK_DAYS ET calendar
 * days, not just today's, so a still-pending pick from a card that crossed
 * midnight never gets orphaned by the date rolling over mid-card.
 *
 * MMA picks get a second look via ESPN's scoreboard (gradeMmaPickWithFallback,
 * worker/src/ufc-events.js) when the Odds API's own /scores hasn't posted a
 * result yet — confirmed live, that's routine for untelevised early-prelim
 * bouts (a whole finished 12-fight card can still read completed:false hours
 * later) while ESPN already has the final result the moment the fight ends.
 * Only fetched when at least one pending pick is actually MMA, so every other
 * sport's grading pass costs exactly what it always has.
 */
export async function runGrading(
  env,
  ctx,
  now = Date.now(),
  { fetchScoresFn = (s) => fetchScores(s, env, ctx), fetchMmaResultsFn = () => fetchMmaResults(ctx, now) } = {},
) {
  const dateKeys = [...new Set(
    Array.from({ length: GRADING_LOOKBACK_DAYS }, (_, i) => etDate(now - i * 86400000)),
  )];
  const loaded = await Promise.all(dateKeys.map((dk) => loadTrackedPicks(env, dk)));
  const picks = loaded.flatMap((d) => d.picks);
  const pending = picks.filter((p) => p.status === 'pending');
  if (!pending.length) return { graded: 0, remaining: 0 };

  const sportsNeeded = [...new Set(pending.map((p) => p.sportKey))];
  const fetched = await Promise.all(sportsNeeded.map((s) => fetchScoresFn(s)));
  const scoreEventsBySport = new Map(sportsNeeded.map((s, i) => [s, fetched[i].events ?? []]));
  const mmaResults = pending.some((p) => isMma(p.sportKey)) ? await fetchMmaResultsFn() : [];

  let graded = 0;
  for (const pick of pending) {
    const scoreEvent = (scoreEventsBySport.get(pick.sportKey) ?? []).find((e) => e.id === pick.eventId);
    let outcome;
    if (isMma(pick.sportKey)) {
      outcome = gradeMmaPickWithFallback(pick, scoreEvent, mmaResults);
    } else if (isTennis(pick.sportKey) && hasSecondarySettlementSource(pick.sportKey, pick.marketKey)) {
      // A metered second source can turn this specific void into a real
      // grade (see worker/src/tennis-results.js) — null falls through to
      // the same gradePick() void every other tennis spread/total gets.
      outcome = (await settleTennisGameMarket(pick, scoreEvent, env, ctx, now)) ?? gradePick(pick, scoreEvent, now);
    } else {
      outcome = gradePick(pick, scoreEvent, now);
    }
    if (!outcome) continue;
    // A void (push, walkover, or a market this feed can't settle — see
    // gradePick) is recorded as settled with the stake returned, so it stops
    // being pending instead of sitting unresolved forever, and is excluded
    // from win rate and ROI by summarizePicks.
    pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    pick.result = {
      payout: outcome.payout,
      roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
      voidReason: outcome.void ? outcome.reason : undefined,
      retired: outcome.retired ?? undefined,
    };
    graded++;
    ctx.waitUntil(
      env.POTD_KV.put(`track:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }
  return { graded, remaining: pending.length - graded };
}

/** Today's tracked Top 5 (or a specific date's), for the /top5 route. */
export async function getTop5(env, { now = Date.now(), dateKey } = {}) {
  const { picks } = await loadTrackedPicks(env, dateKey ?? etDate(now));
  return picks;
}

/**
 * "Which way the app is leaning" for whatever Top5 slots aren't locked yet
 * — computed entirely from today's pool (see updateTop5Pool), so this is a
 * cheap KV read plus local scoring, never a live Odds-API fetch; safe to
 * call on every page load, unlike the real batch itself. Returns [] once
 * all 5 slots are locked (nothing left to lean on) or before anything's
 * entered the pool yet. guaranteeCount is deliberately off here — a lean
 * should only ever show a genuine qualifier, never the padding that's only
 * appropriate once the real, final selection has nothing left to wait for.
 */
export async function getTop5Leaning(env, { now = Date.now(), dateKey } = {}) {
  const dk = dateKey ?? etDate(now);
  const { pickIds } = await loadTrackedPicks(env, dk);
  const needed = TOP5_COUNT - pickIds.length;
  if (needed <= 0) return [];

  const [algoConfig, poolRaw] = await Promise.all([
    getAlgoConfig(env),
    env.POTD_KV.get(`track:${dk}:pool`),
  ]);
  const pool = poolRaw ? JSON.parse(poolRaw).entries : [];
  const existingEventIds = new Set(pickIds.map((id) => id.split(':')[0]));
  const stillActionable = pool.filter((c) => c.commenceMs > now && !existingEventIds.has(c.eventId));

  const slate = topPicks(stillActionable, {
    count: needed,
    oddsMin: CONFIG.ODDS_MIN_DEFAULT,
    oddsMax: CONFIG.ODDS_MAX_DEFAULT,
    minScore: algoConfig.MIN_SCORE,
    minEv: algoConfig.MIN_EV_PCT,
    minKelly: algoConfig.MIN_KELLY_FRACTION,
    guaranteeCount: false,
  });

  return slate.picks.map((pick) => pickRecordFrom(pick, dk, now));
}

/**
 * Every tracked pick across every day still in KV (bounded by KV_TTL_SECONDS
 * — 90 days), for the aggregate summary and calibration reporting. Walks
 * day-by-day back from `now` rather than a KV list().scan over the whole
 * `track:` namespace, since manifests already give an exact, cheap index of
 * which picks exist for a given day without listing keys that don't.
 */
export async function getAllTrackedPicks(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(etDate(now - i * 86400000));
  }
  const perDay = await Promise.all(dateKeys.map((d) => loadTrackedPicks(env, d)));
  return perDay.flatMap((d) => d.picks);
}

/**
 * Wipes every tracked pick and manifest currently in KV — the server-side
 * counterpart to the client's local "Archive & Reset" button. Both are
 * explicit, user-triggered actions (see /top5-reset route), never run on a
 * schedule.
 */
export async function resetAllTracking(env, { now = Date.now(), days = 90 } = {}) {
  let deleted = 0;
  for (let i = 0; i < days; i++) {
    const dateKey = etDate(now - i * 86400000);
    const { pickIds } = await loadTrackedPicks(env, dateKey);
    for (const id of pickIds) {
      await env.POTD_KV.delete(`track:${dateKey}:pick:${id}`);
      deleted++;
    }
    await env.POTD_KV.delete(`track:${dateKey}:top5`);
  }
  return { deleted };
}
