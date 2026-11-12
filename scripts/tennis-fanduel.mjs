#!/usr/bin/env node
/**
 * The tennis board at FanDuel (first pass: print what its public page data
 * carries, so the adapter is written against the real names).
 *
 *   node scripts/tennis-fanduel.mjs --dry-run --dump
 */
import { trimFanduelMarket, fanduelTabSlug } from '../worker/src/ufc-fanduel.js';

const API = 'https://sbapi.nj.sportsbook.fanduel.com/api';
const AK = 'FhMFpcPWXMeyZxOx';
const TENNIS = 2;
const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads the public tennis page data a few times an hour)';

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
  const dump = args.includes('--dump');
  const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const sport = await getJson(`${API}/content-managed-page?page=SPORT&eventTypeId=${TENNIS}&_ak=${AK}&timezone=America%2FNew_York`);
  const att = sport.attachments ?? sport;
  const comps = att.competitions ?? {};
  const all = Object.values(att.events ?? {});
  say(`FD TENNIS page: ${all.length} events, ${Object.keys(att.markets ?? {}).length} markets, competitions [${Object.values(comps).map((c) => `${c.competitionId}:${c.name}`).join(' | ')}]`);
  if (!dump) return;
  say(`FD event keys: ${Object.keys(all[0] ?? {}).join(',')}`);
  say(`FD sport tabs: ${Object.values(sport.layout?.tabs ?? {}).map((t) => t.title).join(' | ')}`);
  for (const e of all.slice(0, 60)) say(`FD EVENT ${e.eventId} | ${e.name} | ${e.openDate} | comp ${e.competitionId} | inPlay ${e.inPlay ?? '-'}`);
  const pageMarkets = Object.values(att.markets ?? {});
  say(`FD page market types: ${[...new Set(pageMarkets.map((m) => `${m.marketType}/${m.marketName}`))].slice(0, 40).join(' | ')}`);
  if (dump) say(`FD raw market keys: ${Object.keys(pageMarkets[0] ?? {}).join(',')}`);
  const singles = all.filter((e) => / v /i.test(String(e.name ?? '')) && !/\//.test(String(e.name ?? '')));
  for (const f of singles.slice(0, 3)) {
    const markets = new Map();
    const read = async (tab) => {
      const body = await getJson(`${API}/event-page?_ak=${AK}&eventId=${f.eventId}${tab ? `&tab=${tab}` : ''}&timezone=America%2FNew_York`);
      for (const m of Object.values((body.attachments ?? body).markets ?? {})) { const t = trimFanduelMarket(m); if (t && !markets.has(t.marketId)) markets.set(t.marketId, { ...t, tab: tab ?? 'default', inPlay: m.inPlay, bettingType: m.bettingType }); }
      return body;
    };
    try {
      const first = await read(null);
      const tabs = Object.values(first.layout?.tabs ?? {}).map((t) => t.title);
      say(`FD TABS ${f.name}: ${tabs.join(' | ')}`);
      for (const title of tabs) { await pause(700); try { await read(fanduelTabSlug(title)); } catch (e) { say(`  ! ${f.name} tab ${title}: ${e.message}`); } }
      for (const m of markets.values()) console.log(`    FD MKT [${m.tab}] ${m.marketType} | ${m.marketName} | sgm ${m.sgm} | ${m.runners.map((r) => `${r.runnerName}${r.handicap ? ` (${r.handicap})` : ''} ${r.american ?? '-'}`).join(' ; ').slice(0, 700)}`);
    } catch (e) { say(`! ${f.name}: ${e.message}`); }
    await pause(900);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
