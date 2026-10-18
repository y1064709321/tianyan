// 真实浏览器层可行性探测: 用 Playwright Chromium + 反自动化检测补丁, 试着抓 WAF 站点。
// 用途: 判断能不能把"真实浏览器"接回抓取降级链 (Scrapling curl_cffi 打不过腾讯云 WAF)。
// 用法: node scripts/probe-real-browser.js [url]
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 反检测补丁 (移植自 puppeteer-extra-plugin-stealth 的核心几条)
const STEALTH_INIT = () => {
  // navigator.webdriver -> undefined
  Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en-US", "en"] });
  Object.defineProperty(navigator, "plugins", {
    get: () => [
      { name: "PDF Viewer", filename: "internal-pdf-viewer" },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer" },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer" },
      { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer" },
      { name: "WebKit built-in PDF", filename: "internal-pdf-viewer" },
    ],
  });
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  // window.chrome 运行时
  if (!window.chrome) {
    window.chrome = {
      runtime: { id: undefined, onConnect: undefined, onMessage: undefined },
      loadTimes: function () { },
      csi: function () { },
      app: { isInstalled: false },
    };
  }
  // permissions 查询伪装
  if (window.navigator && window.navigator.permissions) {
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params && params.name === "notifications"
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery(params);
  }
  // UA 里的 Headless 关键字抹掉 (在 UA override 之后执行)
  try {
    const origUaProp = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
    if (origUaProp && origUaProp.get) {
      Object.defineProperty(Navigator.prototype, "userAgent", {
        get: () => origUaProp.get.call(navigator).replace(/HeadlessChrome\/[\d.]+/, "Chrome/${CHROME_VER}").replace(/Headless/g, ""),
        configurable: true,
      });
    }
  } catch { /* ignore */ }
  // WebGL vendor/renderer 伪装
  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParam.call(this, p);
    };
  } catch { /* ignore */ }
  // iframe contentWindow 的 webdriver 补丁也会在每个新 frame 生效 (addInitScript 已覆盖)
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 三种模式由弱到强试: headless shell -> 完整 chromium headless=new -> 完整 chromium 有头
const MODES = [
  { name: "headless-shell", opts: { headless: true, args: ["--headless=old"] } },
  { name: "chromium-headless-new", opts: { headless: true, channel: "chromium", args: ["--headless=new"] } },
  { name: "chromium-headed", opts: { headless: false, channel: "chromium" } },
];

async function tryMode(url, mode) {
  let browser;
  try {
    browser = await chromium.launch({
      ...mode.opts,
      args: [
        ...(mode.opts.args || []),
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--lang=zh-CN",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      javaScriptEnabled: true,
    });
    await ctx.addInitScript(STEALTH_INIT);
    const page = await ctx.newPage();
    // 屏蔽图片/字体/媒体, 提速
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // 给 probe.js 之类 JS 计算留出时间
    await page.waitForTimeout(4000);
    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch { /* 网络不静默也算到 */ }
    const finalUrl = page.url();
    const html = await page.content();
    return { ok: true, status: resp ? resp.status() : 0, finalUrl, html };
  } catch (e) {
    return { ok: false, error: (e && e.message ? e.message : String(e)).slice(0, 160) };
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function judge(url, html) {
  const text = stripTags(html);
  // 【重要】不能拿"页面里有没有 WAF 探针脚本"当拦截判据 —— 起点正常返回也带 probe.js/TCaptcha.js
  // 做风控埋点。真正的拦截标志是"正文里只剩验证文案"。所以判据只看**正文是否含真实内容**。
  const hardBlocked = [
    [/^(安全验证|访问验证|请先完成验证)/i, "纯验证页"],
    [/^\s*403\s*$/, "纯403"],
  ];
  const hits = hardBlocked.filter(([re]) => re.test(text)).map(([, n]) => n);
  if (hits.length === 0 && text.length < 500) hits.push("正文过短");
  // 榜单特征: 排名数字 + 书名 + 作者/分类
  const bookish = /书籍详情|加入书架|小说排行|月票榜|畅销榜|追读榜|bookName|book-info/i.test(text);
  return { blocked: hits, htmlLen: html.length, textLen: text.length, bookish, title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "" };
}

async function main() {
  const url = process.argv[2] || "https://www.qidian.com/rank/yuepiao";
  console.log(`目标: ${url}\n`);
  for (const mode of MODES) {
    process.stdout.write(`[${mode.name}] 启动中... `);
    const r = await tryMode(url, mode);
    if (!r.ok) { console.log(`失败: ${r.error}`); continue; }
    // 无论成败都落盘一份, 便于分析到底是拦截页还是真内容
    try {
      mkdirSync(join(root, "scripts", ".probe-out"), { recursive: true });
      writeFileSync(join(root, "scripts", ".probe-out", `rb-${mode.name}.html`), r.html, "utf8");
    } catch { /* ignore */ }
    const j = judge(url, r.html);
    console.log(`status=${r.status} html=${j.htmlLen}字 正文=${j.textLen}字 榜单特征=${j.bookish} 拦截=[${j.blocked.join(",") || "无"}]`);
    console.log(`    title: ${j.title}`);
    if (j.blocked.length === 0 && j.bookish) {
      console.log(`\n✅ 模式 "${mode.name}" 通过 (拿到真实页面内容)`);
      console.log("HTML 已存 scripts/.probe-out/");
      return;
    }
  }
  console.log("\n❌ 三种模式都没能拿到真实内容");
}

main().catch((e) => { console.error("探测异常:", e.message); process.exit(1); });
