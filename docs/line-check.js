/**
 * "Too good to be true?" for a Trends line (2026-11-24, the owner, of a
 * 95% line at -108: "It seems too good to be true. Like a free bet ...
 * Can you have a button and data backing or alerting on why this is a
 * good or bad take. For example I saw one yesterday, the guy was 20/20
 * and priced at -120 or so. What I found out later was Ingram had come
 * back to the lineup").
 *
 * A hit rate is the past; the price is the book's view of tonight. When
 * the two disagree, something has usually changed. These are the checks
 * that can be read off the line itself, each a fact with its numbers:
 * the price against the record, the last five against the last twenty,
 * how thin the recent margins were, the minutes, the injury report, the
 * role, a change of team, and the record against tonight's opponent.
 * worker/src/line-check.js adds the lineup: a teammate out or back, and a
 * likely blowout.
 *
 * A flag is {key, tone, title, text}; `tone` is 'bad' (a reason to stay
 * off), 'warn' (a reason to look twice), 'good' (a point in its favour) or
 * 'info' (cuts either way).
 */

/** A line looks too good from this hit rate with this much room over what its price implies. */
export const TOO_GOOD_RATE = 0.9;
export const TOO_GOOD_GAP = 0.2;

const impliedOf = (american) => (Number.isFinite(american) ? (american < 0 ? -american / (-american + 100) : 100 / (american + 100)) : null);
const pct = (x) => `${Math.round(x * 100)}%`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const one = (x) => Math.round(x * 10) / 10;
const OUT = /\b(out|doubtful|suspended|injured reserve|ir)\b/i;

/** The window a line is judged on: the last twenty when ten or more are in it, else the last ten from five, else none. */
export function baseWindow(row) {
  const p = row?.periods ?? {};
  if (p.l20?.games >= 10) return { ...p.l20, n: 20 };
  if (p.l10?.games >= 5) return { ...p.l10, n: 10 };
  return null;
}

/** Does this line look too good: a near-certain record at a price that says otherwise. */
export function looksTooGood(row, american = row?.american) {
  const base = baseWindow(row); const imp = impliedOf(american);
  return Boolean(base && imp != null && base.rate >= TOO_GOOD_RATE && base.rate - imp >= TOO_GOOD_GAP);
}

/** The flags that can be read off the line itself. `american` is the price being looked at (the user's book), the row's best by default. */
export function lineFlags(row, { american = row?.american } = {}) {
  const flags = [];
  const add = (key, tone, title, text) => flags.push({ key, tone, title, text });
  const over = row?.side !== 'under';
  const base = baseWindow(row);
  const series = (row?.series ?? []).filter((g) => Number.isFinite(Number(g?.value)));
  const imp = impliedOf(american);

  if (!base) add('sample', 'warn', 'Small sample', `Fewer than ten games on file at this number, so the hit rate says little yet.`);

  // The price against the record.
  if (base && imp != null) {
    const gap = base.rate - imp;
    if (base.rate >= 0.85 && gap >= TOO_GOOD_GAP) add('price', 'warn', 'The price disagrees with the record', `${base.hits} of ${base.games} is ${pct(base.rate)}, but ${signed(american)} says about ${pct(imp)}. Books rarely leave ${Math.round(gap * 100)} points on the table: look for what has changed.`);
    else if (base.rate >= 0.85 && gap <= 0.08) add('price', 'good', 'The price matches the record', `${signed(american)} says about ${pct(imp)}, in line with ${base.hits} of ${base.games}. No catch is priced in, and there is no bargain either.`);
  }

  // The last five against the window.
  const last5 = series.slice(0, 5).map((g) => Number(g.value));
  if (base && last5.length === 5 && Number.isFinite(base.avg) && base.avg > 0) {
    const avg5 = last5.reduce((s, v) => s + v, 0) / 5;
    if (over && avg5 <= base.avg * 0.7) add('form', 'warn', 'Trending down', `${one(avg5)} a game over the last five, against ${base.avg} over the last ${base.games}. The role may have shrunk.`);
    if (!over && avg5 >= base.avg * 1.3) add('form', 'warn', 'Trending up', `${one(avg5)} a game over the last five, against ${base.avg} over the last ${base.games}. The under is fighting the recent run.`);
  }
  // How thin the recent margins were: the least that clears an over is the next whole number up; the most that keeps an under is the one below.
  if (last5.length === 5 && Number.isFinite(row?.point)) {
    const bare = over ? Math.floor(row.point) + 1 : Math.ceil(row.point) - 1;
    const thin = last5.filter((v) => (over ? v <= bare : v >= bare)).length;
    if (thin >= 3) add('margin', 'warn', 'Thin margins lately', `${thin} of the last five ${over ? 'cleared by the minimum or missed' : 'stayed under by the minimum or went over'} (${last5.join(', ')}); the line is ${row.point}.`);
  }

  // Minutes (the NBA rows carry them).
  const m = row?.mins;
  if (m && Number.isFinite(m.l3) && Number.isFinite(m.l10) && m.l10 > 0) {
    if (m.l3 < m.l10 * 0.8) add('minutes', over ? 'bad' : 'info', 'Minutes are down', `${m.l3} a game over the last three, ${m.l10} over the last ten.${over ? ' Fewer minutes, fewer chances.' : ''}`);
    else if (Number.isFinite(m.last) && m.last < m.l10 * 0.6) add('minutes', over ? 'warn' : 'info', 'Short minutes last game', `${m.last} last game against ${m.l10} over the last ten.`);
  }

  // The injury report and the role.
  if (row?.injury?.status) {
    const s = String(row.injury.status);
    add('injury', OUT.test(s) ? 'bad' : 'warn', 'On the injury report', `Listed ${s.toLowerCase()}${row.injury.detail ? ` (${row.injury.detail})` : ''}. Confirm the lineup before betting.`);
  }
  if (row?.role && row.role.starter === false) add('role', over ? 'warn' : 'info', 'Bench role', row.role.today ? 'Not in today\'s starting lineup.' : 'Did not start his team\'s last game.');

  // A change of team: a game against tonight's own team inside the window means those games were for someone else.
  if (base && row?.team) {
    const team = String(row.team).toUpperCase();
    const windowGames = series.slice(0, base.n);
    const at = windowGames.findIndex((g) => String(g.opponent ?? '').toUpperCase() === team);
    if (at >= 0) {
      const before = windowGames.length - at;
      add('team', before >= windowGames.length / 2 ? 'bad' : 'warn', 'Changed teams', `At least ${before} of these ${windowGames.length} games were for another team (he played against ${team} in that stretch). A new offense and a new role: the record carries over less than it looks.`);
    }
  }

  // Tonight's opponent.
  const h = row?.periods?.h2h;
  if (h?.games >= 2 && h.rate <= 0.5) add('opponent', 'warn', 'Trouble with this opponent', `${h.hits} of ${h.games} against ${row.opponent ?? 'this opponent'}.`);

  return flags;
}

/**
 * What the flags add up to: {key, label, text}. A reason to stay off makes
 * it a likely trap; reasons to look twice make it a careful one; a line
 * the price agrees with is fair; a gap nothing explains is said to be that.
 */
export function lineVerdict(flags, { tooGood = false } = {}) {
  const bad = flags.filter((f) => f.tone === 'bad').length;
  const warn = flags.filter((f) => f.tone === 'warn' && f.key !== 'price').length;
  const priced = flags.some((f) => f.key === 'price' && f.tone === 'warn');
  if (bad) return { key: 'trap', label: 'Likely a trap', text: `${bad === 1 ? 'One thing' : `${bad} things`} here ${bad === 1 ? 'is' : 'are'} a reason to stay off.` };
  if (warn) return { key: 'careful', label: 'Look twice', text: `${warn === 1 ? 'One thing' : `${warn} things`} to weigh before taking it.` };
  if (priced || tooGood) return { key: 'unexplained', label: 'Unexplained', text: 'Nothing in the numbers explains the price. Check the news on this player and his team before taking it.' };
  return { key: 'fair', label: 'Nothing against it', text: 'No red flag in the numbers. The record and the price say the same thing.' };
}
