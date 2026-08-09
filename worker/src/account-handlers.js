import { hashPassword, verifyPassword, generateVerificationToken, generateJWT } from './auth-email.js';
import { authenticateRequest, jwtSecret, EMAIL_LOGO_HTML } from './auth-handlers.js';
import { validateUsername } from './username-policy.js';

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Every account-settings endpoint authenticates through the shared
// epoch-checked helper (see auth-handlers.js's authenticateRequest) so
// "Sign Out Everywhere" and password changes revoke access here too.
const authenticate = authenticateRequest;

export async function handleUpdateUsername(request, env) {
  try {
    const payload = await authenticate(request, env);
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
    const payload = await authenticate(request, env);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword) {
      return json({ error: 'currentPassword and newPassword required' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return json({ error: 'newPassword must be at least 8 characters' }, { status: 400 });
    }

    const user = await env.DB.prepare('SELECT password_hash, email, session_epoch FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!user) return json({ error: 'user not found' }, { status: 404 });

    const currentValid = await verifyPassword(currentPassword, user.password_hash);
    if (!currentValid) {
      return json({ error: 'current password is incorrect' }, { status: 401 });
    }

    // Changing the password revokes every other outstanding session by
    // bumping session_epoch (see auth-handlers.js's authenticateRequest) —
    // the standard "someone may have had my old password" behavior. The
    // response carries a fresh token stamped with the NEW epoch so the one
    // session that legitimately made this change survives; the client
    // swaps it into storage (see account.html's password form handler).
    const newEpoch = (user.session_epoch ?? 0) + 1;
    const newHash = await hashPassword(newPassword);
    await env.DB.prepare('UPDATE users SET password_hash = ?, session_epoch = ?, updated_at = ? WHERE id = ?')
      .bind(newHash, newEpoch, Date.now(), payload.userId)
      .run();

    const freshToken = generateJWT(
      { userId: payload.userId, email: user.email, epoch: newEpoch },
      jwtSecret(env),
    );

    return json({ message: 'password updated — other devices have been signed out', token: freshToken });
  } catch (e) {
    console.error('Update password error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

/**
 * "Sign Out Everywhere": bumps session_epoch, instantly invalidating every
 * outstanding token for this account — including the one making this
 * request, which is the point (the client clears its own storage and
 * returns to login).
 */
export async function handleLogoutAll(request, env) {
  try {
    const payload = await authenticate(request, env);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    await env.DB.prepare(
      'UPDATE users SET session_epoch = COALESCE(session_epoch, 0) + 1, updated_at = ? WHERE id = ?',
    )
      .bind(Date.now(), payload.userId)
      .run();

    return json({ message: 'signed out everywhere' });
  } catch (e) {
    console.error('Logout-all error:', e);
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
    const payload = await authenticate(request, env);
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
    const payload = await authenticate(request, env);
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

/**
 * Permanent self-service account deletion. Requires the current password
 * (a JWT alone isn't enough — a stolen/leftover session on a shared device
 * shouldn't be able to destroy the account). Removes everything this app
 * stores about the person: the users row, their bug reports (those rows
 * carry a copy of their email/username), and their KV settings record.
 * The shared pick-tracking history is untouched — it was never per-user.
 */
export async function handleDeleteAccount(request, env) {
  try {
    const payload = await authenticate(request, env);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const { currentPassword } = await request.json();
    if (!currentPassword) {
      return json({ error: 'currentPassword required to delete your account' }, { status: 400 });
    }

    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!user) return json({ error: 'user not found' }, { status: 404 });

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) return json({ error: 'password is incorrect' }, { status: 401 });

    await env.DB.prepare('DELETE FROM bug_reports WHERE user_id = ?').bind(payload.userId).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(payload.userId).run();
    // Per-account bankroll/settings record lives in KV, keyed by userId —
    // see worker/src/settings.js's settingsKey().
    try {
      await env.POTD_KV.delete(`settings:${payload.userId}`);
    } catch (kvErr) {
      // The account row is already gone (the part that matters for being
      // able to sign in / be emailed) — an orphaned settings blob is
      // unreachable without it, so log rather than fail the deletion.
      console.error('Settings KV cleanup failed during account deletion:', kvErr);
    }

    return json({ message: 'account deleted' });
  } catch (e) {
    console.error('Delete account error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}
