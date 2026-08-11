/**
 * MMA capper-consensus signal — the MMA_Engine picks feed turned into the
 * same bounded -1..1 qualitative number scoreCandidate() already accepts
 * (see docs/qualitative.js for the tennis/team equivalents).
 *
 * The feed (https://perpetualpixel.github.io/MMA_Engine/picks.json) is the
 * trust-weighted consensus of tracked YouTube cappers, rebuilt by
 * MMA_Engine's weekly run. Each entry names a fight, a market, the consensus
 * selection, and a 0-10 `strength` that already blends how one-sided the
 * cappers are with how much trust-weight actually backs them — so this
 * module doesn't re-derive any of that, it just matches a feed entry to an
 * odds-board candidate and signs the strength: positive when the candidate
 * IS the consensus side, negative when it's the opposite corner of a fight
 * the cappers called the other way.
 *
 * Matching is by surname because the two sources spell fighters differently
 * (auto-captions truncate — "Makhache" for "Makhachev" — and books
 * romanize differently), so exact-string equality would silently match
 * nothing. Same contract as qualitative.js: pure functions, null when
 * there's no real data, never a fabricated neutral.
 */

import { clamp, scoreCandidate } from './engine.js';

export const CAPPER_CONSENSUS_URL =
  'https://perpetualpixel.github.io/MMA_Engine/picks.json';

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function surnameOf(name) {
  const tokens = normalizeName(name).split(' ');
  return tokens[tokens.length - 1] ?? '';
}

/**
 * Surname match tolerant of truncation: exact, or one is a prefix of the
 * other with at least 4 shared characters ("makhache"/"makhachev",
 * "stoltzfu"/"stoltzfus"). Short surnames must match exactly — a 3-letter
 * prefix match would conflate genuinely different fighters.
 */
export function surnamesMatch(a, b) {
  const sa = surnameOf(a);
  const sb = surnameOf(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  if (Math.min(sa.length, sb.length) < 4) return false;
  return sa.startsWith(sb) || sb.startsWith(sa);
}

/**
 * Find the feed's moneyline entry for a candidate's fight, or null. Both of
 * the candidate's fighters must match the two sides of the feed entry's
 * fight string — matching the selection alone would let a common surname
 * attach one event's consensus to a different fight.
 */
export function findConsensusPick(feed, candidate) {
  for (const pick of feed?.picks ?? []) {
    if (pick.market !== 'moneyline') continue;
    const sides = String(pick.fight ?? '').split(/\s+vs\.?\s+/i);
    if (sides.length !== 2) continue;
    const [a, b] = sides;
    const matches =
      (surnamesMatch(candidate.home, a) && surnamesMatch(candidate.away, b)) ||
      (surnamesMatch(candidate.home, b) && surnamesMatch(candidate.away, a));
    if (matches) return pick;
  }
  return null;
}

/**
 * The -1..1 signal for one MMA h2h candidate, or null when the feed has no
 * entry for its fight or the candidate's side can't be resolved. `aligned`
 * says whether the candidate IS the consensus side; the magnitude is the
 * feed's own strength on a 0-1 scale either way.
 */
export function capperConsensusSignal(feed, candidate) {
  if (candidate.marketKey !== 'h2h') return null;
  const pick = findConsensusPick(feed, candidate);
  if (!pick) return null;

  const aligned = surnamesMatch(candidate.outcomeName, pick.selection);
  const opponent =
    candidate.outcomeName === candidate.home ? candidate.away : candidate.home;
  // The consensus selection must be one of the two fighters — if it matches
  // neither (a bad parse upstream), say nothing rather than guess a side.
  if (!aligned && !surnamesMatch(opponent, pick.selection)) return null;

  const magnitude = clamp((pick.strength ?? 0) / 10, 0, 1);
  return { signal: aligned ? magnitude : -magnitude, aligned, pick };
}

/**
 * Re-score every MMA h2h candidate that has a consensus entry, attaching
 * what was found as `capperConsensus` so the UI can show its work. Every
 * other candidate passes through untouched — same "enrichment is a bonus"
 * posture as app.js's refreshQualitativeSignals(). Returns a new array;
 * never mutates the input candidates.
 */
export function applyCapperConsensus(candidates, feed, { now = Date.now() } = {}) {
  if (!feed?.picks?.length) return candidates;
  return candidates.map((c) => {
    if (c.sportKey !== 'mma_mixed_martial_arts') return c;
    const match = capperConsensusSignal(feed, c);
    if (!match) return c;
    const rescored = {
      ...c,
      capperConsensus: {
        selection: match.pick.selection,
        consensusPct: match.pick.consensus_pct,
        strength: match.pick.strength,
        tier: match.pick.tier,
        pickCount: match.pick.pick_count,
        aligned: match.aligned,
        signal: match.signal,
        generatedAt: feed.generated_at ?? null,
      },
    };
    return Object.assign(rescored, scoreCandidate(rescored, { now, qualitative: match.signal }));
  });
}

let feedCache = null;
let feedFetchedAt = 0;
const FEED_TTL_MS = 15 * 60 * 1000;

/**
 * Fetch the picks feed, cached for 15 minutes — the feed only changes when
 * MMA_Engine's weekly run pushes, so refetching per render would be noise.
 * Returns null on any failure: the price-only score always stands on its own.
 */
export async function fetchCapperConsensus(url = CAPPER_CONSENSUS_URL, { now = Date.now() } = {}) {
  if (feedCache && now - feedFetchedAt < FEED_TTL_MS) return feedCache;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return feedCache;
    const feed = await res.json();
    if (!Array.isArray(feed?.picks)) return feedCache;
    feedCache = feed;
    feedFetchedAt = now;
    return feed;
  } catch {
    return feedCache;
  }
}
