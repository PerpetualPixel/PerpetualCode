export class QuotaManager {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/check') {
      return this.handleCheck(request);
    }
    if (pathname === '/increment') {
      return this.handleIncrement(request);
    }
    if (pathname === '/reset') {
      return this.handleReset(request);
    }
    if (pathname === '/ratelimit') {
      return this.handleRateLimit(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Fixed-window per-minute rate limiting, one counter per key. Lives in
   * this Durable Object (idFromName per key — see index.js's rateLimited)
   * because DO storage is the one place in Workers with genuinely
   * consistent cross-request state: the platform's own [[ratelimits]]
   * binding was tried first and its counters turned out not to accumulate
   * across separate requests here (verified live — 30 rapid requests from
   * one IP never tripped a 10/min limit, while 15 calls inside a single
   * request tripped it at 12), which defeats the whole point for
   * brute-force protection. The single stored record self-resets each
   * minute rather than accreting one key per window.
   */
  async handleRateLimit(request) {
    const { key, limit = 10 } = await request.json();
    const win = Math.floor(Date.now() / 60000);
    const storageKey = `rl:${key}`;
    const rec = (await this.state.storage.get(storageKey)) || { win: 0, count: 0 };
    if (rec.win !== win) {
      rec.win = win;
      rec.count = 0;
    }
    rec.count += 1;
    await this.state.storage.put(storageKey, rec);
    return new Response(JSON.stringify({ allowed: rec.count <= limit }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async handleCheck(request) {
    const { userId, limit = 3 } = await request.json();
    const today = new Date().toISOString().split('T')[0];
    const key = `usage:${userId}:${today}`;

    const count = (await this.state.storage.get(key)) || 0;
    const allowed = count < limit;

    return new Response(
      JSON.stringify({ allowed, remaining: Math.max(0, limit - count), used: count }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  async handleIncrement(request) {
    const { userId } = await request.json();
    const today = new Date().toISOString().split('T')[0];
    const key = `usage:${userId}:${today}`;

    const count = ((await this.state.storage.get(key)) || 0) + 1;
    await this.state.storage.put(key, count);

    return new Response(JSON.stringify({ used: count }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async handleReset(request) {
    const { userId } = await request.json();
    const today = new Date().toISOString().split('T')[0];
    const key = `usage:${userId}:${today}`;
    await this.state.storage.delete(key);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
