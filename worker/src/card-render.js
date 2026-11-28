/**
 * The card picture, from SVG to PNG (worker/src/card-svg.js writes the
 * SVG). Discord shows a PNG and not an SVG, so the worker draws it itself:
 * resvg, compiled to WebAssembly, with the card's fonts and the logo
 * bundled beside it (worker/vendor; wrangler.toml loads .ttf and .png as
 * data, and .wasm as a module).
 *
 * This file is only ever loaded with import() from a route or the Discord
 * sync, never at the top of another file: the tests run in Node, which
 * cannot import a .wasm or a .ttf, and nothing they cover needs a picture.
 */
import { initWasm, Resvg } from '../vendor/resvg/index.mjs';
import resvgWasm from '../vendor/resvg/index_bg.wasm';
import condensedBold from '../vendor/fonts/RobotoCondensed-700.ttf';
import condensedMedium from '../vendor/fonts/RobotoCondensed-500.ttf';
import condensedRegular from '../vendor/fonts/RobotoCondensed-400.ttf';
import logoPng from '../../docs/assets/logo-icon-180.png';
import { cardSvg, slipCardSvg } from './card-svg.js';
import { resultsCardSvg } from './results-card.js';
import { winsCollageSvg } from './wins-collage.js';

/** The picture's width in pixels: sharp on a phone, and well under Discord's limits. */
export const CARD_PIXELS = 1080;
/** The winners' collage is two cards across, so it is drawn wider to keep each card as sharp. */
export const COLLAGE_PIXELS = 1600;

let ready = null;
let logoUri = null;
const base64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const FONTS = [condensedBold, condensedMedium, condensedRegular].map((f) => new Uint8Array(f));

/** An SVG card as PNG bytes, `pixels` wide. */
async function drawPng(svgOf, { pixels = CARD_PIXELS } = {}) {
  ready ??= initWasm(resvgWasm);
  await ready;
  logoUri ??= `data:image/png;base64,${base64(logoPng)}`;
  const drawn = new Resvg(svgOf(logoUri), { fitTo: { mode: 'width', value: pixels }, font: { fontBuffers: FONTS, loadSystemFonts: false, defaultFontFamily: 'Roboto Condensed' } }).render();
  try { return drawn.asPng(); } finally { drawn.free?.(); }
}
/** The card for a play as PNG bytes. */
export const renderCardPng = (play) => drawPng((logo) => cardSvg(play, { logo }));
/** The card for a slip of several legs (the live NBA plays) as PNG bytes. */
export const renderSlipPng = (post) => drawPng((logo) => slipCardSvg(post, { logo }));
/** The results card (a day's or a week's record, worker/src/results-card.js) as PNG bytes. */
export const renderResultsPng = (model) => drawPng((logo) => resultsCardSvg(model, { logo }));
/** The winners' collage (a day's winning plays, worker/src/wins-collage.js) as PNG bytes. */
export const renderWinsPng = (model) => drawPng((logo) => winsCollageSvg(model, { logo }), { pixels: COLLAGE_PIXELS });
