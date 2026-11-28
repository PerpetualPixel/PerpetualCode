/**
 * The live NBA plays on the owner's Discord (2026-11-25: "I created another channel called lives and a webhook
 * DISCORD_LIVE_BASKETBALL_WEBHOOK ... allow this to post all live NBA plays and @playbook for the links").
 *
 * What a live NBA play is: worker/src/live-probe.js rebuilds each game's slips every few minutes while it is in
 * play (worker/src/live-board.js: three to five player overs at a book, nearest +100; two in the NFL since 2026-11-26), and a slip stands until one
 * of its lines leaves the board, when a new one takes its place.
 *
 * What is posted: the game's best slip, the one the Live tab shows as "Best slip", each time it is a slip that has
 * not been posted before. So whatever play the app is showing for a game is in the channel, each once: a slip that
 * still stands is never posted again, and the same legs are not posted at five books at the same minute. Where the
 * best slip shares a player with a play already posted for that game, another book's slip that shares none is posted
 * in its place when there is one. And a player is never posted twice on the same stat in a game (2026-11-26): a slip
 * that takes him again, for the same number or more, is not posted.
 *
 * (It first followed one slip a game and stopped at six posts. On its first night, 2026-11-25, a game's slips were
 * replaced every few minutes, the six were used in forty minutes, and the owner saw a play in the app that was not
 * in the channel: "how come I see this play in the app but it wasn't posted to the discord?" and then "remove the
 * cap, allow the app and discord to post as many as it finds". There is no cap: every best slip the board makes is
 * posted.)
 *
 * Playbook (docs/playbook.js) is the Discord bot that turns a written bet into a slip link at any book. It has no
 * API: it reads a message that tags it, with the book named and the legs written out, and replies in the channel.
 * So each new play's message starts with that tag and those lines. A pasted "@Playbook" pings nothing: the tag is
 * a real mention only when the bot's user id is known (the DISCORD_PLAYBOOK_USER_ID secret, or the id the owner
 * saved in the app's Playbook settings). Playbook does not answer a message posted by a webhook or by a bot account
 * (tried both, 2026-11-25: no reply either way), only a person: a reader replies to the post with "@Playbook" and
 * their book, and Playbook reads the post it was replied to. So every open post says so in its footer, and the tag
 * line stays, since it is the post Playbook then reads.
 *
 * When the game ends, each post's message is edited to how it finished: every leg against the final box score,
 * won or lost, and the units at one unit a play.
 *
 * Football works the same way (2026-11-25: "DISCORD_FOOTBALL_WEBHOOK ... made another channel ... same thing. Post
 * the live football plays and @playbook for links in the channel"): the live NFL plays go to their own channel,
 * with their own ledger, by the same rules. LEAGUES below is the whole difference between the two.
 *
 * The webhook address is a credential (see worker/src/discord.js): only in the worker's secrets, never logged,
 * never returned by a route.
 */
import { deliver, readJson, markTest, webhookOf } from './discord.js';
import { readWatchIndex, liveWatchKey } from './live-probe.js';
import { livePlayKey, boxValue } from './live-board.js';
import { SPORTSBOOKS } from '../../docs/engine.js';
import { PLAYBOOK_BOOK_NAMES } from '../../docs/playbook.js';
import { liveSlipHash } from '../../docs/live-slips.js';
import { getSettings } from './settings.js';

/** A league's channel: its webhook secret, its ledger, how it is named, and its test card's id (a new value sends one more). */
export const LEAGUES = {
  nba: { secret: 'DISCORD_LIVE_BASKETBALL_WEBHOOK', results: 'DISCORD_NBA_RESULTS_WEBHOOK', ledger: 'discord:nba:ledger', name: 'NBA', emoji: '🏀', testId: '2026-11-25-nba-1' },
  nfl: { secret: 'DISCORD_FOOTBALL_WEBHOOK', results: 'DISCORD_NFL_RESULTS_WEBHOOK', ledger: 'discord:nfl:ledger', name: 'NFL', emoji: '🏈', testId: '2026-11-25-nfl-1' },
};
export const DISCORD_NBA_LEDGER_KEY = LEAGUES.nba.ledger;
/** A slip is posted only while the board that made it is this fresh: an older build's prices are gone. */
export const NBA_FRESH_MS = 12 * 60e3;
const POST_TRIES = 3;
const LEDGER_KEEP_MS = 4 * 86400e3;
const LEDGER_TTL = 14 * 86400;
const GAME_WINDOW_MS = [10 * 3600e3, 3600e3]; // a game from an hour before its start until ten hours after
const BOARD = 'https://perpetualpicks.com/app.html';
const LOGO = 'https://perpetualpicks.com/assets/logo-icon-180.png';
const COLOR = { open: 0x00f0ff, win: 0x10b981, loss: 0xef4444, void: 0x9c98b8 };
/** A stat as Playbook reads it. */
const STAT_WORDS = { points: 'Points', rebounds: 'Rebounds', assists: 'Assists', passingYards: 'Passing Yards', rushingYards: 'Rushing Yards', receivingYards: 'Receiving Yards', receptions: 'Receptions' };

/**
 * One test card, sent once per value: the channel is new, and a card in it shows the setup works without waiting
 * for a game. It is marked as a test and tags nobody (a made-up slip would only confuse the bot).
 */
export const NBA_TEST_ID = LEAGUES.nba.testId;

const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const md = (s) => String(s ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1').slice(0, 200);
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/**
 * Who to tag for Playbook, from what was saved (2026-11-25, the owner, of a tag that came out as "@unknown-user":
 * "another play was posted and it was not @Playbook, fix this"). A server has two things called Playbook: the bot
 * itself, a member, and the role Discord gives it, and an id copied from the role is not a member's. So either is
 * taken: a member's id as the number or <@number>, a role's as <@&number> or &number. What comes back is the
 * inside of the mention, "123" for the member or "&123" for the role, so <@...> around it is right for both.
 */
const userIdOf = (v) => { const m = String(v ?? '').trim().match(/^(?:<@(?:!|(&))?)?(&)?(\d{15,22})>?$/); return m ? `${m[1] || m[2] ? '&' : ''}${m[3]}` : null; };
/** Discord's leave to ping it: a member by users, a role by roles, and nothing else in the message can ping anyone. */
export const mayPing = (tag) => (!tag ? { parse: [], users: [] } : tag.startsWith('&') ? { parse: [], users: [], roles: [tag.slice(1)] } : { parse: [], users: [tag] });

/**
 * Playbook's tag as the secrets give it ("123" for the member, "&123" for the role), or, with none set, the id the
 * owner saved in the app's Playbook settings; null when nothing is known. Shared with the results channel's
 * roll-ups (worker/src/discord-results-digest.js), which tag Playbook the same way.
 */
/** Playbook's tag from the secrets alone: the role's own secret when it is the role that was copied, else the member's (which also takes a role written as <@&id>); null with neither. */
export function playbookTagFromSecrets(env) {
  let playbook = userIdOf(env?.DISCORD_PLAYBOOK_ROLE_ID) ?? userIdOf(env?.DISCORD_PLAYBOOK_USER_ID);
  if (playbook && String(env?.DISCORD_PLAYBOOK_ROLE_ID ?? '').trim() && !playbook.startsWith('&') && userIdOf(env?.DISCORD_PLAYBOOK_ROLE_ID)) playbook = `&${playbook}`;
  return playbook;
}

export async function playbookTag(env) {
  return playbookTagFromSecrets(env) ?? userIdOf((await getSettings(env, 'owner').catch(() => null))?.playbook?.mention);
}

/**
 * What is configured: the channel's webhook (null when unset or not a Discord webhook), Playbook's user id, and the
 * results channel's webhook (2026-11-25, the owner: "create a basketball results channel as well posting the same as
 * tennis results but for nba"): every settled play's card goes there too, and the day's and the week's roll-ups
 * (worker/src/discord-results-digest.js).
 */
export async function leagueConfig(env, league = 'nba') {
  const hook = webhookOf(env?.[LEAGUES[league].secret]);
  // The id the owner saved in the app's Playbook settings stands in when the secret is not set — read only with a channel to post to.
  const playbook = hook ? await playbookTag(env) : playbookTagFromSecrets(env);
  return { hook, playbook, results: webhookOf(env?.[LEAGUES[league].results]) };
}

export const basketballConfig = (env) => leagueConfig(env, 'nba');

/** A slip as it is kept and drawn: the game, the book and price, and each leg with where the player stood. */
export function slipPost(game, play, slip, league = 'nba') {
  return {
    id: `${game.id}:${slip.bookId}:${slip.postedAt ?? play.builtAt}`,
    gameId: String(game.id), game: game.name ?? '', league,
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
  const head = playbook ? `<@${playbook}> ${PLAYBOOK_BOOK_NAMES[post.bookId] ?? post.book}` : `${LEAGUES[post.league]?.emoji ?? '🏀'} **LIVE PLAY** · ${price} · 1u`;
  return [head, ...playbookLines(post)].join('\n').slice(0, 1900);
}

/** Under every open post: how a reader gets their slip, since Playbook answers a person's reply and never the bot's own post. */
export const REPLY_HINT = 'Reply to this message with @Playbook and your book (e.g. "@Playbook FanDuel") for your slip · perpetualpicks.com';

/** The written card, for when there is no picture: the same play in words. */
function slipWritten(post) {
  const outcome = post.status === 'void' ? 'void' : post.status === 'graded' ? (post.result === 'win' ? 'win' : 'loss') : 'open';
  const sport = LEAGUES[post.league] ?? LEAGUES.nba;
  const mark = { open: `${sport.emoji} LIVE PLAY ·`, win: '✅ WON ·', loss: '❌ LOST ·', void: '⚪ VOID ·' }[outcome];
  const legs = post.legs.map((l) => `• **${md(l.player)}** Over ${l.point} ${md(l.label)}${outcome === 'open' ? (l.current != null ? ` · now ${l.current}` : '') : l.final != null ? ` · final ${l.final} ${l.hit ? '✓' : '✗'}` : ''}`);
  const points = Object.entries((outcome === 'open' ? post.score : post.finalScore ?? post.score) ?? {}).map(([t, n]) => `${md(t)} ${n}`).join(', ');
  return {
    title: `${mark} ${post.legs.length} legs · ${fmt(post.american)} at ${md(post.book)}`.slice(0, 250),
    url: outcome === 'open' ? `${BOARD}${liveSlipHash(post.league, post.gameId, post)}` : BOARD,
    author: { name: `PERPETUAL PICKS · LIVE ${sport.name}`, url: BOARD, icon_url: LOGO },
    description: [`${md(post.game)}${points ? ` · ${points}` : ''}`, ...legs, outcome === 'open' ? 'Recommended **1u**' : outcome === 'void' ? '**Stake returned**' : `**${signedUnits(post.profit ?? 0)}**`].join('\n').slice(0, 3900),
    color: COLOR[outcome],
    footer: { text: outcome === 'open' ? REPLY_HINT : 'Live play · perpetualpicks.com', icon_url: LOGO },
    timestamp: new Date(post.postedAt ?? Date.now()).toISOString(),
  };
}

/** A slip as it goes to Discord: {payload, file, plain}, the shape worker/src/discord.js's deliver sends. */
export function slipMessage(post, { png = null, playbook = null, buttons = true } = {}) {
  const outcome = post.status === 'void' ? 'void' : post.status === 'graded' ? (post.result === 'win' ? 'win' : 'loss') : 'open';
  const content = slipLine(post, { playbook });
  // Only the bot can be tagged, and only on a new play: nothing else in the words can ping anyone.
  const allowed_mentions = mayPing(outcome === 'open' ? playbook : null);
  // An open play's button lands on this slip with its "Add to sportsbook" picker open (docs/live-slips.js's
  // liveSlipHash): one tap here, one tap on the book. A settled play's goes to the board.
  const target = outcome === 'open' ? `${BOARD}${liveSlipHash(post.league, post.gameId, post)}` : BOARD;
  const components = [{ type: 1, components: [{ type: 2, style: 5, url: target, label: outcome === 'open' ? 'Add to sportsbook' : 'Live board', emoji: { name: LEAGUES[post.league]?.emoji ?? '🏀' } }] }];
  const plain = { content, allowed_mentions, embeds: [slipWritten(post)] };
  if (!png) return { payload: buttons ? { ...plain, components } : plain, file: null, plain };
  const picture = { color: COLOR[outcome], image: { url: 'attachment://card.png' }, ...(outcome === 'open' ? { footer: { text: REPLY_HINT, icon_url: LOGO } } : {}) };
  return { payload: { content, allowed_mentions, embeds: [picture], attachments: [{ id: 0, filename: 'card.png' }], ...(buttons ? { components } : {}) }, file: { name: 'card.png', bytes: png }, plain };
}

/** The test slip: made-up players, in the shape of a real one. */
export function testSlipPost(now = Date.now(), league = 'nba') {
  if (league === 'nfl') return {
    id: 'test-nfl', gameId: 'test', game: 'Test Team at Sample Team', league: 'nfl', bookId: 'fanduel', book: 'FanDuel', american: 110, decimal: 2.1, units: 1, postedAt: now,
    score: { TST: 14, SMP: 10 }, detail: '8:40 - 2nd Quarter',
    legs: [
      { player: 'Test Quarterback', team: 'TST', stat: 'passingYards', label: 'Pass Yds', point: 224.5, price: -190, current: 141 },
      { player: 'Sample Runner', team: 'SMP', stat: 'rushingYards', label: 'Rush Yds', point: 59.5, price: -170, current: 38 },
      { player: 'Test Receiver', team: 'TST', stat: 'receptions', label: 'Rec', point: 4.5, price: -160, current: 3 },
    ],
    status: 'pending', result: null, profit: null,
  };
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


/**
 * Bring a league's channel level with its live plays. Returns {off} with no webhook, else {posted, settled, failed}.
 * `deps.fetch`, `deps.games`, `deps.play`, `deps.watch` and `deps.render` stand in for Discord, the watched games,
 * a game's stored slips, its watch log and the picture in tests.
 */
export async function syncLeagueDiscord(env, now = Date.now(), league = 'nba', { deps = {} } = {}) {
  const sport = LEAGUES[league];
  const cfg = deps.config ?? await leagueConfig(env, league);
  if (!cfg.hook) return { off: true };
  const fetcher = deps.fetch ?? fetch;
  const writeLedger = (e, l) => e.POTD_KV.put(sport.ledger, JSON.stringify(l), { expirationTtl: LEDGER_TTL });
  const ledger = (await readJson(env, sport.ledger)) ?? {};
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
  /** A settled play's card to the results channel; the entry's `res` says whether it landed, `resTries` how often it was refused. */
  const sendResult = async (entry, png) => {
    const u = await deliver(fetcher, cfg.results, slipMessage(entry.post, { png, buttons: false }));
    entry.res = Boolean(u.ok || u.unknown);
    if (!entry.res) { entry.resTries = (entry.resTries ?? 0) + 1; entry.resAt = now; fail('result', u); }
    else ledger.lastResultAt = now;
  };

  // The test card, once per test id.
  const testId = deps.testId ?? sport.testId;
  if (testId && ledger.test?.id !== testId) {
    const post = testSlipPost(now, league);
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
    .filter((g) => g?.id && (g.league ?? 'nfl') === league && Number.isFinite(Date.parse(g.date)) && now >= Date.parse(g.date) - GAME_WINDOW_MS[1] && now <= Date.parse(g.date) + GAME_WINDOW_MS[0]);
  const playOf = deps.play ?? ((id) => readJson(env, livePlayKey(id)));
  const watchOf = deps.watch ?? ((id) => readJson(env, liveWatchKey(id)));

  for (const g of games) {
    const gid = String(g.id);
    const mine = Object.values(ledger.posts).filter((e) => e.post?.gameId === gid);
    const play = await playOf(gid);
    const state = ledger.games[gid] ?? { count: 0, tries: 0 };

    // A new play: the game's best slip is one that has not been posted, and the board that made it is fresh.
    if (play?.slips?.length && now - (play.builtAt ?? 0) <= NBA_FRESH_MS) {
      const best = slipPost(g, play, play.slips[0], league);
      // Not the same players twice, where there is a choice (2026-11-25, the owner: "let's not post overlapping players
      // if possible"). A play posted earlier is still someone's bet until the game ends, so its players count. When
      // the best slip shares a player with one, another book's slip that shares none is posted in its place; when
      // every slip shares one, the best slip goes, since a play is still a play.
      const posted = mine.filter((e) => e.state !== 'skipped').flatMap((e) => e.post?.legs ?? []);
      const taken = new Set(posted.map((l) => String(l.player).toLowerCase()));
      const shares = (p) => p.legs.some((l) => taken.has(String(l.player).toLowerCase()));
      // And never the same player on the same stat twice (2026-11-26, the owner, of St. Brown over 124.5 receiving yards posted an
      // hour after his 119.5: "not retake a player for more yards if it's already posted for previous yards earlier in the game").
      // The board no longer builds such a slip (worker/src/live-board.js takenLegs); this holds for what it built before.
      const lineOf = (l) => `${String(l.player).toLowerCase()}|${l.stat ?? ''}`;
      const lines = new Set(posted.map(lineOf));
      const retakes = (p) => p.legs.some((l) => lines.has(lineOf(l)));
      const fresh = !ledger.posts[best.id] && best.legs.length > 0;
      const others = fresh && shares(best) ? play.slips.slice(1).map((sl) => slipPost(g, play, sl, league)).filter((p) => p.legs.length && !ledger.posts[p.id]) : [];
      // In place of a best slip that shares a player: a slip that shares none; failing that the best itself, unless it takes a
      // player again on the same stat, when a slip that does not stands in, or nothing is posted.
      const other = others.find((p) => !shares(p)) ?? (fresh && retakes(best) ? others.find((p) => !retakes(p)) ?? null : null);
      const post = other ?? (fresh && retakes(best) ? null : best);
      if (fresh && post) {
        const card = slipMessage(post, { png: await picture(post), playbook: cfg.playbook, buttons: !ledger.noButtons });
        // Marked before it is sent: a run that dies mid-send does not send it again.
        ledger.posts[post.id] = { state: 'sending', at: now, post };
        ledger.games[gid] = { ...state, tries: (state.tries ?? 0) + 1 };
        await writeLedger(env, ledger);
        const r = await send(card);
        // The best slip another stood in for is not posted later: it is kept as passed over.
        if (other && (r.ok || r.unknown)) ledger.posts[best.id] = { state: 'skipped', at: now, post: { id: best.id, gameId: gid, legs: [] } };
        if (r.ok && r.id) { ledger.posts[post.id] = { state: 'open', at: now, messageId: String(r.id), post }; ledger.games[gid] = { ...ledger.games[gid], current: post.id, count: state.count + 1 }; ledger.lastPostAt = now; ledger.lastPostTagged = Boolean(cfg.playbook); ledger.tagged = (ledger.tagged ?? 0) + (cfg.playbook ? 1 : 0); out.posted++; }
        // No answer: it may be in the channel, so it is not sent again. Refused: it is not, so a later tick may try.
        else if (r.unknown || r.ok) { ledger.posts[post.id] = { state: 'lost', at: now, post }; ledger.games[gid] = { ...ledger.games[gid], current: post.id, count: state.count + 1 }; fail('post', r); }
        else { delete ledger.posts[post.id]; fail('post', r); }
        dirty = true;
      }
    }

    // The game is over: every post of it still open is settled. The card in the live channel is left as it was posted
    // (2026-11-28, the owner: "stop changing the cards to won or loss or void in the live channels, leave that for the
    // results channels"; AutoPurger clears each live card 15 minutes after it goes up), and the settled card goes to
    // the results channel when there is one.
    const open = mine.filter((e) => e.state === 'open' && e.messageId);
    if (!open.length) continue;
    const watch = await watchOf(gid);
    const fin = watch?.ticks?.[watch.ticks.length - 1] ?? null;
    if (fin?.state !== 'post') continue;
    for (const e of open) {
      const graded = gradePost(e.post, fin);
      ledger.posts[graded.id] = { ...e, state: 'done', doneAt: now, post: graded }; out.settled++;
      // `res` says whether it got there: one Discord refused is tried again below, a few ticks, and never one Discord
      // gave no answer about.
      if (cfg.results) await sendResult(ledger.posts[graded.id], await picture(graded));
      dirty = true;
    }
  }
  // A play closed without a grade: until 2026-11-28 a settled play's card was edited in the live channel, and a card
  // that had been deleted from it (Discord's 404) closed the play ungraded, so it reached neither the results channel
  // nor the day's roll-up (found 2026-11-28: Friday's NFL plays, and no NFL roll-up for the day). Each is graded now
  // from its game's last look, three tries, and its result is owed to the results channel like any other.
  const settled = (p) => p?.status === 'graded' || p?.status === 'void';
  const lastLooks = new Map();
  for (const e of Object.values(ledger.posts)) {
    if (e.state !== 'done' || !e.editFailed || !e.post?.gameId || !e.post.legs || settled(e.post) || (e.repairTries ?? 0) >= 3) continue;
    const gid = e.post.gameId;
    if (!lastLooks.has(gid)) { const w = await watchOf(gid); const t = w?.ticks?.[w.ticks.length - 1] ?? null; lastLooks.set(gid, t?.state === 'post' ? t : null); }
    const fin = lastLooks.get(gid);
    dirty = true;
    if (!fin) { e.repairTries = (e.repairTries ?? 0) + 1; continue; }
    const { editFailed, repairTries, ...rest } = e;
    ledger.posts[e.post.id] = { ...rest, post: gradePost(e.post, fin), repairedAt: now, ...(cfg.results ? { res: false } : {}) };
    out.settled++;
  }
  // A result the results channel has not had (one Discord refused): sent again, three tries at most, a few a tick, for a day.
  if (cfg.results) {
    let caughtUp = 0;
    for (const e of Object.values(ledger.posts)) {
      // Not one refused on this very tick: the next tick is soon enough.
      if (caughtUp >= 3 || e.state !== 'done' || e.res !== false || e.resAt === now || (e.resTries ?? 0) >= 3 || now - (e.doneAt ?? 0) > 864e5) continue;
      caughtUp++; await sendResult(e, await picture(e.post)); dirty = true;
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

export const syncBasketballDiscord = (env, now, opts) => syncLeagueDiscord(env, now, 'nba', opts);
export const syncFootballDiscord = (env, now, opts) => syncLeagueDiscord(env, now, 'nfl', opts);

/** What a probe may know about a league's channel: whether it is set up and working. No address, no message id. */
export async function leagueStatus(env, league = 'nba') {
  const cfg = await leagueConfig(env, league);
  const ledger = (await readJson(env, LEAGUES[league].ledger)) ?? {};
  const counts = {};
  for (const e of Object.values(ledger.posts ?? {})) counts[e.state] = (counts[e.state] ?? 0) + 1;
  return {
    channel: Boolean(cfg.hook),
    // Set but not a Discord webhook address: the secret is there and wrong.
    secretRejected: Boolean(String(env?.[LEAGUES[league].secret] ?? '').trim()) && !cfg.hook,
    // Whether Playbook's id is known, so its tag is a real mention, and whether it is the bot itself or its role that is tagged.
    playbook: Boolean(cfg.playbook), playbookTag: cfg.playbook ? (cfg.playbook.startsWith('&') ? 'role' : 'member') : null,
    test: ledger.test ? { id: ledger.test.id, state: ledger.test.state, at: ledger.test.at ?? null, picture: ledger.test.picture ?? null } : null,
    // Whether the last play posted started with Playbook's tag, and how many plays have (2026-11-25, the owner: "ensure
    // when football and basketball plays are posted, it ats @Playbook with the card so it can build the links").
    lastPostTagged: ledger.lastPostTagged ?? null, tagged: ledger.tagged ?? 0,
    lastPostAt: ledger.lastPostAt ?? null, lastError: ledger.lastError ?? null, cardError: ledger.cardError ?? null, games: Object.keys(ledger.games ?? {}).length, posts: counts,
    // The results channel: whether it is set up, whether its secret is there and wrong, how many settled plays reached it and when the last did.
    results: Boolean(cfg.results),
    resultsSecretRejected: Boolean(String(env?.[LEAGUES[league].results] ?? '').trim()) && !cfg.results,
    resultsPosted: Object.values(ledger.posts ?? {}).filter((e) => e.res === true).length, lastResultAt: ledger.lastResultAt ?? null,
    // Plays closed without a grade (their card could not be edited), and how many of those have since been graded.
    ungraded: Object.values(ledger.posts ?? {}).filter((e) => e.state === 'done' && e.editFailed).length,
    repaired: Object.values(ledger.posts ?? {}).filter((e) => e.repairedAt).length,
  };
}
export const basketballStatus = (env) => leagueStatus(env, 'nba');
export const footballStatus = (env) => leagueStatus(env, 'nfl');
