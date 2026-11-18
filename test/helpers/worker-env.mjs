/**
 * A worker `env` for tests of the account routes: a real SQL database built
 * from the worker's own migrations, the rate limiter's Durable Object run in
 * memory, a KV, and an email binding that keeps what it was asked to send.
 *
 * The database is node:sqlite (D1 is SQLite), wrapped in the three calls the
 * handlers use: prepare(sql).bind(...).first() / .run() / .all(). So a
 * statement that would fail on D1 for its SQL fails here too.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { QuotaManager } from '../../worker/src/quota.js';

const MIGRATIONS = new URL('../../worker/src/migrations/', import.meta.url);

export function makeDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
  });
  return { prepare: (sql) => statement(sql), raw: db };
}

/** The QuotaManager Durable Object namespace, one in-memory instance per name. */
export function makeQuotaManager() {
  const instances = new Map();
  return {
    idFromName: (name) => name,
    get(name) {
      if (!instances.has(name)) {
        const store = new Map();
        const state = { storage: { async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } };
        const object = new QuotaManager(state, {});
        // A Durable Object takes one request's storage work at a time (its
        // input gate): a read followed by a write is never interleaved with
        // another request's. Modelled here by running each fetch after the last.
        let queue = Promise.resolve();
        instances.set(name, { fetch: (request) => { const run = queue.then(() => object.fetch(request)); queue = run.catch(() => {}); return run; } });
      }
      return instances.get(name);
    },
  };
}

export function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k, type) { const v = store.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

export function makeEnv(extra = {}) {
  const sent = [];
  return {
    DB: makeDb(),
    QUOTA_MANAGER: makeQuotaManager(),
    POTD_KV: makeKv(),
    EMAIL: { async send(m) { sent.push(m); } },
    JWT_SECRET: 'test-secret-that-is-long-enough-to-be-one',
    ALLOWED_ORIGINS: 'https://perpetualpicks.com',
    sent,
    ...extra,
  };
}

/** A JSON request the way the browser sends one. */
export function req(path, { method = 'POST', body, token, ip = '203.0.113.7', headers = {} } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      Origin: 'https://perpetualpicks.com',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The token in the newest email to `to` whose link carries `param`, e.g. 'token', 'resetToken', 'emailToken'. */
export function linkToken(env, to, param) {
  const mail = [...env.sent].reverse().find((m) => m.to === to && new RegExp(`[?&]${param}=`).test(m.text ?? ''));
  return mail ? mail.text.match(new RegExp(`[?&]${param}=([0-9a-f]+)`))[1] : null;
}
