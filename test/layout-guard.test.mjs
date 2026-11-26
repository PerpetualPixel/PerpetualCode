/**
 * Rows that must not cram (2026-11-25, the owner, with a screenshot of an MVP ticket on a phone where "Points 15+"
 * ran under "12/13 92%": "everything is crammed, fix this so it doesn't happen again").
 *
 * The cause was one pattern in docs/styles.css: a piece of text told never to wrap (white-space: nowrap) and also
 * allowed to shrink below its own width (min-width: 0), with nothing to cut it off. In a narrow row it keeps its
 * full width on screen and runs under whatever sits beside it. The first test here reads the whole stylesheet and
 * fails on any selector that has that pattern, so the next row written that way is caught before it ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../docs/styles.css', import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '');
const app = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');

/** Every selector's declarations, merged across the file and its media queries. */
function declarations(text, into = new Map()) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    let depth = 1; let j = open + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    const selector = text.slice(i, open).trim(); const body = text.slice(open + 1, j - 1);
    if (/^@(media|supports|container)/.test(selector)) declarations(body, into);
    else if (!selector.startsWith('@')) for (const one of selector.split(',').map((s) => s.trim())) {
      const d = into.get(one) ?? {};
      for (const part of body.split(';')) { const k = part.indexOf(':'); if (k > 0) d[part.slice(0, k).trim()] = part.slice(k + 1).trim(); }
      into.set(one, d);
    }
    i = j;
  }
  return into;
}
const rules = declarations(css);

test('no text is both kept on one line and allowed to shrink under its neighbour without being cut off', () => {
  assert.ok(rules.size > 1000, 'the stylesheet was read');
  const cut = (d) => /hidden|clip|auto|scroll/.test(`${d.overflow ?? ''} ${d['overflow-x'] ?? ''}`) || Boolean(d['text-overflow']);
  const crammed = [...rules].filter(([, d]) => d['white-space'] === 'nowrap' && d['min-width'] === '0' && !cut(d)).map(([selector]) => selector);
  assert.deepEqual(crammed, [], 'each of these needs to wrap, or to be cut with overflow: hidden and text-overflow: ellipsis');
});

test('an MVP leg\'s row: the stat takes the room that is left and wraps in it; the rate, the price, the mark and the caret keep their own width', () => {
  const stat = rules.get('.mvp-leg-stat');
  assert.equal(stat.flex, '1 1 0');
  assert.equal(stat['min-width'], '0');
  assert.notEqual(stat['white-space'], 'nowrap', 'the stat may wrap');
  assert.equal(stat['overflow-wrap'], 'anywhere', 'and a single long word breaks before it runs under the numbers');
  for (const fixed of ['.mvp-leg-rate', '.mvp-leg-price', '.mvp-leg-caret', '.mvp-leg > summary .ufc-leg-mark']) assert.equal(rules.get(fixed).flex, 'none', `${fixed} is never squeezed`);
  // On a paired ticket the player's name has its own line above the stat.
  assert.equal(rules.get('.mvp-leg-stat small').display, 'block');
  assert.match(app, /<span class="mvp-leg-stat">\$\{pair \? `<small>\$\{esc\(String\(leg\.playerName\)\.split\(' '\)\.at\(-1\)\)\}<\/small>` : ''\}<span class="mvp-leg-what">/);
  // On a phone the percentage sits under the count, so the stat keeps its line.
  assert.match(css, /@media \(max-width: 520px\) \{ \.mvp-leg-rate small \{ display: block; \} \}/);
});

// --- The X: every close, dismiss and clear button (2026-11-25: "fix this x and check all others, they should be centered and the same size all around within reason") ---

const page = fs.readFileSync(new URL('../docs/app.html', import.meta.url), 'utf8');
const X_CLASSES = ['overlay-close-btn', 'notice-close', 'sheet-x', 'sheet-close-x', 'players-clear', 'parlay-preset-clear'];

test('every close, dismiss and clear button in the app is one of the shared X buttons', () => {
  // A button whose whole label is an X, or that is labelled Close, Dismiss or Clear, in the page and in what the app draws.
  const buttons = [...`${page}\n${app}`.matchAll(/<button\b[^>]*>(?:\s*[×✕]\s*|<svg[^]*?<\/svg>)<\/button>/g)].map((m) => m[0]).filter((b) => /[×✕]\s*<\/button>|aria-label="(Close|Dismiss|Clear)/.test(b));
  assert.ok(buttons.length >= 13, `found ${buttons.length}`);
  for (const b of buttons) assert.ok(X_CLASSES.some((c) => new RegExp(`class="[^"]*\\b${c}\\b`).test(b)), `not a shared X: ${b.slice(0, 120)}`);
});

test('the X is drawn, not typed: two bars in the middle of the button, in two sizes, each larger on a phone', () => {
  const src = fs.readFileSync(new URL('../docs/styles.css', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('The X: every close, dismiss and clear button'));
  assert.ok(block.length > 500, 'the shared rule is in the stylesheet');
  // The sizes: a panel's X and a strip's X, and the phone's larger pair.
  assert.match(block, /:root \{ --x-size: 40px; --x-size-sm: 30px; \}/);
  assert.match(block, /@media \(max-width: 620px\) \{ :root \{ --x-size: 44px; --x-size-sm: 34px; \} \}/);
  for (const c of X_CLASSES) {
    const d = rules.get(`.${c}`);
    // The typed character is hidden and the button's one cell is centred in it.
    assert.deepEqual([d['font-size'], d['place-content'], d['place-items'], d.padding], ['0', 'center', 'center', '0'], c);
    // Both bars sit in that one cell, the same length, crossed.
    const before = rules.get(`.${c}::before`); const after = rules.get(`.${c}::after`);
    assert.deepEqual([before['grid-area'], before.background, after.transform], ['1 / 1', 'currentColor', 'rotate(-45deg)'], c);
    // No rule of its own gives it a size or a font size that would fight the shared one.
    assert.ok(!/\b(34|36|26|28)px\b/.test(`${d.width} ${d.height}`), `${c} takes its size from the shared rule`);
  }
  // Round ones are as tall as they are wide, from the one variable; the Parlay Builder's slot button keeps its own box.
  for (const c of X_CLASSES.filter((x) => x !== 'parlay-preset-clear')) assert.deepEqual([rules.get(`.${c}`).width, rules.get(`.${c}`).height, rules.get(`.${c}`)['border-radius']], ['var(--x, var(--x-size))', 'var(--x, var(--x-size))', '50%'], c);
  // The small ones say so.
  for (const c of ['.notice-close', '.players-clear', '.update-banner .overlay-close-btn']) assert.equal(rules.get(c)['--x'], 'var(--x-size-sm)', c);
});

test('the tab row can never make the page wider than the window: it scrolls inside itself wherever its tabs do not fit', () => {
  // With nine tabs it ran past the right edge under about 1280px and the whole page scrolled sideways, cutting off what sat at the right.
  const row = rules.get('.top-tabs');
  assert.equal(row['overflow-x'], 'auto');
  assert.equal(row['scrollbar-width'], 'none');
  assert.match(css, /\.top-tabs \{ overflow-x: auto; scrollbar-width: none; padding-top: 12px; margin-top: -12px; \}\n\.top-tabs::-webkit-scrollbar \{ display: none; \}/, 'at every width, not only on a phone');
  // Between a phone and a full desktop the tabs sit closer, so they fit without scrolling where they can.
  assert.match(css, /@media \(min-width: 620px\) and \(max-width: 1339px\) \{\s*\.top-tab \{ padding: 12px 13px; \}/);
});
