/* What the TV remembers per title, on top of what Plex stores: the resume point (kept even if the server didn't get the
 * last progress report, or for a Plex Home user without sync), and the audio track, subtitle and downloaded
 * online subtitle you picked last time. */
var Memory = (function () {
    'use strict';

    var MAX = 400;
    var data = Util.store('memory') || {};
    var dirty = false;

    function flush() { if (dirty) { Util.store('memory', data); dirty = false; } }
    setInterval(flush, 5000);

    function key(item) { return (Plex.state.server ? Plex.state.server.machineId : '') + ':' + item.ratingKey; }
    function rec(item, create) {
        var k = key(item);
        if (!data[k] && create) {
            var all = Object.keys(data);
            if (all.length >= MAX) {
                all.sort(function (a, b) { return (data[a].at || 0) - (data[b].at || 0); });
                delete data[all[0]];
            }
            data[k] = {};
        }
        return data[k];
    }

    // Called during playback and on stop. Near the start or the end, there's nothing to resume.
    function savePosition(item, ms, durationMs) {
        var r = rec(item, true);
        r.at = r.posAt = Date.now();
        if (ms < 15000 || (durationMs && ms / durationMs > 0.92)) delete r.pos;
        else r.pos = Math.floor(ms);
        dirty = true;
    }
    function flushNow() { dirty = true; flush(); }

    // Use whichever is newer: the TV's own record or the server's.
    function resumeAt(item) {
        var r = rec(item, false);
        var server = item.viewOffset || 0;
        if (!r || r.posAt == null) return server;
        var serverAt = (item.lastViewedAt || 0) * 1000;
        if (r.posAt > serverAt + 30000) return r.pos || 0;
        return server;
    }

    function tracks(item) { return rec(item, false) || {}; }
    function setTracks(item, patch) {
        var r = rec(item, true);
        Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
        r.at = Date.now();
        dirty = true;
    }

    return { savePosition: savePosition, resumeAt: resumeAt, tracks: tracks, setTracks: setTracks, flush: flushNow };
})();
