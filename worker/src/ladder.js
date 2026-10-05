/**
 * The Ladder Challenge — one NFL parlay per kickoff window, every win rolled
 * straight into the next rung, a loss back to the bottom rung.
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
 * Plan vs. reality
 * ----------------
 * ladderPlan is the ideal path at exactly -200. The tracked bankroll is
 * ACTUAL money: a rung filled at -175 banks a little less than the plan and
 * one at +90 rather more, and the skim/target rules are applied to the real
 * number, never to the plan's. The plan is shown as a map, not as a record
 * of what happened.
 *
 * The rung (2026-09-30 redesign)
 * ------------------------------
 * A rung is an NFL PARLAY, not a single pick from whatever sport is on:
 *
 *   - NFL only (LADDER_SPORT_KEY), regular season. Nothing else reaches it.
 *   - One rung per kickoff WINDOW: Thursday night, Sunday early (the 1pm
 *     games, London included), Sunday late (the 4pm games), Sunday night,
 *     Monday night, and a standalone window for a Friday/Saturday/holiday
 *     game (see ladderSlotOf). A rung's legs all come from games in that one
 *     window, across as many of them as it likes, and never two legs from
 *     one game — so a rung can never contradict or overlap itself.
 *   - LADDER_MIN_LEGS to LADDER_MAX_LEGS legs (2-4), combined price inside
 *     LADDER_MIN_AMERICAN..LADDER_MAX_AMERICAN (-200..+100). The whole
 *     bankroll rides the ticket at that combined price.
 *   - ONE rung live at a time. The next window's rung posts only once the
 *     previous rung has settled, so the Sunday late rung goes up after the
 *     1pm games have graded (using the games that haven't kicked yet), and
 *     the Sunday night rung after that. A window whose games have all
 *     started by then is skipped, not forced.
 *   - Every leg has to be a price the reader can bet (`bettable`), carry no
 *     negative expected value against the anchored consensus, and pass the
 *     availability gate: a team leg is refused when the football feed's
 *     current-season report has that team's starting quarterback ruled out,
 *     names a key player as unavailable, or lists no confirmed quarterback
 *     at all; a total is gated on both teams. With no availability data for
 *     a game, its legs are not eligible — "make sure they're playing" is a
 *     requirement, not a preference. The parlay as a whole must clear the
 *     same edge floor every other board holds (algo-health's MIN_EV_PCT).
 *
 * Storage: Workers KV (the same POTD_KV binding the other daily surfaces
 * use). `ladder:state` is the live run, `ladder:play:<date>:<slot>` one
 * rung, `ladder:plays:<date>` the day's list of rungs, `ladder:runs` the
 * archive of finished climbs. A pre-redesign single-pick rung lives at
 * `ladder:play:<date>` and is still read and graded until it ages out.
 */

import { analyze, clearsMaxJuice, isNflPreseason, decimalToAmerican, formatAmerican } from '../../docs/engine.js';
import { gradePick } from '../../docs/learning.js';
import { fetchScores } from './odds.js';
import { getAlgoConfig, getPausedSegments, isSegmentPaused } from './algo-health.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { fetchTennisResults, gradeTennisPickWithEspn, isRegradableTennisVoid, isNoOpTennisRegrade } from './tennis-espn.js';
import { loadTeamContextsFor, applyTeamFormSignal, fixtureKey } from './team-form.js';
import { fetchGridironFeed, findGridironGame, teamsMatch } from '../../docs/gridiron.js';
import { getNflEfficiency } from './nfl-efficiency.js';
import { isTennis, isMma } from '../../docs/insights.js';
import { isExhibition, etDatePlusDays } from './potd.js';

export const LADDER_SPORT_KEY = 'americanfootball_nfl';
export const LADDER_BASE = 20;
/** Skim points: the first time the bankroll passes one, everything above it is banked. */
export const LADDER_MILESTONES = [40, 120, 240];
/** Reaching this completes the climb. */
export const LADDER_TARGET = 360;
/** The price the ladder is designed around — every win pays 1.5x at -200. */
export const LADDER_TARGET_AMERICAN = -200;
/**
 * The combined-price band a rung's parlay must land in: no heavier than
 * -200 (the plan's 1.5x), no longer than +100 (even money). A ticket of two
 * -250 legs pays about -102; three -400 legs about +95; four -550 legs about
 * +100 — so the band is what keeps the legs heavy favourites and the count
 * small, exactly the shape the ladder wants.
 */
export const LADDER_MIN_AMERICAN = -200;
export const LADDER_MAX_AMERICAN = 100;
export const LADDER_MIN_LEGS = 2;
export const LADDER_MAX_LEGS = 4;
/** A window's rung may post once its first unstarted kickoff is this close. */
export const LADDER_LEAD_HOURS = 6;
/** No leg may carry negative expected value against the anchored consensus. */
export const LADDER_LEG_MIN_EV = 0;
/** How many of the best legs the parlay search considers — C(12,4) = 495 combinations, trivial. */
const LADDER_LEG_POOL = 12;
/** Fallback for a game the football feed doesn't carry: this many players listed Out on ESPN blocks the team. */
const LADDER_MAX_OUTS = 8;
/** Only the current season's availability report counts as "playing". */
const LADDER_SEASON = 2026;

const KV_TTL_SECONDS = 86400 * 90;
/** How many finished climbs the archive keeps. */
const MAX_ARCHIVED_RUNS = 60;
/** Three days covers a Sunday rung graded on Monday and a Thursday rung on Friday. */
const GRADING_LOOKBACK_DAYS = 3;

const STATE_KEY = 'ladder:state';
const RUNS_KEY = 'ladder:runs';
const legacyPlayKey = (dateKey) => `ladder:play:${dateKey}`;
const playKey = (dateKey, slot) => `ladder:play:${dateKey}:${slot}`;
const playsKey = (dateKey) => `ladder:plays:${dateKey}`;
/**
 * Why there is no rung right now: waiting on a window, one riding, nothing
 * eligible, or no NFL on the slate. Persisted so /ladder can say which
 * instead of showing an empty section for four different reasons.
 */
const statusKey = (dateKey) => `ladder:status:${dateKey}`;

/** Money is compared and stored to the cent; floating point is not allowed to invent a third decimal. */
const money = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* The plan and the run                                                */
/* ------------------------------------------------------------------ */

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
    // The rung currently riding, as { dateKey, slot }, or null. One at a time
    // is the rule, and this is how the next tick knows one is out.
    activePlay: null,
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

/* ------------------------------------------------------------------ */
/* Kickoff windows                                                     */
/* ------------------------------------------------------------------ */

export const LADDER_SLOTS = {
  OTHER: { key: 'OTHER', label: 'Standalone game', order: 0 },
  TNF: { key: 'TNF', label: 'Thursday Night', order: 1 },
  FRI: { key: 'FRI', label: 'Friday', order: 2 },
  SAT: { key: 'SAT', label: 'Saturday', order: 3 },
  SUN_EARLY: { key: 'SUN_EARLY', label: 'Sunday early window', order: 4 },
  SUN_LATE: { key: 'SUN_LATE', label: 'Sunday late window', order: 5 },
  SNF: { key: 'SNF', label: 'Sunday Night', order: 6 },
  MNF: { key: 'MNF', label: 'Monday Night', order: 7 },
};

/** ET wall-clock parts for an instant: calendar date, weekday (0 = Sunday) and hour. */
export function etClock(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) % 24 };
}

/**
 * Which kickoff window a game belongs to, from its kickoff instant in ET.
 * Sunday splits at 3pm (the early window's 1pm and London 9:30am games
 * before it, the 4:05/4:25 games after) and again at 7pm (Sunday night).
 * Every Monday game is Monday Night, every Thursday game Thursday Night; a
 * Friday or Saturday game is its own window, anything else is standalone.
 */
export function ladderSlotOf(commenceMs) {
  const { weekday, hour } = etClock(commenceMs);
  if (weekday === 0) {
    if (hour < 15) return LADDER_SLOTS.SUN_EARLY;
    if (hour < 19) return LADDER_SLOTS.SUN_LATE;
    return LADDER_SLOTS.SNF;
  }
  if (weekday === 1) return LADDER_SLOTS.MNF;
  if (weekday === 4) return LADDER_SLOTS.TNF;
  if (weekday === 5) return LADDER_SLOTS.FRI;
  if (weekday === 6) return LADDER_SLOTS.SAT;
  return LADDER_SLOTS.OTHER;
}

/**
 * Group unstarted NFL events into windows: [{ slot, dateKey, firstKickoff,
 * events }], soonest first. The dateKey is the ET date of the window's
 * first game, so Monday Night files under Monday and the three Sunday
 * windows under Sunday.
 */
export function ladderWindows(events, now) {
  const groups = new Map();
  for (const event of events ?? []) {
    if (event?.sport_key !== LADDER_SPORT_KEY) continue;
    const commenceMs = Date.parse(event.commence_time ?? '');
    if (!Number.isFinite(commenceMs) || commenceMs <= now) continue;
    const slot = ladderSlotOf(commenceMs);
    const dateKey = etClock(commenceMs).date;
    const id = `${dateKey}:${slot.key}`;
    if (!groups.has(id)) groups.set(id, { id, slot, dateKey, firstKickoff: commenceMs, events: [] });
    const group = groups.get(id);
    group.events.push(event);
    group.firstKickoff = Math.min(group.firstKickoff, commenceMs);
  }
  return [...groups.values()].sort((a, b) => a.firstKickoff - b.firstKickoff);
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

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
 * no honest reason. The same side as a posted pick is fine — the ladder may
 * double a Pixel's Pick; it's a different stake plan over the same board.
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
 * be a separate play), while Pixel's Picks are excluded only where they'd
 * contradict.
 */
export async function ladderExclusions(env, dateKey, top5Picks = []) {
  const [potdRaw, propRaw] = await Promise.all([
    env.POTD_KV.get(`potd:${dateKey}`),
    env.POTD_KV.get(`propplay:${dateKey}`),
  ]);

  const blockedEventIds = new Set();
  const potd = potdRaw ? JSON.parse(potdRaw) : null;
  // The Play of the Day and Pixel's Picks are two-leg tickets (docs/
  // tickets.js): every leg's game is spoken for, and every leg is a side
  // the ladder must not argue with.
  const legsOf = (pick) => (pick?.type === 'combo' && Array.isArray(pick.legs) ? pick.legs : pick ? [pick] : []);
  for (const leg of legsOf(potd?.pick)) {
    if (leg?.eventId) blockedEventIds.add(leg.eventId);
  }
  const prop = propRaw ? JSON.parse(propRaw) : null;
  for (const leg of prop?.legs ?? []) {
    if (leg.oddsEventId) blockedEventIds.add(leg.oddsEventId);
  }

  return {
    blockedEventIds,
    contradictable: [...legsOf(potd?.pick), ...top5Picks.flatMap(legsOf)],
  };
}

/** The team(s) a leg depends on: the side for a moneyline or spread, both for a total. */
function legTeams(candidate) {
  if (candidate.marketKey === 'totals') return [candidate.home, candidate.away].filter(Boolean);
  return [candidate.outcomeName].filter(Boolean);
}

const textFor = (entries, team) =>
  (entries ?? []).find((e) => teamsMatch(e?.team, team))?.text ?? '';

/**
 * The reason a leg fails the availability gate, or null when its players
 * are confirmed playing. Exported for the tests.
 *
 * Primary source: the football engine's picks.json for the game, which is
 * built from the current season's injury reports and rosters (see
 * docs/gridiron.js). Per team it reads three of the feed's plain-text
 * sections, which is deliberately conservative — a text the parser can't
 * read blocks the leg rather than passing it:
 *   - `availability` names each team's starting quarterback; a team not
 *     named there has no confirmed starter → blocked.
 *   - `players` opens "QB <name> …"; if that name appears in the team's
 *     `injuries` "Ruled out" list, the starter is out → blocked. A "Not
 *     available:" clause in `players` names a key player who isn't playing
 *     → blocked.
 * Fallback (a game the feed doesn't carry): ESPN's injury list from the
 * team-form context, blocked at LADDER_MAX_OUTS players listed Out. With
 * neither source the leg is blocked: no data is not the same as healthy.
 */
export function legAvailabilityBlocked(candidate, gridironFeed, contexts) {
  const teams = legTeams(candidate);
  if (!teams.length) return 'no team on this leg';
  const game = findGridironGame(gridironFeed, candidate);

  if (game) {
    if (Number.isFinite(game.season) && game.season < LADDER_SEASON) {
      return `availability report is from ${game.season}, not the current season`;
    }
    const analysis = game.analysis ?? {};
    const availability = String(analysis.availability ?? '');
    for (const team of teams) {
      const named = availability.split(/\band\b/).some((clause) => teamsMatch(clause.replace(/list.*$/i, '').trim(), team) && /quarterback/i.test(clause));
      if (!named) return `${team}: no confirmed starting quarterback in the availability report`;
      const players = textFor(analysis.players, team);
      const injuries = textFor(analysis.injuries, team);
      const qb = /\bQB ([^,.;]+?) (?:has|is|was|adds|remains)\b/.exec(players)?.[1]?.trim();
      if (qb && injuries && injuries.toLowerCase().includes(qb.toLowerCase())) {
        return `${team}: starting quarterback ${qb} is ruled out`;
      }
      const notAvailable = /Not available:\s*([^.]+)/i.exec(players)?.[1]?.trim();
      if (notAvailable) return `${team}: ${notAvailable.replace(/\s+—.*$/, '')} not available`;
    }
    return null;
  }

  const context = contexts?.get?.(fixtureKey(candidate)) ?? null;
  if (!context) return 'no availability data for this game';
  for (const team of teams) {
    const side = [context.home, context.away].find((s) => s && (teamsMatch(s.name, team) || teamsMatch(s.shortName, team)));
    if (!side) return `${team}: no availability data`;
    const outs = (side.injuries ?? []).filter((p) => /^(out|doubtful|injured reserve|ir)\b/i.test(String(p.status ?? ''))).length;
    if (outs >= LADDER_MAX_OUTS) return `${team}: ${outs} players listed out`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Building the parlay                                                 */
/* ------------------------------------------------------------------ */

/**
 * The best parlay from a pool of eligible legs: LADDER_MIN_LEGS to
 * LADDER_MAX_LEGS legs from distinct games whose combined price lands in the
 * band, ranked by the ticket's own expected value (the product of the legs'
 * consensus probabilities against the combined price), with a near-tie
 * breaking toward the price nearest -200 — the plan's 1.5x. Null when no
 * combination qualifies. Pure and exported for the tests.
 */
export function chooseLadderParlay(legs, {
  minLegs = LADDER_MIN_LEGS,
  maxLegs = LADDER_MAX_LEGS,
  minAmerican = LADDER_MIN_AMERICAN,
  maxAmerican = LADDER_MAX_AMERICAN,
  minEv = 0,
} = {}) {
  const pool = (legs ?? [])
    .filter((l) => Number.isFinite(l?.decimal) && l.decimal > 1 && Number.isFinite(l?.consensusProb) && l.consensusProb > 0 && l.consensusProb < 1)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))
    .slice(0, LADDER_LEG_POOL);
  const minDecimal = 1 + 100 / -minAmerican; // -200 → 1.5
  const maxDecimal = maxAmerican > 0 ? 1 + maxAmerican / 100 : 1 + 100 / -maxAmerican; // +100 → 2.0
  const targetDecimal = 1 + 100 / -LADDER_TARGET_AMERICAN;

  let best = null;
  const consider = (combo) => {
    const decimal = combo.reduce((d, l) => d * l.decimal, 1);
    if (decimal < minDecimal - 1e-9 || decimal > maxDecimal + 1e-9) return;
    const prob = combo.reduce((p, l) => p * l.consensusProb, 1);
    const ev = prob * decimal - 1;
    if (ev < minEv) return;
    const candidate = { legs: combo, decimal, american: decimalToAmerican(decimal), prob, ev };
    // A millionth of EV is a tie in any practical sense: at that point the
    // price nearest the plan's 1.5x wins.
    if (!best || ev > best.ev + 1e-6
      || (Math.abs(ev - best.ev) <= 1e-6 && Math.abs(decimal - targetDecimal) < Math.abs(best.decimal - targetDecimal))) {
      best = candidate;
    }
  };
  const walk = (start, combo, games) => {
    if (combo.length >= minLegs) consider(combo);
    if (combo.length >= maxLegs) return;
    for (let i = start; i < pool.length; i++) {
      const leg = pool[i];
      if (games.has(leg.eventId)) continue;
      games.add(leg.eventId);
      walk(i + 1, [...combo, leg], games);
      games.delete(leg.eventId);
    }
  };
  walk(0, [], new Set());
  return best;
}

/** One leg as stored on the rung: everything a grader needs to settle it, nothing else. */
function legRecord(c) {
  return {
    pickId: c.id,
    eventId: c.eventId,
    sportKey: c.sportKey,
    home: c.home,
    away: c.away,
    marketKey: c.marketKey,
    outcomeName: c.outcomeName,
    point: c.point ?? null,
    selection: c.selection,
    american: c.american,
    decimal: c.decimal,
    book: c.book,
    consensusProb: c.consensusProb,
    ev: c.ev,
    score: c.score,
    anchor: c.anchor ?? null,
    commenceMs: c.commenceMs,
    status: 'pending',
  };
}

/* ------------------------------------------------------------------ */
/* Reading rungs                                                       */
/* ------------------------------------------------------------------ */

/** Every rung filed under one ET date — the window rungs plus a pre-redesign single-pick rung, if any. */
async function loadDayPlays(env, dateKey) {
  const [manifestRaw, legacyRaw] = await Promise.all([
    env.POTD_KV.get(playsKey(dateKey)),
    env.POTD_KV.get(legacyPlayKey(dateKey)),
  ]);
  const slots = manifestRaw ? (JSON.parse(manifestRaw).slots ?? []) : [];
  const raws = await Promise.all(slots.map((slot) => env.POTD_KV.get(playKey(dateKey, slot))));
  const plays = raws.filter(Boolean).map((r) => JSON.parse(r));
  if (legacyRaw) plays.push(JSON.parse(legacyRaw));
  return plays.sort((a, b) => (a.generatedAt ?? 0) - (b.generatedAt ?? 0));
}

/** The KV key a stored rung lives under. */
const keyOf = (play) => (play.slot?.key ? playKey(play.dateKey, play.slot.key) : legacyPlayKey(play.dateKey));

/** The rung currently riding, searched across the grading window, or null. */
async function findPendingPlay(env, now) {
  for (let i = 0; i < GRADING_LOOKBACK_DAYS; i++) {
    const plays = await loadDayPlays(env, etDatePlusDays(now, -i));
    const pending = plays.find((p) => !p.settled);
    if (pending) return pending;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Posting a rung                                                      */
/* ------------------------------------------------------------------ */

/**
 * Posts the next window's rung when it's due. Runs on every 15-minute tick
 * (index.js's selection chain) and is idempotent per window: a window with
 * a rung already filed is never drawn twice.
 *
 * Holds, in order, when: a rung is still riding (one at a time); no NFL
 * game is on the slate; the next window is more than LADDER_LEAD_HOURS
 * away; or nothing in the due window builds a parlay that clears the band,
 * the edge floor and the availability gate. Each hold is written to the
 * day's status so /ladder can say which.
 *
 * `gridironFeed` and `fetchFullSlate` are injectable for the tests.
 */
export async function runLadderDaily(env, ctx, now = Date.now(), {
  fetchFullSlate,
  getTop5Picks = async () => [],
  gridironFeed,
} = {}) {
  const today = etClock(now).date;
  const hold = async (reason, detail = {}) => {
    await env.POTD_KV.put(
      statusKey(today),
      JSON.stringify({ dateKey: today, reason, checkedAt: now, ...detail }),
      { expirationTtl: KV_TTL_SECONDS },
    );
    return { skipped: true, reason, dateKey: today, ...detail };
  };

  // One rung at a time — the whole bankroll is on it.
  const pending = await findPendingPlay(env, now);
  if (pending) {
    return hold('a rung is riding — the next window posts once it settles', {
      waiting: true,
      pending: { dateKey: pending.dateKey, slot: pending.slot ?? null, selection: pending.pick?.selection ?? null },
    });
  }

  const events = (await fetchFullSlate()) ?? [];
  const windows = ladderWindows(events, now).filter((w) => !isNflPreseason({ sportKey: w.events[0]?.sport_key }));
  if (!windows.length) {
    return hold('no NFL game on the slate — the ladder is NFL parlays only', { waiting: true });
  }

  // The next window not yet played, soonest first. A window's rung is drawn
  // only from games that haven't kicked, so a window already half underway
  // (the late Sunday games while the early rung was still grading) still
  // gets its rung from what's left — and a window whose games have ALL
  // started simply isn't in `windows` any more.
  let due = null;
  for (const w of windows) {
    if (w.events.length < LADDER_MIN_LEGS) continue;
    if (await env.POTD_KV.get(playKey(w.dateKey, w.slot.key))) continue;
    due = w;
    break;
  }
  if (!due) {
    return hold('every upcoming NFL window either has its rung already or too few games left for a parlay', { waiting: true });
  }
  if (due.firstKickoff - now > LADDER_LEAD_HOURS * 3600000) {
    return hold(`next rung: ${due.slot.label} — posts within ${LADDER_LEAD_HOURS} hours of its first kickoff`, {
      waiting: true,
      next: { slot: due.slot, dateKey: due.dateKey, firstKickoff: due.firstKickoff, games: due.events.length },
    });
  }

  const [pausedSegments, learningProfile, algoConfig, feed] = await Promise.all([
    getPausedSegments(env),
    getLearningProfile(env),
    getAlgoConfig(env),
    gridironFeed !== undefined ? gridironFeed : fetchGridironFeed(undefined, { force: true }).catch(() => null),
  ]);

  const analyzed = analyze(due.events, { now });
  const contexts = await loadTeamContextsFor(analyzed, ctx, { now });
  const candidates = applyLearningToCandidates(
    applyTeamFormSignal(analyzed, contexts, { now, nflEfficiency: await getNflEfficiency(env), gridironFeed: feed }),
    learningProfile,
  );

  const { blockedEventIds, contradictable } = await ladderExclusions(env, today, await getTop5Picks());
  const rejected = { availability: 0, price: 0, edge: 0, board: 0 };
  const legs = candidates.filter((c) => {
    if (c.sportKey !== LADDER_SPORT_KEY || isNflPreseason(c) || isExhibition(c)) return false;
    if (c.commenceMs <= now) return false;
    if (!['h2h', 'spreads', 'totals'].includes(c.marketKey) || !clearsMaxJuice(c)) return false;
    if (isSegmentPaused(c, pausedSegments)) return false;
    if (c.bettable === false) { rejected.price++; return false; }
    if (!(c.ev >= LADDER_LEG_MIN_EV)) { rejected.edge++; return false; }
    if (blockedEventIds.has(c.eventId) || contradictable.some((pick) => contradictsPick(c, pick))) { rejected.board++; return false; }
    if (legAvailabilityBlocked(c, feed, contexts)) { rejected.availability++; return false; }
    return true;
  });

  const parlay = chooseLadderParlay(legs, { minEv: algoConfig.MIN_EV_PCT });
  if (!parlay) {
    return hold(`${due.slot.label}: nothing builds a ${LADDER_MIN_LEGS}-${LADDER_MAX_LEGS} leg parlay inside ${formatAmerican(LADDER_MIN_AMERICAN)}..${formatAmerican(LADDER_MAX_AMERICAN)} that clears the edge floor and the availability gate`, {
      slot: due.slot, dateKey: due.dateKey, eligibleLegs: legs.length, rejected,
    });
  }

  const state = await getLadderState(env, now);
  const stake = money(state.bankroll);
  const legRecords = parlay.legs.map(legRecord);
  const record = {
    dateKey: due.dateKey,
    slot: due.slot,
    runId: state.runId,
    step: state.step,
    generatedAt: now,
    stake,
    toReturn: money(stake * parlay.decimal),
    settled: false,
    pick: {
      pickId: legRecords.map((l) => l.pickId).join('+'),
      dateKey: due.dateKey,
      // A ticket, not a game: no single event. Readers that key on eventId
      // (the write-up route) skip it on purpose.
      eventId: null,
      sportKey: LADDER_SPORT_KEY,
      sportTitle: 'NFL',
      marketKey: 'parlay',
      marketLabel: `${legRecords.length}-leg parlay`,
      outcomeName: null,
      point: null,
      selection: legRecords.map((l) => l.selection).join(' + '),
      american: parlay.american,
      decimal: money(parlay.decimal * 1000) / 1000,
      legs: legRecords,
      consensusProb: parlay.prob,
      ev: parlay.ev,
      score: legRecords.reduce((s, l) => s + (l.score ?? 0), 0) / legRecords.length,
      home: null,
      away: null,
      book: [...new Set(legRecords.map((l) => l.book))].join(', '),
      commenceMs: Math.min(...legRecords.map((l) => l.commenceMs)),
      lastCommenceMs: Math.max(...legRecords.map((l) => l.commenceMs)),
      suggested_stake: stake,
      status: 'pending',
      result: null,
      viaFallback: false,
    },
  };

  const manifestRaw = await env.POTD_KV.get(playsKey(due.dateKey));
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : { dateKey: due.dateKey, slots: [] };
  if (!manifest.slots.includes(due.slot.key)) manifest.slots.push(due.slot.key);

  await Promise.all([
    env.POTD_KV.put(playKey(due.dateKey, due.slot.key), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS }),
    env.POTD_KV.put(playsKey(due.dateKey), JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS }),
    putLadderState(env, { ...state, activePlay: { dateKey: due.dateKey, slot: due.slot.key } }),
    env.POTD_KV.delete(statusKey(today)),
  ]);
  return { skipped: false, dateKey: due.dateKey, slot: due.slot, record };
}

/* ------------------------------------------------------------------ */
/* Settling                                                            */
/* ------------------------------------------------------------------ */

/**
 * Applies one settled rung to the run, returning the next state.
 *
 * Pure, and exported, because this is the part that has to be exactly right:
 * a win compounds and may skim and may complete the climb; a loss ends the
 * run at the bottom; a void (a postponed game, every leg pushing) leaves the
 * ladder untouched so the same rung is played again rather than being
 * treated as either. `outcome.decimal` is the price the ticket actually paid
 * when a pushed leg dropped out of it; absent, the posted price stands.
 * Returns { state, finishedRun } — finishedRun is the archived climb when
 * this settlement ended one, else null.
 */
export function settleLadderPlay(state, play, outcome, now) {
  const clearActive = (s) => ({ ...s, activePlay: null });
  if (outcome.void) {
    return { state: clearActive(state), finishedRun: null };
  }

  if (!outcome.won) {
    const finishedRun = {
      ...clearActive(state),
      status: 'busted',
      endedAt: now,
      endedBy: 'loss',
      lostAt: { dateKey: play.dateKey, slot: play.slot?.label ?? null, step: play.step, stake: play.stake, selection: play.pick.selection },
      // What the climb was worth when it broke: only the money already
      // skimmed out survives a bust, which is the whole argument for
      // skimming at all.
      totalValue: money(state.banked),
    };
    return { state: newLadderRun(now, state.runId), finishedRun };
  }

  const paid = Number.isFinite(outcome.decimal) ? outcome.decimal : play.pick.decimal;
  const returns = money(play.stake * paid);
  const skimmed = new Set(state.skimmed ?? []);
  const milestone = LADDER_MILESTONES.find((m) => !skimmed.has(m) && returns > m);
  const takeOut = milestone ? money(returns - milestone) : 0;
  if (milestone) skimmed.add(milestone);

  const next = {
    ...clearActive(state),
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

/**
 * Settle a parlay's legs from the scores feed and fold them into one
 * verdict. Every leg must land; any lost leg loses the ticket the moment it
 * grades, without waiting on the rest; a pushed leg drops out and the ticket
 * pays the remaining legs' price (the standard treatment — a push is not a
 * loss); a ticket whose every leg pushed is void. Null while the ticket is
 * still open. Legs already settled keep their verdict. Exported for the
 * tests.
 */
export function gradeLadderParlay(pick, scoreEvents, now = Date.now()) {
  for (const leg of pick.legs ?? []) {
    if (leg.status && leg.status !== 'pending') continue;
    const scoreEvent = (scoreEvents ?? []).find((e) => e.id === leg.eventId);
    const outcome = gradePick({ ...leg, suggested_stake: 1 }, scoreEvent, now);
    if (!outcome) continue;
    leg.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    if (outcome.void) leg.voidReason = outcome.reason;
    if (outcome.detail) leg.detail = outcome.detail;
  }
  const legs = pick.legs ?? [];
  if (legs.some((l) => l.status === 'lost')) return { won: false, payout: -pick.suggested_stake };
  if (legs.some((l) => !l.status || l.status === 'pending')) return null;
  const live = legs.filter((l) => l.status === 'won');
  if (!live.length) return { void: true, reason: 'every leg voided', payout: 0 };
  const decimal = live.reduce((d, l) => d * l.decimal, 1);
  return {
    won: true,
    decimal,
    payout: money(pick.suggested_stake * (decimal - 1)),
    ...(live.length < legs.length ? { detail: `${legs.length - live.length} leg${legs.length - live.length === 1 ? '' : 's'} pushed and dropped out; paid at ${formatAmerican(decimalToAmerican(decimal))}` } : {}),
  };
}

/** Grade one stored rung (parlay or pre-redesign single pick) and fold the result into the run. */
async function gradeLadderPlay(env, ctx, now, record, { scoreEvents, fetchScoresFn, fetchMmaResultsFn, fetchTennisResultsFn }) {
  if (record.settled && !isRegradableTennisVoid(record.pick)) return false;
  const { pick } = record;
  const key = keyOf(record);

  let outcome;
  if (Array.isArray(pick.legs)) {
    const before = JSON.stringify(pick.legs.map((l) => l.status));
    outcome = gradeLadderParlay(pick, scoreEvents, now);
    // Partial progress (some legs graded, ticket still open) is persisted so
    // the card can show which legs have landed.
    if (!outcome && JSON.stringify(pick.legs.map((l) => l.status)) !== before) {
      await env.POTD_KV.put(key, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
    }
  } else {
    const { events } = await fetchScoresFn(pick.sportKey);
    const scoreEvent = (events ?? []).find((e) => e.id === pick.eventId);
    if (isMma(pick.sportKey)) {
      outcome = gradeMmaPickWithFallback(pick, scoreEvent, await fetchMmaResultsFn());
    } else if (isTennis(pick.sportKey)) {
      outcome = await gradeTennisPickWithEspn(pick, scoreEvent, await fetchTennisResultsFn(), env, ctx, now);
    } else {
      outcome = gradePick(pick, scoreEvent);
    }
    if (outcome && isNoOpTennisRegrade(pick, outcome)) return false;
  }
  if (!outcome) return false;

  pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
  pick.result = {
    payout: outcome.payout,
    roiPercent: outcome.void ? 0 : (outcome.payout / record.stake) * 100,
    voidReason: outcome.void ? outcome.reason : undefined,
    detail: outcome.detail ?? undefined,
  };

  // The state read happens here rather than up front so a rung that grades
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
  record.paidDecimal = outcome.won ? (outcome.decimal ?? pick.decimal) : null;

  await env.POTD_KV.put(key, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  if (appliesToCurrentRun) {
    if (finishedRun) await archiveRun(env, finishedRun);
    await putLadderState(env, nextState);
  }
  return true;
}

/**
 * Grade whichever rungs of the last few days are still open. Runs on every
 * tick, same as the other grading passes, and is idempotent: a rung carries
 * `settled`, so it can never be applied to the bankroll twice. Oldest first,
 * because rungs compound.
 */
export async function runLadderGrading(env, ctx, now = Date.now(), {
  fetchScoresFn = (s) => fetchScores(s, env, ctx),
  fetchMmaResultsFn = () => fetchMmaResults(ctx, now),
  fetchTennisResultsFn = () => fetchTennisResults(ctx, now),
  lookbackDays = GRADING_LOOKBACK_DAYS,
} = {}) {
  const dateKeys = [...new Set(Array.from({ length: lookbackDays }, (_, i) => etDatePlusDays(now, -i)))].reverse();
  const plays = (await Promise.all(dateKeys.map((d) => loadDayPlays(env, d)))).flat()
    .filter((p) => !p.settled || isRegradableTennisVoid(p.pick))
    .sort((a, b) => (a.generatedAt ?? 0) - (b.generatedAt ?? 0));
  if (!plays.length) return { graded: false };

  // One NFL scores fetch serves every parlay in the window.
  const scoreEvents = plays.some((p) => Array.isArray(p.pick?.legs))
    ? ((await fetchScoresFn(LADDER_SPORT_KEY)).events ?? [])
    : [];

  let graded = false;
  for (const record of plays) {
    if (await gradeLadderPlay(env, ctx, now, record, { scoreEvents, fetchScoresFn, fetchMmaResultsFn, fetchTennisResultsFn })) {
      graded = true;
    }
  }
  return { graded };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Everything the Ladder Challenge section renders from: the live run, the
 * ideal plan, the rung riding now (else the most recent one, marked stale),
 * today's rungs, and why there's nothing riding when there isn't.
 */
export async function getLadder(env, now = Date.now()) {
  const today = etClock(now).date;
  const [state, todayPlays, yesterdayPlays, statusRaw] = await Promise.all([
    getLadderState(env, now),
    loadDayPlays(env, today),
    loadDayPlays(env, etDatePlusDays(now, -1)),
    env.POTD_KV.get(statusKey(today)),
  ]);

  const riding = [...todayPlays, ...yesterdayPlays].find((p) => !p.settled) ?? null;
  const latest = (list) => (list.length ? list[list.length - 1] : null);
  const play = riding
    ?? latest(todayPlays)
    ?? (latest(yesterdayPlays) ? { ...latest(yesterdayPlays), stale: true } : null);
  return {
    state,
    plan: ladderPlan(),
    play,
    plays: todayPlays,
    base: LADDER_BASE,
    target: LADDER_TARGET,
    milestones: LADDER_MILESTONES,
    band: { min: LADDER_MIN_AMERICAN, max: LADDER_MAX_AMERICAN },
    legs: { min: LADDER_MIN_LEGS, max: LADDER_MAX_LEGS },
    sport: 'NFL',
    // Why nothing is riding, when nothing is. Null while a rung is out.
    todayStatus: riding ? null : (statusRaw ? JSON.parse(statusRaw) : null),
  };
}

/**
 * The ladder's own history for the Tracking Dashboard: every rung still in
 * KV plus every finished climb. Rungs carry which run and step they belonged
 * to, so the dashboard can draw each climb start-to-finish rather than as a
 * flat list of picks.
 */
export async function getLadderHistory(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDatePlusDays(now, -i));
  const [dayPlays, runs, state] = await Promise.all([
    Promise.all(dateKeys.map((d) => loadDayPlays(env, d))),
    getLadderRuns(env),
    getLadderState(env, now),
  ]);
  return { plays: dayPlays.flat(), runs, state, plan: ladderPlan() };
}
