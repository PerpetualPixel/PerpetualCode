/**
 * The things that make the first screen arrive sooner (2026-11-25: "optimize the website to load quicker"), each of
 * which fails silently if it drifts: a preload that names a file the app no longer imports is a wasted download, one
 * that is missing puts that file back in the queue behind app.js, and an early request to the wrong address is a
 * second request rather than a head start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONFIG } from '../docs/config.js';

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
const read = (rel) => readFileSync(path.join(docs, rel), 'utf8');

/** Every file app.js imports, directly or through another import. */
function moduleGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const src = read(file);
    const specs = [...src.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.[^'"]+\.js)['"]|^\s*import\s*['"](\.[^'"]+\.js)['"]/gm)].map((m) => m[1] ?? m[2]);
    for (const spec of specs) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (next === entry || seen.has(next)) continue;
      assert.ok(existsSync(path.join(docs, next)), `${file} imports ${spec}, which is not in docs/`);
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort();
}

test('app.html preloads exactly the files app.js imports, each named as the import names it', () => {
  const html = read('app.html');
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(preloaded.length > 10, 'the modulepreload block is empty: run update-version.js');
  for (const href of preloaded) assert.ok(!href.includes('?'), `${href}: a stamped preload is a different address from the import, so the file is fetched twice`);
  assert.deepEqual([...preloaded].sort(), moduleGraph('app.js'), 'the modulepreload block is out of step with app.js: run update-version.js');
  assert.equal(new Set(preloaded).size, preloaded.length, 'a file is preloaded twice');
});

test('the head asks for the first board at the address the app reads it from', () => {
  const early = read('early.js');
  const asked = early.match(/fetch\('([^']+)'/);
  assert.ok(asked, 'docs/early.js should ask for the first board');
  assert.equal(asked[1], new URL('/trends', CONFIG.WORKER_URL).href, 'docs/early.js and docs/config.js name different workers');
  // The app's own request carries no league on a first visit, so the two are the same read.
  assert.match(read('app.js'), /globalThis\.ppEarly\?\.trends/);
});

test('the early script runs in the head, after the frame guard and before the stylesheet', () => {
  const html = read('app.html');
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i > 0, `app.html should carry ${needle}`); return i; };
  assert.ok(at('src="frame-guard.js') < at('src="early.js'));
  assert.ok(at('src="early.js') < at('href="styles.css'));
  assert.ok(at('src="early.js') < at('</head>'));
});

/** docs/loader-fx.js run with a stand-in page: the canvas records what is drawn on it, as text. */
function loaderFx({ reducedMotion = false } = {}) {
  const frames = [];
  const window = {};
  const document = { readyState: 'complete', hidden: false, addEventListener() {}, querySelectorAll: () => [] };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'matchMedia', 'requestAnimationFrame', 'performance', read('loader-fx.js'))(window, document, () => ({ matches: reducedMotion }), (fn) => { frames.push(fn); }, { now: () => 0 });
  const canvasOf = (w, h) => {
    const log = [];
    const grad = () => ({ addColorStop: (o, c) => log.push(`stop ${o} ${c}`) });
    const ctx = new Proxy({}, {
      get: (t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? (...a) => { log.push(`${k} ${a.map((v) => v.toFixed(3)).join(',')}`); return grad(); } : (...a) => { log.push(`${String(k)} ${a.map((v) => (typeof v === 'number' ? v.toFixed(3) : v)).join(',')}`); }),
      set: (t, k, v) => { log.push(`${String(k)}=${typeof v === 'number' ? v.toFixed(4) : typeof v === 'string' ? v : 'gradient'}`); return true; },
    });
    return { width: w, height: h, getContext: () => ctx, log };
  };
  return { fx: window.ppLoaderFx, frames, canvasOf };
}

test('the loader is drawn on the page, not played as a film: a clear canvas in every loader, and its script in the head', () => {
  assert.ok(!existsSync(path.join(docs, 'assets/loader.mp4')), 'the film is gone: a film is a rectangle, and its edges showed');
  for (const page of ['app.html', 'account.html']) {
    const html = read(page);
    assert.ok(!/<video[^>]*loader/.test(html) && !html.includes('pp-loading'), `${page}: no film and no spinning logo`);
    assert.match(html, /<script src="loader-fx\.js\?v=[^"]+" defer><\/script>/, `${page} loads the animation, deferred`);
    assert.ok(html.indexOf('src="loader-fx.js') < html.indexOf('</head>'), `${page}: in the head`);
  }
  const statics = [...read('app.html').matchAll(/<span class="pp-loader-art"[^>]*>.*?<\/span>/g)].map((m) => m[0]);
  assert.ok(statics.length >= 2);
  // The drawn emblem first (it shows before any script has run), then the canvas the animation takes over on.
  for (const art of statics) assert.match(art, /<svg[\s\S]*<\/svg><canvas class="pp-loader-fx"><\/canvas>/);
  assert.match(read('app.js'), /globalThis\.ppLoaderFx\?\.start\(\)/, 'a loader put up by the app starts the animation');
  assert.match(read('styles.css'), /\.pp-loader-art\.is-fx svg \{ opacity: 0; \}/);
});

test('the lap has no seam: the frame at the end of a lap is the frame at its start, and the orb is somewhere else in between', () => {
  const { fx, canvasOf } = loaderFx();
  const frame = (phase, w = 560, h = 280) => { const c = canvasOf(w, h); fx.draw(c, phase); return c.log.join('\n'); };
  assert.equal(frame(1), frame(0), 'a whole lap on, the same picture');
  assert.equal(frame(2.25), frame(0.25));
  assert.notEqual(frame(0.5), frame(0));
  assert.notEqual(frame(0.25), frame(0.75));
  // The ground is cleared each frame and never painted: there is no rectangle to see.
  const log = frame(0.3).split('\n');
  assert.equal(log.filter((l) => l.startsWith('clearRect')).length, 1);
  assert.ok(!log.some((l) => l.startsWith('fillRect') || l.startsWith('rect ')), 'nothing fills the canvas');
  // The small size (a status line) draws less, not differently.
  assert.ok(frame(0.3, 220, 110).split('\n').length < log.length);
  assert.ok(fx.lapMs >= 1500 && fx.lapMs <= 4000);
});

test('the animation runs only while a loader is showing, and not at all for a reduced-motion user', () => {
  const on = loaderFx();
  assert.equal(on.frames.length, 1, 'it starts with the page');
  // No canvas on show: it winds down by itself instead of running for ever.
  let ticks = 0;
  while (on.frames.length && ticks < 200) { const next = on.frames.shift(); next(ticks * 16); ticks++; }
  assert.ok(ticks > 5 && ticks < 60, `stopped after ${ticks} empty frames`);
  on.fx.start();
  assert.equal(on.frames.length, 1, 'and starts again when a loader goes up');
  const off = loaderFx({ reducedMotion: true });
  off.fx.start();
  assert.equal(off.frames.length, 0);
});
