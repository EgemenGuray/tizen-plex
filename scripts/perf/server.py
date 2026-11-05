# Serves the app and the mock IPTV sources (Xtream player_api.php, M3U, XMLTV, logos) for scripts/perf/bench.js.
# python3 server.py <app-dir> <data-dir> <port>
import sys, os, base64, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
APP, DATA, PORT = sys.argv[1], sys.argv[2], int(sys.argv[3])
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=APP, **k)
    def log_message(self, *a): pass
    def send_bytes(self, b, ct):
        self.send_response(200); self.send_header('Content-Type', ct); self.send_header('Content-Length', str(len(b)))
        self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith('/mock/'):
            p = u.path[6:]
            if p == 'player_api.php':
                q = urllib.parse.parse_qs(u.query); a = q.get('action', [None])[0]
                f = os.path.join(DATA, 'x_%s.json' % a if a else 'x_root.json')
                if not os.path.exists(f): return self.send_bytes(b'[]', 'application/json')
                return self.send_bytes(open(f, 'rb').read(), 'application/json')
            if p.startswith('logo/') or p.startswith('poster/'): return self.send_bytes(PNG, 'image/png')
            f = os.path.join(DATA, os.path.basename(p))
            if os.path.exists(f): return self.send_bytes(open(f, 'rb').read(), 'application/octet-stream')
            self.send_error(404); return
        return super().do_GET()
ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
