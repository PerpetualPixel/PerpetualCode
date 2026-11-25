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
 * edit), and DISCORD_UPDATES_WEBHOOK gets one short line per result.
 *
 * The webhook URL is a credential: it is read from the environment, never
 * logged, and never returned by a route.
 */
import { etParts } from './potd.js';
import { tennisLivePlaysKey, liveRecordOf, TENNIS_LIVE_PLAYS_INDEX } from './tennis-live-plays.js';

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
const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const SNOWFLAKE = /^\d{5,25}$/;
const COLOR = { open: 0x8b5cf6, win: 0x22c55e, loss: 0xef4444, void: 0x6b7280 };
const TOUR = { atp: 'ATP', wta: 'WTA' };

/**
 * A test alert, sent once per value (2026-11-25, the owner, with the webhook and the role in place: "Can you send a
 * test"). The worker cannot be asked to post from outside without a credential, so the test rides a deploy: change
 * this value and the next tick posts one sample play, marked as a test, with the role ping; the tick after edits it
 * to its settled form. That is the whole path a real play takes.
 */
export const TEST_ALERT_ID = '2026-11-25-2';
const TEST_PLAY = { id: 'test', market: 'live_ml', tour: 'atp', event: 'Test alert', round: 'not a real play', a: 'Test Player', b: 'Sample Opponent', side: 'a', prob: 0.69, american: -175, playable: -190, book: 'FanDuel', units: 1, selection: 'Test Player to win the match (live)', score: '6-0 3-4', status: 'pending' };
/** The sample alert: a real alert's shape, with TEST in its title and its footer so nobody takes it for a play. */
export function testAlertMessage(now, { role = null, settled = false } = {}) {
  const play = settled ? { ...TEST_PLAY, postedAt: now, status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6' } : { ...TEST_PLAY, postedAt: now };
  const msg = livePlayMessage(play, { role, record: { wins: 8, losses: 2, units: 3.29 } });
  msg.embeds[0].title = `🧪 TEST · ${msg.embeds[0].title}`.slice(0, 250);
  msg.embeds[0].footer = { text: 'Perpetual Picks · TEST ALERT · not a real play' };
  return msg;
}

/** The role id as Discord gives it, or however it was pasted (a mention <@&123>, in quotes, after a label): the one long number in the value. A name has none. */
const roleOf = (v) => { const ids = String(v ?? '').match(/\d{15,22}/g) ?? []; return ids.length === 1 ? ids[0] : String(v ?? '').trim(); };
/** What is configured: the webhooks (null when unset or not a Discord webhook URL) and the role to ping. */
export function discordConfig(env) {
  const hook = (v) => { const s = String(v ?? '').trim(); return WEBHOOK.test(s) ? s : null; };
  const role = roleOf(env?.DISCORD_LIVE_ROLE_ID);
  return { live: hook(env?.DISCORD_LIVE_WEBHOOK), updates: hook(env?.DISCORD_UPDATES_WEBHOOK), role: SNOWFLAKE.test(role) ? role : null };
}

const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const implied = (american) => (american > 0 ? 100 / (american + 100) : -american / (-american + 100));
const pct = (x) => `${Math.round(x * 100)}%`;
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const unitsOf = (u) => `${Math.round((u ?? 1) * 100) / 100}u`;
/** Text from the feed, safe inside Discord markdown. */
const md = (s) => String(s ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1').slice(0, 200);
/** A book link the message can carry: https, and complete (a link with a {state} left in it opens nothing). */
const linkOf = (url) => { const s = String(url ?? ''); return /^https:\/\/[^\s<>]+$/.test(s) && !/[{}]|%7B/i.test(s) ? s : null; };

/** The three kinds of live play, by the words a bettor uses. */
const KIND = {
  live_ml: { head: () => 'Match Winner', record: 'ml' },
  live_set: { head: (p) => `Set ${p.set} Winner`, record: 'sets' },
  live_set_total: { head: (p) => `Set ${p.set} Games`, record: 'setGames' },
};

/**
 * The message for a play: the alert while it is open, the same message
 * with how it ended once it has settled. `record` is the site's own record
 * for this kind of play ({wins, losses, units}), `role` the role to ping.
 */
export function livePlayMessage(play, { role = null, record = null } = {}) {
  const kind = KIND[play.market] ?? KIND.live_ml;
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const settled = play.status === 'graded' || play.status === 'void';
  const outcome = play.status === 'void' ? 'void' : play.result === 'win' ? 'win' : play.result === 'loss' ? 'loss' : 'open';
  const take = String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, '');
  const priceLine = priced
    ? `**${fmt(play.american)} at ${md(play.book ?? 'the book')}**${Number.isFinite(play.playable) && play.playable < play.american ? ` · good to ${fmt(play.playable)}` : ''}`
    : `**Take it at ${fmt(price)} or better**`;
  const link = linkOf(play.link);
  const lines = [
    settled ? `**${{ win: '✅ WON', loss: '❌ LOST', void: '⚪ VOID' }[outcome]}${play.actual ? ` · final ${md(play.actual)}` : ''}${outcome === 'void' ? ' · stake returned' : Number.isFinite(play.profit) ? ` · ${signedUnits(play.profit)}` : ''}**` : null,
    `${priceLine} · ${unitsOf(play.units)}`,
    `${md(play.a)} vs ${md(play.b)}`,
    [TOUR[play.tour] ?? null, play.event ? md(play.event) : null, play.round ? md(play.round) : null].filter(Boolean).join(' · ') || null,
    link && !settled ? `[Open at ${md(play.book ?? 'the book')}](${link})` : null,
  ].filter(Boolean);
  const fields = [
    Number.isFinite(price) ? { name: priced ? 'Price' : 'Price to take', value: `${fmt(price)} · needs ${pct(implied(price))}`, inline: true } : null,
    Number.isFinite(play.prob) ? { name: 'Our read', value: pct(play.prob), inline: true } : null,
    play.score ? { name: 'Score when taken', value: md(play.score), inline: true } : null,
    record && record.wins + record.losses > 0 ? { name: `Our ${kind.head(play).replace(/^Set \d+ /, 'Set ')} record`, value: `${record.wins}-${record.losses} · ${signedUnits(record.units)}`, inline: false } : null,
  ].filter(Boolean);
  return {
    // The ping rides the first post only; an edit re-sends the same text and Discord does not ping again.
    content: role ? `<@&${role}>` : '',
    allowed_mentions: { parse: [], roles: role ? [role] : [] },
    embeds: [{
      title: `🎾 ${kind.head(play)} — Take ${md(take)}`.slice(0, 250),
      url: SITE,
      description: lines.join('\n').slice(0, 3900),
      color: COLOR[outcome],
      fields,
      footer: { text: 'Perpetual Picks · live tennis · tracked play' },
      timestamp: new Date(play.postedAt ?? Date.now()).toISOString(),
    }],
  };
}

/** One line for the updates channel when a play settles. */
export function liveResultLine(play) {
  const outcome = play.status === 'void' ? '⚪ VOID' : play.result === 'win' ? '✅ WON' : '❌ LOST';
  const take = String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, '');
  return { content: `${outcome} · ${md(take)} · ${md(play.a)} vs ${md(play.b)}${play.actual ? ` · ${md(play.actual)}` : ''}${play.status === 'void' ? '' : Number.isFinite(play.profit) ? ` · ${signedUnits(play.profit)}` : ''}`.slice(0, 1900), allowed_mentions: { parse: [] } };
}

/**
 * One call to Discord. {ok, status, id} when it answered; {unknown: true}
 * when it did not (a timeout or a dropped connection: the message may or
 * may not be there). A short rate-limit wait is honoured once.
 */
async function call(fetcher, url, method, payload) {
  const once = async () => {
    try {
      const res = await fetcher(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined });
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
const edit = (fetcher, hook, id, payload) => call(fetcher, `${hook}/messages/${id}`, 'PATCH', payload);

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

  // The first run with a webhook says so in the channel, once: the owner sees the setup works without waiting for a match.
  if (!ledger.helloAt && now - (ledger.helloTriedAt ?? 0) >= HELLO_RETRY_MS) {
    ledger.helloTriedAt = now;
    await writeLedger(env, ledger);
    const r = await post(fetcher, cfg.live, { content: '✅ **Perpetual Picks live alerts are connected.** Tracked live tennis plays post here the moment they open, and each one is updated with its result.', allowed_mentions: { parse: [] } });
    if (r.ok || r.unknown) ledger.helloAt = now; else fail('hello', r);
    dirty = true;
  }

  // The test alert (TEST_ALERT_ID): posted once per value, then edited on a later tick to its settled form.
  const testId = deps.testId ?? TEST_ALERT_ID;
  if (testId && ledger.test?.id !== testId) {
    ledger.test = { id: testId, state: 'sending', at: now };
    await writeLedger(env, ledger);
    const r = await post(fetcher, cfg.live, testAlertMessage(now, { role: cfg.role }));
    if (r.ok && r.id) ledger.test = { id: testId, state: 'open', at: now, messageId: String(r.id) };
    else { ledger.test = { id: testId, state: 'failed', at: now }; fail('test', r); }
    dirty = true;
  } else if (ledger.test?.state === 'open' && ledger.test.messageId && now - ledger.test.at >= 50e3) {
    const r = await edit(fetcher, cfg.live, ledger.test.messageId, testAlertMessage(ledger.test.at, { role: cfg.role, settled: true }));
    ledger.test = { id: ledger.test.id, state: r.ok ? 'done' : 'edit failed', at: ledger.test.at, doneAt: now };
    if (!r.ok) fail('test edit', r);
    // The updates channel gets the test's result line too, as it would a real play's, marked as a test.
    if (cfg.updates) {
      const line = liveResultLine({ ...TEST_PLAY, status: 'graded', result: 'win', profit: 0.57, actual: '6-0 4-6 7-6' });
      const u = await post(fetcher, cfg.updates, { ...line, content: `🧪 TEST (not a real play) · ${line.content}` });
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

  for (const p of tracked) {
    const entry = ledger.plays[p.id];
    const settled = p.status === 'graded' || p.status === 'void';
    if (!entry) {
      // A new alert: open, and fresh enough that its price is still there to take.
      if (settled || p.status !== 'pending' || now - (p.postedAt ?? 0) > FRESH_MS) continue;
      ledger.plays[p.id] = { state: 'sending', at: now, tries: 1 };
      await writeLedger(env, ledger);
      const r = await post(fetcher, cfg.live, livePlayMessage(p, { role: cfg.role, record: await recordFor(p) }));
      if (r.ok && r.id) { ledger.plays[p.id] = { state: 'open', at: now, messageId: String(r.id), tries: 1 }; ledger.lastPostAt = now; out.posted++; }
      // No answer: it may be in the channel, so it is not sent again. Refused: it is not, so the next tick tries again.
      else if (r.unknown || r.ok) { ledger.plays[p.id] = { state: 'lost', at: now }; fail('post', r); }
      else { ledger.plays[p.id] = { state: 'retry', at: now, tries: 1 }; fail('post', r); }
      dirty = true;
      continue;
    }
    if (entry.state === 'retry') {
      if (settled || now - (p.postedAt ?? 0) > FRESH_MS || (entry.tries ?? 1) >= POST_TRIES) { ledger.plays[p.id] = { state: 'failed', at: entry.at }; dirty = true; continue; }
      ledger.plays[p.id] = { state: 'sending', at: entry.at, tries: (entry.tries ?? 1) + 1 };
      await writeLedger(env, ledger);
      const r = await post(fetcher, cfg.live, livePlayMessage(p, { role: cfg.role, record: await recordFor(p) }));
      if (r.ok && r.id) { ledger.plays[p.id] = { state: 'open', at: entry.at, messageId: String(r.id) }; ledger.lastPostAt = now; out.posted++; }
      else if (r.unknown || r.ok) { ledger.plays[p.id] = { state: 'lost', at: entry.at }; fail('post', r); }
      else { ledger.plays[p.id] = { state: 'retry', at: entry.at, tries: (entry.tries ?? 1) + 1 }; fail('post', r); }
      dirty = true;
      continue;
    }
    // Posted and now settled: the same message says how it ended.
    if (entry.state === 'open' && entry.messageId && settled) {
      const r = await edit(fetcher, cfg.live, entry.messageId, livePlayMessage(p, { role: cfg.role, record: await recordFor(p) }));
      if (r.ok) {
        ledger.plays[p.id] = { ...entry, state: 'done', doneAt: now };
        out.edited++;
        if (cfg.updates) { const u = await post(fetcher, cfg.updates, liveResultLine(p)); if (!u.ok && !u.unknown) fail('update', u); }
      } else {
        const tries = (entry.editTries ?? 0) + 1;
        // The message is gone (deleted by hand) or the edit keeps failing: stop trying.
        ledger.plays[p.id] = r.status === 404 || tries >= EDIT_TRIES ? { ...entry, state: 'done', doneAt: now, editFailed: true } : { ...entry, editTries: tries };
        fail('edit', r);
      }
      dirty = true;
    }
  }
  // A marker left by a run that never finished: its post may or may not have landed, so it is closed, not repeated.
  for (const [id, e] of Object.entries(ledger.plays)) {
    if (e.state === 'sending' && now - (e.at ?? 0) > 2 * 60e3) { ledger.plays[id] = { state: 'lost', at: e.at }; dirty = true; }
    else if (now - (e.at ?? 0) > LEDGER_KEEP_MS) { delete ledger.plays[id]; dirty = true; }
  }
  if (dirty) await writeLedger(env, ledger);
  return out;
}

/** What a probe may know: whether it is set up and whether it is working. No address, no message id. */
export async function discordStatus(env) {
  const cfg = discordConfig(env);
  const ledger = (await readJson(env, DISCORD_LEDGER_KEY)) ?? { plays: {} };
  const counts = {};
  for (const e of Object.values(ledger.plays ?? {})) counts[e.state] = (counts[e.state] ?? 0) + 1;
  return {
    live: Boolean(cfg.live), updates: Boolean(cfg.updates), role: Boolean(cfg.role),
    // Set but not a Discord webhook address: the secret is there and wrong.
    liveSecretRejected: Boolean(String(env?.DISCORD_LIVE_WEBHOOK ?? '').trim()) && !cfg.live,
    // The role: found under its name at all, and if found, whether it is a role id (digits only).
    roleSecretFound: Boolean(String(env?.DISCORD_LIVE_ROLE_ID ?? '').trim()),
    roleSecretRejected: Boolean(String(env?.DISCORD_LIVE_ROLE_ID ?? '').trim()) && !cfg.role,
    test: ledger.test ? { id: ledger.test.id, state: ledger.test.state, at: ledger.test.at ?? null, ...(ledger.test.updates ? { updates: ledger.test.updates } : {}) } : null,
    helloAt: ledger.helloAt ?? null, lastPostAt: ledger.lastPostAt ?? null, lastError: ledger.lastError ?? null, plays: counts,
  };
}
