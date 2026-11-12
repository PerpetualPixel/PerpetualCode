#!/usr/bin/env node
/**
 * The ace counts the Tennis tab's aces plays are graded on (2026-11-12:
 * four of them sat at "awaiting serve stats" for a week; nothing wrote
 * the log the grader reads). For every aces play still open in the last
 * six weeks of records: the tournament's page on tennis.com is read for
 * the match's link, the match page for its statistics table, and both
 * players' aces are written to tennis:acelog:<tour>. The worker's next
 * tick grades the play (worker/src/tennis-picks.js gradeAces).
 *
 * A match not played yet, or one whose page has no statistics, is left
 * for the next run. Nothing to read when no aces play is open.
 *
 *   node scripts/tennis-aces.mjs            read and write
 *   node scripts/tennis-aces.mjs --dry-run  read and print, write nothing
 */
import { readKv, writeKv } from './lib/kv.mjs';
import { TENNIS_COM, tournamentSlugs, matchLinks, matchLinkFor, parseMatchAces, acesFor, aceLogEntries, playerToken } from '../worker/src/tennis-aces.js';
import { nameKey } from '../worker/src/tennis-card-parse.js';

const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads a finished match\'s public statistics to settle a play)';
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(path) {
  try {
    const res = await fetch(`${TENNIS_COM}${path}`, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { status: res.status, html: null };
    return { status: res.status, html: await res.text() };
  } catch (e) { return { status: 0, html: null, error: e.message }; }
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const now = Date.now();
  const index = (await readKv('tennis:picks:index')) ?? { dates: [] };
  const open = [];
  for (const d of index.dates.slice(0, 45)) {
    const rec = await readKv(`tennis:picks:${d}`);
    for (const p of rec?.plays ?? []) if (p.market === 'aces' && p.status === 'pending' && p.commenceMs < now - 2 * 3600e3) open.push(p);
  }
  say(`aces plays open and past their start: ${open.length}`);
  if (!open.length) return;
  // One read of a tournament's page serves every play in it.
  const pages = new Map();
  const linksOf = async (eventName) => {
    for (const slug of tournamentSlugs(eventName)) {
      if (!pages.has(slug)) { const page = await getPage(`/tournaments/${slug}`); pages.set(slug, page.html ? matchLinks(page.html) : null); say(`  tournament page /tournaments/${slug}: ${page.html ? `${pages.get(slug).length} match links` : `HTTP ${page.status}${page.error ? ` ${page.error}` : ''}`}`); await pause(800); }
      if (pages.get(slug)?.length) return { slug, links: pages.get(slug) };
    }
    return null;
  };
  const logs = {}; let found = 0;
  const seen = new Set();
  for (const p of open) {
    const tag = `${p.selection} (${p.a} vs ${p.b}, ${new Date(p.commenceMs).toISOString().slice(0, 10)})`;
    const matchKey = `${p.tour}|${p.matchId}`;
    const mine = p.side === 'a' ? p.a : p.b;
    const t = await linksOf(p.event);
    // The page's own link when it lists the match; else the link built from the names and the day, each way round.
    let hrefs = [];
    const listed = t ? matchLinkFor(t.links, p.a, p.b, p.commenceMs) : null;
    if (listed) hrefs = [listed.href];
    else {
      const days = [0, -1, 1].map((d) => new Date(p.commenceMs + d * 864e5).toISOString().slice(0, 10));
      for (const slug of tournamentSlugs(p.event)) for (const day of days) for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) hrefs.push(`/tournaments/${slug}/matches/${playerToken(x)}-vs-${playerToken(y)}-${day}`);
      hrefs = hrefs.slice(0, 8);
    }
    let parsed = null; let used = null;
    for (const href of hrefs) {
      const page = await getPage(href); await pause(700);
      parsed = page.html ? parseMatchAces(page.html) : null;
      if (parsed) { used = href; break; }
    }
    if (!parsed) { say(`! ${tag}: no statistics found (${listed ? 'the match page has no table yet' : t ? 'the tournament page does not list the match and no built link answered' : `no tournament page for "${p.event}"`})`); continue; }
    const a = acesFor(parsed, p.a); const b = acesFor(parsed, p.b);
    if (a == null || b == null) { say(`! ${tag}: the table names ${parsed.left} and ${parsed.right}, not these two`); continue; }
    const date = /(\d{4}-\d{2}-\d{2})$/.exec(used)?.[1] ?? new Date(p.commenceMs).toISOString().slice(0, 10);
    say(`${tag}: ${p.a} ${a} aces, ${p.b} ${b} aces -> ${mine} ${p.side === 'a' ? a : b} against ${p.point} (${used})`);
    found++;
    if (seen.has(matchKey)) continue;
    seen.add(matchKey);
    logs[p.tour] ??= {};
    // Under the page's date and the day either side, so the grader's own three-day look finds it whatever zone the start was read in.
    for (const d of [-1, 0, 1]) Object.assign(logs[p.tour], aceLogEntries(new Date(Date.parse(`${date}T12:00:00Z`) + d * 864e5).toISOString().slice(0, 10), nameKey(p.a), nameKey(p.b), a, b));
  }
  say(`${found} of ${open.length} plays have their aces`);
  if (dry || !Object.keys(logs).length) { if (dry) say('dry run: nothing written'); return; }
  for (const [tour, entries] of Object.entries(logs)) {
    const key = `tennis:acelog:${tour}`;
    const existing = (await readKv(key).catch(() => null)) ?? {};
    await writeKv([{ key, value: { ...existing, ...entries } }], { ttlSeconds: 120 * 86400, say });
    say(`wrote ${key}: ${Object.keys(entries).length} entries added`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
