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

    return new Response('Not found', { status: 404 });
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
