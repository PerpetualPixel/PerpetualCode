/**
 * Scrape upcoming MMA events from Sherdog and match fighters to events.
 * This fetches live event data rather than maintaining a hardcoded mapping.
 */

const SHERDOG = 'https://www.sherdog.com';
const EVENT_CACHE_TTL = 3600 * 6; // 6 hours
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let cachedEventMap = null;
let cachedEventTime = 0;

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse upcoming events from Sherdog's events page.
 * Extracts event name, date, venue, and all fighters on each card.
 */
function parseUpcomingEvents(html) {
  const eventMap = new Map(); // event name -> { date, venue, fighters: [] }

  // Find all event entries (each event has a date header and list of fights)
  const eventSections = html.split('class="event_link"');

  for (let i = 1; i < eventSections.length; i++) {
    const section = eventSections[i];

    // Extract event name from the link
    const eventMatch = section.match(/<a[^>]*>([^<]+)<\/a>/);
    if (!eventMatch) continue;

    const eventName = eventMatch[1].trim();

    // Extract date
    const dateMatch = section.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    const eventDate = dateMatch ? dateMatch[1] : null;

    // Extract all fighter pairs on this card
    const fighterPattern = /<a href="\/fighter\/[^"]*">([^<]+)<\/a>\s*vs\.\s*<a href="\/fighter\/[^"]*">([^<]+)<\/a>/g;
    let match;

    const fighters = [];
    while ((match = fighterPattern.exec(section)) !== null) {
      const fighterA = match[1].trim();
      const fighterB = match[2].trim();
      fighters.push({ a: fighterA, b: fighterB });
    }

    if (fighters.length > 0) {
      eventMap.set(eventName, {
        event: eventName,
        date: eventDate,
        fighters: fighters,
      });
    }
  }

  return eventMap;
}

/**
 * Fetch and cache upcoming MMA events from Sherdog.
 */
async function fetchUpcomingEvents(ctx) {
  const now = Date.now();

  // Return cached map if fresh
  if (cachedEventMap && now - cachedEventTime < EVENT_CACHE_TTL * 1000) {
    return cachedEventMap;
  }

  try {
    const response = await fetch(`${SHERDOG}/events/`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });

    if (!response.ok) return new Map();

    const html = await response.text();
    const eventMap = parseUpcomingEvents(html);

    // Cache the result
    cachedEventMap = eventMap;
    cachedEventTime = now;

    return eventMap;
  } catch (e) {
    console.error('Failed to fetch upcoming events:', e);
    return cachedEventMap || new Map();
  }
}

/**
 * Build a fighter-pair to event mapping from scraped Sherdog data.
 */
function buildFighterEventMap(eventMap) {
  const fighterMap = new Map();

  for (const [eventName, eventData] of eventMap) {
    for (const { a, b } of eventData.fighters) {
      const normA = normalizeName(a);
      const normB = normalizeName(b);

      if (normA && normB) {
        const key = `${normA} ${normB}`;
        const keyReverse = `${normB} ${normA}`;

        const eventMetadata = {
          event: eventData.event,
          date: eventData.date,
        };

        fighterMap.set(key, eventMetadata);
        fighterMap.set(keyReverse, eventMetadata);
      }
    }
  }

  return fighterMap;
}

/**
 * Look up MMA event details for a matchup by fighter names.
 * Fetches upcoming events from Sherdog and matches fighters.
 */
export async function getUfcEventDetails(fighterA, fighterB, ctx) {
  if (!fighterA || !fighterB) return null;

  // Fetch upcoming events from Sherdog
  const eventMap = await fetchUpcomingEvents(ctx);
  if (!eventMap.size) return null;

  // Build fighter-to-event mapping
  const fighterMap = buildFighterEventMap(eventMap);

  // Look up the fighters
  const key = `${normalizeName(fighterA)} ${normalizeName(fighterB)}`;
  const keyReverse = `${normalizeName(fighterB)} ${normalizeName(fighterA)}`;

  return fighterMap.get(key) ?? fighterMap.get(keyReverse) ?? null;
}
