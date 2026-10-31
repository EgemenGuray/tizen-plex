/* Plex API: plex.tv PIN sign-in, server discovery, library browsing, playback URLs, progress reporting. */
var Plex = (function () {
    'use strict';

    var PRODUCT = 'Plex HDR (Tizen)';
    var VERSION = '0.2.0';

    var clientId = Util.store('clientId');
    if (!clientId) { clientId = Util.uuid(); Util.store('clientId', clientId); }

    var state = {
        token: Util.store('token'),       // plex.tv account token
        server: Util.store('server'),     // { name, uri, token, machineId }
        user: Util.store('user')          // { title, thumb, uuid } of the signed-in (or switched-to) Plex Home user
    };

    function deviceName() {
        try { return 'Samsung ' + webapis.productinfo.getRealModel(); } catch (e) { return 'Samsung TV'; }
    }

    function baseParams() {
        return {
            'X-Plex-Product': PRODUCT,
            'X-Plex-Version': VERSION,
            'X-Plex-Client-Identifier': clientId,
            'X-Plex-Platform': 'Tizen',
            'X-Plex-Device': 'Samsung TV',
            'X-Plex-Device-Name': deviceName()
        };
    }

    function request(method, url, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.timeout = opts.timeout || 15000;
            if (opts.responseType) xhr.responseType = opts.responseType;
            else xhr.setRequestHeader('Accept', 'application/json');
            var h = baseParams();
            if (opts.token) h['X-Plex-Token'] = opts.token;
            Object.keys(h).forEach(function (k) { xhr.setRequestHeader(k, h[k]); });
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    if (opts.responseType) return resolve(xhr.response);
                    var body = xhr.responseText;
                    try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
                } else {
                    reject(new Error(method + ' ' + url.split('?')[0] + ' → HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function () { reject(new Error('Network error: ' + url.split('?')[0])); };
            xhr.ontimeout = function () { reject(new Error('Timeout: ' + url.split('?')[0])); };
            xhr.send(null);
        });
    }

    /* ---------- sign-in (plex.tv/link) ---------- */

    function createPin(strong) {
        return request('POST', 'https://plex.tv/api/v2/pins?strong=' + (strong ? 'true' : 'false'));
    }

    // Plex's own sign-in page for a strong PIN: scanning it on a phone signs this TV in without typing a code.
    function authUrl(code) {
        return 'https://app.plex.tv/auth#?' + Util.qs({ clientID: clientId, code: code, 'context[device][product]': PRODUCT });
    }

    function checkPin(id) {
        return request('GET', 'https://plex.tv/api/v2/pins/' + id).then(function (pin) {
            if (pin.authToken) {
                state.token = pin.authToken;
                Util.store('token', state.token);
            }
            return pin.authToken || null;
        });
    }

    function signOut() {
        state.token = null; state.server = null; state.user = null;
        Util.store('token', null); Util.store('server', null); Util.store('user', null);
    }

    function account() {
        return request('GET', 'https://plex.tv/api/v2/user', { token: state.token }).then(function (u) {
            state.user = { title: u.title || u.username, thumb: u.thumb, uuid: u.uuid };
            Util.store('user', state.user);
            return state.user;
        });
    }

    /* ---------- Plex Home users ---------- */

    function homeUsers() {
        return request('GET', 'https://plex.tv/api/v2/home/users', { token: state.token }).then(function (r) {
            return (r && (r.users || r)) || [];
        });
    }

    // Switching gives a token for that user; the server must then be re-resolved, because its access token is per user.
    function switchUser(user, pin) {
        var url = 'https://plex.tv/api/v2/home/users/' + encodeURIComponent(user.uuid) + '/switch' + (pin ? '?' + Util.qs({ pin: pin }) : '');
        return request('POST', url, { token: state.token }).then(function (u) {
            if (!u.authToken) throw new Error('Plex did not accept the switch');
            var machineId = state.server && state.server.machineId;
            state.token = u.authToken;
            Util.store('token', state.token);
            state.user = { title: u.title || user.title, thumb: u.thumb || user.thumb, uuid: u.uuid || user.uuid };
            Util.store('user', state.user);
            state.server = null; Util.store('server', null);
            return listServers().then(function (servers) {
                var same = servers.filter(function (r) { return r.clientIdentifier === machineId; })[0] || servers[0];
                return same ? connect(same) : null;
            });
        });
    }

    /* ---------- servers ---------- */

    function listServers() {
        return request('GET', 'https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', { token: state.token })
            .then(function (res) {
                return (res || []).filter(function (r) { return (r.provides || '').indexOf('server') >= 0; });
            });
    }

    // Try the server's connections (local first, relay last) and keep the first that answers.
    function connect(resource) {
        var conns = (resource.connections || []).slice().sort(function (a, b) {
            return (a.relay - b.relay) || (b.local - a.local);
        });
        var token = resource.accessToken || state.token;
        var i = 0;
        function next() {
            if (i >= conns.length) return Promise.reject(new Error('Could not reach ' + resource.name + ' on any address'));
            var c = conns[i++];
            return request('GET', c.uri + '/identity', { token: token, timeout: 4000 }).then(function () {
                state.server = { name: resource.name, uri: c.uri, token: token, machineId: resource.clientIdentifier, relay: !!c.relay };
                Util.store('server', state.server);
                return state.server;
            }, next);
        }
        return next();
    }

    /* ---------- library ---------- */

    function api(path, params) {
        var p = params ? '?' + Util.qs(params) : '';
        return request('GET', state.server.uri + path + p, { token: state.server.token }).then(function (r) {
            return r.MediaContainer || {};
        });
    }

    function list(mc) { return mc.Metadata || []; }

    function sections() { return api('/library/sections').then(function (mc) { return mc.Directory || []; }); }
    // opts: { sort, unwatched, genre, start, size }
    function sectionItems(id, opts) {
        opts = opts || {};
        return api('/library/sections/' + id + '/all', {
            'X-Plex-Container-Start': opts.start || 0, 'X-Plex-Container-Size': opts.size || 500,
            sort: opts.sort || 'titleSort', unwatched: opts.unwatched ? 1 : null, genre: opts.genre || null,
            actor: opts.actor || null, director: opts.director || null, writer: opts.writer || null, producer: opts.producer || null,
            includeGuids: 1
        });
    }
    function recentlyAdded(id, size) {
        return api('/library/sections/' + id + '/recentlyAdded', { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size || 20, includeGuids: 1 }).then(list);
    }
    function genres(id) { return api('/library/sections/' + id + '/genre').then(function (mc) { return mc.Directory || []; }); }
    function collections(id) { return api('/library/sections/' + id + '/collections').then(list); }
    function onDeck() { return api('/library/onDeck', { includeGuids: 1 }).then(list); }
    // Chapters, intro/credits markers, extras (trailers) and the show's next-up episode come back in one call.
    function metadata(ratingKey) {
        return api('/library/metadata/' + ratingKey, {
            includeChapters: 1, includeMarkers: 1, includeExtras: 1, includeOnDeck: 1, includeGuids: 1
        }).then(function (mc) { return (mc.Metadata || [])[0]; });
    }
    function children(ratingKey) { return api('/library/metadata/' + ratingKey + '/children').then(list); }
    function similar(ratingKey) { return api('/library/metadata/' + ratingKey + '/similar', { count: 20 }).then(list).catch(function () { return []; }); }
    // Every movie and show in the movie and TV libraries that this person is credited on.
    // kind: 'actor' | 'director' | 'writer' | 'producer'
    function personItems(kind, tagId) {
        return sections().then(function (secs) {
            return Promise.all(secs.filter(function (s) { return s.type === 'movie' || s.type === 'show'; }).map(function (s) {
                var o = { sort: 'originallyAvailableAt:desc', size: 300 };
                o[kind] = tagId;
                return sectionItems(s.key, o).then(function (mc) { return mc.Metadata || []; }, function () { return []; });
            }));
        }).then(function (lists) { return [].concat.apply([], lists); });
    }
    function collectionItems(ratingKey) { return api('/library/collections/' + ratingKey + '/children').then(list); }

    function search(query) {
        return api('/hubs/search', { query: query, limit: 20, includeCollections: 1 }).then(function (mc) {
            var out = [];
            (mc.Hub || []).forEach(function (h) {
                if (['movie', 'show', 'episode', 'collection'].indexOf(h.type) >= 0) out = out.concat(h.Metadata || []);
            });
            return out;
        });
    }

    function markWatched(item, watched) {
        return request('GET', state.server.uri + '/:/' + (watched ? 'scrobble' : 'unscrobble') + '?' + Util.qs({
            key: item.ratingKey, identifier: 'com.plexapp.plugins.library'
        }), { token: state.server.token });
    }

    // Next episode after this one: the next in its season, else the first episode of the next season.
    function nextEpisode(ep) {
        if (!ep || ep.type !== 'episode') return Promise.resolve(null);
        return children(ep.parentRatingKey).then(function (eps) {
            var nxt = eps.filter(function (e) { return e.index > ep.index; }).sort(function (a, b) { return a.index - b.index; })[0];
            if (nxt) return nxt;
            return children(ep.grandparentRatingKey).then(function (seasons) {
                var ns = seasons.filter(function (s) { return s.index > ep.parentIndex; }).sort(function (a, b) { return a.index - b.index; })[0];
                return ns ? children(ns.ratingKey).then(function (e2) { return e2[0] || null; }) : null;
            });
        }).then(function (n) { return n ? metadata(n.ratingKey) : null; }).catch(function () { return null; });
    }

    /* ---------- artwork ---------- */

    function clearLogo(item) {
        var img = (item.Image || []).filter(function (i) { return i.type === 'clearLogo'; })[0];
        return img ? img.url : null;
    }

    function imageUrl(path, w, h) {
        if (!path || !state.server) return '';
        return state.server.uri + '/photo/:/transcode?' + Util.qs({
            width: w, height: h, minSize: 1, upscale: 1, url: path, 'X-Plex-Token': state.server.token
        });
    }

    /* ---------- playback ---------- */

    // Original file over HTTP: the TV's own demuxer and hardware decoders do the work (this is what keeps HDR10+ intact).
    function directPlayUrl(part) {
        return state.server.uri + part.key + '?' + Util.qs({ 'X-Plex-Token': state.server.token, 'X-Plex-Client-Identifier': clientId });
    }

    // Trick-play thumbnails (BIF), generated by the server when "video preview thumbnails" is on.
    function previewIndex(part) {
        if (!part || !/sd/.test(part.indexes || '')) return Promise.resolve(null);
        return request('GET', state.server.uri + '/library/parts/' + part.id + '/indexes/sd?' + Util.qs({ 'X-Plex-Token': state.server.token }),
            { responseType: 'arraybuffer', timeout: 60000 }).catch(function () { return null; });
    }

    // Sidecar (external) subtitle file, as text.
    function subtitleText(key) {
        var url = (/^https?:/.test(key) ? key : state.server.uri + key);
        return request('GET', url + (url.indexOf('?') >= 0 ? '&' : '?') + Util.qs({ 'X-Plex-Token': state.server.token }),
            { responseType: 'text' });
    }

    // Server-side subtitle search (the server's OpenSubtitles agent). Not verified against every server version.
    function searchSubtitles(item, language) {
        return api('/library/metadata/' + item.ratingKey + '/subtitles', { language: language, hearingImpaired: 0, forced: 0 })
            .then(function (mc) { return mc.Stream || []; });
    }
    function saveSubtitle(item, result) {
        return request('PUT', state.server.uri + '/library/metadata/' + item.ratingKey + '/subtitles?' + Util.qs({
            key: result.key, codec: result.codec, language: result.languageCode, hearingImpaired: result.hearingImpaired ? 1 : 0,
            forced: result.forced ? 1 : 0, providerTitle: result.providerTitle
        }), { token: state.server.token });
    }

    // Persist the chosen audio/subtitle stream on the server, so transcodes and other clients use the same tracks.
    function selectStreams(partId, audioStreamID, subtitleStreamID) {
        var p = { allParts: 1 };
        if (audioStreamID != null) p.audioStreamID = audioStreamID;
        if (subtitleStreamID != null) p.subtitleStreamID = subtitleStreamID;
        return request('PUT', state.server.uri + '/library/parts/' + partId + '?' + Util.qs(p), { token: state.server.token })
            .catch(function () { /* non-fatal */ });
    }

    // HLS with the video stream copied untouched and only the audio re-encoded (to E-AC3/AC3 the TV can output).
    function audioTranscodeUrl(item, mediaIndex, offsetMs, sessionId) {
        var extra = [
            'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=hevc,h264&audioCodec=eac3,ac3)',
            'add-limitation(scope=videoAudioCodec&scopeName=eac3&type=upperBound&name=audio.channels&value=6)'
        ].join('+');
        var p = baseParams();
        p['X-Plex-Token'] = state.server.token;
        p['X-Plex-Client-Profile-Name'] = 'Generic';
        p['X-Plex-Client-Profile-Extra'] = extra;
        p['X-Plex-Session-Identifier'] = sessionId;
        p.path = '/library/metadata/' + item.ratingKey;
        p.mediaIndex = mediaIndex || 0;
        p.partIndex = 0;
        p.protocol = 'hls';
        p.fastSeek = 1;
        p.directPlay = 0;
        p.directStream = 1;
        p.directStreamAudio = 0;
        p.videoQuality = 100;
        p.maxVideoBitrate = 400000;
        // The source resolution, so the server never scales the copied video down (an 8K file must stay 8K).
        var media = (item.Media || [])[mediaIndex || 0] || {};
        p.videoResolution = media.width && media.height ? media.width + 'x' + media.height : '7680x4320';
        p.offset = Math.floor((offsetMs || 0) / 1000);
        p.session = sessionId;
        return state.server.uri + '/video/:/transcode/universal/start.m3u8?' + Util.qs(p);
    }

    function stopTranscode(sessionId) {
        if (!state.server || !sessionId) return Promise.resolve();
        return request('GET', state.server.uri + '/video/:/transcode/universal/stop?' + Util.qs({ session: sessionId }),
            { token: state.server.token }).catch(function () {});
    }

    function timeline(item, playState, timeMs, durationMs) {
        return request('GET', state.server.uri + '/:/timeline?' + Util.qs({
            ratingKey: item.ratingKey, key: '/library/metadata/' + item.ratingKey,
            state: playState, time: Math.floor(timeMs), duration: Math.floor(durationMs)
        }), { token: state.server.token }).catch(function () {});
    }

    function scrobble(item) {
        return request('GET', state.server.uri + '/:/scrobble?' + Util.qs({
            key: item.ratingKey, identifier: 'com.plexapp.plugins.library'
        }), { token: state.server.token }).catch(function () {});
    }

    return {
        state: state,
        createPin: createPin, authUrl: authUrl, checkPin: checkPin, signOut: signOut, account: account,
        homeUsers: homeUsers, switchUser: switchUser,
        listServers: listServers, connect: connect,
        sections: sections, sectionItems: sectionItems, recentlyAdded: recentlyAdded, genres: genres, collections: collections,
        onDeck: onDeck, metadata: metadata, personItems: personItems, children: children, similar: similar, collectionItems: collectionItems,
        search: search, markWatched: markWatched, nextEpisode: nextEpisode,
        imageUrl: imageUrl, clearLogo: clearLogo,
        previewIndex: previewIndex, subtitleText: subtitleText, searchSubtitles: searchSubtitles, saveSubtitle: saveSubtitle,
        directPlayUrl: directPlayUrl, selectStreams: selectStreams, audioTranscodeUrl: audioTranscodeUrl,
        stopTranscode: stopTranscode, timeline: timeline, scrobble: scrobble
    };
})();
