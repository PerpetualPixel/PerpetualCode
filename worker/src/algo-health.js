/**
 * Weekly algorithm health review — the only part of this app that changes
 * how picks get made without a human reviewing each change individually, so
 * everything here is deliberately narrow and bounded:
 *
 *   - CIRCUIT BREAKERS: a sport+bet-type segment that's losing money on a
 *     real sample gets auto-paused (excluded from future Pixel's Picks /
 *     Play of the Day candidate pools) until it recovers or a human resumes
 *     it early.
 *   - BOUNDED TUNING: if overall (non-paused) performance is weak, one
 *     global threshold (EV floor, Kelly floor, or score floor) tightens by
 *     one fixed step — never below the shipped default in docs/engine.js's
 *     RULES, and never past a pre-set ceiling.
 *   - STRUCTURAL PROPOSALS: anything bigger than a threshold nudge (a new
 *     market type, a scoring-weight change) is written to the log for a
 *     human to read and act on by hand — never auto-applied.
 *
 * Why "below 55% win rate" (the plain framing this was originally requested
 * with) isn't the actual test used here: Pixel's Picks prices span -250 to
 * +150 American odds, so a slate of -200 favorites *should* clear 55%
 * comfortably and a slate of +140 underdogs shouldn't have to. The real
 * question is whether ACTUAL wins fall significantly short of what each
 * pick's own no-vig fair probability (`consensusProb`, already stored on
 * every pick — see tracking.js's pickRecordFrom) predicted. That's a
 * z-test against a sum of Bernoulli trials with different win
 * probabilities, not a flat rate: z = (wins - Σp_i) / sqrt(Σp_i(1-p_i)).
 *
 * Multiple-comparisons note: with roughly 20-30 segments (sport x bet type)
 * tested every week, a naive 97.5%-confidence bar (z ≈ -2.0) would produce
 * a real false pause every couple of weeks by chance alone even with a
 * perfectly healthy algorithm. PAUSE_Z is set more conservatively than that
 * for exactly this reason — this is a known, deliberate tradeoff, not an
 * oversight.
 */

import { RULES } from '../../docs/engine.js';
import { isTennis } from '../../docs/insights.js';

const ALGO_CONFIG_KEY = 'algo:config';
const ALGO_PAUSED_KEY = 'algo:paused';
const ALGO_LOG_KEY = 'algo:health-log';
const ALGO_CONFIG_TTL = 86400 * 365; // config/state should persist indefinitely, not expire like picks

// Trailing window and minimum sample sizes before any action is even
// considered — conservative on purpose: a niche segment simply won't
// accumulate enough evidence to trigger anything, and "no action" is always
// the correct default over an action taken on a noisy handful of picks.
export const HEALTH_WINDOW_DAYS = 60;
export const MIN_SEGMENT_SAMPLE = 20;
export const MIN_OVERALL_SAMPLE = 30;

// z-score thresholds. More negative = worse than expected.
export const PAUSE_Z = -2.5; // conservative given ~20-30 weekly comparisons; see file header
export const RESUME_Z = -0.5; // must clearly recover, not just cross back over the pause line (hysteresis)
export const WARN_Z = -1.3; // flagged as a proposal, never auto-acted on
export const TIGHTEN_Z = -1.5; // softer bar for the global-only tuning lever

// Shipped defaults double as the floor every bounded param can never tighten
// past being loosened below — auto-tuning can only ever move toward the max,
// starting from exactly what docs/engine.js/docs/config.js already ship.
export const TUNABLE_BOUNDS = {
  MIN_EV_PCT: { min: RULES.MIN_EV_PCT, max: 0.035, step: 0.0025 },
  MIN_KELLY_FRACTION: { min: RULES.MIN_KELLY_FRACTION, max: 0.006, step: 0.0005 },
  MIN_SCORE: { min: 50, max: 65, step: 2 },
};
const TUNE_ORDER = ['MIN_EV_PCT', 'MIN_KELLY_FRACTION', 'MIN_SCORE'];

export function defaultAlgoConfig() {
  return {
    MIN_EV_PCT: TUNABLE_BOUNDS.MIN_EV_PCT.min,
    MIN_KELLY_FRACTION: TUNABLE_BOUNDS.MIN_KELLY_FRACTION.min,
    MIN_SCORE: TUNABLE_BOUNDS.MIN_SCORE.min,
  };
}

/**
 * Tennis is keyed per-tournament in the odds feed (this week's Canadian
 * Open, a different key next week) — grouping segments on the raw sportKey
 * would fragment tennis into a new, sample-starved segment every week and
 * never accumulate enough evidence to act on. Collapsed to one virtual
 * ATP/WTA segment each, matching how the rest of the app already treats
 * tennis (see docs/app.js's league-grouping and the Guide's own framing).
 */
export function normalizeSportKey(sportKey) {
  if (!isTennis(sportKey)) return sportKey;
  return String(sportKey).includes('_wta_') || String(sportKey).endsWith('_wta') ? 'tennis_wta' : 'tennis_atp';
}

function segmentKey(sportKey, marketKey) {
  return `${normalizeSportKey(sportKey)}|${marketKey}`;
}

/**
 * Pure aggregator: given a flat array of tracked-pick records (the shape
 * worker/src/tracking.js's pickRecordFrom produces), compute win/loss,
 * ROI, and the z-test described in the file header. Only graded
 * (`status !== 'pending'`), clean (`meetsStandard !== false`) picks with a
 * real `consensusProb` count — flagged/padding picks were never claimed to
 * clear the sharp standard in the first place, so they'd only add noise to
 * a test about whether the standard itself is working.
 */
export function segmentStats(picks) {
  const graded = (picks ?? []).filter(
    (p) => p && p.status !== 'pending' && p.meetsStandard !== false && typeof p.consensusProb === 'number',
  );

  const n = graded.length;
  if (n === 0) {
    return { n: 0, wins: 0, losses: 0, staked: 0, net: 0, roi: 0, expectedWinRate: 0, actualWinRate: 0, z: 0 };
  }

  const wins = graded.filter((p) => p.status === 'won').length;
  const losses = n - wins;
  const staked = graded.reduce((sum, p) => sum + (p.suggested_stake ?? 0), 0);
  const net = graded.reduce((sum, p) => sum + (p.result?.payout ?? 0), 0);
  const roi = staked > 0 ? (net / staked) * 100 : 0;

  const expectedWins = graded.reduce((sum, p) => sum + p.consensusProb, 0);
  const variance = graded.reduce((sum, p) => sum + p.consensusProb * (1 - p.consensusProb), 0);
  const z = variance > 0 ? (wins - expectedWins) / Math.sqrt(variance) : 0;

  return {
    n,
    wins,
    losses,
    staked,
    net,
    roi,
    expectedWinRate: (expectedWins / n) * 100,
    actualWinRate: (wins / n) * 100,
    z,
  };
}

/** Groups a flat pick array into one segmentStats() result per sport+market-type segment. */
export function segmentBreakdown(picks) {
  const bySegment = new Map();
  for (const p of picks ?? []) {
    if (!p?.sportKey || !p?.marketKey) continue;
    const key = segmentKey(p.sportKey, p.marketKey);
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key).push(p);
  }
  return [...bySegment.entries()].map(([key, segPicks]) => ({ key, stats: segmentStats(segPicks) }));
}

/**
 * Decide what (if anything) to do about one segment. Pure — no I/O, fully
 * unit-testable. `isPaused` reflects whether this segment is paused going
 * into this review, which is what makes resume use a different (more
 * forgiving to require, i.e. a stricter recovery bar than the pause bar)
 * threshold than pause — hysteresis, so a segment hovering right at the
 * line doesn't flip pause/resume every week.
 */
export function evaluateSegment(stats, isPaused) {
  if (stats.n < MIN_SEGMENT_SAMPLE) return { action: 'none' };

  if (isPaused) {
    if (stats.z > RESUME_Z) return { action: 'resume', reason: `Recovered: z=${stats.z.toFixed(2)} over ${stats.n} picks` };
    return { action: 'none' };
  }

  if (stats.z <= PAUSE_Z && stats.roi < 0) {
    return { action: 'pause', reason: `z=${stats.z.toFixed(2)}, ROI=${stats.roi.toFixed(1)}% over ${stats.n} picks — significantly below the segment's own no-vig expectation` };
  }
  if (stats.z <= WARN_Z) {
    return { action: 'proposal', reason: `Underperforming but not yet at the pause bar: z=${stats.z.toFixed(2)} over ${stats.n} picks. Worth a manual look — e.g. is moneyline the right market for this segment, or would an alternate market fit better?` };
  }
  return { action: 'none' };
}

/**
 * Decide whether to tighten one global threshold. Only ever moves ONE param
 * ONE step per call — never more than one signal's worth of correction at a
 * time, and never past that param's pre-approved ceiling. Order is fixed
 * (EV floor first, then Kelly, then score) so behavior is deterministic and
 * explainable rather than picking whichever param "looks worst" that week.
 */
export function evaluateGlobalTuning(overallStats, currentConfig) {
  if (overallStats.n < MIN_OVERALL_SAMPLE) return { action: 'none' };
  if (!(overallStats.z <= TIGHTEN_Z && overallStats.roi < 0)) return { action: 'none' };

  for (const param of TUNE_ORDER) {
    const bounds = TUNABLE_BOUNDS[param];
    const before = currentConfig[param] ?? bounds.min;
    if (before >= bounds.max) continue; // already maxed out, try the next param
    const after = Math.min(bounds.max, Math.round((before + bounds.step) * 1e6) / 1e6);
    return {
      action: 'tighten',
      param,
      before,
      after,
      reason: `Overall z=${overallStats.z.toFixed(2)}, ROI=${overallStats.roi.toFixed(1)}% over ${overallStats.n} picks — tightening ${param} from ${before} to ${after}`,
    };
  }
  return { action: 'none' }; // every tunable param already at its ceiling
}

/** Clamp a config to its bounds — defensive; never lets a stored value drift outside [min, max] regardless of how it got there. */
function clampConfig(config) {
  const clamped = {};
  for (const param of TUNE_ORDER) {
    const bounds = TUNABLE_BOUNDS[param];
    const value = config?.[param] ?? bounds.min;
    clamped[param] = Math.min(bounds.max, Math.max(bounds.min, value));
  }
  return clamped;
}

export async function getAlgoConfig(env) {
  const raw = await env.POTD_KV.get(ALGO_CONFIG_KEY);
  return clampConfig(raw ? JSON.parse(raw) : defaultAlgoConfig());
}

export async function getPausedSegments(env) {
  const raw = await env.POTD_KV.get(ALGO_PAUSED_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function getHealthLog(env) {
  const raw = await env.POTD_KV.get(ALGO_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Manual early resume of one paused segment — the "you maintain final
 * approval" override alongside the automatic, evidence-based resume in
 * runAlgoHealthReview. Returns false (no-op) if that segment wasn't paused.
 */
export async function resumeSegmentNow(env, key, now = Date.now()) {
  const paused = await getPausedSegments(env);
  const idx = paused.findIndex((p) => p.key === key);
  if (idx < 0) return false;
  paused.splice(idx, 1);
  const log = await getHealthLog(env);
  const nextLog = [{ week: isoWeekOf(now), at: now, action: 'resume', segment: key, reason: 'Manually resumed' }, ...log].slice(0, 200);
  await Promise.all([
    env.POTD_KV.put(ALGO_PAUSED_KEY, JSON.stringify(paused), { expirationTtl: ALGO_CONFIG_TTL }),
    env.POTD_KV.put(ALGO_LOG_KEY, JSON.stringify(nextLog), { expirationTtl: ALGO_CONFIG_TTL }),
  ]);
  return true;
}

/**
 * Manual full reset of the tuned config back to shipped defaults — the
 * "you maintain final approval" override alongside bounded auto-tightening.
 * Does not touch paused segments (those have their own resume path); a
 * human choosing to reset tuning isn't necessarily vouching for every
 * paused segment too.
 */
export async function resetAlgoConfigToDefaults(env, now = Date.now()) {
  const defaults = defaultAlgoConfig();
  const log = await getHealthLog(env);
  const nextLog = [{ week: isoWeekOf(now), at: now, action: 'reset', reason: 'Manually reset to shipped defaults' }, ...log].slice(0, 200);
  await Promise.all([
    env.POTD_KV.put(ALGO_CONFIG_KEY, JSON.stringify(defaults), { expirationTtl: ALGO_CONFIG_TTL }),
    env.POTD_KV.put(ALGO_LOG_KEY, JSON.stringify(nextLog), { expirationTtl: ALGO_CONFIG_TTL }),
  ]);
  return defaults;
}

/** ISO week string (e.g. "2026-W32") for a given instant, ET calendar. */
function isoWeekOf(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  const d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A candidate whose (normalized sport, market) segment is currently paused
 * is excluded from selection — used by both runTop5Batch (tracking.js) and
 * runPotdDaily (potd.js) so a benched segment can't quietly become the
 * single Play of the Day pick either.
 */
export function isSegmentPaused(candidate, pausedSegments) {
  if (!pausedSegments?.length) return false;
  const key = segmentKey(candidate.sportKey, candidate.marketKey);
  return pausedSegments.some((p) => p.key === key);
}

/**
 * The weekly orchestrator. Idempotent within the same ISO week (ET) — a
 * second tick the same week, or a redeploy mid-week, is a safe no-op. Only
 * real actions (pause/resume/tighten) and proposals are logged; a segment
 * that's simply fine every week doesn't add log noise.
 *
 * `getPicks` is required (not defaulted to tracking.js's getAllTrackedPicks
 * directly) so this module never imports tracking.js — tracking.js already
 * needs to import THIS module for getAlgoConfig/getPausedSegments/
 * isSegmentPaused, and a two-way import would be circular. The real caller
 * (worker/src/index.js's scheduled(), which already imports both modules
 * with no circularity issue) supplies
 * `() => getAllTrackedPicks(env, {now, days: HEALTH_WINDOW_DAYS})`. Same
 * injected-function testability pattern already used throughout this
 * codebase (runTop5Batch's fetchFullSlate, runPotdDaily's fetchFullSlate).
 */
export async function runAlgoHealthReview(env, ctx, now = Date.now(), { getPicks }) {
  const week = isoWeekOf(now);
  const log = await getHealthLog(env);
  // Checked against the most recent 'reviewed' marker specifically, not
  // just log[0] — a manual resume/reset (see resumeSegmentNow/
  // resetAlgoConfigToDefaults) also prepends to this same log with the
  // current week, and would otherwise satisfy a naive log[0] check without
  // an actual review ever having run that week.
  if (log.find((e) => e.action === 'reviewed')?.week === week) {
    return { skipped: true, reason: 'already reviewed this week', week };
  }

  const picks = await getPicks();
  const paused = await getPausedSegments(env);
  const config = await getAlgoConfig(env);

  const entries = [];
  const nextPaused = [...paused];

  for (const { key, stats } of segmentBreakdown(picks)) {
    const isPaused = paused.some((p) => p.key === key);
    const decision = evaluateSegment(stats, isPaused);
    if (decision.action === 'pause') {
      nextPaused.push({ key, pausedAt: now, reason: decision.reason, stats });
      entries.push({ week, at: now, action: 'pause', segment: key, reason: decision.reason, stats });
    } else if (decision.action === 'resume') {
      const idx = nextPaused.findIndex((p) => p.key === key);
      if (idx >= 0) nextPaused.splice(idx, 1);
      entries.push({ week, at: now, action: 'resume', segment: key, reason: decision.reason, stats });
    } else if (decision.action === 'proposal') {
      entries.push({ week, at: now, action: 'proposal', segment: key, reason: decision.reason, stats });
    }
  }

  const pausedKeysAfter = new Set(nextPaused.map((p) => p.key));
  const activePicks = picks.filter((p) => p?.sportKey && p?.marketKey && !pausedKeysAfter.has(segmentKey(p.sportKey, p.marketKey)));
  const overallStats = segmentStats(activePicks);
  const tuning = evaluateGlobalTuning(overallStats, config);
  let nextConfig = config;
  if (tuning.action === 'tighten') {
    nextConfig = clampConfig({ ...config, [tuning.param]: tuning.after });
    entries.push({ week, at: now, action: 'tighten', param: tuning.param, before: tuning.before, after: tuning.after, reason: tuning.reason, stats: overallStats });
  }

  // Always record that a review happened this week, even if nothing changed
  // — otherwise a quiet, healthy week would look identical to "never ran"
  // and the idempotency check above would let it re-run every hourly tick.
  const marker = { week, at: now, action: 'reviewed', segmentCount: segmentBreakdown(picks).length };
  const nextLog = [marker, ...entries, ...log].slice(0, 200);

  await Promise.all([
    env.POTD_KV.put(ALGO_CONFIG_KEY, JSON.stringify(nextConfig), { expirationTtl: ALGO_CONFIG_TTL }),
    env.POTD_KV.put(ALGO_PAUSED_KEY, JSON.stringify(nextPaused), { expirationTtl: ALGO_CONFIG_TTL }),
    env.POTD_KV.put(ALGO_LOG_KEY, JSON.stringify(nextLog), { expirationTtl: ALGO_CONFIG_TTL }),
  ]);

  return { skipped: false, week, actions: entries.length, config: nextConfig, paused: nextPaused };
}
