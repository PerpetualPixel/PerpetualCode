/**
 * Play of the Day — one editorially-selected pick, posted once daily, the
 * same for every user that day.
 *
 * Timing: generated once, at POTD_HOUR (2am ET). Because that's so early in
 * the ET calendar day, a single run already covers essentially the whole
 * day's slate — including an early-morning tennis match — so there's no need
 * for the old two-phase "morning vs. the evening before" split.
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

import { analyze, RULES, explainExtensive, formatAmerican, suggestedStake } from '../../docs/engine.js';
import { buildInsights, insightsByTier, isTennis, isMma } from '../../docs/insights.js';
import { gradePick } from '../../docs/learning.js';
import { fetchContext, hasContext } from './context.js';
import { fetchWeather } from './weather.js';
import { fetchMmaContext } from './mma.js';
import { fetchSport, fetchScores } from './odds.js';

const ET_TZ = 'America/New_York';
export const POTD_HOUR = 2; // 2am ET
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

const TENNIS_ARCHIVE_BASE = 'https://miguelsgarcia4.github.io/PerpetualCode/data';

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

let tennisArchiveCache = null; // module-scope: survives across requests in the same isolate
async function loadTennisArchive(sportKey) {
  const tour = /wta/i.test(sportKey) ? 'wta' : 'atp';
  tennisArchiveCache ??= {};
  if (tennisArchiveCache[tour]) return tennisArchiveCache[tour];

  try {
    const r = await fetch(`${TENNIS_ARCHIVE_BASE}/tennis-${tour}.json`);
    tennisArchiveCache[tour] = r.ok ? await r.json() : null;
  } catch {
    tennisArchiveCache[tour] = null;
  }
  return tennisArchiveCache[tour];
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
 * The full breakdown write-up for one candidate, in four named tiers:
 *
 *   1. The Market & Price Case — the same no-vig/EV reasoning every pick
 *      card carries, just not truncated to one sentence.
 *   2. Primary Personnel & Direct Matchup — the subject's own record, form,
 *      head-to-head, and (MMA) finish tendencies.
 *   3. Supporting Cast & Availability — team-sport roster availability only;
 *      omitted entirely for tennis and MMA, which have no supporting cast to
 *      report on rather than an empty placeholder pretending otherwise.
 *   4. Situational Notes — layoff / retirement-and-walkover flags, the only
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
function buildWriteup(candidate, research, now) {
  const priceBullets = explainExtensive(candidate, { now });
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
    book: candidate.book,
    score: Math.round(candidate.score),
    commenceMs: candidate.commenceMs,
    stake: suggestedStake(candidate),
    sections: [
      { title: 'The Market & Price Case', bullets: priceBullets },
      ...(personnel.length ? [{ title: 'Primary Personnel & Direct Matchup', bullets: personnel }] : []),
      ...(supporting.length ? [{ title: 'Supporting Cast & Availability', bullets: supporting }] : []),
      ...(environmental.length ? [{ title: 'Environmental & Situational Notes', bullets: environmental }] : []),
    ],
  };
}

async function buildRecord(best, dateKey, now, env, ctx) {
  const research = await researchFor(best, env, ctx);
  const writeup = buildWriteup(best, research, now);
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
      home: best.home,
      away: best.away,
      commenceMs: best.commenceMs,
      book: best.book,
      consensusProb: best.consensusProb,
      suggested_stake: FLAT_UNIT_STAKE,
      status: 'pending',
      clv: { openAmerican: best.american, closeAmerican: best.american, updatedAt: now },
      result: null,
    },
    writeup,
  };
}

/**
 * The one daily selection: pull the full slate, filter to today's still-
 * upcoming, non-exhibition, in-band (-200..+150) candidates, take the single
 * best-graded one, build its write-up and tracking record, and store it —
 * unless today's KV entry already exists, in which case there's nothing to
 * do (either an earlier tick this same ET day already ran, or a retried
 * cron tick fired twice).
 */
export async function runPotdDaily(env, ctx, now = Date.now(), { fetchFullSlate }) {
  const dateKey = etParts(now).date;
  const kvKey = `potd:${dateKey}`;

  const existing = await env.POTD_KV.get(kvKey);
  if (existing) return { skipped: true, reason: 'already generated', dateKey };

  const events = await fetchFullSlate();
  const candidates = analyze(events, { now });
  const eligible = candidates.filter((c) => {
    if (c.score < RULES.MIN_SCORE) return false;
    if (isExhibition(c)) return false;
    if (c.american < POTD_MIN_AMERICAN || c.american > POTD_MAX_AMERICAN) return false;
    if (c.commenceMs <= now) return false;
    return etParts(c.commenceMs).date === dateKey;
  });

  if (!eligible.length) {
    return { skipped: true, reason: 'no qualifying candidate in odds band today', dateKey };
  }

  const best = eligible.reduce((a, b) => (b.score > a.score ? b : a));
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
 * Grade today's pick once its game has a completed score, via the exact same
 * gradePick() the client's own "Check Results" button and the Top 5 batch's
 * runGrading both use. Runs every hourly tick, same reasoning as the Top 5
 * batch's own grading pass — idempotent, since it only ever touches a still-
 * pending pick.
 */
export async function runPotdGrading(env, ctx, now = Date.now(), { fetchScoresFn = (s) => fetchScores(s, env, ctx) } = {}) {
  const dateKey = etParts(now).date;
  const raw = await env.POTD_KV.get(`potd:${dateKey}`);
  if (!raw) return { graded: false };

  const record = JSON.parse(raw);
  const { pick } = record;
  if (pick.status !== 'pending') return { graded: false };

  const { events } = await fetchScoresFn(pick.sportKey);
  const scoreEvent = (events ?? []).find((e) => e.id === pick.eventId);
  const outcome = gradePick(pick, scoreEvent);
  if (!outcome) return { graded: false };

  pick.status = outcome.won ? 'won' : 'lost';
  pick.result = { payout: outcome.payout, roiPercent: (outcome.payout / pick.suggested_stake) * 100 };
  await env.POTD_KV.put(`potd:${dateKey}`, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { graded: true };
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
  const raw = await Promise.all(dateKeys.map((d) => env.POTD_KV.get(`potd:${d}`)));
  return raw
    .filter(Boolean)
    .map((r) => JSON.parse(r).pick)
    // A record written by the old two-phase/per-sport system has no `status`
    // (it was write-up-only, never tracked) — skip it rather than surfacing
    // an untracked pick the summary/day-block math can't make sense of.
    .filter((pick) => pick && pick.status != null);
}
