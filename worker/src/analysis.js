/**
 * AI-written matchup analysis — one per game per calendar day (ET), cached,
 * replacing the deterministic no-vig/EV "Market & Price Case" with a
 * qualitative read of the actual team/player factors: records, form,
 * head-to-head, injuries, weather (team sports), Sherdog/UFC.com career
 * data (MMA), or recent form and head-to-head (tennis) — exactly the same
 * underlying context this app already gathers for its bullet-point research,
 * just handed to a model and written as prose instead of computed as bullets.
 *
 * Requires ANTHROPIC_API_KEY as a Cloudflare secret:
 *   wrangler secret put ANTHROPIC_API_KEY
 * Without it, getOrGenerateAnalysis returns null immediately and the caller
 * falls back to the existing quantitative price case — this is additive,
 * never a hard dependency for the rest of the app to keep working.
 *
 * Scoped per GAME, not per market: the same analysis serves every leg on
 * that event (moneyline, spread, total) for the rest of the day, one model
 * call instead of one per market. A matchup preview is legitimately useful
 * context regardless of which side or market a given leg is on — the same
 * reason a real sports column previews the game once, not once per bet type.
 */

import { fetchContext, hasContext } from './context.js';
import { fetchMmaContext } from './mma.js';
import { fetchBaseballContext } from './baseball.js';
import { archivePick } from './learning.js';
import { tennisRecentForm, tennisHeadToHead } from '../../docs/insights.js';

const MODEL = 'claude-haiku-4-5-20251001';
const CACHE_TTL_DAYS = 2;
const TENNIS_ARCHIVE_BASE = 'https://miguelsgarcia4.github.io/PerpetualCode/data';
const ALL_SURFACES = { test: () => true };

function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const isTennisSport = (sportKey) => String(sportKey ?? '').startsWith('tennis_');
const isMmaSport = (sportKey) => sportKey === 'mma_mixed_martial_arts';
const isBaseballSport = (sportKey) => sportKey === 'baseball_mlb';

function isDayGame(commenceTimeStr) {
  if (!commenceTimeStr) return false;
  const date = new Date(commenceTimeStr);
  const hour = date.getUTCHours();
  // Before 5 PM UTC is typically a day game in US time zones
  return hour < 17;
}

// Module-scope: survives across requests in the same isolate, same pattern
// potd.js already uses for this exact static asset.
let tennisCache = null;
async function loadTennisArchive(sportKey) {
  const tour = /wta/i.test(sportKey) ? 'wta' : 'atp';
  tennisCache ??= {};
  if (tennisCache[tour]) return tennisCache[tour];
  try {
    const r = await fetch(`${TENNIS_ARCHIVE_BASE}/tennis-${tour}.json`);
    tennisCache[tour] = r.ok ? await r.json() : null;
  } catch {
    tennisCache[tour] = null;
  }
  return tennisCache[tour];
}

function teamFactSheet(context) {
  if (!context) return null;
  const side = (s) => {
    if (!s) return null;
    const form = (s.lastFive ?? []).map((g) => g.result).join('') || 'unknown';
    const injuries = (s.injuries ?? []).length
      ? s.injuries.map((i) => `${i.name} (${i.status})`).join(', ')
      : 'none reported';
    const splitRecord = s.isHome ? s.homeRecord : s.awayRecord;
    return `${s.name}: ${s.overallRecord ?? 'record unknown'} overall, `
      + `${splitRecord ?? 'unknown'} ${s.isHome ? 'at home' : 'on the road'}. `
      + `Last five results: ${form}. Injuries: ${injuries}.`;
  };
  const lines = [side(context.away), side(context.home)].filter(Boolean);
  if (!lines.length) return null;
  if (context.seriesSummary) lines.push(`Season series so far: ${context.seriesSummary}.`);
  return lines.join('\n');
}

function mmaFactSheet(mmaContext) {
  if (!mmaContext?.a && !mmaContext?.b) return null;
  const side = (f) => {
    if (!f) return null;
    const rec = f.record ? `${f.record.wins}-${f.record.losses}-${f.record.draws}` : 'record unknown';
    const bioParts = [];
    if (f.bio?.height) bioParts.push(`height ${f.bio.height}`);
    if (f.bio?.reach) bioParts.push(`reach ${f.bio.reach}`);
    if (f.bio?.stance) bioParts.push(f.bio.stance);
    const recent = (f.history ?? []).slice(0, 5)
      .map((h) => `${h.result} vs ${h.opponent}${h.method ? ` (${h.method})` : ''}`)
      .join('; ');
    const ufc = f.ufc?.strikingAccuracy != null || f.ufc?.takedownAccuracy != null
      ? ` Career striking accuracy ${f.ufc.strikingAccuracy ?? 'n/a'}%, takedown accuracy ${f.ufc.takedownAccuracy ?? 'n/a'}% (UFC.com).`
      : '';
    return `${f.name}: ${rec}.${bioParts.length ? ` ${bioParts.join(', ')}.` : ''} `
      + `Recent fights: ${recent || 'none on file'}.${ufc}`;
  };
  const lines = [side(mmaContext.a), side(mmaContext.b)].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

function baseballFactSheet(baseballContext, awayTeam, homeTeam, isDay = false) {
  if (!baseballContext) return null;
  const { away, home, awayTeamStats, homeTeamStats } = baseballContext;

  const pitcherInfo = (p, team, isHome) => {
    if (!p) return null;
    let info = `${team}: `;
    if (p.name) info += `pitcher ${p.name}, `;
    if (p.era) info += `ERA ${p.era.toFixed(2)}, `;
    if (p.form) info += `form ${p.form}, `;
    if (p.homeEra && p.awayEra) {
      const splitNote = isHome
        ? `home ERA ${p.homeEra.toFixed(2)}`
        : `away ERA ${p.awayEra.toFixed(2)}`;
      info += `${splitNote}, `;
    }
    if (p.newTeam) info += `new team (adjustment period), `;
    return info.slice(0, -2) + '.';
  };

  const teamContext = (stats, isHome) => {
    if (!stats) return null;
    const dayOrNight = isDay ? 'day' : 'night';
    const winPct = isDay ? stats.dayWinPct : stats.nightWinPct;
    const gameCount = isDay ? stats.dayGameCount : stats.nightGameCount;
    if (gameCount < 3) return null; // Too few games for meaningful split
    return `${dayOrNight.charAt(0).toUpperCase() + dayOrNight.slice(1)} game record: ${(winPct).toFixed(1)}% win rate (${gameCount} games).`;
  };

  const lines = [
    pitcherInfo(away, awayTeam, false),
    pitcherInfo(home, homeTeam, true),
    teamContext(awayTeamStats, isDay),
    teamContext(homeTeamStats, isDay),
  ].filter(Boolean);

  return lines.length ? lines.join('\n') : null;
}

function tennisFactSheet(data, awayName, homeName) {
  if (!data?.matches?.length) return null;
  const form = (name) => {
    const recent = tennisRecentForm(data, name, { limit: 5 });
    if (!recent.length) return `${name}: no recent matches on file.`;
    const list = recent.map((m) => `${m.result} vs ${m.opponent} (${m.surface ?? 'unknown surface'}, ${m.round ?? 'unknown round'})`).join('; ');
    return `${name}: recent form — ${list}.`;
  };
  const lines = [form(awayName), form(homeName)];
  const h2h = tennisHeadToHead(data, awayName, homeName, { filter: ALL_SURFACES });
  if (h2h?.meetings.length) {
    lines.push(`Head-to-head: ${h2h.aName} ${h2h.aWins}, ${h2h.bName} ${h2h.bWins}, most recent on ${h2h.meetings[0].surface ?? 'an unlisted surface'}.`);
  }
  return lines.join('\n');
}

function buildPrompt({ away, home, sportTitle, factSheet, isMma = false, isBaseball = false }) {
  let basePrompt = `You are a sports analyst writing a short matchup breakdown for a sports app. Nobody reading this is asking about betting odds, point spreads, moneylines, or market pricing — only about the actual teams or players.

Matchup: ${away} at ${home} (${sportTitle})

Known facts:
${factSheet}

Write a 5-to-10-sentence analysis of this matchup using only the facts above. Take a clear position on which side has the edge and explain why in plain terms — form, head-to-head history, injuries, or statistical tendencies. Do not mention betting odds, spreads, moneylines, implied probability, vig, or market pricing anywhere in your answer — this is a team/player analysis, not a price analysis. Write flowing prose in a confident, analytical voice, not a bulleted list. If the facts are thin, say so plainly rather than inventing detail.`;

  if (isBaseball) {
    basePrompt += `

CRITICAL FOR BASEBALL:
Explicitly consider pitcher matchup advantages, home/away pitcher performance splits, day vs. night game context, and team travel/time zone adjustments. These factors often outweigh pure team strength. Pay special attention to pitchers new to their team (adjustment period) and recent form (last 10 games ERA). Do NOT invent pitcher information — use only what is provided above.`;
  }

  if (isMma) {
    basePrompt += `

ADDITIONAL REQUIREMENT FOR MMA:
After the main analysis, provide a JSON object on the last line (and only the last line) with this exact structure:
{
  "victoryMethods": {
    "${away}": [
      {"method": "SUB", "reasoning": "reason why this fighter might win by submission"},
      {"method": "DEC", "reasoning": "reason why this fighter might win by decision"},
      {"method": "TKO", "reasoning": "reason why this fighter might win by TKO"}
    ],
    "${home}": [
      {"method": "SUB", "reasoning": "reason why this fighter might win by submission"},
      {"method": "DEC", "reasoning": "reason why this fighter might win by decision"},
      {"method": "TKO", "reasoning": "reason why this fighter might win by TKO"}
    ]
  }
}

The methods should be the TOP 3 most likely ways each fighter can win. Methods are: SUB (submission), DEC (decision), TKO (TKO/KO). Only include the JSON, no other text after the analysis.`;
  }

  return basePrompt;
}

async function callClaude(prompt, env) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
  const data = await response.json();
  return data.content?.[0]?.text?.trim() || null;
}

/**
 * The cached analysis for one game today, generating and caching it on the
 * first request of the day if it doesn't exist yet. Returns null whenever
 * the feature can't produce a real answer — no API key configured, no
 * research context available for this event, or the model call itself
 * failed — so the caller always has a clean signal to fall back to the
 * existing quantitative price case rather than showing a broken section.
 */
export async function getOrGenerateAnalysis(candidate, env, ctx, now = Date.now()) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const dateKey = etDate(now);
  const kvKey = `analysis:${dateKey}:${candidate.eventId}`;
  const cached = await env.POTD_KV.get(kvKey);
  if (cached) return cached;

  let factSheet = null;
  let isBaseball = false;
  try {
    if (isTennisSport(candidate.sportKey)) {
      const data = await loadTennisArchive(candidate.sportKey);
      factSheet = tennisFactSheet(data, candidate.away, candidate.home);
    } else if (isMmaSport(candidate.sportKey)) {
      const mmaContext = await fetchMmaContext({ fighterA: candidate.away, fighterB: candidate.home }, ctx);
      factSheet = mmaFactSheet(mmaContext);
    } else if (isBaseballSport(candidate.sportKey)) {
      isBaseball = true;
      const dayGame = isDayGame(candidate.commence_time);
      const baseballContext = await fetchBaseballContext(
        { awayTeam: candidate.away, homeTeam: candidate.home, awayPitcher: null, homePitcher: null },
        ctx,
      );
      factSheet = baseballFactSheet(baseballContext, candidate.away, candidate.home, dayGame);
    } else if (hasContext(candidate.sportKey)) {
      const context = await fetchContext(
        { sportKey: candidate.sportKey, home: candidate.home, away: candidate.away }, ctx,
      );
      factSheet = teamFactSheet(context);
    }
  } catch {
    factSheet = null;
  }
  if (!factSheet) return null;

  const isMma = isMmaSport(candidate.sportKey);
  const prompt = buildPrompt({
    away: candidate.away,
    home: candidate.home,
    sportTitle: candidate.sportTitle ?? candidate.sportKey,
    factSheet,
    isMma,
    isBaseball,
  });

  let text;
  try {
    text = await callClaude(prompt, env);
  } catch {
    return null;
  }
  if (!text) return null;

  // For MMA, extract victory methods from the response
  let result = text;
  if (isMma) {
    try {
      const lines = text.split('\n');
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine.startsWith('{')) {
        const victoryData = JSON.parse(lastLine);
        const analysis = lines.slice(0, -1).join('\n').trim();
        result = JSON.stringify({
          analysis,
          victoryMethods: victoryData.victoryMethods,
        });
      }
    } catch (e) {
      // If parsing fails, just return the text as-is
      result = text;
    }
  }

  ctx.waitUntil(env.POTD_KV.put(kvKey, result, { expirationTtl: 86400 * CACHE_TTL_DAYS }));
  return result;
}
