/**
 * The results card: a day's (or a week's) record as one picture, for the results channels' roll-ups
 * (worker/src/discord-results-digest.js).
 *
 * 2026-11-26, the owner, with another capper's "Today's record" graphic beside it: "I would like mine to be in this
 * kind of a format, but better. Quick, concise data points. Just enough data to get the point and to see the record
 * or performance, but not too much data to overstimulate the reader. Also to look like my aesthetic for my website
 * ... a logo of tennis and a logo of basketball, so when you look at the results card, you know exactly what sport
 * this is for."
 *
 *   head     the logo and what this is (DAILY RESULTS, WEEKLY RESULTS), the sport's name and its ball at the right
 *   date     the day (or the week) and whether it is final or still running
 *   tiles    three numbers: the record with its hit rate, the units with the ROI, and one more for the sport
 *            (tennis: the leans' record; NBA and NFL: how many legs hit)
 *   panel    a line a market (tennis) or a slip size (NBA, NFL), each with its record and units, the sport's
 *            total lit at the bottom; the week's card has a line a day instead
 *   strip    the day as a row of dots, one a play in the order they settled (the week: a bar a day, its units)
 *   foot     the site, and when it was drawn
 *
 * The look is the website's (worker/src/card-svg.js): the near-black ground, the violet hairline grid, the glass
 * panels, the site's text and muted greys; green for a gain, red for a loss. The sport is the accent: laser blue
 * for tennis (the ball is drawn in it), magenta for basketball, violet for football — all three from the site's
 * own palette, so the card stays the site's whatever the sport.
 *
 * Two parts, both plain text: the model (resultsCardModel, weeklyCardModel — what the card says, as numbers and
 * words, tested as data) and the picture (resultsCardSvg — the SVG, which worker/src/card-render.js turns into a
 * PNG). The font is the one that file loads, Roboto Condensed, cut to Latin letters.
 */
import { textWidth, fitLine } from './card-svg.js';
import { liveRecordOf } from './tennis-live-plays.js';

export const RESULTS_CARD_W = 720;
/** Raised whenever the card's look changes. */
export const RESULTS_CARD_VERSION = 1;

const SITE = { bg: '#05050A', text: '#F3F1FA', muted: '#9C98B8', violet: '#7C3AED', magenta: '#FF007A', laser: '#00F0FF', success: '#10B981', danger: '#EF4444' };
const TONE = { up: '#34D399', down: '#F87171', flat: '#B9B6CF' };
/** Each sport: its name on the card, its accent, its ball. */
export const SPORTS = {
  tennis: { name: 'TENNIS', ink: '#5CE9F7', a: SITE.laser, b: SITE.violet, ball: 'tennis' },
  nba: { name: 'NBA', ink: '#FF5CA8', a: SITE.magenta, b: SITE.violet, ball: 'basketball' },
  nfl: { name: 'NFL', ink: '#A78BFA', a: SITE.violet, b: SITE.magenta, ball: 'football' },
};
const MARKETS = [['live_ml', 'Match Winner'], ['live_set', 'Set Winner'], ['live_set_total', 'Set Total Games']];
const ROOM = 1.03;
const DOTS_PER_ROW = 32;
const DOT_ROWS_MAX = 4;

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[−–—]/g, '-').replace(/[^\x20-\x7e•]/g, '').trim();
const esc = (s) => plain(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inEt = (ms, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(ms);

/* ---------- the numbers ---------- */

const settled = (r) => r.wins + r.losses;
export const recordWords = (r) => `${r.wins}-${r.losses}${r.voids ? `-${r.voids}` : ''}`;
export const unitsWords = (n) => `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(2)}u`;
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '');
const toneOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const outcomeOf = (p) => (p.status === 'void' ? 'void' : p.result === 'win' ? 'win' : 'loss');

/** A line of the panel: a label, the plays' record, their units; `empty` when there is nothing to say. */
function row(label, plays, { highlight = false, unitsShown = true } = {}) {
  const r = liveRecordOf(plays);
  const n = settled(r) + r.voids;
  return { label, record: n ? recordWords(r) : '-', value: !n ? '' : unitsShown ? unitsWords(r.units) : pct(r.wins, settled(r)), tone: !n ? 'flat' : unitsShown ? toneOf(r.units) : toneOf(r.wins - r.losses), count: n, highlight };
}

/** The three tiles for a set of plays: the record, the units, and the sport's own third. */
function tiles(sport, plays, tally, leans) {
  const hit = pct(tally.wins, settled(tally));
  const out = [
    { label: 'RECORD', value: settled(tally) + tally.voids ? recordWords(tally) : '0-0', sub: hit, tone: toneOf(tally.wins - tally.losses), note: tally.voids ? `${tally.voids} void` : '' },
    { label: 'UNITS', value: unitsWords(tally.units), sub: tally.roi == null ? '' : `ROI ${tally.roi < 0 ? '-' : '+'}${Math.abs(tally.roi * 100).toFixed(1)}%`, tone: toneOf(tally.units), note: '' },
  ];
  if (sport === 'tennis') {
    const n = settled(leans) + leans.voids;
    out.push({ label: 'LEANS', value: n ? recordWords(leans) : '0-0', sub: n ? pct(leans.wins, settled(leans)) : 'none', tone: n ? toneOf(leans.wins - leans.losses) : 'flat', note: 'off record' });
  } else {
    const legs = plays.filter((p) => p.status !== 'void').flatMap((p) => p.legs ?? []).filter((l) => l.hit === true || l.hit === false);
    const hits = legs.filter((l) => l.hit === true).length;
    out.push({ label: 'LEGS HIT', value: legs.length ? pct(hits, legs.length) : '-', sub: legs.length ? `${hits} of ${legs.length}` : 'none', tone: legs.length ? toneOf(hits / legs.length - 0.5) : 'flat', note: '' });
  }
  return out;
}

/**
 * The day's card, as what it says. `plays` are the settled plays of the day in the order they settled (the
 * digest's settledIn); `soFar` says the day is still running. `drawnAt` is when the card is drawn (the foot).
 */
export function resultsCardModel(sport, playedDateKey, plays, { soFar = false, drawnAt = Date.now(), noon = null } = {}) {
  const s = SPORTS[sport] ?? SPORTS.nba;
  const tracked = plays.filter((p) => !p.lean);
  const tally = liveRecordOf(tracked);
  const leans = liveRecordOf(plays.filter((p) => p.lean));
  const dayMs = noon ?? Date.parse(`${playedDateKey}T17:00:00Z`);
  const rows = [];
  if (sport === 'tennis') {
    for (const [market, label] of MARKETS) { const r = row(label, tracked.filter((p) => p.market === market)); if (r.count) rows.push(r); }
    const other = tracked.filter((p) => !MARKETS.some(([m]) => m === p.market));
    if (other.length) rows.push(row('Other', other));
  } else {
    const sizes = [[2, '2-leg slips'], [3, '3-leg slips'], [4, '4+ leg slips']];
    for (const [n, label] of sizes) { const r = row(label, tracked.filter((p) => (n === 4 ? (p.legs?.length ?? 0) >= 4 : (p.legs?.length ?? 0) === n))); if (r.count) rows.push(r); }
    const singles = tracked.filter((p) => (p.legs?.length ?? 0) < 2);
    if (singles.length) rows.unshift(row('Singles', singles));
  }
  rows.push(row(`All ${s.name === 'TENNIS' ? 'tennis' : s.name}`, tracked, { highlight: true }));
  return {
    kind: 'daily', sport, title: 'DAILY RESULTS',
    when: inEt(dayMs, { weekday: 'long', month: 'long', day: 'numeric' }).replace(', ', ' • ').toUpperCase(),
    state: soFar ? 'live' : 'final',
    tiles: tiles(sport, tracked, tally, leans),
    sections: [{ title: sport === 'tennis' ? 'BY MARKET' : 'BY SLIP', rows }],
    dots: tracked.map(outcomeOf),
    bars: null,
    plays: tracked.length,
    foot: `${soFar ? 'So far' : 'Posted'} ${inEt(drawnAt, { month: 'short', day: 'numeric' })} • ${inEt(drawnAt, { hour: 'numeric', minute: '2-digit' })} ET`,
  };
}

/**
 * The week's card. `days` is seven of {dateKey, count, tally, leans}, Monday first (the digest's). The tally of a
 * day with no record is zeros.
 */
export function weeklyCardModel(sport, weekStartKey, days, { drawnAt = Date.now() } = {}) {
  const s = SPORTS[sport] ?? SPORTS.nba;
  const zero = () => ({ wins: 0, losses: 0, voids: 0, pending: 0, staked: 0, units: 0, roi: null });
  const sum = (key) => { const out = zero(); for (const d of days) { const r = d?.[key]; if (!r) continue; out.wins += r.wins ?? 0; out.losses += r.losses ?? 0; out.voids += r.voids ?? 0; out.staked += r.staked ?? 0; out.units += r.units ?? 0; } out.staked = Math.round(out.staked * 100) / 100; out.units = Math.round(out.units * 100) / 100; out.roi = out.staked > 0 ? Math.round((out.units / out.staked) * 1000) / 1000 : null; return out; };
  const tally = sum('tally'); const leans = sum('leans');
  const noon = (dateKey) => Date.parse(`${dateKey}T17:00:00Z`);
  const rows = days.map((d) => {
    const r = d.tally ?? zero();
    const n = settled(r) + r.voids;
    return { label: inEt(noon(d.dateKey), { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', ''), record: n ? recordWords(r) : '-', value: n ? unitsWords(r.units) : '', tone: n ? toneOf(r.units) : 'flat', count: n, highlight: false };
  });
  rows.push({ label: 'All week', record: settled(tally) + tally.voids ? recordWords(tally) : '0-0', value: unitsWords(tally.units), tone: toneOf(tally.units), count: settled(tally) + tally.voids, highlight: true });
  const count = days.reduce((n, d) => n + (d.count ?? 0), 0);
  const best = days.reduce((b, d) => (d.tally && (b == null || d.tally.units > b.tally.units) ? d : b), null);
  const third = sport === 'tennis'
    ? { label: 'LEANS', value: settled(leans) + leans.voids ? recordWords(leans) : '0-0', sub: settled(leans) ? pct(leans.wins, settled(leans)) : 'none', tone: settled(leans) ? toneOf(leans.wins - leans.losses) : 'flat', note: 'off record' }
    : { label: 'PLAYS', value: String(count), sub: best?.tally && settled(best.tally) ? `best ${inEt(noon(best.dateKey), { weekday: 'short' })} ${unitsWords(best.tally.units)}` : '', tone: 'flat', note: `${days.filter((d) => d.count).length} days` };
  const first = tiles(sport, [], tally, leans).slice(0, 2);
  const end = noon(days[days.length - 1]?.dateKey ?? weekStartKey);
  return {
    kind: 'weekly', sport, title: 'WEEKLY RESULTS',
    when: `${inEt(noon(weekStartKey), { month: 'short', day: 'numeric' })} - ${inEt(end, { month: 'short', day: 'numeric' })}`.toUpperCase(),
    state: 'final',
    tiles: [...first, third],
    sections: [{ title: 'BY DAY', rows }],
    dots: null,
    bars: days.map((d) => ({ day: inEt(noon(d.dateKey), { weekday: 'short' }).slice(0, 1), units: d.tally?.units ?? 0, played: Boolean(d.count) })),
    plays: count,
    foot: `Posted ${inEt(drawnAt, { month: 'short', day: 'numeric' })} • ${inEt(drawnAt, { hour: 'numeric', minute: '2-digit' })} ET`,
  };
}

/* ---------- the picture ---------- */

const TILE_H = 104; const ROW_H = 46; const DOT = 14; const DOT_GAP = 5; const BAR_H = 96;

/** The sport's ball, drawn in its accent inside a circle of radius `r` at (cx, cy). */
export function ballSvg(kind, cx, cy, r, ink) {
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink}" fill-opacity="0.1" stroke="${ink}" stroke-width="3"/>`;
  const seam = (d) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>`;
  const k = r / 30;
  if (kind === 'tennis') {
    // The two seams: each from the top to a side, bowed in toward the middle, one the mirror of the other.
    const q = (x1, y1, qx, qy, x2, y2) => `M ${cx + x1 * r} ${cy + y1 * r} Q ${cx + qx * r} ${cy + qy * r} ${cx + x2 * r} ${cy + y2 * r}`;
    return `${ring}${seam(q(0.22, -0.975, -0.02, -0.02, -0.975, 0.22))}${seam(q(-0.22, 0.975, 0.02, 0.02, 0.975, -0.22))}`;
  }
  if (kind === 'football') {
    // The ball on its side: its outline, the laces across the middle.
    const w = r * 1.45; const h = r * 0.9;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${w}" ry="${h}" fill="${ink}" fill-opacity="0.1" stroke="${ink}" stroke-width="3"/>${seam(`M ${cx - 14 * k} ${cy} H ${cx + 14 * k}`)}${[-9, -3, 3, 9].map((dx) => seam(`M ${cx + dx * k} ${cy - 5 * k} V ${cy + 5 * k}`)).join('')}`;
  }
  // A basketball: the two straight seams, and the two curved ones bowed in toward the middle.
  const d = r * 0.707;
  return `${ring}${seam(`M ${cx - r} ${cy} H ${cx + r}`)}${seam(`M ${cx} ${cy - r} V ${cy + r}`)}${seam(`M ${cx - d} ${cy - d} Q ${cx - r * 0.22} ${cy} ${cx - d} ${cy + d}`)}${seam(`M ${cx + d} ${cy - d} Q ${cx + r * 0.22} ${cy} ${cx + d} ${cy + d}`)}`;
}

/** The card's height for a model. */
export function resultsCardHeight(model) {
  const rows = model.sections.reduce((n, s) => n + s.rows.length, 0);
  const dotRows = model.dots ? Math.min(DOT_ROWS_MAX, Math.ceil(model.dots.length / DOTS_PER_ROW)) : 0;
  const strip = model.dots ? (model.dots.length ? 40 + dotRows * (DOT + DOT_GAP) : 0) : model.bars ? 40 + BAR_H : 0;
  return 160 + TILE_H + 28 + model.sections.length * 30 + rows * ROW_H + 24 + strip + 60;
}

/**
 * The card as SVG. `logo` is the site's logo as a data: address (worker/src/card-render.js supplies it); without
 * it the title stands alone. Every line is measured and kept inside its own width.
 */
export function resultsCardSvg(model, { logo = null } = {}) {
  const s = SPORTS[model.sport] ?? SPORTS.nba;
  const W = RESULTS_CARD_W; const H = resultsCardHeight(model); const M = 36;
  const text = (x, y, size, weight, fill, body, extra = '') => `<text x="${x}" y="${y}" font-family="Roboto Condensed" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${body}</text>`;
  const end = 'text-anchor="end"';
  const width = (body, size, weight, spacing = 0) => Math.ceil(textWidth(body, size, { weight, spacing }) * ROOM);
  const parts = [];

  // The head: the logo, the site's name, what this is; the sport and its ball at the right.
  const ballR = 30; const ballX = W - M - ballR; const ballY = 70;
  const nameW = width(s.name, 30, 700, 2);
  const titleRoom = ballX - ballR - 16 - nameW - 18 - (logo ? M + 74 : M) - 8;
  const titleX = logo ? M + 74 : M;
  const title = fitLine(model.title, titleRoom, 36, { min: 22, spacing: 1 });
  parts.push(logo ? `<image x="${M}" y="40" width="60" height="60" xlink:href="${logo}" href="${logo}" filter="url(#bright)"/>` : '');
  parts.push(text(titleX, 60, 15, 500, SITE.muted, 'PERPETUAL PICKS', 'letter-spacing="3"'));
  parts.push(text(titleX, 96, title.size, 700, SITE.text, esc(title.text), 'letter-spacing="1"'));
  parts.push(ballSvg(s.ball, ballX, ballY, ballR, s.ink));
  parts.push(text(ballX - ballR - 16, ballY + 11, 30, 700, s.ink, esc(s.name), `${end} letter-spacing="2"`));

  // The date line: the day or the week; final or still running at the right.
  const stateInk = model.state === 'live' ? s.ink : TONE.flat;
  const stateWord = model.state === 'live' ? 'LIVE' : 'FINAL';
  const stateW = width(stateWord, 15, 700, 2);
  parts.push(`<circle cx="${W - M - stateW - 14}" cy="${131}" r="5" fill="${stateInk}"/>`);
  parts.push(text(W - M, 136, 15, 700, stateInk, stateWord, `${end} letter-spacing="2"`));
  const when = fitLine(model.when, W - 2 * M - stateW - 40, 17, { min: 13, weight: 500, spacing: 2.5 });
  parts.push(text(M, 136, when.size, 500, SITE.muted, esc(when.text), 'letter-spacing="2.5"'));
  parts.push(`<line x1="${M}" y1="150" x2="${W - M}" y2="150" stroke="${SITE.violet}" stroke-opacity="0.35" stroke-width="1.5"/>`);

  // The tiles.
  let y = 160 + 8;
  const gap = 12; const tileW = (W - 2 * M - 2 * gap) / 3;
  model.tiles.forEach((t, i) => {
    const x = M + i * (tileW + gap);
    const ink = TONE[t.tone] ?? TONE.flat;
    parts.push(`<rect x="${x}" y="${y}" width="${tileW}" height="${TILE_H}" rx="16" fill="#FFFFFF" fill-opacity="0.04" stroke="${SITE.violet}" stroke-opacity="0.32" stroke-width="1.5"/>`);
    parts.push(text(x + 18, y + 30, 14, 500, SITE.muted, esc(t.label), 'letter-spacing="2"'));
    if (t.note) parts.push(text(x + tileW - 16, y + 30, 13, 400, SITE.muted, esc(t.note), end));
    const sub = t.sub ? fitLine(t.sub, tileW * 0.5, 16, { min: 12, weight: 500 }) : null;
    const subW = sub ? width(sub.text, sub.size, 500) : 0;
    const value = fitLine(t.value, tileW - 36 - (sub ? subW + 10 : 0), 38, { min: 24 });
    parts.push(text(x + 18, y + 80, value.size, 700, t.label === 'RECORD' || t.label === 'PLAYS' ? SITE.text : ink, esc(value.text)));
    if (sub) parts.push(text(x + tileW - 16, y + 80, sub.size, 500, t.label === 'UNITS' ? SITE.muted : ink, esc(sub.text), end));
  });
  y += TILE_H + 28;

  // The panels: a line a row, the lit row for the total.
  for (const section of model.sections) {
    parts.push(text(M, y + 8, 15, 700, s.ink, esc(section.title), 'letter-spacing="3"'));
    y += 22;
    const panelH = section.rows.length * ROW_H + 8;
    parts.push(`<rect x="${M - 12}" y="${y}" width="${W - 2 * M + 24}" height="${panelH}" rx="16" fill="#FFFFFF" fill-opacity="0.03" stroke="${SITE.violet}" stroke-opacity="0.3" stroke-width="1.5"/>`);
    section.rows.forEach((r, i) => {
      const ry = y + 4 + i * ROW_H;
      const ink = TONE[r.tone] ?? TONE.flat;
      if (r.highlight) parts.push(`<rect x="${M - 10}" y="${ry}" width="${W - 2 * M + 20}" height="${ROW_H}" rx="12" fill="${s.ink}" fill-opacity="0.08"/>`);
      parts.push(`<rect x="${M + 6}" y="${ry + 12}" width="4" height="${ROW_H - 24}" rx="2" fill="${r.highlight ? s.ink : ink}"/>`);
      const valueW = r.value ? width(r.value, 22, 700) : 0;
      parts.push(text(W - M - 8, ry + 30, 22, 700, r.value ? ink : TONE.flat, esc(r.value || ''), end));
      const recordX = W - M - 8 - Math.max(valueW, 90) - 28;
      parts.push(text(recordX, ry + 30, 22, 700, r.count ? SITE.text : TONE.flat, esc(r.record), end));
      const label = fitLine(r.label, recordX - width(r.record, 22, 700) - 24 - (M + 24), 22, { min: 15, weight: r.highlight ? 700 : 500 });
      parts.push(text(M + 24, ry + 30, label.size, r.highlight ? 700 : 500, r.highlight ? s.ink : SITE.text, esc(label.text)));
      if (i < section.rows.length - 1) parts.push(`<line x1="${M + 6}" y1="${ry + ROW_H}" x2="${W - M - 6}" y2="${ry + ROW_H}" stroke="${SITE.violet}" stroke-opacity="0.16" stroke-width="1"/>`);
    });
    y += panelH + 8;
  }
  y += 16;

  // The strip: the day's plays as dots in the order they settled, or the week's units as bars.
  if (model.dots?.length) {
    const shown = model.dots.slice(0, DOTS_PER_ROW * DOT_ROWS_MAX);
    const more = model.dots.length - shown.length;
    parts.push(text(M, y + 8, 15, 700, s.ink, 'THE DAY', 'letter-spacing="3"'));
    parts.push(text(W - M, y + 8, 14, 400, SITE.muted, esc(`${model.plays} play${model.plays === 1 ? '' : 's'} in order${more > 0 ? ` • ${more} more` : ''}`), end));
    y += 22;
    const fill = { win: TONE.up, loss: TONE.down, void: TONE.flat };
    const rowW = Math.min(shown.length, DOTS_PER_ROW) * (DOT + DOT_GAP) - DOT_GAP;
    const x0 = M + Math.max(0, Math.floor((W - 2 * M - rowW) / 2));
    shown.forEach((o, i) => {
      const cx = x0 + (i % DOTS_PER_ROW) * (DOT + DOT_GAP); const cy = y + Math.floor(i / DOTS_PER_ROW) * (DOT + DOT_GAP);
      parts.push(`<rect x="${cx}" y="${cy}" width="${DOT}" height="${DOT}" rx="4" fill="${fill[o] ?? TONE.flat}" fill-opacity="${o === 'void' ? 0.45 : 0.9}"/>`);
    });
    y += Math.ceil(shown.length / DOTS_PER_ROW) * (DOT + DOT_GAP) + 18;
  } else if (model.bars) {
    parts.push(text(M, y + 8, 15, 700, s.ink, 'UNITS BY DAY', 'letter-spacing="3"'));
    y += 22;
    const span = Math.max(1, ...model.bars.map((b) => Math.abs(b.units)));
    const zero = y + BAR_H / 2 - 8; const half = BAR_H / 2 - 22;
    const slot = (W - 2 * M) / model.bars.length; const bw = Math.min(56, slot * 0.5);
    parts.push(`<line x1="${M}" y1="${zero}" x2="${W - M}" y2="${zero}" stroke="${SITE.violet}" stroke-opacity="0.35" stroke-width="1.5"/>`);
    model.bars.forEach((b, i) => {
      const cx = M + slot * i + slot / 2;
      const h = Math.max(b.played ? 3 : 0, Math.round((Math.abs(b.units) / span) * half));
      const ink = b.units > 0 ? TONE.up : b.units < 0 ? TONE.down : TONE.flat;
      if (h) parts.push(`<rect x="${cx - bw / 2}" y="${b.units >= 0 ? zero - h : zero}" width="${bw}" height="${h}" rx="4" fill="${ink}" fill-opacity="0.85"/>`);
      if (b.played) parts.push(text(cx, (b.units >= 0 ? zero - h - 6 : zero + h + 16), 13, 700, ink, esc(unitsWords(b.units).replace(/\.(\d)0u$/, '.$1u')), 'text-anchor="middle"'));
      parts.push(text(cx, y + BAR_H - 2, 14, 500, b.played ? SITE.text : SITE.muted, esc(b.day), 'text-anchor="middle" letter-spacing="1"'));
    });
    y += BAR_H + 18;
  }

  // The foot.
  const site = 'perpetualpicks.com';
  const siteW = width(site, 19, 500);
  const foot = fitLine(model.foot, W - 2 * M - siteW - 24, 17, { min: 13, weight: 400 });
  parts.push(text(M, H - 26, 19, 500, SITE.text, site, 'fill-opacity="0.85"'));
  parts.push(text(W - M, H - 26, foot.size, 400, SITE.muted, esc(foot.text), end));

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${s.a}"/><stop offset="1" stop-color="${s.b}"/></linearGradient>
    <radialGradient id="glow" cx="0.06" cy="-0.1" r="0.9"><stop offset="0" stop-color="${s.ink}" stop-opacity="0.18"/><stop offset="0.6" stop-color="${s.ink}" stop-opacity="0"/></radialGradient>
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
  ${parts.filter(Boolean).join('\n  ')}
</svg>`;
}
