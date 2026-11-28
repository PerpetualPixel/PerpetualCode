/**
 * The results channels' daily and weekly roll-ups (worker/src/
 * discord-results-digest.js): the 6am-to-6am ET window, which plays fall
 * in it, the day's line and record, Playbook's tag, the week, and the
 * once-a-day / once-a-week run against a fake KV and a fake Discord —
 * for tennis from its day records, for the NBA from its channel ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_HOUR, DIGEST_DAY_KEY, DIGEST_WEEK_KEY, DIGEST_ONE_OFF_KEY, ONE_OFF,
  etClock, etInstant, shiftDate, digestWindow, settledIn, resultLine, slipResultLine, recordLine, packLines, sumTallies, talliesOf,
  dailyDigestMessage, weeklyDigestMessage, runResultsDigest, digestStatus, ledgerPlays,
} from '../worker/src/discord-results-digest.js';
import { playbookTag, LEAGUES } from '../worker/src/discord-nba.js';

const UPDATES = 'https://discord.com/api/webhooks/223456789012345678/zzzDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const NBA_RESULTS = 'https://discord.com/api/webhooks/623456789012345678/nbaRES_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const PLAYBOOK = '1408438245594763375';

function makeEnv(extra = {}) {
  const store = new Map();
  return { store, env: { ...extra, POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
function fakeDiscord(reply = null) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const form = typeof init.body !== 'string';
    const call = { url, method: init.method, body: JSON.parse(form ? init.body.get('payload_json') : init.body), file: form ? init.body.get('files[0]') : null };
    calls.push(call);
    const r = reply ? reply(call, calls.length) : null;
    const status = r?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r?.body ?? { id: `90000000000000000${++n}` } };
  };
  return { calls, fetch };
}
const at = (dateKey, hour, minute = 0) => etInstant(dateKey, hour) + minute * 60e3;
const play = (over = {}) => ({ id: `atp:${Math.random()}`, matchId: 'atp:1', tour: 'atp', event: 'Nitto ATP Finals', a: 'Jannik Sinner', b: 'Carlos Alcaraz', market: 'live_ml', side: 'a', american: -175, bookId: 'fanduel', book: 'FanDuel', units: 1, selection: 'Jannik Sinner to win the match (live)', postedAt: 0, status: 'graded', result: 'win', actual: '6-4 6-4', profit: 0.57, gradedAt: 0, ...over });
/** A settled NBA post as the channel ledger keeps it (worker/src/discord-nba.js's gradePost). */
const nbaPost = (over = {}) => ({ id: `g1:fanduel:${Math.random()}`, gameId: 'g1', game: 'New York Knicks at Boston Celtics', league: 'nba', bookId: 'fanduel', book: 'FanDuel', american: 105, decimal: 2.05, units: 1, postedAt: 0,
  legs: [{ player: 'Jalen Brunson', stat: 'points', label: 'Pts', point: 19.5, final: 27, hit: true }, { player: 'Jayson Tatum', stat: 'rebounds', label: 'Reb', point: 7.5, final: 9, hit: true }],
  status: 'graded', result: 'win', profit: 1.05, finalScore: { NY: 110, BOS: 104 }, gradedAt: 0, ...over });

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

test('a tennis result line: how it ended, the bet, the score, the units, the price and book, the match; a lean carries no units', () => {
  assert.equal(resultLine(play()), '✅ **Jannik Sinner to win the match** · Final 6-4 6-4 · **+0.57u** · −175 at FanDuel · Jannik Sinner vs Carlos Alcaraz · ATP');
  assert.equal(resultLine(play({ result: 'loss', profit: -1, actual: '4-6 4-6' })), '❌ **Jannik Sinner to win the match** · Final 4-6 4-6 · **−1.00u** · −175 at FanDuel · Jannik Sinner vs Carlos Alcaraz · ATP');
  assert.equal(resultLine(play({ status: 'void', result: 'void', actual: '6-4 2-1: a retirement', profit: 0 })), '⚪ **Jannik Sinner to win the match** · Void · 6-4 2-1: a retirement · −175 at FanDuel · Jannik Sinner vs Carlos Alcaraz · ATP');
  assert.equal(resultLine(play({ lean: true, american: undefined, playable: -186, selection: 'Carlos Alcaraz to win set 2', market: 'live_set', set: 2 })), '✅ Lean · **Carlos Alcaraz to win set 2** · Final 6-4 6-4 · −186 or better · Jannik Sinner vs Carlos Alcaraz · ATP');
});

test('an NBA result line: how it ended, the game and final, the slip at its book, the units, each leg with its final number', () => {
  assert.equal(slipResultLine(nbaPost()), '✅ **New York Knicks at Boston Celtics** · Final NY 110, BOS 104 · 2 legs +105 at FanDuel · **+1.05u** · Brunson Over 19.5 Pts (27) ✓, Tatum Over 7.5 Reb (9) ✓');
  assert.equal(slipResultLine(nbaPost({ result: 'loss', profit: -1, legs: [{ player: 'Jalen Brunson', stat: 'points', label: 'Pts', point: 19.5, final: 12, hit: false }] })), '❌ **New York Knicks at Boston Celtics** · Final NY 110, BOS 104 · 1 legs +105 at FanDuel · **−1.00u** · Brunson Over 19.5 Pts (12) ✗');
  assert.equal(slipResultLine(nbaPost({ status: 'void', result: 'void', profit: 0, finalScore: null, score: null, legs: [{ player: 'Jalen Brunson', stat: 'points', label: 'Pts', point: 19.5, final: null, hit: null }] })), '⚪ **New York Knicks at Boston Celtics** · 1 legs +105 at FanDuel · Void · stake returned · Brunson Over 19.5 Pts');
});

test('the record line: tracked plays with units and ROI, leans counted beside them, nothing when there is nothing; tallies add up', () => {
  const plays = [play({ profit: 0.57 }), play({ result: 'loss', profit: -1 }), play({ status: 'void', result: 'void', profit: 0 }), play({ lean: true, profit: 0.5 }), play({ lean: true, result: 'loss', profit: -1 })];
  assert.equal(recordLine(plays), 'Record 1-1-1 · −0.43u · ROI −21.5% · Leans 1-1');
  assert.equal(recordLine([play({ lean: true })]), 'Leans 1-0');
  assert.equal(recordLine([]), '');
  const total = sumTallies([talliesOf(plays), talliesOf([play({ profit: 0.57 })])]);
  assert.deepEqual([total.tally.wins, total.tally.losses, total.tally.voids, total.tally.units, total.tally.roi, total.leans.wins], [2, 1, 1, 0.14, 0.047, 1]);
});

test('packLines keeps every line and never passes the limit', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(150)}`);
  const pages = packLines(lines, 1000);
  assert.ok(pages.length > 1);
  for (const p of pages) assert.ok(p.length <= 1000);
  assert.equal(pages.join('\n'), lines.join('\n'));
  assert.deepEqual(packLines([]), []);
});

test('the daily post: Playbook tagged in the content and allowed to ping, the day in the title, the record in the footer; the sport in the words', () => {
  const plays = [play({ profit: 0.57 }), play({ result: 'loss', profit: -1, actual: '4-6 4-6' })];
  const m = dailyDigestMessage('2026-11-24', plays, { playbook: PLAYBOOK });
  assert.equal(m.content, `<@${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.deepEqual(m.allowed_mentions, { parse: [], users: [PLAYBOOK] });
  assert.equal(m.embeds.length, 1);
  assert.equal(m.embeds[0].title, '📊 TENNIS RESULTS · Tue, Nov 24 · 2 plays');
  assert.equal(m.embeds[0].author.name, 'PERPETUAL PICKS · LIVE TENNIS');
  assert.equal(m.embeds[0].description.split('\n').length, 2);
  assert.equal(m.embeds[0].footer.text, 'Record 1-1 · −0.43u · ROI −21.5% · perpetualpicks.com');
  const nba = dailyDigestMessage('2026-11-24', [nbaPost()], { label: 'NBA', line: slipResultLine });
  assert.equal(nba.embeds[0].title, '📊 NBA RESULTS · Tue, Nov 24 · 1 play');
  assert.equal(nba.embeds[0].author.name, 'PERPETUAL PICKS · LIVE NBA');
  assert.match(nba.embeds[0].description, /^✅ \*\*New York Knicks at Boston Celtics\*\*/);
  assert.equal(nba.embeds[0].footer.text, 'Record 1-0 · +1.05u · ROI +105.0% · perpetualpicks.com');
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
  const day = (dateKey, plays) => ({ dateKey, count: plays.length, ...talliesOf(plays) });
  const days = [
    day('2026-11-16', [play({ profit: 0.57 }), play({ result: 'loss', profit: -1 })]),
    day('2026-11-17', []),
    day('2026-11-18', [play({ lean: true })]),
    day('2026-11-19', []), day('2026-11-20', []), day('2026-11-21', []),
    day('2026-11-22', [play({ profit: 0.57 })]),
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
  assert.equal(weeklyDigestMessage('2026-11-16', days, { label: 'NBA' }).embeds[0].title, '🗓️ WEEKLY NBA RESULTS · Nov 16 – Nov 22 · 4 plays');
});

const stored = (store, dateKey, plays) => store.set(`tennis:liveplays:${dateKey}`, JSON.stringify({ date: dateKey, plays }));

test('the run: yesterday posts once at 6am ET through the results webhook, with Playbook tagged, and never again', async () => {
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_PLAYBOOK_USER_ID: PLAYBOOK });
  const w = digestWindow('2026-11-25');
  stored(store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 3600e3 }), play({ id: 'early', gradedAt: w.startMs - 3600e3 })]);
  stored(store, '2026-11-25', [play({ id: 'b', gradedAt: w.endMs - 60e3, result: 'loss', profit: -1 }), play({ id: 'late', gradedAt: w.endMs + 60e3 })]);
  const d = fakeDiscord();
  const r = await runResultsDigest(env, at('2026-11-25', 6, 7), { deps: { fetch: d.fetch, oneOff: null } });
  assert.deepEqual(r, { date: '2026-11-25', daily: { posted: 1, day: '2026-11-24', plays: 2, card: false }, weekly: null, nba: { off: true }, nfl: { off: true } });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].method, 'POST');
  assert.equal(d.calls[0].url, `${UPDATES}?wait=true`);
  assert.equal(d.calls[0].body.content, `<@${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.deepEqual(d.calls[0].body.allowed_mentions, { parse: [], users: [PLAYBOOK] });
  assert.equal(d.calls[0].body.embeds[0].title, '📊 TENNIS RESULTS · Tue, Nov 24 · 2 plays');
  assert.match(d.calls[0].body.embeds[0].footer.text, /^Record 1-1 · −0\.43u/);
  const rec = JSON.parse(store.get(DIGEST_DAY_KEY('2026-11-24')));
  assert.deepEqual([rec.plays, rec.tally.wins, rec.tally.losses, rec.leans.wins], [2, 1, 1, 0], 'the day record keeps the tally for the week');
  // The other ticks of the hour, and a forced run later in the day: nothing more.
  assert.equal((await runResultsDigest(env, at('2026-11-25', 6, 22), { deps: { fetch: d.fetch, oneOff: null } })).daily.skipped, 'posted');
  assert.equal((await runResultsDigest(env, at('2026-11-25', 14), { force: true, deps: { fetch: d.fetch, oneOff: null } })).daily.skipped, 'posted');
  assert.equal(d.calls.length, 1);
  const s = await digestStatus(env);
  assert.deepEqual(s, { on: true, hourEt: 6, lastDaily: { day: '2026-11-24', at: at('2026-11-25', 6, 7), plays: 2, tagged: true }, lastWeekly: null, nba: { on: false, lastDaily: null, lastWeekly: null }, nfl: { on: false, lastDaily: null, lastWeekly: null }, wins: { on: false, lastDaily: null } });
});

test('the run: off with no results webhook, nothing outside the hour unless forced, nothing on a day with no settled play, and a refusal is tried again next tick', async () => {
  assert.deepEqual(await runResultsDigest(makeEnv().env, at('2026-11-25', 6), { deps: { oneOff: null } }), { off: true });
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES });
  const d = fakeDiscord();
  assert.deepEqual(await runResultsDigest(env, at('2026-11-25', 12), { deps: { fetch: d.fetch, oneOff: null } }), { skipped: 'hour' });
  assert.equal((await runResultsDigest(env, at('2026-11-25', 12), { force: true, deps: { fetch: d.fetch, oneOff: null } })).daily.skipped, 'no plays');
  assert.equal(d.calls.length, 0);
  assert.ok(!store.has(DIGEST_DAY_KEY('2026-11-24')));
  // A play is there but Discord refuses: not recorded, so the next tick posts it.
  const w = digestWindow('2026-11-25');
  stored(store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 1 })]);
  const refusing = fakeDiscord((call, n) => (n === 1 ? { status: 400, body: { message: 'no' } } : null));
  assert.deepEqual((await runResultsDigest(env, at('2026-11-25', 6, 7), { deps: { fetch: refusing.fetch, oneOff: null } })).daily, { failed: 400, day: '2026-11-24' });
  assert.ok(!store.has(DIGEST_DAY_KEY('2026-11-24')));
  assert.deepEqual((await runResultsDigest(env, at('2026-11-25', 6, 22), { deps: { fetch: refusing.fetch, oneOff: null } })).daily, { posted: 1, day: '2026-11-24', plays: 1, card: false });
  assert.equal(refusing.calls[1].body.content, '', 'nobody known to tag: no content, and the id saved in the app is not there either');
});

test('the run: Monday posts the week that ended this morning, from the day records where there are any and the plays where not, once', async () => {
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_PLAYBOOK_ROLE_ID: `<@&${PLAYBOOK}>` });
  // Plays across the week of Mon Nov 16 - Sun Nov 22 (each in its 6am-to-6am window), one before it, one after.
  stored(store, '2026-11-16', [play({ id: 'mon', gradedAt: at('2026-11-16', 9) }), play({ id: 'prev', gradedAt: at('2026-11-16', 5) })]);
  stored(store, '2026-11-18', [play({ id: 'wed', gradedAt: at('2026-11-18', 22), result: 'loss', profit: -1 })]);
  stored(store, '2026-11-22', [play({ id: 'sun-late', gradedAt: at('2026-11-23', 2) })]); // 2am Monday ET: still Sunday's window
  stored(store, '2026-11-23', [play({ id: 'next', gradedAt: at('2026-11-23', 7) })]);
  // Monday's day record is on file with a different tally than its plays would give: the record wins.
  store.set(DIGEST_DAY_KEY('2026-11-16'), JSON.stringify({ at: 1, plays: 3, tally: { wins: 2, losses: 1, voids: 0, pending: 0, staked: 3, units: 0.14, roi: 0.047 }, leans: { wins: 0, losses: 0, voids: 0, pending: 0, staked: 0, units: 0, roi: null } }));
  const d = fakeDiscord();
  const r = await runResultsDigest(env, at('2026-11-23', 6, 7), { deps: { fetch: d.fetch, oneOff: null } });
  assert.deepEqual(r.daily, { posted: 1, day: '2026-11-22', plays: 1, card: false });
  assert.deepEqual(r.weekly, { posted: 1, week: '2026-11-16', plays: 5, card: false });
  assert.equal(d.calls.length, 2);
  const week = d.calls[1].body;
  assert.equal(week.content, `<@&${PLAYBOOK}> Week of Nov 16`);
  assert.deepEqual(week.allowed_mentions, { parse: [], users: [], roles: [PLAYBOOK] });
  assert.equal(week.embeds[0].title, '🗓️ WEEKLY TENNIS RESULTS · Nov 16 – Nov 22 · 5 plays');
  const lines = week.embeds[0].description.split('\n');
  assert.equal(lines[0], '**Mon, Nov 16** · 3 plays · Record 2-1 · +0.14u · ROI +4.7%', 'from the day record');
  assert.equal(lines[2], '**Wed, Nov 18** · 1 play · Record 0-1 · −1.00u · ROI −100.0%', 'from the plays');
  assert.equal(lines[6], '**Sun, Nov 22** · 1 play · Record 1-0 · +0.57u · ROI +57.0%');
  assert.equal(week.embeds[0].footer.text, 'Week: Record 3-2 · −0.29u · ROI −5.8% · perpetualpicks.com');
  assert.ok(store.has(DIGEST_WEEK_KEY('2026-11-16')));
  // The next tick: both already posted.
  const again = await runResultsDigest(env, at('2026-11-23', 6, 22), { deps: { fetch: d.fetch, oneOff: null } });
  assert.deepEqual([again.daily.skipped, again.weekly.skipped], ['posted', 'posted']);
  assert.equal(d.calls.length, 2);
  // Tuesday: no weekly.
  assert.equal((await runResultsDigest(env, at('2026-11-24', 6, 7), { deps: { fetch: d.fetch, oneOff: null } })).weekly, null);
});

test('the NBA results channel gets its own daily from the channel ledger\'s settled posts, through its own webhook, with its own records', async () => {
  const { env, store } = makeEnv({ DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS, DISCORD_PLAYBOOK_USER_ID: PLAYBOOK });
  const w = digestWindow('2026-11-25');
  const posts = {
    a: { state: 'done', doneAt: w.startMs + 3600e3, post: nbaPost({ id: 'a', gradedAt: w.startMs + 3600e3 }) },
    b: { state: 'done', doneAt: w.endMs - 60e3, post: nbaPost({ id: 'b', gradedAt: w.endMs - 60e3, result: 'loss', profit: -1, legs: [{ player: 'Jayson Tatum', stat: 'rebounds', label: 'Reb', point: 7.5, final: 5, hit: false }] }) },
    open: { state: 'open', at: w.endMs - 1, post: nbaPost({ id: 'open', status: 'pending', result: null, gradedAt: undefined }) },
    failed: { state: 'done', doneAt: w.startMs + 1, editFailed: true, post: nbaPost({ id: 'failed' }) },
    old: { state: 'done', doneAt: w.startMs - 1, post: nbaPost({ id: 'old', gradedAt: w.startMs - 1 }) },
  };
  store.set(LEAGUES.nba.ledger, JSON.stringify({ posts, games: {} }));
  assert.deepEqual((await ledgerPlays(env, 'nba')).map((p) => p.id).sort(), ['a', 'b', 'old'], 'settled posts whose edit landed');
  const d = fakeDiscord();
  const r = await runResultsDigest(env, at('2026-11-25', 6, 7), { deps: { fetch: d.fetch, oneOff: null } });
  assert.deepEqual(r, { date: '2026-11-25', daily: null, weekly: null, nba: { daily: { posted: 1, day: '2026-11-24', plays: 2, card: false }, weekly: null }, nfl: { off: true } }, 'tennis is off: nothing at the top');
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, `${NBA_RESULTS}?wait=true`);
  assert.equal(d.calls[0].body.content, `<@${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.equal(d.calls[0].body.embeds[0].title, '📊 NBA RESULTS · Tue, Nov 24 · 2 plays');
  assert.match(d.calls[0].body.embeds[0].description, /^✅ \*\*New York Knicks at Boston Celtics\*\* · Final NY 110, BOS 104 · 2 legs \+105 at FanDuel · \*\*\+1\.05u\*\* · Brunson Over 19\.5 Pts \(27\) ✓, Tatum Over 7\.5 Reb \(9\) ✓\n❌ /);
  assert.equal(d.calls[0].body.embeds[0].footer.text, 'Record 1-1 · +0.05u · ROI +2.5% · perpetualpicks.com');
  assert.ok(store.has(DIGEST_DAY_KEY('2026-11-24', 'nba')) && !store.has(DIGEST_DAY_KEY('2026-11-24')), 'its own day record, not tennis\'s');
  assert.equal((await runResultsDigest(env, at('2026-11-25', 6, 22), { deps: { fetch: d.fetch, oneOff: null } })).nba.daily.skipped, 'posted');
  assert.equal(d.calls.length, 1);
  const s = await digestStatus(env);
  assert.deepEqual([s.on, s.lastDaily, s.nba.on, s.nba.lastDaily.day, s.nba.lastDaily.plays, s.nfl.on], [false, null, true, '2026-11-24', 2, false]);
  // Monday: the week from the day records (the ledger keeps only days) — one record, the rest empty.
  const mon = makeEnv({ DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS });
  mon.store.set(DIGEST_DAY_KEY('2026-11-20', 'nba'), JSON.stringify({ at: 1, plays: 4, tally: { wins: 3, losses: 1, voids: 0, pending: 0, staked: 4, units: 2.1, roi: 0.525 }, leans: null }));
  mon.store.set(LEAGUES.nba.ledger, JSON.stringify({ posts: {}, games: {} }));
  const d2 = fakeDiscord();
  const r2 = await runResultsDigest(mon.env, at('2026-11-23', 6, 7), { deps: { fetch: d2.fetch, oneOff: null } });
  assert.deepEqual(r2.nba, { daily: { skipped: 'no plays', day: '2026-11-22' }, weekly: { posted: 1, week: '2026-11-16', plays: 4, card: false } });
  assert.equal(d2.calls[0].body.embeds[0].title, '🗓️ WEEKLY NBA RESULTS · Nov 16 – Nov 22 · 4 plays');
  assert.equal(d2.calls[0].body.embeds[0].description.split('\n')[4], '**Fri, Nov 20** · 4 plays · Record 3-1 · +2.10u · ROI +52.5%');
  assert.equal(d2.calls[0].body.embeds[0].footer.text, 'Week: Record 3-1 · +2.10u · ROI +52.5% · perpetualpicks.com');
  // Both channels set up: each gets its own, tennis at the top.
  const both = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS });
  stored(both.store, '2026-11-24', [play({ id: 't', gradedAt: w.startMs + 1 })]);
  both.store.set(LEAGUES.nba.ledger, JSON.stringify({ posts: { a: posts.a }, games: {} }));
  const d3 = fakeDiscord();
  const r3 = await runResultsDigest(both.env, at('2026-11-25', 6, 7), { deps: { fetch: d3.fetch, oneOff: null } });
  assert.deepEqual([r3.daily.posted, r3.nba.daily.posted, d3.calls.map((c) => c.url.split('?')[0])], [1, 1, [UPDATES, NBA_RESULTS]]);
});

test('playbookTag: the member id from the secret however it was pasted, the role when that is what was given, the app setting when neither is set', async () => {
  const kv = { async get() { return null; }, async put() {} };
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_USER_ID: PLAYBOOK, POTD_KV: kv }), PLAYBOOK);
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_USER_ID: `<@${PLAYBOOK}>`, POTD_KV: kv }), PLAYBOOK);
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_ROLE_ID: PLAYBOOK, POTD_KV: kv }), `&${PLAYBOOK}`);
  assert.equal(await playbookTag({ DISCORD_PLAYBOOK_USER_ID: 'not an id', POTD_KV: kv }), null);
});

test('a day on request: "so far" while its window is open and nothing recorded; the whole day once it has closed, recorded; the weekly left alone', async () => {
  const { env, store } = makeEnv({ DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS });
  const w = { startMs: etInstant('2026-11-25', 6), endMs: etInstant('2026-11-26', 6) };
  const posts = {
    a: { state: 'done', doneAt: w.startMs + 3600e3, post: nbaPost({ id: 'a', gradedAt: w.startMs + 3600e3 }) },
    b: { state: 'done', doneAt: w.startMs + 16 * 3600e3, post: nbaPost({ id: 'b', gradedAt: w.startMs + 16 * 3600e3, result: 'loss', profit: -1 }) },
    c: { state: 'done', doneAt: w.startMs + 20 * 3600e3, post: nbaPost({ id: 'c', gradedAt: w.startMs + 20 * 3600e3 }) },
  };
  store.set(LEAGUES.nba.ledger, JSON.stringify({ posts, games: {} }));
  const d = fakeDiscord();
  // 10pm ET on the day: what settled so far (a and b), said so, outside the hour, nothing recorded.
  const r = await runResultsDigest(env, at('2026-11-25', 22, 30), { day: '2026-11-25', deps: { fetch: d.fetch, oneOff: null } });
  assert.deepEqual(r.nba, { daily: { posted: 1, day: '2026-11-25', plays: 2, card: false, soFar: true }, weekly: null });
  assert.equal(d.calls[0].body.embeds[0].title, '📊 NBA RESULTS · Wed, Nov 25 · so far · 2 plays');
  assert.ok(!store.has(DIGEST_DAY_KEY('2026-11-25', 'nba')), 'an open window leaves no record');
  assert.equal((await digestStatus(env)).nba.lastDaily, null, 'and is not the day\'s post');
  // Asked again: it posts again (a "so far" is on request).
  await runResultsDigest(env, at('2026-11-25', 23), { day: '2026-11-25', deps: { fetch: d.fetch, oneOff: null } });
  assert.equal(d.calls.length, 2);
  // The morning after: the whole day (a, b and c), recorded, once.
  const m = await runResultsDigest(env, at('2026-11-26', 6, 7), { deps: { fetch: d.fetch, oneOff: null } });
  assert.deepEqual(m.nba.daily, { posted: 1, day: '2026-11-25', plays: 3, card: false });
  assert.equal(d.calls[2].body.embeds[0].title, '📊 NBA RESULTS · Wed, Nov 25 · 3 plays');
  assert.ok(store.has(DIGEST_DAY_KEY('2026-11-25', 'nba')));
  // The closed day on request again: already posted.
  assert.equal((await runResultsDigest(env, at('2026-11-26', 9), { day: '2026-11-25', deps: { fetch: d.fetch, oneOff: null } })).nba.daily.skipped, 'posted');
  assert.equal(d.calls.length, 3);
});

test('the one-off rides a deploy: posted once on the first tick whatever the hour, marked before it is sent, and never again', async () => {
  const { env, store } = makeEnv({ DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS });
  const start = etInstant('2026-11-25', 6);
  store.set(LEAGUES.nba.ledger, JSON.stringify({ posts: { a: { state: 'done', doneAt: start + 3600e3, post: nbaPost({ id: 'a', gradedAt: start + 3600e3 }) } }, games: {} }));
  const d = fakeDiscord();
  const oneOff = { id: 'x-1', source: 'nba', day: '2026-11-25' };
  const r = await runResultsDigest(env, at('2026-11-25', 21, 52), { deps: { fetch: d.fetch, oneOff } });
  assert.deepEqual(r, { skipped: 'hour', oneOff: { id: 'x-1', source: 'nba', posted: 1, day: '2026-11-25', plays: 1, card: false, soFar: true } });
  assert.equal(d.calls[0].body.embeds[0].title, '📊 NBA RESULTS · Wed, Nov 25 · so far · 1 play');
  assert.equal(JSON.parse(store.get(DIGEST_ONE_OFF_KEY('x-1'))).state, 'done');
  assert.deepEqual(await runResultsDigest(env, at('2026-11-25', 22, 7), { deps: { fetch: d.fetch, oneOff } }), { skipped: 'hour' });
  assert.equal(d.calls.length, 1, 'once');
  // A one-off for a channel that is not set up, or with no id, posts nothing and marks nothing.
  assert.deepEqual(await runResultsDigest(env, at('2026-11-25', 22, 7), { deps: { fetch: d.fetch, oneOff: { id: 'y', source: 'nfl', day: '2026-11-25' } } }), { skipped: 'hour' });
  assert.ok(!store.has(DIGEST_ONE_OFF_KEY('y')));
  // None is pending in the code.
  assert.equal(ONE_OFF, null);
});

test('the roll-up goes as its card: the picture as the one embed with the tag in the content, the day recorded as drawn; the written roll-up when the picture cannot be drawn or Discord refuses it', async () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_PLAYBOOK_USER_ID: PLAYBOOK });
  const w = digestWindow('2026-11-25');
  stored(store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 3600e3 }), play({ id: 'b', gradedAt: w.startMs + 7200e3, result: 'loss', profit: -1 })]);
  const models = [];
  const d = fakeDiscord();
  const r = await runResultsDigest(env, at('2026-11-25', 6, 7), { deps: { fetch: d.fetch, oneOff: null, render: async (m) => { models.push(m); return PNG; } } });
  assert.deepEqual(r.daily, { posted: 1, day: '2026-11-24', plays: 2, card: true });
  assert.equal(models.length, 1);
  assert.deepEqual([models[0].kind, models[0].sport, models[0].when, models[0].state, models[0].plays, models[0].tiles[0].value], ['daily', 'tennis', 'TUESDAY • NOVEMBER 24', 'final', 2, '1-1']);
  assert.equal(d.calls.length, 1);
  assert.ok(d.calls[0].file, 'the picture rides with the message');
  assert.equal(d.calls[0].body.content, `<@${PLAYBOOK}> Results for Tue, Nov 24`);
  assert.deepEqual(d.calls[0].body.embeds.map((e) => e.image?.url), ['attachment://results.png']);
  assert.deepEqual(d.calls[0].body.attachments, [{ id: 0, filename: 'results.png' }]);
  assert.equal(JSON.parse(store.get(DIGEST_DAY_KEY('2026-11-24'))).card, true);
  // Monday: the week's card, from the day records.
  const mon = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES });
  mon.store.set(DIGEST_DAY_KEY('2026-11-20'), JSON.stringify({ at: 1, plays: 4, tally: { wins: 3, losses: 1, voids: 0, pending: 0, staked: 4, units: 2.1, roi: 0.525 }, leans: { wins: 1, losses: 0, voids: 0, pending: 0, staked: 0.5, units: 0, roi: null } }));
  const weekly = [];
  const d2 = fakeDiscord();
  const r2 = await runResultsDigest(mon.env, at('2026-11-23', 6, 7), { deps: { fetch: d2.fetch, oneOff: null, render: async (m) => { weekly.push(m); return PNG; } } });
  assert.deepEqual(r2.weekly, { posted: 1, week: '2026-11-16', plays: 4, card: true });
  assert.deepEqual([weekly[0].kind, weekly[0].when, weekly[0].sections[0].rows.length, weekly[0].sections[0].rows[4].record, weekly[0].tiles[2].value], ['weekly', 'NOV 16 - NOV 22', 8, '3-1', '1-0']);
  assert.ok(d2.calls[0].file);
  // The renderer throws, or is turned off: the written roll-up, as before.
  for (const render of [async () => { throw new Error('no wasm'); }, null]) {
    const t = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES });
    stored(t.store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 3600e3 })]);
    const d3 = fakeDiscord();
    const r3 = await runResultsDigest(t.env, at('2026-11-25', 6, 7), { deps: { fetch: d3.fetch, oneOff: null, render } });
    assert.deepEqual(r3.daily, { posted: 1, day: '2026-11-24', plays: 1, card: false });
    assert.equal(d3.calls[0].file, null);
    assert.equal(d3.calls[0].body.embeds[0].title, '📊 TENNIS RESULTS · Tue, Nov 24 · 1 play');
  }
  // Discord refuses the picture: the written roll-up goes in its place, and the day is recorded as written.
  const u = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES });
  stored(u.store, '2026-11-24', [play({ id: 'a', gradedAt: w.startMs + 3600e3 })]);
  const d4 = fakeDiscord((call) => (call.file ? { status: 400, body: {} } : null));
  const r4 = await runResultsDigest(u.env, at('2026-11-25', 6, 7), { deps: { fetch: d4.fetch, oneOff: null, render: async () => PNG } });
  assert.deepEqual(r4.daily, { posted: 1, day: '2026-11-24', plays: 1, card: false });
  assert.deepEqual(d4.calls.map((c) => Boolean(c.file)), [true, false]);
  assert.equal(d4.calls[1].body.embeds[0].title, '📊 TENNIS RESULTS · Tue, Nov 24 · 1 play');
  assert.equal(JSON.parse(u.store.get(DIGEST_DAY_KEY('2026-11-24'))).card, false);
});

// --- the NBA's and the NFL's day, posted when its slate ends ---
import { slateOver, slateDay } from '../worker/src/discord-results-digest.js';
const NFL_RESULTS = 'https://discord.com/api/webhooks/723456789012345678/nflRES_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const DAY = '2026-11-27';
const game = (id, hour, minute = 0, league = 'nba') => ({ id, name: `Game ${id}`, date: new Date(at(DAY, hour, minute)).toISOString(), league });
const finals = (ids) => async (id) => (ids.includes(id) ? { ticks: [{ state: 'in' }, { state: 'post' }] } : { ticks: [{ state: 'in' }] });
const doneAt = (id, gameId, when, over = {}) => ({ state: 'done', doneAt: when, post: nbaPost({ id, gameId, gradedAt: when, ...over }) });

test('the slate\'s day is the 6am-to-6am window the moment falls in', () => {
  assert.equal(slateDay(at(DAY, 23, 40)), DAY);
  assert.equal(slateDay(at('2026-11-28', 1, 10)), DAY, 'a game that ends after midnight is still that night\'s slate');
  assert.equal(slateDay(at('2026-11-28', 6, 0)), '2026-11-28');
});

test('a slate is over when every game has started and is final and no play of theirs is still open', async () => {
  const games = async () => [game('g1', 19), game('g2', 22), game('f1', 20, 15, 'nfl'), { ...game('old', 19), date: new Date(at('2026-11-26', 19)).toISOString() }];
  const ledger = (posts) => async () => ({ posts });
  const settled = { a: doneAt('a', 'g1', at(DAY, 21, 40)), b: doneAt('b', 'g2', at('2026-11-28', 0, 40)) };
  const over = (now, deps) => slateOver({}, 'nba', DAY, now, { games, ...deps });
  assert.deepEqual(await slateOver({}, 'nba', DAY, at(DAY, 23), { games: async () => [] }), { done: false, games: 0, why: 'no watched game' });
  // The late game started an hour ago.
  assert.equal((await over(at(DAY, 23), { watch: finals(['g1', 'g2']), ledger: ledger(settled) })).why, 'the last game cannot be over yet');
  // Past two hours, one still in play.
  assert.equal((await over(at('2026-11-28', 0, 30), { watch: finals(['g1']), ledger: ledger(settled) })).why, 'a game is not final');
  // Both final, a play of the late game not graded yet.
  assert.equal((await over(at('2026-11-28', 0, 45), { watch: finals(['g1', 'g2']), ledger: ledger({ ...settled, c: { state: 'open', at: 1, post: nbaPost({ id: 'c', gameId: 'g2', status: 'pending' }) } }) })).why, 'a play is not graded yet');
  // Both final and graded: over. Another league's game, and yesterday's, are not its games.
  assert.deepEqual(await over(at('2026-11-28', 0, 45), { watch: finals(['g1', 'g2']), ledger: ledger(settled) }), { done: true, games: 2 });
  // A watch that stopped before the final: the game is taken as over six hours after its start.
  assert.equal((await over(at('2026-11-28', 4, 5), { watch: finals(['g1']), ledger: ledger(settled) })).done, true);
});

test('the NBA\'s day is posted when its last game is final, once, and the morning does not post it again', async () => {
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS, DISCORD_PLAYBOOK_USER_ID: PLAYBOOK });
  const posts = { a: doneAt('a', 'g1', at(DAY, 21, 40)), b: doneAt('b', 'g2', at('2026-11-28', 0, 40), { result: 'loss', profit: -1, legs: [{ player: 'Jayson Tatum', stat: 'rebounds', label: 'Reb', point: 7.5, final: 5, hit: false }] }) };
  store.set(LEAGUES.nba.ledger, JSON.stringify({ posts, games: {} }));
  const d = fakeDiscord();
  const deps = { fetch: d.fetch, oneOff: null, render: null, games: async () => [game('g1', 19), game('g2', 22)], watch: finals(['g1', 'g2']), plays: async () => [] };
  // 11:40 PM: the late game is still on.
  let r = await runResultsDigest(env, at(DAY, 23, 40), { deps: { ...deps, watch: finals(['g1']) } });
  assert.deepEqual(r, { skipped: 'hour' });
  assert.equal(d.calls.length, 0);
  // 12:45 AM: both final and graded. The day's roll-up goes now, labelled with the day it was played.
  r = await runResultsDigest(env, at('2026-11-28', 0, 45), { deps });
  assert.deepEqual(r, { skipped: 'hour', slateEnd: { nba: { posted: 1, day: DAY, plays: 2, card: false, early: true, games: 2 } } });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, `${NBA_RESULTS}?wait=true`);
  assert.equal(d.calls[0].body.embeds[0].title, '📊 NBA RESULTS · Fri, Nov 27 · 2 plays');
  assert.doesNotMatch(JSON.stringify(d.calls[0].body), /so far/i);
  assert.equal(JSON.parse(store.get(DIGEST_DAY_KEY(DAY, 'nba'))).early, true);
  const s = await digestStatus(env);
  assert.deepEqual([s.nba.lastDaily.day, s.nba.lastDaily.plays, s.nba.lastDaily.slateEnd], [DAY, 2, true]);
  // The next tick, and the morning: nothing more to the NBA channel. Tennis keeps its morning and has nothing to say.
  r = await runResultsDigest(env, at('2026-11-28', 1, 0), { deps });
  assert.deepEqual(r, { skipped: 'hour' });
  r = await runResultsDigest(env, at('2026-11-28', 6, 7), { deps });
  assert.deepEqual(r.nba.daily, { skipped: 'posted', day: DAY });
  assert.equal(d.calls.length, 1);
});

test('a slate that never reads as over still goes in the morning, and a play graded after an early post is added to the day without a second post', async () => {
  const { env, store } = makeEnv({ DISCORD_NBA_RESULTS_WEBHOOK: NBA_RESULTS, DISCORD_NFL_RESULTS_WEBHOOK: NFL_RESULTS });
  store.set(LEAGUES.nba.ledger, JSON.stringify({ posts: { a: doneAt('a', 'g1', at(DAY, 21, 40)) }, games: {} }));
  store.set(LEAGUES.nfl.ledger, JSON.stringify({ posts: { n: doneAt('n', 'f1', at(DAY, 23, 30), { league: 'nfl' }) }, games: {} }));
  const d = fakeDiscord();
  // No watched game on file for either league: nothing at night, both in the morning.
  const none = { fetch: d.fetch, oneOff: null, render: null, games: async () => [], watch: finals([]) };
  assert.deepEqual(await runResultsDigest(env, at('2026-11-28', 0, 45), { deps: none }), { skipped: 'hour' });
  assert.equal(d.calls.length, 0);
  const morning = await runResultsDigest(env, at('2026-11-28', 6, 7), { deps: none });
  assert.equal(morning.nba.daily.posted, 1);
  assert.equal(morning.nfl.daily.posted, 1);
  assert.equal(d.calls.length, 2);

  // The NFL's slate ends at night and is posted; a play graded an hour later is added to the day's tally in the morning, with no post.
  const late = makeEnv({ DISCORD_NFL_RESULTS_WEBHOOK: NFL_RESULTS });
  late.store.set(LEAGUES.nfl.ledger, JSON.stringify({ posts: { n: doneAt('n', 'f1', at(DAY, 23, 30), { league: 'nfl' }) }, games: {} }));
  const d2 = fakeDiscord();
  const deps = { fetch: d2.fetch, oneOff: null, render: null, games: async () => [game('f1', 20, 15, 'nfl')], watch: finals(['f1']) };
  const night = await runResultsDigest(late.env, at(DAY, 23, 45), { deps });
  assert.equal(night.slateEnd.nfl.posted, 1);
  assert.equal(night.slateEnd.nfl.plays, 1);
  late.store.set(LEAGUES.nfl.ledger, JSON.stringify({ posts: { n: doneAt('n', 'f1', at(DAY, 23, 30), { league: 'nfl' }), m: doneAt('m', 'f1', at('2026-11-28', 0, 50), { league: 'nfl' }) }, games: {} }));
  const next = await runResultsDigest(late.env, at('2026-11-28', 6, 7), { deps });
  assert.deepEqual(next.nfl.daily, { skipped: 'posted', day: DAY, toppedUp: 1 });
  assert.equal(d2.calls.length, 1);
  const rec = JSON.parse(late.store.get(DIGEST_DAY_KEY(DAY, 'nfl')));
  assert.equal(rec.plays, 2);
  assert.equal(rec.tally.wins, 2);
});

test('a league\'s day already posted takes the fuller tally when a play of it is graded days late; nothing is posted again', async () => {
  const { env, store } = makeEnv({ DISCORD_NFL_RESULTS_WEBHOOK: NFL_RESULTS });
  const THU = '2026-11-26';
  store.set(LEAGUES.nfl.ledger, JSON.stringify({ posts: { a: doneAt('a', 'f1', at(THU, 20, 30), { league: 'nfl' }) }, games: {} }));
  const d = fakeDiscord();
  const deps = { fetch: d.fetch, oneOff: null, render: null, games: async () => [], watch: finals([]) };
  assert.equal((await runResultsDigest(env, at('2026-11-27', 6, 7), { deps })).nfl.daily.plays, 1);
  assert.equal(d.calls.length, 1);
  // A play of Thursday night's game is graded on Saturday (it had been closed without a grade): Thursday's record takes it that morning.
  store.set(LEAGUES.nfl.ledger, JSON.stringify({ posts: { a: doneAt('a', 'f1', at(THU, 20, 30), { league: 'nfl' }), b: doneAt('b', 'f2', at(THU, 23, 30), { league: 'nfl', result: 'loss', profit: -1 }) }, games: {} }));
  const sat = await runResultsDigest(env, at('2026-11-28', 6, 7), { deps });
  assert.deepEqual(sat.nfl, { daily: { skipped: 'no plays', day: '2026-11-27' }, weekly: null, recounted: { [THU]: 1 } });
  const rec = JSON.parse(store.get(DIGEST_DAY_KEY(THU, 'nfl')));
  assert.deepEqual([rec.plays, rec.tally.wins, rec.tally.losses], [2, 1, 1]);
  assert.equal((await runResultsDigest(env, at('2026-11-28', 6, 22), { deps })).nfl.recounted, undefined, 'once');
  assert.equal(d.calls.length, 1);
});
