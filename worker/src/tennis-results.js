/**
 * Games-level tennis settlement via a second, metered data source
 * (tennis-api-atp-wta-itf on RapidAPI) — the impure half of
 * docs/tennis-results.js. See that module's header for the full "why."
 *
 * Free tier: 50 requests/day. That number, not engineering convenience,
 * drives every design choice here:
 *   - Called at most ONCE per pick, ever — never polled. The caller
 *     (tracking.js/full-slate-tracking.js/potd.js's grading loops) only
 *     reaches this after the FREE Odds-API /scores already confirms the
 *     match is completed and cleanly decided (docs/learning.js's
 *     tennisMatchDecided) — a retirement is unsettleable by this source
 *     too, so there's no reason to spend a call finding that out.
 *   - Scoped to TIER_1 tennis spreads/totals only (see docs/tennis-tiers.js's
 *     hasSecondarySettlementSource) — real daily volume in the single
 *     digits, not the full slate.
 *   - A hard daily counter in KV, capped well under the real 50, so a bad
 *     day never risks the account's own rate limit.
 */

import { gradeTennisGameMarket } from '../../docs/tennis-results.js';
import { tennisMatchDecided } from '../../docs/learning.js';
import { hasSecondarySettlementSource } from '../../docs/tennis-tiers.js';

const RAPIDAPI_HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
// Kept well below the provider's real 50/day cap — headroom for a KV-
// counter race (reads/writes here aren't transactional) and for manual
// testing without risking the account's own limit.
export const TENNIS_RESULTS_DAILY_CAP = 30;

function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * "Alex de Minaur" -> "AlexDeMinaur" — best-effort guess at this
 * provider's URL-path naming (confirmed live for plain two-word names like
 * "Daniil Medvedev" -> "DaniilMedvedev"; the multi-word/hyphenated case is
 * inferred, not confirmed). Safe to guess wrong: a bad slug just means the
 * lookup 404s or returns an unrelated event, and gradeTennisGameMarket's
 * own name-match check (independent of this function) refuses to attribute
 * games to the wrong player either way — the failure mode is a wasted
 * budget slot and a fallback to the existing void, never a wrong result.
 */
function toApiName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[\s'-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

async function readDailyCount(env, dateKey) {
  const raw = await env.POTD_KV.get(`tennisresults:${dateKey}:calls`);
  return raw ? Number(raw) || 0 : 0;
}

async function reserveDailyCallSlot(env, ctx, dateKey) {
  const count = await readDailyCount(env, dateKey);
  if (count >= TENNIS_RESULTS_DAILY_CAP) return false;
  // Reserved before the fetch, not after a success — a failed upstream call
  // still spent real budget on the provider's side, and erring toward
  // under-counting our own guard is the wrong direction to be wrong in.
  ctx.waitUntil(env.POTD_KV.put(`tennisresults:${dateKey}:calls`, String(count + 1), {
    expirationTtl: 86400 * 7,
  }));
  return true;
}

async function fetchMatchResult(homeName, awayName, dateKey, env) {
  const key = (env.RAPIDAPI_TENNIS_KEY ?? '').trim();
  if (!key) return null;

  const url = `https://${RAPIDAPI_HOST}/tennis/v2/extend/api/event/get/${toApiName(homeName)}/${toApiName(awayName)}/${dateKey}`;
  try {
    const response = await fetch(url, {
      headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': key },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const result = body?.result;
    if (!result?.score) return null;

    const name1 = result.player1?.name ?? result.participant1 ?? '';
    const name2 = result.player2?.name ?? result.participant2 ?? '';
    return { participantNames: [name1, name2], score: result.score, status: result.status ?? null };
  } catch {
    return null;
  }
}

/**
 * Attempt games-level settlement for one tennis spreads/totals pick.
 *
 * Returns `{won,payout}` | `{void,reason,payout}` on a real answer from
 * the second source, or `null` when this source can't or shouldn't be
 * used for this pick — budget exhausted, match not decided yet, retired,
 * the secret isn't configured, or the lookup/parse failed. `null` tells
 * the caller to fall back to docs/learning.js's gradePick, which already
 * voids this case correctly on its own.
 */
export async function settleTennisGameMarket(pick, scoreEvent, env, ctx, now = Date.now()) {
  if (!hasSecondarySettlementSource(pick.sportKey, pick.marketKey)) return null;

  const decided = tennisMatchDecided(pick, scoreEvent);
  if (!decided?.decided) return null; // not completed yet, or a retirement — same unsettleable case either source

  // Two different calendar days, deliberately not conflated: the budget
  // counts calls against TODAY (when we're actually asking), while the
  // lookup URL needs the MATCH's own date (which day's card to search) —
  // a match that commenced late ET and is graded after midnight would
  // otherwise get billed to the wrong day's counter.
  const callDateKey = etDate(now);
  const matchDateKey = etDate(pick.commenceMs);

  const gotSlot = await reserveDailyCallSlot(env, ctx, callDateKey);
  if (!gotSlot) return null; // daily budget exhausted — fall back to the existing void

  const apiResult = await fetchMatchResult(pick.home, pick.away, matchDateKey, env);
  if (!apiResult) return null;

  return gradeTennisGameMarket(pick, apiResult);
}
