"""
OCR 接口：腾讯云通用文字识别（高精度版，GeneralAccurateOCR）。由 serve.py 按 config.ini [OCR] 节的 provider 加载。
换接口时另写 ocr_<名称>.py，提供同样的 recognize，改 config.ini [OCR] 节的 provider 即可。

recognize(pdf, pages, cfg) -> str：PDF 内容、页数、config.ini [OCR] 节的配置 → 各页文字（一行一段，页间空一行）；出错抛 RuntimeError
本接口每次识别 PDF 的一页（Base64 不超过 10M），逐页调用。签名为腾讯云 API 3.0 的 TC3-HMAC-SHA256，只用标准库。
频率限制：接口文档写明默认 10 次/秒（[OCR] 节可加 qps = N 调整），serve.py 多线程处理请求，所有调用共用一个限速器，超出的排队。
  不重试：仍被拒时错误原样返回网页，由操作人再点一次。
"""
import base64
import collections
import datetime
import hashlib
import hmac
import json
import threading
import time
import urllib.request

HOST = "ocr.tencentcloudapi.com"
_lock = threading.Lock()
_recent = collections.deque()  # 最近 1 秒内各次调用的时间


def throttle(qps):
    """等到最近 1 秒内的调用少于 qps 次，再记下本次"""
    while True:
        with _lock:
            now = time.monotonic()
            while _recent and now - _recent[0] >= 1:
                _recent.popleft()
            if len(_recent) < qps:
                _recent.append(now)
                return
            wait = 1 - (now - _recent[0])
        time.sleep(wait)


def call(cfg, action, payload):
    throttle(int(cfg.get("qps") or 10))
    body = json.dumps(payload)
    ts = int(time.time())
    date = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
    sign = lambda key, msg: hmac.new(key, msg.encode(), hashlib.sha256).digest()
    ctype = "application/json; charset=utf-8"
    canonical = f"POST\n/\n\ncontent-type:{ctype}\nhost:{HOST}\nx-tc-action:{action.lower()}\n\ncontent-type;host;x-tc-action\n{sha(body)}"
    scope = f"{date}/ocr/tc3_request"
    key = sign(sign(sign(("TC3" + cfg["secret_key"]).encode(), date), "ocr"), "tc3_request")
    sig = hmac.new(key, f"TC3-HMAC-SHA256\n{ts}\n{scope}\n{sha(canonical)}".encode(), hashlib.sha256).hexdigest()
    headers = {
        "Authorization": f"TC3-HMAC-SHA256 Credential={cfg['secret_id']}/{scope}, SignedHeaders=content-type;host;x-tc-action, Signature={sig}",
        "Content-Type": ctype, "Host": HOST, "X-TC-Action": action, "X-TC-Timestamp": str(ts), "X-TC-Version": "2018-11-19",
        "X-TC-Region": cfg.get("region") or "ap-shanghai",
    }
    req = urllib.request.Request(f"https://{HOST}/", body.encode(), headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        r = json.load(res)["Response"]
    if "Error" in r:
        raise RuntimeError(f"{r['Error']['Code']}：{r['Error']['Message']}")
    return r


def recognize(pdf, pages, cfg):
    data = base64.b64encode(pdf).decode()
    out = []
    for p in range(1, pages + 1):
        r = call(cfg, "GeneralAccurateOCR", {"ImageBase64": data, "IsPdf": True, "PdfPageNumber": p})
        out.append("\n".join(t["DetectedText"] for t in r["TextDetections"]))
    return "\n\n".join(out)
