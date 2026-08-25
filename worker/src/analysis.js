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
import {
  fetchStartingPitchers, fetchSituationalSplits, fetchTeamStats, fetchLeagueStats,
  fetchPitcherOutings, fetchRecentSchedule, fetchHeadToHead, rankTeamStats,
} from './mlb-stats.js';
import { fetchWeather } from './weather.js';
import { tennisRecentForm, tennisHeadToHead, tennisSurfaceForm, tennisTiebreakForm, tennisGrindLoad } from '../../docs/insights.js';
import { loadTennisArchive } from './tennis-archive.js';
import { surfaceOfEvent } from '../../docs/tennis-tiers.js';

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
  // The A's carry three plausible spellings across the feed's history (the
  // franchise relocated, and ESPN's own slug moved from "oak" to "ath") —
  // all three map to the one current slug so a rename can't silently drop
  // this team's write-up back to no fact sheet at all.
  'Los Angeles Dodgers': 'lad', 'Oakland Athletics': 'ath', 'Athletics': 'ath',
  'Sacramento Athletics': 'ath',
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

/** "4th", "21st", "3rd" — for stating a league rank in prose rather than "rank 4". */
export function ordinal(n) {
  if (!Number.isFinite(n)) return null;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;
}

/**
 * A pitcher's own recent form, rolled up from his last N real outings
 * (worker/src/mlb-stats.js's fetchPitcherOutings). The prompt explicitly
 * asks the model to weigh "recent form (last 10 games ERA)" for baseball,
 * and before this the fact sheet handed it nothing of the kind — only a
 * season-long ERA — so that instruction had no data behind it and the model
 * either ignored it or filled the gap itself. ERA here is computed from the
 * real earned-run and innings totals in those outings, never averaged from
 * per-game ERAs (which would weight a 1-inning outing the same as a 9).
 * Returns null when the log carries no usable innings.
 */
export function pitcherRecentForm(outings) {
  if (!Array.isArray(outings) || !outings.length) return null;
  let outs = 0;
  let earnedRuns = 0;
  let strikeouts = 0;
  let walks = 0;
  let homeRuns = 0;
  let counted = 0;
  for (const o of outings) {
    // ESPN reports innings as "6.2" meaning six innings and two outs — a
    // baseball notation, not a decimal, so ".1"/".2" are thirds and adding
    // these as plain floats would quietly understate the workload.
    const ip = Number.parseFloat(o?.ip);
    if (!Number.isFinite(ip)) continue;
    const whole = Math.trunc(ip);
    const partial = Math.round((ip - whole) * 10);
    outs += whole * 3 + (partial >= 1 && partial <= 2 ? partial : 0);
    earnedRuns += Number(o?.earnedRuns) || 0;
    strikeouts += Number(o?.strikeouts) || 0;
    walks += Number(o?.walks) || 0;
    homeRuns += Number(o?.homeRuns) || 0;
    counted += 1;
  }
  if (!counted || !outs) return null;
  const innings = outs / 3;
  return {
    starts: counted,
    outs,
    innings,
    earnedRuns,
    era: (earnedRuns * 9) / innings,
    strikeouts,
    walks,
    homeRuns,
  };
}

/**
 * Outs back to baseball's own innings notation: 41 outs is "13.2" (thirteen
 * innings and two outs), never "13.7". Writing a decimal here would read as
 * obviously wrong to anyone who follows the sport, and this text is meant to
 * sound like it was written by someone who does.
 */
export function inningsNotation(outs) {
  if (!Number.isFinite(outs) || outs < 0) return null;
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

/** ".268" / ".987" — baseball drops the leading zero on rate stats. */
function rate(value, digits) {
  return Number(value).toFixed(digits).replace(/^0\./, '.');
}

/** "78F, wind 12 mph SW, 20% precip, Partly Cloudy" — only the fields the forecast actually carried. */
function weatherLine(weather) {
  if (!weather) return null;
  const parts = [];
  if (weather.temperatureF != null) parts.push(`${weather.temperatureF}F`);
  if (weather.windSpeed) parts.push(`wind ${weather.windSpeed}${weather.windDirection ? ` ${weather.windDirection}` : ''}`);
  if (weather.precipChance != null) parts.push(`${weather.precipChance}% chance of precipitation`);
  if (weather.shortForecast) parts.push(weather.shortForecast);
  if (!parts.length) return null;
  return `Conditions at first pitch: ${parts.join(', ')}${weather.roof === 'retractable' ? ' (retractable roof, may be closed)' : ''}.`;
}

/**
 * First pitch in ET plus the day/night label. The prompt asks the model to
 * weigh "day vs. night game context" for baseball; without this line that
 * instruction, like the recent-form one above, had no underlying fact to
 * work from. ET rather than the venue's local zone deliberately: this app's
 * whole calendar (dateKey, the 2am board draw, the tracker) is ET, and one
 * consistent zone beats a per-venue one nobody can cross-reference.
 */
export function firstPitchLine(isoDate) {
  const ms = Date.parse(isoDate ?? '');
  if (!Number.isFinite(ms)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const hour24 = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).format(ms));
  // The standard split: anything starting before 5pm local is a day game.
  const label = hour24 < 17 ? 'day game' : 'night game';
  return `First pitch: ${fmt.format(ms)} ET (${label}).`;
}

/** "W 5-3 vs BOS (ATS W -1.5, O 8.5)" for one graded result row. */
function resultRow(g) {
  const markets = [g?.ats ? `ATS ${g.ats}` : null, g?.ou ? `O/U ${g.ou}` : null].filter(Boolean);
  return `${g?.result ?? '?'} ${g?.score ?? ''} vs ${g?.opponentAbbr || g?.opponent || '?'}`
    + `${markets.length ? ` (${markets.join(', ')})` : ''}`;
}

/**
 * The full stat sheet handed to the model for an MLB game.
 *
 * This deliberately reads much wider than the starter-and-record pair it
 * replaced. Every source below already existed, was already proven against
 * live ESPN, and was already being rendered by the Full Slate "View Stats"
 * panel (see the /mlb-stats route in worker/src/index.js, which assembles
 * this identical set) — the write-up simply never saw any of it, so the
 * model was asked for a sharp, numbers-backed read while holding two lines
 * of context. Ranks come from the once-a-day league blob in KV, so the
 * league-wide comparison costs a single KV read rather than 30 fetches.
 *
 * Everything is optional and independently omitted: a team with no probable
 * starter posted, a pitcher with no game log, a game ESPN never priced, a
 * domed venue with no forecast — each simply contributes nothing rather
 * than blocking the sheet or being guessed at.
 */
export function baseballFactSheet(facts, awayTeam, homeTeam) {
  const {
    pitchers, awaySplits, homeSplits, awayStats, homeStats,
    awayForm, homeForm, headToHead, awayOutings, homeOutings, weather,
  } = facts ?? {};

  const sections = [];

  const gameLine = [firstPitchLine(pitchers?.date), weatherLine(weather)].filter(Boolean);
  if (gameLine.length) sections.push(gameLine.join('\n'));

  // --- Starting pitchers, with real recent form ---
  const pitcherBlock = (p, outings, team) => {
    if (!p?.name) return `${team} starter: not yet announced by ESPN.`;
    const bits = [];
    if (p.wins != null && p.losses != null) bits.push(`${p.wins}-${p.losses}`);
    if (p.era != null) bits.push(`${p.era.toFixed(2)} ERA`);
    if (p.whip != null) bits.push(`${p.whip.toFixed(2)} WHIP`);
    if (p.ip != null) bits.push(`${p.ip} IP`);
    if (p.strikeouts != null) bits.push(`${p.strikeouts} K`);
    if (p.walks != null) bits.push(`${p.walks} BB`);
    const head = `${team} starter: ${p.name}${p.throws ? ` (throws ${p.throws})` : ''}`
      + `${bits.length ? `, ${bits.join(', ')} on the season` : ', season line unavailable'}.`;

    const form = pitcherRecentForm(outings);
    if (!form) return head;
    return `${head}\n  Recent form, his last ${form.starts} outings: `
      + `${inningsNotation(form.outs)} IP, ${form.earnedRuns} ER (${form.era.toFixed(2)} ERA over that span), `
      + `${form.strikeouts} K, ${form.walks} BB, ${form.homeRuns} HR allowed.`;
  };
  sections.push(['STARTING PITCHERS',
    pitcherBlock(pitchers?.away, awayOutings, awayTeam),
    pitcherBlock(pitchers?.home, homeOutings, homeTeam),
  ].join('\n'));

  // --- Records and situational splits ---
  const splitLine = (splits, team) => {
    if (!splits) return null;
    const parts = [];
    if (splits.season) parts.push(`${splits.season} overall`);
    if (splits.lastTen) parts.push(`${splits.lastTen} in their last 10`);
    if (splits.home) parts.push(`${splits.home} at home`);
    if (splits.away) parts.push(`${splits.away} on the road`);
    return parts.length ? `${team}: ${parts.join(', ')}.` : null;
  };
  const recordLines = [splitLine(awaySplits, awayTeam), splitLine(homeSplits, homeTeam)].filter(Boolean);
  if (recordLines.length) sections.push(['RECORDS AND SPLITS', ...recordLines].join('\n'));

  // --- Team stats with league rank (1 = best of 30) ---
  const statLine = (ranked, team) => {
    if (!ranked) return null;
    // isRate drops the leading zero (".268 AVG"); ERA and WHIP keep theirs
    // ("3.55 team ERA"), which is how both are written everywhere in the sport.
    const fmt = (entry, label, digits = 2, isRate = false) => {
      if (entry?.value == null) return null;
      const rank = ordinal(entry.rank);
      const shown = isRate ? rate(entry.value, digits) : Number(entry.value).toFixed(digits);
      return `${shown} ${label}${rank ? ` (${rank} of 30)` : ''}`;
    };
    const whole = (entry, label) => {
      if (entry?.value == null) return null;
      const rank = ordinal(entry.rank);
      return `${entry.value} ${label}${rank ? ` (${rank} of 30)` : ''}`;
    };
    const o = ranked.offense ?? {};
    const d = ranked.defense ?? {};
    const offense = [
      fmt(o.battingAvg, 'AVG', 3, true), fmt(o.obpSlugging, 'OPS', 3, true),
      whole(o.runs, 'runs'), whole(o.homeRuns, 'HR'),
      whole(o.walks, 'BB'), whole(o.strikeouts, 'K at the plate'),
      whole(o.stolenBases, 'SB'),
    ].filter(Boolean);
    const defense = [
      fmt(d.era, 'team ERA'), fmt(d.whip, 'team WHIP'),
      whole(d.strikeoutsPitching, 'K on the mound'),
      fmt(d.fieldingPercentage, 'fielding pct', 3, true), whole(d.errors, 'errors'),
    ].filter(Boolean);
    if (!offense.length && !defense.length) return null;
    return [
      offense.length ? `${team} offense: ${offense.join(', ')}.` : null,
      defense.length ? `${team} pitching and defense: ${defense.join(', ')}.` : null,
    ].filter(Boolean).join('\n');
  };
  const statLines = [statLine(awayStats, awayTeam), statLine(homeStats, homeTeam)].filter(Boolean);
  if (statLines.length) {
    sections.push(['SEASON TEAM STATS (league rank in parentheses, 1 = best of 30)', ...statLines].join('\n'));
  }

  // --- Recent results, with the market's own grade where ESPN tracked one ---
  const formLine = (games, team) => {
    if (!Array.isArray(games) || !games.length) return null;
    return `${team} last ${games.length}: ${games.map(resultRow).join('; ')}.`;
  };
  const formLines = [formLine(awayForm, awayTeam), formLine(homeForm, homeTeam)].filter(Boolean);
  if (formLines.length) sections.push(['RECENT RESULTS (most recent first)', ...formLines].join('\n'));

  // --- Season series ---
  if (Array.isArray(headToHead)) {
    sections.push(headToHead.length
      ? `SEASON SERIES\n${awayTeam} in their meetings with ${homeTeam} this season: ${headToHead.map(resultRow).join('; ')}.`
      : `SEASON SERIES\nThese two have no completed meetings on ESPN's schedule for this season. That is a genuine absence of data, not evidence about either side.`);
  }

  // A sheet with nothing but the "not yet announced" pitcher placeholders is
  // not real context — the caller must be able to tell that apart from a
  // sheet that actually resolved something, and fall back accordingly.
  const resolvedAnything = Boolean(
    pitchers?.away?.name || pitchers?.home?.name || recordLines.length
    || statLines.length || formLines.length || (headToHead?.length ?? 0) > 0,
  );
  return resolvedAnything ? sections.join('\n\n') : null;
}

/**
 * Gather everything baseballFactSheet can use, in waves ordered so the
 * shared upstream calls are already in the edge cache by the time the later
 * ones want them: fetchStartingPitchers pulls the away team's season
 * schedule, which fetchHeadToHead and the away team's recent form then read
 * back for free, and the two situational-splits calls both read the single
 * league standings page, so they run in sequence rather than racing each
 * other to two separate misses of the same URL.
 *
 * Every source is individually optional (`safe` swallows its own failure)
 * because this whole sheet is enrichment: a pitcher game log that 404s must
 * cost that one line, never the write-up. Subrequest budget is the real
 * constraint here — this path is also driven from the cron prewarm loop,
 * which is sequential across picks for exactly that reason (see index.js) —
 * so nothing below fans out per-player beyond the two starters.
 */
async function buildBaseballFactSheet(candidate, awayAbbr, homeAbbr, env, ctx) {
  const safe = (p) => Promise.resolve(p).then((v) => v, () => null);

  const pitchers = await safe(fetchStartingPitchers(awayAbbr, homeAbbr, ctx));

  const [awayStatsRaw, homeStatsRaw, leagueStats, awayForm, homeForm, headToHead, weather] = await Promise.all([
    safe(fetchTeamStats(awayAbbr, ctx)),
    safe(fetchTeamStats(homeAbbr, ctx)),
    safe(fetchLeagueStats(env)),
    safe(fetchRecentSchedule(awayAbbr, ctx)),
    safe(fetchRecentSchedule(homeAbbr, ctx)),
    safe(fetchHeadToHead(awayAbbr, homeAbbr, ctx)),
    // commenceMs comes from ESPN's own scheduled date for this game rather
    // than the client, so /analysis keeps its existing query contract.
    pitchers?.date
      ? safe(fetchWeather({
        sportKey: candidate.sportKey, homeTeam: candidate.home, commenceMs: Date.parse(pitchers.date),
      }, ctx))
      : null,
  ]);

  const awaySplits = await safe(fetchSituationalSplits(awayAbbr, ctx));
  const homeSplits = await safe(fetchSituationalSplits(homeAbbr, ctx));

  const [awayOutings, homeOutings] = await Promise.all([
    pitchers?.away?.playerId ? safe(fetchPitcherOutings(pitchers.away.playerId, ctx)) : null,
    pitchers?.home?.playerId ? safe(fetchPitcherOutings(pitchers.home.playerId, ctx)) : null,
  ]);

  const league = Array.isArray(leagueStats) ? leagueStats : [];
  return baseballFactSheet({
    pitchers,
    awaySplits,
    homeSplits,
    awayStats: awayStatsRaw ? rankTeamStats(awayStatsRaw, league) : null,
    homeStats: homeStatsRaw ? rankTeamStats(homeStatsRaw, league) : null,
    awayForm,
    homeForm,
    headToHead,
    awayOutings,
    homeOutings,
    weather,
  }, candidate.away, candidate.home);
}

export function tennisFactSheet(data, awayName, homeName, sportKey) {
  if (!data?.matches?.length) return null;
  const form = (name) => {
    const recent = tennisRecentForm(data, name, { limit: 5 });
    if (!recent.length) return `${name}: no recent matches on file.`;
    const list = recent.map((m) => `${m.result} vs ${m.opponent} (${m.surface ?? 'unknown surface'}, ${m.round ?? 'unknown round'})`).join('; ');
    return `${name}: recent form — ${list}.`;
  };
  const lines = [form(awayName), form(homeName)];

  // Surface-specific form, tiebreak record, and grind load — real, computed
  // facts (docs/insights.js) that used to have no source at all; previously
  // this write-up only ever saw blanket last-5 form regardless of what
  // surface today's match is actually on. surface is null for any
  // tournament docs/tennis-tiers.js's surfaceOfEvent isn't confident about
  // (most 250s) — the two lines below are simply skipped for that player
  // rather than guessed at.
  const surface = surfaceOfEvent(sportKey);
  if (surface) {
    for (const name of [awayName, homeName]) {
      const sf = tennisSurfaceForm(data, name, surface);
      if (sf) lines.push(`${name} on ${surface}: ${sf.wins}-${sf.matches - sf.wins} in their last ${sf.matches} ${surface}-court matches on file (${(sf.winRate * 100).toFixed(0)}% win rate).`);
    }
  }
  for (const name of [awayName, homeName]) {
    const tb = tennisTiebreakForm(data, name);
    if (tb) lines.push(`${name} in tiebreaks: ${tb.won}-${tb.total - tb.won} across their recent matches on file (${(tb.rate * 100).toFixed(0)}% of tiebreak sets won).`);
    const grind = tennisGrindLoad(data, name);
    if (grind) lines.push(`${name}'s last ${grind.matches} matches averaged ${grind.avgSets.toFixed(1)} sets — ${grind.avgSets >= 2.6 ? 'a heavier recent physical load than closing matches in straight sets' : 'mostly straightforward, not a heavy recent physical load'}.`);
  }

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

function buildPrompt({ away, home, sportTitle, factSheet, pick, isMma = false, isBaseball = false, isPotd = false, isAudit = false }) {
  // Play of the Day is the single showcase pick across the whole day's
  // slate, not one game write-up among many — the persona and depth step up
  // accordingly (a sharp bettor's featured-pick column, not a routine game
  // preview), and the JSON below asks for at least 5 reasons instead of 3
  // for exactly that reason.
  //
  // isAudit is Tail or Fade's per-leg "why" — a user auditing their own bet
  // slip, not this app's own featured pick. It gets the same depth step-up
  // as POTD (5-to-8 reasons instead of 3) because that's the whole point of
  // expanding a leg, but a plain analyst persona rather than POTD's "featured
  // pick" one, since an audited leg is the USER's bet, not something this
  // app is endorsing.
  const persona = isPotd
    ? `You are a sharp, highly experienced sports betting analyst with years of expertise specifically in ${sportTitle}, writing the daily "Play of the Day" breakdown — the single best value pick this app is featuring across its ENTIRE slate today, not just one game among many. Write with the voice and confidence of someone who has handicapped this sport professionally for years.`
    : isAudit
      ? `You are a sharp, highly experienced sports betting analyst with years of expertise specifically in ${sportTitle}, giving a detailed matchup breakdown for a user auditing one leg of their own bet slip. Write with the depth of someone who has handicapped this sport professionally, covering multiple distinct angles rather than a quick take.`
      : `You are a sharp, highly experienced sports betting analyst with years of expertise specifically in ${sportTitle}, writing the matchup breakdown behind one of this app's daily picks. Write like a professional handicapper explaining his read to another sharp bettor: specific, numbers-first, and confident about what the data actually supports. Never pad with generic filler ("both teams will look to compete", "it should be a good game") — every sentence has to carry a real fact or a real inference from one.`;

  let basePrompt = `${persona} Nobody reading this is asking about betting odds, point spreads, moneylines, or market pricing — only about the actual teams or players (this app shows the real sportsbook prices separately, in its own section).

Matchup: ${away} at ${home} (${sportTitle})

Known facts (this is the ONLY information you have — there is no other source):
${factSheet}

${isAudit
    ? `A user is auditing "${pick}" as one leg of their own bet slip (this is their bet, not one this app is recommending). Your job is NOT to independently decide who's favored — it's to explain, using only the facts above, the honest case for "${pick}", and to be equally honest about the real risks to it. Do not claim this app picked or endorsed it, and do not name the other side as your own lean anywhere in your answer.`
    : `This app's own pricing model has already identified "${pick}" as today's pick for this matchup, based on the betting market's own numbers (not shown to you here). Your job is NOT to independently decide who's favored — it's to explain, using only the facts above, why "${pick}" makes sense, and to be honest about the real risks to it. Do not contradict this pick or name the other side as your own lean anywhere in your answer.`}

RULES — read carefully, these are not optional:
1. Use ONLY the facts given above. Do not state, imply, or assume any statistic, record, ranking, or result that is not explicitly written above.
2. Use the exact names "${away}" and "${home}" exactly as given, character for character. Never alter, merge, abbreviate, or substitute a different (even similar-sounding) name — if you are not completely sure of a name, use the exact string given here rather than reconstructing it from memory.
3. Never invent a head-to-head record, injury, or prior-meeting detail. If the facts above don't mention something, do not mention it either — do not fill silence with a guess, and do not claim something did NOT happen just because it wasn't listed (absence of a fact is not evidence of its opposite).
4. If the facts above are thin or say "no data" / "unknown" for something, say so plainly rather than working around the gap with invented detail — but still build the strongest honest case for "${pick}" available from what's given, even a modest one.
5. Do not mention betting odds, spreads, moneylines, implied probability, vig, or market pricing anywhere in your answer — this is a team/player analysis, not a price analysis.
6. No markdown: no "#" headings, no "**bold**", no bullet points in Part 1. Start Part 1 directly with its first sentence — the app already shows its own title above this text, so a heading here would just be repeated as literal text.
7a. Cite the actual numbers from the facts above rather than characterising them: write "a 2.98 ERA over his last five starts" or "27th of 30 in team OPS", not "strong recent form" or "a weak offense". A claim with a number attached to it is the whole point of this write-up; a claim without one is filler. Where a league rank is given, prefer it over the raw value alone, since it says how good the number actually is.
7. Never use an em dash (—) anywhere in your answer, Part 1 or the JSON. Use a period, comma, or parentheses instead.

Write your response in two parts, in this order.

PART 1 — Analysis (plain text, before the JSON described below): ${isPotd ? '8-to-14' : '5-to-10'} sentences of flowing prose, not a bulleted list, using only the facts above. Explain why "${pick}" has the edge — form, head-to-head history, injuries, or statistical tendencies. Also describe how you expect the matchup to actually unfold — pace, tempo, or the likely pattern of play — grounded only in what's stated above.`;

  if (isBaseball) {
    basePrompt += `

CRITICAL FOR BASEBALL — the starting pitching matchup is the single biggest driver of a nine-inning game, so lead with it and be specific:
- Compare the two starters directly by the numbers given: season ERA and WHIP, and especially each one's recent-form line (the ERA over his last few outings), which is often a very different pitcher from his season line. Say which side has the edge on the mound and by how much.
- Weigh the offense each starter has to face using the ranked team stats above (OPS, runs, home runs, strikeouts at the plate), not a general impression of the lineup. A top-10 OPS offense against a starter carrying a 5-plus recent ERA is a specific, quantified edge; say it that way.
- Use the bullpen and defense proxies given (team ERA, team WHIP, fielding percentage, errors) when they matter to a total or a close game.
- Factor the situational lines actually provided: home and road splits, last-10 form, the season series, first-pitch time (day vs. night), and the weather at first pitch if given (wind and temperature move run scoring in real, well-understood ways).
Do NOT invent pitcher information, bullpen usage, lineup construction, park factors, or travel/rest details. If a starter is listed as not yet announced, say so plainly and lean on the team-level numbers instead of inventing a pitcher.`;
  }

  basePrompt += `

PART 2 — Structured summary: after Part 1, on the very last line and ONLY the last line, output one JSON object (no other text on that line, and none of Part 1's prose repeated inside it) with this exact structure:
{
  "quickTake": [${isPotd || isAudit ? '<5 to 8 reasons, see below>' : '"<short reason 1 \'' + pick + '\' has the edge>", "<short reason 2>", "<short reason 3>"'}],
  "devilsAdvocate": ["<a genuine weakness or risk in "${pick}" that could cause it to lose>", "<a second genuine vulnerability or way this specific pick could fail>"]${isMma ? ',\n  "victoryMethods": { ...see MMA requirement below... }' : ''}
}
`;

  basePrompt += isPotd
    ? `- quickTake: AT LEAST 5 substantive sentences (a full sentence each, not a fragment) on why "${pick}" is today's featured pick, each traceable to a fact given above. Vary the angle across the list rather than restating the same point five ways — draw from whichever of these actually apply here: recent form, head-to-head history, a statistical or stylistic tendency, an injury or availability factor, a situational note (rest, layoff, travel, surface, home/away split). At least ONE entry must be genuinely predictive, not just historical — a concrete claim about how you expect THIS specific matchup to play out (who controls the pace, which side's strength dictates the pattern of play, where the deciding edge shows up), not a restatement of a past record.
- devilsAdvocate: exactly 2 short sentences on genuine weaknesses or risks in "${pick}" specifically — not a case for the other side winning, but honest reasons this exact pick could still lose (a real vulnerability, a matchup risk, a form concern), grounded only in the facts above. Not a token "anything can happen" disclaimer.`
    : isAudit
      ? `- quickTake: 5 to 8 substantive sentences (a full sentence each, not a fragment) on why "${pick}" has the edge, each traceable to a fact given above. Vary the angle across the list rather than restating the same point several ways — draw from whichever of these actually apply here: recent form, head-to-head history, a statistical or stylistic tendency, an injury or availability factor, a situational note (rest, layoff, travel, surface, home/away split, weather). At least ONE entry must be genuinely predictive, not just historical — a concrete claim about how you expect THIS specific matchup to play out, not a restatement of a past record. If the facts above only support 5 distinct angles, give 5 rather than padding with a repeated point.
- devilsAdvocate: exactly 2 short sentences on genuine weaknesses or risks in "${pick}" specifically — not a case for the other side winning, but honest reasons this exact pick could still lose (a real vulnerability, a matchup risk, a form concern), grounded only in the facts above. Not a token "anything can happen" disclaimer.`
      : `- quickTake: exactly 3 punchy sentences (under ~24 words each) on why "${pick}" has the edge — a form/statistical driver, a head-to-head or matchup factor, and a situational note — each traceable to a fact given above. Every one of the three must contain a specific number from the facts above (an ERA, a rank, a record, a split); a bullet with no number in it is not acceptable here.
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
 * How many quickTake bullets each variant is allowed to keep, matching what
 * buildPrompt actually asked the model for (see its quickTake instructions
 * above) — POTD and audit both ask for more than the default 3, so both cap
 * higher. Exported and pure so the wiring between "what we asked for" and
 * "what we keep" is independently testable without a network call.
 */
export function quickTakeCap(isPotd, isAudit) {
  return isPotd || isAudit ? 8 : 4;
}

/**
 * The KV cache key for one game/pick's write-up. Three disjoint namespaces —
 * one per variant — so a Full Slate card's 3-bullet write-up, a Play of the
 * Day's 5+-bullet showcase write-up, and Tail or Fade's 5-to-8-bullet audit
 * write-up for the SAME event/pick never collide and overwrite one another;
 * each surface always gets back the text shaped for it. Exported and pure
 * for the same reason as quickTakeCap above.
 */
export function analysisCacheKey({ isPotd, isAudit, dateKey, eventId, outcomeName }) {
  // v3/v2/v9: the MLB fact sheet went from two lines (starter line, W-L
  // record) to the full ranked stat sheet the View Stats panel already had,
  // and the default variant's persona moved to the same sharp-bettor voice
  // POTD uses, with every bullet now required to carry a real number. Both
  // change the text materially for every sport, so all three namespaces bump
  // together rather than serving yesterday's thinner write-up for its TTL.
  if (isPotd) return `potd-analysis:v3:${dateKey}:${eventId}:${outcomeName}`;
  if (isAudit) return `audit-analysis:v2:${dateKey}:${eventId}:${outcomeName}`;
  return `analysis:v9:${dateKey}:${eventId}:${outcomeName}`;
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
 * slate, not a routine per-game preview, so it gets a fuller write-up.
 *
 * `isAudit` requests Tail or Fade's per-leg "why" variant: same 5-to-8
 * quickTake depth as POTD, but a plain analyst persona and framing that
 * never claims this app picked or endorsed the leg (it's the user's own bet,
 * pasted from their own slip). Mutually exclusive with isPotd in practice —
 * a POTD pick is never routed through Tail or Fade's audit path — and if
 * both were somehow passed, isPotd wins (see analysisCacheKey/quickTakeCap).
 *
 * Each variant is kept in its own cache namespace (see analysisCacheKey)
 * rather than sharing a key with the others: the three are genuinely
 * different text for the same event/pick, and a game that shows up on more
 * than one surface must never silently swap one write-up in for another
 * depending on which code path asked first.
 */
export async function getOrGenerateAnalysis(candidate, env, ctx, now = Date.now(), { isPotd = false, isAudit = false } = {}) {
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
  const kvKey = analysisCacheKey({ isPotd, isAudit, dateKey, eventId: candidate.eventId, outcomeName: candidate.outcomeName });
  const cached = await env.POTD_KV.get(kvKey);
  if (cached) return cached;

  let factSheet = null;
  let isBaseball = false;
  try {
    if (isTennisSport(candidate.sportKey)) {
      const data = await loadTennisArchive(candidate.sportKey);
      factSheet = tennisFactSheet(data, candidate.away, candidate.home, candidate.sportKey);
    } else if (isMmaSport(candidate.sportKey)) {
      const mmaContext = await fetchMmaContext({ fighterA: candidate.away, fighterB: candidate.home }, ctx);
      factSheet = mmaFactSheet(mmaContext);
    } else if (isBaseballSport(candidate.sportKey)) {
      isBaseball = true;
      const awayAbbr = mlbAbbr(candidate.away);
      const homeAbbr = mlbAbbr(candidate.home);
      if (awayAbbr && homeAbbr) {
        factSheet = await buildBaseballFactSheet(candidate, awayAbbr, homeAbbr, env, ctx);
      } else {
        console.error(`MLB_ABBR_MAP missing entry for "${awayAbbr ? candidate.home : candidate.away}"`);
      }
      // Baseball is the one sport that took a NARROWER research path than the
      // generic ESPN team context while also losing the fallback to it — so a
      // game with no probable starter posted yet, an unmapped team name, or a
      // standings shape ESPN had changed produced no fact sheet at all, and a
      // null fact sheet returns null below: the pick rendered with no write-up
      // whatsoever. cdn.espn.com covers MLB (see context.js's LEAGUE_PATHS),
      // carrying records, last-five form, injuries and the season series, so
      // there is no reason for an MLB pick to ever fall all the way through to
      // nothing. Appended rather than substituted when the baseball sheet did
      // resolve: injuries in particular appear in neither of the sources above.
      const generic = await fetchContext(
        { sportKey: candidate.sportKey, home: candidate.home, away: candidate.away }, ctx,
      ).then(teamFactSheet).catch(() => null);
      if (generic) {
        factSheet = factSheet
          ? `${factSheet}\n\nRECORDS, FORM AND INJURIES (ESPN)\n${generic}`
          : generic;
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
    isAudit,
  });

  // MMA's reply carries a lot more than prose: two fighters x 3 victory
  // methods each with a percentage and a reasoning sentence apiece, plus
  // quickTake/devilsAdvocate on top — 500 tokens (fine for plain prose) was
  // cutting MMA replies off mid-JSON before they could close, which made
  // every MMA analysis fail to parse and fall back to dumping the raw
  // truncated text (JSON fragment included) on screen. Every sport's reply
  // grew with quickTake/devilsAdvocate too, hence the non-MMA bump as well.
  // POTD's and audit's own longer Part 1 and 5+-item quickTake need more
  // headroom again on top of that.
  // The default variant's headroom went up with its persona: a numbers-first
  // write-up spends tokens on the numbers, and a reply truncated mid-JSON
  // falls back to showing prose with no quickTake at all (see the recovery
  // path below), which is exactly the thin result this change is fixing.
  const maxTokens = isMma ? (isPotd || isAudit ? 1800 : 1400) : (isPotd || isAudit ? 1300 : 1200);
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
      quickTake = asStringBullets(parsed.quickTake, quickTakeCap(isPotd, isAudit));
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

/* ------------------------------------------------------------------ */
/* Prop Play of the Day                                                */
/* ------------------------------------------------------------------ */

/**
 * The prop play's own fact sheet: every leg's real line, price, matchup and
 * hit-rate profile, exactly as worker/src/prop-play.js already computed them
 * from the player's ESPN game log.
 *
 * A player prop is not a matchup, so it cannot reuse the game write-up above:
 * "Las Vegas at Seattle" is barely the subject when the bet is whether one
 * player clears 20 points. The numbers that actually decide a prop — how
 * often she has cleared this exact line, her average against it, whether the
 * line sits below her floor rather than near her ceiling — all live on the
 * leg's profile, and none of them appear anywhere in the team fact sheet.
 *
 * Exported and pure so the wiring is testable without a model call.
 */
export function propFactSheet(record) {
  const legs = record?.legs ?? [];
  if (!legs.length) return null;

  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : null);
  const blocks = legs.map((leg, i) => {
    const lines = [`LEG ${i + 1}: ${leg.label} at ${fmtAmericanPrice(leg.american)}${leg.book ? ` (${leg.book})` : ''}`];
    if (leg.away && leg.home) lines.push(`  Game: ${leg.away} at ${leg.home}.`);

    if (leg.kind === 'ml') {
      // A moneyline leg has no game log behind it — its whole case is the
      // price itself, which the model is told not to argue from. Say that
      // plainly rather than leaving it to infer a profile that isn't there.
      lines.push(`  This leg is a straight moneyline on a heavy favorite, not a player prop. `
        + `There is no per-game hit-rate profile for it; judge it only on the team facts you are given, if any.`);
      return lines.join('\n');
    }

    const p = leg.profile;
    if (!p) {
      lines.push('  No game log resolved for this player, so there is no hit-rate history for this line.');
      return lines.join('\n');
    }
    const hitRates = [
      p.season != null ? `${pct(p.season)} of ${p.games} games this season` : null,
      p.l10 != null ? `${pct(p.l10)} over the last 10` : null,
      p.l5 != null ? `${pct(p.l5)} over the last 5` : null,
    ].filter(Boolean);
    if (hitRates.length) lines.push(`  Has cleared this exact ${leg.need}+ line in ${hitRates.join(', ')}.`);
    if (p.avgSeason != null) {
      const cushion = p.avgSeason - leg.need;
      lines.push(`  Season average: ${p.avgSeason}${p.avgL5 != null ? ` (${p.avgL5} across the last 5)` : ''}, `
        + `against a ${leg.need}+ line. That is a cushion of ${cushion >= 0 ? '+' : ''}${Math.round(cushion * 10) / 10} `
        + `between the line and the season average.`);
    }
    if (p.streak >= 2) lines.push(`  Current streak: ${p.streak} straight games clearing ${leg.need}+.`);
    return lines.join('\n');
  });

  const shape = legs.length === 2
    ? `This is a 2-leg parlay at a combined ${fmtAmericanPrice(record.combinedAmerican)}. `
      + `The two legs are deliberately taken from two different games, so one bad night cannot sink both.`
    : `This is a single straight play at ${fmtAmericanPrice(record.combinedAmerican)}.`;

  return `${blocks.join('\n\n')}\n\nSTRUCTURE\n${shape}`;
}

/** "-380" / "+145" — the analysis module's own copy, so this file stays standalone. */
function fmtAmericanPrice(american) {
  const n = Number(american);
  if (!Number.isFinite(n)) return 'an unlisted price';
  return n > 0 ? `+${n}` : String(n);
}

/**
 * The sharp write-up for Prop Play of the Day.
 *
 * Separate entry point from getOrGenerateAnalysis because the subject is
 * different in kind: this argues one two-leg ticket built from player
 * game-log history, not one side of one game, so it takes the whole record
 * rather than a candidate and gets its own prompt and cache namespace. Same
 * contract as the game write-up in every other respect — returns the same
 * {analysis, quickTake, devilsAdvocate} JSON envelope, returns null whenever
 * it can't produce a real answer, and never blocks the play itself.
 */
export async function getOrGeneratePropAnalysis(record, env, ctx, now = Date.now()) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  const factSheet = propFactSheet(record);
  if (!factSheet) return null;

  const dateKey = record.date ?? etDate(now);
  const legKey = (record.legs ?? []).map((l) => l.label).join('|');
  const kvKey = `prop-analysis:v1:${dateKey}:${legKey}`;
  const cached = await env.POTD_KV.get(kvKey);
  if (cached) return cached;

  const prompt = `You are a sharp, highly experienced sports betting analyst who specialises in player props, writing the breakdown behind this app's "Prop Play of the Day" — the single prop ticket it is featuring across the whole slate today. Write like a professional handicapper explaining his read to another sharp bettor: specific, numbers-first, and honest about where the risk actually is.

Known facts (this is the ONLY information you have — there is no other source):
${factSheet}

This app's own model already selected this ticket, from each player's real per-game log. Your job is NOT to re-decide whether to play it — it is to explain, using only the facts above, why these lines are the ones it took, and to be genuinely honest about how the ticket loses.

RULES — read carefully, these are not optional:
1. Use ONLY the facts given above. Do not state, imply, or assume any statistic, injury, minutes projection, matchup detail, defensive ranking, or result that is not explicitly written above.
2. Use each player's and team's name exactly as written above, character for character.
3. Never invent a game log, an opponent's defensive rank, a rest/injury situation, or a head-to-head history. If something is not above, do not mention it. Absence of a fact is not evidence of its opposite.
4. Do not discuss whether the PRICE is good value, implied probability, vig, or line shopping. The app shows pricing separately. Argue the player and the line, not the market.
5. Cite the actual numbers: write "cleared 20+ in 90% of her last 10" or "a 4.3-point cushion between the line and her season average", never "has been consistent" or "is in good form". A claim with no number in it is filler.
6. The whole point of an alternate line this deep is that it sits below the player's floor rather than near her ceiling. Where the cushion supports that, say so in those terms.
7. No markdown: no "#" headings, no "**bold**", no bullet points in Part 1. Start Part 1 directly with its first sentence.
8. Never use an em dash (—) anywhere in your answer. Use a period, comma, or parentheses instead.

Write your response in two parts, in this order.

PART 1 — Analysis (plain text, before the JSON below): 6-to-10 sentences of flowing prose. Take each leg in turn, say what its hit-rate history and cushion actually establish, and then say what has to happen for the ticket as a whole to cash. If this is a parlay, address explicitly what the two legs share and do not share as risks.

PART 2 — Structured summary: after Part 1, on the very last line and ONLY the last line, output one JSON object (no other text on that line, and none of Part 1's prose repeated inside it) with this exact structure:
{
  "quickTake": ["<reason 1>", "<reason 2>", "<reason 3>", "<reason 4 if warranted>"],
  "devilsAdvocate": ["<a genuine way this ticket loses>", "<a second, different genuine way it loses>"]
}
- quickTake: 3 to 4 substantive sentences on why this ticket is today's prop play, each carrying a specific number from the facts above, and each covering a different angle (one per leg at minimum, plus the ticket's overall shape). Do not restate the same hit rate twice.
- devilsAdvocate: exactly 2 short sentences on how this specific ticket actually loses. Be concrete about the real failure modes for a deep alternate line (a blowout cutting a starter's minutes, foul trouble, an unexpected rest day, a single cold shooting night against a line with a thin cushion) and tie each to the facts above where you can. On a parlay, at least one must address that both legs must land. Not a token "anything can happen" disclaimer.`;

  let text;
  try {
    text = await callClaude(prompt, env, { maxTokens: 1200 });
  } catch (e) {
    console.error('Prop analysis call failed:', e);
    return null;
  }
  if (!text) return null;

  // Same trailing-JSON extraction the game write-up uses, and for the same
  // reason: the model does not reliably put a newline before the object.
  let analysis = text;
  let quickTake = null;
  let devilsAdvocate = null;
  const trimmed = text.trim();
  let searchFrom = trimmed.length;
  while (searchFrom > 0) {
    const idx = trimmed.lastIndexOf('{', searchFrom - 1);
    if (idx === -1) break;
    try {
      const parsed = JSON.parse(trimmed.slice(idx));
      analysis = trimmed.slice(0, idx).trim();
      quickTake = asStringBullets(parsed.quickTake, 4);
      devilsAdvocate = asStringBullets(parsed.devilsAdvocate, 3);
      break;
    } catch {
      searchFrom = idx;
    }
  }
  if (analysis === text) {
    const marker = trimmed.indexOf('"quickTake"');
    const braceIdx = marker === -1 ? -1 : trimmed.lastIndexOf('{', marker);
    if (braceIdx !== -1) analysis = trimmed.slice(0, braceIdx).trim();
  }
  analysis = analysis.replace(/^#{1,3}\s+.+\n+/, '').trim();

  const result = JSON.stringify({ analysis, quickTake, devilsAdvocate });
  ctx.waitUntil(env.POTD_KV.put(kvKey, result, { expirationTtl: 86400 * CACHE_TTL_DAYS }));
  return result;
}
