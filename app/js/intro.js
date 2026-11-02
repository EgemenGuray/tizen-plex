/* Lumen startup intro. Same timeline as the Apple app (IntroView.swift) and Shield (IntroScreen.kt).
 * draw(ctx, w, h, t) paints one frame at t seconds. Total length: LumenIntro.DURATION.
 * Timeline: 0-0.35 black | 0.35-0.95 the corner light ignites | 0.95 chime strike + flare
 * 0.95-1.9 light spills along the L | 1.9-2.4 hold | 2.4-3.2 zoom into the light | 3.05-3.6 fade into the app.
 */
(function (root) {
  var STRIKE = 0.95, ZOOM0 = 2.4, ZOOM1 = 3.2, FADE0 = 3.05, DURATION = 3.6;
  function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(a, b, x) { x = clamp((x - a) / (b - a)); return x * x * (3 - 2 * x); }
  function easeOut(x) { x = clamp(x); return 1 - Math.pow(1 - x, 3); }
  function easeIn(x) { x = clamp(x); return x * x * x; }

  /* All the numbers a port needs, at time t. */
  function state(t) {
    var ignite = smooth(0.35, STRIKE, t);                       // corner light 0..1
    var flare = Math.exp(-Math.pow((t - STRIKE) / 0.22, 2));      // bloom at the strike
    var spill = easeOut((t - 0.55) / 1.35);                       // how far the light runs along the arms
    var breathe = t > 1.9 && t < ZOOM0 ? 0.06 * Math.sin((t - 1.9) / 0.5 * Math.PI) : 0;
    var z = clamp((t - ZOOM0) / (ZOOM1 - ZOOM0));
    return {
      ignite: ignite,
      flare: t < 0.5 ? 0 : flare,
      radius: 3 + 61 * spill,                    // gradient radius in logo units (final 64 = the icon)
      glow: Math.min(1, ignite * (0.85 + 0.55 * flare) + breathe),
      zoom: Math.exp(Math.log(70) * easeIn(z)),  // 1 -> 70x
      pan: easeOut(z * 1.4),                     // corner moves to screen centre while zooming
      wash: 0.5 * smooth(0.45, 1, z),           // warm wash as we fly into the light
      fade: 1 - smooth(FADE0, DURATION, t)       // intro layer opacity
    };
  }

  function draw(ctx, w, h, t) {
    var s = state(t);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    var unit = Math.min(w, h) * 0.0058;          // logo units -> px (mark is ~66x76 units incl. caps)
    var cx = 33, cy = 79;                        // light source: the corner of the L
    var fx = 38, fy = 74;                        // zoom target: the brightest point on the bend
    var restX = w / 2 + (fx - 59.5) * unit, restY = h / 2 + (fy - 47.5) * unit;
    var px = restX + (w / 2 - restX) * s.pan, py = restY + (h / 2 - restY) * s.pan;
    ctx.translate(px, py);
    ctx.scale(unit * s.zoom, unit * s.zoom);
    ctx.translate(-fx, -fy);

    // soft glow behind the corner
    if (s.glow > 0.001) {
      var g = ctx.createRadialGradient(36, 75, 0, 36, 75, 28 + 10 * s.flare);
      g.addColorStop(0, 'rgba(255,207,138,' + (0.85 * s.glow) + ')');
      g.addColorStop(0.4, 'rgba(255,154,77,' + (0.3 * s.glow) + ')');
      g.addColorStop(1, 'rgba(255,122,61,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(36, 75, 40, 0, Math.PI * 2); ctx.fill();
    }
    // the L, lit from its corner
    if (s.ignite > 0.001) {
      var r = s.radius;
      var lg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      var a = s.ignite;
      lg.addColorStop(0, 'rgba(255,255,255,' + a + ')');
      lg.addColorStop(0.22, 'rgba(255,230,184,' + a + ')');
      lg.addColorStop(0.55, 'rgba(255,154,77,' + a + ')');
      lg.addColorStop(1, 'rgba(255,90,61,0)');
      ctx.strokeStyle = lg;
      ctx.lineWidth = 13; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(33, 16); ctx.lineTo(33, 62);
      ctx.quadraticCurveTo(33, 79, 50, 79); ctx.lineTo(86, 79);
      ctx.stroke();
    }
    // flare: additive bloom at the strike
    if (s.flare > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      var fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 70);
      fg.addColorStop(0, 'rgba(255,240,215,' + (0.55 * s.flare) + ')');
      fg.addColorStop(0.15, 'rgba(255,190,120,' + (0.25 * s.flare) + ')');
      fg.addColorStop(1, 'rgba(255,120,60,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(cx - 70, cy - 70, 140, 140);
      // thin horizontal streak, like light leaking past a curtain edge
      var sg = ctx.createLinearGradient(cx - 90, 0, cx + 90, 0);
      sg.addColorStop(0, 'rgba(255,170,100,0)');
      sg.addColorStop(0.5, 'rgba(255,236,205,' + (0.5 * s.flare) + ')');
      sg.addColorStop(1, 'rgba(255,170,100,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(cx - 90, cy - 0.9, 180, 1.8);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    if (s.wash > 0.001) {
      ctx.fillStyle = 'rgba(255,228,190,' + s.wash + ')';
      ctx.fillRect(0, 0, w, h);
    }
  }

  root.LumenIntro = { draw: draw, state: state, DURATION: DURATION, STRIKE: STRIKE };
})(this);

/* Plays the intro over the app on boot: a full-screen canvas plus the chime. Any key skips it. */
var Intro = (function () {
    'use strict';
    var cv = null, audio = null, done = null, raf = 0, t0 = 0;

    function active() { return !!cv; }

    function finish(skipped) {
        if (!cv) return;
        cancelAnimationFrame(raf);
        var c = cv; cv = null;
        if (skipped) {
            c.style.transition = 'opacity .25s ease-out';
            c.style.opacity = '0';
            setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 300);
            if (audio) fadeOut(audio);
        } else if (c.parentNode) {
            c.parentNode.removeChild(c);
        }
        var cb = done; done = null;
        if (cb) cb();
    }

    function fadeOut(a) {
        var v = a.volume, id = setInterval(function () {
            v -= 0.125;
            if (v <= 0) { clearInterval(id); a.pause(); return; }
            a.volume = v;
        }, 50);
    }

    function frame(now) {
        if (!cv) return;
        // Follow the chime's clock when it's playing so picture and sound stay together.
        var t = audio && !audio.paused && audio.currentTime > 0 ? audio.currentTime : (now - t0) / 1000;
        if (t >= LumenIntro.DURATION) { finish(false); return; }
        LumenIntro.draw(cv.getContext('2d'), cv.width, cv.height, t);
        cv.style.opacity = LumenIntro.state(t).fade;
        raf = requestAnimationFrame(frame);
    }

    /* opts.sound: play the chime. cb: called when the intro ends or is skipped. */
    function play(opts, cb) {
        done = cb;
        cv = document.createElement('canvas');
        cv.id = 'intro';
        cv.width = 1920; cv.height = 1080;
        document.body.appendChild(cv);
        LumenIntro.draw(cv.getContext('2d'), cv.width, cv.height, 0);
        if (opts.sound) {
            try {
                audio = new Audio('media/lumen_chime.mp3');
                var p = audio.play();
                if (p && p.catch) p.catch(function () { audio = null; });
            } catch (e) { audio = null; }
        }
        t0 = performance.now();
        raf = requestAnimationFrame(frame);
    }

    return { play: play, active: active, skip: function () { finish(true); } };
})();
