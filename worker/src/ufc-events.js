/**
 * Match MMA fighters from Odds API to actual UFC/PFL events.
 * Uses a combination of sources: Sherdog fighter pages for upcoming fights.
 */

const SHERDOG = 'https://www.sherdog.com';
const CACHE_TTL = 3600; // 1 hour
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let cachedFighterMap = null;
let cachedTime = 0;

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search for a fighter on Sherdog and extract their upcoming fights.
 * This gives us the actual event names they're scheduled for.
 */
async function getFighterUpcomingFights(fighterName, ctx) {
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

    // Extract event links from upcoming section
    const eventPattern = /href="\/events\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let match;

    while ((match = eventPattern.exec(upcomingMatch[0])) !== null) {
      const eventSlug = match[1];
      const eventName = match[2].trim();

      // Extract date if available
      const datePattern = /(\d{1,2}\/\d{1,2}\/\d{4})/;
      const dateMatch = html.match(datePattern);
      const date = dateMatch ? dateMatch[1] : null;

      if (eventName) {
        fights.push({
          event: eventName,
          slug: eventSlug,
          date: date,
        });
      }
    }

    return fights;
  } catch (e) {
    return [];
  }
}

/**
 * Build a fighter-pair to event mapping by searching for each fighter.
 */
async function buildFighterEventMap(fighterA, fighterB, ctx) {
  const [fightsA, fightsB] = await Promise.all([
    getFighterUpcomingFights(fighterA, ctx),
    getFighterUpcomingFights(fighterB, ctx),
  ]);

  // Find common events (events both fighters are on)
  for (const fightA of fightsA) {
    for (const fightB of fightsB) {
      if (
        fightA.slug === fightB.slug ||
        fightA.event.toLowerCase() === fightB.event.toLowerCase()
      ) {
        return {
          event: fightA.event,
          date: fightA.date,
        };
      }
    }
  }

  return null;
}

/**
 * Look up MMA event details for a matchup by fighter names.
 * Searches Sherdog for each fighter's upcoming fights and finds the common event.
 */
export async function getUfcEventDetails(fighterA, fighterB, ctx) {
  if (!fighterA || !fighterB) return null;

  try {
    const result = await buildFighterEventMap(fighterA, fighterB, ctx);
    return result;
  } catch (e) {
    console.error('Failed to get event details:', e);
    return null;
  }
}
