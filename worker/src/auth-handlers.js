import crypto from 'node:crypto';
import {
  generateVerificationToken,
  hashPassword,
  verifyPassword,
  passwordNeedsRehash,
  generateId,
  generateJWT,
  verifyJWT,
  normalizeEmail,
} from './auth-email.js';
import { validateUsername } from './username-policy.js';
import { overLimit, clearLimit } from './rate-limit.js';

/**
 * What a route says when something broke on this side. The exception's own
 * text used to be sent ("D1_ERROR: UNIQUE constraint failed: users.email",
 * "JWT_SECRET is not configured — run: wrangler secret put ..."): detail for
 * whoever is probing, of no use to whoever is signing in. It goes to the
 * log, where it always went as well.
 */
export const SERVER_ERROR = 'Something went wrong on our side. Please try again in a moment.';

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/** A password as the routes take one: a string of 8 to 200 characters. */
export const passwordProblem = (password, name = 'password') => (
  typeof password !== 'string' || password.length < 8 ? `${name} must be at least 8 characters`
    : password.length > 200 ? `${name} must be at most 200 characters` : null
);

/**
 * Failed sign-ins are counted per account as well as per address: eight
 * wrong passwords for one email or username inside a quarter of an hour and
 * that name is refused until the window turns over, whatever address the
 * next guess comes from. The per-address throttle alone let a guesser with
 * many addresses (or one IPv6 line) keep going at ten a minute each.
 *
 * Counted by what was typed, not by the account it matched, so a name that
 * belongs to nobody locks the same way and the lock says nothing about who
 * is registered.
 */
export const LOGIN_MAX_FAILURES = 8;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const loginKey = (identifier) => `login:${sha(String(identifier ?? '').trim().toLowerCase()).slice(0, 32)}`;
const LOGIN_LOCKED = 'Too many failed sign-in attempts for this account. Try again in 15 minutes, or reset your password.';

// A real hash of nothing anybody knows, checked when the name typed matches
// no account, so "no such account" takes as long to answer as "wrong
// password" does (the answer is the same; the wait used to give it away).
let dummyHash = null;
const dummyPasswordHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(24).toString('hex')));

/** How many emails one address may be sent in an hour by the routes anyone can call. */
const MAIL_PER_HOUR = 4;
const mailAllowed = async (env, kind, email) => !(await overLimit(env, `mail:${kind}:${sha(email).slice(0, 32)}`, { limit: MAIL_PER_HOUR, windowSeconds: 3600 }));

/** Run after the response where the platform allows it (ctx.waitUntil), so a send does not show in how long the answer took. */
const later = (ctx, work) => {
  const p = Promise.resolve().then(work).catch((e) => console.error('Deferred work failed:', e));
  if (ctx?.waitUntil) ctx.waitUntil(p); else return p;
  return undefined;
};

/** Where a signed-out session's token is remembered until it would have expired anyway. */
const revokedKey = (token) => `revoked:${sha(token).slice(0, 40)}`;

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function jwtSecret(env) {
  // Set via `wrangler secret put JWT_SECRET`. Throwing on a missing secret
  // (rather than falling back to some hardcoded default) is deliberate:
  // this file lives in a public GitHub repo, so any string written here is
  // effectively published — a fallback would let anyone who reads the repo
  // forge a valid session token for any account. Better for auth to fail
  // loudly on a misconfigured deploy than to silently run forgeable.
  const secret = env?.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured — run: wrangler secret put JWT_SECRET');
  return secret;
}

/**
 * The one authentication check every protected endpoint should use.
 * Verifies the JWT signature/expiry, then confirms the token's session
 * epoch still matches the account's current one in D1 — a mismatch means
 * "Sign Out Everywhere" was used (or the password was changed/reset)
 * after this token was issued, so it's dead regardless of its expiry.
 * The same lookup also kills tokens belonging to deleted accounts
 * immediately, instead of letting them pass signature checks for up to
 * 30 days.
 *
 * A token with no epoch field (issued before session_epoch existed)
 * counts as epoch 0, matching the column's DEFAULT — so the migration
 * itself logs nobody out; only an actual bump does.
 *
 * Returns the decoded payload, or null when the request isn't (or is no
 * longer) authenticated.
 */
export async function authenticateRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyJWT(token, jwtSecret(env));
  if (!payload) return null;

  // "Sign out" on one device: that one token is on the signed-out list
  // until its own expiry (see handleLogout). A list that cannot be read
  // does not sign anybody out.
  try {
    if (await env.POTD_KV?.get(revokedKey(token))) return null;
  } catch (e) {
    console.error('Signed-out list read failed:', e);
  }

  const row = await env.DB.prepare('SELECT session_epoch FROM users WHERE id = ?')
    .bind(payload.userId)
    .first();
  if (!row) return null; // account deleted — token dies with it

  const tokenEpoch = payload.epoch ?? 0;
  if (tokenEpoch !== (row.session_epoch ?? 0)) return null;

  return payload;
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

/**
 * Server-side Turnstile verification for registration — the browser widget
 * (docs/login.html's register form) only produces a token; nothing counts
 * until siteverify confirms it here. Requires success, the exact 'signup'
 * action the widget was rendered with, and a production hostname
 * (deliberately excluding the localhost/127.0.0.1 the widget itself allows
 * for local dev — a token minted on localhost must never pass in
 * production). Fails closed on any siteverify error: registration is the
 * one surface bots target, so "verifier unreachable" means "no signups
 * this instant," not "bots welcome."
 */
const TURNSTILE_EXPECTED_ACTION = 'signup';
const TURNSTILE_EXPECTED_HOSTNAMES = new Set(['perpetualpicks.com', 'www.perpetualpicks.com']);

async function verifyTurnstile(env, token, remoteip) {
  if (!env.TURNSTILE_SECRET) {
    throw new Error('TURNSTILE_SECRET is not configured — run: wrangler secret put TURNSTILE_SECRET');
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        ...(remoteip ? { remoteip } : {}),
      }),
    });
    if (!res.ok) return false;
    const result = await res.json();
    return (
      result.success === true &&
      result.action === TURNSTILE_EXPECTED_ACTION &&
      TURNSTILE_EXPECTED_HOSTNAMES.has(result.hostname)
    );
  } catch {
    return false;
  }
}

/** The note to an address that already has an account, when somebody signs up with it again. */
async function sendAlreadyRegisteredEmail(env, email, username) {
  if (!env.EMAIL) throw new Error('Email service not configured');
  await env.EMAIL.send({
    to: email,
    from: { email: 'verify@perpetualpicks.com', name: 'PerpetualPicks' },
    subject: 'You already have a PerpetualPicks account',
    html: `
      <div style="font-family: Arial, sans-serif; background: #05050A; color: #e0e0ff; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #9d4edd; border-radius: 8px; padding: 30px; background: #0a0515;">
          ${EMAIL_LOGO_HTML}
          <h2 style="color: #d946ef; margin-bottom: 20px;">You already have an account</h2>
          <p style="margin-bottom: 16px;">Hi ${username}, someone just tried to sign up to PerpetualPicks with this email address, and it already has an account. Nothing was changed.</p>
          <p style="margin-bottom: 0;">If that was you, sign in at <a href="https://perpetualpicks.com/login.html" style="color: #d946ef;">perpetualpicks.com/login.html</a> (there is a "Forgot password?" link if you need it). If it was not, there is nothing to do.</p>
        </div>
      </div>
    `,
    text: `Hi ${username}, someone just tried to sign up to PerpetualPicks with this email address, and it already has an account. Nothing was changed.\n\nIf that was you, sign in at https://perpetualpicks.com/login.html (there is a "Forgot password?" link if you need it). If it was not, there is nothing to do.`,
  });
}

export async function handleRegister(request, env, ctx) {
  try {
    const body = await request.json();
    const { password, username, notifyEmail, turnstileToken } = body;

    const human = await verifyTurnstile(env, turnstileToken, request.headers.get('CF-Connecting-IP'));
    if (!human) {
      return json({ error: 'verification challenge failed — refresh the page and try again' }, { status: 403 });
    }

    if (!body.email || !password || !username) {
      return json({ error: 'email, password, and username required' }, { status: 400 });
    }
    const email = normalizeEmail(body.email);
    if (!email) return json({ error: 'enter a valid email address' }, { status: 400 });

    const pwProblem = passwordProblem(password);
    if (pwProblem) return json({ error: pwProblem }, { status: 400 });

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.ok) {
      return json({ error: usernameCheck.error }, { status: 400 });
    }

    const now = Date.now();
    // An account nobody verified, whose link has run out, holds nothing: its
    // email and its username are free again. These rows used to stay for
    // good, so signing up once with somebody else's address (or the
    // username they wanted) shut them out of it permanently.
    await env.DB.prepare(
      `DELETE FROM users WHERE email_verified = 0 AND COALESCE(verification_token_expires, 0) < ?
       AND (email = ? COLLATE NOCASE OR username = ?)`,
    ).bind(now, email, username).run();

    // Hashed before anything is looked up, so every answer below has cost the same.
    const passwordHash = await hashPassword(password);

    const byEmail = await env.DB.prepare('SELECT id, email_verified, username FROM users WHERE email = ? COLLATE NOCASE')
      .bind(email)
      .first();
    const byName = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (byName && byName.id !== byEmail?.id) {
      return json({ error: 'username already taken' }, { status: 409 });
    }

    // The one answer for every email, registered or not: this route no
    // longer says which addresses have accounts.
    const accepted = json({ message: 'Registration successful. Check your email to verify.' }, { status: 201 });

    if (byEmail?.email_verified) {
      // The address has an account. Its owner is told (once in a while, not
      // on every attempt), and the caller is told what everyone is told.
      if (await mailAllowed(env, 'registered', email)) {
        await later(ctx, () => sendAlreadyRegisteredEmail(env, email, byEmail.username ?? 'there'));
      }
      return accepted;
    }

    const verificationToken = generateVerificationToken();
    const tokenExpires = now + 24 * 60 * 60 * 1000; // 24 hours
    const notifyFlag = notifyEmail ? 1 : 0;

    if (byEmail) {
      // Signed up before and never verified, link still alive: the newest
      // sign-up takes the row. Only the mailbox's owner can open the link,
      // so the newest details are the ones they chose if it was them, and
      // an earlier stranger's password is gone either way.
      await env.DB.prepare(
        `UPDATE users SET password_hash = ?, username = ?, verification_token = ?, verification_token_expires = ?,
         notify_potd_email = ?, notify_picks_email = ?, updated_at = ? WHERE id = ?`,
      ).bind(passwordHash, username, verificationToken, tokenExpires, notifyFlag, notifyFlag, now, byEmail.id).run();
    } else {
      // Create new user. The single "email me" signup checkbox covers both
      // POTD and Pixel's Picks alerts together — Settings lets a user split
      // them apart later. There is no SMS signup checkbox yet (disabled in the
      // UI — see docs/login.html), so the *_sms columns stay at their DEFAULT
      // 0 and are never set here.
      await env.DB.prepare(
        `INSERT INTO users (
          id, email, password_hash, username, email_verified,
          verification_token, verification_token_expires,
          notify_potd_email, notify_picks_email,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          generateId(), email, passwordHash, username, 0,
          verificationToken, tokenExpires,
          notifyFlag, notifyFlag,
          now, now,
        )
        .run();
    }

    // Send verification email (a handful an hour to one address at most; the link can be asked for again, see handleResendVerification).
    if (await mailAllowed(env, 'verify', email)) {
      await later(ctx, () => sendVerificationEmail(env, email, username, verificationToken));
    }

    return accepted;
  } catch (e) {
    console.error('Register error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}

/**
 * A fresh verification link for an account that has not been verified yet.
 * There was no way to get one: a link that ran out, or an email that never
 * arrived, left the account (and its address and username) stuck. One
 * answer whatever the name typed matches.
 */
export async function handleResendVerification(request, env, ctx) {
  try {
    const { identifier } = await request.json();
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 254) {
      return json({ error: 'email or username required' }, { status: 400 });
    }
    const answer = json({ message: 'If that account still needs verifying, a new link is on its way.' });
    const id = identifier.trim();
    const user = await env.DB.prepare(
      'SELECT id, email, username, email_verified FROM users WHERE email = ? COLLATE NOCASE OR username = ?',
    ).bind(id, id).first();
    if (!user || user.email_verified) return answer;
    if (!(await mailAllowed(env, 'verify', String(user.email).toLowerCase()))) return answer;

    const token = generateVerificationToken();
    await env.DB.prepare('UPDATE users SET verification_token = ?, verification_token_expires = ?, updated_at = ? WHERE id = ?')
      .bind(token, Date.now() + 24 * 60 * 60 * 1000, Date.now(), user.id).run();
    await later(ctx, () => sendVerificationEmail(env, user.email, user.username ?? 'there', token));
    return answer;
  } catch (e) {
    console.error('Resend verification error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}

/**
 * "Sign out" on this device. The token is put on a signed-out list until it
 * would have expired, so it is dead on the server too; clearing the
 * browser's copy alone left it good for up to thirty days to anyone who had
 * taken a copy. Answers the same whether or not the token was still alive.
 */
export async function handleLogout(request, env) {
  try {
    const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
    const payload = token ? verifyJWT(token, jwtSecret(env)) : null;
    if (payload) {
      const ttl = Math.max(60, Math.ceil((payload.exp ?? 0) - Date.now() / 1000));
      await env.POTD_KV.put(revokedKey(token), '1', { expirationTtl: ttl });
    }
    return json({ message: 'signed out' });
  } catch (e) {
    console.error('Logout error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
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
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}

export async function handleLogin(request, env) {
  try {
    // `identifier` is whatever the user typed into the single sign-in
    // field — either their email or their username. Matched against both
    // columns rather than trying to guess which one it is client-side (an
    // "is this shaped like an email" check would have to be kept in sync
    // with whatever the username format allows, for no real benefit).
    const body = await request.json();
    const password = body.password;
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';

    if (!identifier || !password) {
      return json({ error: 'email/username and password required' }, { status: 400 });
    }
    if (identifier.length > 254 || typeof password !== 'string' || password.length > 200) {
      return json({ error: 'invalid credentials' }, { status: 401 });
    }

    // Too many wrong passwords for this name already: refused before the
    // password is even looked at, and without adding to the count (the
    // lock ends when its window does, however often it is knocked on).
    const failures = { limit: LOGIN_MAX_FAILURES, windowSeconds: LOGIN_WINDOW_SECONDS };
    if (await overLimit(env, loginKey(identifier), { ...failures, peek: true })) {
      return json({ error: LOGIN_LOCKED }, { status: 429 });
    }

    // An email matches whatever its capitals (addresses are stored
    // lower-cased now; older rows may not be). A username is exact.
    const user = await env.DB.prepare(
      'SELECT id, email, password_hash, email_verified, username, session_epoch FROM users WHERE email = ? COLLATE NOCASE OR username = ?',
    )
      .bind(identifier, identifier)
      .first();

    const pwValid = await verifyPassword(password, user ? user.password_hash : await dummyPasswordHash());
    if (!user || !pwValid) {
      await overLimit(env, loginKey(identifier), failures);
      return json({ error: 'invalid credentials' }, { status: 401 });
    }

    if (!user.email_verified) {
      return json({ error: 'please verify your email first', needsVerification: true }, { status: 403 });
    }

    // Transparent hash upgrade: an account still on the legacy unsalted
    // SHA-256 format (or an outdated PBKDF2 iteration count) gets re-hashed
    // under the current scheme now, while the plaintext password is briefly
    // in hand — the only moment that's possible. Best-effort: a failure
    // here must never block a valid login, the old hash still works.
    if (passwordNeedsRehash(user.password_hash)) {
      try {
        const upgraded = await hashPassword(password);
        await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
          .bind(upgraded, Date.now(), user.id)
          .run();
      } catch (rehashErr) {
        console.error('Password rehash failed (login still succeeds):', rehashErr);
      }
    }

    // Generate JWT token (30-day expiry), stamped with the account's
    // current session epoch — see authenticateRequest above.
    const token = generateJWT(
      { userId: user.id, email: user.email, epoch: user.session_epoch ?? 0 },
      jwtSecret(env),
    );

    // A right password wipes the count of wrong ones.
    await clearLimit(env, loginKey(identifier));

    return json({ token, userId: user.id, email: user.email, username: user.username });
  } catch (e) {
    console.error('Login error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
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

/** A reset link is good for an hour, and is not replaced while it still has this long to run. */
const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_KEEP_MS = 15 * 60 * 1000;
/** Reset emails one account may be sent in an hour. */
const RESET_MAILS_PER_HOUR = 3;

export async function handleForgotPassword(request, env, ctx) {
  try {
    const body = await request.json();
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    if (!identifier || identifier.length > 254) return json({ error: 'email or username required' }, { status: 400 });

    const user = await env.DB.prepare(
      `SELECT id, email, username, password_reset_token, password_reset_token_expires
       FROM users WHERE email = ? COLLATE NOCASE OR username = ?`,
    )
      .bind(identifier, identifier)
      .first();

    // Same response whether or not an account exists — a different message
    // for "no such account" would let this endpoint be used to check which
    // emails/usernames are registered. The client shows one generic message
    // either way.
    const genericResponse = { message: 'If an account exists, a password reset link has been sent.' };
    if (!user) return json(genericResponse);

    // A few an hour to one account, whoever is asking and from wherever:
    // this route is open to anyone who knows an email or a username, and
    // was a way to fill somebody's inbox.
    if (await overLimit(env, `mail:reset:${user.id}`, { limit: RESET_MAILS_PER_HOUR, windowSeconds: 3600 })) {
      return json(genericResponse);
    }

    // A link that is still good is sent again rather than replaced. Every
    // call used to write a new token over the last, so anyone could keep
    // an account's owner from ever using the link in their inbox by asking
    // for another one every few minutes.
    const now = Date.now();
    let token = user.password_reset_token;
    if (!token || (user.password_reset_token_expires ?? 0) - now < RESET_KEEP_MS) {
      token = generateVerificationToken();
      // 1 hour — shorter than the 24h email-verification/email-change tokens, since a leaked reset link is a direct account takeover
      await env.DB.prepare(
        'UPDATE users SET password_reset_token = ?, password_reset_token_expires = ?, updated_at = ? WHERE id = ?',
      )
        .bind(token, now + RESET_TTL_MS, now, user.id)
        .run();
    }

    // Sent after the answer, so an account that exists does not take
    // visibly longer to answer than one that does not. A send that fails is
    // logged; asking again sends the same link.
    await later(ctx, () => sendPasswordResetEmail(env, user.email, user.username, token));

    return json(genericResponse);
  } catch (e) {
    console.error('Forgot password error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}

export async function handleResetPassword(request, env) {
  try {
    const { token, newPassword } = await request.json();
    if (!token || !newPassword) {
      return json({ error: 'token and newPassword required' }, { status: 400 });
    }
    const pwProblem = passwordProblem(newPassword, 'newPassword');
    if (pwProblem) return json({ error: pwProblem }, { status: 400 });
    if (typeof token !== 'string') return json({ error: 'invalid or already-used token' }, { status: 404 });

    const user = await env.DB.prepare(
      'SELECT id, email, username, password_reset_token_expires FROM users WHERE password_reset_token = ?',
    )
      .bind(token)
      .first();

    if (!user) return json({ error: 'invalid or already-used token' }, { status: 404 });
    if (user.password_reset_token_expires < Date.now()) {
      return json({ error: 'token expired' }, { status: 401 });
    }

    // session_epoch bump: a forgot-password reset usually means the old
    // password may be compromised — every outstanding session dies with
    // it, not just the password (see authenticateRequest).
    const newHash = await hashPassword(newPassword);
    // An email change still waiting for its confirmation link is cancelled
    // in the same statement: whoever had the old password may have asked
    // for it (see account-handlers.js's CANCEL_PENDING, spelled out here
    // because that file imports this one).
    // And the account counts as verified: the link came out of its inbox,
    // which is all the verification link ever proved. Without this, an
    // address somebody else had signed up with stayed "please verify your
    // email first" for its real owner even after they reset the password.
    await env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_reset_token = NULL,
       password_reset_token_expires = NULL,
       pending_email = NULL, pending_email_token = NULL, pending_email_token_expires = NULL,
       email_verified = 1, verification_token = NULL, verification_token_expires = NULL,
       session_epoch = COALESCE(session_epoch, 0) + 1, updated_at = ? WHERE id = ?`,
    )
      .bind(newHash, Date.now(), user.id)
      .run();

    // The owner is back in: any lock from wrong guesses at their name is lifted.
    await clearLimit(env, loginKey(user.email));
    if (user.username) await clearLimit(env, loginKey(user.username));

    return json({ message: 'password updated — you can now sign in with your new password' });
  } catch (e) {
    console.error('Reset password error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}

export async function handleMe(request, env) {
  try {
    const payload = await authenticateRequest(request, env);
    if (!payload) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }

    const user = await env.DB.prepare(
      `SELECT id, email, email_verified, username, pending_email,
              notify_potd_email, notify_picks_email, notify_ladder_email,
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
        ladderEmail: Boolean(user.notify_ladder_email),
        potdSms: Boolean(user.notify_potd_sms),
        picksSms: Boolean(user.notify_picks_sms),
        trackingReportEmail: Boolean(user.notify_tracking_report_email),
      },
    });
  } catch (e) {
    console.error('Me error:', e);
    return json({ error: SERVER_ERROR }, { status: 500 });
  }
}

export { verifyJWT };
