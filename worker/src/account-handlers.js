import { hashPassword, verifyPassword, generateVerificationToken, generateJWT, normalizeEmail, maskEmail } from './auth-email.js';
import { authenticateRequest, jwtSecret, EMAIL_LOGO_HTML, SERVER_ERROR, passwordProblem } from './auth-handlers.js';
import { overLimit } from './rate-limit.js';
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

/**
 * The columns that hold something still in motion on an account: an email
 * change waiting for its confirmation link, and a password reset link. A
 * password change, a password reset and "Sign Out Everywhere" all clear
 * them. They did not, and a stolen session could ask for the email to be
 * moved to the thief's address, sit through the owner resetting the
 * password and signing out everywhere, and then click its confirmation
 * link: the account's email was theirs, and so was the next reset.
 */
export const CANCEL_PENDING = `pending_email = NULL, pending_email_token = NULL, pending_email_token_expires = NULL,
       password_reset_token = NULL, password_reset_token_expires = NULL`;

/**
 * Three routes here ask for the current password (changing it, changing the
 * email, deleting the account), and each one is a way to guess it for
 * whoever holds a session. Wrong ones are counted per account: eight inside
 * a quarter of an hour and all three refuse until the window turns over.
 */
const PASSWORD_CHECK = { limit: 8, windowSeconds: 15 * 60 };
const passwordCheckKey = (userId) => `acctpw:${userId}`;
const TOO_MANY_PASSWORDS = 'Too many wrong passwords. Try again in 15 minutes.';
const passwordLocked = (env, userId) => overLimit(env, passwordCheckKey(userId), { ...PASSWORD_CHECK, peek: true });
const passwordMissed = (env, userId) => overLimit(env, passwordCheckKey(userId), PASSWORD_CHECK);

/** Email changes one account may ask for in a day (each one sends two emails, one of them to an address of the caller's choosing). */
const EMAIL_CHANGES_PER_DAY = 5;

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
    return json({ error: SERVER_ERROR }, { status: 500 });
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
    const pwProblem = passwordProblem(newPassword, 'newPassword');
    if (pwProblem) return json({ error: pwProblem }, { status: 400 });
    if (typeof currentPassword !== 'string') return json({ error: 'current password is incorrect' }, { status: 401 });
    if (await passwordLocked(env, payload.userId)) return json({ error: TOO_MANY_PASSWORDS }, { status: 429 });

    const user = await env.DB.prepare('SELECT password_hash, email, session_epoch FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!user) return json({ error: 'user not found' }, { status: 404 });

    const currentValid = await verifyPassword(currentPassword, user.password_hash);
    if (!currentValid) {
      await passwordMissed(env, payload.userId);
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
    // The same statement cancels an email change waiting to be confirmed and
    // any reset link still out: "someone may have had my old password" has
    // to end whatever that someone set in motion, not only their sessions.
    await env.DB.prepare(
      `UPDATE users SET password_hash = ?, session_epoch = ?, ${CANCEL_PENDING}, updated_at = ? WHERE id = ?`,
    )
      .bind(newHash, newEpoch, Date.now(), payload.userId)
      .run();

    const freshToken = generateJWT(
      { userId: payload.userId, email: user.email, epoch: newEpoch },
      jwtSecret(env),
    );

    return json({ message: 'password updated — other devices have been signed out', token: freshToken });
  } catch (e) {
    console.error('Update password error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
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

    // Signing out everywhere also cancels an email change waiting to be
    // confirmed and any reset link still out (see CANCEL_PENDING).
    await env.DB.prepare(
      `UPDATE users SET session_epoch = COALESCE(session_epoch, 0) + 1, ${CANCEL_PENDING}, updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), payload.userId)
      .run();

    return json({ message: 'signed out everywhere' });
  } catch (e) {
    console.error('Logout-all error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
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

/**
 * The note that goes to the address an account HAS when a change of email
 * is asked for: the one place the owner would otherwise never hear of it.
 */
async function sendEmailChangeNotice(env, currentEmail, username, newEmail) {
  if (!env.EMAIL) throw new Error('Email service not configured');
  const to = maskEmail(newEmail);
  await env.EMAIL.send({
    to: currentEmail,
    from: { email: 'verify@perpetualpicks.com', name: 'PerpetualPicks' },
    subject: 'A change of email was requested - PerpetualPicks',
    html: `
      <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
          ${EMAIL_LOGO_HTML}
          <h2 style="color: #d946ef; margin-bottom: 20px;">Email change requested</h2>
          <p style="margin-bottom: 16px;">Hi ${username}, someone signed in to your PerpetualPicks account asked to move it to ${to}. Nothing changes until the link sent to that address is opened.</p>
          <p style="margin-bottom: 16px;">If that was you, there is nothing to do here.</p>
          <p style="margin-bottom: 0;">If it was not, change your password now at <a href="https://perpetualpicks.com/account.html" style="color: #d946ef;">perpetualpicks.com/account.html</a>: that cancels the request and signs every other device out.</p>
        </div>
      </div>
    `,
    text: `Hi ${username}, someone signed in to your PerpetualPicks account asked to move it to ${to}. Nothing changes until the link sent to that address is opened.\n\nIf that was you, there is nothing to do. If it was not, change your password now at https://perpetualpicks.com/account.html: that cancels the request and signs every other device out.`,
  });
}

export async function handleRequestEmailChange(request, env) {
  try {
    const payload = await authenticate(request, env);
    if (!payload) return json({ error: 'unauthorized' }, { status: 401 });

    const body = await request.json();
    const newEmail = normalizeEmail(body.newEmail);
    if (!newEmail) return json({ error: 'enter a valid email address' }, { status: 400 });
    // The current password, like deleting the account asks for. A session
    // alone used to be enough, which made a stolen or left-open session a
    // permanent takeover: move the email, confirm it, reset the password.
    const currentPassword = body.currentPassword;
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return json({ error: 'currentPassword required to change your email' }, { status: 400 });
    }

    if (await passwordLocked(env, payload.userId)) return json({ error: TOO_MANY_PASSWORDS }, { status: 429 });

    const self = await env.DB.prepare('SELECT username, email, password_hash FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!self) return json({ error: 'user not found' }, { status: 404 });
    if (!(await verifyPassword(currentPassword, self.password_hash))) {
      await passwordMissed(env, payload.userId);
      return json({ error: 'current password is incorrect' }, { status: 401 });
    }
    if (await overLimit(env, `emailchange:${payload.userId}`, { limit: EMAIL_CHANGES_PER_DAY, windowSeconds: 86400 })) {
      return json({ error: 'That is as many email changes as an account can ask for in a day. Try again tomorrow.' }, { status: 429 });
    }
    if (newEmail === String(self.email ?? '').toLowerCase()) {
      return json({ error: 'that is already your email address' }, { status: 400 });
    }

    const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?')
      .bind(newEmail, payload.userId)
      .first();
    if (taken) return json({ error: 'email already in use' }, { status: 409 });

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
      await sendEmailChangeVerification(env, newEmail, self.username ?? 'there', token);
    } catch (emailErr) {
      console.error('Email change verification send failed:', emailErr);
    }
    // And a word to the address the account has now, so a change its owner
    // did not ask for cannot go through unseen.
    try {
      await sendEmailChangeNotice(env, self.email, self.username ?? 'there', newEmail);
    } catch (emailErr) {
      console.error('Email change notice send failed:', emailErr);
    }

    return json({ message: 'Check your new email to confirm the change.' });
  } catch (e) {
    console.error('Request email change error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
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
    return json({ error: SERVER_ERROR }, { status: 500 });
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
    if ('ladderEmail' in body) { fields.push('notify_ladder_email = ?'); values.push(body.ladderEmail ? 1 : 0); }
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
    return json({ error: SERVER_ERROR }, { status: 500 });
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
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return json({ error: 'currentPassword required to delete your account' }, { status: 400 });
    }
    if (await passwordLocked(env, payload.userId)) return json({ error: TOO_MANY_PASSWORDS }, { status: 429 });

    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    if (!user) return json({ error: 'user not found' }, { status: 404 });

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      await passwordMissed(env, payload.userId);
      return json({ error: 'password is incorrect' }, { status: 401 });
    }

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
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}
