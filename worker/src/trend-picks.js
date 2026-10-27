/**
 * Pixel's Picks, drawn from the Trends rows (2026-10-27 direction): a
 * prop that has landed in every one of the player's last 20 games, and
 * every time against today's opponent, qualifies — and then it is
 * researched before it posts. Is the player on limited minutes, hurt or
 * questionable, a starter, in a likely blowout, facing a lineup change?
 * Every answer has to come back favourable for the line, or the line
 * passes. Anything worth knowing before betting it goes on the card as a
 * note. The lines that pass become the day's bets (buildBets): a parlay
 * near +100 on one of the owner's books, or a straight between -200 and
 * +150, at most two a day, one unit each, graded as one ticket. None is
 * a fine answer.
 *
 * Spends no odds credits: the lines are the rows the Trends build already
 * stored, and the research reads ESPN (free) and, when a key is set, the
 * model. Each pick is graded off the player's game log the morning after
 * and kept for the history.
 */

import { getTrends, TREND_ENABLED_SPORTS } from './trends.js';
import { etParts, etDatePlusDays } from './potd.js';
import { fetchContext, hasContext } from './context.js';
import { fetchBasketballGamelog, basketballStatRows } from './basketball-props.js';
import { fetchNflGamelog, gamelogStatIndex } from './football-props.js';
import { bundlePlayer, loadBundleTeams } from './espn-bundle.js';
import { seasonColumnRows } from '../../docs/prop-legs.js';
import { overNeed, underNeed, attachSeries } from '../../docs/trends.js';
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';

/** A line needs this many logged games at 100% before it is a pick: ten 100%s is a pattern, three is a start. */
export const PICK_MIN_GAMES = 10;
/** How many qualifying lines are researched a day (each is an ESPN read and a model call): enough to build a ticket from. */
export const PICK_MAX_RESEARCHED = 8;
/** Minutes: the last three games against the last twenty. Under this ratio the role has changed. */
export const PICK_MIN_MINUTES_RATIO = 0.8;
/** A win probability this lopsided (either side) is a blowout in the making: starters sit in the fourth. */
export const PICK_BLOWOUT_PROJECTION = 82;
export const PICK_NOTE_PROJECTION = 70;
/** A day with no qualifying line is checked again after this long, until the day's games have started. */
export const RETRY_MINUTES = 60;
const KV_TTL_SECONDS = 86400 * 90;
const MODEL = 'claude-haiku-4-5-20251001';

const key = (dateKey) => `trendpicks:${dateKey}`;
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The books a Pixel's Pick may be priced at (2026-10-27 direction: the
 * owner's own books, and no other). Registry ids from docs/engine.js's
 * SPORTSBOOKS where the registry knows the book, the feed's own key
 * otherwise. A line no listed book offers is not a pick.
 */
export const PICK_BOOKS = ['fanduel', 'draftkings', 'caesars', 'hardrock', 'prizepicks', 'bet365', 'fanatics', 'betmgm', 'sleeper', 'underdog'];
const PICK_BOOK_NAMES = { prizepicks: 'PrizePicks', sleeper: 'Sleeper', underdog: 'Underdog' };
/** One unit, in dollars, for the card and the running total. */
export const UNIT_DOLLARS = 5;
/** Bets a day, at most. */
export const PICK_MAX_BETS = 2;
/** A straight bet's price, and a parlay's; the parlay aims at PARLAY_TARGET. */
export const STRAIGHT_RANGE = [-200, 150];
export const PARLAY_RANGE = [-120, 150];
export const PARLAY_TARGET = 100;
/** A parlay leg's own price: heavy favourites are what make a +100 ticket. */
export const LEG_RANGE = [-450, 150];
/** The stored record's shape; an older day is drawn again. */
export const RECORD_VERSION = 3;

/** The registry id of a quote's book when it is one the picks may use, else null. */
export function pickBookId(bookKey) {
  const id = bookIdFor(bookKey) ?? String(bookKey ?? '').toLowerCase();
  return PICK_BOOKS.includes(id) ? id : null;
}
const pickBookName = (bookId) => SPORTSBOOKS[bookId]?.name ?? PICK_BOOK_NAMES[bookId] ?? bookId;
const pickBookUrl = (bookId) => SPORTSBOOKS[bookId]?.url ?? null;

/** A row's quotes at the listed books, best price first, each with its registry id. */
export function pickQuotes(row) {
  return (row?.quotes ?? [])
    .map((q) => ({ ...q, bookId: pickBookId(q.bookKey) }))
    .filter((q) => q.bookId && Number.isFinite(q.american))
    .sort((a, b) => b.american - a.american);
}

const toAmerican = (decimal) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1)));
const inRange = (american, [lo, hi]) => american >= lo && american <= hi;

/**
 * The Trends lines that qualify today, grouped per player, stat and side:
 * 100% over the last 20 (at least PICK_MIN_GAMES of them), 100% head to
 * head when there is any head to head, today's game, not started, and
 * priced at one of the listed books. Each group carries every qualifying
 * number for the player (the bet builder picks the one that makes the
 * price), best paying first, and `best` is the line the research reads.
 * Groups are ranked by sample, then season rate, then price.
 */
export function qualifyingRows(rows, dateKey, now) {
  const groups = new Map();
  for (const r of rows ?? []) {
    if (!r || r.commenceMs <= now || etParts(r.commenceMs).date !== dateKey) continue;
    const l20 = r.periods?.l20;
    if (!l20 || l20.rate !== 1 || l20.games < PICK_MIN_GAMES) continue;
    const h2h = r.periods?.h2h;
    if (h2h?.games > 0 && h2h.rate !== 1) continue;
    const quotes = pickQuotes(r);
    if (!quotes.length) continue;
    const line = { ...r, quotes, american: quotes[0].american, decimal: quotes[0].decimal ?? americanToDecimal(quotes[0].american), book: pickBookName(quotes[0].bookId), bookId: quotes[0].bookId, bookKey: quotes[0].bookKey, link: quotes[0].link ?? null };
    const k = `${fold(r.playerName)}|${r.statKey}|${r.side}`;
    if (!groups.has(k)) groups.set(k, { key: k, playerName: r.playerName, statKey: r.statKey, side: r.side, sportKey: r.sportKey, eventId: r.eventId, lines: [] });
    groups.get(k).lines.push(line);
  }
  const seasonRate = (r) => { const s = r.seasons?.[0]; return s ? (r.periods?.[`s${s}`]?.rate ?? 0) : 0; };
  const out = [...groups.values()];
  for (const g of out) { g.lines.sort((a, b) => b.american - a.american); g.best = g.lines[0]; }
  return out.sort((a, b) => (b.best.periods.l20.games - a.best.periods.l20.games) || (seasonRate(b.best) - seasonRate(a.best)) || (b.best.american - a.best.american));
}

/**
 * The day's bets from the groups that passed research, in rank order:
 * at most PICK_MAX_BETS, one unit each. A parlay first when one lands in
 * PARLAY_RANGE: two legs (three when that is what fits), every leg on the
 * same book, different players, the same sport, the price nearest
 * PARLAY_TARGET, legs from different games preferred. Then a second
 * parlay from the groups left over, else the best straight in
 * STRAIGHT_RANGE. With no parlay, straights for the top groups. A group
 * with no line at a usable price is left alone.
 */
export function buildBets(groups, { maxBets = PICK_MAX_BETS } = {}) {
  const ranked = (groups ?? []).map((g, rank) => ({ ...g, rank }));
  const legOptions = (g, bookId, range) => g.lines.flatMap((line) => line.quotes
    .filter((q) => q.bookId === bookId && inRange(q.american, range))
    .map((q) => ({ group: g, line, bookId, american: q.american, decimal: q.decimal ?? americanToDecimal(q.american), link: q.link ?? null })));
  const books = [...new Set(ranked.flatMap((g) => g.lines.flatMap((l) => l.quotes.map((q) => q.bookId))))];

  const bestParlay = (pool) => {
    let best = null;
    const consider = (legs) => {
      if (legs.some((l, i) => legs.slice(i + 1).some((m) => fold(m.group.playerName) === fold(l.group.playerName)))) return;
      const decimal = legs.reduce((d, l) => d * l.decimal, 1);
      const american = toAmerican(decimal);
      if (!inRange(american, PARLAY_RANGE)) return;
      const games = new Set(legs.map((l) => l.group.eventId)).size;
      const score = Math.abs(american - PARLAY_TARGET) + (legs.length - games) * 15 + (legs.length - 2) * 10 + legs.reduce((s, l) => s + l.group.rank, 0) * 2;
      if (!best || score < best.score) best = { legs, decimal, american, score };
    };
    for (const bookId of books) {
      const bySport = new Map();
      for (const g of pool) {
        const opts = legOptions(g, bookId, LEG_RANGE);
        if (!opts.length) continue;
        if (!bySport.has(g.sportKey)) bySport.set(g.sportKey, []);
        bySport.get(g.sportKey).push(opts);
      }
      for (const groupsOpts of bySport.values()) {
        for (let i = 0; i < groupsOpts.length; i++) for (let j = i + 1; j < groupsOpts.length; j++) {
          for (const a of groupsOpts[i]) for (const b of groupsOpts[j]) consider([a, b]);
          for (let k = j + 1; k < groupsOpts.length; k++) for (const a of groupsOpts[i]) for (const b of groupsOpts[j]) for (const c of groupsOpts[k]) consider([a, b, c]);
        }
      }
    }
    return best;
  };
  const bestStraight = (pool) => {
    for (const g of pool) {
      const opts = g.lines.flatMap((line) => line.quotes.filter((q) => inRange(q.american, STRAIGHT_RANGE)).map((q) => ({ group: g, line, bookId: q.bookId, american: q.american, decimal: q.decimal ?? americanToDecimal(q.american), link: q.link ?? null })));
      if (!opts.length) continue;
      opts.sort((a, b) => b.american - a.american);
      return { legs: [opts[0]], decimal: opts[0].decimal, american: opts[0].american };
    }
    return null;
  };

  const bets = [];
  let pool = ranked;
  while (bets.length < maxBets && pool.length) {
    const parlay = pool.length >= 2 ? bestParlay(pool) : null;
    const bet = parlay ?? bestStraight(pool);
    if (!bet) break;
    bets.push({ type: bet.legs.length > 1 ? 'parlay' : 'straight', legs: bet.legs, american: bet.american, decimal: bet.decimal });
    const used = new Set(bet.legs.map((l) => l.group.key));
    pool = pool.filter((g) => !used.has(g.key));
  }
  return bets;
}

/**
 * The player's game log: the runner's bundled record for the player's
 * team first (espn-bundle.js — ESPN refuses the worker directly), then
 * the league's own fetch.
 */
async function gamelogFor(env, sportKey, team, athleteId, ctx) {
  const bundled = await bundlePlayer(env, sportKey, team, athleteId).catch(() => null);
  if (bundled?.log) return bundled.log;
  if (sportKey === 'basketball_nba') return fetchBasketballGamelog(sportKey, athleteId, ctx).catch(() => null);
  if (sportKey === 'americanfootball_nfl') return fetchNflGamelog(athleteId, ctx).catch(() => null);
  return null;
}

/** The player's minutes per game, most recent first, from the league's game log; [] when the league has none. */
async function minutesFor(row, env, ctx) {
  if (!row.athleteId) return [];
  if (row.sportKey === 'basketball_nba') {
    const log = await gamelogFor(env, row.sportKey, row.team, row.athleteId, ctx);
    return basketballStatRows(log, 'minutes', { allSeasons: false }).map((r) => r.value);
  }
  return [];
}

/**
 * Both teams' injury reports from the bundled rosters, in the shape the
 * ESPN summary gives (context.js), for when the summary is out of reach.
 */
async function bundledInjuries(env, row) {
  const sides = [];
  for (const abbr of [row.team, row.opponent]) {
    if (!abbr) continue;
    const teams = await loadBundleTeams(env, row.sportKey, [abbr]).catch(() => new Map());
    const record = teams.get(String(abbr).toUpperCase());
    if (!record) continue;
    sides.push({
      name: abbr,
      injuries: record.players.flatMap((p) => (p.injuries ?? []).map((i) => ({ name: p.name, status: i.status ?? '', detail: i.detail ?? '' }))),
    });
  }
  return sides;
}

/** Status words that say the player may not play, or may not play his usual minutes. */
const OUT_STATUS = /\b(out|doubtful|questionable|suspended|injured reserve|ir)\b/i;
const DAY_TO_DAY = /\b(day-to-day|day to day|probable|game time decision|gtd)\b/i;

/**
 * Research one qualifying line. Returns { verdict: 'post' | 'pass',
 * flags: [...], note } — `flags` are the facts found, `note` is what a
 * bettor should know before betting it (null when nothing). The checks:
 *
 *   minutes   the last three games' minutes against the last twenty: a
 *             drop past PICK_MIN_MINUTES_RATIO is a changed role — pass.
 *   health    the player on the injury report as out, doubtful or
 *             questionable — pass; day-to-day — a note.
 *   role      under 24 minutes a game is a bench role — a note, the line
 *             is still his.
 *   blowout   ESPN's win projection past PICK_BLOWOUT_PROJECTION either
 *             way — pass; past PICK_NOTE_PROJECTION — a note.
 *   lineup    a teammate on the report as out — a note (the usage shifts).
 *   matchup   the model, given every fact above, the log and the
 *             opponent: a defender or scheme that hinders the line, or a
 *             lineup change it knows of, is a pass; otherwise its line
 *             becomes the note.
 */
export async function researchPick(row, env, ctx, { now = Date.now(), deps = {} } = {}) {
  const flags = [];
  const notes = [];
  let verdict = 'post';
  const pass = (why) => { verdict = 'pass'; flags.push(`pass: ${why}`); };

  const minutes = await (deps.minutes ? deps.minutes(row) : minutesFor(row, env, ctx));
  let minutesLine = null;
  if (minutes.length >= 5) {
    const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
    const l20 = avg(minutes.slice(0, 20));
    const l3 = avg(minutes.slice(0, 3));
    minutesLine = `${l3.toFixed(1)} minutes over the last three games, ${l20.toFixed(1)} over the last twenty`;
    if (l3 < l20 * PICK_MIN_MINUTES_RATIO) pass(`minutes are down: ${minutesLine}`);
    else if (minutes[0] < 15) pass(`played ${minutes[0]} minutes last game`);
    else if (l20 < 24) { flags.push('bench role'); notes.push(`Plays about ${Math.round(l20)} minutes a game, a bench role; the line is still his at that workload.`); }
  }

  const context = await (deps.context ? deps.context(row) : (hasContext(row.sportKey) ? fetchContext({ sportKey: row.sportKey, home: row.home, away: row.away }, ctx).catch(() => null) : null));
  const mine = context ? (fold(context.home?.name) === fold(row.home) ? context.home : context.away) : null;
  const theirs = context ? (mine === context.home ? context.away : context.home) : null;
  const sideFor = (team) => (row.team && context ? (String(team?.shortName ?? '').toUpperCase() === row.team || fold(team?.name).includes(fold(row.home)) === (row.team === row.home) ? team : team) : team);
  void sideFor;
  const player = fold(row.playerName);
  const injurySides = context ? [context.home, context.away].filter(Boolean) : await (deps.injuries ? deps.injuries(row) : bundledInjuries(env, row));
  for (const side of injurySides) {
    for (const inj of side.injuries ?? []) {
      const name = fold(inj.name ?? inj.athlete ?? inj.player);
      const status = String(inj.status ?? inj.type ?? '');
      if (!name) continue;
      if (name === player) {
        if (OUT_STATUS.test(status)) pass(`listed ${status.toLowerCase()} on the injury report`);
        else if (DAY_TO_DAY.test(status)) { flags.push(`day to day: ${status}`); notes.push(`Listed ${status.toLowerCase()} on the injury report; confirm he is in the lineup before betting.`); }
      }
    }
  }
  if (mine && Array.isArray(mine.injuries)) {
    const teammatesOut = mine.injuries.filter((inj) => fold(inj.name ?? inj.athlete ?? inj.player) !== player && OUT_STATUS.test(String(inj.status ?? inj.type ?? '')));
    if (teammatesOut.length) {
      const names = teammatesOut.slice(0, 3).map((inj) => inj.name ?? inj.athlete ?? inj.player).join(', ');
      flags.push(`lineup change: ${names} out`);
      notes.push(`${names} ${teammatesOut.length === 1 ? 'is' : 'are'} out for his team, so the usage shifts; the last 20 games were with a different lineup.`);
    }
  }
  if (context?.projection) {
    const h = Number(context.projection.home); const a = Number(context.projection.away);
    const top = Math.max(h || 0, a || 0);
    if (top >= PICK_BLOWOUT_PROJECTION) pass(`ESPN projects a ${Math.round(top)}% favourite, a likely blowout`);
    else if (top >= PICK_NOTE_PROJECTION) { flags.push(`blowout watch: ${Math.round(top)}%`); notes.push(`ESPN projects a ${Math.round(top)}% favourite; a blowout would cut fourth-quarter minutes.`); }
  }

  if (verdict === 'post') {
    const facts = [
      `Line: ${row.selection} at ${row.american} (${row.book}).`,
      `Last 20 games: landed ${row.periods.l20.hits} of ${row.periods.l20.games}; average ${row.periods.l20.avg}, median ${row.periods.l20.median}.`,
      row.periods.h2h?.games ? `Against ${row.opponent}: landed ${row.periods.h2h.hits} of ${row.periods.h2h.games}.` : `No games against ${row.opponent} in the log.`,
      minutesLine ? `Minutes: ${minutesLine}.` : null,
      mine ? `${mine.name}: ${mine.overallRecord ?? 'record unknown'}, last five ${mine.lastFive ?? 'unknown'}.` : null,
      theirs ? `${theirs.name}: ${theirs.overallRecord ?? 'record unknown'}, last five ${theirs.lastFive ?? 'unknown'}.` : null,
      theirs?.injuries?.length ? `${theirs.name} injury report: ${theirs.injuries.slice(0, 5).map((i) => `${i.name ?? i.athlete ?? i.player} (${i.status ?? i.type ?? ''})`).join('; ')}.` : null,
      flags.length ? `Flags so far: ${flags.join('; ')}.` : null,
    ].filter(Boolean).join('\n');
    const prompt = `You vet one player prop before it is posted as a Pixel's Pick. Use only the facts below and what you know of these teams' rotations and defensive matchups in general; do not invent news. Answer the checklist and decide.

${facts}

Checklist: Is anything here likely to hinder the line today: a defender or scheme the opponent uses on this player, a changed role, a back-to-back, or a lineup change you can infer from the facts? If a fact above makes the line unsafe, answer pass. Otherwise answer post, and write one plain sentence a bettor should read before betting it, or "none" if there is nothing worth saying.

Reply with JSON only: {"verdict":"post"|"pass","reason":"<one sentence>","note":"<one sentence or none>"}`;
    const text = await (deps.model ? deps.model(prompt) : callModel(prompt, env));
    const parsed = parseVerdict(text);
    if (parsed) {
      if (parsed.verdict === 'pass') pass(parsed.reason || 'the matchup read came back against the line');
      else if (parsed.note && !/^none\b/i.test(parsed.note)) notes.push(parsed.note);
      if (parsed.reason && parsed.verdict !== 'pass') flags.push(`matchup: ${parsed.reason}`);
    } else {
      flags.push('matchup read unavailable');
    }
  }

  return { verdict, flags, note: notes.length ? notes.join(' ') : null };
}

async function callModel(prompt, env) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

/** The model's JSON, or null when it sent anything else. */
export function parseVerdict(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o.verdict !== 'post' && o.verdict !== 'pass') return null;
    return { verdict: o.verdict, reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 240) : '', note: typeof o.note === 'string' ? o.note.trim().slice(0, 300) : '' };
  } catch {
    return null;
  }
}

/** The stored leg: what the card shows and what the grader needs. */
function legRecord(leg, research, now) {
  const row = leg.line;
  return {
    id: row.id,
    postedAt: now,
    sportKey: row.sportKey,
    sportTitle: row.sportTitle,
    eventId: row.eventId,
    commenceMs: row.commenceMs,
    gameDate: etParts(row.commenceMs).date,
    home: row.home,
    away: row.away,
    team: row.team,
    opponent: row.opponent,
    playerName: row.playerName,
    athleteId: row.athleteId,
    headshot: row.headshot,
    statKey: row.statKey,
    statLabel: row.statLabel,
    marketLabel: row.marketLabel,
    point: row.point,
    side: row.side,
    selection: row.selection,
    american: leg.american,
    decimal: leg.decimal,
    bookId: leg.bookId,
    book: pickBookName(leg.bookId),
    link: leg.link,
    quotes: (row.quotes ?? []).slice(0, 8),
    rates: row.rates,
    periods: { l5: row.periods.l5, l10: row.periods.l10, l20: row.periods.l20, h2h: row.periods.h2h },
    series: (row.series ?? []).slice(0, 20),
    note: research.note,
    flags: research.flags,
    actual: null,
    result: null,
  };
}

/** The stored bet: one ticket, one unit, graded as a whole. */
function betRecord(bet, index, dateKey, research, now) {
  const legs = bet.legs.map((leg) => legRecord(leg, research.get(leg.group.key), now));
  const bookId = bet.legs[0].bookId;
  return {
    id: `${dateKey}:${index + 1}`,
    postedAt: now,
    type: bet.type,
    sportKey: legs[0].sportKey,
    sportTitle: legs[0].sportTitle,
    bookId,
    book: pickBookName(bookId),
    bookUrl: pickBookUrl(bookId),
    link: bet.type === 'straight' ? legs[0].link : null,
    american: bet.american,
    decimal: Math.round(bet.decimal * 10000) / 10000,
    units: 1,
    stake: UNIT_DOLLARS,
    commenceMs: Math.min(...legs.map((l) => l.commenceMs)),
    legs,
    status: 'pending',
    result: null,
    net: null,
    settledAt: null,
  };
}

/**
 * Draw today's bets from the Trends rows. The groups that qualify are
 * researched in rank order (up to PICK_MAX_RESEARCHED), the ones that
 * pass become the day's bets (buildBets), and the day is final once any
 * bet posts. A day with nothing to post is checked again every
 * RETRY_MINUTES until its games start, since the rows fill in over the
 * morning. A day stored by an older build is drawn again.
 */
export async function runTrendPicksDaily(env, ctx, now = Date.now(), { deps = {}, enabled = TREND_ENABLED_SPORTS } = {}) {
  const dateKey = etParts(now).date;
  const raw = await env.POTD_KV.get(key(dateKey));
  const stored = raw ? JSON.parse(raw) : null;
  const existing = stored?.version === RECORD_VERSION ? stored : null;
  if (existing?.final) return { skipped: true, reason: 'posted', dateKey };
  if (existing && now - (existing.checkedAt ?? 0) < RETRY_MINUTES * 60e3) return { skipped: true, reason: 'checked recently', dateKey };

  const rows = [];
  for (const sportKey of enabled) {
    const stored = deps.rowsFor ? await deps.rowsFor(sportKey) : await getTrends(env, sportKey).then((t) => attachSeries(t?.rows, t?.logs));
    rows.push(...(stored ?? []));
  }
  const groups = qualifyingRows(rows, dateKey, now);
  // Only a line some listed book prices inside LEG_RANGE can sit on a
  // ticket, so a line priced -1100 everywhere is not worth a research
  // call: the day's calls go to the lines that could post.
  const usable = groups.filter((g) => g.lines.some((l) => l.quotes.some((q) => inRange(q.american, LEG_RANGE))));
  const research = new Map();
  const passed = [];
  const posted = [];
  for (const g of usable.slice(0, PICK_MAX_RESEARCHED)) {
    if (posted.some((p) => fold(p.playerName) === fold(g.playerName))) continue;
    const r = await researchPick(g.best, env, ctx, { now, deps });
    if (r.verdict === 'post') { research.set(g.key, r); posted.push(g); }
    else passed.push({ selection: g.best.selection, reasons: r.flags.filter((f) => f.startsWith('pass:')).map((f) => f.slice(6)) });
  }
  const bets = buildBets(posted).map((b, i) => betRecord(b, i, dateKey, research, now));
  // A line that passed research but is on no ticket: the day's two bets
  // were already full, or no listed book priced it in range.
  const betLegs = new Set(bets.flatMap((b) => b.legs.map((l) => fold(l.playerName))));
  const unused = posted.filter((g) => !betLegs.has(fold(g.playerName))).map((g) => ({ selection: g.best.selection, reason: bets.length >= PICK_MAX_BETS ? 'two bets a day' : 'no ticket at a usable price' }));
  const record = {
    version: RECORD_VERSION,
    date: dateKey,
    generatedAt: existing?.generatedAt ?? now,
    checkedAt: now,
    final: bets.length > 0,
    considered: groups.length,
    usable: usable.length,
    bets,
    passed,
    unused,
  };
  await env.POTD_KV.put(key(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { skipped: false, dateKey, posted: bets.length, considered: groups.length, passed: passed.length };
}

/** The player's value for the leg's stat on the leg's game date, from the game log, or null when the log has no such game yet. */
async function actualFor(pick, env, ctx, deps = {}) {
  if (deps.actual) return deps.actual(pick);
  if (!pick.athleteId) return null;
  let rows = [];
  const log = await gamelogFor(env, pick.sportKey, pick.team, pick.athleteId, ctx);
  if (pick.sportKey === 'basketball_nba') rows = basketballStatRows(log, pick.statKey, { allSeasons: false });
  else if (pick.sportKey === 'americanfootball_nfl') rows = seasonColumnRows(log, gamelogStatIndex(log, pick.statKey));
  const row = rows.find((r) => r.date && etParts(r.date).date === pick.gameDate);
  return row ? row.value : null;
}

/** Settle a leg against the actual: push on the number for an integer line, else over or under the line. */
export function settle(pick, actual) {
  if (!Number.isFinite(actual)) return null;
  if (Number.isInteger(pick.point) && actual === pick.point) return 'push';
  const won = pick.side === 'over' ? actual >= overNeed(pick.point) : actual <= underNeed(pick.point);
  return won ? 'win' : 'loss';
}

/**
 * Settle a bet from its legs' results, the way a book does: any lost leg
 * loses the ticket; a pushed or voided leg drops out and the ticket pays
 * at the legs left; a ticket with no legs left is a push. Returns
 * { result, net } in units, or null while a leg is still unsettled.
 */
export function settleBet(bet) {
  const legs = bet.legs ?? [];
  if (legs.some((l) => l.result == null)) return null;
  const units = bet.units ?? 1;
  if (legs.some((l) => l.result === 'loss')) return { result: 'loss', net: -units };
  const live = legs.filter((l) => l.result === 'win');
  if (!live.length) return { result: legs.every((l) => l.result === 'void') ? 'void' : 'push', net: 0 };
  const decimal = live.reduce((d, l) => d * (l.decimal ?? americanToDecimal(l.american)), 1);
  return { result: 'win', net: Math.round(units * (decimal - 1) * 100) / 100 };
}

/** Grade pending bets from the last three days once their games are over; a player with no game in the log a day and a half on did not play, and his leg voids. */
export async function runTrendPicksGrading(env, ctx, now = Date.now(), { deps = {} } = {}) {
  let graded = 0;
  for (let i = 0; i < 3; i++) {
    const dateKey = etDatePlusDays(now, -i);
    const raw = await env.POTD_KV.get(key(dateKey));
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (record.version !== RECORD_VERSION) continue;
    let changed = false;
    for (const bet of record.bets ?? []) {
      if (bet.status !== 'pending') continue;
      for (const leg of bet.legs) {
        if (leg.result != null || now < leg.commenceMs + 3 * 3600e3) continue;
        const actual = await actualFor(leg, env, ctx, deps);
        if (actual === null) {
          if (now > leg.commenceMs + 36 * 3600e3) { leg.result = 'void'; changed = true; }
          continue;
        }
        leg.actual = actual;
        leg.result = settle(leg, actual);
        changed = true;
      }
      const settled = settleBet(bet);
      if (!settled) continue;
      bet.result = settled.result;
      bet.net = settled.net;
      bet.status = settled.result === 'void' ? 'void' : 'graded';
      bet.settledAt = now;
      changed = true;
      graded++;
    }
    if (changed) await env.POTD_KV.put(key(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  }
  return { graded };
}

/** Wins, losses, pushes, voids and net units and dollars over a list of bets. */
export function betRecordOf(bets) {
  const done = (bets ?? []).filter((b) => b.status === 'graded' || b.status === 'void');
  const count = (result) => done.filter((b) => b.result === result).length;
  const units = Math.round(done.reduce((u, b) => u + (b.net ?? 0), 0) * 100) / 100;
  return { wins: count('win'), losses: count('loss'), pushes: count('push'), voids: count('void'), units, dollars: Math.round(units * UNIT_DOLLARS * 100) / 100 };
}

/** Today's record and the last `days` days of bets, newest first, with the running record overall and per league. */
export async function getTrendPicks(env, now = Date.now(), { days = 60 } = {}) {
  const today = etParts(now).date;
  const history = [];
  for (let i = 0; i < days; i++) {
    const dateKey = etDatePlusDays(now, -i);
    const raw = await env.POTD_KV.get(key(dateKey));
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (record.version === RECORD_VERSION) history.push(record);
  }
  const bets = history.flatMap((d) => d.bets ?? []);
  const bySport = {};
  for (const sportKey of TREND_ENABLED_SPORTS) bySport[sportKey] = betRecordOf(bets.filter((b) => b.sportKey === sportKey));
  return {
    today: history.find((d) => d.date === today) ?? null,
    history,
    record: betRecordOf(bets),
    bySport,
    unitDollars: UNIT_DOLLARS,
    books: PICK_BOOKS,
  };
}
