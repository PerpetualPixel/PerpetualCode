import { UPCOMING_UFC_EVENTS, findUfcEventForFight } from './ufc-events-upcoming.js';

/**
 * Match MMA fighters from Odds API to actual UFC/PFL events.
 * Uses official event mapping maintained in ufc-events-upcoming.js
 */

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format a date from commenceMs for fallback grouping.
 */
function formatEventDate(commenceMs) {
  const date = new Date(commenceMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${day}`;
}

/**
 * Look up MMA event details for a matchup.
 * First tries official UFC events list, then falls back to date grouping.
 */
export async function getUfcEventDetails(fighterA, fighterB, commenceMs) {
  if (!fighterA || !fighterB) return null;

  // Try to match against official UFC events
  const officialEvent = findUfcEventForFight(fighterA, fighterB);
  if (officialEvent) {
    return { event: officialEvent };
  }

  // Fallback: return date-based event name for fights not yet in mapping
  if (commenceMs) {
    const dateStr = formatEventDate(commenceMs);
    return { event: `Card - ${dateStr}` };
  }

  return null;
}
