/* Playback: Samsung AVPlay on the TV (hardware decode, HDR10+, bitstream audio), HTML5 <video> in a desktop browser for UI testing.
 * The overlay follows the Apple TV player: a translucent timeline at the bottom, a tabbed panel from the top (▼),
 * scrubbing with preview thumbnails while paused, Skip Intro and Up Next. */
var Player = (function () {
    'use strict';

    /* ---------- engines ---------- */

    function hasAvplay() {
        try { return !!(window.webapis && webapis.avplay); } catch (e) { return false; }
    }

    var DISPLAY_MODES = {
        letterbox: 'PLAYER_DISPLAY_MODE_LETTER_BOX',
        auto: 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO',
        fill: 'PLAYER_DISPLAY_MODE_FULL_SCREEN'
    };

    var AvplayEngine = {
        name: 'AVPlay',
        // media: the Plex Media element being played (for its resolution).
        open: function (url, cb, media) {
            var av = webapis.avplay;
            var width = (media && media.width) || 0;
            try { av.stop(); av.close(); } catch (e) {}
            av.open(url);
            av.setDisplayRect(0, 0, 1920, 1080);
            // Without these AVPlay sets its decoder up for HD (or caps UHD at 4K), so 8K files would come out at 4K.
            if (width >= 3800 || /\.m3u8/.test(url)) {
                try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) {}
            }
            if (width >= 7600) {
                try { av.setStreamingProperty('ADAPTIVE_INFO', 'FIXED_MAX_RESOLUTION=7680x4320'); } catch (e) {}
            }
            av.setListener({
                onbufferingstart: function () { cb.buffering(true); },
                onbufferingcomplete: function () { cb.buffering(false); },
                oncurrentplaytime: function (ms) { cb.time(ms); },
                onstreamcompleted: function () { cb.ended(); },
                onerror: function (err) { cb.error(String(err)); },
                onevent: function () {},
                onsubtitlechange: function (duration, text) { cb.subtitle(text, duration); }
            });
        },
        prepare: function (ok, fail) { webapis.avplay.prepareAsync(ok, function (e) { fail(String(e && e.name || e)); }); },
        play: function () { webapis.avplay.play(); },
        pause: function () { webapis.avplay.pause(); },
        isPaused: function () { return webapis.avplay.getState() === 'PAUSED'; },
        seek: function (ms, done) { webapis.avplay.seekTo(Math.max(0, Math.floor(ms)), done || function () {}, function () { if (done) done(); }); },
        time: function () { return webapis.avplay.getCurrentTime(); },
        duration: function () { return webapis.avplay.getDuration(); },
        // [{ index, type: 'VIDEO'|'AUDIO'|'TEXT', info: {...} }] in container order
        tracks: function () {
            return (webapis.avplay.getTotalTrackInfo() || []).map(function (t) {
                var info = {};
                try { info = JSON.parse(t.extra_info); } catch (e) {}
                return { index: t.index, type: t.type, info: info };
            });
        },
        selectTrack: function (type, index) { webapis.avplay.setSelectTrack(type, index); },
        subtitlesOn: function (on) { try { webapis.avplay.setSilentSubtitle(!on); } catch (e) {} },
        // Shifts embedded subtitles. Not verified on the QN900B; external subtitles are shifted by the app itself.
        subtitleDelay: function (ms) { try { webapis.avplay.setSubtitlePosition(ms); } catch (e) {} },
        display: function (mode) { try { webapis.avplay.setDisplayMethod(DISPLAY_MODES[mode] || DISPLAY_MODES.letterbox); } catch (e) {} },
        close: function () { try { webapis.avplay.stop(); } catch (e) {} try { webapis.avplay.close(); } catch (e) {} }
    };

    var Html5Engine = (function () {
        var v = function () { return document.getElementById('html5-player'); };
        var cbs = null;
        return {
            name: 'HTML5 (browser test mode)',
            open: function (url, cb) {
                cbs = cb;
                var el = v();
                el.style.display = 'block';
                el.onwaiting = function () { cbs.buffering(true); };
                el.onplaying = function () { cbs.buffering(false); };
                el.ontimeupdate = function () { cbs.time(el.currentTime * 1000); };
                el.onended = function () { cbs.ended(); };
                el.onerror = function () { cbs.error('HTML5 video error ' + (el.error && el.error.code)); };
                el.src = url;
            },
            prepare: function (ok, fail) {
                var el = v();
                if (el.readyState >= 1) return ok();
                el.onloadedmetadata = function () { el.onloadedmetadata = null; ok(); };
                el.addEventListener('error', function once() { el.removeEventListener('error', once); fail('cannot load'); });
            },
            play: function () { var p = v().play(); if (p && p.catch) p.catch(function () {}); },
            pause: function () { v().pause(); },
            isPaused: function () { return v().paused; },
            seek: function (ms, done) { v().currentTime = ms / 1000; if (done) done(); },
            time: function () { return v().currentTime * 1000; },
            duration: function () { return (v().duration || 0) * 1000; },
            tracks: function () { return []; },
            selectTrack: function () {},
            subtitlesOn: function () {},
            subtitleDelay: function () {},
            display: function (mode) { v().style.objectFit = mode === 'fill' ? 'fill' : 'contain'; },
            close: function () { var el = v(); el.pause(); el.removeAttribute('src'); el.load(); el.style.display = 'none'; }
        };
    })();

    var engine = hasAvplay() ? AvplayEngine : Html5Engine;
    if (engine === Html5Engine) {
        var obj = document.getElementById('av-player');
        if (obj) obj.parentNode.removeChild(obj);
    }

    /* ---------- session ---------- */

    var s = null;            // current session
    var osdTimer = null, reportTimer = null, subTimer = null;

    function $(id) { return document.getElementById(id); }

    // opts: { subtitle: stream | null, onExit }
    function start(item, plan, settings, startMs, opts) {
        opts = opts || {};
        stopInternal(false);
        s = {
            item: item, plan: plan, settings: settings, onExit: opts.onExit,
            mode: plan.mode, baseOffset: 0, lastTime: startMs || 0, duration: item.duration || 0,
            sessionId: Util.uuid(), retried: false, sub: null, subOffset: 0,
            panel: null, scrub: null, upNext: null, next: undefined, bif: null, skippedIntro: false, prepared: false,
            markers: item.Marker || [], chapters: (item.Chapter || []).slice().sort(function (a, b) { return a.startTimeOffset - b.startTimeOffset; })
        };
        var me = s;
        document.body.classList.add('playing');
        $('player-ui').classList.remove('hidden');
        $('player-ui').className = '';
        $('osd-kicker').textContent = item.type === 'episode' ? item.grandparentTitle : '';
        $('osd-title').textContent = item.type === 'episode' ? 'S' + item.parentIndex + ', E' + item.index + ' · ' + item.title : item.title;
        $('panel').classList.add('hidden');
        $('upnext').classList.add('hidden');
        $('skip').classList.add('hidden');
        subStyle();
        drawMarks();
        setSubtitle(opts.subtitle || null, true);
        if (opts.online) Online.downloadSubtitle(opts.online).then(function (text) { if (s === me) useOnline(opts.online, text, true); }, function () {});
        load(startMs || 0);
        reportTimer = setInterval(report, 10000);
        Plex.previewIndex(plan.part).then(function (buf) { if (s === me && buf) s.bif = Bif.parse(buf); });
        if (item.type === 'episode') Plex.nextEpisode(item).then(function (n) { if (s === me) s.next = n; });
    }

    function load(atMs) {
        var p = s.plan;
        var url;
        $('subtitle').innerHTML = ''; $('subtitle')._html = null;
        if (s.mode === 'direct') {
            url = Plex.directPlayUrl(p.part);
            s.baseOffset = 0;
        } else {
            Plex.stopTranscode(s.sessionId);
            s.sessionId = Util.uuid();
            url = Plex.audioTranscodeUrl(s.item, (s.item.Media || []).indexOf(p.media), atMs, s.sessionId);
            s.baseOffset = atMs;
        }
        s.prepared = false;
        drawInfo();
        // Callbacks from an earlier open (before a seek-restart or the audio fallback) are ignored.
        var gen = s.gen = (s.gen || 0) + 1;
        var live = function () { return s && s.gen === gen; };
        engine.open(url, {
            buffering: function (on) { if (live()) $('player-ui').classList.toggle('buffering', on); },
            time: function (ms) { if (live()) { s.lastTime = s.baseOffset + ms; tick(); } },
            ended: function () { if (live()) ended(); },
            error: function (e) { if (live()) fail('Playback error: ' + e); },
            subtitle: function (text, duration) { if (live()) embeddedSubtitle(text, duration); }
        }, p.media);
        engine.prepare(function () {
            if (!live()) return;
            s.prepared = true;
            engine.display(s.settings.picture);
            if (s.mode === 'direct') applyTracks();
            var d = engine.duration();
            if (d && s.mode === 'direct') s.duration = d;
            var go = function () { engine.play(); showOsd(); report(); };
            if (s.mode === 'direct' && atMs > 0) engine.seek(atMs, go); else go();
        }, function (e) { if (live()) fail('Could not open the file (' + e + ')'); });
    }

    function embeddedSubs() { return Decide.streams(s.plan.part, 3).filter(function (t) { return !t.key; }); }

    // Map the Plex streams the user chose onto AVPlay's track list (both follow container order).
    function applyTracks() {
        if (!s.prepared) return;
        var tracks = engine.tracks();
        var audioTracks = tracks.filter(function (t) { return t.type === 'AUDIO'; });
        var textTracks = tracks.filter(function (t) { return t.type === 'TEXT'; });
        var ai = Decide.streams(s.plan.part, 2).indexOf(s.plan.audio);
        if (ai >= 0 && audioTracks[ai]) {
            try { engine.selectTrack('AUDIO', audioTracks[ai].index); } catch (e) {}
        }
        var si = s.sub && !s.sub.stream.key ? embeddedSubs().indexOf(s.sub.stream) : -1;
        if (si >= 0 && textTracks[si]) {
            try { engine.selectTrack('TEXT', textTracks[si].index); engine.subtitlesOn(true); engine.subtitleDelay(s.subOffset); } catch (e) {}
        } else {
            engine.subtitlesOn(false);
        }
    }

    function fail(msg) {
        if (!s) return;
        // Direct play failed. A first failure is often transient (the server was slow to answer for a large remux), so try
        // direct play once more: converting the audio would lose Atmos. Only after that, retry with the audio converted.
        if (s.mode === 'direct' && !s.directRetried) {
            s.directRetried = true;
            Util.toast(msg + '. Trying again…', 4000);
            engine.close();
            setTimeout(function () { if (s) load(s.lastTime); }, 1500);
            return;
        }
        if (s.mode === 'direct' && !s.retried) {
            s.retried = true;
            s.mode = 'audio-transcode';
            Util.toast(msg + '. Retrying with audio converted by the server.', 7000);
            engine.close();
            load(s.lastTime);
            return;
        }
        Util.toast(msg, 8000);
        stop(false);
    }

    /* ---------- subtitles ---------- */

    function subStyle() {
        var st = s.settings;
        $('subtitle').className = 'size-' + st.subSize + ' color-' + st.subColor + ' bg-' + st.subBg + ' pos-' + st.subPos;
    }

    // stream: Plex subtitle stream or null (off). External files are fetched and drawn by the app.
    function setSubtitle(stream, quiet) {
        clearTimeout(subTimer);
        $('subtitle').innerHTML = ''; $('subtitle')._html = null;
        s.sub = stream ? { stream: stream, cues: null } : null;
        if (!quiet) Memory.setTracks(s.item, { subId: stream ? stream.id : null, online: null });
        if (stream && stream.key) {
            var mine = s.sub;
            Plex.subtitleText(stream.key).then(function (raw) {
                if (s && s.sub === mine) mine.cues = Subs.parse(raw, stream.codec);
            }, function (e) { if (!quiet) Util.toast('Could not load subtitles: ' + e.message); });
        } else if (stream && s.mode !== 'direct' && !quiet) {
            Util.toast('Embedded subtitles show in direct play only. Press Yellow to go back to direct play.', 6000);
        }
        applyTracks();
        if (s.panel) renderPanel();
    }

    function embeddedSubtitle(text, duration) {
        if (!s.sub || s.sub.stream.key || s.sub.stream.online) return;
        clearTimeout(subTimer);
        var html = Subs.clean(text || '').replace(/\n/g, '<br>');
        $('subtitle').innerHTML = html ? '<span>' + html + '</span>' : '';
        if (duration > 0) subTimer = setTimeout(function () { $('subtitle').innerHTML = ''; }, duration);
    }

    function drawExternalSub() {
        if (!s.sub || !s.sub.cues) return;
        var html = Subs.at(s.sub.cues, s.lastTime - s.subOffset);
        var el = $('subtitle');
        if (el._html !== html) { el.innerHTML = html ? '<span>' + html + '</span>' : ''; el._html = html; }
    }

    /* ---------- timeline ---------- */

    function tick() {
        drawExternalSub();
        if ($('player-ui').classList.contains('osd')) drawTime();
        checkMarkers();
    }

    function marker(type) { return s.markers.filter(function (m) { return m.type === type; }); }

    function checkMarkers() {
        var t = s.lastTime;
        var intro = marker('intro').filter(function (m) { return t >= m.startTimeOffset && t < m.endTimeOffset - 1500; })[0];
        if (intro && s.settings.autoSkipIntro && s.skippedIntro !== intro) {
            s.skippedIntro = intro;
            seekTo(intro.endTimeOffset);
            Util.toast('Skipped intro', 2500);
            intro = null;
        }
        s.skipTo = intro ? intro.endTimeOffset : null;
        $('skip').classList.toggle('hidden', !intro || !!s.panel || !!s.upNext);

        if (s.next && s.duration && !s.upNextDismissed) {
            var credits = marker('credits').filter(function (m) { return m.endTimeOffset >= s.duration - 60000 || m.final; })[0];
            var at = credits ? credits.startTimeOffset : s.duration - 30000;
            if (t >= at && !s.upNext) showUpNext();
            else if (t < at - 2000 && s.upNext) hideUpNext();
        }
        if (s.upNext) drawUpNext();
    }

    function showUpNext() {
        var n = s.next;
        s.upNext = { deadline: s.settings.autoplay ? Date.now() + 10000 : 0 };
        $('upnext').innerHTML = '<div class="un-thumb" style="background-image:url(\'' + Plex.imageUrl(n.thumb, 480, 270) + '\')"><div class="un-ring"></div></div>' +
            '<div class="un-text"><div class="un-k">Up Next</div><div class="un-t">' + Util.esc(n.title) + '</div>' +
            '<div class="un-s">S' + n.parentIndex + ', E' + n.index + ' · ' + Util.esc(Util.fmtDuration(n.duration)) + '</div>' +
            '<div class="un-btn">▶ <span id="un-count">Play Next</span></div><div class="un-hint">Back to keep watching</div></div>';
        $('upnext').classList.remove('hidden');
    }
    function drawUpNext() {
        if (!s.upNext.deadline) return;
        var left = Math.ceil((s.upNext.deadline - Date.now()) / 1000);
        var c = $('un-count');
        if (c) c.textContent = 'Play Next in ' + Math.max(0, left);
        if (left <= 0 && !s.panel && !engine.isPaused()) playNext();
    }
    function hideUpNext() { s.upNext = null; $('upnext').classList.add('hidden'); }

    function ended() {
        if (s.next && s.settings.autoplay) playNext();
        else stop(true);
    }

    // Keep the subtitle language of the episode being watched.
    function playNext() {
        var n = s.next, settings = s.settings, onExit = s.onExit, prevSub = s.sub && s.sub.stream;
        if (!n) return;
        var plan = Decide.plan(n, 0, null, settings);
        var sub = Decide.chooseSubtitle(plan.part, plan.audio, settings);
        if (prevSub) {
            sub = Decide.streams(plan.part, 3).filter(function (t) {
                return Decide.sameLang(t.languageCode, prevSub.languageCode) && !!t.forced === !!prevSub.forced && !Decide.isImageSub(t);
            })[0] || sub;
        }
        stopInternal(false);
        Plex.selectStreams(plan.part.id, plan.audio && plan.audio.id, sub ? sub.id : 0).then(function () {
            start(n, plan, settings, 0, { subtitle: sub, onExit: onExit });
        });
    }

    function drawMarks() {
        var html = '';
        var d = s.duration || 1;
        s.chapters.forEach(function (c, i) { if (i) html += '<i class="tick" style="left:' + (c.startTimeOffset / d * 100) + '%"></i>'; });
        marker('intro').concat(marker('credits')).forEach(function (m) {
            html += '<i class="seg" style="left:' + (m.startTimeOffset / d * 100) + '%;width:' + ((m.endTimeOffset - m.startTimeOffset) / d * 100) + '%"></i>';
        });
        $('osd-marks').innerHTML = html;
    }

    function chapterAt(t) {
        var cur = null;
        s.chapters.forEach(function (c) { if (c.startTimeOffset <= t) cur = c; });
        return cur;
    }

    function drawTime() {
        if (!s) return;
        var d = s.duration || 0;
        var t = s.lastTime;
        var pct = d ? Math.min(100, t / d * 100) : 0;
        $('osd-progress').style.width = pct + '%';
        var shown = s.scrub ? s.scrub.pos : t;
        var spct = d ? Math.min(100, shown / d * 100) : 0;
        $('osd-head').style.left = spct + '%';
        $('osd-elapsed').textContent = Util.fmtTime(shown);
        $('osd-remaining').textContent = '-' + Util.fmtTime(Math.max(0, d - shown));
        $('osd-ends').textContent = d ? 'Ends at ' + Util.fmtClock(new Date(Date.now() + (d - t))) : '';
        var ch = chapterAt(shown);
        $('osd-chapter').textContent = ch && s.chapters.length > 1 ? (ch.tag || 'Chapter ' + ch.index) : '';
        var thumb = $('osd-thumb');
        if (s.scrub) {
            var url = Bif.frameUrl(s.bif, shown);
            thumb.style.left = Math.max(8, Math.min(92, spct)) + '%';
            thumb.querySelector('.img').style.backgroundImage = url ? 'url("' + url + '")' : 'none';
            thumb.classList.toggle('noimg', !url);
            thumb.querySelector('.t').textContent = Util.fmtTime(shown);
            thumb.classList.remove('hidden');
        } else {
            thumb.classList.add('hidden');
        }
    }

    function drawInfo() {
        var p = s.plan;
        var bits = Decide.badges(p).filter(function (b) { return !/^CC|SDH/.test(b); });
        bits.push(s.mode === 'direct' ? 'Direct Play' : 'Audio → E-AC3');
        $('osd-badges').innerHTML = bits.map(function (b) { return '<span class="badge">' + Util.esc(b) + '</span>'; }).join('');
    }

    function showOsd() {
        var ui = $('player-ui');
        ui.classList.add('osd');
        drawTime();
        ui.classList.toggle('paused', s && s.prepared && engine.isPaused());
        clearTimeout(osdTimer);
        osdTimer = setTimeout(function () {
            if (s && !s.panel && !s.scrub && !engine.isPaused()) ui.classList.remove('osd');
        }, 5000);
    }

    function report() {
        if (!s) return;
        if (s.prepared) Memory.savePosition(s.item, s.lastTime, s.duration);
        Plex.timeline(s.item, s.prepared && engine.isPaused() ? 'paused' : 'playing', s.lastTime, s.duration);
    }

    function seekTo(target) {
        target = Math.max(0, Math.min((s.duration || Infinity) - 3000, target));
        s.lastTime = target;
        if (s.mode === 'direct') engine.seek(target);
        else { engine.close(); load(target); }   // transcoded stream: restart the transcode at the new offset
        $('subtitle').innerHTML = ''; $('subtitle')._html = null;
        drawTime();
    }

    function jump(deltaMs) {
        seekTo(s.lastTime + deltaMs);
        var j = $('osd-jump');
        j.textContent = (deltaMs > 0 ? '+' : '−') + Math.abs(deltaMs / 1000) + 's';
        j.className = deltaMs > 0 ? 'right' : 'left';
        void j.offsetWidth;
        j.classList.add('go');
        showOsd();
    }

    function togglePause() {
        if (engine.isPaused()) engine.play(); else engine.pause();
        report();
        showOsd();
    }

    /* Scrubbing while paused: each press moves further the faster you press; OK jumps there. */
    function scrubStep(dir) {
        if (!s.scrub) s.scrub = { pos: s.lastTime, last: 0, streak: 0 };
        var now = Date.now();
        s.scrub.streak = now - s.scrub.last < 450 ? s.scrub.streak + 1 : 0;
        s.scrub.last = now;
        var step = s.scrub.streak > 14 ? 120000 : s.scrub.streak > 7 ? 60000 : s.scrub.streak > 2 ? 30000 : 10000;
        s.scrub.pos = Math.max(0, Math.min((s.duration || 0) - 1000, s.scrub.pos + dir * step));
        $('player-ui').classList.add('scrubbing');
        showOsd();
    }
    function endScrub(commit) {
        var to = s.scrub.pos;
        s.scrub = null;
        $('player-ui').classList.remove('scrubbing');
        if (commit) { seekTo(to); engine.play(); }
        showOsd();
    }

    function chapterJump(dir) {
        if (s.chapters.length < 2) { jump(dir * 60000); return; }
        var t = s.lastTime, cur = chapterAt(t), i = s.chapters.indexOf(cur);
        var target;
        if (dir > 0) target = s.chapters[i + 1];
        else target = cur && t - cur.startTimeOffset > 3000 ? cur : s.chapters[Math.max(0, i - 1)];
        if (!target) return;
        seekTo(target.startTimeOffset);
        Util.toast(target.tag || 'Chapter ' + target.index, 2000);
        showOsd();
    }

    // Yellow: swap between direct play and "video copied, audio converted" at the current position.
    function toggleAudioFix() {
        s.mode = s.mode === 'direct' ? 'audio-transcode' : 'direct';
        s.retried = true;
        Util.toast(s.mode === 'direct' ? 'Back to direct play (original audio).' : 'Converting audio to E-AC3 5.1 on the server; video stays untouched.', 5000);
        engine.close();
        load(s.lastTime);
    }

    /* ---------- panel (▼): Info · Chapters · Audio · Subtitles · Picture ---------- */

    var LANG2 = { eng: 'en', tur: 'tr', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', rus: 'ru', ara: 'ar', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh' };
    var CYCLE = {
        subSize: ['s', 'm', 'l', 'xl'], subColor: ['white', 'yellow', 'grey'], subBg: ['shadow', 'outline', 'box'], subPos: ['bottom', 'raised']
    };
    var NAMES = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra Large', white: 'White', yellow: 'Yellow', grey: 'Soft Grey', shadow: 'Drop Shadow', outline: 'Outline', box: 'Dark Box', bottom: 'Bottom', raised: 'Raised' };

    function tabs() {
        var t = [{ id: 'info', label: 'Info' }];
        if (s.chapters.length > 1) t.push({ id: 'chapters', label: 'Chapters' });
        t.push({ id: 'audio', label: 'Audio' }, { id: 'subtitles', label: 'Subtitles' }, { id: 'picture', label: 'Picture' });
        return t;
    }

    function openPanel(id) {
        var t = tabs();
        var i = Math.max(0, t.map(function (x) { return x.id; }).indexOf(id));
        s.panel = { tab: i, zone: id === 'info' ? 'tabs' : 'list', sel: 0, results: null };
        var items = panelItems();
        var chk = items.map(function (x) { return !!x.checked; }).indexOf(true);
        s.panel.sel = chk >= 0 ? chk : 0;
        if (!items.length) s.panel.zone = 'tabs';
        $('panel').classList.remove('hidden');
        $('player-ui').classList.add('panel-open');
        renderPanel();
        showOsd();
    }
    function closePanel() {
        s.panel = null;
        $('panel').classList.add('hidden');
        $('player-ui').classList.remove('panel-open');
        showOsd();
    }

    function adjustSetting(key, dir) {
        var list = CYCLE[key];
        s.settings[key] = list[(list.indexOf(s.settings[key]) + dir + list.length) % list.length];
        Util.store('settings', s.settings);
        subStyle();
    }

    function panelItems() {
        var id = tabs()[s.panel.tab].id, p = s.plan, items = [];
        if (id === 'chapters') {
            var cur = chapterAt(s.lastTime);
            return s.chapters.map(function (c) {
                return { chapter: c, checked: c === cur, action: function () { seekTo(c.startTimeOffset); closePanel(); } };
            });
        }
        if (id === 'audio') {
            Decide.streams(p.part, 2).forEach(function (a) {
                items.push({ label: Decide.audioLabel(a), checked: a === p.audio, action: function () { chooseAudio(a); } });
            });
            items.push({ label: s.mode === 'direct' ? 'Convert audio on the server (Yellow)' : 'Back to direct play (Yellow)',
                detail: s.mode === 'direct' ? 'For a TrueHD track that plays silent. Video stays untouched.' : 'Original audio track, sent as-is',
                action: toggleAudioFix, sep: true });
            return items;
        }
        if (id === 'subtitles') {
            if (s.panel.results) {
                if (!s.panel.results.length) items.push({ label: 'No subtitles found', disabled: true });
                s.panel.results.forEach(function (r) {
                    items.push({ label: r.label, detail: r.detail, action: function () { downloadSubtitle(r); } });
                });
                items.push({ label: '‹ Back', action: function () { s.panel.results = null; s.panel.sel = 0; renderPanel(); }, sep: true });
                return items;
            }
            var cur2 = s.sub && s.sub.stream;
            items.push({ label: 'Off', checked: !cur2, action: function () { setSubtitle(null); } });
            if (cur2 && cur2.online) items.push({ label: cur2.displayTitle, detail: 'Downloaded from OpenSubtitles', checked: true });
            Decide.streams(p.part, 3).forEach(function (t) {
                var img = Decide.isImageSub(t);
                items.push({ label: t.extendedDisplayTitle || t.displayTitle || t.codec, checked: t === cur2, disabled: img,
                    detail: img ? 'Image subtitles need the video re-encoded, which would lose HDR10+' : (t.key ? 'External file' : (s.mode === 'direct' ? 'Embedded' : 'Embedded: direct play only')),
                    action: function () { setSubtitle(t); } });
            });
            var langs = searchLangs();
            items.push({ label: 'Search online…', detail: (Online.keys().opensubtitles ? 'OpenSubtitles and your server' : 'Your server\'s subtitle search (add an OpenSubtitles key in Settings for more)') +
                ' · ' + langs.join(', '), action: searchSubtitles, sep: true });
            items.push({ label: 'Delay', value: (s.subOffset >= 0 ? '+' : '') + (s.subOffset / 1000).toFixed(1) + ' s', adjust: function (d) {
                s.subOffset += d * 100;
                if (s.sub && !s.sub.stream.key && !s.sub.stream.online) engine.subtitleDelay(s.subOffset);
            }, detail: '◀ ▶ to shift. Positive = later.' });
            ['subSize', 'subColor', 'subBg', 'subPos'].forEach(function (k) {
                var label = { subSize: 'Size', subColor: 'Colour', subBg: 'Style', subPos: 'Position' }[k];
                items.push({ label: label, value: NAMES[s.settings[k]], adjust: function (d) { adjustSetting(k, d); }, action: function () { adjustSetting(k, 1); } });
            });
            return items;
        }
        if (id === 'picture') {
            [['letterbox', 'Original (letterbox)'], ['auto', 'Auto aspect ratio'], ['fill', 'Stretch to fill']].forEach(function (m) {
                items.push({ label: m[1], checked: s.settings.picture === m[0], action: function () {
                    s.settings.picture = m[0]; Util.store('settings', s.settings); engine.display(m[0]); renderPanel();
                } });
            });
            return items;
        }
        return items;
    }

    function chooseAudio(a) {
        var res = Decide.plan(s.item, (s.item.Media || []).indexOf(s.plan.media), a.id, s.settings);
        Plex.selectStreams(s.plan.part.id, a.id);
        Memory.setTracks(s.item, { audioId: a.id, mediaIndex: (s.item.Media || []).indexOf(s.plan.media) });
        var needRestart = res.mode !== s.mode || s.mode !== 'direct';
        s.plan = res;
        s.mode = res.mode;
        if (res.audioReason) Util.toast(res.audioReason, 6000);
        if (needRestart) { engine.close(); load(s.lastTime); }
        else { applyTracks(); drawInfo(); }
        renderPanel();
    }

    // Two-letter codes for the subtitle language setting, the audio language, and English.
    function searchLangs() {
        var out = [];
        [s.settings.subLang, s.plan.audio && s.plan.audio.languageCode, 'eng'].forEach(function (l) {
            var c = l && (LANG2[l] || (l.length === 2 ? l : null));
            if (c && out.indexOf(c) < 0) out.push(c);
        });
        return out;
    }

    // OpenSubtitles (matched on this file's hash first, like Infuse) and the server's own search, side by side.
    function searchSubtitles() {
        var me = s, langs = searchLangs();
        Util.toast('Searching for subtitles…', 3000);
        var showP = s.item.type === 'episode' ? Plex.metadata(s.item.grandparentRatingKey).catch(function () { return null; }) : Promise.resolve(null);
        var os = Online.keys().opensubtitles ? showP.then(function (show) {
            return Online.searchSubtitles(s.item, show, langs, Plex.directPlayUrl(s.plan.part), s.plan.part.size);
        }).then(function (res) {
            return res.slice(0, 30).map(function (r) {
                return { source: 'opensubtitles', raw: r, label: '[' + (r.language || '?').toUpperCase() + '] ' + r.title,
                    detail: ['OpenSubtitles', r.hashMatch ? 'exact match for this file' : '', r.hearingImpaired ? 'SDH' : '', r.ai ? 'machine translated' : '',
                        r.downloads ? r.downloads.toLocaleString() + ' downloads' : ''].filter(Boolean).join(' · ') };
            });
        }, function (e) { Util.toast('OpenSubtitles: ' + e.message, 6000); return []; }) : Promise.resolve([]);
        var server = Promise.all(langs.slice(0, 2).map(function (l) {
            return Plex.searchSubtitles(s.item, l).catch(function () { return []; });
        })).then(function (lists) {
            return [].concat.apply([], lists).map(function (r) {
                return { source: 'plex', raw: r, label: r.displayTitle || r.title || r.language,
                    detail: ['Server: ' + (r.providerTitle || 'subtitle search'), r.score ? 'match ' + r.score : ''].filter(Boolean).join(' · ') };
            });
        });
        Promise.all([os, server]).then(function (r) {
            if (s !== me || !s.panel) return;
            s.panel.results = r[0].concat(r[1]); s.panel.sel = 0; renderPanel();
        });
    }

    // Use a downloaded subtitle for this session and remember it for the next time this title is played.
    function useOnline(result, text, quiet) {
        var cues = Subs.parse(text, 'srt');
        if (!cues.length) { if (!quiet) Util.toast('That subtitle file was empty or unreadable.', 5000); return; }
        setSubtitle(null, true);
        s.sub = { stream: { id: -1, online: result, displayTitle: '[' + (result.language || '').toUpperCase() + '] ' + result.title }, cues: cues };
        Memory.setTracks(s.item, { subId: 'online', online: result });
        if (s.panel) { s.panel.results = null; renderPanel(); }
        if (!quiet) Util.toast('Subtitles loaded', 2500);
    }

    function downloadSubtitle(entry) {
        var me = s, r = entry.raw;
        if (entry.source === 'opensubtitles') {
            Util.toast('Downloading…', 2000);
            Online.downloadSubtitle(r).then(function (text) { if (s === me) useOnline(r, text); },
                function (e) { Util.toast('OpenSubtitles download failed: ' + e.message, 6000); });
            return;
        }
        // Server result: save it on the server, then use the new external stream. Falls back to reading it directly.
        var known = Decide.streams(s.plan.part, 3).map(function (t) { return t.id; });
        Plex.saveSubtitle(s.item, r).then(function () { return Plex.metadata(s.item.ratingKey); }).then(function (fresh) {
            if (s !== me) return;
            var part = (((fresh.Media || [])[(s.item.Media || []).indexOf(s.plan.media)] || {}).Part || [])[0];
            var added = Decide.streams(part, 3).filter(function (t) { return known.indexOf(t.id) < 0; })[0];
            if (!added) throw new Error('not added');
            s.plan.part.Stream.push(added);
            s.panel.results = null;
            setSubtitle(added);
            Util.toast('Subtitles added', 3000);
        }).catch(function () {
            if (s !== me) return;
            Plex.subtitleText(r.key).then(function (raw) {
                var cues = Subs.parse(raw, r.codec);
                if (!cues.length) throw new Error('empty');
                setSubtitle(null, true);
                s.sub = { stream: { id: -1, key: r.key, displayTitle: r.displayTitle }, cues: cues };
                s.panel.results = null; renderPanel();
                Util.toast('Subtitles loaded for this session', 3000);
            }).catch(function () { Util.toast('Your server could not download these subtitles.', 6000); });
        });
    }

    function renderPanel() {
        if (!s || !s.panel) return;
        var P = s.panel, t = tabs(), id = t[P.tab].id, items = panelItems();
        P.sel = Math.max(0, Math.min(items.length - 1, P.sel));
        var html = '<div class="p-tabs">' + t.map(function (x, i) {
            return '<span class="p-tab' + (i === P.tab ? ' active' : '') + (i === P.tab && P.zone === 'tabs' ? ' focused' : '') + '">' + x.label + '</span>';
        }).join('') + '</div>';
        if (id === 'info') {
            var it = s.item, p = s.plan;
            var thumb = it.type === 'episode' ? it.thumb : it.thumb;
            html += '<div class="p-info"><div class="p-poster" style="background-image:url(\'' + Plex.imageUrl(thumb, 300, it.type === 'episode' ? 169 : 450) + '\')"></div><div class="p-text">' +
                '<div class="p-title">' + Util.esc(it.type === 'episode' ? it.grandparentTitle + ' · ' + it.title : it.title) + '</div>' +
                '<p class="clamp3">' + Util.esc(it.summary || '') + '</p>' +
                '<div class="kv"><b>Video</b><span>' + Util.esc(p.video ? (p.video.extendedDisplayTitle || p.video.displayTitle) : '?') + ' · ' + Util.esc(p.hdr) + '</span></div>' +
                '<div class="kv"><b>Audio</b><span>' + Util.esc(Decide.audioLabel(p.audio)) + (s.mode === 'direct' ? ' · sent as-is' : ' · converted to E-AC3 5.1 by the server') + '</span></div>' +
                '<div class="kv"><b>Playback</b><span>' + (s.mode === 'direct' ? 'Direct play' : 'Video copied untouched, audio converted') + ' · ' + Util.esc(engine.name) + '</span></div>' +
                '</div></div>';
        } else if (id === 'chapters') {
            html += '<div class="p-chapters">' + items.map(function (x, i) {
                var c = x.chapter;
                return '<div class="p-ch' + (P.zone === 'list' && i === P.sel ? ' focused' : '') + (x.checked ? ' current' : '') + '">' +
                    '<div class="img" style="' + (c.thumb ? 'background-image:url(\'' + Plex.imageUrl(c.thumb, 360, 203) + '\')' : '') + '"></div>' +
                    '<div class="t">' + Util.esc(c.tag || 'Chapter ' + c.index) + '</div><div class="s">' + Util.fmtTime(c.startTimeOffset) + '</div></div>';
            }).join('') + '</div>';
        } else {
            html += '<div class="p-list">' + items.map(function (x, i) {
                return '<div class="p-row' + (P.zone === 'list' && i === P.sel ? ' focused' : '') + (x.disabled ? ' disabled' : '') + (x.sep ? ' sep' : '') + '">' +
                    '<span class="check">' + (x.checked ? '✓' : '') + '</span><span class="lbl">' + Util.esc(x.label) +
                    (x.detail ? '<small>' + Util.esc(x.detail) + '</small>' : '') + '</span>' +
                    (x.value != null ? '<span class="val">' + (x.adjust ? '‹ ' : '') + Util.esc(x.value) + (x.adjust ? ' ›' : '') + '</span>' : '') + '</div>';
            }).join('') + '</div>';
        }
        $('panel').innerHTML = html;
        var f = $('panel').querySelector('.p-row.focused, .p-ch.focused');
        if (f) { try { f.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { f.scrollIntoView(false); } }
    }

    function panelKey(key) {
        var P = s.panel, t = tabs(), items = panelItems(), horizontal = t[P.tab].id === 'chapters';
        if (key === 'back' || ((key === 'up' || key === 'info') && P.zone === 'tabs')) { if (key === 'back' && P.zone === 'list') P.zone = 'tabs'; else { closePanel(); return true; } }
        else if (P.zone === 'tabs') {
            if (key === 'left' || key === 'right') {
                P.tab = (P.tab + (key === 'left' ? -1 : 1) + t.length) % t.length;
                P.results = null;
                var chk = panelItems().map(function (x) { return !!x.checked; }).indexOf(true);
                P.sel = chk >= 0 ? chk : 0;
            } else if ((key === 'down' || key === 'enter') && items.length) P.zone = 'list';
        } else {
            var it = items[P.sel];
            if (horizontal) {
                if (key === 'left') P.sel--;
                else if (key === 'right') P.sel++;
                else if (key === 'up') P.zone = 'tabs';
            } else if (key === 'up') { if (P.sel === 0) P.zone = 'tabs'; else P.sel--; }
            else if (key === 'down') P.sel++;
            else if ((key === 'left' || key === 'right') && it && it.adjust) it.adjust(key === 'left' ? -1 : 1);
            if (key === 'enter' && it && !it.disabled && it.action) it.action();
        }
        if (key === 'yellow') toggleAudioFix();
        renderPanel();
        showOsd();
        return true;
    }

    /* ---------- keys ---------- */

    function handleKey(key) {
        if (!s) return false;
        if (s.panel) return panelKey(key);
        if (s.scrub) {
            if (key === 'left' || key === 'rewind') scrubStep(-1);
            else if (key === 'right' || key === 'ff') scrubStep(1);
            else if (key === 'enter' || key === 'play' || key === 'playpause') endScrub(true);
            else if (key === 'back' || key === 'up' || key === 'down') endScrub(false);
            return true;
        }
        if (s.upNext && (key === 'enter' || key === 'back')) {
            if (key === 'enter') playNext();
            else { s.upNextDismissed = true; hideUpNext(); }
            return true;
        }
        if (s.skipTo != null && key === 'enter') { seekTo(s.skipTo); s.skipTo = null; $('skip').classList.add('hidden'); return true; }
        var paused = s.prepared && engine.isPaused();
        switch (key) {
        case 'enter': case 'playpause': togglePause(); break;
        case 'play': engine.play(); showOsd(); break;
        case 'pause': engine.pause(); showOsd(); break;
        case 'left': case 'rewind': if (paused) scrubStep(-1); else jump(-10000); break;
        case 'right': case 'ff': if (paused) scrubStep(1); else jump(30000); break;
        case 'up': showOsd(); break;
        case 'down': case 'info': openPanel('info'); break;
        case 'chup': chapterJump(1); break;
        case 'chdown': chapterJump(-1); break;
        case 'yellow': toggleAudioFix(); break;
        case 'blue': openPanel('audio'); break;
        case 'green': openPanel('subtitles'); break;
        case 'red': openPanel('picture'); break;
        case 'back': case 'stop': stop(false); break;
        default: showOsd();
        }
        return true;
    }

    function stopInternal(notify) {
        clearInterval(reportTimer);
        clearTimeout(osdTimer);
        clearTimeout(subTimer);
        if (!s) return;
        var cur = s;
        s = null;
        engine.close();
        Bif.release(cur.bif);
        Plex.stopTranscode(cur.sessionId);
        Plex.timeline(cur.item, 'stopped', cur.lastTime, cur.duration);
        if (cur.prepared) { Memory.savePosition(cur.item, cur.lastTime, cur.duration); Memory.flush(); }
        if (cur.duration && cur.lastTime / cur.duration > 0.9) Plex.scrobble(cur.item);
        document.body.classList.remove('playing');
        $('player-ui').className = 'hidden';
        $('panel').classList.add('hidden');
        $('upnext').classList.add('hidden');
        $('subtitle').innerHTML = ''; $('subtitle')._html = null;
        if (notify && cur.onExit) cur.onExit();
    }

    function stop(ended) { stopInternal(true); if (ended) Util.toast('Finished'); }

    return { start: start, handleKey: handleKey, active: function () { return !!s; }, engineName: function () { return engine.name; } };
})();
