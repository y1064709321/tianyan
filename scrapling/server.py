#!/usr/bin/env python3
"""天衍抓取侧车 (scrapling) — 由 Node 侧 spawn/调用.

协议:
  模式A (推荐, 零守护进程):  stdin 收 JSON {action, ...}, stdout 出 JSON 结果
     node:  spawn("python3", [server.py, "--once"]) + stdin.write(JSON.stringify(body))
  模式B: 长驻 HTTP, 与 browserService.ts 的端点结构对齐
     python3 server.py --port 9998

后端: Scrapling (BSD-3-Clause, Copyright 2024 Karim shoair)
  fetch/search/ranking: 纯 HTTP + curl_cffi 指纹模拟 (零浏览器, 任何平台可跑)
  browser: Camoufox 真人模拟层 (仅桌面有浏览器时可用, 自动降级)
  无 scrapling 时自动回退 urllib, 不崩.

actions: search | fetch | ranking | browser

【抓取合规边界】本侧车只抓取榜单页/搜索结果页等公开免费信息,
仅用于创作对标调研。不抓取、不存储、不处理任何付费内容:
- 不下载付费章节正文 (起点 VIP / 番茄付费 / 晋江 VIP 等)
- 不绕过付费墙 (VIP 验证 / 会员解锁)
- 不抓取需登录的内容
榜单条目只取书名/作者/简介等公开元数据。详见 README.md 「抓取合规边界」章节.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import sys
import time
import urllib.request
from typing import Any

try:
    from scrapling import Fetcher  # type: ignore
    HAS_SCRAPLING = True
except Exception:
    try:
        from scrapling.fetchers import Fetcher  # type: ignore
        HAS_SCRAPLING = True
    except Exception:
        HAS_SCRAPLING = False

UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
]
SEARCH_URLS = {
    "bing": "https://cn.bing.com/search?q={q}&mkt=zh-CN&setlang=zh-Hans",
    "google": "https://www.google.com/search?q={q}",
}
RANKING_URLS = {
    "番茄小说": "https://fanqienovel.com/rank",
    "晋江文学城": "https://www.jjwxc.net/topten.php?toptype=1&isfirst=false",
    "起点中文网": "https://www.qidian.com/rank/hotsales/",
}


def _ua() -> str:
    return random.choice(UAS)


def _fetch_html(url: str, timeout: int = 30) -> str:
    """优先 Scrapling Fetcher (curl_cffi TLS 指纹模拟), 回退 urllib."""
    if HAS_SCRAPLING:
        try:
            page = Fetcher().get(url, user_agent=_ua(), timeout=timeout, hidden=True)
            if page is not None:
                body = getattr(page, "body", None) or getattr(page, "text", None)
                if body:
                    return body
        except Exception:
            pass
    req = urllib.request.Request(url, headers={"User-Agent": _ua(), "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _links(html: str, limit: int = 25) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for m in re.finditer(r'<a\s[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I | re.S):
        href, inner = m.group(1).strip(), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if not href.startswith("http") or len(href) < 8:
            continue
        if not (2 <= len(inner) <= 200):
            continue
        out.append({"text": inner[:100], "href": href})
        if len(out) >= limit:
            break
    return out


def _strip_html(html: str, max_chars: int = 12000) -> str:
    t = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>|<noscript[\s\S]*?</noscript>", "", html, flags=re.I)
    t = re.sub(r"<!--[\s\S]*?-->", "", t)
    t = re.sub(r"<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article)>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()[:max_chars]


def do_search(body: dict[str, Any]) -> dict[str, Any]:
    query = str(body.get("query", ""))
    engine = str(body.get("engine", "bing"))
    url = SEARCH_URLS.get(engine, SEARCH_URLS["bing"]).format(q=query)
    html = _fetch_html(url)
    results: list[dict[str, str]] = []
    for m in re.finditer(r'<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?</li>', html, re.I):
        block = m.group(0)
        hm = re.search(r'<h2[^>]*>\s*<a[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', block, re.S | re.I)
        pm = re.search(r'<p[^>]*>(.*?)</p>', block, re.S | re.I)
        if hm:
            snippet = re.sub(r"<[^>]+>", "", pm.group(1)).strip()[:300] if pm else ""
            results.append({"title": re.sub(r"<[^>]+>", "", hm.group(2)).strip()[:200], "url": hm.group(1), "snippet": snippet})
        if len(results) >= int(body.get("maxResults", 10)):
            break
    return {"query": query, "engine": engine, "results": results, "count": len(results), "source": "scrapling"}


def do_fetch(body: dict[str, Any]) -> dict[str, Any]:
    url = str(body.get("url", ""))
    max_chars = int(body.get("maxChars", 12000))
    html = _fetch_html(url)
    tm = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I)
    content = _strip_html(html, max_chars)
    return {
        "url": url, "finalUrl": url,
        "title": (tm.group(1).strip() if tm else ""),
        "content": content, "chars": len(content),
        "links": _links(html), "source": "scrapling",
    }


def do_ranking(body: dict[str, Any]) -> dict[str, Any]:
    platform = str(body.get("platform", "番茄小说"))
    url = RANKING_URLS.get(platform, RANKING_URLS["番茄小说"])
    html = _fetch_html(url)
    items: list[dict[str, str]] = []
    text_head = _strip_html(html, 3000)
    for line in text_head.split("\n"):
        line = line.strip()
        m = re.match(r"^(\d{1,2})[.、\s]+(.{2,40})", line)
        if m:
            items.append({"rank": m.group(1), "title": m.group(2), "author": "", "blurb": ""})
        if len(items) >= 30:
            break
    return {"platform": platform, "url": url, "items": items, "textHead": text_head, "source": "scrapling"}


def _has_browser() -> bool:
    """Camoufox/Playwright 浏览器层可用性: 需 Python 浏览器依赖 + 平台图形栈."""
    if os.getenv("TIANYAN_DISABLE_BROWSER", "") == "1":
        return False
    try:
        from scrapling import Dynamic  # noqa: F401
        return True
    except Exception:
        return False


def do_browser(body: dict[str, Any]) -> dict[str, Any]:
    """真人模拟层: Scrapling Dynamic 打开页面, 随机停留/滚动, 抽取正文/链接/截图.

    body: {url, waitMs, scrollRounds, maxChars, screenshot?}
    返回字段与 browserService.ts handleFetch/handleScreenshot 对齐.
    """
    url = str(body.get("url", ""))
    max_chars = int(body.get("maxChars", 12000))
    wait_ms = int(body.get("waitMs", 4000))
    scroll_rounds = int(body.get("scrollRounds", 2))
    if not _has_browser():
        raise RuntimeError("Camoufox 浏览器层不可用 (缺 Python 浏览器依赖或平台无图形栈), 请走 fetch 层")
    from scrapling import Dynamic  # type: ignore

    with Dynamic(url, user_agent=_ua(), headless=True) as session:
        page = session.page
        if wait_ms:
            time.sleep(wait_ms / 1000.0)
        for _ in range(scroll_rounds):
            try:
                page.mouse.wheel(0, random.randint(300, 800))
                time.sleep(random.uniform(2.0, 5.0))
            except Exception:
                break
        title = (page.title() or "")[:300]
        text = (getattr(page, "text_content", None) or getattr(page, "content", "") or "")[:max_chars]
        links: list[dict[str, str]] = []
        try:
            for a in page.query_selector_all("a[href]")[:60]:
                href = a.get_attribute("href") or ""
                if not href.startswith("http"):
                    continue
                inner = (a.text_content() or "").strip()
                if 2 <= len(inner) <= 200:
                    links.append({"text": inner[:100], "href": href})
                if len(links) >= 25:
                    break
        except Exception:
            pass
        out: dict[str, Any] = {
            "url": url, "finalUrl": page.url, "title": title,
            "content": text, "chars": len(text), "links": links, "source": "scrapling-browser",
        }
        if body.get("screenshot"):
            try:
                png = page.screenshot(type="png")
                out["screenshotB64"] = base64.b64encode(png).decode("ascii")
            except Exception as e:
                out["screenshotNote"] = f"screenshot 不可用: {e}"
        return out


HANDLERS: dict[str, Any] = {
    "search": do_search,
    "fetch": do_fetch,
    "ranking": do_ranking,
    "browser": do_browser,
}


def run_once(body: dict[str, Any]) -> int:
    handler = HANDLERS.get(str(body.get("action", "fetch")), do_fetch)
    try:
        print(json.dumps(handler(body), ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e), "backend": "scrapling"}, ensure_ascii=False))
        return 1


def serve_http(port: int) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def _json(self, code: int, obj: Any) -> None:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:
            if self.path.split("?")[0] == "/health":
                self._json(200, {"ok": True, "backend": "scrapling", "scrapling": HAS_SCRAPLING, "browser": _has_browser()})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") or "{}"
            body = json.loads(raw)
            action = self.path.split("?")[0].lstrip("/")
            handler = HANDLERS.get(action)
            if not handler:
                self._json(404, {"error": f"unknown endpoint {action}"})
                return
            try:
                self._json(200, handler(body))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": str(e), "backend": "scrapling"})

        def log_message(self, *a: Any) -> None:
            pass

    HTTPServer(("127.0.0.1", port), H).serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9998)
    ap.add_argument("--once", action="store_true", help="stdin JSON → stdout JSON, 单次执行")
    args = ap.parse_args()
    if args.once:
        sys.exit(run_once(json.load(sys.stdin)))
    serve_http(args.port)


if __name__ == "__main__":
    main()
