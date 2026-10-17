// 真实浏览器访问层 — 独立抓取服务(:9999, 后端=Scrapling) 优先, Scrapling 侧车浏览器层直连降级
//
// 后端切换: 原 Playwright+stealth 直连已移除 (全部换 Scrapling).
//   1. 独立浏览器服务 (:9999): startBrowserService() 拉起的抓取服务 (scrapling → dom-sim → fetch 三层降级)
//   2. Scrapling 侧车浏览器层直连 (Camoufox, 仅桌面有 python3+scrapling 时可用) — 替代原 Playwright 直连
import { getSettings } from "./config.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 独立浏览器服务 (Scrapling 后端) — 搜索/扫榜首选
import { BROWSER_SVC_BASE } from "./browserService.js";
import { callScrapling } from "./scraplingClient.js";
const BROWSER_SVC = process.env.TIANYAN_BROWSER_SVC || BROWSER_SVC_BASE;
async function svcFetch(path: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
  const r = await fetch(BROWSER_SVC + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("browser-svc " + path + ": " + (j.error || r.status));
  return j;
}
async function svcAvailable(): Promise<boolean> {
  try {
    const r = await fetch(BROWSER_SVC + "/health", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// Scrapling 侧车浏览器层直连 (替代原 Playwright 直连; 无 python3/scrapling 时自动跳)
function scraplingBrowserAvailable(): boolean {
  return process.env.TIANYAN_DISABLE_BROWSER !== "1";
}
async function scraplingBrowserFetch(
  url: string,
  maxChars: number,
  waitMs: number,
): Promise<{ finalUrl: string; title: string; content: string; links: Array<{ text: string; href: string }> } | null> {
  if (!scraplingBrowserAvailable()) return null;
  const r = await callScrapling("browser", { url, maxChars, waitMs, scrollRounds: 2 }, 90_000).catch(() => null);
  if (!r?.ok || r.source === "unavailable") return null;
  const d = r.data as any;
  if (d && typeof d.content === "string" && d.content.length > 0) {
    return { finalUrl: d.finalUrl || url, title: d.title || "", content: d.content, links: d.links || [] };
  }
  return null;
}

/* ===== 串行队列 (浏览器层直连用; 服务层自带串行) ===== */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(fn, fn);
  queue = task.then(() => {}, () => {});
  return task;
}

/* ===== 对外 API ===== */

/** Bing 搜索 — 独立服务(Scrapling) 优先, 无服务时纯 fetch */
export async function browserSearch(
  query: string,
  maxResults = 10,
): Promise<{
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  count: number;
  engine: string;
}> {
  // 独立浏览器服务优先 (Scrapling 后端: 搜索/扫榜首选)
  if (await svcAvailable()) {
    try {
      const r = await svcFetch("/search", { query, maxResults, waitMs: 4000 });
      if (r.results?.length) return { query, results: r.results, count: r.results.length, engine: "scrapling-svc" };
      if (r.source) return { query, results: r.results || [], count: r.count || 0, engine: r.source };
    } catch {}
  }
  // 服务不可用 → Scrapling 侧车搜索直连 (python 有则更稳)
  const sc = await callScrapling("search", { query, engine: "bing", maxResults }, 45000).catch(() => null);
  if (sc?.ok && sc.source === "scrapling") {
    const d = sc.data as any;
    return { query, results: d.results || [], count: d.results?.length || 0, engine: "scrapling-direct" };
  }
  // 纯 fetch 兜底
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-Hans`;
  const text = await fetch(searchUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.text()).catch(() => "");
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const m of text.matchAll(/<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi)) {
    const block = m[0];
    const hm = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (hm) {
      const title = (hm[2] || "").replace(/<[^>]+>/g, "").trim().slice(0, 200);
      results.push({ title, url: hm[1], snippet: pm ? (pm[1] || "").replace(/<[^>]+>/g, "").trim().slice(0, 300) : "" });
    }
    if (results.length >= maxResults) break;
  }
  return { query, results, count: results.length, engine: "bing-fetch" };
}

/** 打开 URL，提取渲染后正文 + 链接列表 */
export async function browserFetch(
  url: string,
  maxChars = 12000,
  waitMs = 4000,
): Promise<{
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  chars: number;
  links: Array<{ text: string; href: string }>;
}> {
  // 独立浏览器服务优先 (Scrapling 后端)
  if (await svcAvailable()) {
    try {
      const r = await svcFetch("/fetch", { url, maxChars, waitMs });
      if (r.content) return { url, finalUrl: r.finalUrl || url, title: r.title || "", content: r.content, chars: r.content.length, links: r.links || [] };
    } catch {}
  }
  // 服务不可用 → Scrapling 侧车浏览器层直连
  const direct = await serial(() => scraplingBrowserFetch(url, maxChars, waitMs));
  if (direct) {
    return { url, finalUrl: direct.finalUrl, title: direct.title, content: direct.content, chars: direct.content.length, links: direct.links };
  }
  // 纯 fetch 兜底
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  const html = r ? await r.text().catch(() => "") : "";
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const content = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
  return { url, finalUrl: url, title: titleM ? titleM[1].trim() : "", content, chars: content.length, links: [] };
}

/** 截图 — 独立服务(Scrapling 浏览器层) 优先, 无服务时 Scrapling 直连, 再不行返回降级说明 */
export async function browserScreenshot(
  url: string,
  name = "screenshot",
  width = 1280,
  height = 800,
): Promise<{
  url: string;
  finalUrl: string;
  title: string;
  path: string;
  width: number;
  height: number;
}> {
  // 独立浏览器服务优先 (Scrapling 后端, 含浏览器层截图)
  if (await svcAvailable()) {
    try {
      const r = await svcFetch("/screenshot", { url, width, height });
      if (r?.screenshotB64) {
        const dir = join(getSettings().dataDir, "screenshots");
        mkdirSync(dir, { recursive: true });
        const filename = `${name}-${Date.now()}.png`;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(dir, filename), Buffer.from(r.screenshotB64, "base64"));
        return { url, finalUrl: url, title: r.title || "", path: `/screenshots/${filename}`, width, height };
      }
      if (r?.note) throw new Error(r.note);
    } catch (e) { /* 降级 Scrapling 直连 */ }
  }
  // Scrapling 侧车浏览器层直连 (桌面有 python+scrapling 时)
  const direct = await serial(() =>
    callScrapling("browser", { url, screenshot: true, waitMs: 3000, scrollRounds: 0, width, height }, 90_000).catch(() => null),
  );
  if (direct?.ok && direct.data && (direct.data as any).screenshotB64) {
    const d = direct.data as any;
    const dir = join(getSettings().dataDir, "screenshots");
    mkdirSync(dir, { recursive: true });
    const filename = `${name}-${Date.now()}.png`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, filename), Buffer.from(d.screenshotB64, "base64"));
    return { url, finalUrl: d.finalUrl || url, title: d.title || "", path: `/screenshots/${filename}`, width, height };
  }
  // 无浏览器层可用 → 降级说明 (原 Playwright 直连已移除)
  return {
    url,
    finalUrl: url,
    title: "",
    path: "",
    width,
    height,
  } as { url: string; finalUrl: string; title: string; path: string; width: number; height: number };
}
