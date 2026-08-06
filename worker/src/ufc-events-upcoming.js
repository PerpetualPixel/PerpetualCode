/**
 * Upcoming UFC/PFL events - manually maintained, updated weekly.
 * Format: date, event name, and fighters for the event.
 * This is the source of truth for official event titles.
 */

export const UPCOMING_UFC_EVENTS = [
  {
    date: '2026-08-07',
    title: 'UFC Fight Night: International Card',
    fighters: [
      { fighter1: 'Denis Goltsov', fighter2: 'Hasan Mezhiev' },
      { fighter1: 'Lewis McGrillen', fighter2: 'Brandon Lewis' },
      { fighter1: 'Trukon Carson', fighter2: 'Trey Waters' },
      { fighter1: 'Eduardo Neves', fighter2: 'Maxwell Djantou Nana' },
      { fighter1: 'Jonathan Martin', fighter2: 'Wilson Lopshire' },
      { fighter1: 'Valentin Moldavsky', fighter2: 'Bruno Cappelozza' },
    ],
  },
  {
    date: '2026-08-08',
    title: 'UFC Fight Night: Miller vs. Oliveira',
    fighters: [
      { fighter1: 'Juliana Miller', fighter2: 'Ravena Oliveira' },
      { fighter1: 'Miles Johns', fighter2: 'Jessie Rosas' },
      { fighter1: 'Manoel Sousa', fighter2: 'Richie Miranda' },
      { fighter1: 'Louie Sutherland', fighter2: 'Jose Montanha' },
      { fighter1: 'Diyar Nurgozhay', fighter2: 'Bruno Lopes' },
      { fighter1: 'Steven Asplund', fighter2: 'Guilherme Pat' },
      { fighter1: 'Michael Boylan', fighter2: 'Landry Ward' },
      { fighter1: 'Cheyanne Bowers', fighter2: 'Elora Dana' },
      { fighter1: 'Cheyden Leialoha', fighter2: 'Robbie Ring' },
      { fighter1: 'Josh Fremd', fighter2: 'Jhony Gregory' },
      { fighter1: 'Joshua Silveira', fighter2: 'Aaron Jeffery' },
      { fighter1: 'Dovletdzhan Yagshimuradov', fighter2: 'Simeon Powell' },
      { fighter1: 'Bryan Battle', fighter2: 'Dalton Rosta' },
      { fighter1: 'Giovanna Canuto', fighter2: 'Carol Foro' },
    ],
  },
  {
    date: '2026-08-09',
    title: 'UFC Fight Night: Miller vs. Goff',
    fighters: [
      { fighter1: 'Ty Miller', fighter2: 'Billy Goff' },
      { fighter1: 'Amanda Lemos', fighter2: 'Alexia Thainara' },
      { fighter1: 'Darren Elkins', fighter2: 'Yadier DelValle' },
      { fighter1: 'Carlos Diego Ferreira', fighter2: 'Billy Quarantillo' },
      { fighter1: 'Mateusz Gamrot', fighter2: 'Quillan Salkilld' },
    ],
  },
  {
    date: '2026-08-16',
    title: 'UFC 305: Makhachev vs. Garry',
    fighters: [
      { fighter1: 'Islam Makhachev', fighter2: 'Ian Garry' },
      { fighter1: 'Mackenzie Dern', fighter2: 'Gillian Robertson' },
      { fighter1: 'Vicente Luque', fighter2: 'Tresean Gore' },
      { fighter1: 'Neil Magny', fighter2: 'Ramiz Brahimaj' },
      { fighter1: 'Jeremiah Wells', fighter2: 'Myktybek Orolbai' },
      { fighter1: 'Jalin Turner', fighter2: 'Kauê Fernandes' },
      { fighter1: 'Edson Barboza', fighter2: 'Esteban Ribovics' },
      { fighter1: 'Mansur Abdul-Malik', fighter2: 'Dustin Stoltzfus' },
      { fighter1: 'Donte Johnson', fighter2: 'Eric McConico' },
      { fighter1: 'Chidi Njokuani', fighter2: 'Joel Alvarez' },
      { fighter1: 'Charles Johnson', fighter2: 'Jose Ochoa' },
      { fighter1: 'Rafael Tobias', fighter2: 'Lucas Fernando' },
    ],
  },
  {
    date: '2026-08-29',
    title: 'UFC Fight Night: Nurmagomedov vs. Yadong',
    fighters: [
      { fighter1: 'Umar Nurmagomedov', fighter2: 'Song Yadong' },
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
