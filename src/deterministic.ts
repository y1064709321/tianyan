// ===== 确定性兜底层 (Codex 哲学: 执行写死在代码里, 模型只做"想"不做"做") =====
//
// 设计原则 (对齐 OpenAI Codex / OpenCode / Hermes 的"模型-工具解耦"):
//   - 工具里的"做事"逻辑(骨架生成/规则质检/密度估算)全部确定性代码实现
//   - LLM 只在"创意发挥"时调用, 且调用失败/输出不足时自动降级到确定性兜底
//   - 零提示词依赖: 不靠 system prompt 让模型"遵守规则", 而是代码直接判定
//
// 使用方:
//   - dispatchTool "continue_writing" / "ghostwrite": LLM 失败 → skeletonWriting()
//   - dispatchTool "quality_check" / "review_chapter": 先规则层 ruleQualityCheck()
//     → 模型只做"创意维度补分", 不再整段自评
//   - dispatchTool "assess_chapter": 代码判定阈值, 模型只看建议

import * as store from "./store.js";
import { estimateDensity } from "./arc.js";

// ===== 确定性写作骨架 (LLM 失败兜底) =====

/**
 * 当 LLM 调用失败、返回空、或 token 预算耗尽时, 用确定性代码生成章节骨架。
 * 保证: 即使换弱模型, "写小说"这件核心事不会塌方 — 至少能按大纲产出结构化段落。
 */
export function skeletonWriting(opts: {
  pid: string;
  chapterTitle: string;
  outline: string;
  prevContent: string;
  instruction: string;
  targetLength: number;
  genre?: string;
  characterNames: string[];
  worldItems: Array<{ name: string; description: string }>;
}): string {
  const { pid, chapterTitle, outline, prevContent, instruction, targetLength, characterNames, worldItems } = opts;
  const paraCount = Math.max(3, Math.min(20, Math.floor(targetLength / 300)));

  const outlineLines = outline
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && /^[一二三四五六七八九十\d]|[-·•\d]/.test(l))
    .slice(0, paraCount);

  const presentChars = characterNames.filter((c) => prevContent.includes(c)).slice(0, 4);
  const charMention = presentChars.length ? presentChars[0] : (characterNames[0] || "主角");

  const openForeshadows = store.listForeshadowings(pid).filter(
    (f) => f.status !== "recovered" && f.status !== "abandoned",
  );

  const paras: string[] = [];
  paras.push(
    `【开篇钩子】${charMention}${outline ? "、" + (outlineLines[0]?.slice(0, 30) || "") : ""}。` +
      (instruction ? `\n指令锚点: ${instruction.slice(0, 80)}。` : ""),
  );

  for (let i = 1; i < paraCount - 1; i++) {
    const beat = outlineLines[i] || `节点${i + 1}`;
    const density = estimateDensity(prevContent.slice(-2000));
    paras.push(
      `【段落${i + 1}】${beat}。` +
        (i % 3 === 2
          ? ` (密度 ${density}/1000字, ${density < 1 ? "建议加密爽点" : "节奏正常"})`
          : ""),
    );
  }

  const recoveryLine = openForeshadows.length
    ? `【伏笔回收】需处理未回收伏笔: ${openForeshadows.map((f: any) => f.name).join("、")}。`
    : "【伏笔回收】本章无待回收伏笔。";
  paras.push(recoveryLine);
  paras.push("【章末钩子】留下一个未解冲突, 引导下一章。");

  if (worldItems.length) {
    paras.push(
      "【设定锚点】" +
        worldItems
          .slice(0, 3)
          .map((w) => `${w.name}(${w.description.slice(0, 30)})`)
          .join("、") + "。",
    );
  }

  return paras.join("\n\n");
}

// ===== 确定性质检规则层 (LLM 只做创意补分) =====

export interface RuleCheckResult {
  wordCount: number;
  density: number;
  openForeshadows: number;
  aiScore: number;
  aiLevel: "light" | "moderate" | "heavy";
  aiDeletionCap: number;
  verdict: "APPROVE" | "CONCERNS" | "REJECT";
  reasons: string[];
}

const AI_FINGERPRINTS = [
  "不由得", "仿佛", "一股暖流", "心中暗道", "心中一凛", "不禁", "缓缓",
  "嘴角勾起", "眼底闪过", "眸中", "眸子里", "嘴角上扬", "眸光", "眸子里",
  "心中五味杂陈", "一股说不清", "莫名的", "说不清的", "难以言喻",
  "一丝", "一抹", "一缕", "淡淡", "微微", "心中暗喜", "心头一紧",
  "心中一沉", "心中一震", "嘴角", "眼底", "眸光",
];

export function detectAIHeuristic(text: string): { score: number; level: "light" | "moderate" | "heavy"; deletionCap: number; traces: number } {
  if (!text || text.length < 50) return { score: 0, level: "light", deletionCap: 0, traces: 0 };
  const per1000 = 1000 / text.length;
  let traces = 0;
  for (const kw of AI_FINGERPRINTS) traces += text.split(kw).length - 1;
  const density = traces * per1000;
  const score = Math.min(10, Math.round(density * 1.5));
  const level: "light" | "moderate" | "heavy" = score < 4 ? "light" : score < 7 ? "moderate" : "heavy";
  const deletionCap = level === "light" ? 0.15 : level === "moderate" ? 0.25 : 0.35;
  return { score, level, deletionCap, traces };
}

export function ruleQualityCheck(opts: {
  pid: string;
  text: string;
  outline?: string;
  genre?: string;
}): RuleCheckResult {
  const { pid, text, outline } = opts;
  const wordCount = text.length;
  const density = estimateDensity(text);
  const openForeshadows = store
    .listForeshadowings(pid)
    .filter((f) => f.status !== "recovered" && f.status !== "abandoned").length;

  const ai = detectAIHeuristic(text);
  const arcTarget = store.getArcTarget(pid);
  const targetDensity = arcTarget?.targetDensity || 1.5;

  const reasons: string[] = [];
  let verdict: RuleCheckResult["verdict"] = "APPROVE";

  if (wordCount < 200) {
    verdict = "REJECT";
    reasons.push(`字数不足: ${wordCount} < 200`);
  }
  if (ai.score >= 7) {
    verdict = "REJECT";
    reasons.push(`AI味过重: ${ai.score}/10 (${ai.level})`);
  }
  if (outline && wordCount > 0 && wordCount < 500) {
    reasons.push("大纲已有但正文过短, 需补写");
  }
  if (density < targetDensity * 0.5 && text.length > 1000) {
    if (verdict === "APPROVE") verdict = "CONCERNS";
    reasons.push(`爽点密度偏低: ${density}/1000字 < 目标 ${targetDensity}`);
  }
  if (openForeshadows > 5 && text.length > 1000) {
    reasons.push(`未回收伏笔 ${openForeshadows} 条, 建议回收`);
  }
  if (ai.score >= 4 && ai.score < 7) {
    if (verdict === "APPROVE") verdict = "CONCERNS";
    reasons.push(`AI味中等: ${ai.score}/10, 建议删除 ≤ ${Math.round(ai.deletionCap * 100)}%`);
  }

  return {
    wordCount,
    density,
    openForeshadows,
    aiScore: ai.score,
    aiLevel: ai.level,
    aiDeletionCap: ai.deletionCap,
    verdict,
    reasons,
  };
}

// ===== 确定性章节评估 (assess_chapter 用) =====

export function assessChapterRules(opts: {
  pid: string;
  chapterIdx: number;
  content: string;
  outline?: string;
}): {
  density: number;
  isPeak: boolean;
  suggestedThreshold: number;
  needReview: boolean;
  reason: string;
} {
  const { pid, chapterIdx, content, outline } = opts;
  const density = estimateDensity(content);
  const arc = store.getArcTarget(pid);
  const isPeak =
    (outline?.includes("高潮") || content.includes("高潮")) ||
    (arc ? Math.abs(chapterIdx - arc.peakChapter) <= 3 : false);
  const suggestedThreshold = isPeak ? 8 : content.length < 1500 ? 6 : 7;
  const needReview = !(content.length < 800 && !isPeak);
  const reason = needReview
    ? isPeak
      ? "高潮章: 建议严格审查 (阈值 8), 保张力"
      : "常规章: 建议标准审查 (阈值 7)"
    : "短过渡章: 可跳过毒舌审稿, 仅做一致性扫描";
  return { density, isPeak, suggestedThreshold, needReview, reason };
}

// ===== 确定性榜单解析 (scan_bestseller 兜底) =====

/**
 * 从爬回的榜单 rawText (按行 "1. 书名 作者 简介...") 确定性提取结构字段。
 * 弱模型不擅长解析榜单 → 代码先提取, LLM 只做趋势归纳。
 */
export function parseRankingItems(rawText: string): Array<{
  rank: number;
  title: string;
  author: string;
  blurb: string;
}> {
  const lines = rawText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const items: Array<{ rank: number; title: string; author: string; blurb: string }> = [];
  let curRank = 0;
  for (const line of lines.slice(0, 50)) {
    // 模式0: "第N名: **《书名》** (作者: X) | 💡 简介" (JSON API 结构化输出, 书名已带 **《》**)
    const jsonM = line.match(/^第([一二三四五六七八九十\d]+)名[:：]?\s*\*\*《(.+?)》\*\*\s*(.*)$/);
    if (jsonM) {
      const cn = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
      let rankNum: number;
      if (/^[一二三四五六七八九十]+$/.test(jsonM[1])) {
        rankNum = cn.indexOf(jsonM[1]);
        if (rankNum < 0 && jsonM[1].length === 2) rankNum = cn.indexOf(jsonM[1][0]) * 10 + (cn.indexOf(jsonM[1][1]) + 1);
        if (rankNum < 0) rankNum = 1;
      } else {
        rankNum = Number(jsonM[1]);
      }
      const title = jsonM[2];
      const rest = jsonM[3] || "";
      const aM = rest.match(/作者[:：]\s*([^（()｜💡\n|]+)/);
      const author = aM ? aM[1].trim() : "";
      const blurbM = rest.match(/💡\s*(.*)$/);
      const blurb = blurbM ? blurbM[1].trim() : "";
      items.push({ rank: rankNum, title, author, blurb });
      curRank = rankNum;
      continue;
    }
    // 匹配 "数字. 书名 作者 简介" 或 "第X名 书名..."
    const m = line.match(/^(\d{1,3})[\.、\s]+(.+)$/);
    const named = line.match(/^第([一二三四五六七八九十\d]+)名[:：]?\s*(.+)/);
    if (m) {
      curRank = Number(m[1]);
      const rest = m[2];
      // 拆分 title / author / blurb: 前两段是 title+author, 其余是 blurb
      const segs = rest.split(/\s{2,}|\t/);
      const title = segs[0] || "";
      const author = segs.length > 1 ? segs[1] : "";
      const blurb = segs.length > 2 ? segs.slice(2).join(" ") : "";
      items.push({ rank: curRank, title, author, blurb });
    } else if (named) {
      curRank += 1;
      const rest = named[2];
      const segs = rest.split(/\s{2,}|\t/);
      items.push({ rank: curRank, title: segs[0] || "", author: segs.length > 1 ? segs[1] : "", blurb: segs.length > 2 ? segs.slice(2).join(" ") : "" });
    }
  }
  return items;
}

/**
 * 从榜单条目确定性提取题材/标签分布 (给 LLM 做趋势归纳的结构化输入)。
 */
export function extractGenreDistribution(
  items: Array<{ title: string; blurb: string; author: string }>,
  genres: string[] = ["玄幻", "仙侠", "都市", "科幻", "悬疑", "历史", "游戏", "军事", "体育", "言情", "奇幻", "武侠"],
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const g of genres) dist[g] = 0;
  const text = items.map((i) => i.title + " " + i.blurb).join(" ");
  for (const g of genres) {
    dist[g] = text.split(g).length - 1;
  }
  return dist;
}

// ===== 确定性大纲骨架 (generate_outline 兜底) =====

/**
 * 按"起承转合 + 高潮节奏"确定性拆章节大纲。
 * 弱模型不擅长结构 → 代码先给骨架, LLM 只填情节。
 */
export function outlineSkeleton(opts: {
  premise: string;
  genre: string;
  numChapters: number;
  targetDensity?: number;
  peakChapter?: number;
}): Array<{ idx: number; title: string; outline: string; beat: string }> {
  const { premise, genre, numChapters, targetDensity = 1.5, peakChapter = Math.max(5, Math.floor(numChapters * 0.8)) } = opts;
  const chapters: Array<{ idx: number; title: string; outline: string; beat: string }> = [];
  for (let i = 0; i < numChapters; i++) {
    const idx = i + 1;
    const ratio = numChapters > 1 ? i / (numChapters - 1) : 1;
    // 四幕结构: 起(0-0.25) 承(0.25-0.5) 转(0.5-0.85) 合(0.85-1.0)
    let beat: string;
    let outline: string;
    if (ratio < 0.25) {
      beat = "起";
      outline = `开篇钩子: 主角出场 + 核心矛盾引入 (${premise.slice(0, 40)}). 建立世界观与金手指, 埋设主线伏笔。`;
    } else if (ratio < 0.5) {
      beat = "承";
      outline = `发展: 主角能力成长 + 第一个小高潮 (打脸/突破/立威). 引入主要配角与反派, 埋设后续伏笔。`;
    } else if (ratio < 0.85) {
      beat = "转";
      outline = `转折: 主线冲突升级 + 中盘高潮 (决战/反转/身份揭露). 回收前段伏笔, 引出大高潮铺垫。`;
    } else {
      beat = "合";
      outline = `高潮与收尾: 全书大高潮 (第${peakChapter}章附近) + 伏笔总回收 + 结局定调。`;
    }
    // 爽点密度标注 (确定性)
    const isPeak = Math.abs(idx - peakChapter) <= 2;
    const densityNote = isPeak ? `[密度: 高, 目标 ${Math.max(targetDensity, 2.5)}/1000字]` : `[密度: 常规, 目标 ${targetDensity}/1000字]`;
    chapters.push({ idx, title: `第${idx}章 (待命名)`, outline: `${outline} ${densityNote}`, beat });
  }
  return chapters;
}

// ===== 确定性毒舌评分下限 (review_chapter 兜底) =====

export interface RuleReviewScore {
  ruleScore: number;      // 规则层分 0-10
  llmScore: number;       // LLM 创意分 0-10
  finalScore: number;     // 加权最终分
  reject: boolean;        // < 7 打回 (规则层兜底判, 不靠模型自觉)
  reasons: string[];
}

/**
 * 毒舌评分下限: 规则层分 (字数/密度/AI味/伏笔) × 0.5 + LLM 创意分 × 0.5。
 * 规则层分 < 5 → 直接打回, 不管 LLM 打多少分。弱模型乱打 10 分时, 规则层封顶。
 */
export function weightedReviewScore(opts: {
  pid: string;
  text: string;
  outline?: string;
  llmScore: number;
}): RuleReviewScore {
  const { pid, text, outline, llmScore } = opts;
  const rule = ruleQualityCheck({ pid, text, outline });

  // 规则层分: 从 verdict + reasons 推导 0-10
  let ruleScore: number;
  if (rule.verdict === "REJECT") {
    ruleScore = 3;  // 规则层否决 → 低分
  } else if (rule.verdict === "CONCERNS") {
    ruleScore = 6;
  } else {
    ruleScore = 8;
  }
  // 密度欠 → 扣 1 分
  if (rule.density < 1) ruleScore = Math.max(2, ruleScore - 1);
  // AI 味重 → 扣 1 分
  if (rule.aiScore >= 4) ruleScore = Math.max(2, ruleScore - 1);

  // 加权: 规则层 0.5 + LLM 创意 0.5
  const finalScore = Number((ruleScore * 0.5 + llmScore * 0.5).toFixed(1));
  // 打回判定: 规则层 < 5 直接打回 (兜底), 或加权分 < 7
  const reject = ruleScore < 5 || finalScore < 7;

  const reasons: string[] = [...rule.reasons];
  reasons.push(`规则层分 ${ruleScore}/10, LLM 创意分 ${llmScore}/10, 加权 ${finalScore}/10`);
  if (ruleScore < 5) reasons.push("规则层否决 (字数/AI味/密度 不达标), 无论 LLM 打多少分都打回");

  return { ruleScore, llmScore, finalScore, reject, reasons };
}

// ===== 确定性原创度检测 (防"一模一样的文章" / 照抄故事) =====
//
// 背景: 用户核心痛点 — AI 若把某本扫榜作品洗一段原文、或把自己前 50 章句式复制一遍,
//       早期 35 维清单里没有任何一维能查出来 (当时没有"原创度"维度)。
//       现在已补为第 36 维, 在 audit-dimensions.ts 里作为单一数据源的一部分调用本函数。
// 设计: 纯代码 n-gram / 句级指纹比对, 零 LLM, 弱模型也查得准。
// 比对源 (确定性可得):
//   1. 自身前文 (store.listChapters 排除当前章) — 自查"自我重复/洗稿式重写"
//   2. 上传的参考语料 (store.listChunks) — 查"照抄用户上传的参考文本"
//   3. (扫榜原文当前未落盘, 暂不比对; 后续 P1 落盘后可加入)

import * as store2 from "./store.js";

export interface SimilaritySource {
  source: string;      // "自身前文:第3章" / "上传语料:xxx.txt"
  kind: "self" | "uploaded";
  overlap: number;     // 0~1 Jaccard (越高越相似)
  matched: string[];   // 命中的长片段 (原文证据)
}

export interface SimilarityResult {
  maxOverlap: number;
  worstSource: string;
  selfRepetition: { repeatedSentences: number; duplicateRatio: number };
  sources: SimilaritySource[];
  verdict: "original" | "suspect" | "plagiarized";
  threshold: number;
  reasons: string[];
}

/** 取 10 字 n-gram 集合 (中文按 10 字滑窗, 标点/空白归一化后切分)。 */
function ngramSet(text: string, n = 10): Set<string> {
  const norm = text.replace(/[\s\u3000。！？，、；：""''《》【】\(\)（）\.\!\?\,\;\:]+/g, "");
  const set = new Set<string>();
  if (norm.length < n) return set;
  for (let i = 0; i + n <= norm.length; i++) set.add(norm.slice(i, i + n));
  return set;
}

/** Jaccard 相似度 (0~1)。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** 句级重复: 找出 ≥15 字、在文中出现 ≥2 次的句子。 */
function selfRepetition(text: string): { repeatedSentences: number; duplicateRatio: number } {
  const sentences = text
    .split(/[。！？\n]/)
    .map((s) => s.replace(/[\s\u3000""''"]/g, ""))
    .filter((s) => s.length >= 15);
  const freq = new Map<string, number>();
  for (const s of sentences) freq.set(s, (freq.get(s) || 0) + 1);
  let repeated = 0;
  let dupChars = 0;
  let totalChars = 0;
  for (const s of sentences) totalChars += s.length;
  for (const [s, c] of freq) {
    if (c >= 2) {
      repeated++;
      dupChars += s.length * (c - 1); // 多余出现的部分
    }
  }
  return { repeatedSentences: repeated, duplicateRatio: totalChars ? Math.round((dupChars / totalChars) * 1000) / 10 : 0 };
}

/**
 * 确定性原创度检测: 对当前章节文本, 比对 自身前文 + 上传语料,
 * 返回 Jaccard 重叠、句级重复、命中长片段, 并给出 original/suspect/plagiarized 三档判定。
 * 阈值: Jaccard ≥0.35 判 plagiarized (照抄), ≥0.18 判 suspect (高度相似), 否则 original。
 */
export function similarityCheck(opts: {
  pid: string;
  currentChapterId?: string;
  text: string;
  corpusTexts?: Array<{ source: string; text: string }>; // 可选: 额外比对源 (如扫榜原文)
  threshold?: number;
}): SimilarityResult {
  const { pid, currentChapterId, text, corpusTexts = [], threshold = 0.18 } = opts;

  const refs: SimilaritySource[] = [];
  const textSet = ngramSet(text);

  // 1. 自身前文 (排除当前章)
  const chapters = store2.listChapters(pid);
  for (const ch of chapters) {
    if (currentChapterId && ch.id === currentChapterId) continue;
    if (!ch.content || ch.content.length < 50) continue;
    const refSet = ngramSet(ch.content);
    const overlap = jaccard(textSet, refSet);
    if (overlap > 0.05) {
      refs.push({
        source: `自身前文:${ch.title || ch.idx}`,
        kind: "self",
        overlap: Number(overlap.toFixed(3)),
        matched: sampleMatches(text, ch.content),
      });
    }
  }

  // 2. 上传语料 (chunks 表)
  try {
    const chunks = store2.listChunks(pid);
    const bySource = new Map<string, string>();
    for (const ck of chunks) bySource.set(ck.source, (bySource.get(ck.source) || "") + ck.text);
    for (const [source, fullText] of bySource) {
      if (fullText.length < 50) continue;
      const refSet = ngramSet(fullText);
      const overlap = jaccard(textSet, refSet);
      if (overlap > 0.05) {
        refs.push({
          source: `上传语料:${source}`,
          kind: "uploaded",
          overlap: Number(overlap.toFixed(3)),
          matched: sampleMatches(text, fullText),
        });
      }
    }
  } catch { /* chunks 表可能不存在 */ }

  // 3. 额外比对源 (扫榜原文等)
  for (const extra of corpusTexts) {
    if (!extra.text || extra.text.length < 50) continue;
    const refSet = ngramSet(extra.text);
    const overlap = jaccard(textSet, refSet);
    if (overlap > 0.05) {
      refs.push({
        source: extra.source,
        kind: "uploaded",
        overlap: Number(overlap.toFixed(3)),
        matched: sampleMatches(text, extra.text),
      });
    }
  }

  refs.sort((a, b) => b.overlap - a.overlap);
  const maxOverlap = refs.length ? refs[0].overlap : 0;
  const worstSource = refs.length ? refs[0].source : "(无显著重叠)";

  const rep = selfRepetition(text);

  let verdict: SimilarityResult["verdict"] = "original";
  const reasons: string[] = [];
  if (maxOverlap >= 0.35) {
    verdict = "plagiarized";
    reasons.push(`与「${worstSource}」高度重叠 Jaccard=${maxOverlap} ≥0.35, 疑似照抄`);
  } else if (maxOverlap >= threshold) {
    verdict = "suspect";
    reasons.push(`与「${worstSource}」相似 Jaccard=${maxOverlap} ≥${threshold}, 建议改写`);
  }
  if (rep.duplicateRatio >= 8) {
    if (verdict === "original") verdict = "suspect";
    reasons.push(`本章内部句级重复 ${rep.repeatedSentences} 句, 重复率 ${rep.duplicateRatio}% (水词/自我复制)`);
  }
  if (!reasons.length) reasons.push("原创度正常, 无显著外部重叠, 内部句级重复可控");

  return {
    maxOverlap,
    worstSource,
    selfRepetition: rep,
    sources: refs,
    verdict,
    threshold,
    reasons,
  };
}

/** 抽取 text 中命中 ref 的长片段 (≥25 字公共子串), 最多 3 条作证据。 */
function sampleMatches(text: string, ref: string): string[] {
  const out: string[] = [];
  const refNorm = ref.replace(/\s+/g, "");
  const win = 25;
  for (let i = 0; i + win < text.length && out.length < 3; i += 2) {
    const seg = text.slice(i, i + win).replace(/\s+/g, "");
    if (seg.length >= win && refNorm.includes(seg)) {
      // 合并连续命中
      const last = out[out.length - 1];
      if (last && text.lastIndexOf(seg, i) === i - win) out[out.length - 1] = last + text[i + win];
      else out.push(text.slice(i, i + win));
    }
  }
  return out.slice(0, 3);
}
