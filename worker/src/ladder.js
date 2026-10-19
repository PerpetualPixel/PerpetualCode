/**
 * The Ladder Challenge — one player-prop parlay a day, every win rolled
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
 * The rung (2026-10-19 redesign)
 * ------------------------------
 * A rung is a parlay of LOW-LEVEL PLAYER PROPS — the direction's own
 * example: a player who gets 40 yards a game, picked to get 20; another
 * who usually grabs seven rebounds, picked to grab four. The two together
 * are the rung. Concretely:
 *
 *   - Legs come from the same prop pipeline the boards use (worker/src/
 *     prop-legs.js: NFL, NBA and NHL lines checked against the player's
 *     current-season game log), held to the ladder's own stricter bar:
 *     the line sits at LADDER_COMFORT_RATIO of the player's season average
 *     or lower, the player has cleared it in LADDER_MIN_SEASON_RATE of
 *     games this season and LADDER_MIN_L5_RATE of the last five, and the
 *     leg prices inside LADDER_LEG_MIN_AMERICAN..LADDER_LEG_MAX_AMERICAN.
 *   - LADDER_MIN_LEGS to LADDER_MAX_LEGS legs (2-3), combined price inside
 *     LADDER_MIN_AMERICAN..LADDER_MAX_AMERICAN (-200..+100), two legs never
 *     on one player (docs/tickets.js's legsConflict). The whole bankroll
 *     rides the ticket at that combined price.
 *   - ONE rung a day, ONE riding at a time: today's rung posts with the 2am
 *     boards once yesterday's has settled. A leg whose player doesn't play
 *     voids and drops out of the ticket; a ticket of nothing but voids is
 *     replayed, not lost.
 *   - Never a leg already posted on the Play of the Day or Pixel's Picks:
 *     the ladder is a separate play, not a double of the board.
 *
 * The record behind the redesign: the previous ladder (single game-market
 * picks, then NFL parlays per kickoff window) went 18-11-2 at the bottom
 * rung and never climbed past step 1 — a $20 bet that won 60% of the time
 * at even money is not a ladder, it is a coin with a small edge.
 *
 * Storage: Workers KV (the same POTD_KV binding the other daily surfaces
 * use). `ladder:state` is the live run, `ladder:play:<date>:<slot>` one
 * rung, `ladder:plays:<date>` the day's list of rungs, `ladder:runs` the
 * archive of finished climbs. Older rungs (a kickoff-window NFL parlay, a
 * pre-redesign single pick at `ladder:play:<date>`) are still read and
 * graded until they age out.
 */

import { decimalToAmerican, formatAmerican } from '../../docs/engine.js';
import { gradePick } from '../../docs/learning.js';
import { legsConflict } from '../../docs/tickets.js';
import { fetchScores } from './odds.js';
import { getAlgoConfig } from './algo-health.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { fetchTennisResults, gradeTennisPickWithEspn, isRegradableTennisVoid, isNoOpTennisRegrade } from './tennis-espn.js';
import { isTennis, isMma } from '../../docs/insights.js';
import { etDatePlusDays } from './potd.js';
import { collectPropLegs, propStatsReader } from './prop-legs.js';
import { gradeTicketLeg, legsOf } from './ticket-grading.js';

export const LADDER_BASE = 20;
/** Skim points: the first time the bankroll passes one, everything above it is banked. */
export const LADDER_MILESTONES = [40, 120, 240];
/** Reaching this completes the climb. */
export const LADDER_TARGET = 360;
/** The price the ladder is designed around — every win pays 1.5x at -200. */
export const LADDER_TARGET_AMERICAN = -200;
/**
 * The combined-price band a rung's parlay must land in: no heavier than
 * -200 (the plan's 1.5x), no longer than +100 (even money). Two -250 legs
 * pay about -102; three -400 legs about +95 — the band is what keeps the
 * legs deep and the count small, exactly the shape the ladder wants.
 */
export const LADDER_MIN_AMERICAN = -200;
export const LADDER_MAX_AMERICAN = 100;
export const LADDER_MIN_LEGS = 2;
export const LADDER_MAX_LEGS = 3;
/** Each leg's own price: a deep comfort-zone line, never a coin flip. */
export const LADDER_LEG_MIN_AMERICAN = -500;
export const LADDER_LEG_MAX_AMERICAN = -150;
/** "Consistently getting 40 a game, picked to get 20": the line at most this share of the season average. */
export const LADDER_COMFORT_RATIO = 0.6;
/** The player has cleared the line in this share of games this season, and of the last five. */
export const LADDER_MIN_SEASON_RATE = 0.85;
export const LADDER_MIN_L5_RATE = 0.8;
/** How many of the best legs the parlay search considers — C(14,3) = 364 combinations, trivial. */
const LADDER_LEG_POOL = 14;

const KV_TTL_SECONDS = 86400 * 90;
/** How many finished climbs the archive keeps. */
const MAX_ARCHIVED_RUNS = 60;
/** Three days covers a late game graded the next morning and a rung that waited a day. */
const GRADING_LOOKBACK_DAYS = 3;

const STATE_KEY = 'ladder:state';
const RUNS_KEY = 'ladder:runs';
const legacyPlayKey = (dateKey) => `ladder:play:${dateKey}`;
const playKey = (dateKey, slot) => `ladder:play:${dateKey}:${slot}`;
const playsKey = (dateKey) => `ladder:plays:${dateKey}`;
/** Why there is no rung right now: one riding, nothing eligible, no prop league on. Persisted so /ladder can say which. */
const statusKey = (dateKey) => `ladder:status:${dateKey}`;

/** The one daily rung's slot. Older kickoff-window rungs keep their own slot keys. */
export const LADDER_SLOT = { key: 'PROPS', label: 'Daily props rung', order: 0 };

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

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

/**
 * Whether a ladder candidate would contradict a pick the app has already
 * posted today. Same event, same market, different side — that's the case
 * that matters: recommending a team's moneyline on one surface and its
 * opponent's on another is the app arguing with itself, and the ladder is
 * the surface that gives way. A prop contradicts only the same player's
 * same stat on the other side; two players, or two stats, never do.
 */
export function contradictsPick(candidate, pick) {
  if (!pick || candidate.eventId !== pick.eventId) return false;
  if (candidate.kind === 'prop' || pick.kind === 'prop') {
    return candidate.kind === 'prop' && pick.kind === 'prop'
      && candidate.statKey === pick.statKey
      && String(candidate.playerName ?? '').toLowerCase() === String(pick.playerName ?? '').toLowerCase()
      && (candidate.outcomeName !== pick.outcomeName || candidate.point !== pick.point);
  }
  if (candidate.marketKey !== pick.marketKey) return false;
  return candidate.outcomeName !== pick.outcomeName
    // Same side of a spread/total at a different number is still a different
    // bet, but the opposite number on the same side is the other side of it.
    || (candidate.point != null && pick.point != null && candidate.point !== pick.point);
}

/**
 * Today's exclusions, read from what's already been posted: every leg the
 * Play of the Day and Pixel's Picks carry (by id — the ladder never doubles
 * a posted leg) and every posted leg a candidate must not argue with.
 */
export async function ladderExclusions(env, dateKey, top5Picks = []) {
  const potdRaw = await env.POTD_KV.get(`potd:${dateKey}`);
  const potd = potdRaw ? JSON.parse(potdRaw) : null;
  const posted = [...legsOf(potd?.pick ?? null), ...top5Picks.flatMap((p) => legsOf(p))].filter(Boolean);
  return {
    postedLegIds: new Set(posted.map((l) => l.legId ?? l.pickId ?? l.id).filter(Boolean)),
    contradictable: posted,
  };
}

/**
 * The reason a prop leg fails the ladder's bar, or null when it clears it.
 * Exported for the tests.
 */
export function ladderLegRejection(leg, { now = Date.now() } = {}) {
  if (leg?.kind !== 'prop' || !leg.profile) return 'not a player prop';
  if (!(leg.commenceMs > now)) return 'game already started';
  if (leg.bettable === false) return 'not a price the reader can bet';
  const minDecimal = 1 + 100 / -LADDER_LEG_MIN_AMERICAN;
  const maxDecimal = 1 + 100 / -LADDER_LEG_MAX_AMERICAN;
  if (!(leg.decimal >= minDecimal - 1e-9 && leg.decimal <= maxDecimal + 1e-9)) return `priced ${formatAmerican(leg.american)}, outside ${formatAmerican(LADDER_LEG_MIN_AMERICAN)}..${formatAmerican(LADDER_LEG_MAX_AMERICAN)}`;
  const p = leg.profile;
  if (!(Number.isFinite(p.avgSeason) && p.avgSeason > 0)) return 'no season average';
  if (leg.need > p.avgSeason * LADDER_COMFORT_RATIO + 1e-9) return `line ${leg.need}+ is above ${Math.round(LADDER_COMFORT_RATIO * 100)}% of the ${p.avgSeason} season average`;
  if (!(p.season >= LADDER_MIN_SEASON_RATE)) return `cleared in ${Math.round(p.season * 100)}% of games this season, under ${Math.round(LADDER_MIN_SEASON_RATE * 100)}%`;
  if (!(p.l5 >= LADDER_MIN_L5_RATE)) return `cleared in ${Math.round(p.l5 * 100)}% of the last five, under ${Math.round(LADDER_MIN_L5_RATE * 100)}%`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Building the parlay                                                 */
/* ------------------------------------------------------------------ */

/**
 * The best parlay from a pool of eligible legs: LADDER_MIN_LEGS to
 * LADDER_MAX_LEGS legs, no two on one player or arguing with each other
 * (docs/tickets.js's legsConflict), whose combined price lands in the band,
 * ranked by the ticket's own expected value (the product of the legs'
 * probabilities against the combined price), with a near-tie breaking
 * toward the price nearest -200 — the plan's 1.5x. Null when no
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
  const walk = (start, combo) => {
    if (combo.length >= minLegs) consider(combo);
    if (combo.length >= maxLegs) return;
    for (let i = start; i < pool.length; i++) {
      const leg = pool[i];
      if (combo.some((l) => l.id === leg.id || legsConflict(l, leg))) continue;
      walk(i + 1, [...combo, leg]);
    }
  };
  walk(0, []);
  return best;
}

/** One leg as stored on the rung: everything a grader and the card need, nothing else. */
function legRecord(c) {
  return {
    pickId: c.id,
    legId: c.id,
    eventId: c.eventId,
    sportKey: c.sportKey,
    sportTitle: c.sportTitle,
    home: c.home,
    away: c.away,
    marketKey: c.marketKey,
    marketLabel: c.marketLabel,
    outcomeName: c.outcomeName,
    point: c.point ?? null,
    selection: c.selection,
    american: c.american,
    decimal: c.decimal,
    book: c.book,
    consensusProb: c.consensusProb,
    ev: c.ev,
    score: c.score,
    commenceMs: c.commenceMs,
    ...(c.kind === 'prop' ? {
      kind: 'prop',
      playerName: c.playerName,
      statKey: c.statKey,
      need: c.need,
      espnEventId: c.espnEventId ?? null,
      profile: c.profile ?? null,
      edge: c.edge ?? null,
    } : {}),
    status: 'pending',
  };
}

/* ------------------------------------------------------------------ */
/* Reading rungs                                                       */
/* ------------------------------------------------------------------ */

/** Every rung filed under one ET date — the slot rungs plus a pre-redesign single-pick rung, if any. */
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
 * Posts today's rung when it's due. Runs on every 15-minute tick (index.js's
 * selection chain) and is idempotent per day: a day with a rung already
 * filed is never drawn twice.
 *
 * Holds, in order, when: a rung is still riding (one at a time); today's
 * rung already posted; no prop league has a game today; or nothing builds
 * a parlay that clears the ladder's bar and the band. Each hold is written
 * to the day's status so /ladder can say which.
 *
 * `fetchFullSlate`, `fetchPropLegs` and `getTop5Picks` are injectable for
 * the tests.
 */
export async function runLadderDaily(env, ctx, now = Date.now(), {
  fetchFullSlate = async () => [],
  fetchPropLegs = (games, opts) => collectPropLegs(games, env, ctx, now, opts),
  getTop5Picks = async () => [],
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
    return hold('a rung is riding — the next posts once it settles', {
      waiting: true,
      pending: { dateKey: pending.dateKey, slot: pending.slot ?? null, selection: pending.pick?.selection ?? null },
    });
  }
  if (await env.POTD_KV.get(playKey(today, LADDER_SLOT.key))) {
    return hold("today's rung has already been played — the next posts tomorrow", { waiting: true });
  }

  const events = (await fetchFullSlate()) ?? [];
  const sameDay = (ms) => etClock(ms).date === today;
  const todaysGames = events.filter((e) => sameDay(Date.parse(e.commence_time ?? '')) && Date.parse(e.commence_time ?? '') > now);
  let propLegs = [];
  try {
    propLegs = (await fetchPropLegs(todaysGames, { sameDay })) ?? [];
  } catch (e) {
    console.error('Ladder prop legs failed:', e);
  }
  propLegs = propLegs.filter((l) => sameDay(l.commenceMs));
  if (!propLegs.length) {
    return hold('no player-prop line on today\'s NFL, NBA or NHL games clears the hit-rate gates', { waiting: true });
  }

  const [algoConfig, { postedLegIds, contradictable }] = await Promise.all([
    getAlgoConfig(env),
    ladderExclusions(env, today, await getTop5Picks()),
  ]);
  const rejected = { board: 0, bar: 0 };
  const legs = propLegs.filter((c) => {
    if (postedLegIds.has(c.id) || contradictable.some((pick) => contradictsPick(c, pick))) { rejected.board++; return false; }
    if (ladderLegRejection(c, { now })) { rejected.bar++; return false; }
    return true;
  });

  const parlay = chooseLadderParlay(legs, { minEv: algoConfig.MIN_EV_PCT });
  if (!parlay) {
    return hold(`${propLegs.length} prop lines on today's games, ${legs.length} deep enough for a rung, but no ${LADDER_MIN_LEGS}-${LADDER_MAX_LEGS} of them pair inside ${formatAmerican(LADDER_MIN_AMERICAN)}..${formatAmerican(LADDER_MAX_AMERICAN)} with an edge`, {
      dateKey: today, eligibleLegs: legs.length, rejected,
    });
  }

  const state = await getLadderState(env, now);
  const stake = money(state.bankroll);
  const legRecords = parlay.legs.map(legRecord);
  const sportTitles = [...new Set(legRecords.map((l) => l.sportTitle ?? l.sportKey))];
  const record = {
    dateKey: today,
    slot: LADDER_SLOT,
    runId: state.runId,
    step: state.step,
    generatedAt: now,
    stake,
    toReturn: money(stake * parlay.decimal),
    settled: false,
    pick: {
      pickId: legRecords.map((l) => l.pickId).join('+'),
      dateKey: today,
      // A ticket, not a game: no single event. Readers that key on eventId
      // (the write-up route) skip it on purpose.
      eventId: null,
      sportKey: 'props',
      sportTitle: sportTitles.join(' + '),
      marketKey: 'parlay',
      marketLabel: `${legRecords.length}-leg props parlay`,
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

  const manifestRaw = await env.POTD_KV.get(playsKey(today));
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : { dateKey: today, slots: [] };
  if (!manifest.slots.includes(LADDER_SLOT.key)) manifest.slots.push(LADDER_SLOT.key);

  await Promise.all([
    env.POTD_KV.put(playKey(today, LADDER_SLOT.key), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS }),
    env.POTD_KV.put(playsKey(today), JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS }),
    putLadderState(env, { ...state, activePlay: { dateKey: today, slot: LADDER_SLOT.key } }),
    env.POTD_KV.delete(statusKey(today)),
  ]);
  return { skipped: false, dateKey: today, slot: LADDER_SLOT, record };
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
 * when a voided leg dropped out of it; absent, the posted price stands.
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
 * Fold a parlay's legs into one verdict. Every leg must land; any lost leg
 * loses the ticket the moment it grades, without waiting on the rest; a
 * voided leg (a push, a player who didn't play) drops out and the ticket
 * pays the remaining legs' price (the standard treatment — a push is not a
 * loss); a ticket whose every leg voided is void. Null while the ticket is
 * still open. Pure and exported for the tests.
 */
export function foldLadderLegs(pick) {
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
    ...(live.length < legs.length ? { detail: `${legs.length - live.length} leg${legs.length - live.length === 1 ? '' : 's'} voided and dropped out; paid at ${formatAmerican(decimalToAmerican(decimal))}` } : {}),
  };
}

/**
 * Settle a game-market parlay's legs from the scores feed (the kickoff-
 * window rungs the ladder used to post) and fold them. Legs already settled
 * keep their verdict. Exported for the tests.
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
  return foldLadderLegs(pick);
}

/**
 * Settle a props parlay's legs through the shared ticket grader (worker/
 * src/ticket-grading.js — the final boxscore for a prop leg, the per-sport
 * graders for anything else) and fold them. Exported for the tests.
 */
export async function gradeLadderPropParlay(pick, deps) {
  for (const leg of pick.legs ?? []) {
    if (leg.status && leg.status !== 'pending') continue;
    const outcome = await gradeTicketLeg(leg, deps);
    if (!outcome) continue;
    leg.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    if (outcome.void) leg.voidReason = outcome.reason;
    if (outcome.detail) leg.detail = outcome.detail;
    if (outcome.actual != null) leg.actual = outcome.actual;
  }
  return foldLadderLegs(pick);
}

/** Grade one stored rung (props parlay, game parlay, or single pick) and fold the result into the run. */
async function gradeLadderPlay(env, ctx, now, record, deps) {
  if (record.settled && !isRegradableTennisVoid(record.pick)) return false;
  const { pick } = record;
  const key = keyOf(record);

  let outcome;
  if (Array.isArray(pick.legs)) {
    const before = JSON.stringify(pick.legs.map((l) => l.status));
    outcome = pick.legs.some((l) => l.kind === 'prop')
      ? await gradeLadderPropParlay(pick, deps)
      : gradeLadderParlay(pick, await deps.scoreEventsFor('americanfootball_nfl'), now);
    // Partial progress (some legs graded, ticket still open) is persisted so
    // the card can show which legs have landed.
    if (!outcome && JSON.stringify(pick.legs.map((l) => l.status)) !== before) {
      await env.POTD_KV.put(key, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
    }
  } else {
    const events = await deps.scoreEventsFor(pick.sportKey);
    const scoreEvent = (events ?? []).find((e) => e.id === pick.eventId);
    if (isMma(pick.sportKey)) {
      outcome = gradeMmaPickWithFallback(pick, scoreEvent, await deps.mmaResults());
    } else if (isTennis(pick.sportKey)) {
      outcome = await gradeTennisPickWithEspn(pick, scoreEvent, await deps.tennisResults(), env, ctx, now);
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
  propStatsFor = propStatsReader(ctx),
  lookbackDays = GRADING_LOOKBACK_DAYS,
} = {}) {
  const dateKeys = [...new Set(Array.from({ length: lookbackDays }, (_, i) => etDatePlusDays(now, -i)))].reverse();
  const plays = (await Promise.all(dateKeys.map((d) => loadDayPlays(env, d)))).flat()
    .filter((p) => !p.settled || isRegradableTennisVoid(p.pick))
    .sort((a, b) => (a.generatedAt ?? 0) - (b.generatedAt ?? 0));
  if (!plays.length) return { graded: false };

  // Every feed is fetched at most once per pass, and only when a rung needs it.
  const memo = new Map();
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const scoreEventsFor = (sportKey) => once(`scores|${sportKey}`, async () => (await fetchScoresFn(sportKey)).events ?? []);
  const deps = {
    scoreEventsFor,
    scoreEventFor: () => undefined,
    mmaResults: () => once('mma', fetchMmaResultsFn),
    tennisResults: () => once('tennis', fetchTennisResultsFn),
    env, ctx, now, propStatsFor,
  };
  // The shared ticket grader reads a score event per leg synchronously;
  // every game-market sport a props rung could carry is prefetched first.
  const gameSports = [...new Set(plays.flatMap((p) => (p.pick?.legs ?? []).filter((l) => l.kind !== 'prop').map((l) => l.sportKey)))];
  const scoresBySport = new Map(await Promise.all(gameSports.map(async (s) => [s, await scoreEventsFor(s)])));
  deps.scoreEventFor = (leg) => (scoresBySport.get(leg.sportKey) ?? []).find((e) => e.id === leg.eventId);

  let graded = false;
  for (const record of plays) {
    if (await gradeLadderPlay(env, ctx, now, record, deps)) graded = true;
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
    legBand: { min: LADDER_LEG_MIN_AMERICAN, max: LADDER_LEG_MAX_AMERICAN },
    legs: { min: LADDER_MIN_LEGS, max: LADDER_MAX_LEGS },
    comfortRatio: LADDER_COMFORT_RATIO,
    rates: { season: LADDER_MIN_SEASON_RATE, l5: LADDER_MIN_L5_RATE },
    sport: 'NFL, NBA and NHL player props',
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
