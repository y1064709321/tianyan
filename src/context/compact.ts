// context/compact.ts — 上下文预算 + 自动压缩 (128k 窗口)
//
// 为什么需要: 长篇创作一聊就是几十轮, 每轮还带工具结果/素材片段。全量塞进模型必然爆窗口
// (爆了就是 400 报错, 或者模型开始"忘记前面说过什么")。这里做两件事:
//   1) 按 token 预算装上下文 (默认 128k 窗口);
//   2) 超预算时把"早期对话"压成一份滚动摘要 (可累积), 最近对话保持原文。
//
// 设计取舍:
//   · 摘要必须**持久化**: 每次 run 重新算一遍摘要 = 每轮多烧一次 LLM 调用, 且摘要会漂移。
//     存在 context_summaries 表里, upto_id 记录"已经压到哪条消息", 下一轮只压增量。
//   · 摘要必须**可核对**: 摘要里写清"早期 N 条已压缩", 并提醒模型细节缺失时去查工具, 不许编。
//   · LLM 摘要失败不能卡住对话: 退化成确定性摘要 (用户原话摘录), 保证永远有东西可用。

import { chat } from "../llm.js";
import { getSettings } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import * as store from "../store.js";

export interface ChatMsg {
  role: string;
  content: string;
  /** 消息 id (用于滚动摘要定位"压到哪条了") */
  id?: string;
}

export interface CompactInfo {
  compacted: boolean;
  window: number;
  beforeTokens: number;
  afterTokens: number;
  kept: number;
  dropped: number;
  summaryChars: number;
}

/**
 * 粗估 token。中文 1 字 ≈ 1 token, 英文/符号 ≈ 4 字符 1 token。
 * 宁可高估 (少塞点) 也不要低估 (爆窗口 → 400 → 整轮白跑)。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // CJK 统一表意文字 / 中文标点 / 全角符号
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

export function estimateMessages(messages: ChatMsg[]): number {
  let n = 0;
  for (const m of messages) n += estimateTokens(m.content || "") + 4; // +4: 角色/分隔符等结构开销
  return n;
}

/** 把消息压成要点 (合并已有摘要 → 滚动摘要) */
async function summarize(msgs: ChatMsg[], prevSummary: string): Promise<string> {
  // 摘要调用本身也要控预算: 一次压 200 条 × 1200 字 = 24 万字, 会把摘要调用自己撑爆。
  // 按条数均摊每条可用字数 (最少 120 字), 整体再给一个硬上限。
  const MAX_IN = 24_000;
  const perMsg = Math.max(120, Math.min(1200, Math.floor(MAX_IN / Math.max(1, msgs.length))));
  let convo = msgs
    .map((m) => `${m.role === "user" ? "用户" : "天衍"}: ${(m.content || "").replace(/\s+/g, " ").slice(0, perMsg)}`)
    .join("\n");
  if (convo.length > MAX_IN) convo = convo.slice(0, MAX_IN * 0.6) + "\n...(中段省略)...\n" + convo.slice(-MAX_IN * 0.4);
  const sys = `你在给一部小说的创作对话做"压缩存档"。把对话压成中文要点, 供后续轮次当记忆直接使用。
必须保留: ①已敲定的设定/角色/世界观/金手指/境界体系 ②用户的明确要求、禁令、偏好 ③已做出的决定和结论 ④未完成的待办 ⑤已上传素材的文件名与用途。
必须丢掉: 寒暄、重复、工具调用过程、已经被推翻的旧方案。
${prevSummary ? "给了【已有摘要】时, 把它和【新增对话】合并成一份完整的新摘要, 已有摘要里的要点不能丢。" : ""}
输出 400~900 字, 每条以 "- " 开头, 不要评论、不要客套、不要写"好的"。`;
  const user = `${prevSummary ? `【已有摘要】\n${prevSummary}\n\n` : ""}【新增对话】\n${convo}`;
  try {
    const resp = (await Promise.race([
      chat(
        [{ role: "system", content: sys }, { role: "user", content: user }],
        undefined,
        { temperature: 0.2, maxTokens: 1400 },
      ) as Promise<{ content?: string }>,
      new Promise<{ content?: string }>((_, rej) => setTimeout(() => rej(new Error("摘要超时 60s")), 60_000)),
    ])) || {};
    const out = (resp.content || "").trim();
    if (out) return out.slice(0, 6000);
  } catch (e) {
    logWarn("[上下文压缩] 摘要 LLM 不可用, 用确定性摘要兜底: " + ((e as Error).message || "").slice(0, 100));
  }
  // 确定性兜底: 摘录用户原话 (用户说的是需求, 比模型的话更值得留)
  const digest = msgs
    .filter((m) => m.role === "user")
    .slice(-40)
    .map((m) => `- 用户: ${(m.content || "").replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n")
    .slice(0, 3000);
  return (prevSummary ? prevSummary + "\n" : "") + (digest || "- (早期对话无可摘录内容)");
}

/**
 * 装上下文: head (系统提示/项目上下文) + history (对话) 超预算时自动压缩早期对话。
 * 返回可直接喂给 LLM 的消息数组 + 压缩信息 (给前端提示用)。
 */
export async function compactConversation(
  pid: string,
  sid: string,
  head: ChatMsg[],
  history: ChatMsg[],
): Promise<{ messages: ChatMsg[]; info: CompactInfo }> {
  const s = getSettings();
  const window = s.contextWindow || 128_000;
  const triggerRatio = s.contextCompactRatio ?? 0.75;
  const keepRatio = s.contextKeepRatio ?? 0.35;
  const headTokens = estimateMessages(head);
  const beforeTokens = headTokens + estimateMessages(history);
  const info: CompactInfo = {
    compacted: false, window, beforeTokens, afterTokens: beforeTokens,
    kept: history.length, dropped: 0, summaryChars: 0,
  };

  // 没超阈值 → 原样返回 (大多数短对话走这条, 不产生任何额外调用)
  if (beforeTokens <= window * triggerRatio || history.length <= 6) {
    return { messages: [...head, ...history], info };
  }

  // 保留预算: 窗口的 keepRatio, 同时给系统提示和本轮回复留出余量
  const keepBudget = Math.max(4000, Math.min(Math.floor(window * keepRatio), window - headTokens - 8000));
  let acc = 0;
  let cut = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i]!.content || "") + 4;
    if (acc + t > keepBudget) break;
    acc += t;
    cut = i;
  }
  if (cut <= 0) return { messages: [...head, ...history], info }; // 最近几条就超预算 → 压不动, 原样交给上游截断

  const dropped = history.slice(0, cut);
  const recent = history.slice(cut);

  // 滚动摘要: 只压"上次之后新增的", 避免每轮重算全部历史
  const prev = store.getContextSummary(pid, sid);
  let todo = dropped;
  if (prev?.uptoId) {
    const idx = dropped.findIndex((m) => m.id === prev.uptoId);
    if (idx >= 0) todo = dropped.slice(idx + 1);
  }
  let summary = prev?.summary || "";
  if (todo.length) {
    summary = await summarize(todo, summary);
  }
  const uptoId = dropped[dropped.length - 1]?.id || prev?.uptoId || "";
  if (uptoId && summary) store.saveContextSummary(pid, sid, uptoId, summary);

  const summaryMsg: ChatMsg = {
    role: "system",
    content: `【历史对话摘要 · 早期 ${dropped.length} 条已自动压缩】\n${summary}\n\n`
      + `(以上是压缩摘要, 下面是最近 ${recent.length} 条未压缩的原文。摘要里若缺细节, 用 query_project / read_source 重新查, 不要凭印象编。)`,
  };
  const messages = [...head, summaryMsg, ...recent];
  info.compacted = true;
  info.afterTokens = estimateMessages(messages);
  info.kept = recent.length;
  info.dropped = dropped.length;
  info.summaryChars = summary.length;
  logInfo(`[上下文压缩] ${pid}: ${beforeTokens} → ${info.afterTokens} tokens (窗口 ${window}, 压缩 ${dropped.length} 条, 保留 ${recent.length} 条, 摘要 ${summary.length} 字)`);
  return { messages, info };
}
