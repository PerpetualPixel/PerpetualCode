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
/**
 * A lean's card (2026-11-25, the leans channel): the same layout, said as a lean everywhere a play says play. An
 * open lean is the violet of the site's lean box; a settled one keeps the result's colour with LEAN in its tag.
 */
const LEAN = {
  live: { tag: 'LEAN', a: '#A78BFA', b: '#6D28D9', ink: '#B9A2FF' },
  won: { tag: 'LEAN • WON' },
  lost: { tag: 'LEAN • LOST' },
  void: { tag: 'LEAN • VOID' },
};
const TOUR = { atp: 'ATP', wta: 'WTA' };

/** Text a Latin-only font can draw, safe inside SVG. */
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[−–—]/g, '-').replace(/[^\x20-\x7e•]/g, '').trim();
const esc = (s) => plain(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (american) => (american > 0 ? `+${american}` : String(american));
const implied = (american) => (american > 0 ? 100 / (american + 100) : -american / (-american + 100));
const ordinal = (n) => `${n}${['TH', 'ST', 'ND', 'RD'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'TH'}`;

/**
 * How wide each letter is (2026-11-25, the owner: "ensure the words, text, and buttons won't overlap regardless of
 * the size of names, events, etc."). A line is measured before it is drawn, with the fonts' own numbers: the advance
 * of every character the card can draw (space to ~, then the bullet), in thousandths of the font size, for Roboto
 * Condensed 400, 500 and 700 as vendored in worker/vendor/fonts. test/discord-cards.test.mjs reads the font files
 * and checks this table against them.
 */
export const ADVANCES = {
  400: [229,246,320,548,494,633,544,175,314,319,431,497,197,248,264,371,494,494,494,494,494,494,494,494,494,494,233,203,446,479,460,422,769,577,546,567,571,497,481,591,620,250,483,545,476,755,620,601,554,601,531,519,521,562,561,762,551,525,523,250,370,250,371,405,309,479,493,462,496,469,316,493,483,229,224,451,229,753,484,502,493,500,305,456,296,483,428,650,439,417,439,307,244,307,589,337],
  500: [230,254,320,537,500,636,563,168,319,321,443,485,223,309,278,350,500,500,500,500,500,500,500,500,500,500,255,230,446,492,457,436,768,588,554,569,568,494,479,588,617,261,487,550,477,757,616,603,562,603,543,530,533,567,570,755,556,535,527,257,376,257,382,402,321,475,494,461,496,474,322,499,488,242,236,465,242,747,489,500,494,499,319,455,302,488,439,641,446,432,446,302,249,302,572,350],
  700: [230,261,321,528,505,638,579,162,323,324,454,476,245,361,291,332,505,505,505,505,505,505,505,505,505,505,273,253,447,503,454,447,766,597,561,570,565,491,476,585,614,270,490,553,479,758,612,604,568,604,553,540,542,571,578,750,560,542,530,264,381,264,391,400,331,471,495,460,496,479,328,503,492,252,245,478,252,742,492,498,495,497,331,454,307,492,449,633,452,445,452,298,253,298,558,360],
};
/** A little room on top of the measure: the renderer's own rounding. */
const ROOM = 1.03;

/** The width of a line in the card's units, at a size and weight, with its letter spacing. Runs of spaces count once, as they are drawn. */
export function textWidth(text, size, { weight = 700, spacing = 0 } = {}) {
  const table = ADVANCES[weight] ?? ADVANCES[700];
  const line = plain(text).replace(/ {2,}/g, ' ');
  let units = 0;
  for (const ch of line) units += table[ch === '•' ? 95 : ch.charCodeAt(0) - 32] ?? 600;
  return (units / 1000) * size + spacing * line.length;
}
const fits = (text, width, size, opts) => textWidth(text, size, opts) * ROOM <= width;

/** The largest size, from `size` down to `min`, at which a line stays inside a width. `min` when none does: fitLine shortens the line then. */
export function fitSize(text, width, size, { min = 20, weight = 700, spacing = 0 } = {}) {
  for (let s = size; s > min; s--) if (fits(text, width, s, { weight, spacing })) return s;
  return min;
}

/**
 * A line that stays inside a width whatever it says: it comes down in size first, and at `min` it is cut short with
 * "..." until it fits. `tail` is an ending that is never cut (the units after a final score). Returns {text, size}.
 */
export function fitLine(text, width, size, { min = 20, weight = 700, spacing = 0, tail = '' } = {}) {
  let body = plain(text);
  const opts = { weight, spacing };
  const s = fitSize(body + tail, width, size, { min, ...opts });
  if (fits(body + tail, width, s, opts)) return { text: body + tail, size: s };
  while (body.length > 1 && !fits(`${body.trimEnd()}...${tail}`, width, min, opts)) body = body.slice(0, -1);
  return { text: `${body.trimEnd()}...${tail}`, size: min };
}

/** A name from longest to shortest: as given, the first name as an initial, the initial and the last name, the last name alone. A pair (A / B) shortens both. */
export function nameForms(name) {
  const full = plain(name);
  // A doubles pair stays a pair: both names shorten together.
  const team = full.split(/\s*[/&]\s*/).filter(Boolean);
  if (team.length > 1) {
    const each = team.map((n) => nameForms(n));
    return [...new Set([full, each.map((f) => f[Math.min(1, f.length - 1)]).join(' / '), each.map((f) => f[f.length - 1]).join(' / ')])];
  }
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [full];
  const initial = /^[A-Za-z]\.?$/.test(parts[0]) ? parts[0].replace(/\.?$/, '.') : `${parts[0][0]}.`;
  // The last name keeps its particle: "de Minaur", "van de Zandschulp".
  let from = parts.length - 1;
  while (from > 1 && /^[a-z]/.test(parts[from - 1])) from--;
  const last = parts.slice(from).join(' ');
  return [...new Set([full, `${initial} ${parts.slice(1).join(' ')}`, `${initial} ${last}`, last])];
}

/**
 * The form of a line that reads best in a width. `forms` run from longest to shortest: the first that fits at
 * `comfy` or larger is taken; if none is that roomy, the longest that fits at all; if none fits, the shortest, cut.
 */
function bestForm(forms, width, size, { min, comfy, weight = 700, spacing = 0 }) {
  const opts = { weight, spacing };
  const sized = forms.map((text) => ({ text, size: fitSize(text, width, size, { min, ...opts }) }));
  return sized.find((f) => f.size >= comfy) ?? sized.find((f) => fits(f.text, width, f.size, opts)) ?? fitLine(forms[forms.length - 1], width, min, { min, ...opts });
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
  const lean = Boolean(play.lean);
  const c = { ...STATES[state], ...(lean ? LEAN[state] : {}) };
  const W = CARD_W; const H = CARD_H; const M = 44; const inner = W - 2 * M;
  const mid = W / 2;
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const { big, small } = playLines(play);
  const text = (x, y, size, weight, fill, body, extra = '') => `<text x="${x}" y="${y}" font-family="Roboto Condensed" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${body}</text>`;
  const centre = 'text-anchor="middle"';
  const label = (y, body) => text(mid, y, 25, 500, '#8D90A6', `[ ${esc(body).toUpperCase()} ]`, `${centre} letter-spacing="1.2"`);
  // Every line below is measured and kept inside its own width: it comes down in size, then to a shorter form, then is cut with "...".

  // The event line: the tournament's name gives way first, so the tour and the round stay whole.
  const eventOf = (name) => `[ ${[TOUR[play.tour] ?? null, name, play.round].filter(Boolean).map(plain).filter(Boolean).join('  •  ').toUpperCase()} ]`;
  const eventOpts = { weight: 500, spacing: 1 };
  const eventName = plain(play.event);
  let event = { text: eventOf(eventName), size: 0 };
  event.size = fitSize(event.text, inner, 28, { min: 19, ...eventOpts });
  if (!fits(event.text, inner, event.size, eventOpts)) {
    let n = eventName.length - 1;
    while (n > 3 && !fits(eventOf(`${eventName.slice(0, n).trimEnd()}...`), inner, 19, eventOpts)) n--;
    const shorter = eventOf(`${eventName.slice(0, n).trimEnd()}...`);
    event = fits(shorter, inner, 19, eventOpts) ? { text: shorter, size: 19 } : fitLine(event.text.replace(/ \]$/, ''), inner, 19, { min: 19, ...eventOpts, tail: ' ]' });
  }

  // The players: full names when there is room, then initials, then last names.
  const nameA = nameForms(plain(play.a) || 'Player A').map((n) => n.toUpperCase());
  const nameB = nameForms(plain(play.b) || 'Player B').map((n) => n.toUpperCase());
  const pairs = Array.from({ length: Math.max(nameA.length, nameB.length) }, (_, i) => [nameA[Math.min(i, nameA.length - 1)], nameB[Math.min(i, nameB.length - 1)]]);
  const sizedPairs = pairs.map(([a, b]) => ({ a, b, size: fitSize(`${a} vs ${b}`, inner, 50, { min: 28 }) }));
  let vs = sizedPairs.find((f) => f.size >= 36) ?? sizedPairs.find((f) => fits(`${f.a} vs ${f.b}`, inner, f.size));
  if (!vs) {
    // Two names too long for the line in any form: each is cut to the same length.
    const [a, b] = pairs[pairs.length - 1];
    const cut = (name, n) => (name.length > n ? `${name.slice(0, n).trimEnd()}...` : name);
    let n = Math.max(a.length, b.length) - 1;
    while (n > 3 && !fits(`${cut(a, n)} vs ${cut(b, n)}`, inner, 28)) n--;
    vs = { a: cut(a, n), b: cut(b, n), size: 28 };
  }
  const versus = `${vs.a} vs ${vs.b}`;
  const vsSize = vs.size;

  // The play: the largest thing on the card.
  const sideName = play.side === 'a' ? plain(play.a) : play.side === 'b' ? plain(play.b) : null;
  const bigOpts = { min: 44, comfy: 60, spacing: 0.5 };
  const bigLine = sideName && big === sideName ? bestForm(nameForms(sideName).map((n) => n.toUpperCase()), inner - 56, 92, bigOpts) : fitLine(big.toUpperCase(), inner - 56, 92, bigOpts);
  const bigUp = bigLine.text;
  const bigSize = bigLine.size;
  const smallLine = fitLine(small.toUpperCase(), inner - 40, 44, { min: 26, spacing: 1.5 });
  const smallUp = small ? smallLine.text : '';
  const priceText = Number.isFinite(price) ? fmt(price) : '';
  const stake = `${Math.round((play.units ?? 1) * 100) / 100}u`;
  // A play no book priced says "or better": that number is the least to take it at, wherever it is found.
  // The price and where to take it sit side by side inside the panel: a long book name comes down in size, then is cut.
  const priceW = Math.max(150, Math.ceil(textWidth(priceText, 50) * ROOM) + 52);
  const whereRoom = inner - 32 - priceW - 22;
  // A lean has no stake: it is not a tracked play, and the card says so where a play shows its units.
  const whereOf = (book) => [book, lean ? 'not tracked' : `${stake} stake`].filter(Boolean).join('  •  ');
  const bookName = priced ? plain(play.book ?? '') : 'or better';
  let whereLine = { text: whereOf(bookName), size: 0 };
  whereLine.size = fitSize(whereLine.text, whereRoom, 31, { min: 23, weight: 500 });
  if (!fits(whereLine.text, whereRoom, whereLine.size, { weight: 500 })) {
    let n = bookName.length - 1;
    while (n > 2 && !fits(whereOf(`${bookName.slice(0, n).trimEnd()}...`), whereRoom, 23, { weight: 500 })) n--;
    const shorter = whereOf(`${bookName.slice(0, n).trimEnd()}...`);
    whereLine = fits(shorter, whereRoom, 23, { weight: 500 }) ? { text: shorter, size: 23 } : fitLine(whereOf(''), whereRoom, 23, { min: 18, weight: 500 });
  }
  const where = whereLine.text;
  const whereW = textWidth(where, whereLine.size, { weight: 500 });
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
    // The chip is as wide as its words; a long score comes down in size inside it.
    // A score whose last set is over ("6-0") was taken between sets: it is said as "after 1 set", not as a set in play.
    const [g1, g2] = (sets[sets.length - 1] ?? '').split('-').map(Number);
    const between = Number.isFinite(g1) && Number.isFinite(g2) && Math.max(g1, g2) >= 6 && (Math.abs(g1 - g2) >= 2 || Math.max(g1, g2) === 7);
    const lead = between ? `AFTER ${sets.length} SET${sets.length === 1 ? '' : 'S'}` : `${ordinal(sets.length)} SET`;
    const chip = fitLine(sets.length ? `${lead}  •  ${sets.join('  ')}` : 'IN PLAY', inner - 56, 38, { min: 20, spacing: 0.6 });
    const chipW = Math.min(inner, Math.ceil(textWidth(chip.text, chip.size, { spacing: 0.6 }) * ROOM) + 56);
    foot = `${label(812, 'score when taken')}
    <rect x="${mid - chipW / 2}" y="826" width="${chipW}" height="62" rx="14" fill="#1E1D2B" stroke="#34334A" stroke-width="2"/>
    ${text(mid, 857 + Math.round(chip.size * 0.32), chip.size, 700, '#F3F1FA', esc(chip.text), `${centre} letter-spacing="0.6"`)}`;
  } else {
    const units = !lean && Number.isFinite(play.profit) ? `${play.profit < 0 ? '-' : '+'}${Math.abs(play.profit).toFixed(2)}u` : '';
    const final = plain(play.actual).replace(/:.*$/, '');
    // The units are never cut: a long final score comes down in size, and past that the score gives way.
    const line = state === 'void' ? fitLine(lean ? 'VOID  •  NO RESULT' : 'VOID  •  STAKE RETURNED', inner, 56, { min: 30 }) : fitLine(`FINAL ${final}`.trim(), inner, 56, { min: 30, tail: units ? `  •  ${units}` : '' });
    const why = state === 'void' ? plain(play.actual).replace(/^[^:]*:\s*/, '') : '';
    const whyLine = fitLine(why.toUpperCase(), inner, 24, { min: 18, weight: 500 });
    foot = `${label(812, state === 'void' ? 'no result' : 'result  •  final score')}
    ${text(mid, 872, line.size, 700, c.ink, esc(line.text), centre)}
    ${why && why !== final ? text(mid, 906, whyLine.size, 500, '#8D90A6', esc(whyLine.text), centre) : ''}`;
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
  ${(() => { const tag = `[ ${c.tag} ]`; const tw = Math.ceil(textWidth(tag, 27, { spacing: 0.6 }) * ROOM) + 36; return `<rect x="${W - M - tw}" y="62" width="${tw}" height="54" rx="12" fill="${c.a}" fill-opacity="0.14" stroke="${c.a}" stroke-opacity="0.8" stroke-width="2.5"/>
  ${text(W - M - tw / 2, 99, 27, 700, c.ink, esc(tag), `${centre} letter-spacing="0.6"`)}`; })()}

  ${text(mid, 226, event.size, 500, '#9EA1B6', esc(event.text), `${centre} letter-spacing="1"`)}
  ${text(mid, 296, vsSize, 700, '#FFFFFF', esc(versus).replace(' vs ', `<tspan font-weight="400" fill="#B9BBCB"> vs </tspan>`), `${centre} xml:space="preserve"`)}

  <rect x="${M - 8}" y="${heroTop}" width="${inner + 16}" height="${heroH}" rx="26" fill="url(#hero)" stroke="${c.a}" stroke-opacity="${live ? 0.55 : 0.28}" stroke-width="2.5"/>
  ${text(mid, heroTop + 48, 26, 700, c.ink, lean ? (live ? 'THE LEAN  •  NOT TRACKED' : 'THE LEAN') : live ? 'THE PLAY  •  TAKE' : 'THE PLAY', `${centre} letter-spacing="3"`)}
  ${text(mid, heroTop + 108 + Math.round(bigSize * 0.35), bigSize, 700, live ? '#FFFFFF' : '#E8E8F2', esc(bigUp), `${centre} letter-spacing="0.5"`)}
  ${smallUp ? text(mid, heroTop + 190, smallLine.size, 700, c.ink, esc(smallUp), `${centre} letter-spacing="1.5"`) : ''}
  ${priceText ? `<rect x="${rowX}" y="${heroTop + 214}" width="${priceW}" height="68" rx="16" fill="${live ? c.a : '#2A2A3A'}" fill-opacity="${live ? 0.95 : 1}"/>
  ${text(rowX + priceW / 2, heroTop + 264, 50, 700, live ? '#06121C' : '#FFFFFF', esc(priceText), centre)}
  ${text(rowX + priceW + 22, heroTop + 259, whereLine.size, 500, '#D6D7E4', esc(where), '')}` : ''}

  ${stats.map(([value, name], i) => `${text(M + cell * i + cell / 2, statsTop + 40, 40, 700, '#F3F1FA', esc(value), centre)}
  ${text(M + cell * i + cell / 2, statsTop + 68, 19, 500, '#8D90A6', esc(name), `${centre} letter-spacing="1.4"`)}`).join('\n  ')}
  ${stats.length > 1 ? stats.slice(1).map((_, i) => `<line x1="${M + cell * (i + 1)}" y1="${statsTop + 8}" x2="${M + cell * (i + 1)}" y2="${statsTop + 70}" stroke="#2C2B3F" stroke-width="2"/>`).join('') : ''}

  ${foot}

  <line x1="${M}" y1="${H - 62}" x2="${W - M}" y2="${H - 62}" stroke="url(#edge)" stroke-width="2" opacity="0.45"/>
  ${text(mid, H - 28, 24, 400, '#8D90A6', esc(['perpetualpicks.com', cardTime(play.postedAt)].filter(Boolean).join('  •  ')), centre)}
</svg>`;
}
