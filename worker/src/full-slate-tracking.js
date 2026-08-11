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
import { analyze, clearsMaxJuice } from '../../docs/engine.js';
import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { fetchSport, fetchScores } from './odds.js';
import { pickRecordFrom, fetchFullSlateEvents, isPickWindowOpen } from './tracking.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { isSettleableTennisMarket, hasSecondarySettlementSource } from '../../docs/tennis-tiers.js';
import { settleTennisGameMarket } from './tennis-results.js';

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

// Matches tracking.js's own TENNIS_NEXT_DAY_CUTOFF_HOUR/isEligibleTennisMatch
// — duplicated for the same "never silently diverge from a private helper
// in another file" reason as isEligibleMmaFight above.
const TENNIS_NEXT_DAY_CUTOFF_HOUR = 6;

/**
 * A tennis round can still be running past midnight ET (a night session
 * pushed late, or simply a late start), and the Odds API only ever lists
 * the round that's actually been drawn — no risk of reaching into a future
 * round early. Eligible if it starts today, or before
 * TENNIS_NEXT_DAY_CUTOFF_HOUR tomorrow morning (a match that rolled just
 * past midnight); NOT eligible for an ordinary tomorrow-afternoon start,
 * which belongs on tomorrow's Full Slate, not today's. Confirmed live: the
 * previous "eligible all day tomorrow" version let a completely ordinary
 * next-day match onto today's Full Slate — a real bug report, not just a
 * theoretical one.
 */
function isEligibleTennisMatch(commenceMs, now) {
  const today = etDate(now);
  const commenceDate = etDate(commenceMs);
  if (commenceDate === today) return true;
  const tomorrow = etDate(now + 86400000);
  return commenceDate === tomorrow && etHour(commenceMs) < TENNIS_NEXT_DAY_CUTOFF_HOUR;
}

/**
 * Runs hourly (see index.js's scheduled()), all day — not a single 2am
 * batch anymore. Pulls the full slate (normally the exact same fetch
 * Pixel's Picks and Play of the Day share — see worker/src/index.js's
 * scheduled()), restricts to today's eligible games not already tracked,
 * and — unlike Pixel's Picks/Play of the Day — locks each one in the
 * moment its own game reaches its own reasonable pre-game lock time (see
 * tracking.js's isPickWindowOpen/PICK_LEAD_HOURS), rather than waiting for
 * anything else: there's no "best of the day" comparison here, every game
 * gets exactly one tracked pick regardless of how it stacks up against any
 * other game today, so there's nothing to wait on. No odds band, no score
 * floor, no algorithm-health pause filter — the point is a complete daily
 * record of what the algorithm's own lean was on every game, not a curated
 * shortlist.
 *
 * Self-healing top-up, same pattern as tracking.js's own runTop5Batch: only
 * adds games not already in the manifest, so an already-tracked game's
 * grading/CLV state is never touched. Cheap to call every tick regardless —
 * the manifest read is a single KV get, and a tick with nothing newly
 * eligible just writes back the same pickIds it already had.
 */
export async function runFullSlateBatch(
  env,
  ctx,
  now = Date.now(),
  { fetchFullSlate = () => fetchFullSlateEvents(env, ctx) } = {},
) {
  const dateKey = etDate(now);
  const manifestKey = `slate:${dateKey}:manifest`;
  const existingRaw = await env.POTD_KV.get(manifestKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;
  const existingPickIds = existing?.pickIds ?? [];
  const existingEventIds = new Set(existingPickIds.map((id) => id.split(':')[0]));

  const events = await fetchFullSlate();
  const candidates = analyze(events, { now })
    .filter((c) => {
      if (isMma(c.sportKey)) return isEligibleMmaFight(c.commenceMs, now);
      if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
      return etDate(c.commenceMs) === dateKey;
    })
    .filter((c) => isPickWindowOpen(c, now))
    .filter((c) => !existingEventIds.has(c.eventId));

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
    // Low-variance markets (player props, MLS's BTTS/double-chance) get
    // their own tighter price ceiling (docs/engine.js's
    // LOW_VARIANCE_MAX_AMERICAN) — an overpriced one simply isn't eligible
    // to be this game's one pick, same as an unsettleable tennis line above.
    if (!clearsMaxJuice(c)) continue;
    if (!bestPerGame.has(c.eventId)) bestPerGame.set(c.eventId, c);
  }

  const newPickIds = [];
  for (const candidate of bestPerGame.values()) {
    const wrapped = { legs: [candidate], score: candidate.score, meetsStandard: true, flagReason: null };
    const record = pickRecordFrom(wrapped, dateKey, now);
    newPickIds.push(record.pickId);
    ctx.waitUntil(
      env.POTD_KV.put(`slate:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }

  const pickIds = [...existingPickIds, ...newPickIds];
  ctx.waitUntil(
    env.POTD_KV.put(manifestKey, JSON.stringify({
      date: dateKey, generatedAt: existing?.generatedAt ?? now, lastUpdatedAt: now, pickIds,
    }), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );

  return { skipped: false, dateKey, count: pickIds.length, added: newPickIds.length };
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
      outcome = (await settleTennisGameMarket(pick, scoreEvent, env, ctx, now)) ?? gradePick(pick, scoreEvent, now);
    } else {
      outcome = gradePick(pick, scoreEvent, now);
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

/**
 * Moves a batch of Full Slate picks off `storedDate` onto whatever ET
 * calendar date each one's own commenceMs actually falls on, and returns how
 * many moved. Shared by the one-off admin migration and the continuous
 * hourly resync below.
 *
 * Every pick that needs to move gets its own `dateKey` field rewritten
 * in-place before being re-persisted — not just relocated to a new KV key —
 * because every render path that groups tracked picks by day (see
 * docs/app.js's own comment: "Groups server-tracked picks by their own
 * stored dateKey, not a pickId prefix") reads that field off the record
 * itself, not the KV key it happens to be filed under. Moving only the
 * storage location while leaving a stale dateKey inside the JSON is a
 * no-op from the client's point of view — confirmed live: the first version
 * of this migration did exactly that, and the affected picks kept rendering
 * under their old day even after the KV keys had moved.
 *
 * Manifest updates are batched per source/target date and awaited (not
 * fired via ctx.waitUntil) rather than one read-modify-write per pick: doing
 * it per-pick raced multiple concurrent read-then-writes against the same
 * manifest key when more than one pick left the same day in a single pass,
 * so only the last write survived and the others' removals/additions were
 * silently lost from the manifest (the underlying pick keys still moved
 * correctly, but the manifest could end up listing a pickId that no longer
 * lived at that date, or missing one that did).
 */
async function movePicksOffDate(env, storedDate, now, { dryRun = false, pendingOnly = false } = {}) {
  const manifestKey = `slate:${storedDate}:manifest`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  if (!manifestRaw) return { misdated: [], moved: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickRaws = await Promise.all(
    manifest.pickIds.map((id) => env.POTD_KV.get(`slate:${storedDate}:pick:${id}`)),
  );

  const misdated = [];
  const toMove = []; // { pickId, actualDate, patchedRaw }
  manifest.pickIds.forEach((pickId, i) => {
    const pickRaw = pickRaws[i];
    if (!pickRaw) return;
    const pick = JSON.parse(pickRaw);
    if (pendingOnly && pick.status !== 'pending') return;
    const actualDate = etDate(pick.commenceMs);
    if (actualDate === storedDate) return;

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

  if (!toMove.length) return { misdated, moved: [] };

  // Write each moved pick to its correct date, delete it from the old one.
  await Promise.all(
    toMove.flatMap(({ pickId, actualDate, patchedRaw }) => [
      env.POTD_KV.put(`slate:${actualDate}:pick:${pickId}`, patchedRaw, { expirationTtl: KV_TTL_SECONDS }),
      env.POTD_KV.delete(`slate:${storedDate}:pick:${pickId}`),
    ]),
  );

  // One rewrite of the source manifest, removing every moved pickId at once.
  const movedIds = new Set(toMove.map((m) => m.pickId));
  manifest.pickIds = manifest.pickIds.filter((id) => !movedIds.has(id));
  manifest.lastUpdatedAt = now;
  await env.POTD_KV.put(manifestKey, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });

  // One rewrite per distinct target date, adding every pick that landed there.
  const byTargetDate = new Map();
  for (const { pickId, actualDate } of toMove) {
    if (!byTargetDate.has(actualDate)) byTargetDate.set(actualDate, []);
    byTargetDate.get(actualDate).push(pickId);
  }
  await Promise.all(
    [...byTargetDate.entries()].map(async ([targetDate, pickIds]) => {
      const targetManifestKey = `slate:${targetDate}:manifest`;
      const targetRaw = await env.POTD_KV.get(targetManifestKey);
      const targetManifest = targetRaw
        ? JSON.parse(targetRaw)
        : { date: targetDate, pickIds: [], generatedAt: now };
      const existing = new Set(targetManifest.pickIds);
      for (const id of pickIds) existing.add(id);
      targetManifest.pickIds = [...existing];
      targetManifest.lastUpdatedAt = now;
      return env.POTD_KV.put(targetManifestKey, JSON.stringify(targetManifest), { expirationTtl: KV_TTL_SECONDS });
    }),
  );

  return { misdated, moved: toMove.map(({ pickId, actualDate }) => ({ pickId, from: storedDate, to: actualDate })) };
}

/** Owner-triggered diagnostic/repair over the last `days` of Full Slate tracking — see movePicksOffDate for the actual logic. */
export async function migrateFullSlatePickDates(env, ctx, now = Date.now(), { days = 5 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const results = await Promise.all(dateKeys.map((d) => movePicksOffDate(env, d, now)));
  const misdated = results.flatMap((r) => r.misdated);
  const moved = results.flatMap((r) => r.moved);
  return { misdated, moved, summary: `Found ${misdated.length} misdated picks, moved ${moved.length} to correct dates` };
}

/**
 * Runs every hourly tick alongside runFullSlateClvSnapshot — catches any
 * still-pending pick whose commenceMs has drifted onto a different ET
 * calendar day than the one it's filed under (a live tournament reschedule
 * between the pick locking in and its match's real start time, most often —
 * tennis order-of-play routinely shifts a match to the next day after it's
 * already been tracked) and moves it, the same way the admin migration does.
 * Only ever touches pending picks — a graded one's day is already final and
 * correctly reflects when its game actually happened.
 */
export async function runFullSlateDateResync(env, ctx, now = Date.now(), { days = 2 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const results = await Promise.all(dateKeys.map((d) => movePicksOffDate(env, d, now, { pendingOnly: true })));
  const moved = results.flatMap((r) => r.moved);
  return { moved: moved.length };
}
