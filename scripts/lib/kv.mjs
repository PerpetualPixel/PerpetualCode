/**
 * The worker's KV from a GitHub runner, through Cloudflare's API: the
 * namespace id from worker/wrangler.toml, the token and account from the
 * environment (the deploy workflow's secrets; the token's "Edit Cloudflare
 * Workers" template carries KV read and write).
 */
import { readFileSync } from 'node:fs';

export function kvConfig() {
  const toml = readFileSync(new URL('../../worker/wrangler.toml', import.meta.url), 'utf8');
  const block = /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"POTD_KV"[\s\S]*?id\s*=\s*"([0-9a-f]+)"/.exec(toml);
  if (!block) throw new Error('POTD_KV namespace id not found in worker/wrangler.toml');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (or pass --dry-run)');
  return { namespace: block[1], token, account };
}

const base = () => { const { namespace, account } = kvConfig(); return `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`; };

/** One value by key, parsed as JSON, or null when it is not there. */
export async function readKv(key) {
  const { token } = kvConfig();
  const res = await fetch(`${base()}/values/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read failed: HTTP ${res.status}`);
  return res.json();
}

/** Entries [{ key, value }] written in batches of 20 with a TTL, values as JSON. */
export async function writeKv(entries, { ttlSeconds = 3 * 86400, say = () => {} } = {}) {
  const { token } = kvConfig();
  for (let i = 0; i < entries.length; i += 20) {
    const batch = entries.slice(i, i + 20).map((e) => ({ key: e.key, value: JSON.stringify(e.value), ...(ttlSeconds ? { expiration_ttl: ttlSeconds } : {}) }));
    const res = await fetch(`${base()}/bulk`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) throw new Error(`KV write failed: HTTP ${res.status} ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
    say(`  wrote ${batch.length} keys (${(batch.reduce((n, b) => n + b.value.length, 0) / 1e6).toFixed(2)} MB)`);
  }
}
