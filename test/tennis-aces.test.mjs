import test from 'node:test';
import assert from 'node:assert/strict';
import { tournamentSlugs, surnameToken, playerToken, matchLinks, matchLinkFor, parseMatchAces, acesFor, aceLogEntries } from '../worker/src/tennis-aces.js';
import { gradeAces } from '../worker/src/tennis-picks.js';

// The markup as read from tennis.com on 2026-11-12: a tournament page's match cards and a match page's statistics table.
const card = (href, label) => `<article class="Match-module-scss-module__PXKSHa__card"><a aria-label="Match details: ${label}" class="Match-module-scss-module__PXKSHa__stretchedLink" href="${href}"></a></article>`;
const TOURNAMENT = [
  card('/tournaments/rolex-paris-masters/matches/c-ruud-vs-j-cerundolo-2026-11-02', 'Ruud, Casper vs Cerúndolo, Juan Manuel'),
  card('/tournaments/rolex-paris-masters/matches/t-etcheverry-vs-a-de-minaur-2026-11-04', 'Etcheverry, Tomás Martín vs de Minaur, Alex'),
  card('/tournaments/rolex-paris-masters/matches/c-alcaraz-vs-c-ruud-2026-11-07', 'Alcaraz, Carlos vs Ruud, Casper'),
  card('/tournaments/rolex-paris-masters/matches/c-alcaraz-vs-c-ruud-2026-11-07', 'Alcaraz, Carlos vs Ruud, Casper'),
  card('/tournaments/rolex-paris-masters/matches/n-borges-vs-c-ruud-2026-11-06', 'Borges, Nuno vs Ruud, Casper'),
].join('');
const MATCH = '<table><thead class="StatsTable-module-scss-module__g3KzGW__srOnly"><tr><th scope="col">C. Alcaraz</th><th scope="col">Statistic</th><th scope="col">C. Ruud</th></tr></thead><tbody><tr><td class="StatsTable-module-scss-module__g3KzGW__value">7</td><th scope="row" class="StatsTable-module-scss-module__g3KzGW__label">Aces</th><td class="StatsTable-module-scss-module__g3KzGW__value">8</td></tr><tr><td class="x">1</td><th scope="row" class="y">Double Faults</th><td class="x">0</td></tr></tbody></table>';

test('tournamentSlugs tries the whole name, then without a sponsor word or two, and drops a "presented by" tail', () => {
  assert.deepEqual(tournamentSlugs('Rolex Paris Masters'), ['rolex-paris-masters', 'paris-masters']);
  assert.deepEqual(tournamentSlugs('BNP Paribas Open'), ['bnp-paribas-open', 'paribas-open']);
  assert.deepEqual(tournamentSlugs('Bybit Stockholm Open'), ['bybit-stockholm-open', 'stockholm-open']);
  assert.deepEqual(tournamentSlugs('DIRECTV Open Presentado por Compesar'), ['directv-open']);
  assert.deepEqual(tournamentSlugs('FAGE WTA Finals Indian Wells'), ['fage-wta-finals-indian-wells', 'wta-finals-indian-wells', 'finals-indian-wells']);
  assert.deepEqual(tournamentSlugs(''), []);
});

test('player tokens follow the site: the first initial and the family name, accents dropped', () => {
  assert.equal(playerToken('Carlos Alcaraz'), 'c-alcaraz');
  assert.equal(playerToken('Alex de Minaur'), 'a-de-minaur');
  assert.equal(playerToken('Tomás Macháč'), 't-machac');
  assert.equal(surnameToken('Juan Manuel Cerúndolo'), 'cerundolo');
  assert.equal(surnameToken('Alex de Minaur'), 'minaur');
});

test('matchLinks reads each match link once, and matchLinkFor finds the pair on the day, either way round', () => {
  const links = matchLinks(TOURNAMENT);
  assert.equal(links.length, 4, 'the repeated link counts once');
  assert.deepEqual(links[1], { href: '/tournaments/rolex-paris-masters/matches/t-etcheverry-vs-a-de-minaur-2026-11-04', a: 't-etcheverry', b: 'a-de-minaur', date: '2026-11-04' });
  const day = (d) => Date.parse(`${d}T19:00:00Z`);
  assert.equal(matchLinkFor(links, 'Casper Ruud', 'Carlos Alcaraz', day('2026-11-07')).date, '2026-11-07', 'our order need not be the page\'s');
  assert.equal(matchLinkFor(links, 'Nuno Borges', 'Casper Ruud', day('2026-11-06')).a, 'n-borges');
  assert.equal(matchLinkFor(links, 'Alex de Minaur', 'Tomás Martín Etcheverry', day('2026-11-04')).a, 't-etcheverry', 'a family name of several words');
  assert.equal(matchLinkFor(links, 'Casper Ruud', 'Carlos Alcaraz', day('2026-11-03')), null, 'days apart: a different meeting');
  assert.equal(matchLinkFor(links, 'Casper Ruud', 'Taylor Fritz', day('2026-11-07')), null);
  // A start read just after midnight UTC still finds the page dated the day before.
  assert.equal(matchLinkFor(links, 'Casper Ruud', 'Carlos Alcaraz', Date.parse('2026-11-08T00:30:00Z')).date, '2026-11-07');
});

test('parseMatchAces reads the statistics table, and acesFor gives each player his own count', () => {
  const parsed = parseMatchAces(MATCH);
  assert.deepEqual(parsed, { left: 'C. Alcaraz', right: 'C. Ruud', aces: [7, 8] });
  assert.equal(acesFor(parsed, 'Carlos Alcaraz'), 7);
  assert.equal(acesFor(parsed, 'Casper Ruud'), 8);
  assert.equal(acesFor(parsed, 'Taylor Fritz'), null);
  assert.equal(parseMatchAces('<html><body>Match starts soon</body></html>'), null, 'no table yet');
  assert.equal(parseMatchAces(MATCH.replace('>Aces<', '>Winners<')), null);
});

test('the entries the runner writes grade an aces play whichever side it is on, over or under', () => {
  const log = aceLogEntries('2026-11-07', 'carlos alcaraz', 'casper ruud', 7, 8);
  const play = (side, point) => ({ market: 'aces', side, point, a: 'Carlos Alcaraz', b: 'Casper Ruud', commenceMs: Date.parse('2026-11-07T19:00:00Z'), units: 1, american: null });
  const ruud = gradeAces(play('b', 4.5), log, Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(ruud.result, 'win');
  assert.equal(ruud.actual, '8 aces');
  const alcaraz = gradeAces(play('a', 7.5), log, Date.parse('2026-11-12T00:00:00Z'));
  assert.deepEqual([alcaraz.result, alcaraz.actual], ['loss', '7 aces']);
  // The day either side of the page's date still finds it.
  assert.equal(gradeAces({ ...play('b', 4.5), commenceMs: Date.parse('2026-11-08T00:30:00Z') }, log, Date.parse('2026-11-12T00:00:00Z')).result, 'win');
  assert.equal(gradeAces(play('b', 4.5), {}, Date.parse('2026-11-12T00:00:00Z')), null, 'no entry: it waits');
});
