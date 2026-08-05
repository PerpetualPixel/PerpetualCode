/**
 * Upcoming UFC events mapping — fighter name pairs to event details.
 * Updated periodically to enrich MMA odds with promotion/event labels.
 *
 * Source: UFC official schedule
 * Format: normalized fighter names -> { event, date, venue }
 */

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const UPCOMING_EVENTS = {
  // Aug 8, 2026 — UFC Fight Night: Gamrot vs. Salkilld
  'quillan salkilld mateusz gamrot': {
    event: 'UFC Fight Night: Gamrot vs. Salkilld',
    date: '2026-08-08',
    venue: 'Meta APEX, Las Vegas, Nevada',
  },
  'mateusz gamrot quillan salkilld': {
    event: 'UFC Fight Night: Gamrot vs. Salkilld',
    date: '2026-08-08',
    venue: 'Meta APEX, Las Vegas, Nevada',
  },

  // Aug 15, 2026 — UFC 330: Makhachev vs. Machado Garry
  'islam makhachev ian garry': {
    event: 'UFC 330: Makhachev vs. Machado Garry',
    date: '2026-08-15',
    venue: 'Xfinity Mobile Arena, Philadelphia, Pennsylvania',
  },
  'ian garry islam makhachev': {
    event: 'UFC 330: Makhachev vs. Machado Garry',
    date: '2026-08-15',
    venue: 'Xfinity Mobile Arena, Philadelphia, Pennsylvania',
  },

  // Aug 29, 2026 — UFC Fight Night: Nurmagomedov vs. Song
  'umar nurmagomedov song yadong': {
    event: 'UFC Fight Night: Nurmagomedov vs. Song',
    date: '2026-08-29',
    venue: 'Oriental Sports Center, Pudong District, China',
  },
  'song yadong umar nurmagomedov': {
    event: 'UFC Fight Night: Nurmagomedov vs. Song',
    date: '2026-08-29',
    venue: 'Oriental Sports Center, Pudong District, China',
  },
};

/**
 * Look up UFC event details for a matchup by fighter names.
 * Returns event metadata if found, null otherwise.
 */
export function getUfcEventDetails(fighterA, fighterB) {
  if (!fighterA || !fighterB) return null;

  const key = `${normalizeName(fighterA)} ${normalizeName(fighterB)}`;
  const reversed = `${normalizeName(fighterB)} ${normalizeName(fighterA)}`;

  return UPCOMING_EVENTS[key] ?? UPCOMING_EVENTS[reversed] ?? null;
}
