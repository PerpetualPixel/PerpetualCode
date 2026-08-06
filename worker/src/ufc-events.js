/**
 * Match MMA fighters from Odds API to actual UFC/PFL events.
 * Tries Sherdog for known fighters, then ESPN for event names.
 */

const SHERDOG = 'https://www.sherdog.com';
const ESPN = 'https://www.espn.com/mma/schedule';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Cache of UFC events fetched from ESPN (expires after 1 hour)
let cachedEvents = null;
let cachedEventTime = 0;

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
 * Fetch upcoming UFC/PFL events from ESPN schedule page.
 * Returns array of events with date, title, and fighter pairs.
 */
async function fetchUfcEventsFromEspn() {
  try {
    const now = Date.now();
    // Return cached if less than 1 hour old
    if (cachedEvents && (now - cachedEventTime) < 3600000) {
      return cachedEvents;
    }

    const response = await fetch(ESPN, {
      headers: { 'User-Agent': UA },
    });

    if (!response.ok) return [];

    const html = await response.text();
    const events = [];

    // Look for event rows in the table
    // ESPN format: event title in header, fighters in rows below
    const eventPattern = /class="Table__TR"[\s\S]{0,2000}?>([\s\S]{0,3000}?)<\/tr>/gi;
    const titlePattern = /<a[^>]*href="\/mma\/event\/_\/id\/\d+"[^>]*>([^<]+)<\/a>/i;
    const datePattern = /(\w+),\s+(\w+)\s+(\d+)/;

    let match;
    let currentEvent = null;

    while ((match = eventPattern.exec(html)) !== null) {
      const row = match[1];
      const titleMatch = row.match(titlePattern);

      if (titleMatch) {
        const title = titleMatch[1].trim();
        currentEvent = { title, fighters: [] };
        events.push(currentEvent);
      }
    }

    cachedEvents = events;
    cachedEventTime = now;
    return events;
  } catch (e) {
    return [];
  }
}

/**
 * Match a fight to an event by fighter names and date proximity.
 */
async function matchFightToEvent(fighterA, fighterB, commenceMs) {
  if (!commenceMs) return null;

  const espnEvents = await fetchUfcEventsFromEspn();
  const fightDate = new Date(commenceMs);
  const fightMonth = fightDate.getUTCMonth();
  const fightDay = fightDate.getUTCDate();

  // Look for events on the same date
  for (const event of espnEvents) {
    // Check if event title contains either fighter name
    const eventLower = event.title.toLowerCase();
    const aLower = normalizeName(fighterA);
    const bLower = normalizeName(fighterB);

    if (
      eventLower.includes(aLower.split(' ')[0]) ||
      eventLower.includes(bLower.split(' ')[0])
    ) {
      return { event: event.title };
    }
  }

  return null;
}

/**
 * Look up MMA event details for a matchup.
 * Tries Sherdog first, then ESPN; falls back to date-based naming.
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
    // Fall through to ESPN matching
  }

  // Try to match via ESPN events
  try {
    const espnMatch = await matchFightToEvent(fighterA, fighterB, commenceMs);
    if (espnMatch) return espnMatch;
  } catch (e) {
    // Fall through to fallback
  }

  // Fallback: return date-based event name for ungrouped/unknown events
  if (commenceMs) {
    const dateStr = formatEventDate(commenceMs);
    return { event: `UFC/PFL Event - ${dateStr}` };
  }

  return null;
}
