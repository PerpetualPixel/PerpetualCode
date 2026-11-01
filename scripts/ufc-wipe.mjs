#!/usr/bin/env node
/**
 * Take one UFC card's picks out of the record (2026-11-01 direction:
 * "wipe tracking for this week"): the card's picks record goes, and the
 * card leaves the ledger's index, so the UFC record and graph no longer
 * count it. The card itself (ufc:event:<id>) and the fighters stay.
 *
 *   node scripts/ufc-wipe.mjs --event 600061420 [--dry-run]
 *
 * Needs the same two secrets as the deploy workflow (CLOUDFLARE_API_TOKEN,
 * CLOUDFLARE_ACCOUNT_ID); --dry-run only reads.
 */
import { readKv, writeKv, deleteKv } from './lib/kv.mjs';
import { ufcPicksKey, ufcPicksIndexKey } from '../worker/src/ufc-picks.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const eventId = args.includes('--event') ? String(args[args.indexOf('--event') + 1] ?? '') : '';
if (!eventId) { console.error('usage: node scripts/ufc-wipe.mjs --event <espn event id> [--dry-run]'); process.exit(2); }

const record = await readKv(ufcPicksKey(eventId));
if (!record) console.log(`no picks record for event ${eventId}`);
else console.log(`event ${eventId}: ${record.eventName ?? '?'}, ${(record.bets ?? []).length} ticket(s): ${(record.bets ?? []).map((b) => `${b.legs.map((l) => l.selection).join(' + ')} (${b.status}${b.result ? ` ${b.result}` : ''})`).join('; ') || 'none'}`);
const index = (await readKv(ufcPicksIndexKey)) ?? { cards: [] };
const listed = (index.cards ?? []).some((c) => String(c.id) === eventId);
console.log(`ledger index: ${listed ? 'lists' : 'does not list'} the card (${(index.cards ?? []).length} cards)`);
if (DRY) { console.log('(dry run) nothing written'); process.exit(0); }
if (record) { await deleteKv(ufcPicksKey(eventId)); console.log('  deleted the picks record'); }
await deleteKv(`${ufcPicksKey(eventId)}:notified`).catch(() => {});
if (listed) {
  await writeKv([{ key: ufcPicksIndexKey, value: { ...index, cards: index.cards.filter((c) => String(c.id) !== eventId) } }], { ttlSeconds: 90 * 86400, say: console.log });
  console.log('  took the card out of the ledger index');
}
console.log('done');
