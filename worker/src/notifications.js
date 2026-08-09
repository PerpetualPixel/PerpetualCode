import { formatAmerican } from '../../docs/engine.js';
import { EMAIL_LOGO_HTML } from './auth-handlers.js';

/**
 * Email notifications for users opted into Play of the Day / Pixel's Picks
 * alerts (worker/src/account-handlers.js's handleUpdateNotifications is
 * where those preferences get set). Called once from the 2am ET scheduled
 * batch in index.js, after runPotdDaily/runTop5Batch have written today's
 * board — never on the page-view path, so a slow or failed send never
 * affects anyone loading the app.
 */

const FROM = { email: 'picks@perpetualpicks.com', name: 'PerpetualPicks' };
const SEND_CONCURRENCY = 5;

async function fetchOptedInUsers(env, column) {
  const { results } = await env.DB.prepare(
    `SELECT email, username FROM users WHERE ${column} = 1 AND email_verified = 1`,
  ).all();
  return results ?? [];
}

/** Fans sends out with a small concurrency cap — true sequential is too
 * slow at any real user count, fully parallel is exactly the kind of
 * per-invocation burst pressure that has bitten this cron before (see the
 * comments around the scheduled handler's subrequest-stampede history in
 * index.js). Failures are per-user and swallowed: one bad address never
 * blocks the rest of the batch. */
async function sendBatch(env, users, buildEmail) {
  const queue = [...users];
  const worker = async () => {
    while (queue.length) {
      const user = queue.shift();
      try {
        await env.EMAIL.send(buildEmail(user));
      } catch (e) {
        console.error(`Notification send failed for ${user.email}:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
}

function emailShell(username, title, bodyHtml) {
  return `
    <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
        ${EMAIL_LOGO_HTML}
        <h2 style="color: #d946ef; margin-bottom: 8px;">${title}</h2>
        <p style="color: #7070aa; font-size: 13px; margin-bottom: 20px;">Hi ${username},</p>
        ${bodyHtml}
        <div style="text-align: center; margin: 30px 0 0;">
          <a href="https://perpetualpicks.com/index.html" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open PerpetualPicks</a>
        </div>
        <p style="margin-top: 24px; color: #7070aa; font-size: 11px; text-align: center;">
          Manage notification preferences at <a href="https://perpetualpicks.com/account.html" style="color: #7070aa;">perpetualpicks.com/account.html</a>
        </p>
      </div>
    </div>`;
}

export async function sendPotdNotifications(env, record) {
  if (!env.EMAIL || !record?.pick) return;
  const users = await fetchOptedInUsers(env, 'notify_potd_email');
  if (!users.length) return;

  const { pick, writeup } = record;
  const headline = writeup?.headline ?? pick.selection;
  const matchup = `${pick.away} @ ${pick.home}`;
  const price = formatAmerican(pick.american);

  await sendBatch(env, users, (user) => ({
    to: user.email,
    from: FROM,
    subject: `Play of the Day: ${pick.selection} (${price})`,
    html: emailShell(user.username, 'Play of the Day is Ready', `
      <p style="margin-bottom: 8px; font-size: 18px; font-weight: bold;">${headline}</p>
      <p style="margin-bottom: 20px; color: #a0a0cc;">${matchup} &middot; ${pick.selection} <span style="color: #00d9ff;">${price}</span></p>
    `),
    text: `Hi ${user.username}, Play of the Day: ${pick.selection} (${price})\n${matchup}\n\nOpen: https://perpetualpicks.com/index.html`,
  }));
}

export async function sendPicksNotifications(env, picks) {
  if (!env.EMAIL || !picks?.length) return;
  const users = await fetchOptedInUsers(env, 'notify_picks_email');
  if (!users.length) return;

  const rows = picks
    .map((p) => `<li style="margin-bottom: 6px;">${p.away} @ ${p.home} &mdash; ${p.selection} <span style="color: #00d9ff;">${formatAmerican(p.american)}</span></li>`)
    .join('');

  await sendBatch(env, users, (user) => ({
    to: user.email,
    from: FROM,
    subject: `Pixel's Picks: ${picks.length} lock${picks.length === 1 ? '' : 's'} are in`,
    html: emailShell(user.username, "Pixel's Picks Are Ready", `
      <ul style="margin: 0 0 20px; padding-left: 20px; color: #e0e0ff; line-height: 1.7;">${rows}</ul>
    `),
    text: `Hi ${user.username}, Pixel's Picks (${picks.length}):\n${picks.map((p) => `${p.away} @ ${p.home} — ${p.selection} (${formatAmerican(p.american)})`).join('\n')}\n\nOpen: https://perpetualpicks.com/index.html`,
  }));
}
