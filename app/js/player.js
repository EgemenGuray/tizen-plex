/* Playback: Samsung AVPlay on the TV (hardware decode, HDR10+, bitstream audio), HTML5 <video> in a desktop browser for UI testing. */
var Player = (function () {
    'use strict';

    /* ---------- engines ---------- */

    function hasAvplay() {
        try { return !!(window.webapis && webapis.avplay); } catch (e) { return false; }
    }

    var AvplayEngine = {
        name: 'AVPlay',
        open: function (url, cb) {
            var av = webapis.avplay;
            try { av.stop(); av.close(); } catch (e) {}
            av.open(url);
            av.setDisplayRect(0, 0, 1920, 1080);
            try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
            if (/\.m3u8/.test(url)) {
                try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) {}
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
            play: function () { v().play(); },
            pause: function () { v().pause(); },
            isPaused: function () { return v().paused; },
            seek: function (ms, done) { v().currentTime = ms / 1000; if (done) done(); },
            time: function () { return v().currentTime * 1000; },
            duration: function () { return (v().duration || 0) * 1000; },
            tracks: function () { return []; },
            selectTrack: function () {},
            subtitlesOn: function () {},
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
    var osdTimer = null, reportTimer = null;

    function $(id) { return document.getElementById(id); }

    function start(item, plan, settings, startMs, onExit) {
        stopInternal(false);
        s = {
            item: item, plan: plan, settings: settings, onExit: onExit,
            mode: plan.mode, baseOffset: 0, lastTime: startMs || 0, duration: item.duration || 0,
            sessionId: Util.uuid(), retried: false, subIndex: -1, tracksOpen: false, trackSel: 0
        };
        document.body.classList.add('playing');
        $('player-ui').classList.remove('hidden');
        $('osd-title').textContent = title(item);
        load(startMs || 0);
        reportTimer = setInterval(report, 10000);
    }

    function title(item) {
        if (item.type === 'episode') return item.grandparentTitle + ' · S' + item.parentIndex + 'E' + item.index + ' · ' + item.title;
        return item.title + (item.year ? ' (' + item.year + ')' : '');
    }

    function load(atMs) {
        var p = s.plan;
        var url;
        $('subtitle').textContent = '';
        if (s.mode === 'direct') {
            url = Plex.directPlayUrl(p.part);
            s.baseOffset = 0;
        } else {
            Plex.stopTranscode(s.sessionId);
            s.sessionId = Util.uuid();
            url = Plex.audioTranscodeUrl(s.item, (s.item.Media || []).indexOf(p.media), atMs, s.sessionId);
            s.baseOffset = atMs;
        }
        updateInfo();
        // Callbacks from an earlier open (before a seek-restart or the audio fallback) are ignored.
        var gen = s.gen = (s.gen || 0) + 1;
        var live = function () { return s && s.gen === gen; };
        engine.open(url, {
            buffering: function (on) { if (on && live()) showOsd('Buffering…'); },
            time: function (ms) { if (live()) { s.lastTime = s.baseOffset + ms; refreshOsd(); } },
            ended: function () { if (live()) stop(true); },
            error: function (e) { if (live()) fail('Playback error: ' + e); },
            subtitle: function (text) { if (live() && s.subIndex >= 0) $('subtitle').textContent = text || ''; }
        });
        engine.prepare(function () {
            if (!live()) return;
            if (s.mode === 'direct') applyTracks();
            var d = engine.duration();
            if (d && s.mode === 'direct') s.duration = d;
            var go = function () { engine.play(); showOsd(); };
            if (s.mode === 'direct' && atMs > 0) engine.seek(atMs, go); else go();
        }, function (e) { if (live()) fail('Could not open the file (' + e + ')'); });
    }

    // Map the Plex stream the user chose onto AVPlay's track list (both follow container order).
    function applyTracks() {
        var tracks = engine.tracks();
        var audioTracks = tracks.filter(function (t) { return t.type === 'AUDIO'; });
        var textTracks = tracks.filter(function (t) { return t.type === 'TEXT'; });
        var plexAudio = Decide.streams(s.plan.part, 2);
        var ai = plexAudio.indexOf(s.plan.audio);
        if (ai >= 0 && audioTracks[ai]) {
            try { engine.selectTrack('AUDIO', audioTracks[ai].index); } catch (e) {}
        }
        if (s.subIndex >= 0 && textTracks[s.subIndex]) {
            try { engine.selectTrack('TEXT', textTracks[s.subIndex].index); engine.subtitlesOn(true); } catch (e) {}
        } else {
            engine.subtitlesOn(false);
        }
        s.engineTracks = { audio: audioTracks, text: textTracks };
    }

    function fail(msg) {
        if (!s) return;
        // Direct play failed: most often an audio format the TV rejects. Retry once with the audio converted.
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

    function updateInfo() {
        var p = s.plan;
        var parts = [
            engine.name,
            s.mode === 'direct' ? 'Direct play' : 'Video copied, audio converted to E-AC3',
            p.video ? (p.video.displayTitle || p.video.codec) + ' · ' + p.hdr : '',
            'Audio: ' + (s.mode === 'direct' ? Decide.audioLabel(p.audio) : 'E-AC3 5.1 (from ' + Decide.audioLabel(p.audio) + ')')
        ];
        $('osd-info').textContent = parts.filter(Boolean).join('  ·  ');
    }

    function showOsd(msg) {
        var osd = $('osd');
        osd.classList.remove('faded');
        if (msg) Util.toast(msg, 2000);
        refreshOsd();
        clearTimeout(osdTimer);
        osdTimer = setTimeout(function () { if (s && !s.tracksOpen && !engine.isPaused()) osd.classList.add('faded'); }, 4000);
    }

    function refreshOsd() {
        if (!s) return;
        var pct = s.duration ? Math.min(100, s.lastTime / s.duration * 100) : 0;
        $('osd-progress').style.width = pct + '%';
        $('osd-time').textContent = Util.fmtTime(s.lastTime) + ' / ' + Util.fmtTime(s.duration);
    }

    function report() {
        if (!s) return;
        Plex.timeline(s.item, engine.isPaused() ? 'paused' : 'playing', s.lastTime, s.duration);
    }

    function seekBy(deltaMs) {
        var target = Math.max(0, Math.min((s.duration || Infinity) - 5000, s.lastTime + deltaMs));
        s.lastTime = target;
        if (s.mode === 'direct') engine.seek(target);
        else { engine.close(); load(target); }   // transcoded stream: restart the transcode at the new offset
        showOsd();
    }

    function togglePause() {
        if (engine.isPaused()) engine.play(); else engine.pause();
        report();
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

    /* ---------- tracks panel (Blue) ---------- */

    function trackOptions() {
        var opts = [];
        Decide.streams(s.plan.part, 2).forEach(function (a) {
            opts.push({ kind: 'audio', stream: a, label: '♪ ' + Decide.audioLabel(a), active: a === s.plan.audio });
        });
        opts.push({ kind: 'sub', idx: -1, label: 'Subtitles off', active: s.subIndex < 0 });
        Decide.streams(s.plan.part, 3).filter(function (t) { return !t.key; }).forEach(function (t, i) {
            opts.push({ kind: 'sub', idx: i, label: '💬 ' + (t.extendedDisplayTitle || t.displayTitle || t.codec), active: s.subIndex === i });
        });
        return opts;
    }

    function renderTracks() {
        var opts = trackOptions();
        s.trackSel = Math.max(0, Math.min(opts.length - 1, s.trackSel));
        $('osd-tracks').innerHTML = '<h2 style="margin-top:0">Audio & subtitles</h2>' + opts.map(function (o, i) {
            return '<div class="list-item' + (i === s.trackSel ? ' focused' : '') + '"><span>' + Util.esc(o.label) + '</span><span>' + (o.active ? '✓' : '') + '</span></div>';
        }).join('') + (s.mode !== 'direct' ? '<p class="muted">Embedded subtitles show in direct play only.</p>' : '');
    }

    function chooseTrack() {
        var o = trackOptions()[s.trackSel];
        if (!o) return;
        if (o.kind === 'audio') {
            var res = Decide.plan(s.item, (s.item.Media || []).indexOf(s.plan.media), o.stream.id, s.settings);
            Plex.selectStreams(s.plan.part.id, o.stream.id);
            var needRestart = res.mode !== s.mode || s.mode !== 'direct';
            s.plan = res;
            s.mode = res.mode;
            if (res.audioReason) Util.toast(res.audioReason, 6000);
            if (needRestart) { engine.close(); load(s.lastTime); }
            else { applyTracks(); updateInfo(); }
        } else {
            s.subIndex = o.idx;
            $('subtitle').textContent = '';
            if (s.mode === 'direct') applyTracks();
        }
        renderTracks();
    }

    /* ---------- keys ---------- */

    function handleKey(key) {
        if (!s) return false;
        if (s.tracksOpen) {
            if (key === 'up') s.trackSel--;
            else if (key === 'down') s.trackSel++;
            else if (key === 'enter') chooseTrack();
            else if (key === 'back' || key === 'blue') { s.tracksOpen = false; $('osd-tracks').classList.add('hidden'); showOsd(); return true; }
            renderTracks();
            return true;
        }
        switch (key) {
        case 'enter': case 'playpause': togglePause(); break;
        case 'play': engine.play(); showOsd(); break;
        case 'pause': engine.pause(); showOsd(); break;
        case 'left': case 'rewind': seekBy(-10000); break;
        case 'right': case 'ff': seekBy(30000); break;
        case 'up': seekBy(60000); break;
        case 'down': seekBy(-60000); break;
        case 'yellow': toggleAudioFix(); break;
        case 'blue': s.tracksOpen = true; $('osd-tracks').classList.remove('hidden'); renderTracks(); showOsd(); break;
        case 'back': case 'stop': stop(false); break;
        default: showOsd();
        }
        return true;
    }

    function stopInternal(notify) {
        clearInterval(reportTimer);
        if (!s) return;
        var cur = s;
        s = null;
        engine.close();
        Plex.stopTranscode(cur.sessionId);
        Plex.timeline(cur.item, 'stopped', cur.lastTime, cur.duration);
        if (cur.duration && cur.lastTime / cur.duration > 0.9) Plex.scrobble(cur.item);
        document.body.classList.remove('playing');
        $('player-ui').classList.add('hidden');
        $('osd-tracks').classList.add('hidden');
        if (notify && cur.onExit) cur.onExit();
    }

    function stop(ended) { stopInternal(true); if (ended) Util.toast('Finished'); }

    return { start: start, handleKey: handleKey, active: function () { return !!s; }, engineName: function () { return engine.name; } };
})();
