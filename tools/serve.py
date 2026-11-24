"""テスト用のサーバー（ブラウザに古いファイルを覚えさせない版）。

使い方:  python3 tools/serve.py        → http://127.0.0.1:8765/
ふつうの `python3 -m http.server` だと、ブラウザが古い engine.js などを覚えていて
（キャッシュ）、書き換えたあともテストが古いファイルで動くことがある。
このサーバーは「毎回取り直して」という指示（Cache-Control: no-store）を付けて返す。
"""
import functools
import http.server
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


def main():
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"serving {ROOT} at http://127.0.0.1:{PORT}/")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
