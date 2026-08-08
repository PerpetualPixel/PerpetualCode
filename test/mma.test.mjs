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

/* ---------------------------------------------------------------- */
/* searchFighter (via fetchMmaContext): tie-safety, full-name only    */
/* ---------------------------------------------------------------- */

/**
 * Regression test for a tie-detection improvement that IS still in place
 * (a surname-widened retry was tried and reverted — see searchFighter's own
 * comment — but scoring the full-name query's own results without guessing
 * on a tie is still a strict improvement over "first candidate to reach the
 * threshold wins"). Two candidates scoring identically against the full
 * query is real ambiguity this app has no further signal to resolve.
 */
test('searchFighter refuses to guess when the full-name query itself returns two equally-scoring candidates', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stats/fightfinder')) {
      const name = decodeURIComponent(u.split('SearchTxt=')[1] ?? '').replace(/\+/g, ' ');
      if (name === 'Real Opponent') return { ok: true, text: async () => makeSearchPage('Real Opponent', '/fighter/Real-Opponent-1') };
      // Two different fighters exactly matching the full query — an
      // artificial but valid stand-in for two Sherdog entries that
      // legitimately tie (e.g. a shared exact name).
      return {
        ok: true,
        text: async () => `<div id="fightfinder_result">
          <tr><td><a onclick="document.location='/fighter/Tied-One-1'"></a><a href="/fighter/Tied-One-1">${name}</a></td></tr>
          <tr><td><a onclick="document.location='/fighter/Tied-Two-2'"></a><a href="/fighter/Tied-Two-2">${name}</a></td></tr>
        </div>`,
      };
    }
    if (u.includes('/fighter/Real-Opponent-1')) {
      return { ok: true, text: async () => makeFighterPage({ name: 'Real Opponent', record: '5-0-0', history: [] }) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const result = await fetchMmaContext({ fighterA: 'Ambiguous Fighter', fighterB: 'Real Opponent' }, ctx);
  assert.equal(result.a, null, 'an exact-score tie on the full-name query must never guess a specific fighter');
  assert.equal(result.b?.name, 'Real Opponent');
});

/**
 * Confirms the surname-widened retry stays gone: a full-name query that
 * comes back empty must resolve to null, not silently try a second, looser
 * search. Locks in the reversion in searchFighter's own comment (that retry
 * produced a confirmed live false positive — "Carlos Diego Ferreira" matched
 * to the unrelated "Alan Carlos Ferreira Rodrigues") so it can't quietly
 * come back.
 */
test('searchFighter never retries with a looser query when the full-name search returns nothing', async () => {
  let fightfinderCalls = 0;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stats/fightfinder')) {
      fightfinderCalls++;
      return { ok: true, text: async () => '<div>no results</div>' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const result = await fetchMmaContext({ fighterA: 'Carlos Diego Ferreira', fighterB: 'Someone Else' }, ctx);
  assert.equal(result, null);
  // Exactly one fightfinder query per side (2 total) — no second, wider
  // attempt for either.
  assert.equal(fightfinderCalls, 2);
});

/* ---------------------------------------------------------------- */
/* ESPN as the primary fighter-data source, Sherdog as fallback       */
/* ---------------------------------------------------------------- */

function makeEspnScoreboard(competitorPairs) {
  return {
    events: [{
      name: 'UFC Fight Night: Test Card',
      date: '2026-08-08T20:00:00Z',
      competitions: competitorPairs.map(([a, b]) => ({
        competitors: [
          { id: a.id, athlete: { displayName: a.name } },
          { id: b.id, athlete: { displayName: b.name } },
        ],
      })),
    }],
  };
}

function makeEspnAthlete({ id, name, wins, losses, draws, history = [] }) {
  return {
    athlete: {
      id,
      displayName: name,
      fullName: name,
      nickname: 'Test Nick',
      links: [{ rel: ['overview', 'desktop', 'athlete'], href: `https://www.espn.com/mma/fighter/_/id/${id}/x` }],
      headshot: { href: `https://a.espncdn.com/i/headshots/mma/players/full/${id}.png` },
      statsSummary: { statistics: [{ name: 'wins-losses-draws', displayValue: `${wins}-${losses}-${draws}` }] },
      displayHeight: `5' 10"`,
      displayWeight: '155 lbs',
      displayReach: `70"`,
      stance: { text: 'Orthodox' },
      weightClass: { text: 'Lightweight' },
      association: { name: 'Test Gym' },
      citizenship: 'United States',
      age: 30,
    },
    eventsMap: Object.fromEntries(history.map((h, i) => [`e${i}`, h])),
  };
}

test('fetchMmaContext resolves a fighter via ESPN when they are on ESPN\'s own UFC/PFL scoreboard, never touching Sherdog', async () => {
  const sherdogQueries = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stats/fightfinder')) {
      sherdogQueries.push(decodeURIComponent(u.split('SearchTxt=')[1] ?? '').replace(/\+/g, ' '));
      return { ok: true, text: async () => '<div>no results</div>' };
    }
    if (u.includes('/ufc/scoreboard')) {
      return {
        ok: true,
        text: async () => JSON.stringify(makeEspnScoreboard([
          [{ id: '111', name: 'Gigi Canuto' }, { id: '222', name: 'Carol Foro' }],
        ])),
      };
    }
    if (u.includes('/pfl/scoreboard')) {
      return { ok: true, text: async () => JSON.stringify({ events: [] }) };
    }
    if (u.includes('/athletes/111')) {
      return {
        ok: true,
        text: async () => JSON.stringify(makeEspnAthlete({
          id: '111', name: 'Gigi Canuto', wins: 7, losses: 1, draws: 0,
          history: [{
            gameResult: 'W', name: 'LFA 224', gameDate: '2026-01-16T05:00:00Z',
            opponent: { displayName: 'Janaina Silva' },
            status: { result: { displayName: 'Submission (Rear Naked Choke)' }, period: 3, displayClock: '2:38' },
          }],
        })),
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const result = await fetchMmaContext({ fighterA: 'Gigi Canuto', fighterB: 'Carol Foro' }, ctx);
  assert.equal(result.a?.name, 'Gigi Canuto');
  assert.deepEqual(result.a?.record, { wins: 7, losses: 1, draws: 0 });
  assert.equal(result.a?.history[0].opponent, 'Janaina Silva');
  assert.equal(result.a?.history[0].category, 'submission');
  assert.equal(result.a?.nickname, 'Test Nick');
  // fighterA is on the mocked ESPN board and resolved directly there — it
  // must never have fallen through to a Sherdog query.
  assert.ok(!sherdogQueries.includes('Gigi Canuto'), 'ESPN resolved this fighter directly; Sherdog should never have been queried for them');
});

/**
 * Regression test for a real incident: the first version of ESPN athlete
 * resolution matched a fighter name against ANY fight anywhere on ESPN's
 * 30-day UFC/PFL schedule, independently per side — so "Ty Miller" (the
 * odds feed's name for one specific fight) matched "Juliana Miller," a
 * completely different fighter on a wholly unrelated card, purely on a
 * shared surname with no check that her actual opponent had anything to do
 * with the real fight. resolveEspnAthleteIds now requires BOTH sides of a
 * fight to plausibly match together, not either side independently.
 */
test('fetchMmaContext never cross-matches a fighter to an unrelated fight sharing only a surname', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ufc/scoreboard')) {
      return {
        ok: true,
        text: async () => JSON.stringify(makeEspnScoreboard([
          // The real fight being looked up.
          [{ id: '301', name: 'Ty Cole Miller' }, { id: '302', name: 'Billy Ray Goff' }],
          // A wholly unrelated fight, elsewhere on the same 30-day board,
          // whose one side happens to share the surname "Miller".
          [{ id: '401', name: 'Juliana Miller' }, { id: '402', name: 'Ravena Oliveira' }],
        ])),
      };
    }
    if (u.includes('/pfl/scoreboard')) return { ok: true, text: async () => JSON.stringify({ events: [] }) };
    if (u.includes('/athletes/301')) {
      return { ok: true, text: async () => JSON.stringify(makeEspnAthlete({ id: '301', name: 'Ty Cole Miller', wins: 7, losses: 0, draws: 0 })) };
    }
    if (u.includes('/athletes/401')) {
      return { ok: true, text: async () => JSON.stringify(makeEspnAthlete({ id: '401', name: 'Juliana Miller', wins: 4, losses: 2, draws: 0 })) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const result = await fetchMmaContext({ fighterA: 'Ty Miller', fighterB: 'Billy Goff' }, ctx);
  assert.equal(result.a?.name, 'Ty Cole Miller', 'must resolve the real opponent-matched Miller, never the unrelated one');
});

test('fetchMmaContext falls back to Sherdog when a fighter is not on ESPN\'s UFC/PFL scoreboard', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ufc/scoreboard') || u.includes('/pfl/scoreboard')) {
      // ESPN's board has no fight involving this fighter at all (e.g. a
      // regional-promotion-only prospect) — schedule resolves empty for them.
      return { ok: true, text: async () => JSON.stringify({ events: [] }) };
    }
    if (u.includes('/stats/fightfinder')) {
      const name = decodeURIComponent(u.split('SearchTxt=')[1] ?? '').replace(/\+/g, ' ');
      if (name === 'Regional Prospect') return { ok: true, text: async () => makeSearchPage('Regional Prospect', '/fighter/Regional-Prospect-1') };
      return { ok: true, text: async () => '<div>no results</div>' };
    }
    if (u.includes('/fighter/Regional-Prospect-1')) {
      return { ok: true, text: async () => makeFighterPage({ name: 'Regional Prospect', record: '3-0-0', history: [] }) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const result = await fetchMmaContext({ fighterA: 'Regional Prospect', fighterB: 'irrelevant' }, ctx);
  assert.equal(result.a?.name, 'Regional Prospect');
});
