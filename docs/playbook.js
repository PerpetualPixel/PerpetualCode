/**
 * Playbook (playbookbot.com), the Action Network bot on Discord and X that
 * turns a written bet into a pre-filled slip at any book, Fanatics and
 * bet365 included (2026-11-07 direction: "I use Playbook's bot on Discord
 * to create the links for Fanatics and other books; integrate this for at
 * least the parlay generator").
 *
 * Playbook has no public API and no documented link format: the bot reads
 * a message that tags it, with the book named and the legs written out,
 * and replies with a playbookbot.com slip. So the app writes that message
 * (one tap to share it to Discord on a phone, or copy it on a PC) and
 * takes the slip link back onto the card, where it becomes the ticket's
 * "Bet now" button. Pure helpers here; the DOM lives in app.js.
 */

/** How Playbook names each book in the tag line ("@Playbook Fanatics"). */
export const PLAYBOOK_BOOK_NAMES = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', caesars: 'Caesars', fanatics: 'Fanatics', betmgm: 'BetMGM',
  prizepicks: 'PrizePicks', hardrock: 'Hard Rock Bet', bet365: 'bet365', betrivers: 'BetRivers', espnbet: 'ESPN BET',
  kalshi: 'Kalshi', underdog: 'Underdog', sleeper: 'Sleeper',
};

export const PLAYBOOK_SITE = 'https://playbookbot.com/';
export const DISCORD_APP = 'https://discord.com/app';

/**
 * The tag that calls the bot. Pasted text never pings a Discord bot by
 * name, so a user who sets the bot's user id (Discord: Developer Mode,
 * right-click Playbook, Copy User ID) gets a real mention, <@id>; anyone
 * else gets the plain "@Playbook" to pick from Discord's autocomplete.
 */
export function playbookMention(setting) {
  const id = playbookUserId(setting);
  return id ? `<@${id}>` : '@Playbook';
}

/** The digits of a Discord user id out of "123", "<@123>" or "<@!123>"; null for anything else. */
export function playbookUserId(value) {
  const m = String(value ?? '').trim().match(/^(?:<@!?)?(\d{5,25})>?$/);
  return m ? m[1] : null;
}

/** A Discord link the user keeps for the channel they tag Playbook in (discord.com, discordapp.com or a discord.gg invite); null for anything else. */
export function discordChannelUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!['discord.com', 'discordapp.com', 'discord.gg', 'ptb.discord.com', 'canary.discord.com'].includes(host)) return null;
    return u.toString();
  } catch { return null; }
}

/** The first playbookbot.com link in a pasted reply, or null. */
export function cleanPlaybookLink(text) {
  const m = String(text ?? '').match(/https?:\/\/(?:www\.)?playbookbot\.com\/[^\s<>"']*/i);
  if (!m) return null;
  try { const u = new URL(m[0]); u.protocol = 'https:'; return u.toString().replace(/[.,;)]+$/, ''); } catch { return null; }
}

/** One leg the way Playbook reads it: the selection, then the game in brackets so a common name lands on the right player. */
export function playbookLegLine(leg) {
  const sel = String(leg?.selection ?? '').replace(/\s+/g, ' ').trim();
  if (!sel) return '';
  const game = String(leg?.game ?? '').replace(/\s+/g, ' ').trim();
  return game && !sel.includes(game) ? `${sel} (${game})` : sel;
}

/**
 * The message to post: the tag and the book on the first line, a leg per
 * line after it. `book` is a registry id (fanatics) or a name; an unknown
 * book is written as given so Playbook still sees it.
 */
export function playbookText({ legs, book, mention = null } = {}) {
  const lines = (legs ?? []).map(playbookLegLine).filter(Boolean);
  if (!lines.length) return '';
  const name = PLAYBOOK_BOOK_NAMES[String(book ?? '').toLowerCase()] ?? String(book ?? '').trim();
  return [`${playbookMention(mention)}${name ? ` ${name}` : ''}`, ...lines].join('\n');
}

/** The key a ticket's Playbook link is kept under: the book and its legs, in a fixed order, so a rebuilt ticket starts clean. */
export function playbookKey(book, legIds) {
  return `${String(book ?? '').toLowerCase()}|${(legIds ?? []).map((v) => String(v)).sort().join('+')}`;
}
