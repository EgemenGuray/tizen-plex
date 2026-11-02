/* Live TV player: channels (▲▼ / CH+ CH− zap, number keys, ◀ channel list, ▶ audio/subtitles/record), catch-up,
 * films, episodes and recordings. AVPlay on the TV, <video> in a desktop browser. Also drives the muted preview
 * window on the Live TV screen (AVPlay drawn into a small rectangle). ES5 only. */
var IPTVPlayer = (function () {
    'use strict';

    function hasAvplay() { try { return !!(window.webapis && webapis.avplay); } catch (e) { return false; } }
    function $(id) { return document.getElementById(id); }
    function esc(s) { return Util.esc(s); }

    var s = null;          // full-screen session
    var preview = null;    // { channel, rect }
    var mutedByUs = false;
    var osdTimer = null, numTimer = null, stallTimer = null;

    /* ---------- engine ---------- */

    function open(url, rect, cb) {
        if (hasAvplay()) {
            var av = webapis.avplay;
            try { av.stop(); av.close(); } catch (e) {}
            av.open(url);
            av.setDisplayRect(rect[0], rect[1], rect[2], rect[3]);
            if (/\.m3u8/.test(url)) { try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) {} }
            av.setListener({
                onbufferingstart: function () { cb.buffering(true); },
                onbufferingcomplete: function () { cb.buffering(false); },
                oncurrentplaytime: function (ms) { cb.time(ms); },
                onstreamcompleted: function () { cb.ended(); },
                onerror: function (e) { cb.error(String(e)); },
                onevent: function () {},
                onsubtitlechange: function (d, text) { cb.subtitle(text); }
            });
            av.prepareAsync(function () {
                try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
                av.play();
                cb.ready();
            }, function (e) { cb.error(String(e && e.name || e)); });
        } else {
            var v = $('html5-player');
            v.style.display = 'block';
            v.style.left = rect[0] + 'px'; v.style.top = rect[1] + 'px'; v.style.width = rect[2] + 'px'; v.style.height = rect[3] + 'px';
            v.muted = !!cb.muted;
            v.onwaiting = function () { cb.buffering(true); };
            v.onplaying = function () { cb.buffering(false); };
            v.ontimeupdate = function () { cb.time(v.currentTime * 1000); };
            v.onended = function () { cb.ended(); };
            v.onerror = function () { cb.error('video error ' + (v.error && v.error.code)); };
            v.onloadedmetadata = function () { cb.ready(); };
            v.src = url;
            var p = v.play(); if (p && p.catch) p.catch(function () {});
        }
    }

    function close() {
        if (hasAvplay()) { try { webapis.avplay.stop(); } catch (e) {} try { webapis.avplay.close(); } catch (e) {} }
        else { var v = $('html5-player'); v.pause(); v.removeAttribute('src'); v.load(); v.style.display = 'none'; v.removeAttribute('style'); }
    }

    function pause(on) {
        if (hasAvplay()) { try { if (on) webapis.avplay.pause(); else webapis.avplay.play(); } catch (e) {} }
        else { var v = $('html5-player'); if (on) v.pause(); else v.play(); }
    }
    function paused() { return hasAvplay() ? webapis.avplay.getState() === 'PAUSED' : $('html5-player').paused; }
    function duration() { try { return hasAvplay() ? webapis.avplay.getDuration() : ($('html5-player').duration || 0) * 1000; } catch (e) { return 0; } }
    function seek(ms) { if (hasAvplay()) webapis.avplay.seekTo(Math.max(0, Math.floor(ms))); else $('html5-player').currentTime = ms / 1000; }

    function mute(on) {
        try {
            if (on && !tizen.tvaudiocontrol.isMute()) { tizen.tvaudiocontrol.setMute(true); mutedByUs = true; }
            if (!on && mutedByUs) { tizen.tvaudiocontrol.setMute(false); mutedByUs = false; }
        } catch (e) { /* no TV audio API */ }
    }

    function tracks() {
        if (!hasAvplay()) return [];
        try {
            return (webapis.avplay.getTotalTrackInfo() || []).map(function (t) {
                var info = {}; try { info = JSON.parse(t.extra_info); } catch (e) {}
                return { index: t.index, type: t.type, info: info };
            });
        } catch (e) { return []; }
    }

    /* ---------- preview ---------- */

    function startPreview(ch, rect) {
        if (s) return;
        if (preview && preview.channel.id === ch.id) return;
        stopPreview();
        preview = { channel: ch, rect: rect };
        document.body.classList.add('iptv-preview');
        mute(true);
        try {
            open(ch.url, rect, { muted: true, buffering: function () {}, time: function () {}, ended: function () {}, error: function () {}, subtitle: function () {}, ready: function () {} });
        } catch (e) { stopPreview(); }
    }

    function stopPreview() {
        if (!preview) return;
        preview = null;
        close();
        mute(false);
        document.body.classList.remove('iptv-preview');
    }

    /* ---------- full-screen ---------- */

    // kind: { live: channel } | { catchup: [channel, programme] } | { movie } | { episode: [series, episode, all] } | { file: job }
    // lineup: channels for zapping. onExit: called when closed.
    function start(kind, lineup, onExit) {
        stopPreview();
        stopInternal(false);
        s = { kind: kind, lineup: lineup || [], onExit: onExit, time: 0, panel: null, retries: 0, prev: null, digits: '' };
        document.body.classList.add('playing');
        ensureUI();
        $('iptv-ui').classList.remove('hidden');
        load(resumeAt());
    }

    function resumeID() {
        var k = s.kind;
        if (k.movie) return k.movie.id;
        if (k.episode) return k.episode[1].id;
        if (k.file) return 'file|' + k.file.id;
        return null;
    }
    function resumeAt() { var id = resumeID(); return id ? IPTV.position(id) : 0; }
    function isLive() { return !!(s && s.kind.live); }
    function channel() { return s && (s.kind.live || (s.kind.catchup && s.kind.catchup[0])); }

    function url() {
        var k = s.kind;
        if (k.live) { IPTV.played(k.live); return k.live.url; }
        if (k.catchup) return IPTV.catchupURL(k.catchup[0], k.catchup[1]);
        if (k.movie) return k.movie.url;
        if (k.episode) return k.episode[1].url;
        if (k.file) return IPTVRec.fileURI(k.file);
        return null;
    }

    function title() {
        var k = s.kind;
        if (k.live) return k.live.name;
        if (k.catchup) return k.catchup[1].title;
        if (k.movie) return k.movie.name;
        if (k.episode) return k.episode[0].name + ' · S' + k.episode[1].season + ' E' + k.episode[1].number;
        if (k.file) return k.file.title;
        return '';
    }

    function load(atMs) {
        var u = url();
        if (!u) { status('This stream has no address.'); return; }
        var k = s.kind;
        if (k.movie) IPTV.noteWatching({ id: k.movie.id, movieID: k.movie.id, title: k.movie.name, subtitle: k.movie.year ? String(k.movie.year) : '', poster: k.movie.poster });
        if (k.episode) IPTV.noteWatching({ id: k.episode[1].id, seriesID: k.episode[0].id, episode: k.episode[1], title: k.episode[0].name,
            subtitle: 'S' + k.episode[1].season + ' E' + k.episode[1].number + ' · ' + k.episode[1].title, poster: k.episode[1].thumb || k.episode[0].poster });
        var me = s, gen = s.gen = (s.gen || 0) + 1;
        var live = function () { return s === me && s.gen === gen; };
        s.ready = false;
        status(s.retries ? 'Reconnecting… (' + s.retries + ')' : null);
        $('iptv-ui').classList.add('buffering');
        open(u, [0, 0, 1920, 1080], {
            buffering: function (on) {
                if (!live()) return;
                $('iptv-ui').classList.toggle('buffering', on);
                clearTimeout(stallTimer);
                if (on && isLive()) stallTimer = setTimeout(function () { if (live()) reconnect('stall'); }, 12000);
            },
            time: function (ms) { if (live()) { s.time = ms; tick(); } },
            ended: function () { if (live()) ended(); },
            error: function (e) { if (live()) reconnect(e); },
            subtitle: function (text) { if (live()) $('iptv-sub').innerHTML = text ? esc(text).replace(/\n/g, '<br>') : ''; },
            ready: function () {
                if (!live()) return;
                s.ready = true; s.retries = 0;
                $('iptv-ui').classList.remove('buffering');
                status(null);
                if (atMs > 0 && !isLive()) seek(atMs);
                measure();
                showOsd();
            }
        });
        showOsd();
    }

    /* Remember the channel's real resolution and sound for the quality badges and filters. */
    function measure() {
        var ch = s.kind.live;
        if (!ch) return;
        setTimeout(function () {
            if (!s || s.kind.live !== ch) return;
            var h = 0, chans = null, hdr = false;
            tracks().forEach(function (t) {
                if (t.type === 'VIDEO') { h = parseInt(t.info.Height || t.info.height, 10) || h; hdr = /hdr|hlg|2084/i.test(JSON.stringify(t.info)); }
                if (t.type === 'AUDIO' && chans === null) chans = parseInt(t.info.channels || t.info.Channels, 10) || null;
            });
            if (!h && !hasAvplay()) h = $('html5-player').videoHeight;
            IPTV.recordMeasured(ch, h, chans, hdr);
        }, 3000);
    }

    function reconnect(err) {
        if (s.retries < 6 && (isLive() || !s.ready)) {
            s.retries++;
            var delay = Math.min(8000, 1000 * Math.pow(2, s.retries - 1));
            status('Reconnecting… (' + s.retries + ')');
            var me = s;
            setTimeout(function () { if (s === me) load(isLive() ? 0 : s.time); }, delay);
            return;
        }
        status('The stream stopped (' + err + '). Press OK to try again.');
        s.failed = true;
    }

    function ended() {
        if (isLive()) return reconnect('ended');
        var id = resumeID();
        if (id) IPTV.savePosition(id, duration(), duration());
        var k = s.kind;
        if (k.episode) {
            var all = k.episode[2], i = all.indexOf(k.episode[1]);
            if (i >= 0 && all[i + 1]) { s.kind = { episode: [k.episode[0], all[i + 1], all] }; s.time = 0; load(0); return; }
        }
        stop();
    }

    function tune(ch) {
        if (!s) return;
        var cur = channel();
        if (cur && cur.id !== ch.id) s.prev = cur;
        s.kind = { live: ch };
        s.retries = 0; s.time = 0; s.failed = false;
        closePanel();
        load(0);
    }

    function zap(d) {
        var cur = channel(), l = s.lineup;
        if (!cur || !l.length) return;
        var i = 0;
        for (var j = 0; j < l.length; j++) if (l[j].id === cur.id) { i = j; break; }
        tune(l[((i + d) % l.length + l.length) % l.length]);
    }

    function digit(n) {
        if (!isLive()) return;
        s.digits += n;
        $('iptv-num').textContent = s.digits;
        $('iptv-num').classList.remove('hidden');
        clearTimeout(numTimer);
        numTimer = setTimeout(function () {
            if (!s) return;
            var want = parseInt(s.digits, 10);
            var ch = s.lineup.filter(function (c) { return c.number === want; })[0] || s.lineup[want - 1];
            s.digits = '';
            $('iptv-num').classList.add('hidden');
            if (ch) tune(ch);
        }, 1500);
    }

    /* ---------- OSD ---------- */

    function ensureUI() {
        if ($('iptv-ui')) return;
        var d = document.createElement('div');
        d.id = 'iptv-ui';
        d.className = 'hidden';
        d.innerHTML = '<div id="iptv-sub"></div><div id="iptv-status" class="hidden"></div><div id="iptv-num" class="hidden"></div>' +
            '<div id="iptv-osd"><div id="iptv-osd-in"></div></div><div id="iptv-panel" class="hidden"></div><div id="iptv-spinner"></div>';
        document.body.appendChild(d);
    }

    function status(t) {
        var el = $('iptv-status');
        if (!el) return;
        el.textContent = t || '';
        el.classList.toggle('hidden', !t);
    }

    function fmt(ms) { return Util.fmtTime(ms); }
    function clock(t) { return Util.fmtClock(new Date(t)); }

    function tagsHtml(ch) {
        return IPTV.tags(ch).map(function (t) { return '<i class="qtag q-' + t.replace('.', '') + '">' + esc(t) + '</i>'; }).join('');
    }

    function drawOsd() {
        if (!s) return;
        var html, ch = s.kind.live;
        if (ch) {
            var nn = IPTV.nowNext(ch), now = nn[0], next = nn[1];
            var pct = now ? Math.round((Date.now() - now.start) / (now.end - now.start) * 100) : 0;
            var rec = IPTVRec.recordingOf(ch);
            html = '<div class="o-row"><div class="o-logo" style="background-image:url(\'' + esc(ch.logo || '') + '\')"></div><div class="o-main">' +
                '<div class="o-title">' + (ch.number ? '<span class="o-num">' + ch.number + '</span>' : '') + esc(ch.name) +
                ' <i class="o-live">LIVE</i>' + (rec ? ' <i class="o-rec">● REC</i>' : '') + tagsHtml(ch) + '</div>' +
                (now ? '<div class="o-prog">' + esc(now.title) + '</div><div class="o-time">' + clock(now.start) + ' – ' + clock(now.end) +
                    '<span class="o-bar"><i style="width:' + pct + '%"></i></span></div>' : '<div class="o-time">No guide information</div>') +
                (next ? '<div class="o-next">Next ' + clock(next.start) + '  ' + esc(next.title) + '</div>' : '') +
                '</div><div class="o-clock">' + clock(Date.now()) + '</div></div>' +
                '<div class="o-hint"><b>▲▼</b> Channels  <b>◀</b> Channel list  <b>▶</b> Audio, subtitles, record  <b>0-9</b> Number</div>';
        } else {
            var d = duration();
            html = '<div class="o-title">' + esc(title()) + '</div>' +
                (s.kind.catchup ? '<div class="o-time">' + esc(s.kind.catchup[0].name) + ' · ' + clock(s.kind.catchup[1].start) + '</div>' : '') +
                (d ? '<div class="o-scrub"><span class="o-bar wide"><i style="width:' + Math.round(s.time / d * 100) + '%"></i></span></div>' +
                    '<div class="o-times"><span>' + fmt(s.time) + '</span><span>-' + fmt(Math.max(0, d - s.time)) + '</span></div>' : '') +
                '<div class="o-hint"><b>◀ ▶</b> −10 s / +30 s  <b>OK</b> Pause  <b>▼</b> Audio and subtitles</div>';
        }
        $('iptv-osd-in').innerHTML = html;
    }

    function showOsd() {
        drawOsd();
        $('iptv-ui').classList.add('osd');
        clearTimeout(osdTimer);
        osdTimer = setTimeout(function () { if (s && !s.panel && !(s.ready && paused())) $('iptv-ui').classList.remove('osd'); }, 5000);
    }

    var lastSave = 0;
    function tick() {
        if ($('iptv-ui').classList.contains('osd') && !isLive()) drawOsd();
        var id = resumeID();
        if (id && Date.now() - lastSave > 10000) { lastSave = Date.now(); IPTV.savePosition(id, s.time, duration()); }
    }

    /* ---------- panels ---------- */

    function openPanel(kind) {
        s.panel = { kind: kind, sel: 0, rows: [] };
        renderPanel();
        $('iptv-panel').classList.remove('hidden');
        showOsd();
    }

    function closePanel() {
        if (!s || !s.panel) return;
        s.panel = null;
        $('iptv-panel').classList.add('hidden');
    }

    function renderPanel() {
        var p = s.panel, rows = [];
        if (p.kind === 'channels') {
            var cur = channel();
            s.lineup.forEach(function (c, i) {
                var now = IPTV.nowNext(c)[0];
                rows.push({ html: '<span class="pn">' + (c.number || '') + '</span><span class="pl" style="background-image:url(\'' + esc(c.logo || '') + '\')"></span><span class="pt">' + esc(c.name) +
                    '<small>' + esc(now ? now.title : '') + '</small></span>', act: function () { tune(c); }, current: cur && c.id === cur.id });
                if (cur && c.id === cur.id && p.sel === 0 && !p.placed) { p.sel = i; p.placed = true; }
            });
        } else {
            rows.push({ header: 'Audio' });
            tracks().filter(function (t) { return t.type === 'AUDIO'; }).forEach(function (t) {
                var label = [t.info.language, t.info.fourCC, t.info.channels ? t.info.channels + ' ch' : ''].filter(Boolean).join(' · ') || 'Track ' + t.index;
                rows.push({ html: esc(label), act: function () { try { webapis.avplay.setSelectTrack('AUDIO', t.index); } catch (e) {} } });
            });
            rows.push({ header: 'Subtitles' });
            rows.push({ html: 'Off', act: function () { try { webapis.avplay.setSilentSubtitle(true); } catch (e) {} $('iptv-sub').innerHTML = ''; } });
            tracks().filter(function (t) { return t.type === 'TEXT'; }).forEach(function (t) {
                rows.push({ html: esc(t.info.track_lang || t.info.language || 'Track ' + t.index), act: function () {
                    try { webapis.avplay.setSilentSubtitle(false); webapis.avplay.setSelectTrack('TEXT', t.index); } catch (e) {}
                } });
            });
            var ch = s.kind.live;
            if (ch) {
                rows.push({ header: 'Record' });
                var job = IPTVRec.recordingOf(ch);
                if (job) rows.push({ html: 'Stop recording', act: function () { IPTVRec.stop(job.id); } });
                else {
                    var now = IPTV.nowNext(ch)[0];
                    if (now) rows.push({ html: 'Record “' + esc(now.title) + '”', act: function () { IPTVRec.record(ch, now); Util.toast('Recording ' + now.title); } });
                    rows.push({ html: 'Record the next hour', act: function () { IPTVRec.record(ch, null, 60); Util.toast('Recording for an hour'); } });
                }
                if (s.prev) rows.push({ header: 'Last channel' }, { html: esc(s.prev.name), act: function () { tune(s.prev); } });
            }
            rows.push({ header: 'Picture' });
            [['letterbox', 'Original'], ['fill', 'Fill screen']].forEach(function (m) {
                rows.push({ html: m[1], act: function () { try { webapis.avplay.setDisplayMethod(m[0] === 'fill' ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : 'PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {} } });
            });
        }
        p.rows = rows.filter(function (r) { return !r.header; });
        if (p.sel >= p.rows.length) p.sel = Math.max(0, p.rows.length - 1);
        var i = 0, html = '<h3>' + (p.kind === 'channels' ? 'Channels' : 'Options') + '</h3><div class="ip-list">';
        rows.forEach(function (r) {
            if (r.header) { html += '<div class="ip-h">' + esc(r.header) + '</div>'; return; }
            html += '<div class="ip-row' + (i === p.sel ? ' sel' : '') + (r.current ? ' cur' : '') + '" data-i="' + i + '">' + r.html + '</div>';
            i++;
        });
        $('iptv-panel').className = 'ip-' + p.kind;
        $('iptv-panel').innerHTML = html + '</div>';
        var sel = $('iptv-panel').querySelector('.ip-row.sel');
        if (sel) {
            var list = $('iptv-panel').querySelector('.ip-list');
            list.style.transform = 'translateY(' + (-Math.max(0, sel.offsetTop - 380)) + 'px)';
        }
    }

    function panelKey(key) {
        var p = s.panel;
        if (key === 'up') { p.sel = Math.max(0, p.sel - 1); renderPanel(); }
        else if (key === 'down') { p.sel = Math.min(p.rows.length - 1, p.sel + 1); renderPanel(); }
        else if (key === 'chup') { p.sel = Math.max(0, p.sel - 10); renderPanel(); }
        else if (key === 'chdown') { p.sel = Math.min(p.rows.length - 1, p.sel + 10); renderPanel(); }
        else if (key === 'enter') { var r = p.rows[p.sel]; if (r) { r.act(); if (s && s.panel === p) { closePanel(); showOsd(); } } }
        else if (key === 'back' || (key === 'left' && p.kind === 'tracks') || (key === 'right' && p.kind === 'channels')) closePanel();
        return true;
    }

    /* ---------- keys ---------- */

    function handleKey(key) {
        if (!s) return false;
        if (s.panel) return panelKey(key);
        if (/^d\d$/.test(key)) { digit(key[1]); return true; }
        if (s.failed && key === 'enter') { s.failed = false; s.retries = 0; load(isLive() ? 0 : s.time); return true; }
        if (isLive()) {
            switch (key) {
            case 'up': case 'chup': zap(-1); break;
            case 'down': case 'chdown': zap(1); break;
            case 'left': openPanel('channels'); break;
            case 'right': case 'info': openPanel('tracks'); break;
            case 'enter': if ($('iptv-ui').classList.contains('osd')) $('iptv-ui').classList.remove('osd'); else showOsd(); break;
            case 'playpause': case 'pause': case 'play': pause(!paused()); showOsd(); break;
            case 'back': case 'stop': stop(); break;
            default: showOsd();
            }
            return true;
        }
        switch (key) {
        case 'left': case 'rewind': seek(Math.max(0, s.time - 10000)); showOsd(); break;
        case 'right': case 'ff': seek(Math.min(duration() - 1000, s.time + 30000)); showOsd(); break;
        case 'enter': case 'playpause': pause(!paused()); showOsd(); break;
        case 'down': case 'info': openPanel('tracks'); break;
        case 'back': case 'stop': stop(); break;
        default: showOsd();
        }
        return true;
    }

    function stopInternal(notify) {
        clearTimeout(osdTimer); clearTimeout(stallTimer);
        if (!s) return;
        var cur = s;
        var id = resumeID();
        if (id) IPTV.savePosition(id, cur.time, duration());
        s = null;
        close();
        document.body.classList.remove('playing');
        if ($('iptv-ui')) { $('iptv-ui').className = 'hidden'; $('iptv-panel').classList.add('hidden'); $('iptv-sub').innerHTML = ''; }
        if (notify && cur.onExit) cur.onExit();
    }

    function stop() { stopInternal(true); }

    return {
        start: start, handleKey: handleKey, active: function () { return !!s; },
        startPreview: startPreview, stopPreview: stopPreview, previewing: function () { return preview && preview.channel; }
    };
})();
