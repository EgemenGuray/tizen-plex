/* IPTV: M3U playlists and Xtream Codes logins, XMLTV guide, catch-up, quality tags, favourites, recents,
 * hidden and PIN-locked groups, renamed channels, reminders and resume points. Same model as Lumen on Apple TV.
 * Big data (channels, films, guide) is cached in IndexedDB; small settings in localStorage. ES5 only. */
var IPTV = (function () {
    'use strict';

    /* ---------- storage ---------- */

    var DB = (function () {
        var dbp = null;
        function open() {
            if (dbp) return dbp;
            dbp = new Promise(function (ok, fail) {
                if (!window.indexedDB) return fail(new Error('no indexedDB'));
                var r = indexedDB.open('lumen-iptv', 1);
                r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
                r.onsuccess = function () { ok(r.result); };
                r.onerror = function () { fail(r.error); };
            });
            return dbp;
        }
        function get(k) {
            return open().then(function (db) {
                return new Promise(function (ok) {
                    var q = db.transaction('kv').objectStore('kv').get(k);
                    q.onsuccess = function () { ok(q.result); };
                    q.onerror = function () { ok(null); };
                });
            }, function () { return null; });
        }
        function set(k, v) {
            return open().then(function (db) {
                return new Promise(function (ok) {
                    var t = db.transaction('kv', 'readwrite');
                    if (v === null) t.objectStore('kv').delete(k); else t.objectStore('kv').put(v, k);
                    t.oncomplete = function () { ok(); };
                    t.onerror = function () { ok(); };
                });
            }, function () {});
        }
        return { get: get, set: set };
    })();

    function pref(k, v) { return Util.store('iptv.' + k, v); }

    /* ---------- HTTP ---------- */

    function request(url, opts) {
        opts = opts || {};
        return new Promise(function (ok, fail) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url);
            xhr.timeout = opts.timeout || 90000;
            if (opts.binary) xhr.responseType = 'arraybuffer';
            // Browsers don't let pages set User-Agent; the TV's runtime does.
            if (opts.userAgent) { try { xhr.setRequestHeader('User-Agent', opts.userAgent); } catch (e) {} }
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300 || (xhr.status === 0 && xhr.response)) ok(xhr.response);
                else fail(new Error(xhr.status === 401 || xhr.status === 403 ? 'The username or password was refused.' : 'The server answered ' + xhr.status + '.'));
            };
            xhr.onerror = function () { fail(new Error('Could not reach ' + url.split('/')[2] + '.')); };
            xhr.ontimeout = function () { fail(new Error('The server took too long to answer.')); };
            xhr.send();
        });
    }

    function getText(url, ua) {
        return request(url, { binary: true, userAgent: ua }).then(function (buf) { return decodeBody(buf); });
    }

    /* gzip guides (.xml.gz) through DecompressionStream where the runtime has it. */
    function decodeBody(buf) {
        var b = new Uint8Array(buf);
        if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
            if (!window.DecompressionStream || !window.Response) return Promise.reject(new Error('This TV cannot unpack .gz guides; use an uncompressed XMLTV address.'));
            var stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
            return new Response(stream).text();
        }
        var text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { text = new TextDecoder('iso-8859-1').decode(b); }
        return Promise.resolve(text);
    }

    /* ---------- helpers ---------- */

    function str(v) { return v === null || v === undefined || v === '' ? null : String(v); }
    function int(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
    function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
    function bool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
    function dateOf(v) { var n = int(v); return n && n > 0 ? n * 1000 : null; }
    function yearOf(v) { var s = str(v); if (!s) return null; var y = parseInt(s.slice(0, 4), 10); return y > 1880 ? y : null; }
    function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }

    /* Name key for matching against the guide: lower case, letters and digits only, no quality tags. */
    function key(name) {
        var s = (' ' + String(name || '').toLowerCase() + ' ');
        [' hd', ' fhd', ' uhd', ' 4k', ' sd', ' hevc', '(hd)', '[hd]'].forEach(function (t) { s = s.split(t).join(''); });
        return s.replace(/[^a-z0-9À-ɏЀ-ӿ]/g, '');
    }

    function splitYear(name) {
        var m = /^(.*?)[\s\-]*[\(\[]?((?:19|20)\d{2})[\)\]]?\s*$/.exec(name);
        if (!m || !m[1].trim()) return { title: name, year: null };
        return { title: m[1].trim(), year: parseInt(m[2], 10) };
    }

    function episodeInfo(name) {
        var res = [/^(.*?)[\s._\-]*[Ss](\d{1,2})[\s._\-]*[Ee](\d{1,3})(.*)$/, /^(.*?)[\s._\-]+(\d{1,2})x(\d{1,3})(.*)$/];
        for (var i = 0; i < res.length; i++) {
            var m = res[i].exec(name);
            if (!m) continue;
            var show = m[1].replace(/\./g, ' ').replace(/^[\s\-_|]+|[\s\-_|]+$/g, '');
            if (!show) continue;
            var rest = m[4].replace(/\./g, ' ').replace(/^[\s\-_|]+|[\s\-_|]+$/g, '');
            return { show: show, season: parseInt(m[2], 10), episode: parseInt(m[3], 10), title: rest || 'Episode ' + parseInt(m[3], 10) };
        }
        return null;
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
            if (s[i] === '"') q = !q;
            else if (s[i] === ',' && !q) return [s.slice(0, i), s.slice(i + 1)];
        }
        return [s, ''];
    }

    function classify(url, name, type) {
        if (type === 'movie' || type === 'movies' || type === 'vod') return 'movie';
        if (type === 'series' || type === 'tvshow') return 'series';
        if (type === 'live' || type === 'stream') return 'live';
        var lower = url.toLowerCase();
        if (lower.indexOf('/series/') >= 0) return 'series';
        if (lower.indexOf('/movie/') >= 0 || lower.indexOf('/movies/') >= 0) return 'movie';
        var ext = (lower.split('?')[0].match(/\.([a-z0-9]+)$/) || [])[1];
        if (['mp4', 'mkv', 'avi', 'mov', 'm4v', 'wmv', 'webm'].indexOf(ext) >= 0) return episodeInfo(name) ? 'series' : 'movie';
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
            if (line.indexOf('#EXTM3U') === 0) {
                var h = attrs(line.slice(7));
                ['url-tvg', 'x-tvg-url', 'tvg-url'].forEach(function (k) {
                    if (h[k]) h[k].split(',').forEach(function (u) { if (u.trim()) c.epgURLs.push(u.trim()); });
                });
                if (h.catchup || h['catchup-type']) header = { mode: h.catchup || h['catchup-type'], days: int(h['catchup-days']) || 7, source: h['catchup-source'] || null };
                continue;
            }
            if (line.indexOf('#EXTINF') === 0) {
                var parts = splitInfo(line.slice(line.indexOf(':') + 1));
                info = { a: attrs(parts[0]), name: parts[1].trim() };
                continue;
            }
            if (line.indexOf('#EXTGRP:') === 0) { grp = line.slice(8).trim(); continue; }
            if (line.indexOf('#EXTVLCOPT:') === 0) {
                var opt = line.slice(11);
                if (/^http-user-agent=/i.test(opt)) ua = opt.slice(16);
                continue;
            }
            if (line[0] === '#') continue;
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

    function emptyContent() {
        return { channels: [], movies: [], series: [], liveGroups: [], movieGroups: [], seriesGroups: [], epgURLs: [], serverTimeZone: null, account: null };
    }

    /* ---------- Xtream Codes ---------- */

    function xtreamBase(raw) {
        var s = String(raw || '').trim();
        if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
        s = s.split('?')[0];
        ['/player_api.php', '/get.php', '/xmltv.php', '/'].forEach(function (x) { if (s.slice(-x.length) === x) s = s.slice(0, -x.length); });
        return s.replace(/\/+$/, '');
    }

    function Xtream(pl) {
        var base = xtreamBase(pl.url), u = encodeURIComponent(pl.username), p = encodeURIComponent(pl.password);
        var api = function (action, extra) {
            var q = { username: pl.username, password: pl.password };
            if (action) q.action = action;
            for (var k in (extra || {})) q[k] = extra[k];
            return request(base + '/player_api.php?' + Util.qs(q), { userAgent: pl.userAgent }).then(function (t) {
                if (typeof t !== 'string') t = new TextDecoder().decode(new Uint8Array(t));
                try { return t ? JSON.parse(t) : []; } catch (e) { throw new Error('This doesn\'t look like an Xtream Codes server.'); }
            });
        };
        function list(v) {
            if (Array.isArray(v)) return v;
            if (v && typeof v === 'object') return Object.keys(v).map(function (k) { return v[k]; });
            return [];
        }
        return {
            base: base,
            epg: base + '/xmltv.php?' + Util.qs({ username: pl.username, password: pl.password }),
            live: function (id, ext) { return base + '/live/' + u + '/' + p + '/' + id + '.' + ext; },
            movie: function (id, ext) { return base + '/movie/' + u + '/' + p + '/' + id + '.' + ext; },
            episode: function (id, ext) { return base + '/series/' + u + '/' + p + '/' + id + '.' + ext; },
            timeshift: function (id, startMs, minutes, tz) {
                return base + '/timeshift/' + u + '/' + p + '/' + minutes + '/' + tsDate(startMs, tz) + '/' + id + '.ts';
            },
            load: function () {
                var self = this, c = emptyContent(), pid = pl.id;
                return api(null).then(function (root) {
                    var user = root && root.user_info;
                    if (!user) throw new Error('This doesn\'t look like an Xtream Codes server.');
                    if (int(user.auth) === 0) throw new Error('The username or password was refused.');
                    c.account = { status: str(user.status), expires: dateOf(user.exp_date), maxConnections: int(user.max_connections), activeConnections: int(user.active_cons), trial: bool(user.is_trial) };
                    c.serverTimeZone = root.server_info && str(root.server_info.timezone);
                    c.epgURLs = [self.epg];
                    return Promise.all(['get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series']
                        .map(function (a) { return api(a).catch(function () { return []; }); }));
                }).then(function (r) {
                    function cats(v) { var m = {}, order = []; list(v).forEach(function (x) { var id = str(x.category_id), n = str(x.category_name); if (id && n) { m[id] = n; order.push(n); } }); return { map: m, order: order }; }
                    var lc = cats(r[0]), vc = cats(r[2]), sc = cats(r[4]);
                    var used = {};
                    list(r[1]).forEach(function (s) {
                        var id = int(s.stream_id); if (id === null) return;
                        var g = lc.map[str(s.category_id)] || 'Other';
                        used[g] = 1;
                        var days = int(s.tv_archive_duration) || 0;
                        c.channels.push({
                            id: pid + '|' + id, playlistID: pid, name: str(s.name) || 'Channel ' + id, number: int(s.num), logo: str(s.stream_icon),
                            group: g, url: self.live(id, 'ts'), epgID: str(s.epg_channel_id),
                            catchup: bool(s.tv_archive) && days > 0 ? { mode: 'xc', days: days, source: null } : null,
                            userAgent: pl.userAgent || null, streamID: id
                        });
                    });
                    c.liveGroups = lc.order.concat(['Other']).filter(function (g, i, a) { return used[g] && a.indexOf(g) === i; });
                    used = {};
                    list(r[3]).forEach(function (s) {
                        var id = int(s.stream_id); if (id === null) return;
                        var g = vc.map[str(s.category_id)] || 'Other';
                        used[g] = 1;
                        var ty = splitYear(str(s.name) || 'Film ' + id);
                        c.movies.push({
                            id: pid + '|m|' + id, playlistID: pid, name: ty.title, poster: str(s.stream_icon), group: g,
                            url: self.movie(id, str(s.container_extension) || 'mp4'), rating: num(s.rating) || null,
                            year: ty.year || yearOf(s.year) || yearOf(s.releasedate), added: dateOf(s.added), streamID: id
                        });
                    });
                    c.movieGroups = vc.order.concat(['Other']).filter(function (g, i, a) { return used[g] && a.indexOf(g) === i; });
                    used = {};
                    list(r[5]).forEach(function (s) {
                        var id = int(s.series_id); if (id === null) return;
                        var g = sc.map[str(s.category_id)] || 'Other';
                        used[g] = 1;
                        c.series.push({
                            id: pid + '|s|' + id, playlistID: pid, name: str(s.name) || 'Series ' + id, poster: str(s.cover), group: g,
                            plot: str(s.plot), rating: num(s.rating) || null, year: yearOf(s.releaseDate) || yearOf(s.release_date), genre: str(s.genre), seriesID: id
                        });
                    });
                    c.seriesGroups = sc.order.concat(['Other']).filter(function (g, i, a) { return used[g] && a.indexOf(g) === i; });
                    return c;
                });
            },
            details: function (kind, id) {
                return api(kind === 'movie' ? 'get_vod_info' : 'get_series_info', kind === 'movie' ? { vod_id: id } : { series_id: id }).then(function (root) {
                    var info = (root && root.info) || {};
                    var d = {
                        plot: str(info.plot) || str(info.description), cast: str(info.cast) || str(info.actors), director: str(info.director),
                        genre: str(info.genre), released: str(info.releasedate || info.releaseDate || info.release_date),
                        duration: num(info.duration_secs) || (num(info.episode_run_time) ? num(info.episode_run_time) * 60 : null),
                        rating: num(info.rating) || null,
                        backdrop: Array.isArray(info.backdrop_path) ? str(info.backdrop_path[0]) : str(info.backdrop_path),
                        poster: str(info.movie_image) || str(info.cover_big) || str(info.cover), episodes: []
                    };
                    if (kind !== 'movie' && root) {
                        var eps = [], src = root.episodes;
                        if (Array.isArray(src)) src.forEach(function (x) { eps = eps.concat(Array.isArray(x) ? x : [x]); });
                        else if (src) Object.keys(src).forEach(function (k) { eps = eps.concat(src[k] || []); });
                        d.episodes = eps.map(function (e) {
                            var ei = e.info || {};
                            return {
                                id: 'x|' + id + '|' + e.id, season: int(e.season) || 1, number: int(e.episode_num) || 0, title: str(e.title) || 'Episode',
                                url: base + '/series/' + u + '/' + p + '/' + e.id + '.' + (str(e.container_extension) || 'mp4'), plot: str(ei.plot),
                                thumb: str(ei.movie_image) || str(ei.cover_big), duration: num(ei.duration_secs)
                            };
                        }).sort(function (x, y) { return x.season - y.season || x.number - y.number; });
                    }
                    return d;
                });
            }
        };
    }

    /* "YYYY-MM-DD:HH-MM" in the server's time zone (Intl where available, else UTC). */
    function tsDate(ms, tz) {
        var d = new Date(ms), parts = null;
        try {
            if (tz && window.Intl) {
                parts = {};
                new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                    .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
            }
        } catch (e) { parts = null; }
        function two(n) { return (n < 10 ? '0' : '') + n; }
        if (!parts) parts = { year: d.getUTCFullYear(), month: two(d.getUTCMonth() + 1), day: two(d.getUTCDate()), hour: two(d.getUTCHours()), minute: two(d.getUTCMinutes()) };
        return parts.year + '-' + parts.month + '-' + parts.day + ':' + (parts.hour === '24' ? '00' : parts.hour) + '-' + parts.minute;
    }

    /* ---------- XMLTV ---------- */

    function xmltvDate(s) {
        var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+\-]\d{4})?/.exec(String(s || '').trim());
        if (!m) return null;
        var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (m[7]) { var sign = m[7][0] === '-' ? -1 : 1; t -= sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10)) * 60000; }
        return t;
    }

    /* Regex scan rather than DOMParser: guides are tens of MB and the TV has little memory to spare. */
    function parseXMLTV(text, wantedIDs, wantedNames, from, to) {
        var progs = {}, names = {}, kept = {};
        var chRe = /<channel\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g, m;
        while ((m = chRe.exec(text))) {
            var id = decode(m[1]).toLowerCase();
            var dn = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g, d, keep = !!wantedIDs[id];
            while ((d = dn.exec(m[2]))) {
                var k = key(decode(d[1]));
                if (wantedNames[k]) keep = true;
                if (!names[k]) names[k] = id;
            }
            if (keep) kept[id] = 1;
        }
        var pRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
        while ((m = pRe.exec(text))) {
            var a = m[1];
            var ch = (/channel="([^"]*)"/.exec(a) || [])[1];
            if (!ch) continue;
            ch = decode(ch).toLowerCase();
            if (!kept[ch] && !wantedIDs[ch]) continue;
            var start = xmltvDate((/start="([^"]*)"/.exec(a) || [])[1]);
            var stop = xmltvDate((/stop="([^"]*)"/.exec(a) || [])[1]) || (start + 3600000);
            if (!start || stop <= from || start >= to) continue;
            var body = m[2];
            var p = { channel: ch, start: start, end: stop, title: tag(body, 'title') || '' };
            var sub = tag(body, 'sub-title'), desc = tag(body, 'desc'), cat = tag(body, 'category');
            var en = /<episode-num[^>]*system="xmltv_ns"[^>]*>([^<]*)</.exec(body);
            if (en) {
                var parts = en[1].split('.');
                var sn = parseInt(parts[0], 10), ep = parseInt(parts[1], 10);
                if (!isNaN(sn) && !isNaN(ep)) sub = 'S' + (sn + 1) + ' E' + (ep + 1) + (sub ? ' · ' + sub : '');
            }
            if (sub) p.episode = sub;
            if (desc) p.desc = desc;
            if (cat) p.category = cat;
            (progs[ch] = progs[ch] || []).push(p);
        }
        Object.keys(progs).forEach(function (k) { progs[k].sort(function (x, y) { return x.start - y.start; }); });
        return { programmes: progs, names: names };
    }

    function tag(body, name) {
        var m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>').exec(body);
        return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : null;
    }

    function decode(s) {
        return String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, function (all, e) {
            var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
            if (map[e.toLowerCase()]) return map[e.toLowerCase()];
            if (e[1] === 'x' || e[1] === 'X') return String.fromCharCode(parseInt(e.slice(2), 16));
            return String.fromCharCode(parseInt(e.slice(1), 10));
        });
    }

    /* ---------- catch-up ---------- */

    function fill(tpl, start, end, now) {
        var s = Math.floor(start / 1000), e = Math.floor(end / 1000), n = Math.floor(now / 1000);
        var d = new Date(start);
        function two(x) { return (x < 10 ? '0' : '') + x; }
        var v = {
            utc: s, start: s, timestamp: n, utcend: e, end: e, lutc: n, now: n, duration: e - s, offset: n - s,
            Y: d.getUTCFullYear(), m: two(d.getUTCMonth() + 1), d: two(d.getUTCDate()), H: two(d.getUTCHours()), M: two(d.getUTCMinutes()), S: two(d.getUTCSeconds())
        };
        var out = String(tpl).replace(/\$?\{(duration|offset):(\d+)\}/g, function (all, k, div) {
            return String(Math.floor((k === 'duration' ? e - s : n - s) / parseInt(div, 10)));
        });
        return out.replace(/\$?\{(\w+)\}/g, function (all, k) { return v[k] !== undefined ? String(v[k]) : all; });
    }

    function catchupURL(ch, p) {
        var c = ch.catchup;
        if (!c) return null;
        var now = Date.now(), end = Math.min(p.end, now), mode = String(c.mode).toLowerCase();
        var pl = playlist(ch.playlistID), content = contents[ch.playlistID] || {};
        var sep = ch.url.indexOf('?') >= 0 ? '&' : '?';
        if (mode === 'xc' || mode === 'xtream') {
            var minutes = Math.max(1, Math.ceil((p.end - p.start) / 60000));
            if (pl && pl.kind === 'xtream' && ch.streamID != null) return Xtream(pl).timeshift(ch.streamID, p.start, minutes, content.serverTimeZone);
            var m = /^(https?:\/\/[^\/]+)\/(?:live\/)?([^\/]+)\/([^\/]+)\/(\d+)(\.\w+)?$/.exec(ch.url.split('?')[0]);
            if (!m) return null;
            return m[1] + '/timeshift/' + m[2] + '/' + m[3] + '/' + minutes + '/' + tsDate(p.start, content.serverTimeZone) + '/' + m[4] + '.ts';
        }
        if (mode === 'append') return c.source ? ch.url + fill(c.source, p.start, end, now) : null;
        if (mode === 'shift' || mode === 'timeshift') return ch.url + sep + 'utc=' + Math.floor(p.start / 1000) + '&lutc=' + Math.floor(now / 1000);
        if (mode.indexOf('flussonic') === 0 || mode === 'fs') {
            var st = Math.floor(p.start / 1000), du = Math.floor((end - p.start) / 1000);
            if (/\/(index|video|mono)[^\/]*\.m3u8/.test(ch.url)) return ch.url.replace(/\/(index|video|mono)[^\/]*\.m3u8/, '/index-' + st + '-' + du + '.m3u8');
            if (/\/mpegts(\?|$)/.test(ch.url)) return ch.url.replace(/\/mpegts(\?|$)/, '/timeshift_abs-' + st + '.ts$1');
            return null;
        }
        if (c.source) {
            var f = fill(c.source, p.start, end, now);
            return /^https?:/i.test(f) ? f : ch.url + f;
        }
        return ch.url + sep + 'utc=' + Math.floor(p.start / 1000) + '&lutc=' + Math.floor(now / 1000);
    }

    function canCatchUp(ch, p) {
        return !!(ch.catchup && ch.catchup.days > 0 && p.start < Date.now() && p.start > Date.now() - ch.catchup.days * 86400000);
    }

    /* ---------- quality ---------- */

    var TAGS = ['4K', 'FHD', 'HD', 'SD', 'HDR', '5.1', 'Stereo', 'HEVC'];
    var VIDEO_TAGS = { '4K': 1, FHD: 1, HD: 1, SD: 1 };

    function parseTags(text) {
        var up = ' ' + String(text).toUpperCase().replace(/[|\[\]():\-_]/g, ' ') + ' ';
        function has(ws) { return ws.some(function (w) { return up.indexOf(' ' + w + ' ') >= 0; }); }
        var t = [];
        if (has(['4K', 'UHD', '2160P', '2160', '8K'])) t.push('4K');
        else if (has(['FHD', '1080P', '1080', '1080I', 'FULLHD', 'FULL HD'])) t.push('FHD');
        else if (has(['HD', '720P', '720', 'HD+'])) t.push('HD');
        else if (has(['SD', '576P', '480P', 'LQ'])) t.push('SD');
        if (has(['HDR', 'HDR10', 'HLG', 'DV', 'DOLBY VISION'])) t.push('HDR');
        if (has(['5.1', '7.1', 'DD5.1', 'DD+', 'AC3', 'EAC3', 'ATMOS', 'DOLBY', 'SURROUND'])) t.push('5.1');
        if (has(['STEREO', '2.0'])) t.push('Stereo');
        if (has(['HEVC', 'H265', 'H.265', 'X265'])) t.push('HEVC');
        return t;
    }

    function measuredTags(m) {
        var t = [];
        if (m.height >= 1700) t.push('4K'); else if (m.height >= 1000) t.push('FHD'); else if (m.height >= 700) t.push('HD'); else if (m.height > 0) t.push('SD');
        if (m.hdr) t.push('HDR');
        if (m.channels) t.push(m.channels > 2 ? '5.1' : 'Stereo');
        return t;
    }

    var tagCache = {};
    function tags(ch) {
        var t = tagCache[ch.id] || (tagCache[ch.id] = parseTags(ch.name + ' ' + ch.group));
        var m = state.measured[ch.id];
        if (!m) return t;
        var mt = measuredTags(m);
        var out = t.filter(function (x) {
            if (VIDEO_TAGS[x] && mt.some(function (y) { return VIDEO_TAGS[y]; })) return false;
            if ((x === '5.1' || x === 'Stereo') && (mt.indexOf('5.1') >= 0 || mt.indexOf('Stereo') >= 0)) return false;
            return true;
        });
        mt.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
        return out;
    }

    function recordMeasured(ch, height, channels, hdr) {
        if (!height) return;
        state.measured[ch.id] = { height: height, channels: channels || (state.measured[ch.id] || {}).channels || null, hdr: !!hdr };
        pref('measured', state.measured);
    }

    /* ---------- state ---------- */

    var playlists = pref('playlists') || [];
    var contents = {};
    var guide = { programmes: {}, names: {}, updated: null };
    var keyCache = {};
    var loading = {}, errors = {}, guideLoading = false;
    var listeners = [];
    var state = {
        favorites: pref('favorites') || [], recents: pref('recents') || [], hidden: pref('hidden') || [], locked: pref('locked') || [],
        renames: pref('renames') || {}, reminders: pref('reminders') || [], pin: pref('pin') || '', unlocked: false,
        positions: pref('positions') || {}, measured: pref('measured') || {}, resume: pref('resume') || [], plays: pref('plays') || {}
    };
    var visible = { channels: [], movies: [], series: [], byID: {} };

    // Playlists predefined in js/iptvconfig.js (not committed), so they don't have to be typed with the remote.
    if (window.LUMEN_IPTV && !playlists.length) {
        playlists = window.LUMEN_IPTV.map(function (p, i) {
            return { id: Util.uuid(), name: p.name || 'Playlist', kind: p.kind || (p.username ? 'xtream' : 'm3u'), url: p.url, username: p.username || '',
                password: p.password || '', epgURL: p.epgURL || '', userAgent: p.userAgent || '', colorIndex: i, enabled: true, lastRefresh: null };
        });
        pref('playlists', playlists);
    }

    var COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2', '#40c8e0', '#ffd60a', '#ff453a'];
    function color(pl) { return COLORS[((pl && pl.colorIndex) || 0) % COLORS.length]; }

    function onChange(fn) { listeners.push(fn); }
    function changed(what) { listeners.forEach(function (fn) { try { fn(what); } catch (e) {} }); }

    function playlist(id) { return playlists.filter(function (p) { return p.id === id; })[0] || null; }

    function groupKey(pid, kind, name) { return pid + '|' + kind + '|' + name; }

    function rebuild() {
        var ch = [], mv = [], se = [], byID = {};
        playlists.forEach(function (p) {
            var c = contents[p.id];
            if (!p.enabled || !c) return;
            function ok(kind, g) { var k = groupKey(p.id, kind, g); return state.hidden.indexOf(k) < 0 && (state.unlocked || state.locked.indexOf(k) < 0); }
            c.channels.forEach(function (x) {
                if (!ok('live', x.group)) return;
                var y = x;
                if (state.renames[x.id] || (!x.userAgent && p.userAgent)) {
                    y = {}; for (var k in x) y[k] = x[k];
                    if (state.renames[x.id]) y.name = state.renames[x.id];
                    if (!y.userAgent && p.userAgent) y.userAgent = p.userAgent;
                }
                ch.push(y); byID[y.id] = y;
            });
            c.movies.forEach(function (x) { if (ok('movie', x.group)) mv.push(x); });
            c.series.forEach(function (x) { if (ok('series', x.group)) se.push(x); });
        });
        visible = { channels: ch, movies: mv, series: se, byID: byID };
        keyCache = {};
        tagCache = {};
        changed('content');
    }

    function init() {
        return Promise.all(playlists.map(function (p) {
            return DB.get('content:' + p.id).then(function (c) { if (c) contents[p.id] = c; });
        })).then(function () {
            return DB.get('guide').then(function (g) { if (g) guide = g; });
        }).then(function () {
            rebuild();
            refreshIfStale();
            setInterval(checkReminders, 20000);
        });
    }

    function refreshIfStale() {
        var p = Promise.resolve();
        playlists.forEach(function (pl) {
            if (pl.enabled && (!contents[pl.id] || !pl.lastRefresh || Date.now() - pl.lastRefresh > 12 * 3600000)) p = p.then(function () { return refresh(pl.id, true); });
        });
        return p.then(function () {
            if (!guide.updated || Date.now() - guide.updated > 6 * 3600000 || !Object.keys(guide.programmes).length) return refreshGuide();
        });
    }

    function refresh(id, skipGuide) {
        var pl = playlist(id);
        if (!pl || loading[id]) return Promise.resolve();
        loading[id] = true; delete errors[id]; changed('loading');
        var job = pl.kind === 'xtream' ? Xtream(pl).load() : getText(pl.url.trim(), pl.userAgent).then(function (text) {
            if (text.indexOf('#EXTINF') < 0 && text.indexOf('#EXTM3U') < 0) throw new Error('This address didn\'t return an M3U playlist.');
            return parseM3U(text, pl);
        });
        return job.then(function (c) {
            contents[id] = c;
            DB.set('content:' + id, c);
            pl.lastRefresh = Date.now();
            pref('playlists', playlists);
            delete loading[id];
            rebuild();
            if (!skipGuide) return refreshGuide();
        }).catch(function (e) {
            delete loading[id];
            errors[id] = e.message || String(e);
            changed('loading');
        });
    }

    function refreshAll() {
        var p = Promise.resolve();
        playlists.forEach(function (pl) { if (pl.enabled) p = p.then(function () { return refresh(pl.id, true); }); });
        return p.then(refreshGuide);
    }

    function refreshGuide() {
        if (guideLoading) return Promise.resolve();
        var urls = [];
        playlists.forEach(function (p) {
            if (!p.enabled) return;
            ((contents[p.id] || {}).epgURLs || []).concat(String(p.epgURL || '').split(',')).forEach(function (u) {
                u = u.trim();
                if (u && !urls.some(function (x) { return x.u === u; })) urls.push({ u: u, ua: p.userAgent });
            });
        });
        if (!urls.length) return Promise.resolve();
        guideLoading = true; changed('guide');
        var all = [];
        Object.keys(contents).forEach(function (k) { all = all.concat(contents[k].channels); });
        var ids = {}, names = {}, maxDays = 1;
        all.forEach(function (c) { if (c.epgID) ids[c.epgID.toLowerCase()] = 1; names[key(c.name)] = 1; if (c.catchup && c.catchup.days > maxDays) maxDays = c.catchup.days; });
        var from = Date.now() - Math.min(maxDays, 14) * 86400000, to = Date.now() + 4 * 86400000;
        var merged = { programmes: {}, names: {} };
        var chain = Promise.resolve();
        urls.forEach(function (x) {
            chain = chain.then(function () {
                return getText(x.u, x.ua).then(function (text) {
                    var g = parseXMLTV(text, ids, names, from, to);
                    Object.keys(g.programmes).forEach(function (k) { if (!merged.programmes[k]) merged.programmes[k] = g.programmes[k]; });
                    Object.keys(g.names).forEach(function (k) { if (!merged.names[k]) merged.names[k] = g.names[k]; });
                }).catch(function (e) { Util.toast('Guide: ' + (e.message || e)); });
            });
        });
        return chain.then(function () {
            guideLoading = false;
            if (Object.keys(merged.programmes).length) {
                merged.updated = Date.now();
                guide = merged;
                keyCache = {};
                DB.set('guide', guide);
            }
            changed('guide');
        });
    }

    function epgKey(ch) {
        if (keyCache[ch.id] !== undefined) return keyCache[ch.id];
        var k = null, id = ch.epgID && ch.epgID.toLowerCase();
        if (id && guide.programmes[id]) k = id;
        else if (guide.names[key(ch.name)] && guide.programmes[guide.names[key(ch.name)]]) k = guide.names[key(ch.name)];
        else {
            var orig = state.renames[ch.id] ? (((contents[ch.playlistID] || {}).channels || []).filter(function (c) { return c.id === ch.id; })[0]) : null;
            if (orig && guide.names[key(orig.name)]) k = guide.names[key(orig.name)];
        }
        keyCache[ch.id] = k;
        return k;
    }

    function programmes(ch, from, to) {
        var k = epgKey(ch), list = (k && guide.programmes[k]) || [];
        if (from == null) return list;
        return list.filter(function (p) { return p.end > from && p.start < to; });
    }

    function nowNext(ch, at) {
        at = at || Date.now();
        var list = programmes(ch);
        for (var i = 0; i < list.length; i++) {
            if (list[i].end > at) return list[i].start <= at ? [list[i], list[i + 1] || null] : [null, list[i]];
        }
        return [null, null];
    }

    /* ---------- groups, library tools ---------- */

    function groups(kind, includeHidden) {
        var out = [];
        playlists.forEach(function (p) {
            var c = contents[p.id];
            if (!p.enabled || !c) return;
            (kind === 'live' ? c.liveGroups : kind === 'movie' ? c.movieGroups : c.seriesGroups).forEach(function (n) {
                var g = { id: groupKey(p.id, kind, n), playlistID: p.id, kind: kind, name: n };
                if (includeHidden || state.hidden.indexOf(g.id) < 0) out.push(g);
            });
        });
        return out;
    }

    function toggleIn(listName, id, on) {
        var l = state[listName], i = l.indexOf(id);
        if (on === undefined) on = i < 0;
        if (on && i < 0) l.push(id);
        if (!on && i >= 0) l.splice(i, 1);
        pref(listName, l);
    }

    function played(ch) {
        state.recents = [ch.id].concat(state.recents.filter(function (x) { return x !== ch.id; })).slice(0, 30);
        pref('recents', state.recents);
        var cut = Date.now() - 14 * 86400000;
        (state.plays[ch.id] = state.plays[ch.id] || []).push(Date.now());
        Object.keys(state.plays).forEach(function (k) { state.plays[k] = state.plays[k].filter(function (t) { return t > cut; }); if (!state.plays[k].length) delete state.plays[k]; });
        pref('plays', state.plays);
    }

    function trendingChannels() {
        var since = Date.now() - 7 * 86400000;
        return Object.keys(state.plays).map(function (k) { return [k, state.plays[k].filter(function (t) { return t > since; }).length]; })
            .filter(function (x) { return x[1] > 0 && visible.byID[x[0]]; })
            .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20).map(function (x) { return visible.byID[x[0]]; });
    }

    function savePosition(id, ms, durationMs) {
        if (!durationMs) return;
        if (ms < 30000 || ms > durationMs * 0.95) delete state.positions[id]; else state.positions[id] = [ms, durationMs];
        pref('positions', state.positions);
        if (!state.positions[id]) { state.resume = state.resume.filter(function (r) { return r.id !== id || r.seriesID; }); pref('resume', state.resume); }
    }

    function noteWatching(entry) {
        state.resume = [entry].concat(state.resume.filter(function (r) { return r.id !== entry.id && !(entry.seriesID && r.seriesID === entry.seriesID); })).slice(0, 40);
        pref('resume', state.resume);
    }

    function removeResume(id) {
        state.resume = state.resume.filter(function (r) { return r.id !== id; });
        delete state.positions[id];
        pref('resume', state.resume); pref('positions', state.positions);
    }

    function continueEntries() {
        var m = {}, s = {};
        visible.movies.forEach(function (x) { m[x.id] = x; });
        visible.series.forEach(function (x) { s[x.id] = x; });
        return state.resume.filter(function (r) { return r.movieID ? (m[r.movieID] && state.positions[r.id]) : !!s[r.seriesID]; });
    }

    var detailCache = {};
    function details(kind, item) {
        if (detailCache[item.id]) return Promise.resolve(detailCache[item.id]);
        if (kind === 'series' && item.episodes) return Promise.resolve({ plot: item.plot, episodes: item.episodes });
        var pl = playlist(item.playlistID);
        if (!pl || pl.kind !== 'xtream') return Promise.resolve({ episodes: [] });
        return Xtream(pl).details(kind, kind === 'movie' ? item.streamID : item.seriesID).then(function (d) { detailCache[item.id] = d; return d; });
    }

    /* ---------- trending films and series (TMDB, matched to your sources) ---------- */

    function cleanTitle(s) {
        return key(String(s).replace(/^\s*[\|\[]?[A-Z]{2,3}[\|\]]?\s*[-:|]\s*/, ' ').replace(/^\s*\|[^|]+\|\s*/, ' ')
            .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' '));
    }

    function trending() {
        var tmdbKey = window.Online && Online.keys ? Online.keys().tmdb : '';
        function fetchList(media) {
            if (!tmdbKey) return Promise.resolve([]);
            // A v4 read access token is a long JWT and goes in a header; a v3 key goes in the address.
            var bearer = tmdbKey.length > 40;
            var url = 'https://api.themoviedb.org/3/trending/' + media + '/week' + (bearer ? '' : '?api_key=' + encodeURIComponent(tmdbKey));
            return new Promise(function (ok, fail) {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url);
                if (bearer) xhr.setRequestHeader('Authorization', 'Bearer ' + tmdbKey);
                xhr.onload = function () { if (xhr.status === 200) ok(xhr.responseText); else fail(new Error(xhr.status)); };
                xhr.onerror = function () { fail(new Error('tmdb')); };
                xhr.send();
            }).then(function (t) {
                if (typeof t !== 'string') t = new TextDecoder().decode(new Uint8Array(t));
                return (JSON.parse(t).results || []).map(function (r) { return { title: r.title || r.name, year: parseInt(String(r.release_date || r.first_air_date || '').slice(0, 4), 10) || null }; });
            }).catch(function () { return []; });
        }
        function match(list, wanted) {
            var idx = {};
            list.forEach(function (x) { var k = cleanTitle(x.name); (idx[k] = idx[k] || []).push(x); });
            var out = [];
            wanted.forEach(function (w) {
                var c = idx[cleanTitle(w.title)];
                if (c && c.length) out.push(c.filter(function (x) { return x.year === w.year; })[0] || c[0]);
            });
            return out;
        }
        return Promise.all([fetchList('movie'), fetchList('tv')]).then(function (r) {
            var m = match(visible.movies, r[0]), s = match(visible.series, r[1]);
            var fromTMDB = m.length > 0 || s.length > 0;
            if (!m.length) m = visible.movies.slice().sort(function (a, b) { return (b.added || 0) - (a.added || 0); }).slice(0, 300).sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); }).slice(0, 20);
            if (!s.length) s = visible.series.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); }).slice(0, 20);
            return { movies: m, series: s, fromTMDB: fromTMDB };
        });
    }

    /* ---------- reminders ---------- */

    function hasReminder(ch, p) { return state.reminders.some(function (r) { return r.channelID === ch.id && r.start === p.start; }); }
    function toggleReminder(ch, p) {
        if (hasReminder(ch, p)) state.reminders = state.reminders.filter(function (r) { return !(r.channelID === ch.id && r.start === p.start); });
        else state.reminders.push({ channelID: ch.id, channelName: ch.name, title: p.title, start: p.start });
        pref('reminders', state.reminders);
    }
    function checkReminders() {
        var now = Date.now();
        var due = state.reminders.filter(function (r) { return r.start <= now + 60000 && r.start > now - 600000; })[0];
        state.reminders = state.reminders.filter(function (r) { return r !== due && r.start > now - 600000; });
        pref('reminders', state.reminders);
        if (due) changed({ reminder: due });
    }

    /* ---------- search ---------- */

    // scope: 'all' | 'channels' | 'programmes'. Tags: every listed tag must match.
    function search(q, wantTags, scope) {
        q = String(q || '').trim().toLowerCase();
        wantTags = wantTags || [];
        var r = { channels: [], programmes: [], movies: [], series: [] };
        if (q.length < 2 && !wantTags.length) return r;
        function match(s) { return !q || (s && String(s).toLowerCase().indexOf(q) >= 0); }
        var pool = wantTags.length ? visible.channels.filter(function (c) { var t = tags(c); return wantTags.every(function (x) { return t.indexOf(x) >= 0; }); }) : visible.channels;
        if (scope !== 'programmes') r.channels = pool.filter(function (c) { return match(c.name); }).slice(0, 200);
        if ((scope !== 'all' && scope !== 'programmes') || !q) return r;
        if (scope === 'all') {
            r.movies = visible.movies.filter(function (m) { return match(m.name); }).slice(0, 80);
            r.series = visible.series.filter(function (s) { return match(s.name); }).slice(0, 80);
        }
        var now = Date.now(), seen = {}, out = [];
        for (var i = 0; i < pool.length && out.length < 300; i++) {
            var k = epgKey(pool[i]);
            if (!k || seen[k]) continue;
            seen[k] = 1;
            (guide.programmes[k] || []).forEach(function (p) {
                if (p.end > now && p.start < now + 2 * 86400000 && (match(p.title) || match(p.category) || match(p.episode))) out.push({ channel: pool[i], programme: p });
            });
        }
        r.programmes = out.sort(function (a, b) { return a.programme.start - b.programme.start; }).slice(0, 80);
        return r;
    }

    /* ---------- playlists ---------- */

    function savePlaylist(p) {
        var i = playlists.map(function (x) { return x.id; }).indexOf(p.id);
        if (i >= 0) playlists[i] = p;
        else { p.id = p.id || Util.uuid(); p.colorIndex = playlists.length; playlists.push(p); }
        pref('playlists', playlists);
        changed('playlists');
        return refresh(p.id);
    }

    function deletePlaylist(id) {
        playlists = playlists.filter(function (p) { return p.id !== id; });
        delete contents[id];
        DB.set('content:' + id, null);
        pref('playlists', playlists);
        rebuild();
    }

    return {
        init: init, onChange: onChange, refresh: refresh, refreshAll: refreshAll, refreshGuide: refreshGuide,
        playlists: function () { return playlists; }, playlist: playlist, content: function (id) { return contents[id]; }, color: color,
        savePlaylist: savePlaylist, deletePlaylist: deletePlaylist,
        setEnabled: function (id, on) { var p = playlist(id); if (p) { p.enabled = on; pref('playlists', playlists); rebuild(); } },
        loading: function (id) { return id ? !!loading[id] : Object.keys(loading).length > 0; }, error: function (id) { return errors[id]; },
        guideLoading: function () { return guideLoading; }, guideUpdated: function () { return guide.updated; },
        hasGuide: function () { return Object.keys(guide.programmes).length > 0; },
        channels: function () { return visible.channels; }, movies: function () { return visible.movies; }, series: function () { return visible.series; },
        channel: function (id) { return visible.byID[id]; },
        groups: groups,
        inGroup: function (kind, g) {
            var l = kind === 'live' ? visible.channels : kind === 'movie' ? visible.movies : visible.series;
            return l.filter(function (x) { return x.playlistID === g.playlistID && x.group === g.name; });
        },
        isHidden: function (g) { return state.hidden.indexOf(g.id) >= 0; },
        isLocked: function (g) { return state.locked.indexOf(g.id) >= 0; },
        setHidden: function (g, on) { toggleIn('hidden', g.id, on); rebuild(); },
        setLocked: function (g, on) { toggleIn('locked', g.id, on); rebuild(); },
        pin: function () { return state.pin; }, setPIN: function (p) { state.pin = p; pref('pin', p); },
        unlocked: function () { return state.unlocked; },
        unlock: function (p) { if (p !== state.pin) return false; state.unlocked = true; rebuild(); return true; },
        lock: function () { state.unlocked = false; rebuild(); },
        isFavorite: function (id) { return state.favorites.indexOf(id) >= 0; },
        toggleFavorite: function (id) { toggleIn('favorites', id); changed('favorites'); },
        favoriteChannels: function () { return state.favorites.map(function (id) { return visible.byID[id]; }).filter(Boolean); },
        favoriteMovies: function () { return visible.movies.filter(function (m) { return state.favorites.indexOf(m.id) >= 0; }); },
        favoriteSeries: function () { return visible.series.filter(function (m) { return state.favorites.indexOf(m.id) >= 0; }); },
        recentChannels: function () { return state.recents.map(function (id) { return visible.byID[id]; }).filter(Boolean); },
        clearRecents: function () { state.recents = []; pref('recents', []); },
        played: played, trendingChannels: trendingChannels, trending: trending,
        rename: function (ch, name) { if (name && name.trim()) state.renames[ch.id] = name.trim(); else delete state.renames[ch.id]; pref('renames', state.renames); rebuild(); },
        position: function (id) { return state.positions[id] ? state.positions[id][0] : 0; },
        progress: function (id) { var p = state.positions[id]; return p ? p[0] / p[1] : 0; },
        savePosition: savePosition, noteWatching: noteWatching, removeResume: removeResume, continueEntries: continueEntries,
        details: details, programmes: programmes, nowNext: nowNext, catchupURL: catchupURL, canCatchUp: canCatchUp,
        hasReminder: hasReminder, toggleReminder: toggleReminder, reminders: function () { return state.reminders; },
        tags: tags, TAGS: TAGS, recordMeasured: recordMeasured, search: search,
        // exposed for tests
        _parseM3U: parseM3U, _parseXMLTV: parseXMLTV, _fill: fill, _parseTags: parseTags, _xmltvDate: xmltvDate
    };
})();
