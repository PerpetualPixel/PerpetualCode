/**
 * The ESPN tennis scoreboard, parsed (shared by the card runner,
 * scripts/tennis-card.mjs, and the worker's live read, worker/src/
 * tennis-live.js): the singles matches of each tournament with their
 * players, round, state and set scores. Pure.
 */

/** A player's key for matching across sources: lowercase ASCII, letters and digits, single spaces. */
export const nameKey = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Men's Grand Slam main draws are best of five; everything else on either tour is best of three. */
export function bestOfFor(tour, eventName, round) {
  const slam = /australian open|roland garros|french open|wimbledon|us open/i.test(String(eventName ?? ''));
  return tour === 'atp' && slam && !/qualifying/i.test(String(round ?? '')) ? 5 : 3;
}

/** The tier the Tennis tab reads a tournament at, from ESPN's name: Slams and 1000s, the Finals, then the rest of the tour. */
export function tierOf(eventName) {
  const n = String(eventName ?? '').toLowerCase();
  if (/australian open|roland garros|french open|wimbledon|us open/.test(n)) return 'slam';
  if (/masters|1000|indian wells|miami open|madrid|rome|italian open|canadian|national bank|cincinnati|shanghai|paris|wuhan|china open|qatar|dubai|atp finals|wta finals|nitto/.test(n)) return '1000';
  if (/challenger|itf|125/.test(n)) return 'challenger';
  return 'tour';
}

/** The surface a tournament plays on, from its name (the Finals and the indoor swing are hard courts). */
export function surfaceOf(eventName) {
  const n = String(eventName ?? '').toLowerCase();
  if (/roland garros|french open|monte|madrid|rome|italian|barcelona|hamburg|munich|geneva|lyon|estoril|marrakech|bucharest|rabat|strasbourg|umag|gstaad|bastad|kitzbuhel|rio|buenos aires|santiago|clay/.test(n)) return 'clay';
  if (/wimbledon|queen|halle|eastbourne|stuttgart|s-hertogenbosch|berlin|bad homburg|mallorca|nottingham|birmingham|grass/.test(n)) return 'grass';
  return 'hard';
}

/** One competitor as the card lists a player; null for a doubles pairing or a placeholder. */
function player(c) {
  if (!c || c.roster) return null;
  const a = c.athlete ?? {};
  if (!a.displayName || /^tbd$|^tba$|^bye$/i.test(String(a.displayName).trim())) return null;
  return { id: String(c.id ?? a.id ?? ''), name: a.displayName, short: a.shortName ?? null, key: nameKey(a.displayName), country: a.flag?.alt ?? null, flag: a.flag?.href ?? null };
}

/**
 * The singles matches in a scoreboard payload: {id, tour, eventId, eventName, tier, round, qualifying, date, state,
 * completed, statusName, detail, bestOf, court, venue, a, b, sets, tiebreaks, winner, note}.
 */
export function parseScoreboard(data, tour) {
  const out = [];
  for (const event of data?.events ?? []) {
    const groupings = event.groupings?.length ? event.groupings : [{ grouping: { slug: '' }, competitions: event.competitions ?? [] }];
    for (const g of groupings) {
      if (/doubles/i.test(String(g?.grouping?.slug ?? ''))) continue;
      for (const c of g.competitions ?? []) {
        if (/doubles/i.test(String(c?.type?.slug ?? ''))) continue;
        const [first, second] = c.competitors ?? [];
        const a = player(first); const b = player(second);
        if (!a || !b) continue;
        const round = c.round?.displayName ?? null;
        const la = first.linescores ?? []; const lb = second.linescores ?? [];
        const sets = la.length === lb.length ? la.map((s, i) => [Number(s?.value ?? 0), Number(lb[i]?.value ?? 0)]) : [];
        const tiebreaks = la.length === lb.length ? la.map((s, i) => (s?.tiebreak != null || lb[i]?.tiebreak != null ? [s?.tiebreak ?? null, lb[i]?.tiebreak ?? null] : null)) : [];
        out.push({
          id: String(c.id), tour, eventId: String(event.id), eventName: event.name ?? null, tier: tierOf(event.name), round, qualifying: /qualifying/i.test(String(round ?? '')),
          date: c.date ?? c.startDate ?? null, state: c.status?.type?.state ?? 'pre', completed: Boolean(c.status?.type?.completed), statusName: c.status?.type?.name ?? null, detail: c.status?.type?.detail ?? null,
          bestOf: bestOfFor(tour, event.name, round), court: c.venue?.court ?? null, venue: c.venue?.fullName ?? null,
          a, b, sets, tiebreaks, winner: first.winner === true ? 'a' : second.winner === true ? 'b' : null, note: (c.notes ?? []).find((n) => n?.text)?.text ?? null,
        });
      }
    }
  }
  return out;
}

/** Whether a set's score is a finished set (6+ by two, or a 7), not one in play. */
export const setDone = ([a, b]) => (Math.max(a, b) >= 6 && Math.abs(a - b) >= 2) || Math.max(a, b) === 7;
