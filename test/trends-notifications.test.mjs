/**
 * The two emails that remain under Trends (worker/src/notifications.js's
 * sendTicketNotifications, worker/src/weekly-report.js): the day's
 * Pixel's Picks tickets once each, and the Monday report of the week's
 * tickets, both from the same records the tab reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendTicketNotifications } from '../worker/src/notifications.js';
import { sendWeeklyTrackingReport, weeklyTicketSummary } from '../worker/src/weekly-report.js';
import { runTrendPicksDaily, runTrendPicksGrading } from '../worker/src/trend-picks.js';

const NOW = Date.parse('2026-10-27T15:00:00Z');
const ctx = { waitUntil: (p) => p };
function makeEnv() {
  const store = new Map();
  const sent = [];
  return {
    store, sent,
    env: { POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); } }, EMAIL: { async send(m) { sent.push(m); } } },
  };
}
const period = (rate, games) => ({ rate, hits: Math.round(rate * games), games, avg: 12, median: 12 });
const dec = (a) => (a < 0 ? 1 + 100 / -a : 1 + a / 100);
function row(id, player, american, { team = 'CHA', eventId = `e-${id}`, book = 'draftkings' } = {}) {
  return { id, eventId, sportKey: 'basketball_nba', sportTitle: 'NBA', commenceMs: NOW + 8 * 3.6e6, home: 'Charlotte Hornets', away: 'Orlando Magic', playerName: player, team, opponent: 'ORL', athleteId: '4', headshot: null, statKey: 'points', statLabel: 'Pts', marketLabel: 'Points', point: 9.5, side: 'over', selection: `${player} Over 9.5 Pts`, american, decimal: dec(american), book, quotes: [{ bookKey: book, book, american, decimal: dec(american), link: `https://${book}.example/${id}` }], seasons: [2026], rates: { l20: 1, h2h: 1 }, periods: { l5: period(1, 5), l10: period(1, 10), l20: period(1, 20), h2h: period(1, 3) }, series: [] };
}
const deps = { minutes: async () => Array(20).fill(32), context: async () => null, model: async () => '{"verdict":"post","reason":"ok","note":"Watch the minutes."}' };
const users = async () => [{ email: 'a@example.com', username: 'ana' }, { email: 'b@example.com', username: 'ben' }];

test('the day\'s tickets go to the users who asked, once each, with every leg, the book, the price and the note', async () => {
  const { env, sent, store } = makeEnv();
  await runTrendPicksDaily(env, ctx, NOW, { deps: { ...deps, rowsFor: async () => [row('a', 'Collin Sexton', -250), row('b', 'LaMelo Ball', -250, { eventId: 'e-2' }), row('c', 'Brandon Miller', -150, { eventId: 'e-3', book: 'fanduel' })] }, enabled: ['basketball_nba'] });
  assert.equal(await sendTicketNotifications(env, NOW, { deps: { users } }), 2, 'two tickets, both new');
  assert.equal(sent.length, 2, 'one email per user');
  assert.equal(sent[0].subject, "Pixel's Picks for Tue, Oct 27: 2 tickets");
  assert.match(sent[0].html, /2-leg parlay at DraftKings <span[^>]*>-104<\/span>/);
  assert.match(sent[0].html, /Collin Sexton Over 9\.5 Pts/);
  assert.match(sent[0].html, /Straight at FanDuel <span[^>]*>-150<\/span>/);
  assert.match(sent[0].html, /Watch the minutes\./);
  assert.match(sent[0].text, /Brandon Miller Over 9\.5 Pts -150, Orlando Magic @ Charlotte Hornets/);
  assert.deepEqual(JSON.parse(store.get('trendpicks:2026-10-27:notified')), ['2026-10-27:1', '2026-10-27:2']);
  assert.equal(await sendTicketNotifications(env, NOW + 60e3, { deps: { users } }), 0, 'never twice');
  assert.equal(sent.length, 2);
  const empty = makeEnv();
  assert.equal(await sendTicketNotifications(empty.env, NOW, { deps: { users } }), 0, 'no tickets, no email');
});

test('the weekly report tallies the week\'s settled tickets overall and per league, lists each, and says so when none settled', async () => {
  const { env, sent } = makeEnv();
  await runTrendPicksDaily(env, ctx, NOW, { deps: { ...deps, rowsFor: async () => [row('a', 'Collin Sexton', -250), row('b', 'LaMelo Ball', -250, { eventId: 'e-2' })] }, enabled: ['basketball_nba'] });
  const later = NOW + 20 * 3.6e6;
  await runTrendPicksGrading(env, ctx, later, { deps: { actual: async () => 12 } });
  const { sections, lines, settled } = await weeklyTicketSummary(env, later);
  assert.equal(settled, 1);
  assert.deepEqual(sections, [['All tickets', { wins: 1, losses: 0, pushes: 0, voids: 0, units: 0.96, risked: 1, roi: 0.96 }], ['NBA', { wins: 1, losses: 0, pushes: 0, voids: 0, units: 0.96, risked: 1, roi: 0.96 }]]);
  assert.equal(lines[0].legs, 'Collin Sexton Over 9.5 Pts + LaMelo Ball Over 9.5 Pts');
  assert.equal(await sendWeeklyTrackingReport(env, later, { deps: { users } }), 2);
  assert.match(sent[0].html, /All tickets/);
  assert.match(sent[0].html, /1-0/);
  assert.match(sent[0].html, /\+0\.96 u &middot; ROI \+96\.0%/);
  assert.match(sent[0].text, /Won \+0\.96u/);
  const empty = makeEnv();
  await sendWeeklyTrackingReport(empty.env, later, { deps: { users } });
  assert.match(empty.sent[0].text, /No ticket settled this week/);
});
