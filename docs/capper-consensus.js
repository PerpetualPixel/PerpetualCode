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
 * The feed entry flattened into the shape the UI renders.
 *
 * `scored` is the honest part: a fighter-consensus can only move the grade of
 * a bet that HAS a fighter side, so an h2h candidate gets scored: true while
 * a rounds total or spread on the same fight gets scored: false — the
 * consensus is real context for that fight either way, but claiming it
 * changed a totals grade would be a lie. `aligned` is null in that case too,
 * since a total is neither with nor against the cappers' pick.
 */
export function consensusRecord(pick, feed, { aligned = null, signal = null, scored = false } = {}) {
  return {
    selection: pick.selection,
    consensusPct: pick.consensus_pct,
    strength: pick.strength,
    tier: pick.tier,
    pickCount: pick.pick_count,
    aligned,
    signal,
    scored,
    generatedAt: feed?.generated_at ?? null,
  };
}

/**
 * The consensus for a candidate's FIGHT, whatever market it is — the drawer
 * needs this because Full Slate's "More info" opens on the best-scoring
 * candidate of the three markets, which for MMA is usually a rounds total,
 * not the moneyline the swing attached to. Null when the feed has no entry.
 */
export function fightConsensusRecord(feed, candidate) {
  const pick = findConsensusPick(feed, candidate);
  return pick ? consensusRecord(pick, feed) : null;
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
      capperConsensus: consensusRecord(match.pick, feed, {
        aligned: match.aligned,
        signal: match.signal,
        scored: true,
      }),
    };
    return Object.assign(rescored, scoreCandidate(rescored, { now, qualitative: match.signal }));
  });
}

let feedCache = null;
let feedFetchedAt = 0;
export const FEED_TTL_MS = 60 * 1000;

/**
 * The last feed successfully fetched, or null before the first one lands.
 * Synchronous on purpose: the stats drawer renders its first paint without
 * awaiting anything, and a fight's consensus should appear in that paint or
 * not at all rather than popping in a moment later.
 */
export function cachedConsensusFeed() {
  return feedCache;
}

/**
 * Fetch the picks feed, cached for a minute.
 *
 * The feed only changes when MMA_Engine's weekly run pushes, but the whole
 * point of a push is that the board reflects it right away — so the cache is
 * short and every actual request is cache-busted (unique `?t=` plus
 * `cache: 'no-store'`). Without that, GitHub Pages' own CDN and the browser
 * HTTP cache would both keep serving the pre-push body for minutes after
 * weekly.bat finished, which reads as "the run didn't work".
 *
 * `force` skips the in-memory TTL for a caller that already knows it wants
 * fresh bytes (the poller below). Returns the last good feed — or null if
 * there has never been one — on any failure: the price-only score always
 * stands on its own.
 */
export async function fetchCapperConsensus(
  url = CAPPER_CONSENSUS_URL,
  { now = Date.now(), force = false } = {},
) {
  if (!force && feedCache && now - feedFetchedAt < FEED_TTL_MS) return feedCache;
  const busted = `${url}${url.includes('?') ? '&' : '?'}t=${now}`;
  try {
    const res = await fetch(busted, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
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
