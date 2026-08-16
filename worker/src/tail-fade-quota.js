/**
 * Daily usage quota for Tail or Fade's bet-slip reader.
 *
 * Every extraction is a paid vision call, so the endpoint needs a per-user
 * ceiling rather than only the per-minute burst limiter the route already
 * sits behind. Those two answer different questions: the burst limiter stops
 * one client hammering the endpoint in a loop, and this stops a normal-paced
 * user quietly costing a fortune over a day.
 *
 * The owner is exempt. Not a courtesy — the owner is who diagnoses this
 * feature when it misbehaves, and a limit that stops them reading the tenth
 * slip of a debugging session is a limit that makes the tool harder to fix
 * than to break.
 *
 * IDENTITY, AND WHY IT DEGRADES THE WAY IT DOES
 * ---------------------------------------------
 * A signed-in user is counted by account id, which is the honest unit: it
 * follows them across devices and survives clearing cookies. An anonymous
 * visitor has no account, so they are counted by IP — weaker (a shared
 * office NAT counts as one visitor, a phone changing networks as several)
 * but it is the only stable handle available, and the alternative of not
 * counting anonymous use at all would leave the paid endpoint open.
 *
 * Anonymous users therefore get a SMALLER allowance than signed-in ones.
 * Not to punish them: an IP is a coarse bucket, and the cost of getting it
 * wrong should be smaller than the cost of getting an account wrong.
 *
 * Counts live in KV under a date-scoped key that expires on its own, so
 * there is no reset job to run and no way for a stale counter to lock
 * someone out tomorrow because of what they did today.
 */

const ET_TZ = 'America/New_York';

/** Signed-in allowance per ET calendar day. */
export const DAILY_LIMIT_AUTHENTICATED = 10;
/** Anonymous allowance — see the header for why it is lower, not equal. */
export const DAILY_LIMIT_ANONYMOUS = 3;

// A day plus a margin. The key is already date-scoped, so the TTL exists
// only to stop KV accumulating dead counters — the margin covers the gap
// between an ET day ending and the TTL expiring in UTC.
const COUNTER_TTL_SECONDS = 60 * 60 * 36;

/** ET calendar date (YYYY-MM-DD) — the same day boundary every other surface uses. */
export function etDate(ms = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Who is asking, and what they are allowed.
 *
 * `authenticate` is injected rather than imported so this module stays
 * testable without a database — the same reason every batch in this worker
 * takes its fetcher as a parameter.
 */
export async function resolveQuotaIdentity(request, env, { authenticate } = {}) {
  // Owner first: an owner key is a deliberate act, and checking it before
  // touching the database keeps the owner's path working even if D1 is down
  // — which is exactly when they need to be debugging.
  const configured = String(env?.OWNER_PASSPHRASE ?? '').trim();
  const supplied = String(request.headers.get('X-Owner-Key') ?? '').trim();
  if (configured && supplied && supplied === configured) {
    return { kind: 'owner', id: 'owner', limit: Infinity, exempt: true };
  }

  if (authenticate) {
    try {
      const payload = await authenticate(request, env);
      if (payload?.userId) {
        return {
          kind: 'user',
          id: `u:${payload.userId}`,
          limit: DAILY_LIMIT_AUTHENTICATED,
          exempt: false,
        };
      }
    } catch {
      // A failed lookup must not become a free pass. Falling through to the
      // anonymous bucket keeps the endpoint covered when auth is degraded.
    }
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return { kind: 'anonymous', id: `ip:${ip}`, limit: DAILY_LIMIT_ANONYMOUS, exempt: false };
}

const counterKey = (identity, dateKey) => `tfquota:${dateKey}:${identity.id}`;

/**
 * Current usage without consuming any — for a UI that wants to show
 * "3 of 10 left today" before the user commits to an upload.
 */
export async function getQuotaUsage(request, env, { now = Date.now(), authenticate } = {}) {
  const identity = await resolveQuotaIdentity(request, env, { authenticate });
  if (identity.exempt) {
    return { kind: identity.kind, used: 0, limit: null, remaining: null, exempt: true };
  }
  const dateKey = etDate(now);
  const raw = await env.POTD_KV.get(counterKey(identity, dateKey));
  const used = Number(raw) || 0;
  return {
    kind: identity.kind,
    used,
    limit: identity.limit,
    remaining: Math.max(0, identity.limit - used),
    exempt: false,
    resetsAt: `${dateKey} end of day ET`,
  };
}

/**
 * Consume one unit if the caller has one.
 *
 * Returns `{ allowed, ... }` rather than throwing, because a user out of
 * quota is a normal state the route has to render, not an exceptional one.
 *
 * Counted BEFORE the paid call rather than after, so a request that fails
 * upstream still consumes its unit. That is the deliberate direction: the
 * spend has already happened by then, and the alternative — only counting
 * successes — makes a stream of failures free and unbounded.
 *
 * Fails OPEN on a KV error. A counter this app cannot read is not a reason
 * to deny a paying feature to everyone; the per-minute burst limiter is
 * still in front of the route, so the exposure of failing open is bounded
 * rather than unlimited.
 */
export async function consumeQuota(request, env, { now = Date.now(), authenticate } = {}) {
  const identity = await resolveQuotaIdentity(request, env, { authenticate });
  if (identity.exempt) {
    return { allowed: true, kind: identity.kind, used: 0, limit: null, remaining: null, exempt: true };
  }

  const dateKey = etDate(now);
  const key = counterKey(identity, dateKey);

  let used = 0;
  try {
    used = Number(await env.POTD_KV.get(key)) || 0;
  } catch (error) {
    console.error('Tail or Fade quota read failed (failing open):', error);
    return { allowed: true, kind: identity.kind, used: 0, limit: identity.limit, remaining: null, degraded: true };
  }

  if (used >= identity.limit) {
    return {
      allowed: false,
      kind: identity.kind,
      used,
      limit: identity.limit,
      remaining: 0,
      message: identity.kind === 'anonymous'
        ? `You've used all ${identity.limit} bet slip reads for today. Sign in for ${DAILY_LIMIT_AUTHENTICATED} a day, or type the bet in instead — that has no limit.`
        : `You've used all ${identity.limit} bet slip reads for today. They reset at midnight ET. Typing a bet in or picking it off the slate has no limit.`,
    };
  }

  try {
    await env.POTD_KV.put(key, String(used + 1), { expirationTtl: COUNTER_TTL_SECONDS });
  } catch (error) {
    // Same reasoning as the read: a counter that cannot be written is not a
    // reason to deny the request, and the burst limiter still applies.
    console.error('Tail or Fade quota write failed (allowing anyway):', error);
  }

  return {
    allowed: true,
    kind: identity.kind,
    used: used + 1,
    limit: identity.limit,
    remaining: Math.max(0, identity.limit - used - 1),
  };
}
