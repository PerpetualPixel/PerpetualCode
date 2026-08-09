import { summarizePicks } from '../../docs/learning.js';
import { getAllTrackedPicks } from './tracking.js';
import { getAllFullSlateTracked } from './full-slate-tracking.js';
import { getPotdHistory } from './potd.js';
import { EMAIL_LOGO_HTML } from './auth-handlers.js';

/**
 * The optional weekly tracking-dashboard digest (off by default — see
 * worker/src/account-handlers.js's notify_tracking_report_email toggle).
 * Reuses summarizePicks(), the exact same win/loss/ROI math the client's own
 * Tracking Dashboard already computes from this data, so the email can never
 * disagree with what a user sees in the app.
 */

const FROM = { email: 'picks@perpetualpicks.com', name: 'PerpetualPicks' };
const REPORT_WINDOW_DAYS = 7;
const SEND_CONCURRENCY = 5;

async function fetchOptedInUsers(env) {
  const { results } = await env.DB.prepare(
    'SELECT email, username FROM users WHERE notify_tracking_report_email = 1 AND email_verified = 1',
  ).all();
  return results ?? [];
}

function summaryRowHtml(label, summary) {
  const record = `${summary.wins}-${summary.losses}${summary.voided ? ` <span style="color:#7070aa;">(${summary.voided} void)</span>` : ''}`;
  const roiColor = summary.roi >= 0 ? '#4ade80' : '#ff6b6b';
  return `<tr>
    <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15);">${label}</td>
    <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15);">${record}</td>
    <td style="padding:8px 12px; border-bottom:1px solid rgba(217,70,239,0.15); color:${roiColor};">${summary.roi.toFixed(1)}%</td>
  </tr>`;
}

function summaryRowText(label, summary) {
  const record = `${summary.wins}-${summary.losses}${summary.voided ? ` (${summary.voided} void)` : ''}`;
  return `${label}: ${record}, ${summary.roi.toFixed(1)}% ROI`;
}

export async function sendWeeklyTrackingReport(env, now = Date.now()) {
  if (!env.EMAIL) return;
  const users = await fetchOptedInUsers(env);
  if (!users.length) return;

  const [top5, slate, potdHistory] = await Promise.all([
    getAllTrackedPicks(env, { now, days: REPORT_WINDOW_DAYS }),
    getAllFullSlateTracked(env, { now, days: REPORT_WINDOW_DAYS }),
    getPotdHistory(env, { now, days: REPORT_WINDOW_DAYS }),
  ]);

  const sections = [
    ["Pixel's Picks", summarizePicks(top5)],
    ['Full Slate', summarizePicks(slate)],
    ['Play of the Day', summarizePicks(potdHistory)],
  ];

  const rowsHtml = sections.map(([label, s]) => summaryRowHtml(label, s)).join('');
  const rowsText = sections.map(([label, s]) => summaryRowText(label, s)).join('\n');

  const buildHtml = (username) => `
    <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
        ${EMAIL_LOGO_HTML}
        <h2 style="color: #d946ef; margin-bottom: 8px;">Your Weekly Tracking Report</h2>
        <p style="color: #7070aa; font-size: 13px; margin-bottom: 24px;">Hi ${username} — last ${REPORT_WINDOW_DAYS} days across every board.</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Board</th>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Record</th>
              <th style="text-align:left; padding:8px 12px; color:#a0a0cc; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">ROI</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="text-align: center; margin: 28px 0 0;">
          <a href="https://perpetualpicks.com/index.html" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open Tracking Dashboard</a>
        </div>
        <p style="margin-top: 24px; color: #7070aa; font-size: 11px; text-align: center;">
          Turn this off any time at <a href="https://perpetualpicks.com/account.html" style="color: #7070aa;">perpetualpicks.com/account.html</a>
        </p>
      </div>
    </div>`;

  const buildText = (username) =>
    `Hi ${username}, your Weekly Tracking Report — last ${REPORT_WINDOW_DAYS} days\n\n` +
    rowsText +
    `\n\nOpen: https://perpetualpicks.com/index.html`;

  const queue = [...users];
  const worker = async () => {
    while (queue.length) {
      const user = queue.shift();
      try {
        await env.EMAIL.send({
          to: user.email,
          from: FROM,
          subject: 'Your Weekly PerpetualPicks Tracking Report',
          html: buildHtml(user.username),
          text: buildText(user.username),
        });
      } catch (e) {
        console.error(`Weekly report send failed for ${user.email}:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
}
