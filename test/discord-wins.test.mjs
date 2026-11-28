/**
 * The wins channel's daily collage (worker/src/discord-results-digest.js, runWins): the day's winners across the
 * sources as one picture with the morning's roll-ups, once a day, against a fake KV and a fake Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResultsDigest, digestStatus, etInstant, WINS_DAY_KEY, DIGEST_DAY_KEY } from '../worker/src/discord-results-digest.js';

const UPDATES = 'https://discord.com/api/webhooks/223456789012345678/zzzDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const WINS = 'https://discord.com/api/webhooks/723456789012345678/winsDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

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
const DAY = '2026-11-27'; const MORNING = '2026-11-28';
const inDay = at(DAY, 20);
const play = (over = {}) => ({ id: `atp:${Math.random()}`, matchId: 'atp:1', tour: 'atp', event: 'Nitto ATP Finals', a: 'Jannik Sinner', b: 'Carlos Alcaraz', market: 'live_ml', side: 'a', american: -175, bookId: 'fanduel', book: 'FanDuel', units: 1, selection: 'Jannik Sinner to win the match (live)', postedAt: inDay - 3600e3, status: 'graded', result: 'win', actual: '6-4 6-4', profit: 0.57, gradedAt: inDay, ...over });
const nbaPost = (over = {}) => ({ id: `g1:fanduel:${Math.random()}`, gameId: 'g1', game: 'New York Knicks at Boston Celtics', league: 'nba', bookId: 'fanduel', book: 'FanDuel', american: 105, decimal: 2.05, units: 1, postedAt: inDay - 3600e3,
  legs: [{ player: 'Jalen Brunson', stat: 'points', label: 'Pts', point: 19.5, final: 27, hit: true }, { player: 'Jayson Tatum', stat: 'rebounds', label: 'Reb', point: 7.5, final: 9, hit: true }],
  status: 'graded', result: 'win', profit: 1.05, finalScore: { NY: 110, BOS: 104 }, gradedAt: inDay + 3600e3, ...over });
const ledgerWith = (...posts) => ({ posts: Object.fromEntries(posts.map((p, i) => [`p${i}`, { state: 'done', doneAt: p.gradedAt, post: p }])) });
const tennisDay = [play({ id: 'win' }), play({ id: 'lost', result: 'loss', profit: -1 }), play({ id: 'yesterday', gradedAt: at(DAY, 5) })];
const deps = (d, over = {}) => ({ fetch: d.fetch, oneOff: null, playbook: null, render: null, renderWins: async () => PNG, plays: async (date) => (date === DAY ? tennisDay : []), ledger: async (league) => (league === 'nba' ? ledgerWith(nbaPost({ id: 'nba-win' }), nbaPost({ id: 'nba-lost', result: 'loss', profit: -1 })) : null), ...over });

test('the day\'s winners go to the wins channel as one picture with the morning run, once; the status says when', async () => {
  const { env, store } = makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_WINS_WEBHOOK: WINS });
  const d = fakeDiscord();
  const seen = [];
  const r = await runResultsDigest(env, at(MORNING, 6, 7), { deps: deps(d, { renderWins: async (model) => { seen.push(model); return PNG; } }) });
  assert.deepEqual(r.wins, { posted: 1, day: DAY, wins: 2, units: 1.62, card: true });
  assert.equal(r.daily.posted, 1, 'the tennis roll-up still goes to its channel');
  assert.deepEqual(seen.map((m) => [m.kind, m.count, m.shown.map((e) => [e.sport, e.play.id])]), [['wins', 2, [['nba', 'nba-win'], ['tennis', 'win']]]], 'the biggest win first; the loss and what settled before the window are left out');
  const post = d.calls.find((c) => c.url.startsWith(WINS));
  assert.ok(post, 'posted to the wins channel');
  assert.equal(post.body.content, '🏆 **2 winners** · Friday, November 27 · **+1.62u**');
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
  assert.deepEqual([post.body.embeds[0].image, post.body.attachments], [{ url: 'attachment://winners.png' }, [{ id: 0, filename: 'winners.png' }]]);
  assert.equal(post.file?.size, PNG.length, 'the picture rides along');
  assert.ok(!JSON.stringify(post.body).includes('winsDEF'));
  const rec = JSON.parse(store.get(WINS_DAY_KEY(DAY)));
  assert.deepEqual([rec.wins, rec.units, rec.card, typeof rec.messageId], [2, 1.62, true, 'string']);
  assert.deepEqual((await digestStatus(env)).wins, { on: true, lastDaily: { day: DAY, at: at(MORNING, 6, 7), wins: 2, units: 1.62 } });
  assert.ok(!JSON.stringify(await digestStatus(env)).includes('winsDEF'));

  // The next tick in the hour, and a forced run later: not again.
  const before = d.calls.length;
  assert.deepEqual((await runResultsDigest(env, at(MORNING, 6, 22), { deps: deps(d) })).wins, { skipped: 'posted', day: DAY });
  assert.deepEqual((await runResultsDigest(env, at(MORNING, 15), { force: true, deps: deps(d) })).wins, { skipped: 'posted', day: DAY });
  assert.equal(d.calls.filter((c) => c.url.startsWith(WINS)).length, 1);
  assert.equal(d.calls.length, before);
});

test('without a wins webhook nothing is gathered; with it alone the run is on even with no results channel', async () => {
  const d = fakeDiscord();
  const r = await runResultsDigest(makeEnv({ DISCORD_UPDATES_WEBHOOK: UPDATES }).env, at(MORNING, 6, 7), { deps: deps(d) });
  assert.equal(r.wins, undefined);
  assert.equal(d.calls.filter((c) => c.url.startsWith(WINS)).length, 0);
  const only = makeEnv({ DISCORD_WINS_WEBHOOK: WINS });
  const r2 = await runResultsDigest(only.env, at(MORNING, 6, 7), { deps: deps(d) });
  assert.deepEqual([r2.off, r2.daily, r2.wins?.posted, r2.wins?.wins], [undefined, null, 1, 2]);
  assert.equal((await digestStatus(only.env)).wins.on, true);
  assert.equal((await digestStatus(makeEnv().env)).wins.on, false);
  // Off the hour: nothing.
  assert.deepEqual(await runResultsDigest(makeEnv({ DISCORD_WINS_WEBHOOK: WINS }).env, at(MORNING, 12), { deps: deps(d) }), { skipped: 'hour' });
});

test('no winners: nothing is posted and nothing recorded; no picture: nothing is posted and the next tick tries again', async () => {
  const { env, store } = makeEnv({ DISCORD_WINS_WEBHOOK: WINS });
  const d = fakeDiscord();
  const lossOnly = { plays: async () => [play({ result: 'loss', profit: -1 })], ledger: async () => null };
  assert.deepEqual((await runResultsDigest(env, at(MORNING, 6, 7), { deps: deps(d, lossOnly) })).wins, { skipped: 'no wins', day: DAY });
  assert.equal(d.calls.length, 0);
  assert.equal(store.has(WINS_DAY_KEY(DAY)), false);

  const noPic = makeEnv({ DISCORD_WINS_WEBHOOK: WINS });
  assert.deepEqual((await runResultsDigest(noPic.env, at(MORNING, 6, 7), { deps: deps(d, { renderWins: null }) })).wins, { skipped: 'no picture', day: DAY });
  assert.deepEqual((await runResultsDigest(noPic.env, at(MORNING, 6, 22), { deps: deps(d, { renderWins: async () => { throw new Error('wasm'); } }) })).wins, { skipped: 'no picture', day: DAY });
  assert.equal(d.calls.length, 0);
  assert.equal(noPic.store.has(WINS_DAY_KEY(DAY)), false);
  assert.equal((await runResultsDigest(noPic.env, at(MORNING, 6, 37), { deps: deps(d) })).wins.posted, 1, 'drawn at last: posted');
  assert.equal(d.calls.length, 1);
});

test('a picture Discord refuses goes as its written lines; a day whose window is still open is posted so far and not recorded', async () => {
  const { env, store } = makeEnv({ DISCORD_WINS_WEBHOOK: WINS });
  const refusing = fakeDiscord((call, n) => (n === 1 ? { status: 400, body: { message: 'no' } } : null));
  const r = await runResultsDigest(env, at(MORNING, 6, 7), { deps: deps(refusing) });
  assert.deepEqual(r.wins, { posted: 1, day: DAY, wins: 2, units: 1.62, card: false });
  assert.equal(refusing.calls.length, 2);
  assert.equal(refusing.calls[1].file, null, 'the second try carries no picture');
  assert.match(refusing.calls[1].body.embeds[0].description, /New York Knicks at Boston Celtics[\s\S]*Jannik Sinner to win the match/);
  assert.equal(JSON.parse(store.get(WINS_DAY_KEY(DAY))).card, false);

  // The owner's route for a day still running: what has won so far, said so, and the morning's post still comes.
  const open = makeEnv({ DISCORD_WINS_WEBHOOK: WINS });
  const d = fakeDiscord();
  const so = await runResultsDigest(open.env, at(DAY, 23), { force: true, day: DAY, deps: deps(d) });
  assert.deepEqual(so.wins, { posted: 1, day: DAY, wins: 2, units: 1.62, card: true, soFar: true });
  assert.match(d.calls[0].body.content, /^🏆 \*\*2 winners so far\*\*/);
  assert.equal(open.store.has(WINS_DAY_KEY(DAY)), false);
  assert.equal(open.store.has(DIGEST_DAY_KEY(DAY)), false);
  assert.equal((await runResultsDigest(open.env, at(MORNING, 6, 7), { deps: deps(d) })).wins.posted, 1, 'the morning still posts the whole day');
});
