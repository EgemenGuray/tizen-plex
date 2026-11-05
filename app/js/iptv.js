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


    /* ---------- helpers (the parsers live in iptvparse.js, shared with the worker) ---------- */

    var P = IPTVParse;
    var str = P.str, int = P.int, key = P.key;

    /* ---------- background worker ---------- */

    // Big playlists and guides are downloaded, parsed and saved in a Web Worker so the remote stays responsive
    // while they load. Without one (or if it fails to start) the same jobs run here.
    var worker = null, jobs = {}, jobSeq = 0, workerFetch = true;
    try {
        if (window.Worker) {
            worker = new Worker('js/iptvworker.js');
            worker.onmessage = function (e) {
                var m = e.data, j = jobs[m.id];
                if (!j) return;
                if (m.part) { var k = m.part[0].split(':')[0]; (j.parts[k] = j.parts[k] || []).push(m.part[1]); return; }
                delete jobs[m.id];
                if (m.error) j.fail(m); else j.ok(P.join(m.result, j.parts));
            };
            worker.onerror = function (e) {
                // The script didn't load: finish the waiting jobs here and stop using the worker.
                if (e && e.preventDefault) e.preventDefault();
                var w = jobs; jobs = {}; worker = null;
                Object.keys(w).forEach(function (k) { w[k].retry(); });
            };
        }
    } catch (e) { worker = null; }

    /* Downloads in the page what the worker shouldn't fetch itself: sources that need a User-Agent (only the page's
     * requests carry it on the TV), or everything once the worker's own requests have failed. */
    function prefetch(d) {
        return Promise.all(d.sources.map(function (src) {
            if (src.buf || (workerFetch && !src.ua)) return src;
            return P.get(src).then(function (b) { return { buf: b }; }, function (e) { return { error: e.message || String(e) }; });
        })).then(function (srcs) { var o = {}; for (var k in d) o[k] = d[k]; o.sources = srcs; return o; });
    }

    /* Runs a job (see IPTVParse.job): 'm3u', 'xtream' or 'guide'. */
    function work(op, d) {
        if (!worker) return P.job(op, d);
        return prefetch(d).then(function (d2) {
            return new Promise(function (ok, fail) {
                var id = ++jobSeq, local = function () { P.job(op, d).then(ok, fail); };
                jobs[id] = {
                    parts: {}, ok: ok, retry: local,
                    fail: function (m) {
                        // The worker couldn't reach the server: download in the page from now on.
                        if (m.net && workerFetch) { workerFetch = false; work(op, d).then(ok, fail); } else fail(new Error(m.error));
                    }
                };
                var bufs = d2.sources.map(function (x) { return x.buf; }).filter(Boolean);
                try { worker.postMessage({ id: id, op: op, data: d2 }, bufs); }
                catch (e) { delete jobs[id]; local(); }
            });
        });
    }

    function Xtream(pl) {
        var base = P.xtreamBase(pl.url), u = encodeURIComponent(pl.username), p = encodeURIComponent(pl.password);
        var api = function (action, extra) {
            var q = { username: pl.username, password: pl.password };
            if (action) q.action = action;
            for (var k in (extra || {})) q[k] = extra[k];
            return request(base + '/player_api.php?' + Util.qs(q), { userAgent: pl.userAgent }).then(function (t) {
                if (typeof t !== 'string') t = new TextDecoder().decode(new Uint8Array(t));
                try { return t ? JSON.parse(t) : []; } catch (e) { throw new Error('This doesn\'t look like an Xtream Codes server.'); }
            });
        };
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
                var self = this, c = P.emptyContent();
                return api(null).then(function (root) {
                    var user = root && root.user_info;
                    if (!user) throw new Error('This doesn\'t look like an Xtream Codes server.');
                    if (int(user.auth) === 0) throw new Error('The username or password was refused.');
                    c.account = { status: str(user.status), expires: P.dateOf(user.exp_date), maxConnections: int(user.max_connections), activeConnections: int(user.active_cons), trial: P.bool(user.is_trial) };
                    c.serverTimeZone = root.server_info && str(root.server_info.timezone);
                    c.epgURLs = [self.epg];
                    // The six lists (50k films is a lot of JSON) are downloaded and parsed by the worker.
                    var sources = ['get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series'].map(function (a) {
                        return { url: base + '/player_api.php?' + Util.qs({ username: pl.username, password: pl.password, action: a }), ua: pl.userAgent || null };
                    });
                    return work('xtream', { pl: { id: pl.id, url: pl.url, username: pl.username, password: pl.password, userAgent: pl.userAgent || '' }, content: c, sources: sources });
                });
            },
            details: function (kind, id) {
                return api(kind === 'movie' ? 'get_vod_info' : 'get_series_info', kind === 'movie' ? { vod_id: id } : { series_id: id }).then(function (root) {
                    var info = (root && root.info) || {};
                    var d = {
                        plot: str(info.plot) || str(info.description), cast: str(info.cast) || str(info.actors), director: str(info.director),
                        genre: str(info.genre), released: str(info.releasedate || info.releaseDate || info.release_date),
                        duration: P.num(info.duration_secs) || (P.num(info.episode_run_time) ? P.num(info.episode_run_time) * 60 : null),
                        rating: P.num(info.rating) || null,
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
                                thumb: str(ei.movie_image) || str(ei.cover_big), duration: P.num(ei.duration_secs)
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
    // The guide keeps each channel's programmes as a JSON string (packed) and unpacks a channel the first time it
    // is shown, so loading a big guide doesn't create hundreds of thousands of objects at once.
    var guide = { packed: {}, names: {}, icons: {}, updated: null, count: 0 };
    var unpacked = {};
    var keyCache = {};
    var loading = {}, errors = {}, guideLoading = false;
    var listeners = [];
    var state = {
        favorites: pref('favorites') || [], recents: pref('recents') || [], hidden: pref('hidden') || [], locked: pref('locked') || [],
        renames: pref('renames') || {}, reminders: pref('reminders') || [], pin: pref('pin') || '', unlocked: false,
        positions: pref('positions') || {}, measured: pref('measured') || {}, resume: pref('resume') || [], plays: pref('plays') || {}
    };
    var visible = { channels: [], movies: [], series: [], byGroup: {}, ids: {} };
    // Look-ups by id, built the first time they're needed (a 50k-film map is not free on the TV).
    function byID(kind) {
        var m = visible.ids[kind];
        if (m) return m;
        m = visible.ids[kind] = {};
        var l = visible[kind];
        for (var i = 0; i < l.length; i++) m[l[i].id] = l[i];
        return m;
    }
    var favSet = {};
    function indexFavorites() { favSet = {}; state.favorites.forEach(function (id) { favSet[id] = 1; }); }
    indexFavorites();

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
        var ch = [], mv = [], se = [], byGroup = {};
        var hidden = {}, locked = {};
        state.hidden.forEach(function (k) { hidden[k] = 1; });
        if (!state.unlocked) state.locked.forEach(function (k) { locked[k] = 1; });
        playlists.forEach(function (p) {
            var c = contents[p.id];
            if (!p.enabled || !c) return;
            // Items come grouped, so the hidden/locked check and the group bucket are looked up once per run of a group.
            function filer(kind) {
                var lastG = null, lastB = null;
                return function (g) {
                    if (g !== lastG) {
                        lastG = g;
                        var k = groupKey(p.id, kind, g);
                        lastB = hidden[k] || locked[k] ? null : (byGroup[k] || (byGroup[k] = []));
                    }
                    return lastB;
                };
            }
            var f = filer('live'), i, x, b;
            for (i = 0; i < c.channels.length; i++) {
                x = c.channels[i]; b = f(x.group);
                if (!b) continue;
                var y = x;
                if (state.renames[x.id] || (!x.userAgent && p.userAgent)) {
                    y = {}; for (var k in x) y[k] = x[k];
                    if (state.renames[x.id]) y.name = state.renames[x.id];
                    if (!y.userAgent && p.userAgent) y.userAgent = p.userAgent;
                }
                ch.push(y); b.push(y);
            }
            f = filer('movie');
            for (i = 0; i < c.movies.length; i++) { x = c.movies[i]; b = f(x.group); if (b) { mv.push(x); b.push(x); } }
            f = filer('series');
            for (i = 0; i < c.series.length; i++) { x = c.series[i]; b = f(x.group); if (b) { se.push(x); b.push(x); } }
        });
        visible = { channels: ch, movies: mv, series: se, byGroup: byGroup, ids: {} };
        keyCache = {};
        tagCache = {};
        trendCache = null;
        changed('content');
    }

    function setGuide(g) {
        if (g && !g.packed && g.programmes) {
            // Saved by an older Lumen: already unpacked.
            unpacked = g.programmes;
            g.packed = {};
            Object.keys(unpacked).forEach(function (k) { g.packed[k] = ''; });
            delete g.programmes;
        } else unpacked = {};
        g.names = g.names || {}; g.icons = g.icons || {};
        g.count = Object.keys(g.packed).length;
        guide = g;
        keyCache = {};
    }

    /* Saved content, read slice by slice (each slice is its own short step for the page). */
    function loadContent(id) {
        return DB.get('content:' + id).then(function (meta) {
            if (!meta || !meta.split) return meta;
            var parts = {}, chain = Promise.resolve();
            Object.keys(meta.split).forEach(function (k) {
                parts[k] = [];
                for (var i = 0; i < meta.split[k]; i++) (function (n) {
                    chain = chain.then(function () { return DB.get('content:' + id + ':' + k + ':' + n); }).then(function (v) { parts[k].push(v || []); });
                })(i);
            });
            return chain.then(function () { return P.join(meta, parts); });
        });
    }

    function loadGuide() {
        return DB.get('guide').then(function (g) {
            if (!g || !g.parts) return g;
            var chain = Promise.resolve();
            g.packed = {};
            for (var i = 0; i < g.parts; i++) (function (n) {
                chain = chain.then(function () { return DB.get('guide:' + n); }).then(function (part) { for (var k in part) g.packed[k] = part[k]; });
            })(i);
            return chain.then(function () { delete g.parts; return g; });
        });
    }

    function init() {
        // Channels first so the screens can draw; the guide follows in its own step.
        var chain = Promise.resolve();
        playlists.forEach(function (p) { chain = chain.then(function () { return loadContent(p.id); }).then(function (c) { if (c) contents[p.id] = c; }); });
        return chain.then(function () {
            rebuild();
            return loadGuide().then(function (g) { if (g) { setGuide(g); changed('guide'); } });
        }).then(function () {
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
            if (!guide.updated || Date.now() - guide.updated > 6 * 3600000 || !guide.count) return refreshGuide();
        });
    }

    function refresh(id, skipGuide) {
        var pl = playlist(id);
        if (!pl || loading[id]) return Promise.resolve();
        loading[id] = true; delete errors[id]; changed('loading');
        var job = pl.kind === 'xtream' ? Xtream(pl).load() : work('m3u', { pl: { id: pl.id }, sources: [{ url: pl.url.trim(), ua: pl.userAgent || null }] });
        return job.then(function (c) {
            contents[id] = c;
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
        var ids = {}, chNames = [], maxDays = 1;
        Object.keys(contents).forEach(function (k) {
            contents[k].channels.forEach(function (c) { if (c.epgID) ids[c.epgID.toLowerCase()] = 1; chNames.push(c.name); if (c.catchup && c.catchup.days > maxDays) maxDays = c.catchup.days; });
        });
        var from = Date.now() - Math.min(maxDays, 14) * 86400000, to = Date.now() + 4 * 86400000;
        // The worker downloads each guide and scans it piece by piece, keeping only our channels and the needed days.
        return work('guide', { sources: urls.map(function (x) { return { url: x.u, ua: x.ua || null }; }), ids: ids, chNames: chNames, from: from, to: to }).then(function (g) {
            (g.errors || []).forEach(function (e) { Util.toast('Guide: ' + e); });
            if (g.count) setGuide({ packed: g.packed, names: g.names, icons: g.icons, updated: g.updated });
        }, function (e) { Util.toast('Guide: ' + (e.message || e)); }).then(function () {
            guideLoading = false;
            changed('guide');
        });
    }

    function hasProgs(k) { return guide.packed[k] !== undefined; }
    function progsOf(k) {
        if (!k) return [];
        var l = unpacked[k];
        if (l) return l;
        var s = guide.packed[k];
        if (!s) return [];
        try { l = JSON.parse(s); } catch (e) { l = []; }
        unpacked[k] = l;
        return l;
    }

    function epgKey(ch) {
        if (keyCache[ch.id] !== undefined) return keyCache[ch.id];
        var k = null, id = ch.epgID && ch.epgID.toLowerCase(), nk;
        if (id && hasProgs(id)) k = id;
        else if ((nk = guide.names[key(ch.name)]) && hasProgs(nk)) k = nk;
        else {
            var orig = state.renames[ch.id] ? (((contents[ch.playlistID] || {}).channels || []).filter(function (c) { return c.id === ch.id; })[0]) : null;
            if (orig && guide.names[key(orig.name)]) k = guide.names[key(orig.name)];
        }
        keyCache[ch.id] = k;
        return k;
    }

    /* The playlist's logo, else the guide's icon for the channel. */
    function logo(ch) {
        if (!ch) return null;
        if (ch.logo) return ch.logo;
        var icons = guide.icons || {};
        var id = ch.epgID && ch.epgID.toLowerCase();
        if (id && icons[id]) return icons[id];
        var k = guide.names[key(ch.name)];
        return (k && icons[k]) || null;
    }

    /* "Kanal 2 HD" gives K2, "TRT 1" gives TRT 1, "Fox Sports" gives FOX, "Discovery Science" gives DS. */
    function initials(name) {
        var n = String(name || '').replace(/^\s*[A-Z]{2,4}\s*[:|\-]\s*/, '').replace(/\b(4K|UHD|FHD|HD|SD|HEVC|H265|50FPS|60FPS|RAW|BACKUP)\b/gi, '').trim();
        var w = n.split(/\s+/).filter(Boolean);
        if (!w.length) return '';
        var num = w.length > 1 && /^\d+$/.test(w[1]) ? w[1] : '';
        if (w[0].length <= 4) return (w[0] + (num ? ' ' + num : '')).toUpperCase();
        if (num) return (w[0][0] + num).toUpperCase();
        if (w.length > 1) return w.slice(0, 3).map(function (x) { return x[0]; }).join('').toUpperCase();
        return w[0].slice(0, 5).toUpperCase();
    }

    /* A logo box: the channel's initials, covered by its logo once that loads. A broken logo just leaves the initials. */
    function logoHtml(ch, cls, url) {
        var u = url || logo(ch);
        return '<span class="lg ' + (cls || '') + '"><b>' + Util.esc(initials(ch && ch.name)) + '</b>' +
            (u ? '<img src="' + Util.esc(u) + '" alt="" onload="this.parentNode.className+=\' ok\'" onerror="this.parentNode.removeChild(this)">' : '') + '</span>';
    }

    function programmes(ch, from, to) {
        var list = progsOf(epgKey(ch));
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
            .filter(function (x) { return x[1] > 0 && byID('channels')[x[0]]; })
            .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20).map(function (x) { return byID('channels')[x[0]]; });
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
        if (!state.resume.length) return [];
        var m = byID('movies'), s = byID('series');
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

    // Home asks for this on every visit; matching 50k films against TMDB is worth doing once per catalogue change.
    var trendCache = null;
    function trending() {
        if (trendCache && Date.now() - trendCache.at < 3600000) return trendCache.p;
        var p = trendingNow();
        trendCache = { at: Date.now(), p: p };
        p.then(function (r) { if (!r.fromTMDB && trendCache && trendCache.p === p) trendCache.at = 0; }, function () { trendCache = null; });
        return p;
    }
    function trendingNow() {
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
            if (!wanted.length) return [];
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
            if (!m.length) m = top(top(visible.movies, 300, function (x) { return x.added || 0; }), 20, function (x) { return x.rating || 0; });
            if (!s.length) s = top(visible.series, 20, function (x) { return x.rating || 0; });
            return { movies: m, series: s, fromTMDB: fromTMDB };
        });
    }

    /* The n items with the highest score, in order, without sorting the whole list (stable for equal scores). */
    function top(list, n, score) {
        var best = [];
        for (var i = 0; i < list.length; i++) {
            var v = score(list[i]);
            if (best.length === n && v <= best[n - 1][0]) continue;
            var j = best.length;
            while (j > 0 && best[j - 1][0] < v) j--;
            best.splice(j, 0, [v, list[i]]);
            if (best.length > n) best.pop();
        }
        return best.map(function (x) { return x[1]; });
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
        var now = Date.now(), seen = {}, out = [], re = mentions(q);
        for (var i = 0; i < pool.length && out.length < 300; i++) {
            var k = epgKey(pool[i]);
            if (!k || seen[k]) continue;
            seen[k] = 1;
            if (!re(k)) continue;
            progsOf(k).forEach(function (p) {
                if (p.end > now && p.start < now + 2 * 86400000 && (match(p.title) || match(p.category) || match(p.episode))) out.push({ channel: pool[i], programme: p });
            });
        }
        r.programmes = out.sort(function (a, b) { return a.programme.start - b.programme.start; }).slice(0, 80);
        return r;
    }

    /* A quick test on a channel's packed guide text, so a search only unpacks channels that can match. */
    function mentions(q) {
        var re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return function (k) { var s = guide.packed[k]; return s === '' || s === undefined ? !!unpacked[k] : re.test(s); };
    }
    // guideMentions(q)(ch): could the channel's guide hold q? (false means it certainly doesn't)
    function guideMentions(q) { var m = mentions(q); return function (ch) { var k = epgKey(ch); return !!k && m(k); }; }

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
        P.save([], 'content:' + id + ':');
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
        hasGuide: function () { return guide.count > 0; }, guideMentions: guideMentions,
        channels: function () { return visible.channels; }, movies: function () { return visible.movies; }, series: function () { return visible.series; },
        channel: function (id) { return byID('channels')[id]; }, logo: logo, logoHtml: logoHtml,
        groups: groups,
        inGroup: function (kind, g) { return visible.byGroup[groupKey(g.playlistID, kind, g.name)] || []; },
        movie: function (id) { return byID('movies')[id]; }, seriesItem: function (id) { return byID('series')[id]; },
        isHidden: function (g) { return state.hidden.indexOf(g.id) >= 0; },
        isLocked: function (g) { return state.locked.indexOf(g.id) >= 0; },
        setHidden: function (g, on) { toggleIn('hidden', g.id, on); rebuild(); },
        setLocked: function (g, on) { toggleIn('locked', g.id, on); rebuild(); },
        pin: function () { return state.pin; }, setPIN: function (p) { state.pin = p; pref('pin', p); },
        unlocked: function () { return state.unlocked; },
        unlock: function (p) { if (p !== state.pin) return false; state.unlocked = true; rebuild(); return true; },
        lock: function () { state.unlocked = false; rebuild(); },
        isFavorite: function (id) { return favSet[id] === 1; },
        toggleFavorite: function (id) { toggleIn('favorites', id); indexFavorites(); changed('favorites'); },
        favoriteChannels: function () { return state.favorites.map(function (id) { return byID('channels')[id]; }).filter(Boolean); },
        favoriteMovies: function () { return state.favorites.map(function (id) { return byID('movies')[id]; }).filter(Boolean); },
        favoriteSeries: function () { return state.favorites.map(function (id) { return byID('series')[id]; }).filter(Boolean); },
        recentChannels: function () { return state.recents.map(function (id) { return byID('channels')[id]; }).filter(Boolean); },
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
        _parseM3U: P.parseM3U, _parseXMLTV: P.parseXMLTV, _fill: fill, _parseTags: parseTags, _xmltvDate: P.xmltvDate
    };
})();
