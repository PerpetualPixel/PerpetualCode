/**
 * A fighter's UFC stat line: what is landed and absorbed a minute, how much
 * of what is thrown at the fighter misses, the takedowns landed and stopped,
 * knockdowns, and how long the fights last.
 *
 * Two sources, read by the runner (scripts/ufc-card.mjs; the worker is
 * refused by both):
 *
 *   UFC.com's athlete page   everything, the absorbed and defence numbers
 *                            included. HTML, found by the fighter's name.
 *   ESPN's core statistics   the landed side only (strikes a minute and
 *                            their accuracy, takedowns per 15 minutes and
 *                            their accuracy, submission attempts). JSON,
 *                            found by the id the card already carries.
 *
 * UFC.com's numbers win where both have one; ESPN fills what UFC.com lacks
 * (a fighter whose page is under another address, or who has none yet).
 * The Sharp analysis on a fight (worker/src/ufc-sharp.js) reads the result.
 */

export const UFC_STATS_KEY = 'ufc:stats';
export const UFC_COM_ATHLETE = 'https://www.ufc.com/athlete';
export const ESPN_CORE_ATHLETE = 'https://sports.core.api.espn.com/v2/sports/mma/athletes';

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** UFC.com's address for a fighter: "Jiří Procházka" is jiri-prochazka. */
export const ufcComSlug = (name) => plain(name).toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** "13:48" as seconds. */
const clock = (text) => { const m = String(text ?? '').match(/^(\d+):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/**
 * UFC.com's athlete page as a stat line, or null when the page carries
 * none (a fighter yet to fight in the UFC, or not the page of a fighter at
 * all). Each number sits in the element before its label:
 *
 *   <div class="c-stat-compare__number">2.74 </div>
 *   <div class="c-stat-compare__label">Sig. Str. Absorbed</div>
 *
 * with a percent sign in its own element after the number for the two
 * defence figures. `name`, when given, must be the fighter the page is
 * about (its <title>), so a name that happens to be someone else's address
 * is not read as the wrong fighter's.
 */
export function parseUfcComStats(html, { name = null } = {}) {
  const text = String(html ?? '');
  if (!text) return null;
  if (name) {
    const title = text.match(/<title>\s*([^|<]+?)\s*(?:\||<)/i)?.[1];
    const key = (s) => plain(s).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (title) {
      const want = key(name).split(' '); const got = key(title).split(' ');
      // The surname, and one more name in common when either side has more than one.
      if (want.at(-1) !== got.at(-1) && !got.includes(want.at(-1))) return null;
    }
  }
  const found = {};
  const re = /c-stat-compare__number">\s*([\d.:]+)[\s\S]{0,140}?c-stat-compare__label">\s*([^<]+?)\s*</g;
  let m;
  while ((m = re.exec(text))) found[m[2].toLowerCase()] = m[1];
  // The two accuracy figures are drawn as charts on the page; the striking one reads cleanly out of its caption. The
  // takedown one does not (a dry run printed 3% for a fighter landing 4.7 takedowns per 15 minutes), so it is left to
  // ESPN, which states it outright.
  const strAcc = num(text.match(/Striking accuracy\s*(\d{1,3})%/i)?.[1]);
  const out = {
    slpm: num(found['sig. str. landed']),
    sapm: num(found['sig. str. absorbed']),
    strAcc,
    strDef: num(found['sig. str. defense']),
    tdAvg: num(found['takedown avg']),
    tdAcc: null,
    tdDef: num(found['takedown defense']),
    subAvg: num(found['submission avg']),
    kdAvg: num(found['knockdown avg']),
    avgFightSec: clock(found['average fight time']),
  };
  // A page with no fights behind it prints zeros throughout and no fight time: not a stat line.
  if (out.slpm == null && out.sapm == null && out.tdAvg == null) return null;
  if (!out.avgFightSec && !(out.slpm > 0) && !(out.sapm > 0)) return null;
  return out;
}

/** ESPN's core statistics for an athlete as the landed half of a stat line, or null. */
export function parseEspnStats(json) {
  const stats = (json?.splits?.categories ?? []).flatMap((c) => c.stats ?? []);
  if (!stats.length) return null;
  const get = (name) => num(stats.find((s) => s.name === name)?.value);
  const out = { slpm: get('strikeLPM'), strAcc: get('strikeAccuracy'), tdAvg: get('takedownAvg'), tdAcc: get('takedownAccuracy'), subAvg: get('submissionAvg') };
  return Object.values(out).some((v) => v != null) ? out : null;
}

const FIELDS = ['slpm', 'sapm', 'strAcc', 'strDef', 'tdAvg', 'tdAcc', 'tdDef', 'subAvg', 'kdAvg', 'avgFightSec'];

/** The two sources as one line: UFC.com's number where it has one, ESPN's otherwise. Null when neither has anything. */
export function mergeFighterStats(ufcCom, espn, at = Date.now()) {
  if (!ufcCom && !espn) return null;
  const out = {};
  // ESPN states the two accuracies as numbers; UFC.com's are read off chart captions, so ESPN's lead for those.
  for (const k of FIELDS) out[k] = (k === 'strAcc' || k === 'tdAcc' ? espn?.[k] ?? ufcCom?.[k] : ufcCom?.[k] ?? espn?.[k]) ?? null;
  out.sources = [ufcCom ? 'ufc.com' : null, espn ? 'espn' : null].filter(Boolean);
  out.at = at;
  return out;
}
