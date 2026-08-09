/**
 * NFL starting-QB props — Pass Completions and Pass Attempts.
 *
 * Mirrors worker/src/mlb-props.js's shape closely (this codebase's
 * established convention for small, parallel per-sport modules — see
 * full-slate-tracking.js's own header comment on that choice), with one
 * real simplification: NFL needs no pregame "resolve the starter" step.
 * Whichever player The Odds API's own market prices a passing prop for is
 * trusted as the subject, matched by name against the final boxscore at
 * grading time — the boxscore match (or non-match, voiding) is the safety
 * net, the same way a bad player-name guess anywhere else in this app
 * fails closed rather than mis-attributing a result.
 *
 * Timing: same per-game dynamic window as MLB props (worker/src/mlb-props.js),
 * scanned every 20-minute tick rather than gated to one fixed hour, for the
 * same reason — a book's prop board isn't guaranteed to be live and liquid
 * arbitrarily far ahead of kickoff.
 *
 * Cost: one per-event odds call per game per week in season (~2
 * credits/game) — negligible; NFL plays far fewer games/week than MLB does
 * per day.
 */

import { scoreCandidate, RULES, suggestedStake, clearsMaxJuice } from '../../docs/engine.js';
import {
  buildQbPropCandidates,
  gradeQbProp,
  nflPropLiquidityBlock,
  normalizeName,
} from '../../docs/nfl-props.js';
import { espnAbbr } from '../../docs/team-logos.js';
import { UPSTREAM, REGIONS } from './odds.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';

const FLAT_UNIT_STAKE = 20;
const KV_TTL_SECONDS = 86400 * 90;
const GRADING_LOOKBACK_DAYS = 4; // NFL games are less frequent; a Sunday slate can still have a pending Monday-night pick two calendar days later
const PROP_MARKETS = 'player_pass_completions,player_pass_attempts';
const PROPS_WINDOW_HOURS = 3;

const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl';
const SCHEDULE_TTL = 3600 * 6;
const SUMMARY_TTL = 900;

function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function cachedEspnJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/nfl-props-espn/${encodeURIComponent(url)}`);
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

/** Today's ESPN event id for a matchup, by searching the home team's own schedule for the opponent. */
async function resolveEspnEventId(homeAbbr, awayAbbr, ctx) {
  if (!homeAbbr || !awayAbbr) return null;
  const schedule = await cachedEspnJson(`${ESPN_SITE}/teams/${homeAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const events = schedule?.events ?? [];
  const match = events.find((e) => {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.completed) return false;
    return comp?.competitors?.some((c) => c.team?.abbreviation?.toLowerCase() === awayAbbr.toLowerCase());
  });
  return match?.id ?? null;
}

/** The completed game's passing boxscore rows across both teams, or null if it isn't final yet. */
async function fetchFinalPassingBoxscore(espnEventId, ctx) {
  const summary = await cachedEspnJson(`${ESPN_SITE}/summary?event=${espnEventId}`, SUMMARY_TTL, ctx);
  const completed = summary?.header?.competitions?.[0]?.status?.type?.completed;
  if (!completed) return null;

  const rows = [];
  for (const team of summary?.boxscore?.players ?? []) {
    const passing = team.statistics?.find((s) => s.name === 'passing' || s.type === 'passing');
    const idx = passing?.names?.indexOf('C/ATT') ?? -1;
    if (idx < 0) continue;
    for (const athlete of passing.athletes ?? []) {
      rows.push({ name: athlete.athlete?.displayName, passingLine: athlete.stats?.[idx] });
    }
  }
  return rows;
}

function qbRowByName(rows, playerName) {
  const target = normalizeName(playerName);
  const row = (rows ?? []).find((r) => normalizeName(r.name) === target);
  return row ? { passingLine: row.passingLine } : null;
}

async function fetchQbPropsForEvent(oddsEventId, env, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/nflprops-odds/${oddsEventId}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${UPSTREAM}/sports/americanfootball_nfl/events/${oddsEventId}/odds`);
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

function todaysNflGames(events, dateKey) {
  return (events ?? []).filter((e) => e.sport_key === 'americanfootball_nfl' && etDate(new Date(e.commence_time).getTime()) === dateKey);
}

function isWithinPropsWindow(commenceMs, now) {
  const hoursUntil = (commenceMs - now) / 3.6e6;
  return hoursUntil > 0 && hoursUntil <= PROPS_WINDOW_HOURS;
}

async function buildCandidatesForGame(oddsEvent, env, ctx, now) {
  const homeAbbr = espnAbbr('americanfootball_nfl', oddsEvent.home_team);
  const awayAbbr = espnAbbr('americanfootball_nfl', oddsEvent.away_team);
  const espnEventId = await resolveEspnEventId(homeAbbr, awayAbbr, ctx);
  if (!espnEventId) return [];

  const propsResponse = await fetchQbPropsForEvent(oddsEvent.id, env, ctx);
  const bookmakers = propsResponse?.bookmakers ?? [];
  if (!bookmakers.length) return [];

  return buildQbPropCandidates(
    {
      eventId: oddsEvent.id,
      espnEventId,
      sportKey: oddsEvent.sport_key,
      sportTitle: oddsEvent.sport_title,
      commenceMs: new Date(oddsEvent.commence_time).getTime(),
      home: oddsEvent.home_team,
      away: oddsEvent.away_team,
    },
    bookmakers,
    { now },
  );
}

function pickRecordFromNflProp(candidate, dateKey, now) {
  return {
    pickId: candidate.id,
    dateKey,
    eventId: candidate.eventId,
    espnEventId: candidate.espnEventId,
    sportKey: candidate.sportKey,
    home: candidate.home,
    away: candidate.away,
    marketKey: candidate.marketKey,
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

async function loadNflPropsTracked(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`nflprops:${dateKey}:manifest`);
  if (!manifestRaw) return { pickIds: [], picks: [] };
  const { pickIds } = JSON.parse(manifestRaw);
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`nflprops:${dateKey}:pick:${id}`)));
  return { pickIds, picks: stored.filter(Boolean).map((r) => JSON.parse(r)) };
}

export async function getAllNflPropsTracked(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const perDay = await Promise.all(dateKeys.map((d) => loadNflPropsTracked(env, d)));
  return perDay.flatMap((d) => d.picks);
}

async function todaysNflGamesCached(env, dateKey, fetchFullSlate) {
  const cacheKey = `nflprops:${dateKey}:games`;
  const cached = await env.POTD_KV.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const events = await fetchFullSlate();
  const games = todaysNflGames(events, dateKey);
  await env.POTD_KV.put(cacheKey, JSON.stringify(games), { expirationTtl: 86400 });
  return games;
}

/** Every 20-minute tick — see module header for why this isn't one fixed hour. */
export async function runNflPropsScan(env, ctx, now = Date.now(), { fetchFullSlate } = {}) {
  const dateKey = etDate(now);
  const games = await todaysNflGamesCached(env, dateKey, fetchFullSlate);
  if (!games.length) return { scanned: 0, gameCount: 0 };

  const manifestKey = `nflprops:${dateKey}:manifest`;
  const manifestRaw = await env.POTD_KV.get(manifestKey);
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : { date: dateKey, pickIds: [], processedEventIds: [] };
  const processed = new Set(manifest.processedEventIds ?? []);

  const eligible = games.filter((g) => !processed.has(g.id) && isWithinPropsWindow(new Date(g.commence_time).getTime(), now));
  if (!eligible.length) return { scanned: 0, gameCount: games.length };

  const perGame = await Promise.all(eligible.map((g) => buildCandidatesForGame(g, env, ctx, now)));
  const rawCandidates = perGame.flat().map((c) => ({ ...c, ...scoreCandidate(c, { now }) }));

  const learningProfile = await getLearningProfile(env);
  const adjusted = applyLearningToCandidates(rawCandidates, learningProfile);

  const cleared = adjusted.filter((c) => {
    if (c.ev <= RULES.MIN_EV_PCT) return false;
    if (suggestedStake(c) < RULES.MIN_KELLY_FRACTION) return false;
    if (!clearsMaxJuice(c)) return false;
    return !nflPropLiquidityBlock(c, now);
  });

  const bestPerPlayerStat = new Map();
  for (const c of cleared) {
    const key = `${normalizeName(c.playerName)}|${c.marketKey}`;
    if (!bestPerPlayerStat.has(key) || c.score > bestPerPlayerStat.get(key).score) {
      bestPerPlayerStat.set(key, c);
    }
  }

  const newPickIds = [];
  for (const candidate of bestPerPlayerStat.values()) {
    const record = pickRecordFromNflProp(candidate, dateKey, now);
    newPickIds.push(record.pickId);
    ctx.waitUntil(env.POTD_KV.put(`nflprops:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
      expirationTtl: KV_TTL_SECONDS,
    }));
  }

  const updatedManifest = {
    date: dateKey,
    pickIds: [...manifest.pickIds, ...newPickIds],
    processedEventIds: [...processed, ...eligible.map((g) => g.id)],
  };
  ctx.waitUntil(env.POTD_KV.put(manifestKey, JSON.stringify(updatedManifest), { expirationTtl: KV_TTL_SECONDS }));

  return { scanned: eligible.length, gameCount: games.length, newPicks: newPickIds.length };
}

export async function runNflPropsGrading(env, ctx, now = Date.now()) {
  const dateKeys = [...new Set(
    Array.from({ length: GRADING_LOOKBACK_DAYS }, (_, i) => etDate(now - i * 86400000)),
  )];
  const loaded = await Promise.all(dateKeys.map((dk) => loadNflPropsTracked(env, dk)));
  const picks = loaded.flatMap((d) => d.picks);
  const pending = picks.filter((p) => p.status === 'pending');
  if (!pending.length) return { graded: 0, remaining: 0 };

  const espnEventIds = [...new Set(pending.map((p) => p.espnEventId))];
  const boxscores = new Map(
    await Promise.all(espnEventIds.map(async (id) => [id, await fetchFinalPassingBoxscore(id, ctx)])),
  );

  let graded = 0;
  for (const pick of pending) {
    const rows = boxscores.get(pick.espnEventId);
    if (!rows) continue; // game not final yet — stays pending
    const row = qbRowByName(rows, pick.playerName);
    const outcome = gradeQbProp(pick, row);
    if (!outcome) continue;
    pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    pick.result = {
      payout: outcome.payout,
      roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
      voidReason: outcome.void ? outcome.reason : undefined,
      actual: outcome.actual ?? undefined,
    };
    graded++;
    ctx.waitUntil(env.POTD_KV.put(`nflprops:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
      expirationTtl: KV_TTL_SECONDS,
    }));
  }
  return { graded, remaining: pending.length - graded };
}
