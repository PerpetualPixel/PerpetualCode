import { getTrendPicks, betRecordOf } from './trend-picks.js';
import { EMAIL_LOGO_HTML } from './auth-handlers.js';

/**
 * The optional weekly tracking digest (off by default; see
 * worker/src/account-handlers.js's notify_tracking_report_email toggle):
 * the week's Pixel's Picks tickets, the record and the net in units and
 * dollars, overall and per league, from the same records the tab's
 * history and graph read (worker/src/trend-picks.js's getTrendPicks), so
 * the email can never disagree with the app.
 */

const FROM = { email: 'picks@perpetualpicks.com', name: 'PerpetualPicks' };
const REPORT_WINDOW_DAYS = 7;
const SEND_CONCURRENCY = 5;
const LEAGUE_LABEL = { basketball_nba: 'NBA', americanfootball_nfl: 'NFL' };

async function fetchOptedInUsers(env) {
  const { results } = await env.DB.prepare(
    'SELECT email, username FROM users WHERE notify_tracking_report_email = 1 AND email_verified = 1',
  ).all();
  return results ?? [];
}

const roi = (r) => (r == null ? 'ROI n/a' : `ROI ${r < 0 ? '' : '+'}${(r * 100).toFixed(1)}%`);
const units = (u) => `${u < 0 ? '' : '+'}${u.toFixed(2)}`;
const recordOf = (r) => `${r.wins}-${r.losses}${r.pushes ? `-${r.pushes}` : ''}${r.voids ? ` (${r.voids} void)` : ''}`;

function summaryRowHtml(label, r) {
  const color = r.dollars >= 0 ? '#4ade80' : '#ff6b6b';
  return `<tr>
    <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15);">${label}</td>
    <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15);">${recordOf(r)}</td>
    <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15); color:${color};">${units(r.units)} u &middot; ${roi(r.roi)}</td>
  </tr>`;
}
const summaryRowText = (label, r) => `${label}: ${recordOf(r)}, ${units(r.units)} units, ${roi(r.roi)}`;

/** The report's numbers for the last REPORT_WINDOW_DAYS days, from the tickets. */
export async function weeklyTicketSummary(env, now = Date.now()) {
  const data = await getTrendPicks(env, now, { days: REPORT_WINDOW_DAYS });
  const bets = data.history.flatMap((d) => d.bets ?? []).filter((b) => b.status === 'graded' || b.status === 'void');
  const tally = (list) => betRecordOf(list);
  const sections = [['All tickets', tally(bets)]];
  for (const [key, label] of Object.entries(LEAGUE_LABEL)) {
    const mine = bets.filter((b) => b.sportKey === key);
    if (mine.length) sections.push([label, tally(mine)]);
  }
  const lines = data.history.flatMap((d) => (d.bets ?? []).filter((b) => b.status === 'graded' || b.status === 'void').map((b) => ({ date: d.date, play: b.play ? b.play : b.type === 'parlay' ? `${b.legs.length}-leg parlay` : 'Straight', book: b.book, american: b.american, result: b.result, net: b.net ?? 0, legs: b.legs.map((l) => l.selection).join(' + ') })));
  return { sections, lines, settled: bets.length };
}

export async function sendWeeklyTrackingReport(env, now = Date.now(), { deps = {} } = {}) {
  if (!env.EMAIL && !deps.send) return 0;
  const users = await (deps.users ? deps.users() : fetchOptedInUsers(env));
  if (!users.length) return 0;
  const { sections, lines, settled } = await weeklyTicketSummary(env, now);
  const fmt = (american) => `${american > 0 ? '+' : ''}${american}`;
  const day = (d) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).format(Date.parse(`${d}T12:00:00Z`));
  const rowsHtml = sections.map(([label, r]) => summaryRowHtml(label, r)).join('');
  const rowsText = sections.map(([label, r]) => summaryRowText(label, r)).join('\n');
  const result = { win: 'Won', loss: 'Lost', push: 'Push', void: 'No action' };
  const linesHtml = lines.map((l) => `<li style="margin: 0 0 6px;"><span style="color:#7070aa;">${day(l.date)}</span> ${l.play} at ${l.book} ${fmt(l.american)}: ${l.legs} <span style="color:${l.net >= 0 ? '#4ade80' : '#ff6b6b'};">${result[l.result] ?? l.result}${l.result === 'void' ? '' : ` ${units(l.net)}u`}</span></li>`).join('');
  const linesText = lines.map((l) => `${day(l.date)}: ${l.play} at ${l.book} ${fmt(l.american)}, ${l.legs}: ${result[l.result] ?? l.result}${l.result === 'void' ? '' : ` ${units(l.net)}u`}`).join('\n');

  const buildHtml = (username) => `
    <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
        ${EMAIL_LOGO_HTML}
        <h2 style="color: #d946ef; margin-bottom: 8px;">Your Weekly Tracking Report</h2>
        <p style="color: #7070aa; font-size: 13px; margin-bottom: 24px;">Hi ${username}, the last ${REPORT_WINDOW_DAYS} days of Pixel's Picks tickets, one unit each.</p>
        ${settled ? `<table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Tickets</th>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Record</th>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Net</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <ul style="margin: 20px 0 0; padding-left: 18px; color: #e0e0ff; line-height: 1.6; font-size: 13px;">${linesHtml}</ul>` : '<p style="color:#a0a0cc;">No ticket settled this week.</p>'}
        <div style="text-align: center; margin: 28px 0 0;">
          <a href="https://perpetualpicks.com/app.html" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open Pixel's Picks</a>
        </div>
        <p style="margin-top: 24px; color: #7070aa; font-size: 11px; text-align: center;">
          Turn this off any time at <a href="https://perpetualpicks.com/account.html" style="color: #7070aa;">perpetualpicks.com/account.html</a>
        </p>
      </div>
    </div>`;

  const buildText = (username) =>
    `Hi ${username}, your Weekly Tracking Report: the last ${REPORT_WINDOW_DAYS} days of Pixel's Picks tickets, one unit each\n\n` +
    (settled ? `${rowsText}\n\n${linesText}` : 'No ticket settled this week.') +
    `\n\nOpen: https://perpetualpicks.com/app.html`;

  const sendOne = deps.send ?? ((msg) => env.EMAIL.send(msg));
  let sent = 0;
  const queue = [...users];
  const worker = async () => {
    while (queue.length) {
      const user = queue.shift();
      try {
        await sendOne({
          to: user.email,
          from: FROM,
          subject: 'Your Weekly PerpetualPicks Tracking Report',
          html: buildHtml(user.username),
          text: buildText(user.username),
        });
        sent++;
      } catch (e) {
        console.error(`Weekly report send failed for ${user.email}:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
  return sent;
}
