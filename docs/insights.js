/**
 * Pixel Pick — contextual insights.
 *
 * The odds feed carries prices and nothing else: an event is
 * { id, sport_key, sport_title, commence_time, home_team, away_team, bookmakers }.
 * Everything on a card that isn't arithmetic on those prices comes from here.
 *
 * THE RULE, and it is not negotiable: every sentence this module produces must
 * trace to a value that arrived in a payload. No inference, no "should continue
 * to dominate", no rounding a 3-1 record up to "dominant". If a fact isn't in
 * the data, the bullet is omitted — a short card is honest, an invented stat is
 * someone losing money on a number that was never real.
 *
 * Two sources, because no single one covers the board:
 *   - Team sports (NFL, MLB, NHL, NBA, soccer) via the worker's /context proxy,
 *     which reads ESPN. Gives form, injuries, head-to-head and ATS records.
 *   - Tennis via a static dataset built by scripts/build-tennis-data.mjs. ESPN's
 *     tennis athletes have no ids at all and its summary endpoint 400s, so live
 *     lookups are impossible; the season archive is the only real option.
 */

/* ------------------------------------------------------------------ */
/* Name matching                                                       */
/* ------------------------------------------------------------------ */

/** Strip accents and punctuation so "Chwalińska" and "Chwalinska" compare equal. */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tennis archives name players "Surname I.I." — "Ruse E.G.", and for compound
 * surnames "Mpetshi Perricard G.". The odds feed says "Elena Gabriela Ruse".
 * Split the archive form into its two halves so the two can be reconciled.
 */
function splitArchiveName(name) {
  const match = String(name).trim().match(/^(.+?)\s+((?:[A-Za-z]\.)+)$/);
  if (!match) return { surname: fold(name), initials: '' };
  return {
    surname: fold(match[1]),
    initials: match[2].replace(/[^A-Za-z]/g, '').toLowerCase(),
  };
}

/** True when `surname` appears as whole words inside `full`. */
function containsWords(full, surname) {
  return (
    full === surname ||
    full.startsWith(`${surname} `) ||
    full.endsWith(` ${surname}`) ||
    full.includes(` ${surname} `)
  );
}

/**
 * Resolve an odds-feed player name to an index in the archive's player list.
 * Returns null rather than a guess when nothing lines up — a wrong player's
 * head-to-head record is far worse than no head-to-head record.
 */
export function matchPlayer(oddsName, players) {
  const full = fold(oddsName);
  if (!full) return null;

  let best = null;

  players.forEach((candidate, index) => {
    const { surname, initials } = splitArchiveName(candidate);
    const display = (candidate.match(/^(.+?)\s+(?:[A-Za-z]\.)+$/) ?? [, candidate])[1];
    if (!surname || !containsWords(full, surname)) return;

    const remainder = full
      .replace(new RegExp(`(^| )${surname}( |$)`), ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    const givenInitials = remainder.map((word) => word[0]).join('');

    // Exact initials beat a first-initial match, which beats surname alone.
    // Longer surnames win ties, so "Mpetshi Perricard" outranks "Perricard".
    let score = 1;
    if (givenInitials && givenInitials === initials) score = 3;
    else if (givenInitials && initials.startsWith(givenInitials[0])) score = 2;
    score += surname.split(' ').length;

    if (!best || score > best.score) best = { index, name: candidate, display, score };
  });

  // Surname-only agreement with contradicting initials is not a match.
  return best && best.score >= 2 ? best : null;
}

/* ------------------------------------------------------------------ */
/* Tennis                                                              */
/* ------------------------------------------------------------------ */

const EPOCH_MS = Date.UTC(2000, 0, 1);
const toDayNum = (ms) => Math.round((ms - EPOCH_MS) / 86400000);

const F = { DAY: 0, SURFACE: 1, ROUND: 2, WINNER: 3, LOSER: 4, WRANK: 5, LRANK: 6, RETIRED: 7 };

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const plural = (n, word) =>
  `${n} ${word}${n === 1 ? '' : /(ch|sh|s|x|z)$/.test(word) ? 'es' : 's'}`;

const DAY_MS = 86400000;
const dayToDate = (day) => new Date(EPOCH_MS + day * DAY_MS);
const shortDate = (day) =>
  dayToDate(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The surface the tour is playing on right now, taken from the most recent
 * matches in the archive rather than from any one player's last outing. A
 * player's own last match can be months old and on a different surface — quoting
 * that record next to a hard-court fixture would be true and still misleading.
 */
function currentSurface(data, sampleSize = 40) {
  const counts = new Map();
  for (const m of data.matches.slice(-sampleSize)) {
    counts.set(m[F.SURFACE], (counts.get(m[F.SURFACE]) ?? 0) + 1);
  }
  let best = -1;
  let bestCount = 0;
  for (const [surface, count] of counts) {
    if (count > bestCount) { best = surface; bestCount = count; }
  }
  return best;
}

/** Every archived match involving a player, oldest first. */
function matchesFor(data, playerIndex, beforeDay) {
  return data.matches.filter(
    (m) =>
      m[F.DAY] < beforeDay &&
      (m[F.WINNER] === playerIndex || m[F.LOSER] === playerIndex),
  );
}

function record(matches, playerIndex) {
  let won = 0;
  for (const m of matches) if (m[F.WINNER] === playerIndex) won++;
  return { won, lost: matches.length - won, played: matches.length };
}

/**
 * Build tennis bullets for one pick.
 *
 * @param data      parsed docs/data/tennis-{atp,wta}.json
 * @param subject   the player the bet is on, as the odds feed names them
 * @param opponent  the other player
 * @param opts.now  evaluation time, so tests are deterministic
 */
export function tennisInsights(data, subject, opponent, { now = Date.now(), surface = null } = {}) {
  if (!data?.matches?.length) return [];

  const me = matchPlayer(subject, data.players);
  const them = matchPlayer(opponent, data.players);
  if (!me) return [];

  const today = toDayNum(now);
  const mine = matchesFor(data, me.index, today);
  if (!mine.length) return [];

  // Use the archive's own surname rather than the last word of the odds name,
  // so "Alex de Minaur" reads as "De Minaur" and not "Minaur".
  const myName = me.display;
  const theirName = them?.display ?? String(opponent).split(' ').slice(-1)[0] ?? opponent;
  const bullets = [];

  /* Head to head ---------------------------------------------------- */
  if (them) {
    const h2h = mine.filter(
      (m) => m[F.WINNER] === them.index || m[F.LOSER] === them.index,
    );
    if (h2h.length) {
      const { won, lost } = record(h2h, me.index);
      const last = h2h[h2h.length - 1];
      const wonLast = last[F.WINNER] === me.index;
      const lastSurface = data.surfaces[last[F.SURFACE]] ?? 'an unlisted surface';
      const seasons = data.seasons.join('–');

      bullets.push(
        won === h2h.length
          ? `${myName} has won all ${plural(h2h.length, 'meeting')} with ${theirName} across ${seasons}, most recently on ${lastSurface.toLowerCase()}.`
          : `Head-to-head across ${seasons}: ${myName} ${won}, ${theirName} ${lost}. ${wonLast ? myName : theirName} took the last meeting, on ${lastSurface.toLowerCase()}.`,
      );
    }
  }

  /* Recent form ----------------------------------------------------- */
  const RECENT = 10;
  const myRecent = mine.slice(-RECENT);
  const myForm = record(myRecent, me.index);

  if (them) {
    const theirRecent = matchesFor(data, them.index, today).slice(-RECENT);
    if (theirRecent.length) {
      const theirForm = record(theirRecent, them.index);
      bullets.push(
        `Form over the last ${RECENT} matches: ${myName} ${myForm.won}-${myForm.lost}, ${theirName} ${theirForm.won}-${theirForm.lost}.`,
      );
    } else {
      bullets.push(`${myName} is ${myForm.won}-${myForm.lost} over their last ${plural(myForm.played, 'match')}.`);
    }
  } else {
    bullets.push(`${myName} is ${myForm.won}-${myForm.lost} over their last ${plural(myForm.played, 'match')}.`);
  }

  /* Surface ---------------------------------------------------------- */
  const surfaceIndex = surface == null ? -1 : data.surfaces.indexOf(surface);
  const activeSurface = surfaceIndex >= 0 ? surfaceIndex : currentSurface(data);

  if (activeSurface >= 0) {
    const label = data.surfaces[activeSurface];
    const onSurface = mine.filter((m) => m[F.SURFACE] === activeSurface);
    if (onSurface.length >= 5) {
      const r = record(onSurface, me.index);
      let line = `On ${label.toLowerCase()}, ${myName} is ${r.won}-${r.lost} (${pct(r.won, r.played)}%) across ${data.seasons.join('–')}.`;

      if (them) {
        const theirs = matchesFor(data, them.index, today)
          .filter((m) => m[F.SURFACE] === activeSurface);
        if (theirs.length >= 5) {
          const tr = record(theirs, them.index);
          line += ` ${theirName} is ${tr.won}-${tr.lost} (${pct(tr.won, tr.played)}%).`;
        }
      }
      bullets.push(line);
    }
  }

  /* Ranking and durability ------------------------------------------ */
  const lastMine = mine[mine.length - 1];
  const myRank = lastMine[F.WINNER] === me.index ? lastMine[F.WRANK] : lastMine[F.LRANK];

  const extras = [];
  if (myRank > 0) {
    // Date-stamped on purpose: a ranking is only as current as the last match it
    // was recorded at, and a player returning from a layoff can be carrying a
    // number that no longer describes them.
    const theirMatches = them ? matchesFor(data, them.index, today) : [];
    const lastTheirs = theirMatches[theirMatches.length - 1];
    const theirRank = lastTheirs
      ? (lastTheirs[F.WINNER] === them.index ? lastTheirs[F.WRANK] : lastTheirs[F.LRANK])
      : 0;

    extras.push(
      theirRank > 0
        ? `Ranked ${myRank} as of ${shortDate(lastMine[F.DAY])}, against ${theirName}'s ${theirRank} as of ${shortDate(lastTheirs[F.DAY])}.`
        : `Ranked ${myRank} as of ${shortDate(lastMine[F.DAY])}.`,
    );
  }

  // Form built from matches months old describes a different player. Say so
  // rather than letting a stale record read as current.
  const daysIdle = today - lastMine[F.DAY];
  if (daysIdle > 35) {
    extras.push(
      `${myName} has no recorded match since ${shortDate(lastMine[F.DAY])} (${daysIdle} days) — the form and ranking above predate that gap.`,
    );
  }

  // A retirement or walkover is the only injury signal this archive carries, so
  // it is reported as exactly that and not dressed up as a diagnosis.
  const retirements = mine.slice(-20).filter((m) => m[F.RETIRED] === 1).length;
  if (retirements) {
    extras.push(
      `${plural(retirements, 'match')} in their last ${Math.min(20, mine.length)} ended in a retirement or walkover — worth checking fitness news before betting.`,
    );
  }

  if (extras.length) bullets.push(extras.join(' '));

  return bullets;
}

/* ------------------------------------------------------------------ */
/* Team sports                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build bullets from the worker's /context bundle (ESPN-derived).
 *
 * @param context  normalised bundle, or null when nothing could be matched
 * @param subject  the team the bet is on, as the odds feed names them
 */
export function teamInsights(context, subject, { marketKey = 'h2h' } = {}) {
  if (!context) return [];

  const subjectFold = fold(subject);
  const sides = [context.home, context.away].filter(Boolean);
  const me = sides.find((t) => fold(t.name) === subjectFold)
    ?? sides.find((t) => containsWords(subjectFold, fold(t.shortName ?? '')))
    ?? null;
  const them = sides.find((t) => t !== me) ?? null;
  if (!me) return [];

  const bullets = [];
  const myName = me.shortName || me.name;
  const theirName = them?.shortName || them?.name || 'their opponent';

  /* Record, split by venue ------------------------------------------ */
  // A season that hasn't started reads 0-0. True, and worth nothing on a card.
  const hasRecord = (r) => r && !/^0-0(-0)?$/.test(r.trim());
  const venue = me.isHome ? me.homeRecord : me.awayRecord;

  if (hasRecord(me.overallRecord)) {
    const opponentClause = hasRecord(them?.overallRecord)
      ? `; ${theirName} are ${them.overallRecord}.`
      : '.';
    bullets.push(
      hasRecord(venue)
        ? `${myName} are ${me.overallRecord} on the season and ${venue} ${me.isHome ? 'at home' : 'on the road'}${opponentClause}`
        : `${myName} are ${me.overallRecord} on the season${opponentClause}`,
    );
  }

  /* Form ------------------------------------------------------------- */
  // Sports with draws need all three counts — "won 0 of their last 5" reads as
  // five defeats when two of them were draws.
  const tallyOf = (side) => {
    const games = side?.lastFive ?? [];
    if (!games.length) return null;
    const tally = { W: 0, D: 0, L: 0, games, sequence: games.map((g) => g.result).join('') };
    for (const g of games) if (tally[g.result] != null) tally[g.result]++;
    return tally;
  };

  const myTally = tallyOf(me);
  if (myTally) {
    const theirTally = tallyOf(them);
    // One format per sentence: mixing "4 of 5" with "3W-2D-0L" in the same
    // breath makes the two sides look like different measurements.
    const anyDraws = Boolean(myTally.D || theirTally?.D);
    const show = (t) =>
      anyDraws
        ? `${t.W}W-${t.D}D-${t.L}L (${t.sequence})`
        : `${t.W} of ${t.games.length} (${t.sequence})`;

    bullets.push(
      anyDraws
        ? `Last 5 — ${myName} ${show(myTally)}.${theirTally ? ` ${theirName} ${show(theirTally)}.` : ''}`
        : `${myName} have won ${show(myTally)}.${theirTally ? ` ${theirName} ${show(theirTally)}.` : ''}`,
    );
  }

  /* Head to head, and ATS when the bet is a spread ------------------- */
  if (context.seriesSummary) {
    const series = context.seriesSummary.trim();
    bullets.push(/[.!?]$/.test(series) ? series : `${series}.`);
  }

  if (marketKey === 'spreads' && me.atsRecord) {
    bullets.push(
      `Against the spread this season: ${myName} ${me.atsRecord}` +
      (them?.atsRecord ? `, ${theirName} ${them.atsRecord}.` : '.'),
    );
  }

  /* Availability ----------------------------------------------------- */
  if (me.injuries?.length) {
    // Statuses arrive in each league's own vocabulary — "Out", "60-Day-IL",
    // "Injured Reserve", "Day-To-Day". Anything on an injured list means
    // unavailable; day-to-day does not. Left in the source's own casing rather
    // than lower-cased, which turned "10-Day-IL" into "10-day-il".
    const unavailable = me.injuries.filter((p) =>
      /\bout\b|injured reserve|\bir\b|-il\b|\bil\b|suspend/i.test(p.status),
    );
    const listed = unavailable.length ? unavailable : me.injuries;
    const named = listed.slice(0, 3).map((p) => `${p.name} (${p.status})`).join(', ');
    const more = listed.length > 3 ? ` and ${listed.length - 3} more` : '';

    bullets.push(
      unavailable.length
        ? `${plural(unavailable.length, 'player')} unavailable for ${myName}: ${named}${more}.`
        : `${myName} injury report: ${named}${more}.`,
    );
  }

  return bullets;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export const isTennis = (sportKey) => String(sportKey ?? '').startsWith('tennis_');

/**
 * Non-price bullets for one leg. Callers concatenate these after engine.js's
 * single price bullet. Returns [] when nothing could be sourced, which the UI
 * renders as a shorter card rather than filler.
 */
export function buildInsights(leg, { tennisData = null, context = null, now = Date.now() } = {}) {
  if (isTennis(leg.sportKey)) {
    if (!tennisData) return [];
    // Tennis "teams" are the two players; the bet names one of them.
    const subject = leg.selection.replace(/ to win$/i, '').trim();
    const opponent = fold(subject) === fold(leg.home) ? leg.away : leg.home;
    return tennisInsights(tennisData, subject, opponent, { now });
  }

  const subject = leg.marketKey === 'totals'
    ? null // A total is about the game, not a side — no team to profile.
    : leg.selection.replace(/ to win$/i, '').replace(/\s[+-]\d+(\.\d+)?$/, '').trim();

  return subject ? teamInsights(context, subject, { marketKey: leg.marketKey }) : [];
}
