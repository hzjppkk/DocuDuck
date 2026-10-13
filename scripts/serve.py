#!/usr/bin/env python3
"""
本地静态服务器并打开首页（页面用 ES 模块和 Web Worker，不能直接双击 html 打开）
  python scripts/serve.py                  默认（双击也是）：局域网共享，同网段的电脑可访问；只服务 site/、不列目录，端口 8080
  python scripts/serve.py --local          只供本机访问（调试用），可列目录
  python scripts/serve.py --local --port 8080 --root <目录> --no-open
接口在网页目录（site/）旁的 api/ 下：根目录是 site/ 时为 /api/…；调试时根目录设为上级目录（如为了访问样本），为 /<到 site 的路径>/api/…
只用 Python 标准库。显式指定 .js / .mjs / .wasm 的类型：Windows 注册表可能把 .js 映射成别的类型，模块脚本会被浏览器拒绝。
每次请求都让浏览器向服务器确认文件是否更新（no-cache），改过代码刷新即生效。局域网模式下 PDF 仍在各自的浏览器里识别。

配置：scripts/config.ini（不入库，含密钥，不能放进 site/），分五节，改后重启生效：
  [存档]              switch = 1 / 0：0（默认，没有这一项时也是）为纯本地模式，提交、查询、下载接口都不可用，页面上也不显示（不写存放目录）
  [发票购买方白名单]  每行「公司名称:统一社会信用代码」，GET /api/whitelist 原样提供给发票页面
  [查询白名单]        每行一个 IP 或网段（如 192.168.1.0/24）；本机也要写（127.0.0.1）
  [下载]              密码 = …：查询白名单内的人下载服务器上的归档文件时要输入；为空时不能下载
  [OCR]               provider = tencent、secret_id、secret_key、region（可选 qps）；有空值时不启用 OCR
提交（网页的「提交」，见 site/common/archive.js）：文件存到 --store 目录（默认仓库根目录下的 submitted/，不在 site/ 里、网页访问不到）下的 <工具目录>/。
  启动时试写一次，写不进去时上传拒绝（403）。
  清单：每个工具目录一份 清单.jsonl，每提交一个文件追加一行（同一文件后写的为准），只记非敏感字段：网页给的显示字段（合同号、申报日期、
    单据类型、部分隐去的报关单号等）、大小、修改时间、提交者 IP、提交时间，下载过的再记 下载：[{ IP, 时间 }]；完整编号、归档路径只记校验值（HMAC，密钥在 --store 下的
    .清单密钥，看不出原文）；海关编号、提运单号、集装箱号原文只供服务器比对提运单、数电发票，查询时不发给页面。查询、问是否已提交都只读清单，不遍历目录；
    删除归档文件后清单保留
  PUT /api/files/<工具目录>/<路径>.pdf 上传：同名已存在且修改时间比上传的晚，或时间相同、大小也相同时不写（409），否则覆盖（200），
    新文件 201；
    请求头 X-Last-Modified：原文件修改时间（毫秒），文件按它设修改时间；请求体开头是清单字段（JSON，字节数见 X-Meta-Length，
    见 manifest_entry），其后是文件
  GET /api/files → { archive, writable, query, download }：是否开启存档、能否提交、能否查询（查询白名单内）、能否下载（再加设了密码）
  POST /api/exists?dir=<工具目录>（请求体 { names: [文件名], stamps: ["大小/修改时间秒"], keys: [编号], bills: [{ 全文, 集装箱号 }] }）
    → { exists: {名称: { 大小, 修改时间 }}, stamps: [清单里有的], keys: {编号: { 校验, 类型: [已有的单据类型] }}（清单里有的）,
        bills: [[报关单 + 提运单号?]]（本地提运单、发票属于哪几份已提交的报关单，供归档） }：
    只能问到自己手上的单据相关的
  GET /api/manifest?dir=<工具目录>（查询白名单内，查询页）→ { groups: [每份已提交的报关单], files: [各文件的清单字段] }
下载（查询白名单内，且要密码）：
  POST /api/download?dir=<工具目录>（请求体 { password }）→ { token, count, bytes }：记下此刻目录里的归档文件
  GET /api/download/<token> 下载这些文件的 zip（不压缩，边打包边发送）；GET /api/download/<token>/status → { done, failed }：是否已发送完、中断
  POST /api/purge（请求体 { token }）：发送完之后，删除这次下载里的、之后没有变过的文件（清单保留）
OCR（网页上疑似提运单的「OCR」）：调用 scripts/ocr_<provider>.py 的 recognize（换接口只换这个文件）；
  GET /api/ocr 查询是否启用，POST /api/ocr?pages=<页数>（请求体为 PDF）返回 { text }
"""
import argparse
import datetime
import functools
import hashlib
import hmac
import http.server
import importlib
import ipaddress
import json
import os
import pathlib
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser
import zipfile

SITE = pathlib.Path(__file__).resolve().parent.parent / "site"
STORE = SITE.parent / "submitted"
CONFIG = pathlib.Path(__file__).resolve().parent / "config.ini"
API = "/api/files"
ARCHIVE_APIS = (API, "/api/exists", "/api/manifest", "/api/download", "/api/purge")  # 存档关闭时不可用（含其下的路径）
MAX_SIZE = 100 * 1024 * 1024
MAX_OCR_PAGES = 20
MANIFEST = "清单.jsonl"
KEY_FILE = ".清单密钥"
DOWNLOAD_TTL = 3600  # 下载凭据的有效期（秒）


def writable(d):
    """目录能否写入：不存在时先建，再试写一个临时文件"""
    try:
        d.mkdir(parents=True, exist_ok=True)
        tempfile.TemporaryFile(dir=d).close()
        return True
    except OSError:
        return False


def read_config():
    """config.ini → {节名: [各行]}（去掉空行和 # 开头的注释）；文件不存在时为空"""
    sections, cur = {}, None
    if CONFIG.exists():
        for line in CONFIG.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if re.fullmatch(r"\[.+\]", line):
                cur = sections.setdefault(line[1:-1].strip(), [])
            elif line and not line.startswith("#") and cur is not None:
                cur.append(line)
    return sections


def key_values(lines):
    """「名称 = 值」各行 → dict"""
    return dict((k.strip(), v.strip()) for k, _, v in (l.partition("=") for l in lines))


def load_ocr(lines):
    """[OCR] 节 → (配置, 接口模块)；没有或有空值时返回 None"""
    cfg = key_values(lines)
    if not cfg.get("provider") or not all(cfg.values()):
        return None
    return cfg, importlib.import_module(f"ocr_{cfg['provider']}")


def load_allow(lines):
    """[查询白名单] 节 → 网段列表；写错的行跳过并提示"""
    nets = []
    for l in lines:
        try:
            nets.append(ipaddress.ip_network(l, strict=False))
        except ValueError:
            print(f"[查询白名单] 跳过无法识别的一行：{l}")
    return nets


class Manifest:
    """各工具目录的清单（清单.jsonl）：追加写入，读取时按 id（归档路径的校验值）合并，同一文件后写的为准；按文件大小、修改时间缓存"""

    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.cache = {}  # 清单文件 → ((大小, 修改时间), {id: 条目})
        self.indexes = {}  # 工具目录 → (算的时候的那份条目, 统计)，见 index
        kf = store / KEY_FILE
        try:
            if not kf.exists():
                kf.write_text(secrets.token_hex(32), encoding="ascii")
            self.key = bytes.fromhex(kf.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            self.key = secrets.token_bytes(32)  # 存放目录不能写：不能提交，清单也不会有内容，用临时密钥即可

    def sign(self, text):
        """校验值：同样的原文得到同样的值，看不出原文（没有密钥也算不出来）"""
        return hmac.new(self.key, text.encode(), hashlib.sha256).hexdigest()[:32]

    @staticmethod
    def stamp(f):
        try:
            st = f.stat()
            return (st.st_size, st.st_mtime_ns)
        except OSError:
            return None

    def entries(self, d):
        f = d / MANIFEST
        stamp = self.stamp(f)
        if not stamp:
            return {}
        with self.lock:
            hit = self.cache.get(f)
            if hit and hit[0] == stamp:
                return hit[1]
            out = {}
            with open(f, encoding="utf-8") as fp:
                for line in fp:
                    try:
                        e = json.loads(line)
                        out[e["id"]] = e
                    except (ValueError, KeyError, TypeError):
                        continue  # 写到一半的行等
            self.cache[f] = (stamp, out)
            return out

    def index(self, d):
        """清单的统计，跟着同一份缓存：清单不变就复用，变了（entries 换成新的一份）才重算。
        { stamps: {"大小/修改时间"}, groups: {校验值: 一份报关单} }；一份报关单：名称（部分隐去的编号）、合同协议号、申报日期、
        已提交 {单据类型: "提交时间 · 提交者 IP"}，以及只供比对、不发给页面的 海关编号、提运单号、集装箱号"""
        entries = self.entries(d)
        hit = self.indexes.get(d)
        if hit and hit[0] is entries:
            return hit[1]
        idx = {"stamps": set(), "groups": {}}
        for e in entries.values():
            idx["stamps"].add(f"{e['大小']}/{e['修改时间']}")
            for g in e.get("组", []):
                cur = idx["groups"].setdefault(g["校验"], {"名称": "", "合同协议号": "", "申报日期": "", "已提交": {},
                                                          "海关编号": "", "提运单号": "", "集装箱号": set()})
                for k in ("名称", "海关编号", "提运单号"):
                    cur[k] = cur[k] or g.get(k, "")
                for k in ("合同协议号", "申报日期"):
                    cur[k] = cur[k] or e.get(k, "")
                cur["集装箱号"] |= set(g.get("集装箱号", []))
                cur["已提交"][e.get("单据类型", "")] = f"{e.get('提交时间', '').replace('T', ' ')} · {e.get('提交IP', '')}"
        self.indexes[d] = (entries, idx)
        return idx

    @staticmethod
    def show(h, g, who):
        """发给页面的一份报关单：不含海关编号、提运单号、集装箱号原文；who 为假时（普通用户）不带提交时间和 IP"""
        return {"校验": h, "名称": g["名称"], "合同协议号": g["合同协议号"], "申报日期": g["申报日期"],
                "已提交": {t: (v if who else "") for t, v in g["已提交"].items()}}

    def add(self, d, *entries):
        """追加；缓存是最新的就顺手更新（另建一份，正在读旧缓存的请求不受影响），不必下次整份重读"""
        f = d / MANIFEST
        with self.lock:
            hit = self.cache.get(f)
            fresh = hit and hit[0] == self.stamp(f)
            with open(f, "a", encoding="utf-8") as fp:
                fp.writelines(json.dumps(e, ensure_ascii=False) + "\n" for e in entries)
            if fresh:
                self.cache[f] = (self.stamp(f), {**hit[1], **{e["id"]: e for e in entries}})


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ".bcmap": "application/octet-stream",
    }
    # 长连接：默认的 HTTP/1.0 每个请求新建一次连接，经网络批量请求时连接排队、卡住；空闲 30 秒的连接断开
    protocol_version = "HTTP/1.1"
    timeout = 30
    wbufsize = 256 * 1024  # 发送缓冲：下载 zip 等大响应攒够再发，不按 8 KB 一个小包发（每个请求处理完自动发出剩余的）
    # 由 main 设置：listing、store、manifest、can_write、ocr、archive、allow、whitelist、password、base（见 route）
    downloads = {}  # 下载凭据 → { dir, files: [(路径, 大小, 修改时间)], ip, time, done }
    downloads_lock = threading.Lock()
    password_lock = threading.Lock()
    password_fails = (0, 0)  # (连续输错次数, 最近一次输错的时间)，所有人共用

    def client_ip(self):
        """来访 IP（浏览器直接连 serve.py，连接的对方地址就是）"""
        return ipaddress.ip_address(self.client_address[0])

    def can_query(self):
        ip = self.client_ip()
        return any(ip in n for n in self.allow)

    def route(self):
        """(接口路径, url)：根目录是 site/ 的上级时，去掉到 site/ 的前缀（base），接口路径统一为 /api/…"""
        url = urllib.parse.urlsplit(self.path)
        path = url.path[len(self.base):] if self.base and url.path.startswith(self.base + "/api/") else url.path
        return path, url

    def closed(self, path):
        """存档关闭时，提交、查询、下载的接口都不可用"""
        return not self.archive and any(path == a or path.startswith(a + "/") for a in ARCHIVE_APIS)

    def do_GET(self):
        path, url = self.route()
        if path == "/api/ocr":
            return self.reply(200, {"enabled": bool(self.ocr)})
        if path == "/api/whitelist":
            return self.reply(200, {"text": self.whitelist})
        if self.closed(path):
            return self.reply(200, {"archive": False}) if path == API else self.reply(404, {"error": "存档已关闭"})
        if path == API:
            query = self.can_query()
            return self.reply(200, {"archive": True, "writable": self.can_write, "query": query, "download": query and bool(self.password)})
        if path == "/api/manifest":
            d = self.dir_of(url)
            if not self.can_query():
                return self.reply(403, {"error": "不在查询白名单内"})
            if not d:
                return self.reply(400, {"error": "目录不对"})
            # 查询页的列表：每份报关单一条（Manifest.show，不含编号原文）；各文件的清单字段（发票视图用）
            files = [{k: v for k, v in e.items() if k not in ("id", "组", "下载")} for e in self.manifest.entries(d).values()]
            return self.reply(200, {"groups": [self.manifest.show(h, g, True) for h, g in self.manifest.index(d)["groups"].items()], "files": files})
        if path.startswith("/api/download/"):
            return self.get_download(path[len("/api/download/"):])
        return super().do_GET()

    def do_POST(self):
        path, url = self.route()
        size = self.number("Content-Length") or 0
        if size > MAX_SIZE:
            return self.refuse(413, "太大")
        if self.closed(path):
            return self.refuse(404, "存档已关闭")
        if path == "/api/exists":
            return self.post_exists(url, size)
        if path == "/api/download":
            return self.post_download(url, size)
        if path == "/api/purge":
            return self.post_purge(size)
        if path != "/api/ocr":
            return self.refuse(404, "没有这个接口")
        if not self.ocr:
            return self.refuse(404, "未启用 OCR")
        pages = (urllib.parse.parse_qs(url.query).get("pages") or ["1"])[0]
        pages = int(pages) if pages.isdigit() else 1
        data = self.rfile.read(size)
        cfg, provider = self.ocr
        try:
            text = provider.recognize(data, max(1, min(pages, MAX_OCR_PAGES)), cfg)
        except Exception as e:  # 接口返回的错误、网络错误都交给网页提示
            return self.reply(502, {"error": str(e)})
        self.reply(200, {"text": text})

    def do_PUT(self):
        path, _ = self.route()
        rel = urllib.parse.unquote(path[len(API) + 1:]) if path.startswith(API + "/") else ""
        p = self.target(rel)
        size = self.number("Content-Length") or 0
        if self.closed(path):
            return self.refuse(404, "存档已关闭")
        if not self.can_write:
            return self.refuse(403, "服务器不能写入")
        if not p or p.suffix.lower() != ".pdf" or "/" not in rel:
            return self.refuse(400, "路径不合法")
        if size > MAX_SIZE:
            return self.refuse(413, "文件太大")
        data = self.rfile.read(size)
        if len(data) != size:  # 上传到一半连接断了：不存半截文件，清单也不记
            return self.refuse(400, "上传不完整")
        # 请求体开头是清单字段（JSON，长度见 X-Meta-Length），后面是文件；放在请求头里，一份提运单属于很多报关单时会超过请求头的长度上限
        n = min(self.number("X-Meta-Length") or 0, len(data))
        meta, data = data[:n], data[n:]
        # 原文件的修改时间（X-Last-Modified，毫秒）：存下的文件沿用它，供按大小 + 修改时间认出库中已有的文件；没有时按现在
        ms = self.number("X-Last-Modified")
        up = ms // 1000 if ms is not None else int(time.time())
        d = self.store / rel.split("/")[0]
        st = p.stat() if p.is_file() else None
        old = self.manifest.entries(d).get(self.manifest.sign(rel))
        # 服务器上的这一份：磁盘上的文件；归档已下载删除的，按清单里记的
        cur = (st.st_size, int(st.st_mtime)) if st else (old["大小"], old["修改时间"]) if old else None
        # 服务器上的更新（不论大小），或时间、大小都相同（同一份）：不写
        code = 409 if cur and (cur[1] > up or cur == (len(data), up)) else 200 if st else 201
        if code != 409:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".tmp")  # 先写临时文件再替换，中途出错不留半个文件
            tmp.write_bytes(data)
            tmp.replace(p)
            if ms is not None:
                os.utime(p, ns=(p.stat().st_atime_ns, ms * 1_000_000))
            self.manifest.add(d, self.manifest_entry(rel, meta, len(data), up))  # 追加一行，后写的为准
        self.reply(code, {"overwritten": True} if code == 200 else {})

    def refuse(self, code, error):
        """没读请求体就回复：之后断开连接（请求体还在连接里，不能接着读下一个请求）。读完请求体的照常保持连接，
        批量上传沿用同一个连接，不必每个文件新建一次（频繁新建连接会被防火墙等限流，导致连接超时）"""
        self.close_connection = True
        self.reply(code, {"error": error})

    def number(self, name):
        """请求头里的非负整数；没有或写错时为 None"""
        v = self.headers.get(name) or ""
        return int(v) if v.isdigit() else None

    def manifest_entry(self, rel, meta, size, mtime):
        """清单的一条：meta（请求体开头的 JSON）为 { 字段: {名称: 文字}, 组: [{ 名称, 校验 | 已校验, 提运单号?, 集装箱号? }] }。
        字段原样记下（网页只放非敏感的）；组的 校验 换成校验值（只在服务器上的组，网页没有完整编号，给的是 已校验）；
        海关编号（校验 的原文）、提运单号、集装箱号原样记下，只供服务器比对提运单、数电发票，查询时不发给页面"""
        try:
            meta = json.loads(meta or b"{}")
        except ValueError:
            meta = {}
        fields = meta.get("字段") if isinstance(meta, dict) and isinstance(meta.get("字段"), dict) else {}
        groups = meta.get("组") if isinstance(meta, dict) and isinstance(meta.get("组"), list) else []
        return {
            **{str(k)[:20]: str(v)[:100] for k, v in list(fields.items())[:10]},
            "组": [self.group_entry(g) for g in groups[:50] if isinstance(g, dict)],
            "大小": size, "修改时间": mtime, "提交IP": str(self.client_ip()),
            "提交时间": datetime.datetime.now().isoformat(timespec="seconds"),
            "id": self.manifest.sign(rel),
        }

    def group_entry(self, g):
        signed = str(g.get("已校验", ""))
        given = re.fullmatch(r"[0-9a-f]{32}", signed)  # 只在服务器上的组：网页没有完整编号，直接给了校验值
        boxes = g.get("集装箱号") if isinstance(g.get("集装箱号"), list) else []
        return {
            "名称": str(g.get("名称", ""))[:40],
            "校验": signed if given else self.manifest.sign(str(g.get("校验", ""))),
            "海关编号": "" if given else re.sub(r"[^0-9A-Z]", "", str(g.get("校验", "")).upper())[:40],
            "提运单号": re.sub(r"[^0-9A-Z]", "", str(g.get("提运单号", "")).upper())[:40],
            "集装箱号": [str(b)[:20] for b in boxes[:50]],
        }

    def dir_of(self, url):
        """?dir= 指的工具目录（存放目录下的第一级）"""
        d = urllib.parse.parse_qs(url.query).get("dir", [""])[0]
        return self.target(d) if d and "/" not in d else None

    def read_json(self, size, kind):
        try:
            v = json.loads(self.rfile.read(size))
            return v if isinstance(v, kind) else None
        except ValueError:
            return None

    def post_exists(self, url, size):
        d, body = self.dir_of(url), self.read_json(size, dict)
        if not d or body is None:
            return self.reply(400, {"error": "格式不对"})
        entries, idx = self.manifest.entries(d), self.manifest.index(d)
        strs = lambda k: [s for s in (body.get(k) if isinstance(body.get(k), list) else [])[:10000] if isinstance(s, str)]
        ok = {n: {"大小": e["大小"], "修改时间": e["修改时间"]} for n in strs("names") if (e := entries.get(self.manifest.sign(f"{d.name}/{n}")))}
        # 编号 → 清单里这份报关单已有的单据类型（不论文件名，如手动补传的）
        groups = idx["groups"]
        keys = {k: {"校验": s, "类型": sorted(groups[s]["已提交"])} for k in strs("keys") if (s := self.manifest.sign(k)) in groups}
        bills = self.match_bills(groups, body.get("bills", [])[:5000]) if isinstance(body.get("bills"), list) else []
        self.reply(200, {"exists": ok, "stamps": sorted(set(strs("stamps")) & idx["stamps"]), "keys": keys, "bills": bills})

    @staticmethod
    def match_bills(groups, bills):
        """本地提运单、数电发票 [{ 全文（数电发票为备注栏）, 集装箱号 }] → 各自属于哪几份已提交的报关单 [[报关单（Manifest.show）+ 提运单号?]]，
        供本地对不上报关单的提运单、发票归档。同网页 parser.js 的 mentions：全文中出现了海关编号或提运单号（8 位以上），没有再按集装箱号。
        提运单号出现在全文中的才回传号码（它本来就在这份单据里），供归档命名"""
        out = []
        for b in bills:
            b = b if isinstance(b, dict) else {}
            text, boxes = str(b.get("全文", "")), {str(x) for x in (b.get("集装箱号") or [])[:50]}
            billed = lambda g: len(g["提运单号"]) >= 8 and g["提运单号"] in text
            hit = [h for h, g in groups.items() if billed(g) or (g["海关编号"] and g["海关编号"] in text)]
            hit = hit or [h for h, g in groups.items() if g["集装箱号"] & boxes]
            out.append([{**Manifest.show(h, groups[h], False), **({"提运单号": groups[h]["提运单号"]} if billed(groups[h]) else {})} for h in hit])
        return out

    # ---------- 下载与删除 ----------

    def post_download(self, url, size):
        d, body = self.dir_of(url), self.read_json(size, dict) or {}
        if not self.can_query():
            return self.reply(403, {"error": "不在查询白名单内，不能下载"})
        if not self.password:
            return self.reply(403, {"error": "服务器没有设下载密码（config.ini 的 [下载]）"})
        # 猜密码限速：核对逐个进行（输错等 1 秒，并发去试也只能一秒一次）；不论哪个 IP，连续输错 5 次，所有人锁 3 分钟
        now = time.time()
        with self.password_lock:
            fails = Handler.password_fails
            if fails[0] >= 5 and now - fails[1] < 180:
                return self.reply(429, {"error": f"密码输错次数过多，请 {int(180 - (now - fails[1])) // 60 + 1} 分钟后再试"})
            if not hmac.compare_digest(str(body.get("password", "")).encode(), self.password.encode()):
                time.sleep(1)
                Handler.password_fails = (fails[0] + 1 if fails[0] < 5 else 1, time.time())  # 锁定期过后重新计数
                return self.reply(403, {"error": "密码不对"})
            Handler.password_fails = (0, 0)
        if not d:
            return self.reply(400, {"error": "目录不对"})
        files = [(p, (st := p.stat()).st_size, st.st_mtime_ns) for p in sorted(d.rglob("*.pdf")) if p.is_file()] if d.is_dir() else []
        token = secrets.token_urlsafe(24)
        with self.downloads_lock:
            now = time.time()
            for t in [t for t, v in self.downloads.items() if now - v["time"] > DOWNLOAD_TTL]:
                del self.downloads[t]
            self.downloads[token] = {"dir": d, "files": files, "ip": self.client_ip(), "time": now, "done": False, "failed": False}
        self.reply(200, {"token": token, "count": len(files), "bytes": sum(f[1] for f in files)})

    def download_of(self, token):
        with self.downloads_lock:
            dl = self.downloads.get(token)
        ok = dl and dl["ip"] == self.client_ip() and time.time() - dl["time"] <= DOWNLOAD_TTL
        return dl if ok else None

    def get_download(self, rest):
        token, _, status = rest.partition("/")
        dl = self.download_of(token)
        if not dl:
            return self.reply(404, {"error": "下载已失效，请重新下载"})
        if status == "status":
            return self.reply(200, {"done": dl["done"], "failed": dl["failed"]})
        # 不压缩（PDF 本身已压缩）、边打包边发送；长度事先不知道，发完即断开连接
        name = urllib.parse.quote(f"{dl['dir'].name}_{datetime.datetime.now():%Y%m%d-%H%M}.zip")
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{name}")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            with zipfile.ZipFile(self.wfile, "w", zipfile.ZIP_STORED) as zf:
                for p, _, _ in dl["files"]:
                    if p.is_file():
                        zf.write(p, p.relative_to(dl["dir"]).as_posix())
            dl["done"] = True
            self.record_download(dl)
        except OSError:
            dl["failed"] = True  # 对方取消下载等

    def record_download(self, dl):
        """发送完后，在清单里给这次下载的每个文件追加 下载：[{ IP, 时间 }]（下载几次记几次）"""
        d, entries = dl["dir"], self.manifest.entries(dl["dir"])
        rec = {"IP": str(self.client_ip()), "时间": datetime.datetime.now().isoformat(timespec="seconds")}
        keys = (self.manifest.sign(f"{d.name}/{p.relative_to(d).as_posix()}") for p, _, _ in dl["files"])
        self.manifest.add(d, *({**e, "下载": [*e.get("下载", []), rec]} for k in keys if (e := entries.get(k))))

    def post_purge(self, size):
        body = self.read_json(size, dict) or {}
        dl = self.download_of(str(body.get("token", "")))
        if not dl or not self.can_query():
            return self.reply(403, {"error": "下载已失效，请重新下载"})
        if not dl["done"]:
            return self.reply(409, {"error": "下载还没有完成"})
        deleted = kept = 0
        for p, size_, mtime in dl["files"]:
            try:
                st = p.stat()
            except OSError:
                continue
            if (st.st_size, st.st_mtime_ns) != (size_, mtime):
                kept += 1  # 下载之后又提交过（覆盖），不删
                continue
            p.unlink()
            deleted += 1
        # 删空了的文件夹（清单在工具目录下，不删）
        for sub in sorted((x for x in dl["dir"].rglob("*") if x.is_dir()), key=lambda x: len(x.parts), reverse=True):
            try:
                sub.rmdir()
            except OSError:
                pass
        with self.downloads_lock:
            self.downloads.pop(str(body.get("token")), None)
        print(f"{self.client_ip()} 删除归档 {deleted} 个（{dl['dir'].name}），保留下载后变动的 {kept} 个")
        self.reply(200, {"deleted": deleted, "kept": kept})

    def target(self, rel):
        """提交目录下的相对路径 → 绝对路径；含 ..、盘符、非法字符、以 . 开头（如密钥文件）等的返回 None"""
        parts = rel.split("/")
        if not rel or re.search(r'[\\:*?"<>|\x00-\x1f]', rel) or any(s in ("", ".", "..") or s != s.strip() or s.startswith(".") for s in parts):
            return None
        root = self.store.resolve()
        p = root.joinpath(*parts).resolve()
        return p if p.is_relative_to(root) and p != root else None

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        if self.listing:
            return super().list_directory(path)
        self.send_error(404)


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128  # 等待接受的连接数（默认 5，几个人同时用、请求一多，新连接要等对方重试，一次就是几秒）
    daemon_threads = True


def lan_ips():
    """本机各网卡的 IPv4 地址（去掉回环、未连通网卡的 169.254.x.x）；可能含 WSL、Docker、代理软件的虚拟网卡，无法自动分辨"""
    try:
        ips = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:  # 个别机器的主机名解析不了
        return []
    return [ip for ip in ips if not ip.startswith(("127.", "169.254."))]


def main():
    ap = argparse.ArgumentParser(description="单据整理本地服务")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--root", default=str(SITE), help="服务的目录，默认 site/（局域网共享时只能是 site/）")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--local", action="store_true", help="只供本机访问（调试用），可列目录、可指定其他目录")
    ap.add_argument("--store", default=str(STORE), help="提交的文件存放目录")
    args = ap.parse_args()
    lan = not args.local
    if lan and pathlib.Path(args.root).resolve() != SITE:
        ap.error("局域网共享只能服务 site/，避免把样本等其他文件暴露到局域网；调试其他目录请加 --local")
    cfg = read_config()
    ocr, allow = load_ocr(cfg.get("OCR", [])), load_allow(cfg.get("查询白名单", []))
    password = key_values(cfg.get("下载", [])).get("密码", "")
    archive = key_values(cfg.get("存档", [])).get("switch", "0") == "1"
    store = pathlib.Path(args.store)
    can_write = archive and writable(store)  # 存档关闭时不碰存放目录
    root = pathlib.Path(args.root).resolve()
    base = urllib.parse.quote("/" + SITE.relative_to(root).as_posix()) if SITE != root and SITE.is_relative_to(root) else ""
    attrs = {"listing": not lan, "store": store, "manifest": Manifest(store) if archive else None, "can_write": can_write, "ocr": ocr,
             "allow": allow, "whitelist": "\n".join(cfg.get("发票购买方白名单", [])), "password": password, "archive": archive, "base": base}
    handler = functools.partial(type("H", (Handler,), attrs), directory=args.root)
    with Server(("0.0.0.0" if lan else "127.0.0.1", args.port), handler) as server:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"服务目录 {args.root}\n配置 {CONFIG}{'' if CONFIG.exists() else '（不存在）'}")
        if archive:
            print(f"提交存放 {args.store}{'' if can_write else '（不能写入，不启用提交）'}")
            print(f"查询白名单 {len(allow)} 条；下载{'已设密码' if password else '未设密码，不能下载'}")
        else:
            print("存档已关闭：纯本地模式，不提交、不查询")
        print(f"OCR {'已启用：' + ocr[0]['provider'] if ocr else '未启用（[OCR] 节没有或有空值）'}")
        print(f"本机打开 {url}")
        if lan:
            print("局域网访问：")
            for ip in lan_ips():
                print(f"  http://{ip}:{args.port}/")
        print("Ctrl+C 停止")
        if not args.no_open and sys.stdin and sys.stdin.isatty():  # 作为后台服务（systemd 等）运行时没有终端，不打开浏览器
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
