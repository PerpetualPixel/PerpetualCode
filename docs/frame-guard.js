/*
 * Refuses to run inside another site's frame.
 *
 * A page that can be loaded invisibly inside someone else's page can have
 * its buttons clicked for a visitor who thinks they are clicking something
 * else (clickjacking). The proper fix is a response header
 * (frame-ancestors), which GitHub Pages cannot send and a <meta> policy is
 * not allowed to carry, so every page loads this first instead: framed by
 * another origin, the document is hidden, and the top window is asked to
 * go to the page itself (a browser usually refuses that without a click
 * from the visitor, which is fine: hidden is the protection). A frame that
 * forbids scripts cannot run this, and cannot run the page either: nothing
 * here works without its scripts.
 *
 * Loaded as a file, not inline, because the pages' Content-Security-Policy
 * refuses inline script.
 */
(function frameGuard() {
  if (window.top === window.self) return;
  try {
    // Framed by this same site: allowed.
    if (window.top.location.origin === window.location.origin) return;
  } catch {
    // Reading a cross-origin parent throws: that is the case being refused.
  }
  document.documentElement.style.display = 'none';
  try {
    window.top.location = window.self.location.href;
  } catch {
    // The frame forbids navigating the top window: stay hidden.
  }
}());
