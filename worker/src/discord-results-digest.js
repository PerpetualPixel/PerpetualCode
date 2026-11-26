/**
 * The results channels' daily and weekly roll-ups (2026-11-25, the owner:
 * "for the tennis results channel, I want them to post and retain the
 * daily results all together. then post a weekly one", and then "create
 * a basketball results channel as well posting the same as tennis
 * results but for nba").
 *
 * Each results channel already gets one card per settled play: tennis
 * through DISCORD_UPDATES_WEBHOOK (worker/src/discord.js), the NBA and
 * NFL through their results webhooks (worker/src/discord-nba.js). Those
 * stay. This adds, once a day at DIGEST_HOUR ET (6am, after the
 * overnight sessions are in), one message to each channel with every
 * play that settled in the 24 hours before it — the day's results
 * together, with the day's record — and every Monday at the same hour
 * one message with the week, day by day, and its totals. Each goes
 * through its channel's own webhook, so it sits with the cards in the
 * same name and picture, and opens with Playbook's tag when its id is
 * known (worker/src/discord-nba.js's playbookTag).
 *
 * The plays come from the worker's own records, never from reading a
 * channel back: tennis from its day records (worker/src/
 * tennis-live-plays.js), the NBA and NFL from their channel ledgers
 * (the settled posts). A day's window is DIGEST_HOUR ET to DIGEST_HOUR
 * ET; a play belongs to the window its settling (gradedAt) fell in, so
 * an overnight match counts with the day it was played.
 *
 * Once each: a KV record per day and per week and per source, written
 * after the post lands, so the three ticks in the hour post one message
 * between them and a forced run (the owner's route) of a day already
 * posted does nothing. A day with nothing settled posts nothing and
 * records nothing. The day record keeps the day's tally, and the weekly
 * roll-up is built from the day records first — a channel ledger keeps
 * only a few days of posts — and from the plays for a day with no record.
 */
import { deliver, readJson, discordConfig, webhookOf } from './discord.js';
import { playbookTag, mayPing, LEAGUES } from './discord-nba.js';
import { tennisLivePlaysKey, liveRecordOf } from './tennis-live-plays.js';
import { SPORTSBOOKS } from '../../docs/engine.js';

export const DIGEST_HOUR = 6; // 6am ET, every day; the weekly on Monday
export const WEEKLY_WEEKDAY = 'Mon';
export const DIGEST_DAY_KEY = (dateKey, source = 'tennis') => (source === 'tennis' ? `discord:digest:day:${dateKey}` : `discord:digest:${source}:day:${dateKey}`);
export const DIGEST_WEEK_KEY = (dateKey, source = 'tennis') => (source === 'tennis' ? `discord:digest:week:${dateKey}` : `discord:digest:${source}:week:${dateKey}`);
export const DIGEST_STATUS_KEY = 'discord:digest:status';
const RECORD_TTL = 35 * 86400;
const SITE = 'https://perpetualpicks.com/app.html';
const LOGO = 'https://perpetualpicks.com/assets/logo-icon-180.png';
const COLOR = { up: 0x10b981, down: 0xef4444, flat: 0x9c98b8, week: 0xff007a };
/** Discord's limit on an embed description. */
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

/** Every stored tennis play that could have settled in the window: the records of the day before it, its days, and the day after. */
async function tennisPlaysAround(env, startMs, endMs, deps) {
  const dates = new Set();
  for (let ms = startMs - DAY_MS; ms <= endMs + DAY_MS; ms += DAY_MS) dates.add(etClock(ms).date);
  const all = [];
  for (const d of [...dates].sort()) all.push(...(deps.plays ? await deps.plays(d) : ((await readJson(env, tennisLivePlaysKey(d)))?.plays ?? [])));
  return all;
}

/** A league channel's settled posts, from its ledger (worker/src/discord-nba.js): each is a play with its final legs. */
export async function ledgerPlays(env, league, deps = {}) {
  const ledger = deps.ledger ? await deps.ledger(league) : await readJson(env, LEAGUES[league].ledger);
  return Object.values(ledger?.posts ?? {}).filter((e) => e?.state === 'done' && !e.editFailed && e.post && isSettled(e.post)).map((e) => ({ ...e.post, gradedAt: e.post.gradedAt ?? e.doneAt ?? null }));
}

/* ---------- the words ---------- */

const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const md = (s) => String(s ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1').slice(0, 200);
const last = (name) => String(name ?? '').trim().split(/\s+/).at(-1) ?? '';

/** One settled tennis play in a line: how it ended, the bet, the final score, the units, the price and book, the match. */
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

/** One settled NBA or NFL play in a line: how it ended, the game, the slip's price and book, the units, each leg with its final number. */
export function slipResultLine(post) {
  const outcome = post.status === 'void' ? 'void' : post.result === 'win' ? 'win' : 'loss';
  const mark = { win: '✅', loss: '❌', void: '⚪' }[outcome];
  const legs = (post.legs ?? []).map((l) => `${md(last(l.player))} Over ${l.point} ${md(l.label ?? l.stat ?? '')}${l.final != null ? ` (${l.final})` : ''}${l.hit === true ? ' ✓' : l.hit === false ? ' ✗' : ''}`.replace(/\s+/g, ' ').trim());
  const score = Object.entries(post.finalScore ?? post.score ?? {}).map(([t, n]) => `${md(t)} ${n}`).join(', ');
  const parts = [
    `${mark} **${md(post.game)}**${score ? ` · Final ${score}` : ''}`,
    `${post.legs?.length ?? 0} legs ${fmt(post.american)} at ${md(SPORTSBOOKS[post.bookId]?.name ?? post.book ?? 'the book')}`,
    outcome === 'void' ? 'Void · stake returned' : Number.isFinite(post.profit) ? `**${signedUnits(post.profit)}**` : null,
    legs.length ? legs.join(', ') : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

const recordWords = (r) => `${r.wins}-${r.losses}${r.voids ? `-${r.voids}` : ''}`;
const roiWords = (r) => (r.roi == null ? '' : ` · ROI ${r.roi < 0 ? '−' : '+'}${Math.abs(r.roi * 100).toFixed(1)}%`);
const has = (r) => Boolean(r) && r.wins + r.losses + r.voids > 0;

/** A set of plays' tallies: the tracked plays' record and the leans' beside it. */
export const talliesOf = (plays) => ({ tally: liveRecordOf(plays.filter((p) => !p.lean)), leans: liveRecordOf(plays.filter((p) => p.lean)) });

/** The record line from tallies: the tracked record with units and ROI, the leans' record beside it; '' with nothing. */
export function recordLineOf({ tally, leans } = {}) {
  const out = [];
  if (has(tally)) out.push(`Record ${recordWords(tally)} · ${signedUnits(tally.units)}${roiWords(tally)}`);
  if (has(leans)) out.push(`Leans ${recordWords(leans)}`);
  return out.join(' · ');
}
/** The record line for a set of plays. */
export const recordLine = (plays) => recordLineOf(talliesOf(plays));

/** Tallies added up: wins, losses, voids, what was staked and what it made, the ROI over all of it. */
export function sumTallies(list) {
  const sum = (key) => { const out = { wins: 0, losses: 0, voids: 0, pending: 0, staked: 0, units: 0, roi: null }; for (const t of list) { const r = t?.[key]; if (!r) continue; out.wins += r.wins ?? 0; out.losses += r.losses ?? 0; out.voids += r.voids ?? 0; out.staked += r.staked ?? 0; out.units += r.units ?? 0; } out.staked = Math.round(out.staked * 100) / 100; out.units = Math.round(out.units * 100) / 100; out.roi = out.staked > 0 ? Math.round((out.units / out.staked) * 1000) / 1000 : null; return out; };
  return { tally: sum('tally'), leans: sum('leans') };
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
 * is titled with the day and carries the record in its footer; a long day runs on into further embeds. `label`
 * names the sport ('TENNIS', 'NBA', 'NFL'); `line` writes a play.
 */
export function dailyDigestMessage(playedDateKey, plays, { playbook = null, label = 'TENNIS', line = resultLine } = {}) {
  const lines = plays.map(line);
  const pages = packLines(lines);
  const record = recordLine(plays);
  const title = `📊 ${label} RESULTS · ${longDay(playedDateKey)} · ${plays.length} play${plays.length === 1 ? '' : 's'}`;
  const embeds = pages.map((description, i) => ({
    ...(i === 0 ? { author: { name: `PERPETUAL PICKS · LIVE ${label}`, url: SITE, icon_url: LOGO }, title: title.slice(0, 250), url: SITE } : {}),
    description,
    color: colorFor(plays),
    ...(i === pages.length - 1 ? { footer: { text: `${record ? `${record} · ` : ''}perpetualpicks.com`.slice(0, 2000), icon_url: LOGO } } : {}),
  }));
  return { content: playbook ? `<@${playbook}> Results for ${longDay(playedDateKey)}` : '', allowed_mentions: mayPing(playbook), embeds };
}

/**
 * The weekly post: a line a day (how many plays, the record and the units), the week's totals in the footer. `days`
 * is seven of {dateKey, count, tally, leans}, Monday first.
 */
export function weeklyDigestMessage(weekStartKey, days, { playbook = null, label = 'TENNIS' } = {}) {
  const weekEndKey = shiftDate(weekStartKey, 6);
  const total = sumTallies(days);
  const count = days.reduce((n, d) => n + (d.count ?? 0), 0);
  const lines = days.map((d) => {
    const r = recordLineOf(d);
    return `**${longDay(d.dateKey)}** · ${d.count ? `${d.count} play${d.count === 1 ? '' : 's'}${r ? ` · ${r}` : ''}` : 'no plays'}`;
  });
  const title = `🗓️ WEEKLY ${label} RESULTS · ${shortDay(weekStartKey)} – ${shortDay(weekEndKey)} · ${count} play${count === 1 ? '' : 's'}`;
  const record = recordLineOf(total);
  return {
    content: playbook ? `<@${playbook}> Week of ${shortDay(weekStartKey)}` : '',
    allowed_mentions: mayPing(playbook),
    embeds: [{
      author: { name: `PERPETUAL PICKS · LIVE ${label}`, url: SITE, icon_url: LOGO },
      title: title.slice(0, 250), url: SITE,
      description: packLines(lines)[0] ?? 'No plays this week.',
      color: COLOR.week,
      footer: { text: `${record ? `Week: ${record} · ` : ''}perpetualpicks.com`.slice(0, 2000), icon_url: LOGO },
    }],
  };
}

/* ---------- the sources ---------- */

/** Each results channel: where its webhook is, where its plays are, how a play is written. */
export const SOURCES = {
  tennis: { label: 'TENNIS', hook: (env) => discordConfig(env).updates, plays: tennisPlaysAround, line: resultLine },
  nba: { label: 'NBA', hook: (env) => webhookOf(env?.DISCORD_NBA_RESULTS_WEBHOOK), plays: (env, s, e, deps) => ledgerPlays(env, 'nba', deps), line: slipResultLine },
  nfl: { label: 'NFL', hook: (env) => webhookOf(env?.DISCORD_NFL_RESULTS_WEBHOOK), plays: (env, s, e, deps) => ledgerPlays(env, 'nfl', deps), line: slipResultLine },
};

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

/** One source's daily and weekly, on a tick inside the hour (or forced). */
async function runSource(env, name, source, hook, now, clock, { fetcher, playbook, deps }) {
  const out = { daily: null, weekly: null };
  const { startMs, endMs, playedDateKey } = digestWindow(clock.date);
  if (await readJson(env, DIGEST_DAY_KEY(playedDateKey, name))) {
    out.daily = { skipped: 'posted', day: playedDateKey };
  } else {
    const plays = settledIn(await source.plays(env, startMs, endMs, deps), startMs, endMs);
    if (!plays.length) {
      out.daily = { skipped: 'no plays', day: playedDateKey };
    } else {
      const r = await postAll(fetcher, hook, dailyDigestMessage(playedDateKey, plays, { playbook, label: source.label, line: source.line }));
      if (r.ok) {
        await writeJson(env, DIGEST_DAY_KEY(playedDateKey, name), { at: now, plays: plays.length, ...talliesOf(plays), messageIds: r.ids });
        out.daily = { posted: r.ids.length, day: playedDateKey, plays: plays.length };
      } else {
        out.daily = { failed: r.status, day: playedDateKey };
      }
    }
  }

  if (clock.weekday === WEEKLY_WEEKDAY) {
    const weekStartKey = shiftDate(clock.date, -7); // last Monday: the week that ended this morning
    if (await readJson(env, DIGEST_WEEK_KEY(weekStartKey, name))) {
      out.weekly = { skipped: 'posted', week: weekStartKey };
    } else {
      // Each day from its record, else from the plays (a channel ledger keeps a few days; the tennis records a month).
      let all = null;
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dateKey = shiftDate(weekStartKey, i);
        const rec = await readJson(env, DIGEST_DAY_KEY(dateKey, name));
        if (rec?.tally) { days.push({ dateKey, count: rec.plays ?? 0, tally: rec.tally, leans: rec.leans ?? null }); continue; }
        const s = etInstant(dateKey, DIGEST_HOUR); const e = etInstant(shiftDate(dateKey, 1), DIGEST_HOUR);
        all ??= await source.plays(env, etInstant(weekStartKey, DIGEST_HOUR), etInstant(clock.date, DIGEST_HOUR), deps);
        const plays = settledIn(all, s, e);
        days.push({ dateKey, count: plays.length, ...talliesOf(plays) });
      }
      const count = days.reduce((n, d) => n + d.count, 0);
      if (!count) {
        out.weekly = { skipped: 'no plays', week: weekStartKey };
      } else {
        const r = await postAll(fetcher, hook, weeklyDigestMessage(weekStartKey, days, { playbook, label: source.label }));
        if (r.ok) {
          await writeJson(env, DIGEST_WEEK_KEY(weekStartKey, name), { at: now, plays: count, ...sumTallies(days), messageIds: r.ids });
          out.weekly = { posted: r.ids.length, week: weekStartKey, plays: count };
        } else {
          out.weekly = { failed: r.status, week: weekStartKey };
        }
      }
    }
  }
  return out;
}

/**
 * Post what is due to every results channel that is set up: yesterday's roll-up if this morning's is not on
 * record, and on Monday the week's. Runs on any tick in DIGEST_HOUR ET (`force` runs it at any hour — the owner's
 * route). Returns what it did, the tennis channel's at the top (`daily`, `weekly`) and each league's under its
 * name; {off} with no results webhook at all. `deps.fetch`, `deps.plays(date)` (tennis), `deps.ledger(league)`
 * and `deps.playbook` stand in for Discord and the stored plays in tests.
 */
export async function runResultsDigest(env, now = Date.now(), { force = false, deps = {} } = {}) {
  const hooks = Object.fromEntries(Object.entries(SOURCES).map(([name, src]) => [name, src.hook(env)]));
  if (!Object.values(hooks).some(Boolean)) return { off: true };
  const clock = etClock(now);
  if (!force && clock.hour !== DIGEST_HOUR) return { skipped: 'hour' };
  const fetcher = deps.fetch ?? fetch;
  const playbook = deps.playbook !== undefined ? deps.playbook : await playbookTag(env);
  const out = { date: clock.date, daily: null, weekly: null };
  const status = (await readJson(env, DIGEST_STATUS_KEY)) ?? {};
  for (const [name, source] of Object.entries(SOURCES)) {
    if (!hooks[name]) { if (name !== 'tennis') out[name] = { off: true }; continue; }
    const r = await runSource(env, name, source, hooks[name], now, clock, { fetcher, playbook, deps });
    const slot = name === 'tennis' ? status : (status[name] ??= {});
    if (r.daily?.posted) slot.lastDaily = { day: r.daily.day, at: now, plays: r.daily.plays, tagged: Boolean(playbook) };
    if (r.weekly?.posted) slot.lastWeekly = { week: r.weekly.week, at: now, plays: r.weekly.plays, tagged: Boolean(playbook) };
    if (name === 'tennis') Object.assign(out, r); else out[name] = r;
  }
  if (Object.values(out).some((r) => r?.daily?.posted || r?.weekly?.posted) || out.daily?.posted || out.weekly?.posted) await writeJson(env, DIGEST_STATUS_KEY, status);
  return out;
}

/** For /discord/status: each results channel, whether it is set up and when its last daily and weekly went out, never an address. */
export async function digestStatus(env) {
  const s = (await readJson(env, DIGEST_STATUS_KEY)) ?? {};
  const out = { on: Boolean(SOURCES.tennis.hook(env)), hourEt: DIGEST_HOUR, lastDaily: s.lastDaily ?? null, lastWeekly: s.lastWeekly ?? null };
  for (const name of ['nba', 'nfl']) out[name] = { on: Boolean(SOURCES[name].hook(env)), lastDaily: s[name]?.lastDaily ?? null, lastWeekly: s[name]?.lastWeekly ?? null };
  return out;
}
