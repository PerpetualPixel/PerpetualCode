/**
 * A book's slip link, made to work on a phone (2026-11-24, the owner:
 * "When I attempt to 'add to slip' with Hardrock it just takes me to
 * https://app.hardrock.bet/downloadApp. Is there a way around it?").
 *
 * Hard Rock has no sportsbook website on a phone: every page of
 * app.hardrock.bet sends a phone to its "download our app" page, and the
 * app does not claim those pages as links of its own, so the feed's link
 * (app.hardrock.bet/?deep_link_value=betslip/<selection>) can only reach a
 * slip on a desktop. The app does claim share.hardrock.bet/Pt0T/*, the
 * link its own bet slip gives out when a bet is shared:
 *
 *   https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/<a>,<b>
 *
 * so on a phone the feed's link is rewritten to that one, which opens the
 * app with the selections on the slip. Both forms take several selections
 * joined by commas, which is one link for a whole parlay.
 */

/** The link Hard Rock's own slip shares a bet with: the app opens it. */
export const HARDROCK_SHARE = 'https://share.hardrock.bet/Pt0T/bet';
const HARDROCK_WEB = 'https://app.hardrock.bet/';
const HR_SLIP = /^https:\/\/app\.hardrock\.bet\/\?(?:[^#]*&)?deep_link_value=betslip\/(\d+(?:,\d+)*)(?=$|[&#])/;

/** The selections a Hard Rock slip link carries, or null when it is not one (an event page, another book). */
export function hardRockSelections(link) {
  const m = HR_SLIP.exec(String(link ?? ''));
  return m ? m[1].split(',') : null;
}

/** A Hard Rock link that puts these selections on the slip: the shared-bet link on a phone, the website's on a desktop. */
export function hardRockSlipLink(ids, { phone = false } = {}) {
  const list = (ids ?? []).map(String).filter((id) => /^\d+$/.test(id));
  if (!list.length) return null;
  return phone ? `${HARDROCK_SHARE}?deep_link_value=hardrock://betslip/${list.join(',')}` : `${HARDROCK_WEB}?deep_link_value=betslip/${list.join(',')}`;
}

/** One link for every leg of a Hard Rock ticket, or null when a leg's link carries no selection. */
export function hardRockCombined(links) {
  const ids = (links ?? []).map(hardRockSelections);
  return ids.length && ids.every(Boolean) ? hardRockSlipLink(ids.flat()) : null;
}

/** A slip link as a phone should be given it: Hard Rock's becomes the one its app opens; every other link is returned as it came. */
export function phoneSlipLink(link) {
  const ids = hardRockSelections(link);
  return ids ? hardRockSlipLink(ids, { phone: true }) : link;
}

/** Is this a phone or a tablet: where a book's app, not its website, takes the bet. (An iPad says it is a Mac; its touch screen gives it away.) */
export function isPhone(userAgent, maxTouchPoints = 0) {
  const ua = String(userAgent ?? '');
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
}

/**
 * A pick written out to paste (2026-11-24, of Onyx, which the odds feed does
 * not carry: "Allowing quick imports for users to the app. Odds don't matter
 * as much"). With no prices and no selection ids there is no link that puts
 * a pick on Onyx's slip, so the quick way in is the pick on the clipboard
 * and Onyx open: a line a leg, the selection and then its game.
 * `legs` is [{selection, game}].
 */
export function pickText(legs) {
  return (legs ?? []).map((l) => { const sel = String(l?.selection ?? '').replace(/\s+/g, ' ').trim(); const game = String(l?.game ?? '').replace(/\s+/g, ' ').trim(); return sel ? `${sel}${game ? ` (${game})` : ''}` : ''; }).filter(Boolean).join('\n');
}

/**
 * The state a book's link is for (2026-11-24, the owner, of Caesars: "Open
 * the books URL, not the app, fix that"). Caesars and BetMGM run a site a
 * state, and the feed writes their slip links with the state left as a
 * placeholder, `{state}`:
 *
 *   https://sportsbook.caesars.com/us/{state}/bet?selectionIds=...&dl=betslip
 *   https://sports.{state}.betmgm.com/en/sports?options=...&type=Single
 *
 * Nothing filled it in, so a tap opened Caesars at an address with the
 * braces still in it: the book's front page, never the slip in its app.
 * withState writes the user's state into the link; a link with no
 * placeholder comes back as it was, and one with a placeholder and no
 * state known comes back null (the caller asks for the state).
 */
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const STATE_SLOT = /\{state\}|%7Bstate%7D/gi;
export const needsState = (link) => /\{state\}|%7Bstate%7D/i.test(String(link ?? ''));
/** A two-letter state out of whatever was stored or detected ("nj", "NJ", "US-NJ"), or null. */
export function cleanState(value) {
  const v = String(value ?? '').toUpperCase().replace(/^US-/, '').trim();
  return US_STATES.includes(v) ? v : null;
}
export function withState(link, state) {
  if (!needsState(link)) return link;
  const st = cleanState(state);
  return st ? String(link).replace(STATE_SLOT, st.toLowerCase()) : null;
}
