/**
 * The page behind a Discord card's "More info" button, and behind its book links that need finishing for the
 * reader (2026-11-25, the owner: the button showed the worker's own address, which carries part of a personal
 * email address; "I'd rather it not have my workers info"). A Discord message now only ever links here, on the
 * site's own name:
 *
 *   play.html?id=<play>             shows that play's page (the worker draws it; it is framed here)
 *   play.html?id=<play>&go=<book>   goes on to that book with the bet on the slip
 *
 * Only an id and a book in the shapes the worker uses are passed on, so the page cannot be used to send anyone
 * anywhere else.
 */
import { CONFIG } from './config.js';

const params = new URLSearchParams(window.location.search);
const id = params.get('id') ?? '';
const book = params.get('go') ?? '';
const frame = document.getElementById('playFrame');
const note = document.getElementById('playNote');

if (!/^[\w:.-]{1,120}$/.test(id) || !CONFIG.WORKER_URL) {
  note.hidden = false;
} else if (book) {
  if (/^[a-z0-9_]{1,40}$/.test(book)) window.location.replace(`${CONFIG.WORKER_URL}/go/${encodeURIComponent(id)}/${book}`);
  else note.hidden = false;
} else {
  frame.src = `${CONFIG.WORKER_URL}/play/${encodeURIComponent(id)}`;
  frame.hidden = false;
}
