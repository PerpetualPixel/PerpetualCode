/**
 * The MMA predictions tracker's read of a card, entered by hand until the
 * MMA Engine's feed carries it (2026-11-05: "the mma predictions tracker
 * will be injected to the mma engine soon"; 2026-11-12: the owner pasted
 * the tracker's breakdown of UFC 334 while the engine's feed had nothing
 * for the card, and every bout read "No capper consensus").
 *
 * The tracker counts, per fight: the YouTube prediction channels that
 * pick each fighter; the picks of its "best predictors" (the channels
 * with the best return over the last 50 events), of its best favourite
 * predictors and its best underdog predictors; every channel's method
 * call; and what its best method predictors call. A card is entered
 * below as those counts, each for fighter `a`, under its ESPN event id,
 * with the average odds the breakdown quoted.
 *
 * trackerPicks turns a card into the engine feed's own pick shape
 * (worker/src/ufc-picks.js fetchMmaEngine), so the breakdowns, the parlay
 * pieces' grades, the underdog of the week and the UFC tab read it with
 * no change:
 *
 *   moneyline   the side backed by the field and the best predictors
 *               together: the mean of the two shares (the best predictors
 *               weigh as much as the whole field, since theirs is the
 *               record that has paid). 75%+ is strong, 60%+ a lean, less
 *               a pass. The counts ride along as the pick's comments.
 *   method      each fighter-and-method with a fifth or more of the
 *               method calls: its share of them; half or more is strong,
 *               three in ten a lean. The quoted price rides along.
 *
 * The engine's feed wins as soon as it has the card (withTracker). A card
 * is keyed by its event id, so it never shows on another card.
 */
export const TRACKER_SOURCE = 'the MMA predictions tracker';
export const TRACKER_STRONG = 75;
export const TRACKER_LEAN = 60;
export const TRACKER_METHOD_MIN = 20;
export const TRACKER_METHOD_STRONG = 50;
export const TRACKER_METHOD_LEAN = 30;

/**
 * [picks for a, picks counted]. `fav` and `dog` are the best favourite and
 * best underdog predictors. `methods` is each side's ko/sub/dec calls;
 * `methodOdds` the average price the breakdown quoted for a call;
 * `bestMethods` what the best method predictors said, in words.
 */
export const UFC_TRACKER = {
  // UFC 334: Gane vs. Hokit, Madison Square Garden. Counts as of the tracker's breakdown video, entered 2026-11-12.
  600061400: { at: '2026-11-12T18:00:00Z', fights: [
    { a: 'Evan Elder', b: 'Samuel Sanches', odds: { a: 100, b: -120 }, channels: [57, 84], best: [6, 7], fav: [7, 8], dog: [7, 8],
      methods: { a: { ko: 3, sub: 6, dec: 27 }, b: { ko: 14, sub: 0, dec: 4 } }, methodOdds: { a: { dec: 250 }, b: { ko: 175 } }, bestMethods: 'All three best method predictors have Elder, two of them by decision' },
    { a: 'Alatengheili', b: 'Juan Diaz', odds: { a: 295, b: -385 }, channels: [0, 80], best: [0, 6], fav: [0, 8], dog: [0, 7],
      methods: { a: { ko: 0, sub: 0, dec: 0 }, b: { ko: 11, sub: 18, dec: 25 } }, methodOdds: {}, bestMethods: 'Two of three best method predictors have Diaz by decision' },
    { a: 'Macy Chiasson', b: 'Bia Mesquita', odds: { a: 215, b: -265 }, channels: [3, 85], best: [1, 7], fav: [1, 8], dog: [1, 8],
      methods: { a: { ko: 1, sub: 1, dec: 0 }, b: { ko: 0, sub: 54, dec: 5 } }, methodOdds: { b: { sub: -116 } }, bestMethods: 'Three of four best method predictors have Mesquita by submission' },
    { a: 'Jared Gordon', b: 'Melquizael Costa', odds: { a: 295, b: -375 }, channels: [1, 86], best: [0, 7], fav: [0, 8], dog: [0, 8],
      methods: { a: { ko: 0, sub: 0, dec: 1 }, b: { ko: 43, sub: 7, dec: 8 } }, methodOdds: { b: { ko: 150 } }, bestMethods: 'The best method predictors have Costa, split between a knockout and a decision' },
    { a: 'Cesar Almeida', b: 'Donte Johnson', odds: { a: 140, b: -165 }, channels: [27, 86], best: [3, 7], fav: [3, 8], dog: [4, 8],
      methods: { a: { ko: 9, sub: 0, dec: 8 }, b: { ko: 32, sub: 2, dec: 9 } }, methodOdds: { a: { ko: 225 }, b: { ko: 150 } }, bestMethods: 'All four best method predictors call a knockout: three for Johnson, one for Almeida' },
    { a: 'Jim Miller', b: 'Terrance McKinney', odds: { a: 170, b: -200 }, channels: [19, 86], best: [0, 7], fav: [0, 8], dog: [0, 8],
      methods: { a: { ko: 0, sub: 14, dec: 0 }, b: { ko: 45, sub: 0, dec: 0 } }, methodOdds: { b: { ko: 140 } }, bestMethods: 'Two of three best method predictors have McKinney by knockout; no channel has it going to the cards' },
    { a: 'Drew Dober', b: 'Chris Duncan', odds: { a: 140, b: -170 }, channels: [33, 87], best: [2, 7], fav: [2, 8], dog: [3, 8],
      methods: { a: { ko: 21, sub: 0, dec: 0 }, b: { ko: 6, sub: 12, dec: 17 } }, methodOdds: { a: { ko: 195 }, b: { ko: 290, sub: 290, dec: 405 } }, bestMethods: 'Two of three best method predictors have Dober by knockout, against the moneyline consensus' },
    { a: 'Stephen Thompson', b: 'Charles Radtke', odds: { a: -155, b: 130 }, channels: [61, 87], best: [6, 7], fav: [6, 8], dog: [7, 8],
      methods: { a: { ko: 17, sub: 0, dec: 24 }, b: { ko: 2, sub: 0, dec: 15 } }, methodOdds: { a: { dec: 130 } }, bestMethods: 'Most best method predictors have Thompson, split between a knockout and a decision' },
    { a: 'Luis Gurule', b: 'Bilal Hasan', odds: { a: 675, b: -1000 }, channels: [0, 84], best: [0, 7], fav: [0, 8], dog: [0, 8],
      methods: { a: { ko: 0, sub: 0, dec: 0 }, b: { ko: 64, sub: 0, dec: 1 } }, methodOdds: { b: { ko: -345 } }, bestMethods: 'Every best method predictor has Hasan by knockout' },
    { a: 'Kevin Holland', b: 'Uroš Medić', odds: { a: 130, b: -155 }, channels: [33, 87], best: [2, 7], fav: [3, 8], dog: [2, 8],
      methods: { a: { ko: 7, sub: 12, dec: 2 }, b: { ko: 32, sub: 0, dec: 6 } }, methodOdds: { b: { ko: 108 } }, bestMethods: 'Two of three best method predictors have Holland by submission, against the moneyline consensus' },
    { a: 'Caio Borralho', b: 'Yousri Belgaroui', odds: { a: -160, b: 135 }, channels: [38, 86], best: [3, 7], fav: [3, 8], dog: [3, 8],
      methods: { a: { ko: 0, sub: 1, dec: 28 }, b: { ko: 10, sub: 0, dec: 22 } }, methodOdds: { a: { dec: 130 } }, bestMethods: 'The best method predictors are split: two have Borralho by decision, one Belgaroui by knockout, one Belgaroui by decision' },
    { a: 'Amanda Nunes', b: 'Kayla Harrison', odds: { a: 150, b: -180 }, channels: [47, 87], best: [6, 7], fav: [7, 8], dog: [6, 8],
      methods: { a: { ko: 22, sub: 0, dec: 11 }, b: { ko: 3, sub: 15, dec: 6 } }, methodOdds: { a: { ko: 305 }, b: { sub: 185, dec: 300 } }, bestMethods: 'The best method predictors mostly have Nunes, one by knockout and one by decision' },
    { a: 'Josh Hokit', b: 'Ciryl Gane', odds: { a: 160, b: -190 }, channels: [33, 87], best: [2, 7], fav: [3, 8], dog: [3, 8],
      methods: { a: { ko: 13, sub: 4, dec: 2 }, b: { ko: 29, sub: 0, dec: 7 } }, methodOdds: { b: { ko: 145 } }, bestMethods: 'Most best method predictors have Gane by knockout' },
  ] },
};

const METHOD_WORD = { ko: 'KO/TKO', sub: 'Submission', dec: 'Decision' };
const round1 = (x) => Math.round(x * 10) / 10;
const share = (pair) => (Array.isArray(pair) && pair[1] > 0 ? pair[0] / pair[1] : null);

/** One fight's moneyline read: the side, the blended share for it, and the counts in words. Null without a count of the field. */
export function trackerMoneyline(f) {
  const all = share(f.channels); if (all == null) return null;
  const best = share(f.best);
  const forA = best == null ? all : (all + best) / 2;
  const side = forA >= 0.5 ? 'a' : 'b';
  const name = f[side]; const other = f[side === 'a' ? 'b' : 'a'];
  const mine = (pair) => (side === 'a' ? pair[0] : pair[1] - pair[0]);
  const pct = round1((side === 'a' ? forA : 1 - forA) * 100);
  const line = (label, pair) => (Array.isArray(pair) && pair[1] > 0 ? `${label}: ${mine(pair)} of ${pair[1]} on ${name}` : null);
  const odds = Number.isFinite(f.odds?.[side]) ? f.odds[side] : null;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const comments = [
    line('Prediction channels', f.channels),
    line('Best predictors (the best return over the last 50 events)', f.best),
    line('Best favourite predictors', f.fav),
    line('Best underdog predictors', f.dog),
    f.bestMethods ? `${f.bestMethods}` : null,
    Number.isFinite(f.odds?.a) && Number.isFinite(f.odds?.b) ? `Average odds when counted: ${f.a} ${signed(f.odds.a)}, ${f.b} ${signed(f.odds.b)}` : null,
  ].filter(Boolean);
  return { side, name, other, pct, tier: pct >= TRACKER_STRONG ? 'strong' : pct >= TRACKER_LEAN ? 'lean' : 'pass', pickCount: f.channels[1], odds, comments };
}

/** A card's tracker entry as feed picks, in the engine record's shape; [] for a card not entered. */
export function trackerPicks(eventId) {
  const card = UFC_TRACKER[String(eventId)]; if (!card) return [];
  const picks = [];
  for (const f of card.fights) {
    const fight = `${f.a} vs ${f.b}`; const fightId = `tracker:${eventId}:${f.a}|${f.b}`;
    const base = { fightId, fight, avgConfidence: null, suggestedUnits: null, cardStatus: null, value: null, source: TRACKER_SOURCE };
    const ml = trackerMoneyline(f);
    if (ml) picks.push({ ...base, market: 'moneyline', marketLabel: 'Moneyline', selection: ml.name, consensusPct: ml.pct, strength: round1(ml.pct / 10), tier: ml.tier, pickCount: ml.pickCount, quotedOdds: ml.odds, comments: ml.comments });
    const total = ['a', 'b'].reduce((n, s) => n + Object.values(f.methods?.[s] ?? {}).reduce((x, y) => x + y, 0), 0);
    if (!total) continue;
    for (const s of ['a', 'b']) for (const m of ['ko', 'sub', 'dec']) {
      const n = f.methods?.[s]?.[m] ?? 0; const pct = round1((n / total) * 100);
      if (pct < TRACKER_METHOD_MIN) continue;
      const quoted = f.methodOdds?.[s]?.[m];
      picks.push({ ...base, market: 'method_of_victory', marketLabel: 'Method of victory', selection: `${f[s]} by ${METHOD_WORD[m]}`, consensusPct: pct, strength: round1(pct / 10), tier: pct >= TRACKER_METHOD_STRONG ? 'strong' : pct >= TRACKER_METHOD_LEAN ? 'lean' : 'pass', pickCount: total, quotedOdds: Number.isFinite(quoted) ? quoted : null, comments: [`${n} of ${total} method calls`] });
    }
  }
  return picks;
}

/**
 * The feed the card reads: the engine's own when it has a pick on this
 * card (`onCard`), else the tracker's entry for the card when there is
 * one, else the engine's as it came.
 */
export function withTracker(feed, event, onCard) {
  if (onCard > 0) return feed;
  const picks = trackerPicks(event?.id);
  if (!picks.length) return feed;
  const card = UFC_TRACKER[String(event.id)];
  return { at: feed?.at ?? null, generatedAt: card.at, event: event.name ?? null, totals: { picks: picks.length }, picks, source: TRACKER_SOURCE };
}
