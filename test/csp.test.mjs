/**
 * Content-Security-Policy guards for the static pages.
 *
 * A CSP regression is the kind that hides best. When connect-src omits a
 * host the page fetches, nothing throws and nothing renders an error: the
 * browser refuses the request, the calling code takes its ordinary "feed
 * unavailable" branch, and the page carries on looking correct while
 * silently missing a whole feature. That exact bug shipped — the CSP added
 * with the code-health pass listed only the worker, which blocked
 * MMA_Engine's picks.json and stripped every fight card of its consensus
 * call, capper reasoning and cancelled-bout annotation, in production, with
 * nothing failing anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const read = (rel) => readFileSync(`${DOCS}${rel}`, 'utf8');
const PAGES = readdirSync(DOCS).filter((f) => f.endsWith('.html'));

/** One page's CSP directives as a map of name -> Set(values). */
function policy(page) {
  const csp = read(page).match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!csp) return null;
  return new Map(csp[1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return [name, new Set(values)];
  }));
}

test('app.html allows the MMA Engine feed it actually fetches', () => {
  // Read the origin out of the fetching module rather than repeating it, so
  // moving the feed can't leave this test asserting a stale host.
  const feed = read('capper-consensus.js').match(/'(https:\/\/[^']+picks\.json)'/);
  assert.ok(feed, 'capper-consensus.js must define the picks.json feed URL');
  const origin = new URL(feed[1]).origin;

  const connect = policy('app.html')?.get('connect-src');
  assert.ok(connect, 'app.html must declare a connect-src');
  assert.ok(
    connect.has(origin),
    `app.html connect-src must allow ${origin} — without it the fetch is refused `
    + 'and every fight card silently loses its consensus data',
  );
});

test('every page keeps the load-bearing script-src, and none re-opens inline script', () => {
  // The whole point of the code-health pass: with 'unsafe-inline' gone and
  // every handler delegated, an injected <script> or onerror="" cannot run —
  // which matters most because the auth token lives in localStorage, readable
  // by any script that does.
  for (const page of PAGES) {
    const p = policy(page);
    assert.ok(p, `${page} must declare a Content-Security-Policy`);

    const script = p.get('script-src');
    assert.ok(script, `${page} must declare a script-src`);
    assert.ok(script.has("'self'"), `${page} script-src must allow 'self'`);
    assert.ok(
      !script.has("'unsafe-inline'"),
      `${page} script-src must not allow 'unsafe-inline' — that is the directive `
      + 'the whole inline-script extraction exists to make possible',
    );
    assert.equal(p.get('object-src')?.has("'none'"), true, `${page} must set object-src 'none'`);
  }
});
