/**
 * The Discord card for a live tennis play, as a picture (2026-11-25, the
 * owner, with four templates: "I'd like the cards to follow this format
 * ... Make the live play the most outstanding thing on the card. So when
 * a user reads it, they're not looking for what they're betting on").
 *
 * One layout in four states, each with its own colour:
 *
 *   live   blue to violet   [ LIVE PLAY ]        the score when it was taken
 *   won    green            [ WON · GRADED ]     the final score and the units
 *   lost   red              [ LOST · GRADED ]    the final score and the units
 *   void   grey             [ VOID · GRADED ]    why, and the stake returned
 *
 * Top to bottom: the logo and the state; the event and round; the two
 * players; THE PLAY, the largest thing on the card (who or what to take,
 * the bet in the words on a slip, the price, the book and the stake); the
 * chance to land against what the price needs; the score or the result;
 * the site and the time.
 *
 * This file only writes the SVG (plain text, so it is tested as text).
 * worker/src/card-render.js turns it into a PNG. The fonts it names are
 * the ones that file loads: Syne for the wordmark, Roboto Condensed for
 * everything else. Those are cut to Latin letters, so a name is folded to
 * plain letters first and a minus is a hyphen.
 */

export const CARD_W = 720;
export const CARD_H = 980;

const STATES = {
  live: { tag: 'LIVE PLAY', a: '#22B8FF', b: '#7C3AED', ink: '#39BEFF' },
  won: { tag: 'WON • GRADED', a: '#2EE86B', b: '#19B95A', ink: '#3BF27A' },
  lost: { tag: 'LOST • GRADED', a: '#FF4545', b: '#C81E3A', ink: '#FF4D4D' },
  void: { tag: 'VOID • GRADED', a: '#9A9DB2', b: '#5E6178', ink: '#B4B7CB' },
};
const TOUR = { atp: 'ATP', wta: 'WTA' };

/** Text a Latin-only font can draw, safe inside SVG. */
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[−–—]/g, '-').replace(/[^\x20-\x7e•]/g, '').trim();
const esc = (s) => plain(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (american) => (american > 0 ? `+${american}` : String(american));
const implied = (american) => (american > 0 ? 100 / (american + 100) : -american / (-american + 100));
const ordinal = (n) => `${n}${['TH', 'ST', 'ND', 'RD'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'TH'}`;

/**
 * A font size that keeps a line inside a width. Roboto Condensed runs
 * about half its size a letter in capitals (bold a little more), so the
 * size comes down for a long line and never below `min`.
 */
export function fitSize(text, width, size, { min = 20, ratio = 0.5 } = {}) {
  const need = plain(text).length * ratio * size;
  return need <= width ? size : Math.max(min, Math.floor((width / need) * size));
}

/** The state of a play's card. */
export const cardState = (play) => (play.status === 'void' ? 'void' : play.status === 'graded' ? (play.result === 'win' ? 'won' : 'lost') : 'live');

/**
 * The play in two lines: what to take, large, and the bet in a slip's
 * words under it. "M. Dellavedova to win the match" is DELLAVEDOVA over
 * TO WIN THE MATCH; a set's games are OVER 9.5 GAMES over IN SET 2.
 */
export function playLines(play) {
  const sel = plain(play.selection).replace(/\s*\(live\)\s*$/i, '');
  const name = play.side === 'a' ? play.a : play.side === 'b' ? play.b : null;
  if (name && sel.toLowerCase().startsWith(plain(name).toLowerCase())) return { big: plain(name), small: sel.slice(plain(name).length).trim() || 'to win' };
  const games = sel.match(/^set (\d+) (over|under) ([\d.]+) games$/i);
  if (games) return { big: `${games[2]} ${games[3]} games`, small: `in set ${games[1]}` };
  return { big: sel, small: '' };
}

/** When it was posted, in Eastern time: "Nov 25 • 8:52 PM ET". */
export function cardTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(ms);
  const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms);
  return `${d}  •  ${t} ET`;
}

/**
 * The card as SVG. `logo` is the logo as a data: address (the worker and
 * the local preview each read the file their own way); without it the
 * wordmark stands alone.
 */
export function cardSvg(play, { logo = null } = {}) {
  const state = cardState(play);
  const c = STATES[state];
  const W = CARD_W; const H = CARD_H; const M = 44; const inner = W - 2 * M;
  const mid = W / 2;
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const { big, small } = playLines(play);
  const text = (x, y, size, weight, fill, body, extra = '') => `<text x="${x}" y="${y}" font-family="Roboto Condensed" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${body}</text>`;
  const centre = 'text-anchor="middle"';
  const label = (y, body) => text(mid, y, 25, 500, '#8D90A6', `[ ${esc(body).toUpperCase()} ]`, `${centre} letter-spacing="1.2"`);

  // The event line and the players.
  const eventLine = [TOUR[play.tour] ?? null, play.event, play.round].filter(Boolean).map(plain).join('  •  ').toUpperCase();
  const versus = `${plain(play.a).toUpperCase()} vs ${plain(play.b).toUpperCase()}`;
  const vsSize = fitSize(versus, inner, 50, { min: 28, ratio: 0.5 });

  // The play: the largest thing on the card.
  const bigUp = big.toUpperCase();
  const bigSize = fitSize(bigUp, inner - 56, 92, { min: 44, ratio: 0.53 });
  const smallUp = small.toUpperCase();
  const priceText = Number.isFinite(price) ? fmt(price) : '';
  const stake = `${Math.round((play.units ?? 1) * 100) / 100}u`;
  // A play no book priced says "or better": that number is the least to take it at, wherever it is found.
  const where = [priced ? plain(play.book ?? '') : 'or better', `${stake} stake`].filter(Boolean).join('  •  ');
  const priceW = Math.max(150, priceText.length * 31 + 48);
  const whereW = where.length * 15.5;
  const rowW = priceW + 22 + whereW;
  const rowX = mid - rowW / 2;
  const live = state === 'live';
  const heroTop = 352; const heroH = 304;

  // The numbers behind it: the chance to land, what the price needs, the edge between them.
  const needs = Number.isFinite(price) ? implied(price) : null;
  const edge = Number.isFinite(play.prob) && needs != null ? Math.round((play.prob - needs) * 100) : null;
  const stats = [
    Number.isFinite(play.prob) ? [`${Math.round(play.prob * 100)}%`, 'CHANCE TO LAND'] : null,
    needs != null ? [`${Math.round(needs * 100)}%`, 'PRICE NEEDS'] : null,
    edge != null ? [`${edge >= 0 ? '+' : ''}${edge}`, 'EDGE, PTS'] : null,
  ].filter(Boolean);
  const cell = inner / Math.max(1, stats.length);
  const statsTop = 686;

  // The last block: where the match stood when it was taken, or how it ended.
  const sets = plain(play.score).split(/\s+/).filter(Boolean);
  let foot;
  if (live) {
    const chip = sets.length ? `${ordinal(sets.length)} SET  •  ${sets.join('  ')}` : 'IN PLAY';
    const chipW = Math.min(inner, chip.length * 19 + 56);
    foot = `${label(812, 'score when taken')}
    <rect x="${mid - chipW / 2}" y="826" width="${chipW}" height="62" rx="14" fill="#1E1D2B" stroke="#34334A" stroke-width="2"/>
    ${text(mid, 869, 38, 700, '#F3F1FA', esc(chip), `${centre} letter-spacing="0.6"`)}`;
  } else {
    const units = Number.isFinite(play.profit) ? `${play.profit < 0 ? '-' : '+'}${Math.abs(play.profit).toFixed(2)}u` : '';
    const final = plain(play.actual).replace(/:.*$/, '');
    const line = state === 'void' ? `VOID  •  STAKE RETURNED` : [`FINAL ${final}`.trim(), units].filter(Boolean).join('  •  ');
    const why = state === 'void' ? plain(play.actual).replace(/^[^:]*:\s*/, '') : '';
    foot = `${label(812, state === 'void' ? 'no result' : 'result  •  final score')}
    ${text(mid, 872, fitSize(line, inner, 56, { min: 34, ratio: 0.5 }), 700, c.ink, esc(line), centre)}
    ${why && why !== final ? text(mid, 906, 24, 500, '#8D90A6', esc(why).toUpperCase(), centre) : ''}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.a}"/><stop offset="1" stop-color="${c.b}"/></linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#11111D"/><stop offset="1" stop-color="#08080F"/></linearGradient>
    <linearGradient id="word" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FF2BD6"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.a}" stop-opacity="${live ? 0.20 : 0.10}"/><stop offset="1" stop-color="${c.b}" stop-opacity="${live ? 0.07 : 0.03}"/></linearGradient>
    <filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="bright" x="-10%" y="-10%" width="120%" height="120%"><feComponentTransfer><feFuncR type="linear" slope="2.1"/><feFuncG type="linear" slope="2.1"/><feFuncB type="linear" slope="2.1"/><feFuncA type="linear" slope="1.6"/></feComponentTransfer></filter>
    <clipPath id="card"><rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="42"/></clipPath>
  </defs>
  <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="42" fill="none" stroke="url(#edge)" stroke-width="10" opacity="0.55" filter="url(#glow)"/>
  <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="42" fill="url(#ground)"/>
  <g clip-path="url(#card)">
    <rect x="10" y="10" width="${W - 20}" height="154" fill="${c.a}" opacity="0.07"/>
    <line x1="10" y1="164" x2="${W - 10}" y2="164" stroke="url(#edge)" stroke-width="3" opacity="0.75"/>
  </g>
  <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="42" fill="none" stroke="url(#edge)" stroke-width="5"/>

  ${logo ? `<image x="${M - 8}" y="38" width="100" height="100" xlink:href="${logo}" href="${logo}" filter="url(#bright)"/>` : ''}
  <text x="${logo ? M + 98 : M}" y="84" font-family="Syne" font-size="20" font-weight="800" fill="#FFFFFF" letter-spacing="0.5">PERPETUAL</text>
  <text x="${logo ? M + 98 : M}" y="112" font-family="Syne" font-size="20" font-weight="800" fill="url(#word)" letter-spacing="0.5">PICKS</text>
  ${(() => { const tag = `[ ${c.tag} ]`; const tw = tag.length * 13.4 + 30; return `<rect x="${W - M - tw}" y="62" width="${tw}" height="54" rx="12" fill="${c.a}" fill-opacity="0.14" stroke="${c.a}" stroke-opacity="0.8" stroke-width="2.5"/>
  ${text(W - M - tw / 2, 99, 27, 700, c.ink, esc(tag), `${centre} letter-spacing="0.6"`)}`; })()}

  ${text(mid, 226, fitSize(`[ ${eventLine} ]`, inner, 28, { min: 19, ratio: 0.5 }), 500, '#9EA1B6', `[ ${esc(eventLine)} ]`, `${centre} letter-spacing="1"`)}
  ${text(mid, 296, vsSize, 700, '#FFFFFF', esc(versus).replace(' vs ', `<tspan font-weight="400" fill="#B9BBCB"> vs </tspan>`), `${centre} xml:space="preserve"`)}

  <rect x="${M - 8}" y="${heroTop}" width="${inner + 16}" height="${heroH}" rx="26" fill="url(#hero)" stroke="${c.a}" stroke-opacity="${live ? 0.55 : 0.28}" stroke-width="2.5"/>
  ${text(mid, heroTop + 48, 26, 700, c.ink, live ? 'THE PLAY  •  TAKE' : 'THE PLAY', `${centre} letter-spacing="3"`)}
  ${text(mid, heroTop + 108 + Math.round(bigSize * 0.35), bigSize, 700, live ? '#FFFFFF' : '#E8E8F2', esc(bigUp), `${centre} letter-spacing="0.5"`)}
  ${smallUp ? text(mid, heroTop + 190, fitSize(smallUp, inner - 40, 44, { min: 28 }), 700, c.ink, esc(smallUp), `${centre} letter-spacing="1.5"`) : ''}
  ${priceText ? `<rect x="${rowX}" y="${heroTop + 214}" width="${priceW}" height="68" rx="16" fill="${live ? c.a : '#2A2A3A'}" fill-opacity="${live ? 0.95 : 1}"/>
  ${text(rowX + priceW / 2, heroTop + 264, 50, 700, live ? '#06121C' : '#FFFFFF', esc(priceText), centre)}
  ${text(rowX + priceW + 22, heroTop + 259, 31, 500, '#D6D7E4', esc(where), '')}` : ''}

  ${stats.map(([value, name], i) => `${text(M + cell * i + cell / 2, statsTop + 40, 40, 700, '#F3F1FA', esc(value), centre)}
  ${text(M + cell * i + cell / 2, statsTop + 68, 19, 500, '#8D90A6', esc(name), `${centre} letter-spacing="1.4"`)}`).join('\n  ')}
  ${stats.length > 1 ? stats.slice(1).map((_, i) => `<line x1="${M + cell * (i + 1)}" y1="${statsTop + 8}" x2="${M + cell * (i + 1)}" y2="${statsTop + 70}" stroke="#2C2B3F" stroke-width="2"/>`).join('') : ''}

  ${foot}

  <line x1="${M}" y1="${H - 62}" x2="${W - M}" y2="${H - 62}" stroke="url(#edge)" stroke-width="2" opacity="0.45"/>
  ${text(mid, H - 28, 24, 400, '#8D90A6', esc(['perpetualpicks.com', cardTime(play.postedAt)].filter(Boolean).join('  •  ')), centre)}
</svg>`;
}
