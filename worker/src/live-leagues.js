/**
 * The leagues the Live tab knows, by the watcher's short id, and the odds
 * feed's sport key behind each: shared by the probe (worker/src/live-probe.js)
 * and the board (worker/src/live-board.js), which import each other and so
 * cannot own this between them.
 */
/** Soccer leagues on the Live tab: the game lines read in play, and the props the feed posts for the domestic leagues. */
export const SOCCER_LIVE = { ucl: 'soccer_uefa_champs_league', epl: 'soccer_epl', laliga: 'soccer_spain_la_liga', seriea: 'soccer_italy_serie_a', bundesliga: 'soccer_germany_bundesliga', ligue1: 'soccer_france_ligue_one' };
export const LIVE_SPORT = { nfl: 'americanfootball_nfl', nba: 'basketball_nba', nhl: 'icehockey_nhl', ...SOCCER_LIVE };
export const isSoccer = (league) => Object.hasOwn(SOCCER_LIVE, league);
