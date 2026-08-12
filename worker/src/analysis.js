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
import { fetchStartingPitchers, fetchSituationalSplits } from './mlb-stats.js';
import { tennisRecentForm, tennisHeadToHead } from '../../docs/insights.js';
import { loadTennisArchive } from './tennis-archive.js';

const MODEL = 'claude-haiku-4-5-20251001';
const CACHE_TTL_DAYS = 2;
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

// Same team name -> ESPN abbreviation mapping as docs/app.js's own
// MLB_ABBR_MAP (used there for the View Stats feature) — duplicated
// server-side rather than shared, matching this codebase's established
// convention of duplicating small parallel data across the worker/docs
// boundary (see tracking.js/potd.js's own FLAT_UNIT_STAKE comments).
// worker/src/mlb-stats.js's ESPN calls key off this abbreviation, not the
// full team name The Odds API hands back.
export const MLB_ABBR_MAP = {
  'Los Angeles Angels': 'laa', 'Baltimore Orioles': 'bal', 'Boston Red Sox': 'bos',
  'New York Yankees': 'nyy', 'Tampa Bay Rays': 'tb', 'Toronto Blue Jays': 'tor',
  'Chicago White Sox': 'chw', 'Cleveland Guardians': 'cle', 'Detroit Tigers': 'det',
  'Kansas City Royals': 'kc', 'Minnesota Twins': 'min', 'Houston Astros': 'hou',
  'Texas Rangers': 'tex',
  'Los Angeles Dodgers': 'lad', 'Oakland Athletics': 'ath', 'Athletics': 'ath',
  'Seattle Mariners': 'sea', 'Arizona Diamondbacks': 'ari', 'Colorado Rockies': 'col',
  'San Diego Padres': 'sd', 'San Francisco Giants': 'sf', 'Atlanta Braves': 'atl',
  'Miami Marlins': 'mia', 'New York Mets': 'nym', 'Philadelphia Phillies': 'phi',
  'Washington Nationals': 'wsh', 'Chicago Cubs': 'chc', 'Cincinnati Reds': 'cin',
  'Milwaukee Brewers': 'mil', 'Pittsburgh Pirates': 'pit', 'St. Louis Cardinals': 'stl',
};
export const mlbAbbr = (teamName) => MLB_ABBR_MAP[teamName] ?? null;

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

/**
 * Real starting-pitcher lines (name, W-L, ERA, WHIP) and situational
 * splits (season/last-10/home-away record) for both sides, from
 * worker/src/mlb-stats.js's already-working ESPN calls — the same data
 * source the live View Stats feature uses, not a separate/duplicated
 * fetch path. `pitchers` is fetchStartingPitchers()'s own {away, home}
 * shape; `awaySplits`/`homeSplits` are fetchSituationalSplits()'s own
 * {season, lastTen, home, away} shape. Any side missing entirely (no
 * probable starter posted yet, a team ESPN doesn't have current standings
 * for) is just omitted rather than guessed.
 */
function baseballFactSheet({ pitchers, awaySplits, homeSplits }, awayTeam, homeTeam) {
  const pitcherLine = (p, team) => {
    if (!p?.name) return null;
    const record = p.wins != null && p.losses != null ? `${p.wins}-${p.losses}` : 'record unknown';
    const era = p.era != null ? `${p.era.toFixed(2)} ERA` : 'ERA unknown';
    const whip = p.whip != null ? `, ${p.whip.toFixed(2)} WHIP` : '';
    const throws = p.throws ? ` (throws ${p.throws})` : '';
    return `${team} starter: ${p.name}${throws}, ${record}, ${era}${whip}.`;
  };

  const splitLine = (splits, team) => {
    if (!splits) return null;
    const parts = [];
    if (splits.season) parts.push(`${splits.season} overall`);
    if (splits.lastTen) parts.push(`${splits.lastTen} last 10`);
    if (splits.home) parts.push(`${splits.home} at home`);
    if (splits.away) parts.push(`${splits.away} on the road`);
    return parts.length ? `${team}: ${parts.join(', ')}.` : null;
  };

  const lines = [
    pitcherLine(pitchers?.away, awayTeam),
    pitcherLine(pitchers?.home, homeTeam),
    splitLine(awaySplits, awayTeam),
    splitLine(homeSplits, homeTeam),
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
  // Always state the head-to-head situation explicitly, even when there
  // isn't one — leaving it out entirely when matchPlayer/tennisHeadToHead
  // comes up empty left the model to guess, and it guessed wrong (claiming
  // "no head-to-head history" for a pair that in reality had a 4-0 record,
  // simply because this archive didn't have it matched). An explicit "no
  // meetings on file" is honest about the data gap; silence invited a
  // hallucinated fact.
  const h2h = tennisHeadToHead(data, awayName, homeName, { filter: ALL_SURFACES });
  lines.push(
    h2h?.meetings.length
      ? `Head-to-head (this archive only, may be incomplete): ${h2h.aName} ${h2h.aWins}, ${h2h.bName} ${h2h.bWins}, most recent on ${h2h.meetings[0].surface ?? 'an unlisted surface'}.`
      : `Head-to-head: no meetings between these two found in this archive. This does not necessarily mean they have never played — only that this archive has no record of it.`,
  );
  return lines.join('\n');
}

function buildPrompt({ away, home, sportTitle, factSheet, pick, isMma = false, isBaseball = false, isPotd = false }) {
  // Play of the Day is the single showcase pick across the whole day's
  // slate, not one game write-up among many — the persona and depth step up
  // accordingly (a sharp bettor's featured-pick column, not a routine game
  // preview), and the JSON below asks for at least 5 reasons instead of 3
  // for exactly that reason.
  const persona = isPotd
    ? `You are a sharp, highly experienced sports betting analyst with years of expertise specifically in ${sportTitle}, writing the daily "Play of the Day" breakdown — the single best value pick this app is featuring across its ENTIRE slate today, not just one game among many. Write with the voice and confidence of someone who has handicapped this sport professionally for years.`
    : `You are a sports analyst writing a short, strictly factual matchup breakdown for a sports app.`;

  let basePrompt = `${persona} Nobody reading this is asking about betting odds, point spreads, moneylines, or market pricing — only about the actual teams or players (this app shows the real sportsbook prices separately, in its own section).

Matchup: ${away} at ${home} (${sportTitle})

Known facts (this is the ONLY information you have — there is no other source):
${factSheet}

This app's own pricing model has already identified "${pick}" as today's pick for this matchup, based on the betting market's own numbers (not shown to you here). Your job is NOT to independently decide who's favored — it's to explain, using only the facts above, why "${pick}" makes sense, and to be honest about the real risks to it. Do not contradict this pick or name the other side as your own lean anywhere in your answer.

RULES — read carefully, these are not optional:
1. Use ONLY the facts given above. Do not state, imply, or assume any statistic, record, ranking, or result that is not explicitly written above.
2. Use the exact names "${away}" and "${home}" exactly as given, character for character. Never alter, merge, abbreviate, or substitute a different (even similar-sounding) name — if you are not completely sure of a name, use the exact string given here rather than reconstructing it from memory.
3. Never invent a head-to-head record, injury, or prior-meeting detail. If the facts above don't mention something, do not mention it either — do not fill silence with a guess, and do not claim something did NOT happen just because it wasn't listed (absence of a fact is not evidence of its opposite).
4. If the facts above are thin or say "no data" / "unknown" for something, say so plainly rather than working around the gap with invented detail — but still build the strongest honest case for "${pick}" available from what's given, even a modest one.
5. Do not mention betting odds, spreads, moneylines, implied probability, vig, or market pricing anywhere in your answer — this is a team/player analysis, not a price analysis.
6. No markdown: no "#" headings, no "**bold**", no bullet points in Part 1. Start Part 1 directly with its first sentence — the app already shows its own title above this text, so a heading here would just be repeated as literal text.
7. Never use an em dash (—) anywhere in your answer, Part 1 or the JSON. Use a period, comma, or parentheses instead.

Write your response in two parts, in this order.

PART 1 — Analysis (plain text, before the JSON described below): ${isPotd ? '8-to-14' : '5-to-10'} sentences of flowing prose, not a bulleted list, using only the facts above. Explain why "${pick}" has the edge — form, head-to-head history, injuries, or statistical tendencies. Also describe how you expect the matchup to actually unfold — pace, tempo, or the likely pattern of play — grounded only in what's stated above.`;

  if (isBaseball) {
    basePrompt += `

CRITICAL FOR BASEBALL:
Explicitly consider pitcher matchup advantages, home/away pitcher performance splits, day vs. night game context, and team travel/time zone adjustments. These factors often outweigh pure team strength. Pay special attention to pitchers new to their team (adjustment period) and recent form (last 10 games ERA). Do NOT invent pitcher information — use only what is provided above.`;
  }

  basePrompt += `

PART 2 — Structured summary: after Part 1, on the very last line and ONLY the last line, output one JSON object (no other text on that line, and none of Part 1's prose repeated inside it) with this exact structure:
{
  "quickTake": [${isPotd ? '<at least 5 reasons, see below>' : '"<short reason 1 \'' + pick + '\' has the edge>", "<short reason 2>", "<short reason 3>"'}],
  "devilsAdvocate": ["<a genuine weakness or risk in "${pick}" that could cause it to lose>", "<a second genuine vulnerability or way this specific pick could fail>"]${isMma ? ',\n  "victoryMethods": { ...see MMA requirement below... }' : ''}
}
`;

  basePrompt += isPotd
    ? `- quickTake: AT LEAST 5 substantive sentences (a full sentence each, not a fragment) on why "${pick}" is today's featured pick, each traceable to a fact given above. Vary the angle across the list rather than restating the same point five ways — draw from whichever of these actually apply here: recent form, head-to-head history, a statistical or stylistic tendency, an injury or availability factor, a situational note (rest, layoff, travel, surface, home/away split). At least ONE entry must be genuinely predictive, not just historical — a concrete claim about how you expect THIS specific matchup to play out (who controls the pace, which side's strength dictates the pattern of play, where the deciding edge shows up), not a restatement of a past record.
- devilsAdvocate: exactly 2 short sentences on genuine weaknesses or risks in "${pick}" specifically — not a case for the other side winning, but honest reasons this exact pick could still lose (a real vulnerability, a matchup risk, a form concern), grounded only in the facts above. Not a token "anything can happen" disclaimer.`
    : `- quickTake: exactly 3 short, punchy sentences (under ~18 words each) on why "${pick}" has the edge — a form/statistical driver, a head-to-head or matchup factor, and a situational note — each traceable to a fact given above.
- devilsAdvocate: exactly 2 short sentences on genuine weaknesses or risks in "${pick}" specifically — not a case for the other side winning, but honest reasons this exact pick could still lose (a real vulnerability, a matchup risk, a form concern), grounded only in the facts above. Not a token "anything can happen" disclaimer.`;

  if (isMma) {
    basePrompt += `

ADDITIONAL REQUIREMENT FOR MMA — "victoryMethods" in the JSON above must give BOTH fighters' top 3 most likely methods of victory, each with your own numeric percentage likelihood (0-100) and a one-sentence reason:
"victoryMethods": {
  "${away}": [
    {"method": "SUB", "percentage": <0-100>, "reasoning": "reason why this fighter might win by submission"},
    {"method": "TKO", "percentage": <0-100>, "reasoning": "reason why this fighter might win by TKO/KO"},
    {"method": "DEC", "percentage": <0-100>, "reasoning": "reason why this fighter might win by decision"}
  ],
  "${home}": [ ...same structure... ]
}
Methods are: SUB (submission), TKO (TKO/KO), DEC (decision). Percentages are your own estimate of how likely each specific method is for that fighter — the three for one fighter do not need to sum to 100 (they're independent paths, not exhaustive of that fighter's full win chance). One quickTake entry should reference "${pick}"'s single most likely method with its percentage (e.g., "Most likely via TKO (38%)"), and devilsAdvocate's second sentence should reference the opponent's most likely method as the concrete way "${pick}" could lose.`;
  }

  return basePrompt;
}

async function callClaude(prompt, env, { maxTokens = 600 } = {}) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
  const data = await response.json();
  return data.content?.[0]?.text?.trim() || null;
}

/**
 * quickTake/devilsAdvocate as the model returns them: an array of short
 * strings. Coerces anything else (missing, wrong type, non-string entries)
 * to null rather than guessing — a missing TL;DR is an obviously-empty UI
 * section; a fabricated one is a hallucination with extra steps. Caps the
 * length so a runaway reply can't turn three bullets into thirty.
 */
function asStringBullets(value, maxItems) {
  if (!Array.isArray(value)) return null;
  const bullets = value.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim());
  return bullets.length ? bullets.slice(0, maxItems) : null;
}

/**
 * MMA's victoryMethods, validated method-by-method: method must be one of
 * the three real values, percentage must be a finite 0-100 number (clamped,
 * or null if the model didn't give a usable one — never fabricated), and
 * reasoning must be a real string. A fighter with no valid entries left
 * after filtering is dropped rather than kept as an empty array.
 */
function sanitizeVictoryMethods(raw) {
  const validMethods = new Set(['SUB', 'TKO', 'DEC']);
  const out = {};
  for (const [fighter, entries] of Object.entries(raw ?? {})) {
    if (!Array.isArray(entries)) continue;
    const cleaned = entries
      .filter((e) => e && validMethods.has(e.method) && typeof e.reasoning === 'string' && e.reasoning.trim())
      .map((e) => ({
        method: e.method,
        percentage: Number.isFinite(e.percentage) ? Math.max(0, Math.min(100, Math.round(e.percentage))) : null,
        reasoning: e.reasoning.trim(),
      }));
    if (cleaned.length) out[fighter] = cleaned;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The cached analysis for one game today, generating and caching it on the
 * first request of the day if it doesn't exist yet. Returns null whenever
 * the feature can't produce a real answer — no API key configured, no
 * research context available for this event, or the model call itself
 * failed — so the caller always has a clean signal to fall back to the
 * existing quantitative price case rather than showing a broken section.
 *
 * `isPotd` requests the richer Play of the Day variant (see buildPrompt): a
 * sharp-bettor persona, a longer Part 1, and at least 5 quickTake reasons
 * instead of 3 — Play of the Day is the one showcase pick across the whole
 * slate, not a routine per-game preview, so it gets a fuller write-up. Kept
 * in its own cache namespace (potd-analysis: vs analysis:) rather than
 * sharing a key with the regular per-game analysis: the two are genuinely
 * different text for the same event/pick, and a POTD game that also shows
 * up on a regular Full Slate card must never silently swap one write-up in
 * for the other depending on which code path asked first.
 */
export async function getOrGenerateAnalysis(candidate, env, ctx, now = Date.now(), { isPotd = false } = {}) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const dateKey = etDate(now);
  // v7 stops asking the model to independently guess who's favored
  // (favoredSide, dropped entirely) and instead tells it which side the
  // app's own pricing model already picked, asking it to build the case for
  // that pick and be honest about its risks in devilsAdvocate — closes off
  // the "algorithm and write-up can silently disagree" bug the old
  // independent-read design allowed. Cache key now includes outcomeName —
  // the write-up is specific to a pick, not just a game, so a game's
  // favorite and its underdog can no longer collide on one shared cache
  // entry written for the other side (this module used to be scoped "per
  // game, shared across every market" on purpose; that assumption no longer
  // holds now that the text itself argues for a specific side). v6 strips a
  // leading markdown "# Heading" the model sometimes prepended to Part 1
  // despite being asked for plain prose — cosmetic (it rendered as literal
  // "# " text, no markdown renderer here) but versioned anyway so today's
  // analyses come back clean rather than waiting out the TTL. v5 added
  // quickTake/devilsAdvocate and MMA percentage likelihoods; v4 fixed the
  // response envelope/anti-hallucination prompt, a trailing-JSON extraction
  // bug, and an MMA token-truncation bug — see prior versions' history in
  // git blame for detail.
  // v8/v2: baseball's fact sheet moved off worker/src/baseball.js's
  // fetchBaseballContext (stale ESPN host, always-null pitcher names — see
  // git history) onto mlb-stats.js's already-working ESPN calls. Bumped so
  // a null result cached under the old, broken path doesn't shadow the fix
  // for the rest of its TTL.
  const kvKey = isPotd
    ? `potd-analysis:v2:${dateKey}:${candidate.eventId}:${candidate.outcomeName}`
    : `analysis:v8:${dateKey}:${candidate.eventId}:${candidate.outcomeName}`;
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
      const awayAbbr = mlbAbbr(candidate.away);
      const homeAbbr = mlbAbbr(candidate.home);
      if (awayAbbr && homeAbbr) {
        const [pitchers, awaySplits, homeSplits] = await Promise.all([
          fetchStartingPitchers(awayAbbr, homeAbbr, ctx),
          fetchSituationalSplits(awayAbbr, ctx),
          fetchSituationalSplits(homeAbbr, ctx),
        ]);
        factSheet = baseballFactSheet({ pitchers, awaySplits, homeSplits }, candidate.away, candidate.home);
      } else {
        console.error(`MLB_ABBR_MAP missing entry for "${awayAbbr ? candidate.home : candidate.away}"`);
      }
    } else if (hasContext(candidate.sportKey)) {
      const context = await fetchContext(
        { sportKey: candidate.sportKey, home: candidate.home, away: candidate.away }, ctx,
      );
      factSheet = teamFactSheet(context);
    }
  } catch (e) {
    console.error('Fact sheet build failed:', e);
    factSheet = null;
  }
  const isMma = isMmaSport(candidate.sportKey);
  // MMA is the one sport where a missing fact sheet must NOT kill the
  // write-up (explicit product direction: EVERY fight card carries the
  // Expected Methods of Victory section). Sherdog misses lesser-known
  // fighters and mismatched spellings routinely, and the methods
  // percentages are the model's own estimates even when stats resolve —
  // so a fight with no sheet proceeds with an honest empty one and firm
  // anti-invention instructions. Every other sport keeps requiring real
  // context: a team write-up without its fact sheet has nothing to argue
  // from.
  if (!factSheet) {
    if (!isMma) return null;
    factSheet = 'No verified stat sheet could be resolved for these fighters. '
      + 'Argue only from widely known, verifiable information about them; if you know '
      + 'little, say so plainly and keep the victory-method percentages conservative '
      + 'and close together rather than inventing confident numbers.';
  }
  // outcomeName is the exact team/player name for h2h and spreads, and
  // literally "Over"/"Under" for totals (see docs/app.js's own comment on
  // this same field) — passed to the model as a given, not something it's
  // asked to independently derive. This is the fix for the algorithm and
  // the write-up being able to contradict each other: the model used to
  // form its own honest, independent read of who's favored, and the client
  // flagged it when that read disagreed with the actual pick. Now the model
  // is told the pick up front and asked to build the case for it (and be
  // honest about its risks in devilsAdvocate) — there's no independent side
  // left to disagree with.
  const pick = candidate.outcomeName;
  const prompt = buildPrompt({
    away: candidate.away,
    home: candidate.home,
    sportTitle: candidate.sportTitle ?? candidate.sportKey,
    factSheet,
    pick,
    isMma,
    isBaseball,
    isPotd,
  });

  // MMA's reply carries a lot more than prose: two fighters x 3 victory
  // methods each with a percentage and a reasoning sentence apiece, plus
  // quickTake/devilsAdvocate on top — 500 tokens (fine for plain prose) was
  // cutting MMA replies off mid-JSON before they could close, which made
  // every MMA analysis fail to parse and fall back to dumping the raw
  // truncated text (JSON fragment included) on screen. Every sport's reply
  // grew with quickTake/devilsAdvocate too, hence the non-MMA bump as well.
  // POTD's own longer Part 1 (8-14 sentences) and 5+-item quickTake need
  // more headroom again on top of that.
  const maxTokens = isMma ? (isPotd ? 1800 : 1400) : (isPotd ? 1300 : 900);
  let text;
  try {
    text = await callClaude(prompt, env, { maxTokens });
  } catch (e) {
    console.error('Anthropic call failed:', e);
    return null;
  }
  if (!text) return null;

  // The model always closes with one trailing JSON object — see buildPrompt
  // — but doesn't reliably put a newline before it (sometimes it runs on
  // straight from the last sentence of prose), so splitting on '\n' and
  // checking only the last line silently missed it about as often as it
  // caught it, leaking raw JSON text into the visible analysis. Searching
  // backward for the last '{' that parses as valid JSON running all the way
  // to the end of the reply works regardless of whitespace.
  let analysis = text;
  let quickTake = null;
  let devilsAdvocate = null;
  let victoryMethods = null;
  const trimmed = text.trim();
  let searchFrom = trimmed.length;
  while (searchFrom > 0) {
    const idx = trimmed.lastIndexOf('{', searchFrom - 1);
    if (idx === -1) break;
    try {
      const parsed = JSON.parse(trimmed.slice(idx));
      analysis = trimmed.slice(0, idx).trim();
      quickTake = asStringBullets(parsed.quickTake, isPotd ? 8 : 4);
      devilsAdvocate = asStringBullets(parsed.devilsAdvocate, 3);
      if (isMma && parsed.victoryMethods) victoryMethods = sanitizeVictoryMethods(parsed.victoryMethods);
      break;
    } catch {
      searchFrom = idx; // that '{' didn't lead to valid JSON — try an earlier one
    }
  }

  // Nothing above parsed — most likely the reply got cut off mid-JSON (a
  // max_tokens truncation, not just a missing trailing object). Rather than
  // ever show a raw, incomplete '{"quickTake": ...' fragment to the user,
  // find where the structured block appears to start and cut the analysis
  // there anyway, even though quickTake/devilsAdvocate/victoryMethods stay
  // null for this one — a shorter analysis is a far smaller problem than a
  // screen full of visible JSON.
  if (analysis === text) {
    const marker = trimmed.indexOf('"quickTake"');
    const braceIdx = marker === -1 ? -1 : trimmed.lastIndexOf('{', marker);
    if (braceIdx !== -1) analysis = trimmed.slice(0, braceIdx).trim();
  }

  // Rule 6 above asks the model to skip a leading markdown heading, but
  // compliance isn't guaranteed — strip a leftover "# Title" or "## Title"
  // first line defensively rather than showing it as literal "# " text
  // (the app has no markdown renderer here, it's a plain <p>).
  analysis = analysis.replace(/^#{1,3}\s+.+\n+/, '').trim();

  const result = JSON.stringify({
    analysis,
    quickTake,
    devilsAdvocate,
    ...(isMma ? { victoryMethods } : {}),
  });

  ctx.waitUntil(env.POTD_KV.put(kvKey, result, { expirationTtl: 86400 * CACHE_TTL_DAYS }));
  return result;
}
