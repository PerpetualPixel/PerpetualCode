/**
 * The results channel's daily and weekly roll-ups (worker/src/
 * discord-results-digest.js): the 6am-to-6am ET window, which plays fall
 * in it, the day's line and record, Playbook's tag, the week, and the
 * once-a-day / once-a-week run against a fake KV and a fake Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_HOUR, DIGEST_DAY_KEY, DIGEST_WEEK_KEY,
  etClock, etInstant, shiftDate, digestWindow, settledIn, resultLine, recordLine, packLines,
  dailyDigestMessage, weeklyDigestMessage, runResultsDigest, digestStatus,
} from '../worker/src/discord-results-digest.js';
import { playbookTag } from '../worker/src/discord-nba.js';

const UPDATES = 'https://discord.com/api/webhooks/223456789012345678/zzzDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const PLAYBOOK = '1408438245594763375';

function makeEnv(extra = {}) {
  const store = new Map();
  return { store, env: { ...extra, POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
function fakeDiscord(reply = null) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const call = { url, method: init.method, body: JSON.parse(init.body) };
    calls.push(call);
    const r = reply ? reply(call, calls.length) : null;
    const status = r?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r?.body ?? { id: `90000000000000000${++n}` } };
  };
  return { calls, fetch };
}
const at = (dateKey, hour, minute = 0) => etInstant(dateKey, hour) + minute * 60e3;
const play = (over = {}) => ({ id: `atp:${Math.random()}`, matchId: 'atp:1', tour: 'atp', event: 'Nitto ATP Finals', a: 'Jannik Sinner', b: 'Carlos Alcaraz', market: 'live_ml', side: 'a', american: -175, bookId: 'fanduel', book: 'FanDuel', units: 1, selection: 'Jannik Sinner to win the match (live)', postedAt: 0, status: 'graded', result: 'win', actual: '6-4 6-4', profit: 0.57, gradedAt: 0, ...over });

test('the window runs 6am ET to 6am ET and is labelled with the day before, across a clock change', () => {
  const w = digestWindow('2026-11-25');
  assert.equal(w.playedDateKey, '2026-11-24');
  assert.deepEqual([etClock(w.startMs).date, etClock(w.startMs).hour, etClock(w.endMs).date, etClock(w.endMs).hour], ['2026-11-24', DIGEST_HOUR, '2026-11-25', DIGEST_HOUR]);
  assert.equal(w.endMs - w.startMs, 24 * 3600e3);
  // The morning after the clocks fall back (Sun Nov 1, 2026): 25 hours, both ends still 6am on the wall.
  const dst = digestWindow('2026-11-01');
  assert.equal(dst.endMs - dst.startMs, 25 * 3600e3);
  assert.equal(etClock(dst.startMs).hour, 6);
  assert.equal(etClock(etInstant('2026-07-04', 6)).hour, 6);
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(etClock(at('2026-11-23', 6, 7)).weekday, 'Mon');
});

test('settledIn keeps what settled inside the window, once each, oldest first, and leaves open plays out', () => {
  const s = at('2026-11-24', 6); const e = at('2026-11-25', 6);
  const a = play({ id: 'a', gradedAt: s + 3600e3 });
  const b = play({ id: 'b', gradedAt: e - 1, status: 'void', result: 'void' });
  const before = play({ id: 'before', gradedAt: s - 1 });
  const after = play({ id: 'after', gradedAt: e });
  const open = play({ id: 'open', status: 'pending', result: null, gradedAt: undefined, postedAt: s + 10 });
  assert.deepEqual(settledIn([b, a, before, after, open, a], s, e).map((p) => p.id), ['a', 'b']);
});

test('a result line: how it ended, the bet, the score, the units, the price and book, the match; a lean carries no units', () => {
  assert.equal(resultLine(play()), '✅ **Jannik Sinner to win the match** · Final 6-4 6-4 · **+0.57u** · −175 at FanDuel · Jannik Sinner vs Carlos Alcaraz · ATP');
  assert.equal(resultLine(play({ result: 'loss', profit: -1, actual: '4-6 4-6' })), '❌ **Jannik Sinner to win the match** · Final 4-6 4-6 · **−1.00u** · −175 at FanDuel · Jannik Sinner vs Carlos Alcaraz · ATP');
  assert.equal(resultLine(play({ status: 'void', result: 'void', actual: '6-4 2-1: a retirement', profit: 0 })), '⚪ **Jannik Sinner to win the match** · Void · 6-4 2-1: a retirement · −175 at FanDuel · Jannik Sinner vs Carlos Alcaraz · ATP');
  assert.equal(resultLine(play({ lean: true, american: undefined, playable: -186, selection: 'Carlos Alcaraz to win set 2', market: 'live_set', set: 2 })), '✅ Lean · **Carlos Alcaraz to win set 2** · Final 6-4 6-4 · −186 or better · Jannik Sinner vs Carlos Alcaraz · ATP');
});

test('the record line: tracked plays with units and ROI, leans counted beside them, nothing when there is nothing', () => {
  const plays = [play({ profit: 0.57 }), play({ result: 'loss', profit: -1 }), play({ status: 'void', result: 'void', profit: 0 }), play({ lean: true, profit: 0.5 }), play({ lean: true, result: 'loss', profit: -1 })];
  assert.equal(recordLine(plays), 'Record 1-1-1 · −0.43u · ROI −21.5% · Leans 1-1');
  assert.equal(recordLine([play({ lean: true })]), 'Leans 1-0');
  assert.equal(recordLine([]), '');
});

test('packLines keeps every line and never passes the limit', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(150)}`);
  const pages = packLines(lines, 1000);
  assert.ok(pages.length > 1);
  for (const p of pages) assert.ok(p.length <= 1000);
  assert.equal(pages.join('\n'), lines.join('\n'));
  assert.deepEqual(packLines([]), []);
});

test('the daily post: Playbook tagged in the content and allowed to ping, the day in the title, the record in the footer', () => {
  const plays = [play({ profit: 0.57 }), play({ result: 'loss', profit: -1, actual: '4-6 4-6' })];
  const m = dailyDigestMessage('2026-11-24', plays, { playbook: PLAYBOOK });
  assert.equal(m.content, `<@${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.deepEqual(m.allowed_mentions, { parse: [], users: [PLAYBOOK] });
  assert.equal(m.embeds.length, 1);
  assert.equal(m.embeds[0].title, '📊 TENNIS RESULTS · Tue, Nov 24 · 2 plays');
  assert.equal(m.embeds[0].description.split('\n').length, 2);
  assert.equal(m.embeds[0].footer.text, 'Record 1-1 · −0.43u · ROI −21.5% · perpetualpicks.com');
  // A role as Playbook: pinged as a role.
  const role = dailyDigestMessage('2026-11-24', plays, { playbook: `&${PLAYBOOK}` });
  assert.equal(role.content, `<@&${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.deepEqual(role.allowed_mentions, { parse: [], users: [], roles: [PLAYBOOK] });
  // Nobody known: no tag, nothing may ping.
  const plain = dailyDigestMessage('2026-11-24', plays);
  assert.equal(plain.content, '');
  assert.deepEqual(plain.allowed_mentions, { parse: [], users: [] });
  // A long day runs into more embeds, the title on the first and the record on the last.
  const many = Array.from({ length: 60 }, (_, i) => play({ id: `p${i}` }));
  const long = dailyDigestMessage('2026-11-24', many);
  assert.ok(long.embeds.length > 1);
  assert.ok(long.embeds[0].title.endsWith('60 plays'));
  assert.equal(long.embeds[1].title, undefined);
  assert.equal(long.embeds.at(-1).footer.text, 'Record 60-0 · +34.20u · ROI +57.0% · perpetualpicks.com');
});

test('the weekly post: a line a day with its record, the week in the title, the totals in the footer', () => {
  const days = [
    { dateKey: '2026-11-16', plays: [play({ profit: 0.57 }), play({ result: 'loss', profit: -1 })] },
    { dateKey: '2026-11-17', plays: [] },
    { dateKey: '2026-11-18', plays: [play({ lean: true })] },
    { dateKey: '2026-11-19', plays: [] }, { dateKey: '2026-11-20', plays: [] }, { dateKey: '2026-11-21', plays: [] },
    { dateKey: '2026-11-22', plays: [play({ profit: 0.57 })] },
  ];
  const m = weeklyDigestMessage('2026-11-16', days, { playbook: PLAYBOOK });
  assert.equal(m.content, `<@${PLAYBOOK}> Week of Nov 16`);
  assert.equal(m.embeds[0].title, '🗓️ WEEKLY TENNIS RESULTS · Nov 16 – Nov 22 · 4 plays');
  const lines = m.embeds[0].description.split('\n');
  assert.equal(lines[0], '**Mon, Nov 16** · 2 plays · Record 1-1 · −0.43u · ROI −21.5%');
  assert.equal(lines[1], '**Tue, Nov 17** · no plays');
  assert.equal(lines[2], '**Wed, Nov 18** · 1 play · Leans 1-0');
  assert.equal(lines[6], '**Sun, Nov 22** · 1 play · Record 1-0 · +0.57u · ROI +57.0%');
  assert.equal(m.embeds[0].footer.text, 'Week: Record 2-1 · +0.14u · ROI +4.7% · Leans 1-0 · perpetualpicks.com');
});

const stored = (store, dateKey, plays) => store.set(`tennis:liveplays:${dateKey}`, JSON.stringify({ date: dateKey, plays }));

test('the run: yesterday posts once at 6am ET through the results webhook, with Playbook tagged, and never again', async () => {
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_PLAYBOOK_USER_ID: PLAYBOOK });
  const w = digestWindow('2026-11-25');
  stored(store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 3600e3 }), play({ id: 'early', gradedAt: w.startMs - 3600e3 })]);
  stored(store, '2026-11-25', [play({ id: 'b', gradedAt: w.endMs - 60e3, result: 'loss', profit: -1 }), play({ id: 'late', gradedAt: w.endMs + 60e3 })]);
  const d = fakeDiscord();
  const r = await runResultsDigest(env, at('2026-11-25', 6, 7), { deps: { fetch: d.fetch } });
  assert.deepEqual(r, { date: '2026-11-25', daily: { posted: 1, day: '2026-11-24', plays: 2 }, weekly: null });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].method, 'POST');
  assert.equal(d.calls[0].url, `${UPDATES}?wait=true`);
  assert.equal(d.calls[0].body.content, `<@${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.deepEqual(d.calls[0].body.allowed_mentions, { parse: [], users: [PLAYBOOK] });
  assert.equal(d.calls[0].body.embeds[0].title, '📊 TENNIS RESULTS · Tue, Nov 24 · 2 plays');
  assert.match(d.calls[0].body.embeds[0].footer.text, /^Record 1-1 · −0\.43u/);
  assert.ok(store.has(DIGEST_DAY_KEY('2026-11-24')));
  // The other ticks of the hour, and a forced run later in the day: nothing more.
  assert.equal((await runResultsDigest(env, at('2026-11-25', 6, 22), { deps: { fetch: d.fetch } })).daily.skipped, 'posted');
  assert.equal((await runResultsDigest(env, at('2026-11-25', 14), { force: true, deps: { fetch: d.fetch } })).daily.skipped, 'posted');
  assert.equal(d.calls.length, 1);
  const s = await digestStatus(env);
  assert.deepEqual(s, { on: true, hourEt: 6, lastDaily: { day: '2026-11-24', at: at('2026-11-25', 6, 7), plays: 2, tagged: true }, lastWeekly: null });
});

test('the run: off with no results webhook, nothing outside the hour unless forced, nothing on a day with no settled play, and a refusal is tried again next tick', async () => {
  assert.deepEqual(await runResultsDigest(makeEnv().env, at('2026-11-25', 6)), { off: true });
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES });
  const d = fakeDiscord();
  assert.deepEqual(await runResultsDigest(env, at('2026-11-25', 12), { deps: { fetch: d.fetch } }), { skipped: 'hour' });
  assert.equal((await runResultsDigest(env, at('2026-11-25', 12), { force: true, deps: { fetch: d.fetch } })).daily.skipped, 'no plays');
  assert.equal(d.calls.length, 0);
  assert.ok(!store.has(DIGEST_DAY_KEY('2026-11-24')));
  // A play is there but Discord refuses: not recorded, so the next tick posts it.
  const w = digestWindow('2026-11-25');
  stored(store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 1 })]);
  const refusing = fakeDiscord((call, n) => (n === 1 ? { status: 400, body: { message: 'no' } } : null));
  assert.deepEqual((await runResultsDigest(env, at('2026-11-25', 6, 7), { deps: { fetch: refusing.fetch } })).daily, { failed: 400, day: '2026-11-24' });
  assert.ok(!store.has(DIGEST_DAY_KEY('2026-11-24')));
  assert.deepEqual((await runResultsDigest(env, at('2026-11-25', 6, 22), { deps: { fetch: refusing.fetch } })).daily, { posted: 1, day: '2026-11-24', plays: 1 });
  assert.equal(refusing.calls[1].body.content, '', 'nobody known to tag: no content, and the id saved in the app is not there either');
});

test('the run: Monday posts the week that ended this morning, from the plays, once', async () => {
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_PLAYBOOK_ROLE_ID: `<@&${PLAYBOOK}>` });
  // Plays across the week of Mon Nov 16 - Sun Nov 22 (each in its 6am-to-6am window), one before it, one after.
  stored(store, '2026-11-16', [play({ id: 'mon', gradedAt: at('2026-11-16', 9) }), play({ id: 'prev', gradedAt: at('2026-11-16', 5) })]);
  stored(store, '2026-11-18', [play({ id: 'wed', gradedAt: at('2026-11-18', 22), result: 'loss', profit: -1 })]);
  stored(store, '2026-11-22', [play({ id: 'sun-late', gradedAt: at('2026-11-23', 2) })]); // 2am Monday ET: still Sunday's window
  stored(store, '2026-11-23', [play({ id: 'next', gradedAt: at('2026-11-23', 7) })]);
  const d = fakeDiscord();
  const r = await runResultsDigest(env, at('2026-11-23', 6, 7), { deps: { fetch: d.fetch } });
  assert.deepEqual(r.daily, { posted: 1, day: '2026-11-22', plays: 1 });
  assert.deepEqual(r.weekly, { posted: 1, week: '2026-11-16', plays: 3 });
  assert.equal(d.calls.length, 2);
  const week = d.calls[1].body;
  assert.equal(week.content, `<@&${PLAYBOOK}> Week of Nov 16`);
  assert.deepEqual(week.allowed_mentions, { parse: [], users: [], roles: [PLAYBOOK] });
  assert.equal(week.embeds[0].title, '🗓️ WEEKLY TENNIS RESULTS · Nov 16 – Nov 22 · 3 plays');
  const lines = week.embeds[0].description.split('\n');
  assert.equal(lines[0], '**Mon, Nov 16** · 1 play · Record 1-0 · +0.57u · ROI +57.0%');
  assert.equal(lines[2], '**Wed, Nov 18** · 1 play · Record 0-1 · −1.00u · ROI −100.0%');
  assert.equal(lines[6], '**Sun, Nov 22** · 1 play · Record 1-0 · +0.57u · ROI +57.0%');
  assert.equal(week.embeds[0].footer.text, 'Week: Record 2-1 · +0.14u · ROI +4.7% · perpetualpicks.com');
  assert.ok(store.has(DIGEST_WEEK_KEY('2026-11-16')));
  // The next tick: both already posted.
  const again = await runResultsDigest(env, at('2026-11-23', 6, 22), { deps: { fetch: d.fetch } });
  assert.deepEqual([again.daily.skipped, again.weekly.skipped], ['posted', 'posted']);
  assert.equal(d.calls.length, 2);
  // Tuesday: no weekly.
  assert.equal((await runResultsDigest(env, at('2026-11-24', 6, 7), { deps: { fetch: d.fetch } })).weekly, null);
});

test('playbookTag: the member id from the secret however it was pasted, the role when that is what was given, the app setting when neither is set', async () => {
  const kv = { async get() { return null; }, async put() {} };
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_USER_ID: PLAYBOOK, POTD_KV: kv }), PLAYBOOK);
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_USER_ID: `<@${PLAYBOOK}>`, POTD_KV: kv }), PLAYBOOK);
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_ROLE_ID: PLAYBOOK, POTD_KV: kv }), `&${PLAYBOOK}`);
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_USER_ID: 'not an id', POTD_KV: kv }), null);
});
