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
