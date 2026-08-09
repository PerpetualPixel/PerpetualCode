import {
  generateVerificationToken,
  hashPassword,
  verifyPassword,
  generateId,
  generateJWT,
  verifyJWT,
} from './auth-email.js';
import { validateUsername } from './username-policy.js';

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function jwtSecret() {
  // TODO: In production, use a secret from environment variable (wrangler secret put JWT_SECRET)
  return 'perpetual-picks-dev-secret-change-in-production';
}

// Every outbound email leads with the same logo header — kept as one
// constant, exported so account-handlers.js/notifications.js/weekly-
// report.js reuse it too, rather than four slightly-drifted copies.
export const EMAIL_LOGO_HTML = `
  <div style="text-align: center; margin-bottom: 20px;">
    <img src="https://perpetualpicks.com/assets/logo-email.png" alt="Perpetual Picks" width="180" style="max-width: 100%; height: auto;">
  </div>`;

// Send verification email using Cloudflare Email Service
async function sendVerificationEmail(env, email, username, token) {
  if (!env.EMAIL) {
    throw new Error('Email service not configured');
  }

  const verifyUrl = `https://perpetualpicks.com/login.html?token=${token}`;

  await env.EMAIL.send({
    to: email,
    from: { email: 'verify@perpetualpicks.com', name: 'PerpetualPicks' },
    subject: 'Verify Your Email - PerpetualPicks',
    html: `
      <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
          ${EMAIL_LOGO_HTML}
          <h2 style="color: #d946ef; margin-bottom: 20px;">Verify Your Email</h2>
          <p style="margin-bottom: 30px;">Hi ${username}, welcome to PerpetualPicks! Click the button below to verify your email:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; cursor: pointer;">Verify Email</a>
          </div>
          <p style="margin-top: 30px; color: #7070aa; font-size: 12px; text-align: center;">Link expires in 24 hours. If the button doesn't work, copy this link into your browser:</p>
          <p style="text-align: center; color: #a0a0cc; font-size: 12px; word-break: break-all;">${verifyUrl}</p>
        </div>
      </div>
    `,
    text: `Hi ${username}, verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
  });
}

export async function handleRegister(request, env) {
  try {
    const { email, password, username, notifyEmail } = await request.json();

    if (!email || !password || !username) {
      return json({ error: 'email, password, and username required' }, { status: 400 });
    }

    if (password.length < 8) {
      return json({ error: 'password must be at least 8 characters' }, { status: 400 });
    }

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.ok) {
      return json({ error: usernameCheck.error }, { status: 400 });
    }

    // Check if email or username already registered
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ? OR username = ?')
      .bind(email, username)
      .first();
    if (existing) {
      return json({ error: 'email or username already registered' }, { status: 409 });
    }

    // Create new user. The single "email me" signup checkbox covers both
    // POTD and Pixel's Picks alerts together — Settings lets a user split
    // them apart later. There is no SMS signup checkbox yet (disabled in the
    // UI — see docs/login.html), so the *_sms columns stay at their DEFAULT
    // 0 and are never set here.
    const id = generateId();
    const passwordHash = await hashPassword(password);
    const verificationToken = generateVerificationToken();
    const tokenExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    const notifyFlag = notifyEmail ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO users (
        id, email, password_hash, username, email_verified,
        verification_token, verification_token_expires,
        notify_potd_email, notify_picks_email,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, email, passwordHash, username, 0,
        verificationToken, tokenExpires,
        notifyFlag, notifyFlag,
        Date.now(), Date.now(),
      )
      .run();

    // Send verification email
    try {
      await sendVerificationEmail(env, email, username, verificationToken);
    } catch (emailErr) {
      console.error('Email send failed:', emailErr);
      // Don't fail registration if email fails — user can request resend
    }

    return json({ message: 'Registration successful. Check your email to verify.' }, { status: 201 });
  } catch (e) {
    console.error('Register error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleVerifyEmail(request, env) {
  try {
    const { token } = await request.json();

    if (!token) {
      return json({ error: 'verification token required' }, { status: 400 });
    }

    const user = await env.DB.prepare(
      'SELECT id, email_verified, verification_token, verification_token_expires FROM users WHERE verification_token = ?',
    )
      .bind(token)
      .first();

    if (!user) {
      return json({ error: 'invalid verification token' }, { status: 404 });
    }

    if (user.email_verified) {
      return json({ error: 'email already verified' }, { status: 400 });
    }

    if (user.verification_token_expires < Date.now()) {
      return json({ error: 'verification token expired' }, { status: 401 });
    }

    // Mark as verified
    await env.DB.prepare(
      'UPDATE users SET email_verified = 1, verification_token = NULL, verification_token_expires = NULL, updated_at = ? WHERE id = ?',
    )
      .bind(Date.now(), user.id)
      .run();

    return json({ message: 'email verified successfully' });
  } catch (e) {
    console.error('Verify email error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleLogin(request, env) {
  try {
    // `identifier` is whatever the user typed into the single sign-in
    // field — either their email or their username. Matched against both
    // columns rather than trying to guess which one it is client-side (an
    // "is this shaped like an email" check would have to be kept in sync
    // with whatever the username format allows, for no real benefit).
    const { identifier, password } = await request.json();

    if (!identifier || !password) {
      return json({ error: 'email/username and password required' }, { status: 400 });
    }

    const user = await env.DB.prepare(
      'SELECT id, email, password_hash, email_verified, username FROM users WHERE email = ? OR username = ?',
    )
      .bind(identifier, identifier)
      .first();

    if (!user) {
      return json({ error: 'invalid credentials' }, { status: 401 });
    }

    const pwValid = await verifyPassword(password, user.password_hash);
    if (!pwValid) {
      return json({ error: 'invalid credentials' }, { status: 401 });
    }

    if (!user.email_verified) {
      return json({ error: 'please verify your email first', needsVerification: true }, { status: 403 });
    }

    // Generate JWT token (30-day expiry)
    const token = generateJWT({ userId: user.id, email: user.email }, jwtSecret());

    return json({ token, userId: user.id, email: user.email, username: user.username });
  } catch (e) {
    console.error('Login error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

async function sendPasswordResetEmail(env, email, username, token) {
  if (!env.EMAIL) {
    throw new Error('Email service not configured');
  }

  const resetUrl = `https://perpetualpicks.com/login.html?resetToken=${token}`;

  await env.EMAIL.send({
    to: email,
    from: { email: 'verify@perpetualpicks.com', name: 'PerpetualPicks' },
    subject: 'Reset Your Password - PerpetualPicks',
    html: `
      <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
          ${EMAIL_LOGO_HTML}
          <h2 style="color: #d946ef; margin-bottom: 20px;">Reset Your Password</h2>
          <p style="margin-bottom: 30px;">Hi ${username}, you (or someone) requested a password reset for your PerpetualPicks account. Click below to choose a new password:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Reset Password</a>
          </div>
          <p style="margin-top: 30px; color: #7070aa; font-size: 12px; text-align: center;">Link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change unless this link is used.</p>
          <p style="text-align: center; color: #a0a0cc; font-size: 12px; word-break: break-all;">${resetUrl}</p>
        </div>
      </div>
    `,
    text: `Hi ${username}, reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

export async function handleForgotPassword(request, env) {
  try {
    const { identifier } = await request.json();
    if (!identifier) return json({ error: 'email or username required' }, { status: 400 });

    const user = await env.DB.prepare('SELECT id, email, username FROM users WHERE email = ? OR username = ?')
      .bind(identifier, identifier)
      .first();

    // Same response whether or not an account exists — a different message
    // for "no such account" would let this endpoint be used to check which
    // emails/usernames are registered. The client shows one generic message
    // either way.
    const genericResponse = { message: 'If an account exists, a password reset link has been sent.' };
    if (!user) return json(genericResponse);

    const token = generateVerificationToken();
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour — shorter than the 24h email-verification/email-change tokens, since a leaked reset link is a direct account takeover

    await env.DB.prepare(
      'UPDATE users SET password_reset_token = ?, password_reset_token_expires = ?, updated_at = ? WHERE id = ?',
    )
      .bind(token, expires, Date.now(), user.id)
      .run();

    try {
      await sendPasswordResetEmail(env, user.email, user.username, token);
    } catch (emailErr) {
      console.error('Password reset email send failed:', emailErr);
      // Matches the rest of this file's send-failure handling: the token
      // row is already saved, so a transport hiccup shouldn't surface
      // differently to the client than a normal success — resending is
      // just calling this endpoint again.
    }

    return json(genericResponse);
  } catch (e) {
    console.error('Forgot password error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleResetPassword(request, env) {
  try {
    const { token, newPassword } = await request.json();
    if (!token || !newPassword) {
      return json({ error: 'token and newPassword required' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return json({ error: 'newPassword must be at least 8 characters' }, { status: 400 });
    }

    const user = await env.DB.prepare(
      'SELECT id, password_reset_token_expires FROM users WHERE password_reset_token = ?',
    )
      .bind(token)
      .first();

    if (!user) return json({ error: 'invalid or already-used token' }, { status: 404 });
    if (user.password_reset_token_expires < Date.now()) {
      return json({ error: 'token expired' }, { status: 401 });
    }

    const newHash = await hashPassword(newPassword);
    await env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_reset_token = NULL,
       password_reset_token_expires = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(newHash, Date.now(), user.id)
      .run();

    return json({ message: 'password updated — you can now sign in with your new password' });
  } catch (e) {
    console.error('Reset password error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export async function handleMe(request, env) {
  try {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '');
    const payload = verifyJWT(token, jwtSecret());

    if (!payload) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }

    const user = await env.DB.prepare(
      `SELECT id, email, email_verified, username, pending_email,
              notify_potd_email, notify_picks_email,
              notify_potd_sms, notify_picks_sms,
              notify_tracking_report_email
       FROM users WHERE id = ?`,
    )
      .bind(payload.userId)
      .first();

    if (!user) {
      return json({ error: 'user not found' }, { status: 404 });
    }

    return json({
      id: user.id,
      email: user.email,
      verified: Boolean(user.email_verified),
      username: user.username,
      pendingEmail: user.pending_email,
      notifications: {
        potdEmail: Boolean(user.notify_potd_email),
        picksEmail: Boolean(user.notify_picks_email),
        potdSms: Boolean(user.notify_potd_sms),
        picksSms: Boolean(user.notify_picks_sms),
        trackingReportEmail: Boolean(user.notify_tracking_report_email),
      },
    });
  } catch (e) {
    console.error('Me error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export { verifyJWT };
