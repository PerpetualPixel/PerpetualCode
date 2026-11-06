#!/usr/bin/env node
/**
 * The Tennis tab's card (2026-11-06: "add a tennis section ... WTA and
 * ATP"), from a runner ESPN answers: today's and tomorrow's singles
 * matches on both tours (main draw, with the qualifying marked), each
 * with its players, round, start time, state and set scores as they come,
 * and the completed singles results of the last twelve days for form and
 * for grading. Written to the worker's KV under tennis:card;
 * worker/src/tennis-picks.js reads it.
 *
 *   node scripts/tennis-card.mjs            read and write
 *   node scripts/tennis-card.mjs --dry-run  read and print, write nothing
 *   node scripts/tennis-card.mjs --dump     print the parsed card as JSON
 */
import { writeKv } from './lib/kv.mjs';

export const TENNIS_CARD_KEY = 'tennis:card';
const SITE = { atp: 'https://site.web.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard', wta: 'https://site.web.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' };
const RESULT_DAYS = 12;
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { if (i === tries - 1) { say(`! ${url}: ${e.message}`); return null; } await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  return null;
}

/** A player's key for matching across sources: lowercase ASCII, letters and digits, single spaces. */
export const nameKey = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Men's Grand Slam main draws are best of five; everything else on either tour is best of three. */
export function bestOfFor(tour, eventName, round) {
  const slam = /australian open|roland garros|french open|wimbledon|us open/i.test(String(eventName ?? ''));
  return tour === 'atp' && slam && !/qualifying/i.test(String(round ?? '')) ? 5 : 3;
}

/** The tier the Tennis tab reads a tournament at, from ESPN's name: Slams and 1000s, the Finals, then 500s and 250s. */
export function tierOf(eventName) {
  const n = String(eventName ?? '').toLowerCase();
  if (/australian open|roland garros|french open|wimbledon|us open/.test(n)) return 'slam';
  if (/masters|1000|indian wells|miami open|madrid|rome|italian open|canadian|national bank|cincinnati|shanghai|paris|wuhan|china open|qatar|dubai|atp finals|wta finals|nitto/.test(n)) return '1000';
  if (/challenger|itf|125/.test(n)) return 'challenger';
  return 'tour';
}

/** One competitor as the card lists a player; null for a doubles pairing. */
function player(c) {
  if (!c || c.roster) return null;
  const a = c.athlete ?? {};
  if (!a.displayName) return null;
  return { id: String(c.id ?? a.id ?? ''), name: a.displayName, short: a.shortName ?? null, key: nameKey(a.displayName), country: a.flag?.alt ?? null, flag: a.flag?.href ?? null };
}

/**
 * The singles matches in a scoreboard payload: {id, tour, eventId, eventName, tier, round, qualifying, date, state,
 * completed, statusName, bestOf, court, a, b, sets, tiebreaks, winner, note}.
 */
export function parseScoreboard(data, tour) {
  const out = [];
  for (const event of data?.events ?? []) {
    const groupings = event.groupings?.length ? event.groupings : [{ grouping: { slug: '' }, competitions: event.competitions ?? [] }];
    for (const g of groupings) {
      if (/doubles/i.test(String(g?.grouping?.slug ?? ''))) continue;
      for (const c of g.competitions ?? []) {
        if (/doubles/i.test(String(c?.type?.slug ?? ''))) continue;
        const [first, second] = c.competitors ?? [];
        const a = player(first); const b = player(second);
        if (!a || !b) continue;
        const round = c.round?.displayName ?? null;
        const la = first.linescores ?? []; const lb = second.linescores ?? [];
        const sets = la.length === lb.length ? la.map((s, i) => [Number(s?.value ?? 0), Number(lb[i]?.value ?? 0)]) : [];
        const tiebreaks = la.length === lb.length ? la.map((s, i) => (s?.tiebreak != null || lb[i]?.tiebreak != null ? [s?.tiebreak ?? null, lb[i]?.tiebreak ?? null] : null)) : [];
        out.push({
          id: String(c.id), tour, eventId: String(event.id), eventName: event.name ?? null, tier: tierOf(event.name), round, qualifying: /qualifying/i.test(String(round ?? '')),
          date: c.date ?? c.startDate ?? null, state: c.status?.type?.state ?? 'pre', completed: Boolean(c.status?.type?.completed), statusName: c.status?.type?.name ?? null, detail: c.status?.type?.detail ?? null,
          bestOf: bestOfFor(tour, event.name, round), court: c.venue?.court ?? null, venue: c.venue?.fullName ?? null,
          a, b, sets, tiebreaks, winner: first.winner === true ? 'a' : second.winner === true ? 'b' : null, note: (c.notes ?? []).find((n) => n?.text)?.text ?? null,
        });
      }
    }
  }
  return out;
}

/** The card: both tours, today and tomorrow for the slate, the last RESULT_DAYS days for results, one entry per match. */
export async function buildCard(now = Date.now(), { get = getJson } = {}) {
  const byId = new Map();
  const events = new Map();
  for (const tour of ['atp', 'wta']) {
    // A scoreboard day returns every tournament active that day with its whole draw, so a few days cover the fortnight.
    const days = [1, 0, -2, -5, -8, -11].map((d) => ymd(now + d * 864e5));
    for (const day of days) {
      const data = await get(`${SITE[tour]}?dates=${day}`);
      if (!data) continue;
      for (const e of data.events ?? []) events.set(`${tour}:${e.id}`, { tour, id: String(e.id), name: e.name ?? null, tier: tierOf(e.name), start: e.date ?? null, end: e.endDate ?? null });
      for (const m of parseScoreboard(data, tour)) { const prev = byId.get(`${tour}:${m.id}`); if (!prev || (m.completed && !prev.completed) || (!prev.sets.length && m.sets.length)) byId.set(`${tour}:${m.id}`, m); }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const all = [...byId.values()];
  const dayOf = (iso) => String(iso ?? '').slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10); const tomorrow = new Date(now + 864e5).toISOString().slice(0, 10); const yesterday = new Date(now - 864e5).toISOString().slice(0, 10);
  // The slate: matches of today and tomorrow (UTC), and anything still in play from yesterday.
  const slate = all.filter((m) => [today, tomorrow].includes(dayOf(m.date)) || (m.state === 'in' && dayOf(m.date) === yesterday)).sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
  const results = all.filter((m) => m.completed && Date.parse(m.date) >= now - RESULT_DAYS * 864e5).sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
  return { at: now, source: 'espn', events: [...events.values()], slate, results };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'); const dump = args.includes('--dump');
  const card = await buildCard();
  for (const t of ['atp', 'wta']) {
    const s = card.slate.filter((m) => m.tour === t); const r = card.results.filter((m) => m.tour === t);
    say(`${t.toUpperCase()}: ${s.length} on the slate (${s.filter((m) => m.state === 'pre').length} to come, ${s.filter((m) => m.state === 'in').length} in play, ${s.filter((m) => m.completed).length} final), ${r.length} results in ${RESULT_DAYS} days; events ${card.events.filter((e) => e.tour === t).map((e) => `${e.name} [${e.tier}]`).join(' | ') || 'none'}`);
    for (const m of s.slice(0, 40)) say(`  ${m.state.padEnd(4)} ${String(m.date).slice(0, 16)} ${m.eventName} ${m.round ?? ''}${m.qualifying ? ' (Q)' : ''}: ${m.a.name} v ${m.b.name}${m.sets.length ? ` ${m.sets.map(([x, y]) => `${x}-${y}`).join(' ')}` : ''}`);
  }
  if (dump) console.log(JSON.stringify(card, null, 1).slice(0, 20000));
  if (dry) { say(`dry run: would write ${TENNIS_CARD_KEY} (${JSON.stringify(card).length} bytes)`); process.exit(0); }
  await writeKv([{ key: TENNIS_CARD_KEY, value: card }], { ttlSeconds: 3 * 86400, say });
  say(`wrote ${TENNIS_CARD_KEY}: ${card.slate.length} on the slate, ${card.results.length} results`);
}
