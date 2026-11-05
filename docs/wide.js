// Runs in the head before first paint (docs/app.html): the "Fit screen" choice from the top bar, remembered per
// browser, widens the shell on desktop (docs/styles.css :root[data-wide]). Everything else about it lives in app.js.
try { if (localStorage.getItem('pp_wide') === '1') document.documentElement.dataset.wide = '1'; } catch { /* storage off: the narrow shell */ }
