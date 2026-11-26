/**
 * MVP Picks (2026-11-24, the owner, with a video titled "Easiest Way to Win
 * an NBA Same Game Parlay": "Implement this and find players that meet
 * this requirement. Add these to the pixels picks if there is a player
 * that does and make the parlay with the necessary links ... Vet the
 * player for any flags of course and you may post more than one player.
 * List them in confidence order and track only the best ones. Call these
 * picks 'MVP picks'").
 *
 * The video's system, one player a ticket:
 *
 *   1. the player with the highest usage rate on his team;
 *   2. an alternate number in each of points, rebounds and assists that he
 *      has cleared in 90% or more of his games this season;
 *   3. tonight's opponent is among the five worst in the league at
 *      guarding his position;
 *   4. the three go on one same-game parlay, and it is a bet when he clears
 *      all three together more often than the book's price says.
 *
 * How each is read here, from what the site already stores (the runner's
 * team records and the Trends rows; no odds call and no model call):
 *
 *   usage      (FGA + 0.44 FTA + TO) a minute against his team's own, this
 *              season, from the game logs: Basketball Reference's formula
 *              with the team's totals summed from its roster.
 *   the lines  the highest number in each stat still at 90% this season
 *              that one sportsbook prices, all three at the same book.
 *   defense    points + rebounds + assists a game allowed to guards, to
 *              forwards and to centers, from every opposing player's log;
 *              the five teams allowing the most are the bottom five.
 *   together   the share of his games this season with all three cleared
 *              in the same game (so the legs' own correlation is in it),
 *              pulled toward last season's share while this season is
 *              young (MVP_SHRINK_GAMES).
 *   the price  the feed carries each leg's price, never a same-game
 *              price, so the ticket names the price to take it at ("or
 *              better": the together rate less MVP_EDGE) and is graded at
 *              that price, the way a live tennis play with no book price
 *              is. It posts only when the legs' own prices say the book's
 *              same-game price should clear it (estimateSameGame).
 *
 * Every player who meets all of it is listed, most confident first, with
 * the "Too good to be true?" flags (docs/line-check.js and
 * worker/src/line-check.js). The best MVP_MAX_TRACKED with nothing
 * against them are tracked, a unit each; the rest are shown and graded
 * but never counted.
 */
import { getTrends } from './trends.js';
import { etParts, etDatePlusDays } from './potd.js';
import { loadBundleTeams, loadBundleIndex, loadInjuries, injuryFor } from './espn-bundle.js';
import { basketballStatRows, basketballStatIndex } from './basketball-props.js';
import { lineupFlags } from './line-check.js';
import { legRecord, gradeBets, betRecordOf, pickQuotes, pickBookName, pickBookUrl, toAmerican, fold } from './trend-picks.js';
import { seasonColumnRows } from '../../docs/prop-legs.js';
import { attachSeries, overNeed } from '../../docs/trends.js';
import { lineFlags } from '../../docs/line-check.js';
import { americanToDecimal } from '../../docs/engine.js';
import { ticketAtBooks } from '../../docs/book-ways.js';

export const MVP_SPORT = 'basketball_nba';
export const MVP_STATS = ['points', 'rebounds', 'assists'];
/** A leg's number must have landed this often this season, over at least this many games. */
export const MVP_MIN_RATE = 0.9;
export const MVP_MIN_GAMES = 10;
/** The opponent must be among this many worst at guarding the position. */
export const MVP_BOTTOM = 5;
/** Tracked a day at most; everyone else who qualifies is listed, not counted. */
export const MVP_MAX_TRACKED = 2;
export const MVP_UNITS = 1;
/** The room asked for under the together rate: the ticket is a bet at this many points better than break-even. */
export const MVP_EDGE = 0.03;
/** How many games of last season's together rate this season's is mixed with. */
export const MVP_SHRINK_GAMES = 8;
/** With no last season to lean on, a young season leans on this. */
export const MVP_PRIOR = 0.75;
/** A usage leader has played this many of his team's games this season at this many minutes a night. */
export const MVP_USAGE_GAMES = 5;
export const MVP_USAGE_MINUTES = 24;
/** A leg no shorter than this: a number at -4000 adds nothing to a ticket. */
export const MVP_LEG_FLOOR = -3000;
/** The books' same-game price gives back less than the legs multiplied: this much of the profit is assumed lost to it. */
export const MVP_SGP_HAIRCUT = 0.1;
/** Posted for games starting within this many hours, so the day's injury news is mostly in. */
export const MVP_WINDOW_HOURS = 9;
/** Sportsbooks that take a same-game parlay (a pick'em app does not). */
export const MVP_BOOKS = ['fanduel', 'draftkings', 'caesars', 'hardrock', 'bet365', 'fanatics', 'betmgm'];
/**
 * The shortest price worth playing (2026-11-24, the owner, of a ticket near -600: "this is not good enough, maybe have a
 * suggestion to up the prop or suggest another player to parlay with"). A ticket whose same-game price would be shorter
 * is stepped up to higher numbers, or paired with a second player, until it is not.
 */
export const MVP_TARGET_AMERICAN = -300;
/** A stepped-up number has still landed this often this season, and is one of this many rungs above the 90% number. */
export const MVP_STEP_RATE = 0.7;
export const MVP_STEP_RUNGS = 7;
export const MVP_VERSION = 2;

const KV_TTL_SECONDS = 86400 * 90;
const LEAGUE_HOURS = 12;
const RECHECK_MINUTES = 28;
const key = (dateKey) => `mvp:picks:${dateKey}`;
const LEAGUE_KEY = 'mvp:league';
/** The days that have a record, newest first, so the tab reads those and no others. */
export const MVP_INDEX_KEY = 'mvp:picks:index';
const round = (x, p = 1) => Math.round(x * 10 ** p) / 10 ** p;
const up = (s) => String(s ?? '').toUpperCase();

/** Guard, forward or center, from ESPN's position ("PG", "G-F", "F", "C"): the first letter that says so. */
export function positionGroup(position) {
  const p = up(position).replace(/[^A-Z-]/g, '');
  if (!p) return null;
  const first = p.split('-')[0];
  if (first.endsWith('G')) return 'G';
  if (first.endsWith('F')) return 'F';
  if (first === 'C') return 'C';
  return null;
}

/** One player's games in a season, by ESPN event: minutes, shots, free throws, turnovers and the three counting stats. */
export function playerGames(log, season = null) {
  const made = (statKey, part) => seasonColumnRows(log, basketballStatIndex(log, statKey), { parse: (v) => Number(String(v ?? '').split('-')[part]), allSeasons: true });
  const plain = (statKey) => basketballStatRows(log, statKey, { allSeasons: true });
  const games = new Map();
  const put = (rows, field) => { for (const r of rows) { if (r.eventId == null || (season != null && r.season !== season)) continue; const g = games.get(r.eventId) ?? { eventId: r.eventId, date: r.date, season: r.season, opponent: up(r.opponent) }; g[field] = r.value; games.set(r.eventId, g); } };
  put(plain('minutes'), 'min'); put(made('fgm', 1), 'fga'); put(made('ftm', 1), 'fta'); put(plain('turnovers'), 'tov');
  put(plain('points'), 'pts'); put(plain('rebounds'), 'reb'); put(plain('assists'), 'ast');
  return [...games.values()];
}

/** The season the league is in: the latest any player's log reaches. */
export function currentSeason(teams) {
  let latest = 0;
  for (const team of teams?.values?.() ?? []) for (const p of team.players ?? []) for (const g of playerGames(p.log)) if (g.season > latest) latest = g.season;
  return latest || null;
}

const poss = (g) => (g.fga ?? 0) + 0.44 * (g.fta ?? 0) + (g.tov ?? 0);

/**
 * A team's usage table, highest first: [{id, name, position, games, mpg,
 * usage}]. Usage is 100 x (the player's possessions used x the team's
 * minutes / 5) / (his minutes x the team's possessions used), over the
 * team's games this season that he played. A team game is an event three
 * or more of the roster logged, so a traded player's games elsewhere fall
 * away, and his games against this team are never counted for it.
 */
export function teamUsage(team, season) {
  const abbr = up(team?.team);
  const per = (team?.players ?? []).map((p) => ({ p, games: playerGames(p.log, season).filter((g) => g.opponent !== abbr && Number.isFinite(g.min) && g.min > 0) }));
  const counts = new Map();
  for (const { games } of per) for (const g of games) counts.set(g.eventId, (counts.get(g.eventId) ?? 0) + 1);
  const teamEvents = new Set([...counts.entries()].filter(([, n]) => n >= 3).map(([id]) => id));
  const totals = new Map();
  for (const { games } of per) for (const g of games) { if (!teamEvents.has(g.eventId)) continue; const t = totals.get(g.eventId) ?? { min: 0, poss: 0 }; t.min += g.min; t.poss += poss(g); totals.set(g.eventId, t); }
  const table = [];
  for (const { p, games } of per) {
    const mine = games.filter((g) => teamEvents.has(g.eventId));
    if (!mine.length) continue;
    const min = mine.reduce((s, g) => s + g.min, 0); const used = mine.reduce((s, g) => s + poss(g), 0);
    const tmMin = mine.reduce((s, g) => s + totals.get(g.eventId).min, 0); const tmPoss = mine.reduce((s, g) => s + totals.get(g.eventId).poss, 0);
    if (!(min > 0) || !(tmPoss > 0)) continue;
    table.push({ id: String(p.id), name: p.name, position: p.position ?? null, games: mine.length, mpg: round(min / mine.length), usage: round((100 * used * (tmMin / 5)) / (min * tmPoss)) });
  }
  return table.sort((a, b) => b.usage - a.usage);
}

/** The team's usage leader among its regulars, with the next man for the card, or null. */
export function usageLeader(table) {
  const regulars = (table ?? []).filter((r) => r.games >= MVP_USAGE_GAMES && r.mpg >= MVP_USAGE_MINUTES);
  if (!regulars.length) return null;
  return { ...regulars[0], next: regulars[1] ? { name: regulars[1].name, usage: regulars[1].usage } : null };
}

/**
 * What every team allows a game to guards, forwards and centers this
 * season: {ABBR: {G: {pra, pts, reb, ast, games, rank, of}, F, C}}. Rank 1
 * allows the most (the worst at guarding the position); `of` is how many
 * teams were ranked.
 */
export function defenseVsPosition(teams, season) {
  const allowed = new Map();
  for (const team of teams?.values?.() ?? []) for (const p of team.players ?? []) {
    const group = positionGroup(p.position);
    if (!group) continue;
    for (const g of playerGames(p.log, season)) {
      if (!g.opponent || !Number.isFinite(g.pts)) continue;
      const d = allowed.get(g.opponent) ?? { events: new Set(), G: { pts: 0, reb: 0, ast: 0 }, F: { pts: 0, reb: 0, ast: 0 }, C: { pts: 0, reb: 0, ast: 0 } };
      d.events.add(g.eventId); d[group].pts += g.pts; d[group].reb += g.reb ?? 0; d[group].ast += g.ast ?? 0;
      allowed.set(g.opponent, d);
    }
  }
  const out = {};
  for (const [abbr, d] of allowed) {
    const games = d.events.size;
    if (games < 3) continue;
    out[abbr] = {};
    for (const group of ['G', 'F', 'C']) out[abbr][group] = { pts: round(d[group].pts / games), reb: round(d[group].reb / games), ast: round(d[group].ast / games), pra: round((d[group].pts + d[group].reb + d[group].ast) / games), games };
  }
  for (const group of ['G', 'F', 'C']) {
    const order = Object.keys(out).sort((a, b) => out[b][group].pra - out[a][group].pra);
    order.forEach((abbr, i) => { out[abbr][group].rank = i + 1; out[abbr][group].of = order.length; });
  }
  return out;
}

/** The league's usage leaders and defense by position, from every team's record: {season, builtAt, leaders: {ABBR: leader}, dvp}. */
export function leagueTables(teams, now = Date.now()) {
  const season = currentSeason(teams);
  const leaders = {};
  for (const [abbr, team] of teams ?? []) { const lead = usageLeader(teamUsage(team, season)); if (lead) leaders[up(abbr)] = lead; }
  return { season, builtAt: now, leaders, dvp: defenseVsPosition(teams, season) };
}

async function loadLeague(env, now) {
  const raw = await env.POTD_KV.get(LEAGUE_KEY).catch(() => null);
  if (raw) { try { const cached = JSON.parse(raw); if (now - (cached.builtAt ?? 0) < LEAGUE_HOURS * 3600e3 && cached.season) return cached; } catch { /* rebuilt below */ } }
  const index = await loadBundleIndex(env, MVP_SPORT);
  const abbrs = (index?.teams ?? []).map((t) => (typeof t === 'string' ? t : t?.abbr ?? t?.team)).filter(Boolean);
  if (!abbrs.length) return null;
  const league = leagueTables(await loadBundleTeams(env, MVP_SPORT, abbrs), now);
  await env.POTD_KV.put(LEAGUE_KEY, JSON.stringify(league), { expirationTtl: 86400 * 3 });
  return league;
}

/** A row's record this season: {rate, hits, games}, or null. */
const seasonOf = (row, season) => row?.periods?.[`s${season}`] ?? null;

/**
 * The three legs at one sportsbook: for each stat the highest number still
 * at MVP_MIN_RATE this season that the book prices, or null when the book
 * is short a stat. `rows` are one player's over rows.
 */
export function legsAtBook(rows, bookId, season) {
  const legs = [];
  for (const stat of MVP_STATS) {
    const fits = (rows ?? []).filter((r) => r.statKey === stat && r.side === 'over' && !r.yesNo && Number.isFinite(r.point))
      .map((r) => ({ row: r, record: seasonOf(r, season), quote: pickQuotes(r).find((q) => q.bookId === bookId) }))
      .filter((x) => x.quote && x.quote.american >= MVP_LEG_FLOOR && x.record && x.record.games >= MVP_MIN_GAMES && x.record.rate >= MVP_MIN_RATE)
      .sort((a, b) => b.row.point - a.row.point);
    if (!fits.length) return null;
    legs.push(fits[0]);
  }
  return legs;
}

/** In how many of a season's games all three numbers were cleared together: {hits, games, rate}. The legs' rows carry their series. */
export function togetherRate(legs, season) {
  const byDate = legs.map((l) => new Map((l.row.series ?? []).filter((g) => g.season === season && Number.isFinite(g.value)).map((g) => [g.date, g.value])));
  let hits = 0; let games = 0;
  for (const [date] of byDate[0]) {
    if (!byDate.every((m) => m.has(date))) continue;
    games++;
    if (legs.every((l, i) => byDate[i].get(date) >= overNeed(l.row.point))) hits++;
  }
  return { hits, games, rate: games ? round(hits / games, 3) : null };
}

/** The chance the ticket lands: this season's together rate mixed with last season's (or MVP_PRIOR) as MVP_SHRINK_GAMES games. */
export function landChance(now, last) {
  const prior = last && last.games >= 20 ? last.rate : MVP_PRIOR;
  return round((now.hits + MVP_SHRINK_GAMES * prior) / (now.games + MVP_SHRINK_GAMES), 3);
}

/**
 * What the book's same-game price should be near, from the legs' own
 * prices: their implied chances multiplied, lifted by how much more often
 * the three land together than apart (never past the hardest leg alone),
 * with MVP_SGP_HAIRCUT of the profit given back. {decimal, american}.
 */
export function estimateSameGame(legs, together) {
  const implied = legs.map((l) => 1 / l.quote.decimal);
  const apart = legs.reduce((p, l) => p * (l.record?.rate ?? 1), 1);
  const lift = apart > 0 && together?.rate != null ? Math.min(1.2, Math.max(1, together.rate / apart)) : 1;
  const joint = Math.min(Math.min(...implied), implied.reduce((p, x) => p * x, 1) * lift);
  const decimal = 1 + (1 / joint - 1) * (1 - MVP_SGP_HAIRCUT);
  return { decimal: round(decimal, 4), american: toAmerican(decimal) };
}

/** A ticket's numbers from its legs: how often they land together this season and last, the chance, the estimate of the book's same-game price and the price to take it at. */
export function ticketOf(legs, season) {
  const together = togetherRate(legs, season);
  const last = togetherRate(legs, season - 1);
  const chance = landChance(together, last);
  const takeDecimal = 1 / Math.max(0.05, chance - MVP_EDGE);
  return { legs, together, last: last.games ? last : null, chance, est: estimateSameGame(legs, together), take: { decimal: round(takeDecimal, 4), american: toAmerican(takeDecimal) } };
}

/** Worth playing: the estimate of the book's price is no shorter than MVP_TARGET_AMERICAN and no shorter than the price to take. */
export const playable = (t) => Boolean(t) && t.est.decimal >= americanToDecimal(MVP_TARGET_AMERICAN) && t.est.decimal >= t.take.decimal;

/**
 * One player's ticket at the 90% numbers, or why there is none: the
 * best-paying book's three legs. {ok: false, reason} | {ok: true, bookId,
 * legs, together, last, chance, take, est}.
 */
export function mvpTicket(rows, season) {
  const mine = (rows ?? []).filter((r) => MVP_STATS.includes(r.statKey));
  if (!mine.length) return { ok: false, reason: 'no points, rebounds or assists lines on the board' };
  const short = MVP_STATS.filter((stat) => !mine.some((r) => r.statKey === stat && r.side === 'over' && (seasonOf(r, season)?.games ?? 0) >= MVP_MIN_GAMES && seasonOf(r, season).rate >= MVP_MIN_RATE));
  if (short.length) return { ok: false, reason: `no ${short.join(' or ')} number at ${Math.round(MVP_MIN_RATE * 100)}% this season` };
  let best = null;
  for (const bookId of MVP_BOOKS) {
    const legs = legsAtBook(mine, bookId, season);
    if (!legs) continue;
    const t = ticketOf(legs, season);
    if (!best || t.est.decimal > best.est.decimal) best = { bookId, ...t };
  }
  return best ? { ok: true, ...best } : { ok: false, reason: 'no one sportsbook prices all three numbers' };
}

/**
 * The same three stats at higher numbers, for a price worth playing: among
 * every book's rungs from the 90% number up (each still landing
 * MVP_STEP_RATE of the time), the three that land together most often
 * while the price stays playable. Null when no such three exist, or the
 * 90% numbers are the answer already.
 */
export function stepUpTicket(rows, season, safe) {
  const mine = (rows ?? []).filter((r) => MVP_STATS.includes(r.statKey) && r.side === 'over' && !r.yesNo && Number.isFinite(r.point));
  const floor = Object.fromEntries((safe?.legs ?? []).map((l) => [l.row.statKey, l.row.point]));
  let best = null;
  for (const bookId of MVP_BOOKS) {
    const ladders = MVP_STATS.map((stat) => mine.filter((r) => r.statKey === stat && r.point >= (floor[stat] ?? -Infinity))
      .map((r) => ({ row: r, record: seasonOf(r, season), quote: pickQuotes(r).find((q) => q.bookId === bookId) }))
      .filter((x) => x.quote && x.quote.american >= MVP_LEG_FLOOR && x.record && x.record.games >= MVP_MIN_GAMES && x.record.rate >= MVP_STEP_RATE)
      .sort((x, y) => x.row.point - y.row.point).slice(0, MVP_STEP_RUNGS));
    if (ladders.some((l) => !l.length)) continue;
    for (const pts of ladders[0]) for (const reb of ladders[1]) for (const ast of ladders[2]) {
      const legs = [pts, reb, ast];
      if (legs.every((l) => l.row.point === floor[l.row.statKey])) continue;
      const t = ticketOf(legs, season);
      if (!playable(t)) continue;
      if (!best || t.chance > best.chance || (t.chance === best.chance && t.est.decimal > best.est.decimal)) best = { bookId, ...t };
    }
  }
  return best;
}

/**
 * Two players' 90% tickets on one slip, at a book that prices both: the
 * chances multiplied (the games are different games) and the prices too.
 * `a` and `b` are {rows, ticket}; null when no book has both or the two
 * are in the same game.
 */
export function pairTicket(a, b, season) {
  if (!a?.ticket?.legs?.length || !b?.ticket?.legs?.length) return null;
  if (a.ticket.legs[0].row.eventId === b.ticket.legs[0].row.eventId) return null;
  for (const bookId of [a.ticket.bookId, b.ticket.bookId, ...MVP_BOOKS]) {
    const la = legsAtBook(a.rows, bookId, season); const lb = legsAtBook(b.rows, bookId, season);
    if (!la || !lb) continue;
    const ta = ticketOf(la, season); const tb = ticketOf(lb, season);
    const chance = round(ta.chance * tb.chance, 3);
    const estDecimal = ta.est.decimal * tb.est.decimal;
    const takeDecimal = 1 / Math.max(0.05, chance - MVP_EDGE);
    return { bookId, legs: [...la, ...lb], together: null, last: null, chance, est: { decimal: round(estDecimal, 4), american: toAmerican(estDecimal) }, take: { decimal: round(takeDecimal, 4), american: toAmerican(takeDecimal) } };
  }
  return null;
}

/** The flags on a ticket: each leg's own (minutes, injury, role, a change of team, the opponent, form, thin margins), one of a kind, worst tone kept. */
export function legFlags(legs) {
  const KEEP = new Set(['minutes', 'injury', 'role', 'team', 'opponent', 'form', 'margin']);
  const worth = { bad: 3, warn: 2, info: 1, good: 0 };
  const by = new Map();
  for (const l of legs) for (const f of lineFlags(l.row, { american: l.quote.american })) {
    if (!KEEP.has(f.key)) continue;
    const text = ['opponent', 'form', 'margin'].includes(f.key) ? `${l.row.statLabel}: ${f.text}` : f.text;
    const had = by.get(f.key);
    if (!had || worth[f.tone] > worth[had.tone]) by.set(f.key, { ...f, text });
  }
  return [...by.values()];
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const GROUP_WORD = { G: 'guards', F: 'forwards', C: 'centers' };

/**
 * Every usage leader on the slate, read: {picks, near, partners}. A pick
 * meets the whole system: {athleteId, player, team, opponent, position,
 * group, usage, dvp, rows, ticket (the 90% numbers), step (higher numbers
 * at a playable price, or null), flags, blocked, confidence}, most
 * confident first. `near` names who fell short and why. `partners` are
 * the leaders with a 90% ticket whom only the opponent's defense kept off
 * the list: not MVP picks, but sound second players to pair one with.
 * `rows` are the NBA Trends rows with their series (games not started),
 * `league` the tables from leagueTables, `report` the injury report.
 */
export async function mvpCandidates(rows, league, { env = null, ctx = null, report = null, deps = {} } = {}) {
  const picks = []; const near = []; const partners = [];
  const season = league?.season;
  const byTeam = new Map();
  for (const r of rows ?? []) { const t = up(r.team); if (!t) continue; if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(r); }
  for (const [team, teamRows] of byTeam) {
    const lead = league?.leaders?.[team];
    if (!lead) continue;
    const mine = teamRows.filter((r) => String(r.athleteId) === lead.id || fold(r.playerName) === fold(lead.name));
    const who = { athleteId: lead.id, player: lead.name, team, usage: lead.usage };
    if (!mine.length) { near.push({ ...who, why: 'no lines on the board' }); continue; }
    const injury = injuryFor(report, lead.id);
    if (injury?.level === 'out') { near.push({ ...who, why: `listed ${String(injury.status).toLowerCase()}` }); continue; }
    const opponent = up(mine[0].opponent);
    const group = positionGroup(lead.position);
    const dvp = group ? league?.dvp?.[opponent]?.[group] ?? null : null;
    const ticket = mvpTicket(mine, season);
    if (!ticket.ok) { near.push({ ...who, why: ticket.reason }); continue; }
    const withInjury = (legs) => legs.map((l) => ({ ...l, row: { ...l.row, injury: injury ?? l.row.injury ?? null } }));
    if (!dvp || dvp.rank > MVP_BOTTOM) {
      const why = dvp ? `${opponent} is ${ordinal(dvp.of - dvp.rank + 1)} of ${dvp.of} against ${GROUP_WORD[group]}, not a bottom-${MVP_BOTTOM} defense` : `no read on how ${opponent} guards his position`;
      near.push({ ...who, why });
      if (!legFlags(withInjury(ticket.legs)).some((f) => f.tone === 'bad')) partners.push({ ...who, opponent, why, rows: mine, ticket });
      continue;
    }
    const pointsRow = { ...(ticket.legs.find((l) => l.row.statKey === 'points') ?? ticket.legs[0]).row, injury: injury ?? null };
    const flags = legFlags(withInjury(ticket.legs));
    try { flags.push(...(deps.lineup ? await deps.lineup(pointsRow) : env ? await lineupFlags(env, pointsRow, ctx) : [])); } catch (e) { console.error('MVP picks, lineup flags:', e); }
    const warns = flags.filter((f) => f.tone === 'warn').length;
    picks.push({
      ...who, opponent, position: lead.position ?? null, group, mpg: lead.mpg, next: lead.next ?? null,
      dvp: { group, rank: dvp.rank, of: dvp.of, pra: dvp.pra }, rows: mine, ticket, step: stepUpTicket(mine, season, ticket), flags,
      blocked: flags.some((f) => f.tone === 'bad'),
      confidence: round(ticket.chance - 0.02 * warns, 3),
    });
  }
  picks.sort((a, b) => b.confidence - a.confidence || a.dvp.rank - b.dvp.rank);
  partners.sort((a, b) => b.ticket.chance - a.ticket.chance);
  return { picks, near, partners };
}

const PLAY_NAME = { safe: 'MVP same-game parlay', step: 'MVP same-game parlay · stepped up', pair: 'MVP parlay · two players' };

/** A way to play a pick as the record keeps it: its numbers, its lines in brief, and its ticket in the shape Pixel's Picks grades and draws, priced at the price to take. */
function optionRecord(kind, t, id, now, extra = {}, rows = []) {
  const legs = t.legs.map((l) => legRecord({ line: l.row, american: l.quote.american, decimal: l.quote.decimal, bookId: t.bookId, link: l.quote.link ?? null }, { note: null, flags: [] }, now));
  // The same legs at every other book (docs/book-ways.js): the number the book has, else its nearest lower one, a stat it lacks dropped.
  const books = ticketAtBooks(legs, rows, { exclude: t.bookId });
  return {
    kind, bookId: t.bookId, book: pickBookName(t.bookId), together: t.together, last: t.last, chance: t.chance, take: t.take, est: t.est, playable: playable(t), ...extra,
    lines: t.legs.map((l) => ({ player: l.row.playerName, stat: l.row.statKey, label: l.row.statLabel, point: l.row.point, american: l.quote.american, hits: l.record.hits, games: l.record.games, rate: l.record.rate })),
    bet: {
      id, postedAt: now, type: 'parlay', shape: null, play: PLAY_NAME[kind], mvp: true, kind,
      sportKey: MVP_SPORT, sportTitle: 'NBA', bookId: t.bookId, book: pickBookName(t.bookId), bookUrl: pickBookUrl(t.bookId), link: null,
      american: t.take.american, decimal: t.take.decimal, estAmerican: t.est.american, units: MVP_UNITS,
      commenceMs: Math.min(...legs.map((l) => l.commenceMs)), legs, books, status: 'pending', result: null, net: null, settledAt: null,
    },
  };
}
/** A ticket with its legs' game logs dropped: enough to draw a line and build a slip link, for the ways not chosen. */
const slim = (option) => ({ ...option, bet: { ...option.bet, legs: option.bet.legs.map(({ series, quotes, ...l }) => l) } });

/**
 * The day's MVP Picks: looked for on every Trends tick from
 * MVP_WINDOW_HOURS before a game until something is tracked, then left to
 * stand. Each pick carries the ways to play it (`options`: the 90% numbers,
 * the same stats stepped up, and paired with a second player) and the one
 * chosen (`play`, whose ticket is `bet`): the first of those at a price
 * worth playing. Writes mvp:picks:<date>. `deps` stands in for the stored
 * rows, the league tables and the injury report in tests.
 */
export async function runMvpPicksDaily(env, ctx, now = Date.now(), { deps = {} } = {}) {
  const dateKey = etParts(now).date;
  const raw = await env.POTD_KV.get(key(dateKey));
  const existing = raw ? JSON.parse(raw) : null;
  if (existing?.version === MVP_VERSION && existing.final) return { skipped: true, reason: 'posted', dateKey };
  if (existing?.version === MVP_VERSION && now - (existing.checkedAt ?? 0) < RECHECK_MINUTES * 60e3) return { skipped: true, reason: 'checked recently', dateKey };
  const stored = deps.rows ? await deps.rows() : await getTrends(env, MVP_SPORT).then((t) => attachSeries(t?.rows, t?.logs));
  const rows = (stored ?? []).filter((r) => r.commenceMs > now && r.commenceMs <= now + MVP_WINDOW_HOURS * 3600e3 && etParts(r.commenceMs).date === dateKey);
  if (!rows.length) return { skipped: true, reason: 'no games in the window', dateKey };
  const league = deps.league ? await deps.league() : await loadLeague(env, now);
  if (!league?.season) return { skipped: true, reason: 'no league tables', dateKey };
  const report = deps.report ? await deps.report() : await loadInjuries(env, MVP_SPORT).catch(() => ({ players: {} }));
  const { picks, near, partners } = await mvpCandidates(rows, league, { env, ctx, report, deps });
  let tracked = 0;
  const used = new Map(); // athleteId -> the player whose tracked ticket he is on
  const out = picks.map((p, i) => {
    const id = `mvp:${dateKey}:${p.athleteId}`;
    // A second player: another pick first (most confident), then a leader only the defense kept off the list. Never one already on a tracked ticket.
    const others = [...picks.filter((x) => x !== p && !x.blocked).map((x) => ({ ...x, mvp: true })), ...partners.map((x) => ({ ...x, mvp: false }))].filter((x) => !used.has(x.athleteId));
    let pair = null; let partner = null;
    for (const x of others) { pair = pairTicket(p, x, league.season); if (pair) { partner = x; break; } }
    const options = [
      optionRecord('safe', p.ticket, `${id}:safe`, now, {}, rows),
      p.step ? optionRecord('step', p.step, `${id}:step`, now, {}, rows) : null,
      pair ? optionRecord('pair', pair, `${id}:pair`, now, { partner: { athleteId: partner.athleteId, player: partner.player, team: partner.team, opponent: partner.opponent, mvp: partner.mvp, why: partner.mvp ? null : partner.why } }, rows) : null,
    ].filter(Boolean);
    const chosen = options.find((o) => o.playable) ?? null;
    const play = chosen ?? options[0];
    const why = p.blocked ? 'a flag against it' : used.has(p.athleteId) ? `already on ${used.get(p.athleteId)}'s tracked ticket` : !chosen ? 'every way to play it is priced too short' : tracked >= MVP_MAX_TRACKED ? `the day's ${MVP_MAX_TRACKED} tracked picks rank above it` : null;
    if (!why) { tracked++; used.set(p.athleteId, p.player); if (play.kind === 'pair') used.set(play.partner.athleteId, p.player); }
    return {
      rank: i + 1, tracked: !why, why, athleteId: p.athleteId, player: p.player, team: p.team, opponent: p.opponent, position: p.position, group: p.group,
      usage: p.usage, mpg: p.mpg, next: p.next, dvp: p.dvp, confidence: p.confidence,
      play: play.kind, partner: play.partner ?? null, together: play.together, last: play.last, chance: play.chance, take: play.take, est: play.est,
      flags: p.flags.map((f) => ({ key: f.key, tone: f.tone, title: f.title, text: f.text })),
      options: options.map((o) => (o === play ? { ...o, bet: null } : slim(o))),
      bet: { ...play.bet, id },
    };
  });
  const record = { version: MVP_VERSION, date: dateKey, season: league.season, generatedAt: existing?.generatedAt ?? now, checkedAt: now, postedAt: tracked ? now : null, final: tracked > 0, teams: new Set(rows.map((r) => up(r.team))).size, picks: out, near: near.slice(0, 12) };
  await env.POTD_KV.put(key(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  const index = await readIndex(env);
  if (!index.includes(dateKey)) await env.POTD_KV.put(MVP_INDEX_KEY, JSON.stringify({ dates: [dateKey, ...index].sort().reverse().slice(0, 400) }), { expirationTtl: KV_TTL_SECONDS });
  return { skipped: false, dateKey, picks: out.length, tracked };
}

async function readIndex(env) {
  try { const v = JSON.parse((await env.POTD_KV.get(MVP_INDEX_KEY)) ?? 'null'); return Array.isArray(v?.dates) ? v.dates : []; } catch { return []; }
}

/** Grade the last three days' MVP tickets, tracked or only listed, off the box score; a ticket that lands pays at the price it said to take. */
export async function runMvpPicksGrading(env, ctx, now = Date.now(), { deps = {} } = {}) {
  let graded = 0;
  for (let i = 0; i < 3; i++) {
    const dateKey = etDatePlusDays(now, -i);
    const raw = await env.POTD_KV.get(key(dateKey));
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (record.version !== MVP_VERSION) continue;
    const bets = (record.picks ?? []).map((p) => p.bet);
    const { changed, graded: n } = await gradeBets(bets, env, ctx, now, deps);
    for (const b of bets) if (b.status === 'graded' && b.result === 'win' && b.legs.every((l) => l.result === 'win')) b.net = Math.round(b.units * (b.decimal - 1) * 100) / 100;
    graded += n;
    if (changed) await env.POTD_KV.put(key(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  }
  return { graded };
}

/** Today's MVP Picks, the last `days` days of them and the record of the tracked ones. */
export async function getMvpPicks(env, now = Date.now(), { days = 60 } = {}) {
  const today = etParts(now).date;
  const oldest = etDatePlusDays(now, -days);
  const history = [];
  for (const dateKey of (await readIndex(env)).filter((d) => d >= oldest && d <= today)) {
    const raw = await env.POTD_KV.get(key(dateKey));
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (record.version !== MVP_VERSION || !(record.picks?.length || record.date === today)) continue;
    history.push(record.date === today ? record : { ...record, near: [], picks: record.picks.map((p) => ({ ...p, options: (p.options ?? []).map(({ bet, ...o }) => o) })) });
  }
  const tracked = history.flatMap((d) => (d.picks ?? []).filter((p) => p.tracked).map((p) => p.bet));
  return { today: history.find((d) => d.date === today) ?? null, history, record: betRecordOf(tracked), rules: { rate: MVP_MIN_RATE, bottom: MVP_BOTTOM, tracked: MVP_MAX_TRACKED, edge: MVP_EDGE, target: MVP_TARGET_AMERICAN } };
}
