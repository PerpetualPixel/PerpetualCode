/**
 * Server-side Top 5 daily tracked picks: a 6am ET batch that runs the
 * existing engine (unmodified — same topPicks(), same RULES.MIN_EV_PCT/
 * MIN_KELLY_FRACTION floor Pixel Picks itself uses) against the full slate
 * and stores the result in KV so it survives independent of any one user's
 * browser; an hourly CLV snapshot for whatever's still pending; and a
 * grading pass (also hourly, not just at a single nightly instant — see
 * runGrading's own note) that fetches scores and grades via the exact same
 * gradePick() the client's own "Check Results" button uses.
 *
 * This is deliberately a *second*, independent tracking record from the
 * browser-local IndexedDB one in docs/learning.js — that one is per-device
 * and stays that way; this one exists specifically so the Top 5 has a
 * single, server-side, always-on history that doesn't depend on anyone
 * having the app open.
 */
import { analyze, topPicks, RULES } from '../../docs/engine.js';
import { gradePick } from '../../docs/learning.js';
import { CONFIG } from '../../docs/config.js';
import { fetchSport, fetchScores, fetchCatalogue } from './odds.js';

export const TOP5_COUNT = 5;
export const TOP5_BATCH_HOUR = 6; // 6am ET
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

function pickRecordFrom(pick, dateKey, now) {
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
  };
}

/**
 * The 6am ET batch: pull the full slate, run the existing, unmodified
 * topPicks() with the exact same sharp standard (-250/+250, confidence
 * floor) and EV/Kelly edge floor Pixel Picks itself enforces, and store the
 * top 5 as this app's own dedicated tracked leaderboard. guaranteeCount is
 * deliberately off — a day without 5 genuine edges gets fewer than 5 rather
 * than padding the featured list with a pick that doesn't clear the bar.
 * Runs at most once per ET calendar day (checked via the day's own manifest
 * key), so a redeploy or a retried cron tick can't silently re-pick a
 * different 5 partway through the day.
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
  const existing = await env.POTD_KV.get(manifestKey);
  if (existing) return { skipped: true, reason: 'already generated today', dateKey };

  const events = await fetchFullSlate();
  const candidates = analyze(events, { now });

  const slate = topPicks(candidates, {
    count: TOP5_COUNT,
    oddsMin: CONFIG.ODDS_MIN_DEFAULT,
    oddsMax: CONFIG.ODDS_MAX_DEFAULT,
    minScore: CONFIG.MIN_SCORE_DEFAULT,
    minEv: RULES.MIN_EV_PCT,
    minKelly: RULES.MIN_KELLY_FRACTION,
    guaranteeCount: false,
  });

  const pickIds = [];
  for (const pick of slate.picks) {
    const record = pickRecordFrom(pick, dateKey, now);
    pickIds.push(record.pickId);
    ctx.waitUntil(
      env.POTD_KV.put(`track:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }

  ctx.waitUntil(
    env.POTD_KV.put(manifestKey, JSON.stringify({ date: dateKey, generatedAt: now, pickIds }), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );

  return { skipped: false, dateKey, count: pickIds.length, poolSize: slate.poolSize };
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

/**
 * Grades whatever's pending and has a completed score available, via the
 * exact same gradePick() the client's own "Check Results" button already
 * uses. Deliberately runs on every hourly tick rather than being gated to a
 * single "11:59pm" instant — grading is idempotent (it only ever touches
 * still-pending picks) and strictly better run more often: a pick from an
 * early-afternoon game gets graded within the hour instead of sitting
 * "pending" until midnight for no reason. A late-finishing game just stays
 * pending until whichever hourly tick finds it complete, including the
 * final ones of the night — so this still covers the "grade by end of day"
 * intent, just without an artificial single deadline.
 */
export async function runGrading(
  env,
  ctx,
  now = Date.now(),
  { fetchScoresFn = (s) => fetchScores(s, env, ctx) } = {},
) {
  const dateKey = etDate(now);
  const { picks } = await loadTrackedPicks(env, dateKey);
  const pending = picks.filter((p) => p.status === 'pending');
  if (!pending.length) return { graded: 0, remaining: 0 };

  const sportsNeeded = [...new Set(pending.map((p) => p.sportKey))];
  const fetched = await Promise.all(sportsNeeded.map((s) => fetchScoresFn(s)));
  const scoreEventsBySport = new Map(sportsNeeded.map((s, i) => [s, fetched[i].events ?? []]));

  let graded = 0;
  for (const pick of pending) {
    const scoreEvent = (scoreEventsBySport.get(pick.sportKey) ?? []).find((e) => e.id === pick.eventId);
    const outcome = gradePick(pick, scoreEvent);
    if (!outcome) continue;
    pick.status = outcome.won ? 'won' : 'lost';
    pick.result = { payout: outcome.payout, roiPercent: (outcome.payout / pick.suggested_stake) * 100 };
    graded++;
    ctx.waitUntil(
      env.POTD_KV.put(`track:${dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
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
