#!/usr/bin/env node
/**
 * The fight props' prices from BestFightOdds (2026-11-05: "can you build
 * something to scrape or find the odds on these MMA fights?"). The odds
 * feed carries no fight props for MMA, and the books' own sites refuse a
 * cloud runner at the edge; BestFightOdds is a public odds-comparison
 * page that answers, and its event page lists every matchup's moneyline
 * and prop rows with a price per book.
 *
 * For each UFC event on the home page: the event page is read once, its
 * one odds table parsed (a header row of books, then per matchup two
 * fighter rows and the prop rows beneath, each cell a price keyed by the
 * book's id in data-li), and the whole board written to KV under
 * ufc:propodds (worker/src/ufc-prop-odds.js prices the parlay legs from
 * it). Fail-open: a page that will not parse writes nothing and leaves
 * the last board standing.
 *
 *   node scripts/ufc-prop-odds.mjs            read and write
 *   node scripts/ufc-prop-odds.mjs --dry-run  read and print, write nothing
 *   node scripts/ufc-prop-odds.mjs --dump     print the parsed board as JSON
 */
import { writeKv } from './lib/kv.mjs';

export const BFO = 'https://www.bestfightodds.com';
export const UFC_PROP_ODDS_KEY = 'ufc:propodds';
const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads the public odds board a few times a day)';

/** BestFightOdds' book names to the site's book ids (docs/engine.js SPORTSBOOKS); an unknown book keeps a slug of its name. */
export const BOOK_IDS = { fanduel: 'fanduel', draftkings: 'draftkings', caesars: 'caesars', betmgm: 'betmgm', betrivers: 'betrivers', bet365: 'bet365', fanatics: 'fanatics', hardrock: 'hardrock', hardrockbet: 'hardrock', espnbet: 'espnbet', espn: 'espnbet' };
export const bookIdOf = (name) => { const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); return BOOK_IDS[slug] ?? slug; };

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&#189;|½/g, '.5').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const text = (html) => decode(String(html ?? '').replace(/<[^>]+>/g, ' '));

/** The UFC events listed on the home page: [{ id, slug, title, url }], in page order. */
export function parseBfoHome(html) {
  const out = [];
  const re = /<div class="table-div[^"]*" id="event(\d+)">[\s\S]*?<div class="table-header"><a href="(\/events\/[^"]+)"><h1>([^<]*)<\/h1>/g;
  let m;
  while ((m = re.exec(html))) {
    const title = decode(m[3]).replace(/\s*Odds$/i, '');
    if (!/^UFC\b/i.test(title)) continue;
    out.push({ id: m[1], slug: m[2].replace(/^\/events\//, ''), title, url: `${BFO}${m[2]}` });
  }
  return out;
}

/**
 * One event page's board: the books in the header (id, name, our id),
 * and each matchup with its two fighters, their moneylines, and the prop
 * rows beneath, every price keyed by our book id.
 */
export function parseBfoEvent(html, { url = null } = {}) {
  const tableAt = html.search(/<table class="odds-table">/);
  if (tableAt < 0) return null;
  const table = html.slice(tableAt, html.indexOf('</table>', tableAt));
  const books = {};
  const headRe = /<th scope="col" data-b="(\d+)">([\s\S]*?)<\/th>/g;
  let h;
  while ((h = headRe.exec(table))) {
    const name = text(h[2].replace(/<br>[\s\S]*$/, '')).replace(/\$\d+ Bonus.*$/, '').trim();
    if (name) books[h[1]] = { name, bookId: bookIdOf(name) };
  }
  const matchups = [];
  let current = null;
  const rowRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/g;
  let r;
  const cells = (row) => {
    const out = [];
    const cellRe = /<td class="but-sgp?" data-li="\[(\d+),(\d+),(\d+)[^\]]*\]"><span[^>]*>([+\-]?\d+)<\/span>/g;
    let c;
    while ((c = cellRe.exec(row))) { const book = books[c[1]]; if (book) out.push({ bookId: book.bookId, book: book.name, american: Number(c[4]), mu: c[3] }); }
    return out;
  };
  while ((r = rowRe.exec(table))) {
    const attrs = r[1]; const row = r[2];
    const th = /<th scope="row"[^>]*>([\s\S]*?)<\/th>/.exec(row);
    if (!th) continue;
    if (/\/fighters\//.test(th[1])) {
      const name = text(th[1]);
      const quotes = cells(row);
      const mu = quotes[0]?.mu ?? (/data-admin-matchup="(\d+)"/.exec(row)?.[1] ?? /data-mu="(\d+)"/.exec(row)?.[1] ?? null);
      if (!current || current.fighters.length >= 2) { current = { mu, fighters: [], moneyline: [], props: [] }; matchups.push(current); }
      if (!current.mu && mu) current.mu = mu;
      current.fighters.push(name);
      current.moneyline.push(quotes.map(({ bookId, book, american }) => ({ bookId, book, american })));
      continue;
    }
    if (/class="pr"/.test(attrs) && current) {
      const label = text(th[1]);
      const quotes = cells(row).map(({ bookId, book, american }) => ({ bookId, book, american }));
      current.props.push({ label, quotes });
    }
  }
  return { url, books: Object.fromEntries(Object.values(books).map((b) => [b.bookId, b.name])), matchups: matchups.filter((m) => m.fighters.length === 2) };
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'); const dump = args.includes('--dump');
  const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const home = await get(`${BFO}/`);
  const events = parseBfoHome(home).slice(0, 3);
  say(`UFC events on the board: ${events.map((e) => e.title).join(' | ') || 'none'}`);
  const boards = [];
  for (const e of events) {
    try {
      const page = await get(e.url);
      const board = parseBfoEvent(page, { url: e.url });
      if (!board || !board.matchups.length) { say(`! ${e.title}: no odds table parsed`); continue; }
      const priced = board.matchups.reduce((n, m) => n + m.props.filter((p) => p.quotes.length).length, 0);
      say(`${e.title}: ${board.matchups.length} matchups, ${priced} priced prop rows, books ${Object.values(board.books).join(', ')}`);
      boards.push({ ...e, ...board });
    } catch (err) { say(`! ${e.title}: ${err.message}`); }
    await new Promise((r) => setTimeout(r, 1500)); // a pause between pages: a few reads a day, never a burst
  }
  if (dump) console.log(JSON.stringify(boards, null, 1).slice(0, 20000));
  if (!boards.length) { say('nothing parsed; the last board stands'); return; }
  const record = { at: Date.now(), source: 'bestfightodds', events: boards };
  if (dry) { say(`dry run: would write ${UFC_PROP_ODDS_KEY} (${JSON.stringify(record).length} bytes)`); return; }
  await writeKv([{ key: UFC_PROP_ODDS_KEY, value: record }], { ttlSeconds: 3 * 86400, say });
  say(`wrote ${UFC_PROP_ODDS_KEY}: ${boards.length} event${boards.length === 1 ? '' : 's'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
