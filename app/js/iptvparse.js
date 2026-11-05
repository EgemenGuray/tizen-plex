/* IPTV parsing: M3U playlists, Xtream Codes lists and XMLTV guides. Plain functions with no DOM, so the same file runs
 * in the page and in the background worker (iptvworker.js), which keeps big playlists and 100 MB guides off the
 * thread that draws the screen. ES5 only. */
var IPTVParse = (function () {
    'use strict';

    /* ---------- helpers ---------- */

    function str(v) { return v === null || v === undefined || v === '' ? null : String(v); }
    function int(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
    function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
    function bool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
    function dateOf(v) { var n = int(v); return n && n > 0 ? n * 1000 : null; }
    function yearOf(v) { var s = str(v); if (!s) return null; var y = parseInt(s.slice(0, 4), 10); return y > 1880 ? y : null; }
    function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }

    /* Name key for matching against the guide: lower case, letters and digits only, no quality tags. */
    var KEY_TAGS = / (?:hd|fhd|uhd|4k|sd|hevc)|\(hd\)|\[hd\]/g;
    var KEY_STRIP = /[^a-z0-9À-ɏЀ-ӿ]/g;
    function key(name) {
        var s = ' ' + String(name || '').toLowerCase() + ' ';
        return s.replace(KEY_TAGS, '').replace(KEY_STRIP, '');
    }

    function splitYear(name) {
        var m = /^(.*?)[\s\-]*[\(\[]?((?:19|20)\d{2})[\)\]]?\s*$/.exec(name);
        if (!m || !m[1].trim()) return { title: name, year: null };
        return { title: m[1].trim(), year: parseInt(m[2], 10) };
    }

    var EP_RES = [/^(.*?)[\s._\-]*[Ss](\d{1,2})[\s._\-]*[Ee](\d{1,3})(.*)$/, /^(.*?)[\s._\-]+(\d{1,2})x(\d{1,3})(.*)$/];
    function episodeInfo(name) {
        for (var i = 0; i < EP_RES.length; i++) {
            var m = EP_RES[i].exec(name);
            if (!m) continue;
            var show = m[1].replace(/\./g, ' ').replace(/^[\s\-_|]+|[\s\-_|]+$/g, '');
            if (!show) continue;
            var rest = m[4].replace(/\./g, ' ').replace(/^[\s\-_|]+|[\s\-_|]+$/g, '');
            return { show: show, season: parseInt(m[2], 10), episode: parseInt(m[3], 10), title: rest || 'Episode ' + parseInt(m[3], 10) };
        }
        return null;
    }

    function emptyContent() {
        return { channels: [], movies: [], series: [], liveGroups: [], movieGroups: [], seriesGroups: [], epgURLs: [], serverTimeZone: null, account: null };
    }

    /* Bytes to text: UTF-8, or Latin-1 when the bytes are not valid UTF-8. */
    function text(buf) {
        var b = new Uint8Array(buf);
        try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return new TextDecoder('iso-8859-1').decode(b); }
    }

    /* ---------- M3U ---------- */

    function attrs(s) {
        var out = {}, re = /([\w\-]+)=("([^"]*)"|(\S+))/g, m;
        while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
        return out;
    }

    function splitInfo(s) {
        var q = false;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c === 34) q = !q;
            else if (c === 44 && !q) return [s.slice(0, i), s.slice(i + 1)];
        }
        return [s, ''];
    }

    var VIDEO_EXT = { mp4: 1, mkv: 1, avi: 1, mov: 1, m4v: 1, wmv: 1, webm: 1 };
    function classify(url, name, type) {
        if (type === 'movie' || type === 'movies' || type === 'vod') return 'movie';
        if (type === 'series' || type === 'tvshow') return 'series';
        if (type === 'live' || type === 'stream') return 'live';
        var lower = url.toLowerCase();
        if (lower.indexOf('/series/') >= 0) return 'series';
        if (lower.indexOf('/movie/') >= 0 || lower.indexOf('/movies/') >= 0) return 'movie';
        var ext = (lower.split('?')[0].match(/\.([a-z0-9]+)$/) || [])[1];
        if (VIDEO_EXT[ext]) return episodeInfo(name) ? 'series' : 'movie';
        return 'live';
    }

    function parseM3U(text, pl) {
        var c = emptyContent(), pid = pl.id;
        var header = null, info = null, grp = null, ua = null, seen = {}, seriesMap = {};
        var lg = [], mg = [], sg = [], lgs = {}, mgs = {}, sgs = {};
        function addGroup(list, set, g) { if (!set[g]) { set[g] = 1; list.push(g); } }
        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.charCodeAt(0) === 35) {   // '#'
                if (line.indexOf('#EXTINF') === 0) {
                    var parts = splitInfo(line.slice(line.indexOf(':') + 1));
                    info = { a: attrs(parts[0]), name: parts[1].trim() };
                } else if (line.indexOf('#EXTM3U') === 0) {
                    var h = attrs(line.slice(7));
                    ['url-tvg', 'x-tvg-url', 'tvg-url'].forEach(function (k) {
                        if (h[k]) h[k].split(',').forEach(function (u) { if (u.trim()) c.epgURLs.push(u.trim()); });
                    });
                    if (h.catchup || h['catchup-type']) header = { mode: h.catchup || h['catchup-type'], days: int(h['catchup-days']) || 7, source: h['catchup-source'] || null };
                } else if (line.indexOf('#EXTGRP:') === 0) grp = line.slice(8).trim();
                else if (line.indexOf('#EXTVLCOPT:') === 0) {
                    var opt = line.slice(11);
                    if (/^http-user-agent=/i.test(opt)) ua = opt.slice(16);
                }
                continue;
            }
            var a = (info && info.a) || {};
            var url = line;
            var name = (info && info.name) || a['tvg-name'] || url;
            var group = a['group-title'] || grp || 'Other';
            var logo = a['tvg-logo'] || null;
            var kind = classify(url, name, (a['tvg-type'] || a.type || '').toLowerCase());
            if (kind === 'live') {
                var id = pid + '|' + (a['tvg-id'] || '') + '|' + name;
                if (seen[id]) id += '|' + hash(url);
                seen[id] = 1;
                var cu = null;
                var mode = a.catchup || a['catchup-type'];
                var days = int(a.timeshift || a['tvg-rec'] || a['catchup-days']);
                if (mode) cu = { mode: mode, days: int(a['catchup-days']) || (header && header.days) || 7, source: a['catchup-source'] || (header && header.source) || null };
                else if (days > 0) cu = { mode: (header && header.mode) || 'default', days: days, source: a['catchup-source'] || (header && header.source) || null };
                else if (header) cu = { mode: header.mode, days: header.days, source: header.source };
                if (cu && !cu.source && cu.mode === 'default' && (url.indexOf('/live/') >= 0 || url.split('/').length >= 6)) cu.mode = 'xc';
                c.channels.push({
                    id: id, playlistID: pid, name: name, number: int(a['tvg-chno'] || a['channel-number'] || a['tvg-num']),
                    logo: logo, group: group, url: url, epgID: a['tvg-id'] || null, catchup: cu,
                    userAgent: ua || a['user-agent'] || a['http-user-agent'] || null, streamID: null
                });
                addGroup(lg, lgs, group);
            } else if (kind === 'movie') {
                var ty = splitYear(name);
                c.movies.push({ id: pid + '|m|' + name + '|' + hash(url), playlistID: pid, name: ty.title, poster: logo, group: group, url: url, rating: null, year: ty.year, added: null, streamID: null });
                addGroup(mg, mgs, group);
            } else {
                var ep = episodeInfo(name);
                var show = ep ? ep.show : name;
                var sk = group + '|' + show.toLowerCase();
                var e = { id: pid + '|e|' + hash(url), season: ep ? ep.season : 1, number: ep ? ep.episode : 1, title: ep ? ep.title : name, url: url, thumb: logo };
                if (seriesMap[sk] !== undefined) c.series[seriesMap[sk]].episodes.push(e);
                else {
                    seriesMap[sk] = c.series.length;
                    c.series.push({ id: pid + '|s|' + sk, playlistID: pid, name: show, poster: logo, group: group, episodes: [e] });
                }
                addGroup(sg, sgs, group);
            }
            info = null; grp = null; ua = null;
        }
        c.series.forEach(function (s) { s.episodes.sort(function (x, y) { return x.season - y.season || x.number - y.number; }); });
        c.liveGroups = lg; c.movieGroups = mg; c.seriesGroups = sg;
        return c;
    }

    /* ---------- Xtream Codes ---------- */

    function xtreamBase(raw) {
        var s = String(raw || '').trim();
        if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
        s = s.split('?')[0];
        ['/player_api.php', '/get.php', '/xmltv.php', '/'].forEach(function (x) { if (s.slice(-x.length) === x) s = s.slice(0, -x.length); });
        return s.replace(/\/+$/, '');
    }

    function xtreamList(v) {
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') return Object.keys(v).map(function (k) { return v[k]; });
        return [];
    }

    function jsonOf(buf) {
        var t = typeof buf === 'string' ? buf : text(buf);
        try { return t ? JSON.parse(t) : []; } catch (e) { return []; }
    }

    /* The six Xtream lists (live categories and streams, film categories and streams, series categories and series)
     * as raw bytes or text, turned into Lumen's content. `c` already has the account details. */
    function xtreamContent(pl, c, raw) {
        var base = xtreamBase(pl.url), u = encodeURIComponent(pl.username), p = encodeURIComponent(pl.password), pid = pl.id;
        var r = raw.map(jsonOf);
        function cats(v) { var m = {}, order = []; xtreamList(v).forEach(function (x) { var id = str(x.category_id), n = str(x.category_name); if (id && n) { m[id] = n; order.push(n); } }); return { map: m, order: order }; }
        function groupsOf(order, used) { var seen = {}; return order.concat(['Other']).filter(function (g) { if (!used[g] || seen[g]) return false; seen[g] = 1; return true; }); }
        var lc = cats(r[0]), vc = cats(r[2]), sc = cats(r[4]);
        var used = {};
        xtreamList(r[1]).forEach(function (s) {
            var id = int(s.stream_id); if (id === null) return;
            var g = lc.map[str(s.category_id)] || 'Other';
            used[g] = 1;
            var days = int(s.tv_archive_duration) || 0;
            c.channels.push({
                id: pid + '|' + id, playlistID: pid, name: str(s.name) || 'Channel ' + id, number: int(s.num), logo: str(s.stream_icon),
                group: g, url: base + '/live/' + u + '/' + p + '/' + id + '.ts', epgID: str(s.epg_channel_id),
                catchup: bool(s.tv_archive) && days > 0 ? { mode: 'xc', days: days, source: null } : null,
                userAgent: pl.userAgent || null, streamID: id
            });
        });
        c.liveGroups = groupsOf(lc.order, used);
        used = {};
        xtreamList(r[3]).forEach(function (s) {
            var id = int(s.stream_id); if (id === null) return;
            var g = vc.map[str(s.category_id)] || 'Other';
            used[g] = 1;
            var ty = splitYear(str(s.name) || 'Film ' + id);
            c.movies.push({
                id: pid + '|m|' + id, playlistID: pid, name: ty.title, poster: str(s.stream_icon), group: g,
                url: base + '/movie/' + u + '/' + p + '/' + id + '.' + (str(s.container_extension) || 'mp4'), rating: num(s.rating) || null,
                year: ty.year || yearOf(s.year) || yearOf(s.releasedate), added: dateOf(s.added), streamID: id
            });
        });
        c.movieGroups = groupsOf(vc.order, used);
        used = {};
        xtreamList(r[5]).forEach(function (s) {
            var id = int(s.series_id); if (id === null) return;
            var g = sc.map[str(s.category_id)] || 'Other';
            used[g] = 1;
            c.series.push({
                id: pid + '|s|' + id, playlistID: pid, name: str(s.name) || 'Series ' + id, poster: str(s.cover), group: g,
                plot: str(s.plot), rating: num(s.rating) || null, year: yearOf(s.releaseDate) || yearOf(s.release_date), genre: str(s.genre), seriesID: id
            });
        });
        c.seriesGroups = groupsOf(sc.order, used);
        return c;
    }

    /* ---------- XMLTV ---------- */

    function xmltvDate(s) {
        var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+\-]\d{4})?/.exec(String(s || '').trim());
        if (!m) return null;
        var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (m[7]) { var sign = m[7][0] === '-' ? -1 : 1; t -= sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10)) * 60000; }
        return t;
    }

    function decode(s) {
        s = String(s);
        if (s.indexOf('&') < 0) return s;
        return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, function (all, e) {
            var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
            if (map[e.toLowerCase()]) return map[e.toLowerCase()];
            if (e[1] === 'x' || e[1] === 'X') return String.fromCharCode(parseInt(e.slice(2), 16));
            return String.fromCharCode(parseInt(e.slice(1), 10));
        });
    }

    /* The text of the first <name ...>...</name> in an element, without regular expressions over the whole guide. */
    function tag(body, name) {
        var open = '<' + name, i = 0, n = open.length;
        for (;;) {
            i = body.indexOf(open, i);
            if (i < 0) return null;
            var c = body.charCodeAt(i + n);
            if (c === 62 || c === 32 || c === 47 || c === 9 || c === 10 || c === 13) break;   // > space / tab newline
            i += n;
        }
        var gt = body.indexOf('>', i);
        if (gt < 0) return null;
        if (body.charCodeAt(gt - 1) === 47) return '';   // <name/>
        var end = body.indexOf('</' + name + '>', gt);
        if (end < 0) return null;
        var v = body.slice(gt + 1, end);
        if (v.indexOf('<![CDATA[') >= 0) v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
        return decode(v).trim();
    }

    function attr(head, name) {
        var i = head.indexOf(' ' + name + '="');
        if (i < 0) { i = head.indexOf('\t' + name + '="'); if (i < 0) i = head.indexOf('\n' + name + '="'); if (i < 0) return null; }
        i += name.length + 3;
        var j = head.indexOf('"', i);
        return j < 0 ? null : head.slice(i, j);
    }

    /* A tag scanner that is fed the guide a piece at a time, so a 100 MB file never has to be one string.
     * Keeps only channels the playlists have (by id or by name) and programmes inside [from, to). */
    function XMLTVScanner(wantedIDs, wantedNames, from, to) {
        var progs = {}, names = {}, kept = {}, icons = {}, buf = '', count = 0;
        function channel(el) {
            var gt = el.indexOf('>');
            var id = attr(el.slice(0, gt + 1), 'id');
            if (id === null) return;
            id = decode(id).toLowerCase();
            var keep = !!wantedIDs[id], i = gt, d;
            while ((i = el.indexOf('<display-name', i)) >= 0) {
                var a = el.indexOf('>', i), b = el.indexOf('</display-name>', a);
                if (a < 0 || b < 0) break;
                d = key(decode(el.slice(a + 1, b)));
                if (wantedNames[d]) keep = true;
                if (!names[d]) names[d] = id;
                i = b;
            }
            if (keep) {
                kept[id] = 1;
                var ic = el.indexOf('<icon');
                if (ic >= 0) { var src = attr(el.slice(ic, el.indexOf('>', ic) + 1), 'src'); if (src) icons[id] = decode(src); }
            }
        }
        function programme(el) {
            var gt = el.indexOf('>'), head = el.slice(0, gt + 1);
            var ch = attr(head, 'channel');
            if (!ch) return;
            ch = decode(ch).toLowerCase();
            if (!kept[ch] && !wantedIDs[ch]) return;
            var start = xmltvDate(attr(head, 'start'));
            var stop = xmltvDate(attr(head, 'stop')) || (start + 3600000);
            if (!start || stop <= from || start >= to) return;
            var body = el.slice(gt + 1);
            var p = { start: start, end: stop, title: tag(body, 'title') || '' };
            var sub = tag(body, 'sub-title'), desc = tag(body, 'desc'), cat = tag(body, 'category');
            var ei = body.indexOf('system="xmltv_ns"');
            if (ei >= 0) {
                var a = body.indexOf('>', ei), b = body.indexOf('<', a);
                var parts = body.slice(a + 1, b).split('.');
                var sn = parseInt(parts[0], 10), ep = parseInt(parts[1], 10);
                if (!isNaN(sn) && !isNaN(ep)) sub = 'S' + (sn + 1) + ' E' + (ep + 1) + (sub ? ' · ' + sub : '');
            }
            if (sub) p.episode = sub;
            if (desc) p.desc = desc;
            if (cat) p.category = cat;
            (progs[ch] = progs[ch] || []).push(p);
            count++;
        }
        function push(chunk) {
            buf = buf ? buf + chunk : chunk;
            var pos = 0, nc = buf.indexOf('<channel'), np = buf.indexOf('<programme');
            for (;;) {
                if (nc >= 0 && nc < pos) nc = buf.indexOf('<channel', pos);
                if (np >= 0 && np < pos) np = buf.indexOf('<programme', pos);
                var isCh = nc >= 0 && (np < 0 || nc < np), at = isCh ? nc : np;
                if (at < 0) { pos = Math.max(pos, buf.length - 12); break; }   // keep a partial "<programm" for the next piece
                var close = isCh ? '</channel>' : '</programme>';
                var next = buf.charCodeAt(at + (isCh ? 8 : 10));
                if (next !== 32 && next !== 62 && next !== 9 && next !== 10 && next !== 13) {
                    if (at + 11 > buf.length) { pos = at; break; }
                    pos = at + 1; continue;   // <channels>, <programmeX> and the like
                }
                var end = buf.indexOf(close, at);
                if (end < 0) {
                    // A channel can be self-closing; anything else waits for the rest of the element.
                    var gt = buf.indexOf('>', at);
                    if (isCh && gt > 0 && buf.charCodeAt(gt - 1) === 47) { channel(buf.slice(at, gt + 1)); pos = gt + 1; continue; }
                    pos = at; break;
                }
                var el = buf.slice(at, end);
                if (isCh) channel(el); else programme(el);
                pos = end + close.length;
            }
            buf = buf.slice(pos);
        }
        /* Programmes of each channel, sorted, packed as one JSON string per channel: cheap to store, copy between
         * threads and load, and only the channels on screen are ever unpacked. */
        function finish() {
            push('');
            var packed = {};
            Object.keys(progs).forEach(function (k) {
                var l = progs[k].sort(function (x, y) { return x.start - y.start; });
                packed[k] = JSON.stringify(l);
            });
            buf = ''; progs = null;
            return { packed: packed, names: names, icons: icons, count: count };
        }
        return { push: push, finish: finish };
    }

    /* The whole guide from bytes (ArrayBuffer, gzip or not) or text. Resolves with { packed, names, icons, count }. */
    function parseXMLTV(src, wantedIDs, wantedNames, from, to) {
        var sc = XMLTVScanner(wantedIDs, wantedNames, from, to);
        if (typeof src === 'string') { sc.push(src); return Promise.resolve(sc.finish()); }
        var b = new Uint8Array(src);
        var gz = b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
        // In the page (no worker) the scan pauses between pieces so the screen keeps answering the remote.
        var inPage = typeof window !== 'undefined', CHUNK = inPage ? 1 << 20 : 4 << 20;
        function feed(dec) {
            return new Promise(function (ok, fail) {
                var i = 0;
                (function step() {
                    try {
                        do {
                            var end = Math.min(b.length, i + CHUNK);
                            sc.push(dec.decode(b.subarray(i, end), { stream: true }));
                            i = end;
                        } while (!inPage && i < b.length);
                        if (i >= b.length) { sc.push(dec.decode()); return ok(); }
                        setTimeout(step, 0);
                    } catch (e) { fail(e); }
                })();
            });
        }
        if (!gz) {
            return feed(new TextDecoder('utf-8', { fatal: true })).then(null, function () {
                sc = XMLTVScanner(wantedIDs, wantedNames, from, to);
                return feed(new TextDecoder('iso-8859-1'));
            }).then(function () { return sc.finish(); });
        }
        if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') return Promise.reject(new Error('This TV cannot unpack .gz guides; use an uncompressed XMLTV address.'));
        var reader = new Response(src).body.pipeThrough(new DecompressionStream('gzip')).getReader();
        var dec = new TextDecoder('utf-8');
        function pump() {
            return reader.read().then(function (r) {
                if (r.done) { sc.push(dec.decode()); return sc.finish(); }
                sc.push(dec.decode(r.value, { stream: true }));
                return pump();
            });
        }
        return pump();
    }

    /* ---------- fetching and saving (the same in the page and in the worker) ---------- */

    function httpError(status) {
        return new Error(status === 401 || status === 403 ? 'The username or password was refused.' : 'The server answered ' + status + '.');
    }

    /* src: { url, ua } to download, { buf } already downloaded, or { error } that failed in the page. */
    function get(src) {
        if (src.buf) return Promise.resolve(src.buf);
        if (src.error) return Promise.reject(new Error(src.error));
        return new Promise(function (ok, fail) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', src.url);
            xhr.timeout = 90000;
            xhr.responseType = 'arraybuffer';
            // Browsers don't let pages set User-Agent; the TV's runtime does.
            if (src.ua) { try { xhr.setRequestHeader('User-Agent', src.ua); } catch (e) {} }
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300 || (xhr.status === 0 && xhr.response)) ok(xhr.response);
                else fail(httpError(xhr.status));
            };
            xhr.onerror = function () { var e = new Error('Could not reach ' + src.url.split('/')[2] + '.'); e.net = true; fail(e); };
            xhr.ontimeout = function () { fail(new Error('The server took too long to answer.')); };
            xhr.send();
        });
    }

    function bytesToText(buf) {
        var b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
        if (b.length > 1 && b[0] === 0x1f && b[1] === 0x8b) {
            if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') return Promise.reject(new Error('This TV cannot unpack .gz files; use an uncompressed address.'));
            return new Response(new Response(buf).body.pipeThrough(new DecompressionStream('gzip'))).text();
        }
        return Promise.resolve(text(buf));
    }

    var dbp = null;
    function db() {
        if (dbp) return dbp;
        dbp = new Promise(function (ok, fail) {
            if (typeof indexedDB === 'undefined' || !indexedDB) return fail(new Error('no indexedDB'));
            var r = indexedDB.open('lumen-iptv', 1);
            r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
            r.onsuccess = function () { ok(r.result); };
            r.onerror = function () { fail(r.error); };
        });
        return dbp;
    }
    /* Writes [key, value] pairs in one go, after removing every key that starts with `clear`. */
    function save(entries, clear) {
        return db().then(function (d) {
            return new Promise(function (ok) {
                var t = d.transaction('kv', 'readwrite'), st = t.objectStore('kv');
                if (clear) st.delete(IDBKeyRange.bound(clear, clear + '￿'));
                entries.forEach(function (e) { st.put(e[1], e[0]); });
                t.oncomplete = function () { ok(true); };
                t.onerror = t.onabort = function () { ok(false); };
            });
        }).catch(function () { return false; });
    }

    /* Content goes to storage and between threads in slices of 5000, so no single copy blocks the page for long. */
    var PART = 5000;
    function split(c) {
        var meta = { split: {} }, parts = [];
        Object.keys(c).forEach(function (k) {
            var v = c[k];
            if (Array.isArray(v) && v.length > PART) {
                meta.split[k] = Math.ceil(v.length / PART);
                for (var i = 0; i < v.length; i += PART) parts.push([k + ':' + (i / PART), v.slice(i, i + PART)]);
            } else meta[k] = v;
        });
        return { meta: meta, parts: parts };
    }
    /* parts: { channels: [slice, slice, ...], ... } in order. */
    function join(meta, parts) {
        if (!meta || !meta.split) return meta;
        var c = {};
        Object.keys(meta).forEach(function (k) { if (k !== 'split') c[k] = meta[k]; });
        Object.keys(meta.split).forEach(function (k) { c[k] = [].concat.apply([], parts[k] || []); });
        return c;
    }
    function saveContent(id, c) {
        var sp = split(c), key = 'content:' + id;
        return save([[key, sp.meta]].concat(sp.parts.map(function (p) { return [key + ':' + p[0], p[1]]; })), key + ':');
    }

    /* ---------- jobs ---------- */

    /* A whole refresh: download (unless the page did), parse, save. The worker runs these; the page runs the
     * same ones itself when there is no worker. In the worker a network failure stops the job, so the page can
     * retry the download itself (the TV may only allow its own requests to other hosts). */
    function job(op, d) {
        var inWorker = typeof window === 'undefined', errors = [];
        function fetch(src) {
            return get(src).then(null, function (e) {
                if (e.net && inWorker) { var n = new Error(e.message); n.net = true; throw n; }
                if (op === 'm3u') throw e;
                if (op === 'guide') errors.push(e.message);
                return null;
            });
        }
        if (op === 'guide') return guideJob(d, fetch, errors);
        return Promise.all(d.sources.map(fetch)).then(function (bufs) {
            if (op === 'm3u') {
                return bytesToText(bufs[0]).then(function (t) {
                    if (t.indexOf('#EXTINF') < 0 && t.indexOf('#EXTM3U') < 0) throw new Error('This address didn\'t return an M3U playlist.');
                    var c = parseM3U(t, d.pl);
                    return saveContent(d.pl.id, c).then(function () { return c; });
                });
            }
            if (op === 'xtream') {
                var c = xtreamContent(d.pl, d.content, bufs.map(function (b) { return b || ''; }));
                return saveContent(d.pl.id, c).then(function () { return c; });
            }
            throw new Error('unknown job ' + op);
        });
    }

    /* Guides one after another (each can be 100 MB), first one wins for a channel. */
    function guideJob(d, fetch, errors) {
        var names = {}, merged = { packed: {}, names: {}, icons: {}, count: 0, errors: errors };
        d.chNames.forEach(function (n) { names[key(n)] = 1; });
        var chain = Promise.resolve();
        d.sources.forEach(function (src) {
            chain = chain.then(function () { return fetch(src); }).then(function (b) {
                if (!b) return;
                return parseXMLTV(b, d.ids, names, d.from, d.to).then(function (g) {
                    Object.keys(g.packed).forEach(function (k) { if (!merged.packed[k]) { merged.packed[k] = g.packed[k]; merged.count++; } });
                    Object.keys(g.names).forEach(function (k) { if (!merged.names[k]) merged.names[k] = g.names[k]; });
                    Object.keys(g.icons).forEach(function (k) { if (!merged.icons[k]) merged.icons[k] = g.icons[k]; });
                }, function (e) { errors.push(e.message || String(e)); });
            });
        });
        return chain.then(function () {
            if (!merged.count) return merged;
            merged.updated = Date.now();
            // Saved in slices of 500 channels, so reading it back is many short steps instead of one long one.
            var entries = [], slice = null, n = 0;
            Object.keys(merged.packed).forEach(function (k, i) {
                if (i % 500 === 0) { slice = {}; entries.push(['guide:' + n++, slice]); }
                slice[k] = merged.packed[k];
            });
            entries.unshift(['guide', { names: merged.names, icons: merged.icons, updated: merged.updated, parts: n }]);
            return save(entries, 'guide:').then(function () { return merged; });
        });
    }

    return {
        str: str, int: int, num: num, bool: bool, dateOf: dateOf, yearOf: yearOf, hash: hash, key: key, text: text,
        splitYear: splitYear, episodeInfo: episodeInfo, emptyContent: emptyContent, parseM3U: parseM3U,
        xtreamBase: xtreamBase, xtreamContent: xtreamContent, xmltvDate: xmltvDate, decode: decode, parseXMLTV: parseXMLTV,
        XMLTVScanner: XMLTVScanner, get: get, job: job, split: split, join: join, save: save, saveContent: saveContent
    };
})();
