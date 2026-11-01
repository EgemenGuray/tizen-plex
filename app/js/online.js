/* Internet services, the way Infuse uses them: TMDB for artwork Plex doesn't have (title logos, backdrops, posters)
 * and OpenSubtitles for subtitles (matched by file hash first, then by title).
 * Both need your own free API keys: Settings → Online services, or app/js/keys.js (see keys.example.js). */
var Online = (function () {
    'use strict';

    var TMDB = 'https://api.themoviedb.org/3';
    var TMDB_IMG = 'https://image.tmdb.org/t/p/';
    var OS = 'https://api.opensubtitles.com/api/v1';
    var APP_UA = 'Lumen v0.3';

    function keys() {
        var k = Util.store('keys') || {};
        var f = window.PLEXHDR_KEYS || {};
        return {
            tmdb: k.tmdb || f.tmdb || '',
            opensubtitles: k.opensubtitles || f.opensubtitles || '',
            omdb: k.omdb || f.omdb || '',
            osUser: k.osUser || f.osUser || '',
            osPass: k.osPass || f.osPass || ''
        };
    }
    function setKey(name, value) {
        var k = Util.store('keys') || {};
        k[name] = value || '';
        Util.store('keys', k);
        if (name === 'osUser' || name === 'osPass') osToken = null;
    }

    function request(method, url, headers, body, responseType) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.timeout = 15000;
            if (responseType) xhr.responseType = responseType;
            Object.keys(headers || {}).forEach(function (h) { xhr.setRequestHeader(h, headers[h]); });
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    if (responseType) return resolve(xhr.response);
                    try { resolve(JSON.parse(xhr.responseText || '{}')); } catch (e) { resolve(xhr.responseText); }
                } else {
                    var msg = 'HTTP ' + xhr.status;
                    try { msg = JSON.parse(xhr.responseText).message || msg; } catch (e) {}
                    reject(new Error(msg));
                }
            };
            xhr.onerror = function () { reject(new Error('Network error')); };
            xhr.ontimeout = function () { reject(new Error('Timeout')); };
            xhr.send(body ? JSON.stringify(body) : null);
        });
    }

    // tmdb://123, imdb://tt0123 and tvdb://… from Plex's Guid list (asked for with includeGuids=1).
    function ids(item) {
        var out = {};
        (item.Guid || []).forEach(function (g) {
            var m = /^(\w+):\/\/(.+)$/.exec(g.id || '');
            if (m) out[m[1]] = m[2];
        });
        return out;
    }

    /* ---------- TMDB artwork ---------- */

    var artCache = Util.store('tmdbArt') || {};
    var pending = {};

    function tmdbGet(path, params) {
        var key = keys().tmdb;
        var headers = {};
        params = params || {};
        // A v4 "read access token" is a long JWT; a v3 key is 32 hex characters.
        if (key.length > 40) headers.Authorization = 'Bearer ' + key;
        else params.api_key = key;
        return request('GET', TMDB + path + '?' + Util.qs(params), headers);
    }

    function pick(list, lang) {
        list = (list || []).slice().sort(function (a, b) { return (b.vote_average || 0) - (a.vote_average || 0); });
        return list.filter(function (i) { return i.iso_639_1 === lang; })[0] ||
            list.filter(function (i) { return i.iso_639_1 === 'en'; })[0] ||
            list.filter(function (i) { return !i.iso_639_1; })[0] || list[0];
    }

    // Promise of { logo, backdrop, poster } (full image URLs, or null) for a movie or show; cached on the TV.
    function artwork(item) {
        if (!keys().tmdb || (Util.store('settings') || {}).tmdbArt === false) return Promise.resolve(null);
        var kind = item.type === 'show' ? 'tv' : item.type === 'movie' ? 'movie' : null;
        var id = ids(item).tmdb;
        if (!kind || !id) return Promise.resolve(null);
        var ck = kind + id;
        if (artCache[ck]) return Promise.resolve(artCache[ck]);
        if (pending[ck]) return pending[ck];
        pending[ck] = tmdbGet('/' + kind + '/' + id + '/images', { include_image_language: 'en,tr,null' }).then(function (r) {
            var logo = pick(r.logos, 'en'), back = pick((r.backdrops || []).filter(function (b) { return !b.iso_639_1; }).concat(r.backdrops || [])), poster = pick(r.posters, 'en');
            var res = {
                logo: logo ? TMDB_IMG + 'w780' + logo.file_path : null,
                backdrop: back ? TMDB_IMG + 'w1280' + back.file_path : null,
                poster: poster ? TMDB_IMG + 'w342' + poster.file_path : null
            };
            artCache[ck] = res;
            var keysList = Object.keys(artCache);
            if (keysList.length > 400) delete artCache[keysList[0]];
            Util.store('tmdbArt', artCache);
            return res;
        }).catch(function () { return null; }).then(function (r) { delete pending[ck]; return r; });
        return pending[ck];
    }

    /* ---------- OpenSubtitles ---------- */

    var osToken = null;
    function osHeaders() {
        var h = { 'Api-Key': keys().opensubtitles, 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-User-Agent': APP_UA };
        if (osToken) h.Authorization = 'Bearer ' + osToken;
        return h;
    }
    // Signing in raises the daily download limit; without an account the API key alone allows a few a day.
    function osLogin() {
        var k = keys();
        if (osToken || !k.osUser || !k.osPass) return Promise.resolve();
        return request('POST', OS + '/login', osHeaders(), { username: k.osUser, password: k.osPass })
            .then(function (r) { osToken = r.token; }, function () { /* fall back to anonymous */ });
    }

    // OpenSubtitles hash: file size + the first and last 64 KB summed as little-endian 64-bit words. Lets the search
    // find subtitles cut for this exact file, which is how Infuse gets well-synced results.
    function fileHash(url, size) {
        var CHUNK = 65536;
        if (!size || size < CHUNK * 2) return Promise.resolve(null);
        function range(from) {
            return request('GET', url, { Range: 'bytes=' + from + '-' + (from + CHUNK - 1) }, null, 'arraybuffer');
        }
        return Promise.all([range(0), range(size - CHUNK)]).then(function (bufs) {
            var lo = size % 4294967296 >>> 0, hi = Math.floor(size / 4294967296) >>> 0;
            bufs.forEach(function (buf) {
                if (!buf || buf.byteLength < CHUNK) throw new Error('short read');
                var dv = new DataView(buf, 0, CHUNK);
                for (var i = 0; i < CHUNK; i += 8) {
                    var l = dv.getUint32(i, true), h = dv.getUint32(i + 4, true);
                    var sum = lo + l;
                    lo = sum >>> 0;
                    hi = (hi + h + (sum > 4294967295 ? 1 : 0)) >>> 0;
                }
            });
            function hex(n) { return ('00000000' + n.toString(16)).slice(-8); }
            return hex(hi) + hex(lo);
        }).catch(function () { return null; });
    }

    // item: Plex metadata (movie or episode); show: the episode's show (for its TMDB/IMDb id); langs: ['en', 'tr']
    function searchSubtitles(item, show, langs, fileUrl, fileSize) {
        if (!keys().opensubtitles) return Promise.reject(new Error('No OpenSubtitles API key (Settings → Online services)'));
        return Promise.all([fileHash(fileUrl, fileSize), osLogin()]).then(function (r) {
            var hash = r[0];
            var p = { languages: langs.join(','), order_by: 'download_count' };
            if (hash) p.moviehash = hash;
            if (item.type === 'episode') {
                var sid = ids(show || {});
                if (sid.tmdb) p.parent_tmdb_id = sid.tmdb; else if (sid.imdb) p.parent_imdb_id = sid.imdb.replace(/^tt/, '');
                else p.query = item.grandparentTitle;
                p.season_number = item.parentIndex;
                p.episode_number = item.index;
            } else {
                var mid = ids(item);
                if (mid.tmdb) p.tmdb_id = mid.tmdb; else if (mid.imdb) p.imdb_id = mid.imdb.replace(/^tt/, '');
                else { p.query = item.title; if (item.year) p.year = item.year; }
            }
            return request('GET', OS + '/subtitles?' + Util.qs(p), osHeaders());
        }).then(function (r) {
            return (r.data || []).map(function (d) {
                var a = d.attributes || {}, f = (a.files || [])[0] || {};
                return {
                    source: 'opensubtitles', fileId: f.file_id, language: a.language, title: a.release || f.file_name || 'Subtitle',
                    hashMatch: !!a.moviehash_match, hearingImpaired: !!a.hearing_impaired, downloads: a.download_count || 0,
                    trusted: !!a.from_trusted, ai: !!(a.ai_translated || a.machine_translated)
                };
            }).filter(function (x) { return x.fileId; })
                .sort(function (a, b) { return (b.hashMatch - a.hashMatch) || (b.downloads - a.downloads); });
        });
    }

    // Downloads one result and returns its text. Downloaded files are kept on the TV so a replay doesn't use up the quota.
    function downloadSubtitle(result) {
        var cache = Util.store('osCache') || {};
        if (cache[result.fileId]) {
            var raw = Util.store('os.' + result.fileId);
            if (raw) return Promise.resolve(raw);
        }
        return osLogin().then(function () {
            return request('POST', OS + '/download', osHeaders(), { file_id: result.fileId, sub_format: 'srt' });
        }).then(function (r) {
            if (!r.link) throw new Error(r.message || 'No download link');
            return request('GET', r.link, {}, null, 'text');
        }).then(function (text) {
            var ids2 = Object.keys(cache);
            if (ids2.length >= 12) { Util.store('os.' + ids2[0], null); delete cache[ids2[0]]; }
            cache[result.fileId] = Date.now();
            Util.store('osCache', cache);
            Util.store('os.' + result.fileId, text);
            return text;
        });
    }

    /* ---------- ratings ---------- */

    function html(url) { return request('GET', url, {}, null, 'text'); }
    function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }

    // Plex already carries IMDb and Rotten Tomatoes (critic and audience) for items matched by its own agent.
    function plexRatings(item) {
        var out = {};
        (item.Rating || []).forEach(function (r) {
            var img = r.image || '', v = num(r.value);
            if (v == null) return;
            if (/^imdb:/.test(img)) out.imdb = v.toFixed(1);
            else if (/^rottentomatoes:\/\/image\.rating\.(ripe|rotten)/.test(img)) out.rtCritic = Math.round(v * 10) + '%';
            else if (/^rottentomatoes:\/\/image\.rating\.(upright|spilled)/.test(img)) out.rtAudience = Math.round(v * 10) + '%';
            else if (/^themoviedb:/.test(img)) out.tmdb = Math.round(v * 10) + '%';
        });
        if (!out.imdb && /imdb/.test(item.audienceRatingImage || '') && item.audienceRating) out.imdb = Number(item.audienceRating).toFixed(1);
        if (!out.rtCritic && /rottentomatoes/.test(item.ratingImage || '') && item.rating) out.rtCritic = Math.round(item.rating * 10) + '%';
        if (!out.rtAudience && /rottentomatoes/.test(item.audienceRatingImage || '') && item.audienceRating) out.rtAudience = Math.round(item.audienceRating * 10) + '%';
        return out;
    }

    function slug(t) {
        return String(t || '').toLowerCase().replace(/&/g, 'and').replace(/['’.:]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    /* Everything is best effort: a source that fails or changes its page is simply left out.
     * OMDb (free key) gives IMDb, Rotten Tomatoes and the Metascore. Letterboxd and the Metacritic user score have no
     * public API, so their public pages are read; those two can break whenever the sites change. */
    function ratings(item) {
        var ck = 'ratings.' + item.ratingKey;
        var cached = Util.store(ck);
        if (cached && Date.now() - cached.at < 7 * 86400000) return Promise.resolve(cached.r);
        var r = plexRatings(item);
        var id = ids(item), k = keys();
        var kind = item.type === 'show' ? 'tv' : 'movie';
        var jobs = [];
        if (k.omdb && id.imdb) {
            jobs.push(request('GET', 'https://www.omdbapi.com/?' + Util.qs({ i: id.imdb, apikey: k.omdb })).then(function (o) {
                if (o.imdbRating && o.imdbRating !== 'N/A') r.imdb = o.imdbRating;
                if (o.Metascore && o.Metascore !== 'N/A') r.metaCritic = o.Metascore;
                (o.Ratings || []).forEach(function (x) { if (x.Source === 'Rotten Tomatoes' && !r.rtCritic) r.rtCritic = x.Value; });
            }).catch(function () {}));
        }
        if (kind === 'movie' && id.tmdb) {
            jobs.push(html('https://letterboxd.com/tmdb/' + id.tmdb + '/').then(function (page) {
                var m = /name="twitter:data2" content="([\d.]+) out of 5"/.exec(page);
                if (m) r.letterboxd = Number(m[1]).toFixed(1);
            }).catch(function () {}));
        }
        if (item.title && (item.type === 'movie' || item.type === 'show')) {
            jobs.push(html('https://www.metacritic.com/' + (kind === 'tv' ? 'tv' : 'movie') + '/' + slug(item.title) + '/').then(function (page) {
                var mu = /"userScore"\s*:\s*\{[^}]*?"score"\s*:\s*([\d.]+)/.exec(page) || /user score[^\d]{0,200}?(\d\.\d)/i.exec(page);
                if (mu) r.metaUser = Number(mu[1]).toFixed(1);
                if (!r.metaCritic) {
                    var mc = /"criticScoreSummary"\s*:\s*\{[^}]*?"score"\s*:\s*(\d+)/.exec(page) || /"ratingValue"\s*:\s*"?(\d+)/.exec(page);
                    if (mc) r.metaCritic = mc[1];
                }
            }).catch(function () {}));
        }
        return Promise.all(jobs).then(function () {
            Util.store(ck, { at: Date.now(), r: r });
            return r;
        });
    }

    return { ratings: ratings, plexRatings: plexRatings, keys: keys, setKey: setKey, ids: ids, artwork: artwork, searchSubtitles: searchSubtitles, downloadSubtitle: downloadSubtitle, fileHash: fileHash };
})();
