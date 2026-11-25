// Runs in the head, before the app's own script has been fetched (docs/app.html): the one job that cannot wait for it.
(function () {
  // The first board (2026-11-25: "optimize the website to load quicker"): asked for now, alongside the app's script,
  // rather than after it has downloaded and run. docs/app.js loadTrends takes this answer for its first read. The
  // address is docs/config.js's WORKER_URL (test/page-speed.test.mjs holds the two together).
  try {
    var trends = fetch('https://pixel-pick-odds.mgbouldering.workers.dev/trends', { headers: { Accept: 'application/json' } }).then(function (res) { return res.json(); });
    trends.catch(function () { /* the app asks again itself */ });
    window.ppEarly = { trends: trends };
  } catch (error) { /* no fetch: the app asks itself */ }
}());
