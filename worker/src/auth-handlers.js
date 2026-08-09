import {
  generateVerificationToken,
  hashPassword,
  verifyPassword,
  generateId,
  generateJWT,
  verifyJWT,
} from './auth-email.js';

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

// Send verification email using Cloudflare Email Service
async function sendVerificationEmail(env, email, token) {
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
          <h2 style="color: #d946ef; margin-bottom: 20px;">Verify Your Email</h2>
          <p style="margin-bottom: 30px;">Welcome to PerpetualPicks! Click the button below to verify your email:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; cursor: pointer;">Verify Email</a>
          </div>
          <p style="margin-top: 30px; color: #7070aa; font-size: 12px; text-align: center;">Link expires in 24 hours. If the button doesn't work, copy this link into your browser:</p>
          <p style="text-align: center; color: #a0a0cc; font-size: 12px; word-break: break-all;">${verifyUrl}</p>
        </div>
      </div>
    `,
    text: `Verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
  });
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export async function handleRegister(request, env) {
  try {
    const { email, password, username, notifyEmail } = await request.json();

    if (!email || !password || !username) {
      return json({ error: 'email, password, and username required' }, { status: 400 });
    }

    if (password.length < 8) {
      return json({ error: 'password must be at least 8 characters' }, { status: 400 });
    }

    if (!USERNAME_PATTERN.test(username)) {
      return json(
        { error: 'username must be 3-20 characters: letters, numbers, underscores only' },
        { status: 400 },
      );
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
      await sendVerificationEmail(env, email, verificationToken);
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
    const { email, password } = await request.json();

    if (!email || !password) {
      return json({ error: 'email and password required' }, { status: 400 });
    }

    const user = await env.DB.prepare(
      'SELECT id, password_hash, email_verified, username FROM users WHERE email = ?',
    )
      .bind(email)
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
    const token = generateJWT({ userId: user.id, email }, jwtSecret());

    return json({ token, userId: user.id, email, username: user.username });
  } catch (e) {
    console.error('Login error:', e);
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
