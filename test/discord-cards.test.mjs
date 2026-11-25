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
import fs from 'node:fs';
import { cardSvg, cardState, playLines, marketWords, fitSize, fitLine, nameForms, textWidth, cardTime, ADVANCES, CARD_W, CARD_H } from '../worker/src/card-svg.js';
import { syncLiveDiscord, discordStatus, discordConfig, livePlayMessage, testPlays, testLeans, cardButtons, cardLine, cardMessage, booksOf, statsUrl, findLivePlay, recordForPlay, DISCORD_LEDGER_KEY } from '../worker/src/discord.js';
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

test('the card is laid out like a bet slip: what it is and the price on top; the pick and its market in the panel; the players and the recommended units; the score and the time', () => {
  const t = testPlays(NOW);
  const svg = cardSvg(t['test-live'], { logo: 'data:image/png;base64,AAAA' });
  assert.match(svg, new RegExp(`^<svg[^>]*viewBox="0 0 ${CARD_W} ${CARD_H}"`));
  assert.ok(CARD_W / CARD_H > 1.6, 'a wide, short card, like a slip');
  assert.match(svg, /<image[^>]*href="data:image\/png;base64,AAAA"/, 'the logo sits beside the tag');
  assert.deepEqual(texts(svg), ['Live Play', '-150', 'FANDUEL', 'ATP', 'Test Player', 'MATCH WINNER', 'Test Player v Sample Opponent', 'RECOMMENDED', '1u', 'Taken at 6-0 3-4', '1:00 PM ET', 'perpetualpicks.com', 'ATP  •  Test alert  •  not a real play  •  Nov 25']);
  // The pick and the price are the two largest things on it; the pick is in the state's colour.
  const sized = [...svg.matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*fill="([^"]+)"[^>]*>([^<]*)/g)].map((m) => [Number(m[1]), m[3], m[2]]).sort((x, y) => y[0] - x[0]);
  assert.deepEqual(sized.slice(0, 2).map((x) => x[1]).sort(), ['-150', 'Test Player']);
  assert.equal(sized.find((x) => x[1] === 'Test Player')[2], '#57B6FF');
  // The market, in a slip's words.
  assert.deepEqual([{ market: 'live_ml' }, { market: 'live_set', set: 2 }, { market: 'live_set_total', set: 3 }].map(marketWords), ['Match Winner', 'Set 2 Winner', 'Set 3 Total Games']);
  // Without the logo the card still stands.
  assert.doesNotMatch(cardSvg(t['test-live']), /<image/);
});

test('the won, lost and void cards keep their own tag and colour, and show the final score and the result in units', () => {
  const t = testPlays(NOW);
  const won = cardSvg(t['test-won']); const lost = cardSvg(t['test-lost']); const voided = cardSvg(t['test-void']);
  assert.deepEqual(texts(won), ['Won', '-150', 'FANDUEL', 'ATP', 'Test Player', 'MATCH WINNER', 'Test Player v Sample Opponent', 'RESULT', '+0.67u', 'Final 6-0 4-6 7-6', '1:00 PM ET', 'perpetualpicks.com', 'ATP  •  Test alert  •  not a real play  •  Nov 25']);
  assert.deepEqual([texts(lost)[0], ...texts(lost).slice(7, 10)], ['Lost', 'RESULT', '-1.00u', 'Final 6-0 4-6 3-6']);
  assert.deepEqual([texts(voided)[0], ...texts(voided).slice(7, 9)], ['Void', 'Stake back', 'Void: a retirement']);
  // Green, red and grey, and none of them the live card's blue.
  assert.match(won, /#17A34A/); assert.match(lost, /#E11D48/); assert.match(voided, /#70758A/);
  for (const s of [won, lost, voided]) assert.doesNotMatch(s, /#1E86FF/);
});

test('a play no book priced says "or better" under its price; a name is folded to letters the card\'s font has, and nothing in a name can break the picture', () => {
  const svg = cardSvg({ id: 'x', market: 'live_set_total', set: 2, tour: 'wta', event: 'Open <b>', round: 'Final', a: 'Iga Świątek', b: 'A & B', side: null, prob: 0.6, playable: -120, units: 0.5, selection: 'Set 2 over 9.5 games', score: '6-2 2-1', status: 'pending', postedAt: NOW });
  assert.deepEqual(texts(svg), ['Live Play', '-120', 'OR BETTER', 'WTA', 'Over 9.5 Games', 'SET 2 TOTAL GAMES', 'Iga Swiatek v A &amp; B', 'RECOMMENDED', '0.5u', 'Taken at 6-2 2-1', '1:00 PM ET', 'perpetualpicks.com', 'WTA  •  Open &lt;b&gt;  •  Final  •  Nov 25']);
  assert.doesNotMatch(svg, /<b>|Ś|ą/);
});

test('the buttons: one a book that has the line, best price first and three at most, then More info; a settled card keeps More info alone', () => {
  const t = testPlays(NOW);
  const flat = (rows) => rows.map((r) => r.components.map((b) => [b.label, b.url]));
  const rows = cardButtons(t['test-live']);
  assert.ok(rows.every((r) => r.type === 1));
  // The books on one row, the stats on the row under it: the stats button never moves and no row is crowded.
  assert.deepEqual(flat(rows), [
    [['Add to slip · FanDuel −150', 'https://sportsbook.fanduel.com/'], ['DraftKings −155', 'https://sportsbook.draftkings.com/'], ['Caesars −160', 'https://sportsbook.caesars.com/']],
    [['More info', `${WORKER}/play/test-live`]],
  ]);
  // Link buttons: the only kind a channel webhook can send.
  assert.ok(rows.flatMap((r) => r.components).every((b) => b.type === 2 && b.style === 5 && /^https:\/\//.test(b.url) && b.label.length <= 80));
  assert.deepEqual(flat(cardButtons(t['test-won'])).map((r) => r.map((b) => b[0])), [['More info']]);
  assert.deepEqual(flat(cardButtons(t['test-void'])).map((r) => r.map((b) => b[0])), [['More info']]);
  // A book with a very long name: its label is cut, so a button is never wider than a phone.
  const longBook = cardButtons(ml({ bookId: 'longbook', book: 'The Extraordinarily Long Sportsbook & Casino Company', quotes: [] }));
  assert.deepEqual(longBook[0].components.map((b) => b.label), ['Add to slip · The Extraordinarily L… −175']);
  assert.ok(longBook.flatMap((r) => r.components).every((b) => b.label.length <= 42));
  // Four books: the three best prices get a button. A link with a blank nobody can fill gets none; one that needs the reader's state goes through the worker.
  const many = ml({ quotes: [
    { bookId: 'betrivers', book: 'BetRivers', american: -160, link: 'https://{state}.betrivers.com/?page=sportsbook#event/1?coupon={pickType}|2|{wagerAmount}' },
    { bookId: 'fanduel', book: 'FanDuel', american: -175, link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2' },
    { bookId: 'caesars', book: 'Caesars', american: -180, link: 'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=abc&dl=betslip' },
    { bookId: 'draftkings', book: 'DraftKings', american: -185, link: 'https://sportsbook.draftkings.com/event/1?outcomes=2' },
    { bookId: 'betmgm', book: 'BetMGM', american: -200, link: 'https://sports.betmgm.com/en/sports?options=1' },
  ] });
  assert.deepEqual(booksOf(many).map((b) => [b.bookId, b.american, Boolean(b.url)]), [['betrivers', -160, false], ['fanduel', -175, true], ['caesars', -180, true], ['draftkings', -185, true], ['betmgm', -200, true]]);
  assert.deepEqual(flat(cardButtons(many)), [
    [['Add to slip · FanDuel −175', 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2'], ['Caesars −180', `${WORKER}/go/atp%3A1%3Alive_ml/caesars`], ['DraftKings −185', 'https://sportsbook.draftkings.com/event/1?outcomes=2']],
    [['More info', `${WORKER}/play/atp%3A1%3Alive_ml`]],
  ]);
  // A play with no book: the stats button alone.
  assert.deepEqual(flat(cardButtons({ id: 'atp:2:live_set:2', market: 'live_set', playable: -186, status: 'pending' })).map((r) => r.map((b) => b[0])), [['More info']]);
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
  assert.deepEqual(card.payload.components.map((r) => r.components.length), [3, 1]);
  // The written card rides along for when the picture cannot go.
  assert.equal(card.plain.embeds[0].title, '🎾 TAKE · Test Player to win the match');
  // The results channel's card pings nobody; a settled card's colour follows how it ended.
  const result = cardMessage(t['test-lost'], { role: ROLE, png: PNG, result: true });
  assert.deepEqual([result.payload.allowed_mentions.roles, result.payload.embeds[0].color, result.payload.content], [[], 0xef4444, '❌ **LOST** · Test Player to win the match · final 6-0 4-6 3-6 · −1.00u']);
  // No picture: the written card with the buttons under it; buttons off: the written card as it always was.
  const written = cardMessage(t['test-live'], { role: ROLE });
  assert.equal(written.file, null);
  assert.deepEqual([written.payload.embeds[0].title, written.payload.components.map((r) => r.components.length)], ['🎾 TAKE · Test Player to win the match', [3, 1]]);
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
  assert.deepEqual(d.calls.map((c) => c.body.components.map((r) => r.components.length)), [[3, 1], [1], [1], [1]]);
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
  assert.deepEqual(d.calls[0].body.components.map((r) => r.components.map((b) => b.label)), [['Add to slip · FanDuel −175'], ['More info']]);
  const settled = ml({ postedAt: NOW, status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6', gradedAt: NOW + 3600e3 });
  await run(env, NOW + 3600e3, d, { plays: [settled], render });
  assert.deepEqual(d.calls.slice(1).map((c) => [c.method, c.url, Boolean(c.file)]), [['PATCH', `${HOOK}/messages/900000000000000001?with_components=true`, true], ['POST', `${UPDATES}?wait=true&with_components=true`, true]]);
  assert.equal(d.calls[1].body.content, '✅ **WON** · M. Dellavedova to win the match · final 6-0 4-6 7-6 · +0.57u');
  assert.deepEqual(d.calls[1].body.attachments, [{ id: 0, filename: 'card.png' }], 'the new picture takes the old one\'s place');
  assert.deepEqual(d.calls[1].body.components.map((r) => r.components.map((b) => b.label)), [['More info']], 'the bet buttons come off a settled card');
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
  assert.deepEqual([posts[0].file, posts[0].body.components.map((r) => r.components.length)], [null, [1, 1]], 'the written card, with its buttons');
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

test('a play is found by its id for the card, the stats page and the links: today\'s, an older kept day\'s, a lean too, and the test cards by their own ids', async () => {
  const { env, store } = makeEnv();
  store.set(tennisLivePlaysKey('2026-11-25'), JSON.stringify({ plays: [ml(), ml({ id: 'atp:3:live_ml', lean: true })] }));
  store.set(tennisLivePlaysKey('2026-11-02'), JSON.stringify({ plays: [ml({ id: 'atp:7:live_ml', a: 'Old Play' })] }));
  store.set(TENNIS_LIVE_PLAYS_INDEX, JSON.stringify({ dates: ['2026-11-02', '2026-11-25'] }));
  assert.equal((await findLivePlay(env, 'atp:1:live_ml', NOW)).a, 'M. Dellavedova');
  assert.equal((await findLivePlay(env, 'atp:7:live_ml', NOW)).a, 'Old Play');
  assert.equal((await findLivePlay(env, 'atp:3:live_ml', NOW)).lean, true, 'a lean has a card and a stats page too');
  assert.equal(await recordForPlay(env, { id: 'atp:3:live_ml', lean: true, market: 'live_ml' }, NOW), null, 'and is on no record');
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
  assert.match(html, new RegExp(`<img class="card" src="${WORKER}/card/test-live\\.png\\?s=live&amp;v=\\d+" alt="Test Player to win the match" width="${CARD_W}" height="${CARD_H}">`));
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

// --- Nothing overlaps, whatever the names, the event, the score or the book are called (2026-11-25) ---

/** Advance widths per 1000 em for the card's characters, read from a font file: the head, hhea, hmtx and cmap (format 4) tables. */
function advancesOf(path, chars) {
  const b = fs.readFileSync(path); const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = {};
  for (let i = 0; i < dv.getUint16(4); i++) { const o = 12 + i * 16; tables[b.toString('latin1', o, o + 4)] = dv.getUint32(o + 8); }
  const upm = dv.getUint16(tables.head + 18); const nH = dv.getUint16(tables.hhea + 34);
  const c = tables.cmap; let sub = null;
  for (let i = 0; i < dv.getUint16(c + 2); i++) { const pid = dv.getUint16(c + 4 + i * 8); const eid = dv.getUint16(c + 6 + i * 8); const off = c + dv.getUint32(c + 8 + i * 8); if (dv.getUint16(off) === 4 && (pid === 0 || (pid === 3 && eid === 1))) sub = off; }
  const segX2 = dv.getUint16(sub + 6); const endO = sub + 14; const startO = endO + segX2 + 2; const deltaO = startO + segX2; const rangeO = deltaO + segX2;
  const glyph = (cp) => { for (let i = 0; i < segX2; i += 2) { if (cp > dv.getUint16(endO + i)) continue; const start = dv.getUint16(startO + i); if (cp < start) return 0; const delta = dv.getInt16(deltaO + i); const ro = dv.getUint16(rangeO + i); if (ro === 0) return (cp + delta) & 0xffff; const g = dv.getUint16(rangeO + i + ro + 2 * (cp - start)); return g ? (g + delta) & 0xffff : 0; } return 0; };
  return [...chars].map((ch) => Math.round((dv.getUint16(tables.hmtx + 4 * Math.min(glyph(ch.codePointAt(0)), nH - 1)) * 1000) / upm));
}

test('the card measures its text with the fonts\' own letter widths: the table matches the font files it is drawn with', () => {
  const chars = `${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')}•`;
  for (const weight of [400, 500, 700]) assert.deepEqual(ADVANCES[weight], advancesOf(new URL(`../worker/vendor/fonts/RobotoCondensed-${weight}.ttf`, import.meta.url), chars), `Roboto Condensed ${weight}`);
  // A width is the letters' widths at the size plus the spacing after each; runs of spaces count once, as they are drawn.
  assert.equal(Math.round(textWidth('AB', 40) * 100) / 100, 46.32);
  assert.equal(textWidth('A  •  B', 20, { weight: 500 }), textWidth('A • B', 20, { weight: 500 }));
  assert.ok(textWidth('WWWW', 40) > textWidth('IIII', 40) * 2, 'a wide letter is not counted like a narrow one');
});

test('a line always fits: it comes down in size, then to a shorter form, then is cut with "...", and what must stay is never cut', () => {
  assert.deepEqual(fitLine('AB', 100, 40), { text: 'AB', size: 40 });
  const cut = fitLine('A'.repeat(200), 100, 40, { min: 24 });
  assert.deepEqual(cut, { text: 'AAAAA...', size: 24 });
  assert.ok(textWidth(cut.text, cut.size) <= 100);
  // The units after a final score stay whole; the score gives way.
  const final = fitLine('FINAL 6-7 7-6 6-7 7-6 70-68 99-97 88-86', 300, 56, { min: 30, tail: '  •  +0.67u' });
  assert.match(final.text, /^FINAL 6-7.*\.\.\.  •  \+0\.67u$/);
  assert.ok(textWidth(final.text, final.size) <= 300);
  // Names shorten the way a scoreboard does, and a pair stays a pair.
  assert.deepEqual(nameForms('Victoria Jimenez Kasintseva'), ['Victoria Jimenez Kasintseva', 'V. Jimenez Kasintseva', 'V. Kasintseva', 'Kasintseva']);
  assert.deepEqual(nameForms('M. Dellavedova'), ['M. Dellavedova', 'Dellavedova']);
  assert.deepEqual(nameForms('Alex de Minaur'), ['Alex de Minaur', 'A. de Minaur', 'de Minaur']);
  assert.deepEqual(nameForms('Alcaraz'), ['Alcaraz']);
  assert.deepEqual(nameForms('Marcel Granollers / Horacio Zeballos'), ['Marcel Granollers / Horacio Zeballos', 'M. Granollers / H. Zeballos', 'Granollers / Zeballos']);
});

/** Every line of text on a card as a box: where it starts and ends across, and its band down the card. */
function boxes(svg) {
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" font-family="([^"]+)" font-size="([\d.]+)" font-weight="(\d+)"[^>]*?>([^]*?)<\/text>/g)].map((m) => {
    const [whole, x, y, family, size, weight, body] = m;
    const words = body.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const spacing = Number(whole.match(/letter-spacing="([\d.]+)"/)?.[1] ?? 0);
    assert.equal(family, 'Roboto Condensed', 'every line is in the font the card can measure');
    const width = textWidth(words, Number(size), { weight: Number(weight), spacing });
    const left = /text-anchor="middle"/.test(whole) ? Number(x) - width / 2 : /text-anchor="end"/.test(whole) ? Number(x) - width : Number(x);
    // Capitals and figures stand on the line and rise about three quarters of the size; only a lower-case tail hangs under it.
    return { words, left, right: left + width, top: Number(y) - Number(size) * 0.76, bottom: Number(y) + Number(size) * (/[gjpqy,]/.test(words) ? 0.22 : 0.02), size: Number(size) };
  });
}

test('nothing on the card overlaps or leaves the card, however long the names, the event, the round, the book, the score or the bet are', () => {
  const long = 'Wolfeschlegelsteinhausenbergerdorff Maximilian-Alexander von Hohenzollern-Sigmaringen';
  const base = { id: 'x', tour: 'atp', market: 'live_ml', side: 'a', prob: 0.69, american: -150, playable: -165, bookId: 'fanduel', book: 'FanDuel', units: 1, score: '6-0 3-4', status: 'pending', postedAt: NOW, event: 'Wimbledon', round: 'Final', a: 'Carlos Alcaraz', b: 'Alexander Zverev', selection: 'Carlos Alcaraz to win the match (live)' };
  const cases = {
    'everything long': { ...base, event: 'The International Championships of the Greater Metropolitan Area presented by A Very Long Sponsor Name Incorporated', round: 'Round of 128 Qualifying Playoff', a: long, b: 'Bartholomew Montgomery-Featherstonehaugh Junior', selection: `${long} to win the match (live)`, book: 'Hard Rock Bet Sportsbook & Casino Online', american: 10000, units: 0.75, score: '6-7 7-6 6-7 7-6 12-12' },
    'the widest letters': { ...base, a: 'W'.repeat(40), b: 'M'.repeat(40), side: 'b', selection: `${'M'.repeat(40)} to win the match`, status: 'graded', result: 'win', profit: 12.34, actual: '6-7 7-6 6-7 7-6 70-68' },
    'a long round alone': { ...base, event: '', round: 'R'.repeat(120) },
    'a bet in other words': { ...base, side: null, selection: 'A completely different kind of selection that nobody planned for and is very long indeed', status: 'void', actual: '6-0 1-0: the match was abandoned after a very long rain delay and will not resume today or tomorrow' },
    'a long final and big units': { ...base, status: 'graded', result: 'loss', profit: -123.45, actual: '6-7 7-6 6-7 7-6 70-68 99-97 88-86 77-75' },
    'a doubles pair, no price': { ...base, a: 'Marcel Granollers / Horacio Zeballos', b: 'Mate Pavic / Marcelo Arevalo', market: 'live_set', selection: 'Marcel Granollers / Horacio Zeballos to win set 3', american: undefined, book: undefined, playable: -1860 },
    'short everything': { ...base, event: 'X', round: '', a: 'Li', b: 'Wu', selection: 'Li to win the match', score: '' },
    'a set total': { ...base, market: 'live_set_total', side: null, selection: 'Set 2 over 9.5 games', american: undefined, book: undefined, playable: -150 },
    'no names at all': { ...base, a: '', b: '', selection: '', event: '', round: '' },
    'a lean, long names': { ...base, lean: true, basis: 'score', units: 0.5, american: undefined, book: undefined, playable: -245, a: long, b: 'Bartholomew Montgomery-Featherstonehaugh Junior', selection: `${long} to win the match` },
    'a lean that lost': { ...base, lean: true, units: 0.5, status: 'graded', result: 'loss', profit: -0.5, actual: '6-7 7-6 6-7 7-6 70-68 99-97' },
  };
  for (const [name, play] of Object.entries(cases)) {
    const svg = cardSvg(play, { logo: 'data:image/png;base64,AAAA' });
    const all = boxes(svg);
    assert.ok(all.length >= 9, `${name}: the card has its lines`);
    for (const box of all) {
      assert.ok(box.left >= 30 && box.right <= CARD_W - 30, `${name}: "${box.words}" stays inside the card (${Math.round(box.left)} to ${Math.round(box.right)})`);
      assert.ok(box.top >= 20 && box.bottom <= CARD_H - 14, `${name}: "${box.words}" stays inside the card, top to bottom`);
      // Inside the dark panel, a line stays inside the panel.
      if (box.top > 122 && box.bottom < 360) assert.ok(box.left >= 48 && box.right <= CARD_W - 48, `${name}: "${box.words}" stays inside the panel`);
    }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const x = all[i]; const y = all[j];
      const across = Math.min(x.right, y.right) - Math.max(x.left, y.left);
      const down = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      assert.ok(across <= 0 || down <= 0, `${name}: "${x.words}" and "${y.words}" do not overlap`);
    }
    // However long it is, the pick is still easy to read.
    assert.ok(all.some((box) => box.size >= 28 && box.top > 122 && box.top < 200), `${name}: the pick is still large`);
  }
  // Two names too long in any form are each cut, so both players are still named.
  const both = texts(cardSvg(cases['the widest letters'])).find((line) => / v /.test(line));
  assert.match(both, /^W+\.\.\. v M+\.\.\.$/);
});

test('the stats page lets a long name, event or reason wrap inside its own box', () => {
  const html = playPage(ml({ a: 'W'.repeat(60), event: 'E'.repeat(120), why: ['R'.repeat(300)] }));
  assert.match(html, /h1, p, li, dt, dd, span, strong \{ overflow-wrap: anywhere; \}/);
  assert.match(html, /\.book span:last-child \{[^}]*white-space: nowrap; flex: none; \}/, 'a price is never squeezed by a long book name');
  assert.match(html, /dl \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

// --- The leans channel (2026-11-25: "I made another channel (tennis-leans) and added the webhook DISCORD_LIVE_LEAN_WEBHOOK") ---

const LEANS = 'https://discord.com/api/webhooks/323456789012345678/yyyDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const leanOf = (over = {}) => ({ id: 'wta:5:lean:live_ml:0', matchId: 'wta:5', tour: 'wta', event: 'IEB+ Argentina Open', round: 'Round 2', a: 'Veronika Erjavec', b: 'Martina Trevisan', market: 'live_ml', side: 'a', prob: 0.75, playable: -245, basis: 'score', lean: true, units: 0.5, selection: 'Veronika Erjavec to win the match', score: '6-0', why: ['Score 6-0.'], postedAt: NOW, status: 'pending', result: null, profit: null, ...over });

test('a lean\'s card says Lean in its tag in every state, is violet while open, carries its recommended units, and shows no result in units', () => {
  const open = cardSvg(leanOf());
  assert.deepEqual(texts(open), ['Lean', '-245', 'OR BETTER', 'WTA', 'Veronika Erjavec', 'MATCH WINNER', 'Veronika Erjavec v Martina Trevisan', 'RECOMMENDED', '0.5u', 'Taken at 6-0', '1:00 PM ET', 'perpetualpicks.com', 'WTA  •  IEB+ Argentina Open  •  Round 2  •  Nov 25']);
  assert.match(open, /#8B5CF6/, 'the violet of the site\'s lean box');
  assert.doesNotMatch(open, /#1E86FF|Live Play/, 'nothing on it reads as a tracked play');
  const won = cardSvg(leanOf({ status: 'graded', result: 'win', profit: 0.2, actual: '6-0 6-3' }));
  assert.deepEqual([texts(won)[0], ...texts(won).slice(7, 10)], ['Lean • Won', 'RECOMMENDED', '0.5u', 'Final 6-0 6-3']);
  assert.match(won, /#17A34A/);
  assert.doesNotMatch(won, /0\.20u|RESULT/, 'a lean shows no result in units: it is not on the record');
  assert.deepEqual([cardSvg(leanOf({ status: 'graded', result: 'loss', actual: '6-0 3-6 2-6' })), cardSvg(leanOf({ status: 'void', actual: '6-0 1-0: a retirement' }))].map((s) => texts(s)[0]), ['Lean • Lost', 'Lean • Void']);
  // The line above the card and the written card say the same.
  assert.equal(cardLine(leanOf(), { role: ROLE }), '💡 **LEAN · Veronika Erjavec to win the match** · −245 or better · 0.5u', 'the recommended units, and nobody is pinged for a lean');
  assert.equal(cardLine(leanOf({ status: 'graded', result: 'loss', profit: -0.5, actual: '6-0 3-6 2-6' })), '❌ **LEAN LOST** · Veronika Erjavec to win the match · final 6-0 3-6 2-6');
  const written = livePlayMessage(leanOf()).embeds[0];
  assert.deepEqual([written.author.name, written.title, written.color, written.image, written.footer.text], ['PERPETUAL PICKS · LIVE TENNIS LEAN', '💡 LEAN · Veronika Erjavec to win the match', 0x8b5cf6, undefined, 'Lean · not a tracked play · not on the record · perpetualpicks.com']);
  assert.match(written.description, /^\*\*−245 or better\*\* at your book · recommended \*\*0\.5u\*\* · a lean, not on the record\n[^]*\*\*Why:\*\* Read from the score alone: no serve data on this match\. We make it 75% to land; the price only needs 71%\./);
  // The stats page too.
  const page = playPage(leanOf({ status: 'graded', result: 'win', profit: 0.2, actual: '6-0 6-3' }));
  assert.match(page, /<h1><small>Live lean · not on the record<\/small>/);
  assert.match(page, /<strong>Lean won<\/strong>/);
  assert.match(page, /<dt>Recommended<\/dt><dd>0\.5u<small>a lean: not on the record<\/small><\/dd>/);
  assert.doesNotMatch(page, /\+0\.20u|record<\/h2>/);
});

test('the leans go to their own channel: posted as they open and edited when they settle, nobody pinged, nothing sent to the results channel, and never mixed with the plays', async () => {
  assert.equal(discordConfig({ DISCORD_LIVE_LEAN_WEBHOOK: LEANS }).leans, LEANS);
  assert.equal(discordConfig({ DISCORD_LIVE_LEAN_WEBHOOK: 'https://example.com/hook' }).leans, null);
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_LIVE_LEAN_WEBHOOK: LEANS, DISCORD_LIVE_ROLE_ID: ROLE });
  hello(store);
  const d = fakeDiscord();
  const out = await run(env, NOW, d, { plays: [ml({ postedAt: NOW }), leanOf()] });
  assert.deepEqual(out, { posted: 2, edited: 0, failed: 0 });
  assert.deepEqual(d.calls.map((c) => [c.method, c.url.split('?')[0]]), [['POST', HOOK], ['POST', LEANS]]);
  const lean = d.calls[1];
  assert.equal(lean.body.content, '💡 **LEAN · Veronika Erjavec to win the match** · −245 or better · 0.5u');
  assert.deepEqual(lean.body.allowed_mentions, { parse: [], roles: [] }, 'the role is for tracked plays');
  assert.equal(lean.body.embeds[0].color, 0x8b5cf6);
  assert.equal(lean.file.size, PNG.length);
  assert.deepEqual(lean.body.components.map((r) => r.components.map((b) => b.label)), [['More info']], 'no book has it, so the stats button alone');
  assert.match(d.calls[0].body.content, new RegExp(`^<@&${ROLE}> 🎾 \\*\\*TAKE`), 'the play still pings, in its own channel');
  // The same tick again: nothing more.
  await run(env, NOW + 60e3, d, { plays: [ml({ postedAt: NOW }), leanOf()] });
  assert.equal(d.calls.length, 2);
  // The lean settles: its own message is edited, and the results channel hears nothing of it.
  await run(env, NOW + 3600e3, d, { plays: [ml({ postedAt: NOW }), leanOf({ status: 'graded', result: 'win', profit: 0.2, actual: '6-0 6-3', gradedAt: NOW + 3600e3 })] });
  assert.deepEqual(d.calls.slice(2).map((c) => [c.method, c.url]), [['PATCH', `${LEANS}/messages/900000000000000002?with_components=true`]]);
  assert.equal(d.calls[2].body.content, '✅ **LEAN WON** · Veronika Erjavec to win the match · final 6-0 6-3');
  const status = await discordStatus(env);
  assert.deepEqual([status.leans, status.leansSecretRejected, status.lastError], [true, false, null]);
  assert.ok(!JSON.stringify(status).includes('323456789012345678') && !JSON.stringify(status).includes('yyyDEF'), 'the status never gives the address away');
  assert.deepEqual([(await discordStatus({ ...env, DISCORD_LIVE_LEAN_WEBHOOK: 'not a webhook' })).leans, (await discordStatus({ ...env, DISCORD_LIVE_LEAN_WEBHOOK: 'not a webhook' })).leansSecretRejected], [false, true]);

  // With no leans channel a lean goes nowhere: the plays' channel never carries one.
  const bare = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES });
  hello(bare.store);
  const d2 = fakeDiscord();
  assert.deepEqual(await run(bare.env, NOW, d2, { plays: [leanOf()] }), { posted: 0, edited: 0, failed: 0 });
  assert.equal(d2.calls.length, 0);
});

test('the leans test: a lean as it opens and one that has won, in the leans channel, marked as a test', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_LIVE_LEAN_WEBHOOK: LEANS, DISCORD_LIVE_ROLE_ID: ROLE });
  hello(store);
  const d = fakeDiscord();
  await run(env, NOW, d, { testId: 't-leans', testScope: 'leans' });
  assert.deepEqual(d.calls.map((c) => [c.method, c.url]), Array(2).fill(['POST', `${LEANS}?wait=true&with_components=true`]));
  assert.deepEqual(d.calls.map((c) => c.body.content), ['🧪 **TEST · not a real play**\n💡 **LEAN · Test Player to win the match** · −245 or better · 0.5u', '🧪 **TEST · not a real play**\n✅ **LEAN WON** · Test Player to win the match · final 6-0 6-3']);
  assert.ok(d.calls.every((c) => c.file && c.body.allowed_mentions.roles.length === 0));
  assert.deepEqual((await discordStatus(env)).test, { id: 't-leans', state: 'done', at: NOW, leans: 2, pictures: 2, buttons: true });
  await run(env, NOW + 60e3, d, { testId: 't-leans', testScope: 'leans' });
  assert.equal(d.calls.length, 2, 'once');
  assert.deepEqual(Object.keys(testLeans(NOW)), ['test-lean', 'test-lean-won']);
  assert.equal((await findLivePlay(env, 'test-lean', NOW)).lean, true);
  // No leans channel: nothing is sent and the status says why.
  const bare = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK });
  hello(bare.store);
  const d2 = fakeDiscord();
  await run(bare.env, NOW, d2, { testId: 't-leans', testScope: 'leans' });
  assert.equal(d2.calls.length, 0);
  assert.equal((await discordStatus(bare.env)).test.state, 'no leans channel');
});

test('the full template test: the four play cards in the live channel and the two lean cards in the leans channel, once', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_WEBHOOK: HOOK, DISCORD_UPDATES_WEBHOOK: UPDATES, DISCORD_LIVE_LEAN_WEBHOOK: LEANS, DISCORD_LIVE_ROLE_ID: ROLE });
  hello(store);
  const d = fakeDiscord();
  await run(env, NOW, d, { testId: 't-both', testScope: 'cards+leans' });
  assert.deepEqual(d.calls.map((c) => c.url.split('?')[0]), [HOOK, HOOK, HOOK, HOOK, LEANS, LEANS]);
  assert.ok(d.calls.every((c) => c.body.content.startsWith('🧪 **TEST · not a real play**') && c.file && c.body.allowed_mentions.roles.length === 0));
  assert.deepEqual((await discordStatus(env)).test, { id: 't-both', state: 'done', at: NOW, cards: 4, leans: 2, pictures: 6, buttons: true });
  await run(env, NOW + 60e3, d, { testId: 't-both', testScope: 'cards+leans' });
  assert.equal(d.calls.length, 6);
});
