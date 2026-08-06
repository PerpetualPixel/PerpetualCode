/**
 * Upcoming UFC/PFL events - manually maintained, updated weekly.
 * Format: date, event name, and fighters for the event.
 * This is the source of truth for official event titles.
 */

export const UPCOMING_UFC_EVENTS = [
  {
    date: '2026-08-08',
    title: 'UFC Fight Night: Oliveira vs. Miller',
    fighters: [
      { fighter1: 'Ravena Oliveira', fighter2: 'Juliana Miller' },
      { fighter1: 'Jessie Rosas', fighter2: 'Miles Johns' },
      { fighter1: 'Richie Miranda', fighter2: 'Manoel Sousa' },
      { fighter1: 'Jose Montanha', fighter2: 'Louie Sutherland' },
      { fighter1: 'Bruno Lopes', fighter2: 'Diyar Nurgozhay' },
      { fighter1: 'Guilherme Pat', fighter2: 'Steven Asplund' },
    ],
  },
  {
    date: '2026-08-09',
    title: 'PFL 2026 Season',
    fighters: [
      { fighter1: 'Billy Goff', fighter2: 'Ty Miller' },
      { fighter1: 'Alexis Thainara', fighter2: 'Amanda Lemos' },
      { fighter1: 'Yodier DeValle', fighter2: 'Darren Elkins' },
    ],
  },
  {
    date: '2026-08-16',
    title: 'UFC Fight Night: Robertson vs. Gamrot',
    fighters: [
      { fighter1: 'Gillian Robertson', fighter2: 'TBD' },
      { fighter1: 'Billy Quarantillo', fighter2: 'Carlos Diego Ferreira' },
      { fighter1: 'Mateusz Gamrot', fighter2: 'TBD' },
    ],
  },
];

/**
 * Match a fight to an official UFC event by finding fighters in the event list.
 */
export function findUfcEventForFight(fighterA, fighterB) {
  if (!fighterA || !fighterB) return null;

  const normFighterA = normalizeName(fighterA);
  const normFighterB = normalizeName(fighterB);

  for (const event of UPCOMING_UFC_EVENTS) {
    for (const fight of event.fighters) {
      const norm1 = normalizeName(fight.fighter1);
      const norm2 = normalizeName(fight.fighter2);

      if (
        (norm1 === normFighterA && norm2 === normFighterB) ||
        (norm1 === normFighterB && norm2 === normFighterA)
      ) {
        return event.title;
      }
    }
  }

  return null;
}

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
