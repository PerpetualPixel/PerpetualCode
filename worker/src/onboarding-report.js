import { EMAIL_LOGO_HTML } from './auth-handlers.js';

/**
 * Daily 8pm ET admin digest of new signups — owner-only, not a user-facing
 * opt-in like weekly-report.js. Always sent to ADMIN_EMAIL; gated in
 * worker/src/index.js's scheduled() by ADMIN_REPORT_HOUR.
 */

const FROM = { email: 'picks@perpetualpicks.com', name: 'PerpetualPicks' };
const ADMIN_EMAIL = 'miguelsgarcia4@outlook.com';
const ET_TZ = 'America/New_York';
// Covers the current ET calendar month from any day within it (at most 31
// days back to the 1st), plus a couple days of slack.
const LOOKBACK_DAYS = 32;

/** ET calendar date (YYYY-MM-DD), its year-month (YYYY-MM), and weekday
 * (0=Sun..6=Sat) for a given instant. */
function etParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    weekday: days.indexOf(parts.weekday),
  };
}

/** The ET calendar date N days before the date containing `ms`. */
function etDateMinusDays(ms, days) {
  return etParts(ms - days * 86400000).date;
}

async function fetchRecentUsers(env, now) {
  const since = now - LOOKBACK_DAYS * 86400000;
  const { results } = await env.DB.prepare(
    'SELECT username, email, created_at FROM users WHERE created_at >= ? ORDER BY created_at ASC',
  )
    .bind(since)
    .all();
  return results ?? [];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export async function sendDailyOnboardingReport(env, now = Date.now()) {
  if (!env.EMAIL) return;

  const users = await fetchRecentUsers(env, now);
  const todayKey = etParts(now).date;
  const monthKey = etParts(now).month;
  // Calendar week, Monday-start.
  const daysSinceMonday = (etParts(now).weekday + 6) % 7;
  const weekStartKey = etDateMinusDays(now, daysSinceMonday);

  const todayUsers = [];
  let weekCount = 0;
  let monthCount = 0;
  for (const u of users) {
    const dateKey = etParts(u.created_at).date;
    if (dateKey === todayKey) todayUsers.push(u);
    if (dateKey >= weekStartKey && dateKey <= todayKey) weekCount++;
    if (dateKey.slice(0, 7) === monthKey) monthCount++;
  }

  const rowsHtml = todayUsers.length
    ? todayUsers
        .map(
          (u) => `<tr>
            <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15);">${escapeHtml(u.username ?? '(no username)')}</td>
            <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15);">${escapeHtml(u.email)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="2" style="padding:8px 12px; color:#7070aa;">No new signups today.</td></tr>`;

  const rowsText = todayUsers.length
    ? todayUsers.map((u) => `- ${u.username ?? '(no username)'} <${u.email}>`).join('\n')
    : 'No new signups today.';

  const html = `
    <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
        ${EMAIL_LOGO_HTML}
        <h2 style="color: #d946ef; margin-bottom: 8px;">Daily Onboarding Report</h2>
        <p style="color: #7070aa; font-size: 13px; margin-bottom: 24px;">${todayKey} (ET)</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
          <tbody>
            <tr><td style="padding:6px 12px; color:#a0a0cc;">Onboarded today</td><td style="padding:6px 12px; font-weight:bold;">${todayUsers.length}</td></tr>
            <tr><td style="padding:6px 12px; color:#a0a0cc;">Onboarded this week</td><td style="padding:6px 12px; font-weight:bold;">${weekCount}</td></tr>
            <tr><td style="padding:6px 12px; color:#a0a0cc;">Onboarded this month</td><td style="padding:6px 12px; font-weight:bold;">${monthCount}</td></tr>
          </tbody>
        </table>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Username</th>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Email</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;

  const text =
    `Daily Onboarding Report — ${todayKey} (ET)\n\n` +
    `Onboarded today: ${todayUsers.length}\n` +
    `Onboarded this week: ${weekCount}\n` +
    `Onboarded this month: ${monthCount}\n\n` +
    `Today's signups:\n${rowsText}`;

  try {
    await env.EMAIL.send({
      to: ADMIN_EMAIL,
      from: FROM,
      subject: `PerpetualPicks Onboarding — ${todayUsers.length} today (${todayKey})`,
      html,
      text,
    });
  } catch (e) {
    console.error('Daily onboarding report send failed:', e);
  }
}
