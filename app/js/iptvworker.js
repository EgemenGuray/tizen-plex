/* Background worker for IPTV: downloads, parses and saves playlists and guides away from the thread that draws the
 * screen, then hands the result to the page in slices so no single copy blocks it for long. ES5 only. */
importScripts('iptvparse.js');

self.onmessage = function (e) {
    var m = e.data;
    IPTVParse.job(m.op, m.data).then(function (res) {
        if (m.op === 'm3u' || m.op === 'xtream') {
            var sp = IPTVParse.split(res);
            sp.parts.forEach(function (p) { self.postMessage({ id: m.id, part: p }); });
            res = sp.meta;
        }
        self.postMessage({ id: m.id, result: res });
    }).catch(function (err) {
        self.postMessage({ id: m.id, error: (err && err.message) || String(err), net: !!(err && err.net) });
    });
};
