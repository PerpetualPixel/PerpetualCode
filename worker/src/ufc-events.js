/**
 * Match MMA fighters from Odds API to actual UFC/PFL events.
 * Tries Sherdog for known fighters, falls back to date-based grouping.
 */

const SHERDOG = 'https://www.sherdog.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search for a fighter on Sherdog and extract their upcoming fights.
 */
async function getFighterUpcomingFights(fighterName) {
  try {
    const slug = normalizeName(fighterName).replace(/ /g, '-');
    const response = await fetch(`${SHERDOG}/fighter/${slug}`, {
      headers: { 'User-Agent': UA },
    });

    if (!response.ok) return [];

    const html = await response.text();
    const fights = [];

    // Look for upcoming fights section
    const upcomingMatch = html.match(/upcoming[\s\S]{0,2000}?event_link/i);
    if (!upcomingMatch) return fights;

    // Extract event links
    const eventPattern = /href="\/events\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let match;

    while ((match = eventPattern.exec(upcomingMatch[0])) !== null) {
      const eventName = match[2].trim();
      if (eventName) {
        fights.push({ event: eventName, slug: match[1] });
      }
    }

    return fights;
  } catch (e) {
    return [];
  }
}

/**
 * Format a date from commenceMs for grouping and display.
 */
function formatEventDate(commenceMs) {
  const date = new Date(commenceMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Look up MMA event details for a matchup.
 * Tries Sherdog first; falls back to date-based event naming.
 */
export async function getUfcEventDetails(fighterA, fighterB, commenceMs) {
  if (!fighterA || !fighterB) return null;

  try {
    // Try to find on Sherdog
    const [fightsA, fightsB] = await Promise.all([
      getFighterUpcomingFights(fighterA),
      getFighterUpcomingFights(fighterB),
    ]);

    // Look for common events
    for (const fightA of fightsA) {
      for (const fightB of fightsB) {
        if (fightA.slug === fightB.slug) {
          return { event: fightA.event };
        }
      }
    }
  } catch (e) {
    // Fall through to fallback
  }

  // Fallback: return date-based event name for ungrouped/unknown events
  if (commenceMs) {
    const dateStr = formatEventDate(commenceMs);
    return { event: `Event - ${dateStr}` };
  }

  return null;
}
