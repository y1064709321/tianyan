// Agent 运行循环 — ReAct 模式 (Reason + Act)
// 支持: 工具调用 / 子 agent 委派 / 并行工具 / 心跳 / 循环检测
import { chat, stream as llmStream, friendlyError, THINK_PREFIX, TOOLCALL_PREFIX, USAGE_PREFIX } from "../llm.js";
import { logInfo, logWarn, logError } from "../logger.js";
import { getSettings } from "../config.js";
import { pickModelForAgent } from "../config.js";
import { isToolAllowedInPhase, advancePhase, getPhaseInfo, PHASES } from "../workflow.js";
import * as store from "../store.js";
import * as memory from "../memory/index.js";
import { getMeta, isValid, isReadonly, AGENT_TOOLS, getMaxDelegateDepth, DEFAULT_AGENT, getAgentPrompt, AGENT_META, FINAL_ADJUDICATION_RULES } from "./index.js";
import { getAgentSkillPrompts } from "../skills.js";
import { isPromptLeakage } from "../think_filter.js";
import type { AgentName, SSEEvent, ToolResult, ToolCall, ToolDefinition, LLMResponse } from "../types.js";
import { precheckCode } from "../security/sandbox.js";
import { randomBytes } from "node:crypto";
import { browserSearch, browserFetch, browserScreenshot } from "../browser.js";
import { assessArc, adjustArc, estimateDensity, recordSnapshot } from "../arc.js";
import { buildWritingContext, summarizeChapter, updateCharacterStatesAfterChapter } from "../context/inject.js";
import { callScrapling } from "../scraplingClient.js";
import { skeletonWriting, ruleQualityCheck, assessChapterRules, parseRankingItems, extractGenreDistribution, outlineSkeleton, weightedReviewScore, similarityCheck, detectAIHeuristic } from "../deterministic.js";
import { buildAuditContext, auditDimensions, AUDIT_DIMENSIONS_TEXT, TOTAL_DIMENSIONS } from "./audit-dimensions.js";
import { matchGenre, normGenre, genreKwsOf } from "./genreFilter.js";
import * as fanqie from "./fanqie.js";
import { isRunCancelled } from "../runCancel.js";
import { getArcTarget } from "../store.js";

// ===== Python 技能引擎桥接 =====
import { callSkill, type SkillAction } from "../skills/engine.js";

// TypeScript 技能引擎 — 直接调用，无需 Python
async function callSkillBridge(action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return callSkill(action as SkillAction, args);
}

// ===== 共享: 36维审计清单 — 单一数据源见 ./audit-dimensions.ts =====
// (原先这里的 36 维只是给 LLM 看的文本, 且代码里另有两份各自漏维的临时规则表;
//  现在提示词与规则层都从 AUDIT_DIMENSIONS 生成, 36 维全部有确定性规则兜底)

// 审计判定工具: 从审计文本提取 JSON (模型可能输出 ```json 包裹或前后缀)
function extractJsonPayload(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const md = text.match(/```json\s*\n(\{[\s\S]*\})\s*\n```/);
  if (md) { try { return JSON.parse(md[1]); } catch { /* fallthrough */ } }
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) {
    let depth = 0;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(braceStart, i + 1)); } catch { return null; } } }
    }
  }
  return null;
}


// ===== 工具调度 =====
// ===== 工具调度 =====
// 将 Agent 的工具调用路由到具体实现
// 完整的 36 个工具 (从 Python 版 tools.py 迁移)

export async function dispatchTool(
  pid: string,
  name: string,
  args: Record<string, unknown>,
  agentName: string,
): Promise<string> {
  // 沙箱检查: 只读 agent 不允许写入工具
  if (isReadonly(agentName)) {
    const writeTools = new Set([
      "generate_outline", "continue_writing", "polish", "add_element",
      "manage_character", "manage_world", "manage_milestone", "manage_outline",
      "scan_bestseller", "analyze_novel", "ghostwrite", "imitate_style",
    ]);
    if (writeTools.has(name)) {
      return JSON.stringify({ error: `只读 agent (${agentName}) 不能调用写入工具 ${name}` });
    }
  }

  try {
    switch (name) {
      // ===== 项目查询 =====
      case "query_project": {
        const proj = store.getProject(pid);
        if (!proj) return JSON.stringify({ error: "项目不存在" });
        return JSON.stringify({
          project: proj,
          stats: store.stats(pid),
          chapters: store.listChapters(pid).map((c) => ({
            id: c.id, title: c.title, idx: c.idx, status: c.status,
            contentChars: c.content?.length || 0, hasContent: !!c.content, hasOutline: !!c.outline,
          })),
          elements: store.listElements(pid),
          foreshadowings: store.listForeshadowings(pid),
          characterStates: store.listCharacterStates(pid),
        });
      }

      // ===== 工作流模式切换 =====
      case "switch_workflow_mode": {
        const mode = String(args.mode || "state_machine");
        if (mode !== "state_machine" && mode !== "crewai") {
          return JSON.stringify({ error: `无效模式: ${mode}，可选: state_machine, crewai` });
        }
        try {
          const { saveSettings } = await import("../config.js");
          const s = getSettings();
          s.workflowMode = mode as "state_machine" | "crewai";
          saveSettings();
          return JSON.stringify({ 
            success: true, 
            mode, 
            message: `工作流模式已切换为: ${mode === "state_machine" ? "状态机（严格阶段执行）" : "CrewAI（灵活协作）"}` 
          });
        } catch (e) {
          return JSON.stringify({ error: `切换失败: ${(e as Error).message}` });
        }
      }

      // ===== 查询工作流状态 =====
      case "query_workflow": {
        const ws = store.getProjectState(pid);
        const { getPhaseInfo } = await import("../workflow.js");
        const phaseInfo = getPhaseInfo(ws.currentPhase as import("../workflow.js").Phase);
        return JSON.stringify({
          mode: getSettings().workflowMode || "state_machine",
          currentPhase: ws.currentPhase,
          phaseName: phaseInfo.name,
          phaseDesc: phaseInfo.description,
          allowedNext: phaseInfo.allowedNext,
          hasCharacters: ws.hasCharacters,
          hasWorld: ws.hasWorld,
          hasOutline: ws.hasOutline,
          hasContent: ws.hasContent,
          hasChapters: ws.hasChapters,
        });
      }

      // ===== 导出项目数据 =====
      case "export_project_data": {
        const fmt = String(args.format || "txt");
        const exportData = store.getExportData(pid, fmt);
        if (fmt === "json") return JSON.stringify(exportData);
        const text = (exportData as { text: string }).text;
        // 保存到文件
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const dataDir = getSettings().dataDir;
        mkdirSync(join(dataDir, "exports"), { recursive: true });
        const exportProj = store.getProject(pid);
        const filename = `${exportProj?.name || "未命名"}_${Date.now()}.txt`;
        writeFileSync(join(dataDir, "exports", filename), text, "utf-8");
        return JSON.stringify({
          success: true,
          format: fmt,
          filename,
          path: `/exports/${filename}`,
          chars: text.length,
          preview: text.slice(0, 500),
        });
      }

      // ===== 扫榜调研 (多平台: 默认抓全部可达平台, 失败诚实标注; 报告头带抓取时刻) =====
      case "scan_bestseller": {
        const genre = String(args.genre || "");
        // 支持三江 / 往期三江
        const board = String(args.board || args.rank || "");
        const requestedPlatform = String(args.platform || "起点中文网");
        // 抓取时刻 (UTC 本地时间, 前端/报告里标注, 让用户知道"这是哪天的榜")
        const fetchedAt = new Date().toLocaleString("zh-CN", { hour12: false });
        // === 多平台: 并行抓全部 (起点/女频/番茄/晋江/飞卢/书旗/QQ阅读) ===
        // 【豆瓣已于 2026-10 移除】它不是网文平台 (出版书/电子书为主), 榜单对网文创作没有参考价值,
        // 而且 read.douban.com 反爬最严, 每次都失败还占一个名额、拉低成功率分母。
        // 用户若还传 platform="豆瓣", 会被当成未知平台加在首位尝试并失败, 不会再有兜底数据。
        // 用户指定了某平台 → 优先它 + 仍抓其余作参照; 没指定 → 全抓 (用户要"多网站")
        // 实测可达性: 番茄 JSON API ✅ / 起点·起点女生·晋江·书旗 ✅ (真实浏览器层) /
        // 飞卢·QQ阅读 ❌ (风控打不过); 都并行试, 抓到的进报告, 失败的诚实标注, 不静默丢
        const SCAN_ALL_PLATFORMS = ["起点中文网", "起点女生网", "番茄小说", "晋江文学城", "飞卢", "书旗", "QQ阅读"];
        const platformOrder = (() => {
          if (requestedPlatform && requestedPlatform !== "起点中文网" && !SCAN_ALL_PLATFORMS.includes(requestedPlatform)) {
            return [requestedPlatform, ...SCAN_ALL_PLATFORMS];
          }
          if (requestedPlatform && SCAN_ALL_PLATFORMS.includes(requestedPlatform)) {
            return [requestedPlatform, ...SCAN_ALL_PLATFORMS.filter((p) => p !== requestedPlatform)];
          }
          return SCAN_ALL_PLATFORMS;
        })();
        // === 并行抓全部平台 (每个独立 try, 失败不拖垮整轮; 结果按 platformOrder 顺序排列) ===
        type PlatResult = { platform: string; ok: boolean; note: string; raw: { source: string; board: string; url: string; items: string[]; rawText: string } | null; items: Array<{ rank: number; title: string; author: string; blurb: string }>; genreDist: Record<string, number> };
        const crawlOne = async (plat: string): Promise<PlatResult> => {
          try {
            const c = await crawlRanking(plat, genre, board);
            const pi = parseRankingItems(c.rawText);
            const gd = extractGenreDistribution(pi);
            return { platform: plat, ok: pi.length > 0, note: pi.length > 0 ? "" : "该平台抓取失败 (反爬/JS渲染/网络限制)", raw: c, items: pi, genreDist: gd };
          } catch (e) {
            return { platform: plat, ok: false, note: "抓取异常: " + (e as Error).message?.slice(0, 40), raw: null, items: [], genreDist: {} };
          }
        };
        const allResults = await Promise.all(platformOrder.map(crawlOne));
        const okCount = allResults.filter((r) => r.ok).length;
        const fallback = allResults.find((r) => r.ok) || allResults[allResults.length - 1]!;
        const lastPlatform = fallback.platform;
        const rawCrawl = fallback.raw;
        // LLM 趋势归纳 (结构化输入, 全部平台命中条目, 降低弱模型解析负担)
        const allParsed = allResults.filter((r) => r.ok).flatMap((r) => r.items);
        // 【防编造闸门】上面列出的条目就是工具真实抓到的**全部**来源。
        // 2026-10-17 事故: 主笔被误派去扫榜时, 我们只给了 2 条真·仙侠, 它交回一张 12 行表格,
        // 前两名是《最强龙婿》《极品全才神婿》—— 这两本存在于番茄综合榜, 但全是都市赘婿文,
        // 且当时压根没喂给它。LLM 的动机就是"表格太空不好看", 所以这里把话说到死。
        const ANTI_FABRICATION = "\n【严禁编造 — 硬约束】上表 + 下方原始数据里的书名/作者/简介, 是本次工具**真实抓取到的全部来源**。\n" +
          "你的报告只能使用这里面出现过的作品, 严禁凭记忆、印象或常识补充任何未列出的书名,\n" +
          "也严禁为了把表格填满而补数据。抓到 2 部就写 2 部 —— 写得少不是缺陷, 编数据一律被终审打回。\n\n";
        const structuredInput = allParsed.length
          ? "【已结构化解析】\n" + allResults.map((r) => (r.ok ? `【${r.platform}】` : `【${r.platform}】(抓取失败)`)).join("\n") + "\n" +
            allParsed.slice(0, 40).map((i) => `  ${i.rank}. ${i.title} | ${i.author} | ${i.blurb.slice(0, 50)}`).join("\n") +
            "\n【题材分布】" + Object.entries(allResults.reduce((acc, r) => { Object.entries(r.genreDist).forEach(([k, v]) => acc[k] = (acc[k] || 0) + v); return acc; }, {} as Record<string, number>)).filter(([, v]) => v > 0).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(" ") +
            ANTI_FABRICATION +
            "\n\n【原始数据】\n"
          : "【警告】所有平台榜单抓取均失败 (反爬/网络限制), 无真实榜单数据。\n";
        let resp: { content: string };
        const llmTimeoutMs = 25_000;
        try {
          const llmPromise = chat([
            { role: "system", content: "你是网文市场分析师。多平台榜单数据已由代码层结构化解析, 你只负责跨平台趋势归纳与创作建议。严禁编造具体书名/排名, 没数据时明确告知用户哪个平台抓失败并基于题材常识给建议。" },
            { role: "user", content: `用户题材方向: ${genre || "全品类"} | 榜单: ${board || "默认畅销/推荐"} | 抓取时刻: ${fetchedAt} | 成功平台 ${okCount}/${allResults.length}\n\n${structuredInput}${allResults.map((r) => r.raw?.rawText || "").slice(0, 6000)}\n\n请跨平台归纳市场趋势与创作建议 (哪些题材多平台共热、哪些是单平台热点)。若平台抓取失败, 明确说明并基于已有数据给方向。` },
          ]);
          const timeoutPromise = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("LLM timeout " + llmTimeoutMs + "ms")), llmTimeoutMs));
          resp = await Promise.race([llmPromise, timeoutPromise]);
        } catch (e) {
          // LLM 超时/失败 → 用确定性数据生成 fallback 分析 (不编造, 只汇报抓到的条目 + 题材分布)
          logWarn("[扫榜] LLM 归纳超时/失败 (" + (e as Error).message?.slice(0, 60) + "), 用确定性数据生成 fallback 分析");
          const fallbackLines: string[] = [];
          if (allParsed.length > 0) {
            fallbackLines.push(`【多平台榜单数据 (真抓 ${allParsed.length} 部, 时刻 ${fetchedAt})】`);
            for (const r of allResults) {
              if (r.ok) fallbackLines.push(`\n■ ${r.platform}:`);
              for (const i of r.items.slice(0, 8)) fallbackLines.push(`  第${i.rank}名: ${i.title} | ${i.author} | ${i.blurb.slice(0, 60)}`);
            }
          }
          fallbackLines.push("\n【LLM 归纳不可用 (网络/限流), 以下为确定性数据汇报】趋势: 以上为当前真实榜单快照, 创作建议请结合题材分布与上述书名判断。");
          resp = { content: fallbackLines.join("\n") };
        }
        // 生成人类可读多平台文本报告 (含抓取时刻 + 失败标注 — 让用户知道"这是哪天的、哪些平台没抓到")
        const lines: string[] = [];
        lines.push(`📊 多平台扫榜 (抓取时刻: ${fetchedAt} / 题材: ${genre || "全品类"} / 榜单: ${board || "默认"} / 成功 ${okCount}/${allResults.length} 平台)`);
        lines.push("");
        for (const r of allResults) {
          if (r.ok) {
            lines.push(`■ ${r.platform} [${r.raw?.source === "json-api" ? "JSON API" : r.raw?.source === "scrapling" ? "Scrapling 指纹抓取(反爬)" : r.raw?.source === "browser" ? "浏览器抓取" : "HTML 解析"}${r.raw?.url ? " · " + r.raw.url.slice(0, 50) : ""}]`);
            for (const i of r.items.slice(0, 10)) {
              const t = `**《${i.title}》**`;
              const a = i.author ? ` (${i.author})` : "";
              const b = i.blurb ? ` | 💡 ${i.blurb.slice(0, 70)}` : "";
              lines.push(`  第${i.rank}名: ${t}${a}${b}`);
            }
            lines.push("");
          } else {
            lines.push(`■ ${r.platform} — ⚠️ ${r.note || "抓取失败 (反爬/网络限制)"}`);
            lines.push("");
          }
        }
        const allGenreDist = allResults.reduce((acc, r) => { Object.entries(r.genreDist).forEach(([k, v]) => acc[k] = (acc[k] || 0) + v); return acc; }, {} as Record<string, number>);
        if (Object.keys(allGenreDist).length > 0) {
          const topG = Object.entries(allGenreDist).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
          lines.push(`📈 题材分布 (全平台合计): ${topG.map(([k, v]) => `${k}×${v}`).join(" | ")}`);
        }
        lines.push("");
        lines.push(`📝 市场趋势与创作建议:`, resp.content);
        // 返回人类可读文本 (而非 JSON.stringify 的原始数据对象)
        return lines.join("\n");
      }

      // ===== 拆书解构 =====
      case "analyze_novel": {
        const text = String(args.text || args.content || "");
        const title = String(args.title || "未知作品");
        if (!text && !title) return JSON.stringify({ error: "需要提供小说文本或书名" });
        let inputText = text;
        // 如果只给了书名,先搜索获取内容
        if (!text && title) {
          let sr: any = null;
          try { sr = await browserSearch(`${title} 小说 精彩片段 经典段落`, 5); } catch { sr = await webSearch(`${title} 小说 精彩片段 经典段落`, 5); }
          for (const r of (sr.results || []).slice(0, 2)) {
            try {
              const page = await webFetch(r.url, 4000);
              if (page.content) inputText += page.content + "\n";
            } catch { /* skip */ }
          }
        }
        const resp = await chat([
          { role: "system", content: `你是资深网文编辑,擅长拆解小说结构。
从以下维度分析:
1. 钩子设计:开篇如何抓住读者
2. 节奏把控:爽点/低谷分布
3. 人设塑造:主角/配角的立体度
4. 文风特点:句式/叙事视角/对话风格
5. 世界观:设定的自洽性与创新度
6. 伏笔布局:线索埋设与回收
给出具体可借鉴的写作技巧。` },
          { role: "user", content: `作品: ${title}\n\n文本内容:\n${inputText.slice(0, 8000)}\n\n请深度拆解这部作品。` },
        ]);
        return JSON.stringify({ title, analysis: resp.content, textLength: inputText.length });
      }

      // ===== 大纲生成 =====
      case "generate_outline": {
        const premise = String(args.premise || "");
        const numChapters = Number(args.num_chapters) || 12;
        const genre = String(args.genre || "");
        // 用 LLM 生成大纲
        const s = getSettings();
        let resp: { content: string } | null = null;
        let llmFailed = false;
        try {
          resp = await chat([
            { role: "system", content: "你是小说大纲架构师。根据核心设定生成详细大纲。返回 JSON 格式。\n格式: {\"premise\":\"...\",\"chapters\":[{\"title\":\"第X章 标题\",\"outline\":\"该章剧情概要\"}]}" },
            { role: "user", content: `核心设定: ${premise}\n类型: ${genre}\n章节数: ${numChapters}\n请生成大纲。` },
          ]);
          if (!resp?.content?.trim()) llmFailed = true;
        } catch (e) {
          llmFailed = true;
          console.log("[generate_outline] LLM 调用失败, 启用确定性骨架兜底:", (e as Error).message?.slice(0, 100));
        }
        // 解析 JSON 大纲 (兼容 ```json 代码块包裹)
        let chapterTitles: Array<{ title: string; outline: string }> = [];
        if (!llmFailed && resp) {
          const outlineParsed = extractJsonPayload(resp.content);
          if (outlineParsed) {
            const chs = (outlineParsed as { chapters?: unknown[] }).chapters;
            if (Array.isArray(chs) && chs.length) {
              chapterTitles = chs.map((c) => {
                const co = c as Record<string, unknown>;
                return { title: String(co?.title || "").trim(), outline: String(co?.outline || "").trim() };
              });
            }
          }
          if (chapterTitles.length === 0) {
            // 文本格式: 匹配 "第X章 xxx" 或 "一、xxx"
            for (const line of resp.content.split("\n")) {
              const m = line.match(/^(第[\d一二三四五六七八九十百千]+章[\s：:]*|[\d一二三四五六七八九十]+\.\s*)(.+)/);
              if (m) {
                chapterTitles.push({ title: line.trim().slice(0, 40), outline: "" });
                if (chapterTitles.length >= numChapters) break;
              }
            }
          }
        }
        // 确定性骨架兜底层: LLM 失败或空输出 → 起承转合骨架 (代码层, 不靠模型)
        let source = "llm";
        if (chapterTitles.length === 0) {
          const skeleton = outlineSkeleton({ premise, genre, numChapters });
          chapterTitles = skeleton.map((c) => ({ title: c.title.replace(" (待命名)", ""), outline: c.outline }));
          source = "deterministic_skeleton";
        }
        // 章节骨架：已有章节则更新 outline，无则创建
        const existing = store.listChapters(pid);
        if (existing.length === 0) {
          // 首次创建
          if (chapterTitles.length === 0) {
            for (let i = 1; i <= Math.min(numChapters, 12); i++) {
              chapterTitles.push({ title: `第${i}章`, outline: "" });
            }
          }
          chapterTitles.forEach((c, idx) => {
            store.addChapter(pid, c.title || `第${idx+1}章`, idx, c.outline || "", "");
          });
        } else if (chapterTitles.length > 0) {
          // 已有章节：用新大纲更新空白 outline 的章节
          console.log("[generate_outline] existing chapters:", existing.length, "new titles:", chapterTitles.length);
          for (let i = 0; i < Math.min(chapterTitles.length, existing.length); i++) {
            const ch = existing[i];
            const newOutline = chapterTitles[i]?.outline || "";
            console.log("[outline update]", i, "old:", (ch.outline||"").length, "new:", newOutline.length, "match:", ch.title === chapterTitles[i]?.title);
            if (ch && (!ch.outline || ch.outline.length === 0) && newOutline) {
              store.updateChapter(ch.id, { outline: newOutline });
              console.log("[outline updated]", ch.id, newOutline.slice(0,40));
            }
          }
        }
        return JSON.stringify({
          outline: resp?.content || "(LLM 失败, 使用确定性骨架)",
          chapters: chapterTitles.length || numChapters,
          chapterTitles: chapterTitles.slice(0, 20),
          createdChapters: existing.length === 0 ? chapterTitles.length : 0,
          source,
        });
      }

      // ===== 续写 =====
      case "continue_writing": {
        const chapterId = String(args.chapter_id || "");
        const instruction = String(args.instruction || "");
        const length = Number(args.length) || 2000;
        // replace=true: 重写整章(删旧换新); false: 追加续写
        const replaceMode = args.replace === true || args.replace === "true";
        // 章节解析: 优先指定ID, 无效时自动用最后章节, 无章节则报错
        let ch = chapterId ? store.getChapter(chapterId) : undefined;
        const chapters = store.listChapters(pid);
        const lastChapter = chapters[chapters.length - 1];
        if (!ch && lastChapter) {
          ch = store.getChapter(lastChapter.id);
        }
        if (!ch) {
          // 自动创建第一章 (自愈: 即使 agent 忘记先建大纲也能写作)
          const newChId = store.addChapter(pid, "第一章", 0, String(instruction).slice(0, 200), "");
          ch = store.getChapter(newChId);
          if (!ch) return JSON.stringify({ error: "章节创建失败" });
        }
        const prevContent = ch.content || "";

        // === FIX 4: 加载完整上下文 (升级为三层注入: 常驻/相关/前文远摘要+近全文 + 资料员素材) ===
        const projCtx = store.getProject(pid);
        const profiles = store.listCharacterProfiles(pid);
        const worldEntries = store.listWorldEntries(pid);
        const elements = store.listElements(pid);
        const outline = ch?.outline || "";
        const sessionId = String(args.session_id || "");

        let contextBlock = "";
        // 新: 三层滚动注入 (远章节摘要 + 近 2 章结尾全文 + 角色滚动状态 + 未回收伏笔 + 资料员截取素材)
        contextBlock += buildWritingContext(pid, {
          currentIdx: ch.idx,
          recentTailChars: 3000,
          maxStates: 10,
          maxForeshadows: 10,
          materialBudget: 20000,
          materialMode: "key",
          sessionId,
        });
        // 保留原有补充层 (世界观/其他设定/本章大纲 — 注入模块未覆盖的字段)
        if (worldEntries.length) {
          contextBlock += "\n【世界观设定】\n" + worldEntries.map(w => `- [${w.category}] ${w.name}: ${w.description || ""}`).join("\n") + "\n\n";
        }
        if (elements.length) {
          contextBlock += "【其他设定】\n" + elements.map(e => `- [${e.kind}] ${e.name}: ${e.detail || ""}`).join("\n") + "\n\n";
        }
        if (outline) contextBlock += `【本章大纲】\n${outline}\n\n`;

        const s = getSettings();
        const genreLock3 = projCtx?.genre ? `\n【风格锁定】本项目类型为「${projCtx.genre}」, 全程禁止偏离。禁止出现其他类型的元素。` : "";
        let resp: { content: string } | null = null;
        let llmFailed = false;
        try {
          resp = await chat([
            { role: "system", content: "你是专业小说主笔。根据上下文和指令续写小说正文。\n必须保持角色性格一致、设定自洽、文风统一。\n禁止出现AI味词汇(如:不由得、仿佛、一股暖流、心中暗道)。" + genreLock3 },
            { role: "user", content: `${contextBlock}上文:\n${prevContent.slice(-3000)}\n\n指令: ${instruction}\n请续写约 ${length} 字。` },
          ]);
          if (!resp?.content?.trim()) llmFailed = true;
        } catch (e) {
          llmFailed = true;
          console.log("[continue_writing] LLM 调用失败, 启用确定性骨架兜底:", (e as Error).message?.slice(0, 100));
        }
        // 确定性兜底层: LLM 失败或空输出 → 骨架兜底, 保证换弱模型不塌方
        let textOut: string;
        if (!llmFailed && resp) {
          textOut = resp.content;
        } else {
          const charNames = profiles.map((p) => String(p.name)).filter(Boolean);
          textOut = skeletonWriting({
            pid,
            chapterTitle: ch.title,
            outline,
            prevContent,
            instruction,
            targetLength: length,
            genre: projCtx?.genre,
            characterNames: charNames,
            worldItems: worldEntries.map((w: any) => ({ name: String(w.name), description: String(w.description || "") })),
          });
        }
        // 保存到章节: replace=true 整章替换(删除旧内容), 否则追加续写
        const finalContent = replaceMode ? textOut : ((ch.content || "") + (ch.content ? "\n" : "") + textOut);
        store.updateChapter(ch.id, { content: finalContent, status: "done" });

        // === 写后闭环: 生成章节摘要 (远历史滚动注入的源头) ===
        // 非阻塞: 摘要生成失败不阻断写作流程, 回退确定性抽取
        summarizeChapter(pid, ch.id, ch.idx, finalContent, chat).then((sum) => {
          try { store.upsertChapterSummary(pid, ch.id, ch.idx, sum); } catch {}
        }).catch(() => {});

        // === 写后闭环: 更新角色当前状态 (防人物漂移) ===
        // 非阻塞: LLM 失败保留旧状态, 不阻断写作流程
        updateCharacterStatesAfterChapter(pid, ch.idx, finalContent, chat).catch(() => {});

        return JSON.stringify({
          text: textOut,
          chars: textOut.length,
          chapterId: ch.id,
          saved: true,
          replaced: replaceMode,
          source: llmFailed ? "deterministic_skeleton" : "llm",
        });
      }

      // ===== 润色 =====
      case "polish": {
        const chapterId = String(args.chapter_id || "");
        const mode = String(args.mode || "polish");
        const instruction = String(args.instruction || "");
        const ch = store.getChapter(chapterId);
        if (!ch) return JSON.stringify({ error: "章节不存在" });
        const s = getSettings();
        const modeMap: Record<string, string> = {
          polish: "润色改进", rewrite: "重写", expand: "扩写", condense: "缩写",
        };
        // === FIX 4: 加载角色上下文 ===
        const plProfiles = store.listCharacterProfiles(pid);
        let plCtx = "";
        if (plProfiles.length) plCtx = "【角色参考】\n" + plProfiles.map(p => `- ${p.name}: ${p.speechStyle || p.personality || ""}`).join("\n") + "\n\n";
        const resp = await chat([
          { role: "system", content: `你是专业编辑。对小说正文进行${modeMap[mode] || "润色"}。保持角色说话风格一致。禁止AI味词汇。` },
          { role: "user", content: `${plCtx}原文:\n${ch.content}\n\n${instruction ? "指令: " + instruction + "\n" : ""}请${modeMap[mode] || "润色"}。` },
        ]);
        store.updateChapter(chapterId, { content: resp.content, status: "done" });
        return JSON.stringify({ text: resp.content, chars: resp.content.length });
      }

      // ===== 角色管理 =====
      case "manage_character": {
        const action = String(args.action || "list");
        if (action === "list") {
          return JSON.stringify({ profiles: store.listCharacterProfiles(pid) });
        }
        const cname = String(args.name || "");
        if (!cname) return JSON.stringify({ error: "需要 name 参数" });
        if (action === "query") {
          const p = store.getCharacterProfile(pid, cname);
          return JSON.stringify(p || { error: `未找到角色 ${cname}` });
        }
        // create/update
        const fields: Record<string, string> = {};
        for (const k of ["role", "personality", "speechStyle", "behaviorLogic", "motivation", "arc", "growthState"]) {
          if (args[k] !== undefined) fields[k] = String(args[k]);
        }
        const id = store.upsertCharacterProfile(pid, cname, fields as Record<string, unknown>);
        return JSON.stringify({ id, name: cname, action });
      }

      // ===== 设定管理 =====
      case "add_element": {
        const kind = String(args.kind || "");
        const elName = String(args.name || "");
        const detail = String(args.detail || "");
        if (!kind || !elName) return JSON.stringify({ error: "需要 kind 和 name" });
        const id = store.addElement(pid, kind, elName, detail);
        return JSON.stringify({ id, kind, name: elName });
      }

      // ===== 世界观 =====
      case "manage_world": {
        const action = String(args.action || "list");
        if (action === "list") {
          const category = args.category ? String(args.category) : undefined;
          return JSON.stringify({ entries: store.listWorldEntries(pid, category) });
        }
        if (action === "add") {
          const category = String(args.category || "");
          const name = String(args.name || "");
          const description = String(args.description || "");
          if (!category || !name) return JSON.stringify({ error: "需要 category 和 name" });
          const id = store.addWorldEntry(pid, category, name, description);
          return JSON.stringify({ id, category, name });
        }
        if (action === "update") {
          const id = String(args.id || "");
          if (!id) return JSON.stringify({ error: "需要 id" });
          store.updateWorldEntry(id, { description: args.description as string, attributes: args.attributes as string });
          return JSON.stringify({ id, status: "updated" });
        }
        if (action === "delete") {
          const id = String(args.id || "");
          if (!id) return JSON.stringify({ error: "需要 id" });
          store.deleteWorldEntry(id);
          return JSON.stringify({ id, status: "deleted" });
        }
        return JSON.stringify({ error: "未知 action" });
      }

      // ===== 里程碑 =====
      case "manage_milestone": {
        const action = String(args.action || "list");
        if (action === "list") {
          return JSON.stringify({ milestones: store.listMilestones(pid) });
        }
        if (action === "add") {
          const chapterIdx = Number(args.chapter_idx) || 0;
          const title = String(args.title || "");
          const description = String(args.description || "");
          if (!title) return JSON.stringify({ error: "需要 title" });
          const id = store.addMilestone(pid, chapterIdx, title, description);
          return JSON.stringify({ id, chapter_idx: chapterIdx, title });
        }
        if (action === "update") {
          const id = String(args.id || "");
          if (!id) return JSON.stringify({ error: "需要 id" });
          store.updateMilestone(id, { status: args.status as string, reached_chapter: args.reached_chapter as number });
          return JSON.stringify({ id, status: "updated" });
        }
        if (action === "delete") {
          const id = String(args.id || "");
          if (!id) return JSON.stringify({ error: "需要 id" });
          store.deleteMilestone(id);
          return JSON.stringify({ id, status: "deleted" });
        }
        return JSON.stringify({ error: "未知 action" });
      }

      // ===== 大纲管理 =====
      case "manage_outline": {
        const action = String(args.action || "list");
        if (action === "list") {
          const chapters = store.listChapters(pid);
          return JSON.stringify({ outlines: chapters.map(c => ({ id: c.id, title: c.title, idx: c.idx, outline: c.outline })) });
        }
        if (action === "update") {
          const chapterId = String(args.chapter_id || "");
          const outline = String(args.outline || "");
          if (!chapterId) return JSON.stringify({ error: "需要 chapter_id" });
          store.updateChapterOutline(chapterId, outline);
          return JSON.stringify({ chapter_id: chapterId, status: "updated" });
        }
        return JSON.stringify({ error: "未知 action" });
      }

      // ===== 毒舌审稿 =====
      case "review_chapter": {
        const chapterId = String(args.chapter_id || "");
        const ch = store.getChapter(chapterId);
        if (!ch) return JSON.stringify({ error: "章节不存在" });
        const s = getSettings();
        const rvProj = store.getProject(pid);
        const rvGenreHint = rvProj?.genre ? `\n项目类型: ${rvProj.genre}。检查正文是否偏离该类型(风格漂移=一票否决)。` : "";
        const llmResp = await chat([
          { role: "system", content: "你是毒舌总编。以严苛标准审稿。评分 1-10, <7 打回。给出具体修改意见。\n输出格式: [评分: X/10] 然后给出意见。" + rvGenreHint },
          { role: "user", content: `章节: ${ch.title}\n正文:\n${ch.content.slice(0, 3000)}\n\n请审稿评分。` },
        ]);
        // LLM 创意分 (原始)
        const scoreMatch = llmResp.content.match(/[评分|得分|总分|分数][：:]\s*(\d+(?:\.\d+)?)/) || llmResp.content.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
        const llmScore = scoreMatch ? Math.min(10, parseFloat(scoreMatch[1])) : 0;
        // 确定性规则层分 (字数/密度/AI味/伏笔) + 加权 (代码层, 弱模型乱打 10 分也能被规则层封顶)
        const weighted = weightedReviewScore({ pid, text: ch.content, outline: ch.outline, llmScore });
        const score = weighted.finalScore;
        // 状态更新: 规则层兜底打回优先
        if (!weighted.reject && score >= 7) {
          store.updateChapter(chapterId, { status: "reviewed" });
        } else if (score > 0) {
          store.updateChapter(chapterId, { status: "revision_needed" });
        }
        return JSON.stringify({
          review: llmResp.content,
          chapterId,
          score,
          ruleScore: weighted.ruleScore,
          llmScore,
          reject: weighted.reject,
          reasons: weighted.reasons,
          status: !weighted.reject && score >= 7 ? "reviewed" : "revision_needed",
        });
      }

      // ===== 网络搜索 =====
      case "web_search": {
        const query = String(args.query || "");
        const maxResults = Number(args.max_results) || 8;
        const results = await webSearch(query, maxResults);
        // 人类可读格式 (而非原始 JSON) — 避免前端正文显示成代码乱码
        const rlines: string[] = [];
        rlines.push(`🔍 联网搜索结果 (查询: ${query})`);
        const rlist: WebSearchResultItem[] = results?.results || [];
        if (rlist.length > 0) {
          rlines.push("");
          for (const [idx, r] of rlist.slice(0, maxResults).entries()) {
            rlines.push(`${idx + 1}. ${r.title || r.url || "(无标题)"}`);
            if (r.snippet) rlines.push(`   ${r.snippet.slice(0, 150)}${r.snippet.length > 150 ? "…" : ""}`);
            if (r.url) rlines.push(`   🔗 ${r.url.slice(0, 80)}`);
          }
        } else {
          rlines.push("⚠️ 未抓到搜索结果 (网络/反爬限制)。以下为基于常识的资料参考:");
          if (results?.analysis) rlines.push(results.analysis);
        }
        return rlines.join("\n");
      }

      case "web_fetch": {
        const url = String(args.url || "");
        const maxChars = Number(args.max_chars) || 8000;
        const result = await webFetch(url, maxChars);
        return JSON.stringify(result);
      }

      case "browser_search": {
        const query = String(args.query || "");
        const maxResults = Number(args.max_results) || 10;
        const results = await browserSearch(query, maxResults);
        return JSON.stringify(results);
      }

      case "browser_fetch": {
        const url = String(args.url || "");
        const maxChars = Number(args.max_chars) || 12000;
        const waitMs = Number(args.wait_ms) || 1500;
        if (!url.startsWith("http")) return JSON.stringify({ error: "url 必须以 http(s):// 开头" });
        const result = await browserFetch(url, maxChars, waitMs);
        return JSON.stringify(result);
      }

      case "browser_screenshot": {
        const url = String(args.url || "");
        const name = String(args.name || "shot");
        const width = Number(args.width) || 1280;
        const height = Number(args.height) || 800;
        if (!url.startsWith("http")) return JSON.stringify({ error: "url 必须以 http(s):// 开头" });
        const result = await browserScreenshot(url, name, width, height);
        return JSON.stringify(result);
      }

      // ===== 技能工具 (LLM 驱动) =====
      case "match_author": {
        const genre = String(args.genre || "");
        const style = String(args.style || "");
        const premise = String(args.premise || "");
        const bridgeResult = await callSkillBridge("match_author", { genre, style, premise });
        if (bridgeResult.error) {
          const resp = await chat([
            { role: "system", content: "你是小说创作顾问。根据用户需求推荐 1-3 位最适合的网文作家,说明推荐理由。" },
            { role: "user", content: `推荐作家: 题材=${genre} 文风=${style}\n请推荐并说明理由。` },
          ]);
          return JSON.stringify({ recommendation: resp.content });
        }
        return JSON.stringify({ recommendations: bridgeResult });
      }
      case "get_author_reference": {
        const author = String(args.author || "");
        const scene = String(args.scene || "");
        const bridgeResult = await callSkillBridge("get_author_reference", { author, scene });
        if (bridgeResult.error) {
          const resp = await chat([
            { role: "system", content: `你是${author}的写作风格分析专家。分析其${scene || "通用"}场景下的写作风格特征。` },
            { role: "user", content: `分析${author}的${scene || "通用"}写作风格,给出句式节奏、信息密度、断句习惯等特征。` },
          ]);
          return JSON.stringify({ author, scene, analysis: resp.content });
        }
        return JSON.stringify(bridgeResult);
      }
      case "list_authors": {
        const bridgeResult = await callSkillBridge("list_authors");
        if (bridgeResult.error) {
          const resp = await chat([
            { role: "system", content: "你是网文知识专家。" },
            { role: "user", content: "列出中国网文界 20 位代表性作家,按流派分类。" },
          ]);
          return JSON.stringify({ authors: resp.content });
        }
        return JSON.stringify(bridgeResult);
      }
      case "deconstruct": {
        const query = String(args.query || args.input || "");
        const bridgeResult = await callSkillBridge("deconstruct", { input: query });
        if (bridgeResult.error) {
          // 降级到 LLM
          const resp = await chat([
            { role: "system", content: "你是顶级网文拆书师。从钩子/节奏/人设/文风/世界观等维度深度拆解作品。" },
            { role: "user", content: query },
          ]);
          return JSON.stringify({ deconstruction: resp.content });
        }
        return JSON.stringify(bridgeResult);
      }
      case "analyze_style": {
        const text = String(args.text || "");
        const bridgeResult = await callSkillBridge("analyze_style", { text });
        if (bridgeResult.error) {
          const resp = await chat([
            { role: "system", content: "你是文风分析专家。分析文本的句式节奏、信息密度、断句习惯、对话比例、修辞手法。" },
            { role: "user", content: `分析以下文本的文风特征:\n\n${text.slice(0, 3000)}` },
          ]);
          return JSON.stringify({ style_analysis: resp.content });
        }
        return JSON.stringify(bridgeResult);
      }
      case "imitate_style": {
        const refText = String(args.reference_text || "");
        const topic = String(args.topic || "");
        const wordCount = Number(args.word_count) || 800;
        const bridgeResult = await callSkillBridge("imitate_style", { reference_text: refText, topic, word_count: wordCount });
        if (bridgeResult.error) {
          const resp = await chat([
            { role: "system", content: "你是文风仿写大师。严格模仿参考文本的句式节奏、断句习惯、信息密度来创作。" },
            { role: "user", content: `参考原文:\n${refText.slice(0, 2000)}\n\n请模仿以上文风,写一段关于「${topic}」的${wordCount}字内容。` },
          ]);
          return JSON.stringify({ imitated_text: resp.content, topic, word_count: wordCount });
        }
        return JSON.stringify(bridgeResult);
      }
      case "diagnose_stuck": {
        const text = String(args.text || "");
        const lastSummary = String(args.last_chapter_summary || "");
        const bridgeResult = await callSkillBridge("diagnose_stuck", { text, last_chapter_summary: lastSummary });
        if (bridgeResult.error) {
          const resp = await chat([
            { role: "system", content: "你是写作诊断专家。分析卡文原因并给出续写方向建议。" },
            { role: "user", content: `以下是我写的正文,但写不下去了:\n\n${text.slice(0, 3000)}\n\n请诊断原因并给续写建议。` },
          ]);
          return JSON.stringify({ diagnosis: resp.content });
        }
        return JSON.stringify(bridgeResult);
      }
      case "audit_novel": {
        const text = String(args.text || "");
        const outline = String(args.outline || "");
        const bridgeResult = await callSkillBridge("audit", { text, outline, pid });
        if (bridgeResult.error) {
          const auditSystemPrompt = `你是资深小说质检员。按${TOTAL_DIMENSIONS}维逐项审计，输出结构化JSON。

严重度分级(对齐oh-story S1-S4)：
S1-严重：影响主线/角色动机/世界规则/读者信任
S2-中等：影响留存/节奏/章节效果/人物可信度
S3-轻微：局部质量/格式/措辞/轻微节奏问题
S4-建议：风格建议或可选增强

${AUDIT_DIMENSIONS_TEXT}

每个finding必须包含：severity(严重度), dimension_id(维度号), dimension(维度名), location(位置), evidence(证据), issue(问题), fix(修复建议)。
判定：有S1→REJECT，有S2→CONCERNS，否则→APPROVE。
输出：{"findings":[{"severity":"S1","dimension_id":1,"dimension":"主角性格矛盾","location":"第X段","evidence":"原文片段","issue":"问题描述","fix":"修复建议"}],"highlights":[{"dimension_id":N,"dimension":"名称","issue":"亮点"}],"verdict":"APPROVE/CONCERNS/REJECT","summary":"总评","platform":"generic"}`;
          const resp = await chat([
            { role: "system", content: auditSystemPrompt },
            { role: "user", content: `审计正文:\n\n${text.slice(0, 8000)}${outline ? "\n\n大纲参考:\n" + outline.slice(0, 3000) : ""}\n\n请严格按${TOTAL_DIMENSIONS}维逐项审计，输出JSON。` },
          ]);
          // 31 维有确定性规则兜底: LLM 漏审的维度由规则层补齐 (第 36 维原创度永远由代码算)
          const ctx = buildAuditContext({ pid, text, outline, chapterId: undefined });
          const rep = auditDimensions(ctx, []);
          return JSON.stringify({
            audit_report: resp.content,
            originality: rep.originality,
            dimensionAudit: rep.dims,
            coverage: rep.coverage,
            ruleFindings: rep.findings,
            text_length: text.length,
            dimensions: TOTAL_DIMENSIONS,
          });
        }
        return JSON.stringify(bridgeResult);
      }
      case "detect_ai": {
        const text = String(args.text || "");
        const bridgeResult = await callSkillBridge("detect_ai", { text });
        if (bridgeResult.error) {
          const aiDetectPrompt = `你是去AI味检测专家。按三遍法检测，输出结构化JSON。

第一遍-模式扫描：检测AI写作指纹(高频套话/情绪告知/章末总结体/叠加式描写/排比堆砌/比喻滥用/引号滥用)
第二遍-深度分析：结构性问题(情绪告知密度/段落长度均匀度/连续排比)
第三遍-综合评估：AI味浓度(0-10) + 等级(轻度/中度/重度) + 删除上限(15%/25%/35%)

每个trace必须包含：category(类别), count(数量), reason(原因), fix(修改建议), evidence(证据:原文片段+位置)。
输出：{"ai_score":0-10,"level":"light/moderate/heavy","traces":[{"category":"类别","count":N,"reason":"原因","fix":"修改","evidence":"证据"}],"depth_issues":[{"type":"类型","count":N,"severity":"S1-S4","fix":"修改","evidence":"证据"}],"verdict":"APPROVE/CONCERNS/REJECT","summary":"总评"}`;
          const resp = await chat([
            { role: "system", content: aiDetectPrompt },
            { role: "user", content: `检测以下文本的AI味:\n\n${text.slice(0, 5000)}\n\n请逐项检测，输出JSON。` },
          ]);
          return JSON.stringify({ ai_detection: resp.content, text_length: text.length });
        }
        return JSON.stringify(bridgeResult);
      }
      case "diagnose_opening": {
        const text = String(args.text || "");
        if (text.length < 50) return JSON.stringify({ error: "文本过短,至少需要 50 字" });
        const bridgeResult = await callSkillBridge("diagnose_opening", { text });
        if (bridgeResult.error) {
          const openingPrompt = `你是开篇诊断专家。从以下5个维度诊断开篇质量，输出JSON：
1.钩子(前200字是否抓人) 2.角色(主角是否鲜明) 3.冲突(是否有核心矛盾) 4.世界观(设定是否清晰) 5.节奏(信息密度是否合适)
输出：{"scores":{"hook":评分(1-10),"character":评分,"conflict":评分,"worldbuilding":评分,"pacing":评分},"issues":[{"dim":"维度","msg":"问题"}],"advice":"改进建议"}`;
          const resp = await chat([
            { role: "system", content: openingPrompt },
            { role: "user", content: `诊断开篇质量:\n\n${text.slice(0, 5000)}\n\n请逐维度诊断，输出JSON。` },
          ]);
          return JSON.stringify({ opening_diagnosis: resp.content, text_length: text.length });
        }
        return JSON.stringify(bridgeResult);
      }
      case "full_audit": {
        const text = String(args.text || "");
        const outline = String(args.outline || "");
        const bridgeResult = await callSkillBridge("full_audit", { text, outline });
        if (bridgeResult.error) {
          const fullAuditPrompt = `你是资深小说质检员+AI味检测员。执行完整审计：${TOTAL_DIMENSIONS}维质量检查(S1-S4) + AI味三遍法检测，输出结构化JSON。

${AUDIT_DIMENSIONS_TEXT}
AI味检测同detect_ai。
综合判定规则：
- 有S1发现 → REJECT
- 有S2发现 或 AI味≥7 → CONCERNS
- 否则 → APPROVE

输出：{"findings":[{"severity":"S1","dimension_id":N,"dimension":"名称","location":"位置","evidence":"证据","issue":"问题","fix":"修复"}],"highlights":[...],"ai_detection":{"ai_score":0-10,"level":"light/moderate/heavy","traces":[...]},"verdict":"APPROVE/CONCERNS/REJECT","summary":"综合报告","platform":"generic"}`;
          const resp = await chat([
            { role: "system", content: fullAuditPrompt },
            { role: "user", content: `全面审计:\n\n${text.slice(0, 8000)}${outline ? "\n\n大纲:\n" + outline.slice(0, 3000) : ""}\n\n请执行${TOTAL_DIMENSIONS}维+AI味完整审计，输出JSON。` },
          ]);
          // 规则层全维兜底 (第 36 维原创度确定性检测)
          const faCtx = buildAuditContext({ pid, text, outline });
          const faRep = auditDimensions(faCtx, []);
          return JSON.stringify({
            full_audit: resp.content,
            originality: faRep.originality,
            dimensionAudit: faRep.dims,
            coverage: faRep.coverage,
            ruleFindings: faRep.findings,
            text_length: text.length,
            dimensions: TOTAL_DIMENSIONS,
          });
        }
        return JSON.stringify(bridgeResult);
      }
      case "ghostwrite": {
        const outlineText = String(args.outline_text || args.outline || "");
        const wordCount = Number(args.words || args.word_count) || 3000;
        const authorName = String(args.author_name || "");
        // ghostwrite 是"按大纲整章重写", 默认替换旧内容; 除非显式 append=true
        const appendMode = args.append === true || args.append === "true";

        // === FIX 4: 加载完整上下文 ===
        const gwProj = store.getProject(pid);
        const gwProfiles = store.listCharacterProfiles(pid);
        const gwWorld = store.listWorldEntries(pid);
        let gwContext = "";
        if (gwProj) gwContext += `项目: ${gwProj.name} | 类型: ${gwProj.genre} | 文风: ${gwProj.style}\n设定: ${gwProj.premise}\n\n`;
        if (gwProfiles.length) gwContext += "【角色】\n" + gwProfiles.map(p => `- ${p.name}: ${p.personality || ""}`).join("\n") + "\n\n";
        if (gwWorld.length) gwContext += "【世界观】\n" + gwWorld.map(w => `- ${w.name}: ${w.description || ""}`).join("\n") + "\n\n";

        const bridgeResult = await callSkillBridge("ghostwrite", { outline: outlineText, word_count: wordCount, author_name: authorName });
        let written: string;
        if (!bridgeResult.error && bridgeResult.text) {
          written = String(bridgeResult.text);
        } else {
          const gwGenreLock = gwProj?.genre ? `\n【风格锁定】本项目类型为「${gwProj.genre}」, 全程禁止偏离。禁止出现其他类型的元素。` : "";
        const resp = await chat([
            { role: "system", content: `你是专业网文写手。根据大纲写正文,约${wordCount}字。${authorName ? `模仿${authorName}的文风。` : ""}\n开篇抓人,章末留钩子,避免AI味。禁止使用:不由得、仿佛、一股暖流、心中暗道。` + gwGenreLock },
            { role: "user", content: `${gwContext}大纲:\n${outlineText}\n\n请写约${wordCount}字正文。` },
          ]);
          written = resp.content;
        }
        // 章节解析: 优先指定ID, 无效时自动用最后章节
        let gwCh = args.chapter_id ? store.getChapter(String(args.chapter_id)) : undefined;
        if (!gwCh) {
          const gwChapters = store.listChapters(pid);
          if (gwChapters.length) gwCh = store.getChapter(gwChapters[gwChapters.length - 1].id);
        }
        if (gwCh) {
          // append=false(默认): 整章替换(删旧换新); append=true: 追加
          const gwFinal = appendMode ? ((gwCh.content || "") + (gwCh.content ? "\n" : "") + written) : written;
          store.updateChapter(gwCh.id, { content: gwFinal, status: "done" });
        }
        return JSON.stringify({ ghostwritten_text: written, chars: written.length, chapter: gwCh ? gwCh.id : null, saved: !!gwCh, replaced: !appendMode });
      }

      // ===== 质检 (36维逐项审计 + 确定性规则层兜底) =====
      case "four_check":
      case "quality_check": {
        let text = String(args.text || "");
        const chapterIdQC = String(args.chapter_id || "");
        if (!text && chapterIdQC) {
          const qcCh = store.getChapter(chapterIdQC);
          text = qcCh?.content || "";
        }
        if (text.length < 20) return JSON.stringify({ error: "文本过短,无法质检" });
        const qcProj = store.getProject(pid);
        const qcCh2 = chapterIdQC ? store.getChapter(chapterIdQC) : undefined;
        const qcOutline = qcCh2?.outline || "";
        const qcGenreHint = qcProj?.genre ? `\n本项目类型: ${qcProj.genre}。维度33"偏离大纲"必须结合大纲核对。` : "";

        // === 确定性规则层 (代码先判: 字数/AI味/密度/伏笔回收), LLM 补创意判断 ===
        const ruleResult = ruleQualityCheck({ pid, text, outline: qcOutline, genre: qcProj?.genre });

        const qcPrompt = `你是资深小说质检员(审核员)。按${TOTAL_DIMENSIONS}维逐项审计,每个维度给出0-10分,输出结构化JSON。
严重度分级(S1-S4): S1=一票否决, S2=中等, S3=轻微, S4=建议。
${AUDIT_DIMENSIONS_TEXT}
${qcGenreHint}
每个维度都要给出结论: 有问题的进 findings (必须带 dimension_id), 没问题的可以不写。
输出必须是纯JSON: {"overall_score":8.3,"verdict":"APPROVE/CONCERNS/REJECT","findings":[{"severity":"S2","dimension_id":17,"dimension":"巧合过多","issue":"...","fix":"..."}],"highlights":[...],"quality_check":"总评"}。不要markdown代码块。`;
        let llmParsed: Record<string, any> = {};
        try {
          const resp = await chat([
            { role: "system", content: qcPrompt },
            { role: "user", content: `质检以下章节:\n\n${text.slice(0, 8000)}${qcOutline ? "\n\n大纲:\n" + qcOutline.slice(0, 3000) : ""}\n\n请严格按${TOTAL_DIMENSIONS}维逐项审计,输出JSON。` },
          ]);
          llmParsed = extractJsonPayload(resp.content) || {};
          if (Object.keys(llmParsed).length === 0) {
            const vMatch = resp.content.match(/verdict\s*["']?\s*[:：]\s*["']?\s*([A-Z]+)/i);
            const oMatch = resp.content.match(/overall_score\s*["']?\s*[:：]\s*(\d+(?:\.\d+)?)/i);
            if (vMatch) llmParsed.verdict = vMatch[1];
            if (oMatch) llmParsed.overall_score = Number(oMatch[1]);
            llmParsed.rawText = resp.content;
          }
        } catch {
          llmParsed = { verdict: "REJECT", overall_score: 0, rawText: "LLM 质检调用失败, 仅采用规则层结果" };
        }

        // === 36 维全维审计: 规则层对每一维跑确定性检测, LLM 漏审的维度由规则层兜底 ===
        const auditCtx = buildAuditContext({
          pid, text, outline: qcOutline, genre: qcProj?.genre, chapterId: chapterIdQC || undefined,
        });
        const dimReport = auditDimensions(auditCtx, (llmParsed.findings || []) as Array<Record<string, unknown>>);

        // === 规则层兜底: 规则层 REJECT 时, LLM 不能翻盘 (弱模型乱给高分也能被封顶) ===
        const ruleReject = ruleResult.verdict === "REJECT";
        const llmVerdict = String(llmParsed.verdict || "").toUpperCase();
        const llmOverall = Number(llmParsed.overall_score ?? 0);

        // 最终判定: 规则层 REJECT → 强制打回; 否则 LLM CONCERNS + 规则 CONCERNS 合并; LLM APPROVE + 规则 APPROVE 才放行
        let finalVerdict: "APPROVE" | "CONCERNS" | "REJECT";
        if (ruleReject && llmVerdict === "APPROVE") {
          finalVerdict = "CONCERNS";  // 规则层否决, 降一级但不完全抹掉 LLM 创意分
        } else if (ruleReject) {
          finalVerdict = "REJECT";
        } else if (llmVerdict === "REJECT") {
          finalVerdict = "REJECT";
        } else if (ruleResult.verdict === "CONCERNS" || llmVerdict === "CONCERNS") {
          finalVerdict = "CONCERNS";
        } else {
          finalVerdict = "APPROVE";
        }

        // 36 维规则层结论并入: 强规则命中 S1 → 一票否决; 其它命中 → 至少 CONCERNS
        if (dimReport.forceReject) {
          finalVerdict = "REJECT";
        } else if (dimReport.forceConcerns && finalVerdict === "APPROVE") {
          finalVerdict = "CONCERNS";
        }
        // 大量维度两层都没审 → 不放行 (防止"没审 = 没问题"的假通过)
        if (dimReport.unauditedIds.length > 4 && finalVerdict === "APPROVE" && llmOverall < 7) {
          finalVerdict = "CONCERNS";
        }
        if (dimReport.findings.length > 0) {
          (llmParsed.findings = llmParsed.findings || []).push(...dimReport.findings);
        }

        const passed = finalVerdict === "APPROVE" || (finalVerdict === "CONCERNS" && llmOverall >= 7);

        if (chapterIdQC) {
          if (passed) store.updateChapter(chapterIdQC, { status: "reviewed" });
          else if (finalVerdict === "REJECT" || llmOverall < 7) store.updateChapter(chapterIdQC, { status: "revision_needed" });
        }

        const payload: Record<string, any> = {
          ...(Object.keys(llmParsed).length ? llmParsed : { quality_check: "LLM 无输出, 仅规则层结果" }),
          verdict: finalVerdict,
          ruleVerdict: ruleResult.verdict,
          ruleReasons: ruleResult.reasons,
          wordCount: ruleResult.wordCount,
          density: ruleResult.density,
          aiScore: ruleResult.aiScore,
          aiLevel: ruleResult.aiLevel,
          openForeshadows: ruleResult.openForeshadows,
          // === 36 维全维审计结果 ===
          dimensionCoverage: dimReport.coverage,
          dimensionAudit: dimReport.dims,          // 36 条, 逐维标出谁审的/命中什么
          ruleFindings: dimReport.findings,        // 规则层补审产出的问题
          unauditedDimensions: dimReport.unauditedIds, // 两层都没审的维度(如实暴露, 不伪造覆盖)
          // 第 36 维: 原创度 (确定性检测, 防照抄/自我重复)
          originality: dimReport.originality,
          passed,
          chapterId: chapterIdQC,
          text_length: text.length,
          dimensions_total: TOTAL_DIMENSIONS,
        };
        return JSON.stringify(payload);
      }

      // ===== 上下文加载 =====
      case "load_context": {
        const proj = store.getProject(pid);
        const chapters = store.listChapters(pid);
        const elements = store.listElements(pid);
        const profiles = store.listCharacterProfiles(pid);
        const world = store.listWorldEntries(pid);
        const milestones = store.listMilestones(pid);
        const foreshadowings = store.listForeshadowings(pid);
        const styleCache = store.getDb().prepare("SELECT * FROM style_cache WHERE project_id=? ORDER BY chapter_idx DESC LIMIT 3").all(pid);
        return JSON.stringify({
          project: proj ? { name: proj.name, genre: proj.genre, premise: proj.premise, style: proj.style } : null,
          chapters_count: chapters.length,
          latest_chapter: chapters.length ? { title: chapters[chapters.length - 1]!.title, content_preview: (chapters[chapters.length - 1]!.content || "").slice(0, 500) } : null,
          elements: elements.slice(0, 20),
          character_profiles: profiles.slice(0, 10),
          world_entries: world.slice(0, 20),
          milestones: milestones.slice(0, 10),
          foreshadowings: foreshadowings.slice(0, 10),
          style_cache: styleCache,
        });
      }

      // ===== 风格缓存 =====
      case "cache_style": {
        const cidx = Number(args.chapter_idx);
        if (isNaN(cidx)) return JSON.stringify({ error: "需要 chapter_idx" });
        store.upsertStyleCache(pid, cidx, String(args.features || ""), String(args.keywords || ""));
        return JSON.stringify({ chapter_idx: cidx, status: "cached" });
      }

      // ===== 对抗式审查 =====
      case "challenge_review": {
        const targetAgent = String(args.target_agent || "");
        const issue = String(args.issue || "");
        const resp = await chat([
          { role: "system", content: `你是对抗式审查员。对 ${targetAgent} 的工作提出质疑和挑战。` },
          { role: "user", content: `挑战 ${targetAgent}: ${issue}` },
        ]);
        return JSON.stringify({ challenge: resp.content, target_agent: targetAgent });
      }
      case "resolve_challenge": {
        const challengeId = String(args.challenge_id || "");
        const response = String(args.response || "");
        return JSON.stringify({ challenge_id: challengeId, response, status: "resolved" });
      }

      // ===== 交付报告 =====
      case "generate_delivery_report": {
        const proj2 = store.getProject(pid);
        const chaps = store.listChapters(pid);
        const totalChars = chaps.reduce((sum, c) => sum + (c.content?.length || 0), 0);
        const doneChaps = chaps.filter(c => c.status === "done" || c.status === "reviewed");
        const resp = await chat([
          { role: "system", content: "你是项目交付报告生成器。生成项目进度、质量、风格一致性的可视化报告。" },
          { role: "user", content: `项目: ${proj2?.name || "未知"}\n类型: ${proj2?.genre || "未知"}\n总章数: ${chaps.length}\n已完成: ${doneChaps.length}\n总字数: ${totalChars}\n请生成交付报告。` },
        ]);
        return JSON.stringify({ report: resp.content, stats: { total_chapters: chaps.length, done: doneChaps.length, total_chars: totalChars } });
      }

      // ===== 技能侦察 =====
      case "skill_scout": {
        const genre = String(args.genre || "");
        const resp = await chat([
          { role: "system", content: "你是网文市场分析师。分析当前网文市场热门题材、读者偏好、流量赛道。" },
          { role: "user", content: `分析${genre || "通用"}题材的市场趋势和创作建议。` },
        ]);
        return JSON.stringify({ market_analysis: resp.content });
      }

// ===== 委派 =====
      case "delegate_to_agent": {
        return JSON.stringify({ error: "delegate_to_agent 必须由 agent 运行时处理" });
      }

      // ===== 决策层工具 (autonomous 模式) =====
      // 逐章审查: 代码层判定阈值(不靠模型自觉), 模型只看建议
      case "assess_chapter": {
        const chapterId = String(args.chapter_id || "");
        const ch = chapterId ? store.getChapter(chapterId) : undefined;
        if (!ch) return JSON.stringify({ error: "章节不存在" });
        const content = ch.content || "";
        // 确定性规则层(无 LLM 成本): 密度/是否高潮/建议阈值/是否需要审查
        const r = assessChapterRules({ pid, chapterIdx: ch.idx, content, outline: ch.outline });
        const phase5 = store.getProjectState(pid).currentPhase === 5;
        return JSON.stringify({
          chapterId, chapterIdx: ch.idx, title: ch.title,
          density: r.density, isPeak: r.isPeak,
          currentPhase: phase5 ? 5 : "non-write",
          suggestedThreshold: r.suggestedThreshold,
          needReview: r.needReview,
          guidance: r.reason,
          _rule: "assess_chapter 判定由代码层完成(密度/高潮/阈值), 模型只看 guidance 决定执行",
        });
      }

      // 跨章一致性反思: 模型主动检索全书伏笔/角色状态, 输出反思
      case "reflect_consistency": {
        const pid_ = pid;
        const foreshadows = store.listForeshadowings(pid_);
        const openForeshadows = foreshadows.filter((f: any) => f.status !== "recovered" && f.status !== "abandoned");
        const charStates = store.listCharacterStates(pid_);
        const chapters = store.listChapters(pid_);
        const doneChapters = chapters.filter((c) => c.status === "done" || c.status === "reviewed");
        const pendingCount = openForeshadows.length;
        // 确定性反思报告: 未回收伏笔 + 角色状态 + 已写章节统计
        return JSON.stringify({
          open_foreshadows: openForeshadows.map((f: any) => ({ name: f.name, planted_chapter: f.planted_chapter, expected_recovery: f.expected_recovery, content: String(f.content || "").slice(0, 100) })),
          pending_count: pendingCount,
          character_states_count: charStates.length,
          chapters_total: chapters.length,
          chapters_done: doneChapters.length,
          latest_chapter: chapters.length ? { title: chapters[chapters.length - 1]!.title, idx: chapters[chapters.length - 1]!.idx } : null,
          reflection_hint: "请检查: 1) 伏笔是否在该回收时回收 2) 角色状态是否前后矛盾 3) 设定是否漂移。发现异常请用 manage_character / manage_world 更新或 add_element(kind=foreshadow) 记录。",
        });
      }

      // 弧线工具: 评估当前弧线
      case "assess_arc": {
        const arc = assessArc(pid);
        return JSON.stringify(arc);
      }

      // 弧线调整: 主 Agent 的决策记录(改变后续章节密度目标)
      case "adjust_arc": {
        const newDensity = Number(args.new_density);
        const reason = String(args.reason || "未说明");
        if (isNaN(newDensity)) return JSON.stringify({ error: "new_density 必须是数字" });
        const adj = adjustArc(pid, newDensity, reason);
        return JSON.stringify({ ...adj, applied: true, note: "弧线目标已更新, 后续章节将按新密度目标执行。" });
      }

      default:
        return JSON.stringify({ error: `未知工具: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: `工具 ${name} 执行异常: ${(e as Error).message}` });
  }
}

// ===== 网络工具 =====

// ===== 平台榜单直抓 (真实浏览器) =====
// 支持平台 + 多榜单URL映射 + 智能提取

interface PlatformConfig {
  match: string[];
  boards: Record<string, string>;  // board名 -> URL
  defaultBoard: string;
  extract: (text: string, board: string) => string;
  /** 可选: 该平台的后端 JSON API (直接给结构化数据, 绕开 JS 渲染壳页). board -> API URL */
  api?: Record<string, string>;
  /** 页面编码: GBK 平台 (晋江) 需手动解码, 否则中文乱码 */
  charset?: string;
  /**
   * 强制先走真实浏览器层 (Playwright + DOM 选择器), 不先看 HTML 层。
   * 用于"HTML 层能抓到但抽出的是脏数据、且脏数据过得了 looksLikeGarbage 校验"的平台 ——
   * 书旗书名和作者是相邻无分隔的两个 span, 去标签后粘成一团, 看起来仍像书名。
   */
  rbFirst?: boolean;
  /**
   * 平台专属抓取 (优先于 api/HTML 通用流程)。
   * 用于"通用流程表达不了"的平台: 番茄有三套互不相关的榜 (作家榜/巅峰榜/分类榜),
   * 分类榜还是 PUA 字体混淆, 需要拿 bookId 二次抓详情页还原 —— 塞不进 url→JSON→list 这套通用流程。
   * 返回 null 表示"这个榜我不处理", 调用方会继续走通用流程。
   */
  customFetch?: (board: string, genre: string) => Promise<{
    items: string[];
    rawText: string;
    url: string;
  } | null>;
}

const PLATFORMS: PlatformConfig[] = [
  // ---- 起点中文网 ----
  {
    match: ["起点", "qidian"],
    defaultBoard: "畅销榜",
    boards: {
      "畅销榜": "https://www.qidian.com/rank/hotsales/",
      "月票榜": "https://www.qidian.com/rank/yuepiao/",
      "人气榜": "https://www.qidian.com/rank/readIndex/",
      "追读榜": "https://www.qidian.com/rank/readIndex/",  // 同人气
      "收藏榜": "https://www.qidian.com/rank/collect/",
      "推荐榜": "https://www.qidian.com/rank/recom/",
      "新书榜": "https://www.qidian.com/rank/newBook/",
      "更新榜": "https://www.qidian.com/rank/update/",
      "三江": "https://www.qidian.com/",
      "往期三江": "https://www.qidian.com/sanjiang/",
    },
    extract: (text, board) => {
      // 三江·网文新风 板块
      if (board === "三江") {
        const sIdx = text.indexOf("三江·网文新风");
        if (sIdx >= 0) {
          const seg = text.slice(sIdx, sIdx + 2000);
          return "三江·网文新风(当前推荐):\n" + seg;
        }
        // 尝试其他关键词
        const s2 = text.indexOf("三江推荐");
        if (s2 >= 0) return "三江推荐:\n" + text.slice(s2, s2 + 2000);
        return "三江板块(未找到具体数据，返回全文摘要):\n" + text.slice(0, 2000);
      }
      // 往期三江
      if (board === "往期三江") {
        // 找日期段落
        const dateMatch = text.match(/\d{4}\.\d{2}\.\d{2}[-–]\d{4}\.\d{2}\.\d{2}/);
        const startIdx = dateMatch ? text.indexOf(dateMatch[0]) : 0;
        return "往期三江推荐:\n" + text.slice(startIdx, startIdx + 3000);
      }
      // 畅销/月票/人气等榜单: 提取排名+书名+作者
      const out: string[] = [];
      const clean = text.replace(/\s+/g, " ");
      // 模式1: 数字序号 + 书名
      for (const m of clean.matchAll(/(\d{1,2})\s*[.、．]\s*([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,30})\s*([\u4e00-\u9fa5]{2,10})/g)) {
        out.push(`第${m[1]}名: ${m[2]} (作者: ${m[3]})`);
        if (out.length >= 15) break;
      }
      // 模式2: 纯数字行 (传统起点布局)
      if (out.length === 0) {
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          if (/^\d{1,2}$/.test(lines[i]) && parseInt(lines[i], 10) <= 30) {
            out.push(`第${lines[i]}名: ${lines[i+1] || "?"} (作者: ${lines[i+2] || "?"})`);
            if (out.length >= 15) break;
          }
        }
      }
      return out.length > 0 ? out.join("\n") : clean.slice(0, 2000);
    },
  },

  // ---- 起点女生网 ----
  {
    match: ["起点女生", "qdmm", "女频"],
    defaultBoard: "畅销榜",
    // 【必须用 qdmm.com 而不是 qidian.com/rank/*/fin/】
    // 起点女生网是独立域名 www.qdmm.com。早前配成 `qidian.com/rank/hotsales/fin/`,
    // 那个 "fin" 段实测会被起点忽略并回落到男生站内容 —— 于是「起点女生网」和
    // 「起点中文网」抓回同一份榜单, 8 个名额白占一个, 女频趋势永久缺失。
    // 2026-10 实测 qdmm.com 四个榜单 each ~5s / 20 条, 均正常。
    boards: {
      "畅销榜": "https://www.qdmm.com/rank/hotsales/",
      "月票榜": "https://www.qdmm.com/rank/yuepiao/",
      "人气榜": "https://www.qdmm.com/rank/readIndex/",
      "收藏榜": "https://www.qdmm.com/rank/collect/",
      "新书榜": "https://www.qdmm.com/rank/newBook/",
    },
    extract: (text, board) => {
      const out: string[] = [];
      const clean = text.replace(/\s+/g, " ");
      for (const m of clean.matchAll(/(\d{1,2})\s*[.、．]\s*([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,30})\s*([\u4e00-\u9fa5]{2,10})/g)) {
        out.push(`第${m[1]}名: ${m[2]} (作者: ${m[3]})`);
        if (out.length >= 15) break;
      }
      if (out.length === 0) {
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          if (/^\d{1,2}$/.test(lines[i]) && parseInt(lines[i], 10) <= 30) {
            out.push(`第${lines[i]}名: ${lines[i+1] || "?"} (作者: ${lines[i+2] || "?"})`);
            if (out.length >= 15) break;
          }
        }
      }
      return out.length > 0 ? "起点女生网 " + board + ":\n" + out.join("\n") : clean.slice(0, 2000);
    },
  },

  // ---- 番茄小说 ----
  {
    match: ["番茄", "fanqie"],
    // 【默认不再是"阅读榜"】/api/rank/list?way=N 是**假榜**: way=1..8 全部返回同一份都市赘婿综合榜,
    // 没有任何题材区分度, 用户当场指出"这种的榜没啥作用"。默认改抓按题材分类的**分类榜**。
    // 老的阅读榜/热度榜/新书榜保留在下面, 手动指定 board 仍能抓 (用户要求降级但不删除)。
    defaultBoard: "分类榜",
    boards: {
      "分类榜": "https://fanqienovel.com/rank",
      "分类新书榜": "https://fanqienovel.com/rank",
      "金番作家榜": "https://fanqienovel.com/",
      "巅峰榜": "https://fanqienovel.com/",
      "阅读榜": "https://fanqienovel.com/rank",
      "热度榜": "https://fanqienovel.com/rank",
      "新书榜": "https://fanqienovel.com/rank",
    },
    // 番茄 /rank 页是 JS 渲染壳页, 真实数据走 JSON API (已实测: /api/rank/list?way=1 返回 data.list[].bookName/author/abstract)
    api: {
      "阅读榜": "https://fanqienovel.com/api/rank/list?way=1",
      "热度榜": "https://fanqienovel.com/api/rank/list?way=2",
      "新书榜": "https://fanqienovel.com/api/rank/list?way=3",
    },
    // 三套榜 + 字体混淆还原, 全部在 src/agents/fanqie.ts
    customFetch: async (board: string, genre: string) => {
      const FQ_URL = "https://fanqienovel.com/";
      if (board === "金番作家榜") {
        const authors = await fanqie.fetchFanqieAuthorBoard();
        if (authors.length === 0) return null;
        const items = fanqie.formatFanqieBooks(authors, "番茄金番作家榜（殿堂作家 / 金番作家，按平台作家等级排序）");
        return { items, rawText: items.join("\n"), url: FQ_URL + "api/author/misc/top_author_list/v1/" };
      }
      if (board === "巅峰榜") {
        const tops = await fanqie.fetchFanqieTopBooks(30);
        if (tops.length === 0) return null;
        const items = fanqie.formatFanqieBooks(tops, "番茄巅峰榜（按好评、人气、互动综合得分）");
        return { items, rawText: items.join("\n"), url: FQ_URL + "api/author/misc/top_book_list/v1/" };
      }
      if (board === "分类榜" || board === "分类新书榜") {
        const isNew = board === "分类新书榜";
        const cat = fanqie.pickFanqieCategory(genre);
        // 番茄没有"武侠"大类, 也没有泛"言情" —— 映射不到就如实回退巅峰榜,
        // 绝不拿个不沾边的分类冒充 (历史上拿都市赘婿榜冒充仙侠榜被用户当场抓包)
        if (!cat) {
          const tops = await fanqie.fetchFanqieTopBooks(20);
          if (tops.length === 0) return null;
          const items = fanqie.formatFanqieBooks(
            tops,
            `番茄巅峰榜（⚠️ 番茄无「${genre}」对应分类，改抓全站头部精品，仅供参考）`,
          );
          return { items, rawText: items.join("\n"), url: FQ_URL + "api/author/misc/top_book_list/v1/" };
        }
        const books = await fanqie.fetchFanqieCategoryBoard(cat, isNew ? 2 : 1);
        if (books.length === 0) return null;
        const items = fanqie.formatFanqieBooks(
          books,
          `番茄${cat.name}·${isNew ? "新书" : "阅读"}榜（按在读数据排序，${isNew ? "30万字以下" : "30万字以上"}）`,
        );
        return {
          items,
          rawText: items.join("\n"),
          url: `https://fanqienovel.com/api/rank/category/list?category_id=${cat.id}&gender=${cat.gender}&rankMold=${isNew ? 2 : 1}`,
        };
      }
      return null; // 阅读榜/热度榜/新书榜走下方通用 api 流程
    },
    extract: (text, board) => {
      const clean = text.replace(/\s+/g, " ");
      const out: string[] = [];
      // 番茄格式: "01 - 书名 作者 (类型)"
      for (const m of clean.matchAll(/(\d{1,2})\s*[-–]\s*([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,40})\s*([\u4e00-\u9fa5]{2,10})\s*[（(]?([^)）]*)?[)）]?/g)) {
        out.push(`第${m[1]}名: ${m[2]} (作者: ${m[3]}${m[4] ? ' 类型: ' + m[4] : ''})`);
        if (out.length >= 15) break;
      }
      // 备选: 中文数字序号
      if (out.length === 0) {
        const cnNum = "一二三四五六七八九十";
        for (const m of clean.matchAll(/([一二三四五六七八九十])\s*[、.\-]\s*([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,40})/g)) {
          out.push(`${m[1]}、${m[2]}`);
          if (out.length >= 15) break;
        }
      }
      return out.length > 0 ? "番茄小说 " + board + ":\n" + out.join("\n") : clean.slice(0, 2000);
    },
  },

  // ---- 晋江文学城 ----
  {
    match: ["晋江", "jjwxc"],
    defaultBoard: "月票榜",
    boards: {
      "月票榜": "https://www.jjwxc.net/topten.php?orderstr=3&t=0",
      "新晋作者榜": "https://www.jjwxc.net/topten.php?orderstr=9&t=0",
      "收藏榜": "https://www.jjwxc.net/topten.php?orderstr=5&t=0",
      "点击榜": "https://www.jjwxc.net/topten.php?orderstr=2&t=0",
      "推荐榜": "https://www.jjwxc.net/topten.php?orderstr=4&t=0",
      "VIP榜": "https://www.jjwxc.net/topten.php?orderstr=7&t=0",
    },
    charset: "gbk", // 晋江是 GBK 编码, 必须手动解码否则乱码
    extract: (text, board) => {
      // 真实结构 (已实测): <a ... href="onebook.php?novelid=xxx" rel="..." class="tooltip">书名</a>
      const out: string[] = [];
      for (const m of text.matchAll(/href="onebook\.php\?novelid=\d+"[^>]*>([^<]{2,40})<\/a>/g)) {
        const title = m[1].trim();
        if (!title || title.length < 2) continue;
        out.push(title);
        if (out.length >= 30) break;
      }
      if (out.length > 0) {
        return "晋江文学城 " + board + " (前" + out.length + "部, 按出现顺序):\n" + out.map((t, i) => (i + 1) + ". " + t).join("\n");
      }
      // 回退: 老逻辑保持原文
      return text.replace(/\s+/g, " ").slice(0, 2500);
    },
  },

  // ---- 飞卢小说网 ----
  {
    match: ["飞卢", "faloo", "b.faloo"],
    defaultBoard: "排行榜",
    boards: {
      "排行榜": "https://b.faloo.com/y_0_0_0_0_3_1_0.html",
      "月票榜": "https://b.faloo.com/y_0_0_0_0_3_2_0.html",
      "收藏榜": "https://b.faloo.com/y_0_0_0_0_3_3_0.html",
      "点击榜": "https://b.faloo.com/y_0_0_0_0_3_5_0.html",
      "更新榜": "https://b.faloo.com/y_0_0_0_0_3_6_0.html",
    },
    extract: (text, _board) => {
      const clean = text.replace(/\s+/g, " ");
      const out: string[] = [];
      // 飞卢格式: 书名 + 作者 通常连续出现
      for (const m of clean.matchAll(/([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{3,30})\s*作家[：:]\s*([\u4e00-\u9fa5]{2,10})/g)) {
        out.push(`${m[1]} (作者: ${m[2]})`);
        if (out.length >= 15) break;
      }
      return out.length > 0 ? "飞卢小说 " + _board + ":\n" + out.join("\n") : clean.slice(0, 2000);
    },
  },

  // ---- 书旗小说 ----
  {
    match: ["书旗", "shuqi"],
    defaultBoard: "点击榜",
    // 【强制走真实浏览器层】去标签后的纯文本把"序号+书名+作者"粘成一串 ("2 村野乱事黄金水饺"),
    // 旧正则抽出的书名全都带着序号、尾部还挂着作者名, 且长得像书名 → 混进趋势归纳。
    // 浏览器层按 <span class="bn">/<span class="au"> 精确拆开。
    rbFirst: true,
    boards: {
      "点击榜": "https://www.shuqi.com/rank",
    },
    extract: (text, _board) => {
      const clean = text.replace(/\s+/g, " ");
      const out: string[] = [];
      // 书旗格式: "1 书名 作者" 
      for (const m of clean.matchAll(/(\d{1,3})\s+([\u4e00-\u9fa5A-Za-z0-9：:《》\-]{2,30})\s+([\u4e00-\u9fa5]{2,10})/g)) {
        const rank = parseInt(m[1]);
        if (rank > 0 && rank <= 50) {
          out.push(`第${m[1]}名: ${m[2]} (作者: ${m[3]})`);
        }
        if (out.length >= 15) break;
      }
      return out.length > 0 ? "书旗小说 " + _board + ":\n" + out.join("\n") : clean.slice(0, 2000);
    },
  },

  // ---- QQ阅读 ----
  {
    match: ["QQ阅读", "qq阅读", "qq阅读", "book.qq"],
    defaultBoard: "热门榜",
    boards: {
      "热门榜": "https://book.qq.com/rank/hot",
    },
    extract: (text, _board) => {
      return text.replace(/\s+/g, " ").slice(0, 2000);
    },
  },
];

/** 根据平台名和board名匹配平台配置 */
function findPlatform(platform: string): PlatformConfig | undefined {
  // 【最长匹配优先】"起点女生网" 同时能被 "起点" 和 "起点女生网" 命中,
  // 按 PLATFORMS 数组顺序取第一个会落到起点配置 → 两个平台抓同一份榜单, 白占一个名额。
  // 按命中的 match 关键字长度降序排, 更具体的那个赢。
  const hits = PLATFORMS
    .map((p) => ({ p, len: Math.max(...p.match.filter((m) => platform.includes(m)).map((m) => m.length), 0) }))
    .filter((x) => x.len > 0)
    .sort((a, b) => b.len - a.len);
  return hits[0]?.p;
}

/**
 * extract 正则抽出来的东西到底能不能用。
 * 实测书旗会抽出 "**《**《2》**" —— 把排名序号当成书名, 旧逻辑照样当成功交给 LLM 归纳,
 * 脏数据混进趋势分析。这里统一按"书名是否像书名"判定。
 */
function looksLikeGarbage(items: string[]): boolean {
  if (items.length === 0) return true;
  const titles = items
    .map((l) => (l.match(/《([^》]*?)》/) || [])[1] || "")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  // 书名缺失 / 过短 / 纯符号纯数字 → 判垃圾
  if (titles.length === 0) return true;
  // 【陷阱】别用 /^[\d\s\W_]+$/ : \w 只含 [A-Za-z0-9_], 而汉字属于 \W → 所有中文书名都被误判为
  // 垃圾, 结果就是每次都触发"真实浏览器层重抽"。这里要用 Unicode 属性转义判纯符号串。
  const isJunk = (t: string) => /^[^\p{L}\p{N}]+$/u.test(t) || /^\d+$/u.test(t);
  const bad = titles.filter((t) => t.length < 2 || isJunk(t)).length;
  return bad / titles.length > 0.4;
}

/** 根据board名模糊匹配到具体URL */
function resolveBoardUrl(conf: PlatformConfig, board: string): { url: string; boardName: string } {
  if (!board) return { url: conf.boards[conf.defaultBoard]!, boardName: conf.defaultBoard };
  // 精确匹配
  if (conf.boards[board]) return { url: conf.boards[board], boardName: board };
  // 模糊匹配 (包含关系)
  for (const [name, url] of Object.entries(conf.boards)) {
    if (board.includes(name) || name.includes(board)) return { url, boardName: name };
  }
  // 没找到就用默认
  return { url: conf.boards[conf.defaultBoard]!, boardName: conf.defaultBoard };
}

/**
 * 【承诺型委派】从总编正文里认出它点名的专家。
 * 总编写了 "我将委派主笔 agent 撰写第一章正文" 却没发 tool_call 时, 代码层要补发这次委派,
 * 目标必须以**它点名的那个**为准 —— 否则按 PHASES[currentPhase] 硬路由会派错人
 * (项目 phase 常停在 1=扫榜, 用户要写正文时被派回架构师再扫一次榜)。
 * 认不出来返回 undefined, 由调用方回退到阶段表。
 */
const PLEDGE_AGENT_ALIASES: Array<[RegExp, string]> = [
  [/主笔|写手|撰稿|写正文|narrative[-_]?writer|\bwriter\b/i, "narrative-writer"],
  [/架构师|拆书|大纲|architect/i, "story-architect"],
  [/角色|人设|人物|character[-_]?designer/i, "character-designer"],
  [/审校|质检|审核|一致性|checker|consistency/i, "consistency-checker"],
  [/资料员|检索|搜资料|explorer/i, "story-explorer"],
  [/交付|汇报|presenter/i, "presenter"],
];
function pledgeTarget(body: string): string | undefined {
  if (!body) return undefined;
  for (const [re, name] of PLEDGE_AGENT_ALIASES) {
    if (re.test(body)) return name;
  }
  return undefined;
}

async function crawlRanking(
  platform: string,
  genre: string,
  board: string,
): Promise<{ source: string; board: string; url: string; items: string[]; rawText: string }> {
  const conf = findPlatform(platform) || PLATFORMS[0]!;
  const boardName = conf.boards[board] ? board : conf.defaultBoard;
  const apiConf = conf as PlatformConfig & { api?: Record<string, string> };
  // === 优先走 JSON API (真实结构化数据, 绕开 JS 渲染壳页) ===
  const apiPath = apiConf.api?.[boardName];
  // 题材过滤: 榜单抓回后按 title+abstract 关键词打分, 命中 0 条才用全量 (并标注偏离)。
  // 词表与判定逻辑全部在 src/agents/genreFilter.ts (纯函数 + 有回归用例), 不要在这里再抄一份 ——
  // 抄一份就等于改词表时改了这边忘了那边, 历史上因此反复出现"赘婿文被判成仙侠"。
  const genreCanon = normGenre(genre);
  const genreKws = genreKwsOf(genre);
  // === 平台专属抓取 (番茄: 作家榜/巅峰榜/分类榜三套体系 + PUA 字体混淆二次还原) ===
  // 返回 null 表示该榜不由专属逻辑处理, 继续往下走通用 api / HTML 流程。
  if (conf.customFetch) {
    try {
      const cr = await conf.customFetch(boardName, genre);
      if (cr && cr.items.length > 0) {
        logInfo(`[扫榜] ${platform} 平台专属抓取成功 (${cr.items.length} 条) 榜=${boardName} 题材=${genre} ${cr.url}`);
        return { source: "platform-custom", board: boardName, url: cr.url, items: cr.items, rawText: cr.rawText };
      }
    } catch (e) {
      logInfo(`[扫榜] ${platform} 平台专属抓取失败 (${(e as Error).message?.slice(0, 60)}), 回退通用流程`);
    }
  }
  if (apiPath) {
    try {
      const resp = await fetch(apiPath, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
        signal: AbortSignal.timeout(20000),
      });
      const j: any = await resp.json();
      let list: any[] = j?.data?.list || j?.list || [];
      let apiPathForLog = apiPath;
      // 番茄 API way=1 返回综合榜, 不带分类过滤; 拼接题材词到查询让 API 尽量命中对应分类
      if (apiPath.includes("fanqienovel.com") && genreCanon) {
        const sep = apiPath.includes("?") ? "&" : "?";
        const filteredPath = apiPath + sep + "keyword=" + encodeURIComponent(genreCanon);
        try {
          const resp2 = await fetch(filteredPath, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(15000),
          });
          const j2: any = await resp2.json();
          const list2: any[] = j2?.data?.list || j2?.list || [];
          // 【别自欺欺人】番茄 rank API 实测**根本不吃 keyword 参数**: 加与不加返回同一份综合榜
          // (全是都市赘婿/总裁文)。旧代码只要 list2 非空就宣布"题材过滤查询命中 N 条",
          // 于是同一份 unrelated 的综合榜被当成"仙侠榜"转手交给 LLM —— 用户当场发现数据不对。
          // 书单完全相同就说明参数没生效: 不换榜, 如实记日志, 交给下方本地题材关键词兜底。
          const key = (b: any) => String(b?.bookId || b?.book_id || b?.bookName || b?.book_name || b?.title || "");
          const unchanged = list2.length > 0 && list2.length === list.length &&
            list2.every((b, i) => key(b) === key(list[i]));
          if (unchanged) {
            logInfo(`[扫榜] ${platform} keyword 题材参数无效 (返回与不过滤完全相同, 仍是综合榜), 改由本地题材关键词过滤`);
          } else if (list2.length > 0) {
            logInfo(`[扫榜] ${platform} 题材过滤查询命中 ${list2.length} 条 ${filteredPath}`);
            list = list2;
            apiPathForLog = filteredPath;
          }
        } catch { /* 题材查询失败, 用全量 */ }
      }
      // 不再拼 items[] (会被 parseRankingItems 二次解析错乱), 直接输出结构化文本行
      // 按题材过滤: 命中的排前面; 全部偏离时仍展示全量并标注
      const filtered = genreKws.length > 0
        ? list.filter((b) => matchGenre(String(b.bookName || b.book_name || b.title || ""), String(b.abstract || b.summary || ""), genre))
        : list;
      const useList = filtered.length > 0 ? filtered : list;
      const out: string[] = [];
      const allTitles: string[] = [];
      for (let i = 0; i < Math.min(useList.length, 20); i++) {
        const b = useList[i];
        const title = String(b.bookName || b.book_name || b.title || "").trim();
        const author = String(b.author || b.authorName || "").trim();
        const blurb = String(b.abstract || b.summary || "").replace(/\n/g, " ").trim();
        allTitles.push(title);
        out.push(`第${i + 1}名: **《${title}》**${author ? " (作者: " + author + ")" : ""}${blurb ? " | 💡 " + blurb.slice(0, 80) + (blurb.length > 80 ? "…" : "") : ""}`);
      }
      const genreNote = genreKws.length > 0 && filtered.length === 0
        ? `\n\n⚠️ 榜单为综合榜, 未抓到「${genre}」分类作品 (平台无该分类或当前榜偏离), 以下为全量榜数据, 请结合题材判断。`
        : genreKws.length > 0 && filtered.length > 0 ? `\n✅ 已按「${genre}」过滤, 命中 ${filtered.length} 部。` : "";
      if (out.length > 0) {
        logInfo(`[扫榜] ${platform} JSON API 直连成功 (${out.length} 条) ${apiPathForLog} 题材=${genre} 过滤后=${filtered.length}`);
        return { source: "json-api", board: boardName, url: apiPathForLog, items: out, rawText: out.join("\n") + genreNote };
      }
      logInfo(`[扫榜] ${platform} JSON API 返回 0 条, 回退 HTML 解析`);
    } catch (e) {
      logInfo(`[扫榜] ${platform} JSON API 失败 (${(e as Error).message?.slice(0, 60)}), 回退 HTML 解析`);
    }
  }
  // === 回退: 抓 HTML 壳页 + extract 正则 ===
  const { url, boardName: bn } = resolveBoardUrl(conf, board);
  let text = "";
  let err = "";
  let usedScrapling = false;
  try {
    if (conf.charset === "gbk") {
      // GBK 平台 (晋江): 拿原始字节手动解码, 避免 UTF-8 误读乱码
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
        signal: AbortSignal.timeout(15000),
      });
      const buf = await resp.arrayBuffer();
      text = new TextDecoder("gbk").decode(buf);
    } else {
      // 优先走 Scrapling 侧车 (curl_cffi TLS 指纹破反爬, 拿最新真实榜单);
      // 无 Python/scrapling 时 source=fetch-fallback → 降级 browserFetch (9999 服务) → 纯 fetch
      const sc = await callScrapling("fetch", { url, maxChars: 150000, waitMs: 0 }, 30000).catch(() => null);
      if (sc?.ok && sc.source === "scrapling" && typeof (sc.data as any)?.content === "string" && (sc.data as any).content.length > 0) {
        text = (sc.data as any).content;
        usedScrapling = true;
        logInfo(`[扫榜] ${platform} HTML 层走 Scrapling 指纹抓取成功 (${text.length} 字)`);
      } else {
        const r = await browserFetch(url, 15000, 6000);
        text = r.content || "";
      }
    }
  } catch (e) {
    err = (e as Error).message;
  }
  if (!text && !err) return { source: "browser", board: bn, url, items: [], rawText: "" };
  const extracted = err ? "抓取失败: " + err : conf.extract(text, bn);
  const items = err ? [] : extracted.split("\n").filter(l => l.trim()).slice(0, 30);

  // === 质量校验 + 真实浏览器层升级 ===
  // 两层触发场景:
  //  a) HTML 层压根没抓到 (起点等腾讯云 WAF 返回 202 + probe.js 探针, curl_cffi 打不过);
  //  b) 抓到了但 extract 正则解析出的是垃圾 (书旗实测抽出 "**《**《2》**" 这种把排名序号
  //     当成书名的条目) —— 这种情况以前也会被当成功, 把脏数据混进趋势归纳。
  // 两种情况都交给 Playwright Chromium + stealth 补丁用 DOM 选择器重抽。
  //  c) 平台标了 rbFirst (书旗): HTML 层自身抽出的就是脏数据且过得了上述校验, 直接走浏览器层。
  if (!err && (looksLikeGarbage(items) || conf.rbFirst)) {
    const { realBrowserFetch, formatRankItems } = await import("../realBrowser.js");
    const rb = await realBrowserFetch(url, { waitMs: 3500 }).catch(() => null);
    const rbLines = rb?.ok && rb.items.length > 0 ? formatRankItems(rb.items) : [];
    // 【必须二次校验】浏览器层的通用抽取器在有些站会把导航链接当成书名
    // (晋江实测抽出《作品库》《VIP作品》)。它抽出来的如果还是垃圾, 就保留 HTML 层结果,
    // 不能无条件覆盖 —— 那等于把本来还行的榜单换成更差的。
    if (rbLines.length > 0 && !looksLikeGarbage(rbLines)) {
      logInfo(`[扫榜] ${platform} 真实浏览器层${usedScrapling ? "重抽 (HTML 层解析为垃圾)" : "突破 WAF"} 成功 (${rbLines.length} 条)`);
      return { source: "real-browser", board: bn, url, items: rbLines, rawText: `${rb?.title || ""}\n${rbLines.join("\n")}` };
    }
    logInfo(
      `[扫榜] ${platform} 真实浏览器层未产出有效书名` +
        (rbLines.length > 0 ? " (抽到的是导航/噪声)" : rb?.error ? ` (${rb.error.slice(0, 60)})` : "") +
        ", 保留 HTML 层结果",
    );
  }
  return {
    // usedScrapling=true 时 source 标 "scrapling" (curl_cffi 指纹破反爬), 否则 "browser" (降级 fetch)
    source: err ? "error" : usedScrapling ? "scrapling" : "browser",
    board: bn,
    url,
    items,
    rawText: extracted,
  };
}


// ===== 网络搜索 (Bing) =====
export interface WebSearchResultItem { title: string; url: string; snippet: string }
export interface WebSearchResult {
  query: string;
  results: WebSearchResultItem[];
  count: number;
  source?: string;
  error?: string;
  analysis?: string;
}
async function webSearch(query: string, maxResults = 8): Promise<WebSearchResult> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  try {
    const resp = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-Hans`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    const html = await resp.text();
    // 正则提取搜索结果
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const re = /<h2[^>]*><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a><\/h2>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const url = m[1]!;
      const title = m[2]!;
      if (url.includes("bing.com") || url.includes("microsoft.com")) continue;
      // 提取摘要
      const after = html.slice(m.index + m[0].length, m.index + m[0].length + 500);
      const snipM = /<p[^>]*>([^<]+)<\/p>/i.exec(after);
      results.push({ title: title.trim(), url, snippet: snipM?.[1]?.trim()?.slice(0, 200) || "" });
      if (results.length >= maxResults) break;
    }
    return { query, results, count: results.length, source: "bing" };
  } catch (e) {
    return { query, results: [], count: 0, error: (e as Error).message };
  }
}

async function webFetch(url: string, maxChars = 8000) {
  if (!url.startsWith("http")) return { error: "url 必须以 http(s):// 开头" };
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await resp.text();
    // 去 HTML 标签提取正文
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + "\n… (已截断)";
    // 提取 title
    const titleM = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    return { url, title: titleM?.[1]?.trim() || "", content: text, chars: text.length };
  } catch (e) {
    return { error: (e as Error).message, url };
  }
}

// ===== 自动推进阶段 (阶段确认制辅助) =====
// 根据项目数据的就绪度，自动把 currentPhase 推进到可达的最高阶段。
// 防止"委派完成但阶段不推进"导致的门禁拦截。每阶段一停由 orchestrator prompt 负责。
// 委派完成后至少推进一个阶段 (orchestrator prompt 已保证按顺序执行)
// 同时检查 DB 数据是否支持更远的阶段 (如已有大纲/正文则跳过中间步骤)
function autoAdvancePhase(pid: string, emit: (evt: SSEEvent) => void): number {
  try {
    const st = store.getProjectState(pid);
    const cur = st.currentPhase as number;
    if (cur >= 8) return cur;
    // 数据就绪度可达的最高阶段
    let dataTarget = cur;
    if (st.hasContent) dataTarget = Math.max(dataTarget, 6);
    if (st.hasOutline && st.hasCharacters && st.hasWorld) dataTarget = Math.max(dataTarget, 5);
    if (st.hasCharacters || st.hasWorld || st.hasOutline) dataTarget = Math.max(dataTarget, 3);
    // 至少推进一个阶段 (委派完成后代表该阶段工作已完成)
    const target = Math.max(dataTarget, cur + 1);
    if (target > cur && target <= 8) {
      // P2 门禁: 强制走 advancePhase 校验 allowedNext + 前置条件 (不绕过状态机, 对齐 workflow.ts 设计意图"跳步直接报错")
      const advanceResult = advancePhase(
        cur as import("../workflow.js").Phase,
        target as import("../workflow.js").Phase,
        st,
      );
      if (advanceResult.success && advanceResult.newPhase) {
        store.updateProjectPhase(pid, advanceResult.newPhase);
        emit({ type: "phase_advanced", agent: "orchestrator", from: cur, to: target });
        return target;
      }
      // 门禁拦截: 打日志, 不静默跳步 (保持当前阶段, 等数据真正就绪)
      console.log(`[autoAdvancePhase] 门禁拦截: 阶段${cur}→${target} 不合法 (${advanceResult.error}), 保持阶段${cur}`);
    }
    return cur;
  } catch { return (store.getProjectState(pid).currentPhase as number); }
}

// ===== 共享: 写作工具执行后强制审查钩子 =====
// 结构化审查流程: 写完 → 总编审稿 → 质检员36维审查 → 角色一致性检查 → 给出明确下一步指令
/**
 * 委派结果摘要 — 只把"谁做的 + 做了什么 + 关键结论"交回主 Agent。
 * 不把专家的全文产出灌进主 Agent 上下文: 原文已落库 (store.addMessage + 记忆),
 * 需要细节时主 Agent 可以再派该专家取。
 * 目的: 主 Agent 是全场上下文最容易被撑爆的角色 (历史 + 记忆 + 各专家回灌),
 * 而它偏偏要做最需要清醒判断的事 (下一步派谁、要不要打回)。所以只喂结论。
 */
const DELEGATION_SUMMARY_HEAD = 350;
const DELEGATION_SUMMARY_TAIL = 150;
export function buildDelegationSummary(
  targetAgent: string, task: string, result: string, durationMs: number, extra?: string,
): string {
  const raw = (result || "").trim();
  let conclusion: string;
  if (raw.length <= DELEGATION_SUMMARY_HEAD + DELEGATION_SUMMARY_TAIL) {
    conclusion = raw;
  } else {
    // 头 + 尾: 工具输出常在开头, 专家的归纳结论常在结尾
    conclusion = raw.slice(0, DELEGATION_SUMMARY_HEAD).replace(/\s+/g, " ")
      + "\n...\n" + raw.slice(-DELEGATION_SUMMARY_TAIL).replace(/\s+/g, " ");
  }
  const lines = [
    `【委派结果摘要】(全文 ${raw.length} 字已落库, 需要细节请派该专家再取)`,
    `专家: ${targetAgent} | 耗时: ${(durationMs / 1000).toFixed(1)}s`,
    `任务: ${(task || "").slice(0, 120)}`,
    `结论: ${conclusion}`,
  ];
  if (extra) lines.push(extra);
  return lines.join("\n");
}

// ===== 两级审核: 初审(审核 agent 打分) → 终审(主 Agent 裁决) =====
// 权责分离: 初审只发现问题+打分, 不裁决; 终审只基于初审结论裁决, 不重读全文再打一遍分。
// 两者上下文互相隔离, 权限不重叠。

/** 初审结论 (结构化) — 只把结论交给终审, 不交全文 */
export interface FirstReviewVerdict {
  chapterId: string;
  score: number;          // 初审评分 (跳过严审时为 10 占位)
  threshold: number;      // 动态阈值
  qcPassed: boolean;      // 底线质检结果
  reviewSkipped: boolean;
  issues: string[];
  detail: string;         // 初审意见正文
  suggestion: string;     // 修改建议
}

/**
 * 终审裁决 — 主 Agent (总编) 基于【初审结论】裁决放过/打回。
 * 上下文隔离: 只收结构化的初审结论 + 终审裁决准则, 不重读全文、不掺主 Agent 的调度历史,
 * 避免"终审被长上下文污染后重新数一遍分"。
 */
export async function finalAdjudicate(
  pid: string, runId: string, fr: FirstReviewVerdict, emit: (evt: SSEEvent) => void,
): Promise<{ passed: boolean; reason: string; llmAvailable: boolean }> {
  // 初审完全不可用 (评分 0 且无问题清单) → 终审无依据, 不阻塞, 如实标注后放行
  if (!fr.score && !fr.issues.length) {
    emit({ type: "observation", agent: DEFAULT_AGENT, tool: "final_adjudicate", result: "初审不可用 (LLM 超时/失败), 终审无裁决依据 → 放行并如实标注" });
    return { passed: true, reason: "初审不可用, 终审无裁决依据", llmAvailable: false };
  }
  const verdictBlock = [
    `章节: ${fr.chapterId}`,
    `初审评分: ${fr.score}/10 (阈值 ${fr.threshold})`,
    `底线质检: ${fr.qcPassed ? "通过" : "未通过"}`,
    fr.reviewSkipped ? "短过渡章: 已跳过严审, 仅底线质检生效" : "",
    `初审问题清单:\n${fr.issues.length ? fr.issues.map((s, i) => `  ${i + 1}. ${s}`).join("\n") : "  无"}`,
    fr.detail ? `初审意见: ${fr.detail.slice(0, 800)}` : "",
    fr.suggestion ? `修改建议: ${fr.suggestion.slice(0, 500)}` : "",
  ].filter(Boolean).join("\n");

  try {
    const resp = await Promise.race([
      chat([
        { role: "system", content: `你是「天衍」团队的【总编】, 本轮只做一件事: 终审裁决。\n${FINAL_ADJUDICATION_RULES}` },
        { role: "user", content: `${verdictBlock}\n\n请裁决。` },
      ], undefined, { temperature: 0.2, maxTokens: 400 }) as Promise<{ content: string }>,
      new Promise<{ content: string }>((_, rej) => setTimeout(() => rej(new Error("终审裁决超时 25s")), 25000)),
    ]);
    const text = (resp?.content || "").trim();
    const m = text.match(/\[裁决[:：]\s*(通过|放过|打回|驳回)/);
    const passed = m ? /通过|放过/.test(m[1]!) : !/打回|驳回|REJECT/.test(text);
    const reason = text.replace(/\[裁决[:：][^\]]*\]/, "").trim().slice(0, 400) || (passed ? "终审通过" : "终审打回");
    emit({ type: "observation", agent: DEFAULT_AGENT, tool: "final_adjudicate", result: `终审裁决: ${passed ? "通过" : "打回"} — ${reason.slice(0, 160)}` });
    return { passed, reason, llmAvailable: true };
  } catch {
    // 终审 LLM 不可用 → 不阻塞: 按初审结论兜底 (初审达线 + 质检通过 → 通过)
    const fallbackPassed = fr.score >= fr.threshold && fr.qcPassed;
    emit({ type: "observation", agent: DEFAULT_AGENT, tool: "final_adjudicate", result: `终审不可用 (LLM 超时/失败), 按初审结论兜底: ${fallbackPassed ? "通过" : "打回"}` });
    return { passed: fallbackPassed, reason: "终审 LLM 不可用, 按初审结论兜底裁决", llmAvailable: false };
  }
}

export async function enforceReviewAfterWrite(
  pid: string, runId: string, agentName: AgentName,
  toolName: string, toolArgs: Record<string, unknown>, result: string,
  messages: Array<{ role: string; content: string; [key: string]: unknown }>,
  emit: (evt: SSEEvent) => void,
): Promise<void> {
  if (toolName !== "continue_writing" && toolName !== "ghostwrite" && toolName !== "polish") return;
  try {
    // 从 toolArgs 或工具返回结果中提取 chapterId
    // LLM 可能不传 chapter_id (自动创建), 此时从 result JSON 中提取
    let chapterIdForReview = String(toolArgs.chapter_id || "");
    if (!chapterIdForReview) {
      try {
        const parsedResult = JSON.parse(result);
        chapterIdForReview = parsedResult.chapterId || parsedResult.chapter_id || "";
      } catch { /* ignore */ }
    }
    if (!chapterIdForReview) return;

    // ===== Step 0: 逐章审查决策 (autonomous) — 先调 assess_chapter 拿"该不该审/审多严" =====
    const chapterRow = store.listChapters(pid).find((c: any) => c.id === chapterIdForReview);
    let threshold = 7;
    let skipStrict = false;
    try {
      const assessRaw = await dispatchTool(pid, "assess_chapter", { chapter_id: chapterIdForReview }, agentName);
      const assess = JSON.parse(assessRaw);
      threshold = Number(assess.suggestedThreshold ?? 7);
      skipStrict = assess.needReview === false;
      emit({ type: "observation", agent: agentName, tool: "assess_chapter(auto)", result: JSON.stringify(assess).slice(0, 500) });
    } catch { /* 决策失败 → 回退默认 7 分 */ }

    // ===== Step 1: 审核员先做36维质检 (quality_check) — 始终执行(底线钩子) =====
    const chapterForQC = chapterRow || store.listChapters(pid).find((c: any) => c.id === chapterIdForReview);
    const chapterText = chapterForQC?.content || "";
    const qcResult = await dispatchTool(pid, "quality_check", { chapter_id: chapterIdForReview, text: chapterText }, "consistency-checker");
    emit({ type: "observation", agent: "consistency-checker", tool: "quality_check(auto)", result: qcResult.slice(0, 2000) });
    const qcParsed = (() => { try { return JSON.parse(qcResult); } catch { return {}; } })();
    // passed=true→通过; null/undefined(无法解析)→不阻塞但交由总编评分决定; 显式false→打回
    const qcPassed = qcParsed.passed === true || qcParsed.passed === "true" || qcParsed.passed === null || qcParsed.passed === undefined;

    // ===== Step 2: 初审 — 固定由审核 agent (consistency-checker) 打分 =====
    // 两级审核: 初审只打分不裁决。原来这里传 agentName (即正在写作的主笔), 等于作者自己给自己打分,
    // 已改为固定走审核 agent, 杜绝自审。
    const REVIEWER_AGENT: AgentName = "consistency-checker";
    let reviewScore = 0;
    let reviewParsed: Record<string, unknown> = {};
    let reviewSkipped = false;
    if (skipStrict) {
      reviewSkipped = true;
      reviewScore = 99; // 占位: 标记"跳过", 不参与 <threshold 打回
      emit({ type: "observation", agent: REVIEWER_AGENT, tool: "review_chapter(skip)", result: "短过渡章, 跳过毒舌严审(底线质检仍生效)。" });
    } else {
      const reviewResult = await dispatchTool(pid, "review_chapter", { chapter_id: chapterIdForReview }, REVIEWER_AGENT);
      emit({ type: "observation", agent: REVIEWER_AGENT, tool: "review_chapter(auto)", result: reviewResult.slice(0, 2000) });
      reviewParsed = (() => { try { return JSON.parse(reviewResult); } catch { return {}; } })();
      reviewScore = (reviewParsed.score as number) ?? 0;
    }

    // ===== Step 3: 角色一致性检查 (manage_character 查询) =====
    const charCheckResult = await dispatchTool(pid, "manage_character", { action: "list" }, "character-designer");
    emit({ type: "observation", agent: agentName, tool: "character_check(auto)", result: charCheckResult.slice(0, 1000) });

    // ===== 初审结论结构化 — 只把结论交给终审, 不交全文 =====
    const effectiveScore = reviewSkipped ? 10 : reviewScore;
    const proj = store.getProject(pid);
    const genreHint = proj?.genre ? `项目类型: ${proj.genre}。` : "";
    const thresholdNote = reviewSkipped ? "(短过渡章已跳过严审)" : `(动态阈值 ${threshold}/10)`;

    const issues: string[] = [];
    if (!reviewSkipped && reviewScore > 0 && reviewScore < threshold) issues.push(`初审评分 ${reviewScore}/10 < ${threshold}`);
    if (qcParsed.passed === false || qcParsed.passed === "false" || String(qcParsed.verdict || "").toUpperCase() === "REJECT") issues.push(`底线质检未通过: ${qcParsed.quality_check || "不合格"}`);

    const firstReview: FirstReviewVerdict = {
      chapterId: chapterIdForReview,
      score: effectiveScore,
      threshold,
      qcPassed,
      reviewSkipped,
      issues,
      detail: (reviewParsed.review as string) || (qcParsed.quality_check as string) || "",
      suggestion: (reviewParsed.suggestion as string) || (reviewParsed.advice as string) || "",
    };
    // ===== 终审: 主 Agent 基于初审结论裁决 (不重读全文, 不重新打分) =====
    const adjudication = await finalAdjudicate(pid, runId, firstReview, emit);

    if (!adjudication.passed) {
      // 终审打回 → 重写，给出明确指令
      const rejectReason = `${genreHint}【终审裁决: 打回】${thresholdNote}。初审评分 ${effectiveScore}/10。` +
        `终审理由: ${adjudication.reason}\n` +
        `请根据以上意见，调用 continue_writing 工具重写本章, 并务必传入参数 replace: true(整章重写: 删除旧内容换成新稿, 绝不追加)。` +
        `重写时务必: 1)保持角色性格一致 2)符合项目类型 3)消除AI味 4)章末留悬念。`;

      // 推送明确的下一步指令给 LLM
      messages.push({ role: "user", content: rejectReason });
      emit({ type: "forced_revision", agent: agentName, score: reviewScore, review: adjudication.reason, chapterId: chapterIdForReview, reason: (issues.join("; ") || adjudication.reason) });

      // 回退到阶段5 (正文写作) + 记录弧线快照(打回)
      // P2 门禁: 7→5 是状态机允许的打回边, 但强制走 advancePhase 校验 (不绕过状态机)
      try {
        const stNow = store.getProjectState(pid);
        const revAdvance = advancePhase(stNow.currentPhase as import("../workflow.js").Phase, 5, stNow);
        if (revAdvance.success && revAdvance.newPhase) {
          store.updateProjectPhase(pid, revAdvance.newPhase);
          emit({ type: "phase_advanced", agent: agentName, from: stNow.currentPhase as number, to: 5 });
        } else {
          console.log(`[enforceReviewAfterWrite] 打回归退被门禁拦截: ${stNow.currentPhase}→5 (${revAdvance.error})`);
        }
      } catch { /* 不阻塞 */ }
      try {
        const chIdx = chapterForQC?.idx ?? 0;
        recordSnapshot(pid, chIdx, estimateDensity(chapterText), true);
      } catch { /* ignore */ }
    } else {
      // 终审通过 → 推进到阶段8，给出下一章指令 + 记录弧线快照(通过)
      const passNote = adjudication.llmAvailable
        ? `【终审裁决: 通过】${adjudication.reason}`
        : `【终审未介入: ${adjudication.reason}】`;
      const nextInstruction = `${genreHint}${passNote} (初审评分 ${effectiveScore}/10 ${thresholdNote})。` +
        `请把审查结果整理成面向用户的汇报,告诉用户本章已完成,并询问是否继续下一章。` +
        `如果用户确认,请调用 continue_writing 开始下一章(写前可先 assess_arc 看节拍器建议)。`;

      messages.push({ role: "user", content: nextInstruction });

      try {
        const projState = store.getProjectState(pid);
        const advanceResult = advancePhase(projState.currentPhase as import("../workflow.js").Phase, 8, projState);
        if (advanceResult.success && advanceResult.newPhase) {
          store.updateProjectPhase(pid, advanceResult.newPhase);
          emit({ type: "review_passed", agent: agentName, score: effectiveScore, qcPassed: true, newPhase: advanceResult.newPhase, chapterId: chapterIdForReview });
        }
      } catch { /* 不阻塞 */ }
      try {
        const chIdx = chapterForQC?.idx ?? 0;
        recordSnapshot(pid, chIdx, estimateDensity(chapterText), false);
      } catch { /* ignore */ }
    }
  } catch (e) { /* 审查失败不阻塞主流程 */ console.error("[enforceReview] error:", e); }
}

/**
 * B-3 终审裁决 (主 Agent, 对所有对外产出, 非仅章节):
 * 两级审核的下游 — 专家产出先过初审 (章节类由 consistency-checker 在独立上下文打分),
 * 这里只做终审裁决: 通过则背书出门, 打回则写明理由交回主 Agent 重新委派专家返修。
 * 职责边界: 终审【不重读全文再打一遍分】(那是初审的活), 也【不替专家改写内容】
 * (原实现里"总编自己修订全文"等于调度者下场干专家的活, 已移除)。
 * 上下文只收结构化摘要 + 终审裁决准则, 保持终审判断不被长文/历史污染。
 * @returns { content: 交付内容(原稿, 打回时附裁决理由), approved, score, verdict }
 */
export async function finalReviewDeliverable(
  pid: string, runId: string, expertAgent: AgentName, deliverableLabel: string,
  content: string, emit: (evt: SSEEvent) => void,
): Promise<{ content: string; approved: boolean; score: number; verdict: string }> {
  if (!(content || "").trim()) return { content, approved: true, score: 0, verdict: "产出为空, 跳过终审" };
  // 终审只看摘要 (上限 1200 字): 调用方传入的已是结构化摘要, 这里再兜一层截断防长文污染
  const src = (content || "").slice(0, 1200);
  let resp: { content: string; [k: string]: unknown } | null = null;
  try {
    resp = await Promise.race([
      chat([
        { role: "system", content: `你是「天衍」团队的【总编】, 本轮只做一件事: 终审裁决。\n你是裁决者不是写手: 只判断这份专家产出能不能出门, 不要重写它。\n${FINAL_ADJUDICATION_RULES}` },
        { role: "user", content: `专家: ${expertAgent}\n交付内容摘要 (任务: ${deliverableLabel}):\n${src}\n\n请终审裁决。` },
      ], undefined, { temperature: 0.2, maxTokens: 300 }) as Promise<{ content: string }>,
      new Promise<{ content: string }>((_, rej) => setTimeout(() => rej(new Error("终审超时 25s")), 25000)),
    ]);
  } catch (e) {
    resp = null;
  }
  if (!resp) {
    logWarn(`[终审] ${expertAgent} 终审不可用 (LLM 失败/超时) → 不阻塞, 交原稿+诚实标注`);
    emit({ type: "observation", agent: DEFAULT_AGENT, tool: "final_review", result: "⚠️ 终审不可用 (LLM 失败/超时), 交付专家原稿 (未终审背书)" });
    return { content, approved: true, score: 0, verdict: "终审不可用, 交原稿" };
  }
  const text = (resp?.content || "").trim();
  const m = text.match(/\[裁决[:：]\s*(通过|放过|打回|驳回)/);
  const approved = m ? /通过|放过/.test(m[1]!) : !/打回|驳回|REJECT/.test(text);
  const verdict = text.replace(/\[裁决[:：][^\]]*\]/, "").trim().slice(0, 300) || (approved ? "终审通过" : "终审打回");
  // 若模型在裁决里引用了初审评分则解析出来 (仅作记录, 终审本身不打分)
  const sm = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
  const score = sm ? Math.min(10, parseFloat(sm[1]!)) : 0;

  if (approved) {
    emit({ type: "observation", agent: DEFAULT_AGENT, tool: "final_review", result: `终审通过 (背书): ${verdict.slice(0, 120)}` });
    emit({ type: "review_passed", agent: DEFAULT_AGENT, score, qcPassed: true, newPhase: 0, chapterId: "", note: `终审背书: ${expertAgent} · ${deliverableLabel}` });
    return { content, approved: true, score, verdict };
  }
  // 打回: 不自己改写, 写明理由交回主 Agent 重新委派该专家返修
  logInfo(`[终审] ${expertAgent}·${deliverableLabel} 打回: ${verdict.slice(0, 80)}`);
  emit({ type: "forced_revision", agent: DEFAULT_AGENT, score, review: verdict.slice(0, 200), chapterId: "", reason: `终审打回 ${expertAgent}·${deliverableLabel}: ${verdict.slice(0, 100)}` });
  return { content, approved: false, score, verdict };
}

/**
 * 终审 + 返修闭环 (2026-10-18 新增)。
 *
 * 以前的断链: finalReviewDeliverable 打回后, 调用方只是把裁决意见**附在文本末尾**就交付了 ——
 * 终审写的"修改指令"从未送回专家手里, run 直接结束。用户看到的就是:
 * 「拆书只回了句启动语 → 终审 0/10 → 然后没有下文, 没有任何返修任务和工具执行」。
 *
 * 这里把闭环补上: 打回 → 调 rework(feedback) 让**同一个专家**带着修改指令重跑 → 再终审,
 * 最多 maxRounds 轮。专家还是交不出东西 → 交最后一次产出 + 裁决标注 (不无限循环)。
 */
export async function finalReviewWithRework(
  pid: string, runId: string, expertAgent: AgentName, deliverableLabel: string,
  initialContent: string,
  emit: (evt: SSEEvent) => void,
  rework: (feedback: string) => Promise<string>,
  maxRounds = 1,
): Promise<{ content: string; approved: boolean; score: number; verdict: string; reworked: number }> {
  let content = initialContent;
  let review = await finalReviewDeliverable(pid, runId, expertAgent, deliverableLabel, content, emit);
  let rounds = 0;
  while (!review.approved && rounds < maxRounds) {
    rounds++;
    emit({ type: "observation", agent: DEFAULT_AGENT, tool: "rework", result: `终审打回, 责令 ${expertAgent} 返修 (第 ${rounds}/${maxRounds} 轮): ${review.verdict.slice(0, 120)}` });
    let revised = "";
    try {
      revised = (await rework(review.verdict)).trim();
    } catch (e) {
      logWarn(`[终审返修] ${expertAgent} 第 ${rounds} 轮返修执行异常: ${(e as Error).message?.slice(0, 100)}`);
    }
    if (!revised) {
      logWarn(`[终审返修] ${expertAgent} 第 ${rounds} 轮仍无产出, 停止返修, 交原稿+裁决`);
      break; // 返修也交不出东西 → 不死循环
    }
    content = revised;
    review = await finalReviewDeliverable(pid, runId, expertAgent, `${deliverableLabel} (返修${rounds})`, content, emit);
  }
  return { content: review.approved ? review.content : content, approved: review.approved, score: review.score, verdict: review.verdict, reworked: rounds };
}

// ===== Agent 循环 =====

interface RunState {
  pid: string;
  agentName: AgentName;
  messages: Array<{ role: string; content: string; [key: string]: unknown }>;
  depth: number;
  runId: string;
  delegationLog: Array<{ to: string; task: string; result: string; durationMs: number }>;
  emit: (evt: SSEEvent) => void;
  sharedSteps?: { value: number };
  orchestratorDelegated?: boolean;  // 阶段确认制: orchestrator 一次 run 只委派一次
  orchestratorDelegateCount?: number;  // orchestrator 本轮委派次数计数
  pendingDelegationReport?: boolean;  // 委派收尾轮标记: 总编刚拿到子agent结果, 下一轮必须产出面向用户的真实汇报正文 (不得把思考当正文)
  tokenAccumulator?: { value: number };  // 本次 run 的 token 累计 (流式 usage 事件累加, finishRun 前写回 DB)
}

// 从 LLM 输出中提取工具调用 (兼容 JSON / <function="x" /> / <invoke name="x">)
function extractToolCall(content: string): { tool: string; args: Record<string, unknown> } | null {
  if (!content) return null;
  // 1. JSON 块: 花括号计数逐个尝试
  const jsonCandidates: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < content.length; j++) {
        if (content[j] === '{') depth++;
        else if (content[j] === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end > i) jsonCandidates.push(content.slice(i, end + 1));
    }
  }
  for (let k = jsonCandidates.length - 1; k >= 0; k--) {
    try {
      const parsed = JSON.parse(jsonCandidates[k]);
      if (parsed && typeof parsed.tool === "string" && (parsed.args === undefined || typeof parsed.args === "object")) {
        return { tool: parsed.tool, args: parsed.args || {} };
      }
    } catch { /* skip malformed */ }
  }
  // 2. <function="name" key="value" /> 格式
  const fnMatches = [...content.matchAll(/<function\s*=\s*["']?([^"'\s>]+)["']?\s*([^>]*)\s*\/?\s*>/g)];
  if (fnMatches.length) {
    const last = fnMatches[fnMatches.length - 1];
    const args: Record<string, unknown> = {};
    const attrRe = /([a-zA-Z_][\w-]*)\s*=\s*["']([^"']*)["']/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(last[2])) !== null) {
      args[am[1]] = am[2];
    }
    return { tool: last[1], args };
  }
  // 3. <invoke name="x"><parameter name="y">z</parameter></invoke> 格式
  const invokeMatches = [...content.matchAll(/<invoke\s+name\s*=\s*["']?([^"'\s>]+)["']?\s*>([\s\S]*?)<\/invoke>/g)];
  if (invokeMatches.length) {
    const last = invokeMatches[invokeMatches.length - 1];
    const args: Record<string, unknown> = {};
    const pRe = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(last[2])) !== null) {
      args[pm[1]] = pm[2].trim();
    }
    return { tool: last[1], args };
  }
  const invokeBare = [...content.matchAll(/<invoke\s+name\s*=\s*["']?([^"'\s>]+)["']?\s*>/g)];
  if (invokeBare.length) {
    return { tool: invokeBare[invokeBare.length - 1][1], args: {} };
  }
  // 4. <tool_call> 格式 (兼容 agnes 输出)
  const tcMatches = [...content.matchAll(/<tool_call>\s*<tool_name>\s*([^<]+?)\s*<\/tool_name>\s*<\/tool_call>/g)];
  if (tcMatches.length) {
    const last = tcMatches[tcMatches.length - 1];
    const toolName = last[1].trim();
    // 尝试从前后文提取 JSON args
    const afterTc = content.slice(last.index! + last[0].length);
    const argMatch = afterTc.match(/\{[\s\S]*?\}/);
    if (argMatch) {
      try {
        const args = JSON.parse(argMatch[0]);
        if (typeof args === "object") return { tool: toolName, args };
      } catch { /* skip */ }
    }
    return { tool: toolName, args: {} };
  }
  // 5. 三重反引号 JSON 块 (```json ... ```)
  const mdJsonMatch = content.match(/```json\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (mdJsonMatch) {
    try {
      const parsed = JSON.parse(mdJsonMatch[1]);
      if (parsed && typeof parsed.tool === "string") return { tool: parsed.tool, args: parsed.args || {} };
    } catch { /* skip */ }
  }
  return null;
}


// ===== OpenAI 原生 function calling 工具 schema =====
const TOOL_SCHEMAS: Record<string, ToolDefinition> = {
  delegate_to_agent: {
    type: "function",
    function: { name: "delegate_to_agent", description: "委派任务给子 agent", parameters: { type: "object", properties: { agent: { type: "string", description: "目标 agent 名" }, task: { type: "string", description: "任务描述" } }, required: ["agent", "task"] } },
  },
  query_project: {
    type: "function",
    function: { name: "query_project", description: "查询当前项目状态、统计信息", parameters: { type: "object", properties: {}, required: [] } },
  },
  review_chapter: {
    type: "function",
    function: { name: "review_chapter", description: "毒舌审稿，评分1-10", parameters: { type: "object", properties: { chapter_id: { type: "string" } }, required: ["chapter_id"] } },
  },
  generate_outline: {
    type: "function",
    function: { name: "generate_outline", description: "生成大纲", parameters: { type: "object", properties: { premise: { type: "string" }, genre: { type: "string" }, num_chapters: { type: "number" } }, required: ["premise"] } },
  },
  manage_outline: {
    type: "function",
    function: { name: "manage_outline", description: "管理/更新大纲", parameters: { type: "object", properties: { action: { type: "string" }, chapter_id: { type: "string" }, outline: { type: "string" } }, required: ["action"] } },
  },
  manage_character: {
    type: "function",
    function: { name: "manage_character", description: "创建/更新角色档案", parameters: { type: "object", properties: { action: { type: "string" }, name: { type: "string" }, personality: { type: "string" }, speechStyle: { type: "string" }, motivation: { type: "string" } }, required: ["action", "name"] } },
  },
  add_element: {
    type: "function",
    function: { name: "add_element", description: "添加设定元素", parameters: { type: "object", properties: { kind: { type: "string" }, name: { type: "string" }, detail: { type: "string" } }, required: ["kind", "name"] } },
  },
  manage_world: {
    type: "function",
    function: { name: "manage_world", description: "管理世界观条目", parameters: { type: "object", properties: { action: { type: "string" }, name: { type: "string" }, category: { type: "string" }, description: { type: "string" } }, required: ["action", "name"] } },
  },
  continue_writing: {
    type: "function",
    function: { name: "continue_writing", description: "续写/重写正文。打回重写时必须传 replace: true 整章重写(删旧换新); 默认追加续写", parameters: { type: "object", properties: { chapter_id: { type: "string" }, instruction: { type: "string" }, length: { type: "number" }, replace: { type: "boolean", description: "整章重写模式: true 删除旧内容覆盖新稿, false/省略 追加续写" } }, required: ["chapter_id", "instruction"] } },
  },
  quality_check: {
    type: "function",
    function: { name: "quality_check", description: "36维质检", parameters: { type: "object", properties: { chapter_id: { type: "string" } }, required: ["chapter_id"] } },
  },
  web_search: {
    type: "function",
    function: { name: "web_search", description: "联网搜索", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  },
  web_fetch: {
    type: "function",
    function: { name: "web_fetch", description: "抓取网页内容", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  },
  scan_bestseller: {
    type: "function",
    function: {
      name: "scan_bestseller",
      description: "扫描小说平台榜单。支持: 起点/起点女生网/番茄/晋江/飞卢/书旗/QQ阅读。board可选: 畅销榜/月票榜/人气榜/追读榜/收藏榜/三江(当前)/往期三江/阅读榜/新书榜等；番茄另有 金番作家榜(殿堂作家+金番作家及代表作)/巅峰榜(头部精品)/分类榜(按项目题材自动选对应分类, 默认)/分类新书榜。不指定board则默认抓该平台默认榜(番茄=分类榜)。用户要求三江就抓三江，要求往期就抓往期。",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", description: "平台名称，如: 起点/起点女生网/番茄/晋江/飞卢/书旗/QQ阅读" },
          genre: { type: "string", description: "题材/类型，如: 仙侠/都市/玄幻/言情，不指定则全品类" },
          board: { type: "string", description: "榜单名称，如: 畅销榜/月票榜/人气榜/三江/往期三江/阅读榜/新书榜/追读榜/收藏榜；番茄还支持 金番作家榜/巅峰榜/分类榜/分类新书榜。不指定则用该平台默认榜(番茄=分类榜，按项目题材自动选分类)" },
        },
        required: ["platform"],
      },
    },
  },
  audit_novel: {
    type: "function",
    function: { name: "audit_novel", description: "36维审计", parameters: { type: "object", properties: { chapter_id: { type: "string" } }, required: ["chapter_id"] } },
  },
  detect_ai: {
    type: "function",
    function: { name: "detect_ai", description: "AI味检测", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  },
  polish: {
    type: "function",
    function: { name: "polish", description: "润色/改写", parameters: { type: "object", properties: { chapter_id: { type: "string" }, mode: { type: "string" }, instruction: { type: "string" } }, required: ["chapter_id"] } },
  },
  match_author: {
    type: "function",
    function: { name: "match_author", description: "匹配最佳作家风格", parameters: { type: "object", properties: { genre: { type: "string" }, style: { type: "string" } }, required: ["genre"] } },
  },
  query_workflow: {
    type: "function",
    function: { name: "query_workflow", description: "查询工作流阶段状态", parameters: { type: "object", properties: {}, required: [] } },
  },
  export_project_data: {
    type: "function",
    function: { name: "export_project_data", description: "导出项目全部章节为txt或json文件，返回下载路径。创作完成后用于交付最终成稿。", parameters: { type: "object", properties: { format: { type: "string", description: "导出格式: txt 或 json，默认txt" } }, required: [] } },
  },
  challenge_review: {
    type: "function",
    function: { name: "challenge_review", description: "发起挑战审查", parameters: { type: "object", properties: { target_agent: { type: "string" }, reason: { type: "string" } }, required: ["reason"] } },
  },
  resolve_challenge: {
    type: "function",
    function: { name: "resolve_challenge", description: "响应挑战审查", parameters: { type: "object", properties: { challenge_id: { type: "string" }, response: { type: "string" } }, required: ["challenge_id", "response"] } },
  },
  // ===== 决策层工具 (autonomous 模式) =====
  assess_chapter: {
    type: "function",
    function: { name: "assess_chapter", description: "逐章审查决策: 返回该章的爽点密度/是否高潮章/建议阈值/是否需审查。供主 Agent 判断'该不该审、审多严'(过渡章宽松, 高潮章严格)。", parameters: { type: "object", properties: { chapter_id: { type: "string" } }, required: ["chapter_id"] } },
  },
  reflect_consistency: {
    type: "function",
    function: { name: "reflect_consistency", description: "跨章一致性反思: 返回未回收伏笔/角色状态/已写章节统计, 供主 Agent 反思前后矛盾并修正。", parameters: { type: "object", properties: {}, required: [] } },
  },
  assess_arc: {
    type: "function",
    function: { name: "assess_arc", description: "评估全书弧线: 返回当前爽点密度/目标密度/偏差/进度/节拍器建议(increase_density/slow_down/frontload_peak/recover_ending)。", parameters: { type: "object", properties: {}, required: [] } },
  },
  adjust_arc: {
    type: "function",
    function: { name: "adjust_arc", description: "调整全书弧线目标密度(主 Agent 的决策)。当节拍器建议抬/缓密度时调用, 改变后续章节的爽点密度目标。", parameters: { type: "object", properties: { new_density: { type: "number", description: "新的目标爽点密度(每1000字爽点数, 范围0.5~4)" }, reason: { type: "string", description: "调整理由(展示给前端)" } }, required: ["new_density", "reason"] } },
  },
};

export function getToolDefinitions(agentName: string): ToolDefinition[] {
  const isValidAgent = agentName in AGENT_TOOLS;
  if (!isValidAgent) return [];
  const toolNames = AGENT_TOOLS[agentName as keyof typeof AGENT_TOOLS] || [];
  return toolNames
    .map((name: string) => TOOL_SCHEMAS[name])
    .filter((def): def is ToolDefinition => !!def);
}


function isReadonlyTool(toolName: string): boolean {
  const readonlyTools = [
    "read_file", "list_files", "search_files", "web_search", "web_fetch",
    "query_characters", "query_world", "query_chapters", "quality_check",
    "list_authors", "list_elements", "bash",
  ];
  return readonlyTools.includes(toolName);
}


// 启发式思考检测: 当模型不支持reasoning_content时,检测content中的规划/思考文本
function isHeuristicThinking(text: string): boolean {
  if (!text || text.length < 50) return false;
  // 中文规划关键词
  const zhPatterns = [
    /^用户.{0,10}(想|需要|要求|请求)/,
    /^我需要/,
    /^接下来/,
    /^首先/,
    /^让我/,
    /^根据.{0,10}(要求|需求|指令)/,
    /^我来/,
    /^我会/,
    /^然后/,
    /^这需要/,
    /^应该/,
    /^需要.{0,5}(进行|执行|完成)/,
    /^调用.{0,10}(工具|tool)/,
    /^发送.{0,10}(给|delegate)/,
    /^委派/,
    /^派发/,
    /^这一步/,
    /^第一(步|阶段)/,
    /^第二(步|阶段)/,
    /^第三(步|阶段)/,
  ];
  const lines = text.split("\n").filter(l => l.trim());
  let matchCount = 0;
  for (const line of lines.slice(0, 10)) {
    if (zhPatterns.some(p => p.test(line.trim()))) matchCount++;
  }
  // 如果前10行中超过3行匹配规划模式,认为是思考文本
  return matchCount >= 3 && lines.length > 5;
}


// 路线A (2026-09-28): generateSyntheticThinking 已删 — 不再合成假思考冒充模型推理
// (原函数在此: 为不支持 reasoning_content 的模型自动生成 "【X】收到任务, 正在分析需求..." 假分析,
//  违反 "模型=大脑负责思考" 原则, 用户要求前端只映射模型真实思考)

export async function runAgentLoop(state: RunState): Promise<string> {
  const s = getSettings();
  const { pid, agentName, depth, runId, emit } = state;
  let messages = [...state.messages];
  let step = 0;
  const loopDetect: Record<string, number> = {};
  let round = 0;
  let bestContent = "";  // 保留最佳内容作为返回值
  let consecutiveEmptyCount = 0;
  // 自适应重试间隔档位 (提升到外层 agent 轮级别, 跨轮保留):
  // 连接失败 / 空回复 都会拉大档位; 成功出内容则不重置 (让 LLM 有更长冷却期)
  // RETRY_INTERVALS: 18s → 30s → 60s → 120s → 240s → 300s(封顶)
  const RETRY_INTERVALS = [18_000, 30_000, 60_000, 120_000, 240_000, 300_000];
  let retryIdx = 0;

  const runStart = Date.now();
  const maxDurationMs = s.runMaxDuration * 1000;

  // 心跳: 每 5 秒发一次
  const heartbeatTimer = setInterval(() => {
    emit({ type: "heartbeat", ts: Date.now(), runId });
  }, 5000);

  // 每个 agent 有独立的 maxSteps / maxTurns
  const agentCfg = s.agents?.[agentName];
  const agentMaxSteps = agentCfg?.maxSteps ?? s.maxSteps;
  const agentMaxTurns = agentCfg?.maxTurns ?? 8;
  // 模型识别闭环: 按该 agent 的 modelTier 解析实际模型 (modelTiers 映射 → 否则落回 defaultModel)
  // 对齐 Codex model_providers: 7 个 agent 的档位差异真正落到 LLM 调用, 不再共用 defaultModel
  // 改4 (agent 级 fallback): 让 agentModel 可重新赋值 — 当前模型反复空响应时, 自动切到候选模型
  let agentModel = pickModelForAgent(agentName);
  const modelFallbackUsed: string[] = []; // 已尝试过的模型 (避免来回切)
  // token 累计器: 每次流式 usage 事件累加, run 结束时写回 runs.total_tokens (修前端成本/统计恒 0)
  const tokenAccum = { value: 0 };
  state.tokenAccumulator = tokenAccum;
  emit({ type: "model_picked", agent: agentName, tier: agentCfg?.modelTier || "mid", model: agentModel.model });

  try {
  while (step < agentMaxSteps && round <= agentMaxTurns) {
    step++;
    if (state.sharedSteps) state.sharedSteps.value = step;
    round++;
    // 用户点了「停止」→ 收尾退出。协作式取消: 不硬杀正在进行的 LLM 请求
    // (硬杀会让已经写了一半的章节留在库里, 状态更乱), 而是在轮与轮之间干净退出。
    if (isRunCancelled(runId)) {
      logInfo(`[停止] agent=${agentName} run=${runId} 用户取消, 主循环退出 (第${round}轮)`);
      emit({ type: "observation", agent: agentName, tool: "user_cancelled", result: "已按用户要求停止。" });
      clearInterval(heartbeatTimer);
      store.finishRun(runId, "cancelled");
      return bestContent || "（已按你的要求停止）";
    }
    // 本轮是否为"委派收尾轮" (总编刚拿到子agent结果, 强制要真实汇报正文)
    const closingRound = agentName === "orchestrator" && !!state.pendingDelegationReport;
    // 超时检查
    if (Date.now() - runStart > maxDurationMs) {
      const msg = `运行超时 (${s.runMaxDuration}s), 已强制停止`;
      emit({ type: "error", message: msg });
      break;
    }

    // ===== 思考阶段: 流式 LLM 调用 =====
    let fullContent = "";
    let thinkingText = "";
    let thinkDone = false;
    let inThinking = false;
    let nativeToolCalls: ToolCall[] = [];
    let emptyToolCallFiltered = false; // 本轮是否有空参数 tool call 被过滤
    // Thinking缓冲区: 累积thinking内容, content到来时统一发送（过滤system prompt泄漏）
    let thinkBuffer = "";
    let thinkFlushed = false;
    let thinkStarted = false;                // 是否已发送 think_start（避免重复）
    const THINK_STREAM_CHUNK = 24;           // 思考内容每攒满24字符就发一批, 前端打字机自然播放
    const THINK_BUFFER_MAX = 2000;
    let thinkSentLen = 0;                     // 已发送的thinking总长度(前端打字机用)

    const MAX_STREAM_RETRIES = 10;
    // (RETRY_INTERVALS + retryIdx 已提升到外层 agent 轮级别, 此处不再重复声明)
    // 本轮流式总预算: 卡 TLS/429 时不无限重试, 超预算直接走 reasoning/兜底路径
    const roundStartTs = Date.now();
    const ROUND_STREAM_BUDGET_MS = 45_000;
    let rateLimitHit = false;  // 429 熔断标志: 置位后不再重试
    // 本轮 LLM 是否处于"降级"状态 (重试过 / 429 / 空响应)。
    // 只有降级轮才允许代码层旁路接管 (正则代跑核心工具), 正常轮一律让主 Agent 自己决策。
    let llmDegraded = false;
    let rateLimitRetried = false;  // 429 突发限流: 是否已做过 60s 冷却重试 (防无限空转)
    for (let streamAttempt = 0; streamAttempt <= MAX_STREAM_RETRIES; streamAttempt++) {
      if (streamAttempt > 0) {
        llmDegraded = true; // 本轮经历过重试 → 视为 LLM 降级轮
        // 429/限流已命中: 不再重试 (避免白烧额度), 直接跳出走兜底
        if (rateLimitHit) {
          logWarn("[LLM限流] agent="+agentName+" 429 已命中, 跳过剩余重试, 直接走确定性兜底");
          break;
        }
        // 429 冷却重试: 已按自适应间隔冷却过, 直接重试 (不检查单轮预算 —
        // 否则冷却本身就把预算超了, 导致"冷却重试仍超总预算"误判熔断, 反复空转)
        if (rateLimitRetried) {
          logInfo("[LLM限流] agent="+agentName+" 429 冷却结束, 立即重试");
          continue; // 直接进下一次 try
        }
        // 自适应间隔: 连接正常 → 用当前 RETRY_INTERVALS[retryIdx] (18s 起步);
        // 连接失败 → 已在 catch/empty 路径 retryIdx++, 下次自动拉大 (30s→60s→120s→240s→300s)
        const retryDelay = RETRY_INTERVALS[Math.min(retryIdx, RETRY_INTERVALS.length - 1)];
        logWarn("[流式重试] agent="+agentName+" 第"+streamAttempt+"次, "+(retryDelay/1000)+"s后重试 (自适应间隔档: "+retryIdx+" → "+(retryDelay/1000)+"s)");
        // 前端转圈提示: "正在尝试链接 LLM..." (SSE event, 带本次间隔与次数)
        emit({ type: "llm_reconnecting", agent: agentName, attempt: streamAttempt, max: MAX_STREAM_RETRIES, interval_s: retryDelay / 1000 });
        await new Promise(r => setTimeout(r, retryDelay));
        // 重置流式状态
        fullContent = ""; thinkingText = ""; thinkDone = false; inThinking = false;
        thinkBuffer = ""; thinkFlushed = false; thinkStarted = false; thinkSentLen = 0;
        nativeToolCalls = [];
        // 预算检查: 自适应间隔累计超 600s → 走 reasoning/非流式兜底 (不卡死)
        if (Date.now() - roundStartTs > 600_000) {
          logWarn("[流式预算] agent="+agentName+" 本轮重试累计超 600s, 停止重试走兜底路径");
          emit({ type: "observation", agent: agentName, tool: "stream_budget", result: "LLM 连接持续不稳定 (已等 600s), 走确定性兜底" });
          break;
        }
      }
    try {
      const agentTools = getToolDefinitions(agentName);
      logInfo("[流式LLM调用] agent="+agentName+" round="+round+" model="+(agentModel?agentModel.model:"?")+" 消息数="+messages.length+" 工具数="+(agentTools?agentTools.length:0));
      const streamGen = llmStream(messages, agentModel, { tools: agentTools });
      for await (const chunk of streamGen) {
        // 用户点了「停止」→ 立即中断本轮流式, 不再把 token 转成前端输出, 也不再执行后面的工具。
        // 放在这里是**最即时的检查点**: LLM 是逐 chunk 返回的, 不用等整轮跑完才响应取消。
        if (isRunCancelled(runId)) {
          logInfo(`[停止] agent=${agentName} run=${runId} 用户取消, 中断流式输出`);
          emit({ type: "observation", agent: agentName, tool: "user_cancelled", result: "已按用户要求停止, 本轮输出到此为止。" });
          clearInterval(heartbeatTimer);
          store.finishRun(runId, "cancelled");
          return "（已按你的要求停止）";
        }
        // USAGE_PREFIX: LLM 返回 usage 统计 (含 prefix cache 命中率)
        if (chunk.startsWith(USAGE_PREFIX)) {
          try {
            const u = JSON.parse(chunk.slice(USAGE_PREFIX.length));
            emit({ type: "usage", agent: agentName, usage: u });
            tokenAccum.value += (u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0) || 0);
            if (state.tokenAccumulator) state.tokenAccumulator.value += (u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0) || 0);
          } catch { /* skip */ }
          continue;
        }
        // TOOLCALL_PREFIX: 原生 tool_calls 由 llm.ts 累积后在末尾输出
        if (chunk.startsWith(TOOLCALL_PREFIX)) {
          // 如果正在 thinking 中收到 tool_call, 先 flush 思考事件 (thinking→tool_call 无 content 中间态)
          if (inThinking && !thinkDone && !thinkFlushed && thinkBuffer.length > 0 && !isPromptLeakage(thinkBuffer)) {
            thinkDone = true;
            if (!thinkStarted) emit({ type: "think_start", agent: agentName, round });
            emit({ type: "think_token", agent: agentName, text: thinkBuffer });
            emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
            thinkFlushed = true;
            thinkBuffer = "";
          } else if (inThinking && !thinkDone) {
            thinkDone = true;
            emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
          }
          try {
            const rawTcs = JSON.parse(chunk.slice(TOOLCALL_PREFIX.length));
            nativeToolCalls = (rawTcs as Array<{ id: string; name: string; arguments: string }>).map((t) => ({
              id: t.id,
              name: t.name,
              arguments: (() => { try { return JSON.parse(t.arguments); } catch { return {}; } })(),
            })).filter((t) => {
              // 过滤空参数 tool call (agnes 等推理模型有时会返回 arguments='' 或 '{}' 的无效调用)
              // 空参数执行毫无意义且触发循环, 直接丢弃并提示模型补充参数
              const empty = t.arguments && Object.keys(t.arguments).length === 0;
              if (empty) {
                emptyToolCallFiltered = true;
                emit({ type: "observation", agent: agentName, tool: t.name, result: "[过滤] 模型返回了空参数工具调用, 已丢弃。请补充具体参数后重试。" });
              }
              return !empty;
            });
          } catch { /* skip malformed */ }
          continue;
        }
        // THINK_PREFIX: agnes reasoning_content 分离传输
        if (chunk.startsWith(THINK_PREFIX)) {
          const thinkText = chunk.slice(THINK_PREFIX.length);
          thinkingText += thinkText;
          if (!thinkDone && !inThinking) {
            inThinking = true;
            // 思考开始: 先发 think_start, 前端创建流式条目
            emit({ type: "think_start", agent: agentName, round });
            thinkStarted = true;
          }
          // 小批量缓冲, 攒满 THINK_STREAM_CHUNK 就发一批, 前端打字机边收边播
          thinkBuffer += thinkText;
          if (!thinkFlushed && thinkBuffer.length >= THINK_STREAM_CHUNK) {
            if (isPromptLeakage(thinkBuffer)) {
              console.log("[think_filter] 已过滤system prompt泄漏, 长度:", thinkBuffer.length);
              thinkFlushed = true;
              thinkBuffer = "";
              thinkSentLen = 0;
            } else {
              // 只发送增量chunk, 不发完整buffer, 前端打字机自然逐字播放
              const newChunk = thinkBuffer.slice(thinkSentLen);
              emit({ type: "think_token", agent: agentName, text: newChunk });
              thinkSentLen = thinkBuffer.length;
              thinkBuffer = "";
            }
          }
          continue; // thinking 不加入 fullContent
        }
        // 普通 content
        if (inThinking && !thinkDone) {
          // thinking 结束, 第一个 content chunk → Flush缓冲
          thinkDone = true;
          // 残留缓冲【无条件】flush (不再要求 >=24 才发, 短 reasoning 也能显示)
          if (thinkBuffer.length > 0 && !isPromptLeakage(thinkBuffer)) {
            const pending = thinkBuffer.slice(thinkSentLen);
            if (pending) emit({ type: "think_token", agent: agentName, text: pending });
          }
          if (!thinkStarted) emit({ type: "think_start", agent: agentName, round });
          thinkFlushed = true;
          thinkBuffer = "";
          emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
          emit({ type: "answer_start", agent: agentName });
        }
        if (!inThinking) {
          // 没有 thinking, 兼容 <thinking> 标签方式
          fullContent += chunk;
          const thinkOpen = fullContent.indexOf("<thinking>");
          const thinkClose = fullContent.indexOf("</thinking>");
          if (thinkOpen >= 0 && thinkClose > thinkOpen) {
            thinkingText = fullContent.slice(thinkOpen + 10, thinkClose);
            thinkDone = true;
            // 缓冲: 思考完成后一次性发送完整内容, 不逐字推送
            emit({ type: "think_start", agent: agentName, round });
            emit({ type: "think_token", agent: agentName, text: thinkingText });
            emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
            const answerPart = fullContent.slice(thinkClose + 11).trim();
            if (answerPart) {
              emit({ type: "answer_start", agent: agentName });
              emit({ type: "token", agent: agentName, content: answerPart });
              fullContent = answerPart;
            } else {
              fullContent = "";
            }
            inThinking = false;
          } else if (thinkOpen >= 0) {
            inThinking = true;
            // 缓冲 thinking 内容, 不逐字推送到前端 (等待思考结束后一次性发送)
            thinkBuffer += chunk;
          } else {
            emit({ type: "token", agent: agentName, content: chunk });
          }
        } else {
          // thinking 已完成, 流式输出回答
          fullContent += chunk;
          emit({ type: "token", agent: agentName, content: chunk });
        }
      }

      // === 【关键】本轮是否真的拿到了产出 ===
      // 旧代码这里缺一个"成功即跳出": 流式正常返回内容后, 控制流仍走到下一次 streamAttempt,
      // 在循环顶部被当成"连接失败重试"处理 —— 打 llm_reconnecting + sleep 18~300s,
      // 并把本轮刚拿到的内容/工具调用清空重来。后果:
      //   · 每个 LLM 回合固定烧 10 次调用 (MAX_STREAM_RETRIES), token ×10
      //   · 每次之间 sleep 18s, 一个回合动辄 3 分钟
      //   · 前端持续收到 llm_reconnecting, 用户看到的就是"长任务时模型连不上"
      // 现在: 拿到东西立刻跳出; 只有全空 (0 chunk / 无 thinking / 无 tool_call) 才算失败继续重试,
      // 连续 2 次空则直接跳出, 交给下方 consecutiveEmptyCount 分支走非流式回退。
      const gotOutput = fullContent.trim().length > 0 || thinkingText.trim().length > 0 || nativeToolCalls.length > 0;
      if (gotOutput) break;
      consecutiveEmptyCount++;
      if (consecutiveEmptyCount >= 2) {
        logWarn("[流式重试] agent=" + agentName + " 连续" + consecutiveEmptyCount + "次空响应, 跳出重试循环, 走下方非流式兜底");
        break;
      }
    } catch (e) {
      const errObj = e as Error;
      const errMsg = errObj.message || String(e);
      // === 限流/配额: 429 (限流, 可稍后重试) 与 402/quota (配额耗尽, 重试无意义) 分开 ===
      // P2 修复: 旧正则 /429|rate.?limit|quota|too many requests/ 把 quota 混进 429 熔断,
      // 402 配额不足也被当成可恢复限流 → 空转重试白烧时间。现在 402/quota 直接停, 不重试。
      // 429 突发限流: 按自适应间隔拉大 (retryIdx++), 下次重试自动走更长的间隔 (18s→30s→60s→120s→240s→300s)
      // 用户要求: 429 后直接给 30 秒冷却起步 (不是 60s), 且自适应递增
      if (/(429|rate.?limit|too many requests)/i.test(errMsg)) {
        clearInterval(heartbeatTimer);
        if (!rateLimitRetried) {
          rateLimitRetried = true;
          // 429 → 至少拉到 30s 档 (RETRY_INTERVALS[1]=30s), 再撞继续拉; 用户要求 429 起步 30s 冷却
          retryIdx = Math.max(retryIdx + 1, 1);
          const cooldown = RETRY_INTERVALS[retryIdx];
          logWarn("[LLM限流] agent="+agentName+" 429 突发限流, 自适应冷却到 "+(cooldown/1000)+"s 后重试 1 次");
          emit({ type: "observation", agent: agentName, tool: "rate_limit", result: `LLM API 返回 429 (突发限流)。${cooldown/1000} 秒冷却后自动重试…` });
          await new Promise(r => setTimeout(r, cooldown));
          // 重试: 重置流式状态, 不 break, 让下一次循环再试
          streamAttempt--; // 抵消 for 的 ++, 使本轮算"重试那一次"
          fullContent = ""; thinkingText = ""; thinkDone = false; inThinking = false;
          thinkBuffer = ""; thinkFlushed = false; thinkStarted = false; thinkSentLen = 0;
          nativeToolCalls = [];
          continue;
        }
        // 重试后仍 429 → 真限流, 熔断走兜底
        logWarn("[LLM限流] agent="+agentName+" 自适应冷却重试后仍 429, 熔断走确定性兜底");
        emit({ type: "observation", agent: agentName, tool: "rate_limit", result: "LLM API 持续 429 (限流)。已停止重试, 改用确定性快路径直接出结果。" });
        rateLimitHit = true; llmDegraded = true;
        break;
      }
      // 配额耗尽 (402 / quota): 重试也不会恢复, 立即停并明确告知
      if (/(402|quota exceeded|insufficient (quota|credits)|payment required)/i.test(errMsg)) {
        clearInterval(heartbeatTimer);
        logWarn("[LLM配额] agent="+agentName+" 检测到配额耗尽 (402/quota), 停止重试");
        emit({ type: "observation", agent: agentName, tool: "quota_exhausted", result: "LLM API 配额已用完 (402/quota)。需充值或换模型, 当前走确定性快路径。" });
        rateLimitHit = true; llmDegraded = true;
        break;
      }
      // 可重试错误: 网络/超时/连接断开/5xx/无数据(0 chunk)
      const isRetryable = /(timeout|ECONNRESET|EPIPE|ECONNREFUSED|socket hang up|5[0-9]{2}|fetch failed|network|heartbeat|abort|未收到任何数据)/i.test(errMsg);
      if (isRetryable && streamAttempt < MAX_STREAM_RETRIES) {
        // 自适应间隔: 本次连接失败 → retryIdx++ (封顶), 下次重试自动拉大间隔
        // (18s→30s→60s→120s→240s→300s 封顶); 连接正常时 stream 成功 return, retryIdx 不变, 继续短间隔
        retryIdx = Math.min(retryIdx + 1, RETRY_INTERVALS.length - 1);
        // 前端转圈提示: "正在尝试链接 LLM..." (第 N/10 次, 下次间隔自动拉大)
        emit({ type: "llm_reconnecting", agent: agentName, attempt: streamAttempt + 1, max: MAX_STREAM_RETRIES, interval_s: RETRY_INTERVALS[retryIdx] / 1000 });
        logWarn("[流式重试] agent="+agentName+" 第"+(streamAttempt+1)+"次, 原因: "+errMsg.slice(0,120)+" → 下次间隔自动拉大到 "+(RETRY_INTERVALS[retryIdx]/1000)+"s");
        continue; // 进入下次重试
      }
      // 不可重试或重试耗尽
      clearInterval(heartbeatTimer);
      emit({ type: "think_end", agent: agentName, feasible: false, reason: "出错中断", plan: [], missing: "" });
      const friendly = friendlyError(errObj, s.defaultModel);
      emit({ type: "error", message: friendly });
      store.addRunEvent(runId, "error", { error: friendly });
      return friendly;
    }
    } // end for (streamAttempt)

    // === FIX: 空参数 tool call 全被过滤后, 模型实际什么有效工具都没调, 注入提示让它补充 ===
    // 防止 agnes 等模型反复返回 arguments=''/'{}' 的死循环
    if (emptyToolCallFiltered && !nativeToolCalls.length && !fullContent.trim() && !thinkingText.trim()) {
      messages.push({ role: "user", content: "[系统提示] 你上一轮的工具调用参数为空, 已被过滤。请重新调用工具并补充具体参数。如果无法补充参数, 请直接回复用户并说明。" });
      emit({ type: "observation", agent: agentName, tool: "empty_args_retry", result: "空参数调用已过滤, 提示模型补充参数 (避免死循环)" });
      // 不 continue, 让下一轮主循环重新调用 LLM
    }

    // === 借鉴 DSH (dsh-llm-deepseek L1206) + Hermes (turn_empty_response.py thinking-only prefill) ===
    // DSH 判定"空响应" = stop 终止 + 0 个内容块, 而 reasoning 块【也算内容块】。
    // 即: 模型把回答放进 reasoning_content (content 空) 时, 这不是"空/失败", 而是"内容在 reasoning 里"。
    // tianyan 对应做法: thinkingText 有实质内容而 fullContent 为空时, 【全文】当正文交付,
    // 而不是丢弃、也不是只取尾部 10 行 (旧做法丢前文)、也不造假思考。
    // 委派收尾例外 (症状1修复): 总编刚拿到子agent结果、强制要求出真实汇报正文的轮次,
    // 若模型只给 reasoning, 不能把"规划口吻"的 reasoning 当正文 → 禁用提升, 走下方 finalContent 确定性模板兜底
    if (thinkingText.trim() && !fullContent.trim() && !nativeToolCalls.length && !closingRound) {
      const replyText = thinkingText.trim();
      if (replyText) {
        fullContent = replyText;
        thinkDone = true; // 正文已由 reasoning 补齐 — 跳过下方"启发式/合成思考"分支 (reasoning 已单独存为 think 消息, 不重复渲染)
        // 思考面板收尾: 三条路径都要保证前端拿到完整的 think_start / think_token / think_end
        //  (a) 流式 THINK_PREFIX 路径: think_start 已在收到第一个 thinking 时发过 (thinkStarted=true);
        //      可能残留一小段未发 (没攒满24字符), 这里把"还没发的部分"补发
        //  (b) <thinking> 标签 / 非流式回退路径: think_start 可能还没发, 补发 start+完整token
        if (inThinking) {
          // 残留缓冲补发 (没攒满24字符的那截), 用 slice 保证不重发已发部分
          const pending = thinkBuffer.slice(thinkSentLen);
          if (pending && !isPromptLeakage(pending)) emit({ type: "think_token", agent: agentName, text: pending });
          emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
        } else if (thinkingText.trim().length > 0 && !thinkStarted) {
          // 标签路径/回退路径: 整段思考还没推过, 补发完整事件组
          emit({ type: "think_start", agent: agentName, round });
          emit({ type: "think_token", agent: agentName, text: replyText });
          emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
        } else if (thinkingText.trim().length > 0) {
          // 已发过 think_start 但还没发 think_end (流结束前没等到 content chunk): 补发收尾
          emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
        }
        // 正文已交付, 无需再发; 下方 2184 的合成/启发式分支因 thinkDone=true 跳过
        logInfo("[reasoning当正文] agent="+agentName+" reasoning 全文 "+replyText.length+" 字已作为正文交付 (content 通道为空)");
      }
    }

    // 如果没有 thinking 标签, 检查是否是启发式思考文本
    if (!thinkDone) {
      if (fullContent.trim().length === 0 && !nativeToolCalls.length) {
        // === 空 content 保护: 不生成假思考、不假装"分析完成" ===
        // agnes 等模型流式被 TLS/Cloudflare 阻断或内容全塞在 reasoning 里时,
        // 这里 fullContent 为空。旧代码会走 else 分支发一段"合成思考"(每轮都刷新一段),
        // 前端看到的就是"思考过程在不停循环"。现在静默跳过假思考, 让下方
        // consecutiveEmptyCount 计数 → 非流式回退 → 重试 真正生效。
        // (不能用 continue: 那会跳过空回复计数直接进下一轮, 反而死循环)
      } else if (nativeToolCalls.length > 0) {
        // === 路线A (2026-09-28): 工具调用路径不再合成假思考 (generateSyntheticThinking 已删) ===
        // 原则: 模型=大脑, 它真实选择了工具 → 前端只映射这个真实决策, 不编"正在分析需求..."
        // 模型若给了 reasoning_content (thinkingText 非空) 上方已发过; 没给 reasoning 就诚实标注工具决策
        if (!thinkingText.trim()) {
          const toolNames = nativeToolCalls.map(t => t.name).join(", ");
          const honestTc = `模型本轮选择调用工具: ${toolNames} (未开启 reasoning 通道, 此为真实工具决策映射, 非合成分析)`;
          thinkingText = honestTc;
          emit({ type: "think_start", agent: agentName, round });
          emit({ type: "think_token", agent: agentName, text: honestTc });
          emit({ type: "think_end", agent: agentName, feasible: true, reason: "工具调用决策(真实映射)", plan: [], missing: "" });
        }
      } else if (!nativeToolCalls.length) {
        // === 思考面板兜底: 只要本轮有内容且没有原生工具调用, 就保证前端思考面板有内容 ===
        //  (a) 启发式: 模型输出了规划性文本(未用 thinking 标签) → 整段当思考路由 (这是模型真实输出, 保留)
        //  (b) 路线A: 模型只给 content 没给 reasoning_content → 不再合成假分析, 静默跳过
        //      (正文本身就是模型真实输出, 思考面板空就空, 不拿"内容生成完毕"假字符串冒充模型思考)
        if (isHeuristicThinking(fullContent)) {
          thinkingText = fullContent;
          thinkDone = true;
          emit({ type: "think_start", agent: agentName, round });
          emit({ type: "think_token", agent: agentName, text: fullContent });
          emit({ type: "think_end", agent: agentName, feasible: true, reason: "思考完成", plan: [], missing: "" });
          fullContent = "";
        }
        // else: 不发假思考 (旧代码此处 generateSyntheticThinking 已删 — 路线A: 前端不显示伪造的思考)
      }
    }

    // let (非 const): 非流式回退拿到内容后会刷新它 (见下方 fallback 分支)
    let content = fullContent;
    if (content.trim()) {
      bestContent = content;  // 记录最佳内容
      consecutiveEmptyCount = 0;  // 重置空回复计数
      // 连接正常 (成功出内容) → 落回最短间隔档, 下次重试又快起来
      // (用户要求: 正常连接用短间隔, 只有失败才拉长)
      if (retryIdx > 0) {
        logInfo("[流式重试] agent="+agentName+" 出内容成功, 间隔档落回 "+0+" (18s)");
        retryIdx = 0;
      }
      // LLM 连接成功 (前面可能在重试) → 通知前端清掉"正在尝试链接"转圈条
      emit({ type: "llm_reconnect_ok", agent: agentName });
    }

    // 持久化思考文本 (tool_name='think'), 前端历史渲染时可恢复折叠面板
    if (thinkingText.trim()) {
      store.addMessage(pid, "assistant", thinkingText.trim(), { toolName: "think", toolCallId: agentName });
    }
    // ===== 优先使用原生 tool_calls =====
    // ===== 兜底: 正文里表达委派意图但没发 tool_call → 代码层强制发起委派 =====
    // agnes 在流式重试耗尽时把"我要委派架构师/主笔"写进正文文本而非原生 tool_call,
    // 导致前端专家卡片永远不出现 (用户看到的"总编说要委派但卡住")。
    // 这里检测正文里的委派意图, 直接按当前阶段路由到专家 agent, 不等模型自觉。
    //
    // 【仅超时/降级才接管】正常轮一律让主 Agent 自己发 delegate_to_agent — 旁路抢着代跑会把
    // 主 Agent 的"拆任务权"架空 (它名义上是大脑, 实际只是转发工具结果的嘴)。
    // 只有本轮 LLM 确实降级 (429/配额耗尽/重试过/空响应) 才由代码层接管, 保证限流时仍能出结果。
    //
    // 【例外: "承诺型委派" 也算需要接管】(2026-10 修)
    // 实测总编在正文里写 "我将委派主笔 agent 撰写第一章正文。" 然后一个 tool_call 都不发,
    // 循环把它当最终答复 → done → 用户看到"总编说要委派, 然后任务就结束了", 正文一个字没写。
    // 这种情况模型已经做完了决策 (派给谁、干什么都写清楚了), 只是**没落成 tool_call**,
    // 代码层接管并不夺它的决策权 —— 夺的只是"说了不做"。
    // 判据收紧三重, 避免误伤真实的汇报正文:
    //   ① 本 run 还没委派过 (已委派过就是收尾汇报轮, 不该再动)
    //   ② 正文很短 (<=300 字) —— 装得下"我要派人"但装不下任何交付物
    //   ③ 含明确的执行意向句式 (意向副词 + 委派/执行/开始… + 角色名或成果名)
    const bodyText0 = (content || "").trim();
    const isDelegationPledge =
      !state.orchestratorDelegated &&
      bodyText0.length > 0 &&
      bodyText0.length <= 300 &&
      /(?:我将|我要|我马上|接下来|现在就|准备|打算|即将|稍后|随后|然后)?\s*(?:委派|交给|指派|安排|派给|让|执行|启动|调用|开展|开始|动笔)\s*[^。！？\n]{0,16}?(?:agent|专家|主笔|架构师|策划|资料员|审校|质检|角色|编剧|写作|撰文|正文|设定|Step|步骤|阶段|writer|architect|explorer|checker|designer|presenter)/i.test(bodyText0);
    const isDegradedRound = llmDegraded || rateLimitHit || !bodyText0.trim() || isDelegationPledge;
    if (nativeToolCalls.length === 0 && agentName === "orchestrator" && depth === 0 && isDegradedRound) {
      const body = (content || "").trim();
      // 找 messages 里最后一条 user 消息作为用户原文
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUserMsg?.content || body;
      const stepMatch = body.match(/Step\s*(\d+)|阶段\s*(\d+)|第\s*(\d+)\s*步/i);
      const phaseNum = Number(stepMatch ? (stepMatch[1] || stepMatch[2] || stepMatch[3]) : store.getProjectState(pid).currentPhase);
      // 三类意图优先级: 扫榜(scan_bestseller) > 搜索(web_search) > 阶段兜底
      const isScanIntent = !state.orchestratorDelegated
        && /扫榜|扫.*榜|榜单|畅销榜|扫榜调研/i.test(body || userText);
      // (2026-10-18 用户实测: 总编写"我这就派角色师执行 Step 3…归拢进设定集", isDelegationPledge=true
      //  但 intentMatch 词表里没有 角色/设定/建档 → isDelegationIntent=false → 整个接管块被跳过,
      //  run 直接 done, 设定集永远空。intentMatch 补上这些词, 且 isDelegationPledge 命中时直接算委派意图。)
      const intentMatch = body.match(/委派|@|\barchitect\b|\bwriter\b|\bdesigner\b|架构师|主笔|总编|拆书|正文|审稿|质检|角色|人设|人物|设定|建档|世界观|档案/i);
      const isDelegationIntent = !!((intentMatch || isDelegationPledge) && !state.orchestratorDelegated && !isScanIntent && PHASES[phaseNum as 1|2|3|4|5|6|7|8]);
      const isSearchIntent = !isScanIntent && !state.orchestratorDelegated
        && /搜索|搜一下|搜榜|找资料|查资料|联网搜|网络搜|资料员|搜索一下/.test(body || userText);
      // 拆书意图: "拆书/拆解/解构《XXX》" → 核心工具 analyze_novel 确定性代跑。
      // (2026-10-18 用户实测: 点名委派拆书走 named 路径 coreTool="", 纯靠子 LLM 自觉,
      //  子 LLM 只回了句"好, 我来完成..."就一个工具没调 → 终审 0/10 → 打回后也没人返修,
      //  拆书事实上没发生。有书名就必须让代码层把 analyze_novel 真跑了。)
      const deconTitle = (
        userText.match(/《([^》]{1,40})》/)?.[1] ||
        body.match(/《([^》]{1,40})》/)?.[1] ||
        ""
      ).trim();
      const isDeconstructIntent = !isScanIntent && !isSearchIntent && !!deconTitle
        && /拆书|拆文|拆解|解构|拉片/.test(bodyText0 + " " + userText);
      if (isScanIntent || isDelegationIntent || isSearchIntent) {
        // 【承诺型委派要听模型说的那个专家】原本一律按 PHASES[currentPhase].agent 路由,
        // 但项目 currentPhase 常常停在 1 (扫榜), 而用户/总编要的是"委派主笔写正文" →
        // 会被硬路由回架构师再扫一次榜, 完全答非所问。模型既然已经在正文里点名了专家,
        // 就以它点名的为准 (这才是尊重它的决策权), 点不准才回退到阶段表。
        const named = pledgeTarget(bodyText0);
        const phaseAgent = PHASES[phaseNum as 1|2|3|4|5|6|7|8]?.agent as AgentName | undefined;
        const targetAgent = (isScanIntent ? "story-architect" : isSearchIntent ? "story-explorer" : (named || phaseAgent)) as AgentName | undefined;
        if (targetAgent && isValid(targetAgent) && targetAgent !== DEFAULT_AGENT) {
          // 【承诺委派的话术不能照搬阶段表】以前一律写"代码层兜底: 执行 Step N",
          // 于是"委派主笔写正文"被代号成 "执行 Step 1 (扫榜调研)", 主笔拿着扫榜的任务真的去扫榜了
          // → 用户问正文、系统回一份榜单趋势, 答非所问。点名专家时按**用户原文**下发任务。
          const delegateTask = isScanIntent
            ? "扫榜: 抓取平台真实榜单数据并归纳趋势"
            : isSearchIntent
              ? "搜索/资料: 联网检索并整理结果"
              : named
                ? `承诺委派接管: ${userText.slice(0, 120)}`
                : `代码层兜底: 执行 Step ${phaseNum}`;
          logInfo("[委派兜底] agent=orchestrator " + (isScanIntent ? "检测到扫榜意图, 强制委派到 story-architect (scan_bestseller)" : isSearchIntent ? "检测到搜索/资料意图, 强制委派到 story-explorer" : "正文检测到委派意图(Step "+phaseNum+"), 强制委派到 "+targetAgent));
          emit({ type: "delegate", from: agentName, to: targetAgent, task: delegateTask, depth: depth + 1 });
          emit({ type: "sub_agent_start", agent: targetAgent, task: delegateTask, depth: depth + 1 });
          // 持久化: 刷新/断线重连后, 前端 loadMessages 仍能渲染出子 agent 卡片
          store.addMessage(pid, "assistant", JSON.stringify({ agent: targetAgent, task: delegateTask }), { toolName: "sub_agent_start", toolCallId: targetAgent });
          const t0fb = Date.now();
          const subSkillPrompts = getAgentSkillPrompts(targetAgent);
          const subSkillBlock = subSkillPrompts.length ? "\n\n" + subSkillPrompts.join("\n\n") : "";
          const proj = store.getProject(pid);
          const subMsgs: Array<{ role: string; content: string }> = [
            { role: "system", content: getAgentPrompt(targetAgent) + subSkillBlock + "\n\n可用工具: " + AGENT_TOOLS[targetAgent].join(", ") + "\n调用工具时使用 function calling (native tool_calls)。\n否则直接回复。" },
          ];
          if (proj) {
            let ctxBlock = `项目: ${proj.name} | 类型: ${proj.genre} | 文风: ${proj.style}\n核心设定: ${proj.premise}`;
            const subProfiles = store.listCharacterProfiles(pid);
            if (subProfiles.length) ctxBlock += "\n\n【角色档案】\n" + subProfiles.map((p: any) => `- ${p.name}(${p.role || "?"}): ${p.personality || ""}`).join("\n");
            const subWorld = store.listWorldEntries(pid);
            if (subWorld.length) ctxBlock += "\n\n【世界观】\n" + subWorld.map((w: any) => `- [${w.category}] ${w.name}: ${w.description || ""}`).join("\n");
            subMsgs.push({ role: "system", content: ctxBlock });
          }
          const proj0 = store.getProject(pid);
          const PHASE_CORE_TOOL: Record<number, string> = {
            1: "scan_bestseller", 2: "analyze_novel", 3: "query_project",
            4: "generate_outline", 5: "continue_writing", 6: "review_chapter",
            7: "quality_check", 8: "export_project_data",
          };
          // 【点名专家时不强行代跑阶段核心工具】阶段表给 writer 配的是 continue_writing(需要已有章节),
          // 而"写第一章"时项目还是 0 章, 强行代跑必然报错。这种情况交给专家自己用工具完成,
          // 代码层只负责"把任务派出去 + 逼它真的动手"。
          // 【例外】拆书有明确书名 → analyze_novel 有确定性输入, 必须代跑, 不能靠 LLM 自觉。
          const coreTool = isScanIntent ? "scan_bestseller" : isSearchIntent ? "web_search"
            : isDeconstructIntent ? "analyze_novel"
            : named ? "" : (PHASE_CORE_TOOL[phaseNum] || "");
          const projGenreForTask = proj0?.genre || "";
          // 搜索意图: 任务文本是搜什么; 阶段意图: 文本是阶段说明
          const taskText = coreTool
            ? (isScanIntent
              ? `你现在的任务是"扫榜调研"。请调用工具 "scan_bestseller" (参数: genre="${projGenreForTask}", platform="番茄小说"), 用真实抓回的榜单条目归纳题材趋势并给出创作建议。严禁编造书名/排名。用户原文: ${userText.slice(0, 300)}`
              : isSearchIntent
              ? `你现在的任务是"联网搜索"。用户想搜的内容 (原文): ${userText.slice(0, 500)}

【强制指令】你必须调用工具 "web_search" (参数 query=用户搜索内容), 然后用工具返回的真实结果整理成中文汇报。严禁不调工具、只口头描述。若工具调用失败, 汇报失败原因。`
              : isDeconstructIntent
              ? `你现在的任务是"拆书解构《${deconTitle}》"。请调用工具 "analyze_novel" (参数: title="${deconTitle}"), 基于抓回的真实文本产出完整拆解: 钩子设计 / 节奏把控 / 人设塑造 / 文风特点 / 世界观设定 / 伏笔布局, 并给出具体可借鉴的写作技巧。严禁只回"我来完成"这类启动语, 严禁编造。用户原文: ${userText.slice(0, 300)}`
              : `执行 Step ${phaseNum} (${PHASES[phaseNum as 1|2|3|4|5|6|7|8].name})。
用户原文: ${userText.slice(0, 500)}

【强制指令】你必须调用工具 "${coreTool}" 完成本阶段核心动作 (参数: ${phaseNum === 1 ? `genre="${projGenreForTask}"` : phaseNum === 5 ? "chapter_id=当前草稿章节" : "按当前阶段需要"}), 然后用工具返回的真实结果整理成中文汇报。严禁不调工具、只口头描述。若工具调用失败, 汇报失败原因。`)
            : named
              ? `${userText.slice(0, 500)}

【强制指令】总编已把这件事明确委派给你(${targetAgent}), 由你负责完成。
你必须调用**你自己的工具**真的动手产出成果 —— 例如写正文就要真的写出正文全文, 做设定就要真的落库。
严禁只回复"我将要/马上开始/已安排去做"这类执行意向, 严禁复述计划, 严禁把任务推回给总编。
若某工具因缺少前置数据而失败 (例如没有大纲), 就用现有上下文自行补齐最小前置再继续, 或如实说明卡在哪一步。${targetAgent === "character-designer" ? `
【建档专项】本任务涉及角色/设定归档, 侧边栏"设定集"只认 add_element 落库的数据:
1) 每个角色必须调 manage_character(action=add, ...) 建档案;
2) 每条设定 (角色/世界观/力量体系/金手指/境界…) 必须逐条调 add_element(kind, name, detail) 写进设定集, kind 用 character/worldview/power_system 等;
3) 回复里必须如实汇报"实际落库 N 条设定 + M 份角色档案"。
只在正文里描述设定而不调 add_element = 没做, 终审会打回。` : ""}`
              : `执行 Step ${phaseNum} (${PHASES[phaseNum as 1|2|3|4|5|6|7|8].name})。用户原文: ${userText.slice(0, 500)}`;
          subMsgs.push({ role: "user", content: taskText });
          // === 兜底的兜底: 代码层强制代跑该阶段核心工具 ===
          // 即便子 agent LLM 流式不稳没发出 tool_call, 这里直接调 dispatchTool 把核心动作做完,
          // 保证"扫榜就是真扫榜" (story-architect 负责), 不靠模型自觉
          let subResult: string;
          const subMsgsProbe = [...subMsgs];
          const subRunId = runId;
          // 代跑参数 (扫榜: 真抓榜单; 搜索: 联网检索; 阶段: 核心工具)
          const coreArgs: Record<string, unknown> = isScanIntent
            ? { genre: projGenreForTask || "仙侠", platform: "番茄小说" }
            : isSearchIntent
              ? { query: userText.slice(0, 200), max_results: 10 }
              : isDeconstructIntent
                ? { title: deconTitle }
              : phaseNum === 1
                ? { genre: projGenreForTask || "", platform: "番茄小说" }
                : phaseNum === 4
                  ? { premise: proj?.premise || "", genre: projGenreForTask || "", num_chapters: 12 }
                : phaseNum === 2
                  ? { title: (userText.match(/对标[^，。\n]+/) || [""])[0].replace("对标", "").trim() || "默认畅销书" }
                : {};
          // === 确定性快路径: 先把核心工具代跑完, 再与 LLM 子循环竞态 ===
          // LLM 卡 TLS/429 时 (subLoopPromise 不返回), 卡片仍能带真实工具结果几秒内出, 不傻等
          if (coreTool) {
            try {
              emit({ type: "observation", agent: targetAgent, tool: coreTool, result: "[代码层强制执行] 核心工具由系统代跑 (确保执行不依赖模型), 真实结果如下..." });
              const coreToolResult = await dispatchTool(pid, coreTool, coreArgs, targetAgent);
              subResult = (isScanIntent || isSearchIntent) ? coreToolResult : "【工具真实执行结果 (系统代跑 " + coreTool + ")】\n" + coreToolResult;
              logInfo("[工具代跑] " + targetAgent + " 核心工具 " + coreTool + " 由代码层强制执行, 结果 " + coreToolResult.length + " 字");
            } catch (e) {
              logWarn("[工具代跑失败] " + coreTool + ": " + (e as Error).message?.slice(0, 150));
              subResult = "";
            }
          } else {
            subResult = "";
          }
          // LLM 子循环竞态: LLM 卡 TLS/429 时在超时点用代跑结果出卡片 (不等 LLM)
          // 注意预算取舍: 核心工具已由代码层代跑完 (上面 dispatchTool), 这里只是等 LLM 把工具结果
          // 整理成"人话汇报"。旧值 15s 太紧 —— 带 tool_call 的长回答 15s 内基本吐不完, 必然落到
          // 代跑兜底, 用户体感就是"长任务里模型连不上/没启用"。
          // 默认放宽到 45s, 可用环境变量 TIANYAN_SUB_LLM_BUDGET_MS 覆盖。
          const SUB_LLM_BUDGET_MS = Number(process.env.TIANYAN_SUB_LLM_BUDGET_MS) || 45_000;
          // 记录子 agent 到底调没调工具 — 光有文本不算交付 (实测会只回一句"好, 我来完成...").
          // 返修判定要用: 0 工具 + 启动语文本 = 空话, 必须返修, 不能指望终审 LLM 每次都抓到。
          const subToolsUsed = new Set<string>();
          const subEmit: typeof emit = (evt) => {
            const t = (evt as { tool?: string }).tool;
            if ((evt.type === "step" || evt.type === "observation") && t) subToolsUsed.add(t);
            emit(evt);
          };
          const subLoopPromise = runAgentLoop({
            pid, agentName: targetAgent, messages: subMsgsProbe,
            depth: depth + 1, runId: subRunId, delegationLog: state.delegationLog, emit: subEmit,
          });
          const timeoutPromise = new Promise<string>((resolve) =>
            setTimeout(() => resolve(""), SUB_LLM_BUDGET_MS)
          );
          const llmResult = await Promise.race([subLoopPromise, timeoutPromise]);
          if (llmResult.trim()) subResult = subResult + "\n\n【子agent LLM 汇报】\n" + llmResult;
          // LLM 在预算内没出结果 → 立刻用代跑结果出卡片 (sub_answer), 不再等
          // 429/限流时 LLM 子循环会熔断, 这里立即用代跑结果快出, 不卡 15s
          if (!llmResult.trim()) {
            // 没核心工具可代跑 + LLM 也没出结果 → 没有任何东西可交付。
            // 别发空卡片糊弄: 如实告知 orchestrator, 让它在汇报里说明 (2026-10-18 拆书实测踩过)
            if (!subResult.trim()) {
              logWarn("[子agent快出] " + targetAgent + " 无 coreTool 且 LLM 无产出, 交付为空, 不出卡片");
              messages.push({ role: "user", content: `[系统指令] 委派给 ${targetAgent} 的任务「${delegateTask}」本轮没有产出任何东西 (专家 LLM 无响应, 且无确定性工具可代跑)。请如实告知用户该任务本轮失败、建议重试, 不要编造结果, 不要把这次委派说成已完成。` });
              state.orchestratorDelegated = true;
              continue;
            }
            logInfo("[子agent快出] " + targetAgent + " LLM " + SUB_LLM_BUDGET_MS/1000 + "s 内未出结果, 用代跑工具结果直接出卡片");
            const subDurEarly = Date.now() - t0fb;
            const earlyLabel = isScanIntent ? "扫榜" : isSearchIntent ? "搜索/资料" : isDeconstructIntent ? `拆书《${deconTitle}》` : `兜底 Step ${phaseNum}`;
            autoAdvancePhase(pid, emit);
            state.delegationLog.push({ to: targetAgent, task: earlyLabel + " (快出)", result: subResult, durationMs: subDurEarly });
            // B-3 总编终审: 快出路径产出出门前总编读一遍 (不背书→总编修订版才出门)
            const finalR_early = await finalReviewDeliverable(pid, runId, targetAgent, earlyLabel + " (快出)", subResult, emit);
            if (!finalR_early.approved) subResult = finalR_early.content + "\n\n[终审裁决: " + finalR_early.verdict.slice(0, 150) + "]";
            emit({ type: "delegate_done", from: agentName, to: targetAgent, task: earlyLabel, result: subResult, durationMs: subDurEarly });
            emit({ type: "sub_answer", agent: targetAgent, text: subResult });
            emit({ type: "sub_agent_done", agent: targetAgent, result: subResult, durationMs: subDurEarly });
            // 持久化 sub_agent_start (快出路径原来缺, 历史重放建不出卡片 → sub_answer 结果被丢)
            store.addMessage(pid, "assistant", JSON.stringify({ agent: targetAgent, task: delegateTask }), { toolName: "sub_agent_start", toolCallId: targetAgent });
            store.addMessage(pid, "assistant", subResult, { toolName: "sub_answer", toolCallId: targetAgent });
            store.addMessage(pid, "assistant", JSON.stringify({ agent: targetAgent, result: subResult.slice(0, 800), durationMs: subDurEarly, early: true }), { toolName: "sub_agent_done", toolCallId: targetAgent });
            // 注入 orchestrator 上下文, 让下一轮基于真实结果继续
            const earlyPushHint = isScanIntent
              ? `扫榜任务已完成 (LLM 归纳不可用, 结果为代码层真抓数据)。请把上面的榜单数据整理成面向用户的中文汇报 (题材趋势 + 创作建议)。`
              : isSearchIntent
                ? `搜索任务已完成。请把上面的搜索结果整理成面向用户的中文汇报。`
                : `该阶段产出的数据已完成。请把上面的子agent结果整理成面向用户的中文汇报，并在末尾明确询问用户是否确认进入下一阶段。未获用户确认前，不要委派下一步。`;
            messages.push({ role: "user", content: buildDelegationSummary(targetAgent, earlyLabel, subResult, subDurEarly) + `\n\n[系统指令] ${earlyPushHint}` });
            state.orchestratorDelegated = true;
            continue; // orchestrator 基于代跑结果继续 (LLM 子循环仍在后台跑, 后续轮次可补充 LLM 分析)
          }
          const subDur = Date.now() - t0fb;
          const fallbackLabel = isScanIntent ? "扫榜" : isSearchIntent ? "搜索/资料" : isDeconstructIntent ? `拆书《${deconTitle}》` : `兜底 Step ${phaseNum}`;
          autoAdvancePhase(pid, emit);
          state.delegationLog.push({ to: targetAgent, task: fallbackLabel, result: subResult, durationMs: subDur });
          // B-3 总编终审 + 返修闭环: 打回不再是终点 —— 带着修改指令让同一个专家重跑一轮再终审。
          // 以前的断链: 裁决意见只被附在文本末尾, 从未送回专家, run 直接结束 (用户: "拆完书就没下文了")。
          const reworkOnce = async (feedback: string): Promise<string> => {
            const retryMsgs: Array<{ role: string; content: string }> = [...subMsgsProbe];
            if (llmResult.trim()) retryMsgs.push({ role: "assistant", content: llmResult.slice(0, 2000) });
            // 第一轮已经代跑出的真实工具数据直接喂给返修轮, 不重复跑 (扫榜一次要 60s+)
            if (coreTool && subResult.trim()) {
              retryMsgs.push({ role: "user", content: `【第一轮工具真实数据已就绪, 无需重复调用】\n${subResult.slice(0, 4000)}` });
            }
            retryMsgs.push({ role: "user", content: `【总编终审打回 · 返修指令】\n${feedback}\n\n这次必须真的产出完整成果${coreTool ? " (基于上面的真实工具数据写成完整汇报)" : " —— 调用你自己的工具真的动手, 写正文就要真的写出正文"}。严禁只回"我将要/马上开始"这类启动语, 严禁复述计划, 严禁把任务推回给总编。` });
            logInfo(`[终审返修] ${targetAgent} 带修改指令重跑 (${fallbackLabel})`);
            const retryText = await Promise.race([
              runAgentLoop({
                pid, agentName: targetAgent, messages: retryMsgs,
                depth: depth + 1, runId: subRunId, delegationLog: state.delegationLog, emit: subEmit,
              }),
              new Promise<string>((resolve) => setTimeout(() => resolve(""), SUB_LLM_BUDGET_MS)),
            ]);
            if (!retryText.trim()) return "";
            const base = coreTool && subResult.trim() ? subResult : "";
            return base ? base + "\n\n【返修汇报】\n" + retryText : "【返修汇报】\n" + retryText;
          };
          const finalR_fb = await finalReviewWithRework(pid, runId, targetAgent, fallbackLabel, subResult, emit, reworkOnce, 1);
          if (!finalR_fb.approved) subResult = finalR_fb.content + "\n\n[终审裁决: " + finalR_fb.verdict.slice(0, 150) + "]";
          else if (finalR_fb.reworked > 0) subResult = finalR_fb.content; // 返修通过 → 用返修版
          // 空话兜底: 终审通过了, 但专家全程 0 工具且只有启动语 → 诚实标注, 不伪装成交付
          else if (subToolsUsed.size === 0 && !coreTool && subResult.trim().length < 300) {
            subResult = subResult + "\n\n⚠️ [系统标注] 该专家本轮未调用任何工具, 以上只是口头应承, 实际成果未产出。可重发指令让其重试。";
            logWarn(`[空话兜底] ${targetAgent} 0 工具 + ${subResult.trim().length} 字短文本, 已标注`);
          }
          emit({ type: "delegate_done", from: agentName, to: targetAgent, task: fallbackLabel, result: subResult, durationMs: subDur });
          emit({ type: "sub_answer", agent: targetAgent, text: subResult });
          emit({ type: "sub_agent_done", agent: targetAgent, result: subResult, durationMs: subDur });
          // 持久化: 子 agent 结果 + 完成状态, 刷新历史时可恢复卡片正文
          store.addMessage(pid, "assistant", subResult, { toolName: "sub_answer", toolCallId: targetAgent });
          store.addMessage(pid, "assistant", JSON.stringify({ agent: targetAgent, result: subResult.slice(0, 800), durationMs: subDur }), { toolName: "sub_agent_done", toolCallId: targetAgent });
          // 子 agent 结果注入 messages 供下一轮 orchestrator 处理
          const pushHint = isScanIntent
            ? `扫榜任务已完成。请把上面的榜单数据整理成面向用户的中文汇报 (题材趋势 + 创作建议)。`
            : isSearchIntent
            ? `搜索任务已完成。请把上面的搜索结果整理成面向用户的中文汇报。`
            : `该阶段产出的数据已完成。请把上面的子agent结果整理成面向用户的中文汇报，并在末尾明确询问用户是否确认进入下一阶段。未获用户确认前，不要委派下一步。`;
          messages.push({ role: "user", content: buildDelegationSummary(targetAgent, fallbackLabel, subResult, subDur) + `\n\n[系统指令] ${pushHint}` });
          state.orchestratorDelegated = true;
          continue; // 让 orchestrator 基于子 agent 结果继续
        }
      }
    }

    // === LLM 429 熔断: 流式全部失败且无内容 → 给出明确提示, 不静默空转 ===
    // 确定性快路径 (扫榜/搜索) 已在上方代跑出真实数据; 这里是"无核心工具可代跑"时的兜底告知
    // 修复3: orchestrator (depth=0) 429 → 发限流提示 + done (整轮收尾);
    //        子 agent (depth>0) 429 → 只发限流提示 (token), 不发 done (done 仍由顶层 orchestrator 发, 避免悬挂)
    if (rateLimitHit && !fullContent.trim() && !nativeToolCalls.length && !thinkingText.trim() && (agentName === "orchestrator" || depth > 0)) {
      const rateLimitNote = depth > 0
        ? `⚠️ 专家「${agentName}」触发 429 限流 (免费额度用尽), 该专家本轮无 LLM 输出。系统已停止重试以保护账号额度, 由总编接管后续。`
        : "⚠️ LLM 接口触发限流 (429, 免费额度用尽/请求过频)。系统已停止重试以保护你的账号额度。\n- **可用**：扫榜、搜索 等确定性任务 (不依赖 LLM, 由系统直接执行)\n- **受限**：需要总编自由创作/推理的指令 (续写、规划、审稿) — 请等额度恢复后重试, 或更换 API Key / 升级付费额度。";
      logWarn(`[429兜底] ${agentName} (depth=${depth}) 无 LLM 可用, 返回限流提示`);
      emit({ type: "answer_start", agent: agentName });
      emit({ type: "token", agent: agentName, content: rateLimitNote });
      // 只有顶层 orchestrator 发 done (整轮收尾); 子 agent 不发 done (父 loop 会继续)
      if (agentName === "orchestrator") {
        emit({ type: "done", agent: "orchestrator", steps: 0, stats: {}, runId });
      }
      store.addMessage(pid, "assistant", rateLimitNote, { toolName: "rate_limit_notice" });
      return rateLimitNote;
    }

    if (nativeToolCalls.length > 0) {
      // 存储 tool_calls 消息 (tool_name='tool_calls'), 前端用于渲染折叠面板
      const tcSummary = nativeToolCalls.map((tc) => ({
        function: { name: tc.name },
        arguments: tc.arguments,
      }));
      store.addMessage(pid, "assistant", JSON.stringify(tcSummary), { toolName: "tool_calls", toolCallId: agentName });
      // 将 assistant 消息以 OpenAI tool_calls 格式加入 messages
      const assistantMsg: any = { role: "assistant", content: content || null };
      assistantMsg.tool_calls = nativeToolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      messages.push(assistantMsg);

      for (const tc of nativeToolCalls) {
        emit({ type: "step", agent: agentName, tool: tc.name, args: tc.arguments });
        const toolKey = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        loopDetect[toolKey] = (loopDetect[toolKey] || 0) + 1;
        if (loopDetect[toolKey] >= s.loopDetectCount) {
          const msg = `检测到循环: ${tc.name} 已连续调用 ${s.loopDetectCount} 次`;
          emit({ type: "error", message: msg });
          break;
        }
        // ===== 委派: 走子 agent =====
        if (tc.name === "delegate_to_agent") {
          // 子agent(depth>0)禁止委派,只有orchestrator可以委派
          if (depth > 0) {
            const err = "子agent不能使用delegate_to_agent，只有总编可以委派。请直接使用你的工具完成任务。";
            messages.push({ role: "tool", content: JSON.stringify({ error: err }), tool_call_id: tc.id });
            emit({ type: "observation", agent: agentName, tool: tc.name, result: err });
            continue;
          }
          const target = String(tc.arguments.agent || tc.arguments.target || "");
          const task = String(tc.arguments.task || tc.arguments.prompt || "");
          if (!isValid(target) || target === DEFAULT_AGENT) {
            const err = `无效委派目标: ${target}`;
            messages.push({ role: "tool", content: JSON.stringify({ error: err }), tool_call_id: tc.id });
            emit({ type: "observation", agent: agentName, tool: tc.name, result: err });
            continue;
          }
          if (depth >= getMaxDelegateDepth()) {
            const err = `已达最大委派深度 ${getMaxDelegateDepth()}`;
            messages.push({ role: "tool", content: JSON.stringify({ error: err }), tool_call_id: tc.id });
            emit({ type: "observation", agent: agentName, tool: tc.name, result: err });
            continue;
          }
          // 多 agent 协同: orchestrator 可多次委派 (最多8次/轮, 防止无限循环)
          if (agentName === "orchestrator" && depth === 0) {
            if (!state.orchestratorDelegateCount) state.orchestratorDelegateCount = 0;
            state.orchestratorDelegateCount++;
            if (state.orchestratorDelegateCount > 8) {
              const err = "【委派次数限制】本轮已达最大委派次数(8次)。请整理当前结果汇报给用户，等待指示。";
              messages.push({ role: "tool", content: JSON.stringify({ error: err }), tool_call_id: tc.id });
              emit({ type: "observation", agent: agentName, tool: tc.name, result: err });
              state.orchestratorDelegateCount = 0;
              continue;
            }
          }
          // 内联委派逻辑
          emit({ type: "delegate", from: agentName, to: target as AgentName, task, depth: depth + 1 });
          emit({ type: "sub_agent_start", agent: target as AgentName, task, depth: depth + 1 });
          // 持久化 sub_agent_start: 历史重放时 findSubBubbleByAgent 靠它建子 agent 卡片
          store.addMessage(pid, "assistant", JSON.stringify({ agent: target, task }), { toolName: "sub_agent_start", toolCallId: target });
          const proj = store.getProject(pid);
          const subSkillPrompts = getAgentSkillPrompts(target);
          const subSkillBlock = subSkillPrompts.length ? "\n\n" + subSkillPrompts.join("\n\n") : "";
          const subMsgs: Array<{ role: string; content: string }> = [
            { role: "system", content: getAgentPrompt(target) + subSkillBlock + "\n\n可用工具: " + AGENT_TOOLS[target as AgentName].join(", ") + "\n调用工具时使用 function calling (native tool_calls)。\n如果模型不支持 function calling，输出一行 JSON: {\"tool\": \"工具名\", \"args\": {...}}。\n否则直接回复。" },
          ];
          if (proj) {
            let ctxBlock = `项目: ${proj.name} | 类型: ${proj.genre} | 文风: ${proj.style}\n核心设定: ${proj.premise}`;
            const subProfiles = store.listCharacterProfiles(pid);
            if (subProfiles.length) ctxBlock += "\n\n【角色档案】\n" + subProfiles.map((p: any) => `- ${p.name}(${p.role || "?"}): ${p.personality || ""}`).join("\n");
            const subWorld = store.listWorldEntries(pid);
            if (subWorld.length) ctxBlock += "\n\n【世界观】\n" + subWorld.map((w: any) => `- [${w.category}] ${w.name}: ${w.description || ""}`).join("\n");
            subMsgs.push({ role: "system", content: ctxBlock });
          }
          subMsgs.push({ role: "user", content: task });
          const subT0 = Date.now();
          const subResult = await runAgentLoop({
            pid, agentName: target as AgentName, messages: subMsgs,
            depth: depth + 1, runId, delegationLog: state.delegationLog, emit,
          });
          const subDur = Date.now() - subT0;
          let subResult2 = subResult;
          state.delegationLog.push({ to: target, task, result: subResult2, durationMs: subDur });
          // B-3 总编终审 + 返修闭环: 打回 → 同一专家带修改指令重跑一轮 → 再终审 (最多 1 轮)。
          // 以前裁决意见只附在文本末尾就交付, 专家永远不知道自己被打回了 → "审完就没下文"。
          const reworkNorm = async (feedback: string): Promise<string> => {
            const retryMsgs: Array<{ role: string; content: string }> = [...subMsgs];
            if (subResult.trim()) retryMsgs.push({ role: "assistant", content: subResult.slice(0, 2000) });
            retryMsgs.push({ role: "user", content: `【总编终审打回 · 返修指令】\n${feedback}\n\n这次必须真的调用你的工具产出完整成果。严禁只回"我将要/马上开始"这类启动语, 严禁复述计划, 严禁把任务推回给总编。` });
            logInfo(`[终审返修] ${target} 带修改指令重跑 (${task.slice(0, 40)})`);
            const REWORK_BUDGET_MS = Number(process.env.TIANYAN_REWORK_BUDGET_MS) || 120_000;
            const retry = await Promise.race([
              runAgentLoop({ pid, agentName: target as AgentName, messages: retryMsgs, depth: depth + 1, runId, delegationLog: state.delegationLog, emit }),
              new Promise<string>((resolve) => setTimeout(() => resolve(""), REWORK_BUDGET_MS)),
            ]);
            return retry.trim();
          };
          const finalR_norm = await finalReviewWithRework(pid, runId, target as AgentName, task.slice(0, 60), subResult2, emit, reworkNorm, 1);
          if (!finalR_norm.approved) subResult2 = finalR_norm.content + "\n\n[终审裁决: " + finalR_norm.verdict.slice(0, 150) + "]";
          else if (finalR_norm.reworked > 0) subResult2 = finalR_norm.content;
          emit({ type: "delegate_done", from: agentName, to: target as AgentName, task, result: subResult2, durationMs: subDur });
          emit({ type: "sub_answer", agent: target as AgentName, text: subResult2 });
          emit({ type: "sub_agent_done", agent: target as AgentName, result: subResult2, durationMs: subDur });
          // 持久化: 刷新/重连后历史重放能渲染子 agent 卡片 + 结果
          // (sub_agent_start 已在 L2703 前后落库; 这里补 sub_answer + sub_agent_done)
          store.addMessage(pid, "assistant", subResult2, { toolName: "sub_answer", toolCallId: target });
          store.addMessage(pid, "assistant", JSON.stringify({ agent: target, result: subResult2.slice(0, 800), durationMs: subDur }), { toolName: "sub_agent_done", toolCallId: target });
          // 委派收尾轮标记: 强制总编下一轮产出真实汇报正文 (native tool_calls 委派路径同样适用)
          if (agentName === "orchestrator" && depth === 0) state.pendingDelegationReport = true;
          // 子 agent 完成后按数据就绪度自动推进阶段 (防止门禁拦截)
          autoAdvancePhase(pid, emit);
          // 回灌主 Agent 的是【摘要】而非全文 (原文已落库), 保持主 Agent 上下文干净
          const finalNote = finalR_norm.approved ? "" : `终审裁决: 打回 — ${finalR_norm.verdict.slice(0, 200)}`;
          const subSummary = buildDelegationSummary(target, task, subResult2, subDur, finalNote);
          const pushHint = agentName === "orchestrator"
            ? `\n\n[系统指令] 该阶段产出的数据已完成。你现在必须【直接输出】面向用户的中文汇报正文 (总结该专家做了什么、关键结论), 末尾询问是否进入下一阶段。禁止只输出思考、禁止再调用工具、禁止委派下一步。若模型倾向把汇报写进 reasoning, 请把正文放进 content。`
            : "";
          messages.push({ role: "tool", content: subSummary + pushHint, tool_call_id: tc.id });
          emit({ type: "observation", agent: agentName, tool: tc.name, result: subResult2.slice(0, 2000) });
          continue;
        }
        // ===== 只读 agent 检查 =====
        if (isReadonly(agentName) && !isReadonlyTool(tc.name)) {
          const err = `只读Agent (${agentName}) 不能调用写入工具 ${tc.name}`;
          messages.push({ role: "tool", content: JSON.stringify({ error: err }), tool_call_id: tc.id });
          emit({ type: "observation", agent: agentName, tool: tc.name, result: err });
          continue;
        }
        // ===== 普通工具 =====
        const t0 = Date.now();
        const result = await dispatchTool(pid, tc.name, tc.arguments, agentName);
        const durMs = Date.now() - t0;
        store.addRunEvent(runId, "tool_call", { agent: agentName, tool: tc.name, input_: tc.arguments, duration_ms: durMs });
        // 截断工具结果防止 token 溢出
        const truncatedResult = result.length > 4000 ? result.slice(0, 4000) + "\n...(结果已截断)" : result;
        messages.push({ role: "tool", content: truncatedResult, tool_call_id: tc.id });
        emit({ type: "observation", agent: agentName, tool: tc.name, result: result.slice(0, 2000) });
        // 自动保存记忆
        try {
          const sessionId = runId;
          if (tc.name === "manage_character" || tc.name === "add_element") {
            memory.saveSessionMemory(pid, sessionId, "context", tc.name, result.slice(0, 500), "agent");
          }
          // 资料员抓取素材 → scraped 类别 (长文不截断, 供 buildWritingContext 按预算截取注入主笔)
          if (tc.name === "web_fetch" || tc.name === "browser_fetch" || tc.name === "web_search" || tc.name === "browser_search") {
            memory.saveSessionMemory(pid, sessionId, "scraped", tc.name + (tc.arguments && (tc.arguments.url || tc.arguments.query) ? ":" + String(tc.arguments.url || tc.arguments.query).slice(0, 60) : ""), result, "agent");
          }
          if (tc.name === "continue_writing" || tc.name === "ghostwrite" || tc.name === "polish") {
            memory.saveSessionMemory(pid, sessionId, "plot", `chapter_${tc.name}`, result.slice(0, 300), "auto", 0.5);
            // === 强制审查钩子：写作工具执行后自动触发审查 (共享实现) ===
            await enforceReviewAfterWrite(pid, runId, agentName, tc.name, tc.arguments, result, messages, emit);
          }
        } catch { /* ignore */ }
      }
      // 循环继续，LLM 看到 tool 结果后生成下一轮
      continue;
    }

    // ===== 工具调用提取: 原生 tool_calls 优先 (流式/非流式回退产生) =====
    // 若无原生 tool_calls, 降级到文本 JSON 解析旧模式 (agnes 等不支持原生 function calling 的模型)
    // 【修复】旧代码 `let toolCall = extractToolCall(content)` 在非流式回退产生 fbToolCalls 后
    //          仍按 content 文本解析 → content 为空 → toolCall=null → nativeToolCalls 丢失 →
    //          delegate_to_agent 等工具永远不执行 (多 agent 协同"卡住不显示"的根因)
    let toolCall: { tool: string; args: Record<string, unknown> } | null = null;
    if (nativeToolCalls.length === 0) {
      toolCall = extractToolCall(content);
    }

    if (!toolCall) {
      // 安全网: 如果 content 为空但有思考文本, 用思考文本作为回复
      // 委派收尾例外 (症状1修复): 总编刚拿到子agent结果、强制出真实汇报正文的轮次,
      // 若 content 仍空, 用 delegationLog 里子agent真实结果拼确定性汇报, 不把"规划口吻"思考当正文
      let finalContent = content || bestContent;
      if (!finalContent && closingRound && state.delegationLog.length) {
        const last = state.delegationLog[state.delegationLog.length - 1]!;
        finalContent = `✅ 已委派「${last.to}」完成: ${last.task}\n\n【专家执行结果】\n${last.result.slice(0, 800)}${last.result.length > 800 ? "\n...(已截断)" : ""}\n\n以上为该专家的真实执行结果汇总。是否确认进入下一阶段?`;
        logInfo(`[委派收尾兜底] orchestrator content 空, 用 delegationLog[${last.to}] 真实结果生成汇报正文`);
      } else if (!finalContent && thinkingText) {
        finalContent = thinkingText.slice(0, 2000);
      }
      // 收尾轮已消费 (无论是否兜底), 清除标记, 不污染后续轮
      if (closingRound) state.pendingDelegationReport = false;
       if (!finalContent) {
        // 借鉴 DSH dsh-llm-deepseek L1206: stop 终止 + 0 内容块 = 空响应, 当作"失败"重试, 不当"模型沉默"。
        // tianyan 自己的写法: 每次重试前改一下 messages (注入变化提示), 打破"同输入→同空输出"的循环。
        consecutiveEmptyCount++;
        // 空回复拉大间隔 — 仅对【真·空】(无思考/无正文) 才拉;
        // 模型其实出了 reasoning(当正文交付) 不算连接失败, 不能惩罚成"连接不稳定"
        // (AgnesAI 免费档常把正文塞进 reasoning_content, content 空是常态, 拉大间隔会导致流程越来越慢)
        if (!thinkingText.trim()) {
          retryIdx = Math.min(retryIdx + 1, RETRY_INTERVALS.length - 1);
        }
        // 每次空回复都往 messages 注入一条【变化的】系统提示 (带次数), 让下一轮 LLM 输入不同 → 不再循环
        messages.push({
          role: "user",
          content: `[系统: 上一轮你的回复内容为空 (连续第 ${consecutiveEmptyCount} 次)。请重新回复——要么直接输出可见文本, 要么调用带具体参数的工具。若确实无法执行, 请用一句话向用户说明原因, 不要返回空内容。]`,
        });
        // 借鉴 Hermes empty_response_guard: "确定性空" 识别 —
        // 连续 2 次空 (同一模型) 且流式通道拿不到内容 → 后续不再空转流式, 直接走非流式回退
        if (consecutiveEmptyCount >= 2) {
          logWarn("[确定性空→非流式回退] agent="+agentName+" model="+(agentModel?agentModel.model:"?")+" 连续"+consecutiveEmptyCount+"次空, 流式放弃, 改非流式");
          emit({ type: "observation", agent: agentName, tool: "fallback_nonstream", result: "流式返回连续为空, 回退到非流式调用..." });
          try {
            const agentTools = getToolDefinitions(agentName);
            const fallbackResp = await chat(messages, agentModel, { tools: agentTools });
            // 非流式回退的 usage 也累加进 token 统计 (流式 0-chunk 走回退时, 否则 runs.total_tokens 恒 0)
            // 非流式回退 usage 也累加 (LLMResponse.usage 为 camelCase 结构)
            {
              const fu = (fallbackResp as unknown as { usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number } }).usage;
              if (fu) {
                const t = fu.totalTokens || (fu.promptTokens || 0) + (fu.completionTokens || 0) || 0;
                tokenAccum.value += t;
                if (state.tokenAccumulator) state.tokenAccumulator.value += t;
              }
            }
            // === 改2 (核心): 非流式拿到内容后, 撤回刚注入的空回复提示 (避免污染上下文),
            //      然后【直接 fall-through 到下方 normal 处理】, 不再 continue 回主循环重走流式。
            //      旧代码 `continue` 会让下一轮又走流式 → 又空 → 死循环 (这就是"卡住不出内容"的根因)。
            const fbContent = (fallbackResp.content || "").trim();
            const fbToolCalls: ToolCall[] = fallbackResp.toolCalls || [];
            if (fbContent || (fallbackResp as unknown as { reasoningContent?: string }).reasoningContent) {
              messages.pop(); // 撤回刚注入的 "[系统: 上一轮内容为空]" 提示
              fullContent = fbContent;
              // reasoning 非流式兜底: content 空但模型给了 reasoning_content → 当正文交付 + 思考面板填充
              const fbReasoning = (fallbackResp as unknown as { reasoningContent?: string }).reasoningContent || "";
              if (!fbContent && fbReasoning) {
                fullContent = fbReasoning;
                content = fbReasoning;
                bestContent = fbReasoning;
                logInfo("[非流式reasoning当正文] agent="+agentName+" reasoning "+fbReasoning.length+" 字当正文交付");
              }
              consecutiveEmptyCount = 0;
              // 不再 continue — 让本轮用非流式结果走 normal 路径 (存消息/继续循环), 不重走流式
              // === 非流式回退补思考面板 (路线A): 回退路径下 thinkDone 一直 false, 流式分支的 think 事件全被跳过 ===
              //  只用真实模型输出 fbReasoning (模型真推理); 没有 reasoning 就静默跳过, 不合成假分析
              if (!thinkDone && fbReasoning.trim()) {
                emit({ type: "think_start", agent: agentName, round });
                emit({ type: "think_token", agent: agentName, text: fbReasoning });
                emit({ type: "think_end", agent: agentName, feasible: true, reason: "非流式回退完成(真实reasoning)", plan: [], missing: "" });
                thinkingText = fbReasoning; // 真实推理落库, 切会话后思考面板仍能恢复
              }
            } else if (fbToolCalls.length > 0) {
              nativeToolCalls = fbToolCalls;
              consecutiveEmptyCount = 0;
              // tool_calls 路径: 撤回提示, 走下方 toolCall 处理
              messages.pop();
              // 路线A: 非流式回退 tool_calls 路径 — 不合成假思考, 诚实标注真实工具决策
              if (!thinkDone) {
                const honestFb = `模型本轮选择调用工具: ${fbToolCalls.map(t => t.name).join(", ")} (非流式回退, 未开启 reasoning 通道, 此为真实工具决策映射, 非合成分析)`;
                emit({ type: "think_start", agent: agentName, round });
                emit({ type: "think_token", agent: agentName, text: honestFb });
                emit({ type: "think_end", agent: agentName, feasible: true, reason: "非流式回退·工具决策(真实映射)", plan: [], missing: "" });
                thinkingText = honestFb;
              }
            } else {
              // 非流式也空 → 继续空回复计数 (走下方 >=5 放弃 或 继续重试)
            }
          } catch (fbErr) {
            logError("[非流式回退失败] agent="+agentName+" model="+(agentModel?agentModel.model:"?")+" err="+(fbErr as Error).message);
            emit({ type: "observation", agent: agentName, tool: "fallback_nonstream", result: `非流式回退也失败: ${(fbErr as Error).message}` });
          }
        }
        // 超过3次空回复 (非流式也没拿到内容) → 借鉴 Hermes empty_response_guard 的 fallback 阶梯:
        // 当前模型反复空 = 该模型不适合, 自动切到候选模型重试 (agnes-3.0 反复空 → agnes-2.5 直接出正文)
        if (consecutiveEmptyCount >= 3) {          const s2 = getSettings();
          const candidates = s2.models.filter((m) => m.model !== agentModel.model && !modelFallbackUsed.includes(m.model));
          if (candidates.length > 0) {
            modelFallbackUsed.push(agentModel.model);
            const nextModel = candidates[0];
            agentModel = nextModel;
            consecutiveEmptyCount = 0; // 新模型重新计数
            // 空回复也算"连接不理想", 自适应间隔拉大 (封顶)
            retryIdx = Math.min(retryIdx + 1, RETRY_INTERVALS.length - 1);
            logWarn("[模型fallback] agent="+agentName+" "+modelFallbackUsed[modelFallbackUsed.length-1]+" 连续空, 切换到 "+nextModel.model+" 重试 (间隔档 "+retryIdx+" → "+(RETRY_INTERVALS[retryIdx]/1000)+"s)");
            emit({ type: "observation", agent: agentName, tool: "model_fallback", result: `「${modelFallbackUsed[modelFallbackUsed.length-1]}」连续空响应, 自动切换到「${nextModel.model}」重试...` });
            continue;
          }
        }
        // 所有候选模型都试过 (或 5 次空回复) → 放弃
        if (consecutiveEmptyCount >= 5 || (consecutiveEmptyCount >= 3 && modelFallbackUsed.length >= 2)) {
          const giveUpMsg = "LLM 连续返回空内容 (已尝试 " + modelFallbackUsed.join(" → ") + " → 当前模型), 已停止。请检查模型的流式兼容性或手动切换其他模型。";
          logError("[空回复放弃] agent="+agentName+" pid="+pid+" 尝试过: ["+modelFallbackUsed.join(",")+"] 当前="+(agentModel?agentModel.model:"?")+" run 终止", {runId});
          emit({ type: "error", message: giveUpMsg });
          store.addRunEvent(runId, "error", { error: giveUpMsg });
          store.addRunTokens(runId, tokenAccum.value);
          store.finishRun(runId, "error");
          clearInterval(heartbeatTimer);
          return giveUpMsg;
        }
        emit({ type: "observation", agent: agentName, tool: "empty_response", result: `LLM 返回空内容, 已注入重试提示, 重试中... (${consecutiveEmptyCount}/5)` });
        continue;
      }
      // 存储最终回答
      store.addMessage(pid, "assistant", finalContent);
      store.addRunEvent(runId, "end", { agent: agentName, output: finalContent.slice(0, 500) });
      store.addRunTokens(runId, tokenAccum.value);
      store.finishRun(runId, "done");
      clearInterval(heartbeatTimer);
      return finalContent;
    }

    const { tool: toolName, args: toolArgs } = toolCall;
    emit({ type: "step", agent: agentName, tool: toolName, args: toolArgs });

    // 循环检测
    const key = `${toolName}:${JSON.stringify(toolArgs)}`;
    loopDetect[key] = (loopDetect[key] || 0) + 1;
    if (loopDetect[key] >= s.loopDetectCount) {
      const msg = `检测到循环: ${toolName} 已连续调用 ${s.loopDetectCount} 次`;
      emit({ type: "error", message: msg });
      break;
    }

    // 委派: 走子 agent
    if (toolName === "delegate_to_agent") {
      // 子agent禁止委派
      if (depth > 0) {
        const subErr = "子agent不能使用delegate_to_agent";
        messages.push({ role: "user", content: `[工具错误]\n${subErr}` });
        emit({ type: "observation", agent: agentName, tool: toolName, result: subErr });
        continue;
      }
      const target = String(toolArgs.agent || toolArgs.target || "");
      const task = String(toolArgs.task || toolArgs.prompt || "");
      if (!isValid(target) || target === DEFAULT_AGENT) {
        const err = `无效委派目标: ${target}`;
        messages.push({ role: "user", content: `[工具错误]\n${err}` });
                    emit({ type: "observation", agent: agentName, tool: toolName, result: err });
        continue;
      }
      // 阶段确认制: orchestrator 一次 run 只委派一次
      if (agentName === "orchestrator" && depth === 0 && state.orchestratorDelegated) {
        const guardErr = "【阶段确认制拦截】你已经完成了一个阶段的委派。请先把当前结果整理成面向用户的汇报，询问用户是否进入下一阶段，然后等待用户回复后再继续。绝对不要继续委派。";
        messages.push({ role: "user", content: `[拦截]\n${guardErr}` });
        emit({ type: "observation", agent: agentName, tool: toolName, result: guardErr });
        continue;
      }
      state.orchestratorDelegated = true;
      if (depth >= getMaxDelegateDepth()) {
        const err = `已达最大委派深度 ${getMaxDelegateDepth()}`;
        messages.push({ role: "user", content: `[委派错误]\n${err}` });
                    continue;
      }
      emit({ type: "delegate", from: agentName, to: target as AgentName, task, depth: depth + 1 });
      emit({ type: "sub_agent_start", agent: target as AgentName, task, depth: depth + 1 });
      // 持久化: 刷新/断线重连后前端 loadMessages 仍能渲染出子 agent 卡片
      // (缺这条历史重放时 findSubBubbleByAgent 找不到卡片, sub_answer 结果就丢了 — 用户看不到执行结果)
      store.addMessage(pid, "assistant", JSON.stringify({ agent: target, task }), { toolName: "sub_agent_start", toolCallId: target });

      const subMeta = getMeta(target);
      const proj = store.getProject(pid);
      const subSkillPrompts = getAgentSkillPrompts(target);
      const subSkillBlock = subSkillPrompts.length ? "\n\n" + subSkillPrompts.join("\n\n") : "";
      const subMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: getAgentPrompt(target) + subSkillBlock + "\n\n可用工具: " + AGENT_TOOLS[target as AgentName].join(", ") },
      ];
      if (proj) {
        let ctxBlock = `项目: ${proj.name} | 类型: ${proj.genre} | 文风: ${proj.style}\n核心设定: ${proj.premise}`;
        // 注入角色档案
        const subProfiles = store.listCharacterProfiles(pid);
        if (subProfiles.length) {
          ctxBlock += "\n\n【角色档案】\n" + subProfiles.map(p => `- ${p.name}(${p.role || "?"}): ${p.personality || ""} | 说话: ${p.speechStyle || ""}`).join("\n");
        }
        // 注入世界观
        const subWorld = store.listWorldEntries(pid);
        if (subWorld.length) {
          ctxBlock += "\n\n【世界观】\n" + subWorld.map(w => `- [${w.category}] ${w.name}: ${w.description || ""}`).join("\n");
        }
        // 注入章节大纲
        const subChapters = store.listChapters(pid);
        const nextCh = subChapters.find(c => c.status === "draft" || c.status === "writing");
        if (nextCh?.outline) {
          ctxBlock += `\n\n【当前章节大纲】${nextCh.title}: ${nextCh.outline}`;
        }
        subMessages.push({ role: "system", content: ctxBlock });
      }
      subMessages.push({ role: "user", content: task });

      const t0 = Date.now();
      const subResult = await runAgentLoop({
        pid, agentName: target as AgentName, messages: subMessages,
        depth: depth + 1, runId, delegationLog: state.delegationLog, emit,
      });
      const durMs = Date.now() - t0;
      autoAdvancePhase(pid, emit);
      let subResult2 = subResult;
      const isOrchClose = agentName === "orchestrator" && depth === 0;
      const legacyHint = isOrchClose
        ? `\n\n[系统指令] 该阶段产出的数据已完成。你现在必须【直接输出】面向用户的中文汇报正文 (总结该专家做了什么、关键结论), 末尾询问是否进入下一阶段。禁止只输出思考、禁止再调用工具、禁止委派下一步。若模型倾向把汇报写进 reasoning, 请把正文放进 content。`
        : "";
      // B-3 总编终审 + 返修闭环: 打回 → 同一专家带修改指令重跑一轮 → 再终审 (最多 1 轮)
      const reworkLegacy = async (feedback: string): Promise<string> => {
        const retryMsgs: Array<{ role: string; content: string }> = [...subMessages];
        if (subResult.trim()) retryMsgs.push({ role: "assistant", content: subResult.slice(0, 2000) });
        retryMsgs.push({ role: "user", content: `【总编终审打回 · 返修指令】\n${feedback}\n\n这次必须真的调用你的工具产出完整成果。严禁只回"我将要/马上开始"这类启动语, 严禁复述计划, 严禁把任务推回给总编。` });
        logInfo(`[终审返修] ${target} 带修改指令重跑 (${task.slice(0, 40)})`);
        const REWORK_BUDGET_MS = Number(process.env.TIANYAN_REWORK_BUDGET_MS) || 120_000;
        const retry = await Promise.race([
          runAgentLoop({ pid, agentName: target as AgentName, messages: retryMsgs, depth: depth + 1, runId, delegationLog: state.delegationLog, emit }),
          new Promise<string>((resolve) => setTimeout(() => resolve(""), REWORK_BUDGET_MS)),
        ]);
        return retry.trim();
      };
      const finalR_legacy = await finalReviewWithRework(pid, runId, target as AgentName, task.slice(0, 60), subResult2, emit, reworkLegacy, 1);
      if (!finalR_legacy.approved) subResult2 = finalR_legacy.content + "\n\n[终审裁决: " + finalR_legacy.verdict.slice(0, 150) + "]";
      else if (finalR_legacy.reworked > 0) subResult2 = finalR_legacy.content;
      state.delegationLog.push({ to: target, task, result: subResult2, durationMs: durMs });
      emit({ type: "delegate_done", from: agentName, to: target as AgentName, task, result: subResult2, durationMs: durMs });
      emit({ type: "sub_answer", agent: target as AgentName, text: subResult2 });
      emit({ type: "sub_agent_done", agent: target as AgentName, result: subResult2, durationMs: durMs });
      // 持久化: 刷新/重连后历史重放能渲染子 agent 卡片 + 结果
      // (sub_agent_start 已在 L2931 落库; 这里补 sub_answer + sub_agent_done)
      store.addMessage(pid, "assistant", subResult2, { toolName: "sub_answer", toolCallId: target });
      store.addMessage(pid, "assistant", JSON.stringify({ agent: target, result: subResult2.slice(0, 800), durationMs: durMs }), { toolName: "sub_agent_done", toolCallId: target });
      // 委派收尾轮标记: 强制总编下一轮产出真实汇报正文, 并让 reasoning-as-body 提升禁用该轮
      if (isOrchClose) state.pendingDelegationReport = true;
      // 回灌主 Agent 的是【摘要】而非全文 (原文已落库), 保持主 Agent 上下文干净
      const legacyNote = finalR_legacy.approved ? "" : `终审裁决: 打回 — ${finalR_legacy.verdict.slice(0, 200)}`;
      messages.push({ role: "user", content: buildDelegationSummary(target, task, subResult2, durMs, legacyNote) + legacyHint });
      continue;
    }

    // === 工作流阶段检查（根据模式决定是否强制执行） ===
    const workflowMode = getSettings().workflowMode || "state_machine";
    const projState = store.getProjectState(pid);
    const currentPhase = projState.currentPhase as import("../workflow.js").Phase;
    
    if (workflowMode === "state_machine") {
      // 状态机模式：强制阶段门禁检查
      const toolCheck = isToolAllowedInPhase(toolName, currentPhase);
      if (!toolCheck.allowed) {
        const errMsg = JSON.stringify({ error: `工作流限制: ${toolCheck.reason}` });
                    messages.push({ role: "user", content: `[工具错误]\n${errMsg}` });
        emit({ type: "observation", agent: agentName, tool: toolName, result: errMsg });
        continue;
      }
    } else {
      // CrewAI模式：灵活调度，跳过阶段门禁
      emit({ type: "observation", agent: agentName, tool: toolName, result: `[CrewAI模式] 跳过阶段检查，允许调用 ${toolName}` });
    }

    // 普通工具
    const t0 = Date.now();
    const result = await dispatchTool(pid, toolName, toolArgs, agentName);
    const durMs = Date.now() - t0;
    store.addRunEvent(runId, "tool_call", { agent: agentName, tool: toolName, input_: toolArgs, duration_ms: durMs });
    messages.push({ role: "user", content: `[工具 ${toolName} 返回结果]\n${result}` });
    emit({ type: "observation", agent: agentName, tool: toolName, result: result.slice(0, 2000) });

    // === FIX 1: 自动保存记忆 ===
    try {
      const sessionId = runId; // 用 runId 作为 sessionId
      if (toolName === "manage_character" || toolName === "add_element") {
        memory.saveSessionMemory(pid, sessionId, "context", toolName, result.slice(0, 500), "agent");
      }
      if (toolName === "continue_writing" || toolName === "ghostwrite" || toolName === "polish") {
        memory.saveSessionMemory(pid, sessionId, "plot", `chapter_${toolName}`, result.slice(0, 300), "auto", 0.5);
        // === 强制审查钩子：写作工具执行后自动触发审查 (共享实现) ===
        await enforceReviewAfterWrite(pid, runId, agentName, toolName, toolArgs, result, messages, emit);
      }
      if (toolName === "review_chapter" || toolName === "quality_check") {
        memory.saveSessionMemory(pid, sessionId, "feedback", toolName, result.slice(0, 500), "agent");
      }
      // 用户偏好的长期记忆
      if (toolName === "query_project") {
        memory.saveLongTermMemory(pid, "context", "项目概况", result.slice(0, 500), "auto", 3);
      }
    } catch { /* 记忆保存失败不影响主流程 */ }
  }
  } finally {
    clearInterval(heartbeatTimer);
  }

  // 步数耗尽 → 优雅收尾 (对齐 OpenCode MAX_STEPS_PROMPT: 禁用工具, 让模型出总结, 不硬停)
  if (step >= agentMaxSteps || round > agentMaxTurns) {
    try {
      logInfo(`[优雅收尾] ${agentName} 达到步数上限 (${agentMaxSteps}步/${agentMaxTurns}轮), 让模型总结进展+剩余工作`);
      const MAX_STEPS_PROMPT = `【系统指令】你已达到本轮最大步数上限, 工具调用已禁用。请仅用文字总结:
1. 目前完成了哪些工作
2. 还有哪些工作没完成
3. 建议下一步怎么做
简洁列出即可, 不要再调用任何工具。`;
      const wrapMessages: Array<{ role: string; content: string }> = [...messages];
      wrapMessages.push({ role: "user", content: MAX_STEPS_PROMPT });
      const wrapResp = await chat(wrapMessages, undefined, { temperature: 0.2, maxTokens: 500, tools: [] });
      const wrapText = wrapResp?.content?.trim() || "已达本轮步数上限, 任务未完全完成。";
      emit({ type: "observation", agent: agentName, tool: "max_steps_wrapup", result: wrapText.slice(0, 500) });
      // 总结同时作为可见回答输出 (前端正文区显示, 用户看得到"完成了什么/剩什么/下一步")
      emit({ type: "answer_start", agent: agentName });
      emit({ type: "token", agent: agentName, content: wrapText });
      emit({ type: "answer_end", agent: agentName });
      store.addRunEvent(runId, "end", { agent: agentName, output: "达到最大步数, 模型总结: " + wrapText.slice(0, 200) });
      store.addRunTokens(runId, tokenAccum.value);
      store.finishRun(runId, "done");
      return wrapText;
    } catch (e) {
      // 优雅收尾本身 429/失败 → 不能静默卡死 (上一轮引入的回归):
      // 发诚实告知 (token) + 落库 end, 让前端拿到正文+收尾信号, 不再悬挂
      const err = (e as Error).message?.slice(0, 80) || "未知错误";
      logWarn(`[优雅收尾] ${agentName} 总结调用失败 (429/限流?), 发诚实告知不卡死: ${err}`);
      const honestNote = `⚠️ 已达本轮步数上限 (${agentMaxSteps}步/${agentMaxTurns}轮), 且总结生成失败 (模型: ${err})。以下为已执行工具的真实结果, 任务未完全完成。`;
      emit({ type: "observation", agent: agentName, tool: "max_steps_wrapup_failed", result: honestNote });
      emit({ type: "answer_start", agent: agentName });
      emit({ type: "token", agent: agentName, content: honestNote });
      emit({ type: "answer_end", agent: agentName });
      store.addRunEvent(runId, "end", { agent: agentName, output: "达到最大步数, 总结调用失败: " + err });
      store.addRunTokens(runId, tokenAccum.value);
      store.finishRun(runId, "done");
      return honestNote;
    }
  }
  store.addRunEvent(runId, "end", { agent: agentName, output: "达到最大步骤数" });
  store.addRunTokens(runId, tokenAccum.value);
  store.finishRun(runId, "done");
  return "达到最大步骤数, 请继续指示。";
}

// ===== 主入口: 构建上下文 + 启动循环 =====

// ===== Prefix Cache 统计 (全部调用共享一个累加器) =====
export interface CacheStats {
  promptTokens: number;      // 总 prompt tokens
  cachedTokens: number;      // 命中缓存的 tokens
  readTokens: number;        // Anthropic cache read
  creationTokens: number;    // Anthropic cache creation
  calls: number;             // LLM 调用次数
}

export function mergeCacheStats(t: CacheStats, u: { promptTokens?: number; cachedTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined): void {
  if (!u) return;
  t.calls++;
  t.promptTokens += u.promptTokens || 0;
  t.cachedTokens += u.cachedTokens || 0;
  t.readTokens += u.cacheReadTokens || 0;
  t.creationTokens += u.cacheCreationTokens || 0;
}

export function cacheRate(t: CacheStats): number {
  if (t.promptTokens <= 0) return 0;
  return Math.min(100, Math.round((t.cachedTokens + t.readTokens) / t.promptTokens * 100));
}

export async function run(
  pid: string,
  userInput: string,
  agentName: AgentName = DEFAULT_AGENT,
): Promise<{ events: SSEEvent[]; result: string }> {
  const s = getSettings();
  const runId = store.createRun(pid, userInput, agentName);
  store.addMessage(pid, "user", userInput);

  const emit = (evt: SSEEvent) => { /* will be replaced by caller */ };

  // 构建 agent 上下文
  const proj = store.getProject(pid);
  const memoryCtx = memory.getMemoryContext(pid);
  const messages: Array<{ role: string; content: string }> = [];

  if (proj) {
    // 风格锁定标签 — 每轮注入, 强制模型不偏离类型
    const genreLock = proj.genre ? `【风格锁定】本项目类型为「${proj.genre}」, 全程禁止偏离。\n禁止出现其他类型的元素(如仙侠项目禁止出现科幻/现代/都市元素)。\n所有角色、设定、战斗方式、世界观必须严格符合「${proj.genre}」类型。` : "";
    messages.push({
      role: "system",
      content: `当前项目: ${proj.name}\n频道: ${proj.audience || "未指定"}\n类型: ${proj.genre}\n文风: ${proj.style}\n核心设定: ${proj.premise}\n${genreLock}`,
    });
  }
  if (memoryCtx) {
    messages.push({ role: "system", content: memoryCtx });
  }

  const meta = getMeta(agentName);
  messages.push({
    role: "system",
    content: getAgentPrompt(agentName) + "\n\n可用工具: " + AGENT_TOOLS[agentName].join(", ") + "\n调用工具时优先使用 function calling (native tool_calls)。\n如果模型不支持 function calling，输出一行 JSON: {\"tool\": \"工具名\", \"args\": {...}}。\n否则直接回复。",
  });
  messages.push({ role: "user", content: userInput });

  // === FIX 1: 保存用户意图到短期记忆 ===
  try {
    const userSid = randomBytes(6).toString("hex");
    memory.saveSessionMemory(pid, userSid, "user_intent", userInput.slice(0, 100), userInput.slice(0, 500), "user", 1.0);
  } catch { /* ignore */ }

  const events: SSEEvent[] = [];
  const cacheStats: CacheStats = { promptTokens: 0, cachedTokens: 0, readTokens: 0, creationTokens: 0, calls: 0 };
  const collectEmit = (evt: SSEEvent) => {
    // 拦截 usage 事件累计缓存统计
    if (evt.type === "usage" && "usage" in evt) {
      const u = (evt as unknown as { usage: LLMResponse["usage"] }).usage;
      mergeCacheStats(cacheStats, u);
    }
    events.push(evt);
  };
  events.push({ type: "start", agent: agentName, input: userInput.slice(0, 200) });

  const sharedSteps = { value: 0 };
  let result = "";
  try {
    result = await runAgentLoop({
      pid, agentName, messages, depth: 0, runId,
      delegationLog: [], emit: collectEmit, sharedSteps,
    });
    events.push({ type: "done", agent: agentName, steps: sharedSteps.value, stats: store.stats(pid), runId });
    // 汇总缓存统计事件 (前端设置面板显示命中率)
    events.push({
      type: "cache_stats", agent: agentName,
      promptTokens: cacheStats.promptTokens,
      cachedTokens: cacheStats.cachedTokens,
      rate: cacheRate(cacheStats),
      calls: cacheStats.calls,
    });
  } catch (e) {
    events.push({ type: "error", message: friendlyError(e as Error, s.defaultModel) });
  }
  return { events, result };
}
