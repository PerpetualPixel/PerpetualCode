/**
 * Pixel's Picks, drawn from the Trends rows (2026-10-27 direction): a
 * prop that has landed in every one of the player's last 20 games, and
 * every time against today's opponent, qualifies — and then it is
 * researched before it posts. Is the player on limited minutes, hurt or
 * questionable, a starter, in a likely blowout, facing a lineup change?
 * Every answer has to come back favourable for the line, or the line
 * passes. Anything worth knowing before betting it goes on the card as a
 * note. One or so a day; none is a fine answer.
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
import { seasonColumnRows } from '../../docs/prop-legs.js';
import { overNeed, underNeed } from '../../docs/trends.js';

/** A line needs this many logged games at 100% before it is a pick: ten 100%s is a pattern, three is a start. */
export const PICK_MIN_GAMES = 10;
/** How many qualifying lines are researched a day (each is an ESPN read and a model call), and how many may post. */
export const PICK_MAX_RESEARCHED = 4;
export const PICK_MAX_POSTED = 2;
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
 * The Trends rows that qualify today: 100% over the last 20 (at least
 * PICK_MIN_GAMES of them), 100% head to head when there is any head to
 * head, today's game, not started. One line per player, stat and side —
 * the best-paying of the 100% lines, which is the line nearest the
 * player's floor. Ranked by sample, then season rate, then price.
 */
export function qualifyingRows(rows, dateKey, now) {
  const best = new Map();
  for (const r of rows ?? []) {
    if (!r || r.commenceMs <= now || etParts(r.commenceMs).date !== dateKey) continue;
    const l20 = r.periods?.l20;
    if (!l20 || l20.rate !== 1 || l20.games < PICK_MIN_GAMES) continue;
    const h2h = r.periods?.h2h;
    if (h2h?.games > 0 && h2h.rate !== 1) continue;
    const k = `${fold(r.playerName)}|${r.statKey}|${r.side}`;
    const prev = best.get(k);
    if (!prev || (r.american ?? -9999) > (prev.american ?? -9999)) best.set(k, r);
  }
  const seasonRate = (r) => { const s = r.seasons?.[0]; return s ? (r.periods?.[`s${s}`]?.rate ?? 0) : 0; };
  return [...best.values()].sort((a, b) => (b.periods.l20.games - a.periods.l20.games) || (seasonRate(b) - seasonRate(a)) || ((b.american ?? 0) - (a.american ?? 0)));
}

/** The player's minutes per game, most recent first, from the league's game log; [] when the league has none. */
async function minutesFor(row, ctx) {
  if (!row.athleteId) return [];
  if (row.sportKey === 'basketball_nba') {
    const log = await fetchBasketballGamelog(row.sportKey, row.athleteId, ctx).catch(() => null);
    return basketballStatRows(log, 'minutes', { allSeasons: false }).map((r) => r.value);
  }
  return [];
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

  const minutes = await (deps.minutes ? deps.minutes(row) : minutesFor(row, ctx));
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
  for (const side of [context?.home, context?.away].filter(Boolean)) {
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

/** The stored pick: what the card shows and what the grader needs. */
function pickRecord(row, research, now) {
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
    american: row.american,
    decimal: row.decimal,
    book: row.book,
    quotes: (row.quotes ?? []).slice(0, 8),
    rates: row.rates,
    periods: { l5: row.periods.l5, l10: row.periods.l10, l20: row.periods.l20, h2h: row.periods.h2h },
    series: (row.series ?? []).slice(0, 20),
    note: research.note,
    flags: research.flags,
    status: 'pending',
    actual: null,
    result: null,
    gradedAt: null,
  };
}

/**
 * Draw today's Pixel's Picks from the Trends rows. Once a day's picks
 * post the day is final; a day with no qualifying line (or none that
 * passed) is checked again every RETRY_MINUTES until its games start,
 * since the Trends rows fill in over the morning.
 */
export async function runTrendPicksDaily(env, ctx, now = Date.now(), { deps = {}, enabled = TREND_ENABLED_SPORTS } = {}) {
  const dateKey = etParts(now).date;
  const raw = await env.POTD_KV.get(key(dateKey));
  const existing = raw ? JSON.parse(raw) : null;
  if (existing?.final) return { skipped: true, reason: 'posted', dateKey };
  if (existing && now - (existing.checkedAt ?? 0) < RETRY_MINUTES * 60e3) return { skipped: true, reason: 'checked recently', dateKey };

  const rows = [];
  for (const sportKey of enabled) {
    const stored = deps.rowsFor ? await deps.rowsFor(sportKey) : (await getTrends(env, sportKey))?.rows;
    rows.push(...(stored ?? []));
  }
  const candidates = qualifyingRows(rows, dateKey, now);
  const picks = [];
  const passed = [];
  for (const row of candidates.slice(0, PICK_MAX_RESEARCHED)) {
    if (picks.length >= PICK_MAX_POSTED) break;
    if (picks.some((p) => fold(p.playerName) === fold(row.playerName))) continue;
    const research = await researchPick(row, env, ctx, { now, deps });
    if (research.verdict === 'post') picks.push(pickRecord(row, research, now));
    else passed.push({ selection: row.selection, reasons: research.flags.filter((f) => f.startsWith('pass:')).map((f) => f.slice(6)) });
  }
  const record = {
    date: dateKey,
    generatedAt: existing?.generatedAt ?? now,
    checkedAt: now,
    final: picks.length > 0,
    considered: candidates.length,
    picks,
    passed,
  };
  await env.POTD_KV.put(key(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  return { skipped: false, dateKey, posted: picks.length, considered: candidates.length, passed: passed.length };
}

/** The player's value for the pick's stat on the pick's game date, from the game log, or null when the log has no such game yet. */
async function actualFor(pick, ctx, deps = {}) {
  if (deps.actual) return deps.actual(pick);
  if (!pick.athleteId) return null;
  let rows = [];
  if (pick.sportKey === 'basketball_nba') {
    const log = await fetchBasketballGamelog(pick.sportKey, pick.athleteId, ctx).catch(() => null);
    rows = basketballStatRows(log, pick.statKey, { allSeasons: false });
  } else if (pick.sportKey === 'americanfootball_nfl') {
    const log = await fetchNflGamelog(pick.athleteId, ctx).catch(() => null);
    rows = seasonColumnRows(log, gamelogStatIndex(log, pick.statKey));
  }
  const row = rows.find((r) => r.date && etParts(r.date).date === pick.gameDate);
  return row ? row.value : null;
}

/** Settle a pick against the actual: push on the number for an integer line, else over or under the line. */
export function settle(pick, actual) {
  if (!Number.isFinite(actual)) return null;
  if (Number.isInteger(pick.point) && actual === pick.point) return 'push';
  const won = pick.side === 'over' ? actual >= overNeed(pick.point) : actual <= underNeed(pick.point);
  return won ? 'win' : 'loss';
}

/** Grade pending picks from the last three days once their games are over; a player with no game in the log a day and a half on did not play, and the pick voids. */
export async function runTrendPicksGrading(env, ctx, now = Date.now(), { deps = {} } = {}) {
  let graded = 0;
  for (let i = 0; i < 3; i++) {
    const dateKey = etDatePlusDays(now, -i);
    const raw = await env.POTD_KV.get(key(dateKey));
    if (!raw) continue;
    const record = JSON.parse(raw);
    let changed = false;
    for (const pick of record.picks ?? []) {
      if (pick.status !== 'pending' || now < pick.commenceMs + 3 * 3600e3) continue;
      const actual = await actualFor(pick, ctx, deps);
      if (actual === null) {
        if (now > pick.commenceMs + 36 * 3600e3) { pick.status = 'void'; pick.result = 'void'; pick.gradedAt = now; changed = true; graded++; }
        continue;
      }
      pick.actual = actual;
      pick.result = settle(pick, actual);
      pick.status = 'graded';
      pick.gradedAt = now;
      changed = true;
      graded++;
    }
    if (changed) await env.POTD_KV.put(key(dateKey), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
  }
  return { graded };
}

/** Today's record and the last `days` days of picks, newest first, with the running record. */
export async function getTrendPicks(env, now = Date.now(), { days = 30 } = {}) {
  const today = etParts(now).date;
  const history = [];
  for (let i = 0; i < days; i++) {
    const dateKey = etDatePlusDays(now, -i);
    const raw = await env.POTD_KV.get(key(dateKey));
    if (raw) history.push(JSON.parse(raw));
  }
  const graded = history.flatMap((d) => d.picks ?? []).filter((p) => p.status === 'graded');
  const wins = graded.filter((p) => p.result === 'win').length;
  const losses = graded.filter((p) => p.result === 'loss').length;
  const pushes = graded.filter((p) => p.result === 'push').length;
  const units = graded.reduce((u, p) => u + (p.result === 'win' ? (p.decimal - 1) : p.result === 'loss' ? -1 : 0), 0);
  return {
    today: history.find((d) => d.date === today) ?? null,
    history,
    record: { wins, losses, pushes, units: Math.round(units * 100) / 100 },
  };
}
