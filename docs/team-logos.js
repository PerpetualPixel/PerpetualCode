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

/**
 * Soccer: ESPN keys a club by a numeric id (the roster and the logo take
 * the id, not the abbreviation), so each map carries the abbreviation the
 * cards show and SOCCER_IDS carries the id behind it. Names fold the way
 * the odds feed and ESPN each write them; the extra keys are the feed's
 * spellings where they differ from ESPN's.
 */
const EPL = {
  'afc bournemouth': 'bou', 'bournemouth': 'bou', 'arsenal': 'ars', 'aston villa': 'avl', 'brentford': 'bre',
  'brighton hove albion': 'bha', 'brighton and hove albion': 'bha', 'brighton': 'bha', 'chelsea': 'che', 'coventry city': 'cov',
  'crystal palace': 'cry', 'everton': 'eve', 'fulham': 'ful', 'hull city': 'hul', 'ipswich town': 'ips', 'leeds united': 'lee',
  'liverpool': 'liv', 'manchester city': 'mnc', 'manchester united': 'man', 'newcastle united': 'new', 'nottingham forest': 'nfo',
  'sunderland': 'sun', 'tottenham hotspur': 'tot', 'tottenham': 'tot',
};
const LA_LIGA = {
  'alaves': 'ala', 'deportivo alaves': 'ala', 'athletic club': 'ath', 'athletic bilbao': 'ath', 'atletico madrid': 'atm', 'barcelona': 'bar',
  'fc barcelona': 'bar', 'celta vigo': 'cel', 'deportivo': 'dep', 'deportivo la coruna': 'dep', 'elche': 'elc', 'elche cf': 'elc', 'espanyol': 'esp', 'getafe': 'get',
  'levante': 'lev', 'malaga': 'mcf', 'osasuna': 'osa', 'ca osasuna': 'osa', 'racing santander': 'rac', 'racing club de santander': 'rac', 'real racing club de santander': 'rac', 'rayo vallecano': 'ray', 'real betis': 'bet', 'real madrid': 'rma',
  'real sociedad': 'rso', 'sevilla': 'sev', 'valencia': 'val', 'villarreal': 'vil',
};
const SERIE_A = {
  'ac milan': 'mil', 'milan': 'mil', 'as roma': 'roma', 'roma': 'roma', 'atalanta': 'ata', 'atalanta bc': 'ata', 'bologna': 'bol', 'cagliari': 'cag',
  'como': 'como', 'fiorentina': 'fio', 'frosinone': 'fro', 'genoa': 'gen', 'internazionale': 'int', 'inter milan': 'int', 'inter': 'int',
  'juventus': 'juv', 'lazio': 'laz', 'lecce': 'lec', 'monza': 'mon', 'napoli': 'nap', 'parma': 'par', 'sassuolo': 'sas', 'torino': 'tor',
  'udinese': 'udi', 'venezia': 'ven',
};
const BUNDESLIGA = {
  '1 fc union berlin': 'fcu', 'union berlin': 'fcu', 'bayer leverkusen': 'b04', 'bayern munich': 'mun', 'fc bayern munich': 'mun',
  'borussia dortmund': 'dor', 'borussia monchengladbach': 'bmg', 'eintracht frankfurt': 'sge', 'fc augsburg': 'fca', 'augsburg': 'fca',
  'fc cologne': 'koe', '1 fc koln': 'koe', 'fc koln': 'koe', 'hamburg sv': 'hsv', 'hamburger sv': 'hsv', 'mainz': 'm05', 'fsv mainz 05': 'm05',
  'mainz 05': 'm05', 'rb leipzig': 'rbl', 'sc freiburg': 'scf', 'freiburg': 'scf', 'sc paderborn 07': 'scp', 'sc paderborn': 'scp', 'paderborn': 'scp',
  'sv elversberg': 'elv', 'elversberg': 'elv', 'schalke 04': 's04', 'fc schalke 04': 's04', 'tsg hoffenheim': 'tsg', 'hoffenheim': 'tsg',
  'vfb stuttgart': 'vfb', 'werder bremen': 'svw',
};
const LIGUE_1 = {
  'aj auxerre': 'aux', 'auxerre': 'aux', 'as monaco': 'mon', 'monaco': 'mon', 'angers': 'ang', 'angers sco': 'ang', 'brest': 'bre',
  'stade brestois': 'bre', 'le havre ac': 'hac', 'le havre': 'hac', 'le mans': 'mns', 'lens': 'rcl', 'rc lens': 'rcl', 'lille': 'lill',
  'losc lille': 'lill', 'lorient': 'lor', 'fc lorient': 'lor', 'lyon': 'lyon', 'olympique lyonnais': 'lyon', 'marseille': 'olm',
  'olympique marseille': 'olm', 'nice': 'nice', 'ogc nice': 'nice', 'paris fc': 'par', 'paris saint germain': 'psg', 'psg': 'psg',
  'stade rennais': 'ren', 'rennes': 'ren', 'strasbourg': 'str', 'rc strasbourg': 'str', 'toulouse': 'tou', 'troyes': 'try',
};
const CHAMPIONS_LEAGUE = {
  'aek athens': 'aek', 'as roma': 'roma', 'roma': 'roma', 'arsenal': 'ars', 'aston villa': 'avl', 'atletico madrid': 'atm', 'barcelona': 'bar',
  'fc barcelona': 'bar', 'bayern munich': 'mun', 'fc bayern munich': 'mun', 'bodo glimt': 'bodo', 'borussia dortmund': 'dor', 'club brugge': 'bru',
  'como': 'como', 'fc porto': 'fcp', 'porto': 'fcp', 'fenerbahce': 'fen', 'feyenoord rotterdam': 'fey', 'feyenoord': 'fey', 'galatasaray': 'gal',
  'internazionale': 'int', 'inter milan': 'int', 'inter': 'int', 'lask linz': 'las', 'lask': 'las', 'lens': 'rcl', 'rc lens': 'rcl', 'lille': 'lill',
  'losc lille': 'lill', 'liverpool': 'liv', 'manchester city': 'mnc', 'manchester united': 'man', 'napoli': 'nap', 'psv eindhoven': 'psv', 'psv': 'psv',
  'paris saint germain': 'psg', 'psg': 'psg', 'rb leipzig': 'rbl', 'real betis': 'bet', 'real madrid': 'rma', 'sabah fk': 'sab', 'sabah': 'sab',
  'shakhtar donetsk': 'shk', 'slavia prague': 'slp', 'slovan bratislava': 'slb', 'sporting cp': 'scp', 'sporting lisbon': 'scp', 'vfb stuttgart': 'vfb',
  'viking fk': 'vfk', 'viking': 'vfk', 'villarreal': 'vil',
};
/** ESPN team ids behind the soccer abbreviations, per league (the roster and the logo take the id). */
export const SOCCER_IDS = {
  soccer_epl: { bou: 349, ars: 359, avl: 362, bre: 337, bha: 331, che: 363, cov: 388, cry: 384, eve: 368, ful: 370, hul: 306, ips: 373, lee: 357, liv: 364, mnc: 382, man: 360, new: 361, nfo: 393, sun: 366, tot: 367 },
  soccer_spain_la_liga: { ala: 96, ath: 93, atm: 1068, bar: 83, cel: 85, dep: 90, elc: 3751, esp: 88, get: 2922, lev: 1538, mcf: 99, osa: 97, rac: 87, ray: 101, bet: 244, rma: 86, rso: 89, sev: 243, val: 94, vil: 102 },
  soccer_italy_serie_a: { mil: 103, roma: 104, ata: 105, bol: 107, cag: 2925, como: 2572, fio: 109, fro: 4057, gen: 3263, int: 110, juv: 111, laz: 112, lec: 113, mon: 4007, nap: 114, par: 115, sas: 3997, tor: 239, udi: 118, ven: 17530 },
  soccer_germany_bundesliga: { fcu: 598, b04: 131, mun: 132, dor: 124, bmg: 268, sge: 125, fca: 3841, koe: 122, hsv: 127, m05: 2950, rbl: 11420, scf: 126, scp: 3307, elv: 10388, s04: 133, tsg: 7911, vfb: 134, svw: 137 },
  soccer_france_ligue_one: { aux: 172, mon: 174, ang: 7868, bre: 6997, hac: 3236, mns: 2697, rcl: 175, lill: 166, lor: 273, lyon: 167, olm: 176, nice: 2502, par: 6851, psg: 160, ren: 169, str: 180, tou: 179, try: 170 },
  soccer_uefa_champs_league: { aek: 887, roma: 104, ars: 359, avl: 362, atm: 1068, bar: 83, mun: 132, bodo: 2980, dor: 124, bru: 570, como: 2572, fcp: 437, fen: 436, fey: 142, gal: 432, int: 110, las: 4411, rcl: 175, lill: 166, liv: 364, mnc: 382, man: 360, nap: 114, psv: 148, psg: 160, rbl: 11420, bet: 244, rma: 86, sab: 21922, shk: 493, slp: 494, slb: 521, scp: 2250, vfb: 134, vfk: 510, vil: 102 },
};
/** ESPN league slugs behind the odds feed's soccer keys. */
export const SOCCER_SLUGS = { soccer_epl: 'eng.1', soccer_spain_la_liga: 'esp.1', soccer_italy_serie_a: 'ita.1', soccer_germany_bundesliga: 'ger.1', soccer_france_ligue_one: 'fra.1', soccer_uefa_champs_league: 'uefa.champions' };
export const SOCCER_KEYS = Object.keys(SOCCER_SLUGS);
/** The ESPN team id for a soccer abbreviation in a league, or null. */
export const soccerTeamId = (sportKey, abbr) => SOCCER_IDS[sportKey]?.[String(abbr ?? '').toLowerCase()] ?? null;

const LEAGUES = {
  americanfootball_nfl: { path: 'nfl', teams: NFL },
  basketball_nba: { path: 'nba', teams: NBA },
  basketball_wnba: { path: 'wnba', teams: WNBA },
  baseball_mlb: { path: 'mlb', teams: MLB },
  icehockey_nhl: { path: 'nhl', teams: NHL },
  soccer_epl: { path: 'soccer', teams: EPL },
  soccer_spain_la_liga: { path: 'soccer', teams: LA_LIGA },
  soccer_italy_serie_a: { path: 'soccer', teams: SERIE_A },
  soccer_germany_bundesliga: { path: 'soccer', teams: BUNDESLIGA },
  soccer_france_ligue_one: { path: 'soccer', teams: LIGUE_1 },
  soccer_uefa_champs_league: { path: 'soccer', teams: CHAMPIONS_LEAGUE },
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
  if (!abbr) return null;
  // Soccer logos sit under the club id, not the abbreviation.
  if (league.path === 'soccer') { const id = soccerTeamId(sportKey, abbr); return id ? `${ESPN_LOGO_BASE}/soccer/500/${id}.png` : null; }
  return `${ESPN_LOGO_BASE}/${league.path}/500/${abbr}.png`;
}
