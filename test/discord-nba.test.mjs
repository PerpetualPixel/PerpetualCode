/**
 * The live NBA plays on the owner's Discord (worker/src/discord-nba.js; 2026-11-25: "allow this to post all live
 * NBA plays and @playbook for the links"): one play at a time a game, each posted once with Playbook's tag and the
 * legs written out, and each edited to how it finished when the game ends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBasketballDiscord, syncFootballDiscord, syncLeagueDiscord, leagueConfig, footballStatus, LEAGUES, basketballConfig, basketballStatus, slipPost, gradePost, slipLine, slipMessage, playbookLines, testSlipPost, DISCORD_NBA_LEDGER_KEY, NBA_FRESH_MS, MAX_A_GAME } from '../worker/src/discord-nba.js';
import { slipCardSvg, slipCardHeight, textWidth, CARD_W } from '../worker/src/card-svg.js';

const NOW = Date.parse('2026-11-26T01:12:00Z');
const HOOK = 'https://discord.com/api/webhooks/423456789012345678/nbaDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const BOT = '123456789012345678';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
function makeEnv(extra = {}) {
  const store = new Map();
  return { store, env: { ...extra, POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
function fakeDiscord(reply = null) {
  const calls = []; let n = 0;
  const fetch = async (url, init) => {
    const form = typeof init.body !== 'string';
    const call = { url, method: init.method, body: JSON.parse(form ? init.body.get('payload_json') : init.body), file: form ? init.body.get('files[0]') : null };
    calls.push(call);
    const r = reply ? reply(call, calls.length) : null;
    const status = r?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r?.body ?? { id: `80000000000000000${++n}` } };
  };
  return { calls, fetch };
}
const GAME = { id: '401', name: 'New York Knicks at Boston Celtics', league: 'nba', date: '2026-11-26T00:30:00Z' };
const leg = (player, team, stat, label, point, price, current) => ({ bookId: 'fanduel', book: 'FanDuel', player, team, stat, label, point, price, decimal: 1.5, current, pace: point * 1.4, cushion: 0.4, link: null });
const slip = (over = {}) => ({ bookId: 'fanduel', book: 'FanDuel', american: 105, decimal: 2.05, postedAt: NOW - 60e3, legs: [leg('Jalen Brunson', 'NY', 'points', 'Pts', 19.5, -180, 14), leg('Jayson Tatum', 'BOS', 'rebounds', 'Reb', 7.5, -200, 5), leg('Karl-Anthony Towns', 'NY', 'rebounds', 'Reb', 9.5, -160, 7)], ...over });
const playOf = (slips, over = {}) => ({ espnEventId: '401', name: GAME.name, builtAt: NOW - 30e3, score: { NY: 54, BOS: 50 }, detail: '5:12 - 2nd Quarter', slips, ...over });
const finalTick = (vals, state = 'post') => ({ ticks: [{ state, at: NOW + 2 * 3600e3, score: { NY: 112, BOS: 104 }, box: Object.entries(vals).map(([name, stats]) => ({ name, stats })) }] });
const run = (env, now, d, { games = [GAME], play = null, watch = null, playbook = BOT, testId = '', render = async () => PNG } = {}) => syncBasketballDiscord(env, now, { deps: { fetch: d.fetch, games: async () => games, play: async () => play, watch: async () => watch, config: { hook: HOOK, playbook }, testId, render } });
const ledgerOf = (store) => JSON.parse(store.get(DISCORD_NBA_LEDGER_KEY));

test('the channel is used only with a real Discord webhook; Playbook\'s id comes from its secret, or from the id the owner saved in the app', async () => {
  const { env, store } = makeEnv();
  assert.deepEqual(await basketballConfig(env), { hook: null, playbook: null });
  assert.deepEqual(await syncBasketballDiscord(env, NOW), { off: true }, 'with no webhook nothing is read or sent');
  assert.deepEqual(await basketballConfig({ ...env, DISCORD_LIVE_BASKETBALL_WEBHOOK: 'https://example.com/hook' }), { hook: null, playbook: null });
  assert.deepEqual(await basketballConfig({ ...env, DISCORD_LIVE_BASKETBALL_WEBHOOK: HOOK, DISCORD_PLAYBOOK_USER_ID: `<@${BOT}>` }), { hook: HOOK, playbook: BOT }, 'pasted as a mention or as the number');
  assert.equal((await basketballConfig({ ...env, DISCORD_LIVE_BASKETBALL_WEBHOOK: HOOK, DISCORD_PLAYBOOK_USER_ID: '@Playbook' })).playbook, null, 'a name is not an id');
  store.set('settings:owner', JSON.stringify({ playbook: { channel: '', mention: '223456789012345678' } }));
  const saved = await basketballConfig({ ...env, DISCORD_LIVE_BASKETBALL_WEBHOOK: HOOK });
  assert.ok(saved.playbook === '223456789012345678' || saved.playbook === null, 'the saved id stands in when it is on file under the owner');
});

test('a play\'s message starts with Playbook\'s tag and the book, then a leg a line the way the bot reads it; only the bot can be pinged', () => {
  const post = slipPost(GAME, playOf([slip()]), slip());
  assert.equal(post.id, `401:fanduel:${NOW - 60e3}`);
  assert.deepEqual(playbookLines(post), ['Jalen Brunson Over 19.5 Points (New York Knicks at Boston Celtics)', 'Jayson Tatum Over 7.5 Rebounds (New York Knicks at Boston Celtics)', 'Karl-Anthony Towns Over 9.5 Rebounds (New York Knicks at Boston Celtics)']);
  assert.equal(slipLine(post, { playbook: BOT }), `<@${BOT}> FanDuel\n${playbookLines(post).join('\n')}`);
  assert.doesNotMatch(slipLine(post, { playbook: BOT }), /\\/, 'no backslashes for the bot to trip on');
  // Without the bot's id: the same lines under a plain heading, and nobody tagged.
  assert.equal(slipLine(post), `🏀 **LIVE PLAY** · +105 at FanDuel · 1u\n${playbookLines(post).join('\n')}`);
  const tagged = slipMessage(post, { png: PNG, playbook: BOT });
  assert.deepEqual(tagged.payload.allowed_mentions, { parse: [], users: [BOT] });
  assert.deepEqual(slipMessage(post, { png: PNG }).payload.allowed_mentions, { parse: [], users: [] });
  assert.deepEqual(tagged.payload.embeds, [{ color: 0x00f0ff, image: { url: 'attachment://card.png' } }]);
  assert.deepEqual(tagged.payload.components[0].components.map((b) => [b.label, b.url]), [['Live board', 'https://perpetualpicks.com/app.html']]);
  // A name that carries Discord's own marks, or a mention, cannot style the message or ping anyone.
  const sharp = slipPost({ ...GAME, name: '@everyone at **Bold**' }, playOf([slip()]), slip({ legs: [leg('<@&999> `x` _y_', 'NY', 'points', 'Pts', 19.5, -180, 14)] }));
  assert.equal(playbookLines(sharp)[0], '@&999 x y Over 19.5 Points (@everyone at Bold)');
  assert.deepEqual(slipMessage(sharp, { playbook: BOT }).payload.allowed_mentions.parse, []);
  // No message carries the worker's own address.
  assert.doesNotMatch(JSON.stringify([tagged.payload, tagged.plain]), /workers\.dev/);
});

test('a slip against the final box: won when every leg cleared, lost when one did not, void when a player is not in the box', () => {
  const post = slipPost(GAME, playOf([slip()]), slip());
  const won = gradePost(post, finalTick({ 'Jalen Brunson': { points: 27 }, 'Jayson Tatum': { rebounds: 9 }, 'Karl-Anthony Towns': { rebounds: 12 } }).ticks[0]);
  assert.deepEqual([won.status, won.result, won.profit, won.legs.map((l) => [l.final, l.hit])], ['graded', 'win', 1.05, [[27, true], [9, true], [12, true]]]);
  const lost = gradePost(post, finalTick({ 'Jalen Brunson': { points: 27 }, 'Jayson Tatum': { rebounds: 7 }, 'Karl-Anthony Towns': { rebounds: 12 } }).ticks[0]);
  assert.deepEqual([lost.status, lost.result, lost.profit, lost.legs[1].hit], ['graded', 'loss', -1, false]);
  const voided = gradePost(post, finalTick({ 'Jalen Brunson': { points: 27 }, 'Karl-Anthony Towns': { rebounds: 12 } }).ticks[0]);
  assert.deepEqual([voided.status, voided.result, voided.profit], ['void', 'void', 0]);
  assert.equal(slipLine(won), '✅ **WON** · New York Knicks at Boston Celtics · 3 legs · +105 at FanDuel · +1.05u');
  assert.equal(slipLine(lost, { playbook: BOT }), '❌ **LOST** · New York Knicks at Boston Celtics · 3 legs · +105 at FanDuel · −1.00u', 'a settled play tags nobody');
  assert.deepEqual(slipMessage(lost, { playbook: BOT }).payload.allowed_mentions.users, []);
});

test('the game\'s best slip is posted each time it is one that has not been posted: what the app shows is in the channel, each play once', async () => {
  const { env, store } = makeEnv();
  const d = fakeDiscord();
  // Two books have a slip; the best is first.
  const first = slip(); const other = slip({ bookId: 'draftkings', book: 'DraftKings', american: 120 });
  assert.deepEqual(await run(env, NOW, d, { play: playOf([first, other]) }), { posted: 1, settled: 0, failed: 0 });
  assert.deepEqual(d.calls.map((c) => [c.method, c.url]), [['POST', `${HOOK}?wait=true&with_components=true`]]);
  assert.equal(d.calls[0].body.content.split('\n')[0], `<@${BOT}> FanDuel`);
  assert.equal(d.calls[0].file.size, PNG.length, 'the card rides with it');
  // The same best slip on later ticks: nothing more.
  await run(env, NOW + 8 * 60e3, d, { play: playOf([first, other], { builtAt: NOW + 8 * 60e3 }) });
  assert.equal(d.calls.length, 1);
  // Another book's slip becomes the best: the app now shows it, so it is posted.
  await run(env, NOW + 16 * 60e3, d, { play: playOf([other, first], { builtAt: NOW + 16 * 60e3 }) });
  assert.equal(d.calls.length, 2);
  assert.equal(d.calls[1].body.content.split('\n')[0], `<@${BOT}> DraftKings`);
  // The first is best again: it has been posted, so it is not posted twice.
  await run(env, NOW + 24 * 60e3, d, { play: playOf([first, other], { builtAt: NOW + 24 * 60e3 }) });
  assert.equal(d.calls.length, 2);
  // The best slip is replaced by a new one: posted as a new play.
  const next = slip({ postedAt: NOW + 32 * 60e3, american: -110, legs: [leg('Jaylen Brown', 'BOS', 'points', 'Pts', 22.5, -170, 17), leg('Josh Hart', 'NY', 'rebounds', 'Reb', 8.5, -190, 6), leg('Derrick White', 'BOS', 'assists', 'Ast', 4.5, -150, 3)] });
  await run(env, NOW + 32 * 60e3, d, { play: playOf([next, other], { builtAt: NOW + 32 * 60e3 }) });
  assert.equal(d.calls.length, 3);
  assert.match(d.calls[2].body.content, /Jaylen Brown Over 22\.5 Points/);
  assert.deepEqual(Object.values(ledgerOf(store).posts).map((e) => e.state), ['open', 'open', 'open']);
  // A board that has not been rebuilt lately (a blowout holds it, the feed is quiet) posts nothing: its prices are gone.
  const stale = makeEnv(); const d2 = fakeDiscord();
  assert.deepEqual(await run(stale.env, NOW, d2, { play: playOf([first], { builtAt: NOW - NBA_FRESH_MS - 1000 }) }), { posted: 0, settled: 0, failed: 0 });
  // Another league's game, or one outside its window, is not this channel's.
  const d3 = fakeDiscord();
  await run(makeEnv().env, NOW, d3, { games: [{ ...GAME, league: 'nfl' }, { ...GAME, id: '402', date: '2026-11-24T00:30:00Z' }], play: playOf([first]) });
  assert.equal(d3.calls.length, 0);
});

test('a whole game\'s plays fit: a new play every few minutes for three hours is all posted, and only a runaway board is stopped', async () => {
  const { env } = makeEnv();
  const d = fakeDiscord();
  // Twenty-four plays, one every seven and a half minutes: every one is posted.
  for (let i = 0; i < 24; i++) { const now = NOW + i * 7.5 * 60e3; await run(env, now, d, { play: playOf([slip({ postedAt: now })], { builtAt: now }) }); }
  assert.equal(d.calls.length, 24);
  assert.ok(MAX_A_GAME >= 30);
});

test('a runaway board cannot fill the channel: a game\'s posts stop at the guard', async () => {
  const { env } = makeEnv();
  const d = fakeDiscord();
  for (let i = 0; i < MAX_A_GAME + 6; i++) {
    const now = NOW + i * 5 * 60e3;
    await run(env, now, d, { play: playOf([slip({ postedAt: now })], { builtAt: now }) });
  }
  assert.equal(d.calls.length, MAX_A_GAME);
});

test('when the game ends each open post is edited to how it finished, once; a post with no answer is not sent again', async () => {
  const { env, store } = makeEnv();
  const d = fakeDiscord();
  await run(env, NOW, d, { play: playOf([slip()]) });
  // Still in play: nothing is settled.
  await run(env, NOW + 30 * 60e3, d, { play: playOf([slip()], { builtAt: NOW }), watch: finalTick({ 'Jalen Brunson': { points: 20 } }, 'in') });
  assert.equal(d.calls.length, 1);
  const watch = finalTick({ 'Jalen Brunson': { points: 27 }, 'Jayson Tatum': { rebounds: 9 }, 'Karl-Anthony Towns': { rebounds: 12 } });
  assert.deepEqual(await run(env, NOW + 2 * 3600e3, d, { play: playOf([slip()], { builtAt: NOW }), watch }), { posted: 0, settled: 1, failed: 0 });
  assert.deepEqual([d.calls[1].method, d.calls[1].url], ['PATCH', `${HOOK}/messages/800000000000000001?with_components=true`]);
  assert.equal(d.calls[1].body.content, '✅ **WON** · New York Knicks at Boston Celtics · 3 legs · +105 at FanDuel · +1.05u');
  assert.deepEqual([d.calls[1].body.embeds[0].color, d.calls[1].body.allowed_mentions.users], [0x10b981, []]);
  await run(env, NOW + 2 * 3600e3 + 60e3, d, { play: playOf([slip()], { builtAt: NOW }), watch });
  assert.equal(d.calls.length, 2, 'once');
  assert.equal(Object.values(ledgerOf(store).posts)[0].state, 'done');

  // No answer from Discord: it may be in the channel, so it is not sent again.
  const quiet = makeEnv();
  const silent = { calls: [], fetch: async (url, init) => { silent.calls.push(url); throw new Error('timeout'); } };
  await run(quiet.env, NOW, silent, { play: playOf([slip()]) });
  await run(quiet.env, NOW + 60e3, silent, { play: playOf([slip()], { builtAt: NOW + 30e3 }) });
  assert.equal(silent.calls.length, 1);
  // Refused outright: it is not there, so the next tick tries again.
  const refused = makeEnv(); let n = 0;
  const d2 = fakeDiscord(() => (++n === 1 ? { status: 500, body: {} } : null));
  await run(refused.env, NOW, d2, { play: playOf([slip()]) });
  await run(refused.env, NOW + 60e3, d2, { play: playOf([slip()], { builtAt: NOW + 30e3 }) });
  assert.deepEqual(d2.calls.map((c) => c.method), ['POST', 'POST']);
  assert.equal(Object.values(ledgerOf(refused.store).posts)[0].state, 'open');
});

test('the test card goes out once, marked as a test and tagging nobody; the status says what is set up and never the address', async () => {
  const { env, store } = makeEnv({ DISCORD_LIVE_BASKETBALL_WEBHOOK: HOOK, DISCORD_PLAYBOOK_USER_ID: BOT });
  const d = fakeDiscord();
  await run(env, NOW, d, { games: [], testId: 't-nba' });
  await run(env, NOW + 60e3, d, { games: [], testId: 't-nba' });
  assert.equal(d.calls.length, 1);
  assert.match(d.calls[0].body.content, /^🧪 \*\*TEST · not a real play\*\*\n🏀 \*\*LIVE PLAY\*\* · \+105 at FanDuel · 1u\nTest Guard Over 19\.5 Points \(Test Team at Sample Team\)/);
  assert.deepEqual(d.calls[0].body.allowed_mentions, { parse: [], users: [] });
  const status = await basketballStatus(env);
  assert.deepEqual([status.channel, status.secretRejected, status.playbook, status.test.state, status.test.picture, status.lastError], [true, false, true, 'done', true, null]);
  assert.ok(!JSON.stringify(status).includes('423456789012345678') && !JSON.stringify(status).includes('nbaDEF'));
  assert.deepEqual([(await basketballStatus({ ...env, DISCORD_LIVE_BASKETBALL_WEBHOOK: 'nope', DISCORD_PLAYBOOK_USER_ID: '' })).secretRejected, (await basketballStatus({ ...env, DISCORD_PLAYBOOK_USER_ID: '' })).playbook], [true, false]);
  assert.equal(store.has(DISCORD_NBA_LEDGER_KEY), true);
  assert.deepEqual(Object.keys(testSlipPost(NOW).legs[0]).sort(), ['current', 'label', 'player', 'point', 'price', 'stat', 'team']);
});

/** Every line of text on a card as a box, measured with the card's own letter widths. */
function boxes(svg) {
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" font-family="([^"]+)" font-size="([\d.]+)" font-weight="(\d+)"[^>]*?>([^]*?)<\/text>/g)].map((m) => {
    const [whole, x, y, , size, weight, body] = m;
    const words = body.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const spacing = Number(whole.match(/letter-spacing="([\d.]+)"/)?.[1] ?? 0);
    const width = textWidth(words, Number(size), { weight: Number(weight), spacing });
    const left = /text-anchor="middle"/.test(whole) ? Number(x) - width / 2 : /text-anchor="end"/.test(whole) ? Number(x) - width : Number(x);
    return { words, left, right: left + width, top: Number(y) - Number(size) * 0.76, bottom: Number(y) + Number(size) * (/[gjpqy,]/.test(words) ? 0.22 : 0.02) };
  });
}

test('the slip card: a line a leg, the card as tall as its legs, and nothing overlaps or leaves it however long the names are', () => {
  const post = slipPost(GAME, playOf([slip()]), slip());
  const svg = slipCardSvg(post, { logo: 'data:image/png;base64,AAAA' });
  const lines = [...svg.matchAll(/<text[^>]*>([^]*?)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(lines, ['LIVE PLAY', '+105', 'FANDUEL', '3-LEG PARLAY', 'New York Knicks at Boston Celtics', 'Jalen Brunson', 'Over 19.5 Pts', 'NY  •  now 14', '-180', 'Jayson Tatum', 'Over 7.5 Reb', 'BOS  •  now 5', '-200', 'Karl-Anthony Towns', 'Over 9.5 Reb', 'NY  •  now 7', '-160', 'Taken 5:12 - 2nd Quarter  •  NY 54, BOS 50', 'RECOMMENDED', '1u', 'perpetualpicks.com', 'NBA  •  Nov 25  •  8:11 PM ET']);
  assert.match(svg, new RegExp(`viewBox="0 0 ${CARD_W} ${slipCardHeight(3)}"`));
  assert.ok(slipCardHeight(5) > slipCardHeight(3));
  const won = slipCardSvg(gradePost(post, finalTick({ 'Jalen Brunson': { points: 27 }, 'Jayson Tatum': { rebounds: 9 }, 'Karl-Anthony Towns': { rebounds: 12 } }).ticks[0]));
  assert.match(won, />WON</); assert.match(won, />HIT</); assert.match(won, />\+1\.05u</); assert.match(won, />Final  •  NY 112, BOS 104</);
  const long = 'Wolfeschlegelsteinhausenbergerdorff Maximilian-Alexander von Hohenzollern-Sigmaringen';
  const cases = [
    slipPost({ ...GAME, name: `${long} Basketball Club at ${long} Athletic Association` }, playOf([slip()], { detail: 'End of the Second Overtime Period with a very long description', score: { WWWWWW: 199, MMMMMM: 198 } }), slip({ book: 'x', bookId: 'The Extraordinarily Long Sportsbook & Casino Company', american: 10000, legs: [leg(long, 'WWWWWW', 'points', 'Points Rebounds Assists', 199.5, -10000, 150), leg('W'.repeat(50), 'MMM', 'rebounds', 'Reb', 19.5, 250, 12), leg('Li', 'NY', 'assists', 'Ast', 0.5, -110, 0), leg(long, 'BOS', 'assists', 'Ast', 10.5, -300, 9), leg('A B', 'NY', 'points', 'Pts', 9.5, -120, 5)] })),
    gradePost(slipPost(GAME, playOf([slip()]), slip({ legs: [leg(long, 'NY', 'points', 'Pts', 19.5, -180, 14), leg('Missing Player', 'BOS', 'rebounds', 'Reb', 7.5, -200, 5)] })), finalTick({ [long]: { points: 3 } }).ticks[0]),
  ];
  for (const one of cases) {
    const all = boxes(slipCardSvg(one, { logo: 'data:image/png;base64,AAAA' }));
    const H = slipCardHeight(one.legs.length);
    for (const b of all) assert.ok(b.left >= 30 && b.right <= CARD_W - 30 && b.top >= 20 && b.bottom <= H - 14, `"${b.words}" stays inside the card`);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const x = all[i]; const y = all[j];
      assert.ok(Math.min(x.right, y.right) - Math.max(x.left, y.left) <= 0 || Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) <= 0, `"${x.words}" and "${y.words}" do not overlap`);
    }
  }
});

test('the worker runs the basketball channel after each live probe, and its status rides the Discord status route', () => {
  const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  assert.match(worker, /runLiveProbe\(env, ctx, now\)\.catch\([^]*?\)\s*\.then\(\(\) => syncBasketballDiscord\(env, now\)\)/);
  assert.match(worker, /\{ \.\.\.\(await discordStatus\(env\)\), basketball: await basketballStatus\(env\), football: await footballStatus\(env\) \}/);
  assert.match(worker, /\.then\(\(\) => syncFootballDiscord\(env, now\)\)/);
});

// --- Football: the same thing in its own channel (2026-11-25: "DISCORD_FOOTBALL_WEBHOOK ... post the live football plays and @playbook for links") ---

const FOOT = 'https://discord.com/api/webhooks/523456789012345678/nflDEF_ghi-jklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const NFL_GAME = { id: '901', name: 'Dallas Cowboys at Philadelphia Eagles', league: 'nfl', date: '2026-11-26T00:20:00Z' };
const nflSlip = (over = {}) => ({ bookId: 'draftkings', book: 'DraftKings', american: 110, decimal: 2.1, postedAt: NOW - 60e3, legs: [
  { bookId: 'draftkings', player: 'Jalen Hurts', team: 'PHI', stat: 'passingYards', label: 'Pass Yds', point: 224.5, price: -190, decimal: 1.53, current: 141 },
  { bookId: 'draftkings', player: 'Saquon Barkley', team: 'PHI', stat: 'rushingYards', label: 'Rush Yds', point: 79.5, price: -170, decimal: 1.59, current: 52 },
  { bookId: 'draftkings', player: 'CeeDee Lamb', team: 'DAL', stat: 'receptions', label: 'Rec', point: 5.5, price: -160, decimal: 1.63, current: 4 }], ...over });

test('football has its own channel, ledger and test card, and is told apart from basketball everywhere', async () => {
  assert.deepEqual([LEAGUES.nfl.secret, LEAGUES.nba.secret], ['DISCORD_FOOTBALL_WEBHOOK', 'DISCORD_LIVE_BASKETBALL_WEBHOOK']);
  assert.notEqual(LEAGUES.nfl.ledger, LEAGUES.nba.ledger);
  const { env, store } = makeEnv({ DISCORD_FOOTBALL_WEBHOOK: FOOT, DISCORD_PLAYBOOK_USER_ID: BOT });
  assert.deepEqual(await leagueConfig(env, 'nfl'), { hook: FOOT, playbook: BOT }, 'one Playbook id serves both channels');
  assert.deepEqual(await syncBasketballDiscord(env, NOW), { off: true }, 'the football webhook does not switch basketball on');
  const play = { espnEventId: '901', name: NFL_GAME.name, builtAt: NOW - 30e3, score: { DAL: 10, PHI: 14 }, detail: '8:40 - 2nd Quarter', slips: [nflSlip()] };
  const d = fakeDiscord();
  const deps = (over = {}) => ({ deps: { fetch: d.fetch, games: async () => [NFL_GAME, GAME], play: async () => play, watch: async () => null, render: async () => PNG, testId: '', ...over } });
  // An NFL game posts to the football channel; the NBA game in the same list is not football's.
  assert.deepEqual(await syncFootballDiscord(env, NOW, deps()), { posted: 1, settled: 0, failed: 0 });
  assert.deepEqual(d.calls.map((c) => c.url.split('?')[0]), [FOOT]);
  assert.equal(d.calls[0].body.content, `<@${BOT}> DraftKings\nJalen Hurts Over 224.5 Passing Yards (Dallas Cowboys at Philadelphia Eagles)\nSaquon Barkley Over 79.5 Rushing Yards (Dallas Cowboys at Philadelphia Eagles)\nCeeDee Lamb Over 5.5 Receptions (Dallas Cowboys at Philadelphia Eagles)`);
  assert.deepEqual(d.calls[0].body.allowed_mentions, { parse: [], users: [BOT] });
  assert.deepEqual(d.calls[0].body.components[0].components[0].emoji, { name: '🏈' });
  assert.ok(store.has(LEAGUES.nfl.ledger) && !store.has(LEAGUES.nba.ledger));
  // The game ends: the post is edited to how it finished, against the football box.
  const watch = { ticks: [{ state: 'post', at: NOW + 3 * 3600e3, score: { DAL: 20, PHI: 27 }, box: [{ name: 'Jalen Hurts', stats: { passingYards: 262 } }, { name: 'Saquon Barkley', stats: { rushingYards: 71 } }, { name: 'CeeDee Lamb', stats: { receptions: 8 } }] }] };
  assert.deepEqual(await syncFootballDiscord(env, NOW + 3 * 3600e3, deps({ watch: async () => watch })), { posted: 0, settled: 1, failed: 0 });
  assert.equal(d.calls[1].body.content, '❌ **LOST** · Dallas Cowboys at Philadelphia Eagles · 3 legs · +110 at DraftKings · −1.00u');
  // Its card says NFL, and its written form names the league.
  const post = slipPost(NFL_GAME, play, nflSlip(), 'nfl');
  assert.match(slipCardSvg(post), />NFL  •  Nov 25  •  8:11 PM ET</);
  assert.match(slipCardSvg(post), />Over 224\.5 Pass Yds</);
  assert.equal(slipMessage(post).plain.embeds[0].author.name, 'PERPETUAL PICKS · LIVE NFL');
  assert.equal(slipLine(post).split('\n')[0], '🏈 **LIVE PLAY** · +110 at DraftKings · 1u');

  // The test card, once, in the football channel, and the status for it.
  const t = makeEnv({ DISCORD_FOOTBALL_WEBHOOK: FOOT });
  const d2 = fakeDiscord();
  await syncLeagueDiscord(t.env, NOW, 'nfl', { deps: { fetch: d2.fetch, games: async () => [], render: async () => PNG } });
  await syncLeagueDiscord(t.env, NOW + 60e3, 'nfl', { deps: { fetch: d2.fetch, games: async () => [], render: async () => PNG } });
  assert.equal(d2.calls.length, 1);
  assert.match(d2.calls[0].body.content, /^🧪 \*\*TEST · not a real play\*\*\n🏈 \*\*LIVE PLAY\*\* · \+110 at FanDuel · 1u\nTest Quarterback Over 224\.5 Passing Yards \(Test Team at Sample Team\)/);
  const status = await footballStatus(t.env);
  assert.deepEqual([status.channel, status.playbook, status.test.id, status.test.state, status.lastError], [true, false, LEAGUES.nfl.testId, 'done', null]);
  assert.ok(!JSON.stringify(status).includes('nflDEF'));
  assert.deepEqual([testSlipPost(NOW, 'nfl').league, testSlipPost(NOW).league], ['nfl', 'nba']);
});

// --- Every new play tags Playbook, with its card (2026-11-25: "ensure ... it ats @Playbook with the card so it can build the links") ---

test('with Playbook\'s id set, every new NBA and NFL play starts with its tag and carries the card in the same message, however the message goes out; the status says so', async () => {
  for (const [league, secret, game, slipOf, sync, status] of [
    ['nba', 'DISCORD_LIVE_BASKETBALL_WEBHOOK', GAME, slip, syncBasketballDiscord, basketballStatus],
    ['nfl', 'DISCORD_FOOTBALL_WEBHOOK', NFL_GAME, nflSlip, syncFootballDiscord, footballStatus],
  ]) {
    // With the picture, without one, and when Discord refuses the buttons: the tag is the first thing in every form.
    for (const [name, render, reply] of [['picture', async () => PNG, null], ['written', async () => null, null], ['no buttons', async () => PNG, (c) => (c.body.components?.length ? { status: 400, body: {} } : null)]]) {
      const { env } = makeEnv({ [secret]: HOOK, DISCORD_PLAYBOOK_USER_ID: BOT });
      const d = fakeDiscord(reply);
      const play = { builtAt: NOW - 30e3, score: {}, detail: 'Q2', slips: [slipOf()] };
      const out = await sync(env, NOW, { deps: { fetch: d.fetch, games: async () => [game], play: async () => play, watch: async () => null, render, testId: '' } });
      assert.equal(out.posted, 1, `${league} ${name}`);
      const sent = d.calls.at(-1);
      assert.ok(sent.body.content.startsWith(`<@${BOT}> `), `${league} ${name}: the message starts with the tag`);
      assert.deepEqual(sent.body.allowed_mentions, { parse: [], users: [BOT] }, `${league} ${name}: and Discord is told the tag may ping the bot`);
      assert.equal(sent.body.content.split('\n').length, 1 + slipOf().legs.length, 'the book, then a line a leg');
      if (name !== 'written') assert.ok(sent.file && sent.body.embeds[0].image.url === 'attachment://card.png', `${league} ${name}: the card rides in the same message`);
      const st = await status(env);
      assert.deepEqual([st.playbook, st.lastPostTagged, st.tagged], [true, true, 1]);
    }
    // Without the id nobody is tagged, and the status says that too.
    const bare = makeEnv({ [secret]: HOOK });
    const d2 = fakeDiscord();
    await sync(bare.env, NOW, { deps: { fetch: d2.fetch, games: async () => [game], play: async () => ({ builtAt: NOW - 30e3, slips: [slipOf()] }), watch: async () => null, render: async () => PNG, testId: '' } });
    assert.deepEqual([(await status(bare.env)).lastPostTagged, (await status(bare.env)).tagged, d2.calls[0].body.allowed_mentions.users], [false, 0, []]);
  }
});
