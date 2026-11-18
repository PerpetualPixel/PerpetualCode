/**
 * A link that came from data, made safe to put in an href.
 *
 * Sportsbook links are relayed from the odds feeds as they come, and
 * escaping a value only stops it breaking out of the attribute: it says
 * nothing about where the link points. This keeps https links and paths on
 * this site, and turns everything else into "#": another scheme
 * (javascript:, data:, plain http:), a //host shortcut, or a value with a
 * control character in it (a browser drops tabs and line breaks from a URL
 * before reading its scheme, so "java<tab>script:" is "javascript:").
 */
export function safeUrl(value) {
  const u = String(value ?? '').trim();
  if (/^https:\/\//i.test(u)) return u;
  // eslint-disable-next-line no-control-regex
  if (!u || /[\u0000-\u001f\u007f]/.test(u) || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.startsWith('\\')) return '#';
  return u;
}
