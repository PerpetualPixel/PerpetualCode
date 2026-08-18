/**
 * The team-sport counterpart to the tennis form gate — recent form and
 * injuries consulted when a pick is CHOSEN, not merely when it's drawn.
 *
 * The gap this closes: docs/qualitative.js's teamQualitativeSignal has
 * existed for a while and was imported in exactly one place, docs/app.js,
 * where it re-scores cards in the browser at render time. Every worker
 * selection path imported applyTennisFormSignal and nothing else, so the
 * picks that actually got locked and tracked for MLB, WNBA, NFL, NCAAF and
 * MLS were chosen on price alone, and the evidence arrived afterwards, too
 * late to change which side was taken. Tennis had a form gate, MMA had
 * capper consensus, and every team sport had neither.
 *
 * docs/engine.js's UNDERDOG_PROB_PENALTY already names this as an open
 * hole in its own comment — it exists as "the sport-agnostic counterpart
 * for everywhere no such evidence source exists," sized from a 30-day
 * record where +120-and-longer underdogs were 57% of graded picks and won
 * 29.6% of them. For the leagues in context.js's LEAGUE_PATHS an evidence
 * source does exist; this module spends it.
 *
 * Two effects, mirroring applyTennisFormSignal exactly:
 *   - a ±QUALITATIVE.MAX_SWING re-score from the form/injury differential;
 *   - a straight-moneyline underdog gate, so an upset call has to be backed
 *     by something other than one book hanging an outlier price.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM TENNIS: no data means no gate here,
 * where in tennis it means a block. That asymmetry is about what missing
 * data MEANS in each sport. A tennis player absent from the archive is
 * routine at ITF/Challenger level and is itself informative — those are the
 * low-information matches where upset calls are worst. A missing ESPN
 * context for a WNBA or MLB fixture in a major league is a transient fetch
 * failure or a name that didn't match, and says nothing about the game. A
 * pick shouldn't be punished for our data source being unreachable, so an
 * unresolvable fixture falls back to exactly the behaviour it had before
 * this module existed: pure price, with UNDERDOG_PROB_PENALTY still
 * applying.
 */

import { fetchContext, hasContext } from './context.js';
import { teamQualitativeSignal, supportsQualitativeSignal } from '../../docs/qualitative.js';
import { scoreCandidate } from '../../docs/engine.js';
import { nflEpaDifferential } from './nfl-efficiency.js';

/** The one sport nflEpaDifferential has real data for — see nfl-efficiency.js's header. */
const isNfl = (sportKey) => sportKey === 'americanfootball_nfl';

/**
 * Minimum form/injury signal a market underdog needs before a straight
 * moneyline on them is pickable.
 *
 * Deliberately stricter than tennis's TENNIS_DOG_MIN_SIGNAL of 0.15,
 * because the sample behind it is half the size. Tennis reads each player's
 * last ≤10 matches, so 0.15 is about one-and-a-half matches' worth of
 * separation. ESPN's lastFiveGames is five, where 0.20 is exactly one game:
 * the dog having won one more of its last five than the favorite. Setting
 * it at tennis's 0.15 over a 5-game window would clear on 0.75 of a game,
 * which no honest reading of five results can distinguish from noise.
 *
 * A judgment call, like every threshold in this app — sanity-check it
 * against the segment records the weekly health review now collects.
 */
export const TEAM_DOG_MIN_SIGNAL = 0.20;

/**
 * Ceiling on ESPN game-page fetches per loadTeamContextsFor call.
 *
 * This repo has a live incident behind this number: refreshMlbLeagueStats
 * had to be moved to its own standalone cron tick because fetching all 30
 * MLB teams alongside a request's own calls blew Cloudflare's
 * per-invocation subrequest cap. The selection batches run inside a
 * scheduled() invocation that is ALREADY doing a great deal — four prop
 * scans, four grading passes, the learning review, and three pick batches —
 * so an unbounded per-game fetch here is the same mistake in a new place.
 *
 * Two things keep the real number far below this ceiling most ticks: the
 * module memo below, and the fact that callers pass only candidates they
 * might actually lock. The Full Slate has already filtered out every event
 * it tracked on a previous tick by the time it asks, so a typical 15-minute
 * tick has a handful of newly-lockable games, not a full day's slate.
 *
 * Over the cap, the remaining fixtures resolve to no context and fall back
 * to pure price — the same honest degradation as an unreachable ESPN.
 */
export const MAX_CONTEXT_FETCHES = 12;

/**
 * How long a resolved context stays usable from the module memo. Matches
 * context.js's own SUMMARY_TTL (1800s), which is the rate the underlying
 * records and injuries actually move at.
 */
const CONTEXT_MEMO_MS = 1800 * 1000;

/**
 * Module-scope memo, same pattern and same reasoning as tennis-archive.js:
 * it survives across requests in the same isolate, so the three selection
 * batches that run in one scheduled() tick resolve a shared fixture once
 * between them rather than three times.
 *
 * A null result is memoized too. An unmatched fixture is the common, cheap,
 * permanent case (ESPN simply has no event for it), and re-fetching it on
 * every tick for the rest of the day would spend the fetch budget on the
 * one thing already known to be a dead end.
 */
let contextMemo = new Map();
let memoSealed = false;

/**
 * Test hook, mirroring seedTennisArchiveCacheForTests: pre-seed the memo so
 * unit tests exercising the pick batches never reach the network. Pass a
 * plain object or Map of fixtureKey -> context (or null).
 *
 * Seeding also SEALS the memo: a fixture the seed doesn't name resolves to
 * null instead of being fetched. A test hook that only pre-populates known
 * fixtures would leave every other fixture in a test slate reaching for
 * cdn.espn.com, which is precisely what the hook exists to prevent — and
 * null is the honest degraded mode anyway, identical to what an unreachable
 * ESPN produces in production.
 *
 * Pass null to unseal and restore live fetching.
 */
export function seedTeamContextCacheForTests(entries) {
  contextMemo = new Map();
  memoSealed = entries != null;
  if (!entries) return;
  const pairs = entries instanceof Map ? entries.entries() : Object.entries(entries);
  for (const [key, value] of pairs) contextMemo.set(key, { value, at: Infinity });
}

/** The fixture a candidate belongs to — one context serves every market on the same game. */
export function fixtureKey(candidate) {
  return `${candidate?.sportKey}|${candidate?.home}|${candidate?.away}`;
}

/**
 * Resolve an ESPN context for every distinct fixture in `candidates` that
 * has a league mapping, bounded by MAX_CONTEXT_FETCHES.
 *
 * Fixtures are attempted in descending order of their best candidate's
 * score, so when the cap does bite it spends the budget on the games most
 * likely to be picked rather than on whatever the list happened to hold
 * first. Memo hits are free and never count against the cap.
 *
 * Never throws: this is an enrichment, and a batch that can't reach ESPN
 * must still produce a board. A fixture that fails resolves to null, which
 * applyTeamFormSignal treats as "no evidence" rather than "bad".
 *
 * Returns a Map of fixtureKey -> context|null.
 */
export async function loadTeamContextsFor(
  candidates,
  ctx,
  { now = Date.now(), max = MAX_CONTEXT_FETCHES, fetchFn = fetchContext } = {},
) {
  const best = new Map();
  for (const c of candidates ?? []) {
    if (!hasContext(c?.sportKey) || !c.home || !c.away) continue;
    const key = fixtureKey(c);
    const score = Number(c.score) || 0;
    if (!best.has(key) || score > best.get(key).score) best.set(key, { candidate: c, score });
  }

  const out = new Map();
  const needed = [];
  for (const [key, { candidate }] of best) {
    const memo = contextMemo.get(key);
    if (memo && now - memo.at < CONTEXT_MEMO_MS) {
      out.set(key, memo.value);
      continue;
    }
    if (memoSealed) { out.set(key, null); continue; }
    needed.push({ key, candidate, score: best.get(key).score });
  }

  needed.sort((a, b) => b.score - a.score);
  const attempted = needed.slice(0, Math.max(0, max));
  for (const { key } of needed.slice(Math.max(0, max))) out.set(key, null);

  await Promise.all(
    attempted.map(async ({ key, candidate }) => {
      let value = null;
      try {
        value = await fetchFn(
          { sportKey: candidate.sportKey, home: candidate.home, away: candidate.away }, ctx,
        );
      } catch (e) {
        console.error(`Team context fetch failed for ${key}:`, e);
      }
      contextMemo.set(key, { value: value ?? null, at: now });
      out.set(key, value ?? null);
    }),
  );

  return out;
}

/**
 * The straight-moneyline underdog gate for team sports — the direct
 * counterpart to docs/qualitative.js's tennisUnderdogBlocked, and blocked
 * on the same two conditions plus one inverted one (see this file's header
 * for why no-data passes here and blocks there).
 *
 * Spreads and totals pass through for the same reason they do in tennis: a
 * handicap dog covering is not an upset call, and consensusProb on a spread
 * measures covering rather than winning.
 */
export function teamUnderdogBlocked(candidate, signal) {
  if (candidate?.marketKey !== 'h2h') return false;
  if (!(Number(candidate.consensusProb) < 0.5)) return false;
  if (!Number.isFinite(signal)) return false; // no evidence either way — not a reason to block
  return signal < TEAM_DOG_MIN_SIGNAL;
}

/**
 * Apply the team form signal to a mixed-sport candidate list: every
 * team-sport candidate with a real side and a resolved context gets
 * re-scored with its form/injury signal (the same ±QUALITATIVE.MAX_SWING
 * enrichment the browser has always applied at render time), and
 * unsupported straight-moneyline underdogs are removed entirely.
 *
 * Tennis, MMA and NHL candidates pass through untouched — the first two
 * have their own evidence layers already applied by the caller, and NHL has
 * no page on this ESPN host at all (see context.js's LEAGUE_PATHS).
 *
 * `nflEfficiency` is the { teams: {...} } snapshot from
 * worker/src/nfl-efficiency.js's getNflEfficiency — optional (every caller
 * that doesn't pass it gets exactly today's form/injury-only behavior). For
 * an NFL candidate specifically, its per-play EPA differential is computed
 * here (from the candidate's own home/away names, no ESPN match required)
 * and handed to teamQualitativeSignal as a third, independent component —
 * see that function's own comment for why it's weighted highest of the
 * three when present.
 *
 * Returns a new array; does NOT re-sort — same contract as
 * applyTennisFormSignal, so callers that depend on score order must sort
 * afterwards, since re-scoring reorders candidates.
 */
export function applyTeamFormSignal(candidates, contexts, { now = Date.now(), nflEfficiency = null } = {}) {
  return (candidates ?? []).flatMap((c) => {
    if (!hasContext(c?.sportKey) || !supportsQualitativeSignal(c.marketKey)) return [c];
    const context = contexts?.get?.(fixtureKey(c)) ?? null;
    let epaDiff = null;
    if (isNfl(c.sportKey) && nflEfficiency?.teams) {
      const opponent = c.outcomeName === c.home ? c.away : c.home;
      epaDiff = nflEpaDifferential(nflEfficiency.teams, c.outcomeName, opponent);
    }
    let signal = null;
    try {
      signal = teamQualitativeSignal(context, c.outcomeName, { epaDiff });
    } catch {
      /* a malformed context is missing data, not a reason to lose the board */
    }
    if (teamUnderdogBlocked(c, signal)) return [];
    if (signal == null) return [{ ...c, formSignal: null, epaDiff }];
    return [{ ...c, ...scoreCandidate(c, { now, qualitative: signal }), formSignal: signal, epaDiff }];
  });
}
