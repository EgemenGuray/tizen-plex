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
        $('perror').classList.add('hidden');
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
        // direct play once more: converting the audio would lose Atmos.
        s.gen++;   // one failure can report twice (error event and failed prepare): ignore the rest of this attempt
        if (s.mode === 'direct' && !s.directRetried) {
            s.directRetried = true;
            Util.toast(msg + '. Trying again…', 4000);
            engine.close();
            var me = s;
            setTimeout(function () { if (s === me && !s.err) load(s.lastTime); }, 1500);
            return;
        }
        // Then let the viewer choose: converting the audio loses Atmos, another version may play as it is.
        showError(msg);
    }

    /* Playback error card: Try Again · Convert audio · Other version · Close (◀ ▶ and OK, Back closes). */
    function showError(msg) {
        engine.close();
        s.prepared = false;
        if (s.panel) closePanel();
        if (s.pending) { clearTimeout(s.pending.timer); s.pending = null; $('player-ui').classList.remove('seeking'); }
        var media = s.item.Media || [], btns = [];
        btns.push({ label: 'Try Again', action: function () { load(s.lastTime); } });
        btns.push({ label: s.mode === 'direct' ? 'Convert audio' : 'Direct play', action: function () {
            s.mode = s.mode === 'direct' ? 'audio-transcode' : 'direct'; s.retried = true; load(s.lastTime);
        } });
        if (media.length > 1) btns.push({ label: 'Other version', action: function () { chooseVersion((mediaIndex() + 1) % media.length); } });
        btns.push({ label: 'Close', action: function () { stop(false); } });
        // OK on the card does what used to happen by itself: convert the audio (direct play), or try again.
        s.err = { msg: msg, btns: btns, sel: s.mode === 'direct' ? 1 : 0 };
        $('player-ui').classList.remove('buffering');
        renderError();
    }
    function renderError() {
        var E = s.err, el = $('perror');
        el.innerHTML = '<div class="pe-card"><div class="pe-t">Playback failed</div><div class="pe-m">' + Util.esc(E.msg) + '</div>' +
            '<div class="pe-note">' + Util.esc(s.mode === 'direct'
                ? 'Convert audio keeps the video untouched (HDR10+ stays) and has the server send E-AC3 5.1 instead of the original track.'
                : 'The server was converting the audio. Direct play sends the original file to the TV.') + '</div>' +
            '<div class="pe-btns">' + E.btns.map(function (b, i) {
                return '<span class="pe-btn' + (i === E.sel ? ' focused' : '') + '">' + Util.esc(b.label) + '</span>';
            }).join('') + '</div></div>';
        el.classList.remove('hidden');
    }
    function errorKey(key) {
        var E = s.err;
        if (key === 'left') E.sel = Math.max(0, E.sel - 1);
        else if (key === 'right') E.sel = Math.min(E.btns.length - 1, E.sel + 1);
        else if (key === 'enter' || key === 'back') {
            var b = key === 'back' ? E.btns[E.btns.length - 1] : E.btns[E.sel];
            s.err = null;
            $('perror').classList.add('hidden');
            b.action();
            return true;
        }
        renderError();
        return true;
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
            Util.toast('Embedded subtitles show in direct play only. Choose "Back to direct play" in the audio column.', 6000);
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
        var shown = s.scrub ? s.scrub.pos : s.pending ? s.pending.target : t;
        var spct = d ? Math.min(100, shown / d * 100) : 0;
        $('osd-head').style.left = spct + '%';
        $('osd-elapsed').textContent = Util.fmtTime(shown);
        $('osd-remaining').textContent = '-' + Util.fmtTime(Math.max(0, d - shown));
        $('osd-ends').textContent = d ? 'Ends at ' + Util.fmtClock(new Date(Date.now() + (d - t))) : '';
        var ch = chapterAt(shown);
        $('osd-chapter').textContent = ch && s.chapters.length > 1 ? (ch.tag || 'Chapter ' + ch.index) : '';
        var thumb = $('osd-thumb');
        if (s.scrub || s.pending) {
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

    /* ◀ ▶ while playing: presses add up (−10 s / +30 s each) and the timeline shows where you'll land; one seek
     * happens 600 ms after the last press, so five quick presses cost one seek (one transcode restart) instead of five. */
    function jump(deltaMs) {
        var p = s.pending;
        if (!p) p = s.pending = { base: s.lastTime, delta: 0, timer: null };
        p.delta += deltaMs;
        p.target = Math.max(0, Math.min((s.duration || Infinity) - 3000, p.base + p.delta));
        clearTimeout(p.timer);
        p.timer = setTimeout(commitJump, 600);
        var j = $('osd-jump'), secs = Math.round(Math.abs(p.delta) / 1000);
        j.textContent = (p.delta >= 0 ? '+' : '−') + (secs < 100 ? secs + ' s' : Util.fmtTime(secs * 1000));
        j.className = (p.delta >= 0 ? 'right' : 'left') + ' hold';
        $('player-ui').classList.add('seeking');
        showOsd();
    }
    function commitJump() {
        var p = s && s.pending;
        if (!p) return;
        clearTimeout(p.timer);
        s.pending = null;
        $('player-ui').classList.remove('seeking');
        var j = $('osd-jump');
        j.className = p.delta >= 0 ? 'right' : 'left';
        void j.offsetWidth;
        j.classList.add('go');
        if (p.delta) seekTo(p.target);
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

    // "Convert audio on the server" / "Back to direct play" (or Yellow): swap between direct play and "video copied, audio converted" at the current position.
    function toggleAudioFix() {
        s.mode = s.mode === 'direct' ? 'audio-transcode' : 'direct';
        s.retried = true;
        Util.toast(s.mode === 'direct' ? 'Back to direct play (original audio).' : 'Converting audio to E-AC3 5.1 on the server; video stays untouched.', 5000);
        engine.close();
        load(s.lastTime);
    }

    /* ---------- panel (▼): Audio & Subtitles · Chapters · Picture · Info ----------
     * The QN900B's SolarCell remote has no colour keys, so everything is reachable with the arrows: ▼ opens straight
     * on Audio & Subtitles, two columns side by side (◀ ▶ moves between them). Colour keys still work as shortcuts. */

    var LANG2 = { eng: 'en', tur: 'tr', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', rus: 'ru', ara: 'ar', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh' };
    var CYCLE = {
        subSize: ['s', 'm', 'l', 'xl'], subColor: ['white', 'yellow', 'grey'], subBg: ['shadow', 'outline', 'box'], subPos: ['bottom', 'raised']
    };
    var NAMES = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra Large', white: 'White', yellow: 'Yellow', grey: 'Soft Grey', shadow: 'Drop Shadow', outline: 'Outline', box: 'Dark Box', bottom: 'Bottom', raised: 'Raised' };

    function tabs() {
        var t = [{ id: 'tracks', label: 'Audio & Subtitles' }];
        if (s.chapters.length > 1) t.push({ id: 'chapters', label: 'Chapters' });
        t.push({ id: 'picture', label: 'Picture' }, { id: 'info', label: 'Info' });
        return t;
    }
    function tabIndex(id) { return Math.max(0, tabs().map(function (x) { return x.id; }).indexOf(id)); }

    // col: 0 = audio, 1 = subtitles (on the Audio & Subtitles tab)
    function openPanel(id, col) {
        s.panel = { tab: tabIndex(id), zone: 'list', col: col || 0, sel: [], results: null };
        resetSel();
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

    // Focus the checked row of every column (or its first row); a tab without rows keeps focus on the tab bar.
    function resetSel() {
        var P = s.panel, cols = columns();
        P.sel = cols.map(function (items) {
            var chk = items.map(function (x) { return !!x.checked; }).indexOf(true);
            return chk >= 0 ? chk : stepRow(items, -1, 1);
        });
        if (P.col >= cols.length) P.col = 0;
        if (!cols[P.col].length) P.zone = 'tabs';
    }

    // Next selectable row from i in direction dir (headers are skipped); -1 when there is none.
    function stepRow(items, i, dir) {
        for (var n = i + dir; n >= 0 && n < items.length; n += dir) if (!items[n].header) return n;
        return -1;
    }

    function adjustSetting(key, dir) {
        var list = CYCLE[key];
        s.settings[key] = list[(list.indexOf(s.settings[key]) + dir + list.length) % list.length];
        Util.store('settings', s.settings);
        subStyle();
    }

    function columns() {
        var id = tabs()[s.panel.tab].id;
        if (id === 'tracks') return [audioItems(), subtitleItems()];
        if (id === 'chapters') {
            var cur = chapterAt(s.lastTime);
            return [s.chapters.map(function (c) {
                return { chapter: c, checked: c === cur, action: function () { seekTo(c.startTimeOffset); closePanel(); } };
            })];
        }
        if (id === 'picture') return [pictureItems()];
        return [[]];
    }

    /* Short track names: "English · TrueHD Atmos 7.1", with what happens to it on the second line. */
    var CODECS = { truehd: 'TrueHD', mlp: 'TrueHD', eac3: 'E-AC3', ac3: 'AC3', aac: 'AAC', dca: 'DTS', dts: 'DTS', flac: 'FLAC', opus: 'Opus',
        mp3: 'MP3', mp2: 'MP2', pcm: 'PCM', lpcm: 'PCM', vorbis: 'Vorbis', alac: 'ALAC',
        srt: 'SRT', subrip: 'SRT', ass: 'ASS', ssa: 'SSA', vtt: 'WebVTT', webvtt: 'WebVTT', mov_text: 'Text', pgs: 'PGS', hdmv_pgs_subtitle: 'PGS',
        vobsub: 'VobSub', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB' };
    function langName(t) { return t.language || t.languageTag || (t.languageCode ? t.languageCode.toUpperCase() : 'Unknown'); }
    function channelsName(n) { return n >= 8 ? '7.1' : n >= 6 ? '5.1' : n === 2 ? 'Stereo' : n === 1 ? 'Mono' : n ? n + ' ch' : ''; }
    function audioName(a) {
        var c = (a.codec || '').toLowerCase(), full = (a.extendedDisplayTitle || '') + ' ' + (a.displayTitle || '');
        var codec = CODECS[c] || (a.codec || '').toUpperCase();
        if (/^dca|^dts/.test(c)) codec = /DTS:X/i.test(full) ? 'DTS:X' : (/DTS-HD MA|\bMA\b/.test(full) || a.profile === 'ma') ? 'DTS-HD MA' : 'DTS';
        if (Decide.isAtmos(a) && !/DTS/.test(codec)) codec += ' Atmos';
        var name = langName(a) + ' · ' + codec + (a.channels ? ' ' + channelsName(a.channels) : '');
        // Keep a track's own title when it says something new ("Commentary"), not when it repeats the format.
        if (a.title && !/atmos|truehd|dts|ac-?3|aac|flac|surround|stereo|mono|\d\.\d|lossless|dolby/i.test(a.title)) name += ' · ' + a.title;
        return name;
    }
    function audioRoute(a, current) {
        var mode = current ? s.mode : Decide.plan(s.item, mediaIndex(), a.id, s.settings).mode;
        if (mode !== 'direct') return 'Converted to E-AC3 by the server';
        return /^(eac3|ac3|truehd|mlp)$/i.test(a.codec || '') ? 'Sent to soundbar' : 'Decoded by the TV';
    }
    function subName(t) {
        var tags = [];
        if (t.forced) tags.push('Forced');
        if (t.hearingImpaired) tags.push('SDH');
        var codec = CODECS[(t.codec || '').toLowerCase()] || (t.codec || '').toUpperCase();
        var name = langName(t) + (tags.length ? ' (' + tags.join(', ') + ')' : '') + (codec ? ' · ' + codec : '');
        if (t.title && !/forced|sdh|srt|ass|pgs|subrip|full|default/i.test(t.title)) name += ' · ' + t.title;
        return name;
    }
    function mediaIndex() { return Math.max(0, (s.item.Media || []).indexOf(s.plan.media)); }
    function versionName(m) {
        var v = Decide.streams((m.Part || [])[0], 1)[0];
        return [(m.videoResolution || '').toUpperCase(), (m.videoCodec || '').toUpperCase(), Decide.hdrLabel(v).split(' (')[0]].filter(Boolean).join(' · ');
    }

    function audioItems() {
        var p = s.plan, items = [{ header: 'Audio' }];
        Decide.streams(p.part, 2).forEach(function (a) {
            var cur = a === p.audio;
            items.push({ label: audioName(a), detail: audioRoute(a, cur), checked: cur, action: function () { if (!cur) chooseAudio(a); } });
        });
        items.push({ label: s.mode === 'direct' ? 'Convert audio on the server' : 'Back to direct play', button: true,
            detail: s.mode === 'direct' ? 'If this track plays silent. Video stays untouched.' : 'Send the original track as-is', action: toggleAudioFix });
        var media = s.item.Media || [];
        if (media.length > 1) {
            items.push({ header: 'Version' });
            media.forEach(function (m, i) {
                var cur = m === p.media, mp = Decide.plan(s.item, i, null, s.settings);
                items.push({ label: versionName(m), checked: cur,
                    detail: (mp.audio ? audioName(mp.audio) + ' · ' : '') + Math.round((m.bitrate || 0) / 1000) + ' Mbps',
                    action: function () { if (!cur) chooseVersion(i); } });
            });
        }
        return items;
    }

    function subtitleItems() {
        var p = s.plan, items = [{ header: 'Subtitles' }];
        if (s.panel.results) {
            items[0] = { header: 'Found online' };
            if (!s.panel.results.length) items.push({ label: 'No subtitles found', disabled: true });
            s.panel.results.forEach(function (r) {
                items.push({ label: r.label, detail: r.detail, action: function () { downloadSubtitle(r); } });
            });
            items.push({ label: '‹ Back', button: true, action: function () { s.panel.results = null; resetSel(); } });
            return items;
        }
        var cur = s.sub && s.sub.stream;
        items.push({ label: 'Off', checked: !cur, action: function () { setSubtitle(null); } });
        if (cur && cur.online) items.push({ label: cur.displayTitle, detail: 'Downloaded from OpenSubtitles', checked: true });
        Decide.streams(p.part, 3).forEach(function (t) {
            var img = Decide.isImageSub(t);
            items.push({ label: subName(t), checked: t === cur, disabled: img,
                detail: img ? 'Image subtitles need the video re-encoded (would lose HDR10+)' : (t.key ? 'External file' : (s.mode === 'direct' ? 'Embedded' : 'Embedded: direct play only')),
                action: function () { setSubtitle(t); } });
        });
        items.push({ label: 'Search online…', button: true, detail: (Online.keys().opensubtitles ? 'OpenSubtitles and your server' : 'Your server\'s subtitle search') +
            ' · ' + searchLangs().join(', '), action: searchSubtitles });
        items.push({ label: 'Subtitle delay', value: (s.subOffset >= 0 ? '+' : '') + (s.subOffset / 1000).toFixed(1) + ' s', adjust: function (d) {
            s.subOffset += d * 100;
            if (s.sub && !s.sub.stream.key && !s.sub.stream.online) engine.subtitleDelay(s.subOffset);
        }, detail: '◀ ▶ shifts by 0.1 s · positive shows them later' });
        return items;
    }

    function pictureItems() {
        var items = [{ header: 'Picture size' }];
        [['letterbox', 'Original (letterbox)'], ['auto', 'Auto aspect ratio'], ['fill', 'Stretch to fill']].forEach(function (m) {
            items.push({ label: m[1], checked: s.settings.picture === m[0], action: function () {
                s.settings.picture = m[0]; Util.store('settings', s.settings); engine.display(m[0]);
            } });
        });
        items.push({ header: 'Subtitle style' });
        ['subSize', 'subColor', 'subBg', 'subPos'].forEach(function (k) {
            var label = { subSize: 'Size', subColor: 'Colour', subBg: 'Style', subPos: 'Position' }[k];
            items.push({ label: label, value: NAMES[s.settings[k]], adjust: function (d) { adjustSetting(k, d); }, action: function () { adjustSetting(k, 1); } });
        });
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

    // Another file version of the same title: restart at the same position, keeping the subtitle language.
    function chooseVersion(i) {
        var plan = Decide.plan(s.item, i, null, s.settings);
        if (!plan.part) { Util.toast('That version has no playable file.'); return; }
        var prev = s.sub, sub = null;
        if (prev && !prev.stream.online && prev.stream.id !== -1) {
            sub = Decide.streams(plan.part, 3).filter(function (t) {
                return Decide.sameLang(t.languageCode, prev.stream.languageCode) && !!t.forced === !!prev.stream.forced && !Decide.isImageSub(t);
            })[0] || null;
        }
        engine.close();
        s.prepared = false;
        s.plan = plan; s.mode = plan.mode; s.retried = false; s.directRetried = false;
        Memory.setTracks(s.item, { mediaIndex: i, audioId: plan.audio && plan.audio.id });
        Plex.selectStreams(plan.part.id, plan.audio && plan.audio.id, sub ? sub.id : 0);
        // A downloaded subtitle belongs to the title, not the file, so it stays.
        if (!prev || (!prev.stream.online && prev.stream.id !== -1)) setSubtitle(sub, true);
        Bif.release(s.bif); s.bif = null;
        var me = s;
        Plex.previewIndex(plan.part).then(function (buf) { if (s === me && buf) s.bif = Bif.parse(buf); });
        drawInfo();
        Util.toast('Version: ' + versionName(plan.media), 3000);
        load(s.lastTime);
        if (s.panel) { resetSel(); renderPanel(); }
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
            s.panel.results = r[0].concat(r[1]); s.panel.col = 1; s.panel.zone = 'list'; s.panel.sel[1] = stepRow(subtitleItems(), -1, 1); renderPanel();
        });
    }

    // Use a downloaded subtitle for this session and remember it for the next time this title is played.
    function useOnline(result, text, quiet) {
        var cues = Subs.parse(text, 'srt');
        if (!cues.length) { if (!quiet) Util.toast('That subtitle file was empty or unreadable.', 5000); return; }
        setSubtitle(null, true);
        s.sub = { stream: { id: -1, online: result, displayTitle: '[' + (result.language || '').toUpperCase() + '] ' + result.title }, cues: cues };
        Memory.setTracks(s.item, { subId: 'online', online: result });
        if (s.panel) { s.panel.results = null; resetSel(); renderPanel(); }
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
            if (s.panel) { s.panel.results = null; resetSel(); }
            setSubtitle(added);
            Util.toast('Subtitles added', 3000);
        }).catch(function () {
            if (s !== me) return;
            Plex.subtitleText(r.key).then(function (raw) {
                var cues = Subs.parse(raw, r.codec);
                if (!cues.length) throw new Error('empty');
                setSubtitle(null, true);
                s.sub = { stream: { id: -1, key: r.key, displayTitle: r.displayTitle }, cues: cues };
                if (s.panel) { s.panel.results = null; resetSel(); renderPanel(); }
                Util.toast('Subtitles loaded for this session', 3000);
            }).catch(function () { Util.toast('Your server could not download these subtitles.', 6000); });
        });
    }

    function rowHtml(x, focusedRow) {
        if (x.header) return '<div class="p-head">' + Util.esc(x.header) + '</div>';
        return '<div class="p-row' + (focusedRow ? ' focused' : '') + (x.disabled ? ' disabled' : '') + (x.button ? ' p-btn' : '') + (x.checked ? ' checked' : '') + '">' +
            '<span class="check">' + (x.checked ? '✓' : '') + '</span><span class="lbl">' + Util.esc(x.label) +
            (x.detail ? '<small>' + Util.esc(x.detail) + '</small>' : '') + '</span>' +
            (x.value != null ? '<span class="val">' + (x.adjust ? '‹ ' : '') + Util.esc(x.value) + (x.adjust ? ' ›' : '') + '</span>' : '') + '</div>';
    }

    function renderPanel() {
        if (!s || !s.panel) return;
        var P = s.panel, t = tabs(), id = t[P.tab].id, cols = columns();
        cols.forEach(function (items, c) {
            // Keep the selection on a real row when the list changed under it.
            var i = Math.max(0, Math.min(items.length - 1, P.sel[c] || 0));
            if (items[i] && items[i].header) i = stepRow(items, i, 1);
            if (i < 0) i = stepRow(items, items.length, -1);
            P.sel[c] = i;
        });
        var html = '<div class="p-tabs">' + t.map(function (x, i) {
            return '<span class="p-tab' + (i === P.tab ? ' active' : '') + (i === P.tab && P.zone === 'tabs' ? ' focused' : '') + '">' + Util.esc(x.label) + '</span>';
        }).join('') + '</div>';
        if (id === 'info') {
            var it = s.item, p = s.plan;
            html += '<div class="p-info"><div class="p-poster" style="background-image:url(\'' + Plex.imageUrl(it.thumb, 300, it.type === 'episode' ? 169 : 450) + '\')"></div><div class="p-text">' +
                '<div class="p-title">' + Util.esc(it.type === 'episode' ? it.grandparentTitle + ' · ' + it.title : it.title) + '</div>' +
                '<p class="clamp3">' + Util.esc(it.summary || '') + '</p>' +
                '<div class="kv"><b>Video</b><span>' + Util.esc(p.video ? (p.video.extendedDisplayTitle || p.video.displayTitle) : '?') + ' · ' + Util.esc(p.hdr) + '</span></div>' +
                '<div class="kv"><b>Audio</b><span>' + Util.esc(p.audio ? audioName(p.audio) : 'none') + ' · ' + (s.mode === 'direct' ? 'sent as-is' : 'converted to E-AC3 5.1 by the server') + '</span></div>' +
                '<div class="kv"><b>Playback</b><span>' + (s.mode === 'direct' ? 'Direct play' : 'Video copied untouched, audio converted') + ' · ' + Util.esc(engine.name) + '</span></div>' +
                '</div></div>';
        } else if (id === 'chapters') {
            html += '<div class="p-chapters">' + cols[0].map(function (x, i) {
                var c = x.chapter;
                return '<div class="p-ch' + (P.zone === 'list' && i === P.sel[0] ? ' focused' : '') + (x.checked ? ' current' : '') + '">' +
                    '<div class="img" style="' + (c.thumb ? 'background-image:url(\'' + Plex.imageUrl(c.thumb, 360, 203) + '\')' : '') + '"></div>' +
                    '<div class="t">' + Util.esc(c.tag || 'Chapter ' + c.index) + '</div><div class="s">' + Util.fmtTime(c.startTimeOffset) + '</div></div>';
            }).join('') + '</div>';
        } else {
            html += '<div class="p-cols' + (cols.length > 1 ? ' two' : '') + '">' + cols.map(function (items, c) {
                return '<div class="p-col' + (P.zone === 'list' && P.col === c ? ' active' : '') + '"><div class="p-list">' + items.map(function (x, i) {
                    return rowHtml(x, P.zone === 'list' && P.col === c && i === P.sel[c]);
                }).join('') + '</div></div>';
            }).join('') + '</div>';
        }
        $('panel').innerHTML = html;
        // Each column scrolls on its own so the focused row stays in view.
        Array.prototype.forEach.call($('panel').querySelectorAll('.p-col'), function (colEl, c) {
            var f = colEl.querySelector('.p-row.focused') || colEl.querySelector('.p-row.checked');
            var list = colEl.firstChild;
            var y = f ? Math.max(0, f.offsetTop + f.offsetHeight - colEl.clientHeight + 40) : 0;
            list.style.transform = 'translateY(' + (-y) + 'px)';
        });
        var ch = $('panel').querySelector('.p-ch.focused');
        if (ch) { try { ch.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { ch.scrollIntoView(false); } }
    }

    function panelKey(key) {
        var P = s.panel, t = tabs(), id = t[P.tab].id, cols = columns();
        if (key === 'back') {
            if (P.results) { P.results = null; resetSel(); }
            else { closePanel(); return true; }
        } else if (key === 'info') { closePanel(); return true; }
        else if (key === 'yellow') toggleAudioFix();
        else if (key === 'blue' || key === 'green' || key === 'red') {
            P.tab = tabIndex(key === 'red' ? 'picture' : 'tracks'); P.zone = 'list'; P.col = key === 'green' ? 1 : 0; P.results = null; resetSel();
        } else if (P.zone === 'tabs') {
            if (key === 'left' || key === 'right') {
                P.tab = (P.tab + (key === 'left' ? -1 : 1) + t.length) % t.length;
                P.results = null; P.col = 0;
                resetSel(); P.zone = 'tabs';
            } else if ((key === 'down' || key === 'enter') && cols[P.col] && cols[P.col].length) P.zone = 'list';
            else if (key === 'up') { closePanel(); return true; }
        } else {
            var items = cols[P.col], it = items[P.sel[P.col]], n;
            if (id === 'chapters') {
                if (key === 'left') P.sel[0] = Math.max(0, P.sel[0] - 1);
                else if (key === 'right') P.sel[0] = Math.min(items.length - 1, P.sel[0] + 1);
                else if (key === 'up') P.zone = 'tabs';
            } else if (key === 'up') {
                n = stepRow(items, P.sel[P.col], -1);
                if (n < 0) P.zone = 'tabs'; else P.sel[P.col] = n;
            } else if (key === 'down') {
                n = stepRow(items, P.sel[P.col], 1);
                if (n >= 0) P.sel[P.col] = n;
            } else if (key === 'left' || key === 'right') {
                if (it && it.adjust) it.adjust(key === 'left' ? -1 : 1);
                else {
                    var nc = P.col + (key === 'left' ? -1 : 1);
                    if (nc >= 0 && nc < cols.length && cols[nc].length) P.col = nc;
                }
            }
            if (key === 'enter' && it && !it.disabled && it.action) it.action();
        }
        renderPanel();
        if (s) showOsd();
        return true;
    }

    /* ---------- keys ---------- */

    function handleKey(key) {
        if (!s) return false;
        if (s.err) return errorKey(key);
        var seekKey = key === 'left' || key === 'right' || key === 'ff' || key === 'rewind';
        if (s.pending && !seekKey) commitJump();
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
        case 'down': case 'info': openPanel('tracks', 0); break;
        case 'chup': chapterJump(1); break;
        case 'chdown': chapterJump(-1); break;
        // Colour keys are extras (the SolarCell remote has none); everything is also in the ▼ panel.
        case 'yellow': toggleAudioFix(); break;
        case 'blue': openPanel('tracks', 0); break;
        case 'green': openPanel('tracks', 1); break;
        case 'red': openPanel('picture'); break;
        case 'back': case 'stop': stop(false); break;
        default: showOsd();
        }
        return true;
    }

    function stopInternal(notify) {
        if (s && s.pending) clearTimeout(s.pending.timer);
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
        $('perror').classList.add('hidden');
        $('subtitle').innerHTML = ''; $('subtitle')._html = null;
        if (notify && cur.onExit) cur.onExit();
    }

    function stop(ended) { stopInternal(true); if (ended) Util.toast('Finished'); }

    return { start: start, handleKey: handleKey, active: function () { return !!s; }, engineName: function () { return engine.name; } };
})();
