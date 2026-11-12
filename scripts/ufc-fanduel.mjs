#!/usr/bin/env node
/**
 * The UFC card's markets at FanDuel, with the ids a slip link needs
 * (2026-11-12 direction: "find UFC props and odds to incorporate parlay
 * deep links ... so I can run a 10 leg parlay and add all the legs to my
 * sportsbook"). The odds feed carries no fight props for MMA, and the
 * BestFightOdds board has their prices but only a link to its own page.
 * FanDuel's public page data answers a runner and lists each market with
 * its marketId and each runner with its selectionId, which is all
 * sportsbook.fanduel.com/addToBetslip takes. (DraftKings refuses a
 * runner at its edge; nothing here tries it.)
 *
 * The MMA sport page lists the fights and their moneylines; each UFC
 * fight's page is then read tab by tab (the default tab, Method of
 * Victory, Round Props), a pause between reads, a few times a day. The
 * card is written to KV under ufc:fanduel; worker/src/ufc-fanduel.js
 * turns the parlay legs' FanDuel prices into slip links from it.
 * Fail-open: a read that does not come leaves the last card standing.
 *
 *   node scripts/ufc-fanduel.mjs            read and write
 *   node scripts/ufc-fanduel.mjs --dry-run  read and print, write nothing
 *   node scripts/ufc-fanduel.mjs --dump     print every market and runner name read
 */
import { writeKv } from './lib/kv.mjs';
import { UFC_FANDUEL_KEY, trimFanduelMarket, fanduelTabSlug, FANDUEL_TABS } from '../worker/src/ufc-fanduel.js';

const API = 'https://sbapi.nj.sportsbook.fanduel.com/api';
// The key FanDuel's own web page sends with every read of its public page data.
const AK = 'FhMFpcPWXMeyZxOx';
const MMA = 26420387;
const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads the public UFC page data a few times a day)';
const LOOKAHEAD_MS = 9 * 864e5;
const MAX_FIGHTS = 16;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error('the page answered with an error');
  return body;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'); const dump = args.includes('--dump');
  const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const now = Date.now();
  const sport = await getJson(`${API}/content-managed-page?page=SPORT&eventTypeId=${MMA}&_ak=${AK}&timezone=America%2FNew_York`);
  const att = sport.attachments ?? sport;
  const comps = att.competitions ?? {};
  const ufcComps = new Set(Object.values(comps).filter((c) => /ufc/i.test(String(c?.name ?? ''))).map((c) => c.competitionId));
  const all = Object.values(att.events ?? {});
  const fights = all.filter((e) => ufcComps.has(e.competitionId) && / v /i.test(String(e.name ?? '')) && Date.parse(e.openDate) > now - 6 * 3600e3 && Date.parse(e.openDate) < now + LOOKAHEAD_MS)
    .sort((a, b) => Date.parse(a.openDate) - Date.parse(b.openDate)).slice(0, MAX_FIGHTS);
  say(`MMA page: ${all.length} events, competitions [${Object.values(comps).map((c) => c.name).join(' | ')}], ${fights.length} UFC fights inside the lookahead`);
  if (dump) say(`event keys: ${Object.keys(all[0] ?? {}).join(',')}`);
  const events = [];
  for (const f of fights) {
    const markets = new Map();
    const read = async (tab) => {
      const body = await getJson(`${API}/event-page?_ak=${AK}&eventId=${f.eventId}${tab ? `&tab=${tab}` : ''}&timezone=America%2FNew_York`);
      for (const m of Object.values((body.attachments ?? body).markets ?? {})) { const t = trimFanduelMarket(m); if (t && !markets.has(t.marketId)) markets.set(t.marketId, t); }
      return body;
    };
    try {
      const first = await read(null);
      const tabs = Object.values(first.layout?.tabs ?? {}).map((t) => t.title).filter((title) => FANDUEL_TABS.some((re) => re.test(String(title))));
      for (const title of tabs) { await pause(700); try { await read(fanduelTabSlug(title)); } catch (e) { say(`  ! ${f.name} tab ${title}: ${e.message}`); } }
      const list = [...markets.values()];
      say(`${f.name}: ${list.length} markets over ${tabs.length + 1} tab${tabs.length ? 's' : ''} [${[...new Set(list.map((m) => m.marketName))].slice(0, 30).join(' | ')}]`);
      if (dump) for (const m of list) console.log(`    ${m.marketType} | ${m.marketName} | ${m.runners.map((r) => `${r.runnerName}${r.handicap ? ` (${r.handicap})` : ''} ${r.american ?? '-'}`).join(' ; ').slice(0, 900)}`);
      if (list.length) events.push({ eventId: f.eventId, name: f.name, openDate: f.openDate, markets: list });
    } catch (e) { say(`! ${f.name}: ${e.message}`); }
    await pause(900);
  }
  if (!events.length) { say('nothing read; the last card stands'); return; }
  const record = { at: now, source: 'fanduel', events };
  const bytes = JSON.stringify(record).length;
  if (dry) { say(`dry run: would write ${UFC_FANDUEL_KEY} (${bytes} bytes, ${events.length} fights)`); return; }
  await writeKv([{ key: UFC_FANDUEL_KEY, value: record }], { ttlSeconds: 3 * 86400, say });
  say(`wrote ${UFC_FANDUEL_KEY}: ${events.length} fights, ${bytes} bytes`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
