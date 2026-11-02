/* Live TV (IPTV) screens: Home, Live TV with preview, TV Guide, Movies, Series, Favorites, Search, Downloads,
 * Recordings and Playlists. Built from UI.kit so focus and scrolling behave like the rest of Lumen. ES5 only. */
var IPTVUI = (function () {
    'use strict';

    var K = function () { return UI.kit; };
    function el(t, c, h) { return K().el(t, c, h); }
    function esc(s) { return Util.esc(s); }
    function clock(t) { return Util.fmtClock(new Date(t)); }

    var SECTIONS = [
        ['home', 'Home'], ['live', 'Live TV'], ['guide', 'TV Guide'], ['movies', 'Movies'], ['series', 'Series'],
        ['favorites', 'Favorites'], ['search', 'Search'], ['downloads', 'Downloads'], ['recordings', 'Recordings'], ['playlists', 'Playlists']
    ];
    var section = Util.store('iptv.section') || 'home';
    var MAX_ROWS = 250;

    function day(t) {
        var d = new Date(t), now = new Date();
        var a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        var diff = Math.round((b - a) / 86400000);
        if (diff === 0) return 'Today';
        if (diff === -1) return 'Yesterday';
        if (diff === 1) return 'Tomorrow';
        return d.toDateString().slice(0, 10);
    }

    function tagsHtml(ch, videoOnly) {
        return IPTV.tags(ch).filter(function (t) { return !videoOnly || ['4K', 'FHD', 'HD', 'SD'].indexOf(t) >= 0; })
            .map(function (t) { return '<i class="qtag q-' + t.replace('.', '') + '">' + esc(t) + '</i>'; }).join('');
    }
    function dot(pid) { return IPTV.playlists().length > 1 ? '<i class="sdot" style="background:' + IPTV.color(IPTV.playlist(pid)) + '"></i>' : ''; }

    function playLive(ch, lineup) { IPTVPlayer.start({ live: ch }, lineup, function () { K().show(); }); }

    /* ---------- frame ---------- */

    var reminderHooked = false, refreshTimer = null;
    function screen(page) {
        IPTVPlayer.stopPreview();
        K().backdrop(null, 'plain');
        if (!reminderHooked) {
            reminderHooked = true;
            IPTV.onChange(function (what) {
                if (what === 'content' || what === 'guide' || what === 'loading') {
                    clearTimeout(refreshTimer);
                    refreshTimer = setTimeout(function () {
                        var f = K().focused();
                        if (!IPTVPlayer.active() && !UI.sheetOpen() && document.querySelector('#app .iptv-body') && !(f && f.closest('.iptv-detail'))) K().show();
                    }, 600);
                }
                if (what && what.reminder) {
                    var r = what.reminder, ch = IPTV.channel(r.channelID);
                    K().openSheet(r.title, [{ html: 'Starting now on ' + esc(r.channelName) },
                        { label: 'Watch', action: function () { if (ch) playLive(ch, IPTV.channels()); } }, { label: 'Dismiss' }]);
                }
            });
        }
        if (Plex.state.token) page.appendChild(K().nav('iptv'));
        else {
            var bar = el('div', 'nav');
            bar.setAttribute('data-anchor', 'top');
            var tabs = el('div', 'tabs hlist');
            var t1 = el('div', 'tab focusable active', 'Live TV'); t1._select = function () {};
            var t2 = el('div', 'tab focusable', 'Sign in to Plex'); t2._select = function () { K().signIn(); };
            tabs.appendChild(t1); tabs.appendChild(t2);
            bar.appendChild(tabs);
            page.appendChild(bar);
        }
        var secWrap = el('div', 'iptv-secwrap');
        secWrap.setAttribute('data-anchor', 'top');
        var bar2 = el('div', 'track hlist');
        secWrap.appendChild(bar2);
        SECTIONS.forEach(function (s) {
            var b = K().button(esc(s[1]), function () { if (section !== s[0]) { section = s[0]; Util.store('iptv.section', section); K().replace(screen, 'iptv'); } },
                'pill' + (s[0] === section ? ' on' : ''), 'sec-' + s[0]);
            if (s[0] === section) b.setAttribute('data-autofocus', '');
            bar2.appendChild(b);
        });
        page.appendChild(secWrap);
        var body = el('div', 'iptv-body');
        page.appendChild(body);
        if (!IPTV.playlists().length && ['playlists', 'downloads', 'recordings'].indexOf(section) < 0) return welcome(body);
        return ({ home: home, live: live, guide: guide, movies: function (b) { return library(b, 'movie'); }, series: function (b) { return library(b, 'series'); },
            favorites: favorites, search: search, downloads: function (b) { return jobs(b, 'download'); }, recordings: function (b) { return jobs(b, 'recording'); },
            playlists: playlists })[section](body);
    }

    function welcome(body) {
        body.appendChild(el('div', 'iptv-empty', '<h1>Watch live TV in Lumen</h1><p>Add an M3U playlist or an Xtream Codes login from your TV provider. ' +
            'Lumen reads its channels, TV guide, catch-up, movies and series.</p><p class="muted">Tip: playlists in <b>js/iptvconfig.js</b> are added automatically, so you don\'t have to type them with the remote.</p>'));
        var row = el('div', 'hlist btn-row center');
        row.appendChild(K().button('Add Playlist', function () { editPlaylist(null); }, 'primary'));
        body.appendChild(row);
    }

    /* ---------- cards ---------- */

    function poster(item, kind, sub) {
        var c = el('div', 'card card-poster focusable');
        var img = K().lazyImg('img', item.poster || '');
        if (!item.poster) img.innerHTML = '<span class="fallback">' + esc(item.name) + '</span>';
        var pr = IPTV.progress(item.id);
        if (pr > 0) img.appendChild(el('div', 'bar', '<i style="width:' + Math.round(pr * 100) + '%"></i>'));
        if (IPTV.isFavorite(item.id)) img.appendChild(el('div', 'fav', '★'));
        c.appendChild(img);
        c.appendChild(el('div', 'cap', '<div class="t">' + esc(item.name) + '</div><div class="s">' + esc(sub != null ? sub : (item.year || '')) + '</div>'));
        c._select = function () { K().push(function (p) { return kind === 'movie' ? movieScreen(p, item) : seriesScreen(p, item); }); };
        c._options = function () {
            var rows = [{ label: IPTV.isFavorite(item.id) ? 'Remove from Favorites' : 'Add to Favorites', action: function () { IPTV.toggleFavorite(item.id); K().show(); } }];
            if (kind === 'movie') rows.push({ label: 'Download', action: function () { if (IPTVRec.download('movie', item)) Util.toast('Downloading ' + item.name); } });
            K().openSheet(item.name, rows);
        };
        return c;
    }

    function channelCard(ch, lineup) {
        var c = el('div', 'card iptv-chcard focusable');
        var now = IPTV.nowNext(ch)[0];
        c.innerHTML = '<div class="img logo" style="background-image:url(\'' + esc(ch.logo || '') + '\')">' + (ch.logo ? '' : '<span>' + esc(ch.name.slice(0, 2)) + '</span>') + '</div>' +
            '<div class="cap"><div class="t">' + esc(ch.name) + ' ' + tagsHtml(ch, true) + '</div><div class="s">' + esc(now ? now.title : '') + '</div></div>';
        c._select = function () { playLive(ch, lineup); };
        c._options = function () { channelOptions(ch); };
        return c;
    }

    function shelf(title, note, cards) {
        var s = el('section', 'shelf');
        s.setAttribute('data-anchor', '');
        s.appendChild(el('h2', '', esc(title) + (note ? ' <small>' + esc(note) + '</small>' : '')));
        var t = el('div', 'track hlist');
        cards.forEach(function (c) { t.appendChild(c); });
        s.appendChild(t);
        return s;
    }

    /* ---------- home ---------- */

    function home(body) {
        var resume = IPTV.continueEntries();
        if (resume.length) body.appendChild(shelf('Continue Watching', null, resume.map(resumeCard)));
        var recent = IPTV.recentChannels();
        if (recent.length) body.appendChild(shelf('Recently Watched Channels', null, recent.slice(0, 20).map(function (c) { return channelCard(c, recent); })));
        var trend = IPTV.trendingChannels();
        if (trend.length) body.appendChild(shelf('Trending Channels', 'Most watched in Lumen this week', trend.map(function (c) { return channelCard(c, trend); })));
        var favs = IPTV.favoriteChannels();
        if (favs.length) body.appendChild(shelf('Favorite Channels', null, favs.slice(0, 30).map(function (c) { return channelCard(c, favs); })));
        return IPTV.trending().then(function (t) {
            if (t.movies.length) body.appendChild(shelf('Trending Movies', t.fromTMDB ? 'Trending on TMDB this week' : 'Top rated new additions (add a TMDB key in Settings for real trends)',
                t.movies.map(function (m) { return poster(m, 'movie'); })));
            if (t.series.length) body.appendChild(shelf('Trending Series', t.fromTMDB ? 'Trending on TMDB this week' : 'Top rated', t.series.map(function (s) { return poster(s, 'series'); })));
            if (!body.children.length) body.appendChild(el('div', 'iptv-empty', '<p>' + (IPTV.loading() ? 'Loading your playlists…' : 'Start watching and your channels, movies and series show up here.') + '</p>'));
        });
    }

    function resumeCard(r) {
        var c = el('div', 'card card-wide focusable');
        var img = K().lazyImg('img', r.poster || '');
        var pr = IPTV.progress(r.id);
        if (pr > 0) img.appendChild(el('div', 'bar', '<i style="width:' + Math.round(pr * 100) + '%"></i>'));
        c.appendChild(img);
        c.appendChild(el('div', 'cap', '<div class="t">' + esc(r.title) + '</div><div class="s">' + esc(r.subtitle || '') + '</div>'));
        c._select = function () {
            if (r.movieID) {
                var m = IPTV.movies().filter(function (x) { return x.id === r.movieID; })[0];
                if (m) IPTVPlayer.start({ movie: m }, null, function () { K().show(); });
                return;
            }
            var s = IPTV.series().filter(function (x) { return x.id === r.seriesID; })[0];
            if (!s) return;
            IPTV.details('series', s).then(function (d) {
                var all = d.episodes || [r.episode], i = -1;
                all.forEach(function (e, j) { if (e.id === r.episode.id) i = j; });
                var e = i >= 0 ? all[i] : r.episode;
                if (!IPTV.position(e.id) && i >= 0 && all[i + 1] && IPTV.progress(e.id) === 0 && r.finished) e = all[i + 1];
                IPTVPlayer.start({ episode: [s, e, all] }, null, function () { K().show(); });
            });
        };
        c._options = function () { K().openSheet(r.title, [{ label: 'Remove from Continue Watching', action: function () { IPTV.removeResume(r.id); K().show(); } }]); };
        return c;
    }

    /* ---------- Live TV ---------- */

    var liveGroup = Util.store('iptv.liveGroup') || 'all', tagFilter = [];

    function lineup(groupId) {
        var l;
        if (groupId === 'all') l = IPTV.channels();
        else if (groupId === 'favorites') l = IPTV.favoriteChannels();
        else if (groupId === 'recents') l = IPTV.recentChannels();
        else {
            var g = IPTV.groups('live').filter(function (x) { return x.id === groupId; })[0];
            l = g ? IPTV.inGroup('live', g) : IPTV.channels();
        }
        if (tagFilter.length) l = l.filter(function (c) { var t = IPTV.tags(c); return tagFilter.every(function (x) { return t.indexOf(x) >= 0; }); });
        return l;
    }

    function column(cls) {
        var col = el('div', 'iptv-col ' + cls);
        var pg = el('div', 'page');
        pg.setAttribute('data-offset', '260');
        col.appendChild(pg);
        return { col: col, page: pg };
    }

    function pick(g, then) {
        if (IPTV.isLocked(g) && !IPTV.unlocked()) {
            K().pinPad('Enter PIN', function (p) { if (IPTV.unlock(p)) then(); else Util.toast('Wrong PIN'); });
        } else then();
    }

    function live(body) {
        var tagsRow = el('div', 'hlist iptv-tags');
        IPTV.TAGS.forEach(function (t) {
            tagsRow.appendChild(K().button(esc(t), function () {
                var i = tagFilter.indexOf(t); if (i >= 0) tagFilter.splice(i, 1); else tagFilter.push(t);
                K().replace(screen, 'iptv');
            }, 'pill small' + (tagFilter.indexOf(t) >= 0 ? ' on' : '')));
        });
        body.appendChild(tagsRow);
        var cols = el('div', 'iptv-cols');
        var gcol = column('groups'), ccol = column('channels');
        var prev = el('div', 'iptv-col preview', '<div class="pv-box"></div><div class="pv-info"></div>');
        function groupRow(id, label, extra) {
            var r = el('div', 'ir focusable' + (id === liveGroup ? ' on' : ''), (extra || '') + '<span class="lbl">' + esc(label) + '</span>');
            r.setAttribute('data-id', 'g-' + id);
            return r;
        }
        [['all', 'All Channels'], ['favorites', 'Favorites'], ['recents', 'Recently Watched']].forEach(function (x) {
            var r = groupRow(x[0], x[1]);
            r._select = function () { liveGroup = x[0]; Util.store('iptv.liveGroup', liveGroup); K().replace(screen, 'iptv'); };
            gcol.page.appendChild(r);
        });
        IPTV.groups('live').forEach(function (g) {
            var r = groupRow(g.id, g.name, dot(g.playlistID));
            if (IPTV.isLocked(g)) r.appendChild(el('span', 'lock', IPTV.unlocked() ? '🔓' : '🔒'));
            r._select = function () { pick(g, function () { liveGroup = g.id; Util.store('iptv.liveGroup', liveGroup); K().replace(screen, 'iptv'); }); };
            r._options = function () { groupOptions(g); };
            gcol.page.appendChild(r);
        });
        var list = lineup(liveGroup);
        if (!list.length) ccol.page.appendChild(el('div', 'muted pad', IPTV.loading() ? 'Loading channels…' : 'No channels here.'));
        list.slice(0, MAX_ROWS).forEach(function (ch) { ccol.page.appendChild(channelRow(ch, list, prev)); });
        if (list.length > MAX_ROWS) ccol.page.appendChild(el('div', 'muted pad', (list.length - MAX_ROWS) + ' more: pick a group or search to narrow the list.'));
        cols.appendChild(gcol.col); cols.appendChild(ccol.col); cols.appendChild(prev);
        // Left and right jump between the group list and the channel list.
        Array.prototype.forEach.call(gcol.page.children, function (r) { r._nav = { right: function () { return ccol.page.querySelector('.focusable'); } }; });
        Array.prototype.forEach.call(ccol.page.children, function (r) {
            r._nav = { left: function () { return gcol.page.querySelector('.ir.on') || gcol.page.querySelector('.focusable'); }, right: function () { return r; } };
        });
        body.appendChild(cols);
        body.appendChild(el('div', 'iptv-hint', '<b>OK</b> Watch  <b>INFO</b> or <i class="key-g"></i> Options (favourite, rename, record, hide, lock)'));
    }

    var previewTimer = null;
    function channelRow(ch, list, prev) {
        var nn = IPTV.nowNext(ch), now = nn[0];
        var pct = now ? Math.round((Date.now() - now.start) / (now.end - now.start) * 100) : 0;
        var r = el('div', 'ir ch focusable',
            '<span class="num">' + (ch.number || '') + '</span><span class="logo" style="background-image:url(\'' + esc(ch.logo || '') + '\')"></span>' +
            '<span class="lbl">' + dot(ch.playlistID) + esc(ch.name) + ' ' + tagsHtml(ch) + (IPTV.isFavorite(ch.id) ? ' <i class="star">★</i>' : '') +
            (ch.catchup ? ' <i class="cu">⟲</i>' : '') + (IPTVRec.recordingOf(ch) ? ' <i class="rec">●</i>' : '') +
            '<small>' + (now ? esc(now.title) + '<span class="pbar"><i style="width:' + pct + '%"></i></span>' : '') + '</small></span>');
        r._select = function () { IPTVPlayer.stopPreview(); playLive(ch, list); };
        r._options = function () { channelOptions(ch); };
        if (prev) r._focus = function () {
            var info = prev.querySelector('.pv-info');
            info.innerHTML = '<div class="t">' + esc(ch.name) + ' ' + tagsHtml(ch) + '</div>' +
                (now ? '<div class="p">' + esc(now.title) + '</div><div class="s">' + clock(now.start) + ' – ' + clock(now.end) + '</div>' + (now.desc ? '<div class="d">' + esc(now.desc) + '</div>' : '') : '') +
                (nn[1] ? '<div class="s">Next ' + clock(nn[1].start) + '  ' + esc(nn[1].title) + '</div>' : '');
            clearTimeout(previewTimer);
            previewTimer = setTimeout(function () {
                var box = prev.querySelector('.pv-box').getBoundingClientRect();
                if (box.width && document.body.contains(prev)) IPTVPlayer.startPreview(ch, [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]);
            }, 900);
        };
        return r;
    }

    function channelOptions(ch) {
        var rec = IPTVRec.recordingOf(ch), now = IPTV.nowNext(ch)[0];
        var rows = [
            { label: 'Watch', action: function () { playLive(ch, [ch]); } },
            { label: IPTV.isFavorite(ch.id) ? 'Remove from Favorites' : 'Add to Favorites', action: function () { IPTV.toggleFavorite(ch.id); K().show(); } },
            { label: 'Rename', action: function () { K().textEntry('Rename ' + ch.name, ch.name, function (t) { IPTV.rename(ch, t); K().show(); }, 'Leave empty to use the original name.'); } }
        ];
        if (rec) rows.push({ label: 'Stop Recording', action: function () { IPTVRec.stop(rec.id); } });
        else {
            if (now) rows.push({ label: 'Record “' + now.title + '”', action: function () { if (IPTVRec.record(ch, now)) Util.toast('Recording ' + now.title); } });
            rows.push({ label: 'Record 1 Hour', action: function () { if (IPTVRec.record(ch, null, 60)) Util.toast('Recording for an hour'); } });
        }
        var g = IPTV.groups('live').filter(function (x) { return x.playlistID === ch.playlistID && x.name === ch.group; })[0];
        if (g) { rows.push({ header: 'Group: ' + g.name }); rows.push.apply(rows, groupRows(g)); }
        K().openSheet(ch.name, rows);
    }

    function groupRows(g) {
        var rows = [{ label: 'Hide Group', action: function () { IPTV.setHidden(g, true); K().show(); } }];
        if (IPTV.pin()) rows.push({ label: IPTV.isLocked(g) ? 'Unlock Group' : 'Lock Group with PIN', action: function () { IPTV.setLocked(g, !IPTV.isLocked(g)); K().show(); } });
        else rows.push({ label: 'Set a PIN in Playlists to lock groups', disabled: true });
        return rows;
    }
    function groupOptions(g) { K().openSheet(g.name, groupRows(g)); }

    /* ---------- TV Guide ---------- */

    var guideStart = null, guideGroup = Util.store('iptv.guideGroup') || 'all';
    var HOUR = 640, HOURS = 2.5, CHW = 300;

    function guide(body) {
        if (guideStart === null) guideStart = Math.floor(Date.now() / 1800000) * 1800000 - 1800000;
        var head = el('div', 'hlist iptv-guidehead');
        var gname = guideGroup === 'all' ? 'All Channels' : guideGroup === 'favorites' ? 'Favorites' : ((IPTV.groups('live').filter(function (g) { return g.id === guideGroup; })[0] || {}).name || 'All Channels');
        head.appendChild(K().button('▤ ' + esc(gname), function () {
            var opts = [{ label: 'All Channels', value: 'all' }, { label: 'Favorites', value: 'favorites' }].concat(IPTV.groups('live').map(function (g) { return { label: g.name, value: g.id, g: g }; }));
            K().choose('Channels', opts, guideGroup, function (v) {
                var o = opts.filter(function (x) { return x.value === v; })[0];
                var go = function () { guideGroup = v; Util.store('iptv.guideGroup', v); K().replace(screen, 'iptv'); };
                if (o.g) pick(o.g, go); else go();
            });
        }, 'pill'));
        head.appendChild(K().button('◀ Earlier', function () { shift(-1); }, 'pill'));
        head.appendChild(K().button('Now', function () { guideStart = null; K().replace(screen, 'iptv'); }, 'pill'));
        head.appendChild(K().button('Later ▶', function () { shift(1); }, 'pill'));
        head.appendChild(el('div', 'gday', esc(day(guideStart))));
        body.appendChild(head);
        if (!IPTV.hasGuide()) {
            body.appendChild(el('div', 'iptv-empty', '<p>' + (IPTV.guideLoading() ? 'Loading the TV guide…' : 'No TV guide yet. Lumen uses the guide your playlist names; you can add an XMLTV address to the playlist.') + '</p>'));
            var r = el('div', 'hlist btn-row center'); r.appendChild(K().button('Load Guide', function () { IPTV.refreshGuide().then(function () { K().show(); }); }));
            body.appendChild(r);
            return;
        }
        var end = guideStart + HOURS * 3600000;
        var ruler = el('div', 'g-ruler');
        ruler.style.paddingLeft = CHW + 'px';
        for (var i = 0; i < HOURS * 2; i++) ruler.appendChild(el('span', '', clock(guideStart + i * 1800000)));
        body.appendChild(ruler);
        var wrap = el('div', 'iptv-col guide');
        var pg = el('div', 'page');
        pg.setAttribute('data-offset', '200');
        var chans = guideGroup === 'all' ? IPTV.channels() : guideGroup === 'favorites' ? IPTV.favoriteChannels() :
            (function () { var g = IPTV.groups('live').filter(function (x) { return x.id === guideGroup; })[0]; return g ? IPTV.inGroup('live', g) : IPTV.channels(); })();
        var now = Date.now();
        if (now > guideStart && now < end) {
            var line = el('div', 'g-now'); line.style.left = (CHW + (now - guideStart) / 3600000 * HOUR) + 'px'; wrap.appendChild(line);
        }
        chans.slice(0, 150).forEach(function (ch) {
            var row = el('div', 'g-row');
            row.appendChild(el('div', 'g-ch', '<span class="logo" style="background-image:url(\'' + esc(ch.logo || '') + '\')"></span><span>' + esc(ch.name) + '</span>'));
            var cells = el('div', 'g-cells hlist');
            var cursor = guideStart, any = false;
            IPTV.programmes(ch, guideStart, end).forEach(function (p) {
                var s = Math.max(p.start, guideStart), e = Math.min(p.end, end);
                if (s > cursor) cells.appendChild(gap((s - cursor) / 3600000 * HOUR));
                var w = (e - Math.max(s, cursor)) / 3600000 * HOUR;
                if (w <= 0) return;
                any = true;
                var c = el('div', 'g-cell focusable' + (p.start <= now && now < p.end ? ' airing' : ''),
                    (IPTVRec.isRecording(ch, p) ? '<i class="rec">●</i> ' : '') + (IPTV.hasReminder(ch, p) ? '🔔 ' : '') + (IPTV.canCatchUp(ch, p) && p.end < now ? '⟲ ' : '') +
                    esc(p.title) + '<small>' + clock(p.start) + '</small>');
                c.style.width = (w - 6) + 'px';
                c._select = function () { programmeSheet(ch, p, chans); };
                cells.appendChild(c);
                cursor = Math.max(cursor, e);
            });
            if (!any) { var none = el('div', 'g-cell empty focusable', esc(ch.name)); none.style.width = (HOURS * HOUR - 6) + 'px'; none._select = function () { playLive(ch, chans); }; cells.appendChild(none); }
            row.appendChild(cells);
            pg.appendChild(row);
        });
        wrap.appendChild(pg);
        body.appendChild(wrap);
    }

    function gap(w) { var g = el('div', 'g-gap'); g.style.width = w + 'px'; return g; }

    function shift(dir) {
        var max = 1;
        IPTV.channels().forEach(function (c) { if (c.catchup && c.catchup.days > max) max = c.catchup.days; });
        guideStart = Math.min(Date.now() + 4 * 86400000, Math.max(Date.now() - max * 86400000, guideStart + dir * HOURS * 3600000 * 0.8));
        K().replace(screen, 'iptv');
    }

    function programmeSheet(ch, p, chans) {
        var now = Date.now(), rows = [];
        rows.push({ html: '<b>' + esc(ch.name) + '</b> · ' + esc(day(p.start)) + ' ' + clock(p.start) + ' – ' + clock(p.end) + (p.episode ? '<br>' + esc(p.episode) : '') + (p.desc ? '<br><span class="muted">' + esc(p.desc) + '</span>' : '') });
        if (p.start <= now && now < p.end) {
            rows.push({ label: 'Watch Live', action: function () { playLive(ch, chans); } });
            if (IPTV.canCatchUp(ch, p)) rows.push({ label: 'Watch from the Start', action: function () { IPTVPlayer.start({ catchup: [ch, p] }, null, function () { K().show(); }); } });
        } else if (p.end <= now) {
            if (IPTV.canCatchUp(ch, p)) {
                rows.push({ label: 'Watch (Catch-up)', action: function () { IPTVPlayer.start({ catchup: [ch, p] }, null, function () { K().show(); }); } });
                rows.push({ label: 'Download', action: function () { if (IPTVRec.download('catchup', { channel: ch, programme: p })) Util.toast('Downloading ' + p.title); } });
            } else rows.push({ label: 'Not available: this channel has no catch-up', disabled: true });
        } else {
            rows.push({ label: IPTV.hasReminder(ch, p) ? 'Cancel Reminder' : 'Remind Me', action: function () { IPTV.toggleReminder(ch, p); K().show(); } });
        }
        if (p.end > now) rows.push({ label: IPTVRec.isRecording(ch, p) ? 'Recording' : 'Record', disabled: IPTVRec.isRecording(ch, p), action: function () { if (IPTVRec.record(ch, p)) Util.toast('Recording scheduled'); K().show(); } });
        rows.push({ label: IPTV.isFavorite(ch.id) ? 'Remove Channel from Favorites' : 'Add Channel to Favorites', action: function () { IPTV.toggleFavorite(ch.id); } });
        K().openSheet(p.title, rows, { wide: true });
    }

    /* ---------- Movies and Series ---------- */

    var libState = { movie: { group: 'all', sort: 'added' }, series: { group: 'all', sort: 'added' } };

    function library(body, kind) {
        var st = libState[kind];
        var groups = IPTV.groups(kind);
        var head = el('div', 'hlist iptv-guidehead');
        var gname = st.group === 'all' ? 'All' : st.group === 'favorites' ? 'Favorites' : ((groups.filter(function (g) { return g.id === st.group; })[0] || {}).name || 'All');
        head.appendChild(K().button('▤ ' + esc(gname), function () {
            var opts = [{ label: 'All', value: 'all' }, { label: 'Favorites', value: 'favorites' }].concat(groups.map(function (g) { return { label: g.name, value: g.id, g: g }; }));
            K().choose(kind === 'movie' ? 'Movies' : 'Series', opts, st.group, function (v) {
                var o = opts.filter(function (x) { return x.value === v; })[0];
                var go = function () { st.group = v; K().replace(screen, 'iptv'); };
                if (o.g) pick(o.g, go); else go();
            });
        }, 'pill'));
        var sorts = [['added', 'Recently Added'], ['name', 'Name'], ['rating', 'Rating'], ['year', 'Year']];
        head.appendChild(K().button('⇅ ' + sorts.filter(function (x) { return x[0] === st.sort; })[0][1], function () {
            K().choose('Sort', sorts.map(function (x) { return { label: x[1], value: x[0] }; }), st.sort, function (v) { st.sort = v; K().replace(screen, 'iptv'); });
        }, 'pill'));
        body.appendChild(head);
        var all = kind === 'movie' ? IPTV.movies() : IPTV.series();
        var list = st.group === 'all' ? all : st.group === 'favorites' ? all.filter(function (x) { return IPTV.isFavorite(x.id); }) :
            (function () { var g = groups.filter(function (x) { return x.id === st.group; })[0]; return g ? IPTV.inGroup(kind, g) : all; })();
        list = list.slice();
        if (st.sort === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name); });
        else if (st.sort === 'rating') list.sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
        else if (st.sort === 'year') list.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
        else if (kind === 'movie') list.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
        if (kind === 'movie' && st.group === 'all') {
            var resume = IPTV.continueEntries().filter(function (r) { return r.movieID; });
            if (resume.length) body.appendChild(shelf('Continue Watching', null, resume.map(resumeCard)));
        }
        if (!list.length) body.appendChild(el('div', 'iptv-empty', '<p>' + (IPTV.loading() ? 'Loading…' : 'Nothing here.') + '</p>'));
        grid(body, list.slice(0, 300), function (x) { return poster(x, kind); });
        if (list.length > 300) body.appendChild(el('div', 'muted pad', (list.length - 300) + ' more: pick a group, change the sort or search.'));
    }

    function grid(body, items, make) {
        for (var i = 0; i < items.length; i += 6) {
            var row = el('div', 'hlist iptv-grid');
            row.setAttribute('data-anchor', '');
            items.slice(i, i + 6).forEach(function (x) { row.appendChild(make(x)); });
            body.appendChild(row);
        }
    }

    function detailFrame(page, img) {
        page.className = 'page iptv-detail';
        K().backdrop(img || null, img ? 'dim' : 'plain');
    }

    function movieScreen(page, m) {
        detailFrame(page, m.poster);
        return IPTV.details('movie', m).then(function (d) {
            if (d.backdrop) K().backdrop(d.backdrop, 'full');
            var meta = [m.year, d.duration ? Math.round(d.duration / 60) + ' min' : null, (d.rating || m.rating) ? '★ ' + (d.rating || m.rating) : null, d.genre].filter(Boolean).join(' · ');
            page.appendChild(el('div', 'iptv-dhead', '<div class="dposter" style="background-image:url(\'' + esc(d.poster || m.poster || '') + '\')"></div><div class="dmain"><h1>' + esc(m.name) + '</h1><div class="meta">' + esc(meta) + '</div>' +
                (d.plot ? '<p class="plot">' + esc(d.plot) + '</p>' : '') + (d.cast ? '<p class="muted">Cast: ' + esc(d.cast) + '</p>' : '') + (d.director ? '<p class="muted">Director: ' + esc(d.director) + '</p>' : '') + '</div>'));
            var row = el('div', 'hlist btn-row');
            row.setAttribute('data-anchor', 'top');
            var resume = IPTV.position(m.id);
            var b = K().button(resume ? '▶ Resume ' + Util.fmtTime(resume) : '▶ Play', function () { IPTVPlayer.start({ movie: m }, null, function () { K().show(); }); }, 'primary');
            b.setAttribute('data-autofocus', '');
            row.appendChild(b);
            if (resume) row.appendChild(K().button('Play from Start', function () { IPTV.savePosition(m.id, 0, 1); IPTVPlayer.start({ movie: m }, null, function () { K().show(); }); }));
            row.appendChild(K().button(IPTV.isFavorite(m.id) ? '★ Favorite' : '☆ Favorite', function () { IPTV.toggleFavorite(m.id); K().show(); }));
            row.appendChild(K().button('⬇ Download', function () { if (IPTVRec.download('movie', m)) Util.toast('Downloading ' + m.name); }));
            page.appendChild(row);
        });
    }

    var seasonSel = {};
    function seriesScreen(page, s) {
        detailFrame(page, s.poster);
        return IPTV.details('series', s).then(function (d) {
            if (d.backdrop) K().backdrop(d.backdrop, 'full');
            var eps = d.episodes || [];
            var seasons = []; eps.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
            seasons.sort(function (a, b) { return a - b; });
            var resumeEp = eps.filter(function (e) { return IPTV.position(e.id); })[0] || eps[0];
            var season = seasonSel[s.id] || (resumeEp ? resumeEp.season : seasons[0]);
            var meta = [s.year, (d.rating || s.rating) ? '★ ' + (d.rating || s.rating) : null, d.genre || s.genre].filter(Boolean).join(' · ');
            page.appendChild(el('div', 'iptv-dhead', '<div class="dposter" style="background-image:url(\'' + esc(d.poster || s.poster || '') + '\')"></div><div class="dmain"><h1>' + esc(s.name) + '</h1><div class="meta">' + esc(meta) + '</div>' +
                ((d.plot || s.plot) ? '<p class="plot">' + esc(d.plot || s.plot) + '</p>' : '') + '</div>'));
            var row = el('div', 'hlist btn-row');
            row.setAttribute('data-anchor', 'top');
            if (resumeEp) {
                var b = K().button((IPTV.position(resumeEp.id) ? '▶ Resume ' : '▶ Play ') + 'S' + resumeEp.season + ' E' + resumeEp.number,
                    function () { IPTVPlayer.start({ episode: [s, resumeEp, eps] }, null, function () { K().show(); }); }, 'primary');
                b.setAttribute('data-autofocus', '');
                row.appendChild(b);
            }
            row.appendChild(K().button(IPTV.isFavorite(s.id) ? '★ Favorite' : '☆ Favorite', function () { IPTV.toggleFavorite(s.id); K().show(); }));
            row.appendChild(K().button('⬇ Download Season', function () {
                eps.filter(function (e) { return e.season === season; }).forEach(function (e) { IPTVRec.download('episode', e, s); });
                Util.toast('Downloading season ' + season);
            }));
            page.appendChild(row);
            if (seasons.length > 1) {
                var sr = el('div', 'hlist iptv-seasons');
                seasons.forEach(function (n) { sr.appendChild(K().button('Season ' + n, function () { seasonSel[s.id] = n; K().show(); }, 'pill' + (n === season ? ' on' : ''))); });
                page.appendChild(sr);
            }
            eps.filter(function (e) { return e.season === season; }).forEach(function (e) {
                var pr = IPTV.progress(e.id);
                var r = el('div', 'ir ep focusable', '<span class="thumb" style="background-image:url(\'' + esc(e.thumb || s.poster || '') + '\')">' +
                    (pr ? '<i class="bar"><b style="width:' + Math.round(pr * 100) + '%"></b></i>' : '') + '</span><span class="lbl">' + e.number + '. ' + esc(e.title) +
                    '<small>' + esc([e.duration ? Math.round(e.duration / 60) + ' min' : '', e.plot || ''].filter(Boolean).join(' · ')) + '</small></span>');
                r._select = function () { IPTVPlayer.start({ episode: [s, e, eps] }, null, function () { K().show(); }); };
                r._options = function () { K().openSheet(e.title, [{ label: 'Download', action: function () { IPTVRec.download('episode', e, s); Util.toast('Downloading'); } }]); };
                page.appendChild(r);
            });
        });
    }

    /* ---------- Favorites ---------- */

    var favTab = 'live';
    function favorites(body) {
        var row = el('div', 'hlist iptv-guidehead');
        [['live', 'Live TV'], ['movies', 'Movies'], ['series', 'Series']].forEach(function (t) {
            row.appendChild(K().button(t[1], function () { favTab = t[0]; K().replace(screen, 'iptv'); }, 'pill' + (favTab === t[0] ? ' on' : '')));
        });
        body.appendChild(row);
        if (favTab === 'live') {
            var chans = IPTV.favoriteChannels();
            if (!chans.length) return body.appendChild(el('div', 'iptv-empty', '<p>No favourite channels yet. Press INFO on a channel and choose Add to Favorites.</p>'));
            var col = column('channels wide');
            chans.forEach(function (c) { col.page.appendChild(channelRow(c, chans, null)); });
            body.appendChild(col.col);
        } else {
            var items = favTab === 'movies' ? IPTV.favoriteMovies() : IPTV.favoriteSeries();
            if (!items.length) return body.appendChild(el('div', 'iptv-empty', '<p>No favourites yet. Press INFO on a poster and choose Add to Favorites.</p>'));
            grid(body, items, function (x) { return poster(x, favTab === 'movies' ? 'movie' : 'series'); });
        }
    }

    /* ---------- Search ---------- */

    var query = '', scope = 'all', searchTags = [];
    function search(body) {
        var head = el('div', 'hlist iptv-guidehead');
        head.appendChild(K().button('⌕ ' + (query ? esc(query) : 'Type to search'), function () {
            K().textEntry('Search channels, programmes, movies, series', query, function (t) { query = t; K().replace(screen, 'iptv'); });
        }, 'pill wide-pill'));
        [['all', 'Everything'], ['channels', 'Channel names'], ['programmes', 'TV programmes']].forEach(function (x) {
            head.appendChild(K().button(x[1], function () { scope = x[0]; K().replace(screen, 'iptv'); }, 'pill' + (scope === x[0] ? ' on' : '')));
        });
        body.appendChild(head);
        var tagsRow = el('div', 'hlist iptv-tags');
        IPTV.TAGS.forEach(function (t) {
            tagsRow.appendChild(K().button(esc(t), function () {
                var i = searchTags.indexOf(t); if (i >= 0) searchTags.splice(i, 1); else searchTags.push(t);
                K().replace(screen, 'iptv');
            }, 'pill small' + (searchTags.indexOf(t) >= 0 ? ' on' : '')));
        });
        body.appendChild(tagsRow);
        var r = IPTV.search(query, searchTags, scope);
        if (r.channels.length) body.appendChild(shelf('Channels', null, r.channels.slice(0, 60).map(function (c) { return channelCard(c, r.channels); })));
        if (r.programmes.length) {
            var sec = el('section', 'iptv-results');
            sec.appendChild(el('h2', '', 'On TV'));
            r.programmes.forEach(function (x) {
                var p = x.programme, ch = x.channel, airing = p.start <= Date.now();
                var row = el('div', 'ir prog focusable', '<span class="when' + (airing ? ' now' : '') + '">' + (airing ? 'Now' : esc(day(p.start))) + '<b>' + clock(p.start) + '</b></span>' +
                    '<span class="logo" style="background-image:url(\'' + esc(ch.logo || '') + '\')"></span><span class="lbl">' + esc(p.title) +
                    '<small>' + dot(ch.playlistID) + esc([ch.name, p.category].filter(Boolean).join(' · ')) + ' ' + tagsHtml(ch) + '</small></span>');
                row.setAttribute('data-anchor', '');
                row._select = function () { programmeSheet(ch, p, r.channels.length ? r.channels : [ch]); };
                sec.appendChild(row);
            });
            body.appendChild(sec);
        }
        if (r.movies.length) body.appendChild(shelf('Movies', null, r.movies.map(function (m) { return poster(m, 'movie'); })));
        if (r.series.length) body.appendChild(shelf('Series', null, r.series.map(function (s) { return poster(s, 'series'); })));
        if (!r.channels.length && !r.programmes.length && !r.movies.length && !r.series.length && (query.length >= 2 || searchTags.length))
            body.appendChild(el('div', 'iptv-empty', '<p>No results</p>'));
    }

    /* ---------- Downloads and recordings ---------- */

    function jobs(body, kind) {
        var list = IPTVRec.list(kind);
        if (!IPTVRec.supported()) body.appendChild(el('div', 'muted pad', 'Recording and downloads work on the TV only (not in a desktop browser).'));
        if (!list.length) {
            body.appendChild(el('div', 'iptv-empty', '<p>' + (kind === 'download' ? 'No downloads. Download movies and episodes from their pages, or past programmes from the TV Guide.' :
                'No recordings. Record a channel from its options or the player, or schedule a programme in the TV Guide.') + '</p>'));
            return;
        }
        var col = column('channels wide');
        list.forEach(function (j) {
            var state = { scheduled: 'Scheduled · ' + day(j.start) + ' ' + clock(j.start), running: kind === 'recording' ? '● Recording' : 'Downloading', done: 'Ready', failed: 'Failed', cancelled: 'Cancelled' }[j.state];
            var size = j.received ? (j.received / 1048576).toFixed(0) + ' MB' : '';
            var pct = j.expected ? Math.round(j.received / j.expected * 100) : 0;
            var r = el('div', 'ir job focusable', '<span class="logo" style="background-image:url(\'' + esc(j.poster || '') + '\')"></span><span class="lbl">' + esc(j.title) +
                '<small>' + esc([j.subtitle, state, size, pct ? pct + '%' : '', j.error].filter(Boolean).join(' · ')) + '</small></span>');
            r._select = function () { if (j.state === 'done') IPTVPlayer.start({ file: j }, null, function () { K().show(); }); else jobOptions(j); };
            r._options = function () { jobOptions(j); };
            col.page.appendChild(r);
        });
        body.appendChild(col.col);
    }

    function jobOptions(j) {
        var rows = [];
        if (j.state === 'done') rows.push({ label: 'Play', action: function () { IPTVPlayer.start({ file: j }, null, function () { K().show(); }); } });
        if (j.state === 'running' || j.state === 'scheduled') rows.push({ label: j.state === 'running' ? 'Stop' : 'Cancel', action: function () { IPTVRec.stop(j.id); K().show(); } });
        if (j.state === 'failed' || j.state === 'cancelled') rows.push({ label: 'Try Again', action: function () { IPTVRec.retry(j.id); K().show(); } });
        rows.push({ label: 'Delete', action: function () { IPTVRec.remove(j.id); K().show(); } });
        K().openSheet(j.title, rows);
    }

    /* ---------- Playlists ---------- */

    function playlists(body) {
        var col = column('channels wide');
        var add = el('div', 'ir focusable', '<span class="lbl">＋ Add Playlist</span>');
        add._select = function () { editPlaylist(null); };
        col.page.appendChild(add);
        IPTV.playlists().forEach(function (p) {
            var c = IPTV.content(p.id), a = c && c.account;
            var lines = [p.kind === 'xtream' ? 'Xtream Codes' : 'M3U playlist', p.enabled ? '' : 'Off',
                c ? c.channels.length + ' channels · ' + c.movies.length + ' movies · ' + c.series.length + ' series' : '',
                a ? [a.status, a.expires ? 'expires ' + new Date(a.expires).toDateString() : '', a.maxConnections ? (a.activeConnections || 0) + '/' + a.maxConnections + ' connections' : ''].filter(Boolean).join(' · ') : '',
                IPTV.loading(p.id) ? 'Refreshing…' : '', IPTV.error(p.id) || ''].filter(Boolean).join(' · ');
            var r = el('div', 'ir focusable', '<i class="sdot big" style="background:' + IPTV.color(p) + '"></i><span class="lbl">' + esc(p.name) + '<small>' + esc(lines) + '</small></span>');
            r._select = function () {
                K().openSheet(p.name, [
                    { label: 'Refresh', action: function () { IPTV.refresh(p.id).then(function () { K().show(); }); Util.toast('Refreshing ' + p.name); } },
                    { label: 'Edit', action: function () { editPlaylist(p); } },
                    { label: p.enabled ? 'Turn Off' : 'Turn On', action: function () { IPTV.setEnabled(p.id, !p.enabled); K().show(); } },
                    { label: 'Delete', action: function () { IPTV.deletePlaylist(p.id); K().show(); } }
                ]);
            };
            col.page.appendChild(r);
        });
        function item(label, detail, fn) { var r = el('div', 'ir focusable', '<span class="lbl">' + esc(label) + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>'); r._select = fn; col.page.appendChild(r); }
        col.page.appendChild(el('div', 'ir-h', 'TV Guide'));
        item('Refresh Guide', IPTV.guideLoading() ? 'Loading…' : IPTV.guideUpdated() ? 'Updated ' + day(IPTV.guideUpdated()) + ' ' + clock(IPTV.guideUpdated()) : 'Not loaded', function () { IPTV.refreshGuide().then(function () { K().show(); }); Util.toast('Loading the guide'); });
        item('Refresh Everything', '', function () { IPTV.refreshAll().then(function () { K().show(); }); Util.toast('Refreshing'); });
        col.page.appendChild(el('div', 'ir-h', 'Parental Control'));
        if (!IPTV.pin()) item('Set a PIN', 'Locked groups ask for it', function () { K().pinPad('New PIN', function (p) { IPTV.setPIN(p); K().show(); }); });
        else {
            item(IPTV.unlocked() ? 'Lock Locked Groups Again' : 'Unlock Locked Groups', '', function () {
                if (IPTV.unlocked()) { IPTV.lock(); K().show(); } else K().pinPad('Enter PIN', function (p) { if (!IPTV.unlock(p)) Util.toast('Wrong PIN'); K().show(); });
            });
            item('Change PIN', '', function () { K().pinPad('New PIN', function (p) { IPTV.setPIN(p); }); });
        }
        var hidden = IPTV.groups('live', true).concat(IPTV.groups('movie', true), IPTV.groups('series', true)).filter(IPTV.isHidden);
        if (hidden.length) {
            col.page.appendChild(el('div', 'ir-h', 'Hidden Groups (OK to show again)'));
            hidden.forEach(function (g) { item(g.name, g.kind === 'live' ? 'Live TV' : g.kind === 'movie' ? 'Movies' : 'Series', function () { IPTV.setHidden(g, false); K().show(); }); });
        }
        col.page.appendChild(el('div', 'ir-h', 'Library'));
        item('Clear Recently Watched', '', function () { IPTV.clearRecents(); Util.toast('Cleared'); });
        IPTV.reminders().forEach(function (r) { item('🔔 ' + r.title, r.channelName + ' · ' + day(r.start) + ' ' + clock(r.start), function () {}); });
        body.appendChild(col.col);
    }

    /* A form on a sheet: each field opens the on-screen keyboard. */
    function editPlaylist(p) {
        var d = p ? JSON.parse(JSON.stringify(p)) : { name: '', kind: 'xtream', url: '', username: '', password: '', epgURL: '', userAgent: '', enabled: true };
        function draw() {
            var rows = [
                { label: 'Type', value: d.kind === 'xtream' ? 'Xtream Codes' : 'M3U playlist', keep: true, action: function () { d.kind = d.kind === 'xtream' ? 'm3u' : 'xtream'; draw(); } },
                { label: 'Name', value: d.name || '—', keep: true, action: function () { field('Name', 'name'); } },
                { label: d.kind === 'xtream' ? 'Server (http://host:port)' : 'Playlist address', value: d.url || '—', keep: true, action: function () { field('Address', 'url'); } }
            ];
            if (d.kind === 'xtream') {
                rows.push({ label: 'Username', value: d.username || '—', keep: true, action: function () { field('Username', 'username'); } });
                rows.push({ label: 'Password', value: d.password ? '••••••' : '—', keep: true, action: function () { field('Password', 'password'); } });
            }
            rows.push({ label: 'Guide address (XMLTV, optional)', value: d.epgURL || '—', keep: true, action: function () { field('Guide address', 'epgURL'); } });
            rows.push({ label: 'User agent (optional)', value: d.userAgent || '—', keep: true, action: function () { field('User agent', 'userAgent'); } });
            var ok = d.url && (d.kind === 'm3u' || (d.username && d.password));
            rows.push({ label: p ? 'Save' : 'Add Playlist', disabled: !ok, action: function () {
                if (!d.name) d.name = (d.url.replace(/^https?:\/\//, '').split(/[\/:]/)[0]) || 'Playlist';
                Util.toast('Loading ' + d.name + '…');
                IPTV.savePlaylist(d).then(function () { K().replace(screen, 'iptv'); });
            } });
            K().openSheet(p ? 'Edit Playlist' : 'Add Playlist', rows, { wide: true });
        }
        function field(title, k) { K().textEntry(title, d[k], function (t) { d[k] = t; draw(); }); }
        draw();
    }

    return { _movie: function (p, m) { return movieScreen(p, m); }, _series: function (p, s) { return seriesScreen(p, s); }, screen: screen, options: function (f) { if (f && f._options) { f._options(); return true; } return false; } };
})();
