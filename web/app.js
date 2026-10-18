// 天衍 前端:Codex 式聊天 + 步骤展示 + 多格式 + 系统打磨
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============ 前端日志上报通道 (2026-10-02 用户要求: 前端"不渲染"能查到原因) ============
// window.onerror / unhandledrejection / console.error|warn 拦截 → POST /api/client-log → 后端 tianyan.log
// 脱敏: 只上报 类别 + 消息 + 触发时 DOM 状态 (activeAgent/是否有 thinking), 不报用户输入内容。
// 防风暴: 同类日志 5s 内只报 1 次 (限流刷屏时不炸后端)。
let __clientLogLast = {};
function reportClientLog(level, msg, ctx) {
  try {
    const key = level + ":" + String(msg).slice(0, 80);
    const now = Date.now();
    if (__clientLogLast[key] && now - __clientLogLast[key] < 5000) return;
    __clientLogLast[key] = now;
    const payload = {
      level,
      msg: String(msg).slice(0, 500),
      ctx: { activeAgent: typeof activeAgent !== "undefined" ? activeAgent : null, ...ctx },
    };
    fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {}); // 上报失败静默 (前端挂了时不阻塞)
  } catch (e) { /* ignore */ }
}
window.addEventListener("error", (e) => {
  reportClientLog("error", e.message || "window.onerror", { src: e.filename, line: e.lineno });
});
window.addEventListener("unhandledrejection", (e) => {
  reportClientLog("error", "unhandledrejection: " + (e.reason && (e.reason.message || String(e.reason))).slice(0, 200), {});
});
// 拦截 console.error/warn 里的 [SSE] 未知事件、渲染异常 (原有 console.warn 保留, 仅加上报)
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn = console.warn.bind(console);
console.error = function(...args) {
  _origConsoleError(...args);
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 300);
  reportClientLog("console.error", msg, {});
};
console.warn = function(...args) {
  _origConsoleWarn(...args);
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 300);
  // 只上报 [SSE] 前缀的 (未知事件类型 = 后端契约变化的关键信号), 其它 warn 不上报防噪
  if (msg.startsWith("[SSE]") || msg.startsWith("[渲染]")) reportClientLog("console.warn", msg, {});
};

let currentProject = null;
let chatHistory = [];
let config = { default: "", models: [], ready: true };
let agentsList = [];
let currentAgent = "orchestrator";        // 入口 agent(固定为 orchestrator,用户不能手选)
let activeAgent = "orchestrator";           // 当前活跃 agent(由 delegate 事件自动更新)
let workflowPhases = [];
let readonlyAgents = [];

// ============ 后端心跳检测 ============
const HEARTBEAT_INTERVAL = 15000; // 15秒检测一次
const HEARTBEAT_TIMEOUT = 5000;   // 5秒超时
let heartbeatTimer = null;
let heartbeatFailCount = 0;
let heartbeatStatus = "unknown"; // unknown | online | offline | reconnecting

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(checkBackend, HEARTBEAT_INTERVAL);
  checkBackend(); // 立即检测一次
}

async function checkBackend() {
  const dot = $("#conn-dot");
  const text = $("#conn-text");
  const status = $("#conn-status");
  if (!dot || !text || !status) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT);
    const res = await fetch("/api/config", { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      if (heartbeatStatus === "offline" || heartbeatStatus === "reconnecting") {
        toast("后端已恢复连接", "ok");
      }
      heartbeatStatus = "online";
      heartbeatFailCount = 0;
      status.className = "conn-status online";
      dot.title = "后端在线";
      text.textContent = "";
    } else {
      throw new Error("HTTP " + res.status);
    }
  } catch (e) {
    heartbeatFailCount++;
    if (heartbeatFailCount >= 2) {
      heartbeatStatus = "offline";
      status.className = "conn-status offline";
      text.textContent = "连接断开";
      dot.title = "后端离线";
    } else if (heartbeatFailCount === 1) {
      heartbeatStatus = "reconnecting";
      status.className = "conn-status reconnecting";
      text.textContent = "重连中…";
      dot.title = "正在重连";
    }
  }
}

// ---- 主题 (浅色/深色/护眼/暗夜紫/羊皮纸) ----
const THEMES = {
  light:   { label: "浅色白",  vars: { "--paper":"#ffffff", "--paper2":"#f7f7f8", "--paper3":"#eef0f2", "--paper4":"#e4e7ea", "--ink":"#1a1a1a", "--ink2":"#4a4a4a", "--muted":"#8a8a8a", "--border":"#e2e2e2", "--border2":"#d0d0d0", "--accent":"#c43d3d", "--blue":"#3d6b8b", "--green":"#2d7a4a", "--yellow":"#9a6b1f", "--red":"#c43d3d" } },
  dark:    { label: "深色夜",  vars: { "--paper":"#1e1f22", "--paper2":"#18191c", "--paper3":"#2a2b2f", "--paper4":"#36373b", "--ink":"#e6e6e6", "--ink2":"#b0b0b0", "--muted":"#7a7a7a", "--border":"#3a3b3f", "--border2":"#4a4b4f", "--accent":"#e57070", "--blue":"#7ab0d4", "--green":"#5fb878", "--yellow":"#d4a256", "--red":"#e57070" } },
  eye:     { label: "护眼绿",  vars: { "--paper":"#c7e3c7", "--paper2":"#b8dab8", "--paper3":"#a8d0a8", "--paper4":"#98c698", "--ink":"#1f3a1f", "--ink2":"#3a5a3a", "--muted":"#6a8a6a", "--border":"#9ac89a", "--border2":"#88b488", "--accent":"#8a3d3d", "--blue":"#3d5a7a", "--green":"#2d6a4a", "--yellow":"#8a6b1f", "--red":"#8a3d3d" } },
  sepia:   { label: "羊皮纸",  vars: { "--paper":"#f6efd9", "--paper2":"#efe5c2", "--paper3":"#e6d9a8", "--paper4":"#dcc88a", "--ink":"#2e1f15", "--ink2":"#5a4530", "--muted":"#8a7a5a", "--border":"#d8c890", "--border2":"#c8b870", "--accent":"#a13d3d", "--blue":"#3d6b8b", "--green":"#2d7a4a", "--yellow":"#9a6b1f", "--red":"#a13d3d" } },
  purple:  { label: "暗夜紫",  vars: { "--paper":"#221a2e", "--paper2":"#1a1424", "--paper3":"#2e2440", "--paper4":"#3a2e52", "--ink":"#e8dff5", "--ink2":"#b8a8d4", "--muted":"#7a6a9a", "--border":"#3a2e52", "--border2":"#4a3a68", "--accent":"#c47a9a", "--blue":"#7a9ad4", "--green":"#5fb878", "--yellow":"#d4a256", "--red":"#c47a7a" } },
};
let currentTheme = localStorage.getItem("na-theme") || "sepia";
let currentFontScale = parseFloat(localStorage.getItem("na-font-scale") || "1");

function applyTheme(name) {
  const t = THEMES[name] || THEMES.sepia;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  localStorage.setItem("na-theme", name);
  currentTheme = name;
}

function applyFontScale(s) {
  const root = document.documentElement;
  root.style.setProperty("--font-scale", String(s));
  // CSS 变量 (供 fixed 浮层 settings-panel/modal/cmdk 用,因为它们在 .app 之外,不受 .app zoom 影响)
  root.style.setProperty("--base-font", `${(14 * s).toFixed(2)}px`);
  root.style.setProperty("--chat-msg-font", `${(15.5 * s).toFixed(2)}px`);
  // line-height 必须是无单位的比例值 (如 1.85), 不能带 px。
  // 若写成 1.85px 则每行仅 1.85 像素高, 字体 (15.5px) 会全部叠压在一起。
  // 且 --chat-msg-font 已按 s 缩放, line-height 作为倍数会自动跟随, 无需再乘 s。
  root.style.setProperty("--chat-line", "1.85");
  root.style.setProperty("--fs-sm", `${(12 * s).toFixed(2)}px`);
  root.style.setProperty("--fs-xs", `${(11 * s).toFixed(2)}px`);
  root.style.setProperty("--fs-md", `${(13 * s).toFixed(2)}px`);
  // 主页整体缩放:zoom 会等比缩放 .app 内所有元素 (按钮/字号/间距/图标/卡片)
  // 配合反向算 width/height:zoom s 倍后视觉宽度=100/s * s = 100vw,正好占满视口,
  // 不会溢出导致按钮被推出屏幕 / 卡片被裁
  const app = document.querySelector(".app");
  if (app) {
    app.style.zoom = String(s);
    app.style.width = `${(100 / s).toFixed(4)}vw`;
    app.style.height = `${(100 / s).toFixed(4)}vh`;
  }
  localStorage.setItem("na-font-scale", String(s));
  currentFontScale = s;
  const lbl = $("#sp-fontscale-label");
  if (lbl) lbl.textContent = `字号缩放 (当前 ${s.toFixed(2)}x)`;
}
const AGENT_LABELS = {
  orchestrator: "总编",
  "story-architect": "架构师",
  "narrative-writer": "主笔",
  "character-designer": "角色师",
  "consistency-checker": "质检员",
  "story-explorer": "资料员",
  presenter: "监制",
  worldbuilder: "设定管理员", // 兼容旧名
  planner: "策划师", writer: "主笔", editor: "编辑",
};
const AGENT_ICONS = {
  orchestrator: "🎯",
  "story-architect": "📐",
  "narrative-writer": "✍️",
  "character-designer": "👤",
  "consistency-checker": "🔍",
  "story-explorer": "📊",
  presenter: "📋",
  worldbuilder: "🌐", // 兼容旧名
  planner: "📐", writer: "✍️", editor: "🔧",
};
// ============ 小说分类数据 ============
const GENRE_DATA = {
  "男频": {
    "主分类": [
      "西方奇幻","东方仙侠","科幻末世","男频衍生","都市高武",
      "悬疑灵异","悬疑脑洞","抗战谍战","历史古代","历史脑洞",
      "都市种田","都市脑洞","都市日常","玄幻脑洞","战神赘婿",
      "动漫衍生","游戏体育","传统玄幻","都市修真"
    ],
    "主题": [
      "衍生","仕途","综影视","天灾","第一人称","赛博朋克",
      "第四天灾","规则怪谈","搞笑轻松","古代","悬疑",
      "克苏鲁","都市异能","末日求生","灵气复苏"
    ]
  },
  "女频": {
    "主分类": [
      "女频悬疑","古风世情","科幻末世","女频衍生","民国言情",
      "悬疑脑洞","青春甜宠","双男主","古言脑洞","现言脑洞",
      "玄幻言情","宫斗宅斗","豪门总裁","动漫衍生","星光璀璨",
      "游戏体育","职场婚恋","双女主","年代","种田","快穿"
    ],
    "主题": [
      "古言权谋","悬疑恋爱","纯爱","衍生","仕途",
      "综影视","天灾","第一人称","赛博朋克","规则怪谈",
      "搞笑轻松","古代","悬疑","谍战","职场商战"
    ]
  }
};
// 分类下拉填充
function populateGenreSelects(audience) {
  const data = GENRE_DATA[audience] || GENRE_DATA["男频"];
  const genreSel = $("#p-genre");
  const themeSel = $("#p-theme");
  genreSel.innerHTML = '<option value="">-- 选择主分类 --</option>';
  themeSel.innerHTML = '<option value="">-- 选择主题 --</option>';
  data["主分类"].forEach(g => {
    genreSel.innerHTML += '<option value="' + g + '">' + g + '</option>';
  });
  data["主题"].forEach(t => {
    themeSel.innerHTML += '<option value="' + t + '">' + t + '</option>';
  });
}

// 工具名 → 中文标签
const TOOL_CN = {
  generate_outline: "生成大纲",
  continue_writing: "续写正文",
  polish: "润色改写",
  add_element: "添加设定",
  query_project: "查询项目",
  delegate_to_agent: "委派专家",
  manage_outline: "细纲管理",
  load_context: "加载上下文",
  quality_check: "一致性检查",
  scan_bestseller: "扫榜调研",
  analyze_novel: "拆书解构",
  review_chapter: "毒舌审稿",
  list_authors: "列出作家",
  match_author: "匹配作家",
  get_author_reference: "取作家参考",
  deconstruct: "拆书解构",
  audit_novel: "33维审计",
  detect_ai: "AI味检测",
  diagnose_opening: "黄金三章诊断",
  analyze_style: "文风分析",
  imitate_style: "文风仿写",
  diagnose_stuck: "卡文诊断",
  ghostwrite: "枪手代笔",
  full_audit: "完整审计",
  web_fetch: "网页抓取",
  web_search: "网页搜索",
  browser_fetch: "浏览器抓取",
  browser_screenshot: "浏览器截图",
  // 新架构工具 (角色档案/世界观/里程碑/风格缓存/四重校验/交付报告)
  manage_character: "角色档案管理",
  manage_world: "世界观档案管理",
  manage_milestone: "里程碑管理",
  cache_style: "风格缓存",
  four_check: "四重校验",
  generate_delivery_report: "生成交付报告",
};

function cnTool(name) {
  return TOOL_CN[name] || name.replace(/_/g, " ");
}

// ---------- 工具 ----------
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
  } catch (e) {
    toast(`网络请求失败: ${e.message}`, "warn");
    throw e;
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // 后端返回了非 JSON (通常是 HTML 错误页或纯文本),不要让浏览器跳转
    const text = await res.text();
    toast(`接口异常 (HTTP ${res.status}): ${text.slice(0, 120)}`, "warn");
    throw new Error(`接口 ${path} 返回非 JSON: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!res.ok) {
    // 422/500 等: 显示后端错误信息
    const msg = data.detail || data.error || JSON.stringify(data).slice(0, 200);
    toast(`请求失败 (${res.status}): ${msg}`, "warn");
    throw new Error(`接口 ${path} HTTP ${res.status}: ${msg}`);
  }
  return data;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- 36 维质检结果摘要 ----------
// quality_check 的返回是一大坨 JSON, 直接截断显示用户只能看到裸 JSON 片段。
// 后端现在逐维给出 dimensionAudit (36 条: 谁审的 / 是否命中 / 命中什么), 这里渲染成可读摘要。
function renderQcDimensionSummary(raw) {
  let p = null;
  try { p = typeof raw === "object" ? raw : JSON.parse(String(raw || "")); } catch { return null; }
  if (!p) return null;
  const dims = p.dimensionAudit;
  if (!Array.isArray(dims) || !dims.length) return null;
  const cov = p.dimensionCoverage || {};
  const hits = dims.filter((d) => d && d.hit);
  const unaudited = Array.isArray(p.unauditedDimensions) ? p.unauditedDimensions : [];
  const verdict = String(p.verdict || "");
  const score = p.overall_score ?? p.overall ?? null;

  const sevCls = (s) => (s === "S1" ? "qc-s1" : s === "S2" ? "qc-s2" : "qc-s3");
  const chips = hits.slice(0, 8).map((d) =>
    `<span class="qc-chip ${sevCls(d.sev)}" title="${esc(d.detail || "")}">${esc(d.sev)} ${d.id}.${esc(d.name)}</span>`).join("");
  const more = hits.length > 8 ? `<span class="qc-chip qc-more">+${hits.length - 8} 项</span>` : "";
  const orig = p.originality || null;
  const origLine = orig && orig.verdict && orig.verdict !== "clean"
    ? `<div class="qc-orig">⚠️ 原创度: ${esc(orig.verdict === "plagiarized" ? "疑似照抄" : "相似度偏高")}${orig.worstSource ? ` · ${esc(orig.worstSource)}` : ""}</div>`
    : "";

  return `<div class="qc-audit">
    <div class="qc-head">
      <span class="qc-verdict qc-v-${verdict.toLowerCase()}">${esc(verdict || "—")}</span>
      ${score != null ? `<span class="qc-score">${esc(score)}/10</span>` : ""}
      <span class="qc-cov">审 ${esc(cov.total || dims.length)} 维 · 命中 <b>${hits.length}</b></span>
      ${unaudited.length ? `<span class="qc-unaudited" title="未审维度: ${esc(unaudited.join(","))}">${unaudited.length} 维未审</span>` : ""}
    </div>
    ${hits.length ? `<div class="qc-chips">${chips}${more}</div>` : `<div class="qc-clean">36 维未发现规则层问题</div>`}
    ${origLine}
  </div>`;
}

// ---------- 全局 button 类型修正 ----------
// 动态生成的 <button> 默认 type="submit",在某些浏览器/情况下会触发默认提交行为,
// 导致页面跳转到 /api/... 显示 {"ok":true} 这种 JSON ("乱码代码")。
// 用 MutationObserver 监听所有新增 button,强制改为 type="button"。
(function fixButtonType() {
  const fix = (root) => {
    root.querySelectorAll("button:not([type])").forEach((b) => b.setAttribute("type", "button"));
    root.querySelectorAll('button[type="submit"]').forEach((b) => b.setAttribute("type", "button"));
  };
  fix(document);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          if (n.tagName === "BUTTON") n.setAttribute("type", "button");
          else if (n.querySelectorAll) fix(n);
        }
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();

// 极简 markdown 渲染 (无需外部依赖)
function renderMd(src) {
  if (!src) return "";
  // 裸 JSON 逐行检测: 任何一行是整段 {...}/[...] (无 ``` 围栏) → 折叠成可展开块, 避免满屏 &quot; 代码墙
  const isBareJsonLine = (ln) => {
    const t = ln.trim();
    if (!t) return false;
    const isObj = t.startsWith("{") && t.endsWith("}");
    const isArr = t.startsWith("[") && t.endsWith("]");
    if (!isObj && !isArr) return false;
    try { JSON.parse(t); return true; } catch { return false; }
  };
  const lines = String(src).split("\n");
  const hasJsonLine = lines.some(isBareJsonLine);
  if (hasJsonLine) {
    // 整体 esc 后, 把每个裸 JSON 行替换成折叠 details 块, 再走剩余 markdown 格式化
    let s = esc(src);
    for (const ln of lines) {
      if (!isBareJsonLine(ln)) continue;
      let pretty = "";
      try { pretty = JSON.stringify(JSON.parse(ln.trim()), null, 2); } catch { continue; }
      const escLn = esc(ln.trim());
      const detailBlock = `<details class="raw-json-fold"><summary>📄 原始数据 (JSON, 点击展开)</summary><pre class="raw-json-pre"><code>${esc(pretty)}</code></pre></details>`;
      s = s.replace(escLn, detailBlock);
    }
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.split(/\n{2,}/).map((b) => {
      if (/^<(h3|ul|ol|pre|blockquote|details)/.test(b.trim())) return b;
      if (/^\s*$/.test(b)) return "";
      return `<p>${b.replace(/\n/g, "<br>")}</p>`;
    }).join("\n");
    return s;
  }
  let s = esc(src);
  // 代码块
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.replace(/^\n/, "")}</code></pre>`);
  // 标题
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>")
       .replace(/^## (.*)$/gm, "<h3>$1</h3>")
       .replace(/^# (.*)$/gm, "<h3>$1</h3>");
  // 粗体/斜体/行内代码
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
       .replace(/`([^`]+)`/g, "<code>$1</code>");
  // 引用
  s = s.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");
  // 列表
  const mlines = s.split("\n");
  let out = [], inUl = false, inOl = false;
  for (const ln of mlines) {
    if (/^- /.test(ln)) {
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${ln.slice(2)}</li>`);
    } else if (/^\d+\. /.test(ln)) {
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${ln.replace(/^\d+\. /, "")}</li>`);
    } else {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
      out.push(ln);
    }
  }
  if (inUl) out.push("</ul>");
  if (inOl) out.push("</ol>");
  s = out.join("\n");
  // 段落 (连续两个换行)
  s = s.split(/\n{2,}/).map((b) => /^<(h3|ul|ol|pre|blockquote)/.test(b.trim()) ? b : `<p>${b.replace(/\n/g, "<br>")}</p>`).join("\n");
  return s;
}

// ---------- toast ----------
function toast(msg, type = "ok", ms = 3000) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  $("#toast-wrap").appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = ".3s";
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---------- 导出TXT ----------
function downloadTxt(text, label) {
  // 清理 markdown 格式, 保留纯文本
  let clean = text
    .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).trim())  // 代码块
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // 粗体
    .replace(/\*([^*]+)\*/g, "$1")  // 斜体
    .replace(/`([^`]+)`/g, "$1")  // 行内代码
    .replace(/^#{1,6} /gm, "")  // 标题
    .replace(/^> /gm, "")  // 引用
    .replace(/^[-*] /gm, "• ")  // 列表
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // 链接
    .trim();
  const blob = new Blob([clean], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  a.download = label ? `${label}_${ts}.txt` : `天衍_${ts}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("已导出 TXT", "ok");
}

// ---------- 配置/模型 ----------
async function loadConfig() {
  config = await api("/api/config");
  refreshModelChip();
  // 就绪提示
  if (!config.ready) {
    toast(`模型 ${config.default} 未配置 API Key,请设置环境变量或编辑 config.yaml`, "warn", 6000);
  }
  refreshStatus();
  // 启动心跳检测
  startHeartbeat();
  // Prefix Cache 命中率指示器
  if (!document.getElementById("cache-indicator")) {
    const ci = document.createElement("span");
    ci.id = "cache-indicator";
    ci.className = "cache-indicator";
    ci.style.display = "none";
    ci.title = "Prefix Cache 命中率";
    const conn = document.getElementById("conn-status");
    if (conn) conn.parentNode?.insertBefore(ci, conn);
  }
}

// 顶栏模型按钮已删除 — 模型快速切换走 Composer 内的 model-chip
// 顶栏齿轮按钮(id=settings-btn)只负责打开完整设置面板(密钥/参数/添加模型)

// 刷新 Composer 中的模型 chip 标签
function refreshModelChip() {
  const el = $("#model-chip-label");
  if (!el || !config) return;
  const m = config.default || "";
  // 显示模型名去掉 provider 前缀,太长截断
  let label = m.split("/").pop();
  if (label.length > 18) label = label.slice(0, 17) + "…";
  el.textContent = label;
  el.parentElement.parentElement.classList.toggle("warn", !config.ready);
}

// Composer 模型 chip 下拉:列出已配置模型 + 管理入口
$("#model-chip").addEventListener("click", async (e) => {
  e.stopPropagation();
  const wrap = $("#model-switch");
  const open = wrap.classList.toggle("open");
  if (!open) return;
  // 拉一次最新 settings(可能用户在 settings-panel 加过模型)
  let s;
  try { s = await api("/api/settings"); } catch { s = null; }
  const menu = $("#model-menu");
  const models = s?.models || (config ? [{ model: config.default, ready: config.ready, is_default: true }] : []);
  const cur = config?.default;
  menu.innerHTML = models.map((m) => {
    const isCur = m.model === cur;
    const shortName = m.model.split("/").pop();
    const provider = m.model.split("/")[0] || "";
    return `<button class="mm-item ${isCur ? "active" : ""}" data-model="${esc(m.model)}">
      <span class="mm-name">${esc(shortName)}</span>
      <span class="mm-prov">${esc(provider)}</span>
      <span class="mm-badge ${m.ready ? "ok" : "warn"}">${m.ready ? "✓" : "!"}</span>
      ${isCur ? '<span class="mm-check">●</span>' : ""}
    </button>`;
  }).join("") +
    `<button class="mm-manage" data-act="discovery" id="mm-discover">🔍 拉取服务端全量模型…</button>` +
    `<button class="mm-manage" data-act="manage">⚙ 管理全部模型…</button>`;
  // 绑定点击
  $$("#model-menu .mm-item").forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const m = b.dataset.model;
      if (m === cur) { wrap.classList.remove("open"); return; }
      try {
        await api("/api/config/model", { method: "PUT", body: JSON.stringify({ model: m }) });
        config.default = m;
        // 同步 ready 状态(从 settings 拿)
        if (s) {
          const found = s.models.find((x) => x.model === m);
          if (found) config.ready = found.ready;
        }
        refreshModelChip();
        refreshStatus();
        toast(`已切换到 ${m.split("/").pop()}`, "ok");
      } catch (e) {
        toast("切换失败: " + e.message, "err");
      }
      wrap.classList.remove("open");
    };
  });
  // 对话框下模型 chip 内联的"拉取服务端全量模型"切换器:
  // 点它 → 用当前默认模型所在 provider 的 base+key 调 /api/models/discover
  // → 拉回该厂商真实可用全部模型 → 内联列出, 点任一个即 添加+切换 (任何厂商都能切, 不再"配了拉不了")
  const discoveryBtn = document.getElementById("mm-discover");
  if (discoveryBtn) {
    discoveryBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const prov = (cur || "").split("/")[0];
      const q = prov ? `?provider=${encodeURIComponent(prov)}` : "";
      discoveryBtn.textContent = "拉取中…";
      let r;
      try { r = await api(`/api/models/discover${q}`); }
      catch (e) { r = { ok: false, error: e.message, count: 0, models: [] }; }
      // 在菜单尾部内联展开拉取到的模型
      let list = document.getElementById("mm-discovered-list");
      if (!list) {
        list = document.createElement("div");
        list.id = "mm-discovered-list";
        menu.appendChild(list);
      }
      if (r.ok && r.count > 0) {
        const configured = new Set((s?.models || []).map((x) => x.model));
        const provLabel = prov || "provider";
        list.innerHTML =
          `<div class="mm-subhead" style="padding:8px 10px 2px;color:var(--text-dim);font-size:11px">🔍 ${esc(provLabel)} 服务端 ${r.count} 个模型 ${r.source === "cache" ? "(缓存)" : ""} · 点选即添加并切换</div>` +
          r.models.map((id) => {
            const full = id.includes("/") ? id : `${provLabel}/${id}`;
            const isCfg = configured.has(full);
            const isCur = full === cur;
            return `<button class="mm-item ${isCur ? "active" : ""}" data-disc="${esc(full)}" style="opacity:${isCfg ? 0.85 : 1}">
              <span class="mm-name">${esc(id)}</span>
              <span class="mm-prov">${isCur ? "● 当前" : isCfg ? "✓ 已配" : "+ 拉取"}</span>
            </button>`;
          }).join("");
        $$("#mm-discovered-list [data-disc]").forEach((b) => {
          b.onclick = async (ee) => {
            ee.stopPropagation();
            const m = b.dataset.disc;
            try {
              // 未配置的模型先添加 (key 留空走该 provider 的环境变量/默认), 再切默认
              if (!configured.has(m)) {
                await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ model: m, api_key: "", api_base: "", temperature: 0.8, max_tokens: 4096 }) });
              }
              await api("/api/config/model", { method: "PUT", body: JSON.stringify({ model: m }) });
              config.default = m;
              config.ready = true;
              refreshModelChip();
              refreshStatus();
              toast(`已切换到 ${m.split("/").pop()}${configured.has(m) ? "" : " (自动添加)"}`, "ok");
              wrap.classList.remove("open");
            } catch (e) {
              toast("切换失败: " + e.message, "err");
            }
          };
        });
      } else {
        list.innerHTML = `<div class="mm-subhead" style="padding:8px 10px;color:var(--text-dim);font-size:11px">拉取失败: ${esc(r.error || "未知错误")} · base=${esc(r.base || "-")} · 需先给 ${esc(prov)} 配好 API Key (设置面板或环境变量)</div>`;
      }
      discoveryBtn.textContent = "🔍 拉取服务端全量模型…";
    };
  }
  $("#model-menu .mm-manage[data-act='manage']").onclick = (ev) => {
    ev.stopPropagation();
    wrap.classList.remove("open");
    $("#settings-btn").click();
  };
});
document.addEventListener("click", () => $("#model-switch")?.classList.remove("open"));

function refreshStatus() {
  const sb = $("#status-bar");
  if (!currentProject) {
    sb.innerHTML = config.ready ? "" : `<span class="pill warn">⚠ 未配置 Key</span>`;
    return;
  }
  const st = currentProject.stats || {};
  const parts = [
    `<span class="pill">${st.chapters || 0} 章</span>`,
    `<span class="pill"><b>${(st.total_chars || 0).toLocaleString()}</b> 字</span>`,
  ];
  if (!config.ready) parts.push(`<span class="pill warn">⚠ Key</span>`);
  sb.innerHTML = parts.join("");
}

// ---------- 项目 ----------
async function loadProjects() {
  const list = await api("/api/projects");
  const menu = $("#proj-menu");
  menu.innerHTML = `<button class="proj-opt" id="new-project-opt">+ 新建项目…</button>` +
    list.map((p) => `<div class="proj-opt-row" data-id="${p.id}">
        <button class="proj-opt" data-id="${p.id}"><span class="name">${esc(p.name)}</span><span class="meta">${esc(p.genre || "")}</span></button>
        <button class="proj-del" data-del="${p.id}" title="删除项目">✕</button>
      </div>`).join("");
  $$("#proj-menu .proj-opt").forEach((el) => {
    if (el.id === "new-project-opt") {
      el.onclick = () => $("#proj-modal").classList.add("show");
    } else {
      el.onclick = () => { selectProject(el.dataset.id); closeSidebar(); };
    }
  });
  // 删除项目
  $$("#proj-menu .proj-del").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const pidDel = el.dataset.del;
      const name = list.find((p) => p.id === pidDel)?.name || pidDel;
      if (!confirm(`确定删除项目「${name}」? 该项目下的章节/设定/消息将全部删除, 不可恢复!`)) return;
      try {
        await api(`/api/projects/${pidDel}`, { method: "DELETE" });
        if (localStorage.getItem("tianyan_last_project") === pidDel) {
          localStorage.removeItem("tianyan_last_project");
        }
        if (currentProject && currentProject.id === pidDel) {
          currentProject = null;
          $("#proj-info").textContent = "未选择项目";
          $("#proj-select-label").textContent = "选择项目 ▾";
          $("#tree").innerHTML = `<div class="tree-empty"><div class="tree-empty-icon">📂</div><p>选择或新建一个项目</p><p class="muted">章节、设定、素材将在此以文件树形式展示</p></div>`;
          $("#chat").innerHTML = "";
          showEmpty();
        }
        await loadProjects();
        toast(`已彻底删除项目「${name}」(含章节/设定/消息/记忆), 数据库已压缩`, "ok", 5000);
      } catch (e) {
        toast("删除失败: " + e.message, "err");
      }
    };
  });
  // 当前项目标签
  if (currentProject) {
    $("#proj-select-label").textContent = currentProject.name;
  } else if (list.length) {
    $("#proj-select-label").textContent = "选择项目 ▾";
  }
}

// 项目选择器下拉
$("#proj-select-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#proj-select-btn").parentElement.classList.toggle("open");
});
// 加号按钮: 直接打开新建项目弹窗
$("#proj-new-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#proj-select-btn").parentElement.classList.remove("open");
  $("#proj-modal").classList.add("show");
});
document.addEventListener("click", () => {
  $("#proj-select-btn")?.parentElement.classList.remove("open");
});

async function selectProject(pid) {
  const p = await api(`/api/projects/${pid}`);
  currentProject = p;
  localStorage.setItem("tianyan_last_project", pid);
  $("#proj-info").textContent = p.name + (p.audience ? ` · ${p.audience}` : "") + (p.genre ? ` · ${p.genre}` : "");
  $("#proj-select-label").textContent = p.name;
  // 拉取已上传素材
  let sources = [];
  try { sources = await api(`/api/projects/${pid}/sources`); } catch { sources = []; }
  currentProject.sources = sources;
  renderTree();
  loadProjects();
  await loadMessages(pid);
  refreshStatus();
}

// ---------- 文件树 ----------
const KIND_META = {
  character:  { label: "人物设定", icon: "👤" },
  world:      { label: "世界观", icon: "🌍" },
  outline:    { label: "大纲", icon: "📋" },
  style:      { label: "文风参考", icon: "🎨" },
  foreshadow: { label: "伏笔", icon: "🔗" },
  plot:       { label: "剧情节点", icon: "⚡" },
  location:   { label: "地点", icon: "📍" },
  timeline:   { label: "时间线", icon: "⏱" },
  milestone:  { label: "里程碑", icon: "🏁" },
};
const FILE_ICON = { chapter: "📄", source: "📚" };

/**
 * 会改变项目数据的工具 —— 执行完必须把项目拉回来重渲染, 否则用户看不到产出。
 *
 * 为什么是白名单而不是"每次 observation 都刷": 一轮里可能有十几个只读工具
 * (query_project / web_search / scan_bestseller…), 全刷会造成请求风暴。
 * 但白名单里漏一个, 表现就是"后端跑完了页面不动, 必须手动刷新" ——
 * 历史上就是因为名单里只有 4 个设定类工具, 写正文的 continue_writing 不在里面才出的问题。
 * 【新增写库工具时必须同步加到这里】
 */
const MUTATING_TOOLS = /^(continue_writing|ghostwrite|generate_outline|manage_outline|review_chapter|quality_check|challenge_review|resolve_challenge|add_element|manage_character|manage_world|manage_milestone|adjust_arc)$/;

// 防抖: 一轮里连跑好几个写库工具, 合并成一次请求 (400ms 内只发最后一次)
let _refreshTimer = null;
function scheduleProjectRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    refreshProjectData();
  }, 400);
}

/** 拉最新项目数据 → 重渲染文件树; 章节抽屉开着则连内容一起更新 */
async function refreshProjectData() {
  if (!currentProject) return;
  try {
    const p = await api(`/api/projects/${currentProject.id}`);
    if (!p || !currentProject) return;
    currentProject.chapters = p.chapters || [];
    currentProject.elements = p.elements || [];
    currentProject.meta = p.meta || currentProject.meta;
    renderTree();
    // 章节抽屉正开着 → 内容也要跟着更新, 否则抽屉里还是旧正文。
    // 但如果用户正在编辑 (编辑框可见), 绝不能覆盖, 会把人写到一半的内容冲掉。
    const drawer = $("#drawer");
    const editing = $("#drawer-edit-area") && !$("#drawer-edit-area").classList.contains("hidden");
    if (drawer && drawer.classList.contains("open") && drawerChapterId && !editing) {
      const ch = (p.chapters || []).find((c) => c.id === drawerChapterId);
      if (ch) {
        $("#drawer-title").textContent = ch.title;
        $("#drawer-body").innerHTML =
          `<h3>梗概</h3>${esc(ch.outline || "(无)")}` +
          `<h3>正文 (${(ch.content || "").length} 字)</h3>${esc(ch.content || "(尚未撰写)")}`;
        $("#drawer-edit-area").value = ch.content || "";
      }
    }
  } catch { /* 刷新失败不影响主流程 */ }
}

function renderTree() {
  const tree = $("#tree");
  if (!currentProject) {
    tree.innerHTML = `<div class="tree-empty"><div class="tree-empty-icon">📂</div>
      <p>选择或新建一个项目</p><p class="muted">章节、设定、素材将在此以文件树形式展示</p></div>`;
    return;
  }
  const p = currentProject;
  const chs = (p.chapters || []).slice().sort((a, b) => a.idx - b.idx);
  const elems = p.elements || [];
  const srcs = p.sources || [];

  // 按设定类型分组
  const byKind = {};
  for (const e of elems) {
    (byKind[e.kind] ||= []).push(e);
  }

  const parts = [];
  // 项目信息节点
  parts.push(`<div class="tree-file" data-act="info">
    <span class="ico">⚙️</span><span class="name">项目设置</span>
    <span class="meta">${p.audience ? p.audience + " · " : ""}${p.genre || ""}</span></div>`);

  // 章节文件夹
  parts.push(`<div class="tree-folder open" id="f-chapters">
    <div class="tree-folder-head" data-toggle="f-chapters">
      <span class="chev">▸</span><span class="ico">📁</span>
      <span class="name">章节</span><span class="cnt">${chs.length}</span>
    </div><div class="tree-folder-children">`);
  if (!chs.length) {
    parts.push(`<div class="tree-file" style="opacity:.5;cursor:default"><span class="ico">·</span><span class="name">(暂无章节,点对话让 Agent 生成)</span></div>`);
  }
  chs.forEach((c) => {
    const n = (c.content || "").length;
    // 状态徽章: draft=不显示 (简洁), generating=脉冲黄, written=绿✓, failed=红✗
    const st = c.status || "draft";
    let badge = "";
    if (st === "generating") badge = `<span class="ch-badge generating" title="生成中">●</span>`;
    else if (st === "written") badge = `<span class="ch-badge written" title="已写完">✓</span>`;
    else if (st === "failed") badge = `<span class="ch-badge failed" title="生成失败,可重试">✗</span>`;
    parts.push(`<div class="tree-file${st === "generating" ? " is-generating" : ""}${st === "failed" ? " is-failed" : ""}" data-chapter="${c.id}">
      <span class="ico">${FILE_ICON.chapter}</span>
      <span class="name">${String(c.idx + 1).padStart(2, "0")}. ${esc(c.title)}</span>
      ${badge}
      <span class="meta">${n ? n + "字" : "草稿"}</span></div>`);
  });
  parts.push(`</div></div>`);

  // 设定文件夹
  parts.push(`<div class="tree-folder open" id="f-elements">
    <div class="tree-folder-head" data-toggle="f-elements">
      <span class="chev">▸</span><span class="ico">📁</span>
      <span class="name">设定</span><span class="cnt">${elems.length}</span>
    </div><div class="tree-folder-children">`);
  if (!elems.length) {
    parts.push(`<div class="tree-file" style="opacity:.5;cursor:default"><span class="ico">·</span><span class="name">(暂无设定,点底部 + 设定 添加)</span></div>`);
  }
  for (const [kind, meta] of Object.entries(KIND_META)) {
    const list = byKind[kind] || [];
    if (!list.length) continue;
    parts.push(`<div class="tree-folder open" id="f-elem-${kind}">
      <div class="tree-folder-head" data-toggle="f-elem-${kind}">
        <span class="chev">▸</span><span class="ico">${meta.icon}</span>
        <span class="name">${meta.label}</span><span class="cnt">${list.length}</span>
      </div><div class="tree-folder-children">`);
    list.forEach((e) => {
      parts.push(`<div class="tree-file" data-element="${e.id}">
        <span class="ico">${meta.icon}</span>
        <span class="name">${esc(e.name)}</span>
        <button class="edel" data-del-elem="${e.id}" title="删除">✕</button></div>`);
    });
    parts.push(`</div></div>`);
  }
  // 未知 kind
  const others = elems.filter((e) => !KIND_META[e.kind]);
  if (others.length) {
    parts.push(`<div class="tree-folder open" id="f-elem-other">
      <div class="tree-folder-head" data-toggle="f-elem-other">
        <span class="chev">▸</span><span class="ico">📁</span>
        <span class="name">其他</span><span class="cnt">${others.length}</span>
      </div><div class="tree-folder-children">`);
    others.forEach((e) => {
      parts.push(`<div class="tree-file" data-element="${e.id}">
        <span class="ico">📄</span><span class="name">${esc(e.name)}</span>
        <button class="edel" data-del-elem="${e.id}" title="删除">✕</button></div>`);
    });
    parts.push(`</div></div>`);
  }
  parts.push(`</div></div>`);

  // 素材库文件夹
  parts.push(`<div class="tree-folder open" id="f-sources">
    <div class="tree-folder-head" data-toggle="f-sources">
      <span class="chev">▸</span><span class="ico">📁</span>
      <span class="name">素材库</span><span class="cnt">${srcs.length}</span>
    </div><div class="tree-folder-children">`);
  if (!srcs.length) {
    parts.push(`<div class="tree-file" style="opacity:.5;cursor:default"><span class="ico">·</span><span class="name">(点顶栏「上传」导入 txt/md/docx/pdf/epub)</span></div>`);
  }
  srcs.forEach((s) => {
    parts.push(`<div class="tree-file" data-source="${esc(s.source)}">
      <span class="ico">${FILE_ICON.source}</span>
      <span class="name">${esc(s.source)}</span>
      <span class="meta">${s.chunks}块</span></div>`);
  });
  parts.push(`</div></div>`);

  tree.innerHTML = parts.join("");

  // 绑定文件夹展开/收起
  tree.querySelectorAll(".tree-folder-head").forEach((h) => {
    h.addEventListener("click", (e) => {
      if (e.target.closest(".edel") || e.target.closest("button")) return;
      h.parentElement.classList.toggle("open");
    });
  });
  // 章节点击
  tree.querySelectorAll("[data-chapter]").forEach((el) => {
    el.addEventListener("click", () => openChapter(el.dataset.chapter));
  });
  // 设定点击 → 打开抽屉预览
  tree.querySelectorAll("[data-element]").forEach((el) => {
    el.addEventListener("click", () => openElement(el.dataset.element));
  });
  // 素材点击 → 预览片段
  tree.querySelectorAll("[data-source]").forEach((el) => {
    el.addEventListener("click", () => openSource(el.dataset.source));
  });
  // 设定删除
  tree.querySelectorAll("[data-del-elem]").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("删除该设定?")) return;
      await api(`/api/elements/${el.dataset.delElem}`, { method: "DELETE" });
      await selectProject(currentProject.id);
      toast("已删除设定", "ok");
    });
  });
}

// 打开设定预览
function openElement(eid) {
  const e = currentProject.elements.find((x) => x.id === eid);
  if (!e) return;
  const meta = KIND_META[e.kind] || { icon: "📄", label: "设定" };
  drawerChapterId = null;
  $("#drawer-title").textContent = `${meta.label} · ${e.name}`;
  $("#drawer-body").innerHTML =
    `<h3>${meta.icon} ${esc(e.name)}</h3><p class="muted">${esc(e.kind)}</p>` +
    `<h3>详情</h3>${esc(e.detail || "(无)")}`;
  $("#drawer-edit-area").classList.add("hidden");
  $("#drawer-body").classList.remove("hidden");
  $("#drawer-edit").classList.add("hidden");
  $("#drawer-save").classList.add("hidden");
  $("#drawer").classList.add("open");
}

// 打开素材预览(首块文本)
async function openSource(source) {
  drawerChapterId = null;
  $("#drawer-title").textContent = `素材 · ${source}`;
  $("#drawer-body").innerHTML = `<p class="muted">加载中…</p>`;
  $("#drawer").classList.add("open");
  $("#drawer-edit-area").classList.add("hidden");
  $("#drawer-body").classList.remove("hidden");
  // 复用 search 拿片段
  try {
    const r = await api(`/api/projects/${currentProject.id}/search?q=${encodeURIComponent(source.slice(0, 8))}`);
    const snips = (r.results || []).map((x) => esc(x.text)).join("\n\n---\n\n");
    $("#drawer-body").innerHTML = `<h3>📚 ${esc(source)}</h3>${snips || "<p class='muted'>(无内容)</p>"}`;
  } catch {
    $("#drawer-body").innerHTML = `<p class="err">读取失败</p>`;
  }
}

// 历史渲染双管线:
// - 新数据 (run_events 有 sse 事件): 按 run 瞬时重放, 与实时渲染共用 handleEvent 同一条管线, 零漂移
//   (思考/工具结果/36维质检结论/审核卡片全部还原 — 旧版刷新后只剩工具名空胶囊)
// - 旧数据 (升级前, 只有 messages 表): 走 legacyRenderMessages 消息分组渲染
async function loadMessages(pid) {
  const chat = $("#chat");
  chat.innerHTML = "";
  chatHistory = [];
  let msgs = [];
  try { msgs = await api(`/api/projects/${pid}/messages`); } catch { /* 网络异常按空处理 */ }
  try { localStorage.setItem("tianyan_chat_" + pid, JSON.stringify((msgs || []).slice(-300))); } catch {}
  let runs = [];
  try { runs = await api(`/api/projects/${pid}/runs`); } catch { /* 忽略 */ }
  const runsAsc = (Array.isArray(runs) ? runs : []).slice().reverse(); // 后端 DESC → 前端按时间 ASC
  // 拉每个 run 的 SSE 事件 (run_events 里 type="sse" 的行, output 即事件 JSON)
  const eventsPerRun = await Promise.all(runsAsc.map((r) =>
    api(`/api/projects/${pid}/runs/${r.id}/events`)
      .then((rows) => (Array.isArray(rows) ? rows : [])
        .map((row) => { try { return JSON.parse(row.output || "{}"); } catch { return null; } })
        .filter((e) => e && e.type && e.type !== "heartbeat"))
      .catch(() => [])
  ));
  const hasSse = eventsPerRun.some((l) => l.length > 0);
  if (!hasSse) {
    // 纯旧数据项目
    if (!msgs || msgs.length === 0) { showEmpty(); return; }
    legacyRenderMessages(msgs);
    scrollChat(true);
    return;
  }
  // 混合项目 (升级中途): 首个有事件的 run 之前的 messages 走旧管线
  const firstSseIdx = eventsPerRun.findIndex((l) => l.length > 0);
  const firstTs = Number(runsAsc[firstSseIdx].started_at) || 0;
  const legacyMsgs = (msgs || []).filter((m) => Number(m.created_at || 0) < firstTs - 1);
  if (legacyMsgs.length) legacyRenderMessages(legacyMsgs);
  // 逐 run 瞬时重放 (REPLAY_MODE: 打字机/toast/阶段确认按钮全部抑制)
  REPLAY_MODE = true;
  try {
    for (let i = 0; i < runsAsc.length; i++) {
      const evts = eventsPerRun[i];
      if (!evts.length) continue;
      const r = runsAsc[i];
      if (r.user_input) appendMessage("user", r.user_input, false);
      const assistant = appendMessage("assistant", "", true);
      for (const evt of evts) { try { handleEvent(evt, assistant); } catch { /* 单条事件损坏不阻塞整体 */ } }
      // 冲刷打字机残留 (回放时打字机不启动, 文本都在队列里)
      flushPendingThink(assistant);
      flushAnswerInstant(assistant);
      if (assistant.subBubbles) for (const k of Object.keys(assistant.subBubbles)) {
        flushPendingThink(assistant.subBubbles[k]);
        flushAnswerInstant(assistant.subBubbles[k]);
      }
      removeAllCarets();
    }
  } finally { REPLAY_MODE = false; }
  scrollChat(true);
}

// 旧数据渲染管线 (messages 表分组): 仅用于还没有 run_events 事件的升级前项目
function legacyRenderMessages(msgs) {
  // 智能分组: 将连续的思考/工具调用归入最近一个正文回答的思考面板
  let thinkItems = []; // 当前累积的思考/工具条目
  let lastSubAgent = null; // 最近一个 sub_agent_start 的 agent 名: 其后的 think 消息挂该子 agent 卡片, 不挂主 agent
  function flushThinkItems() {
    if (thinkItems.length === 0) return null;
    const panel = document.createElement("div");
    // 默认展开 (基态可见): 对话重进/流式时用户能看到思考过程; 点 toggle 才收
    panel.className = "sub-think-panel open";
    const body = document.createElement("div");
    body.className = "sub-think-body";
    for (const item of thinkItems) {
      const div = document.createElement("div");
      div.className = "st-entry " + (item.type === "think" ? "st-think" : "st-done");
      if (item.type === "tool") {
        div.innerHTML = '<span class="st-tool-tag"><span class="tool-icon">🔧</span>' + esc(item.text.replace(/^🔧\s*/, "")) + '<span class="st-tool-status">✓</span></span>';
      } else {
        div.innerHTML = '<span class="st-text">' + esc(item.text) + '</span>';
      }
      body.appendChild(div);
    }
    panel.appendChild(body);
    // 让同一条消息的 "思考过程" toggle 与面板收起/展开态同步 (默认展开, 点 toggle 收起)
    panel.addEventListener("click", () => {
      const msg = panel.closest(".msg");
      if (msg) {
        const t = msg.querySelector(".sub-think-toggle-inline");
        if (t) t.classList.toggle("expanded", !panel.classList.contains("collapsed"));
      }
    });
    thinkItems = [];
    return panel;
  }
  function renderMsgWithThink(content) {
    const ast = appendMessage("assistant", content, false);
    const thinkPanel = flushThinkItems();
    if (thinkPanel) {
      const bubble = ast.el.closest(".msg").querySelector(".bubble");
      ast.el.closest(".msg").insertBefore(thinkPanel, bubble);
    }
  }
  // 历史子 agent 卡片查找: 按 agent 名找最近创建的气泡 (loadMessages 渲染用)
  const histSubBubbles = {};
  function findSubBubbleByAgent(ag) {
    // 优先用最近一次 sub_agent_start 创建的
    if (histSubBubbles[ag]) return histSubBubbles[ag];
    // 兜底: DOM 里找 (data-agent)
    const el = document.querySelector(`#chat .sub-agent[data-agent="${ag}"]`);
    if (!el) return null;
    return { el, answerWrap: el.querySelector(".sub-answer-wrap"), thinkBody: el.closest(".sub-agent-wrapper")?.querySelector(".sub-think-body") };
  }
  for (const m of msgs) {
    if (m.role === "user") {
      // 用户发言: 若前面有悬空的思考/工具条目 (上一轮 agent 没出正文就结束),
      // 先把它们挂在 user 气泡【之前】, 否则 thinkItems 悬空, 末尾兜底会挂错位置
      if (thinkItems.length > 0) {
        const pendingPanel = flushThinkItems();
        if (pendingPanel) {
          const div = document.createElement("div");
          div.className = "msg assistant";
          div.innerHTML = `<div class="role assistant">✦ 天衍 <span class="sub-think-toggle-inline thinking-done" onclick="toggleOrchThink(this)"><span class="spinner-ring sm"></span><span class="spinner-text">思考过程</span> <span class="arrow"></span></span></div><div class="bubble"><div class="md answer-body">(该轮无正文回复)</div></div>`;
          $("#chat").appendChild(div);
          // 思考面板挂在【气泡外、气泡前】, 不塞进 .bubble 框里
          const bubbleEl = div.querySelector(".bubble");
          div.insertBefore(pendingPanel, bubbleEl);
        }
      }
      appendMessage("user", m.content, false);
      lastSubAgent = null; // 新一轮对话, 子 agent 归属重置
    } else if (m.role === "assistant") {
      const tn = m.tool_name || "";
      if (tn === "think") {
        // 思考内容: 若紧邻在某个 sub_agent_start 之后 (同 agent), 挂到该子 agent 卡片面板;
        // 否则累积到主 agent 分组
        if (lastSubAgent && m.tool_call_id === lastSubAgent) {
          const entry = findSubBubbleByAgent(lastSubAgent);
          if (entry && entry.thinkBody) {
            const div = document.createElement("div");
            div.className = "st-entry st-think";
            div.innerHTML = '<span class="st-text">' + esc(m.content || "") + '</span>';
            entry.thinkBody.appendChild(div);
            // 前端真映射④: 历史回放保持默认折叠
            lastSubAgent = null; // 已消费, 后续 think 不再默认挂该子 agent
            continue; // 症状2修复: think 挂子卡片后必须继续渲染后续消息 (sub_answer/正文), 不能跳出整个 for 循环
          }
        }
        thinkItems.push({ type: "think", text: m.content || "" });
      } else if (tn === "tool_calls") {
        let tools = [];
        try { tools = JSON.parse(m.content || "[]"); } catch(e) {}
        const names = tools.map(t => t.function?.name || "?").join(", ");
        thinkItems.push({ type: "tool", text: "🔧 " + names });
      } else if (tn === "sub_agent_start") {
        // 子 agent 委派卡片 (历史): 恢复专家气泡 + 折叠思考面板
        flushThinkItems();
        let meta = {}; try { meta = JSON.parse(m.content || "{}"); } catch(e) {}
        const ag = meta.agent || m.tool_call_id || "story-explorer";
        const fakeAssistant = { subBubbles: {} };
        const entry = createSubAgentBubble(fakeAssistant, ag, meta.task || "");
        if (entry) histSubBubbles[ag] = entry;
        lastSubAgent = ag; // 其后的 think 消息挂该子 agent 卡片
      } else if (tn === "sub_answer") {
        // 子 agent 结果 (历史): 填进对应专家气泡正文, 并把 "执行中…" 占位标成已完成
        flushThinkItems();
        lastSubAgent = null; // 子 agent 轮次结束, 后续 think 不再挂它
        const ag = m.tool_call_id || "story-explorer";
        let entry = findSubBubbleByAgent(ag);
        const text = (m.content || "").trim();
        // 兜底: 旧数据 DB 缺 sub_agent_start (快出路径历史 bug) → 卡片没建, 自动建一张再填结果
        if (!entry && text) {
          const fakeA = { subBubbles: {} };
          entry = createSubAgentBubble(fakeA, ag, "");
          if (entry) histSubBubbles[ag] = entry;
        }
        if (entry && text) {
          // 填结果前, 先给该子 agent 建好思考面板 (历史里 think 消息在 sub_answer 之前被 flushThinkItems 挂到主 agent,
          // 子 agent 卡片此刻还没有 .sub-think-body → 思考字段就丢了, 只剩工具/结果)。
          // 把这条 sub_answer 关联的 think 消息回填到该子 agent 卡片, 保证"思考+工具+结果"三件齐全。
          if (entry.thinkBody && !entry.thinkBody.querySelector(".st-entry")) {
            const subThink = Array.isArray(msgs)
              ? msgs.filter(x => x.role === "assistant" && x.tool_name === "think" && x.tool_call_id === ag)
              : [];
            subThink.forEach(x => addThinkItem(entry.thinkBody, x.content || ""));
          }
          entry.answerWrap.innerHTML = `<div class="sub-answer-body md">${renderMd(text)}</div>`;
          const statusEl = entry.el && entry.el.querySelector(".sub-process-status");
          if (statusEl) statusEl.textContent = "已完成";
          entry.el.classList.add("sub-done");
        }
      } else if (tn === "sub_agent_done") {
        // 子 agent 完成标记 (历史): 标完成态
        lastSubAgent = null; // 子 agent 轮次彻底结束
        const ag = m.tool_call_id || "story-explorer";
        const entry = findSubBubbleByAgent(ag);
        if (entry) {
          entry.el.classList.add("sub-done");
          const statusEl = entry.el.querySelector(".sub-process-status");
          if (statusEl && !statusEl.textContent) statusEl.textContent = "✓ 完成";
        }
      } else if (tn === "rate_limit_notice") {
        // 专家级限流提示: 前端【不显示】(用户明确不要) — 只把对应专家气泡标成已完成, 不留"执行中…"占位
        flushThinkItems();
        const rlAgent = m.tool_call_id || "";
        if (rlAgent) {
          const entry = findSubBubbleByAgent(rlAgent);
          if (entry && entry.el) {
            entry.el.classList.add("sub-done");
            const statusEl = entry.el.querySelector(".sub-process-status");
            if (statusEl && !statusEl.textContent) statusEl.textContent = "✓ 完成";
          }
        }
      } else {
        // 正文回答 (无论正文是否为空, 都渲染成 agent 气泡, 不丢消息)
        // 正文回答前, 先确保悬空的 thinkItems 挂上 — 否则"执行时能看, 执行完(刷新)没了"
        const text = (m.content || "").trim();
        if (text) {
          renderMsgWithThink(text);
        } else {
          // 空正文 (run 中途失败/纯工具轮): 仍渲染气泡占位, 把悬空思考面板挂上来
          if (thinkItems.length > 0) {
            // 症状2观感修复: 给气泡塞占位文案, 避免"只有思考面板、正文区空白"的错觉
            const ast = appendMessage("assistant", "（本轮无正文回复，见上方思考过程）", false);
            const thinkPanel = flushThinkItems();
            if (thinkPanel) {
              const bubble = ast.el.closest(".msg")?.querySelector(".bubble");
              if (bubble) ast.el.closest(".msg").insertBefore(thinkPanel, bubble);
            }
          } else {
            // 全空的 assistant 行: 跳过 (不渲染空气泡)
          }
        }
      }
    }
  }
  // 处理末尾悬空的思考内容 (本轮 agent 结束后没有正文, 也不再有 user 发言)
  if (thinkItems.length > 0) {
    const panel = flushThinkItems();
    if (panel) {
      const lastMsg = $("#chat").querySelector(".msg:last-child");
      if (lastMsg) {
        // 若最后一条是 user 消息: 不能把 agent 思考面板塞进 user 气泡 — 新建一个 agent 气泡承载
        if (lastMsg.classList.contains("user")) {
          const div = document.createElement("div");
          div.className = "msg assistant";
          div.innerHTML = `<div class="role assistant">✦ 天衍 <span class="sub-think-toggle-inline thinking-done" onclick="toggleOrchThink(this)"><span class="spinner-ring sm"></span><span class="spinner-text">思考过程</span> <span class="arrow"></span></span></div><div class="bubble"><div class="md answer-body">(该轮无正文回复)</div></div>`;
          $("#chat").appendChild(div);
          // 面板挂气泡外、气泡前
          const bubbleEl = div.querySelector(".bubble");
          div.insertBefore(panel, bubbleEl);
        } else {
          lastMsg.insertBefore(panel, lastMsg.querySelector(".bubble"));
        }
      }
    }
  }
  scrollChat();
}

function showEmpty() {
  $("#chat").innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty";
  div.id = "empty-state";
  div.innerHTML = `<div class="empty-icon">✦</div><h2>天衍</h2>
    <p>类似 Codex 的协作式小说写作助手。它会自主规划并调用工具完成创作。</p>`;
  $("#chat").appendChild(div);
  rebuildSuggestions();
}

function rebuildSuggestions() {
  const suggs = [
    "查看当前项目状态与进度",
    "继续续写最近一章,2000字",
    "对最近一章做质量检查",
  ];
  const wrap = document.createElement("div");
  wrap.className = "suggestions";
  suggs.forEach((t) => {
    const b = document.createElement("button");
    b.className = "sugg";
    b.textContent = t;
    b.onclick = () => send(t);
    wrap.appendChild(b);
  });
  const es = $("#empty-state");
  if (es) es.appendChild(wrap);
}

// ---------- 对话 ----------
function appendMessage(role, content, streaming) {
  // debug: console.log("[DEBUG] appendMessage:", role, (content||"").slice(0,50));
  const es = $("#empty-state");
  if (es) es.remove();
  const msg = { role, content: content || "", steps: [], streaming };
  chatHistory.push(msg);
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const roleLabel = role === "user" ? "你" : '✦ 天衍 <span class="sub-think-toggle-inline thinking-done" onclick="toggleOrchThink(this)"><span class="spinner-ring sm"></span><span class="spinner-text">思考过程</span> · 执行 <span class="arrow"></span></span>';
  div.innerHTML = `<div class="role ${role}">${roleLabel}</div>
    <div class="bubble"></div>`;
  $("#chat").appendChild(div);
  msg.el = div.querySelector(".bubble");
  if (content) {
    if (role === "assistant") msg.el.innerHTML = `<div class="md">${renderMd(content)}</div>`;
    else msg.el.textContent = content;
  }
  scrollChat(true);
  return msg;
}

// 限流/系统级提示检测: 内容属于"接口被限流"类的系统通知, 不是某个专家的对话正文。
// 限流是系统层的事 (接口临时受限), 不该挂在某个专家卡片上 — 渲染成全局系统提示条。
function isSystemNotice(text) {
  const t = String(text || "");
  // 429 限流 / 配额 兜底文案特征 (后端 runner.ts 429 熔断 + rate_limit observation)
  // 收紧: 必须同时命中 LLM/API 语境且是短文本 —— 防止专家正文里写"API 接口"被误吞
  if (t.length > 400) return false;
  return /(429|限流|配额|quota|too many requests)/i.test(t) && /(LLM|API|接口)/i.test(t) && /⚠|LLM|API/.test(t);
}
// 记录当前轮刚发过限流提示条的 agent (answer_end 收尾时用它判断"没有专家打字机要收"), 轮次开始清
const _rateNoticeAgents = new Set();

// 追加一条系统级提示条 (黄色警告), 与历史重建的 rate_limit_notice 渲染一致 (.msg.system)
function appendSystemNotice(content) {
  const es = $("#empty-state");
  if (es) es.remove();
  const rlDiv = document.createElement("div");
  rlDiv.className = "msg system";
  rlDiv.innerHTML = '<div class="role system">⚡ 系统提示</div><div class="bubble rate-limit-notice md">' + esc(content || "") + '</div>';
  $("#chat").appendChild(rlDiv);
  scrollChat();
}

// 滚动跟随策略 (2026-10-18 修): 以前每次调用时算一次 gap, 思考面板/子agent卡片
// 一次能长好几百 px → gap 瞬间超阈值 → 视图永远停在老位置, 新内容来了不跟底,
// 用户只能手动从最顶端往下翻着找。正确做法: 持续跟踪"用户是否主动上翻"这个状态 —
// 没上翻就永远跟底 (新内容从底端顶上来, 旧内容往上走); 上翻阅读时才不打扰,
// 用户滚回底部后自动恢复跟随。
let userPinnedUp = false;
function scrollChat(force) {
  const c = $("#chat");
  if (!c) return;
  if (force) userPinnedUp = false; // 新消息/新气泡: 强制跟底并解除上翻状态
  if (!userPinnedUp) c.scrollTop = c.scrollHeight;
}
// 跟踪用户滚动: 离底超过 160px 才算"主动上翻阅读"; 回到底部自动恢复跟随
(() => {
  const c = $("#chat");
  if (!c) return;
  c.addEventListener("scroll", () => {
    const gap = c.scrollHeight - c.scrollTop - c.clientHeight;
    userPinnedUp = gap > 160;
  }, { passive: true });
})();

// ===== 回放模式: 断线重放/历史重建时, 打字机瞬时完成, 且抑制 toast/阶段确认按钮等实时交互 =====
let REPLAY_MODE = false;
// 冲刷思考打字机残留: 补满文本 + 执行挂起的收尾回调 (think_end 延迟到播完才执行的机制, 回放/跨轮时直接结算)
function flushPendingThink(target) {
  if (!target) return;
  if (target.curThinkText && target.thinkQueue && target.curThinkText.textContent.length < target.thinkQueue.length) {
    target.curThinkText.textContent = target.thinkQueue;
  }
  target._thinkAnim = false;
  const fn = target._thinkEnd;
  target._thinkEnd = null;
  if (typeof fn === "function") fn();
}
// 冲刷回答打字机残留: 一次性渲染全部队列文本
function flushAnswerInstant(target) {
  if (!target) return;
  // 回放/断线重放: 正文一次性落盘时同样自动折叠思考面板
  if (target.answerQueue && target.answerQueue.length > 0) autoCollapseThink(target);
  const q = target.answerQueue || "";
  target.answerShown = q.length;
  if (q) {
    if (target.answerEl) target.answerEl.innerHTML = renderMd(q);
    else if (target.answerWrap) target.answerWrap.innerHTML = '<div class="sub-answer-body md">' + renderMd(q) + '</div>';
  }
  target._ansAnim = false;
  const fn = target._ansEnd;
  target._ansEnd = null;
  if (typeof fn === "function") fn();
}
// 断线重放前清场: 移除当轮 assistant 气泡及其后所有本轮渲染 (专家气泡/系统提示), 返回全新 assistant 对象
function resetRunRendering(assistant) {
  const msg = assistant && assistant.el ? assistant.el.closest(".msg") : null;
  if (msg) {
    let node = msg;
    while (node) { const nx = node.nextElementSibling; node.remove(); node = nx; }
  }
  return appendMessage("assistant", "", true);
}

// 群聊式: 总编气泡封口后, 下次总编发言需开新气泡
// 通过重置 assistant 的 DOM 引用到新 bubble 元素实现 (subBubbles 保留)
function rotateOrchestratorBubble(assistant) {
  if (!assistant.closed) return;
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="role assistant">✦ 天衍 <span class="sub-think-toggle-inline thinking-done" onclick="toggleOrchThink(this)"><span class="spinner-ring sm"></span><span class="spinner-text">思考过程</span><span class="arrow"></span></span></div><div class="bubble"></div>`;
  $("#chat").appendChild(div);
  // 重置 DOM 引用, 保留 steps(左面板索引) 和 subBubbles(专家气泡引用)
  assistant.el = div.querySelector(".bubble");
  assistant.chainEl = null;
  assistant.answerEl = null;
  assistant.rawBuf = "";
  assistant.answerQueue = "";
  assistant.answerShown = 0;
  assistant._ansAnim = false;
  assistant._ansEnd = null;
  // 重置思考面板引用, 新气泡惰性重建 (ensureOrchestratorThinkPanel)
  assistant.thinkPanel = null;
  assistant.thinkBody = null;
  // 旧气泡的流式思考条目引用一并清空 (否则 think_end 收尾会误操作旧 DOM)
  assistant.curThinkEntry = null;
  assistant.curThinkText = null;
  assistant.thinkQueue = "";
  assistant._thinkAnim = false;
  assistant._thinkEnd = null;
  if (assistant.toolQueues) assistant.toolQueues.orchestrator = [];
  assistant.closed = false;
  scrollChat();
}

// 兜底清理: 移除所有气泡内残留的闪烁光标 (避免取错 bubble 导致光标残留在页面上)
function removeAllCarets() {
  $$(".msg.assistant .caret").forEach((c) => c.remove());
}

function cacheChatMessages(pid) {
  try {
    const msgs = [];
    $$("#chat .msg").forEach((el) => {
      const role = el.classList.contains("user") ? "user" : "assistant";
      const content = el.querySelector(".answer-body")?.textContent || el.querySelector(".bubble")?.textContent || "";
      if (content.trim()) msgs.push({ role, content: content.trim() });
    });
    localStorage.setItem("tianyan_chat_" + pid, JSON.stringify(msgs.slice(-300)));
  } catch {}
}

// ===================== 发送/停止二合一按钮 + 任务取消 =====================
// 用户拍板「暂停跟发送合在一起」:
//   空闲 = 纸飞机(发送); 任务跑着且输入框为空 = 方块(停止, 真停后端 run);
//   输入框里有字 = 仍是发送(发送时会先静默停掉上一个 run)。
// 后端取消是协作式的 (runner 在轮间/流式 chunk 间检查 isRunCancelled), 所以点了之后
// 最快当轮结束就停, 最坏等当前这一次 LLM 调用返回 (不会硬杀 HTTP, 避免半截写库)。
let chatActive = false;       // 是否有 /chat 正在跑
let activeChatAbort = null;   // 当前 /chat 请求的 AbortController (兜底硬断)
let chatStreamDone = false;   // 当前流是否已收到 done/fatal error
let userStopped = false;      // 本次结束是否由用户点停止触发
let chatSeq = 0;              // 任务序号: 防止"上一个任务"的收尾把新任务的按钮状态改掉

/** 任务状态 / 输入框内容一变就调它: 决定按钮显示"发送"还是"停止" */
function updateComposerBtn() {
  const btn = $("#send-btn");
  if (!btn) return;
  const plane = $("#send-icon-plane"), stop = $("#send-icon-stop");
  // 任务跑着 且 输入框是空的 → 按钮是"停止"; 其余情况都是"发送"
  const showStop = chatActive && !($("#input") && $("#input").value.trim());
  btn.classList.toggle("stopping", showStop);
  btn.title = showStop ? "停止当前任务" : "发送";
  if (plane) plane.classList.toggle("hidden", showStop);
  if (stop) stop.classList.toggle("hidden", !showStop);
}
/** 只有"当前最新那个任务"才有权收尾 (改按钮/abort 状态) */
function isCurrentChat(seq) {
  return seq === chatSeq;
}

/** 等 runId 到位: 刚 POST 完后端还没 createRun, 此时点停止拿不到 id */
async function awaitRunId(maxWait = 5000) {
  const t0 = Date.now();
  while (!window.__currentRunId && Date.now() - t0 < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return window.__currentRunId;
}

/**
 * 取消当前 run。silent=true 时不弹提示 (用于"发新消息前自动停掉上一个任务")。
 * @returns {Promise<boolean>} 是否真的发出了取消请求
 */
async function stopActiveRun(silent = false) {
  const runId = window.__currentRunId || (await awaitRunId(1500));
  if (!runId) return false;
  try {
    const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
    const j = await res.json().catch(() => null);
    if (!silent) {
      if (j && j.alreadyFinished) toast(`任务已结束 (${j.status || "done"})`, "ok");
      else toast("已请求停止, 当前步骤结束后立即停下", "ok");
    }
    return !!(j && j.cancelled);
  } catch (e) {
    if (!silent) toast("停止失败: " + (e && e.message || e), "warn");
    return false;
  }
}

/** 停止态点击: 后端取消 + 8s 兜底硬断前端连接 */
async function onStopBtnClick() {
  if (!chatActive) { updateComposerBtn(); return; }
  userStopped = true;
  const ok = await stopActiveRun(false);
  // 后端协作式取消一般几秒内发 done 收尾; 万一卡住 (LLM 长连接没返回), 前端 8s 后硬断,
  // 此时后端已标记 cancelled, 不会再继续烧 token。
  setTimeout(() => {
    if (!chatStreamDone && activeChatAbort) {
      try { activeChatAbort.abort(); } catch {}
    }
  }, 8000);
  return ok;
}

async function send(text) {
  if (!currentProject) {
    toast("请先创建或选择一个项目", "warn");
    return;
  }
  if (!config.ready) {
    toast("模型未配置 Key,可在顶栏切换已配置的模型", "warn", 5000);
  }
  text = text || $("#input").value.trim();
  if (!text) return;
  // 发送时还在录音 → 停掉, 不然识别结果会继续追加到已清空的输入框, 用户困惑
  if (typeof voiceActive !== "undefined" && voiceActive) stopVoice(false);

  // 上一条还在跑 → 先停掉它。否则两个 run 同时写同一个项目,
  // 章节正文 / 大纲会被后跑完的那个覆盖, 且两份 token 一起烧。
  if (chatActive) {
    await stopActiveRun(true);
    toast("已停止上一个任务, 开始处理新指令", "ok", 2500);
  }

  $("#input").value = "";
  autoGrow();
  appendMessage("user", text);

  // 左侧：隐藏文件树，显示思考面板
  showThinkPanel();

  const assistant = appendMessage("assistant", "", true);
  let streamCompleted = false;

  // 新任务开始: 重置 runId (避免残留上一个 run 的 id 让「停止」点错对象), 按钮切成停止态
  const mySeq = ++chatSeq;
  window.__currentRunId = null;
  chatActive = true;
  chatStreamDone = false;
  userStopped = false;
  updateComposerBtn();

  async function attemptFetch() {
    activeChatAbort = new AbortController();
    const res = await fetch(`/api/projects/${currentProject.id}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({ input: text, agent: "orchestrator" }),
      // keepalive 让长连接更稳定 (沙箱预览环境下减少被中断概率)
      keepalive: true,
      // 兜底: 后端取消 8s 没响应时前端硬断 (见 onStopBtnClick)
      signal: activeChatAbort.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // heartbeat 超时检测: 后端每 5s 发一次心跳, 设 20s 兜底 (4 倍冗余)
    let lastDataTs = Date.now();
    const HB_TIMEOUT = 20000;

    while (true) {
      // 竞速: reader.read() vs heartbeat 超时
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("hb_timeout")), HB_TIMEOUT)
      );
      let result;
      try {
        result = await Promise.race([readPromise, timeoutPromise]);
      } catch (e) {
        if (e.message === "hb_timeout") {
          reportClientLog("error", "SSE 心跳超时 (20s 无事件), 主动断开", { runId: window.__currentRunId || null });
          reader.cancel().catch(() => {});
          throw new Error("heartbeat_timeout");
        }
        reportClientLog("error", "SSE reader.read 异常: " + (e && e.message || e), { runId: window.__currentRunId || null });
        throw e;
      }
      const { done, value } = result;
      if (done) break;
      lastDataTs = Date.now();
      buf += decoder.decode(value, { stream: true });
      // SSE 事件以 \n\n 分隔, 兼容单 \n 的后端格式
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        let evt;
        try { evt = JSON.parse(trimmed.slice(6)); } catch { continue; }
        handleEvent(evt, assistant);
        // done 事件: 正常完成
        if (evt.type === "done") { streamCompleted = true; chatStreamDone = true; }
        // 致命 error (fatal 未标或 fatal=true): 标记完成, 后续断连不报错
        // 非致命 error (fatal=false): 后端会继续发数据, 不标记完成, 不断连
        if (evt.type === "error" && evt.fatal !== false) { streamCompleted = true; chatStreamDone = true; }
        // 后端被取消后也会发 done(status=cancelled), 那时按钮切回发送态
        if (isCurrentChat(mySeq) && (evt.type === "done" || (evt.type === "error" && evt.fatal !== false))) updateComposerBtn();
      }
    }
  }

  try {
    await attemptFetch();
    // 清除 loading
    removeThinkLoading();
  } catch (e) {
    removeThinkLoading();
    // 群聊式: 若已收到 done/error 事件, 说明后端正常完成, 只是连接关闭, 不报错
    if (streamCompleted) {
      hideThinkPanel();
      return;
    }
    // 用户点了停止 → 别走重连逻辑 (那会把已取消的 run 又等回来), 直接收尾
    if (userStopped) {
      const tipS = document.createElement("div");
      tipS.className = "stream-tip";
      tipS.textContent = "（已按你的要求停止）";
      assistant.el.appendChild(tipS);
      removeThinkingSpinner(assistant);
      hideThinkPanel();
      return;
    }
    // ===== 断线处理铁律: 绝不重发 POST /chat =====
    // 旧版重连 = 重新 POST → 后端 createRun 重跑整个任务 (重扫榜/重写章节/重复烧 token),
    // 且旧 run 在后台并没停 → 两个 run 同时写库。正确姿势: 轮询 resume 等后台跑完, 清场后瞬时重放。
    //
    // 【2026-10-17 修复】不再有 RETRYABLE 白名单: 用户主诉"断线后内容不更新, 必须刷新网页"。
    // 旧代码只认 fetch/network/timeout 这几种错误才恢复, 其余 (terminated / aborted / HTTP xxx…)
    // 直接显示"连接已断开, 上方内容已保留"就**永远不再拉了** —— 后台明明还在跑, 前端却装死。
    // 正确做法: 不管断线原因是什么, 只要拿到了 runId 就轮询 resume 把后台结果拉回来;
    // 只有连 runId 都没有 (POST 阶段就挂了) 才真的没法恢复。
    const runId = await awaitRunId();
    if (!runId) {
      const tip0 = document.createElement("div");
      tip0.className = "stream-tip";
      tip0.textContent = "（连接失败，本条消息未送达，请重新发送）";
      assistant.el.appendChild(tip0);
      removeThinkingSpinner(assistant);
      hideThinkPanel();
      return;
    }
    setThinkingSpinner(assistant, "连接中断 · 正在恢复…");
    // 渐进式轮询: 前 10 次每 3s (断线瞬间就要尽快拉回, 用户盯着屏幕等),
    // 之后 15s 一次, 最长约 10 分钟 (长章节写作足够)
    const MAX_POLLS = 40;
    let waitedMs = 0;
    let replayed = false;
    let cancelledByBackend = false;
    for (let i = 1; i <= MAX_POLLS && !replayed; i++) {
      const interval = i <= 10 ? 3000 : 15000;
      await new Promise(r => setTimeout(r, interval));
      waitedMs += interval;
      let resumeResp;
      try {
        resumeResp = await fetch(`/api/projects/${currentProject.id}/runs/${runId}/resume`);
      } catch { continue; } // 网络还没恢复, 下一轮再试
      const ct = resumeResp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const st = await resumeResp.json().catch(() => null);
        if (st && st.status === "running") {
          setThinkingSpinner(assistant, `连接中断 · 后台仍在执行 (已等待 ${Math.round(waitedMs / 1000)}s)…`);
          continue;
        }
        if (st && st.status === "cancelled") { cancelledByBackend = true; }
        break; // 404 / cancelled / 其它异常: 放弃
      }
      // SSE 回放: run 已结束 → 清场 → 瞬时重放全量事件
      removeThinkingSpinner(assistant);
      const fresh = resetRunRendering(assistant);
      REPLAY_MODE = true;
      try {
        const replayText = await resumeResp.text();
        for (const line of replayText.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try { handleEvent(JSON.parse(line.slice(6)), fresh); } catch {}
        }
        flushPendingThink(fresh);
        flushAnswerInstant(fresh);
        if (fresh.subBubbles) for (const k of Object.keys(fresh.subBubbles)) flushPendingThink(fresh.subBubbles[k]);
        removeAllCarets();
      } finally { REPLAY_MODE = false; }
      streamCompleted = true;
      replayed = true;
      toast("连接已恢复, 后台结果已同步", "ok", 2500);
      // 断线期间工具写入的数据 (章节/大纲/设定) 也要立刻刷新, 不然还是得手动 F5
      scheduleProjectRefresh();
    }
    removeThinkingSpinner(assistant);
    if (cancelledByBackend) {
      const tipC = document.createElement("div");
      tipC.className = "stream-tip";
      tipC.textContent = "（任务已被停止）";
      assistant.el.appendChild(tipC);
    } else if (!replayed) {
      // 等待超时: 不重复执行, 告知用户后台还在跑, 刷新即可看到结果
      const finalTip = document.createElement("div");
      finalTip.className = "stream-tip";
      finalTip.textContent = "（连接中断，任务仍在后台执行，稍后会自动同步，或重新打开本项目查看）";
      assistant.el.appendChild(finalTip);
      // 就算超时也把目前已经落库的内容刷出来 (写了一半的章节也能看到)
      scheduleProjectRefresh();
    }
    hideThinkPanel();
  } finally {
    // 无论正常完成 / 报错 / 用户停止, 按钮都必须切回发送态。
    // 用序号守卫: 用户可能已经发了新任务, 那时旧任务的收尾不许动新任务的状态。
    if (isCurrentChat(mySeq)) {
      chatActive = false;
      activeChatAbort = null;
      chatStreamDone = true;
      updateComposerBtn();
    }
  }
}

// ===== 思考 spinner: 正在思考时显示转圈, 思考完成后变 "思考过程" =====
function setThinkingSpinner(assistant, label) {
  // toggle 在 .role 行 (bubble 外面), 必须从 .msg 容器找 —— 旧版在 bubble 里找永远是 null, 隐藏/恢复逻辑全失效
  const msg = assistant.el?.closest(".msg");
  if (!msg) return;
  let spin = msg.querySelector(".think-spinner");
  if (!spin) {
    spin = document.createElement("span");
    spin.className = "think-spinner";
    spin.innerHTML = `<span class="spinner-ring"></span><span class="spinner-text"></span>`;
    const role = msg.querySelector(".role");
    if (role) role.appendChild(spin); else msg.appendChild(spin);
  }
  spin.querySelector(".spinner-text").textContent = label || "正在思考";
  // 把 "思考过程" toggle 隐藏 (避免和 spinner 同时出现), 记下来恢复用
  const tog = msg.querySelector(".sub-think-toggle-inline");
  if (tog && !spin._hideToggle) { tog.style.display = "none"; spin._hideToggle = tog; }
}
// ===== 主 agent (天衍) 思考态: 思考中显示 spinner+"思考中", 完成后变 "思考过程" =====
function setMainThinkingState(assistant, active) {
  const msg = assistant.el?.closest(".msg");
  if (!msg) return;
  const toggle = msg.querySelector(".sub-think-toggle-inline");
  if (!toggle) return;
  let ring = toggle.querySelector(".spinner-ring");
  let txt = toggle.querySelector(".spinner-text");
  if (!ring) {
    ring = document.createElement("span");
    ring.className = "spinner-ring sm";
    toggle.insertBefore(ring, toggle.firstChild);
  }
  if (!txt) {
    txt = document.createElement("span");
    txt.className = "spinner-text";
    const arr = toggle.querySelector(".arrow");
    toggle.insertBefore(txt, arr || null);
  }
  ring.style.cssText = "";
  txt.style.cssText = "";
  toggle.classList.remove("thinking-active", "thinking-done");
  if (active) {
    toggle.classList.add("thinking-active");
    txt.textContent = "思考中";
  } else {
    toggle.classList.add("thinking-done");
    txt.textContent = "思考过程";
  }
}

// ===== 子 agent 思考态: 执行中 spinner+"执行中", 完成后变 "执行过程" (点击可展开步骤) =====
function setSubThinkingState(entry, active) {
  const wrap = entry?.el?.closest(".sub-agent-wrapper");
  if (!wrap) return;
  const toggle = wrap.querySelector(".sub-think-toggle");
  if (!toggle) return;
  let ring = toggle.querySelector(".spinner-ring");
  let txt = toggle.querySelector(".spinner-text");
  if (!ring) {
    ring = document.createElement("span");
    ring.className = "spinner-ring sm";
    toggle.insertBefore(ring, toggle.querySelector(".arrow") || null);
  }
  if (!txt) {
    txt = document.createElement("span");
    txt.className = "spinner-text";
    toggle.insertBefore(txt, toggle.querySelector(".arrow") || null);
  }
  ring.style.cssText = "";
  txt.style.cssText = "";
  toggle.classList.remove("thinking-active", "thinking-done");
  if (active) {
    // 思考中 → "架构师 〈执行中 ●转圈〉"
    toggle.classList.add("thinking-active");
    txt.textContent = "执行中";
  } else {
    // 思考完成 → "架构师 〈思考过程〉"
    toggle.classList.add("thinking-done");
    txt.textContent = "思考过程";
  }
}

function removeThinkingSpinner(assistant) {
  const msg = assistant.el?.closest(".msg");
  const spin = msg ? msg.querySelector(".think-spinner") : null;
  if (spin) {
    // 恢复 "思考过程" toggle
    if (spin._hideToggle) spin._hideToggle.style.display = "";
    spin.remove();
  }
}

// ============ 思考链展示 (严格对齐 tianyan-preview.html 范式) ============
// 规则1: 禁止全局日志框 —— 以下函数保留为 no-op, 兼容旧调用点, 不再向任何全局容器写入
function showThinkPanel() { /* no-op: 不再隐藏文件树 / 不再显示全局思考面板 */ }
function hideThinkPanel() { /* no-op */ }
function removeThinkLoading() { /* no-op */ }
function appendThink() { /* no-op: 全局日志已废除, 思考只挂在归属气泡内 */ }

// 规则3: 双层折叠 toggle —— 点击 "思考过程 ▼" 滑出/收起当前气泡的思考面板
// 默认展开态: 点击切 .collapsed (与 toggleOrchThink 一致, 不再用 .open)
function toggleSubThink(btn) {
  // 幂等加 thinking-done, 让 CSS 显隐 spinner 正常
  btn.classList.add("thinking-done");
  let panel = btn.nextElementSibling;
  if (panel && panel.classList.contains("sub-think-panel")) {
    panel.classList.toggle("collapsed");
    btn.classList.toggle("expanded", !panel.classList.contains("collapsed"));
    if (!panel.classList.contains("collapsed")) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}
// ===== 思考过程自动折叠 (2026-10-18, 用户要求) =====
// 以前思考面板**默认展开且永不自动收起**: 正文都开始往外流了, 思考过程还敞着一大坨,
// 把正文顶得看不见。规则: 正文开始输出 (打字机第一帧 / 回放冲刷) → 该气泡的思考面板自动收起,
// 只留"思考过程 ▸"小条, 想看再点开。每个 target 只自动收一次 (用户手动展开过的不反复收)。
function autoCollapseThink(target) {
  if (!target || target._thinkAutoCollapsed) return;
  target._thinkAutoCollapsed = true;
  let panel = target.thinkPanel || null;
  if (!panel && target.el) {
    const wrap = target.el.closest(".sub-agent-wrapper") || target.el.closest(".msg");
    if (wrap) panel = wrap.querySelector(".sub-think-panel");
  }
  if (!panel || panel.classList.contains("collapsed")) return;
  panel.classList.add("collapsed");
  // 同步 toggle 箭头方向 (expanded → 收起)
  const container = panel.parentElement;
  const toggle = container && container.querySelector(".sub-think-toggle, .sub-think-toggle-inline");
  if (toggle) toggle.classList.remove("expanded");
}

// 统一思考打字机: 边收边播, 自然节奏 (基础1字/26ms + 标点停顿, 约35字/秒)
function startThinkTypewriter(target) {
  const el = target.curThinkText;
  if (!el) return;
  // 回放模式不逐字播 (由 think_end/done 处的 flushPendingThink 一次性渲染), 否则长历史要播几分钟
  if (REPLAY_MODE) return;
  if (target._thinkAnim) return;
  target._thinkAnim = true;
  el.classList.add("streaming");
  const TICK = 26;        // 基础间隔: 每字26ms (比真人打字稍快)
  const PAUSE_PUNCT = 140; // 中文标点后的自然停顿
  const PAUSE_NL = 260;    // 换行后的停顿
  function tick() {
    const q = target.thinkQueue || "";
    if (el.textContent.length < q.length) {
      const next = el.textContent.length + 1;
      el.textContent = q.substring(0, next);
      scrollChat();
      const ch = q[next - 1];
      let pause = 0;
      if (ch === "\n") pause = PAUSE_NL;
      else if (/[，。！？、；：,.!?;:]/.test(ch)) pause = PAUSE_PUNCT;
      setTimeout(tick, TICK + pause);
    } else {
      target._thinkAnim = false;
      el.classList.remove("streaming");
      if (typeof target._thinkEnd === "function") {
        const fn = target._thinkEnd;
        target._thinkEnd = null;
        fn();
      }
    }
  }
  tick();
}
window.startThinkTypewriter = startThinkTypewriter;

// 回答正文打字机: 气泡内容也逐字打出 (边收边播, 与思考同节奏但略快)
function startAnswerTypewriter(target) {
  // 正文开始往外流 → 思考过程自动折叠 (用户: "思考过程不会自动折叠")
  autoCollapseThink(target);
  // 回放模式不逐字播 (answer_end/done 处 flushAnswerInstant 一次性渲染)
  if (REPLAY_MODE) return;
  if (target._ansAnim) return;
  target._ansAnim = true;
  const TICK = 22;          // 每步间隔 (ms)
  const PER_STEP = 2;       // 每步字数, 约45字/秒
  const PAUSE_PUNCT = 120;  // 句末停顿
  const PAUSE_NL = 240;     // 换行停顿
  function renderNow() {
    const shown = (target.answerQueue || "").substring(0, target.answerShown || 0);
    if (target.answerEl) target.answerEl.innerHTML = renderMd(shown);
    else if (target.answerWrap) target.answerWrap.innerHTML = '<div class="sub-answer-body md">' + renderMd(shown) + '</div>';
  }
  function tick() {
    const q = target.answerQueue || "";
    if ((target.answerShown || 0) < q.length) {
      const next = Math.min((target.answerShown || 0) + PER_STEP, q.length);
      target.answerShown = next;
      renderNow();
      scrollChat();
      const ch = q[next - 1];
      let pause = 0;
      if (ch === "\n") pause = PAUSE_NL;
      else if (/[。！？.!?]/.test(ch)) pause = PAUSE_PUNCT;
      else if (/[，、；：,;:]/.test(ch)) pause = Math.floor(PAUSE_PUNCT / 2);
      setTimeout(tick, TICK + pause);
    } else {
      target._ansAnim = false;
      if (typeof target._ansEnd === "function") {
        const fn = target._ansEnd;
        target._ansEnd = null;
        fn();
      }
    }
  }
  tick();
}
window.startAnswerTypewriter = startAnswerTypewriter;


// 总编气泡的思考过程切换 (inline toggle)
function toggleOrchThink(btn) {
  // 历史重放/新气泡可能没有 thinking-done class — 视为可展开 (不阻挡点击)
  // 正在"思考中" (thinking-active + spinner 转) 且面板还没内容时, 不展开 (避免展开空面板)
  const _msgForGuard = btn.closest(".msg");
  const _panelForGuard = _msgForGuard ? _msgForGuard.querySelector(".sub-think-panel") : null;
  if (btn.classList.contains("thinking-active") && _panelForGuard && _panelForGuard.querySelectorAll(".st-entry").length === 0) return;
  // 确保 toggle 带 thinking-done (让 CSS 显隐 spinner 正常), 幂等
  btn.classList.add("thinking-done");
  btn.classList.remove("thinking-active");
  btn.classList.toggle("expanded");
  const msg = btn.closest(".msg");
  if (msg) {
    let panel = msg.querySelector(".sub-think-panel");
    // 面板不存在: 建一个空的挂在气泡前 (默认展开, 避免点击没反应)
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "sub-think-panel";
      panel.innerHTML = '<div class="sub-think-body"><div class="st-entry st-think"><span class="st-text">（本轮无展开记录）</span></div></div>';
      const bubble = msg.querySelector(".bubble");
      if (bubble) msg.insertBefore(panel, bubble); else msg.appendChild(panel);
      // 基态可见 (CSS max-height:600px), 点击 toggle 才收起
      panel.classList.remove("collapsed");
      btn.classList.add("expanded");
      return;
    }
    // 基态可见, 点击 toggle 切 .collapsed 收起
    panel.classList.toggle("collapsed");
    // 展开时自动滚到面板
    if (!panel.classList.contains("collapsed")) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // toggle .expanded 与面板收起/展开态同步
    btn.classList.toggle("expanded", !panel.classList.contains("collapsed"));
  }
}
window.toggleSubThink = toggleSubThink;
window.toggleOrchThink = toggleOrchThink;

// 规则4: 后端思考文本(字符串)按序号(1. 2.)或换行拆成数组
function splitThinkItems(text) {
  if (!text) return [];
  const t = String(text).trim();
  if (!t) return [];
  // 优先按 "换行 + 序号" 拆分
  const parts = t.split(/\n\s*(?=\d+[.、)]\s)/);
  if (parts.length > 1) {
    return parts.map((s) => s.replace(/^\d+[.、)]\s*/, "").trim()).filter(Boolean);
  }
  // 回退: 按换行拆
  return t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// 向某个 think-body 追加一条思考条目 (.st-entry.st-think)
function addThinkItem(thinkBody, text) {
  if (!thinkBody) return;
  const items = splitThinkItems(text);
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "st-entry st-think";
    div.innerHTML = `<span class="st-dot"></span><span class="st-text">${esc(it)}</span>`;
    thinkBody.appendChild(div);
  }
  scrollChat();
}

// 规则5: 工具调用渲染成 🔧 工具名 (…/✓) 胶囊, 插在思考列表里 (不显示 JSON)
// 工具名逐字打出 + 先导停顿, 配合观察结果翻转 ✓, 产生"正在执行"的真实感
function addToolCapsule(thinkBody, toolName, pending) {
  if (!thinkBody) return null;
  // 工具调用气泡框: 默认折叠 (只显示工具名+状态), 点击展开才看结果
  const div = document.createElement("div");
  div.className = `st-entry st-tool st-bubble collapsed`;
  // 头部: 扳手图标 + 工具名 + 状态 + 折叠箭头
  const head = document.createElement("div");
  head.className = "st-bubble-head";
  head.innerHTML = `<span class="st-dot"></span>
    <span class="st-tool-tag">🔧 <b class="st-tool-name"></b>
      <span class="st-tool-status">${pending ? "…" : "✓"}</span></span>
    <span class="st-bubble-arrow">▸</span>`;
  // 正文区: 默认 max-height:0 折叠, 展开后显示工具结果
  const bodyWrap = document.createElement("div");
  bodyWrap.className = "st-bubble-body-wrap";
  const bodyInner = document.createElement("div");
  bodyInner.className = "st-bubble-body";
  bodyWrap.appendChild(bodyInner);
  div.appendChild(head);
  div.appendChild(bodyWrap);
  // 点击头部切换折叠/展开
  head.onclick = () => {
    const collapsed = div.classList.toggle("collapsed");
    const arrow = head.querySelector(".st-bubble-arrow");
    if (arrow) arrow.textContent = collapsed ? "▸" : "▾";
  };
  thinkBody.appendChild(div);
  scrollChat(true);
  const nameEl = div.querySelector(".st-tool-name");
  div._toolName = toolName; // 供 observation 按名匹配消费 (并行/乱序不错位)
  if (pending && REPLAY_MODE) {
    // 回放模式: 不逐字打工具名
    nameEl.textContent = toolName;
    div._bubbleBody = bodyInner;
  } else if (pending) {
    div._typing = true;
    div._bubbleBody = bodyInner;
    const name = toolName;
    let i = 0;
    // 工具调用前先停顿一下, 模拟 agent "考虑后拿起工具"
    setTimeout(function step() {
      if (i < name.length) {
        i += 1;
        nameEl.textContent = name.slice(0, i);
        scrollChat();
        const ch = name[i - 1];
        const pause = /[，。！？、；：,.!?;:]/.test(ch) ? 120 : 0;
        setTimeout(step, 26 + pause);
      } else {
        div._typing = false;
        if (div._pendingDone) doneToolCapsule(div);
      }
    }, 200);
  } else if (nameEl) {
    nameEl.textContent = toolName;
    div._bubbleBody = bodyInner;
  }
  return div;
}

// 把胶囊标记为完成 (折叠气泡: 把工具结果写进正文区, 保持折叠态)
function doneToolCapsule(entry, resultText) {
  if (!entry) return;
  const finish = () => {
    entry.classList.remove("st-tool");
    entry.classList.add("st-done");
    const st = entry.querySelector(".st-tool-status");
    if (st) st.textContent = "✓";
    // 工具结果写进气泡正文区 (用户点箭头展开时才看到)
    if (resultText && entry._bubbleBody) {
      entry._bubbleBody.innerHTML = `<div class="st-result"><b>结果:</b> ${esc(String(resultText).slice(0, 800))}</div>`;
      // 有结果时, 头部可展开的箭头更醒目
      const arrow = entry.querySelector(".st-bubble-arrow");
      if (arrow) arrow.style.visibility = "visible";
    }
  };
  // 名字还在逐字打出时先标记, 等打完再翻转
  if (entry._typing) {
    entry._pendingDone = true;
    return;
  }
  finish();
}

// 取/建某 agent 的思考面板 body
// 子 agent: assistant.subBubbles[ag].thinkBody
// 总编: assistant.thinkBody (惰性创建)
function getThinkBody(assistant, ag) {
  if (ag && ag !== "orchestrator") {
    let sub = assistant.subBubbles && assistant.subBubbles[ag];
    if (!sub) {
      // 兜底: sub_agent_start 未到时自动建子 agent 气泡
      sub = createSubAgentBubble(assistant, ag, "");
    }
    return sub ? sub.thinkBody : null;
  }
  return ensureOrchestratorThinkPanel(assistant);
}

// 每个 agent 维护一个待完成工具胶囊的 FIFO 队列 (observation 按序消费)
function getToolQueue(assistant, ag) {
  const key = ag || "orchestrator";
  if (!assistant.toolQueues) assistant.toolQueues = {};
  if (!assistant.toolQueues[key]) assistant.toolQueues[key] = [];
  return assistant.toolQueues[key];
}

// 给总编气泡惰性注入双层折叠结构 (.sub-think-toggle + .sub-think-panel)
// 思考面板插在气泡外面 (跟子agent结构一致)
function ensureOrchestratorThinkPanel(assistant) {
  if (assistant.thinkBody) return assistant.thinkBody;
  const bubble = assistant.el;
  if (!bubble) return null;
  const container = bubble.parentElement; // .msg.assistant
  const panel = document.createElement("div");
  // 基态可见 (CSS max-height:600px 默认展开), 点 role 里的 toggle 才收起
  panel.className = "sub-think-panel open";
  panel.innerHTML = `<div class="sub-think-body"></div>`;
  // 插在气泡外面、气泡之前 (不创建单独的toggle, toggle在role div里)
  container.insertBefore(panel, bubble);
  // 同步 role 里的 toggle 箭头方向 (默认展开 → expanded)
  const toggle = container.querySelector(".sub-think-toggle-inline");
  if (toggle) toggle.classList.add("expanded");
  assistant.thinkPanel = panel;
  assistant.thinkBody = panel.querySelector(".sub-think-body");
  return assistant.thinkBody;
}

// 抽出: 创建子 agent 气泡 (sub_agent_start 与 step 兜底共用)
// 思考折叠按钮+面板在气泡外面, 用 wrapper 包在一起
function createSubAgentBubble(assistant, ag, task) {
  const agLbl = AGENT_LABELS[ag] || ag;
  const agIcon = AGENT_ICONS[ag] || "👤";

  // 外层包装器 (toggle + 面板 + msg 卡片)
  const wrapper = document.createElement("div");
  wrapper.className = `sub-agent-wrapper agent-${ag}`;

  // 思考折叠按钮 (气泡外, wrapper 的第一个子元素)
  // 默认 thinking-done: spinner 不转, 文案 "执行过程" — 展开/收起自由; 思考中由 setSubThinkingState 切 active
  const toggle = document.createElement("div");
  toggle.className = "sub-think-toggle thinking-done";
  toggle.onclick = () => toggleSubThink(toggle);
  // 修复: 旧代码前缀"的执行过程"和后缀 .spinner-text"执行过程" 重复渲染成"执行过程的执行过程"
  // 新规格 (用户指定): 思考中 → "架构师 〈执行中 ●转圈〉"  思考完成 → "架构师 〈思考过程〉"
  // 即前缀只留 图标+agent名 (去掉"的"+"的执行过程"), 动态文案用 .spinner-text (执行中/思考过程)
  toggle.innerHTML = `${agIcon} ${esc(agLbl)} <span class="spinner-ring sm"></span><span class="spinner-text">思考过程</span> <span class="arrow"></span>`;

  // 思考面板 (气泡外, toggle 后) — 基态可见, 点 toggle 才收
  const panel = document.createElement("div");
  panel.className = "sub-think-panel open";
  panel.innerHTML = '<div class="sub-think-body"></div>';

  // 子 Agent 执行过程卡片 (折叠气泡: 任务 + 思考面板, 点击可展开过程)
  const subDiv = document.createElement("div");
  subDiv.className = `msg sub-agent agent-${ag}`;
  subDiv.dataset.agent = ag;
  subDiv.innerHTML = `<div class="bubble sub-bubble sub-process-bubble">
      ${task ? `<div class="sub-task"><div class="sub-task-label">📨 ${esc(agLbl)} 收到群消息「@${esc(agLbl)}」</div>${esc(task.slice(0, 300))}${task.length > 300 ? "…" : ""}</div>` : ""}
      <div class="sub-process-note">🔧 执行中… <span class="sub-process-status"></span></div>
    </div>`;

  // 子 Agent 正文回答 (框外普通文字, 不裹气泡, 与执行过程视觉分离)
  const answerBlock = document.createElement("div");
  answerBlock.className = `sub-answer-block agent-${ag}`;
  answerBlock.innerHTML = `<div class="sub-answer-wrap"></div>`;

  wrapper.appendChild(toggle);
  wrapper.appendChild(panel);
  wrapper.appendChild(subDiv);
  wrapper.appendChild(answerBlock);
  $("#chat").appendChild(wrapper);

  if (!assistant.subBubbles) assistant.subBubbles = {};
  assistant.subBubbles[ag] = {
    el: subDiv,
    thinkBody: panel.querySelector(".sub-think-body"),
    answerWrap: answerBlock.querySelector(".sub-answer-wrap"),
    answerBlock,
  };
  scrollChat(true);
  return assistant.subBubbles[ag];
}


function handleEvent(evt, assistant) {
  const bubble = assistant.el;
  // 调试: 记录所有收到的事件 (F12 console 看)
  if (evt.type && evt.type.startsWith("sub_")) {
    // debug: console.log("%c[群聊事件] " + evt.type, "color:#3d6b8b;font-weight:bold", evt);
  }
  switch (evt.type) {
    // 未知事件兜底: 不静默吞, 防协议漂移 (第一性: 渲染层必须可观测未知事件)
    default:
      console.warn("[SSE] 未知事件类型:", evt.type, JSON.stringify(evt).slice(0, 120));
      break;
    case "start":
      if (!REPLAY_MODE) {
        window.__naRunStartTs = Date.now();
        window.__currentRunId = evt.runId || null;
        _rateNoticeAgents.clear(); // 新一轮 run, 清掉上一轮的限流提示 agent 记录
      }
      break;
    case "think": {
      // 兼容旧单事件 (已废弃, 改用 think_start/token/end 流式)
      break;
    }
    case "model_picked": {
      // 模型选择事件: 该 agent 解析到了哪个模型 (tier → 实际模型)
      // 渲染进该 agent 的思考面板 (若没有则挂到 orchestrator), 不合成假思考, 只标注真实选择
      const mpBody = getThinkBody(assistant, evt.agent || "orchestrator");
      if (mpBody) {
        const mpDiv = document.createElement("div");
        mpDiv.className = "st-entry st-decision";
        const mpTier = evt.tier ? ` <span class="st-delegate-task">[tier=${esc(evt.tier)}]</span>` : "";
        mpDiv.innerHTML = `<span class="st-decision-tag">🧠 模型</span>
          <span class="st-decision-intent">${esc(evt.model || "")}</span>${mpTier}`;
        mpBody.appendChild(mpDiv);
      }
      break;
    }
    case "think_start": {
      // 子agent路由: 如果是子agent的思考, 渲染到子agent气泡 (气泡不存在时自动建 — 与 step/observation 口径一致, 不再串到主 agent)
      const _tsAgent = evt.agent || "orchestrator";
      if (_tsAgent !== "orchestrator") {
        const _tsEntry = (assistant.subBubbles && assistant.subBubbles[_tsAgent]) || createSubAgentBubble(assistant, _tsAgent, "");
        // 上一轮思考还没播完/收尾没执行: 先结算旧条目 (否则旧条目永远残留"..."动画点)
        flushPendingThink(_tsEntry);
        _tsEntry.thinkQueue = "";
        _tsEntry._thinkAnim = false;
        _tsEntry._thinkEnd = null;
        const _body = _tsEntry.thinkBody;
        if (_body) {
          const _entry = document.createElement("div");
          _entry.className = "st-entry st-think";
          _entry.innerHTML = `<span class="st-text"><span class="think-stream-text"></span><span class="thinking-dots"></span></span>`;
          _body.appendChild(_entry);
          _tsEntry.curThinkEntry = _entry;
          _tsEntry.curThinkText = _entry.querySelector(".think-stream-text");
          _tsEntry.panel = _body.closest(".sub-think-panel");
          // 前端真映射④: 保持默认折叠, 不再强制展开
          setSubThinkingState(_tsEntry, true);
        }
        scrollChat();
        break;
      }
      // 上一轮思考还没播完/收尾没执行: 先结算 (否则旧条目残留"..."点、丢失"✓可行"结论)
      flushPendingThink(assistant);
      // rotate 必须在 ensure 之前 — 旧版顺序反了: 气泡已封口时 ensure 会把空面板挂到旧气泡上再被 rotate 丢弃
      if (assistant.closed) rotateOrchestratorBubble(assistant);
      // 主 agent 思考开始: 面板【必须在气泡外、气泡前】, 不能塞进 .bubble 里
      ensureOrchestratorThinkPanel(assistant);
      assistant.thinkQueue = "";
      assistant._thinkAnim = false;
      assistant._thinkEnd = null;
      // 主 agent 进入思考 → 思考态切 "思考中" + spinner
      setMainThinkingState(assistant, true);
      // 前端真映射④: 保持默认折叠, 不再强制展开 (用户点开 toggle 才看)
      // 创建流式思考条目 (挂到气泡外的面板里)
      const body0 = assistant.thinkBody;
      if (body0) {
        const entry0 = document.createElement("div");
        entry0.className = "st-entry st-think";
        entry0.id = "think-stream-" + (evt.round || 1);
        entry0.innerHTML = `<span class="st-text"><span class="think-stream-text"></span><span class="thinking-dots"></span></span>`;
        body0.appendChild(entry0);
        assistant.curThinkEntry = entry0;
        assistant.curThinkText = entry0.querySelector(".think-stream-text");
        scrollChat();
      }
      break;
    }
    case "think_token": {
      const _tkAgent = evt.agent || "orchestrator";
      // 子 agent: 气泡不存在时自动建 (旧版会落到主 agent 思考队列 → 思考串台)
      if (_tkAgent !== "orchestrator" && evt.text) {
        const _subTk = (assistant.subBubbles && assistant.subBubbles[_tkAgent]) || createSubAgentBubble(assistant, _tkAgent, "");
        _subTk.thinkQueue = (_subTk.thinkQueue || "") + evt.text;
        startThinkTypewriter(_subTk);
        break;
      }
      // 思考打字机: 新 token 追加到队列尾部, 边收边播
      if (evt.text) {
        assistant.thinkQueue = (assistant.thinkQueue || "") + evt.text;
        startThinkTypewriter(assistant);
      }
      break;
    }
    case "think_end": {
      const _teAgent = evt.agent || "orchestrator";
      if (_teAgent !== "orchestrator") {
        // 气泡不存在时自动建 (与 think_start/token 口径一致)
        const _subTe = (assistant.subBubbles && assistant.subBubbles[_teAgent]) || createSubAgentBubble(assistant, _teAgent, "");
        // 回放模式: 打字机没跑, 先把队列文本一次性补进条目
        if (REPLAY_MODE && _subTe.curThinkText) _subTe.curThinkText.textContent = _subTe.thinkQueue || "";
        // 思考文本还在逐字打出时, 先挂收尾动作等播完再执行 (避免中途被清空)
        const _teEntry = _subTe.curThinkEntry; // 捕获本轮条目 (后续新一轮 think_start 会换引用)
        const finishSubThink = () => {
          if (_teEntry) {
            const _dots = _teEntry.querySelector(".thinking-dots");
            if (_dots) _dots.remove();
            _teEntry.className = `st-entry st-done`;
          }
          if (_subTe.curThinkEntry === _teEntry) {
            _subTe.curThinkEntry = null;
            _subTe.curThinkText = null;
          }
          _subTe.thinkQueue = "";
          // 子 agent 思考结束 → 执行态切回 "执行过程" (spinner 停, 可点开看步骤)
          setSubThinkingState(_subTe, false);
          // 前端真映射④: 保持默认折叠 (用户点 toggle 才展开看执行过程)
          const _subMsg = _subTe.el?.closest(".msg");
          if (_subMsg) {
            const _subToggle = _subMsg.querySelector(".sub-think-toggle, .sub-think-toggle-inline");
            if (_subToggle) _subToggle.classList.remove("expanded");
          }
        };
        if (_subTe._thinkAnim) _subTe._thinkEnd = finishSubThink;
        else finishSubThink();
        break;
      }
      // 思考结束: 等打字机播完后再移除打字指示、显示判断结果并自动折叠
      const body = assistant.thinkBody;
      const feasible = evt.feasible;
      const reason = evt.reason || "";
      const plan = evt.plan || [];
      const missing = evt.missing || "";
      // 回放模式: 打字机没跑, 先把队列文本一次性补进条目
      if (REPLAY_MODE && assistant.curThinkText) assistant.curThinkText.textContent = assistant.thinkQueue || "";
      const _teEntryMain = assistant.curThinkEntry; // 捕获本轮条目, 防新一轮 think_start 换引用后误操作

      const finishOrchThink = () => {
        // 移除打字指示 (逐字已通过 think_token 渲染)
        if (_teEntryMain) {
          const dots = _teEntryMain.querySelector(".thinking-dots");
          if (dots) dots.remove();
          _teEntryMain.className = `st-entry ${feasible ? "st-done" : "st-think"}`;
        }

        // 追加判断结论
        if (body && (reason || plan.length || missing)) {
          const planStr = plan.length ? ` → ${plan.join(" → ")}` : "";
          const missStr = missing ? ` ⚠缺: ${missing}` : "";
          const sum = document.createElement("div");
          sum.className = `st-entry ${feasible ? "st-done" : "st-think"}`;
          sum.innerHTML = `<span class="st-dot"></span><span class="st-text"><b>${feasible ? "✓ 可行" : "✗ 不可行"}</b> ${esc(reason)}${esc(planStr)}${esc(missStr)}</span>`;
          body.appendChild(sum);
          scrollChat();
        }

        assistant.thinkQueue = "";
        if (assistant.curThinkEntry === _teEntryMain) {
          assistant.curThinkEntry = null;
          assistant.curThinkText = null;
        }
        // 思考结束 → 主 agent 思考态切回 "思考过程"
        // 前端真映射④: 面板保持默认折叠, 用户点 toggle 才展开看刚才的思考过程
        setMainThinkingState(assistant, false);
      };
      if (assistant._thinkAnim) assistant._thinkEnd = finishOrchThink;
      else finishOrchThink();
      break;
    }
    case "usage": {
      updateCacheStats(evt);
      break;
    }
    case "cache_stats": {
      updateCacheStats(evt);
      break;
    }
    case "planner_decision": {
      // 主 agent 规划决策: 让前端看见"它为什么做这个决定 + 任务分解 + 调度路由"
      // 渲染进主 agent 思考面板 (决策条目), 不是合成假思考, 是真实的 intent/route/reason/steps
      const pIntent = evt.intent || "";
      const pRoute = evt.route || "";
      const pReason = evt.reason || "";
      const pSteps = Array.isArray(evt.steps) ? evt.steps : [];
      // 主 agent: 确保气泡外有思考面板
      if (!evt.agent || evt.agent === "orchestrator") {
        ensureOrchestratorThinkPanel(assistant);
        setMainThinkingState(assistant, true);
      }
      const pBody = getThinkBody(assistant, evt.agent);
      if (pBody) {
        const div = document.createElement("div");
        div.className = "st-entry st-decision";
        const intentTag = { create_project: "新建项目", scan_bestseller_fast: "扫榜(快)", web_search_fast: "搜索(快)" }[pIntent] || pIntent;
        const stepsHtml = pSteps.length ? `<div class="st-decision-steps">${pSteps.map(s => `<span class="st-step">${esc(s)}</span>`).join(' <span class="st-step-arrow">→</span> ')}</div>` : "";
        div.innerHTML = `<span class="st-decision-tag">⚙ 决策</span>
          <span class="st-decision-intent">${esc(intentTag)}</span>
          ${pRoute ? `<span class="st-decision-route">→ ${esc(pRoute)}</span>` : ""}
          ${pReason ? `<div class="st-decision-reason">${esc(pReason)}</div>` : ""}
          ${stepsHtml}`;
        pBody.appendChild(div);
        scrollChat();
      }
      break;
    }
    case "delegate": {
      // 群聊式 @拍一拍: 总编 @某专家去执行
      // P1 修复: 旧实现调 appendThink(已废 no-op) → 委派条目在思考面板丢失, 只在气泡里一行 @tag
      // 新实现: 主 agent 思考面板加一条 st-delegate 群消息条目 (与 ⚙决策 同级), 主对话区 @气泡保留
      const toLbl = AGENT_LABELS[evt.to] || evt.to;
      const toIcon = AGENT_ICONS[evt.to] || "↪";
      const fromLbl = AGENT_LABELS[evt.from] || evt.from || "总编";
      const fromIcon = AGENT_ICONS[evt.from] || "🎯";
      if (evt.to) updateActiveAgent(evt.to);
      const task = evt.task || "";

      // 主 agent 思考面板: 群 @消息条目 (蓝左边框, 总编 → @专家)
      if (!evt.from || evt.from === "orchestrator") {
        ensureOrchestratorThinkPanel(assistant);
        setMainThinkingState(assistant, true);
      }
      const dBody = getThinkBody(assistant, evt.from || "orchestrator");
      if (dBody) {
        const dDiv = document.createElement("div");
        dDiv.className = "st-entry st-delegate";
        dDiv.innerHTML = `<span class="st-delegate-tag">${fromIcon} ${esc(fromLbl)} 拍一拍 ${toIcon} @${esc(toLbl)}</span>
          ${task ? `<div class="st-delegate-task">「${esc(task.slice(0, 120))}${task.length > 120 ? "…" : ""}」</div>` : ""}`;
        dBody.appendChild(dDiv);
      }

      // 群聊式: 若上一轮总编气泡已封口, 先开新气泡再发言 (每次@拍一拍都是独立气泡)
      if (assistant.closed) {
        rotateOrchestratorBubble(assistant);
      }
      // 主对话区: @消息作为总编气泡的发言正文 (群聊式 @拍一拍)
      const spk = document.createElement("div");
      spk.className = "md answer-body delegate-speak";
      spk.innerHTML = `<span class="at-tag">${toIcon} @${esc(toLbl)}</span>
        <span class="delegate-task">${esc(task)}</span>`;
      assistant.el.appendChild(spk);
      // 封口当前总编气泡 (下次总编发言会开新气泡)
      assistant.el.classList.add("bubble-closed");
      assistant.closed = true;
      scrollChat();
      break;
    }
    case "delegate_done": {
      // 群聊式: 被@的专家执行完成 — 结果已在专家气泡的 sub_answer 里展示
      // P1 修复: 旧实现调 appendThink(no-op) → 完成条目丢失; 改渲染进主 agent 思考面板
      const toLbl = AGENT_LABELS[evt.to] || evt.to;
      const toIcon = AGENT_ICONS[evt.to] || "↪";
      const fromLbl = AGENT_LABELS[evt.from] || "总编";
      const fromIcon = AGENT_ICONS[evt.from] || "🎯";
      const dur = evt.duration_ms ? `${(evt.duration_ms / 1000).toFixed(1)}s` : "";
      const ddBody = getThinkBody(assistant, evt.from || "orchestrator");
      if (ddBody) {
        const ddDiv = document.createElement("div");
        ddDiv.className = "st-entry st-delegate st-delegate-done";
        ddDiv.innerHTML = `<span class="st-delegate-tag">${fromIcon} ${esc(fromLbl)} 收回 ${toIcon} @${esc(toLbl)} <span class="st-delegate-done-mark">✓ ${dur}</span></span>`;
        ddBody.appendChild(ddDiv);
      }
      if (evt.to) updateActiveAgent(evt.from || "orchestrator");
      scrollChat();
      break;
    }
    case "sub_agent_start": {
      // 规则2: 专家 agent 建独立气泡, 思考挂在该气泡内 (不进全局日志)
      const ag = evt.agent || "";
      const task = evt.task || "";
      if (ag) updateActiveAgent(ag);
      createSubAgentBubble(assistant, ag, task);
      break;
    }
    case "llm_reconnecting": {
      // LLM 中断正在自动重试 → 在对应 agent 处显示「正在尝试链接 LLM…(第N/10次 · 间隔Xs)」转圈条
      const _rcAgent = evt.agent || "orchestrator";
      const _rcAttempt = evt.attempt || 1;
      const _rcMax = evt.max || 10;
      const _rcInterval = evt.interval_s || 0;
      let _rcTarget;
      if (_rcAgent !== "orchestrator") {
        const _rcEntry = assistant.subBubbles && assistant.subBubbles[_rcAgent];
        _rcTarget = _rcEntry ? _rcEntry.el : null;
      } else {
        _rcTarget = assistant.el;
      }
      if (!_rcTarget) break;
      // 已有转圈条则原地更新, 否则新建 (避免重复堆叠)
      let _rcBar = _rcTarget.querySelector(".llm-reconnect-bar");
      if (!_rcBar) {
        _rcBar = document.createElement("div");
        _rcBar.className = "llm-reconnect-bar";
        // 专家气泡内插到 .sub-process-note 之后; 主气泡直接 append
        const _note = _rcTarget.querySelector(".sub-process-note");
        if (_note) _note.insertAdjacentElement("afterend", _rcBar);
        else _rcTarget.appendChild(_rcBar);
      }
      _rcBar.innerHTML = '<span class="llm-reconnect-spinner"></span> 正在尝试链接 LLM… (第 ' + _rcAttempt + '/' + _rcMax + ' 次 · 间隔 ' + _rcInterval + 's)';
      scrollChat();
      break;
    }
    case "llm_reconnect_ok": {
      // LLM 连接成功 → 清掉该 agent 的「正在尝试链接」转圈条
      const _okAgent = evt.agent || "orchestrator";
      const _okTarget = _okAgent !== "orchestrator"
        ? (assistant.subBubbles && assistant.subBubbles[_okAgent] ? assistant.subBubbles[_okAgent].el : null)
        : assistant.el;
      if (_okTarget) {
        const _okBar = _okTarget.querySelector(".llm-reconnect-bar");
        if (_okBar) _okBar.remove();
      }
      break;
    }
    case "sub_think": {
      // 规则4: 专家 agent 思考文本按序号/换行拆成条目, 追加到该专家气泡的思考面板
      const ag = evt.agent || "";
      const text = evt.text || "";
      if (!text) break;
      const entry = assistant.subBubbles && assistant.subBubbles[ag];
      if (!entry || !entry.thinkBody) break;
      addThinkItem(entry.thinkBody, text);
      break;
    }
    case "sub_answer": {
      // 专家 agent 的最终回答作为框外普通文字 (思考/工具面板保持折叠, 正文不裹气泡)
      const ag = evt.agent || "";
      const text = evt.text || evt.content || "";
      if (!text) break;
      let entry = assistant.subBubbles && assistant.subBubbles[ag];
      // 兜底: sub_answer 先于 sub_agent_start 到达 (或 start 被跳过), 自动建气泡
      if (!entry) {
        entry = createSubAgentBubble(assistant, ag, "");
      }
      if (!entry) break;
      const agLbl = AGENT_LABELS[ag] || ag;
      let html = `<div class="sub-answer-body md">${renderMd(text)}</div>`;
      // 前端真映射③: 正文旁"总编终审"角标 — 内容里含终审备注=打回修订版, 否则=背书版
      const _saBadge = /总编终审备注/.test(text)
        ? `<div class="sub-final-review-badge" style="margin-top:4px;font-size:11px;color:#b0836a">🎯 总编终审打回 · 已修订版交付</div>`
        : `<div class="sub-final-review-badge" style="margin-top:4px;font-size:11px;color:var(--text-dim, #8a97a8)">🎯 总编终审背书 · 可放心阅读</div>`;
      html += _saBadge;
      // 如果是主笔写的正文 (字数>200), 加导出TXT按钮
      if (text.length > 200) {
        html += `<div style="margin-top:6px"><button class="btn ghost sm" style="padding:2px 8px;font-size:11px;cursor:pointer" onclick="downloadTxt(this.closest('.sub-answer-block').querySelector('.sub-answer-body').textContent, '${esc(agLbl)}')">📄 导出TXT</button></div>`;
      }
      // 先停掉 token 打字机再覆盖 (否则下一 tick 会把旧进度渲染回去, 冲掉终审角标/导出按钮)
      entry._ansAnim = false;
      entry._ansEnd = null;
      entry.answerQueue = "";
      entry.answerShown = 0;
      entry.answerWrap.innerHTML = html;
      // 正文出框外 → 子 agent 执行态切 "思考过程" (spinner 停, 可点开看步骤)
      setSubThinkingState(entry, false);
      // 子 agent 直写路径同样自动折叠思考面板
      autoCollapseThink(entry);
      // 执行过程状态切到 "已完成"
      const statusEl = entry.el.querySelector(".sub-process-status");
      if (statusEl) statusEl.textContent = "已完成";
      scrollChat();
      break;
    }
    case "sub_agent_done": {
      // 群聊式: 专家 agent 发言结束
      const ag = evt.agent || "";
      const agLbl = AGENT_LABELS[ag] || ag;
      const agIcon = AGENT_ICONS[ag] || "👤";
      const truncated = evt.truncated;
      const entry = assistant.subBubbles && assistant.subBubbles[ag];
      // 兜底: sub_agent_done 先于 sub_agent_start 到达 (或 start 被跳过), 自动建气泡
      if (!entry) {
        entry = createSubAgentBubble(assistant, ag, "");
      }
      if (!entry) break;
      // 标记执行过程完成 (气泡变 ✓), 正文块保持框外普通文字
      entry.el.classList.add("sub-done");
      const statusEl = entry.el.querySelector(".sub-process-status");
      if (statusEl) statusEl.textContent = "✓ 完成";
      // toggle 从 "执行中" 切到 "思考过程" (spinner 停, 可点开看步骤)
      setSubThinkingState(entry, false);
      if (truncated) {
        entry.answerWrap.innerHTML += `<div class="sub-truncated">⚠ 步数用尽, 任务未完全完成</div>`;
      }
      // P1 修复: appendThink 已废 no-op → 完成条目渲染进主 agent 思考面板
      const sdBody = getThinkBody(assistant, "orchestrator");
      if (sdBody) {
        const sdDiv = document.createElement("div");
        sdDiv.className = "st-entry st-delegate st-delegate-done";
        // 前端真映射③: 交付条目语义 = 总编终审背书后交付 (非原样端出)
        sdDiv.innerHTML = `<span class="st-delegate-tag">${agIcon} @${esc(agLbl)} 交付 (总编终审背书) <span class="st-delegate-done-mark">✓</span></span>`;
        sdBody.appendChild(sdDiv);
      }
      // 活跃 agent 切回总编
      updateActiveAgent("orchestrator");
      scrollChat();
      break;
    }
    case "sub_agent_error": {
      const ag = evt.agent || "";
      const agLbl = AGENT_LABELS[ag] || ag;
      const agIcon = AGENT_ICONS[ag] || "👤";
      const entry = assistant.subBubbles && assistant.subBubbles[ag];
      if (entry) {
        entry.el.classList.add("sub-error");
        entry.answerWrap.innerHTML = `<div class="sub-error-msg">❌ 调用失败: ${esc(evt.error || "")}</div>`;
      }
      // P1 修复: appendThink 已废 no-op → 错误条目渲染进主 agent 思考面板
      const seBody = getThinkBody(assistant, "orchestrator");
      if (seBody) {
        const seDiv = document.createElement("div");
        seDiv.className = "st-entry st-delegate st-delegate-error";
        seDiv.innerHTML = `<span class="st-delegate-tag">⚠ @${esc(agLbl)} 调用失败 <span class="st-delegate-done-mark">✗</span></span>`;
        seBody.appendChild(seDiv);
      }
      scrollChat();
      break;
    }
    case "sandbox_validate": {
      // 沙箱验证事件: 显示前置条件检查结果
      const ag = evt.agent || "";
      const agLbl = AGENT_LABELS[ag] || ag;
      const agIcon = AGENT_ICONS[ag] || "👤";
      const toolName = cnTool(evt.tool || "");
      const passed = evt.passed;
      const issues = evt.issues || [];
      
      // 左侧面板: 显示验证结果 — P1: appendThink 已废 no-op, 改渲染进 agent 思考面板
      const svBody = getThinkBody(assistant, ag || "orchestrator");
      if (svBody) {
        const svDiv = document.createElement("div");
        svDiv.className = "st-entry st-delegate" + (passed ? "" : " st-delegate-error");
        svDiv.innerHTML = `<span class="st-delegate-tag">${agIcon} @${esc(agLbl)} · ${esc(toolName)} ${passed ? "前置条件满足" : "前置条件不满足"}</span>
          ${!passed ? `<div class="st-delegate-task">${issues.map(i => esc(i)).join('; ')}</div>` : ""}`;
        svBody.appendChild(svDiv);
      }
      break;
    }
    case "review": {
      // 群聊式: 总编验收 (符合设想→产出 / 有问题→打回)
      const pass = evt.pass;
      const verdict = evt.verdict || "";
      const delegations = evt.delegations || [];
      const agLbl = AGENT_LABELS[evt.agent] || "总编";
      const agIcon = AGENT_ICONS[evt.agent] || "🎯";

      // 左侧思考面板 — P1: appendThink 已废 no-op, 改渲染进主 agent 思考面板 (审核条目可见)
      const rvBody = getThinkBody(assistant, "orchestrator");
      if (rvBody) {
        const rvDiv = document.createElement("div");
        rvDiv.className = "st-entry st-decision st-review" + (pass ? "" : " st-review-reject");
        rvDiv.innerHTML = `<span class="st-decision-tag">🔍 审核</span>
          <span class="st-decision-intent">${pass ? "验收通过" : "验收打回"}</span>
          ${verdict ? `<div class="st-decision-reason">${esc(verdict.slice(0, 200))}</div>` : ""}`;
        rvBody.appendChild(rvDiv);
      }

      // 群聊式: 总编气泡若已封口, 开新气泡展示验收
      if (assistant.closed) {
        rotateOrchestratorBubble(assistant);
      }
      // 主对话区: 验收卡片
      if (!assistant.chainEl) {
        assistant.chainEl = document.createElement("div");
        assistant.chainEl.className = "think-chain";
        assistant.el.appendChild(assistant.chainEl);
      }
      const revBlk = document.createElement("div");
      revBlk.className = `collab-card collab-review ${pass ? "pass" : "reject"}`;
      const dlHtml = delegations.map((d) => {
        const lbl = AGENT_LABELS[d.to] || d.to;
        const icon = AGENT_ICONS[d.to] || "↪";
        return `<div class="cc-rv-item">${icon} ${esc(lbl)}: ${esc((d.task || "").slice(0, 50))}</div>`;
      }).join("");
      revBlk.innerHTML = `<div class="cc-head">
        <span class="cc-from">${agIcon} ${esc(agLbl)} 验收</span>
        <span class="cc-status ${pass ? "done" : "no"}">${pass ? "✓ 符合设想, 产出" : "✗ 不符设想, 打回重做"}</span>
      </div>
      ${dlHtml ? `<div class="cc-rv-list">${dlHtml}</div>` : ""}
      <div class="cc-verdict">${esc(verdict)}</div>`;
      assistant.chainEl.appendChild(revBlk);
      scrollChat();
      break;
    }
    case "step": {
      // 规则5: 工具调用统一渲染成 🔧 工具名 胶囊, 插在归属 agent 的思考列表里 (不显示 JSON)
      const ag = evt.agent || "";
      const toolName = cnTool(evt.tool || "");

      // delegate_to_agent 的展示由 delegate 事件负责; "(完成)" 非真实工具, 跳过
      if (evt.tool === "delegate_to_agent" || evt.tool === "(完成)") {
        scrollChat();
        break;
      }
      // 总编工具: 若气泡已封口(上次@委派), 先开新气泡再挂思考面板
      if (!ag || ag === "orchestrator") {
        if (assistant.closed) rotateOrchestratorBubble(assistant);
        // 主 agent 执行工具 → 思考态切 "正在思考" + spinner
        setMainThinkingState(assistant, true);
      }
      // thinking 已由 think_*(总编) / sub_think(子agent) 处理, 此处不重复渲染
      // 主 agent 工具: 确保气泡外有思考面板 (工具胶囊挂里面, 不塞进 .bubble 框)
      if (!ag || ag === "orchestrator") ensureOrchestratorThinkPanel(assistant);
      const thinkBody = getThinkBody(assistant, ag);
      if (!thinkBody) break;
      const capsule = addToolCapsule(thinkBody, toolName, true);
      getToolQueue(assistant, ag).push(capsule);
      scrollChat();
      break;
    }
    case "observation": {
      // 限流/配额事件: 前端【不显示】这种专家级限流系统提示 (用户明确不要), 直接跳过
      // (不消费工具胶囊, 不渲染提示条 — 限流由后端自行冷却重试, 前端无需提示)
      if (evt.tool === "rate_limit" || evt.tool === "quota_exhausted") {
        break;
      }
      const ag = evt.agent || "";
      const _obTool = evt.tool || "";
      // 与 step 对齐: delegate_to_agent/(完成) 不建胶囊, observation 也必须跳过 —
      // 旧版这里 shift 队列, 会把别的工具的胶囊错标 ✓ (队列错位bug)
      if (_obTool === "delegate_to_agent" || _obTool === "(完成)") {
        break;
      }
      // 工具结果写进折叠气泡的正文区 (点击头部箭头展开才看到)
      const resultText = (typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result || "")).slice(0, 800);
      // ===== 前端真映射①: 两遍审核分型 — 按 tool 区分"质检那遍" vs "总编终审那遍" =====
      // 后端逻辑: quality_check = 质检员过程稿那遍; review_chapter/final_review = 总编自己那遍。
      // 这些是【裸 observation】(无 step 配对), 只做专属面板渲染, 绝不消费工具队列
      if (_obTool === "quality_check(auto)" || _obTool === "quality_check") {
        // 质检员那遍 → 挂到质检员 (consistency-checker) 面板, 专属标签
        const qcBody = getThinkBody(assistant, "consistency-checker");
        if (qcBody) {
          const qcDiv = document.createElement("div");
          qcDiv.className = "st-entry st-delegate";
          // 36 维审计有结构化结果 → 渲染维度摘要; 否则退回原文, 不再让用户读裸 JSON
          const dimHtml = renderQcDimensionSummary(evt.result);
          qcDiv.innerHTML = `<span class="st-delegate-tag">🔍 质检员 · 过程稿那遍 <span class="st-delegate-done-mark">✓</span></span>
            ${dimHtml || `<div class="st-delegate-task">${esc(resultText.slice(0, 300))}</div>`}`;
          qcBody.appendChild(qcDiv);
          const qcPanel = qcBody.closest(".sub-think-panel");
          if (qcPanel) qcPanel.classList.remove("collapsed");
        }
      } else if (_obTool === "review_chapter(auto)" || _obTool === "review_chapter" || _obTool === "review_chapter(skip)" || _obTool === "final_review" || _obTool === "final_adjudicate") {
        // 总编终审那遍 → 挂到总编 (orchestrator) 面板, 专属标签
        const rvBody = getThinkBody(assistant, "orchestrator");
        if (rvBody) {
          const isFinal = _obTool === "final_review" || _obTool === "final_adjudicate";
          const rvDiv = document.createElement("div");
          rvDiv.className = "st-entry st-delegate";
          rvDiv.innerHTML = `<span class="st-delegate-tag">${isFinal ? "🎯 总编 · 终审裁决" : "🎯 总编 · 终审那遍 (毒舌)"} <span class="st-delegate-done-mark">✓</span></span>
            <div class="st-delegate-task">${esc(resultText.slice(0, 300))}</div>`;
          rvBody.appendChild(rvDiv);
        }
      } else if (/^(empty_args_retry|stream_budget|empty_response|model_fallback|fallback_nonstream|max_steps_wrapup|max_steps_wrapup_failed|assess_chapter\(auto\)|character_check\(auto\))$/.test(_obTool)) {
        // 系统类裸 observation (无 step 配对): 渲染为小字便签, 不消费工具队列 (旧版会吃掉真工具胶囊)
        const noteBody = getThinkBody(assistant, ag || "orchestrator");
        if (noteBody) {
          const ntDiv = document.createElement("div");
          ntDiv.className = "st-entry st-delegate st-system-note";
          ntDiv.innerHTML = `<span class="st-delegate-tag">⚙ ${esc(cnTool(_obTool))}</span>
            <div class="st-delegate-task">${esc(resultText.slice(0, 200))}</div>`;
          noteBody.appendChild(ntDiv);
        }
      } else {
        // 规则5: 工具结果把对应胶囊标记为 ✓ — 按工具名匹配消费 (并行/乱序不错位), 无匹配不动队列
        const q = getToolQueue(assistant, ag);
        const want = cnTool(_obTool);
        let idx = q.findIndex(c => c && c._toolName === want);
        if (idx < 0 && q.length === 1) idx = 0; // 单胶囊兜底 (名字对不上也能收尾)
        const capsule = idx >= 0 ? q.splice(idx, 1)[0] : null;
        if (capsule) doneToolCapsule(capsule, resultText);
      }
      // 主 agent 工具完成 → 检查是否还有挂起工具, 没有则切回 "思考过程"
      if (!ag || ag === "orchestrator") {
        // 兜底: step 路径可能因 thinkBody 缺失未挂面板, observation 时确保面板在气泡外
        ensureOrchestratorThinkPanel(assistant);
        const mainQ = getToolQueue(assistant, "orchestrator");
        if (mainQ.length === 0) setMainThinkingState(assistant, false);
      }
      // 【产出后必须实时可见】任何写库工具执行完都要把项目数据拉回来重渲染 ——
      // 旧代码只刷了 4 个"设定类"工具 (add_element/manage_character/manage_world/manage_milestone),
      // 而 continue_writing(写正文) / generate_outline(大纲) / review_chapter(改状态) 这些
      // **真正产出内容的工具一个都没刷** → 后端跑完了但页面纹丝不动, 用户只能手动 F5 才看得到。
      // 改成白名单 + 防抖: 一轮里连跑好几个写库工具也只合并成一次请求。
      const _tool = evt.tool || "";
      if (currentProject && MUTATING_TOOLS.test(_tool)) {
        scheduleProjectRefresh();
      }
      scrollChat();
      break;
    }
    case "answer_start": {
      const _asAgent = evt.agent || "orchestrator";
      const _isSubAs = _asAgent !== "orchestrator" && assistant.subBubbles && assistant.subBubbles[_asAgent];
      if (_isSubAs) {
        const _subAs = assistant.subBubbles[_asAgent];
        _subAs.rawBuf = "";
        _subAs.answerQueue = "";
        _subAs.answerShown = 0;
        _subAs._ansAnim = false;
        _subAs._ansEnd = null;
        break;
      }
      // 主 agent 开始产出最终回答 → 思考已完, toggle 切回 "思考过程" (不再"思考中")
      setMainThinkingState(assistant, false);
      removeThinkLoading();
      // 群聊式: 总编气泡若已封口(上次是@委派), 开新气泡展示最终回答
      if (assistant.closed) {
        rotateOrchestratorBubble(assistant);
      }
      // 开始新回答前清掉所有残留光标, 只保留当前这一个
      removeAllCarets();
      assistant.answerEl = document.createElement("div");
      assistant.answerEl.className = "md answer-body";
      assistant.el.appendChild(assistant.answerEl);
      assistant.rawBuf = "";
      assistant.answerQueue = "";
      assistant.answerShown = 0;
      assistant._ansAnim = false;
      assistant._ansEnd = null;
      const caret = document.createElement("span");
      caret.className = "caret";
      assistant.el.appendChild(caret);
      break;
    }
    case "token": {
      const _tk2Agent = evt.agent || "orchestrator";
      const _tk2Text = (evt.text || evt.content || "");
      // 限流/系统级提示: 前端【不显示】(用户明确不要专家级限流提示), 记录 agent 供 answer_end 收尾
      if (_tk2Agent !== "orchestrator" && isSystemNotice(_tk2Text)) {
        _rateNoticeAgents.add(_tk2Agent);
        break;
      }
      const _isSubTk2 = _tk2Agent !== "orchestrator";
      if (_isSubTk2) {
        // 气泡不存在时自动建 (旧版落到主 agent 正文 → 正文串台)
        const _subTk2 = (assistant.subBubbles && assistant.subBubbles[_tk2Agent]) || createSubAgentBubble(assistant, _tk2Agent, "");
        if (!_subTk2.rawBuf) _subTk2.rawBuf = "";
        _subTk2.rawBuf += _tk2Text;
        _subTk2.answerQueue = (_subTk2.answerQueue || "") + _tk2Text;
        startAnswerTypewriter(_subTk2);
        break;
      }
      if (!assistant.answerEl) {
        // 兜底: 没有 answer_start 也建回答区
        if (assistant.closed) rotateOrchestratorBubble(assistant);
        assistant.answerEl = document.createElement("div");
        assistant.answerEl.className = "md answer-body";
        assistant.rawBuf = "";
        assistant.el.appendChild(assistant.answerEl);
      }
      assistant.rawBuf += (evt.text || evt.content || "");
      assistant.answerQueue = (assistant.answerQueue || "") + (evt.text || evt.content || "");
      startAnswerTypewriter(assistant);
      break;
    }
    case "answer_end": {
      // 等回答打字机播完再清光标 (边收边播时立即清会误删正在使用的光标)
      const _aeAgent = evt.agent || "orchestrator";
      // 限流/系统提示条: token 阶段已拦截, 没有专家打字机在跑, 直接清光标收尾即可
      if (_aeAgent !== "orchestrator" && _rateNoticeAgents.has(_aeAgent)) {
        _rateNoticeAgents.delete(_aeAgent);
        removeAllCarets();
        break;
      }
      const _isSubAe = _aeAgent !== "orchestrator" && assistant.subBubbles && assistant.subBubbles[_aeAgent];
      const finishAns = () => removeAllCarets();
      // 回放模式: 打字机没跑, 一次性渲染全部队列文本
      if (REPLAY_MODE) {
        flushAnswerInstant(_isSubAe ? assistant.subBubbles[_aeAgent] : assistant);
        finishAns();
      } else if (_isSubAe) {
        const _subAe = assistant.subBubbles[_aeAgent];
        if (_subAe._ansAnim) _subAe._ansEnd = finishAns;
        else finishAns();
      } else {
        if (assistant._ansAnim) assistant._ansEnd = finishAns;
        else finishAns();
      }
      break;
    }
    case "phase_advanced": {
      const PHASE_LABELS = {1:"扫榜调研",2:"拆书解构",3:"角色架构",4:"大纲搭建",5:"正文写作",6:"毒舌编辑",7:"审核质检",8:"定稿入库"};
      const _phF = evt.from || 0, _phT = evt.to || 1;
      const _phText = `📌 阶段推进: ${_phF}(${PHASE_LABELS[_phF]||""}) → ${_phT}(${PHASE_LABELS[_phT]||""})`;
      // P1: appendThink no-op → 阶段推进条目渲染进主 agent 思考面板
      const phBody = getThinkBody(assistant, "orchestrator");
      if (phBody) {
        const phDiv = document.createElement("div");
        phDiv.className = "st-entry st-delegate";
        phDiv.innerHTML = `<span class="st-delegate-tag">${_phText}</span>`;
        phBody.appendChild(phDiv);
      }
      scrollChat();
      break;
    }
    case "forced_revision": {
      const _frScore = evt.score || 0;
      const _frPhase = evt.phase || 6;
      const _frLbl = _frPhase === 7 ? "审核质检" : "毒舌编辑";
      const _frReason = evt.reason || "不合格";
      // 前端真映射②: 区分"章节终审打回" vs "总编终审打回专家产出" (note/reason 含终审备注)
      const _frIsDeliverable = /终审/.test(_frReason);
      const _frLabel = _frIsDeliverable ? "总编终审" : _frLbl;
      // P1: appendThink no-op → 打回条目渲染进主 agent 思考面板
      const frBody = getThinkBody(assistant, "orchestrator");
      if (frBody) {
        const frDiv = document.createElement("div");
        frDiv.className = "st-entry st-delegate st-delegate-error";
        frDiv.innerHTML = `<span class="st-delegate-tag">↩ 打回 ${_frLabel}评分 ${_frScore}/10 <span class="st-delegate-done-mark">✗</span></span>
          ${_frReason ? `<div class="st-delegate-task">${esc(_frReason)}</div>` : ""}`;
        frBody.appendChild(frDiv);
      }
      // 在主气泡中提示打回重写
      if (bubble) {
        bubble.innerHTML += `<div class="err err-warn">
          <div class="err-icon">↩</div>
          <div class="err-text">${esc(_frLabel)}不通过（评分 ${_frScore}/10），${_frIsDeliverable ? "总编已修订该产出" : "已打回重写"}。审查意见：${esc(evt.review || "")}</div>
        </div>`;
      }
      scrollChat();
      break;
    }
    case "review_passed": {
      const _rpScore = evt.score || 0;
      // 前端真映射②: note 字段 → 总编终审背书语义 (非章节时)
      const _rpIsDeliverable = !!evt.note && /终审背书/.test(evt.note);
      const _rpLabel = _rpIsDeliverable ? "总编终审背书" : "毒舌编辑";
      // P1: appendThink no-op → 通过条目渲染进主 agent 思考面板
      const rpBody = getThinkBody(assistant, "orchestrator");
      if (rpBody) {
        const rpDiv = document.createElement("div");
        rpDiv.className = "st-entry st-delegate st-delegate-done";
        rpDiv.innerHTML = _rpIsDeliverable
          ? `<span class="st-delegate-tag">🎯 ${evt.note} <span class="st-delegate-done-mark">✓</span></span>`
          : `<span class="st-delegate-tag">🔍 通过 毒舌编辑 ${_rpScore}/10 + 审核质检通过，定稿入库 <span class="st-delegate-done-mark">✓</span></span>`;
        rpBody.appendChild(rpDiv);
      }
      scrollChat();
      break;
    }
    case "heartbeat":
      if (window.__naRunStartTs) {
        const elapsed = Math.max(0, Math.round((Date.now() - window.__naRunStartTs) / 1000));
        const hd = document.getElementById("run-elapsed");
        if (hd) {
          hd.hidden = false;
          hd.textContent = elapsed > 0 ? `已运行 ${elapsed}s` : "";
        }
      }
      break;
    case "error": {
      const errMsg = evt.message || "";
      const isApiKeyErr = errMsg.includes("API Key") || errMsg.includes("api_key") || errMsg.includes("Missing credentials");
      const isLoop = evt.reason === "loop_detected" || errMsg.includes("超限") || errMsg.includes("卡循环");
      // 回放模式: 冲刷打字机残留 (回放时打字机不跑, 文本都在队列里)
      if (REPLAY_MODE) { flushPendingThink(assistant); flushAnswerInstant(assistant); }
      // 左侧面板也显示错误 — P1: appendThink no-op → 渲染进主 agent 思考面板
      const erBody = getThinkBody(assistant, "orchestrator");
      if (erBody) {
        const erDiv = document.createElement("div");
        erDiv.className = "st-entry st-delegate st-delegate-error";
        erDiv.innerHTML = `<span class="st-delegate-tag">❌ 错误 <span class="st-delegate-done-mark">✗</span></span>
          <div class="st-delegate-task">${esc(errMsg)}</div>`;
        erBody.appendChild(erDiv);
      }
      if (isApiKeyErr) {
        bubble.innerHTML += `<div class="err err-apikey">
          <div class="err-icon">🔑</div>
          <div class="err-text">${esc(errMsg)}</div>
          <button class="btn primary sm" onclick="$('#settings-btn').click()" style="margin-top:8px">去设置面板配置 API Key</button>
        </div>`;
        if (!REPLAY_MODE) toast("未配置 API Key，请在设置面板中配置", "warn", 8000);
      } else if (isLoop) {
        bubble.innerHTML += `<div class="err err-warn">
          <div class="err-icon">⚠️</div>
          <div class="err-text">${esc(errMsg)}</div>
        </div>`;
        if (!REPLAY_MODE) toast(`⚠️ ${errMsg}`, "warn", 6000);
      } else {
        bubble.innerHTML += `<div class="err">
          <div class="err-icon">❌</div>
          <div class="err-text">${esc(errMsg)}</div>
        </div>`;
      }
      removeAllCarets();
      window.__naRunStartTs = null;
      const hdErr = document.getElementById("run-elapsed");
      if (hdErr) { hdErr.textContent = ""; hdErr.hidden = true; }
      hideThinkPanel();
      break;
    }
    case "done": {
      // 轮次结束: 兜底刷新一次项目数据 —— 防的是"白名单漏了某个工具/工具在子 agent 里跑完没走
      // observation 分支"这类情况。有这层兜底, 就不需要用户手动刷新页面才能看到产出。
      scheduleProjectRefresh();
      // 轮次结束: 主 agent 思考态切 "思考过程" (若还停在 "思考中")
      setMainThinkingState(assistant, false);
      // 轮次结束兜底: 把本轮还敞着的思考面板全部自动收起
      // (有的轮只有思考没正文, 不会触发正文打字机那条折叠路径)
      autoCollapseThink(assistant);
      if (assistant.subBubbles) for (const k of Object.keys(assistant.subBubbles)) autoCollapseThink(assistant.subBubbles[k]);
      removeThinkLoading();
      removeAllCarets();
      // 回放模式: 冲刷打字机残留 (回放时打字机不跑, 文本都在队列里)
      if (REPLAY_MODE) { flushPendingThink(assistant); flushAnswerInstant(assistant); }
      // stats 可能缺失字段 (回放合成的 done / 快路径): 空值保护, 不显示 "undefined章"
      const _statsTxt = (evt.stats && evt.stats.chapters != null) ? ` · ${evt.stats.chapters}章/${evt.stats.totalElements || 0}个元素` : "";
      // 左侧面板: 完成徽章 — P1: appendThink no-op → 渲染进主 agent 思考面板
      const dnBody = getThinkBody(assistant, "orchestrator");
      if (dnBody) {
        const dnDiv = document.createElement("div");
        dnDiv.className = "st-entry st-delegate st-delegate-done";
        dnDiv.innerHTML = `<span class="st-delegate-tag">✓ 完成 · ${evt.steps} 步${_statsTxt}</span>`;
        dnBody.appendChild(dnDiv);
      }
      // 1.5 秒后恢复文件树
      setTimeout(() => hideThinkPanel(), 1500);

      // 收集总编最终输出内容 (用于导出)
      const finalText = assistant.rawBuf || assistant.answerEl?.textContent || "";

      if (!assistant.answerEl) {
        const note = document.createElement("div");
        note.className = "done-note";
        note.textContent = `✓ 完成 (${evt.steps} 步)` + (evt.note ? ` · ${evt.note}` : "");
        bubble.appendChild(note);
      } else {
        const note = document.createElement("div");
        note.className = "done-note muted";
        note.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
        note.innerHTML = `<span>✓ 完成 · ${evt.steps} 步${_statsTxt}</span>`;
        // 导出TXT按钮
        if (finalText.length > 0) {
          const dlBtn = document.createElement("button");
          dlBtn.className = "btn ghost sm";
          dlBtn.style.cssText = "padding:2px 8px;font-size:11px;cursor:pointer";
          dlBtn.textContent = "📄 导出TXT";
          dlBtn.onclick = () => downloadTxt(finalText);
          note.appendChild(dlBtn);
        }
        bubble.appendChild(note);
      }
      updateActiveAgent("orchestrator");
      window.__naRunStartTs = null;
      const hd = document.getElementById("run-elapsed");
      if (hd) { hd.textContent = ""; hd.hidden = true; }
      if (!REPLAY_MODE && currentProject) {
        api(`/api/projects/${currentProject.id}`).then((p) => {
          if (p && currentProject) {
            currentProject.chapters = p.chapters || [];
            currentProject.elements = p.elements || currentProject.meta;
            currentProject.meta = p.meta || currentProject.meta;
            renderTree();
          }
        }).catch(() => {});
      }
      // 阶段确认制: 追加"进入下一阶段"确认按钮 (回放模式不追加 — 历史记录不需要交互按钮)
      if (!REPLAY_MODE && currentProject) {
        api(`/api/projects/${currentProject.id}`).then((proj) => {
          const phase = proj?.currentPhase || proj?.current_phase || 1;
          const PHASE_NAMES = {1:"扫榜调研",2:"拆书解构",3:"角色架构",4:"大纲搭建",5:"正文写作",6:"终审",7:"质检"};
          if (phase < 8) {
            const next = PHASE_NAMES[phase + 1] || "下一步";
            const bar = document.createElement("div");
            bar.className = "phase-confirm-bar";
            bar.style.cssText = "margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;";
            bar.innerHTML = `<span style="font-size:12px;color:var(--muted);">当前阶段 ${phase} 已完成，下一步: <b>${next}</b></span>`;
            const btn = document.createElement("button");
            btn.className = "btn primary sm";
            btn.textContent = "🚀 进入下一阶段";
            btn.style.cssText = "font-size:12px;padding:4px 12px;cursor:pointer;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;";
            btn.onclick = () => { send("继续"); bar.remove(); };
            bar.appendChild(btn);
            bubble.appendChild(bar);
          } else {
            const note2 = document.createElement("div");
            note2.style.cssText = "margin-top:8px;font-size:12px;color:var(--green);";
            note2.textContent = "🎉 全部阶段已完成，可以导出定稿。";
            bubble.appendChild(note2);
          }
          scrollChat();
        }).catch(() => {});
      }
      scrollChat();
      break;
    }
  }
}

function prettyResult(r, tool) {
  let o;
  try {
    o = typeof r === "string" ? JSON.parse(r) : r;
  } catch {
    return `<span class="tb-result-text">${esc(r)}</span>`;
  }
  // 四重校验: 渲染为四项检查卡片 + 总裁决
  if (tool === "four_check" && o && typeof o === "object") {
    return renderFourCheck(o);
  }
  // 交付报告: 渲染为4份可视化报告
  if (tool === "generate_delivery_report" && o && typeof o === "object") {
    return renderDeliveryReport(o);
  }
  return `<span class="tb-result-text">${esc(JSON.stringify(o, null, 2))}</span>`;
}

// ============ 四重校验卡片渲染 ============
function renderFourCheck(o) {
  const allPass = o.all_pass;
  const verdict = o.verdict || (allPass ? "盖章放行" : "打回修改");
  const c1 = o.check1_logic_foreshadow || {};
  const c2 = o.check2_style_consistency || {};
  const c3 = o.check3_milestone_progress || {};
  const c4 = o.check4_character_ooc || {};

  const checkItem = (label, idx, check) => {
    const pass = check.pass;
    const issues = check.issues || [];
    const note = check.note || "";
    const issuesHtml = issues.length
      ? `<ul class="fc-issues">${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
      : "";
    const noteHtml = note ? `<div class="fc-note">${esc(note)}</div>` : "";
    return `<div class="fc-item ${pass ? "pass" : "fail"}">
      <div class="fc-head">
        <span class="fc-idx">检查${idx}</span>
        <span class="fc-label">${esc(label)}</span>
        <span class="fc-status ${pass ? "ok" : "no"}">${pass ? "✓ 通过" : "✗ 不通过"}</span>
      </div>
      ${noteHtml}
      ${issuesHtml}
    </div>`;
  };

  return `<div class="four-check-card ${allPass ? "all-pass" : "has-fail"}">
    <div class="fc-verdict ${allPass ? "pass" : "fail"}">
      <span class="fc-verdict-icon">${allPass ? "✓" : "✗"}</span>
      <span class="fc-verdict-text">${esc(verdict)}</span>
      <span class="fc-verdict-chapter">第${o.chapter_idx ?? "?"}章</span>
    </div>
    ${checkItem("逻辑/事实/伏笔冲突", "①", c1)}
    ${checkItem("文笔风格一致性", "②", c2)}
    ${checkItem("主线推进度", "③", c3)}
    ${checkItem("角色OOC", "④", c4)}
  </div>`;
}

// ============ 交付报告渲染 (4份可视化报告) ============
function renderDeliveryReport(o) {
  const total = o.total_chapters || 0;
  const chapters = o.chapters || [];
  const styleCurve = o.style_consistency_curve || [];
  const milestones = o.milestone_tracking || [];
  const foreshadows = o.foreshadow_status || [];
  const characters = o.character_growth || [];

  // 1. 风格一致性曲线 (按章节字数简易示意)
  const maxChars = Math.max(1, ...chapters.map((c) => c.chars || 0));
  const styleBars = chapters.map((c) => {
    const h = Math.max(4, Math.round(((c.chars || 0) / maxChars) * 60));
    const hasCache = styleCurve.some((s) => s.chapter_idx === c.idx);
    return `<div class="dr-bar-wrap" title="第${c.idx}章 ${c.chars}字${hasCache ? "·有风格缓存" : ""}">
      <div class="dr-bar ${hasCache ? "has-cache" : ""}" style="height:${h}px"></div>
      <div class="dr-bar-idx">${c.idx}</div>
    </div>`;
  }).join("");

  // 2. 主线推进轨迹 (里程碑标注)
  const milestoneRows = milestones.length ? milestones.map((m) => {
    const statusIcon = { reached: "✓", pending: "⏳", missed: "✗" }[m.status] || "·";
    const statusCls = { reached: "ok", pending: "wait", missed: "no" }[m.status] || "";
    return `<tr class="ms-row ${statusCls}">
      <td class="ms-chap">第${m.chapter_idx}章</td>
      <td class="ms-title">${esc(m.title || "")}</td>
      <td class="ms-status">${statusIcon} ${esc(m.status || "")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="3" class="dr-empty">暂无里程碑</td></tr>`;

  // 3. 伏笔回收状态表
  const foreshadowRows = foreshadows.length ? foreshadows.map((f) => {
    const statusIcon = { recovered: "✓", planted: "🌱", abandoned: "✗" }[f.status] || "·";
    const statusCls = { recovered: "ok", planted: "wait", abandoned: "no" }[f.status] || "";
    return `<tr class="fs-row ${statusCls}">
      <td class="fs-name">${esc(f.name || "")}</td>
      <td class="fs-status">${statusIcon} ${esc(f.status || "")}</td>
      <td class="fs-planted">${f.planted != null ? "第" + f.planted + "章" : "—"}</td>
      <td class="fs-recovered">${f.recovered != null ? "第" + f.recovered + "章" : "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="4" class="dr-empty">暂无伏笔</td></tr>`;

  // 4. 角色成长追踪表
  const charRows = characters.length ? characters.map((c) => {
    return `<tr class="cg-row">
      <td class="cg-name">${esc(c.name || "")}</td>
      <td class="cg-arc">${esc(c.arc || "—")}</td>
      <td class="cg-growth">${esc(c.growth_state || "—")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="3" class="dr-empty">暂无角色档案</td></tr>`;

  return `<div class="delivery-report">
    <div class="dr-header">
      <span class="dr-icon">📋</span>
      <span class="dr-title">监制交付报告</span>
      <span class="dr-total">共 ${total} 章定稿</span>
    </div>

    <div class="dr-section">
      <div class="dr-section-title">📊 风格一致性曲线</div>
      <div class="dr-style-curve">${styleBars || '<div class="dr-empty">暂无章节</div>'}</div>
    </div>

    <div class="dr-section">
      <div class="dr-section-title">🎯 主线推进轨迹</div>
      <table class="dr-table ms-table">
        <thead><tr><th>目标章节</th><th>里程碑</th><th>状态</th></tr></thead>
        <tbody>${milestoneRows}</tbody>
      </table>
    </div>

    <div class="dr-section">
      <div class="dr-section-title">🌱 伏笔回收状态</div>
      <table class="dr-table fs-table">
        <thead><tr><th>伏笔</th><th>状态</th><th>埋设</th><th>回收</th></tr></thead>
        <tbody>${foreshadowRows}</tbody>
      </table>
    </div>

    <div class="dr-section">
      <div class="dr-section-title">👤 角色成长追踪</div>
      <table class="dr-table cg-table">
        <thead><tr><th>角色</th><th>人物弧光</th><th>当前成长状态</th></tr></thead>
        <tbody>${charRows}</tbody>
      </table>
    </div>
  </div>`;
}

// ---------- 章节抽屉 (可编辑) ----------
let drawerChapterId = null;

async function openChapter(cid) {
  const p = currentProject;
  const ch = p.chapters.find((c) => c.id === cid);
  if (!ch) return;
  drawerChapterId = cid;
  $("#drawer-title").textContent = ch.title;
  let body = `<h3>梗概</h3>${esc(ch.outline || "(无)")}`;
  body += `<h3>正文 (${(ch.content || "").length} 字)</h3>${esc(ch.content || "(尚未撰写)")}`;
  $("#drawer-body").innerHTML = body;
  $("#drawer-edit-area").value = ch.content || "";
  $("#drawer-body").classList.remove("hidden");
  $("#drawer-edit-area").classList.add("hidden");
  $("#drawer-edit").classList.remove("hidden");
  $("#drawer-save").classList.add("hidden");
  $("#drawer").classList.add("open");
}

$("#drawer-edit").addEventListener("click", () => {
  $("#drawer-body").classList.add("hidden");
  $("#drawer-edit-area").classList.remove("hidden");
  $("#drawer-edit").classList.add("hidden");
  $("#drawer-save").classList.remove("hidden");
});
$("#drawer-save").addEventListener("click", async () => {
  const content = $("#drawer-edit-area").value;
  await api(`/api/chapters/${drawerChapterId}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  toast("章节已保存", "ok");
  // 刷新
  await selectProject(currentProject.id);
  openChapter(drawerChapterId);
});
$("#drawer-close").addEventListener("click", () => $("#drawer").classList.remove("open"));
$("#drawer-back").addEventListener("click", () => $("#drawer").classList.remove("open"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#drawer").classList.contains("open")) {
    $("#drawer").classList.remove("open");
  }
});
$("#view-chapter-btn").addEventListener("click", () => {
  const p = currentProject;
  if (!p || !p.chapters?.length) return toast("暂无章节", "warn");
  openChapter(p.chapters[p.chapters.length - 1].id);
});

// ---------- 新建章节 ----------
$("#new-chapter-btn").addEventListener("click", async () => {
  if (!currentProject) return toast("先选择项目", "warn");
  const title = prompt("章节标题:");
  if (!title) return;
  const idx = (currentProject.chapters || []).length;
  const c = await api(`/api/projects/${currentProject.id}/chapters`, {
    method: "POST",
    body: JSON.stringify({ title, idx, outline: "", content: "" }),
  });
  await selectProject(currentProject.id);
  if (c.id) openChapter(c.id);
  toast("章节已创建", "ok");
});

// ---------- 上传 (toast) ----------
$("#upload-btn").addEventListener("click", () => $("#upload-input").click());
$("#upload-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !currentProject) return;
  const fd = new FormData();
  fd.append("file", file);
  toast(`正在导入 ${file.name}…`, "ok", 1500);
  const res = await fetch(`/api/projects/${currentProject.id}/upload`, {
    method: "POST",
    body: fd,
  });
  const data = await res.json();
  if (data.error) {
    toast(data.error, "err", 5000);
  } else {
    toast(`已导入 ${data.source}: ${data.chunks} 块 / ${data.chars} 字`, "ok", 4000);
  }
  e.target.value = "";
});

// ---------- 导出 ----------
const exportBtn = $("#export-btn");
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!currentProject) return toast("先选择项目", "warn");
  exportBtn.parentElement.classList.toggle("open");
});
document.addEventListener("click", () => {
  exportBtn.parentElement.classList.remove("open");
});
$("#export-menu").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-fmt]");
  if (!btn) return;
  exportBtn.parentElement.classList.remove("open");
  const fmt = btn.dataset.fmt;
  const pid = currentProject.id;
  const url = `/api/projects/${pid}/export?fmt=${fmt}`;
  if (fmt === "html") {
    window.open(url, "_blank");
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`已导出 ${fmt.toUpperCase()}`, "ok");
  }
});

// ---------- 新建项目 ----------

// 频道切换
let selectedAudience = "男频";
document.querySelectorAll("#p-audience .aud-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#p-audience .aud-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedAudience = btn.dataset.val;
    populateGenreSelects(selectedAudience);
  });
});
// 初始化分类下拉
populateGenreSelects(selectedAudience);

$("#proj-cancel").addEventListener("click", () => $("#proj-modal").classList.remove("show"));
$("#proj-ok").addEventListener("click", async () => {
  const genreVal = $("#p-genre").value;
  const themeVal = $("#p-theme").value;
  const body = {
    name: $("#p-name").value.trim(),
    genre: [genreVal, themeVal].filter(Boolean).join(" / "),
    style: $("#p-style").value.trim(),
    premise: $("#p-premise").value.trim(),
    audience: selectedAudience,
  };
  if (!body.name) return toast("请填名称", "warn");
  const p = await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
  $("#proj-modal").classList.remove("show");
  ["p-name", "p-genre", "p-theme", "p-style", "p-premise"].forEach((i) => ($("#" + i).value = ""));
  await loadProjects();
  await selectProject(p.id);
  closeSidebar();
  toast("项目已创建", "ok");
});

// ---------- 添加设定 ----------
$("#add-element-btn").addEventListener("click", () => {
  if (!currentProject) return toast("先选择项目", "warn");
  $("#elem-modal").classList.add("show");
});
$("#elem-cancel").addEventListener("click", () => $("#elem-modal").classList.remove("show"));
$("#elem-ok").addEventListener("click", async () => {
  const body = {
    kind: $("#e-kind").value,
    name: $("#e-name").value.trim(),
    detail: $("#e-detail").value.trim(),
  };
  if (!body.name) return toast("请填名称", "warn");
  await api(`/api/projects/${currentProject.id}/elements`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  $("#elem-modal").classList.remove("show");
  $("#e-name").value = "";
  $("#e-detail").value = "";
  await selectProject(currentProject.id);
  toast("设定已添加", "ok");
});

// ---------- 清空对话 ----------
$("#clear-chat-btn").addEventListener("click", async () => {
  if (!currentProject || !confirm("清空当前项目对话历史?")) return;
  await api(`/api/projects/${currentProject.id}/messages`, { method: "DELETE" });
  showEmpty();
  toast("已清空对话", "ok");
});

// ---------- 侧栏 (桌面默认显示, 移动端抽屉) ----------
function isMobile() { return window.innerWidth <= 860; }
function openSidebar() {
  $("#sidebar").classList.add("open");
  if (isMobile()) $("#scrim").classList.add("show");
}
function closeSidebar() {
  if (isMobile()) {
    $("#sidebar").classList.remove("open");
    $("#scrim").classList.remove("show");
  }
  // 桌面端侧栏始终可见,不关闭
}
function toggleSidebar() {
  if ($("#sidebar").classList.contains("open")) {
    closeSidebar();
  } else {
    openSidebar();
  }
}
// 桌面端:侧栏始终显示,不需要菜单按钮
// 移动端:菜单按钮切换侧栏
if (isMobile()) {
  $("#menu-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleSidebar(); });
} else {
  // 桌面端隐藏菜单按钮
  const mb = $("#menu-btn"); if (mb) mb.style.display = "none";
}
$("#sidebar-close").addEventListener("click", (e) => { e.stopPropagation(); closeSidebar(); });
$("#scrim").addEventListener("click", closeSidebar);
// 窗口大小变化时同步状态
window.addEventListener("resize", () => {
  if (!isMobile()) {
    $("#sidebar").classList.add("open");
    $("#scrim").classList.remove("show");
    const mb = $("#menu-btn"); if (mb) mb.style.display = "none";
  } else {
    const mb = $("#menu-btn"); if (mb) mb.style.display = "";
  }
});

// ---------- composer ----------
// 发送/停止二合一: 任务跑着且输入框为空 → 点了是停止; 其余 → 发送(会自动先停掉上一个任务)
$("#send-btn").addEventListener("click", () => {
  if (chatActive && !$("#input").value.trim()) { onStopBtnClick(); return; }
  send();
});
// 输入框内容变化会改变按钮语义 (有字=发送, 空+任务跑着=停止), 必须联动刷新图标
$("#input").addEventListener("input", updateComposerBtn);

// ---------- 语音输入 (浏览器自带 Web Speech API, 不依赖后端) ----------
// 直接调浏览器的语音识别: 点击开始 → 实时转写到输入框 (不发送) → 再点停止。
// 注意: Chrome/Edge 支持 (webkitSpeechRecognition), 且必须是 localhost 或 https;
// Firefox 不支持 → 按钮点击时提示, 不静默失败。
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRecog = null;      // SpeechRecognition 实例
let voiceActive = false;    // 是否正在录音
let voiceBaseText = "";     // 开始录音时输入框已有内容 (识别文本追加在它后面)

function setVoiceUI(on) {
  const btn = $("#voice-btn");
  if (!btn) return;
  btn.classList.toggle("recording", on);
  btn.title = on ? "正在聆听… 点击停止" : "语音输入 (点击开始, 再点停止)";
}

function stopVoice(notify) {
  voiceActive = false;
  try { voiceRecog && voiceRecog.stop(); } catch {}
  setVoiceUI(false);
  if (notify) toast("语音输入已停止", "ok", 2000);
}

function startVoice() {
  if (!SpeechRecognitionCtor) {
    toast("当前浏览器不支持语音识别 (请用 Chrome / Edge, 且页面要开在 localhost 或 https)", "warn", 4000);
    return;
  }
  if (voiceActive) { stopVoice(true); return; }
  voiceRecog = new SpeechRecognitionCtor();
  voiceRecog.lang = "zh-CN";
  voiceRecog.continuous = true;       // 持续听, 用户手动停 (长指令不用来回点)
  voiceRecog.interimResults = true;   // 边说边显示临时转写, 说完一句才定稿
  voiceBaseText = $("#input").value;
  let finalText = "";
  voiceRecog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    // 整段重建 = 录音前的原文 + 已定稿 + 临时转写, 避免重复追加
    const t = $("#input");
    t.value = (voiceBaseText ? voiceBaseText : "") + finalText + interim;
    autoGrow();
    updateComposerBtn();
  };
  voiceRecog.onerror = (e) => {
    // not-allowed = 用户拒绝了麦克风权限; audio-capture = 没麦克风
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("麦克风权限被拒绝, 请在浏览器地址栏允许麦克风", "warn", 4000);
      stopVoice(false);
    } else if (e.error === "audio-capture") {
      toast("没检测到麦克风设备", "warn");
      stopVoice(false);
    }
    // no-speech / network 等临时错误不打断, 让它继续听
  };
  voiceRecog.onend = () => {
    // continuous=true 时浏览器也会在静音一段时间后自己结束 → 只要用户没点停, 就自动续听
    if (voiceActive) {
      try { voiceRecog.start(); } catch { stopVoice(false); }
    } else {
      setVoiceUI(false);
    }
  };
  try {
    voiceRecog.start();
    voiceActive = true;
    setVoiceUI(true);
    toast("开始聆听, 说话即可 (说完再点一次麦克风停止)", "ok", 2500);
  } catch (e) {
    toast("语音识别启动失败: " + (e && e.message || e), "warn");
  }
}

$("#voice-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  startVoice();
});
// 页面离开时别留着麦克风占用
window.addEventListener("beforeunload", () => { if (voiceActive) stopVoice(false); });
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
function autoGrow() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}
$("#input").addEventListener("input", autoGrow);
// 斜杠命令:输入 / 触发 popup
$("#input").addEventListener("input", (e) => {
  const v = e.target.value;
  if (v.startsWith("/") && !v.includes("\n")) renderSlashPopup(v);
  else { $("#slash-popup").classList.add("hidden"); slashOpen = false; }
});
$("#input").addEventListener("keydown", (e) => {
  if (slashOpen && (e.key === "Enter" || e.key === "Tab")) {
    const sel = $("#slash-popup .slash-item.sel") || $("#slash-popup .slash-item");
    if (sel) { e.preventDefault(); sel.click(); return; }
  }
  if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const items = [...$$("#slash-popup .slash-item")];
    if (!items.length) return;
    let cur = items.findIndex((x) => x.classList.contains("sel"));
    cur = e.key === "ArrowDown" ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
    items.forEach((x) => x.classList.remove("sel"));
    items[cur].classList.add("sel");
  }
});

// 导出辅助(给命令面板用)
async function doExport(fmt) {
  if (!currentProject) return toast("先选择项目", "warn");
  window.location.href = `/api/projects/${currentProject.id}/export?fmt=${fmt}`;
}

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("sugg")) send(e.target.dataset.prompt || e.target.textContent);
  // 点击 step-card 头部切换折叠 (兼容旧)
  const scHead = e.target.closest(".sc-head");
  if (scHead) {
    scHead.closest(".step-card")?.classList.toggle("collapsed");
  }
  // 点击 think-block 头部切换折叠 (新思考链: 反复展开收起)
  const tbHead = e.target.closest(".tb-head");
  if (tbHead) {
    tbHead.closest(".think-block")?.classList.toggle("collapsed");
  }
});

// init
applyTheme(currentTheme);
applyFontScale(currentFontScale);
loadConfig();
loadProjects();
loadAgents();

// 恢复上次打开的项目: 刷新/重启后自动选中, 避免"项目消失"的错觉
(async () => {
  const saved = localStorage.getItem("tianyan_last_project");
  if (saved) {
    try {
      const list = await api("/api/projects");
      if (list.some((p) => p.id === saved)) {
        await selectProject(saved);
        return;
      }
    } catch { /* 项目已被删除则忽略 */ }
    localStorage.removeItem("tianyan_last_project");
  }
  // 无记录或已失效: 自动选中最近创建的项目, 并提示侧边栏有项目列表
  try {
    const list = await api("/api/projects");
    if (list.length && !currentProject) {
      await selectProject(list[0].id);
      toast(`已打开最近项目: ${list[0].name}`, "ok", 4000);
    }
  } catch { /* 无项目 */ }
})();

// ---------- 多 agent 选择器 ----------
function agentBadgesHtml(a) {
  const parts = [];
  if (a.is_entry) parts.push(`<span class="abadge entry">入口</span>`);
  if (a.phase) parts.push(`<span class="abadge phase">阶段 ${esc(a.phase)}</span>`);
  if (a.sandbox === "read-only") {
    parts.push(`<span class="abadge ro" title="只读沙盒,不可写入">🔒 只读</span>`);
  } else if (a.sandbox === "read-write") {
    parts.push(`<span class="abadge rw" title="可读可写">✏️ 可写</span>`);
  }
  if (a.model_tier) {
    const tier = a.model_tier === "high" ? "强" : a.model_tier === "mid" ? "中" : "轻";
    parts.push(`<span class="abadge tier tier-${a.model_tier}" title="模型层级">${tier}</span>`);
  }
  return parts.join("");
}

async function loadAgents() {
  try {
    const data = await api("/api/agents");
    agentsList = data.agents || [];
    currentAgent = data.default || "orchestrator";
    activeAgent = currentAgent;
    workflowPhases = data.workflow_phases || [];
    readonlyAgents = data.readonly_agents || [];
    updateActiveAgent(currentAgent);   // 初始化芯片
    renderWorkflowPhases();
  } catch (e) {
    console.warn("load agents failed", e);
  }
}

// OpenClaw 模式:更新活跃 agent 状态(前端不显示,纯内部状态,orchestrator 自动委派时用)
function updateActiveAgent(name) {
  activeAgent = name;
}

// 打开 Agent Panel(展示当前活跃 agent 的 memory/tools/指令栈,只读)
function openAgentPanel() {
  const a = agentsList.find((x) => x.name === activeAgent);
  const body = $("#ap-body");
  const title = $("#ap-title");
  if (!a) {
    title.textContent = "Agent";
    body.innerHTML = `<p class="muted">暂无活跃 agent 信息</p>`;
  } else {
    title.innerHTML = `<span style="font-size:18px">${a.icon}</span> ${esc(a.label)}`;
    const toolsList = (a.tools || []).map((t) => `<span class="ap-tool">${esc(t)}</span>`).join("");
    body.innerHTML = `
      <div class="ap-sec">
        <div class="ap-sec-title">角色</div>
        <div class="ap-role">${esc(a.role || "(无描述)")}</div>
      </div>
      <div class="ap-sec">
        <div class="ap-sec-title">阶段</div>
        <div class="ap-meta">${esc(a.phase || "全局")}</div>
      </div>
      <div class="ap-sec">
        <div class="ap-sec-title">沙盒</div>
        <div class="ap-meta">
          <span class="abadge ${a.sandbox === "read-only" ? "ro" : "rw"}">
            ${a.sandbox === "read-only" ? "🔒 只读" : "✏️ 可写"}
          </span>
          <span class="abadge tier tier-${a.model_tier || "mid"}">
            ${a.model_tier === "high" ? "强" : a.model_tier === "mid" ? "中" : "轻"}模型
          </span>
        </div>
      </div>
      <div class="ap-sec">
        <div class="ap-sec-title">可用工具 (${(a.tools || []).length})</div>
        <div class="ap-tools">${toolsList || "<span class='muted'>(无)</span>"}</div>
      </div>
      <div class="ap-sec">
        <div class="ap-sec-title">说明</div>
        <div class="ap-note">入口固定为「总编 orchestrator」,它会根据任务自动委派给对应专家 agent。这里显示的是当前活跃 agent 的实时状态。</div>
      </div>
    `;
  }
  $("#agent-panel").classList.add("open");
}

function renderWorkflowPhases() {
  const el = $("#workflow-phases");
  if (!el) return;
  if (!workflowPhases.length) { el.innerHTML = ""; return; }
  el.innerHTML = workflowPhases.map((p, i) => {
    const agents = p.agents || (p.agent ? [p.agent] : []);
    const icons = agents.map((n) => {
      const a = agentsList.find((x) => x.name === n);
      return a ? `<span class="wf-agent" title="${esc(a.label)}">${a.icon}</span>` : "";
    }).join("");
    // 循环标识:打回重写 / 下一章循环
    const loopBadge = p.loop === "reject"
      ? `<span class="wf-loop reject" title="不通过则打回重写">↺ 打回</span>`
      : p.loop === "next-chapter"
      ? `<span class="wf-loop next" title="通过则推进下一章">↻ 循环</span>`
      : "";
    // 阶段间箭头
    const arrow = i < workflowPhases.length - 1 ? `<div class="wf-arrow">↓</div>` : "";
    return `<div class="wf-item">
      <span class="wf-no">${p.phase}</span>
      <span class="wf-body">
        <span class="wf-name">${esc(p.name)} ${loopBadge}</span>
        <span class="wf-desc">${esc(p.description || "")}</span>
        <span class="wf-agents">${icons}</span>
      </span>
    </div>${arrow}`;
  }).join("");
}

// Agent toggle 已从前端移除 — 用户不直接选 agent,orchestrator 自动委派
// openAgentPanel/openAgentPanel 函数保留(命令面板 ⌘K 仍可调出 Agent 详情查看)
$("#ap-close").addEventListener("click", () => $("#agent-panel").classList.remove("open"));

// ==================== 命令面板 (⌘K / Ctrl+K) ====================
const CMDK_ITEMS = [
  { id: "new-project", icon: "📁", label: "新建项目", action: () => $("#proj-modal").classList.add("show") },
  { id: "switch-project", icon: "📂", label: "切换项目", action: () => $("#proj-select-btn").click() },
  { id: "upload", icon: "📤", label: "上传素材", action: () => $("#upload-input").click() },
  { id: "export-txt", icon: "📄", label: "导出 TXT", action: () => doExport("txt") },
  { id: "export-docx", icon: "📘", label: "导出 Word", action: () => doExport("docx") },
  { id: "view-chapters", icon: "📑", label: "查看章节列表", action: () => $("#view-chapter-btn").click() },
  { id: "settings", icon: "⚙️", label: "打开设置", action: () => $("#settings-btn").click() },
  { id: "agent-panel", icon: "🎯", label: "查看活跃 Agent", action: () => openAgentPanel() },
  { id: "clear-chat", icon: "🗑", label: "清空对话", action: () => $("#clear-chat-btn").click() },
  { id: "cmd-continue", icon: "✍️", label: "续写最近一章", action: () => send("继续续写最近一章,2000字") },
  { id: "cmd-status", icon: "📊", label: "查看项目状态", action: () => send("查看当前项目状态与进度") },
  { id: "cmd-check", icon: "🔍", label: "质量检查", action: () => send("对最近一章做质量检查") },
];

function openCmdk() {
  $("#cmdk-overlay").classList.remove("hidden");
  $("#cmdk-input").value = "";
  renderCmdk("");
  setTimeout(() => $("#cmdk-input").focus(), 50);
}
function closeCmdk() {
  $("#cmdk-overlay").classList.add("hidden");
}
function renderCmdk(q) {
  const ql = q.toLowerCase().trim();
  const items = !ql ? CMDK_ITEMS : CMDK_ITEMS.filter((it) =>
    it.label.toLowerCase().includes(ql) || it.id.includes(ql));
  $("#cmdk-list").innerHTML = items.map((it, i) =>
    `<button class="cmdk-item${i === 0 ? " sel" : ""}" data-id="${it.id}">
      <span class="cmdk-icon">${it.icon}</span><span class="cmdk-text">${esc(it.label)}</span>
    </button>`).join("") || `<div class="cmdk-empty">无匹配</div>`;
  $("#cmdk-list").querySelectorAll(".cmdk-item").forEach((el) => {
    el.onclick = () => {
      const it = CMDK_ITEMS.find((x) => x.id === el.dataset.id);
      if (it) { closeCmdk(); it.action(); }
    };
  });
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#cmdk-overlay").classList.contains("hidden") ? openCmdk() : closeCmdk();
  }
  if (e.key === "Escape") closeCmdk();
});
$("#cmdk-input").addEventListener("input", (e) => renderCmdk(e.target.value));
$("#cmdk-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const sel = $("#cmdk-list .cmdk-item.sel") || $("#cmdk-list .cmdk-item");
    if (sel) sel.click();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...$$("#cmdk-list .cmdk-item")];
    if (!items.length) return;
    let cur = items.findIndex((x) => x.classList.contains("sel"));
    cur = e.key === "ArrowDown" ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
    items.forEach((x) => x.classList.remove("sel"));
    items[cur].classList.add("sel");
    items[cur].scrollIntoView({ block: "nearest" });
  }
});
$("#cmdk-overlay").addEventListener("click", (e) => {
  if (e.target.id === "cmdk-overlay") closeCmdk();
});

// ==================== 斜杠命令 (在输入框输入 / 触发) ====================
const SLASH_COMMANDS = [
  { cmd: "/续写", desc: "续写最近一章", fill: "继续续写最近一章,2000字" },
  { cmd: "/状态", desc: "查看项目状态", fill: "查看当前项目状态与进度" },
  { cmd: "/质检", desc: "质量检查", fill: "对最近一章做质量检查" },
  { cmd: "/大纲", desc: "生成大纲", fill: "帮我构思一个大纲,12章" },
  { cmd: "/设定", desc: "添加设定", fill: "帮我添加一个角色设定" },
  { cmd: "/润色", desc: "润色最近一章", fill: "润色最近一章,增强感染力" },
  { cmd: "/清空", desc: "清空对话", fill: null, action: () => $("#clear-chat-btn").click() },
  { cmd: "/设置", desc: "打开设置", fill: null, action: () => $("#settings-btn").click() },
  { cmd: "/导出", desc: "导出", fill: null, action: () => $("#export-btn").click() },
];
let slashOpen = false;
function renderSlashPopup(q) {
  const items = SLASH_COMMANDS.filter((s) => !q || s.cmd.includes(q.slice(1)) || s.desc.includes(q));
  const pop = $("#slash-popup");
  if (!items.length) { pop.classList.add("hidden"); slashOpen = false; return; }
  pop.classList.remove("hidden");
  slashOpen = true;
  pop.innerHTML = items.map((s, i) =>
    `<button class="slash-item${i === 0 ? " sel" : ""}" data-fill="${esc(s.fill || "")}" data-cmd="${esc(s.cmd)}">
      <span class="slash-cmd">${esc(s.cmd)}</span><span class="slash-desc">${esc(s.desc)}</span>
    </button>`).join("");
  pop.querySelectorAll(".slash-item").forEach((el) => {
    el.onclick = () => {
      const cmd = SLASH_COMMANDS.find((s) => s.cmd === el.dataset.cmd);
      if (cmd) {
        if (cmd.action) { cmd.action(); $("#input").value = ""; }
        else if (cmd.fill) { $("#input").value = cmd.fill; }
        pop.classList.add("hidden"); slashOpen = false;
        $("#input").focus(); autoGrow();
      }
    };
  });
}

// ==================== 设置面板 ====================
let spData = null; // 当前设置数据
let spSelectedProvider = null; // 添加模型时选中的厂商
let spBaseMap = {}; // 模型 -> 厂商默认 base

// 模型 ID → 友好显示名 (设置面板"当前模型"用, 避免用户认不出 deepseek-flash 就是 V4.1)
const MODEL_FRIENDLY = {
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4.1 Flash (旧别名)",
  "deepseek-v4-flash-vision-exp": "DeepSeek V4.1 Flash (视觉实验别名)",
};
function friendlyModelName(modelId) {
  const id = String(modelId || "");
  const bare = id.split("/").pop();
  const provPrefix = id.split("/", 1)[0];
  const prov = (spData?.providers || []).find((x) => x.provider === provPrefix);
  const provLabel = prov ? prov.label : "";
  const friendly = MODEL_FRIENDLY[bare] || bare;
  // 友好名已含厂商名时不重复前缀
  if (provLabel && !friendly.toLowerCase().startsWith(provLabel.split(" ")[0].toLowerCase())) {
    return `${provLabel} · ${friendly}`;
  }
  return friendly;
}

$("#settings-btn").addEventListener("click", async () => {
  $("#settings-panel").classList.add("open");
  await loadSettings();
});
$("#sp-close").addEventListener("click", () => $("#settings-panel").classList.remove("open"));

// ---------- 技能市场 (Skill Market) ----------
let skData = null; // {skills: [...], status: {...}}

$("#skills-btn").addEventListener("click", async () => {
  $("#skills-panel").classList.add("open");
  await loadSkills();
});
$("#skp-close").addEventListener("click", () => $("#skills-panel").classList.remove("open"));

// Tab 切换
$$(".skp-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".skp-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("#skp-builtin").classList.toggle("hidden", which !== "builtin");
    $("#skp-custom").classList.toggle("hidden", which !== "custom");
    $("#skp-add").classList.toggle("hidden", which !== "add");
  });
});

// 添加自定义技能表单
$("#sk-save").addEventListener("click", async () => {
  const name = $("#sk-name").value.trim();
  const label = $("#sk-label").value.trim();
  const icon = $("#sk-icon").value.trim() || "⭐";
  const description = $("#sk-desc").value.trim();
  const prompt = $("#sk-prompt").value.trim();
  const agents = Array.from($$("#sk-agents input:checked")).map((c) => c.value);
  if (!name || !label || !prompt) {
    toast("请填写技能名、显示名、Prompt", "err");
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    toast("技能名只能含英文/数字/下划线", "err");
    return;
  }
  if (agents.length === 0) {
    toast("至少选一个适用 Agent", "err");
    return;
  }
  $("#sk-save").disabled = true;
  try {
    const res = await api("/api/skills/custom", {
      method: "POST",
      body: JSON.stringify({ name, label, icon, description, prompt, agents }),
    });
    if (res.error) {
      toast(res.error, "err");
      return;
    }
    toast(`已添加技能: ${label}`, "ok");
    // 清空表单
    $("#sk-name").value = "";
    $("#sk-label").value = "";
    $("#sk-icon").value = "";
    $("#sk-desc").value = "";
    $("#sk-prompt").value = "";
    // 切回自定义 Tab 并刷新
    document.querySelector('.skp-tab[data-tab="custom"]').click();
    await loadSkills();
  } catch (e) {
    toast("保存失败: " + e.message, "err");
  } finally {
    $("#sk-save").disabled = false;
  }
});
$("#sk-reset").addEventListener("click", () => {
  $("#sk-name").value = "";
  $("#sk-label").value = "";
  $("#sk-icon").value = "";
  $("#sk-desc").value = "";
  $("#sk-prompt").value = "";
});

async function loadSkills() {
  try {
    skData = await api("/api/skills");
    renderSkills();
  } catch (e) {
    $("#skp-status").textContent = "加载失败: " + e.message;
  }
}

function renderSkills() {
  if (!skData) return;
  const skills = skData.skills || [];
  const builtin = skills;
  const custom = skData.custom || [];

  // 状态汇总
  const allSkills = builtin.concat(custom);
  const enabledCount = allSkills.filter((s) => s.enabled).length;
  const totalCount = allSkills.length;
  const totalUsage = 0;
  $("#skp-status").innerHTML =
    `已启用 <b>${enabledCount}</b> / ${totalCount} 项　·　内置 ${builtin.length} / 自定义 ${custom.length}`;

  // 内置 grid
  $("#skp-builtin-grid").innerHTML = builtin.map(renderSkillCard).join("");

  // 自定义 grid
  if (custom.length === 0) {
    $("#skp-custom-grid").innerHTML = "";
    $("#skp-custom-empty").classList.remove("hidden");
  } else {
    $("#skp-custom-grid").innerHTML = custom.map((s) => renderSkillCard({ ...s, kind: "custom" })).join("");
    $("#skp-custom-empty").classList.add("hidden");
  }

  // 绑定开关 + 删除按钮
  $$("#skp-builtin-grid .skill-toggle input").forEach((inp) => {
    inp.addEventListener("change", () => toggleSkill(inp.dataset.name));
  });
  $$("#skp-custom-grid .skill-toggle input").forEach((inp) => {
    inp.addEventListener("change", () => toggleSkill(inp.dataset.name));
  });
  $$("#skp-custom-grid .sc-del").forEach((btn) => {
    btn.addEventListener("click", () => deleteCustomSkill(btn.dataset.name));
  });
}

function renderSkillCard(s) {
  const agents = (s.agents || []).map((a) => `<span class="a-chip">${esc(a)}</span>`).join("");
  const catLabel = s.category || (s.kind === "custom" ? "custom" : "");
  const usage = s.usage || 0;
  const toggle = `<label class="skill-toggle">
    <input type="checkbox" data-name="${esc(s.name)}" ${s.enabled ? "checked" : ""} />
    <span class="track"></span>
  </label>`;
  const delBtn = s.kind === "custom"
    ? `<button class="sc-del" data-name="${esc(s.name)}" title="删除">🗑</button>`
    : "";
  return `<div class="skill-card ${s.enabled ? "enabled" : "disabled"}">
    <div class="sc-head">
      <span class="sc-icon">${esc(s.icon || "⭐")}</span>
      <span class="sc-name">${esc(s.label || s.name)}</span>
      <span class="sc-cat ${esc(catLabel)}">${esc(catLabel || "skill")}</span>
    </div>
    ${s.description ? `<div class="sc-desc">${esc(s.description)}</div>` : ""}
    <div class="sc-meta">
      <div class="agents">${agents}</div>
      <span class="usage">×${usage}</span>
    </div>
    <div class="sc-actions">
      ${delBtn}
      ${toggle}
    </div>
  </div>`;
}

async function toggleSkill(name) {
  try {
    const res = await api(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: "POST", body: "{}" });
    if (res.error) {
      toast(res.error, "err");
      await loadSkills();
      return;
    }
    // 局部更新 (避免整列表闪烁) — 内置在 skills, 自定义在 custom
    if (skData) {
      const s = skData.skills.find((x) => x.name === name);
      if (s) s.enabled = res.enabled;
      else {
        const cs = skData.custom.find((x) => x.name === name);
        if (cs) cs.enabled = res.enabled;
      }
      renderSkills();
    }
    toast(`${name} 已${res.enabled ? "启用" : "禁用"}`, "ok", 1500);
  } catch (e) {
    toast("切换失败: " + e.message, "err");
    await loadSkills();
  }
}

async function deleteCustomSkill(name) {
  if (!confirm(`确定删除技能「${name}」?`)) return;
  try {
    const res = await api(`/api/skills/custom/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.error) {
      toast(res.error, "err");
      return;
    }
    toast(`已删除: ${name}`, "ok");
    await loadSkills();
  } catch (e) {
    toast("删除失败: " + e.message, "err");
  }
}

async function loadSettings() {
  spData = await api("/api/settings");
  spSelectedProvider = null;
  // 构建模型 -> 厂商预设 base 的反查表
  spBaseMap = {};
  for (const p of (spData.providers || [])) {
    if (!p.api_base) continue;
    for (const m of p.models) spBaseMap[m] = p.api_base;
  }
  // 拉取档位 → 模型 映射 (识别闭环)
  try {
    const tierData = await api("/api/settings/tier-model");
    spData.tiers = tierData.tiers || {};
    spData.tierPreview = tierData.preview || {};
  } catch { spData.tiers = {}; spData.tierPreview = {}; }
  renderSettings();
}

async function refreshTierPreview() {
  try {
    const r = await api("/api/settings/tier-model");
    spData.tierPreview = r.preview || {};
    const el = $("#sp-tier-preview");
    if (el) {
      const L = { orchestrator: "总编", "story-architect": "架构师", "narrative-writer": "主笔", "character-designer": "角色师", "consistency-checker": "质检员", "story-explorer": "资料员", presenter: "监制" };
      el.textContent = "识别预览: " + Object.entries(r.preview || {}).map(([a, p]) => `${L[a] || a}[${p.tier}]→${(p.model || "").split("/").pop()}`).join(" · ") || "无";
    }
  } catch { /* 预览失败不阻塞 */ }
}

// 根据模型名找厂商默认 base
function defaultBaseFor(model) {
  if (!spBaseMap) return "";
  if (spBaseMap[model]) return spBaseMap[model];
  // 按 provider 前缀匹配
  const prov = model.split("/", 1)[0];
  const p = (spData?.providers || []).find((x) => x.provider === prov);
  return p?.api_base || "";
}

function renderSettings() {
  const d = spData;
  const parts = [];

  // ---- 外观 (主题 + 字号) ----
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">外观</div>`);
  parts.push(`<div class="sp-field"><span class="lbl">主题配色</span>
    <div class="theme-grid">`);
  for (const [key, t] of Object.entries(THEMES)) {
    const active = key === currentTheme ? "active" : "";
    const sw = t.vars["--paper"];
    const sw2 = t.vars["--accent"];
    parts.push(`<button class="theme-swatch ${active}" data-theme="${key}" title="${t.label}">
      <span class="sw-color" style="background:${sw};border-color:${sw2}"></span>
      <span class="sw-label">${t.label}</span>
    </button>`);
  }
  parts.push(`</div></div>`);
  parts.push(`<div class="sp-field"><span class="lbl" id="sp-fontscale-label">字号缩放 (当前 ${currentFontScale.toFixed(2)}x)</span>
    <div class="font-scale-row">
      <input type="range" id="sp-fontscale" min="0.8" max="1.6" step="0.05" value="${currentFontScale}" />
      <span class="font-scale-hint">0.8x 小 / 1.0x 默认 / 1.6x 大 (拖动实时预览)</span>
    </div>
  </div>`);
  parts.push(`</div>`);

  // ---- 当前模型 ----
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">当前模型</div>`);
  parts.push(`<div class="sp-row"><label title="${esc(d.default)}">${esc(friendlyModelName(d.default))} <span class="muted" style="font-size:11px">(${esc(d.default)})</span></label>
    <span class="mc-badge ${d.ready ? "ok" : "warn"}">${d.ready ? "就绪" : "缺 Key"}</span></div>`);
  // 「测试连接」: 后端 /api/config/test-connection 一直存在但前端从没接入,
  // 用户换模型/换 Key 后只能"发一句话试试才知道通不通"。这里补上入口, 真发一次最小请求验证。
  parts.push(`<div class="sp-row"><button class="btn sm" id="sp-test-conn">🔌 测试连接</button>
    <span class="muted" id="sp-test-conn-result" style="font-size:11px"></span></div>`);
  parts.push(`</div>`);

  // ---- 已配置模型列表 ----
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">已配置模型 (${d.models.length})</div>`);
  if (d.models.length === 0) {
    // 删空后: 显示空状态提示,引导用户去下方"+ 添加模型"区块添加
    parts.push(`<div class="mc-empty">
      <div class="mc-empty-icon">📭</div>
      <p>暂无已配置模型</p>
      <p class="muted">在下方"+ 添加模型"区块选择厂商或填自定义模型名</p>
    </div>`);
  }
  for (const m of d.models) {
    const badges = [];
    if (m.is_default) badges.push(`<span class="mc-badge def">默认</span>`);
    badges.push(`<span class="mc-badge ${m.ready ? "ok" : "warn"}">${m.ready ? "就绪" : "缺Key"}</span>`);
    const defBase = defaultBaseFor(m.model);
    const curBase = m.api_base || "";
    const isOfficial = !curBase || (defBase && curBase === defBase);
    // 官方默认地址不显示输入框,只展示只读徽章;自定义时才显示可编辑输入框
    const baseField = isOfficial
      ? `<div class="sp-field"><span class="lbl" style="color:var(--green)">API Base · 官方默认 ✓</span>
          <div class="sp-readonly">${esc(defBase || "—")}</div></div>`
      : `<div class="sp-field"><span class="lbl">API Base · 自定义</span>
          <input class="sp-input" data-base="${esc(m.model)}" placeholder="${esc(defBase || "")}" value="${esc(curBase)}" /></div>`;
    parts.push(`<div class="model-card ${m.is_default ? "default" : ""}">
      <div class="mc-head">
        <span class="mc-name" title="${esc(m.model)}">${esc(friendlyModelName(m.model))}</span>
        ${badges.join("")}
        <button class="mc-setdef" data-model="${esc(m.model)}" title="设为默认">★</button>
        <button class="mc-del" data-model="${esc(m.model)}" title="删除">✕</button>
      </div>
      <div class="mc-fields">
        <div class="sp-field">
          <span class="lbl">API Key ${m.api_key_set ? "(已设置)" : ""}</span>
          <input class="sp-input" type="password" data-key="${esc(m.model)}" placeholder="${m.api_key_set ? "•••••• (留空保留)" : "粘贴 API Key"}" value="" />
        </div>
        ${baseField}
        <div class="sp-row">
          <div class="sp-field" style="flex:1"><span class="lbl">Temperature</span>
            <input class="sp-input small" type="number" step="0.1" min="0" max="2" data-temp="${esc(m.model)}" value="${m.temperature}" /></div>
          <div class="sp-field" style="flex:1"><span class="lbl">Max Tokens</span>
            <input class="sp-input small" type="number" step="256" data-tok="${esc(m.model)}" value="${m.max_tokens}" /></div>
        </div>
        <button class="btn primary sm mc-save" data-model="${esc(m.model)}">保存此模型配置</button>
      </div>
    </div>`);
  }
  parts.push(`</div>`);

  // ---- 添加自定义模型 ----
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">+ 添加模型</div>`);
  parts.push(`<div class="add-model">`);
  // 厂商快捷
  parts.push(`<div class="provider-pick">`);
  for (const p of d.providers) {
    parts.push(`<button class="pp-btn" data-provider="${p.provider}">${p.label}</button>`);
  }
  parts.push(`</div>`);
  // 选中厂商后显示预设模型
  if (spSelectedProvider) {
    const p = d.providers.find((x) => x.provider === spSelectedProvider);
    if (p) {
      if (p.api_base) parts.push(`<p class="hint" style="margin-bottom:6px">端点(已自动填入,无需修改):<code>${esc(p.api_base)}</code></p>`);
      parts.push(`<div class="pp-models">`);
      for (const m of p.models) {
        parts.push(`<button class="pm-btn" data-addmodel="${esc(m)}" data-base="${esc(p.api_base || "")}">+ ${esc(m)}</button>`);
      }
      parts.push(`</div>`);
      if (p.env) parts.push(`<p class="hint">环境变量 ${p.env} 也可配置 Key</p>`);
    }
  }
  // 自定义模型入口:可填模型名 + 自定义地址 + 密钥
  parts.push(`<div class="sp-field custom-model-box" style="margin-top:12px">
    <span class="lbl">+ 自定义模型 (填模型名/地址/密钥)</span>
    <div class="sp-row">
      <input class="sp-input" id="sp-custom-model" placeholder="模型名 (如 openai/my-model 或 ollama/llama3)" />
    </div>
    <div class="sp-row">
      <input class="sp-input" id="sp-custom-base" placeholder="API Base 自定义端点 (可留空走厂商默认)" />
    </div>
    <div class="sp-row">
      <input class="sp-input" id="sp-custom-key" type="password" placeholder="API Key 密钥 (可留空走环境变量)" />
      <button class="btn primary sm" id="sp-add-custom">添加自定义</button>
    </div>
    <p class="hint">格式: provider/model。密钥留空时后端会读对应环境变量;地址留空时用厂商默认。</p>
  </div>`);

  // ---- 从服务端拉取所有模型 (对齐 Hermes: GET {base}/v1/models) ----
  parts.push(`<div class="sp-field" style="margin-top:14px; border:1px dashed var(--border); border-radius:10px; padding:12px; background:var(--bg-soft)">
    <span class="lbl" style="font-weight:600">🔍 从服务端拉取所有模型 (Live Discover)</span>
    <p class="hint" style="margin:6px 0">对你已配置某个模型的 key/端点, 直接调它的 /v1/models 拿回真实可用的全部模型清单 (Ollama 走 /api/tags)。比预设清单更全、更新。</p>
    <div class="sp-row">
      <select class="sp-input small" id="sp-discover-model">
        ${(d.models || []).map((m) => `<option value="${esc(m.model)}">${esc(m.model)}</option>`).join("") || ""}
      </select>
      <button class="btn primary sm" id="sp-discover-btn">拉取</button>
    </div>
    <div id="sp-discover-result" style="display:none; margin-top:10px">
      <p class="hint" id="sp-discover-meta"></p>
      <div id="sp-discover-list" class="pp-models" style="max-height:180px; overflow:auto"></div>
    </div>
  </div>`);
  parts.push(`</div></div>`);

  // ---- Agent 参数 ----
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">Agent 参数 · 全局</div>`);
  parts.push(`<div class="sp-row"><label>最大步数 (工具调用轮次)</label>
    <input class="sp-input small" type="number" id="sp-maxsteps" value="${d.max_steps}" min="1" max="30" /></div>`);
  parts.push(`<div class="sp-row"><label>素材分块大小 (字符)</label>
    <input class="sp-input small" type="number" id="sp-chunksize" value="${d.chunk_size}" min="200" step="200" /></div>`);
  parts.push(`<div class="sp-row"><label>续写检索块数</label>
    <input class="sp-input small" type="number" id="sp-retrievek" value="${d.retrieve_k}" min="1" max="20" /></div>`);
  parts.push(`<button class="btn primary" id="sp-save-agent" style="margin-top:8px">保存全局参数</button>`);
  parts.push(`</div>`);

  // ---- 模型档位 → 模型 映射 (识别闭环: 7 agent 不再共用 defaultModel) ----
  const tierLabels = { high: "高 (旗舰)", mid: "中 (均衡)", low: "低 (轻量)" };
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">模型档位 → 模型 (识别映射)</div>`);
  parts.push(`<p class="hint" style="margin:4px 0 10px">每个 Agent 按 model_tier 档解析到实际模型。不填则落回默认模型。保存后总编/主笔/质检员等 7 个 agent 各用对应档位的模型。</p>`);
  for (const t of ["high", "mid", "low"]) {
    parts.push(`<div class="sp-row"><label style="min-width:90px">${tierLabels[t]}</label>
      <select class="sp-input small tier-model-sel" data-tier="${t}">
        <option value="">(落回默认模型)</option>
        ${(d.models || []).map((m) => `<option value="${esc(m.model)}" ${(d.tiers || {})[t] === m.model ? "selected" : ""}>${esc(m.model.split("/").pop())}</option>`).join("") || ""}
      </select></div>`);
  }
  parts.push(`<button class="btn primary" id="sp-save-tier" style="margin-top:8px">保存档位映射</button>`);
  parts.push(`<p class="hint tier-preview" id="sp-tier-preview" style="margin-top:6px"></p>`);
  parts.push(`</div>`);

  // ---- Agent 参数: 每个 Agent 的具体参数 (默认值可调整) ----
  const agentMeta = (d.agents || {});
  const AGENT_LABELS = {
    orchestrator: "总编 (天衍)", "story-architect": "架构师", "narrative-writer": "主笔",
    "character-designer": "角色师", "consistency-checker": "质检员", "story-explorer": "资料员", presenter: "监制"
  };
  const tierNames = { high: "高 (旗舰)", mid: "中 (均衡)", low: "低 (轻量)" };
  parts.push(`<div class="sp-sec"><div class="sp-sec-title">Agent 参数 · 各Agent默认值</div>`);
  parts.push(`<p class="hint" style="margin:4px 0 10px">修改后点击该卡片的「保存」生效；留空/不改动的字段保持默认值。</p>`);
  const agentNames = Object.keys(agentMeta).length ? Object.keys(agentMeta) : [
    "orchestrator", "story-architect", "narrative-writer", "character-designer",
    "consistency-checker", "story-explorer", "presenter"
  ];
  for (const an of agentNames) {
    const a = agentMeta[an] || {};
    const label = AGENT_LABELS[an] || an;
    const tier = tierNames[a.modelTier] || a.modelTier || "中 (均衡)";
    const rd = a.readonly ? "只读" : "读+写";
    parts.push(`<div class="agent-card" data-agent="${esc(an)}">
      <div class="mc-head"><span class="mc-name">${esc(label)}</span>
        <span class="mc-badge ${a.readonly ? "warn" : "ok"}">${rd}</span>
        <span class="mc-badge">${esc(tier)}</span></div>
      <div class="mc-fields">
        <div class="sp-row">
          <div class="sp-field" style="flex:1"><span class="lbl">委派深度 (max_depth)</span>
            <input class="sp-input small" type="number" min="1" max="5" data-ad="max_depth" value="${a.maxDepth ?? ""}" /></div>
          <div class="sp-field" style="flex:1"><span class="lbl">最大轮次 (max_turns)</span>
            <input class="sp-input small" type="number" min="1" max="30" data-ad="max_turns" value="${a.maxTurns ?? ""}" /></div>
          <div class="sp-field" style="flex:1"><span class="lbl">最大步数 (max_steps)</span>
            <input class="sp-input small" type="number" min="1" max="50" data-ad="max_steps" value="${a.maxSteps ?? ""}" /></div>
        </div>
        <div class="sp-row">
          <div class="sp-field" style="flex:1"><span class="lbl">模型档位 (model_tier)</span>
            <select class="sp-input small" data-ad="model_tier">
              <option value="high" ${a.modelTier === "high" ? "selected" : ""}>高 (旗舰)</option>
              <option value="mid" ${a.modelTier === "mid" ? "selected" : ""}>中 (均衡)</option>
              <option value="low" ${a.modelTier === "low" ? "selected" : ""}>低 (轻量)</option>
            </select></div>
          <div class="sp-field" style="flex:1"><span class="lbl">只读</span>
            <select class="sp-input small" data-ad="readonly">
              <option value="false" ${!a.readonly ? "selected" : ""}>可读写</option>
              <option value="true" ${a.readonly ? "selected" : ""}>只读</option>
            </select></div>
          <button class="btn primary sm ag-save" data-agent="${esc(an)}" style="margin-top:22px">保存</button>
        </div>
      </div>
    </div>`);
  }
  parts.push(`</div>`);

  $("#sp-body").innerHTML = parts.join("");
  bindSettings();
}

function bindSettings() {
  // 主题切换
  $$("#sp-body .theme-swatch").forEach((b) => {
    b.onclick = () => {
      applyTheme(b.dataset.theme);
      renderSettings();
    };
  });
  // 字号滑块 (拖动实时预览,不重新渲染面板)
  const fs = $("#sp-fontscale");
  if (fs) {
    fs.oninput = (e) => applyFontScale(parseFloat(e.target.value));
  }
  // 选中厂商
  $$("#sp-body .pp-btn").forEach((b) => {
    b.onclick = () => {
      spSelectedProvider = b.dataset.provider;
      renderSettings();
    };
  });
  // 添加预设模型
  $$("#sp-body .pm-btn").forEach((b) => {
    b.onclick = async () => {
      const model = b.dataset.addmodel;
      const defBase = b.dataset.base || "";
      try {
        await api("/api/settings/model", {
          method: "PUT",
          body: JSON.stringify({ model, api_key: "", api_base: defBase, temperature: 0.8, max_tokens: 4096 }),
        });
        toast(`已添加 ${model}`, "ok");
        await loadSettings();
      } catch (e) {
        // api() 已 toast 错误,这里只兜底防止 await 链中断导致按钮看似"卡死"
      }
    };
  });
  // 添加自定义模型 (模型名 + 自定义地址 + 密钥)
  const addBtn = $("#sp-add-custom");
  if (addBtn) {
    addBtn.onclick = async () => {
      const modelEl = $("#sp-custom-model");
      const baseEl = $("#sp-custom-base");
      const keyEl = $("#sp-custom-key");
      const model = modelEl ? modelEl.value.trim() : "";
      if (!model) return toast("请填写模型名", "warn");
      if (!model.includes("/")) return toast("格式: provider/model", "warn");
      const customBase = baseEl ? baseEl.value.trim() : "";
      const customKey = keyEl ? keyEl.value.trim() : "";
      // 用户填了自定义 base 就用,否则用厂商默认
      const defBase = defaultBaseFor(model);
      const api_base = customBase || defBase || "";
      try {
        await api("/api/settings/model", {
          method: "PUT",
          body: JSON.stringify({
            model,
            api_key: customKey,
            api_base,
            temperature: 0.8,
            max_tokens: 4096,
          }),
        });
        toast(`已添加自定义模型 ${model}`, "ok");
        // 清空输入
        if (modelEl) modelEl.value = "";
        if (baseEl) baseEl.value = "";
        if (keyEl) keyEl.value = "";
        await loadSettings();
      } catch (e) {
        // api() 已 toast,兜底防止按钮卡死
      }
    };
  }
  // 「测试连接」: 真发一次最小请求 (maxTokens=1) 验证当前默认模型通不通。
  // 换模型/换 Key/换 Base 之后不用"发句话试试才知道", 点一下就有明确结果 + 耗时。
  const testConnBtn = $("#sp-test-conn");
  if (testConnBtn) {
    testConnBtn.onclick = async () => {
      const out = $("#sp-test-conn-result");
      testConnBtn.disabled = true;
      const oldText = testConnBtn.textContent;
      testConnBtn.textContent = "测试中…";
      if (out) { out.textContent = ""; out.style.color = "var(--text-dim)"; }
      const t0 = Date.now();
      try {
        const r = await api("/api/config/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const ms = Date.now() - t0;
        if (out) {
          out.textContent = `${r && r.ok ? "✅" : "❌"} ${esc((r && r.message) || "无返回")} (${(ms / 1000).toFixed(1)}s)`;
          out.style.color = r && r.ok ? "var(--green)" : "var(--red)";
        }
      } catch (e) {
        if (out) {
          out.textContent = `❌ 请求失败: ${esc(String(e && e.message || e))}`;
          out.style.color = "var(--red)";
        }
      } finally {
        testConnBtn.disabled = false;
        testConnBtn.textContent = oldText;
      }
    };
  }
  // 从服务端拉取所有模型 (Live Discover, 对齐 Hermes GET /v1/models)
  const discoverBtn = $("#sp-discover-btn");
  if (discoverBtn) {
    discoverBtn.onclick = async () => {
      const sel = $("#sp-discover-model");
      const target = sel ? sel.value : "";
      discoverBtn.disabled = true;
      discoverBtn.textContent = "拉取中…";
      try {
        const q = target ? `?model=${encodeURIComponent(target)}` : "";
        const r = await api(`/api/models/discover${q}`);
        const box = $("#sp-discover-result");
        const meta = $("#sp-discover-meta");
        const list = $("#sp-discover-list");
        if (r && r.ok && r.count > 0) {
          box.style.display = "block";
          const provider = (target || "").split("/")[0] || "provider";
          meta.textContent = `${r.count} 个可用模型 · 端点 ${r.base} · 来源: ${r.source === "cache" ? "缓存" : "实时"}${r.error ? " (注: " + r.error + ")" : ""}`;
          // 去重: 已配置的不再显示添加按钮
          const configured = new Set((spData.models || []).map((m) => m.model));
          list.innerHTML = r.models.map((id) => {
            const full = id.includes("/") ? id : `${provider}/${id}`;
            const isCfg = configured.has(full);
            return `<button class="pm-btn" data-discover-add="${esc(full)}" data-base="${esc(r.base)}" ${isCfg ? "disabled" : ""}>${isCfg ? "✓ " : "+ "}${esc(id)}</button>`;
          }).join("");
          $$("#sp-discover-result [data-discover-add]").forEach((b) => {
            b.onclick = async () => {
              const m = b.dataset.discoverAdd;
              const def = defaultBaseFor(m);
              const baseVal = b.dataset.base || def || "";
              try {
                await api("/api/settings/model", {
                  method: "PUT",
                  body: JSON.stringify({ model: m, api_key: "", api_base: baseVal, temperature: 0.8, max_tokens: 4096 }),
                });
                toast(`已添加 ${m}`, "ok");
                await loadSettings();
              } catch (e) { /* api() 已 toast */ }
            };
          });
        } else {
          box.style.display = "block";
          list.innerHTML = "";
          meta.textContent = r?.error ? `拉取失败: ${r.error}` : "该端点无 /v1/models 路由或返回空 (需已配置该 provider 的 API Key)。";
        }
      } catch (e) {
        toast("拉取失败: " + e.message, "err");
      } finally {
        discoverBtn.disabled = false;
        discoverBtn.textContent = "拉取";
      }
    };
  }
  // 保存单个模型配置
  $$("#sp-body .mc-save").forEach((b) => {
    b.onclick = async () => {
      const m = b.dataset.model;
      const keyEl = $(`#sp-body [data-key="${CSS.escape(m)}"]`);
      const baseEl = $(`#sp-body [data-base="${CSS.escape(m)}"]`);
      const tempEl = $(`#sp-body [data-temp="${CSS.escape(m)}"]`);
      const tokEl = $(`#sp-body [data-tok="${CSS.escape(m)}"]`);
      // 留空或等于厂商默认时,统一存空串(由后端兜底填默认)
      let baseVal = baseEl ? baseEl.value.trim() : "";
      const def = defaultBaseFor(m);
      if (!baseVal || (def && baseVal === def)) baseVal = "";
      const body = {
        model: m,
        api_key: keyEl ? keyEl.value : null,
        api_base: baseVal,
        temperature: tempEl ? parseFloat(tempEl.value) : null,
        max_tokens: tokEl ? parseInt(tokEl.value) : null,
      };
      try {
        await api("/api/settings/model", { method: "PUT", body: JSON.stringify(body) });
        toast(`${m} 配置已保存`, "ok");
        await loadSettings();
        await loadConfig();
      } catch (e) {
        // api() 已 toast,兜底
      }
    };
  });
  // 设为默认
  $$("#sp-body .mc-setdef").forEach((b) => {
    b.onclick = async () => {
      try {
        await api("/api/config/model", { method: "PUT", body: JSON.stringify({ model: b.dataset.model }) });
        toast(`已设为默认: ${b.dataset.model}`, "ok");
        await loadSettings();
        await loadConfig();
      } catch (e) {
        // 兜底
      }
    };
  });
  // 删除模型
  $$("#sp-body .mc-del").forEach((b) => {
    b.onclick = async () => {
      const model = b.dataset.model;
      // 二次确认: 用 toast 替代 confirm(),避免在某些浏览器环境 (无头/受限) 不弹窗导致按钮看似卡死
      if (b.dataset.confirming === "1") {
        // 第二次点击: 真正删除
        b.dataset.confirming = "0";
        b.textContent = "✕";
        b.classList.remove("warn");
        try {
          await api("/api/settings/model", { method: "DELETE", body: JSON.stringify({ model }) });
          toast(`已删除 ${model}`, "ok");
          await loadSettings();
          await loadConfig();
        } catch (e) {
          // api() 已 toast (如"至少保留一个模型"),兜底
        }
      } else {
        // 第一次点击: 标红 + 提示再点一次确认
        b.dataset.confirming = "1";
        b.textContent = "再点删除";
        b.classList.add("warn");
        toast(`再点一次确认删除 ${model}`, "warn", 3000);
        // 3 秒后自动取消确认状态
        setTimeout(() => {
          if (b.dataset.confirming === "1") {
            b.dataset.confirming = "0";
            b.textContent = "✕";
            b.classList.remove("warn");
          }
        }, 3000);
      }
    };
  });
  // 保存 Agent 参数 (全局)
  const saveAgent = $("#sp-save-agent");
  if (saveAgent) {
    saveAgent.onclick = async () => {
      await api("/api/settings/agent", {
        method: "PUT",
        body: JSON.stringify({
          max_steps: parseInt($("#sp-maxsteps").value),
          chunk_size: parseInt($("#sp-chunksize").value),
          retrieve_k: parseInt($("#sp-retrievek").value),
        }),
      });
      toast("Agent 参数已保存", "ok");
    };
  }
  // 保存单个 Agent 参数 (各Agent卡片)
  $$("#sp-body .ag-save").forEach((btn) => {
    btn.onclick = async () => {
      const an = btn.dataset.agent;
      const card = btn.closest(".agent-card");
      const cfg = {};
      $$(`[data-agent="${CSS.escape(an)}"] [data-ad]`).forEach((el) => {
        const key = el.dataset.ad;
        if (el.tagName === "SELECT") cfg[key] = el.value === "true" || el.value === "false" ? el.value === "true" : el.value;
        else if (el.value !== "") cfg[key] = parseInt(el.value);
      });
      try {
        await api("/api/settings/agent", {
          method: "PUT",
          body: JSON.stringify({ agents: { [an]: cfg } }),
        });
        toast("已保存: " + an, "ok");
        loadSettings();
      } catch (e) {
        toast("保存失败: " + e.message, "err");
      }
    };
  });
  // 保存模型档位 → 模型 映射 (识别闭环)
  const saveTierBtn = $("#sp-save-tier");
  if (saveTierBtn) {
    saveTierBtn.onclick = async () => {
      const body = {};
      $$("#sp-body .tier-model-sel").forEach((sel) => {
        if (sel.value) body[sel.dataset.tier] = sel.value;
      });
      try {
        const r = await api("/api/settings/tier-model", { method: "PUT", body: JSON.stringify(body) });
        toast("档位映射已保存", "ok");
        // 刷新预览 (7 agent 各自解析到的模型)
        await loadSettings();
        await refreshTierPreview();
      } catch (e) {
        toast("保存失败: " + e.message, "err");
      }
    };
    refreshTierPreview();
  }
}

// ==================== 运行历史面板 (trace 回放) ====================
const runsPanel = $("#runs-panel");
const scrimEl = $("#scrim");

function _fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function _fmtDuration(sec) {
  if (!sec || sec < 0) return "—";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`;
}
function _fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
function _fmtCost(c) {
  if (!c) return "$0";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

// ===== Prefix Cache 命中率实时展示 =====
let _cacheCum = { prompt: 0, cached: 0, calls: 0 };

function updateCacheStats(evt) {
  const u = evt.usage || {};
  const stepHit = u.cachedTokens || evt.hit_tokens || 0;
  const stepTotal = u.promptTokens || ((evt.hit_tokens || 0) + (evt.miss_tokens || 0)) || 0;
  const calls = evt.calls || 1;

  _cacheCum.prompt += stepTotal;
  _cacheCum.cached += stepHit;
  _cacheCum.calls += calls;

  const cumRate = _cacheCum.prompt > 0
    ? (_cacheCum.cached / _cacheCum.prompt * 100).toFixed(1) : "0.0";

  let panel = null;
  if (evt.agent === "orchestrator" || evt.agent === currentAssistant) {
    panel = assistant?.thinkPanel;
  } else {
    const sub = assistant?.subBubbles?.[evt.agent];
    if (sub) panel = sub.thinkPanel;
  }

  if (panel && stepTotal > 0) {
    const stepRate = stepTotal > 0 ? (stepHit / stepTotal * 100).toFixed(1) : "0.0";
    const div = document.createElement("div");
    div.className = "st-cache-entry";
    div.innerHTML = `<span class="st-dot" style="background:#10b981"></span>
      <span class="st-text">缓存命中 <b>${stepRate}%</b> (${_fmtTokens(stepHit)}/${_fmtTokens(stepTotal)}) · 累计 <b>${cumRate}%</b></span>`;
    panel.querySelector(".sub-think-body")?.appendChild(div);
  }

  const ci = document.getElementById("cache-indicator");
  if (ci) {
    ci.textContent = `💾 ${cumRate}%`;
    ci.title = `Prefix Cache: ${_fmtTokens(_cacheCum.cached)} / ${_fmtTokens(_cacheCum.prompt)} (${cumRate}%) · ${_cacheCum.calls}次调用`;
    ci.style.display = _cacheCum.prompt > 0 ? "" : "none";
  }
}

// SSE 事件类型 → 中文标签 + 颜色
const EVENT_META = {
  start:         { label: "开始",     color: "var(--blue)" },
  llm_call:      { label: "LLM 调用", color: "var(--accent)" },
  tool_call:     { label: "调工具",   color: "var(--yellow)" },
  tool_result:   { label: "工具结果", color: "var(--green)" },
  delegate:      { label: "委派",     color: "var(--accent)" },
  delegate_done: { label: "委派完成", color: "var(--green)" },
  error:         { label: "错误",     color: "var(--red)" },
  end:           { label: "结束",     color: "var(--muted)" },
};

async function openRunsPanel() {
  if (!currentProject) return toast("请先选择项目", "warn");
  runsPanel.classList.add("open");
  scrimEl?.classList.add("show");
  $("#rp-detail").classList.add("hidden");
  $("#rp-runs").classList.remove("hidden");
  $("#rp-metrics").textContent = "加载中…";
  $("#rp-runs").innerHTML = '<div class="rp-loading">加载中…</div>';
  try {
    const [metrics, runs] = await Promise.all([
      api(`/api/projects/${currentProject.id}/metrics`),
      api(`/api/projects/${currentProject.id}/runs`),
    ]);
    renderProjectMetrics(metrics);
    renderRunsList(runs);
  } catch (e) { /* api 已 toast */ }
}

function renderProjectMetrics(m) {
  const cacheAll = (m.total_cache_hit_tokens || 0) + (m.total_cache_miss_tokens || 0);
  const cacheRate = cacheAll > 0 ? `${((m.total_cache_hit_tokens / cacheAll) * 100).toFixed(1)}%` : "N/A";
  const html = `
    <div class="rp-metric"><div class="rp-metric-num">${m.total_runs}</div><div class="rp-metric-lbl">总运行</div></div>
    <div class="rp-metric"><div class="rp-metric-num">${_fmtTokens(m.total_tokens)}</div><div class="rp-metric-lbl">tokens</div></div>
    <div class="rp-metric"><div class="rp-metric-num">${cacheRate}</div><div class="rp-metric-lbl">缓存命中率</div></div>
    <div class="rp-metric"><div class="rp-metric-num">${_fmtCost(m.total_cost_usd)}</div><div class="rp-metric-lbl">成本</div></div>
    <div class="rp-metric"><div class="rp-metric-num">${_fmtDuration(m.avg_run_duration_sec)}</div><div class="rp-metric-lbl">平均耗时</div></div>
    <div class="rp-metric"><div class="rp-metric-num">${m.total_tool_calls}</div><div class="rp-metric-lbl">工具调用</div></div>
  `;
  $("#rp-metrics").innerHTML = html;
}

function renderRunsList(runs) {
  if (!runs.length) {
    $("#rp-runs").innerHTML = '<div class="rp-empty"><div class="rp-empty-icon">📭</div><p>暂无运行记录</p><p class="muted">每次发消息触发 agent loop 都会自动记录</p></div>';
    return;
  }
  const html = runs.map((r) => {
    const statusCls = r.status === "done" ? "ok" : (r.status === "error" ? "err" : "running");
    const statusIcon = r.status === "done" ? "✓" : (r.status === "error" ? "✗" : "…");
    return `<button class="rp-item" data-rid="${r.id}">
      <div class="rp-item-main">
        <span class="rp-item-status ${statusCls}">${statusIcon}</span>
        <span class="rp-item-input">${esc((r.user_input || "").slice(0, 60))}${(r.user_input||"").length > 60 ? "…" : ""}</span>
      </div>
      <div class="rp-item-meta">
        <span>${_fmtTime(r.started_at)}</span>
        <span>${r.total_steps} 步</span>
        <span>${_fmtTokens(r.total_tokens)} tok</span>
        <span>${_fmtCost(r.total_cost)}</span>
      </div>
    </button>`;
  }).join("");
  $("#rp-runs").innerHTML = html;
  $$("#rp-runs .rp-item").forEach((el) => {
    el.onclick = async () => {
      const rid = el.dataset.rid;
      await showRunDetail(rid);
    };
  });
}

async function showRunDetail(runId) {
  $("#rp-runs").classList.add("hidden");
  $("#rp-detail").classList.remove("hidden");
  $("#rp-detail-title").textContent = "加载中…";
  $("#rp-timeline").innerHTML = "";
  try {
    const data = await api(`/api/runs/${runId}`);
    const r = data.run;
    const events = data.events || [];
    const dur = r.ended_at ? (r.ended_at - r.started_at) : 0;
    $("#rp-detail-title").textContent = r.user_input.slice(0, 50) + (r.user_input.length > 50 ? "…" : "");
    const headHtml = `
      <div class="rp-run-head">
        <span class="rp-badge ${r.status}">${r.status}</span>
        <span>入口: ${esc(r.entry_agent)}</span>
        <span>${r.total_steps} 步</span>
        <span>${_fmtTokens(r.total_tokens)} tokens</span>
        <span>${_fmtCost(r.total_cost)}</span>
        <span>${_fmtDuration(dur)}</span>
        ${r.error ? `<span class="rp-err">${esc(r.error)}</span>` : ""}
      </div>`;
    const timelineHtml = events.map((e) => {
      const meta = EVENT_META[e.type] || { label: e.type, color: "var(--muted)" };
      let body = "";
      if (e.input) body += `<div class="rp-ev-in"><b>输入:</b> ${esc(e.input)}</div>`;
      if (e.output) body += `<div class="rp-ev-out"><b>输出:</b> ${esc(e.output)}</div>`;
      if (e.error) body += `<div class="rp-ev-err"><b>错误:</b> ${esc(e.error)}</div>`;
      const meta2 = [];
      if (e.agent) meta2.push(`<span class="rp-ev-tag">${esc(e.agent)}</span>`);
      if (e.tool) meta2.push(`<span class="rp-ev-tag">🔧 ${esc(e.tool)}</span>`);
      if (e.tokens) meta2.push(`<span class="rp-ev-tag">${_fmtTokens(e.tokens)} tok</span>`);
      if (e.cost) meta2.push(`<span class="rp-ev-tag">${_fmtCost(e.cost)}</span>`);
      if (e.duration_ms) meta2.push(`<span class="rp-ev-tag">${(e.duration_ms / 1000).toFixed(2)}s</span>`);
      return `<div class="rp-ev" style="--ev-color:${meta.color}">
        <div class="rp-ev-dot"></div>
        <div class="rp-ev-body">
          <div class="rp-ev-head">
            <span class="rp-ev-type">${meta.label}</span>
            ${meta2.join("")}
          </div>
          ${body}
        </div>
      </div>`;
    }).join("");
    $("#rp-timeline").innerHTML = headHtml + timelineHtml;
  } catch (e) { /* api 已 toast */ }
}

// 绑定按钮
$("#runs-btn")?.addEventListener("click", () => {
  if (runsPanel.classList.contains("open")) {
    closeRunsPanel();
  } else {
    openRunsPanel();
  }
});
$("#rp-close")?.addEventListener("click", closeRunsPanel);
$("#rp-back")?.addEventListener("click", () => {
  $("#rp-detail").classList.add("hidden");
  $("#rp-runs").classList.remove("hidden");
});
function closeRunsPanel() {
  runsPanel.classList.remove("open");
  // 同时关闭 scrim (仅当没其他面板打开时)
  if (!$("#settings-panel").classList.contains("open") &&
      !$("#skills-panel").classList.contains("open")) {
    scrimEl?.classList.remove("show");
  }
}
