"""Sirve brand/ en http://localhost:4321 sin caché, para ver cada cambio al recargar.

Uso: python3 brand/serve.py
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


ThreadingHTTPServer(("127.0.0.1", 4321), partial(NoCache, directory=Path(__file__).parent)).serve_forever()
