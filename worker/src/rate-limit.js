/**
 * Request throttles, in one place.
 *
 * The counters live in the QuotaManager Durable Object (worker/src/quota.js's
 * handleRateLimit), one instance per key, because Durable Object storage is
 * the one place in Workers where a read-then-write is atomic across requests:
 * a counter kept in KV can be read by twenty parallel requests before any of
 * them writes it back.
 *
 * Every helper here FAILS OPEN: a limiter that cannot be reached answers
 * "not over the limit". A throttle outage should degrade to no throttle,
 * never to nobody being able to sign in.
 */

/**
 * The bucket one visitor's address counts under.
 *
 * An IPv4 address is its own bucket. An IPv6 subscriber is handed a whole
 * /64 (18 quintillion addresses) and can use a fresh one for every request,
 * so IPv6 is counted by its /64: the first four groups.
 */
export function ipBucket(ip) {
  const s = String(ip ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  let groups;
  if (s.includes('::')) {
    const [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = s.split(':');
  }
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** The bucket of the visitor who sent this request. */
export const clientBucket = (request) => ipBucket(request.headers.get('CF-Connecting-IP'));

/**
 * Count one use of `key` and say whether it is now over `limit` for the
 * current window. With `peek`, only look: nothing is counted, and the answer
 * is whether the limit has already been reached.
 *
 * Windows are fixed, not sliding: every `windowSeconds` the count starts
 * again from nothing.
 */
export async function overLimit(env, key, { limit = 10, windowSeconds = 60, peek = false } = {}) {
  try {
    const id = env.QUOTA_MANAGER.idFromName(`ratelimit:${key}`);
    const res = await env.QUOTA_MANAGER.get(id).fetch(
      new Request('http://quota/ratelimit', {
        method: 'POST',
        body: JSON.stringify({ key, limit, windowSeconds, peek }),
      }),
    );
    const { allowed } = await res.json();
    return !allowed;
  } catch (e) {
    console.error('Rate limiter error (failing open):', e);
    return false;
  }
}

/** Forget the count kept under `key` (a lockout lifted early, e.g. after a password reset). */
export async function clearLimit(env, key) {
  try {
    const id = env.QUOTA_MANAGER.idFromName(`ratelimit:${key}`);
    await env.QUOTA_MANAGER.get(id).fetch(
      new Request('http://quota/ratelimit', { method: 'POST', body: JSON.stringify({ key, clear: true }) }),
    );
  } catch (e) {
    console.error('Rate limiter clear failed:', e);
  }
}
