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

function jwtSecret() {
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
          <p>Welcome to PerpetualPicks! Click the link below to verify your email and complete your registration:</p>
          <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #d946ef 0%, #9d4edd 100%); color: #05050A; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 20px 0;">Verify Email</a>
          <p style="margin-top: 20px; color: #a0a0cc;">Or copy this link: <code style="background: #0f0f1a; padding: 4px 8px; border-radius: 4px;">${verifyUrl}</code></p>
          <p style="margin-top: 30px; color: #7070aa; font-size: 12px;">This link expires in 24 hours.</p>
        </div>
      </div>
    `,
    text: `Verify your email at: ${verifyUrl}\n\nThis link expires in 24 hours.`,
  });
}

export async function handleRegister(request, env) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return json({ error: 'email and password required' }, { status: 400 });
    }

    if (password.length < 8) {
      return json({ error: 'password must be at least 8 characters' }, { status: 400 });
    }

    // Check if email already registered
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return json({ error: 'email already registered' }, { status: 409 });
    }

    // Create new user
    const id = generateId();
    const passwordHash = await hashPassword(password);
    const verificationToken = generateVerificationToken();
    const tokenExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, email_verified, verification_token, verification_token_expires, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, email, passwordHash, 0, verificationToken, tokenExpires, Date.now(), Date.now())
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
      'SELECT id, password_hash, email_verified FROM users WHERE email = ?',
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

    return json({ token, userId: user.id, email });
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

    const user = await env.DB.prepare('SELECT id, email, email_verified FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();

    if (!user) {
      return json({ error: 'user not found' }, { status: 404 });
    }

    return json({ id: user.id, email: user.email, verified: user.email_verified });
  } catch (e) {
    console.error('Me error:', e);
    return json({ error: e.message }, { status: 500 });
  }
}

export { verifyJWT };
