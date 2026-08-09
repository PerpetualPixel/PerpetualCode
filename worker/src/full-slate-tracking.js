/**
 * Full Slate tracking — one pick per game, across every sport, every day,
 * unconditionally. Unlike Pixel's Picks (worker/src/tracking.js) and Play of
 * the Day (worker/src/potd.js), this applies no odds band, no score floor,
 * and no algorithm-health circuit breaker: the point is a complete daily
 * record of what the algorithm's own lean was on every game, not a curated
 * shortlist. A coin-flip −105/−115 line gets tracked exactly the same as a
 * real edge.
 *
 * "One pick per game": for a game with multiple markets (moneyline, spread,
 * total), only the single highest-scoring candidate across all of them is
 * tracked — not one pick per market. analyze() already returns candidates
 * sorted by score descending, so the first candidate seen per eventId is
 * that game's best; no separate sort needed here.
 *
 * Mirrors worker/src/tracking.js's structure closely (this codebase's own
 * convention — see that file's own comments — is to duplicate small,
 * parallel worker modules rather than share code across them), except
 * pickRecordFrom itself: that record-shape mapping is correctness-critical
 * (every shared dashboard rendering helper depends on its exact field list),
 * so it's imported from tracking.js rather than re-implemented here.
 */
import { analyze } from '../../docs/engine.js';
import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { fetchSport, fetchScores } from './odds.js';
import { pickRecordFrom, fetchFullSlateEvents } from './tracking.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { isSettleableTennisMarket, hasSecondarySettlementSource } from '../../docs/tennis-tiers.js';
import { settleTennisGameMarket } from './tennis-results.js';

export const FULL_SLATE_BATCH_HOUR = 2; // 2am ET — same run as Pixel's Picks/Play of the Day
// Matches tracking.js's own FLAT_UNIT_STAKE — duplicated for the same reason
// that file already duplicates it from docs/learning.js: keeps this file's
// own "safe to run in the Worker" boundary obvious without importing a
// constant that sits alongside code this file never calls.
const FLAT_UNIT_STAKE = 20;
const KV_TTL_SECONDS = 86400 * 90; // 90 days — matches every other tracker's retention

/** ET calendar date (YYYY-MM-DD) for a given instant — same as tracking.js's own etDate. */
function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** ET wall-clock hour for a given instant, DST-safe — same as tracking.js's own etHour. */
function etHour(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  return Number(fmt.format(ms)) % 24;
}

// Matches tracking.js's own MMA_NEXT_DAY_CUTOFF_HOUR/isEligibleMmaFight —
// duplicated rather than imported so this file's eligibility window can
// never silently diverge from a private (unexported) helper in another file;
// both trackers should use today's ET date as "today," a late main event
// included.
const MMA_NEXT_DAY_CUTOFF_HOUR = 6;
function isEligibleMmaFight(commenceMs, now) {
  const today = etDate(now);
  const commenceDate = etDate(commenceMs);
  if (commenceDate === today) return true;
  const tomorrow = etDate(now + 86400000);
  return commenceDate === tomorrow && etHour(commenceMs) < MMA_NEXT_DAY_CUTOFF_HOUR;
}

// Matches tracking.js's own isEligibleTennisMatch — duplicated for the same
// "never silently diverge from a private helper in another file" reason as
// isEligibleMmaFight above. A tennis round routinely spans two calendar
// days (day/night sessions, weather pushes), and the Odds API only ever
// lists the round that's actually been drawn — no risk of reaching into a
// future round early. Confirmed live: the Odds API's reigning ATP/WTA
// Canadian Open round split roughly 4-and-4 across today and tomorrow by
// start time; the plain same-ET-day check was excluding exactly half of
// what's really one round from Full Slate tracking.
function isEligibleTennisMatch(commenceMs, now) {
  const today = etDate(now);
  const commenceDate = etDate(commenceMs);
  if (commenceDate === today) return true;
  const tomorrow = etDate(now + 86400000);
  return commenceDate === tomorrow;
}

/**
 * The 2am ET batch: pull the full slate (normally the exact same fetch
 * Pixel's Picks and Play of the Day share at the same hour — see
 * worker/src/index.js's scheduled()), restrict to today's eligible games
 * (same day-boundary rule tracking.js's runTop5Batch uses), pick the single
 * best-scoring candidate per game, and store all of them — no odds band, no
 * score floor, no algorithm-health pause filter. Runs at most once per ET
 * calendar day (checked via the day's own manifest key).
 */
export async function runFullSlateBatch(
  env,
  ctx,
  now = Date.now(),
  { fetchFullSlate = () => fetchFullSlateEvents(env, ctx) } = {},
) {
  const dateKey = etDate(now);
  const manifestKey = `slate:${dateKey}:manifest`;
  const existing = await env.POTD_KV.get(manifestKey);
  if (existing) return { skipped: true, reason: 'already generated today', dateKey };

  const events = await fetchFullSlate();
  const candidates = analyze(events, { now })
    .filter((c) => {
      if (isMma(c.sportKey)) return isEligibleMmaFight(c.commenceMs, now);
      if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
      return etDate(c.commenceMs) === dateKey;
    });

  // analyze() is already sorted by score descending, so the first candidate
  // seen for a given eventId is that game's best — one pick per game.
  //
  // Tennis is the one exception: its spreads and totals are priced in games
  // while the free /scores reports sets, so they can't be settled by that
  // source alone (see docs/tennis-tiers.js's isSettleableTennisMarket). A
  // TIER_1 match's spread/total is now attemptable through a second,
  // metered source (worker/src/tennis-results.js) at grading time, so it's
  // no longer a GUARANTEED void the way it is at TIER_2/Challenger — those
  // stay moneyline-only here too, same as before, since a wasted candidate
  // there would still just void. A TIER_1 spread/total that the second
  // source can't ultimately settle still falls back to the existing void,
  // same as it always has; this only ever adds a chance at a real grade; it
  // never removes coverage a match already had.
  const bestPerGame = new Map();
  for (const c of candidates) {
    const settleable = isSettleableTennisMarket(c.marketKey) || hasSecondarySettlementSource(c.sportKey, c.marketKey);
    if (isTennis(c.sportKey) && !settleable) continue;
    if (!bestPerGame.has(c.eventId)) bestPerGame.set(c.eventId, c);
  }

  const pickIds = [];
  for (const candidate of bestPerGame.values()) {
    const wrapped = { legs: [candidate], score: candidate.score, meetsStandard: true, flagReason: null };
    const record = pickRecordFrom(wrapped, dateKey, now);
    pickIds.push(record.pickId);
    ctx.waitUntil(
      env.POTD_KV.put(`slate:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }

  ctx.waitUntil(
    env.POTD_KV.put(manifestKey, JSON.stringify({ date: dateKey, generatedAt: now, pickIds }), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );

  return { skipped: false, dateKey, count: pickIds.length, gameCount: bestPerGame.size };
}

async function loadFullSlateTracked(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`slate:${dateKey}:manifest`);
  if (!manifestRaw) return { pickIds: [], picks: [] };
  const { pickIds } = JSON.parse(manifestRaw);
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`slate:${dateKey}:pick:${id}`)));
  return { pickIds, picks: stored.filter(Boolean).map((r) => JSON.parse(r)) };
}

/** Same "freshest price before kickoff" CLV approximation as tracking.js's own runClvSnapshot, keyed under slate: instead of track:. */
export async function runFullSlateClvSnapshot(
  env,
  ctx,
  now = Date.now(),
  { fetchSportFn = (s) => fetchSport(s, env, ctx) } = {},
) {
  const dateKey = etDate(now);
  const { picks } = await loadFullSlateTracked(env, dateKey);
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
      env.POTD_KV.put(`slate:${dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }
  return { checked: picks.length, updated };
}

// Same reasoning and value as tracking.js's own GRADING_LOOKBACK_DAYS —
// duplicated for the same "don't import a private constant across worker
// files" reason as MMA_NEXT_DAY_CUTOFF_HOUR above. Full Slate tracks every
// MMA fight on the board (not just the ones that also clear Pixel's Picks'
// sharp standard), so this bug bit it hardest: a whole late card's worth of
// pending picks silently stopped being looked at the instant the ET date
// rolled over mid-card.
const GRADING_LOOKBACK_DAYS = 2;

/**
 * Same continuous, idempotent grading as tracking.js's own runGrading, keyed
 * under slate: instead of track: — including the same ESPN fallback for MMA
 * picks (see worker/src/ufc-events.js's gradeMmaPickWithFallback), since
 * Full Slate tracks every MMA fight on the board, not just the ones that
 * also happen to clear Pixel's Picks' own sharp standard. Also looks back
 * GRADING_LOOKBACK_DAYS ET calendar days rather than just today's, so a
 * pick from a card that crossed midnight never gets orphaned.
 */
export async function runFullSlateGrading(
  env,
  ctx,
  now = Date.now(),
  { fetchScoresFn = (s) => fetchScores(s, env, ctx), fetchMmaResultsFn = () => fetchMmaResults(ctx, now) } = {},
) {
  const dateKeys = [...new Set(
    Array.from({ length: GRADING_LOOKBACK_DAYS }, (_, i) => etDate(now - i * 86400000)),
  )];
  const loaded = await Promise.all(dateKeys.map((dk) => loadFullSlateTracked(env, dk)));
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
      outcome = (await settleTennisGameMarket(pick, scoreEvent, env, ctx, now)) ?? gradePick(pick, scoreEvent);
    } else {
      outcome = gradePick(pick, scoreEvent);
    }
    if (!outcome) continue;
    pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    pick.result = { payout: outcome.payout, roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100, voidReason: outcome.void ? outcome.reason : undefined };
    graded++;
    ctx.waitUntil(
      env.POTD_KV.put(`slate:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }
  return { graded, remaining: pending.length - graded };
}

/** Today's tracked Full Slate picks (or a specific date's). */
export async function getFullSlateTracked(env, { now = Date.now(), dateKey } = {}) {
  const { picks } = await loadFullSlateTracked(env, dateKey ?? etDate(now));
  return picks;
}

/** Every Full Slate pick across every day still in KV, same day-walk pattern as tracking.js's own getAllTrackedPicks. */
export async function getAllFullSlateTracked(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(etDate(now - i * 86400000));
  }
  const perDay = await Promise.all(dateKeys.map((d) => loadFullSlateTracked(env, d)));
  return perDay.flatMap((d) => d.picks);
}

/** Wipes every Full Slate tracked pick and manifest — the Full Slate counterpart to tracking.js's resetAllTracking, called alongside it by the same "Archive & Reset All Tracking" button. */
export async function resetFullSlateTracking(env, { now = Date.now(), days = 90 } = {}) {
  let deleted = 0;
  for (let i = 0; i < days; i++) {
    const dateKey = etDate(now - i * 86400000);
    const { pickIds } = await loadFullSlateTracked(env, dateKey);
    for (const id of pickIds) {
      await env.POTD_KV.delete(`slate:${dateKey}:pick:${id}`);
      deleted++;
    }
    await env.POTD_KV.delete(`slate:${dateKey}:manifest`);
  }
  return { deleted };
}
