/**
 * The UFC side, read from KV where the runner wrote it (scripts/ufc-card.mjs
 * every fifteen minutes; ESPN refuses the worker). Keys:
 *
 *   ufc:events            { builtAt, events: [{ id, name, shortName, date, venue, status, bouts }] }
 *   ufc:event:<id>        { id, name, shortName, date, venue, city, status: 'upcoming' | 'live' | 'final',
 *                           builtAt, bouts: [{ id, order, segment: 'main' | 'prelims' | 'early', weightClass,
 *                           title, status: 'scheduled' | 'live' | 'final' | 'cancelled', a, b, result }],
 *                           changes: [{ at, type, boutId, detail }] }
 *   ufc:fighter:<id>      { id, name, nickname, record, bio, headshot, flag, lastFive, methods, history, builtAt }
 *   ufc:fighters          { builtAt, fighters: [{ id, name, nickname, weightClass, record, headshot }] }
 *
 * The next event is the first by date that is not final: the moment the
 * last bout of a card is in, the tab rolls to the following card.
 */

export const ufcEventsKey = 'ufc:events';
export const ufcEventKey = (id) => `ufc:event:${id}`;
export const ufcFighterKey = (id) => `ufc:fighter:${id}`;
export const ufcFightersKey = 'ufc:fighters';

async function readJson(env, key) {
  const raw = await env?.POTD_KV?.get?.(key).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The runner's event index, or an empty one. */
export async function getUfcEvents(env) {
  return (await readJson(env, ufcEventsKey)) ?? { builtAt: null, events: [] };
}

/** One event with its bouts, or null. */
export async function getUfcEvent(env, id) {
  if (!id) return null;
  return readJson(env, ufcEventKey(id));
}

/** The event the tab shows: the first by date that is not final; after the last card, the most recent one. */
export function nextUfcEvent(events, now = Date.now()) {
  const list = [...(events ?? [])].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  return list.find((e) => e.status !== 'final') ?? list.filter((e) => (e.date ?? 0) <= now).at(-1) ?? null;
}

/** One fighter's profile and history, or null. */
export async function getUfcFighter(env, id) {
  if (!id) return null;
  return readJson(env, ufcFighterKey(id));
}

/** The Fighters search index, or an empty one. */
export async function getUfcFighters(env) {
  return (await readJson(env, ufcFightersKey)) ?? { builtAt: null, fighters: [] };
}
