// browserService.ts — 抓取/搜索 HTTP 微服务 (端口 9999), 由 8090 主进程自动拉起.
//
// 后端已切换为 Scrapling (BSD-3-Clause, Copyright 2024 Karim shoair):
//   抓取/搜索/扫榜: 走 scrapling Python 侧车 (curl_cffi 指纹, 零浏览器, 任何平台可跑)
//   真人模拟层:     Scrapling Camoufox (仅桌面可用, 自动降级)
// 三层降级 (scrapling → dom-sim → 纯 fetch):
//   1. scrapling 侧车: 优先 (有 python3 + scrapling 时)
//   2. 零依赖 DOM 模拟 (browserAdapter.ts): 抓 HTML 提正文/链接/条目, 不需要浏览器
//   3. 纯 fetch: 兜底
//
// 8090 启动时: import { startBrowserService } from "./browserService.js"; await startBrowserService();
// 9999 端口被外部已跑的服务占着 → 自动复用不报错 (手机/电脑分开部署也兼容)。

import * as http from "node:http";
// 三层: Scrapling 侧车 → DOM 模拟 (零依赖) → 纯 fetch
import { createBrowserAdapter, BrowserAdapter } from "./browserAdapter.js";
import { callScrapling } from "./scraplingClient.js";
let domSim: BrowserAdapter | null = null;
async function getDomSim(): Promise<BrowserAdapter> {
  if (!domSim) {
    domSim = await createBrowserAdapter({ cdpEndpoint: process.env.TIANYAN_CDP_ENDPOINT || undefined });
    console.log("[browser-service] dom-sim 适配器已初始化 (backend=" + (await domSim.backend()) + ")");
  }
  return domSim;
}

export const BROWSER_SVC_PORT = Number(process.env.TIANYAN_BROWSER_PORT || 9999);
export const BROWSER_SVC_BASE = "http://127.0.0.1:" + BROWSER_SVC_PORT;

export type BrowserBackend = "scrapling" | "scrapling-browser" | "dom-sim" | "fetch-only";
let backend: BrowserBackend = "fetch-only";
let server: http.Server | null = null;
let alreadyStarted = false;
let scraplingOk: boolean | undefined;
// 侧车实际来源 (决定对外报告的 backend): scrapling=curl_cffi 已装 / fetch-fallback=只有 python, 包没装
let scraplingSource: "scrapling" | "fetch-fallback" | "none" = "none";

/** 探测 Scrapling 侧车是否可用 (python3 + scrapling 包). */
async function probeScrapling(): Promise<boolean> {
  if (scraplingOk !== undefined) return scraplingOk;
  const r = await callScrapling("fetch", { url: "https://example.com", maxChars: 200 }, 20000).catch(() => null);
  scraplingOk = !!(r && r.ok && (r.source === "scrapling" || r.source === "fetch-fallback"));
  scraplingSource = scraplingOk ? (r!.source as "scrapling" | "fetch-fallback") : "none";
  if (scraplingOk && scraplingSource === "scrapling") {
    backend = "scrapling";
    console.log("[browser-service] Scrapling 侧车可用 (curl_cffi 指纹抓取)");
  } else if (scraplingOk) {
    console.log("[browser-service] Python 可用但 scrapling 包未装 (fetch 层兜底, 建议: pip install -r scrapling/requirements.txt)");
  } else {
    console.log("[browser-service] Scrapling 侧车不可用 (无 python3), backend=dom-sim/fetch-only");
  }
  return scraplingOk;
}

async function tryScrapling(action: "search" | "fetch" | "ranking", body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!(await probeScrapling())) return null;
  const r = await callScrapling(action, body, 45000).catch(() => null);
  if (!r || !r.ok || r.source === "unavailable") return null;
  const data = (r.data ?? {}) as Record<string, unknown>;
  if (data && Object.keys(data).length > 0 && !("error" in data)) return data;
  return null;
}

function randInt(a: number, b: number) { return Math.floor(a + Math.random() * (b - a + 1)); }
function pickUserAgent() {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ];
  return uas[randInt(0, uas.length - 1)];
}

async function systemBrowserFallback(url: string): Promise<any> {
  // Android (Termux 等): 用 am 调起系统默认浏览器 (模拟真人点击), 不能用 sh 命令
  if (process.platform === "android" || process.env.TERMUX_VERSION || process.env.PREFIX?.includes("termux")) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`am start -a android.intent.action.VIEW -d "${encodeURIComponent(url)}"`, { timeout: 5000 });
      return { url, source: "android-default-browser", note: "已用 am 调起 Android 系统默认浏览器 (模拟真人点击), 请在浏览器查看 " + url };
    } catch {
      throw new Error("Android 默认浏览器不可用: 请走 fetch 降级");
    }
  }
  const cmds = [
    { cmd: "xdg-open", label: "Linux 默认浏览器" },
    { cmd: "open", label: "macOS 默认浏览器" },
  ];
  for (const { cmd, label } of cmds) {
    try {
      const { spawn } = await import("node:child_process");
      const { execSync } = await import("node:child_process");
      try { execSync(`command -v ${cmd} || exit 1`, { timeout: 2000 }); } catch { continue; }
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
      child.on("error", () => { /* fallthrough */ });
      child.unref();
      return { url, source: "system-default-browser", note: `已调起${label} (模拟真人点击), 请在浏览器查看 ` + url };
    } catch { /* next */ }
  }
  throw new Error("无可用系统浏览器后端, 请走 fetch 降级");
}

async function handleSearch(body: any) {
  const query = String(body.query || "");
  const maxResults = Number(body.maxResults) || 10;
  const engine = String(body.engine || "bing");
  const searchUrl = engine === "google"
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
    : `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-Hans`;

  // 第一层: Scrapling 侧车 (curl_cffi 指纹, 静态搜索结果页通常够)
  const sc = await tryScrapling("search", { query, engine, maxResults });
  if (sc && Array.isArray(sc.results) && (sc as any).results.length > 0) {
    backend = "scrapling";
    return { query, engine, results: sc.results, count: (sc as any).results.length, source: "scrapling" };
  }
  // 第二层: DOM 模拟 (零依赖, Android 上能真跑)
  try {
    const sim = await getDomSim();
    const r = await sim.search(query, maxResults, engine);
    if (r.results.length > 0) return { ...r, engine, source: "dom-sim" };
  } catch { /* 再降级系统浏览器 */ }
  try {
    const fb = await systemBrowserFallback(searchUrl);
    return { query, engine, results: [], count: 0, source: fb.source, note: fb.note };
  } catch { /* 再降级 fetch */ }
  const r = await fetch(searchUrl, { headers: { "User-Agent": pickUserAgent() }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  const text = r ? await r.text().catch(() => "") : "";
  return { query, engine, results: [], count: 0, source: "fetch-only", raw: text.slice(0, 5000) };
}

async function handleFetch(body: any) {
  const url = String(body.url || "");
  const maxChars = Number(body.maxChars) || 12000;
  // 第一层: Scrapling 侧车
  const sc = await tryScrapling("fetch", { url, maxChars });
  if (sc && typeof sc.content === "string" && sc.content.length > 0) {
    backend = "scrapling";
    return { url, finalUrl: url, title: sc.title ?? "", content: sc.content, chars: (sc.content as string).length, links: sc.links ?? [], source: "scrapling" };
  }
  // 第二层: DOM 模拟
  try {
    const sim = await getDomSim();
    const r = await sim.fetchPage(url, maxChars);
    if (r.content.length > 0) return { ...r, source: "dom-sim" };
  } catch { /* 再降级系统浏览器 */ }
  try {
    const fb = await systemBrowserFallback(url);
    return { url, source: fb.source, note: fb.note, content: "", chars: 0, links: [] };
  } catch { /* 再降级 fetch */ }
  const r = await fetch(url, { headers: { "User-Agent": pickUserAgent() }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  const text = r ? await r.text().catch(() => "") : "";
  const content = text.slice(0, maxChars);
  return { url, finalUrl: url, title: "", content, chars: content.length, links: [], source: "fetch-only" };
}

async function handleRanking(body: any) {
  const platform = String(body.platform || "番茄小说");
  const urlMap: Record<string, string> = {
    "番茄小说": "https://fanqienovel.com/rank",
    "晋江文学城": "https://www.jjwxc.net/topten.php?toptype=1&isfirst=false",
    "起点中文网": "https://www.qidian.com/rank/hotsales/",
  };
  const url = urlMap[platform] || urlMap["番茄小说"];

  // 第一层: Scrapling 侧车 (浏览器级, 能渲染 JS 排行页)
  const sc = await tryScrapling("ranking", { platform, url });
  if (sc && Array.isArray(sc.items) && (sc as any).items.length > 0) {
    backend = "scrapling";
    return { platform, url, items: sc.items, textHead: (sc as any).textHead ?? "", source: "scrapling" };
  }
  // 第二层: DOM 模拟 (拿不到结构化条目时返回正文头部, agent 自行判断)
  try {
    const sim = await getDomSim();
    const r = await sim.ranking(platform, url);
    if (r.items.length > 0) return { ...r, platform, url, source: "dom-sim" };
    if (r.textHead && r.textHead.length > 20) {
      return { ...r, platform, url, source: "dom-sim (正文已获取, JS 渲染条目需浏览器层才完整)" };
    }
  } catch { /* 再降级 fetch */ }
  const r = await fetch(url, { headers: { "User-Agent": pickUserAgent() }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  const text = r ? await r.text().catch(() => "") : "";
  const lines = text.split("\n").map((l: string) => l.replace(/<[^>]+>/g, "").trim()).filter((l: string) => l.length > 4).slice(0, 50);
  const items = lines.map((l: string, i: number) => ({ rank: String(i + 1), title: l.slice(0, 60), author: "", blurb: "" }));
  return { platform, url, items, source: "fetch-only (JS 渲染页可能拿不到条目)" };
}

async function handleScreenshot(body: any) {
  const url = String(body.url || "");
  // Scrapling Camoufox 浏览器层 (仅桌面可用; 无浏览器时侧车返回 error, 自动降级)
  const r = await callScrapling("browser", { url, screenshot: true, waitMs: 3000, scrollRounds: 0 }, 60000).catch(() => null);
  if (r?.ok && r.data && (r.data as any).screenshotB64) {
    backend = "scrapling-browser";
    const b64 = (r.data as any).screenshotB64 as string;
    return { url, note: "screenshot base64 len=" + b64.length, screenshotB64: b64, source: "scrapling-browser" };
  }
  // 降级: DOM 模拟 (不支持截图) 或 纯 fetch
  try {
    const sim = await getDomSim();
    return await sim.screenshot(url);
  } catch { /* fall to 第三层 */ }
  return { url, note: "screenshot 需浏览器层 (Camoufox/CDP), 当前无可用", source: "fetch-only" };
}

export async function startBrowserService(): Promise<{ port: number; backend: BrowserBackend; reused: boolean }> {
  if (alreadyStarted) return { port: BROWSER_SVC_PORT, backend, reused: true };
  alreadyStarted = true;

  const probe = await fetch(BROWSER_SVC_BASE + "/health", { signal: AbortSignal.timeout(1500) }).catch(() => null as Response | null);
  if (probe?.ok) {
    const j: any = await probe.json().catch(() => ({}));
    if (j?.ok) {
      console.log(`[browser-service] 端口 ${BROWSER_SVC_PORT} 已有抓取服务在跑 (backend=${j.backend}), 复用之`);
      return { port: BROWSER_SVC_PORT, backend: (j.backend as BrowserBackend) || backend, reused: true };
    }
  }

  // 预热 Scrapling 探测: 等一小会儿 (上限 12s) 拿到真实 backend 再返回,
  // 避免启动日志/health 接口恒显示 fetch-only —— 用户会误以为"爬虫压根没启用"。
  // 超时不阻塞服务启动: probeScrapling 结果已缓存, 后续请求会再次触发并更正 backend。
  await Promise.race([
    probeScrapling().catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 12_000)),
  ]);
  if (scraplingSource === "scrapling") backend = "scrapling";

  server = http.createServer(async (req, res) => {
    const p = req.url?.split("?")[0];
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise<Record<string, unknown>>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });

    try {
      if (req.method === "GET" && p === "/health") {
        return json(200, { ok: true, backend, port: BROWSER_SVC_PORT });
      }
      if (req.method === "POST") {
        const body = await readBody();
        if (p === "/search") return json(200, await handleSearch(body));
        if (p === "/fetch") return json(200, await handleFetch(body));
        if (p === "/ranking") return json(200, await handleRanking(body));
        if (p === "/screenshot") return json(200, await handleScreenshot(body));
        return json(404, { error: "unknown endpoint: " + p });
      }
      return json(405, { error: "method not allowed" });
    } catch (e) {
      json(500, { error: (e as Error).message, backend });
    }
  });

  await new Promise<void>((resolve) => {
    try {
      server!.listen(BROWSER_SVC_PORT, "0.0.0.0", () => {
        console.log(`[browser-service] 启动成功 http://0.0.0.0:${BROWSER_SVC_PORT} (scrapling→dom-sim→fetch 三层降级, 搜索agent可调用)`);
        resolve();
      });
    } catch (e) {
      console.log(`[browser-service] 端口 ${BROWSER_SVC_PORT} 启动失败: ${(e as Error).message} → 继续降级`);
      resolve();
    }
  });
  return { port: BROWSER_SVC_PORT, backend, reused: false };
}

export function browserServiceBackend(): BrowserBackend { return backend; }
export function stopBrowserService() {
  try { server?.close(); } catch {}
  server = null;
}
