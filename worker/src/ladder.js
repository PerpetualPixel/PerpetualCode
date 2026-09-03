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
 * Preferred band is LADDER_MIN_AMERICAN..LADDER_MAX_AMERICAN (-200..+120),
 * nearest -200 preferred among comparable candidates, and never the day's
 * Play of the Day or Prop Play of the Day, nor anything contradicting a pick
 * the app has already posted today. It MAY be a Pixel's Pick — the ladder is
 * a different stake plan over the same board, not a promise of a different
 * game.
 *
 * The ladder posts every day the slate has ANY real game on it. When nothing
 * clears the preferred band (or the app's own RULES.MIN_SCORE floor), the
 * best-SCORING candidate on the whole eligible slate is taken instead — off
 * the app's usual price/quality bar, but a deliberate product decision: a
 * daily challenge that sometimes has no entry isn't the product. What never
 * gets relaxed, band or no band, are the integrity checks that aren't about
 * price at all — no exhibitions, no NFL preseason, no non-Power-4 NCAAF, no
 * paused segment (worker/src/algo-health.js), no market this app can't
 * settle, nothing already spoken for by today's other picks. Only a day with
 * literally no eligible game anywhere on the slate holds with no rung at all
 * — see chooseLadderPlay and the fallback logic in runLadderDaily. A rung
 * taken via the fallback is marked `viaFallback: true` on the stored pick, so
 * every surface that reads it can say so honestly rather than presenting it
 * as an ordinary in-band rung.
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
import { loadTeamContextsFor, applyTeamFormSignal } from './team-form.js';
import { getNflEfficiency } from './nfl-efficiency.js';
import { loadTennisArchivesFor } from './tennis-archive.js';
import { GENERATION_HOUR_ET, loadPublishedSides, contradictsPublishedBoard } from './tracking.js';
import { isExhibition, isEligibleTennisMatch, etParts, etDatePlusDays } from './potd.js';
import { legsOf } from './combo-grading.js';

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
  // Every game on the Play of the Day, not just its anchor: the POTD can be
  // a parlay (see potd.js's buildRecord), and its record's top-level eventId
  // names only the first leg.
  for (const leg of legsOf(potd?.pick)) {
    if (leg?.eventId) blockedEventIds.add(leg.eventId);
  }
  const prop = propRaw ? JSON.parse(propRaw) : null;
  for (const leg of prop?.legs ?? []) {
    if (leg.oddsEventId) blockedEventIds.add(leg.oddsEventId);
  }

  // Sides the Full Slate has already published today. The ladder is the LAST
  // surface drawn (index.js orders the chain), so unlike the curated boards
  // it can see the whole slate — and the slate is not excluded by event the
  // way the flagships are, because it carries a pick on essentially every
  // game and blocking those would leave the ladder nothing to draw from.
  // Agreement is fine; only the opposite side is barred, per the same
  // direction the other boards follow.
  const slateSides = await loadPublishedSides(env, dateKey, ['slate']).catch(() => new Set());

  return {
    blockedEventIds,
    // Flattened to LEGS, not records: a Pixel's Pick can be a bankroll
    // builder whose top-level fields describe only its anchor, so checking
    // the record alone leaves its second leg open to being contradicted.
    // Both flagships are also real picks that could be contradicted on a
    // market the event block above misses (a prop leg with no oddsEventId,
    // say), so they join the contradiction check too.
    contradictable: [...legsOf(potd?.pick), ...top5Picks.flatMap(legsOf)].filter(Boolean),
    slateSides,
  };
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
 * and draws once at the generation hour, after Play of the Day, Pixel's
 * Picks and the Prop Play are already posted (index.js orders the chain),
 * so the exclusions above read a complete picture rather than an empty one.
 *
 * Never bets more than the run's own bankroll. The rung posts every day
 * the slate has any eligible game at all — the in-band standard falls
 * back to the best-scoring eligible candidate (marked viaFallback) rather
 * than holding; see the header.
 */
export async function runLadderDaily(env, ctx, now = Date.now(), { fetchFullSlate, getTop5Picks = async () => [] } = {}) {
  const { date: dateKey, hour } = etParts(now);
  // Same generation hour as every other board — see tracking.js's
  // GENERATION_HOUR_ET. Before it, yesterday's rung is still the rung.
  if (hour < GENERATION_HOUR_ET) {
    return { skipped: true, reason: 'before generation hour', dateKey };
  }
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

  // Team sports get their own form/injury gate (worker/src/team-form.js)
  // alongside the tennis one, in the same position for the same reason.
  const analyzed = analyze(events, { now });
  const candidates = applyLearningToCandidates(
    applyTeamFormSignal(
      applyTennisFormSignal(analyzed, await loadTennisArchivesFor(analyzed), { now }),
      await loadTeamContextsFor(analyzed, ctx, { now }),
      { now, nflEfficiency: await getNflEfficiency(env) },
    ),
    learningProfile,
  );

  // Every check here is about the GAME's legitimacy, not its price — these
  // are what stay non-negotiable even when nothing clears the preferred band
  // below and the fallback has to reach past it. Renamed from the old
  // in-band-only `inBand`: this app used to pool nothing outside the price
  // band at all, which meant a day where the only real games were priced
  // outside -200..+120 had literally no fallback pool to reach into.
  const structurallyEligible = candidates.filter((c) => {
    if (isExhibition(c)) return false;
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

  // One draw at the generation hour, same as every other board since the
  // 2026-08-21 reset — the capture-into-a-pool-as-windows-open cycle (and
  // its "still comparing today's games" hold) is gone with the rest of the
  // progressive-locking machinery. index.js runs this after Play of the
  // Day, Pixel's Picks and the Prop Play are decided, so the exclusions
  // below read a complete day.
  const { blockedEventIds, contradictable, slateSides } = await ladderExclusions(env, dateKey, await getTop5Picks());
  const eligible = structurallyEligible.filter((c) => (
    c.commenceMs > now
    && !blockedEventIds.has(c.eventId)
    && !contradictable.some((pick) => contradictsPick(c, pick))
    && !contradictsPublishedBoard(c, slateSides)
  ));

  if (!eligible.length) {
    // The one hold that can still happen: nothing on the ENTIRE slate today
    // cleared even the integrity checks (an off day, or everything today got
    // excluded). Deliberately not written to KV: a hold isn't a play, and
    // tomorrow's tick should be free to post one.
    return hold("nothing on today's slate clears the ladder's basic eligibility checks", {
      poolSize: structurallyEligible.length,
      blockedByExclusion: structurallyEligible.length - eligible.length,
    });
  }

  // Preferred: the app's own quality floor and the -200..+120 band. Falling
  // back to the full eligible slate only when NOTHING clears that — the
  // ladder posts a rung every day the slate has a real game on it, taking
  // the best-scoring candidate available rather than holding. chooseLadderPlay
  // still applies its own near-tie-toward--200 rule inside whichever pool it
  // gets, so a fallback pick is still the best AVAILABLE approximation of the
  // ladder's own preferred shape, not an arbitrary pick.
  const preferredBand = eligible.filter((c) => (
    c.score >= RULES.MIN_SCORE && c.american >= LADDER_MIN_AMERICAN && c.american <= LADDER_MAX_AMERICAN
  ));
  const viaFallback = preferredBand.length === 0;
  const chosen = chooseLadderPlay(viaFallback ? eligible : preferredBand);

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
      // True when nothing today cleared the preferred -200..+120/MIN_SCORE
      // band and this is the best-scoring candidate on the rest of the
      // slate instead — every surface that reads this pick should say so
      // rather than presenting a fallback rung as an ordinary one.
      viaFallback,
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
