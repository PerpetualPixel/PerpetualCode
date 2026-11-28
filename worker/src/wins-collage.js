/**
 * The winners' collage: every winning play of a day, across tennis, the NBA and the NFL, as one picture for the
 * community's wins channel (worker/src/discord-results-digest.js posts it with the morning's roll-ups).
 *
 * 2026-11-28, the owner: "for the wins and slips channel, have the bot gather all winning slip and post a collage
 * of them in one posting".
 *
 *   head    the logo, WINNERS, the day; at the right the count of wins, the day's net in units when the day is
 *           up (never when it is not), and a chip a sport with its share
 *   cards   each winning play's own card (worker/src/card-svg.js: the tennis card, the slip card for the NBA and
 *           the NFL), two across, the biggest wins first, up to WINS_MAX of them; the rest are counted in the foot
 *   foot    the site, how many more there were, and when it was drawn
 *
 * The cards are the ones the channels already show, drawn once more here as they stand settled: each card's SVG
 * is set inside the collage as a group, with its ids made its own so two cards' gradients never cross. The look
 * is the results card's (worker/src/results-card.js): the near-black ground and the site's palette.
 *
 * Two parts, both plain text: the model (winsCollageModel — which wins, in what order, what the head says, tested
 * as data) and the picture (winsCollageSvg — the SVG, which worker/src/card-render.js turns into a PNG).
 */
import { CARD_W, CARD_H, cardSvg, slipCardSvg, slipCardHeight, textWidth } from './card-svg.js';

export const WINS_COLLAGE_VERSION = 1;
/** How many cards the picture carries at most; more wins are counted, not drawn. */
export const WINS_MAX = 12;
export const COLS = 2;
const GAP = 24; const PAD = 32; const HEAD_H = 180; const FOOT_H = 64;
/** The picture's width: two cards, the gaps and the margins. */
export const WINS_COLLAGE_W = PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP;

const SITE = { bg: '#05050A', text: '#F3F1FA', muted: '#9C98B8', violet: '#7C3AED', magenta: '#FF007A', laser: '#00F0FF', success: '#10B981', danger: '#EF4444' };
const SPORT = { tennis: { name: 'TENNIS', ink: '#5CE9F7' }, nba: { name: 'NBA', ink: '#FF5CA8' }, nfl: { name: 'NFL', ink: '#A78BFA' } };
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[−–—]/g, '-').replace(/[^\x20-\x7e•]/g, '').trim();
const esc = (s) => plain(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inEt = (ms, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(ms);
const unitsWords = (n) => `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(2)}u`;

/** Whether a settled play is a win. */
export const isWin = (p) => p?.status === 'graded' && p?.result === 'win';
const settledAt = (p) => Number(p.gradedAt ?? p.doneAt ?? 0);
/** A card's height for an entry: the tennis card's, or the slip card's for its legs. */
export const cardHeightOf = (entry) => (entry.sport === 'tennis' ? CARD_H : slipCardHeight(Math.min(8, (entry.play.legs ?? []).length)));

/**
 * The model: what the picture says. `entries` are {sport, play} across the sources, settled or not; the wins are
 * kept, the biggest first (units made, then the earlier settled), WINS_MAX of them drawn.
 */
export function winsCollageModel(dateKey, entries, { drawnAt = Date.now() } = {}) {
  const wins = (entries ?? []).filter((e) => e?.play && SPORT[e.sport] && isWin(e.play))
    .sort((a, b) => (Number(b.play.profit ?? 0) - Number(a.play.profit ?? 0)) || (settledAt(a.play) - settledAt(b.play)));
  // The units are the day's net over every settled play, losses included, and are shown only when the day is up
  // (2026-11-28, the owner, of a collage that summed the winners alone: "Remove the units up unless that's really
  // the case. If the net is under a 0.00 units up. Leave it out").
  const settled = (entries ?? []).filter((e) => e?.play && SPORT[e.sport] && (e.play.status === 'graded' || e.play.status === 'void'));
  const net = Math.round(settled.reduce((s, e) => s + (Number.isFinite(e.play.profit) ? e.play.profit : 0), 0) * 100) / 100;
  const bySport = Object.fromEntries(Object.keys(SPORT).map((k) => [k, wins.filter((e) => e.sport === k).length]));
  const dayMs = Date.parse(`${dateKey}T17:00:00Z`); // noon ET or so: the date's own day whatever the clocks
  return {
    kind: 'wins', version: WINS_COLLAGE_VERSION, dateKey, title: 'WINNERS',
    when: inEt(dayMs, { weekday: 'long', month: 'long', day: 'numeric' }).replace(', ', ' • ').toUpperCase(),
    count: wins.length, net, units: net > 0 ? net : null, bySport,
    shown: wins.slice(0, WINS_MAX),
    more: Math.max(0, wins.length - WINS_MAX),
    foot: `Posted ${inEt(drawnAt, { month: 'short', day: 'numeric' })} • ${inEt(drawnAt, { hour: 'numeric', minute: '2-digit' })} ET`,
  };
}

/** Where each drawn card sits: two across, a row as tall as its taller card. */
export function winsLayout(model) {
  const cells = [];
  let y = HEAD_H; let rowH = 0;
  model.shown.forEach((entry, i) => {
    const col = i % COLS;
    if (i && col === 0) { y += rowH + GAP; rowH = 0; }
    const h = cardHeightOf(entry);
    cells.push({ x: PAD + col * (CARD_W + GAP), y, w: CARD_W, h, entry, index: i });
    rowH = Math.max(rowH, h);
  });
  return { cells, height: (model.shown.length ? y + rowH + GAP : HEAD_H) + FOOT_H };
}
export const winsCollageHeight = (model) => winsLayout(model).height;

/** A card's SVG as a group: its root tag off, its ids made its own (`w3-card`), set at (x, y). */
export function nestCard(svg, i, x, y) {
  const body = svg.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const own = body.replace(/\bid="([^"]+)"/g, `id="w${i}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#w${i}-$1)`).replace(/\bhref="#([^"]+)"/g, `href="#w${i}-$1"`);
  return `<g transform="translate(${x} ${y})">${own}</g>`;
}

/** The picture. `logo` is the logo as a data: address; without it the tag stands alone. */
export function winsCollageSvg(model, { logo = null } = {}) {
  const W = WINS_COLLAGE_W; const { cells, height: H } = winsLayout(model);
  const text = (x, y, size, weight, fill, body, extra = '') => `<text x="${x}" y="${y}" font-family="Roboto Condensed" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(body)}</text>`;
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${SITE.bg}"/>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#wins-grid)" opacity="0.5"/>`);
  parts.push(`<rect width="${W}" height="${HEAD_H}" fill="url(#wins-glow)"/>`);
  // Head: the logo and the words at the left.
  const lx = PAD; const ly = 36;
  if (logo) parts.push(`<image href="${logo}" x="${lx}" y="${ly}" width="64" height="64"/>`);
  const tx = logo ? lx + 80 : lx;
  parts.push(text(tx, ly + 22, 18, 700, SITE.muted, 'PERPETUAL PICKS', 'letter-spacing="3"'));
  parts.push(text(tx, ly + 62, 44, 700, SITE.text, model.title, 'letter-spacing="2"'));
  parts.push(text(PAD, HEAD_H - 22, 20, 500, SITE.muted, model.when, 'letter-spacing="1.5"'));
  // Head: the count and the units at the right, the sports under them.
  const rx = W - PAD;
  const countWords = `${model.count} WIN${model.count === 1 ? '' : 'S'}`;
  parts.push(text(rx, ly + 44, 52, 700, SITE.success, countWords, 'text-anchor="end" letter-spacing="1"'));
  if (model.units != null) parts.push(text(rx, ly + 80, 30, 700, SITE.success, unitsWords(model.units), 'text-anchor="end"'));
  let cx = rx;
  for (const [k, n] of Object.entries(model.bySport).reverse()) {
    if (!n) continue;
    const label = `${SPORT[k].name} ${n}`;
    const w = Math.ceil(textWidth(label, 17, { weight: 700, spacing: 1 })) + 26;
    cx -= w;
    parts.push(`<rect x="${cx}" y="${HEAD_H - 40}" width="${w}" height="28" rx="14" fill="${SPORT[k].ink}" fill-opacity="0.14" stroke="${SPORT[k].ink}" stroke-opacity="0.6"/>`);
    parts.push(text(cx + w / 2, HEAD_H - 21, 17, 700, SPORT[k].ink, label, 'text-anchor="middle" letter-spacing="1"'));
    cx -= 10;
  }
  parts.push(`<line x1="${PAD}" y1="${HEAD_H - 4}" x2="${W - PAD}" y2="${HEAD_H - 4}" stroke="${SITE.violet}" stroke-opacity="0.35"/>`);
  // The cards.
  for (const c of cells) {
    const svg = c.entry.sport === 'tennis' ? cardSvg(c.entry.play, { logo }) : slipCardSvg(c.entry.play, { logo });
    parts.push(nestCard(svg, c.index, c.x, c.y));
  }
  if (!cells.length) parts.push(text(W / 2, HEAD_H + 60, 26, 500, SITE.muted, 'No winners today.', 'text-anchor="middle"'));
  // Foot.
  const fy = H - 24;
  parts.push(text(PAD, fy, 18, 700, SITE.muted, 'perpetualpicks.com', 'letter-spacing="1.5"'));
  const foot = model.more ? `+${model.more} more win${model.more === 1 ? '' : 's'} not shown • ${model.foot}` : model.foot;
  parts.push(text(W - PAD, fy, 18, 500, SITE.muted, foot, 'text-anchor="end"'));
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<pattern id="wins-grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M 48 0 L 0 0 0 48" fill="none" stroke="${SITE.violet}" stroke-opacity="0.12" stroke-width="1"/></pattern>
<linearGradient id="wins-glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${SITE.violet}" stop-opacity="0.22"/><stop offset="1" stop-color="${SITE.violet}" stop-opacity="0"/></linearGradient>
</defs>
${parts.join('\n')}
</svg>`;
}
