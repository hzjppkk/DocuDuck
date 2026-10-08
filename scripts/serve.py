#!/usr/bin/env python3
"""
本地静态服务器并打开首页（页面用 ES 模块和 Web Worker，不能直接双击 html 打开）
  python scripts/serve.py                  默认（双击也是）：局域网共享，同网段的电脑可访问；只服务 site/、不列目录，端口 8000
  python scripts/serve.py --local          只供本机访问（调试用），可列目录
  python scripts/serve.py --local --port 8080 --root <目录> --no-open
只用 Python 标准库。显式指定 .js / .mjs / .wasm 的类型：Windows 注册表可能把 .js 映射成别的类型，模块脚本会被浏览器拒绝。
每次请求都让浏览器向服务器确认文件是否更新（no-cache），改过代码刷新即生效。
局域网模式下 PDF 仍在各自的浏览器里识别，不会传到本机；site/ 中的 whitelist.ini 对访问者可见。
"""
import argparse
import functools
import http.server
import pathlib
import socket
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
    listing = True

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        if self.listing:
            return super().list_directory(path)
        self.send_error(404)


def lan_ips():
    """本机各网卡的 IPv4 地址（去掉回环、未连通网卡的 169.254.x.x）；可能含 WSL、Docker、代理软件的虚拟网卡，无法自动分辨"""
    ips = socket.gethostbyname_ex(socket.gethostname())[2]
    return [ip for ip in ips if not ip.startswith(("127.", "169.254."))]


def main():
    ap = argparse.ArgumentParser(description="财务工具本地服务")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--root", default=str(SITE), help="服务的目录，默认 site/（局域网共享时只能是 site/）")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--local", action="store_true", help="只供本机访问（调试用），可列目录、可指定其他目录")
    args = ap.parse_args()
    lan = not args.local
    if lan and pathlib.Path(args.root).resolve() != SITE:
        ap.error("局域网共享只能服务 site/，避免把样本等其他文件暴露到局域网；调试其他目录请加 --local")
    handler = functools.partial(type("H", (Handler,), {"listing": not lan}), directory=args.root)
    with http.server.ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", args.port), handler) as httpd:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"服务目录 {args.root}\n本机打开 {url}")
        if lan:
            print("局域网访问（用与同事电脑同一网段的地址；首次运行时 Windows 防火墙会询问，选“专用网络”）：")
            for ip in lan_ips():
                print(f"  http://{ip}:{args.port}/")
        print("Ctrl+C 停止")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
