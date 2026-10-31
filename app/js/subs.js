/* Sidecar text subtitles (SRT, WebVTT, ASS/SSA) parsed in the app and drawn by us, so they can be restyled and shifted in time. */
var Subs = (function () {
    'use strict';

    function ts(str) {
        var m = /(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?/.exec(str);
        if (!m) return NaN;
        var frac = m[4] ? parseInt((m[4] + '00').slice(0, 3), 10) : 0;
        return ((parseInt(m[1] || '0', 10) * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + frac;
    }

    // Keep only <i>, <b> and <u>; everything else is shown as text.
    function clean(text) {
        return Util.esc(text).replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>').replace(/&lt;\/?font[^&]*&gt;/gi, '');
    }

    function parseSrtVtt(raw) {
        var cues = [];
        raw.replace(/\r/g, '').split(/\n{2,}/).forEach(function (block) {
            var lines = block.split('\n');
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].indexOf('-->') >= 0) {
                    var parts = lines[i].split('-->');
                    var start = ts(parts[0]), end = ts(parts[1]);
                    var text = lines.slice(i + 1).join('\n').trim();
                    if (!isNaN(start) && !isNaN(end) && text) cues.push({ start: start, end: end, html: clean(text) });
                    return;
                }
            }
        });
        return cues;
    }

    function parseAss(raw) {
        var cues = [], fmt = null, inEvents = false;
        raw.replace(/\r/g, '').split('\n').forEach(function (line) {
            if (/^\[events\]/i.test(line)) { inEvents = true; return; }
            if (/^\[/.test(line)) { inEvents = false; return; }
            if (!inEvents) return;
            if (/^format:/i.test(line)) { fmt = line.slice(7).split(',').map(function (f) { return f.trim().toLowerCase(); }); return; }
            if (!/^dialogue:/i.test(line) || !fmt) return;
            var fields = line.slice(9).split(',');
            var rec = {};
            fmt.forEach(function (f, i) {
                rec[f] = i === fmt.length - 1 ? fields.slice(i).join(',') : (fields[i] || '').trim();
            });
            var text = (rec.text || '').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
            if (text) cues.push({ start: ts(rec.start), end: ts(rec.end), html: clean(text) });
        });
        return cues;
    }

    function parse(raw, codec) {
        var cues = /ass|ssa/i.test(codec || '') || /^\s*\[script info\]/i.test(raw) ? parseAss(raw) : parseSrtVtt(raw);
        return cues.sort(function (a, b) { return a.start - b.start; });
    }

    // HTML for every cue showing at time t (ms).
    function at(cues, t) {
        var lo = 0, hi = cues.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (cues[mid].start <= t) lo = mid + 1; else hi = mid; }
        var out = [];
        for (var i = lo - 1; i >= 0 && i >= lo - 8; i--) {
            if (cues[i].end > t) out.unshift(cues[i].html);
        }
        return out.join('<br>');
    }

    function isText(stream) { return /srt|subrip|ass|ssa|vtt|webvtt|mov_text|tx3g|text|smi/i.test(stream.codec || ''); }

    return { parse: parse, at: at, isText: isText, clean: clean };
})();
