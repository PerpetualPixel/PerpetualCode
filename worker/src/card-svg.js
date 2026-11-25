/**
 * The Discord card for a live tennis play or lean, as a picture.
 *
 * It is laid out like a bet slip (2026-11-25, the owner, with a book's slip beside it: "let's make the card simpler
 * like this with a more info button. Keep the color codes and tags like leans, won, loss etc and also let's add
 * recommended units to the live and lean takes"). Everything else a reader might want is behind the More info
 * button (worker/src/play-page.js).
 *
 *   top      the logo, what this is (Live Play, Lean, Won, Lost, Void) and the price, with the book under it
 *   panel    who or what to take, in the state's colour, and the market under it in a slip's words;
 *            the two players and the units (recommended while it is open, the result once it settles);
 *            the score when it was taken or the final score, and the time
 *   foot     the site, and the tour, event and round
 *
 * The card is the website's own look (2026-11-25, the owner, of a first version filled with colour: "too vibrant,
 * make them more in line with my website's palette"): the site's near-black ground with its faint violet glow and
 * hairline grid, a glass panel with a violet hairline, the site's text and muted greys. The state is an accent,
 * not a fill: the card's border, the tag, the pick and the result take the state's colour, from the site's
 * palette: laser blue for a live play (the site's "real edge" colour), violet for a lean (the site's lean box),
 * the site's green for a win and red for a loss, its muted grey for a void.
 *
 * This file only writes the SVG (plain text, so it is tested as text). worker/src/card-render.js turns it into a
 * PNG. The font it names is the one that file loads, Roboto Condensed, cut to Latin letters: a name is folded to
 * plain letters first and a minus is a hyphen.
 */

export const CARD_W = 720;
export const CARD_H = 424;
/** Raised whenever the card's look changes, so a picture kept at the edge or in a browser from the old look is not served for the new one. */
export const CARD_VERSION = 3;

/** The website's palette (docs/styles.css :root). */
const SITE = { bg: '#05050A', text: '#F3F1FA', muted: '#9C98B8', violet: '#7C3AED', magenta: '#FF007A', laser: '#00F0FF', success: '#10B981', danger: '#EF4444' };
/** A state's accent: `a` to `b` is the border, `ink` the tag, the pick and the result. */
const STATES = {
  live: { tag: 'Live Play', a: SITE.violet, b: SITE.laser, ink: '#5CE9F7' },
  won: { tag: 'Won', a: SITE.success, b: SITE.success, ink: '#34D399' },
  lost: { tag: 'Lost', a: SITE.danger, b: SITE.danger, ink: '#F87171' },
  void: { tag: 'Void', a: SITE.muted, b: SITE.muted, ink: '#B9B6CF' },
};
/** A lean's card: the same slip, the site's violet while it is open, and Lean in the tag of every state. */
const LEAN = {
  live: { tag: 'Lean', a: SITE.violet, b: SITE.violet, ink: '#A78BFA' },
  won: { tag: 'Lean • Won' },
  lost: { tag: 'Lean • Lost' },
  void: { tag: 'Lean • Void' },
};
const TOUR = { atp: 'ATP', wta: 'WTA' };

/** Text a Latin-only font can draw, safe inside SVG. */
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[−–—]/g, '-').replace(/[^\x20-\x7e•]/g, '').trim();
const esc = (s) => plain(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (american) => (american > 0 ? `+${american}` : String(american));

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

/** The market in a slip's words: MATCH WINNER, SET 2 WINNER, SET 2 TOTAL GAMES. */
export function marketWords(play) {
  if (play.market === 'live_ml') return 'Match Winner';
  if (play.market === 'live_set' && play.set != null) return `Set ${play.set} Winner`;
  if (play.market === 'live_set_total' && play.set != null) return `Set ${play.set} Total Games`;
  return playLines(play).small;
}

/**
 * The card as SVG. `logo` is the logo as a data: address (the worker and the local preview each read the file
 * their own way); without it the tag stands alone. Every line is measured and kept inside its own width: it comes
 * down in size, then to a shorter form, then is cut with "...".
 */
export function cardSvg(play, { logo = null } = {}) {
  const state = cardState(play);
  const lean = Boolean(play.lean);
  const c = { ...STATES[state], ...(lean ? LEAN[state] : {}) };
  const live = state === 'live';
  const W = CARD_W; const H = CARD_H; const M = 36;
  const panelX = 24; const panelY = 122; const panelW = W - 48; const panelH = 238; const pad = 26;
  const left = panelX + pad; const right = panelX + panelW - pad;
  const priced = Number.isFinite(play.american);
  const price = priced ? play.american : play.playable;
  const text = (x, y, size, weight, fill, body, extra = '') => `<text x="${x}" y="${y}" font-family="Roboto Condensed" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${body}</text>`;
  const end = 'text-anchor="end"';
  // A line drawn from its right edge, placed by its own measured width (so the next thing to its left knows where it stops).
  const fromRight = (x, y, size, weight, fill, body, spacing = 0) => ({ svg: text(x, y, size, weight, fill, esc(body), `${end}${spacing ? ` letter-spacing="${spacing}"` : ''}`), width: Math.ceil(textWidth(body, size, { weight, spacing }) * ROOM) });

  // The top: the price at the right with the book (or "or better") under it, and the tag in the room that is left.
  const priceText = Number.isFinite(price) ? fmt(price) : '';
  const priceLine = fromRight(W - M, 76, 46, 700, SITE.text, priceText);
  const under = fitLine(priced ? plain(play.book ?? '').toUpperCase() : priceText ? 'OR BETTER' : '', 230, 18, { min: 14, weight: 500, spacing: 1.4 });
  // The tag is a pill in the state's colour, like the site's own tags: upper case, spaced, on a tint of the colour.
  const tagX = logo ? M + 74 : M;
  const tag = fitLine(c.tag.toUpperCase(), W - M - Math.max(priceLine.width, 120) - 28 - tagX - 36, 24, { min: 16, spacing: 2 });
  const tagW = Math.ceil(textWidth(tag.text, tag.size, { spacing: 2 }) * ROOM) + 34;

  // The pick, in the state's colour: a name shortens the way a scoreboard does, anything else is cut.
  const { big } = playLines(play);
  const sideName = play.side === 'a' ? plain(play.a) : play.side === 'b' ? plain(play.b) : null;
  const nameX = left + 78;
  const nameRoom = right - nameX;
  const title = (t) => t.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  const pick = !big ? { text: 'The pick', size: 44 } : sideName && big === sideName ? bestForm(nameForms(sideName), nameRoom, 46, { min: 28, comfy: 36 }) : fitLine(title(big), nameRoom, 46, { min: 28 });
  const market = fitLine(marketWords(play).toUpperCase(), nameRoom, 23, { min: 16, weight: 500, spacing: 2 });

  // The units: recommended while it is open (and on a lean, which is never on the record), the result once a play settles.
  const stake = `${Math.round((play.units ?? 1) * 100) / 100}u`;
  const profit = Number.isFinite(play.profit) ? `${play.profit < 0 ? '-' : '+'}${Math.abs(play.profit).toFixed(2)}u` : '';
  const settledPlay = !live && !lean;
  const unitsValue = state === 'void' && !lean ? 'Stake back' : settledPlay && profit ? profit : stake;
  const unitsLabel = state === 'void' && !lean ? '' : settledPlay && profit ? 'RESULT' : 'RECOMMENDED';
  const rowY = panelY + 168;
  const value = fromRight(right, rowY, 30, 700, settledPlay ? c.ink : SITE.text, unitsValue);
  const labelLine = unitsLabel ? fromRight(right - value.width - 10, rowY - 2, 18, 500, SITE.muted, unitsLabel, 1.4) : { svg: '', width: 0 };

  // The two players, in the room left of the units: full names, then initials, then last names, then cut.
  const vsRoom = right - left - value.width - labelLine.width - (unitsLabel ? 10 : 0) - 22;
  const nameA = nameForms(plain(play.a) || 'Player A'); const nameB = nameForms(plain(play.b) || 'Player B');
  const pairs = Array.from({ length: Math.max(nameA.length, nameB.length) }, (_, i) => `${nameA[Math.min(i, nameA.length - 1)]} v ${nameB[Math.min(i, nameB.length - 1)]}`);
  const sizedPairs = pairs.map((line) => ({ text: line, size: fitSize(line, vsRoom, 27, { min: 20, weight: 500 }) }));
  let versus = sizedPairs.find((f) => f.size >= 24) ?? sizedPairs.find((f) => fits(f.text, vsRoom, f.size, { weight: 500 }));
  if (!versus) {
    // Two names too long for the line in any form: each is cut to the same length, so both players are still named.
    const a = nameA[nameA.length - 1]; const b = nameB[nameB.length - 1];
    const cut = (name, n) => (name.length > n ? `${name.slice(0, n).trimEnd()}...` : name);
    let n = Math.max(a.length, b.length) - 1;
    while (n > 2 && !fits(`${cut(a, n)} v ${cut(b, n)}`, vsRoom, 20, { weight: 500 })) n--;
    versus = { text: `${cut(a, n)} v ${cut(b, n)}`, size: 20 };
  }

  // The last line: the score when it was taken, or how it ended; the time at the right.
  const [day, clock] = cardTime(play.postedAt).split(/\s+•\s+/);
  const time = fromRight(right, panelY + 208, 21, 400, SITE.muted, clock ?? '');
  const final = plain(play.actual).replace(/:.*$/, '');
  const whyVoid = plain(play.actual).replace(/^[^:]*:\s*/, '');
  const scoreText = live ? (plain(play.score) ? `Taken at ${plain(play.score)}` : 'In play')
    : state === 'void' ? `Void${whyVoid && whyVoid !== final ? `: ${whyVoid}` : ''}` : final ? `Final ${final}` : 'Final';
  const score = fitLine(scoreText, right - left - time.width - 22, 21, { min: 16, weight: 400 });

  // The foot: the site, and the tour, event and round in the room beside it.
  const site = 'perpetualpicks.com';
  const siteW = Math.ceil(textWidth(site, 19, { weight: 500 }) * ROOM);
  const eventText = [TOUR[play.tour] ?? null, play.event, play.round, day].map(plain).filter(Boolean).join('  •  ');
  const event = fitLine(eventText, W - 2 * M - siteW - 24, 19, { min: 14, weight: 400 });
  const badge = TOUR[play.tour] ?? 'TEN';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.a}"/><stop offset="1" stop-color="${c.b}"/></linearGradient>
    <radialGradient id="glow" cx="0.06" cy="-0.1" r="0.9"><stop offset="0" stop-color="${c.ink}" stop-opacity="0.2"/><stop offset="0.6" stop-color="${c.ink}" stop-opacity="0"/></radialGradient>
    <radialGradient id="far" cx="1" cy="1.1" r="0.8"><stop offset="0" stop-color="${SITE.violet}" stop-opacity="0.16"/><stop offset="0.6" stop-color="${SITE.violet}" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M 42 0 L 0 0 0 42" fill="none" stroke="${SITE.violet}" stroke-opacity="0.09" stroke-width="1"/></pattern>
    <clipPath id="card"><rect x="5" y="5" width="${W - 10}" height="${H - 10}" rx="28"/></clipPath>
    <filter id="bright" x="0" y="0" width="100%" height="100%"><feComponentTransfer><feFuncR type="linear" slope="2.4"/><feFuncG type="linear" slope="2.4"/><feFuncB type="linear" slope="2.4"/><feFuncA type="linear" slope="1.8"/></feComponentTransfer></filter>
  </defs>
  <g clip-path="url(#card)">
    <rect x="0" y="0" width="${W}" height="${H}" fill="${SITE.bg}"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#grid)"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#glow)"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#far)"/>
  </g>
  <rect x="5" y="5" width="${W - 10}" height="${H - 10}" rx="28" fill="none" stroke="url(#edge)" stroke-width="3" stroke-opacity="0.85"/>

  ${logo ? `<image x="${M}" y="34" width="58" height="58" xlink:href="${logo}" href="${logo}" filter="url(#bright)"/>` : ''}
  <rect x="${tagX}" y="42" width="${tagW}" height="42" rx="21" fill="${c.ink}" fill-opacity="0.12" stroke="${c.ink}" stroke-opacity="0.6" stroke-width="2"/>
  ${text(tagX + tagW / 2 + 1, 42 + 21 + Math.round(tag.size * 0.35), tag.size, 700, c.ink, esc(tag.text), 'text-anchor="middle" letter-spacing="2"')}
  ${priceText ? priceLine.svg : ''}
  ${under.text ? text(W - M, 101, under.size, 500, SITE.muted, esc(under.text), `${end} letter-spacing="1.4"`) : ''}

  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="20" fill="#FFFFFF" fill-opacity="0.04" stroke="${SITE.violet}" stroke-opacity="0.32" stroke-width="1.5"/>
  <circle cx="${left + 30}" cy="${panelY + 64}" r="30" fill="${c.ink}" fill-opacity="0.1" stroke="${c.ink}" stroke-opacity="0.7" stroke-width="2.5"/>
  ${text(left + 30, panelY + 71, 20, 700, c.ink, esc(badge), 'text-anchor="middle" letter-spacing="0.5"')}
  ${text(nameX, panelY + 62, pick.size, 700, c.ink, esc(pick.text))}
  ${market.text ? text(nameX, panelY + 96, market.size, 500, SITE.muted, esc(market.text), 'letter-spacing="2"') : ''}
  <line x1="${left}" y1="${panelY + 126}" x2="${right}" y2="${panelY + 126}" stroke="${SITE.violet}" stroke-opacity="0.28" stroke-width="1.5"/>
  ${text(left, rowY, versus.size, 500, SITE.text, esc(versus.text))}
  ${labelLine.svg}
  ${value.svg}
  ${text(left, panelY + 208, score.size, 400, SITE.muted, esc(score.text))}
  ${clock ? time.svg : ''}

  ${text(M, H - 26, 19, 500, SITE.text, site, 'fill-opacity="0.85"')}
  ${event.text ? text(W - M, H - 26, event.size, 400, SITE.muted, esc(event.text), end) : ''}
</svg>`;
}
