import { formatAmerican } from '../../docs/engine.js';
import { getUfcPicks } from './ufc-picks.js';
import { EMAIL_LOGO_HTML } from './auth-handlers.js';
import { getTrendPicks } from './trend-picks.js';

/**
 * Email notifications for users opted into Play of the Day / Pixel's Picks /
 * Ladder Challenge alerts (worker/src/account-handlers.js's handleUpdateNotifications is
 * where those preferences get set). Called every hourly tick from
 * index.js's scheduled(), after runPotdDaily/runTop5Batch have run — never
 * on the page-view path, so a slow or failed send never affects anyone
 * loading the app.
 */

const FROM = { email: 'picks@perpetualpicks.com', name: 'PerpetualPicks' };
const SEND_CONCURRENCY = 5;

async function fetchOptedInUsers(env, column) {
  const { results } = await env.DB.prepare(
    `SELECT email, username FROM users WHERE ${column} = 1 AND email_verified = 1`,
  ).all();
  return results ?? [];
}

/** ET calendar date (YYYY-MM-DD) — same as every other tracker file's own etDate. */
function etDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Which of today's currently-locked Top5 picks have already been emailed
 * about — so a pick covered by an early "can't wait" email (see index.js's
 * scheduled(): a pick locked close enough to its own game that holding out
 * for the rest of the board to fill would risk missing the 1-hour notice
 * floor) never gets a second, redundant email once the board later
 * completes. 7-day TTL is generous headroom, not a meaningful retention
 * choice — this only ever matters same-day.
 */
export async function getNotifiedTop5PickIds(env, now = Date.now()) {
  const raw = await env.POTD_KV.get(`track:${etDate(now)}:top5-notified`);
  return new Set(raw ? JSON.parse(raw) : []);
}

export async function markTop5PickIdsNotified(env, now, pickIds) {
  if (!pickIds.length) return;
  const existing = await getNotifiedTop5PickIds(env, now);
  for (const id of pickIds) existing.add(id);
  await env.POTD_KV.put(`track:${etDate(now)}:top5-notified`, JSON.stringify([...existing]), {
    expirationTtl: 86400 * 7,
  });
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
          <a href="https://perpetualpicks.com/app.html" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open PerpetualPicks</a>
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
  // A ticket (docs/tickets.js) has two legs in two games; a pre-ticket
  // record is one game.
  const legs = Array.isArray(pick.legs) && pick.legs.length ? pick.legs : null;
  const matchup = legs
    ? legs.map((l) => `${l.selection} (${formatAmerican(l.american)}) &middot; ${l.away} @ ${l.home}`).join('<br>')
    : `${pick.away} @ ${pick.home}`;
  const matchupText = legs
    ? legs.map((l) => `${l.selection} (${formatAmerican(l.american)}) — ${l.away} @ ${l.home}`).join('\n')
    : `${pick.away} @ ${pick.home}`;
  const price = Number.isFinite(pick.american) ? formatAmerican(pick.american) : 'price at your book';
  // Dated: tomorrow's play posts the evening before, so the reader must
  // see which day it is for.
  const day = record.date
    ? new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).format(Date.parse(`${record.date}T12:00:00Z`))
    : null;
  const title = day ? `Play of the Day for ${day}` : 'Play of the Day';

  await sendBatch(env, users, (user) => ({
    to: user.email,
    from: FROM,
    subject: `${title}: ${pick.selection} (${price})`,
    html: emailShell(user.username, `${title} is Ready`, `
      <p style="margin-bottom: 8px; font-size: 18px; font-weight: bold;">${headline}</p>
      <p style="margin-bottom: 20px; color: #a0a0cc;">${matchup}${legs ? '' : ` &middot; ${pick.selection}`} <span style="color: #00d9ff;">${price}</span></p>
    `),
    text: `Hi ${user.username}, ${title}: ${pick.selection} (${price})\n${matchupText}\n\nOpen: https://perpetualpicks.com/app.html`,
  }));
}

/**
 * The ladder's daily rung. Deliberately says the stake and what the rung
 * returns rather than just the pick: the ladder compounds, so "which rung
 * am I on and how much is riding" is the part that actually differs from
 * every other notification this app sends — a $240 rung and a $20 rung are
 * the same pick shape but very different information.
 */
export async function sendLadderNotifications(env, record, state) {
  if (!env.EMAIL || !record?.pick) return;
  const users = await fetchOptedInUsers(env, 'notify_ladder_email');
  if (!users.length) return;

  const { pick, stake, toReturn, step } = record;
  // A parlay rung (worker/src/ladder.js, since 2026-09-30) carries its legs
  // and no single game; a pre-redesign rung is one game.
  const legs = Array.isArray(pick.legs) && pick.legs.length ? pick.legs : null;
  const window = record.slot?.label ? ` &middot; ${record.slot.label}` : '';
  const matchup = legs
    ? legs.map((l) => `${l.selection} <span style="color: #00d9ff;">${formatAmerican(l.american)}</span> &middot; ${l.away} @ ${l.home}`).join('<br>')
    : `${pick.away} @ ${pick.home}`;
  const matchupText = legs
    ? legs.map((l) => `${l.selection} (${formatAmerican(l.american)}) — ${l.away} @ ${l.home}`).join('\n')
    : `${pick.away} @ ${pick.home}`;
  const price = Number.isFinite(pick.american) ? formatAmerican(pick.american) : 'price at your book';
  const headline = legs ? `${legs.length}-leg ${legs.some((l) => l.kind === 'prop') ? 'props' : 'NFL'} parlay` : pick.selection;
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const banked = state?.banked ? ` &middot; ${money(state.banked)} already banked` : '';

  await sendBatch(env, users, (user) => ({
    to: user.email,
    from: FROM,
    subject: `Ladder Rung ${step}: ${headline} (${price}) — ${money(stake)} riding`,
    html: emailShell(user.username, `Ladder Challenge &middot; Rung ${step}${window}`, `
      <p style="margin-bottom: 8px; font-size: 18px; font-weight: bold;">${headline} <span style="color: #00d9ff;">${price}</span></p>
      <p style="margin-bottom: 20px; color: #a0a0cc;">${matchup}</p>
      <p style="margin-bottom: 8px; color: #a0a0cc;">
        Staking <strong style="color: #fff;">${money(stake)}</strong> to return
        <strong style="color: #fff;">${money(toReturn)}</strong>${banked}
      </p>
      <p style="margin: 0; color: #7070aa; font-size: 12px;">
        The whole bankroll rides each rung — a loss ends the climb and starts the next one back at $20.
      </p>
    `),
    text: `Hi ${user.username}, Ladder Rung ${step}: ${headline} (${price})\n${matchupText}\nStaking ${money(stake)} to return ${money(toReturn)}\n\nOpen: https://perpetualpicks.com/app.html`,
  }));
}

/**
 * `isFinal` distinguishes the ideal, single "the whole board is in" email
 * (all 5 locked together, wasComplete flipped false→true in one tick) from
 * an early, partial one index.js sends only when waiting for the rest of
 * the board would risk missing the 1-hour notice floor on a pick that's
 * already locked (see tracking.js's PICK_LEAD_HOURS comment and
 * getNotifiedTop5PickIds above) — `picks` may be fewer than 5 in that case.
 * Same template either way; only the subject line says which this is, so
 * a partial email doesn't read as though it's the whole day's board.
 */
export async function sendPicksNotifications(env, picks, { isFinal = true } = {}) {
  if (!env.EMAIL || !picks?.length) return;
  const users = await fetchOptedInUsers(env, 'notify_picks_email');
  if (!users.length) return;

  // A ticket lists its legs under the combined price; a single, its game.
  const describe = (p) => (Array.isArray(p.legs) && p.legs.length
    ? p.legs.map((l) => `${l.selection} (${formatAmerican(l.american)}) &middot; ${l.away} @ ${l.home}`).join('<br>&nbsp;&nbsp;+ ')
    : `${p.away} @ ${p.home} &mdash; ${p.selection}`);
  const describeText = (p) => (Array.isArray(p.legs) && p.legs.length
    ? p.legs.map((l) => `${l.selection} (${formatAmerican(l.american)}) — ${l.away} @ ${l.home}`).join(' + ')
    : `${p.away} @ ${p.home} — ${p.selection}`);
  const rows = picks
    .map((p) => `<li style="margin-bottom: 6px;">${describe(p)} <span style="color: #00d9ff;">${formatAmerican(p.american)}</span></li>`)
    .join('');
  const subject = isFinal
    ? `Pixel's Picks: ${picks.length} lock${picks.length === 1 ? '' : 's'} are in`
    : `Pixel's Picks: ${picks.length} lock${picks.length === 1 ? '' : 's'} in early — game${picks.length === 1 ? '' : 's'} starting soon`;
  const heading = isFinal ? "Pixel's Picks Are Ready" : "Don't Miss These — Locked Early";

  await sendBatch(env, users, (user) => ({
    to: user.email,
    from: FROM,
    subject,
    html: emailShell(user.username, heading, `
      ${isFinal ? '' : `<p style="color: #a0a0cc; font-size: 13px; margin-bottom: 14px;">
        These locked with their own game${picks.length === 1 ? '' : 's'} starting soon, so they're going
        out ahead of the rest of today's board — more Pixel's Picks may still follow later today.</p>`}
      <ul style="margin: 0 0 20px; padding-left: 20px; color: #e0e0ff; line-height: 1.7;">${rows}</ul>
    `),
    text: `Hi ${user.username}, Pixel's Picks (${picks.length}${isFinal ? '' : ', locked early — more may follow today'}):\n${picks.map((p) => `${describeText(p)} (${formatAmerican(p.american)})`).join('\n')}\n\nOpen: https://perpetualpicks.com/app.html`,
  }));
}

/**
 * The day's Pixel's Picks tickets (worker/src/trend-picks.js), to the
 * users who asked for them, once: each ticket is emailed the tick it
 * posts and never again, by its id in KV. Called from the Trends cron
 * after the day's draw. Returns how many tickets went out.
 */
export async function sendTicketNotifications(env, now = Date.now(), { deps = {} } = {}) {
  if (!env.EMAIL && !deps.send) return 0;
  const today = (await (deps.today ? deps.today() : getTrendPicks(env, now, { days: 1 }).then((d) => d.today)));
  const bets = (today?.bets ?? []).filter((b) => b.status === 'pending');
  if (!bets.length) return 0;
  const flagKey = `trendpicks:${today.date}:notified`;
  const notified = new Set(JSON.parse((await env.POTD_KV.get(flagKey)) ?? '[]'));
  const fresh = bets.filter((b) => !notified.has(b.id));
  if (!fresh.length) return 0;
  const users = await (deps.users ? deps.users() : fetchOptedInUsers(env, 'notify_picks_email'));
  if (users.length) {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).format(Date.parse(`${today.date}T12:00:00Z`));
    const time = (ms) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(ms);
    const play = (b) => (b.play ? b.play : b.type === 'parlay' ? `${b.legs.length}-leg parlay` : 'Straight');
    const legHtml = (l) => `<li style="margin: 0 0 6px;">${l.selection} <span style="color:#00d9ff;">${formatAmerican(l.american)}</span><br><span style="color:#a0a0cc; font-size:12px;">${l.away} @ ${l.home} &middot; ${time(l.commenceMs)} ET &middot; landed ${l.periods?.l20?.hits ?? 20} of the last ${l.periods?.l20?.games ?? 20}${l.note ? `<br>${l.note}` : ''}</span></li>`;
    const ticketHtml = (b) => `<div style="margin: 0 0 18px; padding: 14px; border: 1px solid rgba(217,70,239,0.3); border-radius: 10px;">
      <div style="font-weight: bold; color: #e0e0ff; margin-bottom: 8px;">${play(b)} at ${b.book} <span style="color:#00d9ff;">${formatAmerican(b.american)}</span> <span style="color:#7070aa; font-weight: normal;">&middot; ${b.units} unit</span></div>
      <ul style="margin: 0; padding-left: 18px; color: #e0e0ff; line-height: 1.5;">${b.legs.map(legHtml).join('')}</ul>
      ${b.link || b.bookUrl ? `<p style="margin: 10px 0 0;"><a href="${b.link ?? b.bookUrl}" style="color:#d946ef;">Open ${b.book}</a></p>` : ''}
    </div>`;
    const ticketText = (b) => `${play(b)} at ${b.book} ${formatAmerican(b.american)} (${b.units} unit)\n${b.legs.map((l) => `  ${l.selection} ${formatAmerican(l.american)}, ${l.away} @ ${l.home}${l.note ? ` (${l.note})` : ''}`).join('\n')}`;
    const subject = `Pixel's Picks for ${day}: ${fresh.length} ticket${fresh.length === 1 ? '' : 's'}`;
    const sendOne = deps.send ?? ((msg) => env.EMAIL.send(msg));
    const queue = [...users];
    const worker = async () => {
      while (queue.length) {
        const user = queue.shift();
        try {
          await sendOne({
            to: user.email,
            from: FROM,
            subject,
            html: emailShell(user.username, `Pixel's Picks for ${day}`, `<p style="color:#a0a0cc; font-size:13px; margin: 0 0 16px;">${fresh.length === 1 ? 'One ticket today' : `${fresh.length} tickets today`}, one unit each. Lines can move before tip-off; the card in the app follows the book's number.</p>${fresh.map(ticketHtml).join('')}`),
            text: `Hi ${user.username}, Pixel's Picks for ${day}:\n\n${fresh.map(ticketText).join('\n\n')}\n\nOpen: https://perpetualpicks.com/app.html`,
          });
        } catch (e) {
          console.error(`Ticket notification failed for ${user.email}:`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
  }
  await env.POTD_KV.put(flagKey, JSON.stringify([...notified, ...fresh.map((b) => b.id)]), { expirationTtl: 86400 * 7 });
  return fresh.length;
}


/** A card change that voided a pick, to the same users: one email per tick naming the picks and why. */
export async function sendUfcChangeNotifications(env, tick, now = Date.now(), { deps = {} } = {}) {
  const voided = tick?.voided ?? [];
  if (!voided.length || (!env.EMAIL && !deps.send)) return 0;
  const users = await (deps.users ? deps.users() : fetchOptedInUsers(env, 'notify_picks_email'));
  if (!users.length) return 0;
  const sendOne = deps.send ?? ((msg) => env.EMAIL.send(msg));
  const lines = voided.map((b) => `${b.legs[0].selection} (${b.legs[0].a} vs ${b.legs[0].b}): ${b.voidReason}`);
  await Promise.all(users.map((user) => sendOne({
    to: user.email,
    subject: `Card change on ${tick.eventName}: ${voided.length} pick${voided.length === 1 ? '' : 's'} voided`,
    html: `<div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">${EMAIL_LOGO_HTML}
      <h2 style="color: #d946ef; margin-bottom: 8px;">${tick.eventName}</h2><p style="color: #a0a0cc; font-size: 13px;">Hi ${user.username}, the card changed and these picks are off the record. Do not place them. The bout reads again if it is still on.</p>
      <ul style="line-height: 1.6;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
      <p style="margin: 20px 0 0;"><a href="https://perpetualpicks.com/app.html" style="color:#d946ef;">Open the card</a></p></div></div>`,
    text: `Hi ${user.username}, the card changed on ${tick.eventName} and these picks are off the record. Do not place them.\n\n${lines.join('\n')}\n\nOpen: https://perpetualpicks.com/app.html`,
  }).catch(() => null)));
  return voided.length;
}

/**
 * The UFC card's picks, once each to the users who asked for ticket
 * emails, the way sendTicketNotifications does for the day's tickets:
 * a flag per card lists the picks already sent, so a pick added on a
 * later read goes out on its own.
 */
export async function sendUfcTicketNotifications(env, now = Date.now(), { deps = {} } = {}) {
  if (!env.EMAIL && !deps.send) return 0;
  const current = await (deps.current ? deps.current() : getUfcPicks(env, now).then((d) => d.current));
  const bets = (current?.bets ?? []).filter((b) => b.status === 'pending');
  if (!bets.length) return 0;
  const flagKey = `ufc:picks:${current.eventId}:notified`;
  const notified = new Set(JSON.parse((await env.POTD_KV.get(flagKey)) ?? '[]'));
  const fresh = bets.filter((b) => !notified.has(b.id));
  if (!fresh.length) return 0;
  const users = await (deps.users ? deps.users() : fetchOptedInUsers(env, 'notify_picks_email'));
  if (users.length) {
    const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(current.eventDate ?? now);
    const pickHtml = (b) => `<div style="margin: 0 0 14px; padding: 14px; border: 1px solid rgba(217,70,239,0.3); border-radius: 10px;">
      <div style="font-weight: bold; color: #e0e0ff;">${b.legs[0].selection} <span style="color:#00d9ff;">${formatAmerican(b.american)}</span> <span style="color:#7070aa; font-weight: normal;">&middot; ${b.book} &middot; ${b.units} unit</span></div>
      <div style="color:#a0a0cc; font-size:12px; margin-top:4px;">${b.legs[0].a} vs ${b.legs[0].b} &middot; ${b.legs[0].weightClass ?? ''} &middot; confidence ${b.legs[0].confidence} of 5</div>
      ${b.legs[0].note ? `<div style="color:#e0e0ff; font-size:13px; margin-top:8px;">${b.legs[0].note}</div>` : ''}
      ${b.link || b.bookUrl ? `<p style="margin: 10px 0 0;"><a href="${b.link ?? b.bookUrl}" style="color:#d946ef;">Open ${b.book}</a></p>` : ''}
    </div>`;
    const pickText = (b) => `${b.legs[0].selection} ${formatAmerican(b.american)} at ${b.book} (${b.units} unit) - ${b.legs[0].a} vs ${b.legs[0].b}, confidence ${b.legs[0].confidence} of 5${b.legs[0].note ? `\n  ${b.legs[0].note}` : ''}`;
    const subject = `Pixel's Picks for ${current.eventName}: ${fresh.length} pick${fresh.length === 1 ? '' : 's'}`;
    const sendOne = deps.send ?? ((msg) => env.EMAIL.send(msg));
    await Promise.all(users.map((user) => sendOne({
      to: user.email, subject,
      html: `<div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">${EMAIL_LOGO_HTML}
        <h2 style="color: #d946ef; margin-bottom: 4px;">${current.eventName}</h2><p style="color: #7070aa; font-size: 13px; margin: 0 0 20px;">Hi ${user.username}, ${when} ET. One unit each; picks lock at the first bout.</p>
        ${fresh.map(pickHtml).join('')}
        <div style="text-align: center; margin: 24px 0 0;"><a href="https://perpetualpicks.com/app.html" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open the card</a></div>
        <p style="margin-top: 24px; color: #7070aa; font-size: 11px; text-align: center;">Turn this off any time at <a href="https://perpetualpicks.com/account.html" style="color: #7070aa;">perpetualpicks.com/account.html</a></p></div></div>`,
      text: `Hi ${user.username}, Pixel's Picks for ${current.eventName} (${when} ET), one unit each, locked at the first bout:\n\n${fresh.map(pickText).join('\n\n')}\n\nOpen: https://perpetualpicks.com/app.html`,
    }).catch(() => null)));
  }
  await env.POTD_KV.put(flagKey, JSON.stringify([...notified, ...fresh.map((b) => b.id)]), { expirationTtl: 30 * 86400 });
  return users.length ? fresh.length : 0;
}
