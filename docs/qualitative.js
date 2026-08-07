/**
 * A deterministic, rule-based qualitative signal — recent form, head-to-head,
 * injuries — turned into a single bounded number that scoreCandidate() (see
 * engine.js) can use as a small capped swing on top of its price-only score.
 *
 * Deliberately NOT an LLM call: this reads the exact same data already
 * fetched for the app's own research bullets (docs/insights.js's
 * tennisRecentForm/tennisHeadToHead, and the worker's ESPN-derived /context
 * bundle) and reduces it to a number with a fixed, auditable formula — no
 * new network calls, no new cost, no chance of a hallucinated read silently
 * outweighing real market data.
 *
 * Pure, synchronous, no DOM/network — same contract as engine.js. Every
 * export returns `null` when there isn't enough real data to say anything,
 * never a fabricated "neutral" value standing in for missing data.
 */

import { tennisRecentForm, tennisHeadToHead, matchTeamSide, isUnavailable } from './insights.js';
import { clamp } from './engine.js';

/**
 * Recent-form win-rate differential (65%) blended with a confidence-
 * discounted head-to-head differential (35%). A single prior meeting — the
 * Osaka/Mertens case this feature exists for, a 1-0 head-to-head — shouldn't
 * swing as hard as a deep rivalry, so head-to-head confidence scales up to a
 * full 5 meetings before it counts at face value.
 *
 * Returns null when neither recent form (minFormSample games for BOTH
 * players) nor any head-to-head meetings are available.
 */
export function tennisQualitativeSignal(data, subjectName, opponentName, { minFormSample = 3 } = {}) {
  const subjectForm = tennisRecentForm(data, subjectName, { limit: 10 });
  const opponentForm = tennisRecentForm(data, opponentName, { limit: 10 });

  let formDiff = 0;
  let haveForm = false;
  if (subjectForm.length >= minFormSample && opponentForm.length >= minFormSample) {
    const winRate = (games) => games.filter((g) => g.result === 'W').length / games.length;
    formDiff = winRate(subjectForm) - winRate(opponentForm);
    haveForm = true;
  }

  // tennisHeadToHead(data, subjectName, opponentName) always resolves aName/
  // aWins from the first name argument — no separate "which side am I"
  // matching needed here, unlike the team-sport path below.
  const h2h = tennisHeadToHead(data, subjectName, opponentName);
  let h2hDiff = 0;
  let haveH2h = false;
  if (h2h && h2h.meetings.length) {
    const totalMeetings = h2h.aWins + h2h.bWins;
    const confidence = Math.min(totalMeetings, 5) / 5;
    h2hDiff = confidence * ((h2h.aWins - h2h.bWins) / totalMeetings);
    haveH2h = true;
  }

  if (!haveForm && !haveH2h) return null;
  if (haveForm && haveH2h) return clamp(0.65 * formDiff + 0.35 * h2hDiff, -1, 1);
  return clamp(haveForm ? formDiff : h2hDiff, -1, 1);
}

/**
 * Recent-form points differential (65%, draws worth half a win — same
 * convention docs/insights.js's teamInsights() tally already uses) blended
 * with an injury-count differential (35%, capped at maxInjuryDiff so a
 * single extra unavailable player doesn't dominate).
 *
 * Head-to-head is deliberately NOT attempted for team sports:
 * context.seriesSummary is free-text prose with no stable structured shape
 * to parse without risking a silent misread — the exact "vibes, not data"
 * this whole feature exists to avoid.
 *
 * Returns null when the subject team can't be matched to either side, or
 * when neither recent form nor any injury data is available for either side.
 */
export function teamQualitativeSignal(context, subjectTeamName, { minFormSample = 3, maxInjuryDiff = 3 } = {}) {
  const { me, them } = matchTeamSide(context, subjectTeamName);
  if (!me || !them) return null;

  const formPct = (side) => {
    const games = side?.lastFive ?? [];
    if (games.length < minFormSample) return null;
    const points = games.reduce((sum, g) => sum + (g.result === 'W' ? 1 : g.result === 'D' ? 0.5 : 0), 0);
    return points / games.length;
  };
  const myForm = formPct(me);
  const theirForm = formPct(them);
  const haveForm = myForm != null && theirForm != null;
  const formDiff = haveForm ? myForm - theirForm : 0;

  const outCount = (side) => (side?.injuries ?? []).filter(isUnavailable).length;
  const myOut = outCount(me);
  const theirOut = outCount(them);
  const haveInjury = myOut > 0 || theirOut > 0;
  const injuryDiff = haveInjury ? clamp((theirOut - myOut) / maxInjuryDiff, -1, 1) : 0;

  if (!haveForm && !haveInjury) return null;
  if (haveForm && haveInjury) return clamp(0.65 * formDiff + 0.35 * injuryDiff, -1, 1);
  return clamp(haveForm ? formDiff : injuryDiff, -1, 1);
}

/**
 * Whether a market has a real "side" to attach a qualitative signal to. A
 * total's outcomeName is 'Over'/'Under' — not a team or player — so there's
 * no form/H2H/injury differential that means anything; it stays pure-price.
 */
export function supportsQualitativeSignal(marketKey) {
  return marketKey !== 'totals';
}
