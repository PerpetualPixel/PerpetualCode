/**
 * The tracked live plays on the owner's Discord (worker/src/discord.js): a
 * play goes up once when it opens, its own message is edited when it
 * settles, nothing is posted twice, and the webhook address never leaves
 * the worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordConfig, livePlayMessage, liveResultLine, syncLiveDiscord, discordStatus, testAlertMessage, whyLine, meter, cardLink, bookRedirect, TEST_ALERT_ID, DISCORD_LEDGER_KEY, FRESH_MS, POST_TRIES } from '../worker/src/discord.js';

const NOW = Date.parse('2026-11-25T18:00:00Z');
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const UPDATES = 'https://discord.com/api/webhooks/223456789012345678/zzzDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
function makeEnv(extra = {}) {
  const store = new Map();
  return { store, env: { ...extra, POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
/** A Discord that answers: a list of what was asked, and a reply per call (a function, or the default 200 with an id). */
function fakeDiscord(reply = null) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const call = { url, method: init.method, body: JSON.parse(init.body) };
    calls.push(call);
    const r = reply ? reply(call, calls.length) : null;
    if (r === 'throw') throw new Error('timeout');
    const status = r?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r?.body ?? { id: `90000000000000000${++n}` } };
  };
  return { calls, fetch };
}
const ml = (over = {}) => ({ id: 'atp:1:live_ml', matchId: 'atp:1', tour: 'atp', event: 'Challenger Playford 2', round: '1/8-finals', a: 'M. Dellavedova', b: 'H. Moriya', market: 'live_ml', side: 'a', prob: 0.69, american: -175, playable: -190, bookId: 'fanduel', book: 'FanDuel', link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2', units: 1, selection: 'M. Dellavedova to win the match (live)', score: '6-0 3-4', postedAt: NOW - 60e3, status: 'pending', ...over });
const set = (over = {}) => ({ id: 'atp:2:live_set:2', matchId: 'atp:2', tour: 'atp', event: 'Nitto ATP Finals', round: 'Final', a: 'Carlos Alcaraz', b: 'Alexander Zverev', market: 'live_set', side: 'a', set: 2, prob: 0.69, playable: -186, units: 1, selection: 'Carlos Alcaraz to win set 2', score: '6-2 2-1', postedAt: NOW - 60e3, status: 'pending', ...over });
// testId '' keeps the test alert out of the way of these; it has a test of its own below.
const sync = (env, now, d, plays, records = { ml: { wins: 8, losses: 2, units: 3.29 }, sets: { wins: 31, losses: 6, units: 10.22 }, setGames: { wins: 0, losses: 0, units: 0 } }, testId = '') => syncLiveDiscord(env, now, { deps: { fetch: d.fetch, plays: async () => plays, records: async () => records, testId } });

test('only a real Discord webhook address is used, and the role must be an id', () => {
  assert.equal(discordConfig({}).live, null);
  assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: HOOK }).live, HOOK);
  assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: `  ${HOOK}\n` }).live, HOOK, 'pasted with a space or a newline');
  for (const bad of ['http://discord.com/api/webhooks/1234567/abcdefghijklmnopqrstuvwxyz', 'https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', `${HOOK}?wait=true`, 'not a url']) assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: bad }).live, null, bad);
  assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: '987654321098765432' }).role, '987654321098765432');
  assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: '@everyone' }).role, null);
});

const STATS = { holds: { a: { held: 6, served: 6 }, b: { held: 3, served: 5 } }, last: { of: 8, a: 5, b: 3 }, streak: null, setGames: null };
const BOOKS = [
  { bookId: 'fanduel', book: 'FanDuel', american: -175, link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2' },
  { bookId: 'caesars', book: 'Caesars', american: -180, link: 'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=abc&dl=betslip' },
  { bookId: 'hardrock', book: 'Hard Rock Bet', american: -185, link: 'https://app.hardrock.bet/?deep_link_value=betslip/3947887837145334180' },
  { bookId: 'betrivers', book: 'BetRivers', american: -190, link: 'https://{state}.betrivers.com/?page=sportsbook#event/1?coupon={pickType}|2|{wagerAmount}' },
];
const GO = 'https://pixel-pick-odds.mgbouldering.workers.dev/go/atp%3A1%3Alive_ml';

test('the card: TAKE and the bet, the price and where, why in a sentence, the chance as a number, every book that has it linked, in the site\'s colours', () => {
  const open = livePlayMessage(ml({ stats: STATS, quotes: BOOKS }), { role: '987654321098765432', record: { wins: 8, losses: 2, units: 3.29 } });
  const e = open.embeds[0];
  assert.equal(open.content, '<@&987654321098765432>');
  assert.deepEqual(open.allowed_mentions, { parse: [], roles: ['987654321098765432'] }, 'the one role and nothing else can be pinged');
  // What to take is the title, in the words on a bet slip.
  assert.equal(e.title, '🎾 TAKE · M. Dellavedova to win the match');
  assert.deepEqual([e.author.name, e.author.icon_url], ['PERPETUAL PICKS · LIVE TENNIS', 'https://perpetualpicks.com/assets/logo-icon-180.png']);
  const lines = e.description.split('\n');
  assert.equal(lines[0], '**−175** at **FanDuel** · good down to −190 · stake **1u**');
  assert.equal(lines[1], 'Moneyline · M. Dellavedova vs H. Moriya');
  assert.equal(lines[2], 'ATP · Challenger Playford 2 · 1/8-finals');
  // Why, short, from the numbers kept with the play.
  assert.equal(lines[4], '**Why:** Dellavedova has held 6 of 6 service games today; Moriya 3 of 5. Has won 5 of the last 8 games. We make it 69% to land; the price only needs 64%.');
  // Every book with the line, best price first: a whole link as it is, one that needs the reader's state or is Hard Rock's through the worker, one with a blank nobody can fill as a price alone.
  assert.equal(lines[6], `**Bet it:** [FanDuel −175](https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2) · [Caesars −180](${GO}/caesars) · [Hard Rock −185](${GO}/hardrock) · BetRivers −190`);
  // The stats behind it.
  assert.deepEqual(e.fields.map((f) => [f.name, f.value]), [['Chance to land', '▰▰▰▰▰▰▰▱▱▱ **69%**'], ['Price needs', '64%'], ['Edge', '+5 pts'], ['Score when taken', '6-0 3-4'], ['Serve held today', 'Dellavedova 6/6 · Moriya 3/5'], ['Our Match Winner record', '8-2 · +3.29u']]);
  assert.ok(e.fields.every((f) => f.inline));
  assert.deepEqual([meter(0), meter(0.5), meter(1)], ['▱▱▱▱▱▱▱▱▱▱', '▰▰▰▰▰▱▱▱▱▱', '▰▰▰▰▰▰▰▰▰▰']);
  // The look: the site's magenta, and the LIVE PLAY strip.
  assert.equal(e.color, 0xff007a);
  assert.match(e.image.url, /^https:\/\/perpetualpicks\.com\/assets\/discord\/live\.png\?v=\d+$/);
  assert.equal(e.url, 'https://perpetualpicks.com/app.html');
  assert.equal(e.timestamp, new Date(NOW - 60e3).toISOString());

  // A set no book prices: the price to take it at, and it says no book has it.
  const s = livePlayMessage(set({ stats: { ...STATS, streak: { side: 'a', n: 4 } } }), { record: { wins: 31, losses: 6, units: 10.22 } }).embeds[0];
  assert.equal(s.title, '🎾 TAKE · Carlos Alcaraz to win set 2');
  assert.match(s.description, /^\*\*−186 or better\*\* at your book · stake \*\*1u\*\*\nSet 2 winner · Carlos Alcaraz vs Alexander Zverev\n/);
  assert.match(s.description, /\*\*Why:\*\* Alcaraz has held 6 of 6 service games today; Zverev 3 of 5\. Has won the last 4 games\. We make it 69% to land; the price only needs 65%\./);
  assert.match(s.description, /\*\*Bet it:\*\* no book we read has this live\. Take it at −186 or better where you can find it\.$/);
  assert.ok(!/\]\(http/.test(s.description));
  assert.equal(s.fields.at(-1).name, 'Our Set Winner record');
  // The games in a set: both players' holds and where the set is headed.
  const games = livePlayMessage({ ...set({ id: 'atp:2:live_set_total:2', market: 'live_set_total', side: null, selection: 'Set 2 over 9.5 games', point: 9.5, sideWord: 'over', playable: -150, prob: 0.66 }), stats: { ...STATS, setGames: 10.4 } }, {}).embeds[0];
  assert.equal(games.title, '🎾 TAKE · Set 2 over 9.5 games');
  assert.match(games.description, /Set 2 total games · Carlos Alcaraz vs Alexander Zverev/);
  assert.match(games.description, /\*\*Why:\*\* Alcaraz has held 6 of 6 service games and Zverev 3 of 5\. At those hold rates the set runs to about 10\.4 games\. We make it 66% to land; the price only needs 60%\./);
  // A play from before the stats were kept still has its reason: the read against the price.
  assert.equal(whyLine(ml()), 'We make it 69% to land; the price only needs 64%.');

  // Settled: the title leads with it, the strip and the colour change, the links come off.
  const won = livePlayMessage(ml({ stats: STATS, quotes: BOOKS, status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6' }), {}).embeds[0];
  assert.equal(won.title, '✅ WON · M. Dellavedova to win the match');
  assert.match(won.description, /^\*\*Final 6-0 4-6 7-6 · \+0\.57u\*\*\nTaken at \*\*−175\*\* \(FanDuel\) · stake \*\*1u\*\*\n/);
  assert.ok(!/Bet it|\]\(http/.test(won.description), 'no link to a bet that is over');
  assert.match(won.image.url, /\/won\.png/);
  const lost = livePlayMessage(ml({ status: 'graded', result: 'loss', profit: -1, actual: '6-0 4-6 3-6' }), {}).embeds[0];
  assert.deepEqual([lost.title, lost.description.split('\n')[0]], ['❌ LOST · M. Dellavedova to win the match', '**Final 6-0 4-6 3-6 · −1.00u**']);
  assert.match(lost.image.url, /\/lost\.png/);
  const voided = livePlayMessage(ml({ status: 'void', result: 'void', profit: 0, actual: '6-0 1-0: a retirement' }), {}).embeds[0];
  assert.deepEqual([voided.title, voided.description.split('\n')[0]], ['⚪ VOID · M. Dellavedova to win the match', '**Stake returned** · 6-0 1-0: a retirement']);
  assert.match(voided.image.url, /\/void\.png/);
  assert.equal(new Set([e.color, won.color, lost.color, voided.color]).size, 4);

  // A name from the feed cannot write markdown or a mention.
  const odd = livePlayMessage(ml({ a: '@everyone **bold**', selection: '[x](http://evil.example) to win', link: 'javascript:alert(1)' }), {});
  assert.ok(!/\]\(https?:\/\/evil/.test(odd.embeds[0].description) && !/javascript:/.test(odd.embeds[0].description) && odd.embeds[0].description.includes('\\*\\*bold\\*\\*'));
  assert.deepEqual(odd.allowed_mentions, { parse: [], roles: [] });
  assert.equal(liveResultLine(ml({ status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6' })).content, '✅ WON · M. Dellavedova to win the match · M. Dellavedova vs H. Moriya · 6-0 4-6 7-6 · +0.57u');
});

test('a book link on a card: whole links go straight; the worker finishes one for the reader\'s state and phone, and never sends anyone anywhere but a link the site stored', async () => {
  const play = ml({ stats: STATS, quotes: BOOKS });
  assert.equal(cardLink(play, BOOKS[0]), BOOKS[0].link);
  assert.equal(cardLink(play, BOOKS[1]), `${GO}/caesars`);
  assert.equal(cardLink(play, BOOKS[2]), `${GO}/hardrock`);
  assert.equal(cardLink(play, BOOKS[3]), null, 'a blank other than the state cannot be filled');
  for (const bad of ['http://sportsbook.fanduel.com/x', 'javascript:alert(1)', '', null, 'https://a.example/x y']) assert.equal(cardLink(play, { bookId: 'fanduel', link: bad }), null, String(bad));

  const { env, store } = makeEnv();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(NOW);
  store.set(`tennis:liveplays:${today}`, JSON.stringify({ date: today, plays: [play] }));
  const go = (book, opts) => bookRedirect(env, 'atp:1:live_ml', book, { now: NOW, ...opts });
  assert.equal(await go('caesars', { region: 'NJ' }), 'https://sportsbook.caesars.com/us/nj/bet?selectionIds=abc&dl=betslip', 'the reader\'s state goes in');
  assert.equal(await go('caesars', { region: null }), 'https://sportsbook.caesars.com/', 'no state known: the book\'s front page, not a broken link');
  assert.equal(await go('hardrock', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/3947887837145334180', 'a phone gets Hard Rock\'s shared-bet link');
  assert.equal(await go('hardrock', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), BOOKS[2].link);
  assert.equal(await go('betrivers', { region: 'NJ' }), 'https://betrivers.com/', 'a link that cannot be finished: the front page');
  assert.equal(await go('fanduel', {}), BOOKS[0].link);
  // Nothing the site did not store: an unknown play, an unknown book, a made-up book id.
  assert.equal(await bookRedirect(env, 'atp:999:live_ml', 'fanduel', { now: NOW }), 'https://sportsbook.fanduel.com/');
  assert.equal(await go('draftkings', {}), 'https://sportsbook.draftkings.com/');
  assert.equal(await go('evil_example', {}), 'https://perpetualpicks.com/app.html');
  assert.equal(await bookRedirect(env, 'test', 'fanduel', { now: NOW }), 'https://sportsbook.fanduel.com/', 'the test alert\'s links go to the front page');
});

test('with no webhook nothing is sent; with one, the channel is told once that it is connected', async () => {
  const off = makeEnv();
  const d0 = fakeDiscord();
  assert.deepEqual(await sync(off.env, NOW, d0, [ml()]), { off: true });
  assert.equal(d0.calls.length, 0);

  const { env } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  const d = fakeDiscord();
  await sync(env, NOW, d, []);
  await sync(env, NOW + 60e3, d, []);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, `${HOOK}?wait=true`);
  assert.match(d.calls[0].body.content, /live alerts are connected/);
});

test('a tracked play is posted once when it opens, and its own message is edited when it settles', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_LIVE_ROLE_ID: '987654321098765432' });
  store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  const d = fakeDiscord();
  const lean = { ...set({ id: 'atp:3:lean:live_set:1' }), lean: true };
  const stale = ml({ id: 'atp:4:live_ml', postedAt: NOW - FRESH_MS - 60e3 });
  const settledAlready = set({ id: 'atp:5:live_set:1', status: 'graded', result: 'win', profit: 0.5 });
  let plays = [ml(), lean, stale, settledAlready];

  assert.deepEqual(await sync(env, NOW, d, plays), { posted: 1, edited: 0, failed: 0 });
  assert.equal(d.calls.length, 1, 'the lean, the play already too old to take and the one already settled are not posted');
  assert.equal(d.calls[0].method, 'POST');
  assert.equal(d.calls[0].body.content, '<@&987654321098765432>');
  // Every later tick while it is open: nothing.
  for (let i = 1; i <= 5; i++) assert.deepEqual(await sync(env, NOW + i * 60e3, d, plays), { posted: 0, edited: 0, failed: 0 });
  assert.equal(d.calls.length, 1, 'posted once, however many ticks pass');

  // It settles: one edit of that message, and one line in the updates channel.
  plays = [ml({ status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6' }), lean, stale, settledAlready];
  assert.deepEqual(await sync(env, NOW + 40 * 60e3, d, plays), { posted: 0, edited: 1, failed: 0 });
  assert.deepEqual(d.calls.slice(1).map((c) => [c.method, c.url]), [['PATCH', `${HOOK}/messages/900000000000000001`], ['POST', `${UPDATES}?wait=true`]]);
  assert.equal(d.calls[1].body.embeds[0].title, '✅ WON · M. Dellavedova to win the match');
  assert.match(d.calls[1].body.embeds[0].description, /^\*\*Final 6-0 4-6 7-6 · \+0\.57u\*\*/);
  assert.match(d.calls[2].body.content, /^✅ WON · M\. Dellavedova to win the match/);
  assert.deepEqual(await sync(env, NOW + 41 * 60e3, d, plays), { posted: 0, edited: 0, failed: 0 });
  assert.equal(d.calls.length, 3, 'and never again');
});

test('never twice: a post with no answer is not sent again; one Discord refused is tried again, three times at most', async () => {
  // No answer (a timeout): it may be in the channel.
  const a = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  a.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  const lost = fakeDiscord(() => 'throw');
  assert.deepEqual(await sync(a.env, NOW, lost, [ml()]), { posted: 0, edited: 0, failed: 1 });
  for (let i = 1; i <= 3; i++) await sync(a.env, NOW + i * 60e3, lost, [ml()]);
  assert.equal(lost.calls.length, 1, 'one attempt, then left alone');
  assert.equal(JSON.parse(a.store.get(DISCORD_LEDGER_KEY)).plays['atp:1:live_ml'].state, 'lost');

  // Refused (a 500): it is not in the channel, so the next tick tries again, and it lands.
  const b = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  b.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  const flaky = fakeDiscord((c, n) => (n === 1 ? { status: 500, body: {} } : null));
  assert.deepEqual(await sync(b.env, NOW, flaky, [ml()]), { posted: 0, edited: 0, failed: 1 });
  assert.deepEqual(await sync(b.env, NOW + 60e3, flaky, [ml()]), { posted: 1, edited: 0, failed: 0 });
  await sync(b.env, NOW + 120e3, flaky, [ml()]);
  assert.equal(flaky.calls.length, 2);

  // Refused every time: three tries and it stops.
  const c = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  c.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  const down = fakeDiscord(() => ({ status: 403, body: {} }));
  for (let i = 0; i < 8; i++) await sync(c.env, NOW + i * 60e3, down, [ml()]);
  assert.equal(down.calls.length, POST_TRIES);
  assert.equal(JSON.parse(c.store.get(DISCORD_LEDGER_KEY)).plays['atp:1:live_ml'].state, 'failed');

  // A run that died between marking and posting: the marker is closed, not repeated.
  const e = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  e.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: { 'atp:1:live_ml': { state: 'sending', at: NOW - 5 * 60e3 } } }));
  const quiet = fakeDiscord();
  await sync(e.env, NOW, quiet, [ml()]);
  assert.equal(quiet.calls.length, 0);
  assert.equal(JSON.parse(e.store.get(DISCORD_LEDGER_KEY)).plays['atp:1:live_ml'].state, 'lost');
});

test('an edit is retried until it lands, and a message deleted by hand is let go', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: { 'atp:1:live_ml': { state: 'open', at: NOW - 30 * 60e3, messageId: '900000000000000009' } } }));
  const graded = [ml({ status: 'graded', result: 'loss', profit: -1, actual: '6-0 4-6 3-6' })];
  const flaky = fakeDiscord((c, n) => (n === 1 ? { status: 502, body: {} } : null));
  assert.deepEqual(await sync(env, NOW, flaky, graded), { posted: 0, edited: 0, failed: 1 });
  assert.deepEqual(await sync(env, NOW + 60e3, flaky, graded), { posted: 0, edited: 1, failed: 0 });
  assert.equal(flaky.calls.every((c) => c.method === 'PATCH' && c.url === `${HOOK}/messages/900000000000000009`), true);

  const gone = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  gone.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: { 'atp:1:live_ml': { state: 'open', at: NOW - 30 * 60e3, messageId: '900000000000000009' } } }));
  const deleted = fakeDiscord(() => ({ status: 404, body: {} }));
  await sync(gone.env, NOW, deleted, graded);
  await sync(gone.env, NOW + 60e3, deleted, graded);
  assert.equal(deleted.calls.length, 1, 'a 404 is the end of it');
});

test('the status route says whether it is set up and working, never the address or a message id', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: '987654321098765432' });
  store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  await sync(env, NOW, fakeDiscord(), [ml()]);
  const status = await discordStatus(env);
  assert.deepEqual([status.live, status.updates, status.role, status.liveSecretRejected, status.plays], [true, false, true, false, { open: 1 }]);
  const text = JSON.stringify(status);
  assert.ok(!text.includes('webhooks') && !text.includes('abcDEF') && !text.includes('900000000000000001') && !text.includes('987654321098765432'));
  // A secret that is set but is not a webhook address is reported as that.
  assert.equal((await discordStatus(makeEnv({ DISCORD_LIVE_WEBHOOK: 'https://example.com/hook' }).env)).liveSecretRejected, true);
  assert.deepEqual([(await discordStatus(makeEnv().env)).live, (await discordStatus(makeEnv().env)).liveSecretRejected], [false, false]);
});

test('a test alert goes out once per test id: a sample play marked TEST with the role ping, then the same message edited to its settled form', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: '<@&987654321098765432>' });
  store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  const d = fakeDiscord();
  const run = (now, id = 't1') => sync(env, now, d, [], undefined, id);
  await run(NOW);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].method, 'POST');
  assert.equal(d.calls[0].body.content, '<@&987654321098765432>', 'a role pasted as a mention is read as its id, and the test pings it');
  assert.equal(d.calls[0].body.embeds[0].title, '🧪 TEST · 🎾 TAKE · Test Player to win the match');
  assert.match(d.calls[0].body.embeds[0].footer.text, /TEST ALERT · not a real play/);
  assert.match(d.calls[0].body.embeds[0].description, /\*\*Why:\*\* Player has held 6 of 6[^]*\*\*Bet it:\*\* \[FanDuel −175\]\(https:\/\/sportsbook\.fanduel\.com\/\) · \[DraftKings −180\]/, 'the test shows the whole card: the reason and the books');
  await run(NOW + 20e3);
  assert.equal(d.calls.length, 1, 'not edited within the same minute');
  await run(NOW + 60e3);
  assert.deepEqual([d.calls[1].method, d.calls[1].url], ['PATCH', `${HOOK}/messages/900000000000000001`]);
  assert.match(d.calls[1].body.embeds[0].title, /^🧪 TEST · ✅ WON · Test Player/);
  assert.match(d.calls[1].body.embeds[0].description, /^\*\*Final 6-0 4-6 7-6 · \+0\.57u\*\*/);
  for (let i = 2; i < 6; i++) await run(NOW + i * 60e3);
  assert.equal(d.calls.length, 2, 'once per id');
  assert.deepEqual((await discordStatus(env)).test, { id: 't1', state: 'done', at: NOW });
  // A new id sends a new test.
  await run(NOW + 10 * 60e3, 't2');
  assert.equal(d.calls.length, 3);
  assert.ok(TEST_ALERT_ID.length > 0 && testAlertMessage(NOW).embeds[0].title.includes('TEST'));

  // The status says whether the role was found under its name and whether it is an id.
  const st = async (extra) => { const s = await discordStatus(makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, ...extra }).env); return [s.role, s.roleSecretFound, s.roleSecretRejected]; };
  assert.deepEqual(await st({}), [false, false, false], 'not set under DISCORD_LIVE_ROLE_ID');
  assert.deepEqual(await st({ DISCORD_LIVE_ROLE_ID: 'Live Tennis' }), [false, true, true], 'set, but a name and not an id');
  assert.deepEqual(await st({ DISCORD_LIVE_ROLE_ID: ' 987654321098765432 ' }), [true, true, false]);
  for (const pasted of ['"987654321098765432"', '@&987654321098765432', 'Role ID: 987654321098765432', '<@&987654321098765432>']) assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: pasted }).role, '987654321098765432', pasted);
  assert.equal(discordConfig({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: '987654321098765432 123456789012345678' }).role, null, 'two ids: which one is not ours to guess');

  // With an updates channel set, the test's result line goes there too, marked as a test.
  const both = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES });
  both.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ helloAt: NOW - 1, plays: {} }));
  const d2 = fakeDiscord();
  await sync(both.env, NOW, d2, [], undefined, 't9');
  await sync(both.env, NOW + 60e3, d2, [], undefined, 't9');
  await sync(both.env, NOW + 120e3, d2, [], undefined, 't9');
  assert.deepEqual(d2.calls.map((c) => [c.method, c.url.split('?')[0].split('/messages')[0]]), [['POST', HOOK], ['PATCH', HOOK], ['POST', UPDATES]]);
  assert.match(d2.calls[2].body.content, /^🧪 TEST \(not a real play\) · ✅ WON · Test Player to win the match/);
  assert.equal((await discordStatus(both.env)).test.updates, 'sent');
});
