/**
 * Team logos via ESPN's public image CDN — no scraping, no worker call.
 *
 * `https://a.espncdn.com/i/teamlogos/{sport}/500/{abbr}.png` is a stable,
 * directly-linkable URL pattern (confirmed live for nfl/nba/mlb/nhl before
 * writing this) — a different host from cdn.espn.com's JSON pages and from
 * site.api.espn.com, and unrelated to either one's Cloudflare-Worker
 * blocking, since the client's own browser loads this image directly, not
 * the worker. Each map below was pulled from ESPN's own live team list per
 * league, not typed from memory — abbreviations are exactly what ESPN uses
 * for that team today.
 */

const ESPN_LOGO_BASE = 'https://a.espncdn.com/i/teamlogos';

const NFL = {
  'arizona cardinals': 'ari', 'atlanta falcons': 'atl', 'baltimore ravens': 'bal',
  'buffalo bills': 'buf', 'carolina panthers': 'car', 'chicago bears': 'chi',
  'cincinnati bengals': 'cin', 'cleveland browns': 'cle', 'dallas cowboys': 'dal',
  'denver broncos': 'den', 'detroit lions': 'det', 'green bay packers': 'gb',
  'houston texans': 'hou', 'indianapolis colts': 'ind', 'jacksonville jaguars': 'jax',
  'kansas city chiefs': 'kc', 'las vegas raiders': 'lv', 'los angeles chargers': 'lac',
  'los angeles rams': 'lar', 'miami dolphins': 'mia', 'minnesota vikings': 'min',
  'new england patriots': 'ne', 'new orleans saints': 'no', 'new york giants': 'nyg',
  'new york jets': 'nyj', 'philadelphia eagles': 'phi', 'pittsburgh steelers': 'pit',
  'san francisco 49ers': 'sf', 'seattle seahawks': 'sea', 'tampa bay buccaneers': 'tb',
  'tennessee titans': 'ten', 'washington commanders': 'wsh',
};

const NBA = {
  'atlanta hawks': 'atl', 'boston celtics': 'bos', 'brooklyn nets': 'bkn',
  'charlotte hornets': 'cha', 'chicago bulls': 'chi', 'cleveland cavaliers': 'cle',
  'dallas mavericks': 'dal', 'denver nuggets': 'den', 'detroit pistons': 'det',
  'golden state warriors': 'gs', 'houston rockets': 'hou', 'indiana pacers': 'ind',
  'la clippers': 'lac', 'los angeles clippers': 'lac', 'los angeles lakers': 'lal',
  'memphis grizzlies': 'mem', 'miami heat': 'mia', 'milwaukee bucks': 'mil',
  'minnesota timberwolves': 'min', 'new orleans pelicans': 'no', 'new york knicks': 'ny',
  'oklahoma city thunder': 'okc', 'orlando magic': 'orl', 'philadelphia 76ers': 'phi',
  'phoenix suns': 'phx', 'portland trail blazers': 'por', 'sacramento kings': 'sac',
  'san antonio spurs': 'sa', 'toronto raptors': 'tor', 'utah jazz': 'utah',
  'washington wizards': 'wsh',
};

const MLB = {
  'arizona diamondbacks': 'ari', 'athletics': 'ath', 'oakland athletics': 'ath',
  'atlanta braves': 'atl', 'baltimore orioles': 'bal', 'boston red sox': 'bos',
  'chicago cubs': 'chc', 'chicago white sox': 'chw', 'cincinnati reds': 'cin',
  'cleveland guardians': 'cle', 'colorado rockies': 'col', 'detroit tigers': 'det',
  'houston astros': 'hou', 'kansas city royals': 'kc', 'los angeles angels': 'laa',
  'los angeles dodgers': 'lad', 'miami marlins': 'mia', 'milwaukee brewers': 'mil',
  'minnesota twins': 'min', 'new york mets': 'nym', 'new york yankees': 'nyy',
  'philadelphia phillies': 'phi', 'pittsburgh pirates': 'pit', 'san diego padres': 'sd',
  'san francisco giants': 'sf', 'seattle mariners': 'sea', 'st. louis cardinals': 'stl',
  'st louis cardinals': 'stl', 'tampa bay rays': 'tb', 'texas rangers': 'tex',
  'toronto blue jays': 'tor', 'washington nationals': 'wsh',
};

const NHL = {
  'anaheim ducks': 'ana', 'boston bruins': 'bos', 'buffalo sabres': 'buf',
  'calgary flames': 'cgy', 'carolina hurricanes': 'car', 'chicago blackhawks': 'chi',
  'colorado avalanche': 'col', 'columbus blue jackets': 'cbj', 'dallas stars': 'dal',
  'detroit red wings': 'det', 'edmonton oilers': 'edm', 'florida panthers': 'fla',
  'los angeles kings': 'la', 'minnesota wild': 'min', 'montreal canadiens': 'mtl',
  'nashville predators': 'nsh', 'new jersey devils': 'nj', 'new york islanders': 'nyi',
  'new york rangers': 'nyr', 'ottawa senators': 'ott', 'philadelphia flyers': 'phi',
  'pittsburgh penguins': 'pit', 'san jose sharks': 'sj', 'seattle kraken': 'sea',
  'st. louis blues': 'stl', 'st louis blues': 'stl', 'tampa bay lightning': 'tb',
  'toronto maple leafs': 'tor', 'utah mammoth': 'utah', 'vancouver canucks': 'van',
  'vegas golden knights': 'vgk', 'washington capitals': 'wsh', 'winnipeg jets': 'wpg',
};

// Pulled live from ESPN's own /teams endpoint, not typed from memory —
// includes the 2026-season expansion franchises (Golden State Valkyries,
// Portland Fire, Toronto Tempo), which an older/remembered list would miss.
const WNBA = {
  'atlanta dream': 'atl', 'chicago sky': 'chi', 'connecticut sun': 'con',
  'dallas wings': 'dal', 'golden state valkyries': 'gs', 'indiana fever': 'ind',
  'las vegas aces': 'lv', 'los angeles sparks': 'la', 'minnesota lynx': 'min',
  'new york liberty': 'ny', 'phoenix mercury': 'phx', 'portland fire': 'por',
  'seattle storm': 'sea', 'toronto tempo': 'tor', 'washington mystics': 'wsh',
};

// The Odds API's sport_key -> ESPN's logo-path sport segment and this
// module's abbreviation map.
const LEAGUES = {
  americanfootball_nfl: { path: 'nfl', teams: NFL },
  basketball_nba: { path: 'nba', teams: NBA },
  basketball_wnba: { path: 'wnba', teams: WNBA },
  baseball_mlb: { path: 'mlb', teams: MLB },
  icehockey_nhl: { path: 'nhl', teams: NHL },
};

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A team's ESPN crest, or null when the sport isn't one of the four covered
 * here (tennis, MMA, soccer) or the name didn't match — never a guessed or
 * generic placeholder image standing in for a real crest.
 */
/**
 * A team's ESPN abbreviation for one of the five leagues mapped above, or
 * null when the sport isn't covered or the name didn't match. Exported so
 * worker/src/*-props.js's ESPN schedule/boxscore lookups (which key off
 * this abbreviation, not the full team name The Odds API hands back) reuse
 * this one real, live-sourced map per league instead of retyping it.
 */
export function espnAbbr(sportKey, teamName) {
  const league = LEAGUES[sportKey];
  if (!league) return null;
  return league.teams[fold(teamName)] ?? null;
}

export function teamLogoUrl(sportKey, teamName) {
  const league = LEAGUES[sportKey];
  if (!league) return null;
  const abbr = league.teams[fold(teamName)];
  return abbr ? `${ESPN_LOGO_BASE}/${league.path}/500/${abbr}.png` : null;
}
