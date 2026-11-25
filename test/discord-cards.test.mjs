/**
 * The Discord cards as pictures with buttons (2026-11-25, the owner's four
 * templates: live play, won, lost, void). worker/src/card-svg.js draws the
 * card, worker/src/discord.js sends it with its buttons and falls back to
 * the written card, worker/src/play-page.js is the page behind the stats
 * button. The PNG itself is made by a WebAssembly renderer the tests do
 * not load: a stand-in gives the bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSvg, cardState, playLines, fitSize, cardTime, CARD_W, CARD_H } from '../worker/src/card-svg.js';
import { syncLiveDiscord, discordStatus, testPlays, cardButtons, cardLine, cardMessage, booksOf, statsUrl, findLivePlay, recordForPlay, DISCORD_LEDGER_KEY } from '../worker/src/discord.js';
import { playPage, missingPlayPage } from '../worker/src/play-page.js';
import { tennisLivePlaysKey, TENNIS_LIVE_PLAYS_INDEX } from '../worker/src/tennis-live-plays.js';

const NOW = Date.parse('2026-11-25T18:00:00Z');
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const UPDATES = 'https://discord.com/api/webhooks/223456789012345678/zzzDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const ROLE = '987654321098765432';
const WORKER = 'https://pixel-pick-odds.mgbouldering.workers.dev';
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
const ml = (over = {}) => ({ id: 'atp:1:live_ml', matchId: 'atp:1', tour: 'atp', event: 'Challenger Playford 2', round: '1/8-finals', a: 'M. Dellavedova', b: 'H. Moriya', market: 'live_ml', side: 'a', prob: 0.69, american: -175, playable: -190, bookId: 'fanduel', book: 'FanDuel', link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2', units: 1, selection: 'M. Dellavedova to win the match (live)', score: '6-0 3-4', postedAt: NOW - 60e3, status: 'pending', ...over });
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
const ledgerOf = (store) => JSON.parse(store.get(DISCORD_LEDGER_KEY));
const run = (env, now, d, { plays = [], testId = '', testScope = 'cards', render = async () => PNG } = {}) => syncLiveDiscord(env, now, { deps: { fetch: d.fetch, plays: async () => plays, records: async () => ({ ml: { wins: 8, losses: 2, units: 3.29 } }), testId, testScope, render } });
const hello = (store) => store.set(DISCORD_LEDGER_KEY, JSON.stringify({ plays: {}, helloAt: 1 }));

test('the card says which of the four templates it is, and puts the play in two lines: what to take, and the bet', () => {
  assert.deepEqual([ml(), ml({ status: 'graded', result: 'win' }), ml({ status: 'graded', result: 'loss' }), ml({ status: 'void' })].map(cardState), ['live', 'won', 'lost', 'void']);
  assert.deepEqual(playLines(ml()), { big: 'M. Dellavedova', small: 'to win the match' });
  assert.deepEqual(playLines({ a: 'Carlos Alcaraz', b: 'Alexander Zverev', side: 'b', selection: 'Alexander Zverev to win set 2' }), { big: 'Alexander Zverev', small: 'to win set 2' });
  assert.deepEqual(playLines({ a: 'A', b: 'B', side: null, selection: 'Set 2 over 9.5 games' }), { big: 'over 9.5 games', small: 'in set 2' });
  assert.deepEqual(playLines({ a: 'A', b: 'B', selection: 'Something else' }), { big: 'Something else', small: '' });
  // A long line comes down in size and stops at the floor; a short one is left alone.
  assert.equal(fitSize('AB', 100, 40), 40);
  assert.equal(fitSize('ABCDEFGHIJ', 100, 40), 20);
  assert.equal(fitSize('A'.repeat(200), 100, 40, { min: 24 }), 24);
  assert.equal(cardTime(NOW), 'Nov 25  •  1:00 PM ET');
  assert.equal(cardTime(undefined), '');
});

test('the live play card: the header and its tag, the event, the players, the play largest, the price and book, the three numbers, the score, the footer', () => {
  const t = testPlays(NOW);
  const svg = cardSvg(t['test-live'], { logo: 'data:image/png;base64,AAAA' });
  assert.match(svg, new RegExp(`^<svg[^>]*viewBox="0 0 ${CARD_W} ${CARD_H}"`));
  assert.match(svg, /<image[^>]*href="data:image\/png;base64,AAAA"/, 'the logo sits in the header');
  assert.deepEqual(texts(svg), ['PERPETUAL', 'PICKS', '[ LIVE PLAY ]', '[ ATP  •  TEST ALERT  •  NOT A REAL PLAY ]', 'TEST PLAYER vs SAMPLE OPPONENT', 'THE PLAY  •  TAKE', 'TEST PLAYER', 'TO WIN THE MATCH', '-150', 'FanDuel  •  1u stake', '69%', 'CHANCE TO LAND', '60%', 'PRICE NEEDS', '+9', 'EDGE, PTS', '[ SCORE WHEN TAKEN ]', '2ND SET  •  6-0  3-4', 'perpetualpicks.com  •  Nov 25  •  1:00 PM ET']);
  // The play is the largest text on the card: nothing else comes near it.
  const sizes = [...svg.matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*>([^<]*)/g)].map((m) => [Number(m[1]), m[2]]);
  const biggest = sizes.reduce((x, y) => (y[0] > x[0] ? y : x));
  assert.equal(biggest[1], 'TEST PLAYER');
  assert.ok(sizes.filter((s) => s[1] !== 'TEST PLAYER').every((s) => s[0] <= biggest[0] * 0.75), 'everything else is at most three quarters its size');
  // Without the logo the card still stands.
  assert.doesNotMatch(cardSvg(t['test-live']), /<image/);
});

test('the won, lost and void cards: their own tag and colour, the final score and the units in place of the score when taken', () => {
  const t = testPlays(NOW);
  const won = cardSvg(t['test-won']); const lost = cardSvg(t['test-lost']); const voided = cardSvg(t['test-void']);
  assert.deepEqual(texts(won).slice(-3), ['[ RESULT  •  FINAL SCORE ]', 'FINAL 6-0 4-6 7-6  •  +0.67u', 'perpetualpicks.com  •  Nov 25  •  1:00 PM ET']);
  assert.deepEqual(texts(lost).slice(-3), ['[ RESULT  •  FINAL SCORE ]', 'FINAL 6-0 4-6 3-6  •  -1.00u', 'perpetualpicks.com  •  Nov 25  •  1:00 PM ET']);
  assert.deepEqual(texts(voided).slice(-4), ['[ NO RESULT ]', 'VOID  •  STAKE RETURNED', 'A RETIREMENT', 'perpetualpicks.com  •  Nov 25  •  1:00 PM ET']);
  assert.deepEqual([won, lost, voided].map((s) => texts(s)[2]), ['[ WON • GRADED ]', '[ LOST • GRADED ]', '[ VOID • GRADED ]']);
  assert.deepEqual([won, lost, voided].map((s) => texts(s)[5]), ['THE PLAY', 'THE PLAY', 'THE PLAY'], 'a settled card no longer says to take it');
  // Green, red and grey, and none of them the live card's blue.
  assert.match(won, /#2EE86B/); assert.match(lost, /#FF4545/); assert.match(voided, /#9A9DB2/);
  for (const s of [won, lost, voided]) assert.doesNotMatch(s, /#22B8FF/);
});

test('a play no book priced says "or better"; a name is folded to letters the card\'s font has, and nothing in a name can break the picture', () => {
  const svg = cardSvg({ id: 'x', market: 'live_set_total', tour: 'wta', event: 'Open <b>', round: 'Final', a: 'Iga Świątek', b: 'A & B', side: null, prob: 0.6, playable: -120, units: 0.5, selection: 'Set 2 over 9.5 games', score: '6-2 2-1', status: 'pending', postedAt: NOW });
  const t = texts(svg);
  assert.deepEqual(t.slice(3, 10), ['[ WTA  •  OPEN &lt;B&gt;  •  FINAL ]', 'IGA SWIATEK vs A &amp; B', 'THE PLAY  •  TAKE', 'OVER 9.5 GAMES', 'IN SET 2', '-120', 'or better  •  0.5u stake']);
  assert.doesNotMatch(svg, /<b>|Ś|ą/);
});

test('the buttons: one a book that has the line, best price first and three at most, then the stats; a settled card keeps the stats alone', () => {
  const t = testPlays(NOW);
  const [row] = cardButtons(t['test-live']);
  assert.equal(row.type, 1);
  assert.deepEqual(row.components.map((b) => [b.label, b.url]), [
    ['Add to slip · FanDuel −150', 'https://sportsbook.fanduel.com/'],
    ['DraftKings −155', 'https://sportsbook.draftkings.com/'],
    ['Caesars −160', 'https://sportsbook.caesars.com/'],
    ['Stats & why', `${WORKER}/play/test-live`],
  ]);
  // Link buttons: the only kind a channel webhook can send.
  assert.ok(row.components.every((b) => b.type === 2 && b.style === 5 && /^https:\/\//.test(b.url) && b.label.length <= 80));
  assert.deepEqual(cardButtons(t['test-won'])[0].components.map((b) => b.label), ['Stats behind the pick']);
  assert.deepEqual(cardButtons(t['test-void'])[0].components.map((b) => b.label), ['Stats behind the pick']);
  // Four books: the three best prices get a button. A link with a blank nobody can fill gets none; one that needs the reader's state goes through the worker.
  const many = ml({ quotes: [
    { bookId: 'betrivers', book: 'BetRivers', american: -160, link: 'https://{state}.betrivers.com/?page=sportsbook#event/1?coupon={pickType}|2|{wagerAmount}' },
    { bookId: 'fanduel', book: 'FanDuel', american: -175, link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2' },
    { bookId: 'caesars', book: 'Caesars', american: -180, link: 'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=abc&dl=betslip' },
    { bookId: 'draftkings', book: 'DraftKings', american: -185, link: 'https://sportsbook.draftkings.com/event/1?outcomes=2' },
    { bookId: 'betmgm', book: 'BetMGM', american: -200, link: 'https://sports.betmgm.com/en/sports?options=1' },
  ] });
  assert.deepEqual(booksOf(many).map((b) => [b.bookId, b.american, Boolean(b.url)]), [['betrivers', -160, false], ['fanduel', -175, true], ['caesars', -180, true], ['draftkings', -185, true], ['betmgm', -200, true]]);
  assert.deepEqual(cardButtons(many)[0].components.map((b) => [b.label, b.url]), [
    ['Add to slip · FanDuel −175', 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2'],
    ['Caesars −180', `${WORKER}/go/atp%3A1%3Alive_ml/caesars`],
    ['DraftKings −185', 'https://sportsbook.draftkings.com/event/1?outcomes=2'],
    ['Stats & why', `${WORKER}/play/atp%3A1%3Alive_ml`],
  ]);
  // A play with no book: the stats button alone.
  assert.deepEqual(cardButtons({ id: 'atp:2:live_set:2', market: 'live_set', playable: -186, status: 'pending' })[0].components.map((b) => b.label), ['Stats & why']);
  assert.equal(statsUrl({ id: 'atp:2:live_set:2' }), `${WORKER}/play/atp%3A2%3Alive_set%3A2`);
});

test('the line above the card says the bet outright, and the message carries the picture, the ping for the one role, and the buttons', () => {
  const t = testPlays(NOW);
  assert.equal(cardLine(t['test-live'], { role: ROLE }), `<@&${ROLE}> 🎾 **TAKE · Test Player to win the match** · −150 at FanDuel · 1u`);
  assert.equal(cardLine({ ...t['test-live'], american: undefined, playable: -186 }), '🎾 **TAKE · Test Player to win the match** · −186 or better · 1u');
  assert.equal(cardLine(t['test-won'], { role: ROLE }), '✅ **WON** · Test Player to win the match · final 6-0 4-6 7-6 · +0.67u');
  assert.equal(cardLine(t['test-lost']), '❌ **LOST** · Test Player to win the match · final 6-0 4-6 3-6 · −1.00u');
  assert.equal(cardLine(t['test-void']), '⚪ **VOID** · Test Player to win the match · stake returned');

  const card = cardMessage(t['test-live'], { role: ROLE, png: PNG });
  assert.deepEqual(card.file, { name: 'card.png', bytes: PNG });
  assert.deepEqual(card.payload.embeds, [{ color: 0xff007a, image: { url: 'attachment://card.png' } }], 'the picture is the card: no words beside it to compete with the play');
  assert.deepEqual(card.payload.attachments, [{ id: 0, filename: 'card.png' }]);
  assert.deepEqual(card.payload.allowed_mentions, { parse: [], roles: [ROLE] });
  assert.equal(card.payload.components[0].components.length, 4);
  // The written card rides along for when the picture cannot go.
  assert.equal(card.plain.embeds[0].title, '🎾 TAKE · Test Player to win the match');
  // The results channel's card pings nobody; a settled card's colour follows how it ended.
  const result = cardMessage(t['test-lost'], { role: ROLE, png: PNG, result: true });
  assert.deepEqual([result.payload.allowed_mentions.roles, result.payload.embeds[0].color, result.payload.content], [[], 0xef4444, '❌ **LOST** · Test Player to win the match · final 6-0 4-6 3-6 · −1.00u']);
  // No picture: the written card with the buttons under it; buttons off: the written card as it always was.
  const written = cardMessage(t['test-live'], { role: ROLE });
  assert.equal(written.file, null);
  assert.deepEqual([written.payload.embeds[0].title, written.payload.components[0].components.length], ['🎾 TAKE · Test Player to win the match', 4]);
  assert.equal(cardMessage(t['test-live'], { role: ROLE, buttons: false }).payload.components, undefined);
});

test('the template test: one card for each of the four, in the live channel, each with its picture and buttons, marked as a test, and nobody pinged', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_LIVE_ROLE_ID: ROLE });
  hello(store);
  const d = fakeDiscord();
  const drawn = [];
  await run(env, NOW, d, { testId: 't-cards', render: async (p) => { drawn.push(p.id); return PNG; } });
  assert.deepEqual(drawn, ['test-live', 'test-won', 'test-lost', 'test-void']);
  assert.deepEqual(d.calls.map((c) => [c.method, c.url]), Array(4).fill(['POST', `${HOOK}?wait=true&with_components=true`]));
  assert.deepEqual(d.calls.map((c) => c.body.content), [
    '🧪 **TEST · not a real play**\n🎾 **TAKE · Test Player to win the match** · −150 at FanDuel · 1u',
    '🧪 **TEST · not a real play**\n✅ **WON** · Test Player to win the match · final 6-0 4-6 7-6 · +0.67u',
    '🧪 **TEST · not a real play**\n❌ **LOST** · Test Player to win the match · final 6-0 4-6 3-6 · −1.00u',
    '🧪 **TEST · not a real play**\n⚪ **VOID** · Test Player to win the match · stake returned',
  ]);
  for (const c of d.calls) {
    assert.deepEqual(c.body.allowed_mentions, { parse: [], roles: [] }, 'a test of the templates pings nobody');
    assert.equal(c.file.size, PNG.length, 'the picture rides with the message');
    assert.deepEqual(c.body.embeds[0].image, { url: 'attachment://card.png' });
  }
  assert.deepEqual(d.calls.map((c) => c.body.components[0].components.length), [4, 1, 1, 1]);
  assert.deepEqual(d.calls.map((c) => c.body.embeds[0].color), [0xff007a, 0x10b981, 0xef4444, 0x9c98b8]);
  const status = await discordStatus(env);
  assert.deepEqual(status.test, { id: 't-cards', state: 'done', at: NOW, cards: 4, pictures: 4, buttons: true });
  assert.deepEqual([status.buttons, status.pictures, status.cardError, status.lastError], [true, true, null, null]);
  // Once: the next tick sends nothing.
  await run(env, NOW + 60e3, d, { testId: 't-cards' });
  assert.equal(d.calls.length, 4);
});

test('Discord will not take the buttons: the card goes again without them, keeps its picture, and later cards leave them off in one request', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  hello(store);
  const d = fakeDiscord((c) => (c.body.components?.length ? { status: 400, body: { message: 'Invalid Form Body' } } : null));
  await run(env, NOW, d, { testId: 't-nobuttons' });
  assert.deepEqual(d.calls.map((c) => [c.url, Boolean(c.body.components), Boolean(c.file)]), [
    [`${HOOK}?wait=true&with_components=true`, true, true],
    [`${HOOK}?wait=true`, false, true],
    [`${HOOK}?wait=true`, false, true],
    [`${HOOK}?wait=true`, false, true],
    [`${HOOK}?wait=true`, false, true],
  ]);
  const status = await discordStatus(env);
  assert.deepEqual(status.test, { id: 't-nobuttons', state: 'done', at: NOW, cards: 4, pictures: 4, buttons: false });
  assert.equal(status.buttons, false);
  // A real play after that: one request, the picture, no buttons.
  d.calls.length = 0;
  await run(env, NOW + 60e3, d, { testId: 't-nobuttons', plays: [ml({ postedAt: NOW })] });
  assert.deepEqual(d.calls.map((c) => [c.url, Boolean(c.body.components), Boolean(c.file)]), [[`${HOOK}?wait=true`, false, true]]);
});

test('Discord will not take the picture: the written card goes, as every alert did before, and the status says why', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_ROLE_ID: ROLE });
  hello(store);
  const d = fakeDiscord((c) => (c.file ? { status: 400, body: { message: 'Request entity too large' } } : null));
  const out = await run(env, NOW, d, { plays: [ml({ postedAt: NOW })] });
  assert.deepEqual(out, { posted: 1, edited: 0, failed: 0 });
  assert.deepEqual(d.calls.map((c) => [c.url, Boolean(c.file), Boolean(c.body.components)]), [[`${HOOK}?wait=true&with_components=true`, true, true], [`${HOOK}?wait=true`, true, false], [`${HOOK}?wait=true`, false, false]]);
  assert.equal(d.calls[2].body.embeds[0].title, '🎾 TAKE · M. Dellavedova to win the match');
  assert.equal(d.calls[2].body.content, `<@&${ROLE}>`);
  const status = await discordStatus(env);
  assert.match(status.cardError.message, /picture/);
  assert.equal(status.buttons, true, 'the buttons were not the trouble, so they are not turned off');
});

test('a play with its picture: posted as a card, its own message redrawn when it settles, and the same picture sent to the results channel without drawing it twice', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_LIVE_ROLE_ID: ROLE });
  hello(store);
  const d = fakeDiscord();
  const drawn = [];
  const render = async (p) => { drawn.push(`${p.id}:${p.status}`); return PNG; };
  await run(env, NOW, d, { plays: [ml({ postedAt: NOW })], render });
  assert.equal(d.calls[0].body.content, `<@&${ROLE}> 🎾 **TAKE · M. Dellavedova to win the match** · −175 at FanDuel · 1u`);
  assert.deepEqual(d.calls[0].body.components[0].components.map((b) => b.label), ['Add to slip · FanDuel −175', 'Stats & why']);
  const settled = ml({ postedAt: NOW, status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6', gradedAt: NOW + 3600e3 });
  await run(env, NOW + 3600e3, d, { plays: [settled], render });
  assert.deepEqual(d.calls.slice(1).map((c) => [c.method, c.url, Boolean(c.file)]), [['PATCH', `${HOOK}/messages/900000000000000001?with_components=true`, true], ['POST', `${UPDATES}?wait=true&with_components=true`, true]]);
  assert.equal(d.calls[1].body.content, '✅ **WON** · M. Dellavedova to win the match · final 6-0 4-6 7-6 · +0.57u');
  assert.deepEqual(d.calls[1].body.attachments, [{ id: 0, filename: 'card.png' }], 'the new picture takes the old one\'s place');
  assert.deepEqual(d.calls[1].body.components[0].components.map((b) => b.label), ['Stats behind the pick'], 'the bet buttons come off a settled card');
  assert.deepEqual(d.calls[2].body.allowed_mentions.roles, [], 'the results channel pings nobody');
  assert.deepEqual(drawn, ['atp:1:live_ml:pending', 'atp:1:live_ml:graded']);
});

test('drawing is guarded: a marker is stored before each drawing and taken off after, and a run that died drawing turns pictures off so the alert still goes, written', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  hello(store);
  const d = fakeDiscord();
  let seen = null;
  await run(env, NOW, d, { plays: [ml({ postedAt: NOW })], render: async () => { seen = ledgerOf(store); return PNG; } });
  assert.deepEqual(seen.rendering, { at: NOW, id: 'atp:1:live_ml' }, 'the marker is on file while the card is drawn');
  assert.equal(seen.plays['atp:1:live_ml'], undefined, 'and the play is not yet marked as sending: nothing has gone');
  assert.equal(ledgerOf(store).rendering, undefined, 'and off once it is drawn');
  assert.equal(d.calls.length, 1);

  // A run that never came back from drawing: its marker is still there. The play was not posted, so it is, without a picture.
  const died = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  died.store.set(DISCORD_LEDGER_KEY, JSON.stringify({ plays: {}, helloAt: 1, rendering: { at: NOW - 60e3, id: 'atp:1:live_ml' } }));
  const d2 = fakeDiscord();
  let draws = 0;
  const render = async () => { draws++; return PNG; };
  const out = await run(died.env, NOW, d2, { plays: [ml({ postedAt: NOW - 60e3 })], testId: 't1', testScope: 'none', render });
  assert.deepEqual(out, { posted: 1, edited: 0, failed: 0 });
  assert.equal(draws, 0);
  const posts = d2.calls.filter((c) => c.body.embeds?.[0]?.title === '🎾 TAKE · M. Dellavedova to win the match');
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].file, posts[0].body.components[0].components.length], [null, 2], 'the written card, with its buttons');
  assert.equal((await discordStatus(died.env)).pictures, false);
  // Pictures stay off until a new test id asks for them again.
  await run(died.env, NOW + 60e3, d2, { plays: [ml({ id: 'atp:9:live_ml', postedAt: NOW + 60e3 })], testId: 't1', testScope: 'none', render });
  assert.equal(draws, 0);
  await run(died.env, NOW + 120e3, d2, { testId: 't2', testScope: 'cards', render });
  assert.equal(draws, 4);
  assert.equal((await discordStatus(died.env)).pictures, true);
});

test('a drawing that throws is not a failure: the written card goes and the status keeps the reason', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  hello(store);
  const d = fakeDiscord();
  const out = await run(env, NOW, d, { plays: [ml({ postedAt: NOW })], render: async () => { throw new Error('wasm would not start'); } });
  assert.deepEqual(out, { posted: 1, edited: 0, failed: 0 });
  assert.deepEqual([d.calls[0].file, d.calls[0].body.embeds[0].title], [null, '🎾 TAKE · M. Dellavedova to win the match']);
  const status = await discordStatus(env);
  assert.deepEqual(status.cardError, { at: NOW, message: 'wasm would not start' });
  assert.equal(status.pictures, true, 'one bad drawing does not turn pictures off');
});

test('a play is found by its id for the card, the stats page and the links: today\'s, an older kept day\'s, never a lean, and the test cards by their own ids', async () => {
  const { env, store } = makeEnv();
  store.set(tennisLivePlaysKey('2026-11-25'), JSON.stringify({ plays: [ml(), ml({ id: 'atp:3:live_ml', lean: true })] }));
  store.set(tennisLivePlaysKey('2026-11-02'), JSON.stringify({ plays: [ml({ id: 'atp:7:live_ml', a: 'Old Play' })] }));
  store.set(TENNIS_LIVE_PLAYS_INDEX, JSON.stringify({ dates: ['2026-11-02', '2026-11-25'] }));
  assert.equal((await findLivePlay(env, 'atp:1:live_ml', NOW)).a, 'M. Dellavedova');
  assert.equal((await findLivePlay(env, 'atp:7:live_ml', NOW)).a, 'Old Play');
  assert.equal(await findLivePlay(env, 'atp:3:live_ml', NOW), null, 'a lean is not a tracked play');
  assert.equal(await findLivePlay(env, 'nope', NOW), null);
  assert.equal(await findLivePlay(env, '', NOW), null);
  assert.equal(await findLivePlay(env, 'x'.repeat(121), NOW), null);
  for (const [id, status] of [['test-live', 'pending'], ['test-won', 'graded'], ['test-lost', 'graded'], ['test-void', 'void']]) assert.equal((await findLivePlay(env, id, NOW)).status, status);
  assert.equal(await findLivePlay(env, 'test-other', NOW), null);
  assert.deepEqual(await recordForPlay(env, { id: 'test-live' }, NOW), { wins: 9, losses: 2, units: 3.86 });
});

test('the page behind the stats button: the card, the bet, the price with a link a book, the numbers, why, the record, and no script', () => {
  const t = testPlays(NOW);
  const html = playPage(t['test-live'], { record: { wins: 9, losses: 2, units: 3.86 } });
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<title>Test Player to win the match · Perpetual Picks<\/title>/);
  assert.match(html, new RegExp(`<img class="card" src="${WORKER}/card/test-live\\.png\\?s=live"`));
  assert.match(html, /<h1><small>Live play · take<\/small>Test Player to win the match<\/h1>/);
  assert.match(html, /<a class="book" href="https:\/\/sportsbook\.fanduel\.com\/" rel="noopener noreferrer"><span>Add to slip · FanDuel<\/span><span>−150 ↗<\/span><\/a>/);
  for (const part of ['<h2>The price</h2>', 'good down to −165', '<h2>The numbers</h2>', '<dt>Chance to land</dt><dd>69%', '<dt>Price needs</dt><dd>60%', '<dt>Edge</dt><dd>+9 pts', '<dt>Player serve</dt><dd>6/6', '<dt>Last 8 games</dt><dd>5–3', '<h2>Why</h2>', '<li>Last 8 games: Test Player 5, Sample Opponent 3.</li>', '<h2>Our Match Winner record</h2>', '<dd>9-2</dd>', '<dd>+3.86u</dd>']) assert.ok(html.includes(part), part);
  // Settled: the result, and no bet links.
  const won = playPage(t['test-won']);
  assert.match(won, /<h2>Result<\/h2><strong>Won · \+0\.67u<\/strong>/);
  assert.doesNotMatch(won, /Add to slip/);
  assert.match(playPage(t['test-void']), /Void · stake returned/);
  // Nothing in a play's own words can become markup.
  const sharp = playPage(ml({ a: '<img src=x onerror=alert(1)>', selection: '<script>alert(1)</script> to win', event: '"><b>', why: ['<i>x</i>'] }));
  assert.doesNotMatch(sharp, /<script|<img src=x|<i>x|· "><b>/);
  for (const safe of ['&lt;script&gt;alert(1)&lt;/script&gt; to win', '&lt;img src=x onerror=alert(1)&gt; vs', '&quot;&gt;&lt;b&gt;', '<li>&lt;i&gt;x&lt;/i&gt;</li>']) assert.ok(sharp.includes(safe), safe);
  const gone = missingPlayPage();
  assert.match(gone, /That play is no longer on file\./);
  assert.doesNotMatch(gone, /<script/i);
});
