/**
 * Recommended parlays for a UFC card (2026-11-18: "provide recommendations
 * for parlays ... builders, lottos, or regular parlays. Display odds of
 * each leg ... sort and filter parlays by confidence, payout, favorites,
 * underdogs, type ... so I can just click the recommended button and see
 * pre generated parlays for the UFC event and take the highest confidence
 * ML parlay or the highest payout lotto ... a leg breakdown, at least one
 * bullet point per leg and why it was picked").
 *
 * The tickets are put together from the card's graded pieces
 * (worker/src/ufc-props.js: every leg with its chance, its stars, its
 * reasons and each book's price) and the stat plays of the Sharp analysis
 * (worker/src/ufc-sharp.js). No model call: a ticket is a recipe run over
 * those legs, one leg a fight, so every number on it is one the card
 * already shows.
 *
 * What a ticket is called is decided by what it pays, not by the recipe:
 *
 *   builder   under about +160: a few likely legs, the bankroll builder
 *   parlay    +160 to +800: the regular ticket
 *   lotto     past +800: a long shot, sprinkle size
 *   stat      the Sharp analysis's stat plays (strikes, takedowns,
 *             knockdowns), which most books price in fight week only
 *
 * A ticket is priced at the one book that carries every leg where there
 * is one (a parlay is placed at one book), best first; failing that, leg
 * by leg at each leg's best price, and it says so.
 *
 * A leg's chance on a ticket: a moneyline's is the card's own (the market
 * blended with the lean). A prop's comes off the two records alone, which
 * run hot (a "does not go the distance" at 82% that the book prices at
 * 47%), so a prop counts as halfway between the records and its price.
 * A leg the book prices more than REC_MIN_ROOM short of its chance is
 * left off: it adds a way to lose and nothing to the payout.
 *
 * A ticket's confidence is its legs' stars (the weakest and the average,
 * evenly) less a quarter star for every leg past the second, so a long
 * ticket of good legs does not outrank a short one.
 */
import { americanToDecimal, decimalToAmerican } from '../../docs/engine.js';

export const REC_TYPES = { builder: 'Builder', parlay: 'Parlay', lotto: 'Lotto', stat: 'Stat plays' };
export const REC_STYLES = { ml: 'Moneyline', method: 'Method of victory', props: 'Fight props', mixed: 'Mixed', stat: 'Stats' };
/** Where a builder ends and a lotto starts, in decimal odds: +160 and +800. */
export const REC_BUILDER_MAX = 2.6;
export const REC_LOTTO_MIN = 9;
/** A leg's price to be on a ticket: nothing shorter than -600 (it adds risk and no payout). */
export const REC_LEG_FLOOR = -600;
/** The most a leg's price may ask over its chance (the book's cut on a favourite is about two points). */
export const REC_MIN_ROOM = -0.04;
/** The most tickets a card carries. */
export const REC_MAX = 40;
/** A venue that is not a sportsbook takes no parlay: it prices a leg, never a ticket. */
const NO_PARLAY = new Set(['kalshi', 'polymarket', 'engine']);

const pct = (p) => `${Math.round(p * 100)}%`;
const signed = (a) => (a > 0 ? `+${a}` : String(a));
const round3 = (x) => Math.round(x * 1000) / 1000;
const half = (x) => Math.round(x * 2) / 2;
const impliedOf = (american) => 1 / americanToDecimal(american);
const ordinalWord = ['likeliest', 'second likeliest', 'third likeliest', 'fourth likeliest', 'fifth likeliest'];

/** A leg's prices at real books (the cappers' quote is a reference, not a price to bet). */
const bookQuotes = (leg) => (leg.quotes ?? []).filter((q) => q.bookId !== 'engine' && Number.isFinite(q.american));
const bestQuote = (leg) => [...bookQuotes(leg)].sort((x, y) => y.american - x.american)[0] ?? null;
const againstPick = (leg) => (leg.why ?? []).some((w) => /against a Pixel's Pick/i.test(w));

/** A ticket's confidence, 1 to 5 in halves: the weakest leg and the average, evenly, less a quarter star a leg past the second. */
export const confidenceOf = (scores) => Math.max(1, half((Math.min(...scores) + scores.reduce((s, x) => s + x, 0) / scores.length) / 2 - 0.25 * Math.max(0, scores.length - 2)));

/** The stars a Sharp play's strength is worth beside the pieces' own. */
const strengthStars = (s) => (s >= 85 ? 5 : s >= 75 ? 4 : s >= 65 ? 3.5 : 3);

/**
 * The card's recommended parlays. `legs` is the card's pieces
 * (record.props.legs), `breakdowns` the reads by bout id (the lean, its
 * confidence, its reasons, the Sharp plays). Returns {at, tickets, counts}.
 */
export function recommendedParlays({ legs = [], breakdowns = {}, now = Date.now(), max = REC_MAX } = {}) {
  const live = legs.filter((l) => Number.isFinite(l.chance) && !againstPick(l) && (l.boutDate == null || l.boutDate > now));
  // `read` is the card's chance for the leg; `chance` is what the ticket counts it as.
  const priced = live.map((l) => ({ ...l, best: bestQuote(l) })).filter((l) => l.best && l.best.american >= REC_LEG_FLOOR)
    .map((l) => ({ ...l, read: l.chance, chance: l.prop === 'ml' ? l.chance : round3((l.chance + impliedOf(l.best.american)) / 2) }))
    .filter((l) => l.read - impliedOf(l.best.american) >= REC_MIN_ROOM);
  // The favourite of each fight: the side the books price shorter (the likelier side where no book prices the fight).
  const favOf = new Map();
  for (const l of live) {
    if (l.prop !== 'ml' || !l.side) continue;
    const q = bestQuote(l); const rank = q ? impliedOf(q.american) : l.chance; const cur = favOf.get(l.boutId);
    if (!cur || rank > cur.rank) favOf.set(l.boutId, { side: l.side, rank, chance: l.chance });
  }
  const role = (l) => (!l.side || !favOf.has(l.boutId) ? null : favOf.get(l.boutId).side === l.side ? 'fav' : 'dog');
  const sideChance = (l) => live.find((x) => x.prop === 'ml' && x.boutId === l.boutId && x.side === l.side)?.chance ?? null;
  const bd = (l) => breakdowns?.[l.boutId] ?? {};
  const onLean = (l) => Boolean(l.side && bd(l).lean === l.side);

  const byChance = (x, y) => y.chance - x.chance || y.score - x.score || String(x.id).localeCompare(String(y.id));
  const ml = priced.filter((l) => l.prop === 'ml');
  const favML = ml.filter((l) => role(l) === 'fav').sort(byChance);
  const dogML = ml.filter((l) => role(l) === 'dog' && l.chance >= 0.3).sort(byChance);
  const leanML = ml.filter((l) => onLean(l) && (bd(l).confidence ?? 0) >= 4).sort((x, y) => (bd(y).confidence ?? 0) - (bd(x).confidence ?? 0) || byChance(x, y));
  const safeProps = priced.filter((l) => ['distance', 'rounds', 'double', 'end_method'].includes(l.prop) && l.chance >= 0.58 && l.score >= 4).sort(byChance);
  const methods = priced.filter((l) => l.prop === 'method' && l.score >= 2 && l.chance >= 0.2).sort(byChance);
  const gradedML = ml.filter((l) => l.score >= 3 && l.chance >= 0.45).sort((x, y) => y.score - x.score || byChance(x, y));
  const finishes = priced.filter((l) => (l.prop === 'distance' && /does not go/i.test(l.selection)) && l.chance >= 0.55).sort(byChance);
  const goesLong = priced.filter((l) => ((l.prop === 'distance' && !/does not go/i.test(l.selection)) || (l.prop === 'rounds' && /^over/i.test(l.selection))) && l.chance >= 0.5).sort(byChance);
  const longs = priced.filter((l) => ['method_round', 'win_round', 'method_rounds', 'end_round'].includes(l.prop) && l.side && l.read >= 0.08 && l.read <= 0.3 && l.best.american >= 250).sort((x, y) => Number(Boolean(y.sprinkle)) - Number(Boolean(x.sprinkle)) || byChance(x, y));
  // The best leg of each fight: the most stars, then the most room between the read and the price.
  const room = (l) => l.chance - impliedOf(l.best.american);
  const bestPerBout = [...priced.filter((l) => ['ml', 'method', 'distance', 'rounds', 'double'].includes(l.prop) && l.score >= 4 && l.chance >= 0.45)
    .reduce((m, l) => { const cur = m.get(l.boutId); if (!cur || l.score > cur.score || (l.score === cur.score && room(l) > room(cur))) m.set(l.boutId, l); return m; }, new Map()).values()].sort((x, y) => y.score - x.score || byChance(x, y));

  /** The first `n` of a pool, one a fight, skipping the fights `not` already holds; null when the pool runs short. */
  const take = (pool, n, not = []) => {
    const used = new Set(not.map((l) => l.boutId)); const out = [];
    for (const l of pool) { if (out.length >= n) break; if (used.has(l.boutId)) continue; used.add(l.boutId); out.push(l); }
    return out.length === n ? out : null;
  };

  /** A leg as a ticket shows it: the selection, its price, and why it is there. */
  const legView = (l, picked, quote) => {
    const q = quote ?? l.best;
    const why = [picked];
    const asks = `${q.book ?? q.bookId} ${signed(q.american)} asks for ${pct(impliedOf(q.american))}`;
    why.push(l.prop === 'ml' ? `${pct(l.read)} to win, the market's price blended with Pixel's lean; ${asks}` : `${pct(l.read)} by the two records; ${asks}; counted here as ${pct(l.chance)}, halfway between`);
    // The card's own reasons, less the lines that only repeat the chance.
    for (const w of (l.why ?? []).filter((x) => !/^\d+% to (win|pass|end)\b/i.test(x)).slice(0, 3)) why.push(w.replace(/^./, (c) => c.toUpperCase()));
    const reason = onLean(l) ? (bd(l).reasons ?? [])[0] : null;
    if (reason) why.push(reason.length > 220 ? `${reason.slice(0, 217).replace(/\s+\S*$/, '')}…` : reason);
    return { id: l.id, boutId: l.boutId, fight: l.fight, order: l.order ?? null, prop: l.prop, label: l.label, selection: l.selection, side: l.side ?? null, name: l.name ?? null, role: role(l), chance: l.chance, read: l.read, score: l.score, american: q.american, bookId: q.bookId, book: q.book ?? null, link: q.link ?? null, fairAmerican: l.fairAmerican ?? null, why };
  };

  /** The ticket's price: at the one book with every leg where there is one, else leg by leg at each leg's best. */
  const price = (chosen) => {
    const books = new Map();
    for (const [i, l] of chosen.entries()) for (const q of bookQuotes(l)) {
      if (NO_PARLAY.has(q.bookId)) continue;
      if (!books.has(q.bookId)) books.set(q.bookId, { bookId: q.bookId, book: q.book ?? null, quotes: new Map() });
      const b = books.get(q.bookId); if (!b.quotes.has(i) || q.american > b.quotes.get(i).american) b.quotes.set(i, q);
    }
    const full = [...books.values()].filter((b) => b.quotes.size === chosen.length).map((b) => ({ ...b, decimal: [...b.quotes.values()].reduce((d, q) => d * americanToDecimal(q.american), 1) })).sort((x, y) => y.decimal - x.decimal);
    if (full.length) return { oneBook: true, bookId: full[0].bookId, book: full[0].book, decimal: full[0].decimal, quotes: chosen.map((_, i) => full[0].quotes.get(i)), books: full.map((b) => ({ bookId: b.bookId, book: b.book, american: decimalToAmerican(b.decimal) })) };
    return { oneBook: false, bookId: null, book: null, decimal: chosen.reduce((d, l) => d * americanToDecimal(l.best.american), 1), quotes: chosen.map((l) => l.best), books: [] };
  };

  const tickets = []; const seen = new Set();
  const add = (style, title, blurb, chosen, picked) => {
    if (!chosen || chosen.length < 2) return;
    const key = chosen.map((l) => l.id).sort().join('|');
    if (seen.has(key)) return; seen.add(key);
    const p = price(chosen);
    const legsOut = chosen.map((l, i) => legView(l, typeof picked === 'function' ? picked(l, i) : picked, p.quotes[i]));
    const chance = chosen.reduce((x, l) => x * l.chance, 1);
    const scores = chosen.map((l) => l.score);
    const type = p.decimal < REC_BUILDER_MAX ? 'builder' : p.decimal < REC_LOTTO_MIN ? 'parlay' : 'lotto';
    const dogs = legsOut.filter((l) => l.role === 'dog').length; const favs = legsOut.filter((l) => l.role === 'fav').length;
    tickets.push({
      id: `rec:${style}:${key}`, type, style, title, blurb, legs: legsOut, n: legsOut.length,
      chance: round3(chance), decimal: round3(p.decimal), american: decimalToAmerican(p.decimal), implied: round3(1 / p.decimal), edge: round3(chance - 1 / p.decimal),
      confidence: confidenceOf(scores),
      favorites: favs, underdogs: dogs, sides: dogs ? 'underdogs' : favs ? 'favorites' : 'neither',
      oneBook: p.oneBook, bookId: p.bookId, book: p.book, books: p.books,
    });
  };

  const nth = (pool, what) => (l, i) => `The ${ordinalWord[pool.indexOf(l)] ?? 'next likeliest'} ${what} on the card`;
  const leanLine = (l) => `Pixel leans ${l.name}, ${bd(l).confidence} of 5${bd(l).parlayPiece ? ', and calls the moneyline a sound parlay piece' : ''}`;
  const methodLine = (l) => { const p = sideChance(l); return `The way ${l.name}'s wins most often come${p != null ? `, on a side the read gives ${pct(p)} to win` : ''}`; };
  const propLine = (l) => `One of the likeliest priced props on the card, ${l.score} of 5 stars`;

  // ---- the short tickets
  add('ml', 'The two likeliest favourites', 'The two fighters the market and the read make likeliest to win.', take(favML, 2), nth(favML, 'favourite'));
  add('ml', "Pixel's leans", 'Moneylines on the sides Pixel leans at confidence 4 or better.', take(leanML, 2), leanLine);
  add('ml', 'The two highest-graded moneylines', 'The two moneylines with the most stars: the read, the cappers and the price together.', take(gradedML, 2), (l) => `One of the highest-graded moneylines on the card: ${l.score} of 5 stars`);
  add('props', 'Two safe props', 'The two likeliest priced props, no side to pick.', take(safeProps, 2), propLine);
  { const f = take(favML, 1); const s = f && take(safeProps, 1, f); add('mixed', 'A favourite and a prop', 'The likeliest favourite with the likeliest prop from another fight.', f && s ? [...f, ...s] : null, (l) => (l.prop === 'ml' ? nth(favML, 'favourite')(l) : propLine(l))); }
  // ---- the regular tickets
  add('ml', 'The three likeliest favourites', 'Three favourites, each the likeliest of its fight.', take(favML, 3), nth(favML, 'favourite'));
  add('ml', 'Four favourites', 'The four likeliest favourites on the card.', take(favML, 4), nth(favML, 'favourite'));
  add('ml', "Pixel's leans, three legs", 'Three moneylines on the sides Pixel leans at confidence 4 or better.', take(leanML, 3), leanLine);
  add('ml', 'The three highest-graded moneylines', 'The three moneylines with the most stars: the read, the cappers and the price together.', take(gradedML, 3), (l) => `One of the highest-graded moneylines on the card: ${l.score} of 5 stars`);
  add('method', 'Two methods of victory', 'Two fighters to win the way their wins most often come.', take(methods, 2), methodLine);
  add('method', 'Three methods of victory', 'Three fighters to win the way their wins most often come.', take(methods, 3), methodLine);
  { const f = take(favML, 2); const d = f && take(dogML, 1, f); add('ml', 'Two favourites and a live dog', 'Two favourites carry the ticket; the underdog with the best chance on the card makes it pay.', f && d ? [...f, ...d] : null, (l) => (role(l) === 'dog' ? `The underdog with the best chance on the card: ${pct(l.chance)} to win` : nth(favML, 'favourite')(l))); }
  add('props', 'Three finishes', 'Three fights the two records say end before the cards.', take(finishes, 3), (l) => 'Both fighters finish, and get finished, more often than not');
  add('props', 'Two that go long', 'Two fights the records say see the later rounds.', take(goesLong, 2), (l) => 'Neither record points to an early finish');
  add('props', 'Three safe props', 'The three likeliest priced props, no side to pick.', take(safeProps, 3), propLine);
  // The best leg of each fight comes after the tickets with a theme, so the same legs keep the name that says what they are.
  add('mixed', 'The best leg of three fights', 'The highest-graded leg of each of three fights, whatever the market.', take(bestPerBout, 3), (l) => `The highest-graded leg of ${l.fight}: ${l.score} of 5 stars`);
  add('mixed', 'The best leg of four fights', 'The highest-graded leg of each of four fights, whatever the market.', take(bestPerBout, 4), (l) => `The highest-graded leg of ${l.fight}: ${l.score} of 5 stars`);
  // ---- the long ones
  if (favML.length >= 5) add('ml', 'Every favourite on the card', `All ${favML.length} favourites to win: one upset ends it.`, take(favML, favML.length), nth(favML, 'favourite'));
  add('ml', 'Two underdogs', 'The two underdogs with the best chance to win.', take(dogML, 2), nth(dogML, 'underdog'));
  add('ml', 'Three underdogs', 'The three underdogs with the best chance to win.', take(dogML, 3), nth(dogML, 'underdog'));
  add('method', 'Four methods of victory', 'Four fighters to win the way their wins most often come.', take(methods, 4), methodLine);
  add('method', 'Two round-and-method long shots', "Two long prices the fighters' own records back best.", take(longs, 2), (l) => `A long shot the record backs: ${pct(l.read)} by the records at ${signed(l.best.american)}`);
  add('method', 'Three round-and-method long shots', "Three long prices the fighters' own records back best.", take(longs, 3), (l) => `A long shot the record backs: ${pct(l.read)} by the records at ${signed(l.best.american)}`);
  { const f = take(favML, 3); const d = f && take(dogML, 2, f); add('ml', 'Chalk and dogs', 'Three favourites and the two likeliest underdogs.', f && d ? [...f, ...d] : null, (l) => (role(l) === 'dog' ? nth(dogML, 'underdog')(l) : nth(favML, 'favourite')(l))); }
  add('props', 'Five finishes', 'Five fights to end before the cards.', take(finishes, 5), (l) => 'Both fighters finish, and get finished, more often than not');
  add('mixed', 'The best leg of six fights', 'The highest-graded leg of each of six fights.', take(bestPerBout, 6), (l) => `The highest-graded leg of ${l.fight}: ${l.score} of 5 stars`);

  // ---- the stat plays of the Sharp analysis: strikes, takedowns, knockdowns, one a fight, the strongest first
  const stats = [];
  for (const [boutId, b] of Object.entries(breakdowns ?? {})) {
    if (b.boutDate != null && b.boutDate <= now) continue;
    const play = (b.sharp?.plays ?? []).filter((p) => ['strikes', 'takedowns', 'knockdown'].includes(p.family)).sort((x, y) => y.strength - x.strength)[0];
    if (play) stats.push({ boutId, b, play });
  }
  stats.sort((x, y) => y.play.strength - x.play.strength || String(x.boutId).localeCompare(String(y.boutId)));
  const statTicket = (title, blurb, list) => {
    if (list.length < 2) return;
    const key = list.map((s) => `${s.boutId}:${s.play.key}`).sort().join('|');
    if (seen.has(key)) return; seen.add(key);
    const legsOut = list.map(({ boutId, b, play }) => {
      const q = play.quote && Number.isFinite(play.quote.american) ? play.quote : null;
      return { id: `${boutId}:sharp:${play.key}`, boutId, fight: `${b.a} vs ${b.b}`, order: b.order ?? null, prop: play.family, label: play.market, selection: play.selection, side: play.side ?? null, name: play.side ? b[play.side] : null, role: null, chance: null, score: strengthStars(play.strength), strength: play.strength, american: q?.american ?? null, bookId: q?.bookId ?? null, book: q?.book ?? null, link: q?.link ?? null, fairAmerican: null,
        why: [`A Sharp analysis play, strength ${play.strength} of 100`, ...(play.why ?? []).slice(0, 3), ...(play.note ? [play.note] : [])] };
    });
    const allPriced = legsOut.every((l) => l.american != null) && new Set(legsOut.map((l) => l.bookId)).size === 1;
    const decimal = allPriced ? legsOut.reduce((d, l) => d * americanToDecimal(l.american), 1) : null;
    const scores = legsOut.map((l) => l.score);
    tickets.push({
      id: `rec:stat:${key}`, type: 'stat', style: 'stat', title, blurb, legs: legsOut, n: legsOut.length,
      chance: null, decimal: decimal ? round3(decimal) : null, american: decimal ? decimalToAmerican(decimal) : null, implied: decimal ? round3(1 / decimal) : null, edge: null,
      confidence: confidenceOf(scores),
      favorites: 0, underdogs: 0, sides: 'neither', oneBook: allPriced, bookId: allPriced ? legsOut[0].bookId : null, book: allPriced ? legsOut[0].book : null, books: [],
    });
  };
  statTicket('The two strongest stat plays', 'The two strongest strikes, takedown or knockdown reads on the card.', stats.slice(0, 2));
  statTicket('The three strongest stat plays', 'The three strongest strikes, takedown or knockdown reads on the card.', stats.slice(0, 3));
  const strikes = stats.filter((s) => s.play.family === 'strikes');
  statTicket('Most significant strikes', 'Fighters who out-land an opponent who lets more through.', strikes.slice(0, 3));

  const out = tickets.slice(0, max);
  const counts = { builder: 0, parlay: 0, lotto: 0, stat: 0 };
  for (const t of out) counts[t.type]++;
  return { at: now, tickets: out, counts, types: REC_TYPES, styles: REC_STYLES };
}
