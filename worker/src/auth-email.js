import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

// Generate secure random token for email verification
export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash password using SHA-256 (simple, though bcrypt would be better for production)
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hashBuffer).toString('hex');
}

// Verify password against hash
export async function verifyPassword(password, hash) {
  const newHash = await hashPassword(password);
  return newHash === hash;
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
