/**
 * Prop Play of the Day — one high-conviction, safe-line player-prop play per
 * day: a straight, or a 2-leg cross-game parlay when a second leg of the
 * same quality exists (two games so one off night can't sink both legs).
 *
 * Modeled directly on the winning hand-made plays this replaces: legs are
 * ALTERNATE lines deep in a player's comfort zone ("10+ points" at -460,
 * "4+ rebounds" at -310), not the ~-110 standard lines the wnba-props scan
 * tracks (which deliberately caps juice — different product: that one hunts
 * EV, this one hunts near-certainty with a stats case). Conviction is
 * measured, not vibed: every leg must clear season / last-10 hit-rate gates
 * computed from the player's real ESPN game log, and the writeup quotes
 * those same numbers — nothing in the pitch is invented.
 *
 * Cost-conscious by design (see the credit-diet history): the slate's own
 * cached odds fetch finds today's games for free, alternate-market calls
 * are bounded to the soonest few games (3 markets x 1 region each), and
 * every ESPN call (rosters, game logs, boxscores) is free.
 *
 * WNBA-first: it's the season in progress and the shape the hand-made
 * writeups used. The stat plumbing (points/rebounds/assists) is deliberately
 * generic so an NBA/NFL variant is a constants change, not a rewrite.
 */

import { fetchSport, UPSTREAM, REGIONS } from './odds.js';
import { normalizeName } from '../../docs/wnba-props.js';
import { espnAbbr } from '../../docs/team-logos.js';

const KV_TTL_SECONDS = 86400 * 90;
const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba';
const ESPN_GAMELOG = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes';
const ROSTER_TTL = 3600 * 6;
const GAMELOG_TTL = 3600 * 6;
const SUMMARY_TTL = 900;

export const ALT_MARKETS = 'player_points_alternate,player_rebounds_alternate,player_assists_alternate';
const STAT_OF_MARKET = {
  player_points_alternate: 'points',
  player_rebounds_alternate: 'rebounds',
  player_assists_alternate: 'assists',
};
const STAT_LABEL = { points: 'points', rebounds: 'rebounds', assists: 'assists' };

// The "safe line" band per leg: heavier than -650 pays too little even
// inside a parlay; lighter than -250 isn't the near-certainty this product
// promises. Combined 2-leg price is kept at -150 or heavier so the parlay
// stays a safety-first play, not a lottery ticket.
const LEG_DECIMAL_MIN = 1 + 100 / 650; // -650
const LEG_DECIMAL_MAX = 1 + 100 / 250; // -250
const PARLAY_DECIMAL_MAX = 1 + 100 / 150; // -150

// Conviction gates, from the player's real game log.
const MIN_GAMES = 8;
const MIN_SEASON_RATE = 0.75;
const MIN_L10_RATE = 0.8;
const MAX_GAMES_SCANNED = 3;
const MAX_GAMELOG_LOOKUPS = 12;

const GRADING_LOOKBACK_DAYS = 3;

function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const toAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)));
const fmtAmerican = (a) => (a > 0 ? `+${a}` : String(a));

async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/prop-play/${encodeURIComponent(url)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.text();
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
  })));
  return JSON.parse(body);
}

/** ESPN athlete id for a player on one of the game's two teams, via the
 * (free, cached) team rosters — deterministic, no name-search API. */
async function resolveAthleteId(playerName, teamAbbrs, ctx) {
  const target = normalizeName(playerName);
  for (const abbr of teamAbbrs) {
    if (!abbr) continue;
    const roster = await cachedJson(`${ESPN_SITE}/teams/${abbr.toLowerCase()}/roster`, ROSTER_TTL, ctx);
    for (const group of roster?.athletes ?? []) {
      const items = Array.isArray(group?.items) ? group.items : Array.isArray(group) ? group : [group];
      for (const athlete of items) {
        if (athlete?.displayName && normalizeName(athlete.displayName) === target) return athlete.id;
      }
    }
  }
  return null;
}

/**
 * The player's per-game values for one stat, most recent first, parsed from
 * ESPN's common/v3 gamelog (labels array + seasonTypes -> categories ->
 * events with stats arrays). Defensive throughout: an unexpected shape
 * returns [] and the candidate is simply skipped, never guessed.
 */
export function parseGamelogValues(gamelog, statKey) {
  const labels = gamelog?.labels ?? gamelog?.names ?? [];
  const wanted = { points: 'PTS', rebounds: 'REB', assists: 'AST' }[statKey];
  const idx = labels.indexOf(wanted);
  if (idx < 0) return [];
  const eventMeta = gamelog?.events ?? {};
  const rows = [];
  for (const seasonType of gamelog?.seasonTypes ?? []) {
    for (const category of seasonType?.categories ?? []) {
      for (const event of category?.events ?? []) {
        const value = Number(event?.stats?.[idx]);
        if (!Number.isFinite(value)) continue;
        const meta = eventMeta[event.eventId] ?? {};
        rows.push({ value, date: Date.parse(meta.gameDate ?? '') || 0 });
      }
    }
  }
  rows.sort((x, y) => y.date - x.date);
  return rows.map((r) => r.value);
}

/** Hit-rate profile of `values` (most recent first) against `need` (e.g. 10
 * for a 9.5-alternate "10+" line). */
export function hitProfile(values, need) {
  if (!values.length) return null;
  const hits = (list) => list.filter((v) => v >= need).length;
  const rate = (n) => { const slice = values.slice(0, n); return slice.length ? hits(slice) / slice.length : 0; };
  let streak = 0;
  for (const v of values) { if (v >= need) streak++; else break; }
  const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
  return {
    games: values.length,
    season: hits(values) / values.length,
    l10: rate(10),
    l5: rate(5),
    streak,
    avgSeason: Math.round(avg(values) * 10) / 10,
    avgL5: Math.round(avg(values.slice(0, 5)) * 10) / 10,
  };
}

/** Conviction score a leg is ranked by — hit rates first, streak as a kicker. */
const convictionOf = (p) =>
  p.season * 0.35 + p.l10 * 0.35 + p.l5 * 0.15 + (Math.min(p.streak, 15) / 15) * 0.15;

const pct = (r) => `${Math.round(r * 100)}%`;

/** The stats-dense pitch for one leg — every number comes from the game log. */
export function legWriteup(leg) {
  const p = leg.profile;
  const stat = STAT_LABEL[leg.statKey];
  const sentences = [
    `${leg.player} has cleared ${leg.need}+ ${stat} in ${pct(p.season)} of her ${p.games} games this season` +
      (p.streak >= 3 ? `, and is riding a ${p.streak}-game streak of doing it` : '') + `.`,
    `She's hitting ${pct(p.l10)} over her last 10 and ${pct(p.l5)} over her last 5, averaging ` +
      `${p.avgSeason} ${stat} on the season (${p.avgL5} across her last 5) — the ${leg.need}+ line sits ` +
      `well below her normal output.`,
    `Priced ${fmtAmerican(leg.american)} at ${leg.book}.`,
  ];
  return sentences.join(' ');
}

function playWriteup(legs, combinedAmerican) {
  const parts = legs.map((leg) => legWriteup(leg));
  if (legs.length === 2) {
    parts.push(
      `Two legs from two different games at a combined ${fmtAmerican(combinedAmerican)} — ` +
      `each leg stands on its own record, and neither result can drag the other down.`,
    );
  }
  return parts.join('\n\n');
}

async function fetchAltProps(oddsEventId, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/basketball_wnba/events/${oddsEventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', ALT_MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');
  return cachedJson(url.toString(), 3600, ctx);
}

/** Every safe-band Over-alternate from one game's odds payload, best price
 * per player+stat+threshold across books. */
export function extractAltCandidates(eventOdds, game) {
  const best = new Map();
  for (const book of eventOdds?.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      const statKey = STAT_OF_MARKET[market.key];
      if (!statKey) continue;
      for (const outcome of market.outcomes ?? []) {
        if (String(outcome.name ?? '').toLowerCase() !== 'over') continue;
        const player = outcome.description ?? '';
        const point = Number(outcome.point);
        const american = Number(outcome.price);
        if (!player || !Number.isFinite(point) || !Number.isFinite(american)) continue;
        const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
        if (decimal < LEG_DECIMAL_MIN || decimal > LEG_DECIMAL_MAX) continue;
        const key = `${normalizeName(player)}|${statKey}|${point}`;
        if (!best.has(key) || decimal > best.get(key).decimal) {
          best.set(key, {
            player, statKey, point, need: Math.ceil(point), american, decimal,
            book: book.title ?? book.key, game,
          });
        }
      }
    }
  }
  return [...best.values()];
}

/**
 * Build (or return) today's Prop Play. One per day, chosen pregame; once
 * written it never changes — same editorial posture as Play of the Day.
 */
export async function runPropPlayDaily(env, ctx, now = Date.now(), { debug = false } = {}) {
  const dateKey = etDate(now);
  const kvKey = `propplay:${dateKey}`;
  const existing = await env.POTD_KV.get(kvKey);
  if (existing && !debug) return { created: false, record: JSON.parse(existing) };

  const trace = [];
  const { events } = await fetchSport('basketball_wnba', env, ctx);
  const games = (events ?? [])
    .filter((e) => etDate(new Date(e.commence_time).getTime()) === dateKey)
    .filter((e) => new Date(e.commence_time).getTime() > now)
    .sort((x, y) => new Date(x.commence_time) - new Date(y.commence_time))
    .slice(0, MAX_GAMES_SCANNED);
  trace.push(`games today, pregame: ${games.length}`);
  if (!games.length) return { created: false, reason: 'no pregame games today', trace };

  let candidates = [];
  for (const game of games) {
    const odds = await fetchAltProps(game.id, env, ctx);
    const extracted = extractAltCandidates(odds, {
      oddsEventId: game.id, home: game.home_team, away: game.away_team, commence: game.commence_time,
    });
    trace.push(`${game.away_team} @ ${game.home_team}: ${extracted.length} safe-band alternates`);
    candidates = candidates.concat(extracted);
  }
  if (!candidates.length) return { created: false, reason: 'no safe-band alternate lines found', trace };

  // SAFEST line first — heaviest juice = deepest below the player's normal
  // output — and one lookup per player+stat, which keeps each player's
  // deepest-comfort threshold. Confirmed live the other way round: sorting
  // lightest-first shortlisted the most aggressive thresholds in the band
  // (a 20+ line on a 17-ppg scorer), which by construction fail the 75/80%
  // hit-rate gates, and zero legs qualified. The product is Hamby 10+ when
  // she averages 15 — the -460 line with the 87% season record — not the
  // 20+ line priced like a coin flip.
  candidates.sort((x, y) => x.decimal - y.decimal);
  const seen = new Set();
  const shortlist = [];
  for (const c of candidates) {
    const key = `${normalizeName(c.player)}|${c.statKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shortlist.push(c);
    if (shortlist.length >= MAX_GAMELOG_LOOKUPS) break;
  }

  const qualified = [];
  for (const c of shortlist) {
    const abbrs = [espnAbbr('basketball_wnba', c.game.home), espnAbbr('basketball_wnba', c.game.away)];
    const athleteId = await resolveAthleteId(c.player, abbrs, ctx);
    if (!athleteId) { trace.push(`${c.player}: no roster match`); continue; }
    const gamelog = await cachedJson(`${ESPN_GAMELOG}/${athleteId}/gamelog`, GAMELOG_TTL, ctx);
    const profile = hitProfile(parseGamelogValues(gamelog, c.statKey), c.need);
    if (!profile) { trace.push(`${c.player}: empty gamelog`); continue; }
    if (profile.games < MIN_GAMES || profile.season < MIN_SEASON_RATE || profile.l10 < MIN_L10_RATE) {
      trace.push(`${c.player} ${c.need}+ ${c.statKey}: gates missed (n=${profile.games}, season=${pct(profile.season)}, L10=${pct(profile.l10)})`);
      continue;
    }
    qualified.push({ ...c, profile, conviction: convictionOf(profile) });
  }
  trace.push(`qualified legs: ${qualified.length}`);
  if (!qualified.length) return { created: false, reason: 'no leg cleared the conviction gates', trace };

  qualified.sort((x, y) => y.conviction - x.conviction);
  const first = qualified[0];
  const second = qualified.find(
    (c) => c.game.oddsEventId !== first.game.oddsEventId && first.decimal * c.decimal <= PARLAY_DECIMAL_MAX,
  );
  const legs = second ? [first, second] : [first];
  const combinedDecimal = legs.reduce((d, leg) => d * leg.decimal, 1);
  const combinedAmerican = toAmerican(combinedDecimal);

  const record = {
    date: dateKey,
    kind: legs.length === 2 ? 'parlay' : 'straight',
    combinedAmerican,
    combinedDecimal: Math.round(combinedDecimal * 1000) / 1000,
    legs: await Promise.all(legs.map(async (leg) => ({
      player: leg.player,
      statKey: leg.statKey,
      label: `${leg.player} ${leg.need}+ ${STAT_LABEL[leg.statKey]}`,
      need: leg.need,
      point: leg.point,
      american: leg.american,
      book: leg.book,
      home: leg.game.home,
      away: leg.game.away,
      commence: leg.game.commence,
      espnEventId: await resolveWnbaEventId(leg.game, ctx),
      profile: leg.profile,
      status: 'pending',
    }))),
    writeup: playWriteup(legs, combinedAmerican),
    status: 'pending',
    generatedAt: now,
  };
  await env.POTD_KV.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { created: true, record, ...(debug ? { trace } : {}) };
}

async function resolveWnbaEventId(game, ctx) {
  const homeAbbr = espnAbbr('basketball_wnba', game.home);
  const awayAbbr = espnAbbr('basketball_wnba', game.away);
  if (!homeAbbr || !awayAbbr) return null;
  const schedule = await cachedJson(`${ESPN_SITE}/teams/${homeAbbr.toLowerCase()}/schedule`, ROSTER_TTL, ctx);
  const match = (schedule?.events ?? []).find((e) => {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.completed) return false;
    return comp?.competitors?.some((c) => c.team?.abbreviation?.toLowerCase() === awayAbbr.toLowerCase());
  });
  return match?.id ?? null;
}

/** Grade one leg from a final boxscore row; null while the game is live. */
export function gradePropLeg(leg, row) {
  if (!row) return { void: true, reason: 'player not in final boxscore (DNP)' };
  const value = Number(row[leg.statKey]);
  if (!Number.isFinite(value)) return { void: true, reason: 'stat missing from boxscore' };
  return { won: value >= leg.need, actual: value };
}

export async function runPropPlayGrading(env, ctx, now = Date.now()) {
  let graded = 0;
  for (let i = 0; i < GRADING_LOOKBACK_DAYS; i++) {
    const dateKey = etDate(now - i * 86400000);
    const raw = await env.POTD_KV.get(`propplay:${dateKey}`);
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (record.status !== 'pending') continue;

    for (const leg of record.legs) {
      if (leg.status !== 'pending' || !leg.espnEventId) continue;
      const summary = await cachedJson(`${ESPN_SITE}/summary?event=${leg.espnEventId}`, SUMMARY_TTL, ctx);
      if (!summary?.header?.competitions?.[0]?.status?.type?.completed) continue;
      const rows = [];
      for (const team of summary?.boxscore?.players ?? []) {
        const stat = team.statistics?.[0];
        const names = stat?.names ?? [];
        const idx = { points: names.indexOf('PTS'), rebounds: names.indexOf('REB'), assists: names.indexOf('AST') };
        for (const athlete of stat?.athletes ?? []) {
          rows.push({
            name: athlete.athlete?.displayName,
            points: Number(athlete.stats?.[idx.points]),
            rebounds: Number(athlete.stats?.[idx.rebounds]),
            assists: Number(athlete.stats?.[idx.assists]),
          });
        }
      }
      const row = rows.find((r) => normalizeName(r.name) === normalizeName(leg.player)) ?? null;
      const outcome = gradePropLeg(leg, row);
      leg.status = outcome.void ? 'void' : outcome.won ? 'won' : 'lost';
      leg.actual = outcome.actual ?? null;
      if (outcome.void) leg.voidReason = outcome.reason;
    }

    // The play settles once every leg has: any lost leg loses it, any void
    // leg voids it (books reprice a voided leg; being stricter on ourselves
    // keeps the tracked record honest), all won wins it.
    if (record.legs.every((l) => l.status !== 'pending')) {
      record.status = record.legs.some((l) => l.status === 'lost') ? 'lost'
        : record.legs.some((l) => l.status === 'void') ? 'void'
        : 'won';
      graded++;
    }
    await env.POTD_KV.put(`propplay:${dateKey}`, JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  }
  return { graded };
}
