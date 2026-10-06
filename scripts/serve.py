#!/usr/bin/env python3
"""
本机调试：起一个只供本机访问的静态服务器并打开首页（页面用 ES 模块和 Web Worker，不能直接双击 html 打开）
  python scripts/serve.py                  默认服务 site/，端口 8000
  python scripts/serve.py --port 8080 --root <目录> --no-open
只用 Python 标准库。显式指定 .js / .mjs / .wasm 的类型：Windows 注册表可能把 .js 映射成别的类型，模块脚本会被浏览器拒绝。
每次请求都让浏览器向服务器确认文件是否更新（no-cache），改过代码刷新即生效。
"""
import argparse
import functools
import http.server
import pathlib
import webbrowser

SITE = pathlib.Path(__file__).resolve().parent.parent / "site"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".bcmap": "application/octet-stream",
        ".ini": "text/plain; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser(description="财务工具本地服务")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--root", default=str(SITE), help="服务的目录，默认 site/")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=args.root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"服务目录 {args.root}\n浏览器打开 {url}　（Ctrl+C 停止）")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
