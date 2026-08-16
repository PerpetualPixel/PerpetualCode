/**
 * The Ladder Challenge — one lower-risk play a day, every win rolled
 * straight into the next bet, a loss back to the bottom rung.
 *
 * This is a different shape of bet from everything else the app tracks. Play
 * of the Day, Pixel's Picks and Full Slate all flat-stake: every pick risks
 * the same unit, and a bad day costs one unit. The ladder compounds — the
 * whole bankroll rides on each rung, so eight straight wins turn $20 into
 * $360 and a single loss ends the run. That's the point of it, and it's why
 * the ladder is tracked as RUNS (a climb that ended, and how far it got)
 * rather than as a win rate over picks.
 *
 * The rungs
 * ---------
 * Start at LADDER_BASE ($20). Every rung bets the entire current bankroll at
 * roughly -200, so a win pays 1.5x. Whenever the bankroll first passes a
 * milestone ($40, $120, $240) the excess above it is skimmed off and banked —
 * real profit taken out of the challenge and kept, which is what makes a run
 * worth something even when it eventually breaks. Reaching LADDER_TARGET
 * ($360) completes the climb. The ideal path (see ladderPlan) is 8 rungs:
 *
 *   20 → 30 → 45 (bank 5, carry 40) → 60 → 90 → 135 (bank 15, carry 120)
 *      → 180 → 270 (bank 30, carry 240) → 360.  Banked 50, final 360.
 *
 * That's the same ladder shape as the $100 → $2,050 version this was
 * modelled on, scaled to a $20 start.
 *
 * Plan vs. reality
 * ----------------
 * ladderPlan is the ideal path at exactly -200. The tracked bankroll is
 * ACTUAL money: a rung filled at -175 banks a little less than the plan and
 * one at -230 a little more, and the skim/target rules are applied to the
 * real number, never to the plan's. The plan is shown as a map, not as a
 * record of what happened.
 *
 * The pick
 * --------
 * LADDER_MIN_AMERICAN..LADDER_MAX_AMERICAN (-200..+120), nearest -200
 * preferred among comparable candidates, and never the day's Play of the Day
 * or Prop Play of the Day, nor anything contradicting a pick the app has
 * already posted today. It MAY be a Pixel's Pick — the ladder is a different
 * stake plan over the same board, not a promise of a different game. On a day
 * where nothing clears those bars the ladder simply holds: no rung, no
 * bankroll change, and the run keeps its place.
 *
 * Storage: Workers KV (the same POTD_KV binding the other daily surfaces
 * use). `ladder:state` is the live run, `ladder:play:<date>` is a day's play,
 * `ladder:runs` is the archive of finished climbs.
 */

import { analyze, RULES, clearsMaxJuice, isNflPreseason } from '../../docs/engine.js';
import { isPower4Matchup } from '../../docs/ncaaf-conferences.js';
import { isTennis, isMma } from '../../docs/insights.js';
import { gradePick } from '../../docs/learning.js';
import { fetchScores } from './odds.js';
import { getPausedSegments, isSegmentPaused } from './algo-health.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { fetchTennisResults, gradeTennisPickWithEspn, isRegradableTennisVoid, isNoOpTennisRegrade } from './tennis-espn.js';
import { applyTennisFormSignal } from '../../docs/qualitative.js';
import { loadTennisArchivesFor } from './tennis-archive.js';
import { isPickWindowOpen } from './tracking.js';
import { scheduleStillOpen, isExhibition, isEligibleTennisMatch, etParts, etDatePlusDays } from './potd.js';

export const LADDER_BASE = 20;
/** Skim points: the first time the bankroll passes one, everything above it is banked. */
export const LADDER_MILESTONES = [40, 120, 240];
/** Reaching this completes the climb. */
export const LADDER_TARGET = 360;
/** The price the ladder is designed around — every win pays 1.5x at -200. */
export const LADDER_TARGET_AMERICAN = -200;
/**
 * The selection band: no heavier than -200, no longer than +120.
 *
 * Widened from an earlier -250..-165 on explicit product direction. Two
 * consequences worth knowing, since this is the one surface that compounds:
 *
 * 1. -200 is now the SAFE edge of the band rather than its centre, so the
 *    near-tie rule below (break toward LADDER_TARGET_AMERICAN) now always
 *    resolves a tie toward the heaviest-favoured candidate available. For a
 *    bankroll that rides every rung, that is the right direction to lean.
 * 2. The plan (ladderPlan) still models 1.5x per rung because that is what
 *    -200 pays. A rung actually taken at +120 pays 2.2x, so real bankroll
 *    can run AHEAD of plan — which is exactly why tracked bankroll and plan
 *    are stored separately and always have been.
 */
export const LADDER_MIN_AMERICAN = -200;
export const LADDER_MAX_AMERICAN = 120;
/**
 * Two candidates within this much of each other on score are treated as
 * equally good, and the tie breaks toward whichever is priced closest to
 * -200 — the ladder's math is built on 1.5x, so among plays the algorithm
 * rates the same, the one that actually pays 1.5x is the right one. Same
 * near-tie shape prop-play.js uses to break its own pairing ties.
 */
const NEAR_TIE_SCORE = 3;
const KV_TTL_SECONDS = 86400 * 90;
/** How many finished climbs the archive keeps. */
const MAX_ARCHIVED_RUNS = 60;
/** Same reasoning as potd.js's own GRADING_LOOKBACK_DAYS. */
const GRADING_LOOKBACK_DAYS = 3;

const STATE_KEY = 'ladder:state';
const RUNS_KEY = 'ladder:runs';
const playKey = (dateKey) => `ladder:play:${dateKey}`;
const poolKey = (dateKey) => `ladder-pool:${dateKey}`;
/**
 * Why today has no rung yet. runLadderDaily already returned this as a
 * {skipped, reason} on every tick, but that value only ever went to the
 * cron's own return — so from outside, "the ladder is holding because the
 * day's field hasn't settled" and "the ladder found nothing it could bet"
 * and "something is broken" all looked identical: an empty section. This
 * persists the reason so /ladder can say which it is.
 */
const statusKey = (dateKey) => `ladder:status:${dateKey}`;

/** Money is compared and stored to the cent; floating point is not allowed to invent a third decimal. */
const money = (n) => Math.round(n * 100) / 100;

/**
 * The ideal climb at exactly -200, from base to target: what each rung bets,
 * what it returns, what gets banked, and what carries forward. Pure — the UI
 * renders the same array the tests assert against, so the ladder drawn on
 * screen can't drift from the one the worker is running.
 */
export function ladderPlan({
  base = LADDER_BASE,
  milestones = LADDER_MILESTONES,
  target = LADDER_TARGET,
} = {}) {
  const rungs = [];
  let bankroll = base;
  let banked = 0;
  const skimmed = new Set();

  // The loop is bounded rather than trusting the math to terminate: a bad
  // constant (a target below the base, a milestone above the target) would
  // otherwise spin forever inside a Worker request.
  for (let step = 1; step <= 32 && bankroll < target; step++) {
    const stake = bankroll;
    const returns = money(stake * 1.5);
    const milestone = milestones.find((m) => !skimmed.has(m) && returns > m);
    const takeOut = milestone ? money(returns - milestone) : 0;
    if (milestone) skimmed.add(milestone);
    banked = money(banked + takeOut);
    bankroll = money(returns - takeOut);
    rungs.push({ step, stake, returns, takeOut, carry: bankroll, banked });
  }
  return { base, target, rungs, banked, final: bankroll, totalValue: money(bankroll + banked) };
}

/** A fresh run at the bottom rung. `startedAt` is when the ladder reset, not when its first play posts. */
export function newLadderRun(now, previousRunId = null) {
  return {
    runId: `run-${now}`,
    startedAt: now,
    step: 1,
    bankroll: LADDER_BASE,
    banked: 0,
    skimmed: [],
    wins: 0,
    status: 'active',
    previousRunId,
  };
}

export async function getLadderState(env, now = Date.now()) {
  const raw = await env.POTD_KV.get(STATE_KEY);
  if (!raw) return newLadderRun(now);
  const state = JSON.parse(raw);
  // A completed or busted run is history: the next read starts the next
  // climb, so the section is never sitting on a finished ladder with nothing
  // to do. The archive already holds the finished one (see settleLadderPlay).
  if (state.status !== 'active') return newLadderRun(now, state.runId);
  return state;
}

async function putLadderState(env, state) {
  await env.POTD_KV.put(STATE_KEY, JSON.stringify(state), { expirationTtl: KV_TTL_SECONDS });
}

export async function getLadderRuns(env) {
  const raw = await env.POTD_KV.get(RUNS_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function archiveRun(env, run) {
  const runs = await getLadderRuns(env);
  runs.unshift(run);
  await env.POTD_KV.put(RUNS_KEY, JSON.stringify(runs.slice(0, MAX_ARCHIVED_RUNS)), { expirationTtl: KV_TTL_SECONDS });
}

/**
 * Whether a ladder candidate would contradict a pick the app has already
 * posted today. Same event, same market, different side — that's the case
 * that matters: recommending a team's moneyline on one surface and its
 * opponent's on another is the app arguing with itself, and the ladder is
 * the surface that gives way.
 *
 * Deliberately NOT "same event, any market": a total and a moneyline on the
 * same game don't contradict each other, and excluding a whole event because
 * one of its markets is already spoken for would thin the ladder's pool for
 * no honest reason.
 */
export function contradictsPick(candidate, pick) {
  if (!pick || candidate.eventId !== pick.eventId) return false;
  if (candidate.marketKey !== pick.marketKey) return false;
  return candidate.outcomeName !== pick.outcomeName
    // Same side of a spread/total at a different number is still a different
    // bet, but the opposite number on the same side is the other side of it.
    || (candidate.point != null && pick.point != null && candidate.point !== pick.point);
}

/**
 * Today's exclusions, read from what's already been posted: the Play of the
 * Day and every Prop Play leg are excluded by EVENT (the ladder is meant to
 * be a separate play, and the user asked for it explicitly), while Pixel's
 * Picks are excluded only where they'd contradict (the ladder is allowed to
 * land on the same pick — it's a different stake plan over the same board).
 */
export async function ladderExclusions(env, dateKey, top5Picks = []) {
  const [potdRaw, propRaw] = await Promise.all([
    env.POTD_KV.get(`potd:${dateKey}`),
    env.POTD_KV.get(`propplay:${dateKey}`),
  ]);

  const blockedEventIds = new Set();
  const potd = potdRaw ? JSON.parse(potdRaw) : null;
  if (potd?.pick?.eventId) blockedEventIds.add(potd.pick.eventId);
  const prop = propRaw ? JSON.parse(propRaw) : null;
  for (const leg of prop?.legs ?? []) {
    if (leg.oddsEventId) blockedEventIds.add(leg.oddsEventId);
  }

  return {
    blockedEventIds,
    // Both the day's flagship picks are also real picks that could be
    // contradicted on a market the event block above misses (a prop leg with
    // no oddsEventId, say), so they join the contradiction check too.
    contradictable: [...(potd?.pick ? [potd.pick] : []), ...top5Picks],
  };
}

/**
 * Snapshots newly-lockable ladder-band candidates into today's pool —
 * identical reasoning to potd.js's updatePotdPool: an early game's price is
 * gone from the feed long before an evening game's own lock window opens, so
 * "compare the whole day fairly" means freezing each candidate when it
 * becomes trustworthy rather than re-reading prices later.
 */
async function updateLadderPool(env, ctx, dateKey, lockable, now) {
  const raw = await env.POTD_KV.get(poolKey(dateKey));
  const pool = raw ? JSON.parse(raw) : { date: dateKey, entries: [] };
  const known = new Set(pool.entries.map((e) => e.id));
  const fresh = lockable.filter((c) => !known.has(c.id));
  if (!fresh.length) return pool;
  pool.entries.push(...fresh.map((c) => ({ ...c, capturedAt: now })));
  ctx.waitUntil(env.POTD_KV.put(poolKey(dateKey), JSON.stringify(pool), { expirationTtl: KV_TTL_SECONDS }));
  return pool;
}

/**
 * The day's ladder play out of a pool of qualifiers: best score wins, and
 * among candidates within NEAR_TIE_SCORE of that best, the one priced
 * closest to -200 takes it. Exported for the tests — the selection rule is
 * the part of this file most likely to be argued with later.
 */
export function chooseLadderPlay(candidates) {
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const contenders = candidates.filter((c) => best.score - c.score <= NEAR_TIE_SCORE);
  return contenders.reduce((a, b) => (
    Math.abs(b.american - LADDER_TARGET_AMERICAN) < Math.abs(a.american - LADDER_TARGET_AMERICAN) ? b : a
  ));
}

/**
 * Posts today's rung, once. Runs on the same hourly tick as everything else
 * and no-ops until the day's field is settled (scheduleStillOpen false —
 * the same signal Play of the Day locks on), which also means the Play of
 * the Day and Prop Play are already posted by the time this picks, so the
 * exclusions above are reading a complete picture rather than an empty one.
 *
 * Never bets more than the run's own bankroll, and never posts on a day
 * with nothing in band: the ladder holding its place is a valid outcome,
 * not a failure.
 */
export async function runLadderDaily(env, ctx, now = Date.now(), { fetchFullSlate, getTop5Picks = async () => [] } = {}) {
  const dateKey = etParts(now).date;
  // Records why the day has no rung, so /ladder can explain an empty
  // section instead of leaving "holding on purpose" and "broken" looking
  // identical. Written on every skip, cleared once a rung actually posts.
  const hold = async (reason, detail = {}) => {
    await env.POTD_KV.put(
      statusKey(dateKey),
      JSON.stringify({ dateKey, reason, checkedAt: now, ...detail }),
      { expirationTtl: KV_TTL_SECONDS },
    );
    return { skipped: true, reason, dateKey, ...detail };
  };

  const existing = await env.POTD_KV.get(playKey(dateKey));
  if (existing) return { skipped: true, reason: 'already posted today', dateKey };

  const [pausedSegments, learningProfile, events] = await Promise.all([
    getPausedSegments(env),
    getLearningProfile(env),
    fetchFullSlate(),
  ]);

  const analyzed = analyze(events, { now });
  const candidates = applyLearningToCandidates(
    applyTennisFormSignal(analyzed, await loadTennisArchivesFor(analyzed), { now }),
    learningProfile,
  );

  const inBand = candidates.filter((c) => {
    if (c.score < RULES.MIN_SCORE) return false;
    if (isExhibition(c)) return false;
    if (c.american < LADDER_MIN_AMERICAN || c.american > LADDER_MAX_AMERICAN) return false;
    if (!clearsMaxJuice(c)) return false;
    // NFL preseason is excluded from the ladder for the same reason as
    // Pixel's Picks and Play of the Day (see isNflPreseason in
    // docs/engine.js) — and more so here, since the ladder stakes its whole
    // compounding bankroll on a single rung rather than one flat unit.
    if (isNflPreseason(c)) return false;
    if (c.sportKey === 'americanfootball_ncaaf' && !isPower4Matchup(c.home, c.away)) return false;
    if (c.commenceMs <= now) return false;
    if (isSegmentPaused(c, pausedSegments)) return false;
    if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
    return etParts(c.commenceMs).date === dateKey;
  });

  await updateLadderPool(env, ctx, dateKey, inBand.filter((c) => isPickWindowOpen(c, now)), now);
  if (scheduleStillOpen(events, dateKey, now)) {
    return hold("still comparing today's games", { inBandSoFar: inBand.length });
  }

  const poolRaw = await env.POTD_KV.get(poolKey(dateKey));
  const pool = poolRaw ? JSON.parse(poolRaw).entries : [];
  const { blockedEventIds, contradictable } = await ladderExclusions(env, dateKey, await getTop5Picks());
  const eligible = pool.filter((c) => (
    c.commenceMs > now
    && !blockedEventIds.has(c.eventId)
    && !contradictable.some((pick) => contradictsPick(c, pick))
  ));

  const chosen = chooseLadderPlay(eligible);
  if (!chosen) {
    // Deliberately not written to KV: a hold isn't a play, and tomorrow's
    // tick should be free to post one. The reason is returned for the cron
    // log and for /ladder to explain the empty day.
    return hold('no qualifying play in the ladder band today', {
      poolSize: pool.length,
      blockedByExclusion: pool.length - eligible.length,
    });
  }

  const state = await getLadderState(env, now);
  const stake = money(state.bankroll);
  const record = {
    dateKey,
    runId: state.runId,
    step: state.step,
    generatedAt: now,
    stake,
    // What this rung pays if it lands, at the price actually taken — not the
    // plan's 1.5x.
    toReturn: money(stake * chosen.decimal),
    settled: false,
    pick: {
      pickId: chosen.id,
      dateKey,
      eventId: chosen.eventId,
      sportKey: chosen.sportKey,
      sportTitle: chosen.sportTitle,
      marketKey: chosen.marketKey,
      marketLabel: chosen.marketLabel,
      outcomeName: chosen.outcomeName,
      point: chosen.point ?? null,
      selection: chosen.selection,
      american: chosen.american,
      decimal: chosen.decimal,
      score: chosen.score,
      home: chosen.home,
      away: chosen.away,
      commenceMs: chosen.commenceMs,
      book: chosen.book,
      consensusProb: chosen.consensusProb,
      // The whole bankroll rides — that IS the ladder.
      suggested_stake: stake,
      status: 'pending',
      result: null,
    },
  };
  await env.POTD_KV.put(playKey(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { skipped: false, dateKey, record };
}

/**
 * Applies one settled rung to the run, returning the next state.
 *
 * Pure, and exported, because this is the part that has to be exactly right:
 * a win compounds and may skim and may complete the climb; a loss ends the
 * run at the bottom; a void (a postponed game, a push) leaves the ladder
 * untouched so the same rung is played again rather than being treated as
 * either. Returns { state, finishedRun } — finishedRun is the archived climb
 * when this settlement ended one, else null.
 */
export function settleLadderPlay(state, play, outcome, now) {
  if (outcome.void) {
    return { state: { ...state }, finishedRun: null };
  }

  if (!outcome.won) {
    const finishedRun = {
      ...state,
      status: 'busted',
      endedAt: now,
      endedBy: 'loss',
      lostAt: { dateKey: play.dateKey, step: play.step, stake: play.stake, selection: play.pick.selection },
      // What the climb was worth when it broke: only the money already
      // skimmed out survives a bust, which is the whole argument for
      // skimming at all.
      totalValue: money(state.banked),
    };
    return { state: newLadderRun(now, state.runId), finishedRun };
  }

  const returns = money(play.stake * play.pick.decimal);
  const skimmed = new Set(state.skimmed ?? []);
  const milestone = LADDER_MILESTONES.find((m) => !skimmed.has(m) && returns > m);
  const takeOut = milestone ? money(returns - milestone) : 0;
  if (milestone) skimmed.add(milestone);

  const next = {
    ...state,
    step: state.step + 1,
    wins: (state.wins ?? 0) + 1,
    bankroll: money(returns - takeOut),
    banked: money((state.banked ?? 0) + takeOut),
    skimmed: [...skimmed],
  };

  if (next.bankroll >= LADDER_TARGET) {
    const finishedRun = {
      ...next,
      status: 'complete',
      endedAt: now,
      endedBy: 'target',
      totalValue: money(next.bankroll + next.banked),
    };
    return { state: newLadderRun(now, state.runId), finishedRun };
  }
  return { state: next, finishedRun: null };
}

/** Grade one day's ladder play and fold the result into the run. */
async function gradeLadderDate(env, ctx, now, dateKey, fetchScoresFn, fetchMmaResultsFn, fetchTennisResultsFn) {
  const raw = await env.POTD_KV.get(playKey(dateKey));
  if (!raw) return false;
  const record = JSON.parse(raw);
  if (record.settled && !isRegradableTennisVoid(record.pick)) return false;

  const { pick } = record;
  const { events } = await fetchScoresFn(pick.sportKey);
  const scoreEvent = (events ?? []).find((e) => e.id === pick.eventId);

  let outcome;
  if (isMma(pick.sportKey)) {
    outcome = gradeMmaPickWithFallback(pick, scoreEvent, await fetchMmaResultsFn());
  } else if (isTennis(pick.sportKey)) {
    outcome = await gradeTennisPickWithEspn(pick, scoreEvent, await fetchTennisResultsFn(), env, ctx, now);
  } else {
    outcome = gradePick(pick, scoreEvent);
  }
  if (!outcome) return false;
  if (isNoOpTennisRegrade(pick, outcome)) return false;

  pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
  pick.result = {
    payout: outcome.payout,
    roiPercent: outcome.void ? 0 : (outcome.payout / record.stake) * 100,
    voidReason: outcome.void ? outcome.reason : undefined,
    detail: outcome.detail ?? undefined,
  };

  // The state read happens here rather than up front so a day that grades
  // nothing never touches the run at all.
  const state = await getLadderState(env, now);
  // A play from a run that has already ended (a stale key graded late, after
  // a loss already reset the ladder) records its own result but must never
  // move the current climb — that money isn't riding anymore.
  const appliesToCurrentRun = state.runId === record.runId;
  const { state: nextState, finishedRun } = appliesToCurrentRun
    ? settleLadderPlay(state, record, outcome, now)
    : { state, finishedRun: null };

  record.settled = true;
  record.appliedToRun = appliesToCurrentRun;
  record.bankrollAfter = appliesToCurrentRun ? nextState.bankroll : null;

  await env.POTD_KV.put(playKey(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  if (appliesToCurrentRun) {
    if (finishedRun) await archiveRun(env, finishedRun);
    await putLadderState(env, nextState);
  }
  return true;
}

/**
 * Grade whichever of the last few days' ladder plays are still open. Runs on
 * every tick, same as the other grading passes, and is idempotent: a play
 * carries `settled`, so a rung can never be applied to the bankroll twice.
 */
export async function runLadderGrading(env, ctx, now = Date.now(), {
  fetchScoresFn = (s) => fetchScores(s, env, ctx),
  fetchMmaResultsFn = () => fetchMmaResults(ctx, now),
  fetchTennisResultsFn = () => fetchTennisResults(ctx, now),
  lookbackDays = GRADING_LOOKBACK_DAYS,
} = {}) {
  const dateKeys = [...new Set(Array.from({ length: lookbackDays }, (_, i) => etDatePlusDays(now, -i)))];
  let graded = false;
  // Oldest first: rungs compound, so grading them out of order would apply
  // yesterday's win to a bankroll that already has today's on it.
  for (const dateKey of dateKeys.reverse()) {
    if (await gradeLadderDate(env, ctx, now, dateKey, fetchScoresFn, fetchMmaResultsFn, fetchTennisResultsFn)) {
      graded = true;
    }
  }
  return { graded };
}

/**
 * Everything the Ladder Challenge section renders from: the live run, the
 * ideal plan, today's play (or yesterday's, if today's hasn't posted), and
 * the recent settled rungs of this climb.
 */
export async function getLadder(env, now = Date.now()) {
  const today = etParts(now).date;
  const [state, todayRaw, yesterdayRaw, statusRaw] = await Promise.all([
    getLadderState(env, now),
    env.POTD_KV.get(playKey(today)),
    env.POTD_KV.get(playKey(etDatePlusDays(now, -1))),
    env.POTD_KV.get(statusKey(today)),
  ]);

  const todayPlay = todayRaw ? JSON.parse(todayRaw) : null;
  const yesterdayPlay = yesterdayRaw ? JSON.parse(yesterdayRaw) : null;
  return {
    state,
    plan: ladderPlan(),
    play: todayPlay ?? (yesterdayPlay ? { ...yesterdayPlay, stale: true } : null),
    base: LADDER_BASE,
    target: LADDER_TARGET,
    milestones: LADDER_MILESTONES,
    band: { min: LADDER_MIN_AMERICAN, max: LADDER_MAX_AMERICAN },
    // Why there's no rung today, when there isn't one. Null once today's
    // play posts — at that point the play itself is the answer.
    todayStatus: todayPlay ? null : (statusRaw ? JSON.parse(statusRaw) : null),
  };
}

/**
 * The ladder's own history for the Tracking Dashboard: every settled rung
 * still in KV plus every finished climb. Rungs carry which run and step they
 * belonged to, so the dashboard can draw each climb start-to-finish rather
 * than as a flat list of picks.
 */
export async function getLadderHistory(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDatePlusDays(now, -i));
  const [raws, runs, state] = await Promise.all([
    Promise.all(dateKeys.map((d) => env.POTD_KV.get(playKey(d)))),
    getLadderRuns(env),
    getLadderState(env, now),
  ]);
  const plays = raws.filter(Boolean).map((r) => JSON.parse(r));
  return { plays, runs, state, plan: ladderPlan() };
}
