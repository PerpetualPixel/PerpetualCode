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
import { analyze, topPicks, clearsMaxJuice, isNflPreseason } from '../../docs/engine.js';
import { fetchCapperConsensus, applyCapperConsensus, upgradeToValueStraight } from '../../docs/capper-consensus.js';
import { getAllWnbaPropsTracked } from './wnba-props.js';
import { getAllMlbPropsTracked } from './mlb-props.js';
import { getAllNflPropsTracked } from './nfl-props.js';
import { getAllNhlPropsTracked } from './nhl-props.js';
import { isPower4Matchup } from '../../docs/ncaaf-conferences.js';
import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { CONFIG } from '../../docs/config.js';
import { fetchSport, fetchScores, fetchCatalogue, UPSTREAM, REGIONS, DEFAULT_CACHE_SECONDS } from './odds.js';
import { getAlgoConfig, getPausedSegments, isSegmentPaused } from './algo-health.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { applyTennisFormSignal } from '../../docs/qualitative.js';
import { loadTennisArchivesFor } from './tennis-archive.js';
import {
  tennisTier,
  dedupeTennisEvents,
  isMarketAllowedForTier,
  tierLiquidityBlock,
} from '../../docs/tennis-tiers.js';
import {
  fetchTennisResults,
  gradeTennisPickWithEspn,
  isRegradableTennisVoid,
  isNoOpTennisRegrade,
  regradeTennisVoids,
  BACKFILL_READ_BUDGET,
} from './tennis-espn.js';
import { retractedRecord } from './retraction.js';

export const TOP5_COUNT = 5;

/**
 * Score at or above which a candidate is locked the moment its window opens,
 * without waiting for the rest of the day to be visible.
 *
 * The board used to wait for EVERY one of today's games to reach its lock
 * window before drawing at all, so it could compare the whole day. The
 * trigger for that fires ~3h before the day's LAST game — by which point the
 * draw pool, which only contains games that haven't started, has lost the
 * entire afternoon. On a normal MLB day (1pm-10pm ET) the draw happened
 * around 7pm and could only see 7pm-or-later games. That is why a board
 * promising 5 kept posting 1 or 2, repeatedly, and why guaranteeCount
 * couldn't save it: its fallback draws from that same emptied pool.
 *
 * A genuinely strong number doesn't need the rest of the day for context, so
 * it's taken when it appears rather than left to expire.
 */
const PREMIUM_LOCK_SCORE = 72;

/**
 * How much slack to leave before treating the day as running out.
 *
 * Slots are filled once the remaining unstarted events are down to roughly
 * the number of slots still open. The buffer exists because supply is only
 * re-measured once per tick (15 min) and several games can start between two
 * ticks — waiting for supply to reach exactly the slot count would routinely
 * overshoot and strand the board short, which is the entire failure being
 * fixed here.
 */
const DEADLINE_BUFFER_EVENTS = 3;

/**
 * Pixel's Picks price band, per explicit product direction: "-200 straight is
 * okay ... near that range of -200 to +100. I don't want a -1800."
 *
 * SHARP is the standard a real lock is held to. HARD is the bound nothing
 * crosses, thin-day fallback included — see topPicks' own hardOddsMin note
 * for how a -1800 reached a live board that already claimed a -200 floor.
 * The hard ceiling sits above the sharp one because the two ends fail
 * differently: an extra-long dog is a bad-value bet, while a -1800 favorite
 * is a bet whose price makes the whole board's premise dishonest.
 */
const PIXEL_ODDS = { SHARP_MIN: -200, SHARP_MAX: 100, HARD_MIN: -200, HARD_MAX: 150 };

/**
 * Sides already taken by the other boards, as `eventId|marketKey|outcomeName`.
 *
 * Pixel's Picks must never sit on the opposite side of a bet the Full Slate
 * or Play of the Day already published — per explicit product direction,
 * "these cannot contradict another pick anywhere in the full slate or play of
 * the day." Agreement is fine and expected: the Full Slate carries a pick on
 * essentially every game, so excluding its events outright would leave
 * nothing to pick from. Only the OPPOSITE side of a market it already called
 * is a contradiction.
 *
 * Read straight from KV rather than through full-slate-tracking.js's own
 * loader: that module already imports from this one, and closing the cycle
 * for one lookup isn't worth the load-order fragility.
 */
async function loadPublishedSides(env, dateKey) {
  const sides = new Set();
  const add = (pick) => {
    if (!pick?.eventId || !pick?.marketKey || !pick?.outcomeName) return;
    sides.add(`${pick.eventId}|${pick.marketKey}|${pick.outcomeName}`);
  };

  try {
    const [slateManifestRaw, potdRaw] = await Promise.all([
      env.POTD_KV.get(`slate:${dateKey}:manifest`),
      env.POTD_KV.get(`potd:${dateKey}`),
    ]);
    if (potdRaw) add(JSON.parse(potdRaw)?.pick);

    const slateIds = slateManifestRaw ? (JSON.parse(slateManifestRaw).pickIds ?? []) : [];
    const slatePicks = await Promise.all(
      slateIds.map((id) => env.POTD_KV.get(`slate:${dateKey}:pick:${id}`)),
    );
    for (const raw of slatePicks) {
      if (raw) add(JSON.parse(raw));
    }
  } catch {
    // A cross-board read failure must not stop the board from being built —
    // it degrades to this board's own same-event guards, which already
    // prevent the worst case (two Pixel's Picks on opposite sides).
  }
  return sides;
}

/**
 * Whether a candidate takes the opposite side of a market another board
 * already published. Same event + same market + a DIFFERENT outcome is the
 * contradiction; the identical outcome is agreement and passes.
 */
export function contradictsPublishedBoard(candidate, publishedSides) {
  if (!publishedSides?.size) return false;
  for (const side of publishedSides) {
    const [eventId, marketKey, outcomeName] = side.split('|');
    if (candidate.eventId === eventId && candidate.marketKey === marketKey && candidate.outcomeName !== outcomeName) {
      return true;
    }
  }
  return false;
}
// Matches docs/learning.js's own FLAT_UNIT_STAKE — duplicated rather than
// imported because that module's exported constant sits alongside
// IndexedDB-touching functions this file never calls; importing just the
// one pure function (gradePick) and this one number keeps the boundary
// between "browser-only" and "safe to run in the Worker" obvious at a
// glance rather than relying on nothing-happens-to-call-the-unsafe-part.
const FLAT_UNIT_STAKE = 20;
const KV_TTL_SECONDS = 86400 * 90; // 90 days — long enough for weeks of calibration data, not forever

// How many ET calendar days back runTop5Batch looks for an event it already
// tracked — same constant, same value, same reasoning as
// full-slate-tracking.js's own EVENT_DEDUPE_LOOKBACK_DAYS (see the long
// comment at its declaration there): a game whose start time moved after
// its pick locked in must not be pickable a second time under a new date.
const EVENT_DEDUPE_LOOKBACK_DAYS = 2;

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
// 2am, not 6am: set per explicit product direction that the only tennis
// matches allowed onto the previous day's board are the genuinely "super
// early" ones — midnight to 2am ET, i.e. a night session that ran long.
// A 5am start is an ordinary next-morning match and belongs on its own day.
const TENNIS_NEXT_DAY_CUTOFF_HOUR = 2;

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
 * Whether any of today's real games — checked against the raw event list
 * straight from the odds feed, not the price-filtered candidate pool —
 * hasn't had its own pick window open yet. This is the actual "have we
 * seen the whole day" signal runTop5Batch/potd.js's runPotdDaily need
 * before finalizing; it used to be approximated as
 * `eligibleToday.some(c => !isPickWindowOpen(c, now))`, checked against
 * the price/EV/segment-filtered candidate list. That let a still-to-come
 * game silently drop out of the "still waiting" check the moment it had no
 * candidate at all yet — routine for a market that simply hasn't posted
 * odds (tennis prices matches close to start far more than other sports
 * do) — which is a real incident this exact gap produced: a mediocre
 * early-afternoon game locked in as Play of the Day hours before a much
 * stronger tennis match even had a price, because nothing left in the
 * price-filtered set still needed waiting on.
 *
 * NCAAF's Power 4 filter is applied here too, since it's knowable from
 * team names alone — a non-Power-4 buy game can never become eligible
 * regardless of price, so it shouldn't block completeness either. A
 * paused-segment exclusion is deliberately NOT applied here: that's
 * specific to one (sportKey, marketKey) pair, and a raw event can carry
 * several markets, so a paused moneyline shouldn't stop the whole game
 * from counting while its spread or total might still be eligible.
 */
export function scheduleStillOpen(events, dateKey, now) {
  return events.some((event) => {
    const sportKey = event.sport_key;
    const commenceMs = Date.parse(event.commence_time);
    if (!Number.isFinite(commenceMs)) return false;
    if (sportKey === 'americanfootball_ncaaf' && !isPower4Matchup(event.home_team, event.away_team)) return false;
    const eligibleToday = isMma(sportKey)
      ? isEligibleMmaFight(commenceMs, now)
      : isTennis(sportKey)
        ? isEligibleTennisMatch(commenceMs, now)
        : etDate(commenceMs) === dateKey;
    if (!eligibleToday) return false;
    return !isPickWindowOpen({ sportKey, commenceMs }, now);
  });
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
// stakeUnits defaults to 2: Pixel's Picks are 2-UNIT plays (product
// direction — the 5 daily picks sit just below the two 5U Plays of the Day).
// Full Slate passes 1 explicitly: it tracks every game and stays the flat
// 1U baseline.
export function pickRecordFrom(pick, dateKey, now, stakeUnits = 2) {
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
    suggested_stake: FLAT_UNIT_STAKE * stakeUnits,
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
  const [algoConfig, pausedSegments, learningProfile, boardReview] = await Promise.all([
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
    // The 3-of-5 accountability loop (runBoardReview below): a board that
    // missed the standard raises its own conviction floor for the next day,
    // and earns the ground back by meeting it.
    getBoardReview(env),
  ]);
  const convictionFloor = algoConfig.MIN_SCORE + (boardReview.scoreBump ?? 0);

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
  //
  // The exclusion window spans EVENT_DEDUPE_LOOKBACK_DAYS of manifests, not
  // just today's, for the same reason full-slate-tracking.js's
  // runFullSlateBatch does: a match whose start time moves after its pick
  // locked in (tennis order-of-play, most often) shows up to a later day's
  // batch as an eventId absent from that day's manifest — because it's in a
  // previous day's — and gets picked a SECOND time, by then possibly on the
  // opposite side (the confirmed Full Slate incident: Rafael Jodar -105 AND
  // Arthur Fils +100 on one match). On this board a duplicate is worse than
  // a double-count: it burns one of only TOP5_COUNT daily slots.
  const priorDateKeys = Array.from(
    { length: EVENT_DEDUPE_LOOKBACK_DAYS }, (_, i) => etDate(now - (i + 1) * 86400000),
  );
  const priorManifests = await Promise.all(
    priorDateKeys.map((dk) => env.POTD_KV.get(`track:${dk}:top5`)),
  );
  const existingEventIds = new Set(
    [
      ...existingPickIds,
      ...priorManifests.filter(Boolean).flatMap((raw) => JSON.parse(raw).pickIds ?? []),
    ].map((id) => id.split(':')[0]),
  );
  const analyzed = analyze(events, { now })
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
      // NFL preseason is excluded from Pixel's Picks — only regular season games.
      .filter((c) => !isNflPreseason(c))
      .filter((c) => !existingEventIds.has(c.eventId));

  // Tennis form gate (docs/qualitative.js): re-score tennis candidates with
  // their recent-form/head-to-head signal and drop straight-moneyline
  // underdogs the form data doesn't back — the pure-price engine's EV
  // shopping structurally over-picks tennis dogs (the outlier price it hunts
  // lives on the dog side of a two-outcome market), which a live run of WTA
  // upset calls confirmed. Applied BEFORE the learning weights so the
  // reliability multiplier scales the form-adjusted grade, same order the
  // browser's own enrichment implies.
  const eligibleToday = applyLearningToCandidates(
    applyTennisFormSignal(analyzed, await loadTennisArchivesFor(analyzed), { now }),
    learningProfile,
  );

  // Split by whether each candidate's own game has reached its lock time —
  // see this function's own comment for why only "lockable" candidates get
  // captured into the pool this tick, and why the real slots wait for
  // stillUpcoming to go false before drawing from it. stillUpcoming itself
  // is checked against the raw event list (scheduleStillOpen), not this
  // price-filtered eligibleToday — see that function's own comment for why.
  const lockable = eligibleToday.filter((c) => isPickWindowOpen(c, now));
  const stillUpcoming = scheduleStillOpen(events, dateKey, now);
  await updateTop5Pool(env, ctx, dateKey, lockable, now);

  const poolRaw = await env.POTD_KV.get(`track:${dateKey}:pool`);
  const pool = poolRaw ? JSON.parse(poolRaw).entries : [];

  // How many of today's eligible games still haven't started — the day's
  // remaining supply of chances. Measured off the raw event list, not the
  // price-filtered pool, for the same reason scheduleStillOpen is: a game
  // that hasn't posted a price yet is still a chance this board has left.
  const supplyLeft = events.filter((event) => {
    const commenceMs = Date.parse(event.commence_time);
    if (!Number.isFinite(commenceMs) || commenceMs <= now) return false;
    if (existingEventIds.has(event.id)) return false;
    if (event.sport_key === 'americanfootball_ncaaf' && !isPower4Matchup(event.home_team, event.away_team)) return false;
    if (isMma(event.sport_key)) return isEligibleMmaFight(commenceMs, now);
    if (isTennis(event.sport_key)) return isEligibleTennisMatch(commenceMs, now);
    return etDate(commenceMs) === dateKey;
  }).length;

  // Two ways a slot gets filled on this tick:
  //   - the day is running out (supply is down to roughly the slots left, or
  //     every game has had its window and there's nothing more coming), so
  //     take the best of what's actually still bettable; or
  //   - a candidate is strong enough to stand on its own (PREMIUM_LOCK_SCORE),
  //     in which case waiting only risks losing it to its own start time.
  // The old behaviour was neither: it waited for the whole day, every time,
  // and by then most of the day was unbettable.
  const atDeadline = !stillUpcoming || supplyLeft <= needed + DEADLINE_BUFFER_EVENTS;
  // Already-locked events are excluded same as the live eligibility filter
  // above (existingEventIds) — a pool entry can predate today's most recent
  // lock. Anything whose game has since started can't be posted anymore;
  // it stays in the pool's own history, just never becomes a real pick.
  const stillActionable = pool.filter((c) => c.commenceMs > now && !existingEventIds.has(c.eventId));

  // MMA moneylines get the MMA_Engine capper-consensus swing (docs/
  // capper-consensus.js) before the final draw — the same enrichment the
  // browser's refreshQualitativeSignals() applies, so the locked board and
  // the live one grade an MMA fight the same way. Fetch failure degrades to
  // the unadjusted pool: consensus is a bonus, never a dependency.
  const consensusFeed = await fetchCapperConsensus(undefined, { force: true }).catch(() => null);
  const drawPool = consensusFeed
    ? applyCapperConsensus(stillActionable, consensusFeed, { now })
    : stillActionable;

  // Never the opposite side of something the Full Slate or Play of the Day
  // already published — see loadPublishedSides.
  const publishedSides = await loadPublishedSides(env, dateKey);
  const nonConflicting = drawPool.filter((c) => !contradictsPublishedBoard(c, publishedSides));

  const slate = topPicks(nonConflicting, {
    oddsMin: PIXEL_ODDS.SHARP_MIN,
    oddsMax: PIXEL_ODDS.SHARP_MAX,
    // Enforced even by the thin-day fallback, which is what stops a -1800
    // reaching a board that promises -200 or better.
    hardOddsMin: PIXEL_ODDS.HARD_MIN,
    hardOddsMax: PIXEL_ODDS.HARD_MAX,
    count: needed,
    // Off-deadline, only a genuinely strong number earns a slot early;
    // at the deadline the standard is the configured one and the fallback
    // is allowed to fill rather than let the board finish short.
    minScore: atDeadline ? convictionFloor : Math.max(convictionFloor, PREMIUM_LOCK_SCORE),
    minEv: algoConfig.MIN_EV_PCT,
    minKelly: algoConfig.MIN_KELLY_FRACTION,
    guaranteeCount: atDeadline,
  });

  // The revamped hierarchy: the two BEST plays of the day are the 5U
  // flagships (Play of the Day + Prop Play); Pixel's Picks are the next 5.
  // High-conviction prop picks (already scored 0-100 by their scans, priced
  // -200 or better) compete for those 5 slots on equal footing with the
  // team markets, and anything already featured by a flagship is excluded
  // so the 7 plays never overlap.
  try {
    const [potdRaw, propPlayRaw, ...pools] = await Promise.all([
      env.POTD_KV.get(`potd:${dateKey}`),
      env.POTD_KV.get(`propplay:${dateKey}`),
      getAllWnbaPropsTracked(env, { now, days: 1 }),
      getAllMlbPropsTracked(env, { now, days: 1 }),
      getAllNflPropsTracked(env, { now, days: 1 }),
      getAllNhlPropsTracked(env, { now, days: 1 }),
    ]);
    const featured = new Set();
    const potdRecord = potdRaw ? JSON.parse(potdRaw) : null;
    if (potdRecord?.pick?.eventId) featured.add(potdRecord.pick.eventId);
    const propPlay = propPlayRaw ? JSON.parse(propPlayRaw) : null;
    for (const leg of propPlay?.legs ?? []) {
      if (leg.oddsEventId) featured.add(leg.oddsEventId);
    }
    slate.picks = slate.picks.filter((p) => !featured.has(p.legs[0].eventId));

    const propCandidates = pools.flat().filter((p) =>
      p.status === 'pending' && Number(p.decimal) >= 1.5 && Number.isFinite(p.score)
      && p.commenceMs > now && !featured.has(p.eventId) && !existingEventIds.has(p.eventId)
      // Same price band and same cross-board rule the team markets are held
      // to — a prop is a Pixel's Pick like any other, not a side door around
      // the standard.
      && Number(p.american) >= PIXEL_ODDS.HARD_MIN && Number(p.american) <= PIXEL_ODDS.HARD_MAX
      && !contradictsPublishedBoard(p, publishedSides));
    const merged = [
      ...slate.picks,
      ...propCandidates.map((p) => ({ legs: [p], score: p.score, meetsStandard: true, flagReason: null })),
    ].sort((x, y) => y.score - x.score);
    const perEvent = new Set();
    slate.picks = merged.filter((p) => {
      const eventId = p.legs[0].eventId;
      if (perEvent.has(eventId)) return false;
      perEvent.add(eventId);
      return true;
    }).slice(0, needed);
  } catch { /* props and flagship dedupe are upgrades — the team slate stands alone */ }

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
    // MMA fights lock their best VALUE play, not automatically the priced
    // market that earned the slot: a heavy moneyline gives way to the
    // consensus's priced straight (method/round/distance) when the straight
    // carries more value — see upgradeToValueStraight.
    if (consensusFeed) pick.legs = pick.legs.map((leg) => upgradeToValueStraight(leg, consensusFeed));
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
    // Spread `existing` rather than building a fresh object — the manifest
    // also carries retractedPickIds (see retractTop5Picks), and a literal
    // listing only this function's own fields would drop them on the very
    // next top-up tick, orphaning every retracted record.
    env.POTD_KV.put(manifestKey, JSON.stringify({
      ...(existing ?? {}), date: dateKey, generatedAt: now, pickIds,
    }), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );

  return { skipped: false, dateKey, count: pickIds.length, added: newPickIds.length, poolSize: slate.poolSize };
}

/**
 * A day's Pixel's Picks records. `picks` includes retracted ones so the
 * dashboard still shows them (voided) rather than a gap; `pickIds` is the
 * LIVE set only, since every caller reading it — the batch's own top-up
 * count and event dedupe, the date migration, the reset sweep — means
 * "picks that still stand." Exactly mirrors full-slate-tracking.js's own
 * loadFullSlateTracked; see retractTop5Picks below.
 */
async function loadTrackedPicks(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`track:${dateKey}:top5`);
  if (!manifestRaw) return { pickIds: [], picks: [], retractedPickIds: [] };
  const { pickIds = [], retractedPickIds = [] } = JSON.parse(manifestRaw);
  const [stored, retracted] = await Promise.all([
    Promise.all(pickIds.map((id) => env.POTD_KV.get(`track:${dateKey}:pick:${id}`))),
    Promise.all(retractedPickIds.map((id) => env.POTD_KV.get(`track:${dateKey}:retracted:${id}`))),
  ]);
  return {
    pickIds,
    retractedPickIds,
    picks: [...stored, ...retracted].filter(Boolean).map((r) => JSON.parse(r)),
  };
}

/**
 * The Pixel's Picks counterpart to full-slate-tracking.js's
 * retractFullSlatePicks — same contract, same reasoning, same reason the
 * record moves to its own key prefix instead of staying in place. Because
 * runTop5Batch tops up to TOP5_COUNT, removing an id from `pickIds` also
 * re-opens that slot: the board refills to five on the next tick, from
 * whatever the engine now grades highest.
 */
export async function retractTop5Picks(env, { now = Date.now(), dateKey, match, reason }) {
  const day = dateKey ?? etDate(now);
  const manifestKey = `track:${day}:top5`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  if (!manifestRaw) return { dateKey: day, retracted: 0, picks: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickIds = manifest.pickIds ?? [];
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`track:${day}:pick:${id}`)));

  const keptIds = [];
  const pulled = [];
  pickIds.forEach((pickId, i) => {
    const raw = stored[i];
    if (!raw) { keptIds.push(pickId); return; }
    const pick = JSON.parse(raw);
    if (!match(pick)) { keptIds.push(pickId); return; }
    pulled.push(retractedRecord(pick, { reason, at: now }));
  });

  if (!pulled.length) return { dateKey: day, retracted: 0, picks: [] };

  await Promise.all(pulled.flatMap((pick) => [
    env.POTD_KV.put(`track:${day}:retracted:${pick.pickId}`, JSON.stringify(pick), {
      expirationTtl: KV_TTL_SECONDS,
    }),
    env.POTD_KV.delete(`track:${day}:pick:${pick.pickId}`),
  ]));

  manifest.pickIds = keptIds;
  manifest.retractedPickIds = [...new Set([...(manifest.retractedPickIds ?? []), ...pulled.map((p) => p.pickId)])];
  manifest.lastUpdatedAt = now;
  await env.POTD_KV.put(manifestKey, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });

  return { dateKey: day, retracted: pulled.length, picks: pulled };
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
  {
    fetchScoresFn = (s) => fetchScores(s, env, ctx),
    fetchMmaResultsFn = () => fetchMmaResults(ctx, now),
    fetchTennisResultsFn = () => fetchTennisResults(ctx, now),
    // Widened by the nightly reconciliation pass (see index.js's scheduled
    // handler). The every-tick default stays deliberately short: grading
    // runs 96 times a day and almost never needs to look further back than
    // a game that crossed midnight.
    lookbackDays = GRADING_LOOKBACK_DAYS,
  } = {},
) {
  const dateKeys = [...new Set(
    Array.from({ length: lookbackDays }, (_, i) => etDate(now - i * 86400000)),
  )];
  const loaded = await Promise.all(dateKeys.map((dk) => loadTrackedPicks(env, dk)));
  const picks = loaded.flatMap((d) => d.picks);
  // Same reopen as full-slate-tracking.js's own grading pass — see its
  // comment for why a void can come back into scope.
  const pending = picks.filter((p) => p.status === 'pending' || isRegradableTennisVoid(p));
  if (!pending.length) return { graded: 0, remaining: 0 };

  const sportsNeeded = [...new Set(pending.map((p) => p.sportKey))];
  const fetched = await Promise.all(sportsNeeded.map((s) => fetchScoresFn(s)));
  const scoreEventsBySport = new Map(sportsNeeded.map((s, i) => [s, fetched[i].events ?? []]));
  const mmaResults = pending.some((p) => isMma(p.sportKey)) ? await fetchMmaResultsFn() : [];
  // The odds feed has never once posted a tennis result (see
  // worker/src/tennis-espn.js's header) — ESPN's scoreboard is what actually
  // settles these. One fetch per pass covers every tournament in play.
  const tennisResults = pending.some((p) => isTennis(p.sportKey)) ? await fetchTennisResultsFn() : [];

  let graded = 0;
  let rescheduled = 0;
  for (const pick of pending) {
    const scoreEvent = (scoreEventsBySport.get(pick.sportKey) ?? []).find((e) => e.id === pick.eventId);

    // Same live-feed commence-time refresh as full-slate-tracking.js's
    // runFullSlateGrading — see its comment for the confirmed incident this
    // guards against (a rescheduled tennis match sitting "pending" on the
    // wrong day forever, its stored commenceMs a stale lock-time snapshot).
    // When the fresh time lands on a different ET day, grading is skipped
    // for this tick so runTop5DateResync can re-bucket the still-pending
    // pick first; grading resumes under the right day on a later tick.
    if (scoreEvent?.commence_time) {
      const freshCommenceMs = Date.parse(scoreEvent.commence_time);
      if (Number.isFinite(freshCommenceMs) && freshCommenceMs !== pick.commenceMs) {
        const movedDay = etDate(freshCommenceMs) !== pick.dateKey;
        pick.commenceMs = freshCommenceMs;
        rescheduled++;
        ctx.waitUntil(
          env.POTD_KV.put(`track:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
            expirationTtl: KV_TTL_SECONDS,
          }),
        );
        if (movedDay) continue;
      }
    }

    let outcome;
    if (isMma(pick.sportKey)) {
      outcome = gradeMmaPickWithFallback(pick, scoreEvent, mmaResults);
    } else if (isTennis(pick.sportKey)) {
      // ESPN's scoreboard supplies the sets the odds feed never posts, and
      // the metered second source still layers on top for TIER_1
      // spreads/totals — see worker/src/tennis-espn.js.
      outcome = await gradeTennisPickWithEspn(pick, scoreEvent, tennisResults, env, ctx, now);
    } else {
      outcome = gradePick(pick, scoreEvent, now);
    }
    if (!outcome) continue;
    // A reopened void that still can't settle lands right back on the reason
    // it already carries — nothing changed, so leave the record alone.
    if (isNoOpTennisRegrade(pick, outcome)) continue;
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
      // Settlement-time display detail (tennis set scores, MMA winner +
      // method — see docs/tennis-results.js's tennisDetail and
      // ufc-events.js's gradeMmaPickWithFallback): captured here because
      // grading is the only moment this data is in hand for free.
      detail: outcome.detail ?? undefined,
    };
    graded++;
    ctx.waitUntil(
      env.POTD_KV.put(`track:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }
  return { graded, remaining: pending.length - graded, rescheduled };
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

  // Same capper-consensus enrichment as the real batch below, so the lean
  // never disagrees with the eventual lock over an adjustment one of them
  // didn't apply.
  const consensusFeed = await fetchCapperConsensus(undefined, { force: true }).catch(() => null);
  const drawPool = consensusFeed
    ? applyCapperConsensus(stillActionable, consensusFeed, { now })
    : stillActionable;

  const slate = topPicks(drawPool, {
    count: needed,
    oddsMin: CONFIG.ODDS_MIN_DEFAULT,
    oddsMax: CONFIG.ODDS_MAX_DEFAULT,
    minScore: algoConfig.MIN_SCORE,
    minEv: algoConfig.MIN_EV_PCT,
    minKelly: algoConfig.MIN_KELLY_FRACTION,
    guaranteeCount: false,
  });

  return slate.picks.map((pick) => {
    if (consensusFeed) pick.legs = pick.legs.map((leg) => upgradeToValueStraight(leg, consensusFeed));
    return pickRecordFrom(pick, dk, now);
  });
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
    const { pickIds, retractedPickIds } = await loadTrackedPicks(env, dateKey);
    for (const id of pickIds) {
      await env.POTD_KV.delete(`track:${dateKey}:pick:${id}`);
      deleted++;
    }
    // Retracted records sit under their own key prefix — dropping the
    // manifest without them would leave unreachable orphans behind.
    for (const id of retractedPickIds) {
      await env.POTD_KV.delete(`track:${dateKey}:retracted:${id}`);
      deleted++;
    }
    await env.POTD_KV.delete(`track:${dateKey}:top5`);
  }
  return { deleted };
}

/**
 * Moves a batch of Pixel's Picks off `storedDate` onto whatever ET calendar
 * date each one's own commenceMs actually falls on — the Top 5 counterpart
 * to worker/src/full-slate-tracking.js's own movePicksOffDate, same
 * reasoning and same batched-manifest-write shape (see that file's own
 * comment for why per-pick manifest writes raced each other and silently
 * dropped entries when more than one pick left the same day at once).
 * Every moved pick's own `dateKey` field is rewritten too, not just its KV
 * key — docs/app.js groups tracked picks by that field, not by storage
 * location.
 */
async function moveTop5PicksOffDate(env, storedDate, now, { dryRun = false, pendingOnly = false } = {}) {
  const manifestKey = `track:${storedDate}:top5`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  if (!manifestRaw) return { misdated: [], moved: [], relabeled: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickRaws = await Promise.all(
    manifest.pickIds.map((id) => env.POTD_KV.get(`track:${storedDate}:pick:${id}`)),
  );

  const misdated = [];
  const toMove = [];
  // A pick already filed under the right KV location (storedDate ===
  // actualDate) can still carry a stale dateKey field of its own — see
  // full-slate-tracking.js's own movePicksOffDate for the full reasoning.
  // Patched in place, no manifest change needed.
  const toRelabel = [];
  manifest.pickIds.forEach((pickId, i) => {
    const pickRaw = pickRaws[i];
    if (!pickRaw) return;
    const pick = JSON.parse(pickRaw);
    if (pendingOnly && pick.status !== 'pending') return;
    const actualDate = etDate(pick.commenceMs);

    if (actualDate === storedDate) {
      if (dryRun || pick.dateKey === storedDate) return;
      pick.dateKey = storedDate;
      toRelabel.push({ pickId, patchedRaw: JSON.stringify(pick) });
      return;
    }

    misdated.push({
      pickId,
      storedDate,
      actualDate,
      pick: { eventId: pick.eventId, home: pick.home, away: pick.away, sportKey: pick.sportKey },
    });
    if (dryRun) return;

    pick.dateKey = actualDate;
    toMove.push({ pickId, actualDate, patchedRaw: JSON.stringify(pick) });
  });

  if (toRelabel.length) {
    await Promise.all(
      toRelabel.map(({ pickId, patchedRaw }) =>
        env.POTD_KV.put(`track:${storedDate}:pick:${pickId}`, patchedRaw, { expirationTtl: KV_TTL_SECONDS })),
    );
  }

  if (!toMove.length) return { misdated, moved: [], relabeled: toRelabel.map((r) => r.pickId) };

  await Promise.all(
    toMove.flatMap(({ pickId, actualDate, patchedRaw }) => [
      env.POTD_KV.put(`track:${actualDate}:pick:${pickId}`, patchedRaw, { expirationTtl: KV_TTL_SECONDS }),
      env.POTD_KV.delete(`track:${storedDate}:pick:${pickId}`),
    ]),
  );

  const movedIds = new Set(toMove.map((m) => m.pickId));
  manifest.pickIds = manifest.pickIds.filter((id) => !movedIds.has(id));
  await env.POTD_KV.put(manifestKey, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });

  const byTargetDate = new Map();
  for (const { pickId, actualDate } of toMove) {
    if (!byTargetDate.has(actualDate)) byTargetDate.set(actualDate, []);
    byTargetDate.get(actualDate).push(pickId);
  }
  await Promise.all(
    [...byTargetDate.entries()].map(async ([targetDate, pickIds]) => {
      const targetManifestKey = `track:${targetDate}:top5`;
      const targetRaw = await env.POTD_KV.get(targetManifestKey);
      const targetManifest = targetRaw ? JSON.parse(targetRaw) : { date: targetDate, generatedAt: now, pickIds: [] };
      const existing = new Set(targetManifest.pickIds);
      for (const id of pickIds) existing.add(id);
      targetManifest.pickIds = [...existing];
      return env.POTD_KV.put(targetManifestKey, JSON.stringify(targetManifest), { expirationTtl: KV_TTL_SECONDS });
    }),
  );

  return {
    misdated,
    moved: toMove.map(({ pickId, actualDate }) => ({ pickId, from: storedDate, to: actualDate })),
    relabeled: toRelabel.map((r) => r.pickId),
  };
}

/**
 * Collapses an event holding more than one tracked Pixel's Pick on the same
 * day back to the earliest-generated one — the Top 5 counterpart to
 * full-slate-tracking.js's own dedupeEventPicksOnDate; see that function's
 * comment for the full reasoning (keeper = the lock the algorithm actually
 * committed to first; its commenceMs is refreshed from the newest duplicate;
 * groups carrying any graded pick are reported, never touched). Extra stake
 * here: a duplicate doesn't just distort the record, it burns one of only
 * TOP5_COUNT daily slots, and runTop5Batch's own top-up self-heals the freed
 * slot with a genuinely different game on its next tick.
 */
async function dedupeTop5EventPicksOnDate(env, storedDate, now) {
  const manifestKey = `track:${storedDate}:top5`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  if (!manifestRaw) return { collapsed: [], skippedGraded: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickRaws = await Promise.all(
    manifest.pickIds.map((id) => env.POTD_KV.get(`track:${storedDate}:pick:${id}`)),
  );

  const byEvent = new Map();
  manifest.pickIds.forEach((pickId, i) => {
    if (!pickRaws[i]) return;
    const pick = JSON.parse(pickRaws[i]);
    if (!byEvent.has(pick.eventId)) byEvent.set(pick.eventId, []);
    byEvent.get(pick.eventId).push({ pickId, pick });
  });

  const collapsed = [];
  const skippedGraded = [];
  const dropIds = [];
  const rewrites = [];

  for (const [eventId, group] of byEvent) {
    if (group.length < 2) continue;

    const graded = group.filter(({ pick }) => pick.status !== 'pending');
    if (graded.length) {
      skippedGraded.push({
        eventId,
        storedDate,
        picks: group.map(({ pickId, pick }) => ({ pickId, selection: pick.selection, status: pick.status })),
      });
      continue;
    }

    const sorted = [...group].sort((a, b) => a.pick.generatedAt - b.pick.generatedAt);
    const keeper = sorted[0];
    const dropped = sorted.slice(1);
    const freshestCommenceMs = sorted.reduce(
      (best, cur) => (cur.pick.generatedAt > best.generatedAt ? cur.pick : best), keeper.pick,
    ).commenceMs;

    if (keeper.pick.commenceMs !== freshestCommenceMs) {
      keeper.pick.commenceMs = freshestCommenceMs;
      rewrites.push({ pickId: keeper.pickId, patchedRaw: JSON.stringify(keeper.pick) });
    }

    dropIds.push(...dropped.map((d) => d.pickId));
    collapsed.push({
      eventId,
      storedDate,
      kept: { pickId: keeper.pickId, selection: keeper.pick.selection },
      dropped: dropped.map(({ pickId, pick }) => ({ pickId, selection: pick.selection })),
    });
  }

  if (!dropIds.length && !rewrites.length) return { collapsed, skippedGraded };

  await Promise.all([
    ...rewrites.map(({ pickId, patchedRaw }) =>
      env.POTD_KV.put(`track:${storedDate}:pick:${pickId}`, patchedRaw, { expirationTtl: KV_TTL_SECONDS })),
    ...dropIds.map((id) => env.POTD_KV.delete(`track:${storedDate}:pick:${id}`)),
  ]);

  if (dropIds.length) {
    const dropSet = new Set(dropIds);
    manifest.pickIds = manifest.pickIds.filter((id) => !dropSet.has(id));
    await env.POTD_KV.put(manifestKey, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });
  }

  return { collapsed, skippedGraded };
}

/** Owner-triggered diagnostic/repair over the last `days` of Pixel's Picks tracking — see moveTop5PicksOffDate/dedupeTop5EventPicksOnDate for the actual logic. */
export async function migrateTop5PickDates(env, ctx, now = Date.now(), { days = 5 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const results = await Promise.all(dateKeys.map((d) => moveTop5PicksOffDate(env, d, now)));
  const misdated = results.flatMap((r) => r.misdated);
  const moved = results.flatMap((r) => r.moved);
  const relabeled = results.flatMap((r) => r.relabeled);

  // After the date fixes, same ordering rationale as the Full Slate
  // migration: duplicates only converge onto one day once each record is
  // filed under its match's real date.
  const dedupeResults = await Promise.all(dateKeys.map((d) => dedupeTop5EventPicksOnDate(env, d, now)));
  const collapsed = dedupeResults.flatMap((r) => r.collapsed);
  const skippedGraded = dedupeResults.flatMap((r) => r.skippedGraded);

  return {
    misdated,
    moved,
    relabeled,
    collapsed,
    skippedGraded,
    summary:
      `Found ${misdated.length} misdated picks, moved ${moved.length} to correct dates, ` +
      `relabeled ${relabeled.length} already-relocated picks whose own dateKey field was still stale, ` +
      `collapsed ${collapsed.length} events that had been tracked more than once` +
      (skippedGraded.length ? `, left ${skippedGraded.length} duplicate event(s) alone because they carry graded results` : ''),
  };
}

/**
 * Runs every tick — the Pixel's Picks counterpart to
 * full-slate-tracking.js's own runFullSlateDateResync. Only touches pending
 * picks; a graded one's day is already final. Collapses any event left
 * holding more than one still-pending pick after the date fixes, same as
 * the Full Slate resync does.
 */
export async function runTop5DateResync(env, ctx, now = Date.now(), { days = 2 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const results = await Promise.all(dateKeys.map((d) => moveTop5PicksOffDate(env, d, now, { pendingOnly: true })));
  const moved = results.flatMap((r) => r.moved);

  const dedupeResults = await Promise.all(dateKeys.map((d) => dedupeTop5EventPicksOnDate(env, d, now)));
  const collapsed = dedupeResults.flatMap((r) => r.collapsed);

  return { moved: moved.length, collapsed: collapsed.length };
}

/**
 * Pixel's Picks counterpart to full-slate-tracking.js's own
 * regradeFullSlateTennisVoids — see that function for the walk/budget
 * reasoning. Same shape, `track:` keys instead of `slate:`.
 */
export async function regradeTop5TennisVoids(
  env,
  ctx,
  { now = Date.now(), days = 90, offsetDays = 0, readBudget = BACKFILL_READ_BUDGET } = {},
) {
  const candidates = [];
  let reads = 0;
  let day = offsetDays;

  while (day < days) {
    const dateKey = etDate(now - day * 86400000);
    const { picks } = await loadTrackedPicks(env, dateKey);
    reads += 1 + picks.length;
    candidates.push(...picks.filter(isRegradableTennisVoid));
    day++;
    if (reads >= readBudget) break;
  }

  const changed = await regradeTennisVoids(candidates, env, ctx, now);
  await Promise.all(changed.map((pick) => env.POTD_KV.put(
    `track:${pick.dateKey}:pick:${pick.pickId}`,
    JSON.stringify(pick),
    { expirationTtl: KV_TTL_SECONDS },
  )));

  return {
    daysWalked: day - offsetDays,
    nextOffsetDays: day < days ? day : null,
    found: candidates.length,
    regraded: changed.length,
  };
}

/* ---------------------------------------------------------------- */
/* Board accountability — the 3-of-5 standard                        */
/* ---------------------------------------------------------------- */

/**
 * The bar Pixel's Picks is held to, per explicit product direction: "These
 * picks need to hit at least 3/5 or the algorithm needs to reassess its
 * picks again."
 */
export const BOARD_STANDARD_WINS = 3;

/** KV key holding the rolling board-review state and its recent verdicts. */
const BOARD_REVIEW_KEY = 'track:board-review';

/**
 * How far the conviction floor moves after a day that missed the standard,
 * and how far back it relaxes after one that met it.
 *
 * Deliberately asymmetric and small. A single five-pick day is a tiny
 * sample — at a true 55% win rate, missing 3/5 happens more than a third of
 * the time by chance alone — so one bad day must not be able to slam the
 * standard shut, and one good day must not undo a genuine trend in a single
 * step. What this produces is drift under sustained evidence, not a reaction
 * to noise.
 */
const BOARD_TIGHTEN_STEP = 2;
const BOARD_RELAX_STEP = 1;
/** Ceiling on the accumulated adjustment, so a cold streak can't drive the board to zero picks. */
const BOARD_MAX_SCORE_BUMP = 8;

export async function getBoardReview(env) {
  const raw = await env.POTD_KV.get(BOARD_REVIEW_KEY);
  const parsed = raw ? JSON.parse(raw) : null;
  return { scoreBump: 0, lastReviewedDate: null, history: [], ...(parsed ?? {}) };
}

/**
 * Grades yesterday's Pixel's Picks board against the 3-of-5 standard and
 * moves the conviction floor accordingly.
 *
 * Runs once per ET day (idempotent on `lastReviewedDate`), against the most
 * recent day whose picks are ALL settled — reviewing a half-graded day would
 * count still-pending picks as non-wins and manufacture a miss out of a day
 * that hadn't finished yet.
 *
 * Voids are excluded from both halves of the ratio, the same way
 * summarizePicks already excludes them everywhere else: a returned stake is
 * neither a win nor a loss, and counting one as a miss would punish the board
 * for a walkover it had no part in.
 *
 * Reporting only in one specific sense — it moves a floor, it never rewrites
 * a graded result. The Full Slate record stays untouched by design so
 * tomorrow's evidence is still drawn from the unadjusted engine.
 */
export async function runBoardReview(env, ctx, now = Date.now(), { days = 4 } = {}) {
  const review = await getBoardReview(env);
  const today = etDate(now);
  if (review.lastReviewedDate === today) return { skipped: true, reason: 'already reviewed today' };

  // Walk back to the most recent fully-settled day, skipping today (still in
  // progress) and any day still carrying a pending pick.
  let target = null;
  for (let i = 1; i <= days; i++) {
    const dateKey = etDate(now - i * 86400000);
    const { picks } = await loadTrackedPicks(env, dateKey);
    const live = picks.filter((p) => !p.retracted);
    if (!live.length) continue;
    if (live.some((p) => p.status === 'pending')) continue;
    target = { dateKey, picks: live };
    break;
  }
  if (!target) return { skipped: true, reason: 'no fully-settled day to review' };

  const decided = target.picks.filter((p) => p.status === 'won' || p.status === 'lost');
  if (!decided.length) return { skipped: true, reason: 'nothing decided on that day' };

  const wins = decided.filter((p) => p.status === 'won').length;
  // Scaled to the day's real size: a 4-pick day that went 2-4 shouldn't be
  // judged against a bar written for 5.
  const required = Math.ceil((BOARD_STANDARD_WINS / TOP5_COUNT) * decided.length);
  const met = wins >= required;

  const scoreBump = met
    ? Math.max(0, review.scoreBump - BOARD_RELAX_STEP)
    : Math.min(BOARD_MAX_SCORE_BUMP, review.scoreBump + BOARD_TIGHTEN_STEP);

  const entry = { dateKey: target.dateKey, wins, decided: decided.length, required, met, scoreBump, at: now };
  const next = {
    scoreBump,
    lastReviewedDate: today,
    // Bounded so the record stays a useful recent history rather than an
    // ever-growing KV value.
    history: [entry, ...review.history].slice(0, 30),
  };
  ctx.waitUntil(env.POTD_KV.put(BOARD_REVIEW_KEY, JSON.stringify(next), { expirationTtl: KV_TTL_SECONDS }));
  return entry;
}
