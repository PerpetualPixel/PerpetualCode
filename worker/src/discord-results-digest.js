/**
 * The results channel's daily and weekly roll-ups (2026-11-25, the owner:
 * "for the tennis results channel, I want them to post and retain the
 * daily results all together. then post a weekly one").
 *
 * The results channel already gets one card per settled live tennis play
 * (worker/src/discord.js, DISCORD_UPDATES_WEBHOOK). Those stay. This adds,
 * once a day at DIGEST_HOUR ET (6am, after the overnight sessions are in),
 * one message with every play that settled in the 24 hours before it —
 * the day's results together, with the day's record — and every Monday at
 * the same hour one message with the week, day by day, and its totals.
 * Both go through the same webhook, so they sit in the same channel with
 * the same name and picture, and both open with Playbook's tag when its
 * id is known (DISCORD_PLAYBOOK_USER_ID / DISCORD_PLAYBOOK_ROLE_ID, or the
 * id saved in the app's Playbook settings; worker/src/discord-nba.js's
 * playbookTag).
 *
 * The plays come from the worker's own records (worker/src/
 * tennis-live-plays.js, one record per ET date), never from reading the
 * channel back: the worker is what posted them, so it needs no bot and no
 * Discord read permission. A day's window is DIGEST_HOUR ET to DIGEST_HOUR
 * ET; a play belongs to the window its settling (gradedAt) fell in, so an
 * overnight match counts with the day it was played.
 *
 * Once each: a KV record per day and per week (DIGEST_DAY_KEY /
 * DIGEST_WEEK_KEY) is written after the post lands, so the three ticks in
 * the hour post one message between them, and a forced run (the owner's
 * route) of a day already posted does nothing. A day with nothing settled
 * posts nothing and records nothing. The weekly roll-up is built from the
 * plays, not from the daily posts, so a morning the worker missed does not
 * leave a hole in the week.
 */
import { deliver, readJson, discordConfig } from './discord.js';
import { playbookTag, mayPing } from './discord-nba.js';
import { tennisLivePlaysKey, liveRecordOf } from './tennis-live-plays.js';
import { SPORTSBOOKS } from '../../docs/engine.js';

export const DIGEST_HOUR = 6; // 6am ET, every day; the weekly on Monday
export const WEEKLY_WEEKDAY = 'Mon';
export const DIGEST_DAY_KEY = (dateKey) => `discord:digest:day:${dateKey}`;
export const DIGEST_WEEK_KEY = (dateKey) => `discord:digest:week:${dateKey}`;
export const DIGEST_STATUS_KEY = 'discord:digest:status';
const RECORD_TTL = 35 * 86400;
const SITE = 'https://perpetualpicks.com/app.html';
const LOGO = 'https://perpetualpicks.com/assets/logo-icon-180.png';
const COLOR = { up: 0x10b981, down: 0xef4444, flat: 0x9c98b8, week: 0xff007a };
/** Discord's limits: an embed description, and what one message's embeds may hold together. */
const DESCRIPTION_MAX = 4000;
const TOUR = { atp: 'ATP', wta: 'WTA' };
const DAY_MS = 86400e3;

/* ---------- ET clock (the same Intl approach as the rest of the worker, with weekday and minute) ---------- */

export function etClock(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** The instant of `hour`:00 ET on the ET date `dateKey`, right on both sides of a clock change. */
export function etInstant(dateKey, hour) {
  const [y, m, d] = dateKey.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour + 5, 0, 0); // ET is UTC-5 or UTC-4
  for (let i = 0; i < 3; i++) {
    const got = etClock(guess);
    const dayShift = got.date === dateKey ? 0 : (got.date < dateKey ? 1 : -1);
    const diff = (hour - got.hour) + dayShift * 24;
    if (diff === 0) break;
    guess += diff * 3600e3;
  }
  return guess;
}

export const shiftDate = (dateKey, days) => etClock(etInstant(dateKey, 12) + days * DAY_MS).date;

/** The window the digest posted on the morning of `dateKey` covers, and the day it is labelled with (the day before). */
export function digestWindow(dateKey) {
  const playedDateKey = shiftDate(dateKey, -1);
  return { startMs: etInstant(playedDateKey, DIGEST_HOUR), endMs: etInstant(dateKey, DIGEST_HOUR), playedDateKey };
}

const longDay = (dateKey) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).format(etInstant(dateKey, 12));
const shortDay = (dateKey) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(etInstant(dateKey, 12));

/* ---------- the plays ---------- */

const settledAt = (p) => Number(p.gradedAt ?? p.postedAt ?? 0);
const isSettled = (p) => p && p.id && (p.status === 'graded' || p.status === 'void');

/** The plays that settled inside [startMs, endMs), oldest settled first, each once. */
export function settledIn(plays, startMs, endMs) {
  const seen = new Set();
  return (plays ?? [])
    .filter((p) => isSettled(p) && settledAt(p) >= startMs && settledAt(p) < endMs && !seen.has(p.id) && seen.add(p.id))
    .sort((a, b) => settledAt(a) - settledAt(b));
}

/** Every stored play that could have settled in the window: the records of the day before it, its days, and the day after. */
async function playsAround(env, startMs, endMs, deps) {
  const dates = new Set();
  for (let ms = startMs - DAY_MS; ms <= endMs + DAY_MS; ms += DAY_MS) dates.add(etClock(ms).date);
  const all = [];
  for (const d of [...dates].sort()) all.push(...(deps.plays ? await deps.plays(d) : ((await readJson(env, tennisLivePlaysKey(d)))?.plays ?? [])));
  return all;
}

/* ---------- the words ---------- */

const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const md = (s) => String(s ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1').slice(0, 200);

/** One settled play in a line: how it ended, the bet, the final score, the units, the price and book, the match. */
export function resultLine(play) {
  const outcome = play.status === 'void' ? 'void' : play.result === 'win' ? 'win' : 'loss';
  const lean = Boolean(play.lean);
  const mark = { win: '✅', loss: '❌', void: '⚪' }[outcome];
  const take = md(String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, ''));
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const parts = [
    `${mark} ${lean ? 'Lean · ' : ''}**${take}**`,
    outcome === 'void' ? (play.actual ? `Void · ${md(play.actual)}` : 'Void') : (play.actual ? `Final ${md(play.actual)}` : null),
    !lean && outcome !== 'void' && Number.isFinite(play.profit) ? `**${signedUnits(play.profit)}**` : null,
    Number.isFinite(price) ? `${fmt(price)}${priced ? ` at ${md(SPORTSBOOKS[play.bookId]?.name ?? play.book ?? 'the book')}` : ' or better'}` : null,
    [`${md(play.a)} vs ${md(play.b)}`, TOUR[play.tour] ?? null].filter(Boolean).join(' · '),
  ].filter(Boolean);
  return parts.join(' · ');
}

const recordWords = (r) => `${r.wins}-${r.losses}${r.voids ? `-${r.voids}` : ''}`;
const roiWords = (r) => (r.roi == null ? '' : ` · ROI ${r.roi < 0 ? '−' : '+'}${Math.abs(r.roi * 100).toFixed(1)}%`);

/** The record line for a set of plays: the tracked plays' record and units, and the leans' record beside it. */
export function recordLine(plays) {
  const tracked = liveRecordOf(plays.filter((p) => !p.lean));
  const leans = liveRecordOf(plays.filter((p) => p.lean));
  const out = [];
  if (tracked.wins + tracked.losses + tracked.voids > 0) out.push(`Record ${recordWords(tracked)} · ${signedUnits(tracked.units)}${roiWords(tracked)}`);
  if (leans.wins + leans.losses + leans.voids > 0) out.push(`Leans ${recordWords(leans)}`);
  return out.join(' · ');
}

const colorFor = (plays) => { const r = liveRecordOf(plays.filter((p) => !p.lean)); return r.units > 0 ? COLOR.up : r.units < 0 ? COLOR.down : COLOR.flat; };

/** Lines into embed descriptions no longer than `max` each, split between lines. */
export function packLines(lines, max = DESCRIPTION_MAX) {
  const out = [];
  let cur = '';
  for (const raw of lines) {
    const line = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > max && cur) { out.push(cur); cur = line; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The daily post: {content, allowed_mentions, embeds}. The content is Playbook's tag, when known; the first embed
 * is titled with the day and carries the record in its footer; a long day runs on into further embeds.
 */
export function dailyDigestMessage(playedDateKey, plays, { playbook = null } = {}) {
  const lines = plays.map(resultLine);
  const pages = packLines(lines);
  const record = recordLine(plays);
  const title = `📊 TENNIS RESULTS · ${longDay(playedDateKey)} · ${plays.length} play${plays.length === 1 ? '' : 's'}`;
  const embeds = pages.map((description, i) => ({
    ...(i === 0 ? { author: { name: 'PERPETUAL PICKS · LIVE TENNIS', url: SITE, icon_url: LOGO }, title: title.slice(0, 250), url: SITE } : {}),
    description,
    color: colorFor(plays),
    ...(i === pages.length - 1 ? { footer: { text: `${record ? `${record} · ` : ''}perpetualpicks.com`.slice(0, 2000), icon_url: LOGO } } : {}),
  }));
  return { content: playbook ? `<@${playbook}> Results for ${longDay(playedDateKey)}` : '', allowed_mentions: mayPing(playbook), embeds };
}

/** The weekly post: a line a day (record and units), the week's totals in the footer, nothing else. */
export function weeklyDigestMessage(weekStartKey, days, { playbook = null } = {}) {
  const weekEndKey = shiftDate(weekStartKey, 6);
  const all = days.flatMap((d) => d.plays);
  const lines = days.map((d) => {
    const n = d.plays.length;
    const r = recordLine(d.plays);
    return `**${longDay(d.dateKey)}** · ${n ? `${n} play${n === 1 ? '' : 's'}${r ? ` · ${r}` : ''}` : 'no plays'}`;
  });
  const title = `🗓️ WEEKLY TENNIS RESULTS · ${shortDay(weekStartKey)} – ${shortDay(weekEndKey)} · ${all.length} play${all.length === 1 ? '' : 's'}`;
  const record = recordLine(all);
  return {
    content: playbook ? `<@${playbook}> Week of ${shortDay(weekStartKey)}` : '',
    allowed_mentions: mayPing(playbook),
    embeds: [{
      author: { name: 'PERPETUAL PICKS · LIVE TENNIS', url: SITE, icon_url: LOGO },
      title: title.slice(0, 250), url: SITE,
      description: packLines(lines)[0] ?? 'No plays this week.',
      color: COLOR.week,
      footer: { text: `${record ? `Week: ${record} · ` : ''}perpetualpicks.com`.slice(0, 2000), icon_url: LOGO },
    }],
  };
}

/* ---------- the run ---------- */

/** Messages are split so no message carries more than Discord allows across its embeds (6,000 characters). */
function split(message) {
  const out = [];
  let embeds = [];
  let size = 0;
  for (const e of message.embeds) {
    const n = (e.description?.length ?? 0) + (e.title?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0);
    if (embeds.length && (size + n > 5800 || embeds.length >= 10)) { out.push(embeds); embeds = []; size = 0; }
    embeds.push(e); size += n;
  }
  if (embeds.length) out.push(embeds);
  return out.map((group, i) => (i === 0 ? { ...message, embeds: group } : { content: '', allowed_mentions: { parse: [] }, embeds: group }));
}

async function postAll(fetcher, hook, message) {
  const ids = [];
  for (const payload of split(message)) {
    const r = await deliver(fetcher, hook, { payload, file: null, plain: payload });
    if (!r.ok && !r.unknown) return { ok: false, status: r.status ?? null, ids };
    ids.push(r.id ? String(r.id) : null);
  }
  return { ok: true, ids };
}

const writeJson = (env, key, value) => env.POTD_KV.put(key, JSON.stringify(value), { expirationTtl: RECORD_TTL });

/**
 * Post what is due: yesterday's roll-up if this morning's is not on record, and on Monday the week's. Runs on any
 * tick in DIGEST_HOUR ET (`force` runs it at any hour — the owner's route). Returns what it did; {off} with no
 * results webhook. `deps.fetch` and `deps.plays(date)` stand in for Discord and the stored plays in tests.
 */
export async function runResultsDigest(env, now = Date.now(), { force = false, deps = {} } = {}) {
  const hook = discordConfig(env).updates;
  if (!hook) return { off: true };
  const clock = etClock(now);
  if (!force && clock.hour !== DIGEST_HOUR) return { skipped: 'hour' };
  const fetcher = deps.fetch ?? fetch;
  const playbook = deps.playbook !== undefined ? deps.playbook : await playbookTag(env);
  const out = { date: clock.date, daily: null, weekly: null };
  const status = (await readJson(env, DIGEST_STATUS_KEY)) ?? {};

  const { startMs, endMs, playedDateKey } = digestWindow(clock.date);
  if (await readJson(env, DIGEST_DAY_KEY(playedDateKey))) {
    out.daily = { skipped: 'posted', day: playedDateKey };
  } else {
    const plays = settledIn(await playsAround(env, startMs, endMs, deps), startMs, endMs);
    if (!plays.length) {
      out.daily = { skipped: 'no plays', day: playedDateKey };
    } else {
      const r = await postAll(fetcher, hook, dailyDigestMessage(playedDateKey, plays, { playbook }));
      if (r.ok) {
        await writeJson(env, DIGEST_DAY_KEY(playedDateKey), { at: now, plays: plays.length, messageIds: r.ids });
        status.lastDaily = { day: playedDateKey, at: now, plays: plays.length, tagged: Boolean(playbook) };
        out.daily = { posted: r.ids.length, day: playedDateKey, plays: plays.length };
      } else {
        out.daily = { failed: r.status, day: playedDateKey };
      }
    }
  }

  if (clock.weekday === WEEKLY_WEEKDAY) {
    const weekStartKey = shiftDate(clock.date, -7); // last Monday: the week that ended this morning
    if (await readJson(env, DIGEST_WEEK_KEY(weekStartKey))) {
      out.weekly = { skipped: 'posted', week: weekStartKey };
    } else {
      const weekStartMs = etInstant(weekStartKey, DIGEST_HOUR);
      const weekEndMs = etInstant(clock.date, DIGEST_HOUR);
      const all = settledIn(await playsAround(env, weekStartMs, weekEndMs, deps), weekStartMs, weekEndMs);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dateKey = shiftDate(weekStartKey, i);
        const s = etInstant(dateKey, DIGEST_HOUR); const e = etInstant(shiftDate(dateKey, 1), DIGEST_HOUR);
        days.push({ dateKey, plays: all.filter((p) => settledAt(p) >= s && settledAt(p) < e) });
      }
      if (!all.length) {
        out.weekly = { skipped: 'no plays', week: weekStartKey };
      } else {
        const r = await postAll(fetcher, hook, weeklyDigestMessage(weekStartKey, days, { playbook }));
        if (r.ok) {
          await writeJson(env, DIGEST_WEEK_KEY(weekStartKey), { at: now, plays: all.length, messageIds: r.ids });
          status.lastWeekly = { week: weekStartKey, at: now, plays: all.length, tagged: Boolean(playbook) };
          out.weekly = { posted: r.ids.length, week: weekStartKey, plays: all.length };
        } else {
          out.weekly = { failed: r.status, week: weekStartKey };
        }
      }
    }
  }
  if (out.daily?.posted || out.weekly?.posted) await writeJson(env, DIGEST_STATUS_KEY, status);
  return out;
}

/** For /discord/status: when the last daily and weekly roll-ups went out, never an address. */
export async function digestStatus(env) {
  const on = Boolean(discordConfig(env).updates);
  const s = (await readJson(env, DIGEST_STATUS_KEY)) ?? {};
  return { on, hourEt: DIGEST_HOUR, lastDaily: s.lastDaily ?? null, lastWeekly: s.lastWeekly ?? null };
}
