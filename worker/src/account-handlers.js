import { hashPassword, verifyPassword, generateVerificationToken } from './auth-email.js';
import { verifyJWT, jwtSecret, EMAIL_LOGO_HTML } from './auth-handlers.js';
import { validateUsername } from './username-policy.js';

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Every account-settings endpoint requires a valid JWT — returns the
 * decoded payload, or null if the request isn't authenticated. */
function authenticate(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return verifyJWT(token, jwtSecret());
}

export async function handleUpdateUsername(request, env) {
  try {
    const payload = authenticate(request);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const { username } = await request.json();
    const usernameCheck = validateUsername(username);
    if (!usernameCheck.ok) {
      return json({ error: usernameCheck.error }, { status: 400 });
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .bind(username, payload.userId)
      .first();
    if (existing) {
      return json({ error: 'username already taken' }, { status: 409 });
    }

    await env.DB.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?')
      .bind(username, Date.now(), payload.userId)
      .run();

    return json({ username });
  } catch (e) {
    console.error('Update username error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleUpdatePassword(request, env) {
  try {
    const payload = authenticate(request);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword) {
      return json({ error: 'currentPassword and newPassword required' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return json({ error: 'newPassword must be at least 8 characters' }, { status: 400 });
    }

    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!user) return json({ error: 'user not found' }, { status: 404 });

    const currentValid = await verifyPassword(currentPassword, user.password_hash);
    if (!currentValid) {
      return json({ error: 'current password is incorrect' }, { status: 401 });
    }

    const newHash = await hashPassword(newPassword);
    await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(newHash, Date.now(), payload.userId)
      .run();

    // Note: existing JWTs issued before this change stay valid until they
    // naturally expire (30 days) — there's no token-revocation list. Not a
    // concern for this app's current scale; worth revisiting if it ever is.
    return json({ message: 'password updated' });
  } catch (e) {
    console.error('Update password error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

async function sendEmailChangeVerification(env, newEmail, username, token) {
  if (!env.EMAIL) throw new Error('Email service not configured');

  const confirmUrl = `https://perpetualpicks.com/account.html?emailToken=${token}`;

  await env.EMAIL.send({
    to: newEmail,
    from: { email: 'verify@perpetualpicks.com', name: 'PerpetualPicks' },
    subject: 'Confirm Your New Email - PerpetualPicks',
    html: `
      <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
          ${EMAIL_LOGO_HTML}
          <h2 style="color: #d946ef; margin-bottom: 20px;">Confirm Your New Email</h2>
          <p style="margin-bottom: 30px;">Hi ${username}, you requested to change your PerpetualPicks account email to this address. Click below to confirm:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${confirmUrl}" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Confirm New Email</a>
          </div>
          <p style="margin-top: 30px; color: #7070aa; font-size: 12px; text-align: center;">Link expires in 24 hours. If you didn't request this change, you can safely ignore this email — your account email won't change unless this link is clicked.</p>
          <p style="text-align: center; color: #a0a0cc; font-size: 12px; word-break: break-all;">${confirmUrl}</p>
        </div>
      </div>
    `,
    text: `Hi ${username}, confirm your new email: ${confirmUrl}\n\nThis link expires in 24 hours. If you didn't request this, ignore this email.`,
  });
}

export async function handleRequestEmailChange(request, env) {
  try {
    const payload = authenticate(request);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const { newEmail } = await request.json();
    if (!newEmail) return json({ error: 'newEmail required' }, { status: 400 });

    const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(newEmail, payload.userId)
      .first();
    if (taken) return json({ error: 'email already in use' }, { status: 409 });

    const self = await env.DB.prepare('SELECT username FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();

    const token = generateVerificationToken();
    const expires = Date.now() + 24 * 60 * 60 * 1000;

    await env.DB.prepare(
      'UPDATE users SET pending_email = ?, pending_email_token = ?, pending_email_token_expires = ?, updated_at = ? WHERE id = ?',
    )
      .bind(newEmail, token, expires, Date.now(), payload.userId)
      .run();

    // Matches handleRegister's own send-failure handling: the pending_email
    // row above is the actual state that matters and is already saved, so a
    // transport hiccup (temporary bounce, transient send failure) shouldn't
    // surface as a raw 500 — the row stays there either way, so resending is
    // just calling this endpoint again with the same newEmail.
    try {
      await sendEmailChangeVerification(env, newEmail, self?.username ?? 'there', token);
    } catch (emailErr) {
      console.error('Email change verification send failed:', emailErr);
    }

    return json({ message: 'Check your new email to confirm the change.' });
  } catch (e) {
    console.error('Request email change error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleConfirmEmailChange(request, env) {
  try {
    const { token } = await request.json();
    if (!token) return json({ error: 'token required' }, { status: 400 });

    const user = await env.DB.prepare(
      'SELECT id, pending_email, pending_email_token_expires FROM users WHERE pending_email_token = ?',
    )
      .bind(token)
      .first();

    if (!user) return json({ error: 'invalid or already-used token' }, { status: 404 });
    if (user.pending_email_token_expires < Date.now()) {
      return json({ error: 'token expired' }, { status: 401 });
    }

    await env.DB.prepare(
      `UPDATE users SET email = ?, pending_email = NULL, pending_email_token = NULL,
       pending_email_token_expires = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(user.pending_email, Date.now(), user.id)
      .run();

    return json({ message: 'email updated', email: user.pending_email });
  } catch (e) {
    console.error('Confirm email change error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleUpdateNotifications(request, env) {
  try {
    const payload = authenticate(request);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const body = await request.json();
    // Piecemeal update — only touches fields actually present in the body.
    // SMS fields are deliberately not accepted here: real SMS sending isn't
    // built yet (see docs/login.html's disabled "text me" checkbox), so
    // there's nothing meaningful to opt into.
    const fields = [];
    const values = [];
    if ('potdEmail' in body) { fields.push('notify_potd_email = ?'); values.push(body.potdEmail ? 1 : 0); }
    if ('picksEmail' in body) { fields.push('notify_picks_email = ?'); values.push(body.picksEmail ? 1 : 0); }
    if ('trackingReportEmail' in body) {
      fields.push('notify_tracking_report_email = ?');
      values.push(body.trackingReportEmail ? 1 : 0);
    }

    if (!fields.length) return json({ error: 'no recognized notification fields in body' }, { status: 400 });

    values.push(Date.now(), payload.userId);
    await env.DB.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...values)
      .run();

    return json({ message: 'notification preferences updated' });
  } catch (e) {
    console.error('Update notifications error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}
