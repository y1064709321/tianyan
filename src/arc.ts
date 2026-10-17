// 全书弧线跟踪器 — autonomous 模式的"宏观节拍器"
//
// 设计原则:
//   1. 弧线目标由 LLM 在项目创建时生成一次(目标章数/目标爽点密度/高潮章节/弧线计划)
//   2. 每章完成后记录一个快照(爽点密度 + 是否被打回)
//   3. 主 Agent 在写下一章节前调用 assess_arc / adjust_arc:
//      - assess_arc: 返回当前进度 + 偏差 + 建议(确定性计算, 不依赖 LLM)
//      - adjust_arc: 模型决定调整(提前高潮/放缓节奏/补密度), 工具记录并通知前端
//   4. 弧线目标与节奏约束不改变"铁律框架"(7 步顺序不变), 只改变"每章怎么执行"

import * as store from "./store.js";
import type { ArcSnapshot } from "./types.js";

// ===== 弧线目标 =====

export interface ArcTarget {
  targetChapters: number;   // 全书目标章数
  targetDensity: number;    // 目标爽点密度(每1000字爽点数, 网文惯例 1-3)
  peakChapter: number;      // 全书大高潮所在章节
  arcPlan: string;          // LLM 生成的弧线计划文本(起承转合描述)
}

export function getOrCreateArcTarget(pid: string): ArcTarget {
  const existing = store.getArcTarget(pid);
  if (existing) return existing;
  // 项目尚未生成目标时: 用保守默认值, 等待 planner 在创建项目时调 setArcTarget 填充
  return { targetChapters: 20, targetDensity: 1.5, peakChapter: 15, arcPlan: "(弧线目标尚未生成)" };
}

export function setArcTarget(pid: string, t: ArcTarget): void {
  store.setArcTarget(pid, t.targetChapters, t.targetDensity, t.peakChapter, t.arcPlan);
}

// ===== 爽点密度启发式估算 =====

const HOOK_KEYWORDS = [
  "震惊", "炸裂", "暴涨", "碾压", "秒杀", "反杀", "打脸", "亮剑", "爆发",
  "跪了", "哭了", "疯了", "全场", "无人敢", "跪求", "目瞪口呆", "汗毛",
  "血赚", "白嫖", "逆天", "禁忌", "夺命",
];

/** 估算一段正文的爽点密度(每1000字爽点数) — 纯启发式, 无 LLM 成本 */
export function estimateDensity(text: string): number {
  if (!text || text.length < 100) return 0;
  const per1000 = (1000 / text.length);
  let hits = 0;
  for (const kw of HOOK_KEYWORDS) hits += (text.split(kw).length - 1);
  // 换行/段落分隔也算弱节奏点(每3段计1)
  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 30).length;
  const rhythmHits = Math.floor(paragraphs / 3);
  return Number(((hits + rhythmHits) * per1000).toFixed(2));
}

/** 记录一章的弧线快照(主 Agent 写完后调用) */
export function recordSnapshot(pid: string, chapterIdx: number, density: number, rejected: boolean): void {
  store.recordArcSnapshot(pid, chapterIdx, density, rejected);
}

/** 列出该项目全部弧线快照 */
export function listSnapshots(pid: string): ArcSnapshot[] {
  return store.listArcSnapshots(pid).map((s) => ({
    chapterIdx: s.chapterIdx,
    density: s.density,
    rejected: s.rejected,
    ts: s.ts,
  }));
}

// ===== 弧线偏差分析(确定性, 给主 Agent 看) =====

export interface ArcAssessment {
  chapterIdx: number;           // 当前刚完成的章节序号
  totalChapters: number;        // 已写章数
  targetChapters: number;       // 全书目标章数
  avgDensity: number;           // 平均爽点密度
  targetDensity: number;        // 目标密度
  densityGap: number;           // 密度偏差(目标 - 平均, 正=欠, 负=过)
  rejectedCount: number;        // 被打回章节数
  peakChapter: number;          // 全书高潮章节
  progressRatio: number;       // 进度 0~1
  /** 节拍器建议 — 主 Agent 据此决定是否调 arc */
  suggestion: "on_track" | "increase_density" | "slow_down" | "frontload_peak" | "recover_ending";
  reason: string;
}

export function assessArc(pid: string): ArcAssessment {
  const target = getOrCreateArcTarget(pid);
  const snaps = listSnapshots(pid);
  const chapterIdx = snaps.length ? Math.max(...snaps.map((s) => s.chapterIdx)) : 0;
  const avgDensity = snaps.length ? Number((snaps.reduce((a, s) => a + s.density, 0) / snaps.length).toFixed(2)) : 0;
  const densityGap = Number((target.targetDensity - avgDensity).toFixed(2));
  const rejectedCount = snaps.filter((s) => s.rejected).length;
  const progressRatio = target.targetChapters > 0 ? Math.min(1, chapterIdx / target.targetChapters) : 0;

  // 节拍器决策(确定性规则, 不耗 LLM):
  let suggestion: ArcAssessment["suggestion"] = "on_track";
  let reason = "节奏正常, 维持当前密度与弧线计划。";

  // 中盘之前: 爽点密度明显欠(低于目标 30%)且接近中段 → 该抬密度了
  if (avgDensity > 0 && densityGap > target.targetDensity * 0.3 && progressRatio >= 0.3 && progressRatio < 0.7) {
    suggestion = "increase_density";
    reason = `平均爽点密度 ${avgDensity}/1000字, 低于目标 ${target.targetDensity}; 建议后续章节加密爽点(加反转/打脸/升级节点)。`;
  }
  // 大高潮前 20% 仍欠密度 → 该把高潮前提前铺
  if (progressRatio >= 0.6 && progressRatio < 0.85 && avgDensity < target.targetDensity) {
    suggestion = "frontload_peak";
    reason = `距全书高潮(第${target.peakChapter}章)约 ${(1 - progressRatio) * target.targetChapters} 章, 密度仍欠; 建议提前埋钩子并压缩过渡章。`;
  }
  // 中盘后密度已超 → 放缓, 留给结尾留白
  if (progressRatio >= 0.7 && densityGap < -target.targetDensity * 0.2) {
    suggestion = "slow_down";
    reason = `密度已超目标, 建议放缓节奏、留白给情感/伏笔回收, 避免后段透支。`;
  }
  // 临近结尾仍欠 → 结尾补强
  if (progressRatio >= 0.9) {
    suggestion = "recover_ending";
    reason = "进入收尾段, 需集中回收伏笔并放大高潮张力。";
  }

  return {
    chapterIdx,
    totalChapters: snaps.length,
    targetChapters: target.targetChapters,
    avgDensity,
    targetDensity: target.targetDensity,
    densityGap,
    rejectedCount,
    peakChapter: target.peakChapter,
    progressRatio: Number(progressRatio.toFixed(2)),
    suggestion,
    reason,
  };
}

// ===== 弧线调整 — 主 Agent 的决策记录 =====

export interface ArcAdjustment {
  pid: string;
  chapterIdx: number;
  from: number;             // 调整前目标密度
  to: number;              // 调整后目标密度
  reason: string;          // 模型说明(展示给前端)
  ts: number;
}

/** 主 Agent 调整弧线目标 — 工具 adjust_arc 调用此函数 */
export function adjustArc(pid: string, newDensity: number, reason: string): ArcAdjustment {
  const target = getOrCreateArcTarget(pid);
  const from = target.targetDensity;
  // 夹紧合理范围: 爽点密度 0.5 ~ 4
  const clamped = Math.max(0.5, Math.min(4, newDensity));
  setArcTarget(pid, { ...target, targetDensity: clamped });
  return { pid, chapterIdx: assessArc(pid).chapterIdx, from, to: clamped, reason, ts: Date.now() };
}
