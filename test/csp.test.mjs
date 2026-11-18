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

test('every page loads the frame guard first, before any other script', () => {
  // The guard is what stands in for the frame-ancestors header GitHub Pages
  // cannot send: a page without it, or with a script ahead of it, can be
  // framed by another site and clicked on (docs/frame-guard.js).
  for (const page of PAGES) {
    const scripts = [...read(page).matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
    assert.ok(scripts.length, `${page} must load the frame guard`);
    assert.match(scripts[0][1], /^frame-guard\.js(\?v=[\w.]+)?$/, `${page}: the first script must be frame-guard.js`);
    assert.doesNotMatch(scripts[0][0], /\b(async|defer)\b|type="module"/, `${page}: the guard must run before the page renders, not after`);
    assert.ok(read(page).indexOf(scripts[0][0]) < read(page).indexOf('<body'), `${page}: the guard belongs in the head`);
  }
});

test('a link from data is https or a path on this site, or nothing', async () => {
  const { safeUrl } = await import('../docs/safe-url.js');
  for (const ok of [
    'https://sportsbook.fanduel.com/addToBetslip?marketId=42.1&selectionId=7',
    'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=d35cad85&dl=betslip',
    'HTTPS://Example.com/x', 'account.html', './app.html?tab=ufc', '#', '/data/x.json',
  ]) assert.equal(safeUrl(ok), ok, ok);
  assert.equal(safeUrl('  https://example.com/a  '), 'https://example.com/a');
  for (const bad of [
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'http://example.com/', '//evil.example/x', '\\\\evil.example/x',
    'ftp://example.com', 'intent://x', '', null, undefined,
  ]) assert.equal(safeUrl(bad), '#', JSON.stringify(bad));
  // And every data-driven href in the app goes through it.
  const app = read('app.js');
  assert.equal([...app.matchAll(/href="\$\{(?!escUrl\()/g)].length, 0, 'an href built from data must use escUrl()');
});
