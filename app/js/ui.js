/* Screens and remote-control focus navigation. */
var UI = (function () {
    'use strict';

    var app = function () { return document.getElementById('app'); };
    var stack = [];          // [{ render, focusIndex }]
    var focused = null;

    var settings = Util.store('settings') || {};
    if (!settings.truehd) settings.truehd = 'auto';

    /* ---------- focus ---------- */

    function focusables() { return Array.prototype.slice.call(app().querySelectorAll('.focusable')); }

    function focus(el) {
        if (!el) return;
        if (focused) focused.classList.remove('focused');
        focused = el;
        el.classList.add('focused');
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { el.scrollIntoView(false); }
    }

    // Pick the nearest focusable element in the pressed direction.
    function move(dir) {
        if (!focused) return focus(focusables()[0]);
        var a = focused.getBoundingClientRect();
        var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
        var best = null, bestScore = Infinity;
        focusables().forEach(function (el) {
            if (el === focused) return;
            var b = el.getBoundingClientRect();
            var bx = b.left + b.width / 2, by = b.top + b.height / 2;
            var dx = bx - ax, dy = by - ay, main, cross;
            if (dir === 'left') { main = -dx; cross = Math.abs(dy); }
            else if (dir === 'right') { main = dx; cross = Math.abs(dy); }
            else if (dir === 'up') { main = -dy; cross = Math.abs(dx); }
            else { main = dy; cross = Math.abs(dx); }
            if (main <= 4) return;
            var score = main + cross * 3;
            if (score < bestScore) { bestScore = score; best = el; }
        });
        if (best) focus(best);
    }

    function refocus(id) { focus(app().querySelector('[data-id="' + id + '"]') || focusables()[0]); }

    function select() { if (focused && focused._select) focused._select(); }

    /* ---------- screen plumbing ---------- */

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
    }

    function button(label, fn, cls) {
        var b = el('div', 'btn focusable ' + (cls || ''), Util.esc(label));
        b._select = fn;
        return b;
    }

    function push(render) {
        if (stack.length) stack[stack.length - 1].focusIndex = focusables().indexOf(focused);
        stack.push({ render: render, focusIndex: 0 });
        show();
    }

    function replace(render) { stack = []; push(render); }

    function back() {
        if (stack.length <= 1) return false;
        stack.pop();
        show();
        return true;
    }

    function show() {
        var top = stack[stack.length - 1];
        focused = null;
        app().innerHTML = '<h1 class="muted">Loading…</h1>';
        Promise.resolve().then(function () { return top.render(app()); }).then(function () {
            if (stack[stack.length - 1] !== top) return;
            var f = focusables();
            focus(f[Math.min(top.focusIndex || 0, f.length - 1)] || f[0]);
        }).catch(function (err) {
            app().innerHTML = '';
            app().appendChild(el('h1', '', 'Something went wrong'));
            app().appendChild(el('p', 'bad', Util.esc(err.message || err)));
            app().appendChild(button('Retry', show));
            app().appendChild(button('Change server', function () { replace(serversScreen); }));
            focus(focusables()[0]);
        });
    }

    /* ---------- cards ---------- */

    function card(item, onSelect) {
        var c = el('div', 'card focusable');
        var thumb = item.type === 'episode' ? (item.grandparentThumb || item.thumb) : item.thumb;
        var label = item.type === 'episode'
            ? item.grandparentTitle + ' S' + item.parentIndex + 'E' + item.index
            : item.title;
        c.innerHTML = '<div class="poster" style="background-image:url(\'' + Plex.imageUrl(thumb, 240, 360) + '\')"></div>' +
            (item.viewOffset && item.duration ? '<div class="progress" style="width:' + Math.round(item.viewOffset / item.duration * 100) + '%"></div>' : '') +
            '<div class="label">' + Util.esc(label) + '</div>';
        c._select = onSelect;
        return c;
    }

    function openItem(item) {
        if (item.type === 'show') push(function (root) { return showScreen(root, item.ratingKey); });
        else if (item.type === 'season') push(function (root) { return episodesScreen(root, item.ratingKey, item.parentTitle + ' · ' + item.title); });
        else push(function (root) { return detailsScreen(root, item.ratingKey); });
    }

    /* ---------- screens ---------- */

    var pinPoll = null;
    function signInScreen(root) {
        clearInterval(pinPoll);
        return Plex.createPin().then(function (pin) {
            root.innerHTML = '';
            root.appendChild(el('h1', '', 'Sign in to Plex'));
            root.appendChild(el('p', '', 'On your phone or computer, open <b>plex.tv/link</b> and enter this code:'));
            root.appendChild(el('div', 'pin', Util.esc(pin.code)));
            root.appendChild(el('p', 'muted', 'This screen continues on its own once the code is accepted.'));
            root.appendChild(button('New code', function () { replace(signInScreen); }));
            pinPoll = setInterval(function () {
                Plex.checkPin(pin.id).then(function (token) {
                    if (token) { clearInterval(pinPoll); replace(serversScreen); }
                }).catch(function () {});
            }, 2000);
        });
    }

    function serversScreen(root) {
        return Plex.listServers().then(function (servers) {
            root.innerHTML = '';
            root.appendChild(el('h1', '', 'Choose a server'));
            if (!servers.length) root.appendChild(el('p', 'warn', 'No Plex Media Server is linked to this account.'));
            var list = el('div', 'scroll');
            servers.forEach(function (srv) {
                var it = el('div', 'list-item focusable', '<span>' + Util.esc(srv.name) + '</span><span class="muted">' +
                    (srv.owned ? 'yours' : 'shared') + (srv.presence ? '' : ' · offline?') + '</span>');
                it._select = function () {
                    it.querySelector('.muted').textContent = 'connecting…';
                    Plex.connect(srv).then(function (s) {
                        if (s.relay) Util.toast('Connected through Plex Relay: bandwidth is limited, 4K direct play will stutter. Check that the TV can reach the server on your network.', 9000);
                        replace(homeScreen);
                    }, function (e) { Util.toast(e.message, 6000); it.querySelector('.muted').textContent = 'unreachable'; });
                };
                list.appendChild(it);
            });
            list.appendChild(button('Sign out', function () { Plex.signOut(); replace(signInScreen); }));
            root.appendChild(list);
            if (servers.length === 1 && !Plex.state.server) setTimeout(function () { list.firstChild._select(); }, 0);
        });
    }

    function homeScreen(root) {
        return Promise.all([Plex.onDeck().catch(function () { return []; }), Plex.sections()]).then(function (r) {
            var deck = r[0], secs = r[1];
            root.innerHTML = '';
            root.appendChild(el('h1', '', Util.esc(Plex.state.server.name)));
            var scroll = el('div', 'scroll');
            if (deck.length) {
                scroll.appendChild(el('h2', '', 'Continue watching'));
                var row = el('div', 'row');
                deck.forEach(function (it) { row.appendChild(card(it, function () { openItem(it); })); });
                scroll.appendChild(row);
            }
            scroll.appendChild(el('h2', '', 'Libraries'));
            secs.filter(function (s) { return s.type === 'movie' || s.type === 'show'; }).forEach(function (s) {
                scroll.appendChild(button(s.title, function () { push(function (root2) { return libraryScreen(root2, s); }); }));
            });
            scroll.appendChild(el('h2', '', 'App'));
            scroll.appendChild(button('Settings', function () { push(settingsScreen); }));
            scroll.appendChild(button('Change server', function () { replace(serversScreen); }));
            root.appendChild(scroll);
        });
    }

    function libraryScreen(root, section) {
        return Plex.sectionItems(section.key, 0, 500).then(function (mc) {
            root.innerHTML = '';
            root.appendChild(el('h1', '', Util.esc(section.title) + ' <span class="muted">' + (mc.totalSize || mc.size || 0) + '</span>'));
            var scroll = el('div', 'scroll');
            var grid = el('div', 'grid');
            (mc.Metadata || []).forEach(function (it) { grid.appendChild(card(it, function () { openItem(it); })); });
            scroll.appendChild(grid);
            root.appendChild(scroll);
        });
    }

    function showScreen(root, ratingKey) {
        return Promise.all([Plex.metadata(ratingKey), Plex.children(ratingKey)]).then(function (r) {
            var show = r[0], seasons = r[1];
            root.innerHTML = '';
            root.appendChild(el('h1', '', Util.esc(show.title)));
            var grid = el('div', 'grid scroll');
            seasons.forEach(function (s) { grid.appendChild(card(s, function () { openItem(s); })); });
            root.appendChild(grid);
        });
    }

    function episodesScreen(root, ratingKey, heading) {
        return Plex.children(ratingKey).then(function (eps) {
            root.innerHTML = '';
            root.appendChild(el('h1', '', Util.esc(heading)));
            var list = el('div', 'scroll');
            eps.forEach(function (e) {
                var it = el('div', 'list-item focusable', '<span>' + e.index + '. ' + Util.esc(e.title) + '</span><span class="muted">' +
                    (e.viewCount ? '✓ ' : '') + Util.fmtTime(e.duration) + '</span>');
                it._select = function () { openItem(e); };
                list.appendChild(it);
            });
            root.appendChild(list);
        });
    }

    function detailsScreen(root, ratingKey) {
        return Plex.metadata(ratingKey).then(function (item) {
            var mediaIndex = 0, audioId = null;

            function render() {
                var plan = Decide.plan(item, mediaIndex, audioId, settings);
                root.innerHTML = '';
                var wrap = el('div', 'details');
                wrap.appendChild(el('div', 'poster', ''));
                wrap.firstChild.style.backgroundImage = 'url(\'' + Plex.imageUrl(item.type === 'episode' ? item.grandparentThumb : item.thumb, 360, 540) + '\')';
                var info = el('div', '');
                var heading = item.type === 'episode'
                    ? Util.esc(item.grandparentTitle) + ' <span class="muted">S' + item.parentIndex + 'E' + item.index + '</span><br>' + Util.esc(item.title)
                    : Util.esc(item.title) + ' <span class="muted">' + (item.year || '') + '</span>';
                info.appendChild(el('h1', '', heading));
                info.appendChild(el('div', 'summary', Util.esc(item.summary || '')));

                var mi = '<div><b>File</b> ' + Util.esc((plan.media.container || '?').toUpperCase()) + ' · ' +
                    Util.esc(plan.media.videoResolution || '') + ' · ' + Math.round((plan.media.bitrate || 0) / 1000) + ' Mbps</div>' +
                    '<div><b>Video</b> ' + Util.esc(plan.video ? (plan.video.extendedDisplayTitle || plan.video.displayTitle) : '?') + ' · ' + Util.esc(plan.hdr) + '</div>' +
                    '<div><b>Audio</b> ' + Util.esc(Decide.audioLabel(plan.audio)) + (plan.mode === 'audio-transcode' ? ' <span class="warn">→ E-AC3 5.1 by server</span>' : ' <span class="good">→ sent as-is</span>') + '</div>' +
                    '<div><b>Plan</b> ' + (plan.mode === 'direct' ? '<span class="good">Direct play</span>' : '<span class="warn">Video copied untouched, audio converted</span>') + '</div>' +
                    (plan.audioReason ? '<div class="muted">' + Util.esc(plan.audioReason) + '</div>' : '') +
                    plan.warnings.map(function (w) { return '<div class="warn">' + Util.esc(w) + '</div>'; }).join('');
                info.appendChild(el('div', 'mediainfo', mi));

                var resumeAt = item.viewOffset || 0;
                function play(at) {
                    Plex.selectStreams(plan.part.id, plan.audio && plan.audio.id).then(function () {
                        Player.start(item, plan, settings, at, function () { show(); });
                    });
                }
                if (resumeAt) info.appendChild(button('Resume from ' + Util.fmtTime(resumeAt), function () { play(resumeAt); }));
                info.appendChild(button(resumeAt ? 'Play from start' : 'Play', function () { play(0); }));

                if ((item.Media || []).length > 1) {
                    var vb = button('Version ' + (mediaIndex + 1) + '/' + item.Media.length, function () {
                        mediaIndex = (mediaIndex + 1) % item.Media.length; audioId = null; render(); refocus('version');
                    });
                    vb.dataset.id = 'version';
                    info.appendChild(vb);
                }
                var audios = Decide.streams(plan.part, 2);
                if (audios.length > 1) {
                    var ab = button('Audio: change', function () {
                        var i = audios.indexOf(plan.audio);
                        audioId = audios[(i + 1) % audios.length].id;
                        render(); refocus('audio');
                    });
                    ab.dataset.id = 'audio';
                    info.appendChild(ab);
                }
                wrap.appendChild(info);
                root.appendChild(wrap);
            }
            render();
        });
    }

    function settingsScreen(root) {
        var modes = {
            auto: 'Auto: use an E-AC3/AC3 track in the same language if the file has one, otherwise send TrueHD as-is',
            direct: 'Always send TrueHD as-is (try passthrough; depends on TV firmware)',
            transcode: 'Always convert TrueHD to E-AC3 5.1 on the server (reliable sound, no Atmos)'
        };
        root.innerHTML = '';
        root.appendChild(el('h1', '', 'Settings'));
        root.appendChild(el('h2', '', 'Dolby TrueHD'));
        var b = button(modes[settings.truehd], function () {
            var keys = Object.keys(modes);
            settings.truehd = keys[(keys.indexOf(settings.truehd) + 1) % keys.length];
            Util.store('settings', settings);
            b.textContent = modes[settings.truehd];
        });
        root.appendChild(b);
        root.appendChild(el('p', 'muted', 'TV setup for passthrough: Settings → Sound → Sound Output = Receiver (HDMI-eARC); Expert Settings → HDMI-eARC Mode = Auto; Digital Output Audio Format = Passthrough.'));
        root.appendChild(el('h2', '', 'About'));
        root.appendChild(el('p', 'muted', 'Player: ' + Util.esc(Player.engineName()) + ' · Server: ' + Util.esc(Plex.state.server ? Plex.state.server.uri : '-')));
        root.appendChild(button('Sign out', function () { Plex.signOut(); replace(signInScreen); }));
    }

    function start() {
        if (!Plex.state.token) replace(signInScreen);
        else if (!Plex.state.server) replace(serversScreen);
        else replace(homeScreen);
    }

    return { start: start, move: move, select: select, back: back };
})();
