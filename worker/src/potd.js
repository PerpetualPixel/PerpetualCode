/**
 * Play of the Day — one editorially-selected pick, posted once daily, the
 * same for every user that day.
 *
 * Timing: NOT a single 2am batch anymore. Runs hourly, all day (see
 * index.js's scheduled()), accumulating a pool of candidates as each one's
 * own game reaches its own reasonable pre-game lock time (tracking.js's
 * isPickWindowOpen/PICK_LEAD_HOURS) — see updatePotdPool's own comment for
 * why a pool is necessary at all rather than just picking the best
 * currently-lockable candidate: an early game's odds vanish once it
 * starts, long before an evening game's own window has even opened, so
 * "wait and compare the whole day fairly" requires freezing each
 * candidate's data the moment it becomes trustworthy, not re-reading live
 * prices later. POTD_HOUR (2am ET) still matters — it's when the daily
 * learning review digests yesterday's results, which today's locks read.
 *
 * Odds: restricted to POTD_MIN_AMERICAN..POTD_MAX_AMERICAN, a narrower band
 * than the rest of the app's general sharp-price rules (RULES.MIN_AMERICAN/
 * MAX_AMERICAN) — this is a single showcase pick, not a full board, so it's
 * held to a stricter "real moneyline-friendly favorite-to-live-underdog"
 * range with no fallback outside it: a day with nothing in range simply
 * posts nothing rather than reaching for a price outside what was asked for.
 *
 * Tracking: the stored pick carries the same status/clv/result fields
 * worker/src/tracking.js's Top 5 batch tracks its own picks with, graded via
 * the same gradePick() and refreshed by the same hourly CLV/grading cron
 * ticks — so Play of the Day gets a real, gradeable history instead of being
 * write-up-only.
 *
 * Storage: Workers KV, one key per ET calendar date. Once a date's pick is
 * written, nothing overwrites it.
 */

import { analyze, RULES, formatAmerican, suggestedStake, clearsMaxJuice } from '../../docs/engine.js';
import { fetchCapperConsensus, applyCapperConsensus, upgradeToValueStraight } from '../../docs/capper-consensus.js';
import { isPower4Matchup } from '../../docs/ncaaf-conferences.js';
import { buildInsights, insightsByTier, isTennis, isMma } from '../../docs/insights.js';
import { gradePick } from '../../docs/learning.js';
import { fetchContext, hasContext } from './context.js';
import { fetchWeather } from './weather.js';
import { fetchMmaContext } from './mma.js';
import { fetchSport, fetchScores } from './odds.js';
import { getPausedSegments, isSegmentPaused } from './algo-health.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';
import { fetchMmaResults, gradeMmaPickWithFallback } from './ufc-events.js';
import { getOrGenerateAnalysis } from './analysis.js';
import {
  fetchTennisResults,
  gradeTennisPickWithEspn,
  isRegradableTennisVoid,
  isNoOpTennisRegrade,
  regradeTennisVoids,
} from './tennis-espn.js';
import { isPickWindowOpen } from './tracking.js';
import { applyTennisFormSignal } from '../../docs/qualitative.js';
import { loadTennisArchive, loadTennisArchivesFor } from './tennis-archive.js';
import { retractedRecord } from './retraction.js';

const ET_TZ = 'America/New_York';
export const POTD_HOUR = 2; // 2am ET — when the daily learning review runs, not when picks lock anymore
const POTD_MIN_AMERICAN = -200;
const POTD_MAX_AMERICAN = 150;
// Matches docs/learning.js's own FLAT_UNIT_STAKE — duplicated rather than
// imported for the same reason worker/src/tracking.js already duplicates it:
// keeps the browser-only/IndexedDB boundary of that module obvious at a
// glance, rather than importing a constant that sits alongside code this
// Worker never calls.
const FLAT_UNIT_STAKE = 20;
// Matches tracking.js's own KV_TTL_SECONDS — the Tracking Dashboard's Play of
// the Day section (getPotdHistory) needs weeks of history to be meaningful,
// not just the display card's old 8-day window.
const KV_TTL_SECONDS = 86400 * 90;

/** ET calendar date (YYYY-MM-DD) and wall-clock hour for a given instant. */
function etParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  // Intl reports hour 24 for midnight in some environments — normalise to 0.
  const hour = Number(parts.hour) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

/** The ET calendar date N days after the date containing `ms`. */
function etDatePlusDays(ms, days) {
  return etParts(ms + days * 86400000).date;
}

/**
 * Filters out exhibition-format games that happen to carry a real, gradeable
 * price but aren't a real competitive game — an All-Star Game or Pro Bowl
 * has odds priced on it same as anything else, but nobody wants it standing
 * in as "today's pick." The Odds API carries no explicit game-type field to
 * key off, so this reads the only text available: the team names
 * themselves, which for these formats aren't real team names at all (e.g.
 * "Team LeBron", "AFC", "NL All-Stars").
 */
const EXHIBITION_PATTERN = /all[\s-]?star|pro\s?bowl|dunk contest|3-point contest|three-point contest|skills challenge|summer league|rising stars|g league|celebrity|exhibition/i;
// NBA/NHL All-Star Games are draft-captain squads named "Team LeBron" or
// "Team McDavid" rather than a real franchise name — a real team is never
// named "Team <FirstName>", so this catches the actual naming pattern those
// games use in the odds feed, which the keyword list above doesn't.
const CAPTAIN_TEAM_PATTERN = /^team [a-z.'-]+$/i;
function isExhibition(candidate) {
  const names = [candidate.home, candidate.away];
  return names.some((n) => EXHIBITION_PATTERN.test(n) || CAPTAIN_TEAM_PATTERN.test(n));
}

// Matches tracking.js/full-slate-tracking.js's own
// TENNIS_NEXT_DAY_CUTOFF_HOUR. This file previously accepted the ENTIRE next
// calendar day, which is the same "eligible all day tomorrow" bug those two
// files already fixed — it let a completely ordinary tomorrow-afternoon
// match be picked as *today's* Play of the Day. The fix never got ported
// here at the time; this closes that gap.
const TENNIS_NEXT_DAY_CUTOFF_HOUR = 2;

/**
 * A tennis round can still be running just past midnight ET (a night session
 * that started on time but ran long), and the Odds API only ever lists the
 * round that's actually been drawn, so there's no risk of reaching into a
 * future round early. Eligible if it starts today, or before
 * TENNIS_NEXT_DAY_CUTOFF_HOUR tomorrow morning — NOT for an ordinary
 * tomorrow-afternoon start, which belongs on tomorrow's board.
 */
function isEligibleTennisMatch(commenceMs, now) {
  const today = etParts(now).date;
  const commenceDate = etParts(commenceMs).date;
  if (commenceDate === today) return true;
  return commenceDate === etDatePlusDays(now, 1)
    && etParts(commenceMs).hour < TENNIS_NEXT_DAY_CUTOFF_HOUR;
}

/**
 * Whether any of today's real games — checked against the raw event list
 * straight from the odds feed, not the price/exhibition/band-filtered
 * candidate pool — hasn't had its own pick window open yet. Same fix, same
 * reasoning, as tracking.js's own scheduleStillOpen: runPotdDaily used to
 * approximate "have we seen the whole day" as
 * `eligibleToday.some(c => !isPickWindowOpen(c, now))`, checked against a
 * list already narrowed to POTD's own -200..+150 price band. A game whose
 * odds simply hadn't posted yet — routine for tennis, priced close to
 * start far more than other sports — had no candidate at all yet, so it
 * could never register as "still waiting on," letting POTD conclude the
 * day was fully compared and lock a mediocre early pick hours before a
 * genuinely stronger match even had a price.
 *
 * Exhibition and NCAAF Power 4 are both knowable from team names alone, so
 * they're applied here too — an All-Star Game or Group-of-5 buy game can
 * never become eligible regardless of price, so neither should block
 * completeness. A paused-segment exclusion is deliberately NOT applied
 * here, for the same reason as tracking.js's version: it's specific to one
 * (sportKey, marketKey) pair, and a raw event can carry several markets.
 */
function scheduleStillOpen(events, dateKey, now) {
  return events.some((event) => {
    const sportKey = event.sport_key;
    const commenceMs = Date.parse(event.commence_time);
    if (!Number.isFinite(commenceMs)) return false;
    if (EXHIBITION_PATTERN.test(event.home_team) || EXHIBITION_PATTERN.test(event.away_team)) return false;
    if (CAPTAIN_TEAM_PATTERN.test(event.home_team) || CAPTAIN_TEAM_PATTERN.test(event.away_team)) return false;
    if (sportKey === 'americanfootball_ncaaf' && !isPower4Matchup(event.home_team, event.away_team)) return false;
    const eligibleToday = isTennis(sportKey)
      ? isEligibleTennisMatch(commenceMs, now)
      : etParts(commenceMs).date === dateKey;
    if (!eligibleToday) return false;
    return !isPickWindowOpen({ sportKey, commenceMs }, now);
  });
}

/** Reconstruct the same {leg, home/away subject} buildInsights expects. */
function legFromCandidate(c) {
  return {
    sportKey: c.sportKey,
    marketKey: c.marketKey,
    selection: c.selection,
    home: c.home,
    away: c.away,
    eventId: c.eventId,
  };
}

async function researchFor(candidate, env, ctx) {
  const leg = legFromCandidate(candidate);
  try {
    if (isTennis(candidate.sportKey)) {
      const tennisData = await loadTennisArchive(candidate.sportKey);
      return buildInsights(leg, { tennisData });
    }
    if (isMma(candidate.sportKey)) {
      const subject = candidate.selection.replace(/ to win$/i, '').trim();
      const mmaContext = await fetchMmaContext(
        { fighterA: candidate.home, fighterB: candidate.away }, ctx,
      );
      return buildInsights(leg, { mmaContext });
    }
    if (hasContext(candidate.sportKey)) {
      const [context, weather] = await Promise.all([
        fetchContext(
          { sportKey: candidate.sportKey, home: candidate.home, away: candidate.away }, ctx,
        ),
        fetchWeather(
          { sportKey: candidate.sportKey, homeTeam: candidate.home, commenceMs: candidate.commenceMs }, ctx,
        ),
      ]);
      return buildInsights(leg, { context, weather });
    }
  } catch {
    /* Research is a bonus on the write-up, not a blocker for posting it. */
  }
  return [];
}

/**
 * The full breakdown write-up for one candidate. The primary "why" is the
 * AI-written sharp-bettor analysis (`analysis`/`reasons`/`devilsAdvocate`,
 * built by getOrGenerateAnalysis with isPotd: true) — the same prose-plus-
 * bullets treatment the Matchup Analysis panel gives every other pick, not
 * a separate quantitative price case. The book-price comparison table is
 * shown as its own dedicated element (see docs/app.js's renderPotdBooks),
 * so a price case here would just be the same numbers said twice. What's
 * left in `sections` is supporting research, in three named tiers:
 *
 *   1. Primary Personnel & Direct Matchup — the subject's own record, form,
 *      head-to-head, and (MMA) finish tendencies.
 *   2. Supporting Cast & Availability — team-sport roster availability only;
 *      omitted entirely for tennis and MMA, which have no supporting cast to
 *      report on rather than an empty placeholder pretending otherwise.
 *   3. Situational Notes — layoff / retirement-and-walkover flags, the only
 *      "is this record still current" signal this app's sources carry. Not
 *      labelled "Environmental" — there is no weather, travel, or venue data
 *      behind this app at all, and claiming that coverage would be exactly
 *      the kind of invented authority this app's own research module refuses
 *      to produce.
 *
 * Each tier is included only when it actually has content — an empty section
 * with a heading and nothing under it reads as a gap the analysis missed,
 * not as an honest "nothing sourced here."
 */
/**
 * `analysis` is the parsed { analysis, quickTake, devilsAdvocate,
 * victoryMethods? } object from getOrGenerateAnalysis(..., { isPotd: true }),
 * or null when the feature isn't available (no API key, a failed model
 * call, or no research context to ground it in) — Play of the Day still
 * posts on schedule either way, just without the sharp-bettor write-up on
 * top of its existing quantitative sections. `quotes` (every book's own
 * price on this exact line) is carried through from the candidate
 * unchanged so the client can render a real price-comparison table, the
 * same per-book data every other pick card in this app already shows.
 */
function buildWriteup(candidate, research, now, analysis) {
  const headline = `${candidate.selection} (${formatAmerican(candidate.american)})`;
  const matchup = `${candidate.away} @ ${candidate.home}`;

  const personnel = insightsByTier(research, 'personnel');
  const supporting = insightsByTier(research, 'supporting');
  // Environmental (weather, NFL/MLB only) and situational (a layoff or
  // currency flag, tennis/MMA only) are separate tags at the source — they
  // answer different questions — but in practice a given sport only ever
  // populates one of the two, so the write-up presents them under one
  // combined heading rather than two headings where one is nearly always
  // empty. Environmental first: it's about the game itself, before notes
  // about a specific competitor's recent history.
  const environmental = [
    ...insightsByTier(research, 'environmental'),
    ...insightsByTier(research, 'situational'),
  ];

  return {
    headline,
    matchup,
    sportTitle: candidate.sportTitle ?? candidate.sportKey,
    marketLabel: candidate.marketLabel,
    price: formatAmerican(candidate.american),
    american: candidate.american,
    book: candidate.book,
    quotes: candidate.quotes ?? [],
    score: Math.round(candidate.score),
    commenceMs: candidate.commenceMs,
    stake: suggestedStake(candidate),
    analysis: analysis?.analysis ?? null,
    reasons: analysis?.quickTake ?? null,
    devilsAdvocate: analysis?.devilsAdvocate ?? null,
    victoryMethods: analysis?.victoryMethods ?? null,
    sections: [
      ...(personnel.length ? [{ title: 'Primary Personnel & Direct Matchup', bullets: personnel }] : []),
      ...(supporting.length ? [{ title: 'Supporting Cast & Availability', bullets: supporting }] : []),
      ...(environmental.length ? [{ title: 'Environmental & Situational Notes', bullets: environmental }] : []),
    ],
  };
}

async function buildRecord(best, dateKey, now, env, ctx) {
  const research = await researchFor(best, env, ctx);
  // A sharp-bettor-voiced write-up on top of the existing quantitative
  // sections — see buildWriteup's own comment. Never blocks posting: any
  // failure here (no API key, a rate limit, a malformed reply) just leaves
  // analysis null and Play of the Day goes up on schedule regardless,
  // exactly like the same feature already behaves for every other pick.
  let analysis = null;
  try {
    const raw = await getOrGenerateAnalysis(best, env, ctx, now, { isPotd: true });
    if (raw) analysis = JSON.parse(raw);
  } catch (e) {
    // Logged (not just swallowed) so a recurring failure here is
    // diagnosable from the Worker's logs instead of silently posting an
    // analysis-less Play of the Day every day with no trace of why —
    // backfillPotdAnalysis below gets another shot at it on a later tick
    // regardless.
    console.error('POTD analysis generation failed:', e);
    analysis = null;
  }
  const writeup = buildWriteup(best, research, now, analysis);
  return {
    date: dateKey,
    generatedAt: now,
    pick: {
      pickId: best.id,
      dateKey,
      eventId: best.eventId,
      sportKey: best.sportKey,
      marketKey: best.marketKey,
      outcomeName: best.outcomeName,
      point: best.point ?? null,
      selection: best.selection,
      american: best.american,
      decimal: best.decimal,
      score: best.score,
      // Same daily-learning provenance the Top 5 records carry (see
      // tracking.js's pickRecordFrom) — null when no learned weight
      // adjusted this candidate's score before selection.
      rawScore: best.rawScore ?? null,
      learnWeight: best.learnWeight ?? null,
      home: best.home,
      away: best.away,
      commenceMs: best.commenceMs,
      book: best.book,
      consensusProb: best.consensusProb,
      // Play of the Day is a 5-UNIT play (product direction — it and the
      // Prop Play are the two 5U flagship plays; every other tracker stays
      // at the flat 1U).
      suggested_stake: FLAT_UNIT_STAKE * 5,
      status: 'pending',
      clv: { openAmerican: best.american, closeAmerican: best.american, updatedAt: now },
      result: null,
    },
    writeup,
  };
}

/**
 * Snapshots every newly-lockable, qualifying candidate into today's
 * accumulation pool — called every tick with whatever's currently eligible
 * and window-open; only candidates not already in the pool get added, and
 * each one is frozen at capture time (the live odds feed may no longer
 * have it, e.g. once its game starts, by the time the pool is actually
 * used to pick a winner). Nothing is ever removed from the pool — an
 * entry whose game has since started just gets filtered out at selection
 * time (see runPotdDaily), not deleted, so the pool stays a true record of
 * everything that was actually available today.
 */
async function updatePotdPool(env, ctx, dateKey, lockable, now) {
  const poolKey = `potd-pool:${dateKey}`;
  const raw = await env.POTD_KV.get(poolKey);
  const pool = raw ? JSON.parse(raw) : { date: dateKey, entries: [] };
  const known = new Set(pool.entries.map((e) => e.id));
  const fresh = lockable.filter((c) => !known.has(c.id));
  if (!fresh.length) return pool;
  pool.entries.push(...fresh.map((c) => ({ ...c, capturedAt: now })));
  ctx.waitUntil(env.POTD_KV.put(poolKey, JSON.stringify(pool), { expirationTtl: KV_TTL_SECONDS }));
  return pool;
}

/**
 * Runs hourly, all day (see index.js's scheduled()) — not a single 2am
 * batch anymore. Filters today's still-upcoming, non-exhibition, in-band
 * (-200..+150) candidates same as before, but only candidates whose own
 * game has reached its own reasonable pre-game lock time (tracking.js's
 * isPickWindowOpen) get captured into today's pool (see updatePotdPool).
 *
 * The actual winner isn't picked the moment something qualifies — that
 * would bias toward whichever early game happens to clear the bar first,
 * exactly the "might miss a genuinely better evening game" problem a pool
 * exists to avoid. Instead this waits until stillUpcoming goes false (every
 * one of today's eligible games has had its own window open, so the pool
 * is as complete as it's going to get), then picks the best pool entry
 * that's STILL ACTIONABLE — hasn't started yet. An entry that was
 * genuinely the day's best but has since started (this only happens on a
 * day where nothing later ever beat it, and by the time nothing's left to
 * wait for, its own game has already gone) is skipped in favor of the best
 * among what's still postable; it stays visible in the pool's own history
 * either way, just never becomes the actual Play of the Day.
 *
 * Skips (no-op) once today's KV entry already exists — either an earlier
 * tick already locked it, or a retried cron tick fired twice.
 */
export async function runPotdDaily(env, ctx, now = Date.now(), { fetchFullSlate }) {
  const dateKey = etParts(now).date;
  const kvKey = `potd:${dateKey}`;

  const existing = await env.POTD_KV.get(kvKey);
  if (existing) return { skipped: true, reason: 'already generated', dateKey };

  // A segment the weekly algorithm health review has paused (worker/src/
  // algo-health.js, on evidence from Pixel's Picks' own graded history)
  // shouldn't be able to become the single Play of the Day pick either —
  // benching it for one surface but not the other would be inconsistent.
  // The daily learning review's reliability weights apply here for the same
  // reason: the day's single highest-conviction pick shouldn't come from a
  // segment the evidence says has been misfiring when a nearly-as-good
  // candidate from a reliable one exists.
  //
  // The recent-POTD reads guard against the same reschedule re-pick hole
  // tracking.js/full-slate-tracking.js close with their
  // EVENT_DEDUPE_LOOKBACK_DAYS manifests: this function's own idempotency
  // is per-date (`potd:${dateKey}` exists -> skip), so a match featured
  // YESTERDAY whose start time then moved to today would read as a fresh,
  // eligible candidate and could be featured a second day running —
  // possibly on the opposite side, exactly the confirmed Full Slate
  // incident. Two KV gets closes it.
  const [pausedSegments, learningProfile, ...recentPotdRaws] = await Promise.all([
    getPausedSegments(env),
    getLearningProfile(env),
    env.POTD_KV.get(`potd:${etDatePlusDays(now, -1)}`),
    env.POTD_KV.get(`potd:${etDatePlusDays(now, -2)}`),
  ]);
  const recentPotdEventIds = new Set(
    recentPotdRaws.filter(Boolean).map((raw) => JSON.parse(raw)?.pick?.eventId).filter(Boolean),
  );

  const events = await fetchFullSlate();
  // Tennis form gate (docs/qualitative.js): re-score tennis candidates with
  // their recent-form/head-to-head signal and drop unsupported straight-
  // moneyline underdogs — same gate the Top 5 and Full Slate batches apply,
  // in the same order (form first, then the learning multiplier scales the
  // form-adjusted grade).
  const analyzed = analyze(events, { now });
  const candidates = applyLearningToCandidates(
    applyTennisFormSignal(analyzed, await loadTennisArchivesFor(analyzed), { now }),
    learningProfile,
  );
  const eligibleToday = candidates.filter((c) => {
    if (c.score < RULES.MIN_SCORE) return false;
    if (isExhibition(c)) return false;
    if (c.american < POTD_MIN_AMERICAN || c.american > POTD_MAX_AMERICAN) return false;
    // Low-variance markets (player props, MLS's BTTS/double-chance) get
    // their own tighter price ceiling on top of POTD's own band — see
    // docs/engine.js's LOW_VARIANCE_MAX_AMERICAN.
    if (!clearsMaxJuice(c)) return false;
    // NCAAF: only Power 4 vs. Power 4 matchups — see docs/ncaaf-conferences.js
    // and tracking.js's own identical filter for the full reasoning.
    if (c.sportKey === 'americanfootball_ncaaf' && !isPower4Matchup(c.home, c.away)) return false;
    if (c.commenceMs <= now) return false;
    if (isSegmentPaused(c, pausedSegments)) return false;
    // A match already featured as a recent day's POTD can't be featured
    // again — see the recentPotdEventIds comment above.
    if (recentPotdEventIds.has(c.eventId)) return false;
    if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
    return etParts(c.commenceMs).date === dateKey;
  });

  // stillUpcoming is checked against the raw event list (scheduleStillOpen),
  // not this price/band-filtered eligibleToday — see that function's own
  // comment for why.
  const lockable = eligibleToday.filter((c) => isPickWindowOpen(c, now));
  const stillUpcoming = scheduleStillOpen(events, dateKey, now);
  await updatePotdPool(env, ctx, dateKey, lockable, now);

  if (stillUpcoming) {
    return { skipped: true, reason: "still comparing today's games", dateKey };
  }

  const poolRaw = await env.POTD_KV.get(`potd-pool:${dateKey}`);
  const pool = poolRaw ? JSON.parse(poolRaw).entries : [];
  // recentPotdEventIds re-applied here because pool entries persist across
  // ticks — an entry could have been added before the excluded match's
  // reschedule became visible (or before this guard existed at all).
  const stillActionable = pool.filter((c) => c.commenceMs > now && !recentPotdEventIds.has(c.eventId));
  if (!stillActionable.length) {
    return { skipped: true, reason: 'no qualifying candidate remained actionable today', dateKey };
  }

  // MMA candidates get the MMA_Engine capper-consensus swing (docs/
  // capper-consensus.js) before the day's single winner is drawn — the same
  // enrichment Pixel's Picks' own batch applies (worker/src/tracking.js), so
  // a consensus-backed fight competes for Play of the Day on the same
  // adjusted grade it carries everywhere else, still subject to every date/
  // band/segment filter above. Fetch failure degrades to the unadjusted
  // pool: consensus is a bonus, never a dependency.
  const consensusFeed = await fetchCapperConsensus(undefined, { force: true }).catch(() => null);
  const drawPool = consensusFeed
    ? applyCapperConsensus(stillActionable, consensusFeed, { now })
    : stillActionable;

  const chosen = drawPool.reduce((a, b) => (b.score > a.score ? b : a));
  // An MMA winner runs as its best-value play (possibly a capper-priced
  // straight) rather than a moneyline too heavy to pay — same swap the Full
  // Slate lock applies, so the two boards never disagree about a fight.
  const best = consensusFeed ? upgradeToValueStraight(chosen, consensusFeed) : chosen;
  const record = await buildRecord(best, dateKey, now, env, ctx);
  // A day's pick, once posted, doesn't move even if the market does — it's
  // an editorial call made at a point in time, not a live-repriced candidate.
  await env.POTD_KV.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { skipped: false, dateKey, pick: record.pick };
}

/**
 * Refresh today's closing-line snapshot while the pick is still pending and
 * hasn't started — same "freshest price seen before the game goes off the
 * board" approximation worker/src/tracking.js's runClvSnapshot uses for the
 * Top 5, just for the single Play of the Day record instead of a manifest of
 * several.
 */
export async function runPotdClvSnapshot(env, ctx, now = Date.now(), { fetchSportFn = (s) => fetchSport(s, env, ctx) } = {}) {
  const dateKey = etParts(now).date;
  const raw = await env.POTD_KV.get(`potd:${dateKey}`);
  if (!raw) return { updated: false };

  const record = JSON.parse(raw);
  const { pick } = record;
  if (pick.status !== 'pending' || pick.commenceMs <= now) return { updated: false };

  const { events } = await fetchSportFn(pick.sportKey);
  const fresh = analyze(events ?? [], { now }).find((c) => c.id === pick.pickId);
  if (!fresh || fresh.american === pick.clv.closeAmerican) return { updated: false };

  pick.clv = { ...pick.clv, closeAmerican: fresh.american, updatedAt: now };
  await env.POTD_KV.put(`potd:${dateKey}`, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { updated: true };
}

/**
 * Retries today's AI write-up if it's still missing — runPotdDaily itself is
 * a strict one-shot (posts the pick once, then `if (existing) return` skips
 * every later tick for the rest of the day — see its own comment), so
 * unlike Top5/Full Slate's self-healing top-up, a transient failure on that
 * one attempt (a rate limit, a slow reply racing the cron invocation's own
 * time budget, anything — buildRecord's own comment covers why this is
 * never allowed to block posting the pick itself) used to leave the day's
 * single showcase pick without a write-up for the rest of the day, with no
 * way to recover. Called on every scheduled tick (see index.js's
 * scheduled()) — cheap to no-op (one KV get) once a write-up exists, so
 * running it far more often than it'll ever actually need to do work is
 * fine.
 */
export async function backfillPotdAnalysis(env, ctx, now = Date.now()) {
  const dateKey = etParts(now).date;
  const kvKey = `potd:${dateKey}`;
  const raw = await env.POTD_KV.get(kvKey);
  if (!raw) return { attempted: false };

  const record = JSON.parse(raw);
  if (record.writeup?.analysis) return { attempted: false };

  const candidate = {
    eventId: record.pick.eventId,
    sportKey: record.pick.sportKey,
    sportTitle: record.writeup?.sportTitle,
    home: record.pick.home,
    away: record.pick.away,
    outcomeName: record.pick.outcomeName,
  };

  let analysis = null;
  try {
    const raw2 = await getOrGenerateAnalysis(candidate, env, ctx, now, { isPotd: true });
    if (raw2) analysis = JSON.parse(raw2);
  } catch (e) {
    console.error('POTD analysis backfill failed:', e);
    return { attempted: true, succeeded: false };
  }
  if (!analysis) return { attempted: true, succeeded: false };

  record.writeup.analysis = analysis.analysis ?? null;
  record.writeup.reasons = analysis.quickTake ?? null;
  record.writeup.devilsAdvocate = analysis.devilsAdvocate ?? null;
  record.writeup.victoryMethods = analysis.victoryMethods ?? null;
  await env.POTD_KV.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { attempted: true, succeeded: true };
}

/** Grades one dateKey's POTD record if it exists and is still pending — the
 * per-day worker runPotdGrading below calls once per day in its lookback
 * window. Returns false without touching anything for a missing/already-
 * graded/still-pending-with-no-result record, same idempotent shape as
 * every other grading pass here. */
async function gradePotdForDate(env, ctx, now, dateKey, pick, record, fetchScoresFn, fetchMmaResultsFn, fetchTennisResultsFn) {
  const { events } = await fetchScoresFn(pick.sportKey);
  const scoreEvent = (events ?? []).find((e) => e.id === pick.eventId);
  let outcome;
  if (isMma(pick.sportKey)) {
    outcome = gradeMmaPickWithFallback(pick, scoreEvent, await fetchMmaResultsFn());
  } else if (isTennis(pick.sportKey)) {
    // ESPN's scoreboard, not the odds feed, is what settles tennis at all —
    // see worker/src/tennis-espn.js.
    outcome = await gradeTennisPickWithEspn(pick, scoreEvent, await fetchTennisResultsFn(), env, ctx, now);
  } else {
    outcome = gradePick(pick, scoreEvent);
  }
  if (!outcome) return false;
  if (isNoOpTennisRegrade(pick, outcome)) return false;

  pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
  pick.result = {
    payout: outcome.payout,
    roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
    voidReason: outcome.void ? outcome.reason : undefined,
    // Same settlement-time display detail as tracking.js's runGrading.
    detail: outcome.detail ?? undefined,
  };
  await env.POTD_KV.put(`potd:${dateKey}`, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return true;
}

// Same reasoning as tracking.js's own GRADING_LOOKBACK_DAYS: a late-night
// pick's game can still be pending after the ET date has already rolled
// over to tomorrow, and this used to only ever check today's `potd:` key —
// once the date rolled, last night's still-pending pick was never looked at
// again by any future tick.
const GRADING_LOOKBACK_DAYS = 2;

/**
 * Grade whichever of the last GRADING_LOOKBACK_DAYS days' Play of the Day
 * picks is still pending, via the exact same gradePick() the client's own
 * "Check Results" button and the Top 5 batch's runGrading both use. Runs
 * every tick, same reasoning as the Top 5 batch's own grading pass —
 * idempotent, since it only ever touches a still-pending pick. When a
 * pending pick is MMA, also falls back to ESPN's scoreboard (see
 * worker/src/ufc-events.js's gradeMmaPickWithFallback) the same way Full
 * Slate and Pixel's Picks grading do, for the same reason: the Odds API's
 * /scores routinely lags real MMA results by hours.
 */
export async function runPotdGrading(env, ctx, now = Date.now(), {
  fetchScoresFn = (s) => fetchScores(s, env, ctx),
  fetchMmaResultsFn = () => fetchMmaResults(ctx, now),
  fetchTennisResultsFn = () => fetchTennisResults(ctx, now),
  lookbackDays = GRADING_LOOKBACK_DAYS,
} = {}) {
  const dateKeys = [...new Set(
    Array.from({ length: lookbackDays }, (_, i) => etDatePlusDays(now, -i)),
  )];

  let graded = false;
  for (const dateKey of dateKeys) {
    const raw = await env.POTD_KV.get(`potd:${dateKey}`);
    if (!raw) continue;
    const record = JSON.parse(raw);
    // A tennis spread/total voided only for want of a games score is
    // reconsidered too — see worker/src/tennis-espn.js's isRegradableTennisVoid.
    if (record.pick.status !== 'pending' && !isRegradableTennisVoid(record.pick)) continue;
    if (await gradePotdForDate(env, ctx, now, dateKey, record.pick, record, fetchScoresFn, fetchMmaResultsFn, fetchTennisResultsFn)) {
      graded = true;
    }
  }
  return { graded };
}

/** Today's Play of the Day, or yesterday's as a labelled fallback if today's
 * hasn't been generated yet (e.g. it's 1am ET and the cron hasn't fired). */
export async function getPotd(env, now = Date.now()) {
  const today = etParts(now).date;
  const todayRaw = await env.POTD_KV.get(`potd:${today}`);
  if (todayRaw) return JSON.parse(todayRaw);

  const yesterday = etDatePlusDays(now, -1);
  const yesterdayRaw = await env.POTD_KV.get(`potd:${yesterday}`);
  if (yesterdayRaw) return { ...JSON.parse(yesterdayRaw), stale: true };

  return null;
}

/**
 * "Which way the app is leaning" for today's Play of the Day before it's
 * locked — computed entirely from today's pool (see updatePotdPool), so
 * this is a cheap KV read plus local comparison, never a live Odds-API
 * fetch or a model call: no write-up is generated for a lean, since that's
 * real cost worth spending once on the actual final pick, not on every
 * page load of a preview that might still change before it locks. Returns
 * null once today's pick is already locked (nothing left to lean on) or
 * before anything's entered the pool yet.
 */
export async function getPotdLeaning(env, now = Date.now()) {
  const dateKey = etParts(now).date;
  const existing = await env.POTD_KV.get(`potd:${dateKey}`);
  if (existing) return null;

  const poolRaw = await env.POTD_KV.get(`potd-pool:${dateKey}`);
  const pool = poolRaw ? JSON.parse(poolRaw).entries : [];
  const stillActionable = pool.filter((c) => c.commenceMs > now);
  if (!stillActionable.length) return null;

  const best = stillActionable.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    pickId: best.id,
    dateKey,
    eventId: best.eventId,
    sportKey: best.sportKey,
    sportTitle: best.sportTitle,
    marketKey: best.marketKey,
    outcomeName: best.outcomeName,
    point: best.point ?? null,
    selection: best.selection,
    american: best.american,
    decimal: best.decimal,
    score: best.score,
    home: best.home,
    away: best.away,
    commenceMs: best.commenceMs,
    book: best.book,
    consensusProb: best.consensusProb,
  };
}

/**
 * Every Play of the Day pick still in KV (bounded by KV_TTL_SECONDS — 90
 * days), one per day it was generated, for the Tracking Dashboard's Play of
 * the Day section. Returns the `.pick` tracking objects
 * directly — they already carry the same {dateKey, away, home, selection,
 * status, result, suggested_stake, clv} shape the client's existing Top 5
 * history renderer (groupTop5ByDay/renderTop5DayBlock/top5ClvPct) expects,
 * so that rendering is reused unchanged rather than duplicated.
 */
export async function getPotdHistory(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(etParts(now - i * 86400000).date);
  }
  // Retracted days are read alongside live ones (see retractPotd): a pulled
  // Play of the Day still belongs in the history, settled as a void, rather
  // than vanishing and leaving the day looking like one nothing was picked.
  const [raw, retractedRaw] = await Promise.all([
    Promise.all(dateKeys.map((d) => env.POTD_KV.get(`potd:${d}`))),
    Promise.all(dateKeys.map((d) => env.POTD_KV.get(`potd-retracted:${d}`))),
  ]);
  const records = [
    ...raw.filter(Boolean).map((r) => JSON.parse(r)),
    // One day can hold several retractions — a pick pulled, regenerated,
    // and pulled again — so this key stores an array, not a single record.
    ...retractedRaw.filter(Boolean).flatMap((r) => JSON.parse(r)),
  ];
  return records
    .map((r) => r.pick)
    // A record written by the old two-phase/per-sport system has no `status`
    // (it was write-up-only, never tracked) — skip it rather than surfacing
    // an untracked pick the summary/day-block math can't make sense of.
    .filter((pick) => pick && pick.status != null);
}

/**
 * Retracts a day's Play of the Day when its pick matches, voiding it and
 * clearing the slot so runPotdDaily picks the day again on its next tick.
 *
 * Unlike the two multi-pick trackers, this one's idempotency is the mere
 * EXISTENCE of `potd:<date>` ("already generated -> skip"), so the live key
 * has to be deleted outright for the day to be re-picked at all — which is
 * exactly why the record can't simply be voided in place. It's appended to
 * `potd-retracted:<date>` instead (an array, since a day can be pulled more
 * than once), where getPotdHistory above reads it back.
 */
export async function retractPotd(env, { now = Date.now(), dateKey, match, reason }) {
  const day = dateKey ?? etParts(now).date;
  const raw = await env.POTD_KV.get(`potd:${day}`);
  if (!raw) return { dateKey: day, retracted: 0, picks: [] };

  const record = JSON.parse(raw);
  if (!record.pick || !match(record.pick)) return { dateKey: day, retracted: 0, picks: [] };

  const pulled = { ...record, pick: retractedRecord(record.pick, { reason, at: now }) };
  const priorRaw = await env.POTD_KV.get(`potd-retracted:${day}`);
  const prior = priorRaw ? JSON.parse(priorRaw) : [];

  await env.POTD_KV.put(`potd-retracted:${day}`, JSON.stringify([...prior, pulled]), {
    expirationTtl: KV_TTL_SECONDS,
  });
  await env.POTD_KV.delete(`potd:${day}`);

  return { dateKey: day, retracted: 1, picks: [pulled.pick] };
}

/**
 * Play of the Day counterpart to the other two trackers' tennis backfill.
 *
 * No read budget here: this is one KV record per day, not a manifest plus a
 * pick per game, so even the full 90-day window is 90 reads — an order of
 * magnitude under the ceiling the multi-pick trackers have to respect.
 *
 * A retracted day is deliberately left alone: those live under their own
 * key and a retraction is meant to stay pulled (see worker/src/retraction.js).
 */
export async function regradePotdTennisVoids(env, ctx, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = [];
  for (let i = 0; i < days; i++) dateKeys.push(etParts(now - i * 86400000).date);

  const raw = await Promise.all(dateKeys.map((d) => env.POTD_KV.get(`potd:${d}`)));
  const records = [];
  raw.forEach((r, i) => {
    if (!r) return;
    try {
      const record = JSON.parse(r);
      if (record?.pick && isRegradableTennisVoid(record.pick)) {
        records.push({ dateKey: dateKeys[i], record });
      }
    } catch { /* an unparseable day is left exactly as it is */ }
  });

  const changed = await regradeTennisVoids(records.map((r) => r.record.pick), env, ctx, now);
  const changedIds = new Set(changed.map((p) => p.pickId));
  const toWrite = records.filter((r) => changedIds.has(r.record.pick.pickId));

  await Promise.all(toWrite.map(({ dateKey, record }) => env.POTD_KV.put(
    `potd:${dateKey}`,
    JSON.stringify(record),
    { expirationTtl: KV_TTL_SECONDS },
  )));

  return { found: records.length, regraded: toWrite.length };
}
