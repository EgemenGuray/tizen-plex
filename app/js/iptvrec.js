/* Downloads (films, episodes, catch-up programmes) and recordings (live channels, now or scheduled from the guide).
 * The stream is read with fetch() and written to the TV's Downloads folder through the Tizen filesystem API, so
 * recordings can stop at their end time. Jobs run while Lumen is open. Not available in a desktop browser. ES5 only. */
var IPTVRec = (function () {
    'use strict';

    var jobs = Util.store('iptv.jobs') || [];
    var running = {};   // id -> { reader, handle, timer }
    jobs.forEach(function (j) { if (j.state === 'running') { j.state = 'failed'; j.error = 'Interrupted when Lumen closed.'; } });

    function save() { Util.store('iptv.jobs', jobs); }
    function find(id) { return jobs.filter(function (j) { return j.id === id; })[0]; }
    function supported() { try { return !!(window.tizen && tizen.filesystem && tizen.filesystem.openFile && window.fetch && window.ReadableStream); } catch (e) { return false; } }

    function fileName(title, ext) {
        return String(title).replace(/[\/\\:*?"<>|]/g, ' ').slice(0, 80).trim() + ' ' + Math.floor(Date.now() / 1000) + '.' + (ext || 'ts');
    }
    function extOf(url) {
        var e = ((url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
        return ['mp4', 'mkv', 'avi', 'mov', 'm4v', 'ts', 'webm'].indexOf(e) >= 0 ? e : 'ts';
    }
    function path(j) { return 'downloads/Lumen/' + j.file; }
    function fileURI(j) { try { return tizen.filesystem.toURI(path(j)); } catch (e) { return 'file:///opt/usr/home/owner/content/Downloads/Lumen/' + j.file; } }

    function add(j) {
        if (!supported()) { Util.toast('Recording and downloads work on the TV only.'); return null; }
        j.id = Util.uuid(); j.state = 'scheduled'; j.received = 0; j.created = Date.now();
        jobs.unshift(j);
        save();
        tick();
        return j;
    }

    function download(kind, item, extra) {
        var url = item.url;
        if (kind === 'catchup') {
            url = IPTV.catchupURL(item.channel, item.programme);
            return add({ kind: 'download', title: item.programme.title, subtitle: item.channel.name, poster: item.channel.logo, url: url,
                userAgent: item.channel.userAgent, file: fileName(item.channel.name + ' ' + item.programme.title, 'ts'), start: Date.now(),
                end: Date.now() + (item.programme.end - item.programme.start) + 600000 });
        }
        var title = kind === 'episode' ? extra.name + ' S' + item.season + ' E' + item.number : item.name;
        return add({ kind: 'download', title: title, subtitle: kind === 'episode' ? item.title : (item.year || ''), poster: item.thumb || item.poster || (extra && extra.poster),
            url: url, file: fileName(title, extOf(url)), start: Date.now(), end: null });
    }

    function record(ch, p, minutes) {
        var start = p ? Math.max(Date.now(), p.start - 60000) : Date.now();
        var end = p ? p.end + 120000 : Date.now() + (minutes || 60) * 60000;
        var title = p ? p.title : ch.name;
        return add({ kind: 'recording', title: title, subtitle: ch.name + ' · ' + Util.fmtClock(new Date(start)) + ' – ' + Util.fmtClock(new Date(end)),
            poster: ch.logo, url: ch.url, userAgent: ch.userAgent, file: fileName(ch.name + ' ' + title, 'ts'), start: start, end: end, channelID: ch.id });
    }

    function isRecording(ch, p) {
        return jobs.some(function (j) { return j.kind === 'recording' && j.channelID === ch.id && (j.state === 'scheduled' || j.state === 'running') && j.start <= p.start + 60000 && j.end >= p.end; });
    }
    function recordingOf(ch) { return jobs.filter(function (j) { return j.kind === 'recording' && j.channelID === ch.id && j.state === 'running'; })[0] || null; }

    function tick() {
        var now = Date.now();
        jobs.forEach(function (j) {
            if (j.state === 'scheduled' && j.start <= now) {
                if (j.end && j.end <= now) { j.state = 'failed'; j.error = 'Lumen wasn\'t open at the scheduled time.'; save(); return; }
                begin(j);
            } else if (j.state === 'running' && j.end && j.end <= now) {
                stop(j.id, 'done');
            }
        });
    }
    setInterval(tick, 10000);

    function openFile(j, mode) {
        try { tizen.filesystem.createDirectory('downloads/Lumen', true); } catch (e) { /* exists */ }
        return tizen.filesystem.openFile(path(j), mode);
    }

    function begin(j, append) {
        j.state = 'running'; j.error = null;
        if (!append) j.received = 0;
        save();
        var handle;
        try { handle = openFile(j, append ? 'a' : 'w'); } catch (e) { fail(j, 'Can\'t write to Downloads: ' + (e.message || e)); return; }
        var r = running[j.id] = { handle: handle, reader: null, last: 0 };
        var headers = {};
        if (j.userAgent) headers['User-Agent'] = j.userAgent;
        if (/\.m3u8(\?|$)/i.test(j.url)) { hls(j, r); return; }
        fetch(j.url, { headers: headers }).then(function (resp) {
            if (!resp.ok) throw new Error('The server answered ' + resp.status + '.');
            j.expected = parseInt(resp.headers.get('content-length'), 10) || null;
            r.reader = resp.body.getReader();
            function pump() {
                return r.reader.read().then(function (res) {
                    if (res.done) return finished(j, null);
                    if (running[j.id] !== r) return;
                    r.handle.writeData(res.value);
                    j.received += res.value.length;
                    if (Date.now() - r.last > 2000) { r.last = Date.now(); save(); }
                    return pump();
                });
            }
            return pump();
        }).catch(function (e) { if (running[j.id] === r) finished(j, e); });
    }

    /* HLS channels: poll the playlist and append each new segment. */
    function hls(j, r) {
        var seen = {}, media = j.url;
        function text(u) { return fetch(u).then(function (x) { if (!x.ok) throw new Error('HTTP ' + x.status); return x.text(); }); }
        function bytes(u) { return fetch(u).then(function (x) { if (!x.ok) throw new Error('HTTP ' + x.status); return x.arrayBuffer(); }); }
        function abs(u, base) { try { return new URL(u, base).href; } catch (e) { return u; } }
        function round() {
            if (running[j.id] !== r) return;
            if (j.end && Date.now() >= j.end) return finished(j, null);
            text(media).then(function (t) {
                var lines = t.split(/\r?\n/).map(function (l) { return l.trim(); });
                if (lines.some(function (l) { return l.indexOf('#EXT-X-STREAM-INF') === 0; })) {
                    var best = null, bw = -1;
                    lines.forEach(function (l, i) {
                        if (l.indexOf('#EXT-X-STREAM-INF') !== 0) return;
                        var b = parseInt((/BANDWIDTH=(\d+)/.exec(l) || [])[1], 10) || 0;
                        if (b >= bw && lines[i + 1]) { bw = b; best = abs(lines[i + 1], media); }
                    });
                    if (best) { media = best; return round(); }
                }
                var target = 6;
                lines.forEach(function (l) { if (l.indexOf('#EXT-X-TARGETDURATION:') === 0) target = parseFloat(l.slice(22)) || 6; });
                var segs = lines.filter(function (l) { return l && l[0] !== '#'; }).map(function (l) { return abs(l, media); }).filter(function (u) { return !seen[u]; });
                var chain = Promise.resolve();
                segs.forEach(function (u) {
                    seen[u] = 1;
                    chain = chain.then(function () { return bytes(u); }).then(function (b) {
                        if (running[j.id] !== r) return;
                        r.handle.writeData(new Uint8Array(b));
                        j.received += b.byteLength;
                    });
                });
                return chain.then(function () {
                    save();
                    if (lines.indexOf('#EXT-X-ENDLIST') >= 0) return finished(j, null);
                    setTimeout(round, Math.max(1000, target * 500));
                });
            }).catch(function () { setTimeout(round, 3000); });
        }
        round();
    }

    function finished(j, err) {
        var r = running[j.id];
        if (r) { try { r.handle.close(); } catch (e) {} delete running[j.id]; }
        if (j.state !== 'running') return;
        if (j.kind === 'recording' && j.end && j.end > Date.now() + 30000) {
            // A live recording that drops reconnects and keeps appending until its end time.
            setTimeout(function () { if (j.state === 'running') begin(j, true); }, 3000);
            return;
        }
        if (err && j.kind === 'download') fail(j, err.message || String(err));
        else { j.state = 'done'; save(); }
    }

    function fail(j, msg) { j.state = 'failed'; j.error = msg; save(); }

    function stop(id, state) {
        var j = find(id);
        if (!j) return;
        var r = running[id];
        delete running[id];
        if (r) { try { if (r.reader) r.reader.cancel(); } catch (e) {} try { r.handle.close(); } catch (e) {} }
        if (j.kind === 'recording' && j.received > 0) { j.state = 'done'; j.end = Math.min(j.end || Date.now(), Date.now()); }
        else j.state = state || 'cancelled';
        save();
    }

    function remove(id) {
        var j = find(id);
        stop(id);
        if (j) { try { tizen.filesystem.deleteFile(path(j)); } catch (e) {} }
        jobs = jobs.filter(function (x) { return x.id !== id; });
        save();
    }

    function retry(id) {
        var j = find(id);
        if (!j || (j.kind === 'recording' && j.end && j.end <= Date.now())) return;
        j.state = 'scheduled'; j.start = Math.min(j.start, Date.now());
        save(); tick();
    }

    return {
        supported: supported, download: download, record: record, isRecording: isRecording, recordingOf: recordingOf,
        stop: stop, remove: remove, retry: retry, fileURI: fileURI,
        list: function (kind) { return jobs.filter(function (j) { return j.kind === kind; }); }
    };
})();
