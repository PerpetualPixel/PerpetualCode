import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

// TOTP library (simplified speakeasy-like implementation)
export function generateTOTPSecret() {
  return crypto.randomBytes(32).toString('base64');
}

export function getTOTPToken(secret) {
  const key = Buffer.from(secret, 'base64');
  const time = Math.floor(Date.now() / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time), 0);

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0xf;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % 1000000;

  return String(code).padStart(6, '0');
}

export function verifyTOTPToken(secret, token, window = 1) {
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const key = Buffer.from(secret, 'base64');
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(now + i), 0);

    const hmac = crypto.createHmac('sha1', key);
    hmac.update(timeBuffer);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1] & 0xf;
    const code = (
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)
    ) % 1000000;

    if (String(code).padStart(6, '0') === token) {
      return true;
    }
  }
  return false;
}

export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hashBuffer).toString('hex');
}

export async function verifyPassword(password, hash) {
  const newHash = await hashPassword(password);
  return newHash === hash;
}

export function generateId() {
  return crypto.randomBytes(12).toString('hex');
}

export function generateJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerEncoded = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${headerEncoded}.${payloadEncoded}`);
  const signature = hmac.digest('base64url');

  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

export function verifyJWT(token, secret) {
  try {
    const [headerEncoded, payloadEncoded, signatureEncoded] = token.split('.');
    if (!headerEncoded || !payloadEncoded || !signatureEncoded) return null;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${headerEncoded}.${payloadEncoded}`);
    const expectedSig = hmac.digest('base64url');

    if (signatureEncoded !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString());

    if (payload.exp && payload.exp < Date.now() / 1000) return null;

    return payload;
  } catch {
    return null;
  }
}

export function getTOTPQRCode(email, secret) {
  const label = encodeURIComponent(`PixelPick (${email})`);
  const encoded = Buffer.from(secret, 'base64').toString('base64');
  return `otpauth://totp/${label}?secret=${encoded}&issuer=PixelPick`;
}
