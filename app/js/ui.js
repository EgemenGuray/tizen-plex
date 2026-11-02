/* Screens, focus navigation and the Apple TV-style browse UI (top shelf, artwork rows, sliding focus). */
var UI = (function () {
    'use strict';

    var app = function () { return document.getElementById('app'); };
    var stack = [];          // [{ render, focusIndex, tab }]
    var focused = null;
    var sheet = null;        // open modal sheet: { el, prev }
    var libs = null;         // movie and TV libraries, for the tab bar

    var DEFAULTS = {
        truehd: 'auto', audioLang: '', subtitles: 'forced', subLang: '', subSize: 'm', subColor: 'white', subBg: 'shadow',
        subPos: 'bottom', autoplay: true, autoSkipIntro: false, picture: 'letterbox', tmdbArt: true
    };
    var settings = Util.store('settings') || {};
    Object.keys(DEFAULTS).forEach(function (k) { if (settings[k] === undefined) settings[k] = DEFAULTS[k]; });
    function saveSettings() { Util.store('settings', settings); }

    /* ---------- focus ---------- */

    function scope() { return sheet ? sheet.el : app(); }
    function focusables() { return Array.prototype.slice.call(scope().querySelectorAll('.focusable')); }

    function focus(el) {
        if (!el) return;
        if (focused) focused.classList.remove('focused');
        focused = el;
        el.classList.add('focused');
        place(el);
        if (el._focus) el._focus();
    }

    // Rows (.hlist) move left/right through their own items, even ones scrolled off screen.
    function hlistOf(el) { return el.parentNode && el.parentNode.classList && el.parentNode.classList.contains('hlist') ? el.parentNode : null; }

    function move(dir) {
        if (!focused || !scope().contains(focused)) return focus(focusables()[0]);
        // A screen can name the next element itself (side-by-side lists in Live TV).
        if (focused._nav && focused._nav[dir]) { var to = focused._nav[dir](); if (to) return focus(to); }
        var hl = hlistOf(focused);
        if (hl && (dir === 'left' || dir === 'right')) {
            var sib = focused;
            do { sib = dir === 'left' ? sib.previousElementSibling : sib.nextElementSibling; } while (sib && !sib.classList.contains('focusable'));
            if (sib) focus(sib);
            else if (hl._edge) hl._edge(dir);
            return;
        }
        // Otherwise: the nearest element in the pressed direction, measured on screen.
        var a = focused.getBoundingClientRect();
        var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
        var cands = [];
        focusables().forEach(function (el) {
            if (el === focused || (hl && hlistOf(el) === hl)) return;
            var b = el.getBoundingClientRect();
            if (!b.width) return;
            var bx = b.left + b.width / 2, by = b.top + b.height / 2;
            var dx = bx - ax, dy = by - ay, main, cross;
            if (dir === 'left') { main = -dx; cross = Math.abs(dy); }
            else if (dir === 'right') { main = dx; cross = Math.abs(dy); }
            else if (dir === 'up') { main = -dy; cross = Math.abs(dx); }
            else { main = dy; cross = Math.abs(dx); }
            if (main > 4) cands.push({ el: el, main: main, cross: cross });
        });
        if (!cands.length) return;
        var best;
        if (dir === 'up' || dir === 'down') {
            // Up/down: go to the nearest row, then to the item in it closest to where we are.
            var near = Math.min.apply(null, cands.map(function (c) { return c.main; }));
            best = cands.filter(function (c) { return c.main <= near + 60; })
                .sort(function (a, b) { return a.cross - b.cross; })[0];
        } else {
            best = cands.sort(function (a, b) { return (a.main + a.cross * 3) - (b.main + b.cross * 3); })[0];
        }
        focus(best.el);
    }

    /* Slide rows and the page so the focused item sits in a steady place (transforms animate on the GPU). */
    function place(el) {
        var track = el.parentNode;
        if (track && track.classList.contains('track')) {
            var view = track.parentNode.clientWidth, margin = 90;
            var x = track._x || 0;
            var left = el.offsetLeft - x, right = left + el.offsetWidth;
            if (right > view - margin) x += right - (view - margin);
            if (left < margin) x -= margin - left;
            x = Math.max(0, Math.min(x, track.offsetWidth - view));
            track._x = x;
            track.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        }
        var page = el.closest('.page');
        if (page) {
            var anchor = el.closest('[data-anchor]');
            var y = 0;
            if (!anchor || anchor.getAttribute('data-anchor') !== 'top') {
                y = topIn(anchor || el, page) - (parseInt(page.getAttribute('data-offset'), 10) || 120);
            }
            var viewH = page.parentNode.clientHeight;
            y = Math.max(0, Math.min(y, page.offsetHeight - viewH + 60));
            page.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
            if (page.parentNode === app()) document.body.classList.toggle('scrolled', y > 0);
        }
    }

    function topIn(el, ancestor) {
        var y = 0;
        while (el && el !== ancestor) { y += el.offsetTop; el = el.offsetParent; }
        return y;
    }

    function refocus(id) { focus(scope().querySelector('[data-id="' + id + '"]') || focusables()[0]); }

    function select() { if (focused && focused._select) focused._select(); }

    /* ---------- backdrop ---------- */

    var bd = { cur: 0, url: null };
    function backdrop(url, mode) {
        var root = document.getElementById('backdrop');
        if (mode) root.className = 'bd-' + mode;
        if (url === bd.url) return;
        bd.url = url;
        var layers = root.querySelectorAll('.bd-layer');
        if (!url) { layers[0].classList.remove('on'); layers[1].classList.remove('on'); return; }
        var img = new Image();
        img.onload = function () {
            if (bd.url !== url) return;
            var next = layers[1 - bd.cur];
            next.style.backgroundImage = 'url("' + url + '")';
            next.classList.add('on');
            layers[bd.cur].classList.remove('on');
            bd.cur = 1 - bd.cur;
        };
        img.src = url;
    }
    function artOf(item) { return item.art || item.grandparentArt || item.parentArt || ''; }
    var softBackdrop = Util.debounce(function (item) {
        // A small image stretched to full screen reads as a soft blur, without a costly CSS filter.
        backdrop(Plex.imageUrl(artOf(item), 480, 270), 'dim');
    }, 350);

    /* ---------- building blocks ---------- */

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
    }

    function button(label, fn, cls, id) {
        var b = el('div', 'btn focusable ' + (cls || ''), label);
        b._select = fn;
        if (id) b.setAttribute('data-id', id);
        return b;
    }

    var lazyObs = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
            if (!e.isIntersecting) return;
            var t = e.target;
            t.style.backgroundImage = 'url("' + t.getAttribute('data-src') + '")';
            t.classList.add('loaded');
            lazyObs.unobserve(t);
        });
    }, { rootMargin: '400px 900px' }) : null;

    function lazyImg(cls, src) {
        var d = el('div', cls);
        if (!src) return d;
        if (lazyObs) { d.setAttribute('data-src', src); lazyObs.observe(d); }
        else { d.style.backgroundImage = 'url("' + src + '")'; d.classList.add('loaded'); }
        return d;
    }

    function epCode(it) { return 'S' + it.parentIndex + ', E' + it.index; }

    // kind: 'poster' (2:3), 'wide' (16:9), 'person' (round), 'chapter'
    function card(item, kind, onSelect, opts) {
        opts = opts || {};
        var c = el('div', 'card card-' + kind + ' focusable');
        var src, title = item.title, sub = '';
        if (kind === 'poster') {
            src = Plex.imageUrl(item.type === 'episode' ? item.grandparentThumb || item.parentThumb : item.thumb, 300, 450);
            if (item.type === 'episode') { title = item.grandparentTitle; sub = epCode(item); }
            else if (item.type === 'season') { sub = item.parentTitle || ''; }
            else if (item.type === 'show') { sub = item.childCount ? item.childCount + (item.childCount > 1 ? ' Seasons' : ' Season') : (item.year || ''); }
            else if (item.type === 'collection') { sub = item.childCount ? item.childCount + ' items' : 'Collection'; }
            else sub = item.year || '';
        } else if (kind === 'wide') {
            src = Plex.imageUrl(item.type === 'episode' ? item.thumb : (item.art || item.thumb), 560, 315);
            if (item.type === 'episode' && !opts.inShow) { title = item.grandparentTitle; sub = epCode(item) + ' · ' + item.title; }
            else if (item.type === 'episode') { title = item.index + '. ' + item.title; sub = Util.fmtDuration(item.duration); }
            else sub = item.year || Util.fmtDuration(item.duration);
            if (item.viewOffset && item.duration) sub = Util.fmtDuration(item.duration - item.viewOffset) + ' left' + (item.type === 'episode' && !opts.inShow ? ' · ' + epCode(item) : '');
        } else if (kind === 'person') {
            src = item.thumb ? Plex.imageUrl(item.thumb, 240, 240) : '';
            title = item.tag; sub = item.role || '';
        } else if (kind === 'chapter') {
            src = item.thumb ? Plex.imageUrl(item.thumb, 400, 225) : '';
            title = item.tag || ('Chapter ' + item.index); sub = Util.fmtTime(item.startTimeOffset);
        }
        var img = lazyImg('img', src);
        if (!src && kind === 'poster') {
            Online.artwork(item).then(function (a) {
                if (a && a.poster) { img.style.backgroundImage = 'url("' + a.poster + '")'; var f = img.querySelector('.fallback'); if (f) f.parentNode.removeChild(f); }
            });
        }
        if (kind === 'person' && !src) img.innerHTML = '<span>' + Util.esc((item.tag || '?').split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2)) + '</span>';
        if (kind === 'poster' && !src) img.innerHTML = '<span class="fallback">' + Util.esc(title) + '</span>';
        if (item.viewOffset && item.duration) {
            img.appendChild(el('div', 'bar', '<i style="width:' + Math.round(item.viewOffset / item.duration * 100) + '%"></i>'));
        } else if ((item.type === 'movie' || item.type === 'episode') && item.viewCount) {
            img.appendChild(el('div', 'watched', '✓'));
        } else if ((item.type === 'show' || item.type === 'season') && item.leafCount && item.viewedLeafCount < item.leafCount) {
            img.appendChild(el('div', 'unwatched', String(item.leafCount - (item.viewedLeafCount || 0))));
        }
        if (opts.current) c.classList.add('current');
        c.appendChild(img);
        c.appendChild(el('div', 'cap', '<div class="t">' + Util.esc(title) + '</div><div class="s">' + Util.esc(sub) + '</div>'));
        c._select = onSelect || function () { openItem(item); };
        if (kind === 'poster' || kind === 'wide') c._focus = function () { if (artOf(item)) softBackdrop(item); };
        return c;
    }

    function shelf(title, items, kind, opts) {
        var s = el('section', 'shelf shelf-' + kind);
        s.setAttribute('data-anchor', '');
        if (title) s.appendChild(el('h2', '', Util.esc(title)));
        var t = el('div', 'track hlist');
        items.forEach(function (it) { t.appendChild(card(it, kind, opts && opts.onSelect ? function () { opts.onSelect(it); } : null, opts)); });
        s.appendChild(t);
        return s;
    }

    function openItem(item) {
        if (item.type === 'show') push(function (p) { return showScreen(p, item.ratingKey); });
        else if (item.type === 'season') push(function (p) { return showScreen(p, item.parentRatingKey, item.ratingKey); });
        else if (item.type === 'collection') push(function (p) { return gridScreen(p, item.title, Plex.collectionItems(item.ratingKey)); });
        else push(function (p) { return detailsScreen(p, item.ratingKey); });
    }

    /* ---------- modal sheet ---------- */

    // rows: [{ header }] or [{ label, detail, checked, action, keep, id }]
    function openSheet(title, rows, opts) {
        opts = opts || {};
        closeSheet(true);
        var host = document.getElementById('sheet');
        host.innerHTML = '';
        var cardEl = el('div', 'sheet-card' + (opts.wide ? ' wide' : ''));
        cardEl.appendChild(el('h2', '', Util.esc(title)));
        if (opts.note) cardEl.appendChild(el('p', 'sheet-note', opts.note));
        var view = el('div', 'sheet-view');
        var list = el('div', 'page sheet-list');
        list.setAttribute('data-offset', '200');
        var first = null;
        rows.forEach(function (r) {
            if (r.header) { list.appendChild(el('div', 'sheet-header', Util.esc(r.header))); return; }
            if (r.html) { list.appendChild(el('div', 'sheet-text', r.html)); return; }
            var row = el('div', 'sheet-row focusable' + (r.disabled ? ' disabled' : ''),
                '<span class="check">' + (r.checked ? '✓' : '') + '</span><span class="lbl">' + Util.esc(r.label) +
                (r.detail ? '<small>' + Util.esc(r.detail) + '</small>' : '') + '</span>' + (r.value != null ? '<span class="val">' + Util.esc(r.value) + '</span>' : ''));
            if (r.id) row.setAttribute('data-id', r.id);
            row._select = function () {
                if (r.disabled) return;
                if (!r.keep) closeSheet();
                if (r.action) r.action();
            };
            if (r.checked && !first) first = row;
            list.appendChild(row);
        });
        view.appendChild(list);
        cardEl.appendChild(view);
        if (opts.footer) cardEl.appendChild(opts.footer);
        host.appendChild(cardEl);
        host.classList.remove('hidden');
        sheet = { el: cardEl, prev: focused, onClose: opts.onClose };
        if (focused) focused.classList.remove('focused');
        focused = null;
        focus(first || focusables()[0]);
    }

    function closeSheet(silent) {
        if (!sheet) return false;
        var prev = sheet.prev, onClose = sheet.onClose;
        sheet = null;
        var host = document.getElementById('sheet');
        host.classList.add('hidden');
        host.innerHTML = '';
        focused = null;
        if (!silent) {
            if (prev && app().contains(prev)) focus(prev);
            if (onClose) onClose();
        }
        return true;
    }

    // One-of-many choice on a sheet.
    function choose(title, options, current, cb, note) {
        openSheet(title, options.map(function (o) {
            return { label: o.label, detail: o.detail, checked: o.value === current, action: function () { cb(o.value); } };
        }), { note: note });
    }

    // Free text with the remote: a one-line keyboard with a shift key, for API keys and account names.
    function textEntry(title, value, cb, note) {
        var text = value || '', upper = false;
        var display = el('div', 'entry-display', '');
        var keys = el('div', 'track hlist keyboard');
        var wrap = el('div', 'entry-kb');
        wrap.appendChild(keys);
        function draw() {
            display.innerHTML = (text ? Util.esc(text) : '<span class="muted">Empty</span>') + '<i class="caret"></i>';
            Array.prototype.forEach.call(keys.children, function (k) {
                if (k.getAttribute('data-c')) k.textContent = upper ? k.getAttribute('data-c').toUpperCase() : k.getAttribute('data-c');
            });
        }
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_.@:/?=&%+~'.split('');
        ['⇧'].concat(chars).concat(['⌫', 'Clear', 'Done']).forEach(function (k) {
            var b = el('div', 'key focusable' + (k.length > 1 ? ' wide' : ''), k);
            if (k.length === 1 && k !== '⇧' && k !== '⌫') b.setAttribute('data-c', k);
            b._select = function () {
                if (k === '⇧') upper = !upper;
                else if (k === '⌫') text = text.slice(0, -1);
                else if (k === 'Clear') text = '';
                else if (k === 'Done') { closeSheet(); cb(text); return; }
                else text += upper ? k.toUpperCase() : k;
                draw();
            };
            keys.appendChild(b);
        });
        draw();
        var foot = el('div', 'entry-wrap');
        foot.appendChild(display);
        foot.appendChild(wrap);
        openSheet(title, [], { footer: foot, wide: true, note: note });
    }

    // Number pad for Plex Home PINs.
    function pinPad(title, cb) {
        var digits = '';
        var display = el('div', 'pin-display', '');
        var pad = el('div', 'hlist pin-pad');
        function draw() { display.textContent = digits ? digits.replace(/./g, '●') : '– – – –'; }
        '1234567890'.split('').concat(['⌫']).forEach(function (k) {
            var b = el('div', 'key focusable', k);
            b._select = function () {
                if (k === '⌫') digits = digits.slice(0, -1);
                else if (digits.length < 4) digits += k;
                draw();
                if (digits.length === 4) { closeSheet(); cb(digits); }
            };
            pad.appendChild(b);
        });
        draw();
        var foot = el('div', 'pin-wrap');
        foot.appendChild(display);
        foot.appendChild(pad);
        openSheet(title, [], { footer: foot });
    }

    /* ---------- screen plumbing ---------- */

    function push(render, tab) {
        if (stack.length) stack[stack.length - 1].focusIndex = focusables().indexOf(focused);
        stack.push({ render: render, focusIndex: -1, tab: tab });
        show();
    }

    function replace(render, tab) { stack = []; push(render, tab); }

    function back() {
        if (closeSheet()) return true;
        if (stack.length > 1) { stack.pop(); show(); return true; }
        if (stack[0] && stack[0].tab && stack[0].tab !== 'home' && Plex.state.token) { replace(homeScreen, 'home'); return true; }
        return false;
    }

    function show() {
        var top = stack[stack.length - 1];
        if (window.IPTVPlayer) IPTVPlayer.stopPreview();
        closeSheet(true);
        focused = null;
        document.body.classList.remove('scrolled');
        var page = el('div', 'page');
        var spinner = el('div', 'spinner');
        var root = app();
        root.innerHTML = '';
        root.appendChild(spinner);
        Promise.resolve().then(function () { return top.render(page); }).then(function () {
            if (stack[stack.length - 1] !== top) return;
            root.innerHTML = '';
            root.appendChild(page);
            var f = focusables();
            var idx = top.focusIndex;
            var tabEl = top.onTab && page.querySelector('.tab.active');
            focus(idx >= 0 && f[idx] ? f[idx] : (tabEl || page.querySelector('[data-autofocus]') || f[0]));
        }).catch(function (err) {
            if (stack[stack.length - 1] !== top) return;
            root.innerHTML = '';
            var box = el('div', 'page center-box');
            box.appendChild(el('h1', '', 'Something went wrong'));
            box.appendChild(el('p', 'bad', Util.esc(err.message || err)));
            var bl = el('div', 'hlist btn-row');
            bl.appendChild(button('Try Again', show, 'primary'));
            bl.appendChild(button('Change Server', function () { replace(serversScreen); }));
            box.appendChild(bl);
            root.appendChild(box);
            focus(focusables()[0]);
        });
    }

    /* ---------- tab bar ---------- */

    function ensureLibs() {
        if (libs) return Promise.resolve(libs);
        return Plex.sections().then(function (secs) {
            libs = secs.filter(function (s) { return s.type === 'movie' || s.type === 'show'; });
            return libs;
        });
    }

    function nav(active) {
        var bar = el('div', 'nav');
        bar.setAttribute('data-anchor', 'top');
        var tabs = el('div', 'tabs hlist');
        function tab(id, label, render) {
            var t = el('div', 'tab focusable' + (id === active ? ' active' : ''), Util.esc(label));
            t.setAttribute('data-id', 'tab-' + id);
            t._select = function () { if (id !== active) { replace(render, id); stack[0].onTab = true; } };
            tabs.appendChild(t);
        }
        if (Plex.state.token) tab('home', 'Home', homeScreen);
        tab('iptv', 'Live TV', function (p) { return IPTVUI.screen(p); });
        (libs || []).forEach(function (l) { tab('lib' + l.key, l.title, function (p) { return libraryScreen(p, l, true); }); });
        tab('search', 'Search', searchScreen);
        tab('settings', 'Settings', settingsScreen);
        bar.appendChild(tabs);
        var u = Plex.state.user;
        var right = el('div', 'nav-right', '<span class="clock">' + Util.fmtClock(new Date()) + '</span>');
        if (u) {
            var av = lazyImg('avatar', u.thumb || '');
            if (!u.thumb) av.textContent = (u.title || '?')[0];
            right.appendChild(av);
        }
        bar.appendChild(right);
        return bar;
    }

    setInterval(function () {
        var c = document.querySelectorAll('.clock');
        for (var i = 0; i < c.length; i++) c[i].textContent = Util.fmtClock(new Date());
    }, 15000);

    /* ---------- playback entry points ---------- */

    // item: full metadata. opts: { mediaIndex, audioId, sub (stream | null = off | undefined = default), at }
    // Without explicit choices, the audio track and subtitle you used last time for this title are picked again.
    function play(item, opts) {
        opts = opts || {};
        var mem = Memory.tracks(item);
        var mediaIndex = opts.mediaIndex != null ? opts.mediaIndex : (mem.mediaIndex || 0);
        if (!(item.Media || [])[mediaIndex]) mediaIndex = 0;
        var part0 = ((item.Media[mediaIndex] || {}).Part || [])[0];
        var has = function (type, id) { return Decide.streams(part0, type).filter(function (x) { return x.id === id; })[0]; };
        var audioId = opts.audioId != null ? opts.audioId : (mem.audioId != null && has(2, mem.audioId) ? mem.audioId : null);
        var plan = Decide.plan(item, mediaIndex, audioId, settings);
        if (!plan.part) { Util.toast('This item has no playable file.'); return; }
        var online = null;
        var sub = opts.sub;
        if (sub === undefined && mem.subId !== undefined) {
            if (mem.subId === 'online' && mem.online) { sub = null; online = mem.online; }
            else sub = mem.subId === null ? null : (has(3, mem.subId) || undefined);
        }
        if (sub === undefined) sub = Decide.chooseSubtitle(plan.part, plan.audio, settings);
        if (opts.audioId != null || opts.mediaIndex != null) Memory.setTracks(item, { audioId: plan.audio && plan.audio.id, mediaIndex: mediaIndex });
        if (opts.sub !== undefined) Memory.setTracks(item, { subId: opts.sub ? opts.sub.id : null, online: null });
        if (stack.length) stack[stack.length - 1].focusIndex = focusables().indexOf(focused);
        closeSheet(true);
        Plex.selectStreams(plan.part.id, plan.audio && plan.audio.id, sub ? sub.id : 0).then(function () {
            Player.start(item, plan, settings, opts.at || 0, { subtitle: sub, online: online, onExit: function () { show(); } });
        });
    }

    // From a card or hero: resolve shows to their next-up episode, resume where it was left.
    function playKey(ratingKey, fromStart) {
        Plex.metadata(ratingKey).then(function (item) {
            if (item.type === 'show') {
                var next = item.OnDeck && item.OnDeck.Metadata && item.OnDeck.Metadata[0];
                if (next) return playKey(next.ratingKey, false);
                return Plex.children(item.ratingKey).then(function (seasons) {
                    var s1 = seasons.filter(function (s) { return s.index > 0; })[0] || seasons[0];
                    return s1 && Plex.children(s1.ratingKey).then(function (eps) { if (eps[0]) playKey(eps[0].ratingKey, true); });
                });
            }
            play(item, { at: fromStart ? 0 : Memory.resumeAt(item) });
        }).catch(function (e) { Util.toast(e.message, 6000); });
    }

    /* ---------- sign-in and servers ---------- */

    var pinPoll = null;
    function signInScreen(page) {
        clearInterval(pinPoll);
        backdrop(null, 'plain');
        // Two PINs: the short code for plex.tv/link, and a strong one behind the QR code. Whichever is approved first wins.
        return Promise.all([Plex.createPin(false), Plex.createPin(true).catch(function () { return null; })]).then(function (pins) {
            var pin = pins[0], strong = pins[1];
            page.className = 'page center-box';
            page.appendChild(el('div', 'wordmark', 'Plex <b>HDR</b>'));
            var row = el('div', 'signin-row');
            var codeCol = el('div', 'signin-col');
            codeCol.appendChild(el('p', 'lead', 'On your phone or computer, go to <b>plex.tv/link</b> and enter'));
            codeCol.appendChild(el('div', 'pin', Util.esc(pin.code)));
            row.appendChild(codeCol);
            if (strong && window.qrcode) {
                var qr = qrcode(0, 'M');
                qr.addData(Plex.authUrl(strong.code));
                qr.make();
                var qrCol = el('div', 'signin-col');
                qrCol.appendChild(el('p', 'lead', 'Or scan with your phone'));
                qrCol.appendChild(el('div', 'qr', qr.createSvgTag({ cellSize: 8, margin: 32, scalable: true })));
                row.appendChild(el('div', 'signin-or', 'or'));
                row.appendChild(qrCol);
            }
            page.appendChild(row);
            page.appendChild(el('p', 'muted', 'This screen moves on by itself once you sign in.'));
            var bl = el('div', 'hlist btn-row');
            bl.appendChild(button('New Code', function () { replace(signInScreen); }));
            bl.appendChild(button('Live TV only (IPTV, no Plex)', function () { clearInterval(pinPoll); pinPoll = null; Util.store('iptv.only', true); replace(function (p) { return IPTVUI.screen(p); }, 'iptv'); }));
            page.appendChild(bl);
            var ids = [pin.id].concat(strong ? [strong.id] : []);
            pinPoll = setInterval(function () {
                ids.forEach(function (id) {
                    Plex.checkPin(id).then(function (token) {
                        if (token && pinPoll) { clearInterval(pinPoll); pinPoll = null; Plex.account().catch(function () {}); replace(serversScreen); }
                    }).catch(function () {});
                });
            }, 2000);
        });
    }

    function serversScreen(page) {
        backdrop(null, 'plain');
        libs = null;
        return Plex.listServers().then(function (servers) {
            page.className = 'page center-box';
            page.appendChild(el('h1', '', 'Choose a Server'));
            if (!servers.length) page.appendChild(el('p', 'warn', 'No Plex Media Server is linked to this account.'));
            var list = el('div', 'server-list');
            servers.forEach(function (srv) {
                var it = el('div', 'sheet-row focusable', '<span class="lbl">' + Util.esc(srv.name) + '<small>' +
                    (srv.owned ? 'Your server' : 'Shared with you') + (srv.presence ? '' : ' · may be offline') + '</small></span><span class="val"></span>');
                it._select = function () {
                    it.querySelector('.val').textContent = 'Connecting…';
                    Plex.connect(srv).then(function (s) {
                        if (s.relay) Util.toast('Connected through Plex Relay: bandwidth is limited, 4K direct play will stutter. Check that the TV can reach the server on your network.', 9000);
                        replace(homeScreen, 'home');
                    }, function (e) { Util.toast(e.message, 6000); it.querySelector('.val').textContent = 'Unreachable'; });
                };
                list.appendChild(it);
            });
            page.appendChild(list);
            var bl = el('div', 'hlist btn-row');
            bl.appendChild(button('Sign Out', function () { Plex.signOut(); replace(signInScreen); }));
            page.appendChild(bl);
            if (servers.length === 1 && !Plex.state.server) setTimeout(function () { list.firstChild._select(); }, 0);
        });
    }

    /* ---------- home: top shelf + rows ---------- */

    function metaLine(item) {
        var bits = [];
        if (item.type === 'episode') bits.push(epCode(item));
        if (item.year) bits.push(item.year);
        if (item.contentRating) bits.push('<span class="rating-box">' + Util.esc(item.contentRating) + '</span>');
        if (item.type === 'show' && item.childCount) bits.push(item.childCount + (item.childCount > 1 ? ' Seasons' : ' Season'));
        else if (item.duration) bits.push(Util.fmtDuration(item.duration));
        var g = (item.Genre || []).slice(0, 2).map(function (x) { return x.tag; }).join(', ');
        if (g) bits.push(Util.esc(g));
        return bits.map(function (b) { return typeof b === 'number' ? String(b) : b; }).join('<i class="dot">·</i>');
    }

    function titleBlock(item, big) {
        var logo = Plex.clearLogo(item.type === 'episode' ? {} : item);
        var showName = item.type === 'episode' ? '<div class="kicker">' + Util.esc(item.grandparentTitle) + '</div>' : '';
        if (logo) return showName + '<img class="logo' + (big ? ' big' : '') + '" src="' + Plex.imageUrl(logo, 900, 360) + '">';
        return showName + '<h1 class="title' + (big ? ' big' : '') + '">' + Util.esc(item.title) + '</h1>';
    }

    /* ---------- ratings and internet artwork ---------- */

    /* Rating chips: a logo drawn in SVG (no image files to ship) followed by the number.
     * Tomatometer and RT Audience change logo with the score, like Rotten Tomatoes does (fresh/rotten, upright/spilled);
     * Metacritic shows the critics' Metascore in a square and the user score in a circle, coloured by score. */
    var ICONS = {
        imdb: '<span class="logo-imdb">IMDb</span>',
        letterboxd: '<svg viewBox="0 0 42 16"><circle cx="8" cy="8" r="7" fill="#ff8000"/><circle cx="21" cy="8" r="7" fill="#00e054"/>' +
            '<circle cx="34" cy="8" r="7" fill="#40bcf4"/></svg>',
        fresh: '<svg viewBox="0 0 32 32"><circle cx="16" cy="18" r="12" fill="#fa320a"/><ellipse cx="12" cy="14" rx="4" ry="2.5" fill="#ff7a5c" opacity=".7"/>' +
            '<path d="M16 9l-3-4 2 .5L13 2l3.5 3L19 2l-1 3.5 4-1-4 3.5z" fill="#00912d"/></svg>',
        rotten: '<svg viewBox="0 0 32 32"><path d="M16 4l3 6 6-3-2 7 7 2-6 4 4 6-7-1-1 7-4-5-5 5-1-7-7 1 4-6-6-4 7-2-2-7 6 3z" fill="#0ac855"/></svg>',
        upright: '<svg viewBox="0 0 32 32"><circle cx="10" cy="9" r="5" fill="#ffd36b"/><circle cx="16" cy="6" r="5" fill="#ffe08a"/><circle cx="22" cy="9" r="5" fill="#ffd36b"/>' +
            '<path d="M5 12h22l-3 18H8z" fill="#fff"/><path d="M8.5 12h3l1 18h-2.5zM15 12h2v18h-2zM20.5 12h3l-2 18H19z" fill="#fa320a"/></svg>',
        spilled: '<svg viewBox="0 0 32 32"><g transform="rotate(-62 16 18)"><path d="M6 10h20l-3 18H9z" fill="#0ac855"/><path d="M9.5 10h3l1 18H11zM16 10h2v18h-2z" fill="#078a3a"/></g>' +
            '<circle cx="25" cy="27" r="3.5" fill="#ffe08a"/><circle cx="29" cy="23" r="2.5" fill="#ffd36b"/></svg>',
        metacritic: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#000" stroke="#ffbd3f" stroke-width="2"/>' +
            '<path d="M9 22l3.5-11 3.5 6 3.5-6L23 22h-3l-1.7-5.5L16 21l-2.3-4.5L12 22z" fill="#fff"/></svg>'
    };
    function tier(v, good, mid) { return v >= good ? 'good' : v >= mid ? 'mid' : 'low'; }
    var SCORES = [
        { key: 'imdb', name: 'IMDb', icon: function () { return ICONS.imdb; } },
        { key: 'letterboxd', name: 'Letterboxd', icon: function () { return ICONS.letterboxd; } },
        { key: 'rtCritic', name: 'Tomatometer', icon: function (v) { return parseInt(v, 10) >= 60 ? ICONS.fresh : ICONS.rotten; } },
        { key: 'rtAudience', name: 'RT Audience', icon: function (v) { return parseInt(v, 10) >= 60 ? ICONS.upright : ICONS.spilled; } },
        { key: 'metaUser', name: 'Metacritic', icon: function () { return ICONS.metacritic; },
            value: function (v) { return '<span class="mc-circle ' + tier(+v, 6.1, 4) + '">' + Util.esc(v) + '</span>'; } },
        { key: 'metaCritic', name: 'Metascore', icon: function () { return ICONS.metacritic; },
            value: function (v) { return '<span class="mc-square ' + tier(+v, 61, 40) + '">' + Util.esc(v) + '</span>'; } }
    ];
    function ratingsHtml(r) {
        if (!r) return '';
        return SCORES.filter(function (x) { return r[x.key]; }).map(function (x) {
            var v = r[x.key];
            return '<span class="score s-' + x.key + '"><i class="score-logo">' + x.icon(v) + '</i>' +
                (x.value ? x.value(v) : '<span class="score-num">' + Util.esc(v) + '</span>') +
                '<span class="score-name">' + x.name + '</span></span>';
        }).join('');
    }
    function fillRatings(container, item) {
        var host = container.querySelector('.ratings');
        if (!host) return;
        host.innerHTML = ratingsHtml(Online.plexRatings(item));
        Online.ratings(item).then(function (r) {
            var h = container.querySelector('.ratings');
            if (h) h.innerHTML = ratingsHtml(r);
        });
    }

    // Title logo, backdrop and poster from TMDB where Plex has none.
    function enhance(container, item, setBackdrop) {
        if (item.type !== 'movie' && item.type !== 'show') return;
        Online.artwork(item).then(function (a) {
            if (!a) return;
            var h = container.querySelector('h1.title');
            if (a.logo && h && !Plex.clearLogo(item)) {
                var img = new Image();
                img.className = h.className.replace('title', 'logo');
                img.onload = function () { if (h.parentNode) h.parentNode.replaceChild(img, h); };
                img.src = a.logo;
            }
            if (setBackdrop && !artOf(item) && a.backdrop) backdrop(a.backdrop, 'details');
        });
    }

    function hero(items) {
        var h = el('section', 'hero');
        h.setAttribute('data-anchor', 'top');
        var body = el('div', 'hero-body');
        var btns = el('div', 'hlist btn-row');
        var dots = el('div', 'dots');
        h.appendChild(body); h.appendChild(btns); h.appendChild(dots);
        var i = 0, timer = null;

        function render(dirClass) {
            var it = items[i];
            body.className = 'hero-body ' + (dirClass || '');
            void body.offsetWidth;   // restart the fade
            body.classList.add('in');
            body.innerHTML = titleBlock(it, true) + '<div class="meta">' + metaLine(it) + '</div>' +
                '<div class="ratings">' + ratingsHtml(Online.plexRatings(it)) + '</div>' +
                '<p class="summary clamp3">' + Util.esc(it.summary || '') + '</p>';
            enhance(body, it);
            var focusIdx = focused && btns.contains(focused) ? Array.prototype.indexOf.call(btns.children, focused) : -1;
            btns.innerHTML = '';
            var resume = it.viewOffset && it.duration;
            btns.appendChild(button('<span class="ico">▶</span>' + (resume ? 'Resume' : 'Play'), function () { playKey(it.ratingKey, false); }, 'primary'));
            btns.appendChild(button('More Info', function () { openItem(it); }));
            dots.innerHTML = items.map(function (_, n) { return '<i' + (n === i ? ' class="on"' : '') + '></i>'; }).join('');
            Array.prototype.forEach.call(btns.children, function (b) {
                b._focus = function () { backdrop(Plex.imageUrl(artOf(it), 1920, 1080), 'hero'); arm(); };
            });
            if (focusIdx >= 0) focus(btns.children[Math.min(focusIdx, btns.children.length - 1)]);
            else if (!focused || !app().contains(focused) || focused.closest('.hero')) backdrop(Plex.imageUrl(artOf(it), 1920, 1080), 'hero');
        }
        function step(d) { i = (i + d + items.length) % items.length; render(d > 0 ? 'from-right' : 'from-left'); }
        function arm() {
            clearTimeout(timer);
            timer = setTimeout(function () {
                if (!document.body.contains(h) || Player.active()) return;
                if (focused && btns.contains(focused) && !sheet) step(1); else arm();
            }, 9000);
        }
        btns._edge = function (dir) { if (items.length > 1) step(dir === 'right' ? 1 : -1); };
        render();
        return h;
    }

    function homeScreen(page) {
        return ensureLibs().then(function (ls) {
            var reqs = [Plex.onDeck().catch(function () { return []; })].concat(ls.map(function (l) {
                return Plex.recentlyAdded(l.key, 24).catch(function () { return []; });
            }));
            if (!Plex.state.user) reqs.push(Plex.account().catch(function () { return null; }));
            return Promise.all(reqs).then(function (r) {
                var deck = r[0];
                page.appendChild(nav('home'));
                var seen = {}, heroItems = [];
                function addHero(it) {
                    var key = it.type === 'episode' ? it.grandparentRatingKey : it.ratingKey;
                    if (seen[key] || !artOf(it) || heroItems.length >= 7) return;
                    seen[key] = 1; heroItems.push(it);
                }
                deck.slice(0, 2).forEach(addHero);
                ls.forEach(function (l, n) { r[n + 1].slice(0, 4).forEach(addHero); });
                if (heroItems.length) page.appendChild(hero(heroItems));
                else backdrop(null, 'plain');
                if (deck.length) page.appendChild(shelf('Continue Watching', deck, 'wide'));
                ls.forEach(function (l, n) {
                    if (r[n + 1].length) page.appendChild(shelf('Recently Added in ' + l.title, r[n + 1], 'poster'));
                });
                if (!deck.length && !ls.length) page.appendChild(el('p', 'muted pad', 'No movie or TV libraries on this server.'));
                var first = page.querySelector('.hero .btn');
                if (first) first.setAttribute('data-autofocus', '');
            });
        });
    }

    /* ---------- libraries ---------- */

    var SORTS = [
        { value: 'titleSort', label: 'Title' },
        { value: 'addedAt:desc', label: 'Date Added' },
        { value: 'originallyAvailableAt:desc', label: 'Release Date' },
        { value: 'audienceRating:desc', label: 'Rating' },
        { value: 'lastViewedAt:desc', label: 'Recently Watched' }
    ];
    var libState = {};

    function libraryScreen(page, sec, isTab) {
        var st = libState[sec.key] || (libState[sec.key] = { sort: sec.type === 'movie' ? 'originallyAvailableAt:desc' : 'titleSort', unwatched: false, genre: null, genreTitle: 'All Genres', view: 'all' });
        backdrop(null, 'plain');
        return ensureLibs().then(function () {
            if (isTab) page.appendChild(nav('lib' + sec.key));
            var head = el('div', 'lib-head');
            head.setAttribute('data-anchor', 'top');
            var pills = el('div', 'hlist pills');
            var sortLabel = SORTS.filter(function (s) { return s.value === st.sort; })[0].label;
            pills.appendChild(button('Sort: ' + sortLabel, function () {
                choose('Sort By', SORTS, st.sort, function (v) { st.sort = v; show(); });
            }, 'pill', 'p-sort'));
            pills.appendChild(button((st.unwatched ? '● ' : '') + 'Unwatched', function () { st.unwatched = !st.unwatched; show(); }, 'pill' + (st.unwatched ? ' on' : ''), 'p-unw'));
            pills.appendChild(button(Util.esc(st.genreTitle), function () {
                Plex.genres(sec.key).then(function (gs) {
                    choose('Genre', [{ value: null, label: 'All Genres' }].concat(gs.map(function (g) { return { value: g.key, label: g.title }; })), st.genre, function (v) {
                        st.genre = v;
                        st.genreTitle = v ? gs.filter(function (g) { return g.key === v; })[0].title : 'All Genres';
                        show();
                    });
                });
            }, 'pill' + (st.genre ? ' on' : ''), 'p-genre'));
            pills.appendChild(button('Collections', function () { st.view = st.view === 'collections' ? 'all' : 'collections'; show(); }, 'pill' + (st.view === 'collections' ? ' on' : ''), 'p-coll'));
            head.appendChild(el('h1', 'page-title', Util.esc(sec.title) + ' <span class="count"></span>'));
            head.appendChild(pills);
            page.appendChild(head);
            page.setAttribute('data-offset', '320');

            var grid = el('div', 'grid');
            page.appendChild(grid);
            if (st.view === 'collections') {
                return Plex.collections(sec.key).then(function (cs) {
                    head.querySelector('.count').textContent = cs.length;
                    cs.forEach(function (c) { grid.appendChild(card(c, 'poster')); });
                    if (!cs.length) page.appendChild(el('p', 'muted pad', 'No collections in this library.'));
                });
            }
            // Load in pages so big libraries open quickly; more is fetched as focus nears the end.
            var PAGE = 120, loaded = 0, total = Infinity, loading = false;
            function more() {
                if (loading || loaded >= total) return Promise.resolve();
                loading = true;
                return Plex.sectionItems(sec.key, { sort: st.sort, unwatched: st.unwatched, genre: st.genre, start: loaded, size: PAGE }).then(function (mc) {
                    loading = false;
                    var items = mc.Metadata || [];
                    total = mc.totalSize != null ? mc.totalSize : loaded + items.length;
                    head.querySelector('.count').textContent = total;
                    items.forEach(function (it, n) {
                        var c = card(it, 'poster');
                        var at = loaded + n;
                        var f = c._focus;
                        c._focus = function () { if (f) f(); if (at > loaded - 21) more(); };
                        grid.appendChild(c);
                    });
                    loaded += items.length;
                    if (!items.length) total = loaded;
                }, function (e) { loading = false; throw e; });
            }
            return more().then(function () {
                if (!loaded) page.appendChild(el('p', 'muted pad', 'Nothing here with these filters.'));
            });
        });
    }

    function gridScreen(page, title, promise) {
        return promise.then(function (items) {
            page.appendChild(el('h1', 'page-title top-pad', Util.esc(title)));
            page.setAttribute('data-offset', '240');
            var grid = el('div', 'grid');
            items.forEach(function (it) { grid.appendChild(card(it, 'poster')); });
            page.appendChild(grid);
            if (!items.length) page.appendChild(el('p', 'muted pad', 'Nothing found.'));
        });
    }

    // Everything in the movie and TV libraries this person is credited on, in any role.
    function personScreen(page, person) {
        backdrop(null, 'plain');
        var kinds = person.kinds || [person.kind || 'actor'];
        return Promise.all(kinds.map(function (k) { return Plex.personItems(k, person.id); })).then(function (lists) {
            var seen = {}, items = [];
            [].concat.apply([], lists).forEach(function (it) { if (!seen[it.ratingKey]) { seen[it.ratingKey] = 1; items.push(it); } });
            items.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
            var head = el('section', 'person-head');
            head.setAttribute('data-anchor', 'top');
            var face = lazyImg('person-face', person.thumb ? Plex.imageUrl(person.thumb, 300, 300) : '');
            if (!person.thumb) face.textContent = (person.tag || '?').split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2);
            head.appendChild(face);
            head.appendChild(el('div', 'person-text', '<h1 class="page-title">' + Util.esc(person.tag) + '</h1><div class="meta">' +
                Util.esc(person.roles.join(' · ')) + '<i class="dot">·</i>' + items.length + (items.length === 1 ? ' title' : ' titles') + ' in your library</div>'));
            page.appendChild(head);
            page.setAttribute('data-offset', '300');
            var grid = el('div', 'grid');
            items.forEach(function (it) { grid.appendChild(card(it, 'poster')); });
            page.appendChild(grid);
            if (!items.length) page.appendChild(el('p', 'muted pad', 'Nothing else in your library.'));
        });
    }

    // Apple TV-style Cast & Crew: actors with their characters, then directors, writers and producers.
    function people(item) {
        var out = [], byId = {};
        function add(list, kind, label) {
            (list || []).forEach(function (p) {
                var id = p.id || p.tag;
                var caption = kind === 'actor' ? (p.role || 'Actor') : label;
                if (byId[id]) {
                    // Same person in two roles (e.g. writer-director): one card, both roles.
                    byId[id].role += ', ' + label; byId[id].kinds.push(kind); byId[id].roles.push(label);
                    return;
                }
                var person = { id: p.id, tag: p.tag, thumb: p.thumb, role: caption, kind: kind, kinds: [kind], roles: [kind === 'actor' ? 'Actor' : label] };
                byId[id] = person;
                out.push(person);
            });
        }
        add(item.Role, 'actor', 'Actor');
        add(item.Director, 'director', 'Director');
        add(item.Writer, 'writer', 'Writer');
        add(item.Producer, 'producer', 'Producer');
        return out;
    }

    function castShelf(item) {
        var ppl = people(item);
        if (!ppl.length) return null;
        return shelf('Cast & Crew', ppl, 'person', {
            onSelect: function (p) {
                if (p.id) push(function (pg) { return personScreen(pg, p); });
                else Util.toast('Plex has no ID for ' + p.tag + ', so their other titles can\'t be listed.');
            }
        });
    }

    /* ---------- show page ---------- */

    function showScreen(page, ratingKey, seasonKey) {
        return Promise.all([Plex.metadata(ratingKey), Plex.children(ratingKey), Plex.similar(ratingKey)]).then(function (r) {
            var show = r[0], seasons = r[1], similar = r[2];
            backdrop(Plex.imageUrl(artOf(show), 1920, 1080), 'details');
            var onDeck = show.OnDeck && show.OnDeck.Metadata && show.OnDeck.Metadata[0];
            var top = el('section', 'detail-hero');
            top.setAttribute('data-anchor', 'top');
            top.innerHTML = titleBlock(show, true) + '<div class="meta">' + metaLine(show) + '</div>' +
                '<div class="ratings"></div>' +
                '<p class="summary clamp3">' + Util.esc(show.summary || '') + '</p>';
            fillRatings(top, show);
            enhance(top, show, true);
            var btns = el('div', 'hlist btn-row');
            var playLabel = onDeck ? (onDeck.viewOffset ? 'Resume ' : 'Play ') + epCode(onDeck) : 'Play';
            var pb = button('<span class="ico">▶</span>' + playLabel, function () { playKey(onDeck ? onDeck.ratingKey : show.ratingKey, false); }, 'primary');
            pb.setAttribute('data-autofocus', '');
            btns.appendChild(pb);
            var allWatched = show.leafCount && show.viewedLeafCount >= show.leafCount;
            btns.appendChild(button(allWatched ? 'Mark Unwatched' : 'Mark Watched', function () {
                Plex.markWatched(show, !allWatched).then(show_, function (e) { Util.toast(e.message); });
            }));
            top.appendChild(btns);
            page.appendChild(top);

            var seasonRow = el('section', 'shelf season-shelf');
            seasonRow.setAttribute('data-anchor', '');
            var pills = el('div', 'hlist pills');
            seasonRow.appendChild(pills);
            page.appendChild(seasonRow);
            var epHost = el('div', 'ep-host');
            page.appendChild(epHost);

            var current = seasonKey || (onDeck && onDeck.parentRatingKey) || (seasons.filter(function (s) { return s.index > 0; })[0] || seasons[0] || {}).ratingKey;
            var token = 0;
            function loadSeason(key) {
                var my = ++token;
                Array.prototype.forEach.call(pills.children, function (p) { p.classList.toggle('on', p.getAttribute('data-key') === key); });
                return Plex.children(key).then(function (eps) {
                    if (my !== token) return;
                    var s = shelf('', eps, 'wide', { inShow: true });
                    s.classList.add('episodes');
                    epHost.innerHTML = '';
                    epHost.appendChild(s);
                });
            }
            var pickSeason = Util.debounce(function (key) { if (key !== current) { current = key; loadSeason(key); } }, 300);
            seasons.forEach(function (s) {
                var p = button(Util.esc(s.title), function () { current = s.ratingKey; loadSeason(s.ratingKey); }, 'pill');
                p.setAttribute('data-key', s.ratingKey);
                p._focus = function () { pickSeason(s.ratingKey); };
                pills.appendChild(p);
            });
            var cast = castShelf(show);
            if (cast) page.appendChild(cast);
            if (similar.length) page.appendChild(shelf('More Like This', similar, 'poster'));
            return current ? loadSeason(current) : null;
        });
        function show_() { show(); }
    }

    /* ---------- details (movie / episode) ---------- */

    function detailsScreen(page, ratingKey) {
        return Plex.metadata(ratingKey).then(function (item) {
            var mem = Memory.tracks(item);
            var st = { mediaIndex: (item.Media || [])[mem.mediaIndex] ? mem.mediaIndex : 0, audioId: mem.audioId != null ? mem.audioId : null, sub: undefined };
            var extras = (item.Extras && item.Extras.Metadata) || [];
            var trailer = extras.filter(function (x) { return x.subtype === 'trailer' || x.extraType === 1; })[0];
            backdrop(Plex.imageUrl(artOf(item), 1920, 1080), 'details');

            var top = el('section', 'detail-hero');
            top.setAttribute('data-anchor', 'top');
            page.appendChild(top);

            function planOf() { return Decide.plan(item, st.mediaIndex, st.audioId, settings); }
            function subOf(plan) {
                if (st.sub !== undefined) return st.sub;
                if (mem.subId === 'online' && mem.online) return { displayTitle: 'downloaded (' + (mem.online.language || '').toUpperCase() + ')', online: true };
                if (mem.subId === null) return null;
                var m = Decide.streams(plan.part, 3).filter(function (x) { return x.id === mem.subId; })[0];
                return m || Decide.chooseSubtitle(plan.part, plan.audio, settings);
            }

            function render() {
                var plan = planOf();
                var sub = subOf(plan);
                var focusId = focused && top.contains(focused) ? focused.getAttribute('data-id') : null;
                var badges = Decide.badges(plan).map(function (b) { return '<span class="badge">' + Util.esc(b) + '</span>'; }).join('');
                var route = plan.mode === 'direct'
                    ? '<span class="good">● Direct play</span> · ' + Util.esc(Decide.audioLabel(plan.audio)) + ' sent as-is'
                    : '<span class="warn">● Video untouched, audio converted</span> · ' + Util.esc(Decide.audioLabel(plan.audio)) + ' → E-AC3 5.1';
                var notes = (plan.audioReason ? [plan.audioReason] : []).concat(plan.warnings);
                top.innerHTML = titleBlock(item, true) +
                    (item.type === 'episode' ? '<h2 class="ep-title">' + Util.esc(item.title) + '</h2>' : '') +
                    '<div class="meta">' + metaLine(item) + '</div>' +
                    '<div class="badges">' + badges + '</div>' +
                    '<div class="ratings"></div>' +
                    '<p class="summary clamp3">' + Util.esc(item.summary || '') + '</p>' +
                    '<div class="route">' + route + (sub ? ' · Subtitles: ' + Util.esc(sub.displayTitle || sub.language || 'on') : '') + '</div>' +
                    (notes.length ? '<div class="notes">' + notes.map(function (n) { return '<div>' + Util.esc(n) + '</div>'; }).join('') + '</div>' : '');
                fillRatings(top, item);
                enhance(top, item, true);
                var btns = el('div', 'hlist btn-row');
                var resumeAt = Memory.resumeAt(item);
                var opts = function (at) { return { mediaIndex: st.mediaIndex, audioId: st.audioId, sub: st.sub, at: at }; };
                btns.appendChild(button('<span class="ico">▶</span>' + (resumeAt ? 'Resume ' + Util.fmtTime(resumeAt) : 'Play'), function () { play(item, opts(resumeAt)); }, 'primary', 'play'));
                if (resumeAt) btns.appendChild(button('Start Over', function () { play(item, opts(0)); }, '', 'restart'));
                if (trailer) btns.appendChild(button('Trailer', function () { playKey(trailer.ratingKey, true); }, '', 'trailer'));
                btns.appendChild(button('Audio & Subtitles', function () { tracksSheet(plan, sub); }, '', 'tracks'));
                if ((item.Media || []).length > 1) btns.appendChild(button('Version ' + (st.mediaIndex + 1) + ' of ' + item.Media.length, versionsSheet, '', 'version'));
                btns.appendChild(button(item.viewCount ? '✓ Watched' : 'Mark Watched', function () {
                    Plex.markWatched(item, !item.viewCount).then(function () {
                        item.viewCount = item.viewCount ? 0 : 1; item.viewOffset = 0; render();
                    }, function (e) { Util.toast(e.message); });
                }, '', 'watched'));
                btns.appendChild(button('Info', function () { infoSheet(item, plan); }, '', 'info'));
                top.appendChild(btns);
                if (focusId) refocus(focusId);
                else btns.firstChild.setAttribute('data-autofocus', '');
            }

            function tracksSheet(plan, sub) {
                var rows = [{ header: 'Audio' }];
                Decide.streams(plan.part, 2).forEach(function (a) {
                    rows.push({ label: Decide.audioLabel(a), detail: trackNote(a), checked: a === plan.audio, action: function () { st.audioId = a.id; render(); } });
                });
                rows.push({ header: 'Subtitles' });
                rows.push({ label: 'Off', checked: !sub, action: function () { st.sub = null; render(); } });
                Decide.streams(plan.part, 3).forEach(function (t) {
                    var img = Decide.isImageSub(t);
                    rows.push({
                        label: t.extendedDisplayTitle || t.displayTitle || t.codec, checked: sub === t, disabled: img,
                        detail: img ? 'Image subtitles can\'t be shown without re-encoding the video' : (t.key ? 'External file' : 'Embedded'),
                        action: function () { st.sub = t; render(); }
                    });
                });
                openSheet('Audio & Subtitles', rows);
            }

            function versionsSheet() {
                openSheet('Version', item.Media.map(function (m, i) {
                    var p = Decide.plan(item, i, null, settings);
                    return {
                        label: [(m.videoResolution || '').toUpperCase(), (m.videoCodec || '').toUpperCase(), p.hdr.split(' (')[0]].filter(Boolean).join(' · '),
                        detail: Decide.audioLabel(p.audio) + ' · ' + Math.round((m.bitrate || 0) / 1000) + ' Mbps' + (p.warnings.length ? ' · ' + p.warnings[0] : ''),
                        checked: i === st.mediaIndex,
                        action: function () { st.mediaIndex = i; st.audioId = null; st.sub = undefined; render(); }
                    };
                }));
            }

            render();

            var chapters = item.Chapter || [];
            if (chapters.length > 1) {
                page.appendChild(shelf('Chapters', chapters, 'chapter', { onSelect: function (c) { play(item, { mediaIndex: st.mediaIndex, audioId: st.audioId, sub: st.sub, at: c.startTimeOffset }); } }));
            }
            var tail = [];
            if (item.type === 'episode') {
                tail.push(Plex.children(item.parentRatingKey).then(function (eps) {
                    if (eps.length > 1) {
                        var s = shelf('Season ' + item.parentIndex, eps, 'wide', { inShow: true });
                        Array.prototype.forEach.call(s.querySelectorAll('.card'), function (c, i) {
                            if (eps[i].ratingKey === item.ratingKey) c.classList.add('current');
                            c._select = function () {
                                stack[stack.length - 1] = { render: function (p) { return detailsScreen(p, eps[i].ratingKey); }, focusIndex: -1 };
                                show();
                            };
                        });
                        return s;
                    }
                }).catch(function () { return null; }));
            } else tail.push(Promise.resolve(null));
            tail.push(Promise.resolve(castShelf(item)));
            tail.push(Promise.resolve(extras.length ? shelf('Extras', extras, 'wide', { onSelect: function (x) { playKey(x.ratingKey, true); } }) : null));
            tail.push(item.type === 'movie' ? Plex.similar(item.ratingKey).then(function (s) { return s.length ? shelf('More Like This', s, 'poster') : null; }) : Promise.resolve(null));
            return Promise.all(tail).then(function (shelves) { shelves.forEach(function (s) { if (s) page.appendChild(s); }); });
        });
    }

    function trackNote(a) {
        if (/^dca|^dts/i.test(a.codec || '')) return 'DTS: server converts to E-AC3 5.1';
        if (Decide.isTrueHd(a)) return settings.truehd === 'transcode' ? 'TrueHD: converted to E-AC3 5.1' : 'TrueHD: passthrough depends on TV firmware';
        if (a.codec === 'eac3' && Decide.isAtmos(a)) return 'Passes through to the soundbar as Atmos';
        return '';
    }

    function infoSheet(item, plan) {
        var m = plan.media, v = plan.video, a = plan.audio;
        var rows = [
            ['File', (m.container || '?').toUpperCase() + ' · ' + Math.round((m.bitrate || 0) / 1000) + ' Mbps' + (plan.part && plan.part.size ? ' · ' + (plan.part.size / 1073741824).toFixed(1) + ' GB' : '')],
            ['Video', v ? (v.extendedDisplayTitle || v.displayTitle || v.codec) : '?'],
            ['HDR', plan.hdr],
            ['Frame rate', v && v.frameRate ? v.frameRate + ' fps (the TV plays it at the native rate)' : '?'],
            ['Audio', Decide.audioLabel(a) + (plan.mode === 'direct' ? ' → sent as-is' : ' → E-AC3 5.1 by the server')],
            ['Plan', plan.mode === 'direct' ? 'Direct play: the TV decodes the original file' : 'Video copied untouched, audio converted'],
            ['Player', Player.engineName()]
        ];
        var html = rows.map(function (r) { return '<div class="kv"><b>' + Util.esc(r[0]) + '</b><span>' + Util.esc(r[1]) + '</span></div>'; }).join('') +
            (plan.audioReason ? '<p class="muted">' + Util.esc(plan.audioReason) + '</p>' : '') +
            plan.warnings.map(function (w) { return '<p class="warn">' + Util.esc(w) + '</p>'; }).join('');
        openSheet('Playback Info', [{ html: html }, { label: 'Close' }], { wide: true });
    }

    /* ---------- search ---------- */

    var searchState = { q: '', results: [] };
    function searchScreen(page) {
        backdrop(null, 'plain');
        return ensureLibs().then(function () {
            page.appendChild(nav('search'));
            page.setAttribute('data-offset', '380');
            var box = el('section', 'search-box');
            box.setAttribute('data-anchor', 'top');
            var q = el('div', 'search-q');
            var keys = el('div', 'track hlist keyboard');
            var kbWrap = el('div', 'kb-wrap');
            kbWrap.appendChild(keys);
            box.appendChild(q);
            box.appendChild(kbWrap);
            page.appendChild(box);
            var grid = el('div', 'grid');
            page.appendChild(grid);

            function drawQ() { q.innerHTML = searchState.q ? Util.esc(searchState.q) + '<i class="caret"></i>' : '<span class="muted">Movies, shows, episodes, collections</span><i class="caret"></i>'; }
            function drawResults() {
                grid.innerHTML = '';
                searchState.results.forEach(function (it) { grid.appendChild(card(it, 'poster')); });
                if (searchState.q.length > 1 && !searchState.results.length) grid.appendChild(el('p', 'muted', 'No results'));
            }
            var run = Util.debounce(function () {
                var term = searchState.q;
                if (term.length < 2) { searchState.results = []; drawResults(); return; }
                Plex.search(term).then(function (res) {
                    if (term !== searchState.q) return;
                    searchState.results = res; drawResults();
                }).catch(function (e) { Util.toast(e.message); });
            }, 450);
            'abcdefghijklmnopqrstuvwxyz1234567890'.split('').concat(['space', '⌫', 'clear']).forEach(function (k) {
                var b = el('div', 'key focusable' + (k.length > 1 ? ' wide' : ''), k === 'space' ? 'Space' : k === 'clear' ? 'Clear' : k);
                b._select = function () {
                    if (k === 'space') searchState.q += ' ';
                    else if (k === '⌫') searchState.q = searchState.q.slice(0, -1);
                    else if (k === 'clear') searchState.q = '';
                    else searchState.q += k;
                    drawQ(); run();
                };
                keys.appendChild(b);
            });
            keys.firstChild.setAttribute('data-autofocus', '');
            drawQ(); drawResults();
        });
    }

    /* ---------- settings ---------- */

    var LANGS = [
        { value: '', label: 'Automatic (server default)' }, { value: 'eng', label: 'English' }, { value: 'tur', label: 'Turkish' },
        { value: 'ger', label: 'German' }, { value: 'fre', label: 'French' }, { value: 'spa', label: 'Spanish' }, { value: 'ita', label: 'Italian' },
        { value: 'por', label: 'Portuguese' }, { value: 'dut', label: 'Dutch' }, { value: 'rus', label: 'Russian' }, { value: 'ara', label: 'Arabic' },
        { value: 'jpn', label: 'Japanese' }, { value: 'kor', label: 'Korean' }, { value: 'chi', label: 'Chinese' }
    ];
    var OPTIONS = {
        truehd: [
            { value: 'auto', label: 'Auto', detail: 'Use an E-AC3/AC3 track in the same language if there is one, otherwise send TrueHD as-is' },
            { value: 'direct', label: 'Always send as-is', detail: 'Try passthrough every time; depends on the TV firmware' },
            { value: 'transcode', label: 'Always convert', detail: 'Server converts to E-AC3 5.1: reliable sound, no Atmos' }
        ],
        audioLang: LANGS,
        subtitles: [
            { value: 'off', label: 'Off' },
            { value: 'forced', label: 'Forced only', detail: 'Foreign-language parts only' },
            { value: 'always', label: 'Always on' }
        ],
        subLang: LANGS,
        subSize: [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' }, { value: 'xl', label: 'Extra Large' }],
        subColor: [{ value: 'white', label: 'White' }, { value: 'yellow', label: 'Yellow' }, { value: 'grey', label: 'Soft Grey' }],
        subBg: [{ value: 'shadow', label: 'Drop Shadow' }, { value: 'outline', label: 'Outline' }, { value: 'box', label: 'Dark Box' }],
        subPos: [{ value: 'bottom', label: 'Bottom' }, { value: 'raised', label: 'Raised' }],
        picture: [
            { value: 'letterbox', label: 'Original (letterbox)' },
            { value: 'auto', label: 'Auto aspect ratio' },
            { value: 'fill', label: 'Stretch to fill' }
        ],
        autoplay: [{ value: true, label: 'On' }, { value: false, label: 'Off' }],
        tmdbArt: [{ value: true, label: 'Fill in missing artwork' }, { value: false, label: 'Off' }],
        autoSkipIntro: [{ value: true, label: 'On' }, { value: false, label: 'Off' }]
    };
    function optLabel(key) {
        var o = OPTIONS[key].filter(function (x) { return x.value === settings[key]; })[0];
        return o ? o.label : String(settings[key]);
    }

    function settingsScreen(page) {
        backdrop(null, 'plain');
        return ensureLibs().then(function () {
            page.appendChild(nav('settings'));
            page.setAttribute('data-offset', '300');
            var col = el('div', 'settings');
            page.appendChild(col);
            function section(t) { col.appendChild(el('h2', '', Util.esc(t))); }
            function row(label, value, fn, id) {
                var r = el('div', 'sheet-row focusable', '<span class="lbl">' + Util.esc(label) + '</span><span class="val">' + Util.esc(value) + '</span>');
                r._select = fn;
                r.setAttribute('data-id', id || label);
                r.setAttribute('data-anchor', '');
                col.appendChild(r);
                return r;
            }
            function opt(label, key, note) {
                row(label, optLabel(key), function () {
                    choose(label, OPTIONS[key], settings[key], function (v) { settings[key] = v; saveSettings(); show(); }, note);
                }, key);
            }
            section('Account');
            row('User', Plex.state.user ? Plex.state.user.title : 'Plex account', switchUserSheet, 'user');
            row('Server', Plex.state.server ? Plex.state.server.name : '-', function () { replace(serversScreen); }, 'server');
            section('Audio');
            opt('Dolby TrueHD', 'truehd');
            opt('Preferred audio language', 'audioLang');
            section('Subtitles');
            opt('Show subtitles', 'subtitles');
            opt('Subtitle language', 'subLang');
            opt('Size', 'subSize');
            opt('Colour', 'subColor');
            opt('Style', 'subBg');
            opt('Position', 'subPos');
            section('Playback');
            opt('Autoplay next episode', 'autoplay');
            opt('Skip intros automatically', 'autoSkipIntro');
            opt('Picture size', 'picture');
            section('Online services');
            function keyRow(label, name, note, secret) {
                var v = Online.keys()[name];
                row(label, v ? (secret ? '••••••' : v.slice(0, 4) + '…' + v.slice(-3)) : 'Not set', function () {
                    textEntry(label, v, function (nv) { Online.setKey(name, nv.trim()); show(); }, note);
                }, 'k-' + name);
            }
            keyRow('TMDB API key', 'tmdb', 'Free at themoviedb.org → Settings → API. Fills in title logos, backdrops and posters Plex doesn\'t have.');
            opt('Artwork from TMDB', 'tmdbArt');
            keyRow('OMDb API key', 'omdb', 'Free at omdbapi.com. Adds IMDb, Rotten Tomatoes and Metascore when Plex lacks them.');
            keyRow('OpenSubtitles API key', 'opensubtitles', 'Free at opensubtitles.com → Profile → API consumers. Lets "Search online…" find subtitles like Infuse does.');
            keyRow('OpenSubtitles username', 'osUser', 'Optional. Signing in raises the daily download limit.');
            keyRow('OpenSubtitles password', 'osPass', 'Optional, stored only on this TV.', true);
            col.appendChild(el('p', 'muted small', 'Typing keys with the remote is slow: you can also put them in app/js/keys.js before building (see keys.example.js).'));
            section('Help');
            row('TV and soundbar setup', '', function () {
                openSheet('Sound Setup for the Q990C', [{ html:
                    '<p>Settings → Sound → Sound Output → <b>Receiver (HDMI-eARC)</b></p>' +
                    '<p>Settings → Sound → Expert Settings → <b>HDMI-eARC Mode: Auto</b>, <b>Digital Output Audio Format: Passthrough</b></p>' +
                    '<p>The soundbar display shows "Dolby Atmos" when it receives an Atmos bitstream. If a TrueHD track plays silent, press <b>Yellow</b> during playback.</p>' +
                    '<p>Audio out of sync? Use the TV\'s Settings → Sound → Expert Settings → <b>Digital Output Audio Delay</b>; apps can\'t shift audio on Tizen.</p>' }, { label: 'Close' }], { wide: true });
            }, 'help');
            row('Remote control', '', function () {
                openSheet('During Playback', [{ html:
                    '<div class="kv"><b>OK</b><span>Play / pause, or press the button on screen (Skip Intro, Play Next)</span></div>' +
                    '<div class="kv"><b>◀ ▶</b><span>Back 10 s / forward 30 s. While paused: scrub with preview thumbnails, OK to jump</span></div>' +
                    '<div class="kv"><b>▼ or Info</b><span>Info, chapters, audio, subtitles and picture</span></div>' +
                    '<div class="kv"><b>▲</b><span>Show the timeline</span></div>' +
                    '<div class="kv"><b>CH ▲ / ▼</b><span>Next / previous chapter</span></div>' +
                    '<div class="kv"><b>Yellow</b><span>Switch between direct play and server-converted audio</span></div>' +
                    '<div class="kv"><b>Blue / Green</b><span>Audio tracks / subtitles</span></div>' +
                    '<div class="kv"><b>Back</b><span>Close a panel, or stop</span></div>' }, { label: 'Close' }], { wide: true });
            }, 'keys');
            row('Sign out', '', function () { Plex.signOut(); libs = null; replace(signInScreen); }, 'signout');
            col.appendChild(el('p', 'muted small', 'Player: ' + Util.esc(Player.engineName()) + ' · Server: ' + Util.esc(Plex.state.server ? Plex.state.server.uri : '-')));
        });
    }

    function switchUserSheet() {
        Plex.homeUsers().then(function (users) {
            if (!users.length) { Util.toast('This Plex account has no Plex Home users.'); return; }
            openSheet('Switch User', users.map(function (u) {
                return {
                    label: u.title || u.username, detail: (u.admin ? 'Admin' : u.restricted ? 'Managed' : '') + (u.protected ? ' · PIN' : ''),
                    checked: Plex.state.user && Plex.state.user.uuid === u.uuid,
                    action: function () {
                        var go = function (pin) {
                            Plex.switchUser(u, pin).then(function () {
                                libs = null; libState = {}; Util.toast('Switched to ' + (u.title || u.username));
                                replace(homeScreen, 'home');
                            }, function (e) { Util.toast(e.message, 6000); });
                        };
                        if (u.protected) pinPad('PIN for ' + (u.title || u.username), go); else go();
                    }
                };
            }));
        }, function (e) { Util.toast(e.message, 6000); });
    }

    function start() {
        if (!Plex.state.token && Util.store('iptv.only')) replace(function (p) { return IPTVUI.screen(p); }, 'iptv');
        else if (!Plex.state.token) replace(signInScreen);
        else if (!Plex.state.server) replace(serversScreen);
        else replace(homeScreen, 'home');
    }

    return {
        start: start, move: move, select: select, back: back, settings: settings,
        play: play, sheetOpen: function () { return !!sheet; },
        // Building blocks for the Live TV (IPTV) screens in iptvui.js.
        kit: {
            el: el, button: button, lazyImg: lazyImg, push: push, replace: replace, show: show, nav: nav, focus: focus, refocus: refocus,
            focused: function () { return focused; }, openSheet: openSheet, closeSheet: closeSheet, choose: choose, textEntry: textEntry,
            pinPad: pinPad, backdrop: backdrop, ensureLibs: ensureLibs, signIn: function () { Util.store('iptv.only', null); replace(signInScreen); }
        }
    };
})();
