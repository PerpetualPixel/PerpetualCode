#!/usr/bin/env node
/**
 * The tennis board at FanDuel, with the ids a slip link needs (2026-11-12:
 * the odds feed had no board at all for the Stockholm week, so no match
 * there was priced; the user's screenshots of that week were FanDuel's
 * board: "display only the matches worth betting and who to lean and how,
 * moneyline, spread, to win a set"). FanDuel's public page data answers a
 * runner: the tennis sport page lists every match with its moneyline, and
 * a match's page lists the set winner, the "to win at least a set" yes and
 * no, the game spread, the totals and each player's aces ladder.
 *
 * Only the matches on the Tennis tab's own card are read (KV tennis:card:
 * the tour-level singles still to come), a pause between reads, and the
 * card is written to KV under tennis:fanduel; worker/src/tennis-fanduel.js
 * turns it into the feed's shape for the match read. Fail-open: a read
 * that does not come leaves the last board standing.
 *
 *   node scripts/tennis-fanduel.mjs            read and write
 *   node scripts/tennis-fanduel.mjs --dry-run  read and print, write nothing
 *   node scripts/tennis-fanduel.mjs --dump     print every market and runner name read
 *   node scripts/tennis-fanduel.mjs --list     print every singles match on FanDuel's page and whether the card has it
 *
 * The same read of the page also keeps the board of the matches below the
 * tours (2026-11-27, worker/src/tennis-lower.js): every Challenger and ITF
 * singles match with its moneyline, which the page itself carries, so it
 * costs no read of its own. A match the page lists without its moneyline
 * is read from its own page, the soonest first, a few a run.
 */
import { readKv, writeKv } from './lib/kv.mjs';
import { trimFanduelMarket } from '../worker/src/ufc-fanduel.js';
import { TENNIS_FANDUEL_KEY, FANDUEL_TENNIS_TABS, FANDUEL_TENNIS_TYPES, fanduelPlayers, samePlayer } from '../worker/src/tennis-fanduel.js';
import { TENNIS_LOWER_KEY, lowerTierOf, mergeLower, lowerBoard } from '../worker/src/tennis-lower.js';

const API = 'https://sbapi.nj.sportsbook.fanduel.com/api';
// The key FanDuel's own web page sends with every read of its public page data.
const AK = 'FhMFpcPWXMeyZxOx';
const TENNIS = 2;
const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads the public tennis page data three times an hour)';
const LOOKAHEAD_MS = 36 * 3600e3;
const MAX_MATCHES = 40;
// With no card to go by: the tour-level competitions by name, the Challenger and ITF weeks left out.
const TOUR_LEVEL = /^(ATP|WTA)\b|\b(Australian|French|US) Open\b|Wimbledon/i;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error('the page answered with an error');
  return body;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The lower tiers: how far back a started match is still noted as in play, the most matches read from their own page for a moneyline in one run.
const LOWER_BACK_MS = 12 * 3600e3;
const LOWER_OWN_READS = 25;
const MONEYLINE = /^(MATCH_BETTING|MONEY_LINE|MATCH_ODDS)$/;

/** A match's moneyline as the lower board keeps it: both prices and the ids a slip link needs; null unless both players are priced. */
function moneyline(market, [pa, pb]) {
  const ra = market.runners.find((r) => samePlayer(r.runnerName, pa)); const rb = market.runners.find((r) => r !== ra && samePlayer(r.runnerName, pb));
  return ra && rb && Number.isFinite(ra.american) && Number.isFinite(rb.american) ? { a: ra.american, b: rb.american, market: market.marketId, selA: ra.selectionId, selB: rb.selectionId } : null;
}

/** The Challenger and ITF singles on the page with their moneylines, folded into the log (KV tennis:lower). Never stops the card's own read. */
async function readLower({ att, comps, now, dry, list, say }) {
  const pageMoney = new Map();
  // An event carries no word on whether it is in play; its market does.
  const inPlay = new Set();
  for (const m of Object.values(att.markets ?? {})) { if (!MONEYLINE.test(String(m.marketType ?? ''))) continue; if (m.inPlay === true && m.eventId != null) inPlay.add(String(m.eventId)); const t = trimFanduelMarket(m); if (t && m.eventId != null && !pageMoney.has(String(m.eventId))) pageMoney.set(String(m.eventId), t); }
  const events = Object.values(att.events ?? {}).filter((e) => fanduelPlayers(e.name) && lowerTierOf(comps[e.competitionId]?.name) && Date.parse(e.openDate) > now - LOWER_BACK_MS && Date.parse(e.openDate) < now + LOOKAHEAD_MS)
    .sort((x, y) => Date.parse(x.openDate) - Date.parse(y.openDate));
  let own = 0;
  const board = [];
  for (const e of events) {
    const players = fanduelPlayers(e.name); const start = Date.parse(e.openDate);
    const started = inPlay.has(String(e.eventId)) || start <= now;
    let market = pageMoney.get(String(e.eventId)) ?? null;
    if (!market && !started && own < LOWER_OWN_READS) {
      own += 1;
      try { const body = await getJson(`${API}/event-page?_ak=${AK}&eventId=${e.eventId}&timezone=America%2FNew_York`); const found = Object.values((body.attachments ?? body).markets ?? {}).find((m) => MONEYLINE.test(String(m.marketType ?? ''))); market = found ? trimFanduelMarket(found) : null; } catch (err) { say(`  ! ${e.name}: ${err.message}`); }
      await pause(500);
    }
    board.push({ id: String(e.eventId), comp: comps[e.competitionId]?.name ?? null, compId: e.competitionId ?? null, a: players[0], b: players[1], start, inPlay: started, ml: market && !started ? moneyline(market, players) : null });
  }
  // A log that cannot be read is not written over (its tally is the only copy): a dry run alone goes on without one.
  let before = null;
  try { before = await readKv(TENNIS_LOWER_KEY); } catch (err) { if (!dry) throw err; }
  const log = mergeLower(before, board, now);
  const view = lowerBoard(log, now);
  const leans = view.matches.filter((m) => m.call.kind === 'lean');
  const graded = Object.values(log.matches).filter((m) => m.gradedAt === now && m.result && m.result !== 'unknown').length;
  say(`lower tiers: ${events.length} singles on the page (${pageMoney.size} moneylines on the page itself, ${own} matches read from their own page), ${view.matches.length} to come, ${leans.length} leans, ${graded} results read from the draw; tally ${JSON.stringify(log.tally)}`);
  if (list) {
    const types = [...new Set(Object.values(att.markets ?? {}).map((m) => m.marketType))];
    console.log(`    markets on the page: ${Object.keys(att.markets ?? {}).length} [${types.slice(0, 12).join(' | ')}]; an event's fields: ${Object.keys(events[0] ?? {}).join(', ')}`);
    for (const m of view.matches) console.log(`    ${m.comp} | ${m.a} v ${m.b} | ${new Date(m.start).toISOString().slice(0, 16)} | ${m.ml ? `${m.ml.a} / ${m.ml.b}` : 'no price'} | ${m.call.kind === 'lean' ? `LEAN ${m.call.name} ${m.call.american} (${m.call.how}, ${Math.round(m.call.share * 100)}%)` : m.call.text}`);
    console.log(`    in play by the page's markets: ${inPlay.size}; a market's fields: ${Object.keys(Object.values(att.markets ?? {}).find((m) => MONEYLINE.test(String(m.marketType ?? ''))) ?? {}).join(', ')}`);
  }
  const bytes = JSON.stringify(log).length;
  if (dry) { say(`dry run: would write ${TENNIS_LOWER_KEY} (${bytes} bytes, ${Object.keys(log.matches).length} matches)`); return; }
  if (!board.length && !before) return;
  await writeKv([{ key: TENNIS_LOWER_KEY, value: log }], { ttlSeconds: 14 * 86400, say });
  say(`wrote ${TENNIS_LOWER_KEY}: ${Object.keys(log.matches).length} matches, ${bytes} bytes`);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'); const dump = args.includes('--dump');
  const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const now = Date.now();
  const sport = await getJson(`${API}/content-managed-page?page=SPORT&eventTypeId=${TENNIS}&_ak=${AK}&timezone=America%2FNew_York`);
  const att = sport.attachments ?? sport;
  const comps = att.competitions ?? {};
  const singles = Object.values(att.events ?? {}).filter((e) => fanduelPlayers(e.name) && Date.parse(e.openDate) > now - 3600e3 && Date.parse(e.openDate) < now + LOOKAHEAD_MS);
  // The card's matches still to come, when the card can be read; the tour-level competitions otherwise.
  const card = await readKv('tennis:card').catch(() => null);
  const slate = (card?.slate ?? []).filter((m) => m.state === 'pre' && !m.qualifying && m.tier !== 'challenger');
  const onCard = (e) => { const [x, y] = fanduelPlayers(e.name); return slate.some((m) => (samePlayer(m.a.name, x) && samePlayer(m.b.name, y)) || (samePlayer(m.a.name, y) && samePlayer(m.b.name, x))); };
  const wanted = (slate.length ? singles.filter(onCard) : singles.filter((e) => TOUR_LEVEL.test(String(comps[e.competitionId]?.name ?? ''))))
    .sort((a, b) => Date.parse(a.openDate) - Date.parse(b.openDate)).slice(0, MAX_MATCHES);
  say(`FanDuel tennis page: ${singles.length} singles inside the lookahead, ${slate.length} matches to come on the card, ${wanted.length} to read`);
  // --list: every singles match on FanDuel's page with its competition and whether the card has it, and the card's own
  // matches, for seeing why a week reads nothing (a tournament FanDuel does not list, or names that do not pair).
  if (args.includes('--list')) {
    for (const e of [...singles].sort((x, y) => String(comps[x.competitionId]?.name ?? '').localeCompare(String(comps[y.competitionId]?.name ?? '')) || Date.parse(x.openDate) - Date.parse(y.openDate))) console.log(`    ${onCard(e) ? 'CARD' : '    '} ${comps[e.competitionId]?.name ?? '?'} | ${e.name} | ${e.openDate}`);
    for (const m of slate) console.log(`    card: ${m.tour} ${m.eventName} [${m.tier}] ${m.round} | ${m.a.name} v ${m.b.name} | ${m.date}`);
    const all = Object.values(att.events ?? {}); console.log(`    events on the page: ${all.length}; competitions: ${[...new Set(all.map((e) => comps[e.competitionId]?.name ?? '?'))].join(' | ')}`);
  }
  try { await readLower({ att, comps, now, dry, list: args.includes('--list'), say }); } catch (e) { say(`! lower tiers: ${e.message}`); }
  const events = [];
  for (const f of wanted) {
    const markets = new Map();
    const read = async (tab) => {
      const body = await getJson(`${API}/event-page?_ak=${AK}&eventId=${f.eventId}${tab ? `&tab=${tab}` : ''}&timezone=America%2FNew_York`);
      for (const m of Object.values((body.attachments ?? body).markets ?? {})) { if (!FANDUEL_TENNIS_TYPES.has(m.marketType)) continue; const t = trimFanduelMarket(m); if (t && !markets.has(t.marketId)) markets.set(t.marketId, t); }
    };
    try {
      await read(null);
      for (const tab of FANDUEL_TENNIS_TABS) { await pause(600); try { await read(tab); } catch (e) { say(`  ! ${f.name} tab ${tab}: ${e.message}`); } }
      const list = [...markets.values()];
      say(`${f.name} (${comps[f.competitionId]?.name ?? ''}): ${list.length} markets [${[...new Set(list.map((m) => m.marketType))].join(' | ')}]`);
      if (dump) for (const m of list) console.log(`    ${m.marketType} | ${m.marketName} | ${m.runners.map((r) => `${r.runnerName}${r.handicap ? ` (${r.handicap})` : ''} ${r.american ?? '-'}`).join(' ; ').slice(0, 500)}`);
      if (list.length) events.push({ eventId: f.eventId, name: f.name, competition: comps[f.competitionId]?.name ?? null, openDate: f.openDate, markets: list });
    } catch (e) { say(`! ${f.name}: ${e.message}`); }
    await pause(800);
  }
  if (!events.length) { say('nothing read; the last board stands'); return; }
  const record = { at: now, source: 'fanduel', events };
  const bytes = JSON.stringify(record).length;
  if (dry) { say(`dry run: would write ${TENNIS_FANDUEL_KEY} (${bytes} bytes, ${events.length} matches)`); return; }
  await writeKv([{ key: TENNIS_FANDUEL_KEY, value: record }], { ttlSeconds: 86400, say });
  say(`wrote ${TENNIS_FANDUEL_KEY}: ${events.length} matches, ${bytes} bytes`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
