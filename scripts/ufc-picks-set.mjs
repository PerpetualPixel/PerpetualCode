#!/usr/bin/env node
/**
 * Post the owner's UFC tickets for a card (2026-11-09 direction: "I will
 * tell you what they are"): the picks in JSON (worker/src/ufc-picks.js's
 * ownerTicket spec), resolved against the card's bouts and written into
 * the card's picks record, which the worker's tick then prices, voids on
 * a card change and grades like its own. The card's record is replaced
 * unless --add keeps what is there.
 *
 *   node scripts/ufc-picks-set.mjs --picks '[{"fighter":"Ciryl Gane","book":"fanduel","american":-200}]' [--event 600061420] [--add] [--dry-run]
 *   node scripts/ufc-picks-set.mjs --picks-file picks.json
 *
 * Without --event the card is the one the tab shows (the next card).
 * Needs the same two secrets as the deploy workflow; --dry-run only reads.
 */
import { readFileSync } from 'node:fs';
import { readKv, writeKv } from './lib/kv.mjs';
import { ufcPicksKey, ufcPicksIndexKey, ownerTicket, UFC_RECORD_VERSION, ufcLockMs } from '../worker/src/ufc-picks.js';
import { ufcEventsKey, ufcEventKey, nextUfcEvent } from '../worker/src/ufc-card.js';

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? String(args[args.indexOf(name) + 1] ?? '') : '');
const DRY = args.includes('--dry-run');
const ADD = args.includes('--add');
const raw = opt('--picks') || (opt('--picks-file') ? readFileSync(opt('--picks-file'), 'utf8') : '');
if (!raw) { console.error('usage: node scripts/ufc-picks-set.mjs --picks <json> | --picks-file <path> [--event <id>] [--add] [--dry-run]'); process.exit(2); }
const specs = JSON.parse(raw);
if (!Array.isArray(specs) || !specs.length) { console.error('--picks is a JSON list of tickets'); process.exit(2); }

const now = Date.now();
let eventId = opt('--event');
if (!eventId) { const idx = (await readKv(ufcEventsKey)) ?? { events: [] }; eventId = String(nextUfcEvent(idx.events, now)?.id ?? ''); }
if (!eventId) { console.error('no card to post on'); process.exit(1); }
const event = await readKv(ufcEventKey(eventId));
if (!event) { console.error(`no card record for event ${eventId}`); process.exit(1); }
console.log(`card ${eventId}: ${event.name}, ${(event.bouts ?? []).length} bouts, ${new Date(event.date).toISOString()}`);

const tickets = specs.map((spec) => ownerTicket(event, spec, now));
for (const t of tickets) console.log(`  ${t.type}: ${t.legs.map((l) => l.selection).join(' + ')} | ${t.book} ${t.american ?? 'unpriced'} | ${t.units} unit(s)`);

const key = ufcPicksKey(eventId);
const record = (await readKv(key)) ?? { version: UFC_RECORD_VERSION, eventId: event.id, eventName: event.name, eventDate: event.date, generatedAt: now, lockMs: ufcLockMs(event), bets: [], passed: [], breakdowns: {}, oddsAt: null };
const kept = ADD ? (record.bets ?? []) : [];
const bets = [...kept.filter((b) => !tickets.some((t) => t.id === b.id)), ...tickets];
console.log(`${ADD ? 'adding to' : 'replacing'} the record: ${bets.length} ticket(s) after`);
if (DRY) { console.log('(dry run) nothing written'); process.exit(0); }
await writeKv([{ key, value: { ...record, bets, passed: [], manual: true, ownerPostedAt: now } }], { ttlSeconds: 60 * 86400, say: console.log });
const index = (await readKv(ufcPicksIndexKey)) ?? { cards: [] };
if (!(index.cards ?? []).some((c) => String(c.id) === String(event.id))) {
  await writeKv([{ key: ufcPicksIndexKey, value: { ...index, cards: [{ id: event.id, name: event.name, date: event.date }, ...(index.cards ?? [])].slice(0, 40) } }], { ttlSeconds: 90 * 86400, say: console.log });
  console.log('  the card joins the ledger index');
}
console.log('done');
