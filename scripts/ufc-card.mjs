/**
 * The UFC side's data, from a runner ESPN answers (the worker is refused;
 * see worker/src/espn-bundle.js): every UFC card ESPN lists over the next
 * two months with its bouts in order, each fighter's profile and fight
 * history, finished bouts' results, and an index of every fighter seen on
 * a UFC card in the last year for the Fighters search. Written to the
 * worker's KV; worker/src/ufc-card.js reads it.
 *
 *   node scripts/ufc-card.mjs                # the next cards, their fighters, results
 *   node scripts/ufc-card.mjs --dry-run      # fetch and report, write nothing
 *   node scripts/ufc-card.mjs --dump         # print ESPN's raw shapes for one event and one athlete
 *   node scripts/ufc-card.mjs --index        # also rebuild the year-long fighter index (weekly)
 */
import { readKv, writeKv } from './lib/kv.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DUMP = args.includes('--dump');
const INDEX = args.includes('--index');
const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc';
const ATHLETE = 'https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/athletes';
const CONCURRENCY = 6;
const say = (...a) => console.log(...a);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) { say(`  ! ${url}: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return null;
}
async function pool(items, worker, size = CONCURRENCY) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); } }));
  return out;
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

const now = Date.now();
const board = await getJson(`${SITE}/scoreboard?dates=${ymd(now - 2 * 864e5)}-${ymd(now + 60 * 864e5)}`);
const events = board?.events ?? [];
say(`${events.length} UFC events on ESPN's board for the next two months`);
for (const e of events) say(`  ${e.date}  ${e.name}  (${e.id}) ${e.competitions?.length ?? 0} bouts, status ${e.status?.type?.name ?? '?'}`);

if (DUMP) {
  const e = events[0];
  const trim = (o) => JSON.stringify(o, (k, v) => (k === 'links' || k === 'logos' ? undefined : v)).slice(0, 6000);
  say('\n=== event keys', Object.keys(e ?? {}));
  say('=== event (trimmed)', trim({ ...e, competitions: undefined }));
  say('=== competition[0]', trim(e?.competitions?.[0]));
  say('=== competition[last]', trim(e?.competitions?.at(-1)));
  const id = e?.competitions?.at(-1)?.competitors?.[0]?.id;
  const a = id ? await getJson(`${ATHLETE}/${id}?enable=history`) : null;
  say('=== athlete keys', Object.keys(a ?? {}), Object.keys(a?.athlete ?? {}));
  say('=== athlete (trimmed)', trim({ ...a, eventsMap: undefined, athlete: { ...a?.athlete, links: undefined } }));
  const first = Object.values(a?.eventsMap ?? {})[0];
  say('=== eventsMap[0]', trim(first));
  const past = await getJson(`${SITE}/scoreboard?dates=${ymd(now - 14 * 864e5)}-${ymd(now - 1 * 864e5)}`);
  const done = (past?.events ?? []).flatMap((ev) => ev.competitions ?? []).find((c) => c.status?.type?.completed);
  say('=== finished competition', trim(done));
  const yearBoard = await getJson(`${SITE}/scoreboard?dates=${ymd(now - 365 * 864e5)}-${ymd(now - 300 * 864e5)}`);
  say('=== a year back: events', yearBoard?.events?.length, 'first', yearBoard?.events?.[0]?.name);
  process.exit(0);
}

/* ---------------- parsing (field names checked against --dump) ---------------- */

const SEGMENT = (text) => { const t = String(text ?? '').toLowerCase(); return t.includes('early') ? 'early' : t.includes('prelim') ? 'prelims' : 'main'; };
const boutStatus = (st) => (st?.type?.completed ? 'final' : st?.type?.state === 'in' ? 'live' : /cancel|postpone/i.test(st?.type?.name ?? '') ? 'cancelled' : 'scheduled');
const recordOf = (text) => { const m = String(text ?? '').match(/(\d+)-(\d+)(?:-(\d+))?(?:,?\s*(\d+)\s*NC)?/i); return m ? { wins: +m[1], losses: +m[2], draws: +(m[3] ?? 0), nc: +(m[4] ?? 0) } : null; };
const methodCategory = (m) => { const t = String(m ?? '').toLowerCase(); if (!t) return null; if (/ko|tko|knock|strikes|punch|kick/.test(t)) return 'ko'; if (/sub|choke|lock|tap/.test(t)) return 'sub'; if (/dec/.test(t)) return 'dec'; if (/dq|disq|no contest|nc|overturn/.test(t)) return 'other'; return 'other'; };
const finishMethod = (c) => { const d = (c.details ?? []).find((x) => /^unofficial winner\s+/i.test(x?.type?.text ?? '')); const raw = d ? d.type.text.replace(/^unofficial winner\s+/i, '').trim() : (c.status?.result?.displayName ?? c.status?.result?.name ?? null); return raw ? (raw.toLowerCase() === 'kotko' ? 'KO/TKO' : raw) : null; };

/**
 * ESPN lists a card's bouts earliest first with no segment field, but the
 * prelims and the main card start at different times (the early prelims
 * at a third), so the segment is the bout's start time's rank: the latest
 * start is the main card, the earliest the early prelims when there are
 * three, prelims otherwise.
 */
function segmentsByStart(competitions) {
  const starts = [...new Set(competitions.map((c) => c.date).filter(Boolean))].sort();
  return (c) => { const i = starts.indexOf(c.date); if (starts.length <= 1 || i === starts.length - 1) return 'main'; return starts.length >= 3 && i === 0 ? 'early' : 'prelims'; };
}

function parseEvent(e) {
  const comp0 = e.competitions?.[0];
  const segmentOf = segmentsByStart(e.competitions ?? []);
  const bouts = (e.competitions ?? []).map((c, i) => {
    const [x, y] = c.competitors ?? [];
    // The competitor's own id is the athlete id (the athlete object on the scoreboard carries none); the headshot comes from the profile, filled in below.
    const side = (p) => (p ? { id: String(p.id ?? p.athlete?.id ?? ''), name: p.athlete?.displayName ?? p.athlete?.fullName ?? '', record: p.records?.[0]?.summary ?? null, headshot: null, flag: p.athlete?.flag?.href ?? null, country: p.athlete?.flag?.alt ?? null, winner: p.winner === true } : null);
    const status = boutStatus(c.status);
    const a = side(x); const b = side(y);
    const winner = status === 'final' ? (a?.winner ? a.id : b?.winner ? b.id : null) : null;
    return {
      id: String(c.id), order: i + 1,
      segment: c.cardSegment?.description ? SEGMENT(c.cardSegment.description) : segmentOf(c),
      weightClass: c.type?.text ?? c.type?.abbreviation ?? null,
      title: Boolean(c.titleFight) || /title|championship/i.test(c.type?.text ?? '') || (c.notes ?? []).some((n) => /title/i.test(n?.headline ?? '')),
      rounds: c.format?.regulation?.periods ?? null,
      date: c.date ? Date.parse(c.date) : null,
      status, a, b,
      result: status === 'final' ? { winnerId: winner, method: finishMethod(c), round: Number(c.status?.period) > 0 ? Number(c.status.period) : null, time: c.status?.displayClock ?? null, draw: !winner } : null,
    };
  });
  bouts.reverse().forEach((b, i) => { b.order = i + 1; });
  const done = bouts.filter((b) => b.status !== 'cancelled');
  const status = done.length && done.every((b) => b.status === 'final') ? 'final' : done.some((b) => b.status === 'live' || b.status === 'final') ? 'live' : 'upcoming';
  return {
    id: String(e.id), name: e.name, shortName: e.shortName ?? e.name, date: e.date ? Date.parse(e.date) : null,
    venue: comp0?.venue?.fullName ?? e.venues?.[0]?.fullName ?? null, city: [comp0?.venue?.address?.city ?? e.venues?.[0]?.address?.city, comp0?.venue?.address?.state ?? e.venues?.[0]?.address?.state ?? comp0?.venue?.address?.country].filter(Boolean).join(', ') || null,
    status, builtAt: now, bouts,
  };
}

function parseFighter(data) {
  const a = data?.athlete; if (!a) return null;
  const history = Object.values(data.eventsMap ?? {}).filter((e) => e.gameResult || e.status?.type?.completed).map((e) => {
    const method = e.status?.result?.displayName ?? e.status?.result?.name ?? null;
    const res = String(e.gameResult ?? '').toUpperCase();
    return { date: e.gameDate ? Date.parse(e.gameDate) : null, event: e.name ?? e.shortName ?? null, eventId: e.id ? String(e.id) : null, title: Boolean(e.titleFight), opponent: { id: e.opponent?.id ? String(e.opponent.id) : null, name: e.opponent?.displayName ?? null, record: null }, result: res.startsWith('W') ? 'win' : res.startsWith('L') ? 'loss' : res.startsWith('D') ? 'draw' : 'nc', method, category: methodCategory(method), round: Number(e.status?.period) > 0 ? Number(e.status.period) : null, time: e.status?.displayClock ?? null };
  }).sort((x, y) => (y.date ?? 0) - (x.date ?? 0));
  // ESPN's stats summary carries the record ("21-7-1") and the (T)KO and
  // submission counts as "wins-losses"; decisions are the rest. The
  // history tally is the fallback when the summary is missing.
  const stat = (type) => (a.statsSummary?.statistics ?? []).find((x) => x.type === type)?.displayValue ?? null;
  const pair = (text) => { const m = String(text ?? '').match(/^(\d+)-(\d+)$/); return m ? [+m[1], +m[2]] : null; };
  const tally = (result) => history.filter((h) => h.result === result).reduce((m, h) => { m[h.category ?? 'other'] = (m[h.category ?? 'other'] ?? 0) + 1; return m; }, { ko: 0, sub: 0, dec: 0, other: 0 });
  const record = recordOf(stat('wins-losses-draws')) ?? { wins: history.filter((h) => h.result === 'win').length, losses: history.filter((h) => h.result === 'loss').length, draws: history.filter((h) => h.result === 'draw').length, nc: history.filter((h) => h.result === 'nc').length };
  const ko = pair(stat('tkos-tkolosses')); const sub = pair(stat('submissions-submissionlosses'));
  const methods = ko && sub
    ? { wins: { ko: ko[0], sub: sub[0], dec: Math.max(0, record.wins - ko[0] - sub[0]), other: 0 }, losses: { ko: ko[1], sub: sub[1], dec: Math.max(0, record.losses - ko[1] - sub[1]), other: 0 } }
    : { wins: tally('win'), losses: tally('loss') };
  return {
    id: String(a.id), name: a.displayName ?? a.fullName, nickname: a.nickname ?? null,
    record,
    bio: { age: a.age ?? null, height: a.displayHeight ?? null, weight: a.displayWeight ?? null, reach: a.displayReach ?? null, stance: a.stance?.text ?? null, style: a.displayFightingStyle ?? null, weightClass: a.weightClass?.text ?? null, team: a.association?.name ?? null, country: a.citizenship ?? null },
    headshot: a.headshot?.href ?? null, flag: a.flag?.href ?? null,
    lastFive: history.slice(0, 5).map((h) => h.result),
    methods,
    history, builtAt: now,
  };
}

const parsed = events.map(parseEvent);
const index = { builtAt: now, events: parsed.map((e) => ({ id: e.id, name: e.name, shortName: e.shortName, date: e.date, venue: e.venue, status: e.status, bouts: e.bouts.length })) };
for (const e of parsed) say(`  ${e.shortName}: ${e.bouts.length} bouts (${e.bouts.filter((b) => b.segment === 'main').length} main), status ${e.status}${e.bouts.filter((b) => b.status === 'final').length ? `, ${e.bouts.filter((b) => b.status === 'final').length} final` : ''}`);

// Card changes: the stored event, bout by bout, against this pull.
async function withChanges(e) {
  const stored = DRY ? null : await readKv(`ufc:event:${e.id}`).catch(() => null);
  const changes = [...(stored?.changes ?? [])];
  if (stored) {
    const was = new Map(stored.bouts.map((b) => [b.id, b]));
    const isNow = new Map(e.bouts.map((b) => [b.id, b]));
    for (const b of e.bouts) {
      const w = was.get(b.id);
      if (!w) { changes.push({ at: now, type: 'added', boutId: b.id, detail: `${b.a?.name} vs ${b.b?.name} added to the card` }); continue; }
      for (const k of ['a', 'b']) if (w[k]?.id && b[k]?.id && w[k].id !== b[k].id) changes.push({ at: now, type: 'replaced', boutId: b.id, detail: `${b[k].name} in for ${w[k].name}${b.date ? ` on ${Math.max(0, Math.round((b.date - now) / 864e5))} days' notice` : ''}` });
      if (w.status !== 'cancelled' && b.status === 'cancelled') changes.push({ at: now, type: 'removed', boutId: b.id, detail: `${b.a?.name} vs ${b.b?.name} is off the card` });
      if (w.segment !== b.segment) changes.push({ at: now, type: 'moved', boutId: b.id, detail: `${b.a?.name} vs ${b.b?.name} moved to the ${b.segment === 'main' ? 'main card' : b.segment === 'early' ? 'early prelims' : 'prelims'}` });
    }
    for (const w of stored.bouts) if (!isNow.has(w.id) && w.status !== 'cancelled') changes.push({ at: now, type: 'removed', boutId: w.id, detail: `${w.a?.name} vs ${w.b?.name} is off the card` });
  }
  return { ...e, changes: changes.slice(-40) };
}

const records = [];
for (const e of parsed) records.push(await withChanges(e));
for (const r of records) for (const c of r.changes.filter((c) => c.at === now)) say(`  change: ${r.shortName}: ${c.type}: ${c.detail}`);

// Fighter profiles: everyone on the next two cards, plus the year-long index on --index.
const nextTwo = records.filter((e) => e.status !== 'final').slice(0, 2);
const ids = new Map();
for (const e of nextTwo) for (const b of e.bouts) for (const k of ['a', 'b']) if (b[k]?.id) ids.set(b[k].id, b[k].name);
let indexIds = new Map(ids);
if (INDEX) {
  for (let back = 365; back > 0; back -= 60) {
    const chunk = await getJson(`${SITE}/scoreboard?dates=${ymd(now - back * 864e5)}-${ymd(now - Math.max(0, back - 60) * 864e5)}`);
    for (const e of chunk?.events ?? []) for (const c of e.competitions ?? []) for (const p of c.competitors ?? []) if (p.athlete?.id) indexIds.set(String(p.athlete.id), p.athlete.displayName);
  }
  say(`${indexIds.size} fighters on UFC cards in the last year`);
}
const fighters = (await pool([...indexIds.keys()], async (id) => parseFighter(await getJson(`${ATHLETE}/${id}?enable=history`)))).filter(Boolean);
say(`${fighters.length} fighter profiles (${ids.size} on the next two cards)`);
const headshotOf = new Map(fighters.map((f) => [f.id, f.headshot]));
for (const r of records) for (const b of r.bouts) for (const k of ['a', 'b']) if (b[k]?.id && headshotOf.get(b[k].id)) b[k].headshot = headshotOf.get(b[k].id);

const entries = [
  { key: 'ufc:events', value: index },
  ...records.map((r) => ({ key: `ufc:event:${r.id}`, value: r })),
  ...fighters.map((f) => ({ key: `ufc:fighter:${f.id}`, value: f })),
];
if (INDEX || !(await readKv('ufc:fighters').catch(() => null))) {
  entries.push({ key: 'ufc:fighters', value: { builtAt: now, fighters: fighters.map((f) => ({ id: f.id, name: f.name, nickname: f.nickname, weightClass: f.bio.weightClass, record: f.record, headshot: f.headshot })).sort((a, b) => a.name.localeCompare(b.name)) } });
} else if (fighters.length) {
  // Keep the search index current with whoever is on the next cards.
  const stored = await readKv('ufc:fighters');
  const byId = new Map((stored?.fighters ?? []).map((f) => [f.id, f]));
  for (const f of fighters) byId.set(f.id, { id: f.id, name: f.name, nickname: f.nickname, weightClass: f.bio.weightClass, record: f.record, headshot: f.headshot });
  entries.push({ key: 'ufc:fighters', value: { builtAt: now, fighters: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) } });
}
say(`${entries.length} keys, ${(entries.reduce((n, e) => n + JSON.stringify(e.value).length, 0) / 1e6).toFixed(2)} MB`);
if (DRY) process.exit(0);
await writeKv(entries, { ttlSeconds: 14 * 86400, say });
