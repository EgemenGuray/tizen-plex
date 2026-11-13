// Live TV performance check in headless Chromium with the CPU slowed down (default 6x, roughly a Samsung TV).
//   python3 scripts/perf/gen.py /tmp/iptv-data              # 20k-channel M3U, Xtream (10k live, 50k films, 10k series), 114 MB XMLTV
//   python3 scripts/perf/server.py app /tmp/iptv-data 8101 &  # the app plus the mock sources under /mock/
//   node scripts/perf/bench.js http://127.0.0.1:8101/ [rate] [noworker]
const { chromium } = require('playwright');
const BASE = process.argv[2], RATE = +(process.argv[3] || 6), NOWORKER = process.argv[4] === 'noworker';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load/.test(m.text())) console.log('CONSOLE', m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  if (NOWORKER) await page.addInitScript(() => { window.Worker = undefined; });
  await page.addInitScript(() => {
    if (!localStorage.getItem('plexhdr.iptv.playlists')) {
      localStorage.setItem('plexhdr.iptv.playlists', JSON.stringify([
        { id: 'pl-m3u', name: 'Big M3U', kind: 'm3u', url: location.origin + '/mock/big.m3u', username: '', password: '', epgURL: location.origin + '/mock/guide.xml', userAgent: '', colorIndex: 0, enabled: true, lastRefresh: null },
        { id: 'pl-x', name: 'Xtream', kind: 'xtream', url: location.origin + '/mock', username: 'u', password: 'p', epgURL: '', userAgent: '', colorIndex: 1, enabled: true, lastRefresh: null }]));
      localStorage.setItem('plexhdr.settings', JSON.stringify({ intro: 'off' }));
      localStorage.setItem('plexhdr.iptv.only', 'true');
      localStorage.setItem('plexhdr.iptv.section', '"home"');
    }
    window.__lt = { n: 0, sum: 0, max: 0, tbt: 0 };
    try {
      new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { var s = window.__lt; s.n++; s.sum += e.duration; s.tbt += Math.max(0, e.duration - 50); if (e.duration > s.max) s.max = e.duration; }); }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    window.__frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }); };
    window.__until = function (f, ms) { return new Promise(function (ok, fail) { var t0 = Date.now(); (function poll() { var v; try { v = f(); } catch (e) {} if (v) return ok(v); if (Date.now() - t0 > (ms || 600000)) return fail(new Error('timeout')); setTimeout(poll, 20); })(); }); };
  });
  const out = {};
  const lt = () => page.evaluate(() => { var s = window.__lt; return { longTasks: s.n, maxLongTaskMs: Math.round(s.max), totalBlockingMs: Math.round(s.tbt) }; });
  // Cold start: empty cache, downloads + parses everything.
  await page.goto(BASE + 'index.html');
  out.coldLoadMs = await page.evaluate(() => __until(() => IPTV.playlists().every(p => !IPTV.loading(p.id) && IPTV.content(p.id)) && IPTV.hasGuide() && !IPTV.guideLoading()).then(() => Math.round(performance.now())));
  out.coldLoadMainThread = await lt();
  out.counts = await page.evaluate(() => ({ channels: IPTV.channels().length, movies: IPTV.movies().length, series: IPTV.series().length }));
  await page.waitForTimeout(3000); // let IndexedDB writes finish
  // Warm start: from the IndexedDB cache.
  await page.reload();
  out.warmLoadMs = await page.evaluate(() => __until(() => IPTV.channels().length > 0 && IPTV.hasGuide() && document.querySelector('#app .iptv-body') && !document.querySelector('#app .spinner')).then(() => Math.round(performance.now())));
  await page.waitForTimeout(1500);
  out.warmLoadMainThread = await lt();
  const heap = await cdp.send('Runtime.getHeapUsage'); out.jsHeapMB = Math.round(heap.usedSize / 1048576);
  async function openSec(id) {
    return page.evaluate(id => {
      var t0 = performance.now();
      document.querySelector('[data-id="tab-iptv:' + id + '"]')._select();
      return __until(() => document.querySelector('#app .iptv-body') && UI.kit.focused() && document.body.contains(UI.kit.focused()) && !document.querySelector('#app .spinner'))
        .then(__frame).then(() => Math.round(performance.now() - t0));
    }, id);
  }
  async function keys(sel, dir, n, extra) {
    return page.evaluate(([sel, dir, n]) => {
      if (sel) UI.kit.focus(document.querySelector(sel));
      var lat = [], sync = [];
      function one(i) {
        if (i >= n) return Promise.resolve();
        var t0 = performance.now();
        UI.move(dir);
        sync.push(performance.now() - t0);
        return __frame().then(function () { lat.push(performance.now() - t0); return one(i + 1); });
      }
      return one(0).then(function () {
        lat.sort((a, b) => a - b); sync.sort((a, b) => a - b);
        var f = UI.kit.focused();
        return { median: Math.round(lat[lat.length >> 1]), p95: Math.round(lat[Math.floor(lat.length * .95)]), max: Math.round(lat[lat.length - 1]), syncMedian: +sync[sync.length >> 1].toFixed(1), syncMax: +sync[sync.length - 1].toFixed(1), focusables: document.querySelectorAll('#app .focusable').length, endedOn: f ? f.textContent.slice(0, 40) : null };
      });
    }, [sel, dir, n]);
  }
  out.openLiveMs = await openSec('live');
  out.liveDown40 = await keys('.iptv-col.channels .focusable', 'down', 40);
  out.liveUp40 = await keys(null, 'up', 40);
  out.liveUpToTags = await keys(null, 'up', 1);
  out.liveGroupsDown20 = await keys('.iptv-col.groups .focusable', 'down', 20);
  out.liveLeftRight = await keys('.iptv-col.channels .focusable', 'left', 1);
  out.liveSelectGroupMs = await page.evaluate(() => { var t0 = performance.now(); var r = document.querySelectorAll('.iptv-col.groups .focusable')[5]; UI.kit.focus(r); r._select(); return __until(() => UI.kit.focused() && document.body.contains(UI.kit.focused()) && !document.querySelector('#app .spinner')).then(__frame).then(() => Math.round(performance.now() - t0)); });
  out.openGuideMs = await openSec('guide');
  out.guideDown30 = await keys('.iptv-col.guide .focusable', 'down', 30);
  out.guideRight5 = await keys(null, 'right', 5);
  out.openMoviesMs = await openSec('movies');
  out.moviesDown15 = await keys('.iptv-grid .focusable', 'down', 15);
  out.openSeriesMs = await openSec('series');
  out.openHomeMs = await openSec('home');
  out.searchMs = await page.evaluate(() => { var t0 = performance.now(); var r = IPTV.search('show 2', [], 'all'); return { ms: Math.round(performance.now() - t0), channels: r.channels.length, programmes: r.programmes.length, movies: r.movies.length }; });
  out.totalMainThread = await lt();
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
