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
import { getAllWnbaPropsTracked } from './wnba-props.js';
import { getAllMlbPropsTracked } from './mlb-props.js';
import { getAllNflPropsTracked } from './nfl-props.js';
import { getAllNhlPropsTracked } from './nhl-props.js';
import { applyTennisFormSignal } from '../../docs/qualitative.js';
import { loadTennisArchivesFor } from './tennis-archive.js';
import { retractedRecord } from './retraction.js';

// Matches tracking.js's own FLAT_UNIT_STAKE — duplicated for the same reason
// that file already duplicates it from docs/learning.js: keeps this file's
// own "safe to run in the Worker" boundary obvious without importing a
// constant that sits alongside code this file never calls.
const FLAT_UNIT_STAKE = 20;
const KV_TTL_SECONDS = 86400 * 90; // 90 days — matches every other tracker's retention

// How many ET calendar days back runFullSlateBatch looks for an event it has
// already tracked, so a game whose start time moved after its pick locked in
// can't be picked a second time under a new date. Matches
// GRADING_LOOKBACK_DAYS below (the window grading already walks for the same
// crossing-midnight reason) — 2 days comfortably covers any real reschedule;
// a match moved more than 48h is a different fixture in practice.
const EVENT_DEDUPE_LOOKBACK_DAYS = 2;

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
// 2am, not 6am — matches tracking.js's own constant, set per explicit
// product direction. See that file's comment for the reasoning.
const TENNIS_NEXT_DAY_CUTOFF_HOUR = 2;

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

  // "Already tracked" has to be answered across a window of days, not just
  // today's manifest. An event's start time can move after its pick locked
  // in (tennis order-of-play reschedules routinely shift a match by hours,
  // sometimes across midnight), and when it does, today's batch sees an
  // eventId that isn't in today's manifest — because it's in yesterday's —
  // and tracks the same match a SECOND time. Confirmed live, and it isn't
  // merely a double-count: by the time the second pick was taken the line
  // had moved enough that the engine graded the opposite side highest, so
  // the tracker held Rafael Jodar -105 AND Arthur Fils +100 on the same
  // match, a guaranteed one-win-one-loss bleeding the vig. Checking the
  // same GRADING_LOOKBACK_DAYS window grading already walks keeps one
  // event to one tracked pick even when its date moves underneath us.
  const priorDateKeys = Array.from(
    { length: EVENT_DEDUPE_LOOKBACK_DAYS }, (_, i) => etDate(now - (i + 1) * 86400000),
  );
  const priorManifests = await Promise.all(
    priorDateKeys.map((dk) => env.POTD_KV.get(`slate:${dk}:manifest`)),
  );
  const existingEventIds = new Set(
    [
      ...existingPickIds,
      ...priorManifests.filter(Boolean).flatMap((raw) => JSON.parse(raw).pickIds ?? []),
    ].map((id) => id.split(':')[0]),
  );

  const events = await fetchFullSlate();
  const analyzed = analyze(events, { now })
    .filter((c) => {
      if (isMma(c.sportKey)) return isEligibleMmaFight(c.commenceMs, now);
      if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
      return etDate(c.commenceMs) === dateKey;
    })
    .filter((c) => isPickWindowOpen(c, now))
    .filter((c) => !existingEventIds.has(c.eventId));

  // Tennis form gate (docs/qualitative.js): even though this board is
  // otherwise the unfiltered record of the engine's lean, an unsupported
  // straight-moneyline underdog is removed here too — same precedent as the
  // MMA capper-consensus preference: when a real evidence source
  // contradicts a pure-price read, the recommendation follows the evidence,
  // and the game's slot falls to its next-best candidate (usually the
  // favorite's moneyline) rather than going empty. Re-sorted afterwards
  // because the form re-score can reorder tennis candidates, and the
  // per-game loop below depends on score-descending order.
  const candidates = applyTennisFormSignal(analyzed, await loadTennisArchivesFor(analyzed), { now })
    .sort((a, b) => b.score - a.score);

  // analyze() is already sorted by score descending (re-sorted above after
  // the tennis form re-score), so the first candidate seen for a given
  // eventId is that game's best — one pick per game.
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

  // A player prop can be the game's Main Play (explicit product direction:
  // "the pitcher is more likely to get 5 strikeouts than the team is to
  // win — make the prop the main play"). The per-sport prop scans already
  // score their picks on the SAME 0-100 scale as these team candidates, so
  // the comparison is direct: when a same-game prop priced -200 or better
  // outscores the team market, the prop takes the slot and the displaced
  // team side is kept as `teamLean` so the card still shows the ML/spread
  // lean. Grading is delegated to the prop's own pool via `propRef` — the
  // pool grades from boxscores; this record just mirrors its settlement.
  const PROP_PRICE_FLOOR_DECIMAL = 1.5; // -200 or better, per direction
  const POOL_OF_SPORT = {
    basketball_wnba: 'wnbaprops', baseball_mlb: 'mlbprops',
    americanfootball_nfl: 'nflprops', icehockey_nhl: 'nhlprops',
  };
  let todaysProps = [];
  try {
    const pools = await Promise.all([
      getAllWnbaPropsTracked(env, { now, days: 1 }),
      getAllMlbPropsTracked(env, { now, days: 1 }),
      getAllNflPropsTracked(env, { now, days: 1 }),
      getAllNhlPropsTracked(env, { now, days: 1 }),
    ]);
    todaysProps = pools.flat().filter((p) =>
      p.status === 'pending' && Number(p.decimal) >= PROP_PRICE_FLOOR_DECIMAL && Number.isFinite(p.score));
  } catch { /* props are an upgrade, never a dependency */ }

  for (const [eventId, teamCandidate] of bestPerGame) {
    const gameProps = todaysProps.filter((p) =>
      p.eventId === eventId || (p.home === teamCandidate.home && p.away === teamCandidate.away));
    const bestProp = gameProps.sort((x, y) => y.score - x.score)[0];
    if (!bestProp || bestProp.score <= teamCandidate.score) continue;
    bestPerGame.set(eventId, {
      ...bestProp,
      eventId,
      outcomeName: bestProp.outcomeName ?? bestProp.selection,
      teamLean: {
        selection: teamCandidate.selection,
        marketKey: teamCandidate.marketKey,
        american: teamCandidate.american,
        point: teamCandidate.point ?? null,
      },
      propRef: {
        pool: POOL_OF_SPORT[bestProp.sportKey] ?? null,
        dateKey: bestProp.dateKey ?? dateKey,
        pickId: bestProp.pickId,
      },
    });
  }

  const newPickIds = [];
  for (const candidate of bestPerGame.values()) {
    const wrapped = { legs: [candidate], score: candidate.score, meetsStandard: true, flagReason: null };
    const record = pickRecordFrom(wrapped, dateKey, now, 1); // Full Slate stays 1U
    if (candidate.propRef) { record.propRef = candidate.propRef; record.teamLean = candidate.teamLean; }
    newPickIds.push(record.pickId);
    ctx.waitUntil(
      env.POTD_KV.put(`slate:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }

  const pickIds = [...existingPickIds, ...newPickIds];
  ctx.waitUntil(
    // Spread `existing` rather than building a fresh object: the manifest
    // also carries retractedPickIds (see retractFullSlatePicks), and a
    // literal that only listed the fields this function itself writes would
    // silently drop them — orphaning every retracted record the moment the
    // next hourly top-up ran, which is precisely the tick that follows a
    // retraction.
    env.POTD_KV.put(manifestKey, JSON.stringify({
      ...(existing ?? {}),
      date: dateKey, generatedAt: existing?.generatedAt ?? now, lastUpdatedAt: now, pickIds,
    }), {
      expirationTtl: KV_TTL_SECONDS,
    }),
  );

  return { skipped: false, dateKey, count: pickIds.length, added: newPickIds.length };
}

/**
 * A day's Full Slate records.
 *
 * `picks` includes retracted ones (see retractFullSlatePicks) so the
 * dashboard still shows them, voided, rather than a silent gap where a pick
 * used to be. `pickIds` deliberately does NOT: it's the LIVE set, and every
 * caller that reads it — the batch's own event dedupe, the date migration,
 * the reset sweep — means "picks that still stand." A retracted pick must
 * not keep its game from being re-picked; that re-pick is the entire point
 * of retracting it.
 */
async function loadFullSlateTracked(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`slate:${dateKey}:manifest`);
  if (!manifestRaw) return { pickIds: [], picks: [], retractedPickIds: [] };
  const { pickIds = [], retractedPickIds = [] } = JSON.parse(manifestRaw);
  const [stored, retracted] = await Promise.all([
    Promise.all(pickIds.map((id) => env.POTD_KV.get(`slate:${dateKey}:pick:${id}`))),
    Promise.all(retractedPickIds.map((id) => env.POTD_KV.get(`slate:${dateKey}:retracted:${id}`))),
  ]);
  return {
    pickIds,
    retractedPickIds,
    picks: [...stored, ...retracted].filter(Boolean).map((r) => JSON.parse(r)),
  };
}

/**
 * Pulls every Full Slate pick matching `match` out of the live record for a
 * day and re-files it as a retraction — voided, reason attached, still
 * visible on the dashboard (see worker/src/retraction.js for why a void and
 * not a delete).
 *
 * Retracted records move to their own `slate:<date>:retracted:<pickId>` key
 * rather than staying in place. Two reasons, both load-bearing: the pickId
 * is `${eventId}:${marketKey}|...` (docs/engine.js's analyze()), so a
 * regenerated pick that lands on the SAME market as the one just retracted
 * would otherwise overwrite the retraction and quietly un-void it; and
 * keeping the id out of `pickIds` is what lets the batch's dedupe see the
 * game as un-picked and give it a fresh pick at all.
 */
export async function retractFullSlatePicks(env, { now = Date.now(), dateKey, match, reason }) {
  const day = dateKey ?? etDate(now);
  const manifestKey = `slate:${day}:manifest`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  if (!manifestRaw) return { dateKey: day, retracted: 0, picks: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickIds = manifest.pickIds ?? [];
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`slate:${day}:pick:${id}`)));

  const keptIds = [];
  const pulled = [];
  pickIds.forEach((pickId, i) => {
    const raw = stored[i];
    // A manifest id with no record behind it is already gone (expired TTL,
    // a half-finished migration) — there's nothing to retract, but dropping
    // it here would quietly rewrite history, so it stays listed as-is.
    if (!raw) { keptIds.push(pickId); return; }
    const pick = JSON.parse(raw);
    if (!match(pick)) { keptIds.push(pickId); return; }
    pulled.push(retractedRecord(pick, { reason, at: now }));
  });

  if (!pulled.length) return { dateKey: day, retracted: 0, picks: [] };

  await Promise.all(pulled.flatMap((pick) => [
    env.POTD_KV.put(`slate:${day}:retracted:${pick.pickId}`, JSON.stringify(pick), {
      expirationTtl: KV_TTL_SECONDS,
    }),
    env.POTD_KV.delete(`slate:${day}:pick:${pick.pickId}`),
  ]));

  manifest.pickIds = keptIds;
  manifest.retractedPickIds = [...new Set([...(manifest.retractedPickIds ?? []), ...pulled.map((p) => p.pickId)])];
  manifest.lastUpdatedAt = now;
  await env.POTD_KV.put(manifestKey, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });

  return { dateKey: day, retracted: pulled.length, picks: pulled };
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
  let rescheduled = 0;
  for (const pick of pending) {
    // Prop main plays settle by mirroring their prop pool's own record —
    // the pool grades from real boxscores; duplicating that here would be
    // a second, drift-prone grader for the same bet.
    if (pick.propRef?.pool && pick.propRef.pickId) {
      try {
        const raw = await env.POTD_KV.get(`${pick.propRef.pool}:${pick.propRef.dateKey}:pick:${pick.propRef.pickId}`);
        const source = raw ? JSON.parse(raw) : null;
        if (source && source.status !== 'pending') {
          pick.status = source.status;
          pick.result = source.result ?? null;
          graded++;
          ctx.waitUntil(env.POTD_KV.put(`slate:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
            expirationTtl: KV_TTL_SECONDS,
          }));
        }
      } catch { /* stays pending until the pool settles */ }
      continue;
    }
    const scoreEvent = (scoreEventsBySport.get(pick.sportKey) ?? []).find((e) => e.id === pick.eventId);

    // A pick's commenceMs is a snapshot taken when it locked in, and for
    // tennis especially that snapshot goes stale: order-of-play routinely
    // pushes a match hours or a full day later, and nothing here ever
    // re-read it. Confirmed live — two Aug 10 matches sat "pending" looking
    // like a grading failure when the feed had long since moved them to Aug
    // 11; they hadn't been played yet. The date-resync couldn't see it
    // either, since it only compares a pick's own stored commenceMs against
    // its storage date and those agreed with each other. The freshest time
    // is already in hand here at zero extra cost — this pass has to fetch
    // /scores for every pending pick's sport regardless — so refresh it.
    if (scoreEvent?.commence_time) {
      const freshCommenceMs = Date.parse(scoreEvent.commence_time);
      if (Number.isFinite(freshCommenceMs) && freshCommenceMs !== pick.commenceMs) {
        const movedDay = etDate(freshCommenceMs) !== pick.dateKey;
        pick.commenceMs = freshCommenceMs;
        rescheduled++;
        ctx.waitUntil(
          env.POTD_KV.put(`slate:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
            expirationTtl: KV_TTL_SECONDS,
          }),
        );
        // Landed on a different ET day: this record is now misfiled, and
        // grading it here would settle it under the wrong day permanently
        // (the resync only re-buckets picks that are still pending). Leave
        // it pending; runFullSlateDateResync moves it on a following tick
        // and grading picks it up there, under the right day.
        if (movedDay) continue;
      }
    }

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
    pick.result = {
      payout: outcome.payout,
      roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
      voidReason: outcome.void ? outcome.reason : undefined,
      // Same settlement-time display detail as tracking.js's runGrading.
      detail: outcome.detail ?? undefined,
    };
    graded++;
    ctx.waitUntil(
      env.POTD_KV.put(`slate:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
  }
  return { graded, remaining: pending.length - graded, rescheduled };
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
    const { pickIds, retractedPickIds } = await loadFullSlateTracked(env, dateKey);
    for (const id of pickIds) {
      await env.POTD_KV.delete(`slate:${dateKey}:pick:${id}`);
      deleted++;
    }
    // Retracted records live under their own key prefix and are listed
    // separately in the manifest — a sweep that only walked pickIds would
    // drop the manifest while leaving them behind as unreachable orphans.
    for (const id of retractedPickIds) {
      await env.POTD_KV.delete(`slate:${dateKey}:retracted:${id}`);
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
  if (!manifestRaw) return { misdated: [], moved: [], relabeled: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickRaws = await Promise.all(
    manifest.pickIds.map((id) => env.POTD_KV.get(`slate:${storedDate}:pick:${id}`)),
  );

  const misdated = [];
  const toMove = []; // { pickId, actualDate, patchedRaw }
  // A pick can already be filed under the right KV location (storedDate ===
  // actualDate) while its own dateKey field still says otherwise — leftover
  // damage from the first version of this migration, which relocated the KV
  // key but never touched the field docs/app.js actually groups by. That
  // needs an in-place field patch, not a move: no manifest change, same key,
  // just a corrected payload.
  const toRelabel = []; // { pickId, patchedRaw }
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
        env.POTD_KV.put(`slate:${storedDate}:pick:${pickId}`, patchedRaw, { expirationTtl: KV_TTL_SECONDS })),
    );
  }

  if (!toMove.length) return { misdated, moved: [], relabeled: toRelabel.map((r) => r.pickId) };

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

  return {
    misdated,
    moved: toMove.map(({ pickId, actualDate }) => ({ pickId, from: storedDate, to: actualDate })),
    relabeled: toRelabel.map((r) => r.pickId),
  };
}

/**
 * Collapses an event that ended up with more than one tracked pick on the
 * same day back to the single pick that was actually locked in first.
 *
 * This is the repair half of EVENT_DEDUPE_LOOKBACK_DAYS above: a match whose
 * start time moved after being tracked could be picked again by a later
 * day's batch, and once the date-resync files both records under the match's
 * real day, that day holds two picks on one game — in the confirmed live
 * case, on OPPOSITE SIDES (Rafael Jodar -105 and Arthur Fils +100), which is
 * a guaranteed one-win-one-loss rather than merely a double-count.
 *
 * The earliest-generated pick is the keeper, always. That's the one the
 * algorithm actually committed to at the time, and this file's whole premise
 * (see the module header on tracking.js) is that a locked pick never changes
 * after the fact — keeping the later one would be retroactively re-picking a
 * game with information the original lock didn't have, which is exactly the
 * hindsight this tracker exists to rule out. Its commenceMs IS refreshed
 * from the newest duplicate, though: the later record saw the corrected
 * start time, and a keeper carrying a stale one would keep landing in the
 * wrong day's bucket and mis-time its own grading window.
 *
 * Only ever collapses picks that are still pending or all-unsettled. If any
 * duplicate already carries a real graded result, the group is left entirely
 * alone and reported instead — deleting settled history is not a repair this
 * should make unattended.
 */
async function dedupeEventPicksOnDate(env, storedDate, now) {
  const manifestKey = `slate:${storedDate}:manifest`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  if (!manifestRaw) return { collapsed: [], skippedGraded: [] };

  const manifest = JSON.parse(manifestRaw);
  const pickRaws = await Promise.all(
    manifest.pickIds.map((id) => env.POTD_KV.get(`slate:${storedDate}:pick:${id}`)),
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
    // The newest duplicate saw the most recently corrected start time.
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
      env.POTD_KV.put(`slate:${storedDate}:pick:${pickId}`, patchedRaw, { expirationTtl: KV_TTL_SECONDS })),
    ...dropIds.map((id) => env.POTD_KV.delete(`slate:${storedDate}:pick:${id}`)),
  ]);

  if (dropIds.length) {
    const dropSet = new Set(dropIds);
    manifest.pickIds = manifest.pickIds.filter((id) => !dropSet.has(id));
    manifest.lastUpdatedAt = now;
    await env.POTD_KV.put(manifestKey, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });
  }

  return { collapsed, skippedGraded };
}

/** Owner-triggered diagnostic/repair over the last `days` of Full Slate tracking — see movePicksOffDate/dedupeEventPicksOnDate for the actual logic. */
export async function migrateFullSlatePickDates(env, ctx, now = Date.now(), { days = 5 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const results = await Promise.all(dateKeys.map((d) => movePicksOffDate(env, d, now)));
  const misdated = results.flatMap((r) => r.misdated);
  const moved = results.flatMap((r) => r.moved);
  const relabeled = results.flatMap((r) => r.relabeled);

  // Dedupe AFTER the date fixes above, not before: two picks on one event
  // only land on the same day once each has been filed under its match's
  // real date, so running this first would miss exactly the case that
  // motivated it.
  const dedupeResults = await Promise.all(dateKeys.map((d) => dedupeEventPicksOnDate(env, d, now)));
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
 * Runs every tick alongside runFullSlateClvSnapshot — catches any
 * still-pending pick whose commenceMs has drifted onto a different ET
 * calendar day than the one it's filed under (a live tournament reschedule
 * between the pick locking in and its match's real start time, most often —
 * tennis order-of-play routinely shifts a match to the next day after it's
 * already been tracked) and moves it, the same way the admin migration does.
 * Only ever touches pending picks — a graded one's day is already final and
 * correctly reflects when its game actually happened.
 *
 * Then collapses any event left holding more than one still-pending pick,
 * which is the state a reschedule used to produce before
 * EVENT_DEDUPE_LOOKBACK_DAYS closed the hole at pick time. Runs after the
 * date fixes for the reason dedupeEventPicksOnDate's own comment gives:
 * duplicates only converge onto one day once both are filed correctly.
 * Graded groups are left alone here exactly as they are in the admin path.
 */
export async function runFullSlateDateResync(env, ctx, now = Date.now(), { days = 2 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const results = await Promise.all(dateKeys.map((d) => movePicksOffDate(env, d, now, { pendingOnly: true })));
  const moved = results.flatMap((r) => r.moved);

  const dedupeResults = await Promise.all(dateKeys.map((d) => dedupeEventPicksOnDate(env, d, now)));
  const collapsed = dedupeResults.flatMap((r) => r.collapsed);

  return { moved: moved.length, collapsed: collapsed.length };
}
