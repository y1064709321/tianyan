/**
 * 番茄小说专属抓取 —— 之所以单独成文件, 是因为番茄跟其他平台完全不是一个套路:
 *
 * 1. 番茄有**三套互不相关的榜**, 而且只有"作品分类榜"是传统意义上的排行榜:
 *    - 金番作家榜 (作家等级榜: 殿堂作家 > 金番作家) —— 用户点名要的"金番茄榜"
 *    - 番茄巅峰榜 (首页头部精品作品, 带分类标签)
 *    - 分类阅读/新书榜 (按题材分, 37 个分类)
 * 2. 分类榜的**书名/作者/简介是 PUA 字体混淆码点** (私用区字符, 直接输出是一坨豆腐块),
 *    必须拿 bookId 去书详情页再取一次干净数据。
 * 3. 老接口 `/api/rank/list?way=N` 是**假榜** —— way=1..8 全部返回同一份都市赘婿综合榜,
 *    没有任何题材区分度, 用户当场指出"这种的榜没啥作用"。
 *
 * 所有接口实测**不需要 a_bogus 签名**, 纯 fetch + 浏览器 UA 即可。
 */

import { logInfo } from "../logger.js";
import { normGenre } from "./genreFilter.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface FanqieBook {
  title: string;
  author: string;
  blurb: string;
  /** 巅峰榜带分类标签 (都市高武/悬疑脑洞/...) */
  category?: string;
  /** 作家榜用的等级 (殿堂作家/金番作家) */
  level?: string;
}

async function getJson(url: string, timeoutMs = 15000): Promise<any | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://fanqienovel.com/" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch (e) {
    logInfo(`[番茄] 请求失败 ${url.slice(0, 80)} :: ${(e as Error).message?.slice(0, 50)}`);
    return null;
  }
}

/**
 * 番茄分类 ID 表 —— 来源:
 *   https://fanqienovel.com/api/config/list?config_key=serial_rank_category_list_common
 * 站点改版会变, 表里 37 项失效时重新拉一次上面的接口刷新即可 (group 分 male/female)。
 * gender: 1=男频 0=女频
 */
export const FANQIE_CATEGORIES: Array<{ name: string; id: number; gender: 0 | 1 }> = [
  { name: "东方仙侠", id: 1140, gender: 1 },
  { name: "传统玄幻", id: 258, gender: 1 },
  { name: "玄幻脑洞", id: 257, gender: 1 },
  { name: "西方奇幻", id: 1141, gender: 1 },
  { name: "都市日常", id: 261, gender: 1 },
  { name: "都市修真", id: 124, gender: 1 },
  { name: "都市高武", id: 1014, gender: 1 },
  { name: "都市脑洞", id: 262, gender: 1 },
  { name: "都市种田", id: 263, gender: 1 },
  { name: "战神赘婿", id: 27, gender: 1 },
  { name: "历史古代", id: 273, gender: 1 },
  { name: "历史脑洞", id: 272, gender: 1 },
  { name: "悬疑脑洞", id: 539, gender: 1 },
  { name: "悬疑灵异", id: 751, gender: 1 },
  { name: "科幻末世", id: 8, gender: 1 },
  { name: "游戏体育", id: 746, gender: 1 },
  { name: "抗战谍战", id: 504, gender: 1 },
  { name: "动漫衍生", id: 718, gender: 1 },
  { name: "男频衍生", id: 1016, gender: 1 },
  { name: "古风世情", id: 1139, gender: 0 },
  { name: "古言脑洞", id: 253, gender: 0 },
  { name: "玄幻言情", id: 248, gender: 0 },
  { name: "宫斗宅斗", id: 246, gender: 0 },
  { name: "豪门总裁", id: 748, gender: 0 },
  { name: "青春甜宠", id: 749, gender: 0 },
  { name: "现言脑洞", id: 267, gender: 0 },
  { name: "职场婚恋", id: 750, gender: 0 },
  { name: "民国言情", id: 1017, gender: 0 },
  { name: "星光璀璨", id: 745, gender: 0 },
  { name: "女频悬疑", id: 747, gender: 0 },
  { name: "种田", id: 23, gender: 0 },
  { name: "年代", id: 79, gender: 0 },
  { name: "快穿", id: 24, gender: 0 },
  { name: "女频衍生", id: 1015, gender: 0 },
];

/**
 * 项目题材 → 番茄分类。先按别名/前缀归一化成标准题材 (复用 genreFilter), 再查名。
 * 番茄没有"武侠"这种大类, 也没有泛"言情" —— 映射不到就返回 null, 调用方回退巅峰榜并如实标注,
 * 不要拿个不沾边的分类冒充 (历史上拿都市赘婿榜冒充仙侠榜被用户当场抓包)。
 */
const GENRE_TO_FANQIE: Record<string, string> = {
  "仙侠": "东方仙侠",
  "玄幻": "传统玄幻",
  "都市": "都市日常",
  "科幻": "科幻末世",
  "悬疑": "悬疑脑洞",
  // 番茄女频没有泛"言情"大类, 只有现言/古言/总裁/甜宠等细分 —— 给个最贴近的"现言脑洞",
  // 总比回退到巅峰榜(全是都市高武悬疑)有用。武侠是真没有, 保持不映射。
  "言情": "现言脑洞",
};

export function pickFanqieCategory(genre: string): { name: string; id: number; gender: 0 | 1 } | null {
  const canon = normGenre(genre);
  if (!canon) return null;
  const name = GENRE_TO_FANQIE[canon!];
  if (!name) return null;
  return FANQIE_CATEGORIES.find((c) => c.name === name) || null;
}

/** 金番作家榜: 殿堂作家 + 金番作家 + 代表作 (数据干净, 无字体混淆) */
export async function fetchFanqieAuthorBoard(limit = 60): Promise<FanqieBook[]> {
  const j = await getJson(`https://fanqienovel.com/api/author/misc/top_author_list/v1/?limit=${limit}&offset=0`);
  // 注意: 数据在**顶层 author_list**, 不在 j.data —— 取错位置会得到 0 条
  const arr: any[] = j?.author_list || [];
  if (arr.length === 0) return [];
  const out: FanqieBook[] = [];
  for (const a of arr) {
    const author = String(a.author || "").trim();
    const level = String(a.author_level || "").trim();
    const intr = String(a.introduction || "").trim();
    if (!author) continue;
    // 代表作可能有多本: "代表作《惜花芷》《惹金枝》" → 取第一本当"书名", 保证 parseRankingItems 契约
    const first = intr.match(/《([^》]+)》/);
    out.push({
      title: first ? first[1]! : author,
      author,
      blurb: [level, intr].filter(Boolean).join(" · "),
      level,
    });
  }
  logInfo(`[番茄] 金番作家榜 ${out.length} 位 (殿堂 ${out.filter((x) => x.level === "殿堂作家").length} / 金番 ${out.filter((x) => x.level === "金番作家").length})`);
  return out;
}

/** 番茄巅峰榜: 首页头部精品作品 (带分类标签, 数据干净) */
export async function fetchFanqieTopBooks(limit = 30): Promise<FanqieBook[]> {
  const j = await getJson(`https://fanqienovel.com/api/author/misc/top_book_list/v1/?limit=${limit}&offset=0`);
  // 同样在**顶层 book_list**
  const arr: any[] = j?.book_list || [];
  const out: FanqieBook[] = [];
  for (const b of arr) {
    const title = String(b.book_name || "").trim();
    if (!title) continue;
    out.push({
      title,
      author: String(b.author || "").trim(),
      blurb: "",
      category: String(b.category || "").trim(),
    });
  }
  logInfo(`[番茄] 巅峰榜 ${out.length} 部`);
  return out;
}

/**
 * 书详情页取干净数据 —— 绕开字体混淆的关键一步。
 * 分类榜 API 返回的 bookName/author/abstract 是 PUA 私用区码点 (渲染靠动态字体, 文本层面全是乱码),
 * 但详情页是服务端渲染的 SEO 页, title / meta description / meta keywords **全部是正常汉字**。
 * 实测一次请求就能拿到书名 + 简介 + 作者, 比破解字体 (字形比对建映射表) 简单一万倍。
 */
async function fetchCleanByPage(bookId: string): Promise<{ title: string; author: string; blurb: string } | null> {
  try {
    const r = await fetch(`https://fanqienovel.com/page/${bookId}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    // title 形如: "西游：开局找黄狮精买功法完整版在线免费阅读_西游：..._番茄小说官网"
    const tM = html.match(/<title>([^<]*)<\/title>/);
    let title = tM ? tM[1]!.replace(/完整版在线免费阅读[\s\S]*$/, "").trim() : "";
    // meta description: "番茄小说提供{书名}完整版在线免费阅读，精彩小说尽在番茄小说网。{简介}"
    const dM = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    let blurb = "";
    if (dM) {
      const d = dM[1]!;
      const bm = d.match(/精彩小说尽在番茄小说网。([\s\S]*)$/);
      blurb = bm ? bm[1]!.trim() : "";
      if (!title) {
        const nm = d.match(/提供(.+?)完整版在线免费阅读/);
        if (nm) title = nm[1]!.trim();
      }
    }
    // 作者: keywords 里形如 "...,仙临尘小说西游：..." ; 取不到再试页面上的 author 元素
    let author = "";
    const kM = html.match(/<meta\s+name="keywords"\s+content="([^"]*)"/i);
    if (kM) {
      const am = kM[1]!.match(/,([^,]{1,20}?)小说[^,]*(?:免费阅读|最新章节)/);
      if (am) author = am[1]!.trim();
    }
    if (!author) {
      const aM = html.match(/class="[^"]*author[^"]*"[^>]*>([^<]{1,20})</i);
      if (aM) author = aM[1]!.trim();
    }
    if (!title) return null;
    return { title, author, blurb };
  } catch {
    return null;
  }
}

/**
 * 分类阅读/新书榜。
 * @param rankMold 1=阅读榜 2=新书榜 (实测官网就这么传)
 * 注意 **limit 只能 10** —— 传 20 会返回 0 本 (接口硬限制, 别再调大)。
 */
export async function fetchFanqieCategoryBoard(
  category: { name: string; id: number; gender: 0 | 1 },
  rankMold: 1 | 2,
): Promise<FanqieBook[]> {
  const url =
    `https://fanqienovel.com/api/rank/category/list?app_id=2503&rank_list_type=3&offset=0&limit=10` +
    `&category_id=${category.id}&rank_version=&gender=${category.gender}&rankMold=${rankMold}`;
  const j = await getJson(url);
  if (!j || j.code !== 0) {
    logInfo(`[番茄] 分类榜 ${category.name} 请求失败 (code=${j?.code})`);
    return [];
  }
  const raw: any[] = j?.data?.book_list || [];
  if (raw.length === 0) return [];
  // 并发去详情页还原干净书名/作者/简介
  const cleaned = await Promise.all(
    raw.map(async (b) => {
      const id = String(b.bookId || b.book_id || "");
      if (!id) return null;
      const c = await fetchCleanByPage(id);
      if (!c) return null;
      return { ...c, readCount: Number(b.read_count || 0) };
    }),
  );
  const out: FanqieBook[] = [];
  for (const c of cleaned) {
    if (!c || !c.title) continue;
    const rc = c.readCount > 0 ? ` 在读 ${(c.readCount / 10000).toFixed(1)} 万` : "";
    out.push({ title: c.title, author: c.author, blurb: (c.blurb ? c.blurb.slice(0, 80) : "") + rc });
  }
  logInfo(`[番茄] 分类榜 ${category.name}(${rankMold === 1 ? "阅读" : "新书"}) ${out.length}/${raw.length} 部还原成功`);
  return out;
}

/** 统一格式化 —— 必须严格对齐 parseRankingItems 的契约: "第N名: **《书名》** (作者: X) | 💡 简介" */
export function formatFanqieBooks(books: FanqieBook[], boardLabel: string): string[] {
  const out: string[] = [];
  books.forEach((b, i) => {
    const author = b.author ? ` (作者: ${b.author})` : "";
    const bits: string[] = [];
    if (b.category) bits.push(b.category);
    if (b.blurb) bits.push(b.blurb);
    const tail = bits.length > 0 ? ` | 💡 ${bits.join(" · ")}` : "";
    out.push(`第${i + 1}名: **《${b.title}》**${author}${tail}`);
  });
  if (out.length > 0) out.unshift(`> ${boardLabel}（数据来源: 番茄小说，接口实时抓取）`);
  return out;
}
