/**
 * Player search (2026-10-28 direction, the way breakingballssports.io
 * does it): any NBA or NFL player by name as the user types, then a stat
 * and a number, and his game log at that number. Reads the runner's
 * ESPN bundle (worker/src/espn-bundle.js): the league's player index for
 * the type-ahead, the player's team record for the log. No odds credits.
 */
import { NBA_TREND_MARKETS, basketballStatRows } from './basketball-props.js';
import { NFL_TREND_MARKETS, gamelogStatIndex } from './football-props.js';
import { seasonColumnRows } from '../../docs/prop-legs.js';
import { bundlePlayer, playersIndexKey } from './espn-bundle.js';

/** The stats a player can be searched on, per league: each Trends stat once, by its plain market name. */
export function playerStats(sportKey) {
  const markets = sportKey === 'basketball_nba' ? NBA_TREND_MARKETS : sportKey === 'americanfootball_nfl' ? NFL_TREND_MARKETS : null;
  if (!markets) return [];
  const seen = new Map();
  for (const m of Object.values(markets)) {
    if (seen.has(m.stat)) continue;
    seen.set(m.stat, { key: m.stat, label: m.marketLabel.replace(/\s*\(alt\)$/i, ''), short: m.label });
  }
  return [...seen.values()];
}

/** The league's player index as the runner wrote it, or an empty list. */
export async function getPlayerIndex(env, sportKey) {
  const raw = await env.POTD_KV.get(playersIndexKey(sportKey)).catch(() => null);
  if (!raw) return { sportKey, builtAt: null, players: [] };
  try { return JSON.parse(raw); } catch { return { sportKey, builtAt: null, players: [] }; }
}

/**
 * The player's per-game values of `stat`, every season the bundle
 * holds, most recent first: value, date, season, season type, opponent,
 * home or away, result and score. Null when the bundle has no such
 * player or the stat is not in his log.
 */
export async function getPlayerLog(env, sportKey, team, athleteId, stat) {
  const player = await bundlePlayer(env, sportKey, team, athleteId);
  if (!player?.log) return null;
  const rows = sportKey === 'basketball_nba'
    ? basketballStatRows(player.log, stat, { allSeasons: true })
    : seasonColumnRows(player.log, gamelogStatIndex(player.log, stat), { allSeasons: true });
  return {
    player: { id: player.id, name: player.name, team: String(team).toUpperCase(), position: player.position ?? null, injuries: player.injuries ?? [] },
    stat,
    rows: rows.map((r) => ({ value: r.value, date: r.date, season: r.season, seasonType: r.seasonType ?? null, opponent: r.opponent ?? null, atVs: r.atVs ?? null, result: r.result ?? null, score: r.score ?? null })),
  };
}
