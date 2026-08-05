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
 * Each bullet is tagged { tier, text } rather than returned as a plain
 * string. The tier groups bullets into the same three buckets every sport
 * here uses: 'personnel' (the subject and the direct matchup), 'situational'
 * (form-affecting context around the match rather than the head-to-head
 * itself). Tennis has no team-sport "supporting cast" — an individual
 * carries their own match, so that tier is simply never populated here.
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

      bullets.push({
        tier: 'personnel',
        text:
          won === h2h.length
            ? `${myName} has won all ${plural(h2h.length, 'meeting')} with ${theirName} across ${seasons}, most recently on ${lastSurface.toLowerCase()}.`
            : `Head-to-head across ${seasons}: ${myName} ${won}, ${theirName} ${lost}. ${wonLast ? myName : theirName} took the last meeting, on ${lastSurface.toLowerCase()}.`,
      });
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
      bullets.push({
        tier: 'personnel',
        text: `Form over the last ${RECENT} matches: ${myName} ${myForm.won}-${myForm.lost}, ${theirName} ${theirForm.won}-${theirForm.lost}.`,
      });
    } else {
      bullets.push({
        tier: 'personnel',
        text: `${myName} is ${myForm.won}-${myForm.lost} over their last ${plural(myForm.played, 'match')}.`,
      });
    }
  } else {
    bullets.push({
      tier: 'personnel',
      text: `${myName} is ${myForm.won}-${myForm.lost} over their last ${plural(myForm.played, 'match')}.`,
    });
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
      bullets.push({ tier: 'personnel', text: line });
    }
  }

  /* Ranking ----------------------------------------------------------- */
  const lastMine = mine[mine.length - 1];
  const myRank = lastMine[F.WINNER] === me.index ? lastMine[F.WRANK] : lastMine[F.LRANK];

  if (myRank > 0) {
    // Date-stamped on purpose: a ranking is only as current as the last match it
    // was recorded at, and a player returning from a layoff can be carrying a
    // number that no longer describes them.
    const theirMatches = them ? matchesFor(data, them.index, today) : [];
    const lastTheirs = theirMatches[theirMatches.length - 1];
    const theirRank = lastTheirs
      ? (lastTheirs[F.WINNER] === them.index ? lastTheirs[F.WRANK] : lastTheirs[F.LRANK])
      : 0;

    bullets.push({
      tier: 'personnel',
      text:
        theirRank > 0
          ? `Ranked ${myRank} as of ${shortDate(lastMine[F.DAY])}, against ${theirName}'s ${theirRank} as of ${shortDate(lastTheirs[F.DAY])}.`
          : `Ranked ${myRank} as of ${shortDate(lastMine[F.DAY])}.`,
    });
  }

  /* Situational: layoff and fitness flags ----------------------------- */
  // Form built from matches months old describes a different player. Say so
  // rather than letting a stale record read as current.
  const daysIdle = today - lastMine[F.DAY];
  if (daysIdle > 35) {
    bullets.push({
      tier: 'situational',
      text: `${myName} has no recorded match since ${shortDate(lastMine[F.DAY])} (${daysIdle} days) — the form and ranking above predate that gap.`,
    });
  }

  // A retirement or walkover is the only injury signal this archive carries, so
  // it is reported as exactly that and not dressed up as a diagnosis.
  const retirements = mine.slice(-20).filter((m) => m[F.RETIRED] === 1).length;
  if (retirements) {
    bullets.push({
      tier: 'situational',
      text: `${plural(retirements, 'match')} in their last ${Math.min(20, mine.length)} ended in a retirement or walkover — worth checking fitness news before betting.`,
    });
  }

  return bullets;
}

/* ------------------------------------------------------------------ */
/* Team sports                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build bullets from the worker's /context bundle (ESPN-derived).
 *
 * Each bullet is tagged { tier, text }. 'personnel' covers the subject team
 * and the direct matchup (record, form, series history, ATS); 'supporting'
 * is specifically roster availability — the one "who else is playing"
 * signal this data source actually carries, standing in for the fuller
 * bench-depth/workload picture a real supporting-cast tier would ideally
 * have, which this app has no source for.
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
    bullets.push({
      tier: 'personnel',
      text: hasRecord(venue)
        ? `${myName} are ${me.overallRecord} on the season and ${venue} ${me.isHome ? 'at home' : 'on the road'}${opponentClause}`
        : `${myName} are ${me.overallRecord} on the season${opponentClause}`,
    });
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

    bullets.push({
      tier: 'personnel',
      text: anyDraws
        ? `Last 5 — ${myName} ${show(myTally)}.${theirTally ? ` ${theirName} ${show(theirTally)}.` : ''}`
        : `${myName} have won ${show(myTally)}.${theirTally ? ` ${theirName} ${show(theirTally)}.` : ''}`,
    });
  }

  /* Head to head, and ATS when the bet is a spread ------------------- */
  if (context.seriesSummary) {
    const series = context.seriesSummary.trim();
    bullets.push({ tier: 'personnel', text: /[.!?]$/.test(series) ? series : `${series}.` });
  }

  if (marketKey === 'spreads' && me.atsRecord) {
    bullets.push({
      tier: 'personnel',
      text: `Against the spread this season: ${myName} ${me.atsRecord}` +
        (them?.atsRecord ? `, ${theirName} ${them.atsRecord}.` : '.'),
    });
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

    bullets.push({
      tier: 'supporting',
      text: unavailable.length
        ? `${plural(unavailable.length, 'player')} unavailable for ${myName}: ${named}${more}.`
        : `${myName} injury report: ${named}${more}.`,
    });
  }

  return bullets;
}

/* ------------------------------------------------------------------ */
/* Weather (NFL, MLB — outdoor and retractable-roof venues)             */
/* ------------------------------------------------------------------ */

/**
 * Bullets from the worker's /weather bundle (National Weather Service data
 * for the home team's venue). `weather` is null for a domed stadium, an
 * indoor sport, a venue this app doesn't have on file, or a game further out
 * than NWS forecasts reach — every one of those is "nothing to say", not an
 * error, so this returns [] rather than a placeholder.
 *
 * Tagged 'environmental' — its own tier, distinct from 'situational'
 * (a layoff or currency flag about a competitor) even though Play of the
 * Day's write-up presents both under one combined heading; the tags stay
 * separate because they answer different questions.
 */
export function weatherInsights(weather) {
  if (!weather) return [];

  const bullets = [];
  const parts = [];
  if (weather.temperatureF != null) parts.push(`${weather.temperatureF}°F`);
  if (weather.shortForecast) parts.push(weather.shortForecast.toLowerCase());
  if (weather.windSpeed) {
    parts.push(`wind ${weather.windSpeed}${weather.windDirection ? ` ${weather.windDirection}` : ''}`);
  }

  if (parts.length) {
    bullets.push({ tier: 'environmental', text: `Forecast at kickoff: ${parts.join(', ')}.` });
  }

  if (weather.precipChance != null && weather.precipChance >= 30) {
    bullets.push({
      tier: 'environmental',
      text: `${weather.precipChance}% chance of precipitation — worth checking closer to game time.`,
    });
  }

  if (weather.roof === 'retractable' && bullets.length) {
    bullets.push({
      tier: 'environmental',
      text: `This venue has a retractable roof — whether it's actually open for this game is a team decision made day-of, not something this forecast can tell you.`,
    });
  }

  return bullets;
}

/* ------------------------------------------------------------------ */
/* MMA (UFC / PFL / Dana White's Contender Series)                     */
/* ------------------------------------------------------------------ */

/**
 * The Odds API bundles every MMA promotion under one key with no tag saying
 * which — the promotion only ever surfaces indirectly, in an event name
 * scraped off a fighter's own Sherdog page (e.g. "UFC Fight Night 284").
 * There is nothing to disambiguate UFC from PFL from Contender Series at the
 * odds-feed layer; a fighter's record is fighter-specific regardless of which
 * card they're on.
 */

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** Sherdog dates read "Mon / DD / YYYY" — parsed rather than displayed as-is
 * so a layoff can be measured, but the original string is what's ever shown. */
function parseSherdogDate(text) {
  const m = String(text ?? '').match(/([A-Za-z]{3})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  return Date.UTC(+m[3], month, +m[2]);
}

/** Wins broken down by how they ended — a finish rate is a real signal in a
 * sport where "decision machine" and "finisher" are genuinely different bets. */
export function finishSummary(fighter) {
  const wins = fighter.history.filter((f) => f.result === 'win');
  if (!wins.length) return null;
  const tally = { knockout: 0, submission: 0, decision: 0, other: 0 };
  for (const w of wins) if (w.category) tally[w.category]++;
  const finishes = tally.knockout + tally.submission;
  return { wins: wins.length, finishes, ...tally };
}

/** Losses broken down the same way — how a fighter has been finished before
 * is a durability signal, and hiding it because it's unflattering would be
 * exactly the kind of one-sided card this app is built not to produce. */
export function vulnerabilitySummary(fighter) {
  const losses = fighter.history.filter((f) => f.result === 'loss');
  if (!losses.length) return null;
  const koLosses = losses.filter((f) => f.category === 'knockout').length;
  const subLosses = losses.filter((f) => f.category === 'submission').length;
  return { losses: losses.length, koLosses, subLosses };
}

function recordLine(fighter) {
  const r = fighter.record;
  if (!r) return `${fighter.name}'s pro record isn't on file.`;
  const total = r.wins + r.losses + r.draws;
  const finish = finishSummary(fighter);
  const finishClause = finish
    ? ` ${finish.finishes} of ${finish.wins} wins by finish (${finish.knockout} KO/TKO, ${finish.submission} submission).`
    : '';
  return `${fighter.name} is ${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''} pro (${total} fights).${finishClause}`;
}

function formLine(fighter, RECENT = 5) {
  const recent = fighter.history.slice(0, RECENT); // Sherdog lists newest first
  if (!recent.length) return null;
  const sequence = recent
    .map((f) => ({ win: 'W', loss: 'L', draw: 'D', nc: 'NC' })[f.result] ?? '?')
    .join('-');
  const wins = recent.filter((f) => f.result === 'win').length;
  return `Last ${recent.length}: ${sequence} (${wins} win${wins === 1 ? '' : 's'}).`;
}

/**
 * Bullets for one MMA matchup. `context` is the { a, b } bundle from the
 * worker's /mma-context — each side resolved independently, either of which
 * may be null when Sherdog has no confident match (a brand-new prospect is a
 * real "nothing on file" case, not a bug).
 *
 * Tagged the same way every sport here is: 'personnel' for the fighter's own
 * record, finish tendencies, form, and durability; 'situational' for a
 * layoff long enough to make that record's currency worth questioning. MMA
 * has no team-sport "supporting cast" — it's the two fighters and nothing
 * else — so that tier is never populated here.
 */
/** Which of the two Sherdog-resolved fighters the bet names, and which is
 * the other side — the same matching mmaInsights uses internally, exported
 * so a caller building a fuller breakdown (the More Stats drawer's bar
 * charts) doesn't need its own copy of this logic. Both null when neither
 * side resolves confidently. */
export function resolveMmaFighters(context, subjectName) {
  if (!context) return { me: null, opponent: null };
  const subjectFold = fold(subjectName);
  const candidates = [context.a, context.b].filter(Boolean);
  const me = candidates.find((f) => fold(f.name) === subjectFold)
    ?? candidates.find((f) => containsWords(subjectFold, fold(f.name)) || containsWords(fold(f.name), subjectFold));
  if (!me) return { me: null, opponent: null };
  const opponent = [context.a, context.b].find((f) => f && f !== me) ?? null;
  return { me, opponent };
}

export function mmaInsights(context, subjectName) {
  if (!context) return [];

  const { me, opponent } = resolveMmaFighters(context, subjectName);
  if (!me) return [];

  const bullets = [{ tier: 'personnel', text: recordLine(me) }];

  const form = formLine(me);
  if (form) {
    bullets.push({
      tier: 'personnel',
      text: opponent ? `${form} ${opponent.name}: ${formLine(opponent) ?? 'no history on file.'}` : form,
    });
  }

  const vuln = vulnerabilitySummary(me);
  if (vuln && (vuln.koLosses || vuln.subLosses)) {
    const parts = [];
    if (vuln.koLosses) parts.push(`${plural(vuln.koLosses, 'loss')} by KO/TKO`);
    if (vuln.subLosses) parts.push(`${plural(vuln.subLosses, 'loss')} by submission`);
    bullets.push({
      tier: 'personnel',
      text: `Of ${me.name}'s ${vuln.losses} career ${vuln.losses === 1 ? 'loss' : 'losses'}, ${parts.join(' and ')}.`,
    });
  }

  const last = me.history[0];
  const lastDate = last ? parseSherdogDate(last.date) : null;
  if (lastDate != null) {
    const days = Math.round((Date.now() - lastDate) / 86400000);
    // A year-plus out of the cage is unusual in MMA and usually means injury,
    // suspension, or a title-shot wait — worth surfacing before the fight, not
    // treating this fighter's dated form as current.
    if (days > 365) {
      bullets.push({
        tier: 'situational',
        text: `${me.name}'s last fight was ${last.date} (${Math.round(days / 30)} months ago) — ` +
          `the record above predates that layoff.`,
      });
    }
  }

  return bullets;
}

/**
 * Career fight count grouped by year, oldest first — the raw material for a
 * bar-chart "Activity Report" like MMA Fantasy's. Undated fights (Sherdog's
 * date didn't parse) are simply not counted rather than guessed into a year.
 */
export function fighterActivityByYear(history) {
  const tally = new Map();
  for (const fight of history ?? []) {
    const ms = parseSherdogDate(fight.date);
    if (ms == null) continue;
    const year = new Date(ms).getUTCFullYear();
    tally.set(year, (tally.get(year) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
}

/**
 * How many of a fighter's past fights ended in each round — the "goes the
 * distance vs. finishes early" signal. Fights with no round on file (an
 * older Sherdog entry that predates the site tracking it, or a decision
 * where the field genuinely wasn't captured) are counted separately rather
 * than silently dropped, so the total here still reconciles with history.length.
 */
export function fighterRoundsEnded(history) {
  const tally = new Map();
  let unknown = 0;
  for (const fight of history ?? []) {
    if (fight.round == null) { unknown++; continue; }
    tally.set(fight.round, (tally.get(fight.round) ?? 0) + 1);
  }
  return {
    rounds: [...tally.entries()].sort((a, b) => a[0] - b[0]).map(([round, count]) => ({ round, count })),
    unknown,
  };
}

/**
 * A plain-language confidence label for how much fight history is actually
 * on file — MMA Fantasy's "Strong"/"Moderate" framing, adopted directly
 * because it's exactly the right honesty check: a record built from 3 fights
 * says less than one built from 15, and the reader should know which they're
 * looking at rather than treat every stat here as equally solid.
 */
export function dataReliability(history) {
  const n = history?.length ?? 0;
  if (n >= 10) return 'Strong';
  if (n >= 5) return 'Moderate';
  if (n > 0) return 'Limited';
  return 'None';
}

/** Opponents both fighters have faced, most recent meeting first per side —
 * a real, cheap head-to-head-adjacent signal: two fighters who've both
 * fought the same person invite a direct form comparison neither fighter's
 * own record alone gives you. */
export function commonOpponents(fighterA, fighterB) {
  const opponentsOf = (fighter) => (fighter?.history ?? [])
    .filter((f) => f.opponent)
    .map((f) => ({ name: f.opponent, result: f.result, method: f.method, date: f.date }));

  const aFights = opponentsOf(fighterA);
  const bFights = opponentsOf(fighterB);
  const bNames = new Set(bFights.map((f) => fold(f.name)));

  const shared = [];
  for (const af of aFights) {
    const bf = bFights.find((f) => fold(f.name) === fold(af.name));
    if (bf) shared.push({ opponent: af.name, a: af, b: bf });
  }
  return shared;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export const isTennis = (sportKey) => String(sportKey ?? '').startsWith('tennis_');
export const isMma = (sportKey) => sportKey === 'mma_mixed_martial_arts';

/**
 * Non-price bullets for one leg, each tagged { tier, text }:
 *   - 'personnel'   the subject and the direct matchup — record, form,
 *                    head-to-head, surface/ranking, finish tendencies.
 *   - 'supporting'  team-sport roster availability (injuries). Never
 *                    populated for tennis or MMA — an individual sport has
 *                    no supporting cast to report on.
 *   - 'situational' something that affects how current the above is: a
 *                    layoff, a retirement/walkover flag.
 * Callers concatenate these after engine.js's single price bullet for the
 * compact card (see insightTexts()), or group them by tier for a fuller
 * breakdown (see worker/src/potd.js). Returns [] when nothing could be
 * sourced, which the UI renders as a shorter card rather than filler.
 */
export function buildInsights(leg, { tennisData = null, context = null, mmaContext = null, weather = null, now = Date.now() } = {}) {
  if (isTennis(leg.sportKey)) {
    if (!tennisData) return [];
    // Tennis "teams" are the two players; the bet names one of them.
    const subject = leg.selection.replace(/ to win$/i, '').trim();
    const opponent = fold(subject) === fold(leg.home) ? leg.away : leg.home;
    return tennisInsights(tennisData, subject, opponent, { now });
  }

  if (isMma(leg.sportKey)) {
    if (!mmaContext) return [];
    const subject = leg.selection.replace(/ to win$/i, '').trim();
    return mmaInsights(mmaContext, subject);
  }

  const subject = leg.marketKey === 'totals'
    ? null // A total is about the game, not a side — no team to profile.
    : leg.selection.replace(/ to win$/i, '').replace(/\s[+-]\d+(\.\d+)?$/, '').trim();

  const bullets = subject ? teamInsights(context, subject, { marketKey: leg.marketKey }) : [];
  // Weather applies to the game, not to whichever side the bet names — worth
  // showing on a total exactly as much as a moneyline or spread.
  return [...bullets, ...weatherInsights(weather)];
}

/** Flattens tagged bullets to plain text, in original order — what the
 * compact card's single "why" list has always shown, tier tags stripped. */
export const insightTexts = (bullets) => bullets.map((b) => b.text);

/** Every bullet matching one tier, text only, in original order. */
export const insightsByTier = (bullets, tier) =>
  bullets.filter((b) => b.tier === tier).map((b) => b.text);
