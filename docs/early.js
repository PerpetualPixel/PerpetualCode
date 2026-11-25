// Runs in the head, before the app's own script has been fetched (docs/app.html). Two jobs that cannot wait for it.
(function () {
  // The loader (docs/app.js loaderHtml, styles.css .pp-loader): the drawn emblem shows at once, and the film takes its
  // place the moment it is really playing. A browser that will not play it (a phone saving power, a blocked file)
  // never fires this, so the drawn one stays. Media events do not bubble, hence the capture.
  document.addEventListener('playing', function (event) {
    var video = event.target;
    if (video && video.classList && video.classList.contains('pp-loader-video') && video.parentElement) video.parentElement.classList.add('is-video');
  }, true);
  // The first board (2026-11-25: "optimize the website to load quicker"): asked for now, alongside the app's script,
  // rather than after it has downloaded and run. docs/app.js loadTrends takes this answer for its first read. The
  // address is docs/config.js's WORKER_URL (test/page-speed.test.mjs holds the two together).
  try {
    var trends = fetch('https://pixel-pick-odds.mgbouldering.workers.dev/trends', { headers: { Accept: 'application/json' } }).then(function (res) { return res.json(); });
    trends.catch(function () { /* the app asks again itself */ });
    window.ppEarly = { trends: trends };
  } catch (error) { /* no fetch: the app asks itself */ }
}());
