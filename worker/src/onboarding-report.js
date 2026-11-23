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

/**
 * Account health for the owner's digest (2026-11-23, the owner: "look over
 * users trends, anything being abused?"). Counts only, no name or address:
 * the accounts and how many never verified, one mailbox behind several
 * accounts (dots and +tags removed, the way a mail provider reads them),
 * the busiest hour of signups this week, and the week's reports (many
 * from one account, links, the same text again). Usage is not here: the
 * daily count is kept outside the database, where it cannot be got round
 * by a second row. `flags` are the sentences worth a look; an empty list
 * means nothing stands out. Returns null when the tables cannot be read,
 * so the digest still goes.
 */
export async function accountHealth(env, now = Date.now()) {
  const first = async (sql, ...bind) => (await env.DB.prepare(sql).bind(...bind).first()) ?? {};
  const week = now - 7 * 86400000;
  try {
    const users = await first('SELECT COUNT(*) total, SUM(email_verified = 1) verified, SUM(CASE WHEN email_verified = 0 AND created_at < ? THEN 1 ELSE 0 END) stale FROM users', week);
    const shared = await first("SELECT COUNT(*) mailboxes, COALESCE(SUM(n), 0) accounts, COALESCE(MAX(n), 0) most FROM (SELECT COUNT(*) n FROM (SELECT replace(CASE WHEN instr(l, '+') > 0 THEN substr(l, 1, instr(l, '+') - 1) ELSE l END, '.', '') || '#' || d k FROM (SELECT lower(substr(email, 1, instr(email, '@') - 1)) l, lower(substr(email, instr(email, '@') + 1)) d FROM users)) GROUP BY k HAVING n > 1)");
    const burst = await first("SELECT COALESCE(MAX(n), 0) most FROM (SELECT COUNT(*) n FROM users WHERE created_at >= ? GROUP BY strftime('%Y-%m-%d %H', created_at / 1000, 'unixepoch'))", week);
    const reports = await first("SELECT COUNT(*) total, COALESCE(SUM(message LIKE '%http%'), 0) links FROM bug_reports WHERE created_at >= ?", week);
    const reporter = await first('SELECT COALESCE(MAX(n), 0) most FROM (SELECT COUNT(*) n FROM bug_reports WHERE created_at >= ? GROUP BY user_id)', week);
    const repeats = await first('SELECT COUNT(*) texts FROM (SELECT COUNT(*) n FROM bug_reports WHERE created_at >= ? GROUP BY message HAVING n > 1)', week);
    const n = (x) => Number(x ?? 0);
    const counts = {
      accounts: n(users.total), verified: n(users.verified), unverifiedOverAWeek: n(users.stale),
      sharedMailboxes: n(shared.mailboxes), sharedAccounts: n(shared.accounts), mostOnOneMailbox: n(shared.most),
      busiestSignupHour: n(burst.most),
      reportsThisWeek: n(reports.total), reportsWithLinks: n(reports.links), mostReportsFromOne: n(reporter.most), repeatedReportTexts: n(repeats.texts),
    };
    const flags = [];
    if (counts.sharedMailboxes) flags.push(`${counts.sharedMailboxes} mailbox${counts.sharedMailboxes === 1 ? ' is' : 'es are'} behind ${counts.sharedAccounts} accounts (the most on one: ${counts.mostOnOneMailbox}). One person signing up more than once.`);
    if (counts.busiestSignupHour >= 5) flags.push(`${counts.busiestSignupHour} signups landed in one hour this week. A burst like that is usually a script or a shared link.`);
    if (counts.unverifiedOverAWeek >= 10 && counts.unverifiedOverAWeek > counts.accounts * 0.2) flags.push(`${counts.unverifiedOverAWeek} of ${counts.accounts} accounts are over a week old and never verified their email.`);
    if (counts.mostReportsFromOne > 5) flags.push(`One account sent ${counts.mostReportsFromOne} reports this week.`);
    if (counts.reportsWithLinks) flags.push(`${counts.reportsWithLinks} report${counts.reportsWithLinks === 1 ? '' : 's'} this week carried a link, which is how spam arrives.`);
    if (counts.repeatedReportTexts) flags.push(`${counts.repeatedReportTexts} report text${counts.repeatedReportTexts === 1 ? ' was' : 's were'} sent more than once this week.`);
    return { counts, flags };
  } catch (e) {
    console.error('Account health failed:', e);
    return null;
  }
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

  const health = await accountHealth(env, now);
  const hc = health?.counts;
  const healthLines = hc ? [
    ['Accounts', `${hc.accounts} (${hc.verified} verified)`],
    ['Never verified, over a week old', String(hc.unverifiedOverAWeek)],
    ['Most signups in one hour this week', String(hc.busiestSignupHour)],
    ['Reports this week', String(hc.reportsThisWeek)],
  ] : [];
  const healthHtml = health ? `
        <h3 style="color: #d946ef; margin: 28px 0 8px; font-size: 15px;">Account health</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 12px;"><tbody>
          ${healthLines.map(([k, v]) => `<tr><td style="padding:6px 12px; color:#a0a0cc;">${k}</td><td style="padding:6px 12px; font-weight:bold;">${escapeHtml(v)}</td></tr>`).join('')}
        </tbody></table>
        ${health.flags.length ? `<ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.5; color: #ffd27a;">${health.flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '<p style="font-size: 14px; color: #7fe0a8; margin: 0;">Nothing stands out: no shared mailboxes, no signup bursts, no report spam.</p>'}` : '';
  const healthText = health ? `\n\nAccount health\n${healthLines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${health.flags.length ? health.flags.map((f) => `! ${f}`).join('\n') : 'Nothing stands out.'}` : '';

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
        </table>${healthHtml}
      </div>
    </div>`;

  const text =
    `Daily Onboarding Report — ${todayKey} (ET)\n\n` +
    `Onboarded today: ${todayUsers.length}\n` +
    `Onboarded this week: ${weekCount}\n` +
    `Onboarded this month: ${monthCount}\n\n` +
    `Today's signups:\n${rowsText}${healthText}`;

  try {
    await env.EMAIL.send({
      to: ADMIN_EMAIL,
      from: FROM,
      subject: `PerpetualPicks Onboarding — ${todayUsers.length} today (${todayKey})${health?.flags.length ? ` · ${health.flags.length} to look at` : ''}`,
      html,
      text,
    });
  } catch (e) {
    console.error('Daily onboarding report send failed:', e);
  }
}
