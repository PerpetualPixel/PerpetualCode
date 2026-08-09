/**
 * NCAAF Power 4 conference membership — SEC, Big Ten, ACC, Big 12.
 *
 * Pure functions only, same boundary as every other docs/ module.
 *
 * Pulled live from ESPN's own standings endpoint for the current season
 * (confirmed against the conversation that added this — 67 teams across
 * the four conferences) rather than typed from memory, because conference
 * realignment has been real and recent: the Pac-12 collapsed to 2 teams
 * (Oregon State, Washington State — both excluded here, since a 2-team
 * conference isn't a "power conference" in any meaningful sense anymore),
 * and members like SMU, Cal, Stanford (-> ACC), Oregon, Washington, UCLA,
 * USC (-> Big Ten), and Arizona, Colorado, Utah (-> Big 12) all moved
 * conferences in the last two realignment cycles. A remembered list would
 * likely be wrong in exactly the way this app's own "verify, don't assume"
 * pattern exists to catch.
 *
 * "Power 4/5" in the original spec reflects this transition — this app
 * treats it as today's real Power 4 (no fifth power conference exists any
 * more). Notre Dame (an FBS Independent, not in any of these four) is
 * excluded by that same literal reading, despite being widely considered
 * power-conference-caliber; revisit if that's not the intent.
 */

const POWER4_TEAMS = new Set([
  // ACC
  'miami hurricanes', 'virginia cavaliers', 'smu mustangs', 'georgia tech yellow jackets',
  'louisville cardinals', 'wake forest demon deacons', 'duke blue devils', 'pittsburgh panthers',
  'nc state wolfpack', 'california golden bears', 'clemson tigers', 'florida state seminoles',
  'stanford cardinal', 'north carolina tar heels', 'virginia tech hokies', 'syracuse orange',
  'boston college eagles',
  // Big 12
  'texas tech red raiders', 'byu cougars', 'utah utes', 'houston cougars', 'arizona wildcats',
  'tcu horned frogs', 'iowa state cyclones', 'arizona state sun devils', 'cincinnati bearcats',
  'kansas state wildcats', 'baylor bears', 'kansas jayhawks', 'ucf knights',
  'west virginia mountaineers', 'colorado buffaloes', 'oklahoma state cowboys',
  // Big Ten
  'indiana hoosiers', 'oregon ducks', 'ohio state buckeyes', 'usc trojans', 'michigan wolverines',
  'iowa hawkeyes', 'illinois fighting illini', 'minnesota golden gophers', 'nebraska cornhuskers',
  'northwestern wildcats', 'penn state nittany lions', 'rutgers scarlet knights',
  'wisconsin badgers', 'michigan state spartans', 'maryland terrapins', 'ucla bruins',
  'purdue boilermakers', 'washington huskies',
  // SEC
  'ole miss rebels', 'georgia bulldogs', 'texas a&m aggies', 'texas longhorns',
  'oklahoma sooners', 'vanderbilt commodores', 'alabama crimson tide', 'missouri tigers',
  'tennessee volunteers', 'lsu tigers', 'kentucky wildcats', 'auburn tigers',
  'mississippi state bulldogs', 'florida gators', 'south carolina gamecocks', 'arkansas razorbacks',
]);

function normalize(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

export function isPower4Team(teamName) {
  return POWER4_TEAMS.has(normalize(teamName));
}

/**
 * Whether a matchup is Power 4 vs. Power 4 — both sides, not just one.
 * A Power 4 team's early-season buy game against a Group-of-5 or FCS
 * opponent is exactly the lopsided, high-variance matchup this app's whole
 * low-variance framing exists to avoid, so one side clearing the bar isn't
 * enough.
 */
export function isPower4Matchup(homeTeam, awayTeam) {
  return isPower4Team(homeTeam) && isPower4Team(awayTeam);
}
