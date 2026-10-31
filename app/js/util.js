/* Small helpers shared by every module. */
var Util = (function () {
    'use strict';

    function store(key, value) {
        try {
            if (value === undefined) {
                var raw = localStorage.getItem('plexhdr.' + key);
                return raw === null ? null : JSON.parse(raw);
            }
            if (value === null) localStorage.removeItem('plexhdr.' + key);
            else localStorage.setItem('plexhdr.' + key, JSON.stringify(value));
        } catch (e) { /* storage unavailable: behave as empty */ }
        return null;
    }

    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function qs(params) {
        return Object.keys(params).filter(function (k) {
            return params[k] !== undefined && params[k] !== null;
        }).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&');
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function fmtTime(ms) {
        var s = Math.max(0, Math.floor((ms || 0) / 1000));
        var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    // "2 hr 15 min", "48 min"
    function fmtDuration(ms) {
        var m = Math.round((ms || 0) / 60000);
        if (!m) return '';
        var h = Math.floor(m / 60);
        return ((h ? h + ' hr ' : '') + (m % 60 ? m % 60 + ' min' : '')).trim();
    }

    function fmtClock(date) {
        var h = date.getHours(), m = date.getMinutes();
        return h + ':' + (m < 10 ? '0' : '') + m;
    }

    function debounce(fn, ms) {
        var t = null;
        return function () {
            var args = arguments, self = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(self, args); }, ms);
        };
    }

    var toastTimer = null;
    function toast(msg, ms) {
        var el = document.getElementById('toast');
        el.innerHTML = esc(msg);
        el.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 5000);
    }

    return {
        store: store, uuid: uuid, qs: qs, esc: esc, fmtTime: fmtTime, fmtDuration: fmtDuration,
        fmtClock: fmtClock, debounce: debounce, toast: toast
    };
})();
