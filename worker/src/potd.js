/**
 * Play of the Day — one editorially-selected play, posted once daily, the
 * same for every user that day. Since 2026-10-05 that play is the day's
 * best ANCHOR + PARTNER TICKET (docs/tickets.js): a safe leg — an NFL
 * alternate-line player prop far below the player's normal output, or a
 * side the market reads at 72% or better — paired with a favourite-side
 * partner from a different game, -200 to +100 together, from NFL, NCAA
 * football, MMA and tennis. Pixel's Picks are the next five such tickets.
 *
 * Timing: one draw at the generation hour (tracking.js's
 * GENERATION_HOUR_ET, 2am ET), immediately after the daily learning review
 * and BEFORE the Pixel's Picks batch — per explicit product direction
 * (2026-08-21 reset), the Play of the Day is the slate's #1 pick, and
 * Pixel's Picks are the next 5, drawn afterward with this pick's game
 * excluded. The old accumulate-a-pool-through-the-day flow (each game
 * captured as its own lock window opened, drawn only once nothing was left
 * to wait for) is gone with the rest of the progressive-locking machinery.
 *
 * Odds: restricted to POTD_MIN_AMERICAN..POTD_MAX_AMERICAN, a narrower band
 * than the rest of the app's general sharp-price rules — this is a single
 * showcase pick, held to a stricter range. A day with nothing in range
 * still posts where it can: the pick falls back in visible, flagged tiers
 * (confidence floor first, then the band). The one thing NO tier relaxes is
 * the edge floor (algo-health's MIN_EV_PCT / MIN_KELLY_FRACTION, the same
 * bar Pixel's Picks holds): until 2026-09-15 this board had no EV
 * requirement at all — a pick only had to clear the composite score, which
 * a zero-EV bet with clean numbers did comfortably — and the flagship of
 * the day was routinely a bet the engine's own numbers graded as a loser.
 * A day where nothing clears the edge floor posts NO Play of the Day, with
 * the reason written to KV (`potd:hold:<date>`) so the card can say why.
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

import { analyze, RULES, formatAmerican, suggestedStake, clearsMaxJuice, isNflPreseason, UNIT_DOLLARS, STAKE_BANDS, stakeUnitsForScore } from '../../docs/engine.js';
import { buildTickets, legEligible, isTicketSport, TICKET_BAND } from '../../docs/tickets.js';
import { fetchCapperConsensus, applyCapperConsensus } from '../../docs/capper-consensus.js';
import { collectNflPropLegs, NFL_SPORT_KEY } from './football-props.js';
import { gradeTicket, legsOf, nflStatsReader } from './ticket-grading.js';
import { isPower4Matchup } from '../../docs/ncaaf-conferences.js';

// What the Play of the Day counts as a favourite worth showcasing: a side
// actually laying juice. A pick'em or a dog can grade well on price cleanliness
// and still isn't the bet to lead the day with.
export const POTD_FAVOURITE_MAX_AMERICAN = -110;

/**
 * The day's pick: the best-scoring genuine FAVOURITE, falling back to the
 * best-scoring candidate of any price when the slate offers no favourite at
 * all (the board runs every day).
 *
 * Exported and pure so the rule is testable on its own. It used to be a bare
 * max-by-score over the whole pool, and score is "how clean is this number",
 * NOT "how likely is this to win" — it blends liquidity, book agreement,
 * line-shopping gain and freshness. A tidily priced underdog could therefore
 * be the day's single most-confident pick while being the least likely to
 * land, which is a structural reason for the showcase pick to lose regardless
 * of sample size.
 */
export function chooseShowcasePick(pool, maxAmerican = POTD_FAVOURITE_MAX_AMERICAN) {
  if (!pool?.length) return null;
  const favourites = pool.filter((c) => c.american <= maxAmerican);
  return (favourites.length ? favourites : pool).reduce((a, b) => (b.score > a.score ? b : a));
}
import { buildInsights, insightsByTier, isTennis, isMma } from '../../docs/insights.js';
import { gradePick } from '../../docs/learning.js';
import { fetchContext, hasContext } from './context.js';
import { fetchWeather } from './weather.js';
import { fetchMmaContext } from './mma.js';
import { fetchSport, fetchScores } from './odds.js';
import { getAlgoConfig, getPausedSegments, isSegmentPaused } from './algo-health.js';
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
import { GENERATION_HOUR_ET, pickRecordFrom } from './tracking.js';
import { applyTennisFormSignal } from '../../docs/qualitative.js';
import { loadTeamContextsFor, applyTeamFormSignal } from './team-form.js';
import { fetchGridironFeed } from '../../docs/gridiron.js';
import { getNflEfficiency } from './nfl-efficiency.js';
import { loadTennisArchive, loadTennisArchivesFor } from './tennis-archive.js';
import { retractedRecord } from './retraction.js';

const ET_TZ = 'America/New_York';
export const POTD_HOUR = 2; // 2am ET — the daily learning review and the day's single draw (see header)
const POTD_MIN_AMERICAN = -200;
const POTD_MAX_AMERICAN = 150;
/* Stake dollars come from docs/engine.js's UNIT_DOLLARS ($25/1U) — the
   flat 5U x $20 this file used to hardcode is replaced by the
   confidence-scaled 3-5U band in buildRecord (2026-08-21 direction). */
// Matches tracking.js's own KV_TTL_SECONDS — the Tracking Dashboard's Play of
// the Day section (getPotdHistory) needs weeks of history to be meaningful,
// not just the display card's old 8-day window.
const KV_TTL_SECONDS = 86400 * 90;
/**
 * Why today has no Play of the Day, when it doesn't — written by
 * runPotdDaily on a day nothing clears the edge floor, read by getPotdHold
 * for the /potd route. Mirrors the ladder's own `ladder:status:<date>`: an
 * empty card that can say "no edge today" is a different thing from one
 * that can't say whether the draw simply hasn't run.
 */
const holdKey = (dateKey) => `potd:hold:${dateKey}`;

/** ET calendar date (YYYY-MM-DD) and wall-clock hour for a given instant. */
export function etParts(ms) {
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
export function etDatePlusDays(ms, days) {
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
export function isExhibition(candidate) {
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
export function isEligibleTennisMatch(commenceMs, now) {
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
export function scheduleStillOpen(events, dateKey, now) {
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
/** One line on why a leg is on the ticket — measured numbers only. */
function legNote(leg) {
  if (leg.kind === 'prop' && leg.profile) {
    const p = leg.profile;
    return `${leg.playerName} has cleared ${leg.need}+ in ${Math.round(p.season * 100)}% of ${p.games} games this season `
      + `and ${Math.round(p.l5 * 100)}% of the last five, averaging ${p.avgSeason} (${p.avgL5} over the last five) — `
      + `the line sits well below normal output.`;
  }
  return `The market reads this side at ${Math.round(leg.consensusProb * 100)}%; `
    + `${formatAmerican(leg.american)} at ${leg.book} beats the no-vig consensus by ${(leg.ev * 100).toFixed(1)}% EV.`;
}

/**
 * The write-up for a ticket. `candidate` is the FEATURE leg — the game-
 * market leg when the ticket has one, else the anchor — whose game the
 * research and the sharp analysis are about; `ticket` carries both legs
 * and the combined price the card leads with.
 */
function buildWriteup(ticket, candidate, research, now, analysis) {
  const legs = ticket.legs;
  const headline = `${legs.map((l) => l.selection).join(' + ')} (${formatAmerican(ticket.american)})`;
  const matchup = legs.map((l) => `${l.away} @ ${l.home}`).join(' · ');

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
    // The two legs, in the order the ticket holds them (anchor first), with
    // everything the card shows per leg.
    legs: legs.map((l) => ({
      kind: l.kind ?? 'game',
      selection: l.selection,
      price: formatAmerican(l.american),
      american: l.american,
      book: l.book,
      matchup: `${l.away} @ ${l.home}`,
      home: l.home,
      away: l.away,
      sportTitle: l.sportTitle ?? l.sportKey,
      marketKey: l.marketKey,
      marketLabel: l.marketLabel,
      commenceMs: l.commenceMs,
      note: legNote(l),
    })),
    pairReason: ticket.pairReason ?? null,
    sportTitle: [...new Set(legs.map((l) => l.sportTitle ?? l.sportKey))].join(' + '),
    marketLabel: '2-leg ticket',
    price: formatAmerican(ticket.american),
    american: ticket.american,
    book: [...new Set(legs.map((l) => l.book))].join(' / '),
    quotes: candidate.quotes ?? [],
    score: Math.round(ticket.score),
    commenceMs: Math.min(...legs.map((l) => l.commenceMs)),
    stake: suggestedStake({ consensusProb: ticket.prob, decimal: ticket.decimal }),
    // The algorithm's own sizing for this play, in units — rendered on the
    // card itself (renderPotdConfidence). Same value stored on pick.stakeUnits.
    stakeUnits: stakeUnitsForScore(ticket.score, STAKE_BANDS.potd),
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

async function buildRecord(ticket, dateKey, now, env, ctx) {
  // The research and the sharp write-up are about ONE game: the ticket's
  // game-market leg when it has one (a prop leg's game has no side to argue
  // for), else the anchor's game.
  const feature = ticket.legs.find((l) => l.kind !== 'prop') ?? ticket.legs[0];
  const research = feature.kind === 'prop' ? [] : await researchFor(feature, env, ctx);
  // A sharp-bettor-voiced write-up on top of the existing quantitative
  // sections — see buildWriteup's own comment. Never blocks posting: any
  // failure here (no API key, a rate limit, a malformed reply) just leaves
  // analysis null and Play of the Day goes up on schedule regardless,
  // exactly like the same feature already behaves for every other pick.
  let analysis = null;
  if (feature.kind !== 'prop') {
    try {
      const raw = await getOrGenerateAnalysis(feature, env, ctx, now, { isPotd: true });
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
  }
  const writeup = buildWriteup(ticket, feature, research, now, analysis);
  // The same ticket record Pixel's Picks store (worker/src/tracking.js's
  // pickRecordFrom) — type 'combo', both legs, the combined price, the joint
  // probability as consensusProb, no CLV (a ticket spans two markets) — so
  // every dashboard helper reads a Play of the Day exactly as it reads a
  // Pixel's Pick. Only the sizing differs: the flagship's own unit band.
  const units = stakeUnitsForScore(ticket.score, STAKE_BANDS.potd);
  const pick = pickRecordFrom(ticket, dateKey, now, units);
  return { date: dateKey, generatedAt: now, pick, writeup };
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
export async function runPotdDaily(env, ctx, now = Date.now(), {
  fetchFullSlate,
  // NFL alternate-line prop legs (worker/src/football-props.js); injectable
  // for the tests, same as fetchFullSlate.
  fetchPropLegs = (games) => collectNflPropLegs(games, env, ctx, now),
} = {}) {
  const { date: dateKey, hour } = etParts(now);
  // One draw for the whole day, at the generation hour, per explicit
  // product direction (2026-08-21 reset): the Play of the Day is the
  // slate's #1 pick and is decided FIRST — index.js awaits this before the
  // Pixel's Picks batch, which then excludes this pick's game — so the
  // day's boards form one ranking rather than three independent draws.
  // Before that hour, yesterday's pick is simply still the pick.
  if (hour < GENERATION_HOUR_ET) {
    return { skipped: true, reason: 'before generation hour', dateKey };
  }
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
  const [pausedSegments, learningProfile, algoConfig, ...recentPotdRaws] = await Promise.all([
    getPausedSegments(env),
    getLearningProfile(env),
    // The same EV/Kelly floor Pixel's Picks reads (worker/src/algo-health.js)
    // — tightened by the weekly review, never loosened below RULES.
    getAlgoConfig(env),
    env.POTD_KV.get(`potd:${etDatePlusDays(now, -1)}`),
    env.POTD_KV.get(`potd:${etDatePlusDays(now, -2)}`),
  ]);
  // The one bar no fallback tier below relaxes — see the file header.
  // ...and a price the reader can take (buildCandidates' `bettable`): a
  // Play of the Day at 1xBet or Pinnacle is a number, not a bet, and in the
  // record those went 12-13 for -24%.
  const clearsEdge = (c) => c.bettable !== false
    && c.ev > algoConfig.MIN_EV_PCT
    && suggestedStake(c) >= algoConfig.MIN_KELLY_FRACTION;
  // Every game a recent ticket touched, both legs.
  const recentPotdEventIds = new Set(
    recentPotdRaws.filter(Boolean).flatMap((raw) => legsOf(JSON.parse(raw)?.pick ?? null).map((l) => l?.eventId)).filter(Boolean),
  );

  const events = await fetchFullSlate();
  // Tennis form gate (docs/qualitative.js): re-score tennis candidates with
  // their recent-form/head-to-head signal and drop unsupported straight-
  // moneyline underdogs — same gate the Top 5 and Full Slate batches apply,
  // in the same order (form first, then the learning multiplier scales the
  // form-adjusted grade).
  // Team sports get their own form/injury gate (worker/src/team-form.js)
  // alongside the tennis one, in the same position for the same reason.
  const analyzed = analyze(events, { now });
  const candidates = applyLearningToCandidates(
    applyTeamFormSignal(
      applyTennisFormSignal(analyzed, await loadTennisArchivesFor(analyzed), { now }),
      await loadTeamContextsFor(analyzed, ctx, { now }),
      { now, nflEfficiency: await getNflEfficiency(env),
        gridironFeed: await fetchGridironFeed(undefined, { force: true }).catch(() => null) },
    ),
    learningProfile,
  );
  // The checks about the GAME's legitimacy, before any pricing: a ticket
  // sport, today's date (tennis keeps its next-day carve-out), not an
  // exhibition, not NFL preseason, Power 4 only for NCAAF, not a segment the
  // health review paused, not a game a recent Play of the Day already
  // featured, and not started.
  const structurallySound = candidates.filter((c) => {
    if (!isTicketSport(c.sportKey)) return false;
    if (isExhibition(c)) return false;
    if (!clearsMaxJuice(c)) return false;
    if (isNflPreseason(c)) return false;
    if (c.sportKey === 'americanfootball_ncaaf' && !isPower4Matchup(c.home, c.away)) return false;
    if (c.commenceMs <= now) return false;
    if (isSegmentPaused(c, pausedSegments)) return false;
    if (recentPotdEventIds.has(c.eventId)) return false;
    if (isTennis(c.sportKey)) return isEligibleTennisMatch(c.commenceMs, now);
    return etParts(c.commenceMs).date === dateKey;
  });

  // MMA candidates get the MMA_Engine capper-consensus swing (docs/
  // capper-consensus.js) before the day's ticket is built — the same
  // enrichment Pixel's Picks' own batch applies (worker/src/tracking.js), so
  // a consensus-backed fight competes for Play of the Day on the same
  // adjusted grade it carries everywhere else. Fetch failure degrades to
  // the unadjusted pool: consensus is a bonus, never a dependency.
  const consensusFeed = await fetchCapperConsensus(undefined, { force: true }).catch(() => null);
  const drawPool = consensusFeed
    ? applyCapperConsensus(structurallySound, consensusFeed, { now })
    : structurallySound;

  // The leg pool (docs/tickets.js): game-market legs clearing the board's
  // bars — bettable, the edge and Kelly floors, the conviction floor, a
  // favourite-side read — plus NFL alternate-line props whose game-log hit
  // rate clears the prop gates. A failed prop scan degrades to game legs
  // alone; props widen the anchor supply, they are not a dependency.
  const gameLegs = drawPool.filter((c) => legEligible(c, {
    minEv: algoConfig.MIN_EV_PCT,
    minKelly: algoConfig.MIN_KELLY_FRACTION,
    minScore: RULES.MIN_SCORE,
  }));
  let propLegs = [];
  try {
    const nflGames = events.filter((e) => e.sport_key === NFL_SPORT_KEY
      && etParts(new Date(e.commence_time).getTime()).date === dateKey
      && !recentPotdEventIds.has(e.id));
    propLegs = (await fetchPropLegs(nflGames)) ?? [];
  } catch (e) {
    console.error('Play of the Day prop legs failed:', e);
  }

  // The day's single best ticket: the pair whose combined price most
  // underrates the chance both legs land. Nothing below this relaxes — a
  // ticket that doesn't clear the band, the joint-probability floor and the
  // edge floor is not posted, and the hold says why.
  const [ticket] = buildTickets([...gameLegs, ...propLegs], {
    count: 1,
    usedEventIds: recentPotdEventIds,
    minAmerican: TICKET_BAND.MIN_AMERICAN,
    maxAmerican: TICKET_BAND.MAX_AMERICAN,
    minEv: algoConfig.MIN_EV_PCT,
  });
  if (!ticket) {
    // Either an off day with no gradeable game at all, a slate priced
    // efficiently enough that no leg beats the market by the floor, or
    // legs that never pair inside the band. All honest "no play" days;
    // the hold is written so the card can say which rather than showing
    // yesterday's pick as if it were live.
    const anyGame = structurallySound.length > 0;
    const legCount = gameLegs.length + propLegs.length;
    const reason = !anyGame
      ? 'no gradeable NFL, NCAA football, MMA or tennis game on the slate today'
      : legCount < 2
        ? `nothing on today's slate clears the edge floor (${(algoConfig.MIN_EV_PCT * 100).toFixed(1)}% EV against the no-vig consensus) on both sides of a ticket`
        : `${legCount} legs cleared the standard but no two pair inside ${formatAmerican(TICKET_BAND.MIN_AMERICAN)} to ${formatAmerican(TICKET_BAND.MAX_AMERICAN)} with both more likely than not to land`;
    await env.POTD_KV.put(holdKey(dateKey), JSON.stringify({ dateKey, reason, checkedAt: now, poolSize: candidates.length, legCount }), {
      expirationTtl: KV_TTL_SECONDS,
    });
    return { skipped: true, reason, dateKey };
  }

  const record = await buildRecord(ticket, dateKey, now, env, ctx);
  // A day's pick, once posted, doesn't move even if the market does — it's
  // an editorial call made at a point in time, not a live-repriced candidate.
  await env.POTD_KV.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  // A pick supersedes any hold an earlier tick wrote for the day (a slate
  // that filled in late, a redraw) — the card must never show both.
  try { await env.POTD_KV.delete(holdKey(dateKey)); } catch { /* best-effort */ }
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
  // A ticket spans two markets, so there is no single close to track — see
  // tracking.js's pickRecordFrom, which records its clv as null.
  if (!pick.clv) return { updated: false };

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

  // A ticket's write-up is about its feature leg — the game-market leg when
  // it has one (a prop leg's game has no side to argue), else the anchor;
  // same choice buildRecord makes. A pre-ticket record is its own subject.
  const legs = legsOf(record.pick);
  const feature = legs.find((l) => l.kind !== 'prop') ?? legs[0];
  if (feature?.kind === 'prop') return { attempted: false };
  const candidate = {
    eventId: feature.eventId,
    sportKey: feature.sportKey,
    sportTitle: feature.sportTitle ?? record.writeup?.sportTitle,
    home: feature.home,
    away: feature.away,
    outcomeName: feature.outcomeName,
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
  let outcome;
  if (pick.type === 'combo' && Array.isArray(pick.legs)) {
    // A ticket settles leg by leg through the shared grader (worker/src/
    // ticket-grading.js) — the same one Pixel's Picks use.
    const legs = pick.legs;
    const sports = [...new Set(legs.filter((l) => l.kind !== 'prop').map((l) => l.sportKey))];
    const fetched = await Promise.all(sports.map((sk) => fetchScoresFn(sk)));
    const bySport = new Map(sports.map((sk, i) => [sk, fetched[i].events ?? []]));
    outcome = await gradeTicket(pick, {
      scoreEventFor: (leg) => (bySport.get(leg.sportKey) ?? []).find((e) => e.id === leg.eventId),
      mmaResults: legs.some((l) => isMma(l.sportKey)) ? await fetchMmaResultsFn() : [],
      tennisResults: legs.some((l) => isTennis(l.sportKey)) ? await fetchTennisResultsFn() : [],
      env, ctx, now,
      nflStatsFor: nflStatsReader(ctx),
    });
    if (!outcome) return false;
    pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    pick.result = {
      payout: outcome.payout,
      roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
      voidReason: outcome.void ? outcome.reason : undefined,
    };
    await env.POTD_KV.put(`potd:${dateKey}`, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
    return true;
  }
  const { events } = await fetchScoresFn(pick.sportKey);
  const scoreEvent = (events ?? []).find((e) => e.id === pick.eventId);
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
/** Today's hold record ({ dateKey, reason, checkedAt }) when the draw ran and posted nothing, else null. */
export async function getPotdHold(env, now = Date.now()) {
  const raw = await env.POTD_KV.get(holdKey(etParts(now).date));
  return raw ? JSON.parse(raw) : null;
}

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
