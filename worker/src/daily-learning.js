/**
 * Daily learning review — the self-correction loop that makes the picker
 * sharper day over day, sitting between the raw engine (docs/engine.js,
 * which never changes) and the 2am selection batches.
 *
 * ── The loop ─────────────────────────────────────────────────────────────
 * Every day at the 2am ET batch hour, BEFORE any picks are generated:
 *   1. Load the trailing LEARN_WINDOW_DAYS of graded picks from BOTH
 *      trackers. The Full Slate tracker is the key input: it grades every
 *      game with no odds band, no score floor, and no learning applied —
 *      an unbiased, high-volume record of how the engine's own probability
 *      estimates perform in the real world.
 *   2. Slice that record along two feature axes: sport+market segment
 *      ("seg:baseball_mlb|totals") and odds band ("odds:dog"). For each
 *      feature, ask two questions:
 *        - Results: did actual wins fall short of what the picks' own
 *          no-vig probabilities predicted? (z-test on a sum of Bernoulli
 *          trials — same math as algo-health.js's weekly review.)
 *        - CLV: did the closing line move toward or away from our picks?
 *          Negative CLV is the fastest honest tell that a perceived edge
 *          is illusory — it shows up in days, not weeks, because it doesn't
 *          depend on win/loss variance at all.
 *   3. Convert each feature's evidence into a bounded reliability weight,
 *      shrunk toward 1.0 by sample size (empirical-Bayes style): a feature
 *      with 8 graded picks can barely move its weight no matter how bad the
 *      stretch; one with 80 can move it meaningfully.
 *   4. Store the weight profile + a plain-English report of what changed
 *      and why. The 2am selection batches (Pixel's Picks, Play of the Day)
 *      then multiply each candidate's score by its matching weights before
 *      ranking — a segment that's been misfiring needs a visibly better
 *      price to make the board; one that's been sharp gets a small nudge.
 *
 * ── What keeps it honest ─────────────────────────────────────────────────
 *   - Adjustments apply ONLY at next-day generation. Nothing is re-graded,
 *     re-scored, or touched intraday, so the tracked record is never skewed
 *     by the learner reaching back into it.
 *   - The Full Slate tracker NEVER has weights applied to it. It keeps
 *     measuring the raw engine so tomorrow's learning is drawn from clean
 *     evidence, not from a record already filtered by yesterday's lessons —
 *     the classic feedback-loop failure this design exists to avoid.
 *   - Every pick records both its raw and adjusted score plus the profile
 *     date that adjusted it, so "did the learning layer actually help" is
 *     itself measurable later.
 *   - Bounds are asymmetric: a feature can be penalized down to x0.70 but
 *     boosted only to x1.05. Chasing winners overfits much faster than
 *     benching losers; the asymmetry encodes that. The penalty floor was
 *     originally x0.85, sized when the graded record was small — live
 *     experience showed that to be toothless against a structural leak:
 *     the +120-and-longer band sat at 16/54 (29.6%) over a 30-day window
 *     while its weight could only reach x0.96, a 4% haircut on the exact
 *     segment losing the most. The wider floor lets sustained, real losses
 *     actually push a segment off the curated boards; the boost cap stays
 *     tight because that overfit risk hasn't changed.
 *   - Below MIN_FEATURE_N graded picks a feature gets no weight at all, and
 *     shrinkage means even at the threshold the movement is fractional.
 *     "No adjustment" is always the default over an adjustment on noise.
 */

import { normalizeSportKey } from './algo-health.js';
import { impliedProb } from '../../docs/engine.js';

const LEARN_PROFILE_KEY = 'learn:profile';
const LEARN_LOG_KEY = 'learn:log';
const LEARN_TTL = 86400 * 365;

export const LEARN_WINDOW_DAYS = 30;
export const MIN_FEATURE_N = 15; // below this, a feature emits no weight at all
const SHRINK_K = 30; // shrink = n/(n+K): n=15 → 33% of target, n=90 → 75%
const WEIGHT_MIN = 0.7; // hardest single-feature penalty — see file header for why this widened from 0.85
const WEIGHT_MAX = 1.05; // gentlest cap on boosting — see file header on asymmetry
const COMBINED_MIN = 0.6; // floor when multiple penalized features stack on one candidate
const COMBINED_MAX = 1.08;
// How much one unit of evidence moves the pre-shrinkage target: z is worth
// 6%/point (capped), CLV probability-points 2%/point (capped) — results
// dominate, CLV accelerates the verdict while samples are still small.
const Z_STEP = 0.06;
const CLV_STEP = 0.02;
const LOG_MAX = 120;

/** ET calendar date (YYYY-MM-DD) — same day boundary every tracker uses. */
function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Closing line value in probability points (x100): positive means the
 * market moved TOWARD the pick after we took it (we beat the close),
 * negative means it moved away (the close said our price was too generous
 * to us — i.e. the "edge" evaporated). Computed from the implied
 * probabilities of the open and close snapshots every tracked pick already
 * carries, so it's price-format agnostic.
 */
export function clvProbPts(pick) {
  const open = pick?.clv?.openAmerican;
  const close = pick?.clv?.closeAmerican;
  if (typeof open !== 'number' || typeof close !== 'number' || open === 0 || close === 0) return null;
  return (impliedProb(close) - impliedProb(open)) * 100;
}

/**
 * Odds band for one American price — the second feature axis. Buckets are
 * coarse on purpose: four bands accumulate a usable sample in days; a
 * per-10-cent ladder would take months and learn nothing in the meantime.
 */
export function oddsBand(american) {
  if (american <= -180) return 'heavyfav';
  if (american <= -120) return 'fav';
  if (american < 120) return 'close';
  return 'dog';
}

/** The feature keys one graded pick contributes evidence to. */
export function featureKeysFor(pick) {
  const keys = [];
  if (pick?.sportKey && pick?.marketKey) {
    keys.push(`seg:${normalizeSportKey(pick.sportKey)}|${pick.marketKey}`);
  }
  if (typeof pick?.american === 'number') {
    keys.push(`odds:${oddsBand(pick.american)}`);
  }
  return keys;
}

/**
 * Aggregate stats for one bucket of graded picks: the same
 * wins-vs-expected z-test algo-health.js uses, plus average CLV.
 * Only graded, standard-clearing picks with a real probability count —
 * padding picks were never claimed to clear the sharp bar, and pending
 * picks have no outcome to learn from.
 */
export function featureStats(picks) {
  const graded = (picks ?? []).filter(
    (p) => p && (p.status === 'won' || p.status === 'lost') && p.meetsStandard !== false && typeof p.consensusProb === 'number',
  );
  const n = graded.length;
  if (!n) return { n: 0, wins: 0, expectedWins: 0, z: 0, roi: 0, avgClvPts: null };

  const wins = graded.filter((p) => p.status === 'won').length;
  const expectedWins = graded.reduce((s, p) => s + p.consensusProb, 0);
  const variance = graded.reduce((s, p) => s + p.consensusProb * (1 - p.consensusProb), 0);
  const z = variance > 0 ? (wins - expectedWins) / Math.sqrt(variance) : 0;

  const staked = graded.reduce((s, p) => s + (p.suggested_stake ?? 0), 0);
  const net = graded.reduce((s, p) => s + (p.result?.payout ?? 0), 0);
  const roi = staked > 0 ? (net / staked) * 100 : 0;

  const clvs = graded.map(clvProbPts).filter((v) => typeof v === 'number');
  const avgClvPts = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;

  return { n, wins, expectedWins, z, roi, avgClvPts };
}

/**
 * One feature's evidence → one bounded reliability weight.
 *
 * target = 1 + Z_STEP·clamp(z, −3, +1.5) + CLV_STEP·clamp(avgClv, −2, +1)
 * weight = 1 + shrink·(target − 1), shrink = n/(n+K), clamped to bounds.
 *
 * The z clamp is asymmetric (−3 vs +1.5) for the same reason the weight
 * bounds are: over-trusting a hot streak is the faster way to donate money.
 */
export function weightFromStats(stats) {
  if (!stats || stats.n < MIN_FEATURE_N) return null;
  const zTerm = Z_STEP * clamp(stats.z, -3, 1.5);
  const clvTerm = typeof stats.avgClvPts === 'number' ? CLV_STEP * clamp(stats.avgClvPts, -2, 1) : 0;
  const target = 1 + zTerm + clvTerm;
  const shrink = stats.n / (stats.n + SHRINK_K);
  const weight = clamp(1 + shrink * (target - 1), WEIGHT_MIN, WEIGHT_MAX);
  // A weight that rounds to no-op is dropped — it would only add log noise.
  if (Math.abs(weight - 1) < 0.01) return null;
  return Math.round(weight * 1000) / 1000;
}

/**
 * Learn the full weight profile from a flat pick array. Pure — the KV-aware
 * orchestrator below calls this; tests call it directly.
 */
export function learnWeights(picks) {
  const byFeature = new Map();
  for (const p of picks ?? []) {
    for (const key of featureKeysFor(p)) {
      if (!byFeature.has(key)) byFeature.set(key, []);
      byFeature.get(key).push(p);
    }
  }

  const weights = {};
  const evidence = {};
  for (const [key, bucket] of byFeature) {
    const stats = featureStats(bucket);
    evidence[key] = stats;
    const w = weightFromStats(stats);
    if (w !== null) weights[key] = w;
  }
  return { weights, evidence };
}

/** Combined multiplier for one candidate under a profile — product of its matching feature weights, clamped. */
export function combinedWeightFor(candidate, profile) {
  const weights = profile?.weights;
  if (!weights) return 1;
  let w = 1;
  for (const key of featureKeysFor(candidate)) {
    if (typeof weights[key] === 'number') w *= weights[key];
  }
  return clamp(w, COMBINED_MIN, COMBINED_MAX);
}

/**
 * Apply a learned profile to a candidate pool ahead of selection: each
 * candidate's score becomes rawScore × its combined weight, with the raw
 * value and the multiplier kept on the candidate so the tracked record can
 * store both. Returns new objects — never mutates the input pool.
 *
 * Applied by runTop5Batch and runPotdDaily only. NEVER by the Full Slate
 * tracker — see the file header on keeping the evidence stream unbiased.
 */
export function applyLearningToCandidates(candidates, profile) {
  if (!profile?.weights || !Object.keys(profile.weights).length) return candidates;
  return (candidates ?? []).map((c) => {
    const w = combinedWeightFor(c, profile);
    if (w === 1) return c;
    return { ...c, rawScore: c.score, learnWeight: w, score: Math.round(c.score * w * 10) / 10 };
  });
}

/* ---------------------------------------------------------------- */
/* The daily report                                                  */
/* ---------------------------------------------------------------- */

const FEATURE_LABELS = { heavyfav: 'heavy favorites (-180 and shorter)', fav: 'favorites (-179 to -120)', close: 'near-pickem prices (-119 to +119)', dog: 'underdogs (+120 and longer)' };

function featureLabel(key) {
  if (key.startsWith('odds:')) return FEATURE_LABELS[key.slice(5)] ?? key;
  const [sport, market] = key.slice(4).split('|');
  return `${sport} ${market}`;
}

/**
 * Plain-English account of what the review saw and what it's changing —
 * built deterministically from the numbers, so the report IS the evidence
 * rather than a narrative about it.
 */
export function buildDailyReport({ dateKey, yesterdayStats, windowStats, weights, evidence, prevWeights }) {
  const lines = [];

  if (yesterdayStats.n > 0) {
    const diff = yesterdayStats.wins - yesterdayStats.expectedWins;
    lines.push(
      `Yesterday: ${yesterdayStats.wins}-${yesterdayStats.n - yesterdayStats.wins} (${diff >= 0 ? '+' : ''}${diff.toFixed(1)} vs the model's own expectation), ROI ${yesterdayStats.roi >= 0 ? '+' : ''}${yesterdayStats.roi.toFixed(1)}%${typeof yesterdayStats.avgClvPts === 'number' ? `, avg CLV ${yesterdayStats.avgClvPts >= 0 ? '+' : ''}${yesterdayStats.avgClvPts.toFixed(2)} prob pts` : ''}.`,
    );
  } else {
    lines.push('Yesterday: no graded picks to review.');
  }

  lines.push(
    `${LEARN_WINDOW_DAYS}-day window: ${windowStats.n} graded picks, ${windowStats.wins} wins vs ${windowStats.expectedWins.toFixed(1)} expected (z=${windowStats.z.toFixed(2)}), ROI ${windowStats.roi >= 0 ? '+' : ''}${windowStats.roi.toFixed(1)}%.`,
  );

  const prev = prevWeights ?? {};
  const allKeys = [...new Set([...Object.keys(weights), ...Object.keys(prev)])].sort();
  // Structured version of the same diff the lines below narrate — consumed
  // by the plain-language admin briefing email (worker/src/
  // learning-brief-email.js) and the dashboard's "algorithm adjusted"
  // indicator, so both stay built from the identical evidence rather than
  // re-deriving (and possibly disagreeing about) what changed.
  const changes = [];
  for (const key of allKeys) {
    const now = weights[key];
    const before = prev[key];
    const stats = evidence[key];
    const why = stats
      ? `${stats.wins}/${stats.n} vs ${stats.expectedWins.toFixed(1)} expected (z=${stats.z.toFixed(2)})${typeof stats.avgClvPts === 'number' ? `, CLV ${stats.avgClvPts >= 0 ? '+' : ''}${stats.avgClvPts.toFixed(2)}pts` : ''}`
      : 'no longer enough evidence in the window';
    if (now !== undefined && before === undefined) {
      lines.push(`${now < 1 ? 'Penalizing' : 'Boosting'} ${featureLabel(key)}: x${now.toFixed(3)} — ${why}.`);
      changes.push({ key, label: featureLabel(key), kind: 'added', before: null, now, stats: stats ?? null });
    } else if (now === undefined && before !== undefined) {
      lines.push(`Cleared adjustment on ${featureLabel(key)} (was x${before.toFixed(3)}) — ${why}.`);
      changes.push({ key, label: featureLabel(key), kind: 'cleared', before, now: null, stats: stats ?? null });
    } else if (now !== undefined && Math.abs(now - before) >= 0.005) {
      lines.push(`${featureLabel(key)}: x${before.toFixed(3)} → x${now.toFixed(3)} — ${why}.`);
      changes.push({ key, label: featureLabel(key), kind: 'moved', before, now, stats: stats ?? null });
    }
  }

  if (!Object.keys(weights).length) {
    lines.push(
      windowStats.n < MIN_FEATURE_N
        ? 'No adjustments yet — still accumulating graded evidence. Adjustments begin once a segment or odds band reaches 15 graded picks.'
        : 'No adjustments today — every segment and odds band is performing within its own expected range.',
    );
  }

  return { dateKey, lines, weightCount: Object.keys(weights).length, changes };
}

/* ---------------------------------------------------------------- */
/* KV orchestration                                                  */
/* ---------------------------------------------------------------- */

export async function getLearningProfile(env) {
  const raw = await env.POTD_KV.get(LEARN_PROFILE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function getLearningLog(env) {
  const raw = await env.POTD_KV.get(LEARN_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

/**
 * The daily orchestrator. Idempotent per ET date — the 2am hour ticks three
 * times, and only the first does the work. `getPicks` is injected (same
 * no-circular-imports pattern as runAlgoHealthReview): the caller supplies
 * the merged Pixel's Picks + Full Slate history.
 *
 * MUST complete before the day's selection batches run — index.js awaits it
 * inside the 2am gate so the profile the batches read is today's, not
 * yesterday's leftovers.
 */
export async function runDailyLearning(env, ctx, now = Date.now(), { getPicks }) {
  const dateKey = etDate(now);
  const log = await getLearningLog(env);
  if (log[0]?.dateKey === dateKey) {
    return { skipped: true, reason: 'already learned today', dateKey };
  }

  const prevProfile = await getLearningProfile(env);
  const picks = await getPicks();

  const { weights, evidence } = learnWeights(picks);
  const windowStats = featureStats(picks);
  const yesterdayKey = etDate(now - 86400000);
  const yesterdayStats = featureStats(picks.filter((p) => p.dateKey === yesterdayKey));

  const report = buildDailyReport({
    dateKey,
    yesterdayStats,
    windowStats,
    weights,
    evidence,
    prevWeights: prevProfile?.weights,
  });

  const profile = { dateKey, generatedAt: now, weights, evidence };
  // The structured changes + day/window stats ride on the log entry so the
  // dashboard's "algorithm adjusted today" indicator (docs/app.js) and the
  // owner's manual /admin/learning-brief resend can both answer "what
  // actually CHANGED this morning" from the log alone — weightCount only
  // says how many adjustments are active, which includes carried-over ones.
  const entry = {
    dateKey, at: now, report: report.lines, weightCount: report.weightCount,
    windowN: windowStats.n, changeCount: report.changes.length,
    changes: report.changes, yesterdayStats, windowStats,
  };

  await Promise.all([
    env.POTD_KV.put(LEARN_PROFILE_KEY, JSON.stringify(profile), { expirationTtl: LEARN_TTL }),
    env.POTD_KV.put(LEARN_LOG_KEY, JSON.stringify([entry, ...log].slice(0, LOG_MAX)), { expirationTtl: LEARN_TTL }),
  ]);

  return {
    skipped: false, dateKey, weights, report: report.lines,
    // Consumed by the plain-language admin briefing (worker/src/
    // learning-brief-email.js) — structured changes plus the day/window
    // stats its key-numbers line is built from.
    changes: report.changes, yesterdayStats, windowStats,
  };
}
