/**
 * Grading from the box score. ESPN's athlete game log leaves out the
 * games a player sat, so a grader reading only the log cannot tell "not
 * posted yet" from "did not play" and waits its whole window before
 * voiding (the Oct 30, 2026 ticket sat "In play" a day and a half). The
 * runner (scripts/espn-bundle.mjs --injuries) reads each open leg's game
 * off the day's scoreboard once it is final, takes the player's line
 * from the box score, and writes it under boxKey; the worker's grader
 * (trend-picks.js's actualFor) reads that before the game log. A player
 * missing from a final box score, or listed as did-not-play, is a
 * no-show and his leg is void on the spot.
 */

/** The box lines the runner wrote for a league's game date: { sportKey, gameDate, at, legs: { '<athleteId>:<statKey>': { value, dnp, eventId, at } } }. */
export const boxKey = (sportKey, gameDate) => `trendpicks:box:${sportKey}:${gameDate}`;
export const boxLegKey = (athleteId, statKey) => `${athleteId}:${statKey}`;

/** The scoreboard event one of whose teams is the abbreviation, or null. */
export function findBoxEvent(scoreboard, teamAbbr) {
  const want = String(teamAbbr ?? '').toUpperCase();
  if (!want) return null;
  for (const e of scoreboard?.events ?? []) {
    const comp = e?.competitions?.[0];
    if ((comp?.competitors ?? []).some((c) => String(c?.team?.abbreviation ?? '').toUpperCase() === want)) return e;
  }
  return null;
}

/** True once the event is over (status state "post" or completed). */
export const eventFinal = (event) => Boolean(event?.status?.type?.completed || event?.status?.type?.state === 'post' || event?.competitions?.[0]?.status?.type?.completed);

/**
 * One athlete's line from a game summary's box score: every statistics
 * block he appears in, merged into one { key: value } map, with the box
 * keys ESPN uses (points, rebounds, "fieldGoalsMade-fieldGoalsAttempted",
 * passingYards, "completions/passingAttempts", …). { found: false } when
 * he is in no block; dnp when every block lists him as did-not-play.
 */
export function boxLine(summary, athleteId) {
  const id = String(athleteId ?? '');
  // A soccer summary lists each side's roster with stats as { name, value } pairs; a player with no appearance did not play.
  if (Array.isArray(summary?.rosters) && !summary?.boxscore?.players?.length) {
    for (const side of summary.rosters) {
      for (const p of side?.roster ?? []) {
        if (String(p?.athlete?.id ?? '') !== id) continue;
        const stats = {};
        for (const s of p.stats ?? []) if (s?.name && s.value != null) stats[s.name] = String(s.value);
        const played = p.starter === true || p.subbedIn === true || Number(stats.appearances ?? 0) > 0;
        return { found: true, dnp: !played, reason: played ? null : 'did not play', stats };
      }
    }
    return { found: false, dnp: true, reason: 'not in the box score', stats: {} };
  }
  const stats = {};
  let found = false;
  let played = false;
  let reason = null;
  for (const team of summary?.boxscore?.players ?? []) {
    for (const block of team?.statistics ?? []) {
      const keys = Array.isArray(block?.keys) && block.keys.length ? block.keys : (block?.names ?? []);
      for (const a of block?.athletes ?? []) {
        if (String(a?.athlete?.id ?? '') !== id) continue;
        found = true;
        if (a.didNotPlay) { reason = reason ?? (a.reason || 'did not play'); continue; }
        played = true;
        keys.forEach((k, i) => { if (a.stats?.[i] != null && a.stats[i] !== '') stats[k] = String(a.stats[i]); });
      }
    }
  }
  if (!found) return { found: false, dnp: true, reason: 'not in the box score', stats: {} };
  return { found: true, dnp: !played, reason: played ? null : reason, stats };
}

const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const part = (v, i, sep) => (v == null ? null : num(String(v).split(sep)[i]));
const NBA_BOX = {
  points: (s) => num(s.points),
  rebounds: (s) => num(s.rebounds ?? s.totalRebounds),
  assists: (s) => num(s.assists),
  blocks: (s) => num(s.blocks),
  steals: (s) => num(s.steals),
  turnovers: (s) => num(s.turnovers),
  minutes: (s) => num(s.minutes),
  threes: (s) => part(s['threePointFieldGoalsMade-threePointFieldGoalsAttempted'], 0, '-'),
  fgm: (s) => part(s['fieldGoalsMade-fieldGoalsAttempted'], 0, '-'),
  ftm: (s) => part(s['freeThrowsMade-freeThrowsAttempted'], 0, '-'),
};
const NBA_COMBO = { pra: ['points', 'rebounds', 'assists'], pr: ['points', 'rebounds'], pa: ['points', 'assists'], ra: ['rebounds', 'assists'], stocks: ['blocks', 'steals'] };
// A player in the game with no block for a category (a receiver who never ran) recorded zero of it.
const NFL_BOX = {
  passYds: (s) => num(s.passingYards) ?? 0,
  rushYds: (s) => num(s.rushingYards) ?? 0,
  recYds: (s) => num(s.receivingYards) ?? 0,
  receptions: (s) => num(s.receptions) ?? 0,
  passCompletions: (s) => part(s['completions/passingAttempts'], 0, '/') ?? num(s.completions) ?? 0,
  passAttempts: (s) => part(s['completions/passingAttempts'], 1, '/') ?? num(s.passingAttempts) ?? 0,
  passTds: (s) => num(s.passingTouchdowns) ?? 0,
  rushAttempts: (s) => num(s.rushingAttempts) ?? 0,
  targets: (s) => num(s.receivingTargets ?? s.targets) ?? 0,
  anyTd: (s) => (num(s.rushingTouchdowns) ?? 0) + (num(s.receivingTouchdowns) ?? 0),
};

// Skaters sit in the forwards and defenses blocks (shotsTotal is shots on goal; the "SOG"-labelled column is shootout goals),
// goalies in their own block with saves. Points are goals + assists: the box has no points column.
// A column the block does not carry (a goalie has no shots, a skater no saves) reads null, never zero.
const col = (s, k) => (s[k] == null ? null : num(s[k]));
const NHL_BOX = {
  shots: (s) => col(s, 'shotsTotal'),
  goals: (s) => col(s, 'goals'),
  assists: (s) => col(s, 'assists'),
  points: (s) => { const g = col(s, 'goals'); const a = col(s, 'assists'); return g != null && a != null ? g + a : null; },
  saves: (s) => col(s, 'saves'),
};

// Soccer: a played line carries every column, so a missing one reads zero (a sub who never shot).
const SOCCER_BOX = {
  shots: (s) => num(s.totalShots) ?? 0,
  shotsOnTarget: (s) => num(s.shotsOnTarget) ?? 0,
  assists: (s) => num(s.goalAssists) ?? 0,
  goals: (s) => num(s.totalGoals) ?? 0,
};

/** The stat a leg settles on, from a played line's stats, or null when the box does not carry it. */
export function boxActual(line, sportKey, statKey) {
  if (!line || line.dnp) return null;
  const s = line.stats ?? {};
  if (sportKey === 'basketball_nba') {
    const parts = NBA_COMBO[statKey];
    if (parts) { const vals = parts.map((p) => NBA_BOX[p](s)); return vals.every((v) => v != null) ? vals.reduce((a, b) => a + b, 0) : null; }
    return NBA_BOX[statKey] ? NBA_BOX[statKey](s) : null;
  }
  if (sportKey === 'americanfootball_nfl') return NFL_BOX[statKey] ? NFL_BOX[statKey](s) : null;
  if (sportKey === 'icehockey_nhl') return NHL_BOX[statKey] ? NHL_BOX[statKey](s) : null;
  if (String(sportKey).startsWith('soccer_')) return SOCCER_BOX[statKey] ? SOCCER_BOX[statKey](s) : null;
  return null;
}
