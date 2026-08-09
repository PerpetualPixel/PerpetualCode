import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

// Generate secure random token for email verification
export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Password hashing: salted PBKDF2-SHA256 via Web Crypto, stored as
 * `pbkdf2$<iterations>$<saltHex>$<hashHex>`. Iterations are stored in the
 * record itself so they can be raised later without breaking existing
 * hashes — verification always uses the stored count, hashing always uses
 * the current constant.
 *
 * Accounts created before this used a single unsalted SHA-256 hex digest
 * (no `$` separators — that's the format discriminator). verifyPassword
 * still accepts those, and handleLogin transparently re-hashes a legacy
 * account into this format on its next successful sign-in (see
 * passwordNeedsRehash below) — so old hashes age out on their own without
 * a forced reset for anyone.
 */
const PBKDF2_ITERATIONS = 100000;

async function pbkdf2Hex(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return Buffer.from(bits).toString('hex');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hashHex = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${hashHex}`;
}

/** The pre-PBKDF2 format: one unsalted SHA-256 hex digest. Kept only so
 * existing accounts can still sign in; never used for new hashes. */
async function legacySha256Hex(password) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Buffer.from(hashBuffer).toString('hex');
}

function timingSafeHexEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex), 'hex');
  const b = Buffer.from(String(bHex), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// Verify password against a stored hash of either format
export async function verifyPassword(password, stored) {
  const record = String(stored ?? '');
  if (record.startsWith('pbkdf2$')) {
    const [, iterStr, saltHex, hashHex] = record.split('$');
    const iterations = Number(iterStr);
    if (!Number.isFinite(iterations) || iterations < 1 || !saltHex || !hashHex) return false;
    const derivedHex = await pbkdf2Hex(password, Buffer.from(saltHex, 'hex'), iterations);
    return timingSafeHexEqual(derivedHex, hashHex);
  }
  return timingSafeHexEqual(await legacySha256Hex(password), record);
}

/** True when a stored hash is still the legacy unsalted format (or an older
 * iteration count) and should be upgraded on next successful login. */
export function passwordNeedsRehash(stored) {
  const record = String(stored ?? '');
  if (!record.startsWith('pbkdf2$')) return true;
  return Number(record.split('$')[1]) < PBKDF2_ITERATIONS;
}

// Generate random ID
export function generateId() {
  return crypto.randomBytes(12).toString('hex');
}

// Generate JWT token with 30-day expiry
export function generateJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const expiryTime = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const tokenPayload = { ...payload, exp: expiryTime };

  const headerEncoded = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadEncoded = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${headerEncoded}.${payloadEncoded}`);
  const signature = hmac.digest('base64url');

  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

// Verify and decode JWT token
export function verifyJWT(token, secret) {
  try {
    const [headerEncoded, payloadEncoded, signatureEncoded] = token.split('.');
    if (!headerEncoded || !payloadEncoded || !signatureEncoded) return null;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${headerEncoded}.${payloadEncoded}`);
    const expectedSig = hmac.digest('base64url');

    if (signatureEncoded !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString());

    // Check expiry
    if (payload.exp && payload.exp < Date.now() / 1000) return null;

    return payload;
  } catch {
    return null;
  }
}
