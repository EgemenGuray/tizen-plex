/* Plex trick-play thumbnails: a BIF file is a header, a table of (timestamp, offset) pairs and the JPEGs back to back. */
var Bif = (function () {
    'use strict';

    var MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

    function parse(buf) {
        if (!buf || buf.byteLength < 64) return null;
        var dv = new DataView(buf);
        for (var i = 0; i < 8; i++) if (dv.getUint8(i) !== MAGIC[i]) return null;
        var count = dv.getUint32(12, true);
        var mult = dv.getUint32(16, true) || 1000;
        var frames = [];
        for (var n = 0; n < count; n++) {
            var at = 64 + n * 8;
            var t = dv.getUint32(at, true), off = dv.getUint32(at + 4, true), next = dv.getUint32(at + 12, true);
            if (t === 0xffffffff) break;
            frames.push({ time: t * mult, start: off, end: next });
        }
        return { buf: buf, frames: frames, url: null, shown: -1 };
    }

    // Object URL of the frame closest to ms (the previous one is released).
    function frameUrl(bif, ms) {
        if (!bif || !bif.frames.length) return null;
        var lo = 0, hi = bif.frames.length - 1;
        while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (bif.frames[mid].time <= ms) lo = mid; else hi = mid - 1; }
        if (lo === bif.shown) return bif.url;
        if (bif.url) URL.revokeObjectURL(bif.url);
        var f = bif.frames[lo];
        bif.url = URL.createObjectURL(new Blob([bif.buf.slice(f.start, f.end)], { type: 'image/jpeg' }));
        bif.shown = lo;
        return bif.url;
    }

    function release(bif) { if (bif && bif.url) URL.revokeObjectURL(bif.url); }

    return { parse: parse, frameUrl: frameUrl, release: release };
})();
