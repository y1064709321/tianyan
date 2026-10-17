// 天衍 本地 Playwright 浏览器服务 — 独立进程, HTTP :9999
// 搜索/扫榜 agent 通过 HTTP 调它, 真实 Chromium 模拟真人访问网页 (绕反爬/JS渲染)。
// 三层降级: 主=真实Chromium(headless,stealth) → 降级1=系统默认浏览器(xdg-open/open) → 降级2=纯fetch
// 启动: node browser-service.mjs
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.TIANYAN_BROWSER_PORT || 9999);

let chromium = null;
let stealth = null;
let browser = null;
let queue = Promise.resolve();
let backendMode = "unknown";

function serial(fn) {
  const t = queue.then(fn, fn);
  queue = t.then(() => {}, () => {});
  return t;
}

async function initPlaywright() {
  try {
    const pw = await import("playwright");
    const ste = await import("puppeteer-extra-plugin-stealth").catch(() => null);
    if (pw.chromium) { chromium = pw.chromium; stealth = ste?.default || null; }
    backendMode = "playwright";
  } catch (e) {
    console.log("[browser-service] Playwright 加载失败, 降级:", e.message?.slice(0, 120));
    backendMode = "fetch-only";
  }
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  const launchOpts = { headless: true, args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-blink-features=AutomationControlled"] };
  if (stealth?.default) {
    try {
      const extraChromium = stealth.default(chromium);
      browser = await extraChromium.launch(launchOpts);
      return browser;
    } catch { /* fallthrough */ }
  }
  browser = await chromium.launch(launchOpts);
  return browser;
}

function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
function pickUserAgent() {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ];
  return uas[randInt(0, uas.length - 1)];
}
function pickViewport() {
  const vps = [ {w:1366,h:768}, {w:1280,h:800}, {w:1440,h:900}, {w:1920,h:1080}, {w:1536,h:864} ];
  return vps[randInt(0, vps.length - 1)];
}

async function humanWait(page, ms) {
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(randInt(800, 2500), left);
    await page.waitForTimeout(chunk);
    const x = randInt(50, 1200), y = randInt(50, 700);
    await page.mouse.move(x, y, { steps: randInt(3, 12) }).catch(() => {});
    left -= chunk;
  }
}
async function humanScroll(page, rounds) {
  for (let i = 0; i < rounds; i++) {
    const dy = randInt(200, 900);
    await page.mouse.wheel(0, dy).catch(() => {});
    await page.waitForTimeout(randInt(600, 1800));
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
}

async function withHumanPage({ url, waitMs = 4000, scrollRounds = 2 }, fn, opTimeoutMs = 90000) {
  return serial(async () => {
    const b = await getBrowser();
    const vp = pickViewport();
    const ctx = await b.newContext({
      userAgent: pickUserAgent(),
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: randInt(1, 2),
      hasTouch: Math.random() > 0.5,
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
      window.chrome = window.chrome || { runtime: {} };
      window.Notification = window.Notification || { permission: "default" };
    });
    const page = await ctx.newPage();
    try {
      const r = await Promise.race([
        (async () => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await humanWait(page, waitMs);
          await humanScroll(page, scrollRounds);
          return await fn(page);
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("browser op timeout " + opTimeoutMs + "ms")), opTimeoutMs)),
      ]);
      await ctx.close().catch(() => {});
      return r;
    } catch (e) {
      await ctx.close().catch(() => {});
      throw e;
    }
  });
}

async function doSearch(query, maxResults = 10, engine = "bing", waitMs = 4000) {
  const searchUrl = engine === "google"
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
    : `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-Hans`;
  return withHumanPage({ url: searchUrl, waitMs, scrollRounds: 2 }, async (page) => {
    const results = await page.evaluate((max) => {
      const out = [];
      for (const li of document.querySelectorAll("li.b_algo")) {
        if (out.length >= max) break;
        const a = li.querySelector("h2 a") || li.querySelector("a");
        const p = li.querySelector("p");
        if (a?.href?.startsWith("http")) out.push({ title: (a.textContent||"").trim().slice(0,200), url: a.href, snippet: (p?.textContent||"").trim().slice(0,300) });
      }
      if (out.length === 0) {
        for (const r of document.querySelectorAll("div.g, div[data-ved]")) {
          if (out.length >= max) break;
          const a = r.querySelector("a[href^='http']");
          if (a) out.push({ title: (a.textContent||"").trim().slice(0,200), url: a.href, snippet: "" });
        }
      }
      return out;
    }, maxResults);
    return { query, engine, results, count: results.length, source: "real-browser" };
  });
}

async function doFetch(url, maxChars = 12000, waitMs = 4000) {
  return withHumanPage({ url, waitMs, scrollRounds: 2 }, async (page) => {
    const data = await page.evaluate((max) => {
      const text = (document.body?.innerText || document.body?.textContent || "").slice(0, max);
      const links = [];
      for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 120)) {
        if (!a.href?.startsWith("http")) continue;
        const t = (a.textContent || "").trim();
        if (t.length >= 2 && t.length <= 200) links.push({ text: t.slice(0, 100), href: a.href });
        if (links.length >= 25) break;
      }
      return { title: document.title, text, links };
    }, maxChars);
    return { url, finalUrl: page.url(), title: data.title, content: data.text, chars: data.text.length, links: data.links, source: "real-browser" };
  });
}

async function doRanking(platform, genre, board) {
  const urlMap = {
    "番茄小说": "https://fanqienovel.com/rank",
    "晋江文学城": "https://www.jjwxc.net/topten.php?toptype=1&isfirst=false",
    "起点中文网": "https://www.qidian.com/rank/hotsales/",
  };
  const url = urlMap[platform] || urlMap["番茄小说"];
  return withHumanPage({ url, waitMs: 6000, scrollRounds: 4 }, async (page) => {
    const items = await page.evaluate(() => {
      const out = [];
      const text = document.body?.innerText || "";
      for (const el of document.querySelectorAll("li, .book-item, .rank-item, .module-card")) {
        const titleEl = el.querySelector("[class*='title'], [class*='name'], h2, h3, .book-name");
        const authorEl = el.querySelector("[class*='author'], [class*='writer']");
        const rankEl = el.querySelector("[class*='rank'], [class*='index'], [class*='num']");
        if (titleEl?.textContent?.trim()) {
          out.push({ rank: rankEl?.textContent?.trim() || "", title: titleEl.textContent.trim().slice(0,60), author: authorEl?.textContent?.trim() || "", blurb: (el.textContent || "").replace(titleEl.textContent, "").trim().slice(0,80) });
          if (out.length >= 30) break;
        }
      }
      if (out.length === 0) {
        for (const line of text.split("\n").map(l => l.trim()).filter(Boolean)) {
          if (out.length >= 30) break;
          const m = line.match(/^(\d{1,2})[.、\s]+(.{2,40})/);
          if (m) out.push({ rank: m[1], title: m[2], author: "", blurb: "" });
        }
      }
      return { items: out, textHead: text.slice(0, 3000) };
    });
    return { platform, board, url, items: items.items, textHead: items.textHead, source: "real-browser" };
  });
}

async function systemBrowserFallback(url) {
  // Android: am start 调起系统默认浏览器 (模拟真人点击)
  if (process.platform === "android" || require("node:fs").existsSync("/system/bin/am")) {
    try {
      const { execSync } = require("node:child_process");
      execSync(`am start -a android.intent.action.VIEW -d "${encodeURIComponent(url)}" 2>/dev/null || am start -a android.intent.action.VIEW -d "${url}"`, { timeout: 5000 });
      return { url, source: "android-default-browser", note: "已用 am 调起 Android 系统默认浏览器, 请在浏览器查看 " + url };
    } catch {} 
  }
  const cmds = ["xdg-open", "open", "cmd /c start"];
  for (const cmd of cmds) {
    try {
      spawn(cmd, [url], { stdio: "ignore", detached: true, shell: true }).unref();
      return { url, source: "system-browser", note: "已调起系统默认浏览器, 请在浏览器查看 " + url };
    } catch { /* next */ }
  }
  throw new Error("无可用浏览器后端");
}

const server = http.createServer(async (req, res) => {
  const p = req.url?.split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readBody = () => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } }); });

  try {
    if (req.method === "GET" && p === "/health") return json(200, { ok: true, backend: backendMode, port: PORT });
    if (req.method === "POST") {
      const body = await readBody();
      if (backendMode !== "playwright") {
        if (p === "/fetch") {
          if (process.env.TIANYAN_BROWSER_SYSTEM === "1") return json(200, await systemBrowserFallback(body.url));
          const r = await fetch(body.url, { headers: { "User-Agent": pickUserAgent() }, signal: AbortSignal.timeout(15000) });
          const text = (await r.text()).slice(0, body.maxChars || 12000);
          return json(200, { url: body.url, content: text, chars: text.length, source: "fetch-only" });
        }
        return json(400, { error: "后端降级模式不支持: " + p, backend: backendMode });
      }
      if (p === "/search") return json(200, await doSearch(body.query, body.maxResults || 10, body.engine || "bing", body.waitMs || 4000));
      if (p === "/fetch") return json(200, await doFetch(body.url, body.maxChars || 12000, body.waitMs || 4000));
      if (p === "/ranking") return json(200, await doRanking(body.platform, body.genre, body.board));
      return json(404, { error: "unknown endpoint: " + p });
    }
    return json(405, { error: "method not allowed" });
  } catch (e) {
    json(500, { error: e.message, backend: backendMode });
  }
});

await initPlaywright();
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  天衍 本地浏览器服务");
  console.log(`  地址: http://127.0.0.1:${PORT}`);
  console.log(`  后端: ${backendMode}\n\n`);
});

process.on("SIGINT", async () => { try { await browser?.close(); } catch {} process.exit(); });
process.on("SIGTERM", async () => { try { await browser?.close(); } catch {} process.exit(); });
