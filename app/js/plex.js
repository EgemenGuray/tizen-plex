/* Plex API: plex.tv PIN sign-in, server discovery, library browsing, playback URLs, progress reporting. */
var Plex = (function () {
    'use strict';

    var PRODUCT = 'Plex HDR (Tizen)';
    var VERSION = '0.1.0';

    var clientId = Util.store('clientId');
    if (!clientId) { clientId = Util.uuid(); Util.store('clientId', clientId); }

    var state = {
        token: Util.store('token'),       // plex.tv account token
        server: Util.store('server')      // { name, uri, token, machineId }
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
            xhr.setRequestHeader('Accept', 'application/json');
            var h = baseParams();
            if (opts.token) h['X-Plex-Token'] = opts.token;
            Object.keys(h).forEach(function (k) { xhr.setRequestHeader(k, h[k]); });
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
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

    function createPin() {
        return request('POST', 'https://plex.tv/api/v2/pins?strong=false');
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
        state.token = null; state.server = null;
        Util.store('token', null); Util.store('server', null);
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

    function sections() { return api('/library/sections').then(function (mc) { return mc.Directory || []; }); }
    function sectionItems(id, start, size) {
        return api('/library/sections/' + id + '/all', {
            'X-Plex-Container-Start': start || 0, 'X-Plex-Container-Size': size || 200, sort: 'titleSort'
        });
    }
    function onDeck() { return api('/library/onDeck').then(function (mc) { return mc.Metadata || []; }); }
    function metadata(ratingKey) {
        return api('/library/metadata/' + ratingKey, { includeChapters: 1 }).then(function (mc) { return (mc.Metadata || [])[0]; });
    }
    function children(ratingKey) { return api('/library/metadata/' + ratingKey + '/children').then(function (mc) { return mc.Metadata || []; }); }

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
        p.maxVideoBitrate = 200000;
        p.videoResolution = '3840x2160';
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
        createPin: createPin, checkPin: checkPin, signOut: signOut,
        listServers: listServers, connect: connect,
        sections: sections, sectionItems: sectionItems, onDeck: onDeck, metadata: metadata, children: children,
        imageUrl: imageUrl,
        directPlayUrl: directPlayUrl, selectStreams: selectStreams, audioTranscodeUrl: audioTranscodeUrl,
        stopTranscode: stopTranscode, timeline: timeline, scrobble: scrobble
    };
})();
