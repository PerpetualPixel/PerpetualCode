/**
 * Stuck-pick watchdog.
 *
 * Every tracker grades on its own hourly cron pass, and each one is
 * self-healing in the normal case. What none of them had was a check on the
 * abnormal case: a pick whose game finished hours ago and which is STILL
 * `pending`. That state is invisible by design — a pending pick looks
 * exactly like one whose game simply hasn't started yet — so a genuinely
 * stuck pick could sit unnoticed indefinitely. Every stuck-pick incident
 * found so far was found by a human eyeballing the dashboard, which is not
 * a monitoring strategy.
 *
 * This is deliberately a DETECTOR, not a fixer. It writes no pick, changes
 * no status, and grades nothing — the grading passes already run every tick
 * and re-running them here would just duplicate work while making a
 * detector that can also mutate state, which is exactly the kind of thing
 * that turns one bad result into a silent cascade. It reads, compares
 * against wall-clock, and reports.
 *
 * "Stale" is `commenceMs + STALE_AFTER_HOURS < now` while still pending.
 * The threshold is generous on purpose: an MMA card's early prelims can
 * start six hours before its main event, a rain-delayed MLB game runs long,
 * and a tennis match has no clock at all. Flagging a still-playing game as
 * stuck would train whoever reads this to ignore it, which is worse than
 * not having it. A pick with no usable commenceMs (Prop Play stores null
 * when its first leg carried no start time) can't be judged either way and
 * is reported separately rather than assumed fine or assumed broken.
 */

import { getAllTrackedPicks } from './tracking.js';
import { getAllFullSlateTracked } from './full-slate-tracking.js';
import { getPotdHistory } from './potd.js';
import { getAllPropPlays } from './prop-play.js';
import { getLadderHistory } from './ladder.js';
import { getAllMlbPropsTracked } from './mlb-props.js';
import { getAllNflPropsTracked } from './nfl-props.js';
import { getAllWnbaPropsTracked } from './wnba-props.js';
import { getAllNhlPropsTracked } from './nhl-props.js';

/**
 * How long after a game's own start time a still-pending pick is treated as
 * stuck rather than in progress. Eight hours clears every real event length
 * this app tracks — a full MMA card prelims-to-main-event, a long tennis
 * match, an extra-innings MLB game — so anything past it genuinely didn't
 * settle rather than merely running late.
 */
export const STALE_AFTER_HOURS = 8;

/** Where the latest report is cached for the read-only endpoint to serve. */
const STALE_REPORT_KEY = 'stale-picks:latest';
const REPORT_TTL_SECONDS = 7 * 24 * 3600;

/**
 * How far back each tracker is scanned. Two days covers "finished last
 * night, still stuck this morning" without walking 90 days of history on
 * every hourly tick — a stuck pick is worth catching within hours, and one
 * that has been stuck for a week is not newly actionable.
 */
const SCAN_DAYS = 2;

/**
 * Every tracker, read through its own existing public accessor rather than
 * by re-reading KV keys directly — those key layouts are each module's own
 * business, and duplicating them here would mean this file silently breaks
 * the next time one of them changes.
 */
const SOURCES = [
  { tracker: 'top5', label: "Pixel's Picks", load: (env, o) => getAllTrackedPicks(env, o) },
  { tracker: 'fullslate', label: 'Full Slate', load: (env, o) => getAllFullSlateTracked(env, o) },
  { tracker: 'potd', label: 'Play of the Day', load: (env, o) => getPotdHistory(env, o) },
  { tracker: 'propplay', label: 'Prop Play', load: (env, o) => getAllPropPlays(env, o) },
  { tracker: 'mlbprops', label: 'MLB Props', load: (env, o) => getAllMlbPropsTracked(env, o) },
  { tracker: 'nflprops', label: 'NFL Props', load: (env, o) => getAllNflPropsTracked(env, o) },
  { tracker: 'wnbaprops', label: 'WNBA Props', load: (env, o) => getAllWnbaPropsTracked(env, o) },
  { tracker: 'nhlprops', label: 'NHL Props', load: (env, o) => getAllNhlPropsTracked(env, o) },
  // The ladder stores plays under its own shape (getLadderHistory returns
  // { plays, ... }), and each play wraps its bet in `pick` rather than being
  // the pick itself — normalized here so it reports through the same path
  // as everything else instead of needing a second code path.
  {
    tracker: 'ladder',
    label: 'Ladder Challenge',
    load: async (env, o) => {
      const { plays } = await getLadderHistory(env, o);
      return (plays ?? []).map((play) => ({
        pickId: play.pick?.pickId ?? `ladder:${play.dateKey}`,
        dateKey: play.dateKey,
        sportKey: play.pick?.sportKey,
        home: play.pick?.home,
        away: play.pick?.away,
        selection: play.pick?.selection,
        commenceMs: play.pick?.commenceMs ?? null,
        status: play.pick?.status,
      }));
    },
  },
];

/** One flagged pick, trimmed to what a human actually needs to chase it down. */
function describe(pick, tracker, label, now) {
  const hoursStale = pick.commenceMs == null
    ? null
    : Math.round(((now - pick.commenceMs) / 3.6e6) * 10) / 10;
  return {
    tracker,
    trackerLabel: label,
    pickId: pick.pickId ?? null,
    dateKey: pick.dateKey ?? null,
    sportKey: pick.sportKey ?? null,
    matchup: [pick.away, pick.home].filter(Boolean).join(' @ ') || null,
    selection: pick.selection ?? null,
    commenceMs: pick.commenceMs ?? null,
    hoursSinceStart: hoursStale,
  };
}

/**
 * Scans every tracker for pending picks whose game started long enough ago
 * that they should have settled, and returns a report. Pure read — see this
 * module's own header for why it deliberately never grades or writes a pick.
 *
 * A tracker whose read throws is reported as an error entry rather than
 * failing the whole scan: one broken tracker must not blind the watchdog to
 * every other one.
 */
export async function findStalePicks(env, now = Date.now(), { days = SCAN_DAYS, staleAfterHours = STALE_AFTER_HOURS } = {}) {
  const cutoff = now - staleAfterHours * 3.6e6;
  const stale = [];
  const unknownStart = [];
  const errors = [];
  const byTracker = {};

  const loaded = await Promise.all(SOURCES.map(async ({ tracker, label, load }) => {
    try {
      return { tracker, label, picks: (await load(env, { now, days })) ?? [] };
    } catch (error) {
      return { tracker, label, error: String(error).slice(0, 200) };
    }
  }));

  for (const entry of loaded) {
    if (entry.error) {
      errors.push({ tracker: entry.tracker, error: entry.error });
      continue;
    }
    const pending = entry.picks.filter((p) => p?.status === 'pending');
    byTracker[entry.tracker] = { label: entry.label, pending: pending.length, stale: 0 };
    for (const pick of pending) {
      if (pick.commenceMs == null || !Number.isFinite(pick.commenceMs)) {
        unknownStart.push(describe(pick, entry.tracker, entry.label, now));
        continue;
      }
      if (pick.commenceMs < cutoff) {
        stale.push(describe(pick, entry.tracker, entry.label, now));
        byTracker[entry.tracker].stale += 1;
      }
    }
  }

  // Most-overdue first — if there is a real backlog, that ordering is what
  // makes the top of the list the thing worth looking at.
  stale.sort((a, b) => (b.hoursSinceStart ?? 0) - (a.hoursSinceStart ?? 0));

  return {
    checkedAt: now,
    staleAfterHours,
    scanDays: days,
    staleCount: stale.length,
    stale,
    unknownStart,
    errors,
    byTracker,
  };
}

/**
 * The hourly cron entry point: runs the scan and caches the report so the
 * read-only endpoint can serve it without re-walking every tracker on a
 * page view. Deliberately swallows nothing — a thrown error here would take
 * down the whole scheduled() invocation it shares, so the caller wraps it,
 * same as every other job on that tick.
 */
export async function runStalePickAudit(env, ctx, now = Date.now(), opts = {}) {
  const report = await findStalePicks(env, now, opts);
  await env.POTD_KV.put(STALE_REPORT_KEY, JSON.stringify(report), { expirationTtl: REPORT_TTL_SECONDS });
  return report;
}

/**
 * The last cached report, for GET /stale-picks. Null before the first cron
 * tick has ever run — a real "nothing to say yet" answer, not an error.
 */
export async function getStalePickReport(env) {
  const raw = await env.POTD_KV.get(STALE_REPORT_KEY);
  return raw ? JSON.parse(raw) : null;
}
