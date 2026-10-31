/**
 * A user's own Pixel's Pick (2026-10-31 direction: "let a user set their
 * own confidence floor or book for a personal ticket draw, saved per
 * user"). The account's settings (worker/src/settings.js's picks: the
 * book, the Pixel-score floor, the legs) draw one ticket a day from the
 * same Trends rows the tab shows, the first time the user opens Pixel's
 * Picks that day; it stands until a leg tips off, and the user can
 * redraw it before then. Graded the way the house tickets are
 * (trend-picks.js's gradeBets: the runner's box score, then the game
 * log), when the user next reads it, so no cron walks every account.
 * Kept per user under mypicks:<userId>, the last KEEP_DAYS days.
 */
import { getTrends, TREND_ENABLED_SPORTS } from './trends.js';
import { attachSeries, legScore, isAltLine, PICKEM_POWER } from '../../docs/trends.js';
import { etParts } from './potd.js';
import { americanToDecimal, bookIdFor } from '../../docs/engine.js';
import { loadInjuries, injuryFor } from './espn-bundle.js';
import { legRecord, gradeBets, betRecordOf, pickBookName, pickBookUrl, toAmerican, inRange, fold, STRAIGHT_RANGE, LEG_RANGE, TICKET_UNITS, PRIZEPICKS, PRIZEPICKS_PLAYS } from './trend-picks.js';

export const MY_PICKS_VERSION = 1;
export const myPicksKey = (userId) => `mypicks:${userId}`;
const KEEP_DAYS = 60;
const KV_TTL_SECONDS = 86400 * 90;

/** The PrizePicks play for a lineup of n projections: the house shapes for 2 and 3, the Power Play table past that. */
function pickemPlay(n) {
  if (n === 2) return { shape: 'power2', play: PRIZEPICKS_PLAYS.power2.label, decimal: 3 };
  if (n === 3) return { shape: 'flex3', play: PRIZEPICKS_PLAYS.flex3.label, decimal: PRIZEPICKS_PLAYS.flex3.payouts[3] };
  return { shape: `power${n}`, play: `${n}-pick Power Play`, decimal: PICKEM_POWER[n] ?? null };
}

/**
 * The ticket the settings draw from today's rows, or null with why not.
 * A leg: a game today not yet started, the player not listed out, a
 * quote at the user's book (never PrizePicks on an alternate number),
 * priced in the straight range for a one-leg ticket and the leg range
 * otherwise, and a Pixel score at or over the floor. Best scores first,
 * one leg per player, legs from different games preferred.
 */
export function drawMyTicket(rows, prefs, dateKey, now) {
  const legsWanted = prefs.book === PRIZEPICKS ? Math.min(6, Math.max(2, prefs.legs)) : prefs.legs;
  const range = legsWanted === 1 ? STRAIGHT_RANGE : LEG_RANGE;
  const candidates = [];
  let onBoard = 0;
  let atBook = 0;
  for (const row of rows ?? []) {
    if (!row || !(row.commenceMs > now) || etParts(row.commenceMs).date !== dateKey) continue;
    onBoard++;
    if (row.injury?.level === 'out') continue;
    if (prefs.book === PRIZEPICKS && isAltLine(row)) continue;
    const quote = (row.quotes ?? []).find((q) => (bookIdFor(q.bookKey) ?? String(q.bookKey ?? '').toLowerCase()) === prefs.book && Number.isFinite(q.american));
    if (!quote) continue;
    atBook++;
    if (prefs.book !== PRIZEPICKS && !inRange(quote.american, range)) continue;
    const score = legScore(row);
    if (score < prefs.minScore) continue;
    candidates.push({ row, quote, score });
  }
  candidates.sort((a, b) => (b.score - a.score) || (b.quote.american - a.quote.american));
  const chosen = [];
  const players = new Set();
  const games = new Set();
  // Different games first, then any player not already on the ticket.
  for (const pass of [true, false]) {
    for (const c of candidates) {
      if (chosen.length >= legsWanted) break;
      const who = fold(c.row.playerName);
      if (players.has(who)) continue;
      if (pass && games.has(c.row.eventId)) continue;
      chosen.push(c); players.add(who); games.add(c.row.eventId);
    }
  }
  if (!chosen.length) {
    const book = pickBookName(prefs.book);
    return { bet: null, reason: !onBoard ? 'No games left on the board today.' : !atBook ? `${book} has not priced today's lines yet.` : `Nothing at ${book} clears ${prefs.minScore} stars today${legsWanted === 1 ? ' in the straight range' : ''}.` };
  }
  if (prefs.book === PRIZEPICKS && chosen.length < 2) return { bet: null, reason: 'A PrizePicks lineup needs two projections; only one clears the floor today.' };
  const legs = chosen.map((c) => legRecord({ line: c.row, american: c.quote.american, decimal: c.quote.decimal ?? americanToDecimal(c.quote.american), bookId: prefs.book, link: c.quote.link ?? null }, { note: '', flags: [] }, now));
  legs.forEach((leg, i) => { leg.score = chosen[i].score; });
  const pickem = prefs.book === PRIZEPICKS ? pickemPlay(legs.length) : null;
  const decimal = pickem ? pickem.decimal : legs.reduce((d, l) => d * l.decimal, 1);
  const sports = [...new Set(legs.map((l) => l.sportKey))];
  return {
    bet: {
      id: `${dateKey}:mine`,
      mine: true,
      postedAt: now,
      type: legs.length === 1 ? 'straight' : 'parlay',
      shape: pickem?.shape ?? null,
      play: pickem ? `PrizePicks ${pickem.play}` : null,
      sportKey: sports.length === 1 ? sports[0] : 'mixed',
      sportTitle: sports.length === 1 ? legs[0].sportTitle : 'Mixed',
      bookId: prefs.book,
      book: pickBookName(prefs.book),
      bookUrl: pickBookUrl(prefs.book),
      link: legs.length === 1 ? legs[0].link : null,
      american: toAmerican(decimal),
      decimal: Math.round(decimal * 10000) / 10000,
      units: TICKET_UNITS,
      commenceMs: Math.min(...legs.map((l) => l.commenceMs)),
      legs,
      prefs: { book: prefs.book, minScore: prefs.minScore, legs: prefs.legs },
      short: legs.length < legsWanted ? `${legs.length} of the ${legsWanted} legs asked for clear the floor today.` : null,
      status: 'pending',
      result: null,
      net: null,
      settledAt: null,
    },
    reason: null,
  };
}

/** The user's stored record, or an empty one. */
async function loadRecord(env, userId) {
  const raw = await env.POTD_KV.get(myPicksKey(userId)).catch(() => null);
  if (!raw) return { version: MY_PICKS_VERSION, tickets: {} };
  try {
    const r = JSON.parse(raw);
    return r?.version === MY_PICKS_VERSION && r.tickets ? r : { version: MY_PICKS_VERSION, tickets: {} };
  } catch { return { version: MY_PICKS_VERSION, tickets: {} }; }
}

/** Today's rows across the leagues, each with its injury tag, the way the Parlay Builder reads them. */
async function loadRows(env, enabled, deps) {
  const rows = [];
  for (const sportKey of enabled) {
    if (deps.rowsFor) { rows.push(...((await deps.rowsFor(sportKey)) ?? [])); continue; }
    const t = await getTrends(env, sportKey).catch(() => null);
    const report = await loadInjuries(env, sportKey).catch(() => ({ players: {} }));
    for (const row of attachSeries(t?.rows ?? [], t?.logs) ?? []) rows.push({ ...row, injury: injuryFor(report, row.athleteId) });
  }
  return rows;
}

/**
 * The user's tickets: today's (drawn now when there is none and the
 * settings are set; drawn again on `redraw` while no leg has started),
 * the last KEEP_DAYS days graded, and the record over them.
 */
export async function getMyPicks(env, ctx, userId, now = Date.now(), { prefs = null, redraw = false, deps = {}, enabled = TREND_ENABLED_SPORTS } = {}) {
  const dateKey = etParts(now).date;
  const record = await loadRecord(env, userId);
  let changed = false;
  // Yesterday's and older tickets settle the way the house tickets do.
  const graded = await gradeBets(Object.values(record.tickets), env, ctx, now, deps);
  changed = changed || graded.changed;
  let today = record.tickets[dateKey] ?? null;
  let reason = null;
  let redrawn = false;
  const canDraw = prefs && (!today || (redraw && today.status === 'pending' && today.commenceMs > now));
  if (canDraw) {
    const drawn = drawMyTicket(await loadRows(env, enabled, deps), prefs, dateKey, now);
    reason = drawn.reason;
    if (drawn.bet) { record.tickets[dateKey] = drawn.bet; today = drawn.bet; changed = true; redrawn = Boolean(redraw); }
  } else if (redraw && today) {
    reason = 'A leg has started; this ticket stands.';
  }
  // The last KEEP_DAYS days only.
  for (const date of Object.keys(record.tickets)) {
    if ((now - Date.parse(`${date}T12:00:00Z`)) > KEEP_DAYS * 864e5) { delete record.tickets[date]; changed = true; }
  }
  if (changed) await env.POTD_KV.put(myPicksKey(userId), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS }).catch(() => {});
  const history = Object.entries(record.tickets).sort(([a], [b]) => (a < b ? 1 : -1)).map(([date, bet]) => ({ date, bets: [bet] }));
  return { dateKey, prefs, today, reason, redrawn, history, record: betRecordOf(Object.values(record.tickets)) };
}
