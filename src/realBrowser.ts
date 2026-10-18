/**
 * 真实浏览器抓取层 (Playwright Chromium + 反自动化检测补丁)
 *
 * 【为什么需要这一层】
 * Scrapling(curl_cffi) 只是 TLS/HTTP 指纹模拟, 打得过普通反爬, 打不过**腾讯云 WAF**:
 * 起点返回 202 + 一段 probe.js 设备指纹探针, 纯 HTTP 层无论如何都停在拦截页。
 * 实测 Playwright Chromium + stealth 补丁能拿到真实榜单 DOM。
 *
 * 【为什么不用 Camoufox】
 * Camoufox 反检测更强, 但要额外下载上百 MB 浏览器二进制; 本机 Playwright Chromium 已就绪
 * (tianyan.bat 启动时会自检), 且实测 headless shell 模式即可通过, 成本最低。
 *
 * 【重要: 别用"页面里有没有 WAF 探针脚本"判断被拦截】
 * 起点正常返回也带 probe.js / TCaptcha.js 做风控埋点, 真正的拦截是"正文只剩验证文案"。
 * 判据必须看**有没有抽出真实内容**。
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHROME_VER = "131.0.0.0";

/** 空闲多久后关掉共享浏览器实例 (避免频繁冷启动, 也别一直占着内存) */
const IDLE_TTL_MS = 60_000;
/** 单次抓取总预算 */
const FETCH_BUDGET_MS = Number(process.env.TIANYAN_REAL_BROWSER_TIMEOUT_MS) || 45_000;

// ===== 反自动化检测补丁 =====
// navigator.webdriver / window.chrome / plugins / WebGL 是可被 JS 直接检测的高频特征。
// 【写成本字符串而非 TS 函数】: 本文件在 Node 里编译 (tsconfig 无 DOM lib), 函数体一旦引用
// window/document/Notification 等浏览器全局就编译不过; 而且 addInitScript 传字符串也是官方推荐做法。
const STEALTH_SCRIPT = `
(function () {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; }, configurable: true });
    Object.defineProperty(navigator, 'languages', { get: function () { return ['zh-CN', 'zh', 'en-US', 'en']; }, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: function () { return 'Win32'; }, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 8; }, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: function () { return 8; }, configurable: true });
    Object.defineProperty(navigator, 'plugins', {
      get: function () {
        return [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer' }
        ];
      }, configurable: true
    });
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {}, app: { isInstalled: false } };
    }
    if (window.navigator && window.navigator.permissions) {
      var origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = function (params) {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return origQuery(params);
      };
    }
    var desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    if (desc && desc.get) {
      var origGet = desc.get;
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: function () {
          return String(origGet.call(navigator)).replace(/HeadlessChrome\\/[\\d.]+/, 'Chrome/${CHROME_VER}').replace(/Headless/g, '');
        }, configurable: true
      });
    }
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    };
  } catch (e) { /* 单个补丁失败不影响整体 */ }
})();
`;

// ===== 共享浏览器实例 (串行复用 + 空闲 TTL) =====
let sharedBrowser: Browser | null = null;
let sharedCtx: BrowserContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** 上次失败原因 — 浏览器环境不可用时应彻底短路, 别让每次抓取都去冷启动一遍拖慢主流程 */
let lastLaunchError = "";
/** 最近一次"页面打开成功但没抽到条目"的说明 — 这是站点级问题, 不构成熔断依据 */
let lastEmptyNote = "";
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void closeShared().catch(() => {});
  }, IDLE_TTL_MS);
}

async function closeShared(): Promise<void> {
  if (sharedCtx) { try { await sharedCtx.close(); } catch { /* ignore */ } sharedCtx = null; }
  if (sharedBrowser) { try { await sharedBrowser.close(); } catch { /* ignore */ } sharedBrowser = null; }
  ctxPromise = null;
}

// 【single-flight】并发请求的头几个会同时走到 getContext, 此时 sharedCtx 还是 null,
// 若各自 launch 就会同时起好几个 Chromium (前面的实例泄漏、互相抢资源 → 实测 Whole 扫榜
// 被拖到 124s 且部分站超时失败)。用同一个 in-flight Promise 保证只真正 launch 一次。
let ctxPromise: Promise<BrowserContext> | null = null;

function getContext(): Promise<BrowserContext> {
  if (sharedCtx) { scheduleIdleClose(); return Promise.resolve(sharedCtx); }
  if (!ctxPromise) {
    ctxPromise = createContext().catch((e) => {
      // 起不来就别把这个坏 Promise 留在原地, 否则后续请求永远复用同一份失败
      ctxPromise = null;
      throw e;
    });
  }
  return ctxPromise;
}

async function createContext(): Promise<BrowserContext> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--lang=zh-CN",
      ],
    });
  } catch (e) {
    // 环境级故障 (没装 Chromium / 端口被拦 / 沙箱限制) → 只有这里才累计熔断,
    // 避免某站超时这类站点级问题把整层拖死。
    consecutiveFailures++;
    lastLaunchError = String((e as Error)?.message || e).slice(0, 140);
    sharedCtx = null;
    sharedBrowser = null;
    throw e;
  }
  consecutiveFailures = 0;
  sharedBrowser = browser;
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  await ctx.addInitScript(STEALTH_SCRIPT);
  sharedCtx = ctx;
  scheduleIdleClose();
  return ctx;
}

// ===== 并发控制 =====
// 扫榜一次要抓 8 个平台, 全串行跑(每站 ~12s)要 96s, 太慢; 全放开又会开一堆 Chromium 把内存打爆。
// 共享同一个 Browser 实例、只开**并发 page**, 上限默认 4。
const MAX_CONCURRENT_PAGES = Number(process.env.TIANYAN_REAL_BROWSER_CONCURRENCY) || 4;
let active = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT_PAGES) { active++; return Promise.resolve(); }
  return new Promise<void>((res) => waiters.push(res));
}

function releaseSlot(): void {
  // slot 直接交给等待者 (active 计数不变), 没有等待者才真正释放
  const w = waiters.shift();
  if (w) w();
  else active--;
}

// ===== 榜单结构化提取 =====
export interface RankItemInput {
  rank: number;
  title: string;
  author?: string;
  category?: string;
  blurb?: string;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const trimAll = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 起点系 (起点中文网 / 起点女生网): li[data-rid] → .book-mid-info h2 a (书名)
 * / .author a.name (作者) / .author a (分类·子分类) / .intro (简介)
 * 用 evaluate 字符串而非 $$eval 箭头函数 —— 本文件在 Node 里编译, 没有 DOM lib,
 * 浏览器端的 document/Element 类型在编译期都不可见。
 */
const QIDIAN_EXTRACTOR = `
(function () {
  var lis = Array.prototype.slice.call(document.querySelectorAll('li[data-rid]'));
  var out = [];
  for (var i = 0; i < lis.length; i++) {
    var li = lis[i];
    var mid = li.querySelector('.book-mid-info');
    if (!mid) continue;
    var titleEl = mid.querySelector('h2 a') || mid.querySelector('.book-info h4 a') || mid.querySelector('a[data-bid]');
    var title = (titleEl && titleEl.textContent || '').trim();
    if (!title) continue;
    var authorEl = mid.querySelector('.author a.name') || mid.querySelector('.author a');
    var author = (authorEl && authorEl.textContent || '').trim();
    var authorLinks = Array.prototype.slice.call(mid.querySelectorAll('.author a'));
    var cats = [];
    for (var j = 1; j < authorLinks.length; j++) {
      var t = (authorLinks[j].textContent || '').trim();
      if (t && t !== author && t.indexOf('作者') === -1) cats.push(t);
    }
    var introEl = mid.querySelector('.intro') || mid.querySelector('.intro-text');
    var intro = (introEl && introEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push({
      rank: parseInt(li.getAttribute('data-rid') || String(out.length + 1), 10),
      title: title,
      author: author,
      category: cats.join(' · '),
      blurb: intro
    });
  }
  return out;
})()
`;

/**
 * 书名是否是"符号串/纯数字"垃圾。
 * 【陷阱】不能用 /^[\d\s\W_]+$/ : \w 只含 [A-Za-z0-9_], 汉字落在 \W 里 → 中文书名全被判垃圾。
 * 用 Unicode 属性转义: 既没有字母(\p{L})也没有数字(\p{N}) = 纯符号。
 */
function isJunkTitle(t: string): boolean {
  if (!t) return true;
  return /^[^\p{L}\p{N}]+$/u.test(t) || /^\d+$/u.test(t);
}

/** DOM textContent 常带换行/缩进, 书名里混进去会变成 "2\\n村野乱事黄金水饺" 这种脏串 */
function sanitizeItems(items: RankItemInput[]): RankItemInput[] {
  return items
    .map((i) => ({
      rank: Number(i.rank) || 0,
      title: String(i.title || "").replace(/\s+/g, " ").trim(),
      author: String(i.author || "").replace(/\s+/g, " ").trim(),
      category: String(i.category || "").replace(/\s+/g, " ").trim(),
      blurb: String(i.blurb || "").replace(/\s+/g, " ").trim(),
    }))
    // 【陷阱】别用 /^[\d\s\W_]+$/ 判"纯符号垃圾": \w 只含 [A-Za-z0-9_], **汉字属于 \W**,
    // 于是所有纯中文书名都被当成垃圾过滤掉 (实测起点整份 20 条被清空)。
    // 正确姿势: 既没有任何字母(\p{L})也没有任何数字(\p{N}) → 才是符号串。
    .filter((i) => i.title.length >= 2 && !isJunkTitle(i.title));
}

/**
 * 起点系 (起点中文网/女生网/QQ阅读等同源站) 榜单 DOM:
 *   <li data-rid="1"><div class="book-img-box">…<div class="book-mid-info">
 *     <h2><a href="…" title="夜无疆最新章节在线阅读">夜无疆</a></h2>
 *     <p class="author">…<a class="name" title="辰东">辰东</a><em>|</em>
 *       <a href="…/xuanhuan">玄幻</a><i>·</i><a class="go-sub-type">东方玄幻</a>…</p>
 *     <p class="intro">那一天太阳落下…</p>
 *
 * 【为什么不用 page.evaluate】起点的 WAF probe.js 会在首屏之后触发**二次导航**,
 * evaluate 时执行上下文已被销毁 → 抛 "Execution context was destroyed", 而它被 .catch(()=>[])
 * 静默吞掉 → 现象是"页面明明抓到了 data-rid 却一条都抽不出来"。
 * content() 拿到的 HTML 字符串是终态、不会受影响, 所以直接在 Node 侧正则解析。
 */
function extractRankFromHtml(html: string): RankItemInput[] {
  const out: RankItemInput[] = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const liRe = /<li\s+data-rid="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  for (let m = liRe.exec(html); m !== null; m = liRe.exec(html)) {
    const seg = m[2]!;
    // 只要 .book-mid-info 那一段, 丢掉右侧月票数字区 (那是自定义混淆字体, 抓不到也没用)
    const bodyM = seg.match(/<div class="book-mid-info">([\s\S]*?)<div class="book-right-info">/) ||
      seg.match(/<div class="book-mid-info">([\s\S]*)$/);
    const body = bodyM ? bodyM[1] : seg;
    const titleM = body!.match(/<h2><a[^>]*>([^<]+)<\/a>/) ||
      body!.match(/<a[^>]*data-bid[^>]*>([^<]+)<\/a>/) ||
      seg.match(/<h2><a[^>]*>([^<]+)<\/a>/);
    const title = titleM ? strip(titleM[1]!) : "";
    if (!title) continue;
    const authorM = body!.match(/<a class="name"[^>]*>([^<]+)<\/a>/) ||
      body!.match(/<p class="author">[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    const author = authorM ? strip(authorM[1]!) : "";
    const authorBlockM = body!.match(/<p class="author">([\s\S]*?)<\/p>/);
    const cats: string[] = [];
    if (authorBlockM) {
      const as = [...authorBlockM[1]!.matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((a) => strip(a[1]!)).filter((t) => t && t !== author);
      cats.push(...as);
    }
    const introM = body!.match(/<p class="intro">([\s\S]*?)<\/p>/);
    out.push({
      rank: Number(m[1]) || out.length + 1,
      title,
      author,
      category: cats.slice(0, 2).join(" · "),
      blurb: introM ? strip(introM[1]!).slice(0, 80) : "",
    });
    if (out.length >= 30) break;
  }
  return sanitizeItems(out);
}

async function extractQidian(page: Page): Promise<RankItemInput[]> {
  const r = await page.evaluate(QIDIAN_EXTRACTOR);
  return sanitizeItems((Array.isArray(r) ? r : []) as RankItemInput[]);
}

/** 通用榜单兜底: 任意容器下有书名链接的条目 */
// 【噪声黑名单】晋江等站实测会把站点导航 (作品库/VIP作品/完结半价…) 当成书名抽出来,
// 这类词混进榜单比没有数据更糟 —— 上层 looksLikeGarbage 只看"像不像书名", 认不出导航词。
// 【必须限定容器】不加限制时, 起点的页游推荐位 (.box-center 里的天尊传奇web) 会排在 DOM 前面
// 被当成第 1 名抽走。只认排行榜容器内部的元素, 找不到容器才退回全局。
const GENERIC_EXTRACTOR = `
(function () {
  var NOISE = ['作品库','VIP作品','完结作品','驻站作品','经典文库','免费文库','完结半价','包月','排行','榜单','首页','搜索','登录','注册','我的书架','作家专区','客户端','全部作品','分类'];
  var roots = [];
  var sels = ['.rank-view-list','#book-img-text','.book-img-text','.rank-body','.book-list','ul.rank-list','ol.rank-list'];
  for (var s = 0; s < sels.length; s++) {
    var found = document.querySelectorAll(sels[s]);
    for (var f = 0; f < found.length; f++) roots.push(found[f]);
  }
  var scope = roots.length > 0 ? roots : [document];
  var out = [];
  var seen = {};
  for (var r = 0; r < scope.length && out.length < 30; r++) {
    var nodes = Array.prototype.slice.call(scope[r].querySelectorAll('li, tr'));
    for (var i = 0; i < nodes.length && out.length < 30; i++) {
      var n = nodes[i];
      var a = n.querySelector('a[href*="book"]') || n.querySelector('h2 a') || n.querySelector('h3 a') || n.querySelector('h4 a') || n.querySelector('.name a');
      var title = (a && a.textContent || '').trim();
      if (!title || title.length > 40 || title.length < 2 || seen[title]) continue;
      var noisy = false;
      for (var k = 0; k < NOISE.length; k++) { if (title === NOISE[k] || title.indexOf(NOISE[k]) === 0) { noisy = true; break; } }
      if (noisy) continue;
      var txt = (n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (txt.length < 4 || txt.length > 600) continue;
      seen[title] = 1;
      out.push({ rank: out.length + 1, title: title, author: '', category: '', blurb: txt.slice(0, 80) });
    }
  }
  return out;
})()
`;

/**
 * 书旗 (shuqi.com/rank) 榜单 DOM:
 *   <ul class="cp-ranks-list js-ranksList">
 *     <li><a href="/book/8994349.html"><p class="title"><i class="no">1</i>
 *       <span class="bn">末世：播种女神暴击，亿倍返还</span><span class="au">甲无猜</span></p></a></li>
 *
 * 【为什么必须精确取 bn/au】书名和作者是**相邻且无分隔**的两个 span, 通用抽取器取 <li> 的
 * textContent 会得到 "1 村野乱事黄金水饺" —— 序号和作者名全部粘进书名, 抽成
 * 《2 村野乱事黄金水饺》《10 说好重生当律师…？为何偏偏喜欢你》(后者全是书名+作者拼接)。
 * 这种脏数据过得了"像不像书名"的校验, 会被原样喂给 LLM 做趋势归纳。
 *
 * 页面里每个 .comp-ranks-2 块是一个榜 (男频点击榜/女频点击榜…), 只取第一个块 ——
 * 否则多榜串台, 第二个榜的序号从头开始, 出现"第10名之后又是第2名"的怪数据。
 */
function extractShuqiFromHtml(html: string): RankItemInput[] {
  const out: RankItemInput[] = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const blockM = html.match(/<ul class="cp-ranks-list[^"]*">([\s\S]*?)<\/ul>/);
  if (!blockM) return out;
  const seen = new Set<string>();
  for (const li of blockM[1]!.matchAll(/<li>[\s\S]*?<\/li>/g)) {
    const seg = li[0];
    const titleM = seg.match(/<span class="bn">([\s\S]*?)<\/span>/);
    const title = titleM ? strip(titleM[1]!) : "";
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const rankM = seg.match(/<i class="no">(\d+)<\/i>/);
    const authorM = seg.match(/<span class="au">([\s\S]*?)<\/span>/);
    out.push({
      rank: rankM ? Number(rankM[1]) : out.length + 1,
      title,
      author: authorM ? strip(authorM[1]!) : "",
    });
    if (out.length >= 20) break;
  }
  return sanitizeItems(out);
}

async function extractGenericRank(page: Page): Promise<RankItemInput[]> {
  const r = await page.evaluate(GENERIC_EXTRACTOR);
  return sanitizeItems((Array.isArray(r) ? r : []) as RankItemInput[]);
}

export function formatRankItems(items: RankItemInput[]): string[] {
  // 【格式必须与 JSON API 分支一致】上层用 deterministic.parseRankingItems(rawText) 二次解析,
  // 它认的是 `第N名: **《书名》** (作者: X) | 💡 简介` —— 作者少了"作者:"前缀就会解析成空,
  // 结果这一整站被判"抓取失败"。改这里前先去看那条正则。
  return items.map((it) =>
    `第${it.rank}名: **《${it.title}》**` +
    (it.author ? ` (作者: ${it.author})` : "") +
    (it.category ? ` | ${it.category}` : "") +
    (it.blurb ? ` | 💡 ${it.blurb}` : ""),
  );
}

export interface RealBrowserResult {
  ok: boolean;
  source: string;
  finalUrl: string;
  title: string;
  html: string;
  text: string;
  items: RankItemInput[];
  error?: string;
}

/**
 * 真实浏览器抓取。返回渲染后 DOM 的 html/text, 并尽力给出结构化榜单 items。
 * items 非空 = 确实拿到了真内容 (WAF 拦截页抽不出这些东西)。
 */
/** 榜单容器选择器 — 命中任意一个就认为列表已渲染 (“,” = 或关系, Playwright 原生支持) */
const RANK_CONTAINER_SELECTOR =
  "li[data-rid], .rank-view-list, #book-img-text, .book-img-text, .rank-body, .book-list li, ul.rank-list li, table tr";

export async function realBrowserFetch(
  url: string,
  opts: { waitMs?: number; maxChars?: number; waitForSelector?: string } = {},
): Promise<RealBrowserResult> {
  // 并发跑多个平台时 Chromium 负载高, 固定 sleep 3s 常常"还没渲染完就开始抽" → 抽不到或抽到
  // 页面上半部分的广告位。改成等榜单容器真正出现 (超时就按原流程继续)。
  const { waitMs = 3500, maxChars = 150_000, waitForSelector = RANK_CONTAINER_SELECTOR } = opts;
  const fail = (error: string): RealBrowserResult => ({
    ok: false, source: "real-browser-error", finalUrl: url, title: "", html: "", text: "", items: [], error,
  });
  // 连续失败多次 → 大概率是本机 Playwright/Chromium 环境不可用, 彻底短路
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return fail(`真实浏览器层已熔断 (连续失败 ${consecutiveFailures} 次): ${lastLaunchError}`);
  }

  // 【deadline 必须在拿到并发槽之后才开始计时】扫榜一次并发请求 8 个平台, 排在后面的
  // 要先等槽位; 若 earlier 就开始倒计时, 等待时间会白白吃掉抓取预算 → goto 直接超时,
  // 表现就是"明明能抓的站也失败了"。
  await acquireSlot();
  const deadline = Date.now() + FETCH_BUDGET_MS;
  let page: Page | null = null;
  try {
    const ctx = await getContext();
    page = await ctx.newPage();
    // 屏蔽图片/字体/媒体 — 榜单页不需要, 省一半以上加载时间
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(5000, deadline - Date.now()),
    });
    // 给 WAF probe.js 之类 JS 指纹计算留出时间 (早于此时拿到的是空壳)
    await page.waitForTimeout(Math.min(waitMs, Math.max(1000, deadline - Date.now())));
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: Math.max(2000, Math.min(8000, deadline - Date.now())) }).catch(() => {});
    }
    await page.waitForLoadState("networkidle", { timeout: Math.max(2000, Math.min(8000, deadline - Date.now())) }).catch(() => {});
    const html = await page.content();
    const finalUrl = page.url();
    const title = await page.title().catch(() => "");

    // 抽取优先级: Node 侧解析 HTML 字符串 (不受 WAF 二次导航影响) → 浏览器内 DOM 查询 → 通用榜单容器。
    const dbg = extractRankFromHtml(html);
    if (process.env.TIANYAN_RB_DEBUG) {
      console.log(`[realBrowser][debug] ${url} html=${html.length} li[data-rid]=${(html.match(/<li\s+data-rid=/g) || []).length} htmlParse=${dbg.length} first=${dbg[0]?.title || "-"}`);
    }
    let items: RankItemInput[] = dbg.length > 0 ? dbg : extractShuqiFromHtml(html);
    if (items.length === 0) items = await extractQidian(page).catch(() => []);
    if (items.length === 0) items = await extractGenericRank(page).catch(() => []);
    if (items.length === 0) items = await extractGenericRank(page).catch(() => []);

    // 【注意】抽不到条目不累计熔断: 扫榜一次并发请求多个平台, 某站超时/结构变了是常态,
    // 若这也计数, 头几个站失败就会把后面所有站一起熔断 (实测导致起点被误伤为"抓取失败")。
    // 只有 getContext 抛错 (Playwright/Chromium 环境级故障) 才累计。
    if (items.length === 0) lastEmptyNote = "未抽到榜单条目";

    return {
      ok: items.length > 0,
      source: "real-browser",
      finalUrl,
      title: trimAll(title),
      html: html.slice(0, maxChars),
      text: htmlToText(html).slice(0, maxChars),
      items,
      error: items.length === 0 ? lastEmptyNote : undefined,
    };
  } catch (e) {
    lastLaunchError = String((e as Error)?.message || e).slice(0, 140);
    return fail(lastLaunchError);
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
    releaseSlot();
  }
}

/** 服务关闭时释放浏览器进程 */
export async function shutdownRealBrowser(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  await closeShared().catch(() => {});
}

/** 给外部探活: 能否真的开出浏览器 (也用来做低峰期预热) */
export async function realBrowserAvailable(): Promise<boolean> {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;
  await acquireSlot();
  try {
    await getContext();
    return true;
  } catch (e) {
    lastLaunchError = String((e as Error)?.message || e).slice(0, 140);
    consecutiveFailures++;
    return false;
  } finally {
    releaseSlot();
  }
}
