/**
 * The things that make the first screen arrive sooner (2026-11-25: "optimize the website to load quicker"), each of
 * which fails silently if it drifts: a preload that names a file the app no longer imports is a wasted download, one
 * that is missing puts that file back in the queue behind app.js, and an early request to the wrong address is a
 * second request rather than a head start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
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

test('the loader film is small enough to be worth showing, and every loader on the page names it', () => {
  const film = path.join(docs, 'assets/loader.mp4');
  assert.ok(existsSync(film));
  assert.ok(statSync(film).size < 300_000, 'the loader film should stay well under the size of the page it stands in for');
  const html = read('app.html');
  assert.ok(!html.includes('pp-loading'), 'the old spinning-logo loader is gone');
  const films = [...html.matchAll(/<video class="pp-loader-video"[^>]*>/g)].map((m) => m[0]);
  assert.ok(films.length >= 2);
  // Silent, inline and looping, or a phone will not start it by itself.
  for (const tag of films) for (const attr of ['src="assets/loader.mp4"', 'autoplay', 'muted', 'loop', 'playsinline']) assert.ok(tag.includes(attr), `${attr} missing on ${tag}`);
});
