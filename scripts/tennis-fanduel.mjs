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
 */
import { readKv, writeKv } from './lib/kv.mjs';
import { trimFanduelMarket } from '../worker/src/ufc-fanduel.js';
import { TENNIS_FANDUEL_KEY, FANDUEL_TENNIS_TABS, FANDUEL_TENNIS_TYPES, fanduelPlayers, samePlayer } from '../worker/src/tennis-fanduel.js';

const API = 'https://sbapi.nj.sportsbook.fanduel.com/api';
// The key FanDuel's own web page sends with every read of its public page data.
const AK = 'FhMFpcPWXMeyZxOx';
const TENNIS = 2;
const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads the public tennis page data twice an hour)';
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
