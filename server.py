# -*- coding: utf-8 -*-
"""
AI 生图小工具 · 一体化本地服务器
====================================
- 在 http://localhost:8000 提供 image-view.html
- 转发规则（解决浏览器 CORS）：
    /v1/*       -> https://token.sensenova.cn/v1/*      （商汤）
    /agnes/v1/* -> https://apihub.agnes-ai.com/v1/*     （Agnes）
    /cf/run/*   -> https://api.cloudflare.com/client/v4/accounts/<ID>/ai/run/*（Cloudflare）
    /ms/v1/*    -> https://api-inference.modelscope.cn/v1/*（魔搭）
- 智谱 open.bigmodel.cn 本身支持浏览器直连，不需要走这里

用法：
    直接双击 start.bat，或命令行运行：python server.py [端口]
    浏览器会自动打开页面；按 Ctrl+C 停止。
"""
import io
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(SCRIPT_DIR, "image-view.html")
UPSTREAM_SENSE = "https://token.sensenova.cn"
UPSTREAM_AGNES = "https://apihub.agnes-ai.com"
CF_ACCOUNT_ID = "af4d85429a77278c53432d60eeea800a"
UPSTREAM_CF = "https://api.cloudflare.com"
UPSTREAM_MS = "https://api-inference.modelscope.cn"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
DEFAULT_PORT = int(os.environ.get("PORT", "8000"))

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    from PIL import Image
    HAS_PIL = True
except Exception:
    HAS_PIL = False

THUMB_QUALITY = 82
THUMB_MAX_W = 4096
# 缩略图内存缓存 {(url, w): (bytes, ctype)}：只缓存缩略图（几十 KB 级）
IMG_CACHE = {}
IMG_CACHE_MAX = 300
IMG_CACHE_MAX_BYTES = 512 * 1024   # 单张超过这个体积不入缓存（兜住「没装 Pillow → 原图被当缩略图缓存」的情况）
# 原图内存缓存 {url: (bytes, ctype)}：网格请求缩略图时会顺手把原图存下来，
# 于是大图 / 下载 / 预取都直接吃缓存，不用再回源一次（上游只被拉一遍）
FULL_CACHE = {}
FULL_CACHE_MAX_BYTES = 192 * 1024 * 1024
FULL_CACHE_BYTES = 0
IMG_CACHE_LOCK = threading.Lock()   # 同时保护 IMG_CACHE 与 FULL_CACHE


def _full_cache_put(url, data, ctype):
    """原图入缓存（总字节上限，超了淘汰最早的）；单张就超预算则不缓存"""
    global FULL_CACHE_BYTES
    size = len(data)
    if size > FULL_CACHE_MAX_BYTES:
        return
    with IMG_CACHE_LOCK:
        old = FULL_CACHE.pop(url, None)
        if old is not None:
            FULL_CACHE_BYTES -= len(old[0])
        FULL_CACHE[url] = (data, ctype)
        FULL_CACHE_BYTES += size
        while FULL_CACHE_BYTES > FULL_CACHE_MAX_BYTES and FULL_CACHE:
            k = next(iter(FULL_CACHE))
            FULL_CACHE_BYTES -= len(FULL_CACHE.pop(k)[0])


def _hsize(n):
    """人类可读体积，用于日志"""
    if n >= 1024 * 1024:
        return "%.1fMB" % (n / 1024.0 / 1024.0)
    if n >= 1024:
        return "%.0fKB" % (n / 1024.0)
    return "%dB" % n


def _sniff_ctype(data, fallback=""):
    """按魔数判断图片类型；认不出来时退回上游 Content-Type（旧代码一律标成 image/png，WebP 会被贴错）"""
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"GIF8":
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:2] == b"BM":
        return "image/bmp"
    fb = (fallback or "").split(";")[0].strip().lower()
    return fb if fb.startswith("image/") else "application/octet-stream"


def _maybe_resize(data, ctype, w, url=""):
    """按 w 生成 JPEG 缩略图。源图更窄 / 未装 Pillow / 动图 / 解码失败 → 原样返回（绝不放大）"""
    if w <= 0 or not HAS_PIL or ctype == "image/gif":
        return data, ctype
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        if im.width <= w:
            return data, ctype          # 源图本来就窄：不放大
        h = max(1, round(im.height * w / float(im.width)))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))   # 透明底铺白，避免缩略图发黑
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        im = im.resize((w, h), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=THUMB_QUALITY, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception as e:
        print("[img resize SKIP] %s | %s" % (url[:120], e))
        return data, ctype


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---------- 基础响应 ----------
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # CORS 头：即使通过 file:// 打开并把代理填成本服务地址，也能工作
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Cache-Control")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    # 静态文件：只服务项目目录内的文件（lib/ 等），拦截路径穿越
    def _serve_static(self, full_path):
        full_path = os.path.normpath(full_path)
        root = os.path.normpath(SCRIPT_DIR)
        if not full_path.startswith(root + os.sep):
            self._json(403, {"error": "forbidden"})
            return
        try:
            with open(full_path, "rb") as f:
                data = f.read()
        except OSError:
            self._json(404, {"error": "not found"})
            return
        if full_path.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif full_path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full_path.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        elif full_path.endswith(".json"):
            ctype = "application/json; charset=utf-8"
        elif full_path.endswith(".png"):
            ctype = "image/png"
        elif full_path.endswith(".jpg") or full_path.endswith(".jpeg"):
            ctype = "image/jpeg"
        elif full_path.endswith(".svg"):
            ctype = "image/svg+xml"
        elif full_path.endswith(".webp"):
            ctype = "image/webp"
        else:
            ctype = "application/octet-stream"
        self._send(200, data, ctype)

    def log_message(self, fmt, *args):
        sys.stderr.write("[server] %s\n" % (fmt % args))

    # ---------- GET: 页面 ----------
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html", "/image-view.html"):
            try:
                with open(HTML_FILE, "r", encoding="utf-8") as f:
                    html = f.read()
                self._send(200, html, "text/html; charset=utf-8")
            except OSError as e:
                self._json(500, {"error": "无法读取 image-view.html: %s" % e})
            return
        if path == "/ping":
            self._json(200, {"ok": True})
            return
        if path == "/img":
            self._img_proxy()
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # 本地静态库：lib/*.js（Three.js / Vanta 等，离线可用）
        if path.startswith("/lib/"):
            self._serve_static(os.path.join(SCRIPT_DIR, "lib", path[len("/lib/"):]))
            return
        if path.startswith("/ms/v1/"):
            self._proxy("GET", UPSTREAM_MS, path[len("/ms"):])
            return
        if path.startswith("/agnes/v1/"):
            self._proxy("GET", UPSTREAM_AGNES, path[len("/agnes"):])
            return
        if path.startswith("/v1/"):
            self._proxy("GET", UPSTREAM_SENSE, path)
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/dl-zip":
            self._dl_zip()
            return
        if path.startswith("/agnes/v1/"):
            self._proxy("POST", UPSTREAM_AGNES, path[len("/agnes"):])
        elif path.startswith("/cf/run/"):
            # 账户 ID 优先取页面传入的 X-CF-Account-Id，空则回退到内置默认值
            aid = (self.headers.get("X-CF-Account-Id") or "").strip() or CF_ACCOUNT_ID
            self._proxy("POST", UPSTREAM_CF, "/client/v4/accounts/%s/ai/run/%s" % (aid, path[len("/cf/run/"):]))
        elif path.startswith("/ms/v1/"):
            self._proxy("POST", UPSTREAM_MS, path[len("/ms"):])
        elif path.startswith("/v1/"):
            self._proxy("POST", UPSTREAM_SENSE, path)
        else:
            self._json(404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Cache-Control")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 图片代理: /img?url=...&w=640 → 缩略图；不带 w → 原图（带浏览器 UA 绕防盗链） ----------
    def _img_proxy(self):
        q = urllib.parse.parse_qs(urlparse(self.path).query)
        url = (q.get("url") or [""])[0]
        if not url.startswith("http"):
            self._json(400, {"error": "bad url"})
            return
        try:
            w = int((q.get("w") or ["0"])[0] or 0)
        except ValueError:
            w = 0
        if w < 0 or w > THUMB_MAX_W:
            w = 0
        cache_hdr = {"Cache-Control": "public, max-age=86400"}
        t0 = time.time()
        if w > 0:
            with IMG_CACHE_LOCK:                      # ① 缩略图缓存
                hit = IMG_CACHE.get((url, w))
            if hit:
                print("[img] w=%d HIT  %s  %s" % (w, _hsize(len(hit[0])), url[:100]))
                self._send(200, hit[0], hit[1], cache_hdr)
                return
        else:
            with IMG_CACHE_LOCK:                      # ② 原图缓存（网格拉缩略图时已顺手存下）
                hit = FULL_CACHE.get(url)
            if hit:
                print("[img] full HIT  %s  %s" % (_hsize(len(hit[0])), url[:100]))
                self._send(200, hit[0], hit[1], cache_hdr)
                return
        try:
            resp = urlopen(Request(url, headers={"User-Agent": BROWSER_UA}), timeout=120)
            ttfb_ms = (time.time() - t0) * 1000              # 连接+首字节（含 DNS / TLS / 重定向）
            with resp:
                src_ct = resp.headers.get("Content-Type", "")
                data = resp.read()
            body_ms = (time.time() - t0) * 1000 - ttfb_ms    # 正文传输
            ctype = _sniff_ctype(data, src_ct)
            _full_cache_put(url, data, ctype)         # 原图先入缓存，供大图/下载复用
            raw_len = len(data)
            t1 = time.time()
            data, ctype = _maybe_resize(data, ctype, w, url)
            rz_ms = (time.time() - t1) * 1000
            # 计时日志：ttfb 大 = 上游慢在握手/排队；body 大 = 上游带宽小；两者都小才是本机的问题
            print("[img] w=%d MISS ttfb=%dms body=%dms resize=%dms %s -> %s  %s" % (
                w, round(ttfb_ms), round(body_ms), round(rz_ms), _hsize(raw_len), _hsize(len(data)), url[:100]))
            if w > 0 and len(data) <= IMG_CACHE_MAX_BYTES:
                with IMG_CACHE_LOCK:
                    if len(IMG_CACHE) >= IMG_CACHE_MAX:
                        IMG_CACHE.pop(next(iter(IMG_CACHE)))   # 先进先出淘汰
                    IMG_CACHE[(url, w)] = (data, ctype)
            self._send(200, data, ctype, cache_hdr)
        except Exception as e:
            short = url[:160]
            print("[img FAIL] %s | %s after %dms" % (short, e, round((time.time() - t0) * 1000)))
            self._json(502, {"error": "图片代理失败: %s（下载地址：%s）" % (e, short)})


    # ---------- 批量下载: /dl-zip {urls:[...]} -> zip ----------
    def _dl_zip(self):
        import json as _json
        import io as _io
        import zipfile
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        try:
            data = _json.loads(body.decode("utf-8", "replace"))
            urls = data.get("urls") or []
        except Exception:
            self._json(400, {"error": "bad request"})
            return
        buf = _io.BytesIO()
        wrote = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for i, u in enumerate(urls[:200]):
                try:
                    with IMG_CACHE_LOCK:                 # 先吃原图缓存，避免打包时把几百 MB 再下一遍
                        hit = FULL_CACHE.get(u)
                    if hit:
                        d = hit[0]
                    else:
                        with urlopen(Request(u, headers={"User-Agent": BROWSER_UA}), timeout=60) as resp:
                            d = resp.read()
                    ext = "png"
                    if d[:2] == b"\xff\xd8":
                        ext = "jpg"
                    elif d[:4] == b"GIF8":
                        ext = "gif"
                    zf.writestr("image_%03d.%s" % (i + 1, ext), d)
                    wrote += 1
                except Exception:
                    continue
        if not wrote:
            self._json(502, {"error": "全部图片下载失败"})
            return
        self._send(200, buf.getvalue(), "application/zip")

    # ---------- 代理: /v1/* -> token.sensenova.cn；/agnes/v1/* -> apihub.agnes-ai.com ----------
    def _proxy(self, method, upstream, path):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        target = upstream + path
        headers = {"Content-Type": self.headers.get("Content-Type", "application/json")}
        auth = self.headers.get("Authorization")
        if auth:
            headers["Authorization"] = auth
        # 魔搭异步模式等自定义头透传（X-ModelScope-Async-Mode 等）
        for hk, hv in self.headers.items():
            if hk.lower().startswith("x-modelscope"):
                headers[hk] = hv
        req = Request(target, data=body, headers=headers, method=method)

        # 上游偶发 502/503/超时/连接错误时自动重试（生图请求为独立任务，可安全重试）
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            try:
                with urlopen(req, timeout=300) as resp:
                    data = resp.read()
                    ctype = resp.headers.get("Content-Type", "application/json; charset=utf-8")
                    self._send(resp.status, data, ctype)
                    return
            except HTTPError as e:
                data = e.read()
                ctype = e.headers.get("Content-Type", "application/json; charset=utf-8")
                if e.code >= 500 and attempt < max_attempts:
                    time.sleep(attempt * 0.8)  # 0.8s / 1.6s 退避后重试
                    continue
                self._send(e.code, data, ctype)
                return
            except URLError as e:
                if attempt < max_attempts:
                    time.sleep(attempt * 0.8)
                    continue
                self._json(502, {"error": "转发到上游失败(%s): %s" % (upstream, e.reason or e)})
                return
            except (TimeoutError, socket.timeout):
                if attempt < max_attempts:
                    time.sleep(attempt * 0.8)
                    continue
                self._json(504, {"error": "转发到上游超时(%s)" % upstream})
                return
            except Exception as e:
                self._json(500, {"error": "代理异常: %s" % e})
                return


def pick_port(start):
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise OSError("端口 %d-%d 都被占用" % (start, start + 20))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    try:
        port = pick_port(port)
    except OSError as e:
        print("[错误] %s，请指定其他端口：python server.py 9000" % e)
        input("按回车退出…")
        return
    url = "http://localhost:%d/" % port
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 52)
    print("  AI 生图小工具 · 本地服务已启动")
    print("  页面地址 : %s" % url)
    print("  商汤转发 : /v1/*        -> %s/v1/*" % UPSTREAM_SENSE)
    print("  Agnes转发 : /agnes/v1/*  -> %s/v1/*" % UPSTREAM_AGNES)
    print("  CF转发   : /cf/run/*     -> api.cloudflare.com .../ai/run/*")
    print("  魔搭转发 : /ms/v1/*      -> %s/v1/*" % UPSTREAM_MS)
    print("  缩略图   : %s" % ("已启用（/img?w=640 用 Pillow 缩放并缓存）" if HAS_PIL else "未启用（缺 Pillow：pip install Pillow，图片将按原图返回）"))
    print("  按 Ctrl+C 停止服务")
    print("=" * 52)
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.server_close()


if __name__ == "__main__":
    main()