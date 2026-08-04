/**
 * Demo slate — used only when CONFIG.WORKER_URL is empty.
 *
 * These are invented prices on real team names, shaped like genuine Odds API
 * payloads (including realistic hold and cross-book disagreement) so the engine
 * has something honest to chew on. The UI labels this DEMO everywhere it shows.
 * Never treat these numbers as real prices.
 */

const BOOKS = [
  ['draftkings', 'DraftKings'],
  ['fanduel', 'FanDuel'],
  ['betmgm', 'BetMGM'],
  ['caesars', 'Caesars'],
  ['betrivers', 'BetRivers'],
  ['espnbet', 'ESPN BET'],
];

/** Deterministic PRNG so the demo slate is varied but stable between reloads. */
function rng(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Spread prices across books with plausible, ASYMMETRIC variation.
 *
 * Real books don't drift in lockstep — they disagree by a few cents in
 * different directions, and one book usually hangs a better number on one side.
 * Symmetric drift would de-vig to an exact coin flip on every market and make
 * the whole board look like a 50/50 with zero edge.
 */
function quotes(basePrice, seed) {
  const next = rng(seed);
  const outlier = Math.floor(next() * BOOKS.length);
  return BOOKS.map((_, i) => {
    const jitter = Math.round((next() - 0.45) * 16);
    // One book per market is a genuine step better — the line-shopping target.
    const edge = i === outlier ? 12 : 0;
    return Math.round((basePrice + jitter + edge) / 5) * 5;
  });
}

function market(key, outcomes, minutesAgo) {
  return {
    key,
    last_update: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    outcomes,
  };
}

function game({ id, sport, title, hoursOut, home, away, homeML, awayML, spread, total }) {
  const homePrices = quotes(homeML, `${id}:h2h:home`);
  const awayPrices = quotes(awayML, `${id}:h2h:away`);
  const overPrices = quotes(-110, `${id}:tot:over`);
  const underPrices = quotes(-110, `${id}:tot:under`);
  const homeSpreadPrices = quotes(-110, `${id}:spr:home`);
  const awaySpreadPrices = quotes(-110, `${id}:spr:away`);

  return {
    id,
    sport_key: sport,
    sport_title: title,
    commence_time: new Date(Date.now() + hoursOut * 3600000).toISOString(),
    home_team: home,
    away_team: away,
    bookmakers: BOOKS.map(([key, bookTitle], i) => ({
      key,
      title: bookTitle,
      last_update: new Date(Date.now() - (5 + i) * 60000).toISOString(),
      markets: [
        market('h2h', [
          { name: away, price: awayPrices[i] },
          { name: home, price: homePrices[i] },
        ], 5 + i),
        market('spreads', [
          { name: away, price: awaySpreadPrices[i], point: spread },
          { name: home, price: homeSpreadPrices[i], point: -spread },
        ], 6 + i),
        market('totals', [
          { name: 'Over', price: overPrices[i], point: total },
          { name: 'Under', price: underPrices[i], point: total },
        ], 6 + i),
      ],
    })),
  };
}

export const DEMO_EVENTS = [
  game({
    id: 'demo-nfl-1', sport: 'americanfootball_nfl', title: 'NFL', hoursOut: 30,
    home: 'Kansas City Chiefs', away: 'Buffalo Bills',
    homeML: -155, awayML: 132, spread: 2.5, total: 48.5,
  }),
  game({
    id: 'demo-nfl-2', sport: 'americanfootball_nfl', title: 'NFL', hoursOut: 52,
    home: 'Philadelphia Eagles', away: 'Dallas Cowboys',
    homeML: -210, awayML: 175, spread: 4.5, total: 45.5,
  }),
  game({
    id: 'demo-nba-1', sport: 'basketball_nba', title: 'NBA', hoursOut: 6,
    home: 'Boston Celtics', away: 'New York Knicks',
    homeML: -185, awayML: 158, spread: 4.5, total: 219.5,
  }),
  game({
    id: 'demo-nba-2', sport: 'basketball_nba', title: 'NBA', hoursOut: 8,
    home: 'Denver Nuggets', away: 'Minnesota Timberwolves',
    homeML: -135, awayML: 114, spread: 2.5, total: 224.5,
  }),
  game({
    id: 'demo-mlb-1', sport: 'baseball_mlb', title: 'MLB', hoursOut: 4,
    home: 'Los Angeles Dodgers', away: 'San Diego Padres',
    homeML: -145, awayML: 122, spread: 1.5, total: 8.5,
  }),
  game({
    id: 'demo-mlb-2', sport: 'baseball_mlb', title: 'MLB', hoursOut: 5,
    home: 'New York Yankees', away: 'Baltimore Orioles',
    homeML: -168, awayML: 142, spread: 1.5, total: 9,
  }),
  game({
    id: 'demo-nhl-1', sport: 'icehockey_nhl', title: 'NHL', hoursOut: 7,
    home: 'Colorado Avalanche', away: 'Vegas Golden Knights',
    homeML: -125, awayML: 105, spread: 1.5, total: 6.5,
  }),
  game({
    id: 'demo-nhl-2', sport: 'icehockey_nhl', title: 'NHL', hoursOut: 27,
    home: 'Florida Panthers', away: 'Tampa Bay Lightning',
    homeML: -190, awayML: 160, spread: 1.5, total: 6,
  }),
];
