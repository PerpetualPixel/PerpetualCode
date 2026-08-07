import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNickname,
  parseNationalityLocation,
  computeCurrentStreak,
  fetchMmaContext,
} from '../worker/src/mma.js';

const ctx = { waitUntil: (p) => p };

test('parseNickname: returns null when Sherdog marks the fighter as having none', () => {
  const html = '<span class="nickname_empty">&nbsp;</span>';
  assert.equal(parseNickname(html), null);
});

test('parseNickname: extracts a real nickname (Bryan Battle "The Butcher", confirmed live)', () => {
  const html = '<h1 itemprop="name"><span class="nickname">"<em>The Butcher</em>"</span></h1>';
  assert.equal(parseNickname(html), 'The Butcher');
});

test('parseNationalityLocation: extracts nationality and locality from the fighter-nationality block', () => {
  const html = `
    <div class="fighter-nationality">
      <span class="item birthplace">
        <strong itemprop="nationality">United States</strong><br />
        <span itemprop="address"><span itemprop="addressLocality" class="locality">Charlotte, North Carolina</span></span>
      </span>
    </div>`;
  const result = parseNationalityLocation(html);
  assert.equal(result.nationality, 'United States');
  assert.equal(result.location, 'Charlotte, North Carolina');
});

test('parseNationalityLocation: both null when the block is missing entirely, not a throw', () => {
  const result = parseNationalityLocation('<div>nothing here</div>');
  assert.deepEqual(result, { nationality: null, location: null });
});

test('computeCurrentStreak: counts consecutive same-result fights from the most recent', () => {
  const history = [
    { result: 'win' }, { result: 'win' }, { result: 'win' }, { result: 'loss' }, { result: 'win' },
  ];
  assert.deepEqual(computeCurrentStreak(history), { result: 'win', count: 3 });
});

test('computeCurrentStreak: a streak of exactly one is still reported, not treated as "no streak"', () => {
  const history = [{ result: 'loss' }, { result: 'win' }];
  assert.deepEqual(computeCurrentStreak(history), { result: 'loss', count: 1 });
});

test('computeCurrentStreak: null for an empty history, not a fabricated 0', () => {
  assert.equal(computeCurrentStreak([]), null);
});

/* ---------------------------------------------------------------- */
/* fetchMmaContext: opponent-record-at-time reconstruction           */
/* ---------------------------------------------------------------- */

function makeSearchPage(name, href) {
  return `<div id="fightfinder_result">
    <tr><td><a onclick="document.location='${href}'"></a><a href="${href}">${name}</a></td></tr>
  </div>`;
}

function makeFighterPage({ name, record, history, nickname = null }) {
  const rows = history.map((h) => `
    <tr>
      <td><span class="final_result ${h.result}">${h.result}</span></td>
      <td><a href="${h.opponentHref}">${h.opponent}</a></td>
      <td><a href="/events/x">${h.event}</a><br /><span class="sub_line">${h.date}</span></td>
      <td class="winby"><b>Decision</b></td>
      <td>1</td>
      <td>5:00</td>
    </tr>`).join('');

  return `
    <div class="fighter-nationality">
      <span class="item birthplace"><strong itemprop="nationality">USA</strong></span>
    </div>
    <h1 itemprop="name"><span class="fn">${name}</span></h1>
    ${nickname ? `<span class="nickname">"<em>${nickname}</em>"</span>` : '<span class="nickname_empty">&nbsp;</span>'}
    <div class="fight-card-preview">
      <a href="/fighter/${name.replace(/\s+/g, '-')}-1">x</a>
      <span class="record">${record}</span>
    </div>
    <div itemprop="image" src="/img/x.jpg"></div>
    <div class="bio-holder">
      <table><tr><td>AGE</td><td><b>30</b></td></tr></table>
    </div>
    <div class="fight_history">
      <table>
        <tr class="table_head"><td>Result</td></tr>
        ${rows}
      </table>
    </div>`;
}

test('fetchMmaContext reconstructs an opponent\'s record as of the fight date, not their current record', async () => {
  // Subject fought "Old Rival" on Jun/01/2024. Old Rival's OWN history shows
  // 2 wins before that date and 1 more win after it (from a later fight) -
  // the record-at-the-time should count only the 2 that came before.
  const pages = {
    '/fighter/Subject-1': makeFighterPage({
      name: 'Subject Fighter',
      record: '5-0-0',
      history: [
        { result: 'win', opponent: 'Old Rival', opponentHref: '/fighter/Old-Rival-2', event: 'Some Event', date: 'Jun / 01 / 2024' },
      ],
    }),
    '/fighter/Old-Rival-2': makeFighterPage({
      name: 'Old Rival',
      record: '3-1-0',
      history: [
        // Newest first, matching Sherdog's own order.
        { result: 'win', opponent: 'Someone Later', opponentHref: '/fighter/X-9', event: 'Later Event', date: 'Jan / 01 / 2025' },
        { result: 'loss', opponent: 'Subject Fighter', opponentHref: '/fighter/Subject-1', event: 'Some Event', date: 'Jun / 01 / 2024' },
        { result: 'win', opponent: 'Prior Opponent 2', opponentHref: '/fighter/X-10', event: 'Earlier Event 2', date: 'Mar / 01 / 2024' },
        { result: 'win', opponent: 'Prior Opponent 1', opponentHref: '/fighter/X-11', event: 'Earlier Event 1', date: 'Jan / 01 / 2024' },
      ],
    }),
  };

  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stats/fightfinder')) {
      const name = decodeURIComponent(u.split('SearchTxt=')[1] ?? '').replace(/\+/g, ' ');
      const href = name.includes('Subject') ? '/fighter/Subject-1' : '/fighter/Old-Rival-2';
      return { ok: true, text: async () => makeSearchPage(name, href) };
    }
    const path = new URL(u).pathname;
    return pages[path]
      ? { ok: true, text: async () => pages[path] }
      : { ok: false, status: 404, text: async () => '' };
  };

  const result = await fetchMmaContext({ fighterA: 'Subject Fighter', fighterB: 'irrelevant' }, ctx);
  const fight = result.a.history[0];
  assert.equal(fight.opponent, 'Old Rival');
  // As of Jun/01/2024: 2 wins before that date (Jan and Mar), the loss to
  // Subject Fighter itself same-day counts too (on-or-before), and the
  // Jan/2025 win must NOT be counted (it's after the fight).
  assert.deepEqual(fight.opponentRecordAtTime, { wins: 2, losses: 1, draws: 0 });
});

test('fetchMmaContext: a history row beyond the lookback window has no opponentRecordAtTime, not a stale/wrong one', async () => {
  const manyFights = Array.from({ length: 15 }, (_, i) => ({
    result: 'win',
    opponent: `Opp ${i}`,
    opponentHref: `/fighter/Opp-${i}`,
    event: 'Event',
    date: 'Jan / 01 / 2024',
  }));

  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stats/fightfinder')) {
      return { ok: true, text: async () => makeSearchPage('Subject Fighter', '/fighter/Subject-1') };
    }
    if (u.includes('/fighter/Subject-1')) {
      return { ok: true, text: async () => makeFighterPage({ name: 'Subject Fighter', record: '15-0-0', history: manyFights }) };
    }
    // Every opponent has a thin, fast-to-parse profile.
    return { ok: true, text: async () => makeFighterPage({ name: 'Opp', record: '1-0-0', history: [] }) };
  };

  const result = await fetchMmaContext({ fighterA: 'Subject Fighter', fighterB: 'irrelevant' }, ctx);
  const history = result.a.history;
  assert.equal(history.length, 15);
  assert.ok(history[0].opponentRecordAtTime !== undefined, 'within the lookback window');
  assert.equal(history[14].opponentRecordAtTime, undefined, 'beyond the lookback window: field simply absent');
});
