// context/inject.ts — 小说场景上下文注入 (借鉴 DSH compaction 的"远摘要+近全文"思想, 用天衍自己的 TS 实现)
//
// 设计 (写第 N 章时, 模型手里的上下文分三层):
//   常驻层:  文风/核心设定/本章大纲 — 小, 永远在
//   相关层:  相关角色档案 + 相关伏笔 (按本章筛) + 角色滚动状态 (character_states)
//   前文层:  远章节 = 章节摘要 (每章一条), 近 2 章 = 结尾原文 (接写需要近处细节)
//   素材层:  资料员抓的对标素材 (scraped 类短期记忆), 按预算截取头部+关键词段
//
// 借鉴 DSH dsh-compaction 的点: "老历史压成摘要, 最近保留原样, 摘要假装一直都在"
// 不照搬 DSH 代码, 全部用天衍 store/memory 自己的数据写。

import * as store from "../store.js";
import { getSessionMemories } from "../memory/index.js";

export interface WritingContextOptions {
  /** 当前要写/续写的章节号 (用于确定"远"和"近"的分界) */
  currentIdx: number;
  /** 前文全文保留多少字 (近 2 章结尾) */
  recentTailChars?: number;
  /** 角色状态最多注入几条 */
  maxStates?: number;
  /** 伏笔最多注入多少条 (未回收的优先) */
  maxForeshadows?: number;
  /** 素材注入预算 (字, 默认 20000) */
  materialBudget?: number;
  /** 素材截取策略: head=简单取前N字, key=头部+关键词命中段 (仿 DSH pruner) */
  materialMode?: "head" | "key";
  /** session id (素材层从短期记忆拉) */
  sessionId?: string;
  /** 章节正文获取 (默认查 store, 便于测试/自定义注入) */
  getChapterContent?: (pid: string, idx: number) => string;
}

// 素材关键词 (写小说最该看的: 钩子/节奏/人设/文风样本)
const MATERIAL_KEYWORDS = ["钩子", "开篇", "节奏", "爽点", "金手指", "人设", "文风", "转折", "悬念", "打脸", "逆袭", "伏笔"];

function pickMaterial(text: string, budget: number, mode: "head" | "key"): string {
  if (text.length <= budget) return text;
  if (mode === "head") return text.slice(0, budget);
  // key 模式: 头部 40% + 关键词命中段, 凑满预算
  const headLen = Math.floor(budget * 0.4);
  let out = text.slice(0, headLen);
  const paraRe = /[\n。！？](.){10,300}/g;
  for (const m of text.matchAll(paraRe)) {
    const para = m[0];
    if (!MATERIAL_KEYWORDS.some((k) => para.includes(k))) continue;
    if ((out + para).length > budget) break;
    out += para;
  }
  return out.slice(0, budget);
}

/** 生成"远摘要+近全文+相关层+素材层"的完整写作上下文块 */
export function buildWritingContext(pid: string, opts: WritingContextOptions): string {
  const {
    currentIdx,
    recentTailChars = 3000,
    maxStates = 10,
    maxForeshadows = 10,
    materialBudget = 20000,
    materialMode = "key",
    sessionId,
    getChapterContent,
  } = opts;

  const parts: string[] = [];

  // 1. 常驻层: 项目设定 + 文风
  const proj = store.getProject(pid);
  if (proj) {
    parts.push(
      `【项目】${proj.name} | 类型: ${proj.genre || "?"} | 文风: ${proj.style || "?"}\n核心设定: ${proj.premise || "(无)"}`,
    );
  }

  // 2. 相关层: 角色档案
  const profiles = store.listCharacterProfiles(pid);
  if (profiles.length) {
    parts.push(
      "【角色档案】\n" +
        profiles.map((p) => `- ${p.name}(${p.role || "?"}): ${p.personality || ""} | 说话风格: ${p.speechStyle || ""} | 动机: ${p.motivation || ""}`).join("\n"),
    );
  }

  // 3. 相关层: 角色滚动状态 (每章写完更新, 保证人物状态不漂移)
  const states = store.listCharacterStates(pid).slice(0, maxStates);
  if (states.length) {
    parts.push(
      "【角色当前状态】\n" +
        states.map((s) => `- ${String(s.character_name)}: ${String(s.current_state)} (截至第 ${String(s.latest_chapter)} 章)`).join("\n"),
    );
  }

  // 4. 相关层: 未回收伏笔 (最优先)
  const foreshadows = store.listForeshadowings2(pid);
  const open = foreshadows.filter((f) => String(f.status) !== "recovered").slice(0, maxForeshadows);
  if (open.length) {
    parts.push(
      "【未回收伏笔 (写作时留意)】\n" +
        open.map((f) => `- ${String(f.name)} (第${String(f.planted_chapter)}章种): ${String(f.content || "").slice(0, 120)}`).join("\n"),
    );
  }

  // 5. 前文层: 远章节摘要 (第 1 ~ currentIdx-3 章, 每章一条)
  const farEnd = Math.max(0, currentIdx - 3); // 近 3 章保留全文
  const summaries = store.listChapterSummaries(pid, farEnd + 1); // idx < farEnd+1
  if (summaries.length) {
    const lines = summaries.map((s) => `第${s.chapter_idx}章摘要: ${s.summary}${s.key_events ? " | 事件: " + s.key_events : ""}`);
    parts.push("【前情提要 (远章节)】\n" + lines.join("\n"));
  }

  // 6. 前文层: 近 2 章结尾原文 (接写最需要近处细节)
  const fetchContent =
    getChapterContent ??
    ((pidArg: string, idx: number): string => {
      const chs = store.listChapters(pidArg);
      const ch = chs.find((c) => c.idx === idx);
      return ch?.content || "";
    });
  const recentBlocks: string[] = [];
  for (let i = Math.max(1, currentIdx - 2); i < currentIdx; i++) {
    const c = fetchContent(pid, i);
    if (c) recentBlocks.push(`第${i}章结尾:\n${c.slice(-recentTailChars)}`);
  }
  if (recentBlocks.length) parts.push(recentBlocks.join("\n\n"));

  // 7. 素材层: 资料员抓的对标素材 (scraped 类短期记忆, 按预算截取)
  if (sessionId) {
    const scraped = getSessionMemories(pid, sessionId, "scraped", 5);
    const joined = scraped.map((m) => `[${m.topic}]\n${m.content}`).join("\n\n---\n\n");
    if (joined) {
      parts.push("【对标素材 (资料员截取, 借鉴手法不抄袭)】\n" + pickMaterial(joined, materialBudget, materialMode));
    }
  }

  return parts.join("\n\n");
}

/** 生成章节摘要 (写后调用), LLM 失败时回退确定性抽取 (前 150 字) */
export async function summarizeChapter(
  pid: string,
  chapterId: string,
  chapterIdx: number,
  content: string,
  chat: (msgs: Array<{ role: string; content: string }>) => Promise<{ content: string }>,
): Promise<string> {
  const fallback = content.replace(/\n+/g, " ").slice(0, 150) + "…";
  try {
    const resp = await chat([
      {
        role: "system",
        content:
          "你是小说编辑。把本章压缩成 1-3 句摘要: 发生了什么、谁的状态变了、留了什么伏笔。只输出摘要文本, 不要解释。",
      },
      { role: "user", content: `第${chapterIdx}章正文:\n${content.slice(0, 12000)}` },
    ]);
    const s = (resp.content || "").trim();
    return s && s.length > 4 ? s : fallback;
  } catch {
    return fallback;
  }
}

/** 写后自动更新角色当前状态 (防人物漂移): 读角色档案 + 本章正文, LLM 生成各角色"截至本章"的状态 */
export async function updateCharacterStatesAfterChapter(
  pid: string,
  chapterIdx: number,
  content: string,
  chat: (msgs: Array<{ role: string; content: string }>) => Promise<{ content: string }>,
): Promise<void> {
  const profiles = store.listCharacterProfiles(pid);
  if (!profiles.length) return;
  const names = profiles.map((p) => String(p.name)).filter(Boolean);
  try {
    const resp = await chat([
      {
        role: "system",
        content:
          "你是小说编辑。根据本章正文, 用 JSON 数组输出每个角色的当前状态 (截至本章结束)。" +
          `每个对象: {"name":"角色名","state":"1句话状态: 心理/掌握的东西/关系变化"}。` +
          `只输出 JSON 数组, 不要解释。角色名单: ${names.join(", ")}。`,
      },
      { role: "user", content: `第${chapterIdx}章正文:\n${content.slice(0, 12000)}` },
    ]);
    const raw = (resp.content || "").trim();
    // 容错解析: 找 JSON 数组段
    let arr: Array<{ name?: unknown; state?: unknown }> = [];
    try {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) arr = JSON.parse(m[0]);
    } catch {
      return; // 解析失败不阻断, 保留旧状态
    }
    for (const item of arr) {
      const name = String(item?.name || "");
      const state = String(item?.state || "").trim();
      if (!name || !state) continue;
      try {
        store.upsertCharacterState(pid, name, state, chapterIdx);
      } catch {
        /* 单条失败不影响其余 */
      }
    }
  } catch {
    /* LLM 失败保留旧状态, 不阻断写作流程 */
  }
}
