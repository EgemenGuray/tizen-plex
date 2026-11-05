# Generates the big test sources for scripts/perf/bench.js: python3 gen.py <out-dir>
import json, random, time, sys
random.seed(1)
D = sys.argv[1]
now = int(time.time())
# M3U: 20k channels in 400 groups
with open(D + '/big.m3u', 'w') as f:
    f.write('#EXTM3U\n')
    for i in range(20000):
        g = 'Group %d' % (i // 50)
        q = ['HD', 'FHD', '4K', 'SD', ''][i % 5]
        f.write('#EXTINF:-1 tvg-id="ch%d.tv" tvg-name="Channel %d" tvg-logo="/mock/logo/%d.png" group-title="%s",Channel %d %s\n' % (i, i, i, g, i, q))
        f.write('http://stream.example/live/u/p/%d.ts\n' % i)
# Xtream
cats = lambda n, p: [{'category_id': str(k), 'category_name': '%s %d' % (p, k), 'parent_id': 0} for k in range(n)]
json.dump({'user_info': {'auth': 1, 'status': 'Active', 'exp_date': str(now + 86400 * 90), 'max_connections': '2', 'active_cons': '0', 'is_trial': '0'},
           'server_info': {'timezone': 'Europe/London'}}, open(D + '/x_root.json', 'w'))
json.dump(cats(150, 'Live'), open(D + '/x_get_live_categories.json', 'w'))
json.dump([{'num': i + 1, 'name': 'XLive %d HD' % i, 'stream_type': 'live', 'stream_id': 100000 + i, 'stream_icon': '/mock/logo/x%d.png' % i,
            'epg_channel_id': 'x%d.tv' % i, 'added': str(now - i), 'category_id': str(i % 150), 'tv_archive': i % 3 == 0 and 1 or 0, 'tv_archive_duration': 3}
           for i in range(10000)], open(D + '/x_get_live_streams.json', 'w'))
json.dump(cats(300, 'Movies'), open(D + '/x_get_vod_categories.json', 'w'))
json.dump([{'num': i + 1, 'name': 'Movie Title Number %d (%d)' % (i, 1980 + i % 45), 'stream_type': 'movie', 'stream_id': 200000 + i,
            'stream_icon': '/mock/poster/%d.jpg' % i, 'rating': '%.1f' % (random.random() * 10), 'rating_5based': 3, 'added': str(now - i * 60),
            'category_id': str(i % 300), 'container_extension': 'mkv', 'custom_sid': '', 'direct_source': ''} for i in range(50000)],
          open(D + '/x_get_vod_streams.json', 'w'))
json.dump(cats(120, 'Series'), open(D + '/x_get_series_categories.json', 'w'))
json.dump([{'num': i + 1, 'name': 'Series Show %d' % i, 'series_id': 300000 + i, 'cover': '/mock/poster/s%d.jpg' % i,
            'plot': 'A plot about show %d that goes on for a while to be realistic.' % i, 'cast': 'A, B, C', 'director': 'D', 'genre': 'Drama',
            'releaseDate': '20%02d-01-01' % (i % 25), 'last_modified': str(now), 'rating': '7.1', 'category_id': str(i % 120)} for i in range(10000)],
          open(D + '/x_get_series.json', 'w'))
# XMLTV ~100 MB: 5000 M3U channels + 1000 Xtream channels + 2000 unrelated, 4 days of 1 h shows (-2d .. +2d)
def ts(t): return time.strftime('%Y%m%d%H%M%S +0000', time.gmtime(t))
start = (now // 3600) * 3600 - 36 * 3600
ids = ['ch%d.tv' % i for i in range(5000)] + ['x%d.tv' % i for i in range(1000)] + ['other%d.tv' % i for i in range(2000)]
with open(D + '/guide.xml', 'w') as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="bench">\n')
    for cid in ids:
        f.write('  <channel id="%s"><display-name lang="en">%s</display-name><icon src="/mock/logo/%s.png" /></channel>\n' % (cid, cid.split('.')[0], cid))
    for cid in ids:
        for h in range(36):
            t = start + h * 7200
            f.write('  <programme start="%s" stop="%s" channel="%s"><title lang="en">Show %d on %s</title><sub-title>Part %d</sub-title>'
                    '<desc lang="en">Description of the show &amp; what happens in episode %d, with a few more words to be realistic about size.</desc>'
                    '<category lang="en">Drama</category><episode-num system="xmltv_ns">1.%d.</episode-num></programme>\n' % (ts(t), ts(t + 7200), cid, h, cid, h, h, h % 20))
    f.write('</tv>\n')
