/**
 * MLB starting-pitcher props — Outs Recorded and Strikeouts.
 *
 * Runs in its OWN cron hour (1am ET, MLB_PROPS_BATCH_HOUR below), one hour
 * before the main 2am lock-in (Pixel's Picks/Full Slate/Play of the Day).
 * Deliberately not folded into that same invocation: this batch makes one
 * ESPN schedule lookup, one ESPN boxscore-summary lookup, AND one real
 * Odds-API per-event odds call PER MLB GAME (~15/day in season) — on top of
 * what the 2am invocation already does (a full-slate fetch, three
 * selection batches, and five analysis-prewarm model calls), that's the
 * kind of per-invocation subrequest pressure that has already forced one
 * other MLB job (mlb-stats.js's refreshMlbLeagueStats) into its own
 * isolated hour after hitting Cloudflare's cap live. Giving this batch its
 * own hour sidesteps the same failure mode rather than rediscovering it.
 *
 * Cost, by design: ONE odds snapshot per game per day (~2 credits/game,
 * ~30 credits/day in season) — no intraday re-checks for line movement yet.
 * That was a deliberate, explicit scoping decision (see the conversation
 * that shipped this file) made after finding the account's existing
 * 20-minute grading/CLV cron ticks already project to blow well past a
 * 20,000-credit monthly plan on their own; adding a repeating intraday prop
 * snapshot on top of that unresolved problem would have compounded it
 * before it's even understood. Revisit once that's sized.
 *
 * Settlement: MLB's boxscore is the one player-level stat source already
 * proven reachable from this Worker (mlb-stats.js's own header note on
 * which ESPN host actually answers Cloudflare Workers), which is why this
 * exists as a real feature while the equivalent NBA/NFL asks do not yet.
 */

import { scoreCandidate, RULES, suggestedStake } from '../../docs/engine.js';
import {
  buildPitcherPropCandidates,
  gradePitcherProp,
  propLiquidityBlock,
} from '../../docs/mlb-props.js';
import { mlbAbbr } from './analysis.js';
import { UPSTREAM, REGIONS } from './odds.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';

export const MLB_PROPS_BATCH_HOUR = 1; // 1am ET — see module header for why this isn't 2am
const FLAT_UNIT_STAKE = 20; // matches every other tracker's own duplicated copy of docs/learning.js's constant
const KV_TTL_SECONDS = 86400 * 90;
const GRADING_LOOKBACK_DAYS = 2;
const PROP_MARKETS = 'pitcher_outs,pitcher_strikeouts';

const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb';
const SCHEDULE_TTL = 3600 * 6;
const SUMMARY_TTL = 900; // short: this same URL is read pregame (probables) and, hours later, postgame (final boxscore)

/** ET calendar date (YYYY-MM-DD) for a given instant — same convention as tracking.js's own etDate. */
function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function cachedEspnJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/mlb-props-espn/${encodeURIComponent(url)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.text();
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    })));
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function pitcherFromProbable(probable) {
  if (!probable?.athlete) return null;
  return { playerId: probable.athlete.id, name: probable.athlete.displayName };
}

/**
 * Find today's ESPN game between two teams and both probable starters, by
 * searching the home team's own schedule for the matching opponent — the
 * same technique mlb-stats.js's fetchStartingPitchers already uses, kept
 * separate here because that function doesn't return the ESPN event id,
 * which grading needs later to re-fetch this exact game's final boxscore.
 */
async function resolveEspnGame(homeAbbr, awayAbbr, ctx) {
  if (!homeAbbr || !awayAbbr) return null;
  const schedule = await cachedEspnJson(`${ESPN_SITE}/teams/${homeAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const events = schedule?.events ?? [];
  const match = events.find((e) => {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.completed) return false;
    return comp?.competitors?.some((c) => c.team?.abbreviation?.toLowerCase() === awayAbbr.toLowerCase());
  });
  if (!match) return null;

  const summary = await cachedEspnJson(`${ESPN_SITE}/summary?event=${match.id}`, SUMMARY_TTL, ctx);
  const competitors = summary?.header?.competitions?.[0]?.competitors ?? [];
  const away = pitcherFromProbable(competitors.find((c) => c.homeAway === 'away')?.probables?.[0]);
  const home = pitcherFromProbable(competitors.find((c) => c.homeAway === 'home')?.probables?.[0]);
  if (!away && !home) return null;

  return { espnEventId: match.id, pitchers: [away, home].filter(Boolean) };
}

/** The completed game's boxscore, or null if it isn't final yet. */
async function fetchFinalBoxscore(espnEventId, ctx) {
  const summary = await cachedEspnJson(`${ESPN_SITE}/summary?event=${espnEventId}`, SUMMARY_TTL, ctx);
  const completed = summary?.header?.competitions?.[0]?.status?.type?.completed;
  if (!completed) return null;
  return summary?.boxscore?.players ?? [];
}

/** This pitcher's own pitching-stat row from a completed game's boxscore, or null if he never appears in it. */
function pitcherRowFromBoxscore(boxscorePlayers, playerId) {
  for (const team of boxscorePlayers ?? []) {
    const pitching = team.statistics?.find((s) => s.type === 'pitching');
    if (!pitching) continue;
    const ipIdx = pitching.names?.indexOf('IP') ?? -1;
    const kIdx = pitching.names?.indexOf('K') ?? -1;
    const athlete = pitching.athletes?.find((a) => String(a.athlete?.id) === String(playerId));
    if (athlete) {
      return { ip: ipIdx >= 0 ? athlete.stats?.[ipIdx] : null, strikeouts: kIdx >= 0 ? athlete.stats?.[kIdx] : null };
    }
  }
  return null;
}

/**
 * The Odds API's per-event endpoint, billed per market/region regardless of
 * the cheap league-wide featured pull the rest of the app uses (see
 * worker/src/index.js's fetchTennisAltSpread for the same shape/reasoning).
 */
async function fetchPitcherPropsForEvent(oddsEventId, env, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/mlbprops-odds/${oddsEventId}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${UPSTREAM}/sports/baseball_mlb/events/${oddsEventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', PROP_MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const upstream = await fetch(url.toString());
  if (!upstream.ok) return { bookmakers: [] };
  const body = await upstream.text();
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=900' },
  })));
  return JSON.parse(body);
}

/** Every MLB game on today's ET slate from the shared full-slate event list — no new odds fetch. */
function todaysMlbGames(events, dateKey) {
  return (events ?? []).filter((e) => e.sport_key === 'baseball_mlb' && etDate(new Date(e.commence_time).getTime()) === dateKey);
}

async function buildCandidatesForGame(oddsEvent, env, ctx, now) {
  const homeAbbr = mlbAbbr(oddsEvent.home_team);
  const awayAbbr = mlbAbbr(oddsEvent.away_team);
  const game = await resolveEspnGame(homeAbbr, awayAbbr, ctx);
  if (!game?.pitchers?.length) return [];

  const propsResponse = await fetchPitcherPropsForEvent(oddsEvent.id, env, ctx);
  const bookmakers = propsResponse?.bookmakers ?? [];
  if (!bookmakers.length) return [];

  return buildPitcherPropCandidates(
    {
      eventId: oddsEvent.id,
      espnEventId: game.espnEventId,
      sportKey: oddsEvent.sport_key,
      sportTitle: oddsEvent.sport_title,
      commenceMs: new Date(oddsEvent.commence_time).getTime(),
      home: oddsEvent.home_team,
      away: oddsEvent.away_team,
      pitchers: game.pitchers,
    },
    bookmakers,
    { now },
  );
}

function pickRecordFromMlbProp(candidate, dateKey, now) {
  return {
    pickId: candidate.id,
    dateKey,
    eventId: candidate.eventId,
    espnEventId: candidate.espnEventId,
    sportKey: candidate.sportKey,
    home: candidate.home,
    away: candidate.away,
    marketKey: candidate.marketKey,
    playerId: candidate.playerId,
    playerName: candidate.playerName,
    outcomeName: candidate.outcomeName,
    point: candidate.point,
    selection: candidate.selection,
    american: candidate.american,
    decimal: candidate.decimal,
    book: candidate.book,
    score: candidate.score,
    rawScore: candidate.rawScore ?? null,
    learnWeight: candidate.learnWeight ?? null,
    consensusProb: candidate.consensusProb,
    commenceMs: candidate.commenceMs,
    suggested_stake: FLAT_UNIT_STAKE,
    generatedAt: now,
    status: 'pending',
    result: null,
  };
}

async function loadMlbPropsTracked(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`mlbprops:${dateKey}:manifest`);
  if (!manifestRaw) return { pickIds: [], picks: [] };
  const { pickIds } = JSON.parse(manifestRaw);
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`mlbprops:${dateKey}:pick:${id}`)));
  return { pickIds, picks: stored.filter(Boolean).map((r) => JSON.parse(r)) };
}

export async function getAllMlbPropsTracked(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const perDay = await Promise.all(dateKeys.map((d) => loadMlbPropsTracked(env, d)));
  return perDay.flatMap((d) => d.picks);
}

/**
 * The 1am ET batch: one real edge-scan per MLB game, at real per-event
 * Odds-API cost (see module header). Idempotent per ET day via its own
 * manifest key, so a retried or overlapping tick can't double the spend.
 */
export async function runMlbPropsBatch(
  env,
  ctx,
  now = Date.now(),
  { fetchFullSlate } = {},
) {
  const dateKey = etDate(now);
  const manifestKey = `mlbprops:${dateKey}:manifest`;
  const existing = await env.POTD_KV.get(manifestKey);
  if (existing) return { skipped: true, reason: 'already generated today', dateKey };

  const events = await fetchFullSlate();
  const games = todaysMlbGames(events, dateKey);
  if (!games.length) {
    await env.POTD_KV.put(manifestKey, JSON.stringify({ date: dateKey, generatedAt: now, pickIds: [] }), {
      expirationTtl: KV_TTL_SECONDS,
    });
    return { skipped: false, dateKey, count: 0, reason: 'no MLB games today' };
  }

  const perGame = await Promise.all(games.map((g) => buildCandidatesForGame(g, env, ctx, now)));
  const rawCandidates = perGame.flat().map((c) => ({ ...c, ...scoreCandidate(c, { now }) }));

  const learningProfile = await getLearningProfile(env);
  const adjusted = applyLearningToCandidates(rawCandidates, learningProfile);

  // A genuine edge, not a scan of everything priced — matches Pixel's
  // Picks' own EV/Kelly floor (RULES.MIN_EV_PCT/MIN_KELLY_FRACTION) rather
  // than Full Slate's "show every game regardless" philosophy, since the
  // ask here was explicitly to "identify edges," not catalogue the board.
  const cleared = adjusted.filter((c) => {
    if (c.ev <= RULES.MIN_EV_PCT) return false;
    if (suggestedStake(c) < RULES.MIN_KELLY_FRACTION) return false;
    return !propLiquidityBlock(c, now);
  });

  // One pick per (player, stat) — Over and Under of the same line can't
  // both be a real edge, so keep only the better-scoring side if somehow
  // both cleared the bar.
  const bestPerPlayerStat = new Map();
  for (const c of cleared) {
    const key = `${c.playerId}|${c.marketKey}`;
    if (!bestPerPlayerStat.has(key) || c.score > bestPerPlayerStat.get(key).score) {
      bestPerPlayerStat.set(key, c);
    }
  }

  const pickIds = [];
  for (const candidate of bestPerPlayerStat.values()) {
    // suggested_stake is the app's flat per-pick unit (FLAT_UNIT_STAKE,
    // matching every other tracker) — the Kelly/EV filter above decides
    // WHETHER a candidate qualifies, not how much to stake once it does.
    // docs/mlb-props.js's PROP_MAX_STAKE_FRACTION documents the policy this
    // app would size to if it ever moves off a flat unit (tennis-tiers.js's
    // own capStakeForTier is the same not-yet-wired policy for that market).
    const record = pickRecordFromMlbProp(candidate, dateKey, now);
    pickIds.push(record.pickId);
    ctx.waitUntil(env.POTD_KV.put(`mlbprops:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
      expirationTtl: KV_TTL_SECONDS,
    }));
  }

  ctx.waitUntil(env.POTD_KV.put(manifestKey, JSON.stringify({ date: dateKey, generatedAt: now, pickIds }), {
    expirationTtl: KV_TTL_SECONDS,
  }));

  return { skipped: false, dateKey, count: pickIds.length, gameCount: games.length };
}

/**
 * 20-minute grading tick. Cheap when nothing's pending (one KV read per
 * recent day, no fetch) — mirrors tracking.js's own runGrading in that
 * respect. Each still-pending pick re-fetches its OWN game's ESPN summary
 * (free — no Odds-API cost), so this tick's cost doesn't grow with time the
 * way a real intraday odds re-check would.
 */
export async function runMlbPropsGrading(env, ctx, now = Date.now()) {
  const dateKeys = [...new Set(
    Array.from({ length: GRADING_LOOKBACK_DAYS }, (_, i) => etDate(now - i * 86400000)),
  )];
  const loaded = await Promise.all(dateKeys.map((dk) => loadMlbPropsTracked(env, dk)));
  const picks = loaded.flatMap((d) => d.picks);
  const pending = picks.filter((p) => p.status === 'pending');
  if (!pending.length) return { graded: 0, remaining: 0 };

  const espnEventIds = [...new Set(pending.map((p) => p.espnEventId))];
  const boxscores = new Map(
    await Promise.all(espnEventIds.map(async (id) => [id, await fetchFinalBoxscore(id, ctx)])),
  );

  let graded = 0;
  for (const pick of pending) {
    const boxscorePlayers = boxscores.get(pick.espnEventId);
    if (!boxscorePlayers) continue; // game not final yet — stays pending
    const row = pitcherRowFromBoxscore(boxscorePlayers, pick.playerId);
    const outcome = gradePitcherProp(pick, row);
    if (!outcome) continue;
    pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    pick.result = {
      payout: outcome.payout,
      roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
      voidReason: outcome.void ? outcome.reason : undefined,
      actual: outcome.actual ?? undefined,
    };
    graded++;
    ctx.waitUntil(env.POTD_KV.put(`mlbprops:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
      expirationTtl: KV_TTL_SECONDS,
    }));
  }
  return { graded, remaining: pending.length - graded };
}
