import { verifyJWT, jwtSecret, EMAIL_LOGO_HTML } from './auth-handlers.js';

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const VALID_TYPES = new Set(['bug', 'suggestion']);
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Notifies bugs@perpetualpicks.com — a Cloudflare Email Routing address,
 * not a personal inbox. The owner sets up forwarding from that address to
 * their own email entirely on the Cloudflare dashboard side (a routing
 * rule + a one-time click-to-verify on the real destination); nothing here
 * ever sees or stores that personal address. If Email Routing isn't set up
 * for bugs@ yet, this send will simply fail to deliver anywhere — the
 * report is still saved in D1 either way, so nothing is lost while that's
 * being configured.
 */
async function notifyBugReportInbox(env, report) {
  if (!env.EMAIL) return;

  const typeLabel = report.type === 'suggestion' ? 'Suggestion' : 'Bug Report';

  await env.EMAIL.send({
    to: 'bugs@perpetualpicks.com',
    from: { email: 'verify@perpetualpicks.com', name: 'PerpetualPicks' },
    subject: `[Ticket #${report.id}] ${typeLabel} from ${report.username}`,
    html: `
      <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
          ${EMAIL_LOGO_HTML}
          <h2 style="color: #d946ef; margin-bottom: 8px;">Ticket #${report.id} &mdash; ${typeLabel}</h2>
          <p style="color: #7070aa; font-size: 13px; margin-bottom: 20px;">
            From ${report.username} (${report.email})
          </p>
          <p style="white-space: pre-wrap; background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; line-height: 1.6;">${report.message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
        </div>
      </div>`,
    text: `Ticket #${report.id} — ${typeLabel}\nFrom ${report.username} (${report.email})\n\n${report.message}`,
  });
}

export async function handleReportBug(request, env) {
  try {
    const auth = request.headers.get('Authorization') || '';
    const payload = verifyJWT(auth.replace('Bearer ', ''), jwtSecret(env));
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Expected a JSON body' }, { status: 400 });

    const message = String(body.message ?? '').trim();
    if (!message) return json({ error: 'message required' }, { status: 400 });
    if (message.length > MAX_MESSAGE_LENGTH) {
      return json({ error: `message must be under ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 });
    }

    const type = VALID_TYPES.has(body.type) ? body.type : 'bug';

    const user = await env.DB.prepare('SELECT email, username FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!user) return json({ error: 'user not found' }, { status: 404 });

    const now = Date.now();
    const insertResult = await env.DB.prepare(
      'INSERT INTO bug_reports (user_id, email, username, type, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(payload.userId, user.email, user.username, type, message, 'open', now)
      .run();

    const ticketId = insertResult.meta.last_row_id;

    // Best-effort, same philosophy as every other outbound email in this
    // app: the report is already durably saved in D1 above, so a transport
    // hiccup here shouldn't fail the whole request — the ticket still
    // exists and can be found/actioned even if this particular send failed.
    try {
      await notifyBugReportInbox(env, { id: ticketId, email: user.email, username: user.username, type, message });
    } catch (emailErr) {
      console.error('Bug report notification send failed:', emailErr);
    }

    return json({ ticketId }, { status: 201 });
  } catch (e) {
    console.error('Report bug error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}
