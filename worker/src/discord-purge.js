/**
 * The live channels' cards come down 15 minutes after they go up (2026-11-28, the owner: "each item posted should
 * be shown for 15 minutes", and "if you can do it without autopurger, go ahead. and remove it and do it yourself").
 *
 * How it works:
 *
 *   - Each sync (worker/src/discord.js, worker/src/discord-nba.js) marks every message it posts to a live channel
 *     for purging: one small KV key a message, its channel, id and time in the key's metadata. The syncs never
 *     read these keys again, and the sweep never touches a ledger, so the two never write over each other.
 *   - Every minute (worker/src/index.js's minute schedule) the sweep lists the marks, and for each one older than
 *     SHOW_MS deletes the message through the channel's own webhook (a webhook may delete what it posted) and
 *     drops the mark. A message already gone (404) is dropped too; one Discord would not delete is tried again
 *     next minute. A few dozen a sweep at most.
 *   - A mark whose channel is no longer set up is dropped: there is nothing to delete it with. Marks expire on
 *     their own after a few days, so a sweep that never runs leaves nothing behind.
 *
 * Nobody else's messages are touched: the channels are read-only for members, so a live channel holds the
 * worker's cards and the owner's own posts, and the owner's stay.
 */
import { discordConfig, webhookOf } from './discord.js';

/** How long a live card is shown. */
export const SHOW_MS = 15 * 60e3;
export const PURGE_PREFIX = 'discord:purge:';
/** Marks are deleted this many at most a sweep: a minute later the rest. */
export const PURGE_A_SWEEP = 40;
const MARK_TTL = 3 * 86400;

/** The live channels' webhooks by the name a mark carries. */
export const PURGE_CHANNELS = {
  'tennis-live': (env) => discordConfig(env).live,
  'tennis-leans': (env) => discordConfig(env).leans,
  nba: (env) => webhookOf(env?.DISCORD_LIVE_BASKETBALL_WEBHOOK),
  nfl: (env) => webhookOf(env?.DISCORD_FOOTBALL_WEBHOOK),
};
export const purgeKey = (channel, messageId) => `${PURGE_PREFIX}${channel}:${messageId}`;

/** A message just posted to a live channel: marked to come down SHOW_MS after `at`. Nothing without an id. */
export async function markForPurge(env, channel, messageId, at) {
  if (!messageId || !PURGE_CHANNELS[channel] || !env?.POTD_KV) return false;
  await env.POTD_KV.put(purgeKey(channel, messageId), '1', { metadata: { channel, messageId: String(messageId), at }, expirationTtl: MARK_TTL });
  return true;
}

/**
 * The sweep: every marked message past its time is deleted and its mark dropped. Returns {due, deleted, failed,
 * waiting}. `deps.fetch` stands in for Discord in tests.
 */
export async function purgeLiveCards(env, now = Date.now(), { deps = {} } = {}) {
  const fetcher = deps.fetch ?? fetch;
  const out = { due: 0, deleted: 0, failed: 0, waiting: 0 };
  if (!env?.POTD_KV?.list) return out;
  const listed = await env.POTD_KV.list({ prefix: PURGE_PREFIX, limit: 500 });
  let tried = 0;
  for (const key of listed?.keys ?? []) {
    const m = key.metadata ?? {};
    if (!m.messageId || !m.channel) { await env.POTD_KV.delete(key.name); continue; }
    if (now - Number(m.at ?? 0) < SHOW_MS) { out.waiting++; continue; }
    out.due++;
    if (tried >= PURGE_A_SWEEP) continue;
    const hook = PURGE_CHANNELS[m.channel]?.(env);
    if (!hook) { await env.POTD_KV.delete(key.name); continue; }
    tried++;
    let r = null;
    try { r = await fetcher(`${hook}/messages/${m.messageId}`, { method: 'DELETE' }); } catch { r = null; }
    if (r && (r.ok || r.status === 404)) { await env.POTD_KV.delete(key.name); out.deleted++; }
    else out.failed++;
  }
  return out;
}
