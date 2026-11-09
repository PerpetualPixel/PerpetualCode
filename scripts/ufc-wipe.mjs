#!/usr/bin/env node
/**
 * Take UFC picks out of the record (2026-11-01 direction: "wipe tracking
 * for this week"; 2026-11-09: "remove the UFC Pixel's Picks, I will tell
 * you what they are; restart tracking"): a card's picks record goes and
 * the card leaves the ledger's index, so the UFC record and graph no
 * longer count it. --all does that for every card the index lists and
 * keeps the old index under ufc:picks:index:archived:<date>, which is a
 * fresh start for the record. --manual on|off sets the draw mode
 * (worker/src/ufc-picks.js's ufcModeKey): on, the tick posts no picks of
 * its own and the owner's tickets go in with scripts/ufc-picks-set.mjs.
 * The cards themselves (ufc:event:<id>) and the fighters stay.
 *
 *   node scripts/ufc-wipe.mjs --event 600061420 [--dry-run]
 *   node scripts/ufc-wipe.mjs --all --manual on [--dry-run]
 *
 * Needs the same two secrets as the deploy workflow (CLOUDFLARE_API_TOKEN,
 * CLOUDFLARE_ACCOUNT_ID); --dry-run only reads.
 */
import { readKv, writeKv, deleteKv } from './lib/kv.mjs';
import { ufcPicksKey, ufcPicksIndexKey, ufcModeKey } from '../worker/src/ufc-picks.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');
const eventId = args.includes('--event') ? String(args[args.indexOf('--event') + 1] ?? '') : '';
const manual = args.includes('--manual') ? String(args[args.indexOf('--manual') + 1] ?? '').toLowerCase() : '';
if (!eventId && !ALL && !manual) { console.error('usage: node scripts/ufc-wipe.mjs (--event <espn event id> | --all) [--manual on|off] [--dry-run]'); process.exit(2); }
if (manual && manual !== 'on' && manual !== 'off') { console.error('--manual takes on or off'); process.exit(2); }

const describe = (record) => `${record.eventName ?? '?'}, ${(record.bets ?? []).length} ticket(s): ${(record.bets ?? []).map((b) => `${b.legs.map((l) => l.selection).join(' + ')} (${b.status}${b.result ? ` ${b.result}` : ''})`).join('; ') || 'none'}`;
const index = (await readKv(ufcPicksIndexKey)) ?? { cards: [] };
const cards = ALL ? (index.cards ?? []) : eventId ? [{ id: eventId }] : [];
for (const card of cards) {
  const id = String(card.id);
  const record = await readKv(ufcPicksKey(id));
  console.log(record ? `event ${id}: ${describe(record)}` : `event ${id}: no picks record`);
  if (DRY) continue;
  if (record) { await deleteKv(ufcPicksKey(id)); console.log('  deleted the picks record'); }
  await deleteKv(`${ufcPicksKey(id)}:notified`).catch(() => {});
}
console.log(`ledger index: ${(index.cards ?? []).length} card(s)${eventId ? `, ${(index.cards ?? []).some((c) => String(c.id) === eventId) ? 'lists' : 'does not list'} the card` : ''}`);
if (!DRY && cards.length) {
  if (ALL) {
    if ((index.cards ?? []).length) await writeKv([{ key: `${ufcPicksIndexKey}:archived:${new Date().toISOString().slice(0, 10)}`, value: index }], { ttlSeconds: 365 * 86400, say: console.log });
    await writeKv([{ key: ufcPicksIndexKey, value: { cards: [] } }], { ttlSeconds: 90 * 86400, say: console.log });
    console.log('  the ledger index is empty: the record starts over');
  } else if ((index.cards ?? []).some((c) => String(c.id) === eventId)) {
    await writeKv([{ key: ufcPicksIndexKey, value: { ...index, cards: index.cards.filter((c) => String(c.id) !== eventId) } }], { ttlSeconds: 90 * 86400, say: console.log });
    console.log('  took the card out of the ledger index');
  }
}
if (manual) {
  console.log(`draw mode: manual ${manual}`);
  if (!DRY) await writeKv([{ key: ufcModeKey, value: { manual: manual === 'on', setAt: Date.now() } }], { ttlSeconds: 0, say: console.log });
}
if (DRY) console.log('(dry run) nothing written');
console.log('done');
