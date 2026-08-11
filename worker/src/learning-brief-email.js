import { EMAIL_LOGO_HTML } from './auth-handlers.js';

/**
 * Plain-language admin briefing for days the daily learning review actually
 * changed something — owner-only, same recipient/sender as
 * onboarding-report.js. Deliberately NOT the technical report the dashboard
 * shows (z-scores, x0.923 multipliers): the ask was a one-minute read in
 * the voice of an engineer giving their boss a quick hallway update — key
 * numbers, what moved, why, no computation garbage.
 *
 * Sends ONLY when runDailyLearning's structured `changes` list is
 * non-empty. A quiet day sends nothing — an inbox full of "no changes
 * today" is how real changes get skimmed past.
 *
 * Every sentence still traces to a value the review actually computed
 * (docs/insights.js's rule, applied to prose): records, ROI, and
 * expected-wins come straight from the evidence object; the only
 * "translation" is formatting a x0.92 multiplier as "8% harder to make the
 * board."
 */

const FROM = { email: 'picks@perpetualpicks.com', name: 'PerpetualPicks' };
const ADMIN_EMAIL = 'miguelsgarcia4@outlook.com';

const pct = (w) => Math.round(Math.abs(1 - w) * 100);

/** One change -> one plain sentence with its evidence inline. */
export function describeChange(change) {
  const s = change.stats;
  const record = s ? `${s.wins} of ${s.n} (the math expected ~${Math.round(s.expectedWins)})` : null;
  const marketNote = s && typeof s.avgClvPts === 'number' && s.avgClvPts <= -0.5
    ? ' Closing prices have been moving against these too, which is usually the fastest honest tell.'
    : '';

  if (change.kind === 'cleared') {
    return `Took the training wheels off ${change.label} — ${s ? `it went ${record} and that's back in its normal range.` : 'not enough recent volume to keep judging it, so it rides at full weight again.'}`;
  }
  const now = change.now;
  if (now < 1) {
    const verb = change.kind === 'added' ? `Easing off ${change.label}` : `Easing off ${change.label} a bit more`;
    return `${verb} — ${record ? `they've gone ${record}.` : 'recent results ran under expectation.'} They now need a roughly ${pct(now)}% better case to make the board.${marketNote}`;
  }
  const verb = change.kind === 'added' ? `Giving ${change.label} a small nudge up` : `Nudging ${change.label} up a touch more`;
  return `${verb} — ${record ? `they've gone ${record}.` : 'recent results beat expectation.'} Worth about ${pct(now)}% extra benefit of the doubt (that's the cap; winners get chased slowly on purpose).`;
}

const fmtRecord = (stats) => `${stats.wins}-${stats.n - stats.wins}`;
const fmtRoi = (roi) => `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;

/**
 * The one-minute read. `review` is runDailyLearning's non-skipped result;
 * needs review.changes (structured) and review.yesterdayStats/windowStats.
 */
export async function sendLearningBriefEmail(env, review, now = Date.now()) {
  if (!env.EMAIL) return { sent: false, reason: 'no EMAIL binding' };
  const changes = review?.changes ?? [];
  if (!changes.length) return { sent: false, reason: 'no changes today' };

  const y = review.yesterdayStats;
  const w = review.windowStats;

  const yesterdayLine = y && y.n > 0
    ? (y.roi < 0
      ? `Rough one yesterday: ${fmtRecord(y)}, ROI ${fmtRoi(y.roi)}.`
      : `Decent day yesterday: ${fmtRecord(y)}, ROI ${fmtRoi(y.roi)}.`)
    : 'No graded picks yesterday.';
  const windowLine = w
    ? `Bigger picture: over the last 30 days we're ${fmtRecord(w)} with ROI ${fmtRoi(w.roi)}.`
    : '';

  const changeSentences = changes.map(describeChange);
  const nChanges = changes.length;

  const text =
    `Morning — quick update from the picks engine.\n\n` +
    `${yesterdayLine} ${windowLine}\n\n` +
    `This morning's review made ${nChanges} adjustment${nChanges === 1 ? '' : 's'}:\n\n` +
    changeSentences.map((s) => `• ${s}`).join('\n') +
    `\n\nHow this works: nothing already picked or graded gets touched — these only change what makes tomorrow's board. ` +
    `A cold segment has to show a clearly better price to get picked; a hot one gets a small nudge at most. ` +
    `If a segment straightens out, its adjustment clears on its own.\n\n` +
    `Full detail (the nerd version) is on the Tracking Dashboard under Daily Learning.\n\n— the engine`;

  const changesHtml = changeSentences
    .map((s) => `<li style="margin-bottom:10px; line-height:1.5;">${escapeHtml(s)}</li>`)
    .join('');

  const html = `
    <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
        ${EMAIL_LOGO_HTML}
        <h2 style="color: #d946ef; margin-bottom: 8px;">Algorithm check-in — ${escapeHtml(review.dateKey)}</h2>
        <p style="line-height:1.6;">Morning — quick update from the picks engine.</p>
        <p style="line-height:1.6;"><strong>${escapeHtml(yesterdayLine)}</strong> ${escapeHtml(windowLine)}</p>
        <p style="line-height:1.6;">This morning's review made <strong>${nChanges} adjustment${nChanges === 1 ? '' : 's'}</strong>:</p>
        <ul style="padding-left: 20px;">${changesHtml}</ul>
        <p style="color:#a0a0cc; font-size: 13px; line-height:1.6;">
          How this works: nothing already picked or graded gets touched — these only change what makes
          tomorrow's board. A cold segment has to show a clearly better price to get picked; a hot one
          gets a small nudge at most. If a segment straightens out, its adjustment clears on its own.
        </p>
        <p style="color:#7070aa; font-size: 12px;">Full detail (the nerd version) is on the Tracking Dashboard under Daily Learning.</p>
        <p style="color:#a0a0cc;">— the engine</p>
      </div>
    </div>`;

  try {
    await env.EMAIL.send({
      to: ADMIN_EMAIL,
      from: FROM,
      subject: `Algo check-in: ${nChanges} adjustment${nChanges === 1 ? '' : 's'} this morning (${review.dateKey})`,
      html,
      text,
    });
    return { sent: true, changes: nChanges };
  } catch (e) {
    console.error('Learning brief email send failed:', e);
    return { sent: false, reason: String(e).slice(0, 120) };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
