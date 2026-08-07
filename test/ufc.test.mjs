import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUfcProfile } from '../worker/src/ufc.js';

/**
 * Fixture trimmed from a real ufc.com/athlete/<slug> page (Islam Makhachev,
 * fetched live while building the c-stat-compare parsing this covers) —
 * kept close to the real markup's whitespace/nesting quirks rather than a
 * clean hand-written shape, since that's exactly what broke a naive parse
 * (see ufc.js's comments on c-bio__field and the tag layout below).
 */
const FIXTURE_HTML = `
<div class="c-bio__field">
  <div class="c-bio__label">Age</div>
  <div class="c-bio__text">33</div>
</div>
<div class="c-bio__field">
  <div class="c-bio__label">Place of Birth</div>
  <div class="c-bio__text">Dagestan Republic, Russia</div>
</div>
<meta property="og:image" content="https://ufc.com/photo.jpg">

<div class="e-chart-circle__wrapper">
  <svg><title>Striking accuracy 58%</title></svg>
  <h2 class="e-t3">Striking accuracy</h2>
</div>
<div class="e-chart-circle__wrapper">
  <svg><title>Takedown Accuracy 18%</title></svg>
  <h2 class="e-t3">Takedown Accuracy</h2>
</div>

<div class="c-stat-compare c-stat-compare--no-bar">
  <div class="c-stat-compare__group c-stat-compare__group-1 ">
    <div class="c-stat-compare__number">2.45
        </div>
    <div class="c-stat-compare__label">Sig. Str. Landed</div>
    <div class="c-stat-compare__label-suffix">Per Min</div>
  </div>
  <div class="c-stat-compare__group c-stat-compare__group-2 ">
    <div class="c-stat-compare__number">1.45
        </div>
    <div class="c-stat-compare__label">Sig. Str. Absorbed</div>
    <div class="c-stat-compare__label-suffix">Per Min</div>
  </div>
</div>

<div class="c-stat-compare c-stat-compare--no-bar">
  <div class="c-stat-compare__group c-stat-compare__group-1 ">
    <div class="c-stat-compare__number">3.10
        </div>
    <div class="c-stat-compare__label">Takedown avg</div>
    <div class="c-stat-compare__label-suffix">Per 15 Min</div>
  </div>
  <div class="c-stat-compare__group c-stat-compare__group-2 ">
    <div class="c-stat-compare__number">0.98
        </div>
    <div class="c-stat-compare__label">Submission avg</div>
    <div class="c-stat-compare__label-suffix">Per 15 Min</div>
  </div>
</div>

<div class="c-stat-compare c-stat-compare--no-bar">
  <div class="c-stat-compare__group c-stat-compare__group-1 ">
    <div class="c-stat-compare__number">62
        <div class="c-stat-compare__percent">%</div></div>
    <div class="c-stat-compare__label">Sig. Str. Defense</div>
  </div>
  <div class="c-stat-compare__group c-stat-compare__group-2 ">
    <div class="c-stat-compare__number">91
        <div class="c-stat-compare__percent">%</div></div>
    <div class="c-stat-compare__label">Takedown Defense</div>
  </div>
</div>

<h2 class="c-stat-3bar__title">Win by Method</h2>
<div class="c-stat-3bar__group">
  <div class="c-stat-3bar__label">KO/TKO </div>
  <div class="c-stat-3bar__value">5 (18%)</div>
</div>
<div class="c-stat-3bar__group">
  <div class="c-stat-3bar__label">DEC </div>
  <div class="c-stat-3bar__value">10 (36%) </div>
</div>
<div class="c-stat-3bar__group">
  <div class="c-stat-3bar__label">SUB </div>
  <div class="c-stat-3bar__value">13 (46%)</div>
</div>
`;

function stubUfcPage(html) {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
}

const ctx = { waitUntil: (p) => p };

test('fetchUfcProfile parses the rate-stat comparison rows (landed/absorbed per min, takedown avg, defenses)', async () => {
  stubUfcPage(FIXTURE_HTML);
  const profile = await fetchUfcProfile('Islam Makhachev', ctx);

  assert.equal(profile.sigStrikeLandedPerMin, 2.45);
  assert.equal(profile.sigStrikeAbsorbedPerMin, 1.45);
  assert.equal(profile.sigStrikeDefense, 62);
  assert.equal(profile.takedownAvgPer15Min, 3.10);
  assert.equal(profile.takedownDefense, 91);
});

test('fetchUfcProfile still parses the pre-existing accuracy/win-method fields alongside the new ones', async () => {
  stubUfcPage(FIXTURE_HTML);
  const profile = await fetchUfcProfile('Islam Makhachev', ctx);

  assert.equal(profile.strikingAccuracy, 58);
  assert.equal(profile.takedownAccuracy, 18);
  assert.deepEqual(profile.winMethod, [
    { label: 'KO/TKO', count: 5, pct: 18 },
    { label: 'DEC', count: 10, pct: 36 },
    { label: 'SUB', count: 13, pct: 46 },
  ]);
  assert.equal(profile.bio.placeOfBirth, 'Dagestan Republic, Russia');
});

test('a page missing the rate-stat rows entirely leaves those fields null, not zero or fabricated', async () => {
  stubUfcPage(`
    <div class="c-bio__field">
      <div class="c-bio__label">Age</div>
      <div class="c-bio__text">27</div>
    </div>
  `);
  const profile = await fetchUfcProfile('Some Fighter', ctx);

  assert.equal(profile.sigStrikeLandedPerMin, null);
  assert.equal(profile.sigStrikeAbsorbedPerMin, null);
  assert.equal(profile.takedownAvgPer15Min, null);
  assert.equal(profile.takedownDefense, null);
});

test('a slug that resolves to no real athlete page returns null, never a guessed profile', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html>not an athlete page</html>' });
  const profile = await fetchUfcProfile('Nobody At All', ctx);
  assert.equal(profile, null);
});
