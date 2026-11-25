/**
 * The page behind a card's "Stats & why" button (GET /play/<id>;
 * 2026-11-25, the owner: "allowing the user to click a button and find
 * more stats and data backing the pick"). One play, in full: the card,
 * the reason in a sentence, every line of the read it was made on, the
 * numbers (the chance to land, what the price needs, the edge, the serve
 * games held, the run of recent games), each book's price with its link
 * while the play is open, how it ended once it has, and the site's record
 * for that kind of play.
 *
 * A page of its own, with its styles inside it and no script: it opens
 * from Discord on any phone, and it is still there after the match has
 * left the Live tab.
 */
import { CONFIG } from '../../docs/config.js';
import { whyLine, booksOf } from './discord.js';
import { cardState, playLines, cardTime } from './card-svg.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (american) => (american > 0 ? `+${american}` : String(american).replace('-', '−'));
const implied = (american) => (american > 0 ? 100 / (american + 100) : -american / (-american + 100));
const pct = (x) => `${Math.round(x * 100)}%`;
const signedUnits = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}u`;
const lastName = (name) => String(name ?? '').trim().split(/\s+/).at(-1) ?? '';
const SITE = 'https://perpetualpicks.com/app.html';
const TONE = { live: '#22B8FF', won: '#2EE86B', lost: '#FF4545', void: '#9A9DB2' };
const KIND = { live_ml: 'Match Winner', live_set: 'Set Winner', live_set_total: 'Set Games' };

const shell = (title, body, tone = '#7C3AED') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#05050A">
<title>${esc(title)}</title>
<style>
  :root { --tone: ${tone}; }
  * { box-sizing: border-box; }
  /* A long name, event or reason wraps inside its own box: nothing runs under what is beside it. */
  h1, p, li, dt, dd, span, strong { overflow-wrap: anywhere; }
  dl > div { min-width: 0; }
  body { margin: 0; background-color: #05050A; background-image: linear-gradient(rgba(124,58,237,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(124,58,237,0.08) 1px, transparent 1px); background-size: 40px 40px; color: #F3F1FA; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 20px 16px 48px; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  header img { width: 40px; height: 40px; }
  header b { font-weight: 800; letter-spacing: 0.14em; font-size: 0.95rem; }
  header b span { background: linear-gradient(90deg, #FF2BD6, #8B5CF6); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .card { display: block; width: 100%; max-width: 420px; height: auto; margin: 0 auto 20px; }
  h1 { font-size: 1.35rem; line-height: 1.25; margin: 0 0 4px; }
  h1 small { display: block; color: var(--tone); font-size: 0.78rem; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 4px; }
  .sub { color: #9C98B8; margin: 0 0 16px; font-size: 0.92rem; }
  section { border: 1px solid rgba(124,58,237,0.28); background: rgba(255,255,255,0.03); border-radius: 16px; padding: 14px 16px; margin-top: 12px; }
  h2 { margin: 0 0 8px; font-size: 0.74rem; letter-spacing: 0.12em; text-transform: uppercase; color: #9C98B8; }
  .result { border-color: var(--tone); }
  .result strong { color: var(--tone); font-size: 1.2rem; }
  dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
  dt { color: #9C98B8; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
  dd { margin: 2px 0 0; font-weight: 800; font-size: 1.15rem; font-variant-numeric: tabular-nums; }
  dd small { display: block; font-weight: 500; font-size: 0.78rem; color: #9C98B8; }
  ul { margin: 0; padding-left: 18px; } li { margin: 4px 0; color: #D9D6EA; font-size: 0.92rem; }
  .books { display: grid; gap: 8px; }
  .book { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.06); color: #F3F1FA; text-decoration: none; font-weight: 700; min-height: 48px; }
  a.book { border: 1px solid var(--tone); }
  .book span:first-child { min-width: 0; }
  .book span:last-child { font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
  .book small { color: #9C98B8; font-weight: 500; }
  .note { color: #9C98B8; font-size: 0.82rem; margin: 10px 0 0; }
  .more { display: block; text-align: center; margin-top: 18px; padding: 14px; border-radius: 12px; background: #7C3AED; color: #fff; font-weight: 800; text-decoration: none; }
  footer { margin-top: 18px; color: #6f6b8a; font-size: 0.78rem; text-align: center; }
</style></head><body><main>
<header><img src="https://perpetualpicks.com/assets/logo-icon-180.png" alt="" width="40" height="40"><b>PERPETUAL <span>PICKS</span></b></header>
${body}
</main></body></html>`;

/** The page for a play that is not on file (an old link, a wrong one). */
export const missingPlayPage = () => shell('Play not found · Perpetual Picks', `<h1>That play is no longer on file.</h1><p class="sub">Live plays are kept for about two months. Every result is on the site.</p><a class="more" href="${SITE}">Open Perpetual Picks</a>`);

/** The page for a play. `record` is the site's record for this kind of play ({wins, losses, units}) or null. */
export function playPage(play, { record = null } = {}) {
  const state = cardState(play);
  const { big, small } = playLines(play);
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const needs = Number.isFinite(price) ? implied(price) : null;
  const edge = Number.isFinite(play.prob) && needs != null ? Math.round((play.prob - needs) * 100) : null;
  const st = play.stats ?? {};
  const h = st.holds;
  const cells = [
    Number.isFinite(play.prob) ? ['Chance to land', pct(play.prob), 'our read'] : null,
    needs != null ? ['Price needs', pct(needs), `to break even at ${fmt(price)}`] : null,
    edge != null ? ['Edge', `${edge >= 0 ? '+' : '−'}${Math.abs(edge)} pts`, 'read less price'] : null,
    ['Stake', `${Math.round((play.units ?? 1) * 100) / 100}u`, 'sized by confidence'],
    play.score ? ['Score when taken', play.score, ''] : null,
    h ? [`${lastName(play.a)} serve`, `${h.a.held}/${h.a.served}`, 'games held today'] : null,
    h ? [`${lastName(play.b)} serve`, `${h.b.held}/${h.b.served}`, 'games held today'] : null,
    st.last ? [`Last ${st.last.of} games`, `${st.last.a}–${st.last.b}`, `${lastName(play.a)} – ${lastName(play.b)}`] : null,
    Number.isFinite(st.setGames) ? ['Set headed for', `${st.setGames}`, 'games, at today\'s holds'] : null,
  ].filter(Boolean);
  const books = state === 'live' ? booksOf(play) : [];
  const why = whyLine(play).replace(/\\([\\*_~`|>[\]()])/g, '$1');
  const reasons = (play.why ?? []).map((w) => String(w)).filter(Boolean).slice(0, 8);
  const result = state === 'live' ? '' : `<section class="result"><h2>Result</h2><strong>${state === 'void' ? 'Void · stake returned' : `${state === 'won' ? 'Won' : 'Lost'}${Number.isFinite(play.profit) ? ` · ${signedUnits(play.profit)}` : ''}`}</strong>${play.actual ? `<p class="note">Final ${esc(play.actual)}</p>` : ''}</section>`;
  const body = `
<img class="card" src="${CONFIG.WORKER_URL}/card/${encodeURIComponent(play.id)}.png?s=${state}" alt="${esc(`${big} ${small}`)}" width="1080" height="1470">
<h1><small>${state === 'live' ? 'Live play · take' : 'Tracked live play'}</small>${esc(String(play.selection ?? '').replace(/\s*\(live\)\s*$/i, ''))}</h1>
<p class="sub">${esc(play.a)} vs ${esc(play.b)}${play.event ? ` · ${esc(play.event)}` : ''}${play.round ? ` · ${esc(play.round)}` : ''}${Number.isFinite(play.postedAt) ? ` · posted ${esc(cardTime(play.postedAt).replace(/\s+•\s+/, ', '))}` : ''}</p>
${result}
<section><h2>The price</h2><div class="books">
${Number.isFinite(price) ? `<div class="book"><span>${priced ? esc(play.book ?? 'The book') : 'Take it at'} <small>${priced && Number.isFinite(play.playable) && play.playable < play.american ? `good down to ${fmt(play.playable)}` : priced ? 'when posted' : 'or better, at any book'}</small></span><span>${fmt(price)}</span></div>` : ''}
${books.filter((b) => b.url).map((b) => `<a class="book" href="${esc(b.url)}" rel="noopener noreferrer"><span>Add to slip · ${esc(b.name)}</span><span>${fmt(b.american)} ↗</span></a>`).join('\n')}
${books.filter((b) => !b.url).map((b) => `<div class="book"><span>${esc(b.name)} <small>no slip link</small></span><span>${fmt(b.american)}</span></div>`).join('\n')}
</div>${state === 'live' ? '<p class="note">A live price moves. If the book has gone past the "good down to" number, the play is gone.</p>' : ''}</section>
<section><h2>The numbers</h2><dl>${cells.map(([name, value, note]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`).join('')}</dl></section>
<section><h2>Why</h2>${why ? `<p style="margin:0 0 8px">${esc(why)}</p>` : ''}${reasons.length ? `<ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</section>
${record && record.wins + record.losses > 0 ? `<section><h2>Our ${esc(KIND[play.market] ?? 'live')} record</h2><dl><div><dt>Record</dt><dd>${record.wins}-${record.losses}</dd></div><div><dt>Net units</dt><dd>${esc(signedUnits(record.units))}</dd></div>${record.roi != null ? `<div><dt>ROI</dt><dd>${record.roi < 0 ? '−' : '+'}${Math.abs(record.roi * 100).toFixed(1)}%</dd></div>` : ''}</dl></section>` : ''}
<a class="more" href="${SITE}">Open Perpetual Picks</a>
<footer>Tracked play, graded automatically. Bet only what you can afford to lose.</footer>`;
  return shell(`${big} ${small} · Perpetual Picks`.replace(/\s+/g, ' '), body, TONE[state]);
}
