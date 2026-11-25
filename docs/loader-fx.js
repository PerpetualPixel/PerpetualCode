// The loader's animation, drawn on the page itself (2026-11-25, the owner, of the film it replaces: "the loading
// animation shows the whole area outline, can we seamlessly integrate this ... so you cant see an ugly defined border.
// Also I'd like to polish up the animation to have more of an orb and the orb to go around the infinity symbol in a
// looping pattern with a beginning and ending frame overlapping so when it plays again, it looks like it never ended").
//
// A film is a rectangle: on a phone it sat over the page's grid as a flat block with edges. This is a canvas with a
// clear ground, so the page shows through everywhere the light is not. An orb of light laps an infinity in the
// logo's colours, with a comet tail, sparks shed behind it, and a flare each time it crosses the middle. Every part
// is worked out from where the orb is on its lap and nothing else, so the last frame of a lap is the first of the
// next: it has no seam to see.
//
// A plain script (no imports), loaded in the head by any page with a loader: it draws every <canvas
// class="pp-loader-fx"> on the page and stops by itself when none is showing. docs/app.js loaderHtml calls
// ppLoaderFx.start() when it puts a loader up. Still for a reduced-motion user: nothing is drawn, and the page's own
// drawn emblem stays.
(function () {
  'use strict';
  var TAU = Math.PI * 2;
  /** One lap of the orb, in milliseconds. */
  var LAP = 2600;
  var still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The track: a figure of eight, as points an equal step of path apart, so the orb keeps one speed all the way round.
  var M = 240;
  var P = (function () {
    var raw = []; var total = 0; var n = 720; var i;
    for (i = 0; i <= n; i++) {
      // Starts at the middle heading up and to the right, takes the right loop, then the left.
      var th = Math.PI / 2 - (i / n) * TAU;
      var c = Math.cos(th); var s = Math.sin(th);
      var d = 1 + 0.22 * s * s;
      raw.push({ x: c / d, y: -(s * c * 0.92) / d });
      if (i) total += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
      raw[i].at = total;
    }
    var out = []; var k = 0;
    for (i = 0; i < M; i++) {
      var want = (i / M) * total;
      while (k < n - 1 && raw[k + 1].at < want) k++;
      var a = raw[k]; var b = raw[k + 1]; var f = (want - a.at) / Math.max(1e-9, b.at - a.at);
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return out;
  }());
  /** The point a fraction u of the way round (0 to 1, wrapping), between its two nearest steps. */
  function at(u) {
    var v = ((u % 1) + 1) % 1 * M; var i = Math.floor(v); var f = v - i;
    var a = P[i % M]; var b = P[(i + 1) % M];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
  // Where the track crosses itself: the two moments of a lap the orb is at the middle.
  var CROSS = (function () {
    var best = []; var i;
    for (i = 0; i < M; i++) best.push({ u: i / M, d: Math.hypot(P[i].x, P[i].y) });
    best.sort(function (p, q) { return p.d - q.d; });
    var first = best[0].u; var second = first;
    for (i = 1; i < best.length; i++) { var gap = Math.abs(best[i].u - first); if (Math.min(gap, 1 - gap) > 0.25) { second = best[i].u; break; } }
    return [first, second];
  }());
  /** The same "random" number every time for the same spark: a spark's path is part of the loop, not chance. */
  function rnd(k, salt) { var v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453; return v - Math.floor(v); }
  var SPARK_COLOURS = ['155,233,255', '255,138,230', '255,255,255', '255,217,138', '139,92,246'];

  /** One frame on a canvas, the orb a fraction `phase` of the way round its lap. */
  function draw(canvas, phase) {
    var ctx = canvas.getContext('2d'); if (!ctx) return;
    var w = canvas.width; var h = canvas.height;
    var cx = w / 2; var cy = h / 2;
    // The figure fills most of the width and leaves room around it for the glow and the sparks: nothing meets an edge.
    var A = Math.min(w * 0.35, h * 0.72);
    var X = function (p) { return cx + p.x * A; }; var Y = function (p) { return cy + p.y * A; };
    var small = w < 260;
    var lw = Math.max(1.4, A * 0.036);
    var i; var j; var p; var q;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // The track, in the logo's colours left to right, with a soft glow under it.
    var grad = ctx.createLinearGradient(cx - A, 0, cx + A, 0);
    grad.addColorStop(0, '#ff2bd6'); grad.addColorStop(0.5, '#8b5cf6'); grad.addColorStop(1, '#22e3ff');
    ctx.beginPath(); ctx.moveTo(X(P[0]), Y(P[0]));
    for (i = 1; i < M; i++) ctx.lineTo(X(P[i]), Y(P[i]));
    ctx.closePath();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = grad;
    ctx.globalAlpha = 0.14; ctx.lineWidth = lw * 3.4; ctx.stroke();
    ctx.globalAlpha = 0.62; ctx.lineWidth = lw; ctx.stroke();

    // Light adds to light from here on.
    ctx.globalCompositeOperation = 'lighter';

    // The comet tail: the stretch of track the orb has just run, bright and wide at the orb, thin and gone behind it.
    // Laid down as whole strokes of different lengths, every one starting at the orb: where more of them lie over each
    // other (nearer the orb) the light adds up, so it fades evenly along its length with no joins to show.
    var TAIL = 0.36; var layers = small ? 10 : 20; var steps = Math.round(M * TAIL);
    ctx.lineCap = 'butt';
    for (var n = layers; n >= 1; n--) {
      var cover = n / layers;                                   // how much of the tail this stroke runs
      var upto = Math.max(2, Math.round(steps * cover));
      ctx.beginPath();
      for (j = 0; j <= upto; j++) { p = at(phase - j / M); if (!j) ctx.moveTo(X(p), Y(p)); else ctx.lineTo(X(p), Y(p)); }
      ctx.strokeStyle = grad; ctx.globalAlpha = 0.085; ctx.lineWidth = lw * (1.1 + 3.1 * (1 - cover)); ctx.stroke();
      // The white-hot core lives in the nearer half only.
      if (cover <= 0.5) { ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.14; ctx.lineWidth = lw * (0.55 + 1.0 * (1 - cover * 2)); ctx.stroke(); }
    }
    ctx.lineCap = 'round';

    // Sparks: each leaves the track at its own point of the lap, drifts off to one side and fades. Where it is depends on the lap alone.
    var S = small ? 16 : 54;
    for (var k = 0; k < S; k++) {
      var born = (k + rnd(k, 1)) / S;
      var age = ((phase - born) % 1 + 1) % 1;
      var life = 0.16 + 0.26 * rnd(k, 2);
      if (age >= life) continue;
      var t = age / life;
      p = at(born); q = at(born + 0.004);
      var tx = q.x - p.x; var ty = q.y - p.y; var tl = Math.hypot(tx, ty) || 1;
      var side = rnd(k, 3) < 0.5 ? -1 : 1;
      var out = A * (0.05 + 0.22 * rnd(k, 4)) * (1 - Math.pow(1 - t, 2));   // quick away from the track, then slowing
      var back = A * 0.10 * rnd(k, 5) * t;
      var sx = X(p) + (-ty / tl) * side * out - (tx / tl) * back;
      var sy = Y(p) + (tx / tl) * side * out - (ty / tl) * back;
      var size = Math.max(0.8, lw * (0.28 + 0.6 * rnd(k, 6)) * (1 - 0.55 * t));
      ctx.globalAlpha = Math.pow(1 - t, 1.4) * (0.7 + 0.3 * rnd(k, 7));
      ctx.fillStyle = 'rgb(' + SPARK_COLOURS[Math.floor(rnd(k, 8) * SPARK_COLOURS.length)] + ')';
      ctx.beginPath(); ctx.arc(sx, sy, size, 0, TAU); ctx.fill();
    }

    // A flare where the track crosses, as the orb goes through it.
    var flare = 0;
    for (i = 0; i < CROSS.length; i++) { var dph = Math.abs(phase - CROSS[i]); dph = Math.min(dph, 1 - dph); flare = Math.max(flare, Math.exp(-Math.pow(dph / 0.045, 2))); }
    if (flare > 0.02) {
      var fr = A * (0.16 + 0.22 * flare);
      var fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr);
      fg.addColorStop(0, 'rgba(255,255,255,' + (0.55 * flare).toFixed(3) + ')');
      fg.addColorStop(0.35, 'rgba(170,150,255,' + (0.30 * flare).toFixed(3) + ')');
      fg.addColorStop(1, 'rgba(34,227,255,0)');
      ctx.globalAlpha = 1; ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(cx, cy, fr, 0, TAU); ctx.fill();
    }

    // The orb: a white-hot centre in a halo that runs from ice blue to the logo's pink. It breathes three times a lap.
    p = at(phase);
    var ox = X(p); var oy = Y(p);
    var breathe = 1 + 0.07 * Math.sin(phase * TAU * 3);
    var R = Math.max(6, A * 0.40) * breathe;
    var halo = ctx.createRadialGradient(ox, oy, 0, ox, oy, R);
    halo.addColorStop(0, 'rgba(255,255,255,1)');
    halo.addColorStop(0.20, 'rgba(255,255,255,0.97)');
    halo.addColorStop(0.30, 'rgba(190,243,255,0.80)');
    halo.addColorStop(0.42, 'rgba(150,170,255,0.42)');
    halo.addColorStop(0.62, 'rgba(210,90,255,0.18)');
    halo.addColorStop(0.82, 'rgba(255,43,214,0.06)');
    halo.addColorStop(1, 'rgba(255,43,214,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(ox, oy, R, 0, TAU); ctx.fill();
    // The core once more, so the centre reads as a solid ball of light.
    var cr = R * 0.29;
    var core = ctx.createRadialGradient(ox - cr * 0.18, oy - cr * 0.22, 0, ox, oy, cr);
    core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(0.72, 'rgba(240,250,255,0.92)'); core.addColorStop(0.9, 'rgba(180,235,255,0.5)'); core.addColorStop(1, 'rgba(160,220,255,0)');
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(ox, oy, cr, 0, TAU); ctx.fill();

    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  /** Size a canvas to the box it sits in, at the screen's own sharpness (up to 3x). False when it is not on show. */
  function fit(canvas) {
    var cw = canvas.clientWidth; var ch = canvas.clientHeight;
    if (!cw || !ch) return false;
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var w = Math.round(cw * dpr); var h = Math.round(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return true;
  }

  var running = false; var idle = 0; var t0 = 0;
  function frame(now) {
    var list = document.querySelectorAll('canvas.pp-loader-fx'); var shown = 0;
    if (!document.hidden) {
      var phase = ((now - t0) % LAP) / LAP;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!fit(c)) continue;
        shown++;
        draw(c, phase);
        // The page's drawn emblem steps aside once this is on screen (styles.css .pp-loader-art.is-fx).
        if (c.parentElement && !c.parentElement.classList.contains('is-fx')) c.parentElement.classList.add('is-fx');
      }
    }
    // Nothing on show for a third of a second: stop, until a loader goes up again.
    if (shown) idle = 0; else if (++idle > 20) { running = false; return; }
    requestAnimationFrame(frame);
  }
  function start() {
    if (still || running || typeof requestAnimationFrame !== 'function') return;
    running = true; idle = 0;
    if (!t0) t0 = performance.now();
    requestAnimationFrame(frame);
  }

  window.ppLoaderFx = { start: start, draw: draw, fit: fit, lapMs: LAP };
  // The loaders already in the page when it arrives, a tab switched to, a page come back to.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) start(); });
  document.addEventListener('click', function () { setTimeout(start, 0); }, true);
}());
