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
import { analyze, topPicks } from '../../docs/engine.js';
import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { CONFIG } from '../../docs/config.js';
import { fetchSport, fetchScores, fetchCatalogue } from './odds.js';
import { getAlgoConfig, getPausedSegments, isSegmentPaused } from './algo-health.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';

export const TOP5_COUNT = 5;
export const TOP5_BATCH_HOUR = 2; // 2am ET — same run as Play of the Day
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

/**
 * A tennis round routinely spans two calendar days (a day session and a
 * night session, or matches simply pushed by weather/court scheduling), and
 * the Odds API only ever lists the round that's actually been drawn — the
 * next round's matchups don't exist in the feed at all until the current
 * one finishes — so there's no risk of this reaching into a future round
 * early. Eligible if it starts today or tomorrow's ET date; no hour cutoff
 * needed the way MMA's single-card-crossing-midnight case does, since
 * tennis matches aren't one continuous show. Confirmed live: the Odds API's
 * reigning ATP/WTA Canadian Open round split its matches roughly 4-and-4
 * across today and tomorrow by start time — the plain same-ET-day check
 * this replaces was excluding exactly half of what's really one round.
 */
function isEligibleTennisMatch(commenceMs, now) {
  const today = etDate(now);
  const commenceDate = etDate(commenceMs);
  if (commenceDate === today) return true;
  const tomorrow = etDate(now + 86400000);
  return commenceDate === tomorrow;
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

/** Every event across the full slate, merged — sports that failed to fetch just contribute nothing rather than failing the whole batch. */
export async function fetchFullSlateEvents(env, ctx) {
  const keys = await fullSlateSportKeys(env, ctx);
  const results = await Promise.all(keys.map((k) => fetchSport(k, env, ctx)));
  const events = [];
  for (const r of results) {
    if (r.events) events.push(...r.events);
  }
  return events;
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
    marketKey: leg.marketKey,
    outcomeName: leg.outcomeName,
    point: leg.point ?? null,
    selection: leg.selection,
    american: leg.american,
    decimal: leg.decimal,
    book: leg.book,
    score: pick.score,
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
 * The 2am ET batch: pull the full slate, run the existing, unmodified
 * topPicks() with the exact same sharp standard (-250/+250, confidence
 * floor) and EV/Kelly edge floor Pixel's Picks itself enforces, and store
 * the result as the locked "Pixel's Picks" board for the day — the same set
 * the client tab now renders (see docs/app.js's loadPixelPicks()) instead of
 * recomputing live against drifting prices. guaranteeCount is on: the board
 * always shows at least 5, padding with flagged (meetsStandard: false) picks
 * on a thin day rather than shrinking — but minEv/minKelly stay a hard floor
 * even for the padding, so a -EV or dust-edge candidate never fills a slot
 * just to hit the count.
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
 * call on every cron tick after the batch hour (see index.js's scheduled()):
 * the manifest read is a single KV get, and the real full-slate fetch only
 * happens when the board is actually short.
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
  const [algoConfig, pausedSegments] = await Promise.all([getAlgoConfig(env), getPausedSegments(env)]);

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
  const candidates = analyze(events, { now })
    .filter((c) => {
      if (isMma(c.sportKey)) return isEligibleMmaFight(c.commenceMs, now);
      if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
      return etDate(c.commenceMs) === dateKey;
    })
    .filter((c) => !isSegmentPaused(c, pausedSegments))
    .filter((c) => !existingEventIds.has(c.eventId));

  const slate = topPicks(candidates, {
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
    const outcome = isMma(pick.sportKey)
      ? gradeMmaPickWithFallback(pick, scoreEvent, mmaResults)
      : gradePick(pick, scoreEvent);
    if (!outcome) continue;
    pick.status = outcome.won ? 'won' : 'lost';
    pick.result = { payout: outcome.payout, roiPercent: (outcome.payout / pick.suggested_stake) * 100 };
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
