/**
 * The tracked live plays, posted to the owner's Discord server (2026-11-25:
 * "For these officially tracked live plays, I would like to push these to
 * my discord server ... have a bot post these for me when they are first
 * available", with a server that posts a live tennis play and edits the
 * same message when it settles).
 *
 * How it works:
 *
 *   - A channel webhook, not a hosted bot: the owner makes one in the
 *     channel's settings and stores its URL as the worker secret
 *     DISCORD_LIVE_WEBHOOK. Nothing to host, and the worker can still edit
 *     what it posted. With no secret this file does nothing.
 *   - After each live tennis tick (worker/src/tennis-live-plays.js) the
 *     tracked plays of today and yesterday are held against a small ledger:
 *     a play not yet posted, still open and no more than FRESH_MS old goes
 *     up; a posted play that has settled has its own message edited to say
 *     how it ended. A lean is never posted: it is not a tracked play.
 *   - Posting once (the owner, 2026-11-23: "try not to double post"): the
 *     ledger is marked before the post and filled in after it. A post whose
 *     outcome is unknown (a timeout) is never sent again; a post Discord
 *     plainly refused is tried again, three times at most. An edit is safe
 *     to repeat, so it is retried.
 *   - A play that was already old or settled when the webhook was added is
 *     not posted late: an alert is for a play that can still be taken.
 *
 * Optional: DISCORD_LIVE_ROLE_ID pings a role on each new play (never on an
 * edit), and DISCORD_UPDATES_WEBHOOK gets one simple card per result.
 *
 * The webhook URL is a credential: it is read from the environment, never
 * logged, and never returned by a route.
 */
import { etParts } from './potd.js';
import { tennisLivePlaysKey, liveRecordOf, TENNIS_LIVE_PLAYS_INDEX } from './tennis-live-plays.js';
import { SPORTSBOOKS } from '../../docs/engine.js';
import { needsState, withState, hardRockSelections, phoneSlipLink, isPhone } from '../../docs/book-links.js';

export const DISCORD_LEDGER_KEY = 'discord:live:ledger';
/** A play older than this when first seen is not posted: the price it names has moved on. */
export const FRESH_MS = 15 * 60e3;
/** Posts Discord refused are tried this many times; edits this many. */
export const POST_TRIES = 3;
export const EDIT_TRIES = 6;
const LEDGER_KEEP_MS = 4 * 86400e3;
const LEDGER_TTL = 14 * 86400;
const HELLO_RETRY_MS = 30 * 60e3;
const SITE = 'https://perpetualpicks.com/app.html';
/**
 * Every link a Discord message carries to something of ours is on the site's own name (2026-11-25, the owner, of a
 * More info button that opened the worker's address, which has part of a personal email address in it: "I'd
 * rather it not have my workers info"). The site's play.html shows a play's page and passes a book link on; the
 * worker's address is never written into a message. LINK_VERSION is raised when that changes, and a message
 * posted under an older one is edited once so the old links come off it.
 */
const PLAY_PAGE = 'https://perpetualpicks.com/play.html';
export const LINK_VERSION = 2;
const RELINK_A_TICK = 4;
const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const SNOWFLAKE = /^\d{5,25}$/;
// The site's own colours (docs/styles.css): magenta for a play that is live, its green and red for a result.
const COLOR = { open: 0xff007a, win: 0x10b981, loss: 0xef4444, void: 0x9c98b8 };
/** An open lean's colour: the violet of the lean box on the site. */
const LEAN_COLOR = 0x7c3aed;
/** A live play's card: the site's laser blue. */
const LIVE_COLOR = 0x00f0ff;
const LOGO = 'https://perpetualpicks.com/assets/logo-icon-180.png';
// The strips under the card (docs/assets/discord: live, won, lost, void). Discord keeps an image by its address, so a redrawn strip needs a new version.
const ART = 'https://perpetualpicks.com/assets/discord';
const ART_VERSION = 1;
const TOUR = { atp: 'ATP', wta: 'WTA' };

/**
 * A test alert, sent once per value (2026-11-25, the owner, with the webhook and the role in place: "Can you send a
 * test"). The worker cannot be asked to post from outside without a credential, so the test rides a deploy: change
 * this value and the next tick posts one sample play, marked as a test, with the role ping; the tick after edits it
 * to its settled form. That is the whole path a real play takes.
 */
export const TEST_ALERT_ID = '2026-11-25-8';
/**
 * What the test sends: 'cards' (one card for each template in the live channel: live play, won, lost, void, with
 * their buttons and no ping), 'all' (one alert with its ping, its edit, and the result card), 'results' (the
 * result cards alone, a win and a loss, in the results channel) or 'leans' (a lean as it opens and one that has
 * won, in the leans channel), 'cards+leans' (both of those: every template, each in its own channel), or 'pair'
 * (one live play card in the live channel and one lean card in the leans channel: a look at a restyle without
 * filling the channels).
 */
export const TEST_SCOPE = 'pair';
const TEST_BASE = { market: 'live_ml', tour: 'atp', event: 'Test alert', round: 'not a real play', a: 'Test Player', b: 'Sample Opponent', side: 'a', prob: 0.69, american: -150, playable: -165, bookId: 'fanduel', book: 'FanDuel', units: 1, selection: 'Test Player to win the match (live)', score: '6-0 3-4', status: 'pending',
  stats: { holds: { a: { held: 6, served: 6 }, b: { held: 3, served: 5 } }, last: { of: 8, a: 5, b: 3 }, streak: null, setGames: null },
  why: ['Score 6-0 3-4: from here the model gives Test Player 74% to win the match and 58% to win the set in play.', 'Test Player has held 6 of 6 service games; Sample Opponent has held 3 of 5 service games.', 'Last 8 games: Test Player 5, Sample Opponent 3.', 'The live price gives Test Player 60%; the read puts it at 69%.'],
  // The books' own front pages: a test has no bet to put on a slip.
  quotes: [{ bookId: 'fanduel', book: 'FanDuel', american: -150, link: 'https://sportsbook.fanduel.com/' }, { bookId: 'draftkings', book: 'DraftKings', american: -155, link: 'https://sportsbook.draftkings.com/' }, { bookId: 'caesars', book: 'Caesars', american: -160, link: 'https://sportsbook.caesars.com/' }] };
/** The four test plays, one for each card: test-live, test-won, test-lost, test-void. */
export function testPlays(now = Date.now()) {
  return {
    'test-live': { ...TEST_BASE, id: 'test-live', postedAt: now },
    'test-won': { ...TEST_BASE, id: 'test-won', postedAt: now, gradedAt: now, status: 'graded', result: 'win', profit: 0.67, actual: '6-0 4-6 7-6' },
    'test-lost': { ...TEST_BASE, id: 'test-lost', postedAt: now, gradedAt: now, status: 'graded', result: 'loss', profit: -1, actual: '6-0 4-6 3-6' },
    'test-void': { ...TEST_BASE, id: 'test-void', postedAt: now, gradedAt: now, status: 'void', result: 'void', profit: 0, actual: '6-0 1-0: a retirement' },
  };
}
/** The two test leans, as the leans channel shows them: test-lean (open) and test-lean-won. A lean has no stake on the record, no hold counts and often no book. */
export function testLeans(now = Date.now()) {
  const { quotes: _q, stats: _s, american: _a, bookId: _b, book: _n, ...base } = TEST_BASE;
  const lean = { ...base, lean: true, basis: 'score', units: 0.5, prob: 0.75, playable: -245, score: '6-0', why: ['Score 6-0: from here the model gives Test Player 75% to win the match.', 'No serve data on this match: the read is from the score alone.'] };
  return {
    'test-lean': { ...lean, id: 'test-lean', postedAt: now },
    'test-lean-won': { ...lean, id: 'test-lean-won', postedAt: now, gradedAt: now, status: 'graded', result: 'win', profit: 0.2, actual: '6-0 6-3' },
  };
}
const isTestId = (id) => /^test(-|$)/.test(String(id ?? ''));
/** A message marked as a test, wherever its words are: the line above the card, the written card's title and footer. */
const markTest = (msg) => {
  // Marked once: the card and its written form can share the same title and footer.
  if (!String(msg.content ?? '').startsWith('🧪')) msg.content = `🧪 **TEST · not a real play**${msg.content ? `\n${msg.content}` : ''}`;
  const e = msg.embeds?.[0];
  if (e?.title && !e.title.startsWith('🧪')) e.title = `🧪 TEST · ${e.title}`.slice(0, 250);
  if (e?.footer && !e.footer.text.startsWith('TEST')) e.footer = { ...e.footer, text: `TEST · not a real play · ${e.footer.text}` };
  return msg;
};
/** The written card for the first test alert, open or settled. */
export function testAlertMessage(now, { role = null, settled = false } = {}) {
  const plays = testPlays(now);
  return markTest(livePlayMessage(settled ? plays['test-won'] : plays['test-live'], { role, record: { wins: 8, losses: 2, units: 3.29 } }));
}

/** The role id as Discord gives it, or however it was pasted (a mention <@&123>, in quotes, after a label): the one long number in the value. A name has none. */
const roleOf = (v) => { const ids = String(v ?? '').match(/\d{15,22}/g) ?? []; return ids.length === 1 ? ids[0] : String(v ?? '').trim(); };
/** What is configured: the webhooks (null when unset or not a Discord webhook URL) and the role to ping. `leans` is the channel for the live leans (2026-11-25: "I made another channel (tennis-leans)"). */
export function discordConfig(env) {
  const hook = (v) => { const s = String(v ?? '').trim(); return WEBHOOK.test(s) ? s : null; };
  const role = roleOf(env?.DISCORD_LIVE_ROLE_ID);
  return { live: hook(env?.DISCORD_LIVE_WEBHOOK), updates: hook(env?.DISCORD_UPDATES_WEBHOOK), leans: hook(env?.DISCORD_LIVE_LEAN_WEBHOOK), role: SNOWFLAKE.test(role) ? role : null };
}

const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const implied = (american) => (american > 0 ? 100 / (american + 100) : -american / (-american + 100));
const pct = (x) => `${Math.round(x * 100)}%`;
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const unitsOf = (u) => `${Math.round((u ?? 1) * 100) / 100}u`;
/** Text from the feed, safe inside Discord markdown. */
const md = (s) => String(s ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1').slice(0, 200);
const lastName = (name) => String(name ?? '').trim().split(/\s+/).at(-1) ?? '';
/** The read as a ten-step meter: ▰▰▰▰▰▰▰▱▱▱ for 69%. */
export const meter = (p) => { const n = Math.max(0, Math.min(10, Math.round(p * 10))); return '▰'.repeat(n) + '▱'.repeat(10 - n); };

/**
 * A book's bet-slip link as the card can carry it, or null. A complete https link goes as it is. One that needs
 * the reader's state ({state}: Caesars, BetMGM) or is Hard Rock's (a phone needs the shared-bet form) goes through
 * the site's play page (docs/play.js) to the worker's /go route, which finishes it for whoever taps it. Any other blank left in it cannot be filled.
 */
export function cardLink(play, quote) {
  const raw = String(quote?.link ?? '');
  if (!/^https:\/\/[^\s<>()]+$/.test(raw) || !quote?.bookId) return null;
  const viaWorker = `${PLAY_PAGE}?id=${encodeURIComponent(play.id)}&go=${encodeURIComponent(quote.bookId)}`;
  if (needsState(raw)) return /[{}]|%7B/i.test(raw.replace(/\{state\}|%7Bstate%7D/gi, '')) ? null : viaWorker;
  if (/[{}]|%7B/i.test(raw)) return null;
  return hardRockSelections(raw) ? viaWorker : raw;
}
/** The books that have the line, best price first, each as "Book −175", linked where the link can be carried. */
function bookLinks(play) {
  return booksOf(play).slice(0, 6).map((b) => { const text = `${md(b.name)} ${fmt(b.american)}`; return b.url ? `[${text}](${b.url})` : text; });
}

/** The three kinds of live play, by the words a bettor uses. */
const KIND = {
  live_ml: { head: () => 'Match Winner', label: () => 'Moneyline', record: 'ml' },
  live_set: { head: (p) => `Set ${p.set} Winner`, label: (p) => `Set ${p.set} winner`, record: 'sets' },
  live_set_total: { head: (p) => `Set ${p.set} Games`, label: (p) => `Set ${p.set} total games`, record: 'setGames' },
};

/**
 * Why, in a sentence or two, from the numbers the play kept when it posted (worker/src/tennis-live-plays.js
 * playStats): who is holding serve, who has the run of games, and the read against what the price asks.
 */
export function whyLine(play) {
  const st = play.stats ?? {};
  const side = play.side === 'a' || play.side === 'b' ? play.side : null;
  const other = side === 'a' ? 'b' : 'a';
  const out = [];
  const h = st.holds;
  if (play.market === 'live_set_total') {
    if (h && h.a.served + h.b.served >= 3) out.push(`${md(lastName(play.a))} has held ${h.a.held} of ${h.a.served} service games and ${md(lastName(play.b))} ${h.b.held} of ${h.b.served}.`);
    if (Number.isFinite(st.setGames)) out.push(`At those hold rates the set runs to about ${st.setGames} games.`);
  } else if (side) {
    if (h && h[side].served >= 2 && h[other].served >= 2) out.push(`${md(lastName(play[side]))} has held ${h[side].held} of ${h[side].served} service games today; ${md(lastName(play[other]))} ${h[other].held} of ${h[other].served}.`);
    if (st.streak?.side === side) out.push(`Has won the last ${st.streak.n} games.`);
    else if (st.last && st.last[side] > st.last[other]) out.push(`Has won ${st.last[side]} of the last ${st.last.of} games.`);
  }
  const price = Number.isFinite(play.american) ? play.american : play.playable;
  if (play.lean && play.basis === 'score') out.push('Read from the score alone: no serve data on this match.');
  if (Number.isFinite(play.prob) && Number.isFinite(price)) out.push(`We make it ${pct(play.prob)} to land; the price only needs ${pct(implied(price))}.`);
  return out.slice(0, 3).join(' ');
}

/**
 * The alert card (2026-11-25, the owner: "a unique and simple alert card with the important info and a short
 * explanation on why to take it ... a % of hitting or stats backing the pick. Be very clear on what bet to take ...
 * a link for a user to click and import to any sportsbook we provide and that has the line ... in line with my
 * website and my logo").
 *
 *   author     the logo and "PERPETUAL PICKS · LIVE TENNIS"
 *   title      TAKE and the bet, in the words on the bet slip
 *   body       the price and where, the stake; the kind of bet and the match; why; the books that have it, linked
 *   fields     the chance to land as a meter, what the price needs, the edge; the score when taken, the holds, the record
 *   image      a strip in the site's colours that says LIVE PLAY, and WON, LOST or VOID once it settles
 *
 * The same message is the result once the play settles: the title leads with it and the links come off.
 * `record` is the site's record for this kind of play ({wins, losses, units}), `role` the role to ping.
 */
export function livePlayMessage(play, { role = null, record = null } = {}) {
  const kind = KIND[play.market] ?? KIND.live_ml;
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const settled = play.status === 'graded' || play.status === 'void';
  const outcome = play.status === 'void' ? 'void' : play.result === 'win' ? 'win' : play.result === 'loss' ? 'loss' : 'open';
  const take = String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, '');
  const bookName = md(SPORTSBOOKS[play.bookId]?.name ?? play.book ?? 'the book');
  // A lean is a call, not a tracked play: it carries no stake and is never on the record, and every line of it says so.
  const lean = Boolean(play.lean);
  const stake = lean ? `recommended **${unitsOf(play.units)}** · a lean, not on the record` : `${settled ? '' : 'recommended '}stake **${unitsOf(play.units)}**`;
  const betLine = priced
    ? `**${fmt(play.american)}** at **${bookName}**${Number.isFinite(play.playable) && play.playable < play.american ? ` · good down to ${fmt(play.playable)}` : ''} · ${stake}`
    : `**${fmt(price)} or better** at your book · ${stake}`;
  const why = whyLine(play);
  const links = settled ? [] : bookLinks(play);
  const lines = [
    settled ? (outcome === 'void' ? `**${lean ? 'No result' : 'Stake returned'}**${play.actual ? ` · ${md(play.actual)}` : ''}` : `**Final ${md(play.actual ?? '')}${!lean && Number.isFinite(play.profit) ? ` · ${signedUnits(play.profit)}` : ''}**`) : null,
    settled ? `${lean ? 'Leaned' : 'Taken'} at **${priced ? fmt(play.american) : `${fmt(price)} or better`}**${priced ? ` (${bookName})` : ''} · ${stake}` : betLine,
    `${kind.label(play)} · ${md(play.a)} vs ${md(play.b)}`,
    [TOUR[play.tour] ?? null, play.event ? md(play.event) : null, play.round ? md(play.round) : null].filter(Boolean).join(' · ') || null,
    why ? `\n**Why:** ${why}` : null,
    settled ? null : links.length ? `\n**Bet it:** ${links.join(' · ')}` : `\n**Bet it:** no book we read has this live. Take it at ${fmt(price)} or better where you can find it.`,
  ].filter(Boolean);
  const edge = Number.isFinite(play.prob) && Number.isFinite(price) ? Math.round((play.prob - implied(price)) * 100) : null;
  const h = play.stats?.holds;
  const fields = [
    Number.isFinite(play.prob) ? { name: 'Chance to land', value: `${meter(play.prob)} **${pct(play.prob)}**`, inline: true } : null,
    Number.isFinite(price) ? { name: 'Price needs', value: pct(implied(price)), inline: true } : null,
    edge != null ? { name: 'Edge', value: `${edge >= 0 ? '+' : '−'}${Math.abs(edge)} pts`, inline: true } : null,
    play.score ? { name: 'Score when taken', value: md(play.score), inline: true } : null,
    h ? { name: 'Serve held today', value: `${md(lastName(play.a))} ${h.a.held}/${h.a.served} · ${md(lastName(play.b))} ${h.b.held}/${h.b.served}`, inline: true } : null,
    record && record.wins + record.losses > 0 ? { name: `Our ${kind.head(play).replace(/^Set \d+ /, 'Set ')} record`, value: `${record.wins}-${record.losses} · ${signedUnits(record.units)}`, inline: true } : null,
  ].filter(Boolean);
  const mark = (lean ? { open: '💡 LEAN ·', win: '✅ LEAN WON ·', loss: '❌ LEAN LOST ·', void: '⚪ LEAN VOID ·' } : { open: '🎾 TAKE ·', win: '✅ WON ·', loss: '❌ LOST ·', void: '⚪ VOID ·' })[outcome];
  return {
    // The ping rides the first post only; an edit re-sends the same text and Discord does not ping again.
    content: role ? `<@&${role}>` : '',
    allowed_mentions: { parse: [], roles: role ? [role] : [] },
    embeds: [{
      author: { name: lean ? 'PERPETUAL PICKS · LIVE TENNIS LEAN' : 'PERPETUAL PICKS · LIVE TENNIS', url: SITE, icon_url: LOGO },
      title: `${mark} ${md(take)}`.slice(0, 250),
      url: SITE,
      description: lines.join('\n').slice(0, 3900),
      color: lean && outcome === 'open' ? LEAN_COLOR : COLOR[outcome],
      fields,
      // The strips say LIVE PLAY, WON, LOST and VOID: a lean is none of the first, so an open lean carries no strip.
      ...(lean && outcome === 'open' ? {} : { image: { url: `${ART}/${{ open: 'live', win: 'won', loss: 'lost', void: 'void' }[outcome]}.png?v=${ART_VERSION}` } }),
      footer: { text: lean ? 'Lean · not a tracked play · not on the record · perpetualpicks.com' : 'Tracked play · graded automatically · perpetualpicks.com', icon_url: LOGO },
      timestamp: new Date(play.postedAt ?? Date.now()).toISOString(),
    }],
  };
}

/**
 * The result card for the results channel (2026-11-25, the owner, of the alert card: "Do the same for results but a
 * very simple win or loss and the score or any pertinent information"). Won, lost or void and the bet in the title;
 * the final score and the units; the price it was taken at; the match. The site's record for that kind of play, as it
 * stands with this result in it, is the footer. The same logo, colours and strip as the alert, and nothing else.
 */
export function liveResultMessage(play, { record = null } = {}) {
  const kind = KIND[play.market] ?? KIND.live_ml;
  const outcome = play.status === 'void' ? 'void' : play.result === 'win' ? 'win' : 'loss';
  const take = String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, '');
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const lines = [
    outcome === 'void' ? `**Stake returned**${play.actual ? ` · ${md(play.actual)}` : ''}` : `**Final ${md(play.actual ?? '')}**${Number.isFinite(play.profit) ? ` · **${signedUnits(play.profit)}**` : ''}`,
    Number.isFinite(price) ? `Taken at ${priced ? fmt(play.american) : `${fmt(price)} or better`}${priced ? ` (${md(SPORTSBOOKS[play.bookId]?.name ?? play.book ?? 'the book')})` : ''} · ${unitsOf(play.units)} stake` : null,
    [`${md(play.a)} vs ${md(play.b)}`, TOUR[play.tour] ?? null, play.event ? md(play.event) : null].filter(Boolean).join(' · '),
  ].filter(Boolean);
  const mark = { win: '✅ WON ·', loss: '❌ LOST ·', void: '⚪ VOID ·' }[outcome];
  return {
    content: '',
    allowed_mentions: { parse: [] },
    embeds: [{
      author: { name: 'PERPETUAL PICKS · LIVE TENNIS', url: SITE, icon_url: LOGO },
      title: `${mark} ${md(take)}`.slice(0, 250),
      url: SITE,
      description: lines.join('\n').slice(0, 1900),
      color: COLOR[outcome],
      image: { url: `${ART}/${{ win: 'won', loss: 'lost', void: 'void' }[outcome]}.png?v=${ART_VERSION}` },
      footer: { text: record && record.wins + record.losses > 0 ? `Our ${kind.head(play).replace(/^Set \d+ /, 'Set ')} record: ${record.wins}-${record.losses} · ${signedUnits(record.units)}` : 'perpetualpicks.com', icon_url: LOGO },
      timestamp: new Date(play.gradedAt ?? Date.now()).toISOString(),
    }],
  };
}

/** The books that have the line, best price first, each with the link the card can carry for it (or null). */
export function booksOf(play) {
  const quotes = [...(play.quotes ?? [])];
  if (play.bookId && Number.isFinite(play.american) && !quotes.some((q) => q.bookId === play.bookId)) quotes.unshift({ bookId: play.bookId, book: play.book, american: play.american, link: play.link });
  return quotes.filter((q) => q?.bookId && Number.isFinite(q.american)).sort((x, y) => y.american - x.american)
    .map((q) => ({ bookId: q.bookId, name: SPORTSBOOKS[q.bookId]?.name ?? q.book ?? q.bookId, american: q.american, url: cardLink(play, q.link ? q : { ...q, link: q.bookId === play.bookId ? play.link : null }) }));
}
/** The page with the numbers behind a play: the site's play.html, which shows the worker's page for it (worker/src/play-page.js). */
export const statsUrl = (play) => `${PLAY_PAGE}?id=${encodeURIComponent(play.id)}`;

/**
 * The buttons under a card (2026-11-25: "allowing for the user to click one button and add to the sports book ...
 * click a button and find more stats and data backing the pick"). While the play is open: one button a book that
 * has the line, best price first (three at most), each opening that book with the bet on the slip; then the stats
 * button on a row of its own. Once it has settled: the stats button alone. They are link buttons: the only kind a channel webhook can send.
 */
export function cardButtons(play) {
  const settled = play.status === 'graded' || play.status === 'void';
  // A long book name is cut so a label stays short enough to read on a phone, whatever the book is called.
  const short = (name) => (String(name).length > 22 ? `${String(name).slice(0, 21).trimEnd()}…` : String(name));
  const books = [];
  if (!settled) for (const b of booksOf(play)) {
    if (!b.url || books.length >= 3) continue;
    books.push({ type: 2, style: 5, url: b.url, label: `${books.length ? '' : 'Add to slip · '}${short(b.name)} ${fmt(b.american)}`.slice(0, 80), ...(books.length ? {} : { emoji: { name: '➕' } }) });
  }
  const stats = { type: 2, style: 5, url: statsUrl(play), label: 'More info', emoji: { name: '📊' } };
  // The books on one row and the stats on the row under it: the stats button is always in the same place, and a row is never crowded.
  return [...(books.length ? [{ type: 1, components: books }] : []), { type: 1, components: [stats] }];
}

/** The line above the card: what a phone's notification shows, and what stands if the picture does not load. */
export function cardLine(play, { role = null } = {}) {
  const take = md(String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, ''));
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const at = Number.isFinite(price) ? (priced ? ` · ${fmt(price)} at ${md(SPORTSBOOKS[play.bookId]?.name ?? play.book ?? 'the book')}` : ` · ${fmt(price)} or better`) : '';
  if (play.lean) {
    // A lean says it is one first. It carries its recommended units while it is open and no result in units: it is not on the record.
    if (play.status === 'void') return `⚪ **LEAN VOID** · ${take}`;
    if (play.status === 'graded') return `${play.result === 'win' ? '✅ **LEAN WON**' : '❌ **LEAN LOST**'} · ${take}${play.actual ? ` · final ${md(play.actual)}` : ''}`;
    return `💡 **LEAN · ${take}**${at} · ${unitsOf(play.units)}`;
  }
  if (play.status === 'void') return `⚪ **VOID** · ${take} · stake returned`;
  if (play.status === 'graded') return `${play.result === 'win' ? '✅ **WON**' : '❌ **LOST**'} · ${take}${play.actual ? ` · final ${md(play.actual)}` : ''}${Number.isFinite(play.profit) ? ` · ${signedUnits(play.profit)}` : ''}`;
  return `${role ? `<@&${role}> ` : ''}🎾 **TAKE · ${take}**${at} · ${unitsOf(play.units)}`;
}

/**
 * A play as it goes to Discord (2026-11-25, the owner's four templates): the card as a picture (worker/src/card-svg.js
 * draws it, `png` its bytes), a line above it, and the buttons under it. Returns {payload, file, plain}: `file` is
 * the picture to attach, and `plain` is the same play as the written card with its links in the text, which is what
 * goes out when there is no picture or Discord will not take the buttons. `result` is the results channel's card.
 */
export function cardMessage(play, { role = null, record = null, png = null, result = false, buttons = true } = {}) {
  const plain = result ? liveResultMessage(play, { record }) : livePlayMessage(play, { role, record });
  if (!png) return { payload: buttons ? { ...plain, components: cardButtons(play) } : plain, file: null, plain };
  const outcome = play.status === 'void' ? 'void' : play.status === 'graded' ? (play.result === 'win' ? 'win' : 'loss') : 'open';
  const payload = {
    content: cardLine(play, { role: result ? null : role }),
    allowed_mentions: { parse: [], roles: role && !result ? [role] : [] },
    // The bar Discord draws beside the picture takes the card's own accent: laser blue for a live play, violet for a lean.
    embeds: [{ color: play.lean && outcome === 'open' ? LEAN_COLOR : outcome === 'open' ? LIVE_COLOR : COLOR[outcome], image: { url: 'attachment://card.png' } }],
    attachments: [{ id: 0, filename: 'card.png' }],
    ...(buttons ? { components: cardButtons(play) } : {}),
  };
  return { payload, file: { name: 'card.png', bytes: png }, plain };
}

/**
 * One call to Discord. {ok, status, id} when it answered; {unknown: true}
 * when it did not (a timeout or a dropped connection: the message may or
 * may not be there). A short rate-limit wait is honoured once.
 */
async function call(fetcher, url, method, payload, file = null) {
  const once = async () => {
    try {
      let init;
      if (file) {
        // A picture rides beside the message: the message as payload_json, the picture as files[0].
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        form.append('files[0]', new Blob([file.bytes], { type: 'image/png' }), file.name);
        init = { method, body: form };
      } else init = { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
      const res = await fetcher(url, { ...init, signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(file ? 15000 : 8000) : undefined });
      let body = null;
      try { body = await res.json(); } catch { /* an empty answer */ }
      return { ok: res.ok, status: res.status, id: body?.id ?? null, retryAfter: Number(body?.retry_after) || null };
    } catch { return { ok: false, unknown: true }; }
  };
  let out = await once();
  // A 429 was not delivered: a wait of a couple of seconds is taken here, a longer one is left for the next tick.
  if (out.status === 429 && out.retryAfter && out.retryAfter <= 2) { await new Promise((r) => setTimeout(r, Math.ceil(out.retryAfter * 1000) + 100)); out = await once(); }
  return out;
}
const post = (fetcher, hook, payload) => call(fetcher, `${hook}?wait=true`, 'POST', payload);
/**
 * Send a card ({payload, file, plain} from cardMessage), new or over a message already posted. Buttons need
 * with_components. If Discord refuses the card outright (a 400), it is sent again with less on it: first without
 * the buttons (`refused` on the answer says they were the trouble), then as the written card with no picture
 * (`noPicture`), which is the form every earlier alert went out in.
 */
async function deliver(fetcher, hook, card, { messageId = null } = {}) {
  const rich = Boolean(card.payload.components);
  const target = (withComponents) => (messageId ? `${hook}/messages/${messageId}${withComponents ? '?with_components=true' : ''}` : `${hook}?wait=true${withComponents ? '&with_components=true' : ''}`);
  const method = messageId ? 'PATCH' : 'POST';
  // An edit that carries no picture takes an earlier one off, or the written card would sit under it.
  const body = (payload, file) => (messageId && !file ? { ...payload, attachments: [] } : payload);
  const first = await call(fetcher, target(rich), method, body(card.payload, card.file), card.file);
  if (first.ok || first.unknown || first.status !== 400 || (!rich && !card.file)) return first;
  if (rich) {
    const { components: _buttons, ...bare } = card.payload;
    const second = await call(fetcher, target(false), method, body(messageId ? { ...bare, components: [] } : bare, card.file), card.file);
    if (second.ok || second.unknown || second.status !== 400 || !card.file) return { ...second, refused: true };
  }
  const third = await call(fetcher, target(false), method, messageId ? { ...card.plain, attachments: [], components: [] } : card.plain);
  return { ...third, noPicture: true };
}

const readJson = async (env, key) => { try { const raw = await env.POTD_KV.get(key); return raw ? JSON.parse(raw) : null; } catch { return null; } };
const writeLedger = (env, ledger) => env.POTD_KV.put(DISCORD_LEDGER_KEY, JSON.stringify(ledger), { expirationTtl: LEDGER_TTL });

/** The site's record for each kind of live play over the kept days (worker/src/tennis-live-plays.js's own sums), read only when a message is about to go out. */
async function liveRecords(env, now) {
  const index = (await readJson(env, TENNIS_LIVE_PLAYS_INDEX)) ?? { dates: [] };
  const dates = [...new Set([etParts(now).date, ...index.dates])].sort().reverse().slice(0, 30);
  const all = [];
  for (const d of dates) all.push(...((await readJson(env, tennisLivePlaysKey(d)))?.plays ?? []));
  const of = (market) => liveRecordOf(all.filter((p) => !p.lean && p.market === market));
  return { ml: of('live_ml'), sets: of('live_set'), setGames: of('live_set_total') };
}

/**
 * Bring Discord level with the tracked live plays. Returns what it did:
 * {off} with no webhook, else {posted, edited, failed}. `deps.fetch`,
 * `deps.plays` and `deps.records` stand in for Discord and the stored plays
 * in tests.
 */
export async function syncLiveDiscord(env, now = Date.now(), { deps = {} } = {}) {
  const cfg = discordConfig(env);
  if (!cfg.live) return { off: true };
  const fetcher = deps.fetch ?? fetch;
  const ledger = (await readJson(env, DISCORD_LEDGER_KEY)) ?? { plays: {} };
  ledger.plays ??= {};
  const out = { posted: 0, edited: 0, failed: 0 };
  let dirty = false;
  const fail = (what, r) => { ledger.lastError = { at: now, what, status: r.unknown ? 'no answer' : r.status }; out.failed++; dirty = true; };
  const testId = deps.testId ?? TEST_ALERT_ID;
  const testScope = deps.testScope ?? TEST_SCOPE;
  // Drawing a card is the one heavy thing here, and a run that goes over its CPU allowance is ended where it stands.
  // So a marker is stored before each drawing and taken off after it: a marker still there on a later run means that
  // run died drawing, and from then on the written cards go, with no picture. A new test id tries pictures again.
  if (ledger.noPictures && ledger.noPictures.test !== testId) { delete ledger.noPictures; dirty = true; }
  if (ledger.rendering) { ledger.noPictures = { at: now, test: testId }; delete ledger.rendering; dirty = true; }
  // The card's picture (worker/src/card-render.js, loaded only here: it carries a WebAssembly renderer). No picture is not a failure: the written card goes.
  const render = deps.render ?? (async (play) => (await import('./card-render.js')).renderCardPng(play));
  const drawn = new Map();
  const picture = async (play) => {
    if (ledger.noPictures) return null;
    const key = `${play.id}:${play.status}`;
    if (drawn.has(key)) return drawn.get(key);
    ledger.rendering = { at: now, id: String(play.id).slice(0, 120) };
    await writeLedger(env, ledger);
    let png = null;
    try { png = (await render(play)) ?? null; } catch (e) { ledger.cardError = { at: now, message: String(e?.message ?? e).slice(0, 120) }; }
    delete ledger.rendering; dirty = true;
    drawn.set(key, png);
    return png;
  };
  const dress = async (play, { record = null, result = false, role = cfg.role, test = false } = {}) => {
    const card = cardMessage(play, { role, record, png: await picture(play), result, buttons: !ledger.noButtons });
    if (test) { markTest(card.payload); markTest(card.plain); }
    return card;
  };
  // Discord refused the buttons once: they are left off from then on, so every later card is one request, not two.
  const sent = (r) => {
    if (r.refused && r.ok) { ledger.noButtons = true; dirty = true; }
    if (r.noPicture && r.ok) { ledger.cardError = { at: now, message: 'Discord did not take the card with its picture; the written card went' }; dirty = true; }
    return r;
  };
  // A card drawn before the buttons were refused goes without them.
  const send = async (hook, card, opts) => { if (ledger.noButtons && card.payload.components) delete card.payload.components; return sent(await deliver(fetcher, hook, card, opts)); };

  // The first run with a webhook says so in the channel, once: the owner sees the setup works without waiting for a match.
  if (!ledger.helloAt && now - (ledger.helloTriedAt ?? 0) >= HELLO_RETRY_MS) {
    ledger.helloTriedAt = now;
    await writeLedger(env, ledger);
    const r = await post(fetcher, cfg.live, { content: '✅ **Perpetual Picks live alerts are connected.** Tracked live tennis plays post here the moment they open, and each one is updated with its result.', allowed_mentions: { parse: [] } });
    if (r.ok || r.unknown) ledger.helloAt = now; else fail('hello', r);
    dirty = true;
  }

  // The test alert (TEST_ALERT_ID): posted once per value, then edited on a later tick to its settled form.
  // Each card is drawn before the test is marked as sending: a run that dies drawing has sent nothing, and the next sends it written.
  const testRecord = { wins: 9, losses: 2, units: 3.86 };
  if (testId && ledger.test?.id !== testId && (testScope === 'cards' || testScope === 'cards+leans' || testScope === 'pair')) {
    // One card for each template, in the live channel, with their buttons: nobody is pinged. With 'cards+leans' the two lean cards follow, in the leans channel.
    const cards = [];
    const pair = testScope === 'pair';
    for (const play of Object.values(testPlays(now)).slice(0, pair ? 1 : 4)) cards.push(await dress(play, { record: testRecord, role: null, test: true }));
    const leanCards = [];
    if (testScope !== 'cards' && cfg.leans) for (const play of Object.values(testLeans(now)).slice(0, pair ? 1 : 2)) leanCards.push(await dress(play, { role: null, test: true }));
    ledger.test = { id: testId, state: 'sending', at: now };
    await writeLedger(env, ledger);
    let ok = 0; let pictures = 0;
    for (const card of cards) {
      const r = await send(cfg.live, card);
      if (r.ok) { ok++; if (card.file && !r.noPicture) pictures++; } else fail('test card', r);
    }
    let leansOk = 0;
    for (const card of leanCards) {
      const r = await send(cfg.leans, card);
      if (r.ok) { leansOk++; if (card.file && !r.noPicture) pictures++; } else fail('test lean', r);
    }
    ledger.test = { id: testId, state: ok === cards.length && leansOk === leanCards.length ? 'done' : 'failed', at: now, cards: ok, pictures, buttons: !ledger.noButtons, ...(testScope !== 'cards' ? { leans: leansOk } : {}) };
    dirty = true;
  } else if (testId && ledger.test?.id !== testId && testScope === 'leans') {
    // The leans channel: a lean as it opens and one that has won, marked as a test. Nobody is pinged there.
    const cards = [];
    if (cfg.leans) for (const play of Object.values(testLeans(now))) cards.push(await dress(play, { role: null, test: true }));
    ledger.test = { id: testId, state: 'sending', at: now };
    await writeLedger(env, ledger);
    let ok = 0; let pictures = 0;
    for (const card of cards) {
      const r = await send(cfg.leans, card);
      if (r.ok) { ok++; if (card.file && !r.noPicture) pictures++; } else fail('test lean', r);
    }
    ledger.test = { id: testId, state: !cfg.leans ? 'no leans channel' : ok === cards.length ? 'done' : 'failed', at: now, leans: ok, pictures, buttons: !ledger.noButtons };
    dirty = true;
  } else if (testId && ledger.test?.id !== testId && testScope === 'results') {
    // The result cards alone, a win and a loss, in the results channel: nobody is pinged.
    const plays = testPlays(now);
    const cards = [];
    if (cfg.updates) for (const play of [plays['test-won'], plays['test-lost']]) cards.push(await dress(play, { record: testRecord, result: true, test: true }));
    ledger.test = { id: testId, state: 'sending', at: now };
    await writeLedger(env, ledger);
    let state = cfg.updates ? 'sent' : 'no results channel';
    for (const card of cards) {
      const u = await send(cfg.updates, card);
      if (!u.ok) { state = 'failed'; fail('test result', u); }
    }
    ledger.test = { id: testId, state: 'done', at: now, updates: state };
    dirty = true;
  } else if (testId && ledger.test?.id !== testId) {
    const card = await dress(testPlays(now)['test-live'], { record: testRecord, test: true });
    ledger.test = { id: testId, state: 'sending', at: now };
    await writeLedger(env, ledger);
    const r = await send(cfg.live, card);
    if (r.ok && r.id) ledger.test = { id: testId, state: 'open', at: now, messageId: String(r.id) };
    else { ledger.test = { id: testId, state: 'failed', at: now }; fail('test', r); }
    dirty = true;
  } else if (ledger.test?.state === 'open' && ledger.test.messageId && now - ledger.test.at >= 50e3) {
    const won = testPlays(ledger.test.at)['test-won'];
    const r = await send(cfg.live, await dress(won, { record: testRecord, test: true }), { messageId: ledger.test.messageId });
    ledger.test = { id: ledger.test.id, state: r.ok ? 'done' : 'edit failed', at: ledger.test.at, doneAt: now };
    if (!r.ok) fail('test edit', r);
    // The results channel gets the test's result card too, as it would a real play's, marked as a test.
    if (cfg.updates) {
      const u = await send(cfg.updates, await dress(won, { record: testRecord, result: true, test: true }));
      ledger.test.updates = u.ok ? 'sent' : 'failed';
      if (!u.ok) fail('test update', u);
    }
    dirty = true;
  }

  const today = etParts(now).date; const yesterday = etParts(now - 864e5).date;
  const plays = deps.plays ? await deps.plays() : [...((await readJson(env, tennisLivePlaysKey(today)))?.plays ?? []), ...((await readJson(env, tennisLivePlaysKey(yesterday)))?.plays ?? [])];
  const tracked = plays.filter((p) => p && !p.lean && p.id && KIND[p.market]);
  let records = null;
  const recordFor = async (p) => { records ??= deps.records ? await deps.records() : await liveRecords(env, now).catch(() => ({})); return records?.[KIND[p.market].record] ?? null; };

  // The leans go to their own channel, when there is one: posted as they open and edited when they settle, like a
  // play, but with nobody pinged, no record under them and nothing sent to the results channel.
  const leans = cfg.leans ? plays.filter((p) => p && p.lean && p.id && KIND[p.market]) : [];
  for (const p of [...tracked, ...leans]) {
    const lean = Boolean(p.lean);
    const hook = lean ? cfg.leans : cfg.live;
    const mine = async (more = {}) => dress(p, { record: lean ? null : await recordFor(p), ...(lean ? { role: null } : {}), ...more });
    const entry = ledger.plays[p.id];
    const settled = p.status === 'graded' || p.status === 'void';
    if (!entry) {
      // A new alert: open, and fresh enough that its price is still there to take.
      if (settled || p.status !== 'pending' || now - (p.postedAt ?? 0) > FRESH_MS) continue;
      // Drawn first, then marked as sending: a run that dies drawing has posted nothing, and the next tick posts it written.
      const card = await mine();
      ledger.plays[p.id] = { state: 'sending', at: now, tries: 1 };
      await writeLedger(env, ledger);
      const r = await send(hook, card);
      if (r.ok && r.id) { ledger.plays[p.id] = { state: 'open', at: now, messageId: String(r.id), tries: 1, lv: LINK_VERSION }; ledger.lastPostAt = now; out.posted++; }
      // No answer: it may be in the channel, so it is not sent again. Refused: it is not, so the next tick tries again.
      else if (r.unknown || r.ok) { ledger.plays[p.id] = { state: 'lost', at: now }; fail('post', r); }
      else { ledger.plays[p.id] = { state: 'retry', at: now, tries: 1 }; fail('post', r); }
      dirty = true;
      continue;
    }
    if (entry.state === 'retry') {
      if (settled || now - (p.postedAt ?? 0) > FRESH_MS || (entry.tries ?? 1) >= POST_TRIES) { ledger.plays[p.id] = { state: 'failed', at: entry.at }; dirty = true; continue; }
      const card = await mine();
      ledger.plays[p.id] = { state: 'sending', at: entry.at, tries: (entry.tries ?? 1) + 1 };
      await writeLedger(env, ledger);
      const r = await send(hook, card);
      if (r.ok && r.id) { ledger.plays[p.id] = { state: 'open', at: entry.at, messageId: String(r.id), lv: LINK_VERSION }; ledger.lastPostAt = now; out.posted++; }
      else if (r.unknown || r.ok) { ledger.plays[p.id] = { state: 'lost', at: entry.at }; fail('post', r); }
      else { ledger.plays[p.id] = { state: 'retry', at: entry.at, tries: (entry.tries ?? 1) + 1 }; fail('post', r); }
      dirty = true;
      continue;
    }
    // Posted and now settled: the same message says how it ended.
    if (entry.state === 'open' && entry.messageId && settled) {
      const r = await send(hook, await mine(), { messageId: entry.messageId });
      if (r.ok) {
        ledger.plays[p.id] = { ...entry, state: 'done', doneAt: now, lv: LINK_VERSION };
        out.edited++;
        if (cfg.updates && !lean) { const u = await send(cfg.updates, await mine({ result: true })); if (!u.ok && !u.unknown) fail('update', u); }
      } else {
        const tries = (entry.editTries ?? 0) + 1;
        // The message is gone (deleted by hand) or the edit keeps failing: stop trying.
        ledger.plays[p.id] = r.status === 404 || tries >= EDIT_TRIES ? { ...entry, state: 'done', doneAt: now, editFailed: true, lv: LINK_VERSION } : { ...entry, editTries: tries };
        fail('edit', r);
      }
      dirty = true;
    }
  }
  // A message posted with older links (the worker's own address under its buttons) is edited once, as it stands,
  // so they come off it: a few a tick, open or settled, and never again once it has taken or the message is gone.
  let relinked = 0;
  for (const p of [...tracked, ...leans]) {
    const entry = ledger.plays[p.id];
    if (relinked >= RELINK_A_TICK || !entry?.messageId || (entry.lv ?? 1) >= LINK_VERSION || !['open', 'done'].includes(entry.state)) continue;
    // An open message whose play has settled is the loop above's to edit, and that edit carries the new links.
    if (entry.state === 'open' && (p.status === 'graded' || p.status === 'void')) continue;
    relinked++;
    const lean = Boolean(p.lean);
    const r = await send(lean ? cfg.leans : cfg.live, await dress(p, { record: lean ? null : await recordFor(p), ...(lean ? { role: null } : {}) }), { messageId: entry.messageId });
    const tries = (entry.lvTries ?? 0) + 1;
    if (r.ok || r.status === 404 || tries >= 3) ledger.plays[p.id] = { ...entry, lv: LINK_VERSION };
    else { ledger.plays[p.id] = { ...entry, lvTries: tries }; fail('relink', r); }
    dirty = true;
  }
  // A marker left by a run that never finished: its post may or may not have landed, so it is closed, not repeated.
  for (const [id, e] of Object.entries(ledger.plays)) {
    if (e.state === 'sending' && now - (e.at ?? 0) > 2 * 60e3) { ledger.plays[id] = { state: 'lost', at: e.at }; dirty = true; }
    else if (now - (e.at ?? 0) > LEDGER_KEEP_MS) { delete ledger.plays[id]; dirty = true; }
  }
  if (dirty) await writeLedger(env, ledger);
  return out;
}

/**
 * Where a card's book link goes for the person who tapped it (GET /go/<play>/<book>): the link stored on that play
 * for that book, with the reader's state filled in (Caesars and BetMGM put it in the address) and, on a phone, Hard
 * Rock's shared-bet form. Only a link the site itself stored on a play can be reached, so the route cannot be used
 * to send anyone anywhere else. With no such link, or one that cannot be finished (no state known), the book's own
 * front page, else the site.
 */
/**
 * A live play or a live lean by its id, for the card, the stats page and the book links: today's and yesterday's
 * first, then the kept days, newest first. The test cards' plays answer to their own ids. Null when it is not on file.
 */
export async function findLivePlay(env, playId, now = Date.now()) {
  const id = String(playId ?? '');
  if (isTestId(id)) return testPlays(now)[id] ?? testLeans(now)[id] ?? null;
  if (!id || id.length > 120) return null;
  const tried = new Set();
  const look = async (date) => { if (tried.has(date)) return null; tried.add(date); return ((await readJson(env, tennisLivePlaysKey(date)))?.plays ?? []).find((p) => p.id === id) ?? null; };
  for (const d of [etParts(now).date, etParts(now - 864e5).date]) { const hit = await look(d); if (hit) return hit; }
  const index = (await readJson(env, TENNIS_LIVE_PLAYS_INDEX)) ?? { dates: [] };
  for (const d of [...index.dates].sort().reverse().slice(0, 62)) { const hit = await look(d); if (hit) return hit; }
  return null;
}
/** The site's record for the kind of play this is ({wins, losses, units}), or null. */
export async function recordForPlay(env, play, now = Date.now()) {
  // A lean is on no record.
  if (play?.lean) return null;
  if (isTestId(play?.id)) return { wins: 9, losses: 2, units: 3.86 };
  const records = await liveRecords(env, now).catch(() => null);
  return records?.[KIND[play?.market]?.record] ?? null;
}

export async function bookRedirect(env, playId, bookId, { region = null, userAgent = '', now = Date.now() } = {}) {
  const fallback = /^https:\/\//.test(SPORTSBOOKS[bookId]?.url ?? '') ? SPORTSBOOKS[bookId].url : SITE;
  if (isTestId(playId)) return fallback;
  const play = await findLivePlay(env, playId, now);
  const raw = (play?.quotes ?? []).find((q) => q.bookId === bookId)?.link ?? (play?.bookId === bookId ? play.link : null);
  if (!raw || !/^https:\/\//.test(raw)) return fallback;
  let url = withState(raw, region);
  if (!url || /[{}]|%7B/i.test(url)) return fallback;
  if (isPhone(userAgent)) url = phoneSlipLink(url) ?? url;
  return /^https:\/\/[^\s<>]+$/.test(url) ? url : fallback;
}

/** What a probe may know: whether it is set up and whether it is working. No address, no message id. */
export async function discordStatus(env) {
  const cfg = discordConfig(env);
  const ledger = (await readJson(env, DISCORD_LEDGER_KEY)) ?? { plays: {} };
  const counts = {};
  for (const e of Object.values(ledger.plays ?? {})) counts[e.state] = (counts[e.state] ?? 0) + 1;
  return {
    live: Boolean(cfg.live), updates: Boolean(cfg.updates), leans: Boolean(cfg.leans), role: Boolean(cfg.role),
    // Set but not a Discord webhook address: the leans secret is there and wrong.
    leansSecretRejected: Boolean(String(env?.DISCORD_LIVE_LEAN_WEBHOOK ?? '').trim()) && !cfg.leans,
    // Set but not a Discord webhook address: the secret is there and wrong.
    liveSecretRejected: Boolean(String(env?.DISCORD_LIVE_WEBHOOK ?? '').trim()) && !cfg.live,
    // The role: found under its name at all, and if found, whether it is a role id (digits only).
    roleSecretFound: Boolean(String(env?.DISCORD_LIVE_ROLE_ID ?? '').trim()),
    roleSecretRejected: Boolean(String(env?.DISCORD_LIVE_ROLE_ID ?? '').trim()) && !cfg.role,
    test: ledger.test ? { id: ledger.test.id, state: ledger.test.state, at: ledger.test.at ?? null, ...(ledger.test.updates ? { updates: ledger.test.updates } : {}), ...(ledger.test.cards != null ? { cards: ledger.test.cards } : {}), ...(ledger.test.leans != null ? { leans: ledger.test.leans } : {}), ...(ledger.test.cards != null || ledger.test.leans != null ? { pictures: ledger.test.pictures, buttons: ledger.test.buttons } : {}) } : null,
    // Whether Discord took the buttons, and the last reason a card's picture could not be drawn.
    buttons: !ledger.noButtons, pictures: !ledger.noPictures, cardError: ledger.cardError ?? null,
    helloAt: ledger.helloAt ?? null, lastPostAt: ledger.lastPostAt ?? null, lastError: ledger.lastError ?? null, plays: counts,
  };
}
