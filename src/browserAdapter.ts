// browserAdapter.ts — 三层自动降级浏览器适配器 (CDP → 零依赖 DOM 模拟 → 纯 fetch)
//
// 设计:
//   1. CDP 层: 系统/下载的 Chrome 可被 CDP 驱动 (桌面为主, Android 上无独立 Chrome 时跳过)
//   2. DOM 模拟层: 零依赖 (~250 行正则), 拉 HTML → 模拟点击导航 → 提取标题/链接/正文
//      Android 上能真跑, 替代 Playwright 的"真实浏览器"能力 (抓取+翻页+点击, 不截图)
//   3. 纯 fetch 层: 兜底, 拿原始 HTML 不做 DOM 解析
//
// 接口对齐 browserService.ts 的 /search /fetch /ranking /screenshot 端点返回结构

type Backend = "cdp" | "dom-sim" | "fetch-only" | "unavailable";

export interface BrowserAdapterConfig {
  /** CDP 端点 (如 http://127.0.0.1:9222), 有则走 CDP */
  cdpEndpoint?: string;
  /** 超时 (ms) */
  timeoutMs?: number;
  /** 随机 UA 池 (模拟真人) */
  userAgents?: string[];
}

const DEFAULT_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

function pickUA(uaList: string[] = DEFAULT_UAS): string {
  return uaList[Math.floor(Math.random() * uaList.length)];
}

/** 模拟人类等待 (随机 0.5~2s, 加速不阻塞) */
function humanWait(ms = 1000): Promise<void> {
  const t = Math.min(Math.max(Math.round(ms * 0.5), 500), 2000);
  return new Promise(r => setTimeout(r, t));
}

// ===== 零依赖 HTML 解析器 (正则提取, 不引入 parse5/jsdom) =====

interface ParsedDoc {
  title: string;
  links: Array<{ text: string; href: string }>;
  text: string;
  raw: string;
  lines: string[];
}

export function parseHtml(html: string): ParsedDoc {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").trim().replace(/\s+/g, " ");

  const links: Array<{ text: string; href: string }> = [];
  const linkRe = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(linkRe)) {
    const href = m[1].trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) continue;
    const text = (m[2] || "").replace(/<[^>]+>/g, "").trim();
    if (text.length >= 2 && text.length <= 200) links.push({ text: text.slice(0, 100), href });
    if (links.length >= 200) break;
  }

  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const text = cleanHtml
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 2);

  return { title, links, text, raw: html, lines };
}

function extractSearchResults(doc: ParsedDoc, maxResults = 10): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const algoRe = /<li\s+class="b_algo"[\s\S]*?<\/li>/gi;
  for (const m of doc.raw.matchAll(algoRe)) {
    if (results.length >= maxResults) break;
    const block = m[0];
    const h2aRe = /<h2[^>]*>\s*<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const h2m = h2aRe.exec(block);
    if (h2m) {
      const title = h2m[2].replace(/<[^>]+>/g, "").trim();
      const pRe = /<p[^>]*>([\s\S]*?)<\/p>/i;
      const pm = pRe.exec(block);
      const snippet = (pm?.[1] || "").replace(/<[^>]+>/g, "").trim().slice(0, 300);
      results.push({ title, url: h2m[1], snippet });
      continue;
    }
    const aRe = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const am = aRe.exec(block);
    if (am && am[1].startsWith("http")) {
      const title = am[2].replace(/<[^>]+>/g, "").trim().slice(0, 200);
      results.push({ title, url: am[1], snippet: "" });
    }
  }
  if (results.length === 0) {
    for (const link of doc.links) {
      if (results.length >= maxResults) break;
      if (/(bing\.com|google\.[a-z.]+|microsoft\.com|msn\.com|cn\.bing)/i.test(link.href)) continue;
      if (!link.href.startsWith("http")) continue;
      if (link.text.length < 6) continue;
      results.push({ title: link.text, url: link.href, snippet: "" });
    }
  }
  return results;
}

export function extractRankingItems(doc: ParsedDoc, platform: string = ""): Array<{ rank: string; title: string; author: string; blurb: string }> {
  const items: Array<{ rank: string; title: string; author: string; blurb: string }> = [];
  const isFanqie = /番茄|fanqie/i.test(platform + doc.raw);
  const isJjwxc = /晋江|jjwxc/i.test(platform + doc.raw);
  const isQidian = /起点|qidian/i.test(platform + doc.raw);

  for (const line of doc.lines) {
    if (items.length >= 30) break;
    if (isFanqie) {
      const m = line.match(/(\d{1,3})\s*[.、．]\s*([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,40})\s*([\u4e00-\u9fa5]{1,15})/);
      if (m) items.push({ rank: m[1], title: m[2].trim(), author: m[3] || "", blurb: "" });
    } else if (isJjwxc) {
      const m = line.match(/^(.{2,30})\s+([\u4e00-\u9fa5]{1,10})\s+(.{5,})$/);
      if (m) items.push({ rank: String(items.length + 1), title: m[1].trim(), author: m[2], blurb: m[3].slice(0, 80) });
    } else if (isQidian) {
      const m = line.match(/^(.{2,40})\s*([\d.]+\s*字|连载中|已完结)/);
      if (m) items.push({ rank: String(items.length + 1), title: m[1].trim(), author: "", blurb: m[2] });
    } else {
      const general = line.match(/^(\d{1,3})\s*[.、．]\s*(.+)$/);
      if (general) {
        const rest = general[2];
        const m2 = rest.match(/^([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,40})\s*([\u4e00-\u9fa5]{1,15})?/);
        if (m2) items.push({ rank: general[1], title: m2[1].trim(), author: m2[2] || "", blurb: rest.slice(m2[1].length + (m2[2]?.length || 0)).trim().slice(0, 80) });
      }
    }
  }
  return items;
}

export class BrowserAdapter {
  private cfg: BrowserAdapterConfig;
  private cdpWs: WebSocket | null = null;
  private cdpId = 0;
  private cdpPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private cdpOk = false;
  private timeoutMs: number;

  constructor(cfg: BrowserAdapterConfig = {}) {
    this.cfg = cfg;
    this.timeoutMs = cfg.timeoutMs ?? 30000;
  }

  async probeCdp(): Promise<boolean> {
    if (!this.cfg.cdpEndpoint) return false;
    try {
      const r = await fetch(this.cfg.cdpEndpoint + "/json/version", { signal: AbortSignal.timeout(3000) });
      this.cdpOk = r.ok;
      return this.cdpOk;
    } catch {
      this.cdpOk = false;
      return false;
    }
  }

  async backend(): Promise<Backend> {
    if (await this.probeCdp()) return "cdp";
    return "dom-sim";
  }

  async search(query: string, maxResults = 10, engine = "bing"): Promise<{
    query: string; results: Array<{ title: string; url: string; snippet: string }>; count: number; source: string;
  }> {
    const url = engine === "google"
      ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
      : `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-Hans`;

    if (this.cdpOk) {
      try { return await this.cdpSearch(query, maxResults, url); } catch { /* fall to dom-sim */ }
    }
    const html = await this.fetchHtml(url, 15000);
    if (!html) throw new Error("dom-sim: fetch 搜索页失败");
    await humanWait(800);
    const doc = parseHtml(html);
    const results = extractSearchResults(doc, maxResults);
    return { query, results, count: results.length, source: "dom-sim" };
  }

  async fetchPage(url: string, maxChars = 12000): Promise<{
    url: string; finalUrl: string; title: string; content: string; chars: number;
    links: Array<{ text: string; href: string }>; source: string;
  }> {
    if (this.cdpOk) {
      try { return await this.cdpFetch(url, maxChars); } catch { /* fall to dom-sim */ }
    }
    const html = await this.fetchHtml(url, this.timeoutMs);
    if (!html) throw new Error("dom-sim: fetch 页面失败");
    await humanWait(600);
    const doc = parseHtml(html);
    const content = doc.text.slice(0, maxChars);
    return { url, finalUrl: url, title: doc.title, content, chars: content.length, links: doc.links.slice(0, 25), source: "dom-sim" };
  }

  async ranking(platform: string, url: string): Promise<{
    platform: string; url: string; items: Array<{ rank: string; title: string; author: string; blurb: string }>;
    textHead: string; source: string;
  }> {
    if (this.cdpOk) {
      try {
        const r = await this.cdpFetch(url, 12000);
        const doc = parseHtml(r.content);
        const items = extractRankingItems(doc, platform);
        return { platform, url, items, textHead: doc.text.slice(0, 3000), source: "cdp" };
      } catch { /* fall to dom-sim */ }
    }
    const html = await this.fetchHtml(url, this.timeoutMs);
    if (!html) throw new Error("dom-sim: fetch 榜单页失败");
    await humanWait(1000);
    const doc = parseHtml(html);
    const items = extractRankingItems(doc, platform);
    return { platform, url, items, textHead: doc.text.slice(0, 3000), source: "dom-sim" };
  }

  async screenshot(url: string): Promise<{ url: string; note: string; source: string }> {
    if (this.cdpOk) {
      try { return await this.cdpScreenshot(url); } catch { /* fall to dom-sim */ }
    }
    return { url, note: "dom-sim 层不支持截图 (需真浏览器内核), 已降级", source: "dom-sim" };
  }

  private async fetchHtml(url: string, timeoutMs: number): Promise<string | null> {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": pickUA(this.cfg.userAgents), "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return null;
      return await r.text();
    } catch { return null; }
  }

  private async cdpConnect(endpoint: string): Promise<WebSocket> {
    const r = await fetch(endpoint + "/json", { signal: AbortSignal.timeout(5000) });
    const targets = await r.json() as Array<{ webSocketDebuggerUrl: string; type: string }>;
    const page = targets.find(t => t.type === "page");
    if (!page) throw new Error("no page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse((ev as MessageEvent).data as string);
      if (msg.id && this.cdpPending.has(msg.id)) {
        this.cdpPending.get(msg.id)!.resolve(msg.result);
        this.cdpPending.delete(msg.id);
      }
    };
    return ws;
  }

  private cdpSend(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.cdpId;
    const p = new Promise<unknown>((resolve, reject) => {
      this.cdpPending.set(id, { resolve, reject });
      setTimeout(() => { if (this.cdpPending.has(id)) { this.cdpPending.delete(id); reject(new Error("CDP timeout")); } }, 30000);
    });
    ws.send(JSON.stringify({ id, method, params }));
    return p;
  }

  private async cdpSearch(query: string, maxResults: number, url: string): Promise<{ query: string; results: Array<{ title: string; url: string; snippet: string }>; count: number; source: string }> {
    if (!this.cdpWs) this.cdpWs = await this.cdpConnect(this.cfg.cdpEndpoint!);
    await this.cdpSend(this.cdpWs, "Page.navigate", { url });
    await new Promise(r => setTimeout(r, 3000));
    const res = await this.cdpSend(this.cdpWs, "Runtime.evaluate", {
      expression: `(() => { const out = []; for (const li of document.querySelectorAll("li.b_algo, div.g")) { if (out.length >= ${maxResults}) break; const a = li.querySelector("h2 a") || li.querySelector("a"); const p = li.querySelector("p"); if (a?.href?.startsWith("http")) out.push({ title: (a.textContent||"").trim().slice(0,200), url: a.href, snippet: (p?.textContent||"").trim().slice(0,300) }); } return out; })()`,
      returnByValue: true,
    });
    const results = ((res as any)?.result?.value || []) as Array<{ title: string; url: string; snippet: string }>;
    return { query, results, count: results.length, source: "cdp" };
  }

  private async cdpFetch(url: string, maxChars: number): Promise<{ url: string; finalUrl: string; title: string; content: string; chars: number; links: Array<{ text: string; href: string }>; source: string }> {
    if (!this.cdpWs) this.cdpWs = await this.cdpConnect(this.cfg.cdpEndpoint!);
    await this.cdpSend(this.cdpWs, "Page.navigate", { url });
    await new Promise(r => setTimeout(r, 3000));
    const res = await this.cdpSend(this.cdpWs, "Runtime.evaluate", {
      expression: `(() => { const doc = document; const title = doc.title || ""; const text = (doc.body?.innerText || doc.body?.textContent || "").slice(0, ${maxChars}); const links = []; for (const a of Array.from(doc.querySelectorAll("a[href]")).slice(0, 25)) { if (!a.href?.startsWith("http")) continue; const t = (a.textContent||"").trim(); if (t.length >= 2 && t.length <= 200) links.push({ text: t.slice(0,100), href: a.href }); } return { title, text, links }; })()`,
      returnByValue: true,
    });
    const d = (res as any)?.result?.value || {};
    return { url, finalUrl: url, title: d.title || "", content: d.text || "", chars: (d.text || "").length, links: d.links || [], source: "cdp" };
  }

  private async cdpScreenshot(url: string): Promise<{ url: string; note: string; source: string }> {
    if (!this.cdpWs) this.cdpWs = await this.cdpConnect(this.cfg.cdpEndpoint!);
    await this.cdpSend(this.cdpWs, "Page.navigate", { url });
    await new Promise(r => setTimeout(r, 2000));
    const res = await this.cdpSend(this.cdpWs, "Page.captureScreenshot", { format: "png" });
    return { url, note: "CDP 截图 base64 长度 " + String((res as any)?.data?.length || 0), source: "cdp" };
  }
}

export async function createBrowserAdapter(cfg: BrowserAdapterConfig = {}): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter(cfg);
  await adapter.probeCdp();
  return adapter;
}
