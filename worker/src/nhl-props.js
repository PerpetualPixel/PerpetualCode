/**
 * NHL player props — Shots on Goal.
 *
 * Mirrors worker/src/nfl-props.js / worker/src/wnba-props.js closely. One
 * NHL-specific wrinkle in the boxscore shape, confirmed live before writing
 * this (see docs/nhl-props.js's own header for the full story): individual
 * skaters are split across separate `forwards` and `defenses` statistics
 * blocks (a `skaters` block with the same columns exists too, but its own
 * `athletes` array is always empty — a rollup shell, not player rows), so
 * both blocks have to be combined to find every skater. And the column
 * that looks like the obvious match, labeled "SOG", is actually
 * `shootoutGoals` — the real shots-on-goal column is labeled "S", keyed
 * `shotsTotal`. Indexed here by the `keys` array's machine name
 * (`shotsTotal`), not the ambiguous single-letter label.
 */

import { scoreCandidate, RULES, suggestedStake, clearsMaxJuice } from '../../docs/engine.js';
import {
  buildNhlPropCandidates,
  gradeNhlProp,
  nhlPropLiquidityBlock,
  normalizeName,
} from '../../docs/nhl-props.js';
import { espnAbbr } from '../../docs/team-logos.js';
import { UPSTREAM, REGIONS } from './odds.js';
import { getLearningProfile, applyLearningToCandidates } from './daily-learning.js';

const FLAT_UNIT_STAKE = 20;
const KV_TTL_SECONDS = 86400 * 90;
const GRADING_LOOKBACK_DAYS = 2;
const PROP_MARKETS = 'player_shots_on_goal';
const PROPS_WINDOW_HOURS = 3;

const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/hockey/nhl';
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
  const cacheKey = new Request(`https://pixel-pick.cache/nhl-props-espn/${encodeURIComponent(url)}`);
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

/** Every skater's {name, shotsOnGoal} across both teams — forwards + defensemen combined — or null if the game isn't final. */
async function fetchFinalBoxscore(espnEventId, ctx) {
  const summary = await cachedEspnJson(`${ESPN_SITE}/summary?event=${espnEventId}`, SUMMARY_TTL, ctx);
  const completed = summary?.header?.competitions?.[0]?.status?.type?.completed;
  if (!completed) return null;

  const rows = [];
  for (const team of summary?.boxscore?.players ?? []) {
    for (const blockName of ['forwards', 'defenses']) {
      const block = team.statistics?.find((s) => s.name === blockName);
      const idx = block?.keys?.indexOf('shotsTotal') ?? -1;
      if (idx < 0) continue;
      for (const athlete of block.athletes ?? []) {
        rows.push({ name: athlete.athlete?.displayName, shotsOnGoal: Number(athlete.stats?.[idx]) });
      }
    }
  }
  return rows;
}

function rowByName(rows, playerName) {
  const target = normalizeName(playerName);
  const row = (rows ?? []).find((r) => normalizeName(r.name) === target);
  return row ? { shotsOnGoal: row.shotsOnGoal } : null;
}

async function fetchNhlPropsForEvent(oddsEventId, env, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/nhlprops-odds/${oddsEventId}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = new URL(`${UPSTREAM}/sports/icehockey_nhl/events/${oddsEventId}/odds`);
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

function todaysNhlGames(events, dateKey) {
  return (events ?? []).filter((e) => e.sport_key === 'icehockey_nhl' && etDate(new Date(e.commence_time).getTime()) === dateKey);
}

function isWithinPropsWindow(commenceMs, now) {
  const hoursUntil = (commenceMs - now) / 3.6e6;
  return hoursUntil > 0 && hoursUntil <= PROPS_WINDOW_HOURS;
}

async function buildCandidatesForGame(oddsEvent, env, ctx, now) {
  const homeAbbr = espnAbbr('icehockey_nhl', oddsEvent.home_team);
  const awayAbbr = espnAbbr('icehockey_nhl', oddsEvent.away_team);
  const espnEventId = await resolveEspnEventId(homeAbbr, awayAbbr, ctx);
  if (!espnEventId) return [];

  const propsResponse = await fetchNhlPropsForEvent(oddsEvent.id, env, ctx);
  const bookmakers = propsResponse?.bookmakers ?? [];
  if (!bookmakers.length) return [];

  return buildNhlPropCandidates(
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

function pickRecordFromNhlProp(candidate, dateKey, now) {
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

async function loadNhlPropsTracked(env, dateKey) {
  const manifestRaw = await env.POTD_KV.get(`nhlprops:${dateKey}:manifest`);
  if (!manifestRaw) return { pickIds: [], picks: [] };
  const { pickIds } = JSON.parse(manifestRaw);
  const stored = await Promise.all(pickIds.map((id) => env.POTD_KV.get(`nhlprops:${dateKey}:pick:${id}`)));
  return { pickIds, picks: stored.filter(Boolean).map((r) => JSON.parse(r)) };
}

export async function getAllNhlPropsTracked(env, { now = Date.now(), days = 90 } = {}) {
  const dateKeys = Array.from({ length: days }, (_, i) => etDate(now - i * 86400000));
  const perDay = await Promise.all(dateKeys.map((d) => loadNhlPropsTracked(env, d)));
  return perDay.flatMap((d) => d.picks);
}

async function todaysNhlGamesCached(env, dateKey, fetchFullSlate) {
  const cacheKey = `nhlprops:${dateKey}:games`;
  const cached = await env.POTD_KV.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const events = await fetchFullSlate();
  const games = todaysNhlGames(events, dateKey);
  await env.POTD_KV.put(cacheKey, JSON.stringify(games), { expirationTtl: 86400 });
  return games;
}

export async function runNhlPropsScan(env, ctx, now = Date.now(), { fetchFullSlate } = {}) {
  const dateKey = etDate(now);
  const games = await todaysNhlGamesCached(env, dateKey, fetchFullSlate);
  if (!games.length) return { scanned: 0, gameCount: 0 };

  const manifestKey = `nhlprops:${dateKey}:manifest`;
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
    return !nhlPropLiquidityBlock(c, now);
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
    const record = pickRecordFromNhlProp(candidate, dateKey, now);
    newPickIds.push(record.pickId);
    ctx.waitUntil(env.POTD_KV.put(`nhlprops:${dateKey}:pick:${record.pickId}`, JSON.stringify(record), {
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

export async function runNhlPropsGrading(env, ctx, now = Date.now()) {
  const dateKeys = [...new Set(
    Array.from({ length: GRADING_LOOKBACK_DAYS }, (_, i) => etDate(now - i * 86400000)),
  )];
  const loaded = await Promise.all(dateKeys.map((dk) => loadNhlPropsTracked(env, dk)));
  const picks = loaded.flatMap((d) => d.picks);
  const pending = picks.filter((p) => p.status === 'pending');
  if (!pending.length) return { graded: 0, remaining: 0 };

  const espnEventIds = [...new Set(pending.map((p) => p.espnEventId))];
  const boxscores = new Map(
    await Promise.all(espnEventIds.map(async (id) => [id, await fetchFinalBoxscore(id, ctx)])),
  );

  let graded = 0;
  for (const pick of pending) {
    const rows = boxscores.get(pick.espnEventId);
    if (!rows) continue;
    const row = rowByName(rows, pick.playerName);
    const outcome = gradeNhlProp(pick, row);
    if (!outcome) continue;
    pick.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
    pick.result = {
      payout: outcome.payout,
      roiPercent: outcome.void ? 0 : (outcome.payout / pick.suggested_stake) * 100,
      voidReason: outcome.void ? outcome.reason : undefined,
      actual: outcome.actual ?? undefined,
    };
    graded++;
    ctx.waitUntil(env.POTD_KV.put(`nhlprops:${pick.dateKey}:pick:${pick.pickId}`, JSON.stringify(pick), {
      expirationTtl: KV_TTL_SECONDS,
    }));
  }
  return { graded, remaining: pending.length - graded };
}
