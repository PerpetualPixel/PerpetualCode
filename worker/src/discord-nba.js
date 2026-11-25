/**
 * The live NBA plays on the owner's Discord (2026-11-25: "I created another channel called lives and a webhook
 * DISCORD_LIVE_BASKETBALL_WEBHOOK ... allow this to post all live NBA plays and @playbook for the links").
 *
 * What a live NBA play is: worker/src/live-probe.js rebuilds each game's slips every few minutes while it is in
 * play (worker/src/live-board.js: three to five player overs at a book, nearest +100), and a slip stands until one
 * of its lines leaves the board, when a new one takes its place.
 *
 * What is posted: one play at a time a game. The game's best slip goes up when it is first built; when the slip
 * being followed is replaced, the game's best slip then goes up as a new post. So every play the board makes for a
 * game is posted, each once, and never the same legs at five books at the same minute. A game is capped
 * (MAX_A_GAME) so a jumpy board cannot fill the channel.
 *
 * Playbook (docs/playbook.js) is the Discord bot that turns a written bet into a slip link at any book. It has no
 * API: it reads a message that tags it, with the book named and the legs written out, and replies in the channel.
 * So each new play's message starts with that tag and those lines. A pasted "@Playbook" pings nothing: the tag is
 * a real mention only when the bot's user id is known (the DISCORD_PLAYBOOK_USER_ID secret, or the id the owner
 * saved in the app's Playbook settings). Whether the bot answers a message posted by a webhook is the bot's own
 * rule and is not known here.
 *
 * When the game ends, each post's message is edited to how it finished: every leg against the final box score,
 * won or lost, and the units at one unit a play.
 *
 * The webhook address is a credential (see worker/src/discord.js): only in the worker's secrets, never logged,
 * never returned by a route.
 */
import { deliver, readJson, markTest, webhookOf } from './discord.js';
import { readWatchIndex, liveWatchKey } from './live-probe.js';
import { livePlayKey, boxValue } from './live-board.js';
import { SPORTSBOOKS } from '../../docs/engine.js';
import { PLAYBOOK_BOOK_NAMES } from '../../docs/playbook.js';
import { getSettings } from './settings.js';

export const DISCORD_NBA_LEDGER_KEY = 'discord:nba:ledger';
/** A slip is posted only while the board that made it is this fresh: an older build's prices are gone. */
export const NBA_FRESH_MS = 12 * 60e3;
/** The most plays posted for one game. */
export const MAX_A_GAME = 6;
const POST_TRIES = 3;
const LEDGER_KEEP_MS = 4 * 86400e3;
const LEDGER_TTL = 14 * 86400;
const GAME_WINDOW_MS = [10 * 3600e3, 3600e3]; // a game from an hour before its start until ten hours after
const BOARD = 'https://perpetualpicks.com/app.html';
const LOGO = 'https://perpetualpicks.com/assets/logo-icon-180.png';
const COLOR = { open: 0x00f0ff, win: 0x10b981, loss: 0xef4444, void: 0x9c98b8 };
/** A stat as Playbook reads it. */
const STAT_WORDS = { points: 'Points', rebounds: 'Rebounds', assists: 'Assists' };

/**
 * One test card, sent once per value: the channel is new, and a card in it shows the setup works without waiting
 * for a game. It is marked as a test and tags nobody (a made-up slip would only confuse the bot).
 */
export const NBA_TEST_ID = '2026-11-25-nba-1';

const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const md = (s) => String(s ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1').slice(0, 200);
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const userIdOf = (v) => String(v ?? '').trim().match(/^(?:<@!?)?(\d{15,22})>?$/)?.[1] ?? null;

/** What is configured: the channel's webhook (null when unset or not a Discord webhook) and Playbook's user id. */
export async function basketballConfig(env) {
  const hook = webhookOf(env?.DISCORD_LIVE_BASKETBALL_WEBHOOK);
  let playbook = userIdOf(env?.DISCORD_PLAYBOOK_USER_ID);
  // The id the owner saved in the app's Playbook settings stands in when the secret is not set.
  if (hook && !playbook) playbook = userIdOf((await getSettings(env, 'owner').catch(() => null))?.playbook?.mention);
  return { hook, playbook };
}

/** A slip as it is kept and drawn: the game, the book and price, and each leg with where the player stood. */
export function slipPost(game, play, slip) {
  return {
    id: `${game.id}:${slip.bookId}:${slip.postedAt ?? play.builtAt}`,
    gameId: String(game.id), game: game.name ?? '', league: 'nba',
    bookId: slip.bookId, book: SPORTSBOOKS[slip.bookId]?.name ?? slip.book ?? slip.bookId,
    american: slip.american, decimal: slip.decimal, units: 1,
    postedAt: slip.postedAt ?? play.builtAt, score: play.score ?? null, detail: play.detail ?? null,
    legs: (slip.legs ?? []).map((l) => ({ player: l.player, team: l.team ?? null, stat: l.stat, label: l.label ?? l.stat, point: l.point, price: l.price, current: l.current ?? null })),
    status: 'pending', result: null, profit: null,
  };
}

/**
 * A posted slip against the game's final box score: each leg's final number and whether it cleared. Won when
 * every leg cleared, lost when any did not; void when no leg missed but a player is not in the box at all.
 */
export function gradePost(post, tick) {
  const box = new Map((tick?.box ?? []).map((p) => [String(p.name ?? '').toLowerCase(), p]));
  const legs = post.legs.map((l) => { const p = box.get(String(l.player).toLowerCase()); const final = p ? num(boxValue(p, l.stat)) : null; return { ...l, final, hit: final == null ? null : final >= l.point }; });
  const result = legs.some((l) => l.hit === false) ? 'loss' : legs.every((l) => l.hit === true) ? 'win' : 'void';
  const decimal = Number(post.decimal) || (post.american > 0 ? 1 + post.american / 100 : 1 + 100 / -post.american);
  return { ...post, legs, status: result === 'void' ? 'void' : 'graded', result, profit: result === 'win' ? Math.round((decimal - 1) * 100) / 100 : result === 'loss' ? -1 : 0, finalScore: tick?.score ?? null, gradedAt: tick?.at ?? null };
}

/** A name as it is written into a line the bot reads: nothing that Discord would style, and no backslashes put in to stop it. */
const bare = (s) => String(s ?? '').replace(/[\\*_~`|<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
/** The legs as Playbook reads them: the player, Over and the number, the stat in full, and the game in brackets. */
export const playbookLines = (post) => post.legs.map((l) => `${bare(l.player)} Over ${l.point} ${STAT_WORDS[l.stat] ?? bare(l.label)} (${bare(post.game)})`);

/**
 * The words of the message. A new play starts with Playbook's tag and the book, then a leg a line: that is the form
 * the bot reads. Without the bot's id the same lines stand under a plain heading. A settled play says how it ended.
 */
export function slipLine(post, { playbook = null } = {}) {
  const price = `${fmt(post.american)} at ${md(post.book)}`;
  if (post.status === 'void') return `⚪ **VOID** · ${md(post.game)} · ${post.legs.length} legs · stake returned`;
  if (post.status === 'graded') return `${post.result === 'win' ? '✅ **WON**' : '❌ **LOST**'} · ${md(post.game)} · ${post.legs.length} legs · ${price} · ${signedUnits(post.profit ?? 0)}`;
  const head = playbook ? `<@${playbook}> ${PLAYBOOK_BOOK_NAMES[post.bookId] ?? post.book}` : `🏀 **LIVE PLAY** · ${price} · 1u`;
  return [head, ...playbookLines(post)].join('\n').slice(0, 1900);
}

/** The written card, for when there is no picture: the same play in words. */
function slipWritten(post) {
  const outcome = post.status === 'void' ? 'void' : post.status === 'graded' ? (post.result === 'win' ? 'win' : 'loss') : 'open';
  const mark = { open: '🏀 LIVE PLAY ·', win: '✅ WON ·', loss: '❌ LOST ·', void: '⚪ VOID ·' }[outcome];
  const legs = post.legs.map((l) => `• **${md(l.player)}** Over ${l.point} ${md(l.label)}${outcome === 'open' ? (l.current != null ? ` · now ${l.current}` : '') : l.final != null ? ` · final ${l.final} ${l.hit ? '✓' : '✗'}` : ''}`);
  const points = Object.entries((outcome === 'open' ? post.score : post.finalScore ?? post.score) ?? {}).map(([t, n]) => `${md(t)} ${n}`).join(', ');
  return {
    title: `${mark} ${post.legs.length} legs · ${fmt(post.american)} at ${md(post.book)}`.slice(0, 250),
    url: BOARD,
    author: { name: 'PERPETUAL PICKS · LIVE NBA', url: BOARD, icon_url: LOGO },
    description: [`${md(post.game)}${points ? ` · ${points}` : ''}`, ...legs, outcome === 'open' ? 'Recommended **1u**' : outcome === 'void' ? '**Stake returned**' : `**${signedUnits(post.profit ?? 0)}**`].join('\n').slice(0, 3900),
    color: COLOR[outcome],
    footer: { text: 'Live play · perpetualpicks.com', icon_url: LOGO },
    timestamp: new Date(post.postedAt ?? Date.now()).toISOString(),
  };
}

/** A slip as it goes to Discord: {payload, file, plain}, the shape worker/src/discord.js's deliver sends. */
export function slipMessage(post, { png = null, playbook = null, buttons = true } = {}) {
  const outcome = post.status === 'void' ? 'void' : post.status === 'graded' ? (post.result === 'win' ? 'win' : 'loss') : 'open';
  const content = slipLine(post, { playbook });
  // Only the bot can be tagged, and only on a new play: nothing else in the words can ping anyone.
  const allowed_mentions = { parse: [], users: playbook && outcome === 'open' ? [playbook] : [] };
  const components = [{ type: 1, components: [{ type: 2, style: 5, url: BOARD, label: 'Live board', emoji: { name: '🏀' } }] }];
  const plain = { content, allowed_mentions, embeds: [slipWritten(post)] };
  if (!png) return { payload: buttons ? { ...plain, components } : plain, file: null, plain };
  return { payload: { content, allowed_mentions, embeds: [{ color: COLOR[outcome], image: { url: 'attachment://card.png' } }], attachments: [{ id: 0, filename: 'card.png' }], ...(buttons ? { components } : {}) }, file: { name: 'card.png', bytes: png }, plain };
}

/** The test slip: made-up players, in the shape of a real one. */
export function testSlipPost(now = Date.now()) {
  return {
    id: 'test-nba', gameId: 'test', game: 'Test Team at Sample Team', league: 'nba', bookId: 'fanduel', book: 'FanDuel', american: 105, decimal: 2.05, units: 1, postedAt: now,
    score: { TST: 54, SMP: 50 }, detail: '5:12 - 2nd Quarter',
    legs: [
      { player: 'Test Guard', team: 'TST', stat: 'points', label: 'Pts', point: 19.5, price: -180, current: 14 },
      { player: 'Sample Center', team: 'SMP', stat: 'rebounds', label: 'Reb', point: 8.5, price: -200, current: 6 },
      { player: 'Test Forward', team: 'TST', stat: 'assists', label: 'Ast', point: 4.5, price: -160, current: 3 },
    ],
    status: 'pending', result: null, profit: null,
  };
}

const writeLedger = (env, ledger) => env.POTD_KV.put(DISCORD_NBA_LEDGER_KEY, JSON.stringify(ledger), { expirationTtl: LEDGER_TTL });

/**
 * Bring the channel level with the live NBA plays. Returns {off} with no webhook, else {posted, settled, failed}.
 * `deps.fetch`, `deps.games`, `deps.play`, `deps.watch` and `deps.render` stand in for Discord, the watched games,
 * a game's stored slips, its watch log and the picture in tests.
 */
export async function syncBasketballDiscord(env, now = Date.now(), { deps = {} } = {}) {
  const cfg = deps.config ?? await basketballConfig(env);
  if (!cfg.hook) return { off: true };
  const fetcher = deps.fetch ?? fetch;
  const ledger = (await readJson(env, DISCORD_NBA_LEDGER_KEY)) ?? {};
  ledger.games ??= {}; ledger.posts ??= {};
  const out = { posted: 0, settled: 0, failed: 0 };
  let dirty = false;
  const fail = (what, r) => { ledger.lastError = { at: now, what, status: r.unknown ? 'no answer' : r.status }; out.failed++; dirty = true; };
  const render = deps.render ?? (async (post) => (await import('./card-render.js')).renderSlipPng(post));
  const picture = async (post) => { try { return (await render(post)) ?? null; } catch (e) { ledger.cardError = { at: now, message: String(e?.message ?? e).slice(0, 120) }; dirty = true; return null; } };
  const send = async (card, opts) => {
    if (ledger.noButtons && card.payload.components) delete card.payload.components;
    const r = await deliver(fetcher, cfg.hook, card, opts);
    if (r.refused && r.ok) { ledger.noButtons = true; dirty = true; }
    return r;
  };

  // The test card, once per NBA_TEST_ID.
  const testId = deps.testId ?? NBA_TEST_ID;
  if (testId && ledger.test?.id !== testId) {
    const post = testSlipPost(now);
    const card = slipMessage(post, { png: await picture(post), buttons: !ledger.noButtons });
    markTest(card.payload); if (card.plain !== card.payload) markTest(card.plain);
    ledger.test = { id: testId, state: 'sending', at: now };
    await writeLedger(env, ledger);
    const r = await send(card);
    ledger.test = { id: testId, state: r.ok ? 'done' : 'failed', at: now, picture: Boolean(card.file) && !r.noPicture };
    if (!r.ok) fail('test', r);
    dirty = true;
  }

  const games = (deps.games ? await deps.games() : (await readWatchIndex(env)).games)
    .filter((g) => g?.id && (g.league ?? 'nfl') === 'nba' && Number.isFinite(Date.parse(g.date)) && now >= Date.parse(g.date) - GAME_WINDOW_MS[1] && now <= Date.parse(g.date) + GAME_WINDOW_MS[0]);
  const playOf = deps.play ?? ((id) => readJson(env, livePlayKey(id)));
  const watchOf = deps.watch ?? ((id) => readJson(env, liveWatchKey(id)));

  for (const g of games) {
    const gid = String(g.id);
    const mine = Object.values(ledger.posts).filter((e) => e.post?.gameId === gid);
    const play = await playOf(gid);
    const state = ledger.games[gid] ?? { count: 0, tries: 0 };

    // A new play: the slip being followed is no longer on the board (or none has been posted), and the board is fresh.
    if (play?.slips?.length && now - (play.builtAt ?? 0) <= NBA_FRESH_MS && state.count < MAX_A_GAME && (state.tries ?? 0) < POST_TRIES * MAX_A_GAME) {
      const followed = state.current ? ledger.posts[state.current]?.post : null;
      const standing = followed && play.slips.some((s) => s.bookId === followed.bookId && (s.postedAt ?? play.builtAt) === followed.postedAt);
      const post = standing ? null : slipPost(g, play, play.slips[0]);
      if (post && !ledger.posts[post.id] && post.legs.length) {
        const card = slipMessage(post, { png: await picture(post), playbook: cfg.playbook, buttons: !ledger.noButtons });
        // Marked before it is sent: a run that dies mid-send does not send it again.
        ledger.posts[post.id] = { state: 'sending', at: now, post };
        ledger.games[gid] = { ...state, tries: (state.tries ?? 0) + 1 };
        await writeLedger(env, ledger);
        const r = await send(card);
        if (r.ok && r.id) { ledger.posts[post.id] = { state: 'open', at: now, messageId: String(r.id), post }; ledger.games[gid] = { ...ledger.games[gid], current: post.id, count: state.count + 1 }; ledger.lastPostAt = now; out.posted++; }
        // No answer: it may be in the channel, so it is not sent again. Refused: it is not, so a later tick may try.
        else if (r.unknown || r.ok) { ledger.posts[post.id] = { state: 'lost', at: now, post }; ledger.games[gid] = { ...ledger.games[gid], current: post.id, count: state.count + 1 }; fail('post', r); }
        else { delete ledger.posts[post.id]; fail('post', r); }
        dirty = true;
      }
    }

    // The game is over: every post of it still open is edited to how it finished.
    const open = mine.filter((e) => e.state === 'open' && e.messageId);
    if (!open.length) continue;
    const watch = await watchOf(gid);
    const fin = watch?.ticks?.[watch.ticks.length - 1] ?? null;
    if (fin?.state !== 'post') continue;
    for (const e of open) {
      const graded = gradePost(e.post, fin);
      const r = await send(slipMessage(graded, { png: await picture(graded), buttons: !ledger.noButtons }), { messageId: e.messageId });
      const tries = (e.editTries ?? 0) + 1;
      if (r.ok) { ledger.posts[graded.id] = { ...e, state: 'done', doneAt: now, post: graded }; out.settled++; }
      else { ledger.posts[graded.id] = r.status === 404 || tries >= 6 ? { ...e, state: 'done', doneAt: now, editFailed: true } : { ...e, editTries: tries }; fail('edit', r); }
      dirty = true;
    }
  }

  // A marker left by a run that never finished is closed, not repeated; what is old is let go.
  for (const [id, e] of Object.entries(ledger.posts)) {
    if (e.state === 'sending' && now - (e.at ?? 0) > 2 * 60e3) { ledger.posts[id] = { ...e, state: 'lost' }; dirty = true; }
    else if (now - (e.at ?? 0) > LEDGER_KEEP_MS) { delete ledger.posts[id]; dirty = true; }
  }
  for (const id of Object.keys(ledger.games)) if (!Object.values(ledger.posts).some((e) => e.post?.gameId === id)) { delete ledger.games[id]; dirty = true; }
  if (dirty) await writeLedger(env, ledger);
  return out;
}

/** What a probe may know about the basketball channel: whether it is set up and working. No address, no message id. */
export async function basketballStatus(env) {
  const cfg = await basketballConfig(env);
  const ledger = (await readJson(env, DISCORD_NBA_LEDGER_KEY)) ?? {};
  const counts = {};
  for (const e of Object.values(ledger.posts ?? {})) counts[e.state] = (counts[e.state] ?? 0) + 1;
  return {
    channel: Boolean(cfg.hook),
    // Set but not a Discord webhook address: the secret is there and wrong.
    secretRejected: Boolean(String(env?.DISCORD_LIVE_BASKETBALL_WEBHOOK ?? '').trim()) && !cfg.hook,
    // Whether Playbook's user id is known, so its tag is a real mention.
    playbook: Boolean(cfg.playbook),
    test: ledger.test ? { id: ledger.test.id, state: ledger.test.state, at: ledger.test.at ?? null, picture: ledger.test.picture ?? null } : null,
    lastPostAt: ledger.lastPostAt ?? null, lastError: ledger.lastError ?? null, cardError: ledger.cardError ?? null, games: Object.keys(ledger.games ?? {}).length, posts: counts,
  };
}
