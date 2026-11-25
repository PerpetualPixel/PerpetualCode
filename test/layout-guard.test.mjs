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
