/**
 * Live weather for outdoor NFL/MLB venues, from the National Weather Service
 * (api.weather.gov) — a free, no-key-required official US government
 * source, confirmed reachable from a live Cloudflare Worker before this was
 * built against it (same discipline ESPN's site API taught the hard way:
 * "reachable from my machine" doesn't imply "reachable from Cloudflare's IP
 * range", and this one was checked first instead of after deploying).
 *
 * NWS only forecasts US locations, which is exactly this app's outdoor
 * footprint (NFL, MLB) — no coverage gap to work around for the sports that
 * need it. Forecasts only extend a handful of days out; a game further out
 * than NWS forecasts gets no weather bullet at all, not a guessed one.
 *
 * Domed stadiums are never fetched for weather — conditions inside a sealed
 * building aren't a betting signal. Retractable-roof stadiums still get a
 * forecast, but the bullet says plainly that whether the roof is actually
 * open for this specific game isn't knowable in advance from any source
 * this app has — that's an operations decision teams announce day-of, not
 * something derivable from a weather API.
 *
 * The venue table below (city, coordinates, roof type) is static and
 * manually maintained, the same kind of fragile-but-necessary mapping as
 * context.js's ESPN league-path table — a team relocating or a stadium
 * getting a roof retrofit will make an entry stale until this file is
 * updated by hand. Last checked current as of the 2025 season.
 */

const NWS_UA = 'PixelPick/1.0 (github.com/miguelsgarcia4/PerpetualCode; contact via repo issues)';
const POINTS_TTL = 3600 * 24 * 7; // a venue's forecast grid location never changes
const FORECAST_TTL = 3600; // NWS refreshes its hourly forecast roughly hourly

/** roof: 'outdoor' | 'dome' | 'retractable'. Coordinates are the stadium's own. */
export const NFL_VENUES = {
  'Arizona Cardinals': { lat: 33.5276, lon: -112.2626, roof: 'retractable' },
  'Atlanta Falcons': { lat: 33.7554, lon: -84.4009, roof: 'dome' },
  'Baltimore Ravens': { lat: 39.2780, lon: -76.6227, roof: 'outdoor' },
  'Buffalo Bills': { lat: 42.7738, lon: -78.7870, roof: 'outdoor' },
  'Carolina Panthers': { lat: 35.2258, lon: -80.8528, roof: 'outdoor' },
  'Chicago Bears': { lat: 41.8623, lon: -87.6167, roof: 'outdoor' },
  'Cincinnati Bengals': { lat: 39.0955, lon: -84.5160, roof: 'outdoor' },
  'Cleveland Browns': { lat: 41.5061, lon: -81.6995, roof: 'outdoor' },
  'Dallas Cowboys': { lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  'Denver Broncos': { lat: 39.7439, lon: -105.0201, roof: 'outdoor' },
  'Detroit Lions': { lat: 42.3400, lon: -83.0456, roof: 'dome' },
  'Green Bay Packers': { lat: 44.5013, lon: -88.0622, roof: 'outdoor' },
  'Houston Texans': { lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  'Indianapolis Colts': { lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  'Jacksonville Jaguars': { lat: 30.3239, lon: -81.6373, roof: 'outdoor' },
  'Kansas City Chiefs': { lat: 39.0489, lon: -94.4839, roof: 'outdoor' },
  'Las Vegas Raiders': { lat: 36.0909, lon: -115.1833, roof: 'dome' },
  'Los Angeles Chargers': { lat: 33.9535, lon: -118.3392, roof: 'dome' },
  'Los Angeles Rams': { lat: 33.9535, lon: -118.3392, roof: 'dome' },
  'Miami Dolphins': { lat: 25.9580, lon: -80.2389, roof: 'outdoor' },
  'Minnesota Vikings': { lat: 44.9737, lon: -93.2577, roof: 'dome' },
  'New England Patriots': { lat: 42.0909, lon: -71.2643, roof: 'outdoor' },
  'New Orleans Saints': { lat: 29.9511, lon: -90.0812, roof: 'dome' },
  'New York Giants': { lat: 40.8135, lon: -74.0745, roof: 'outdoor' },
  'New York Jets': { lat: 40.8135, lon: -74.0745, roof: 'outdoor' },
  'Philadelphia Eagles': { lat: 39.9008, lon: -75.1675, roof: 'outdoor' },
  'Pittsburgh Steelers': { lat: 40.4468, lon: -80.0158, roof: 'outdoor' },
  'San Francisco 49ers': { lat: 37.4030, lon: -121.9700, roof: 'outdoor' },
  'Seattle Seahawks': { lat: 47.5952, lon: -122.3316, roof: 'outdoor' },
  'Tampa Bay Buccaneers': { lat: 27.9759, lon: -82.5033, roof: 'outdoor' },
  'Tennessee Titans': { lat: 36.1665, lon: -86.7713, roof: 'outdoor' },
  'Washington Commanders': { lat: 38.9077, lon: -76.8645, roof: 'outdoor' },
};

export const MLB_VENUES = {
  'Arizona Diamondbacks': { lat: 33.4453, lon: -112.0667, roof: 'retractable' },
  'Atlanta Braves': { lat: 33.8908, lon: -84.4678, roof: 'outdoor' },
  'Baltimore Orioles': { lat: 39.2838, lon: -76.6216, roof: 'outdoor' },
  'Boston Red Sox': { lat: 42.3467, lon: -71.0972, roof: 'outdoor' },
  'Chicago Cubs': { lat: 41.9484, lon: -87.6553, roof: 'outdoor' },
  'Chicago White Sox': { lat: 41.8299, lon: -87.6338, roof: 'outdoor' },
  'Cincinnati Reds': { lat: 39.0975, lon: -84.5064, roof: 'outdoor' },
  'Cleveland Guardians': { lat: 41.4962, lon: -81.6852, roof: 'outdoor' },
  'Colorado Rockies': { lat: 39.7559, lon: -104.9942, roof: 'outdoor' },
  'Detroit Tigers': { lat: 42.3390, lon: -83.0485, roof: 'outdoor' },
  'Houston Astros': { lat: 29.7573, lon: -95.3555, roof: 'retractable' },
  'Kansas City Royals': { lat: 39.0517, lon: -94.4803, roof: 'outdoor' },
  'Los Angeles Angels': { lat: 33.8003, lon: -117.8827, roof: 'outdoor' },
  'Los Angeles Dodgers': { lat: 34.0739, lon: -118.2400, roof: 'outdoor' },
  'Miami Marlins': { lat: 25.7781, lon: -80.2196, roof: 'retractable' },
  'Milwaukee Brewers': { lat: 43.0280, lon: -87.9712, roof: 'retractable' },
  'Minnesota Twins': { lat: 44.9817, lon: -93.2776, roof: 'outdoor' },
  'New York Mets': { lat: 40.7571, lon: -73.8458, roof: 'outdoor' },
  'New York Yankees': { lat: 40.8296, lon: -73.9262, roof: 'outdoor' },
  'Athletics': { lat: 38.5802, lon: -121.5137, roof: 'outdoor' },
  'Philadelphia Phillies': { lat: 39.9061, lon: -75.1665, roof: 'outdoor' },
  'Pittsburgh Pirates': { lat: 40.4469, lon: -80.0057, roof: 'outdoor' },
  'San Diego Padres': { lat: 32.7073, lon: -117.1566, roof: 'outdoor' },
  'San Francisco Giants': { lat: 37.7786, lon: -122.3893, roof: 'outdoor' },
  'Seattle Mariners': { lat: 47.5914, lon: -122.3325, roof: 'retractable' },
  'St. Louis Cardinals': { lat: 38.6226, lon: -90.1928, roof: 'outdoor' },
  'Tampa Bay Rays': { lat: 27.9683, lon: -82.6534, roof: 'outdoor' },
  'Texas Rangers': { lat: 32.7473, lon: -97.0842, roof: 'retractable' },
  'Toronto Blue Jays': { lat: 43.6414, lon: -79.3894, roof: 'retractable' },
  'Washington Nationals': { lat: 38.8730, lon: -77.0074, roof: 'outdoor' },
};

const VENUES_BY_SPORT = {
  americanfootball_nfl: NFL_VENUES,
  baseball_mlb: MLB_VENUES,
};

export const hasVenue = (sportKey) => Boolean(VENUES_BY_SPORT[sportKey]);

/** Cache-through JSON fetch, keyed on the upstream URL. */
async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/nws/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, {
    headers: { 'User-Agent': NWS_UA, Accept: 'application/geo+json' },
  });
  if (!response.ok) return null;

  const body = await response.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: { 'Content-Type': 'application/geo+json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  try { return JSON.parse(body); } catch { return null; }
}

/** The hourly forecast period whose window covers `atMs`, or null if the
 * forecast doesn't reach that far — a genuinely different case from a
 * fetch failure, and treated as "nothing to say" rather than an error. */
export function periodCovering(periods, atMs) {
  return periods?.find((p) => {
    const start = Date.parse(p.startTime);
    const end = Date.parse(p.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && atMs >= start && atMs < end;
  }) ?? null;
}

/**
 * Forecast for one outdoor/retractable NFL or MLB venue at game time, or
 * null when the venue is domed, unknown, or the game is further out than
 * NWS forecasts reach.
 */
export async function fetchWeather({ sportKey, homeTeam, commenceMs }, ctx) {
  const venues = VENUES_BY_SPORT[sportKey];
  const venue = venues?.[homeTeam];
  if (!venue || venue.roof === 'dome') return null;

  try {
    const points = await cachedJson(
      `https://api.weather.gov/points/${venue.lat},${venue.lon}`, POINTS_TTL, ctx,
    );
    const forecastUrl = points?.properties?.forecastHourly;
    if (!forecastUrl) return null;

    const forecast = await cachedJson(forecastUrl, FORECAST_TTL, ctx);
    const period = periodCovering(forecast?.properties?.periods, commenceMs);
    if (!period) return null;

    return {
      roof: venue.roof,
      shortForecast: period.shortForecast ?? null,
      temperatureF: period.temperature ?? null,
      windSpeed: period.windSpeed ?? null,
      windDirection: period.windDirection ?? null,
      precipChance: period.probabilityOfPrecipitation?.value ?? null,
    };
  } catch {
    return null; // Weather is a bonus bullet, not a blocker for the rest of the card.
  }
}
