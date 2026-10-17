/**
 * 天衍 工作流状态机 — Phase Gate + State Machine 双重约束
 * 
 * 8个阶段，线性推进，审查不通过可打回重写。
 * 代码层面强制：跳步直接报错。
 */

export type Phase = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface PhaseInfo {
  phase: Phase;
  name: string;
  description: string;
  requiredPreconditions: string[];
  allowedNext: Phase[];
  agent: string;
}

// ===== 8个阶段定义 =====
export const PHASES: Record<Phase, PhaseInfo> = {
  1: {
    phase: 1,
    name: "扫榜调研",
    description: "扫描市场热门榜单，分析题材趋势",
    requiredPreconditions: ["项目已创建"],
    allowedNext: [2],
    agent: "story-architect",
  },
  2: {
    phase: 2,
    name: "拆书解构",
    description: "拆解对标畅销书的钩子/节奏/人设/文风",
    requiredPreconditions: ["阶段1完成"],
    allowedNext: [3],
    agent: "story-architect",
  },
  3: {
    phase: 3,
    name: "定文风定位",
    description: "确定文风/题材/核心梗/情绪曲线",
    requiredPreconditions: ["阶段2完成"],
    allowedNext: [4],
    agent: "story-architect",
  },
  4: {
    phase: 4,
    name: "大纲搭建",
    description: "全书体量→卷纲→细纲→伏笔/时间线",
    requiredPreconditions: ["阶段3完成", "有角色档案"],
    allowedNext: [5],
    agent: "story-architect",
  },
  5: {
    phase: 5,
    name: "正文写作",
    description: "细纲→加载上下文→揉进→字数验证",
    requiredPreconditions: ["阶段4完成", "有大纲"],
    allowedNext: [6],
    agent: "narrative-writer",
  },
  // 两级审核: 阶段 6 初审 (审核 agent 在独立上下文打分, 只发现问题不裁决)
  //          → 阶段 8 终审 (主 Agent 基于初审结论裁决放过/打回)
  6: {
    phase: 6,
    name: "初审质检",
    description: "审核agent独立上下文逐章打分, 产出评分+问题清单(只打分不裁决)",
    requiredPreconditions: ["阶段5完成", "有正文"],
    allowedNext: [7],
    agent: "consistency-checker",
  },
  7: {
    phase: 7,
    name: "打回返修",
    description: "一致性+伏笔+去AI味+格式合规",
    requiredPreconditions: ["阶段6完成"],
    allowedNext: [5, 8],  // 5=打回重写, 8=通过定稿
    agent: "consistency-checker",
  },
  8: {
    phase: 8,
    name: "终审定稿",
    description: "主Agent基于初审结论裁决→通过则定稿→推进下一章",
    requiredPreconditions: ["阶段7通过"],
    allowedNext: [1],  // 下一本书或下一章
    agent: "orchestrator",
  },
};

// ===== 状态机：检查转换是否合法 =====
export function canTransition(from: Phase, to: Phase): boolean {
  const phase = PHASES[from];
  if (!phase) return false;
  return phase.allowedNext.includes(to);
}

// ===== Phase Gate：检查前置条件 =====
export interface PreconditionResult {
  passed: boolean;
  failed: string[];
}

export function checkPreconditions(
  targetPhase: Phase,
  projectState: {
    currentPhase: Phase;
    hasCharacters: boolean;
    hasWorld: boolean;
    hasOutline: boolean;
    hasContent: boolean;
    hasChapters: boolean;
  }
): PreconditionResult {
  const phase = PHASES[targetPhase];
  const failed: string[] = [];

  for (const pre of phase.requiredPreconditions) {
    switch (pre) {
      case "项目已创建":
        break; // 总是通过
      case "阶段1完成":
        if (projectState.currentPhase < 1) failed.push("阶段1未完成");
        break;
      case "阶段2完成":
        if (projectState.currentPhase < 2) failed.push("阶段2未完成");
        break;
      case "阶段3完成":
        if (projectState.currentPhase < 3) failed.push("阶段3未完成");
        break;
      case "阶段4完成":
        if (projectState.currentPhase < 4) failed.push("阶段4未完成");
        break;
      case "阶段5完成":
        if (projectState.currentPhase < 5) failed.push("阶段5未完成");
        break;
      case "阶段6完成":
        if (projectState.currentPhase < 6) failed.push("阶段6未完成");
        break;
      case "阶段7完成":
        if (projectState.currentPhase < 7) failed.push("阶段7未完成");
        break;
      case "阶段7通过":
        if (projectState.currentPhase < 7) failed.push("阶段7未通过");
        break;
      case "有角色档案":
        if (!projectState.hasCharacters) failed.push("缺少角色档案");
        break;
      case "有世界观":
        if (!projectState.hasWorld) failed.push("缺少世界观设定");
        break;
      case "有大纲":
        if (!projectState.hasOutline) failed.push("缺少大纲");
        break;
      case "有正文":
        if (!projectState.hasContent) failed.push("缺少正文内容");
        break;
    }
  }

  return { passed: failed.length === 0, failed };
}

// ===== 强制推进阶段 =====
export function advancePhase(
  currentPhase: Phase,
  targetPhase: Phase,
  projectState: Parameters<typeof checkPreconditions>[1]
): { success: boolean; error?: string; newPhase?: Phase } {
  // 检查转换合法性
  if (!canTransition(currentPhase, targetPhase)) {
    return {
      success: false,
      error: `不允许从阶段${currentPhase}(${PHASES[currentPhase].name})跳到阶段${targetPhase}(${PHASES[targetPhase].name})。允许的下一步: ${PHASES[currentPhase].allowedNext.map(p => `${p}(${PHASES[p as Phase].name})`).join(", ")}`,
    };
  }

  // 检查前置条件
  const check = checkPreconditions(targetPhase, projectState);
  if (!check.passed) {
    return {
      success: false,
      error: `阶段${targetPhase}(${PHASES[targetPhase].name})前置条件不满足: ${check.failed.join("; ")}`,
    };
  }

  return { success: true, newPhase: targetPhase };
}

// ===== 获取当前阶段信息 =====
export function getPhaseInfo(phase: Phase): PhaseInfo {
  return PHASES[phase];
}

// ===== 主 agent 询问门禁 (P1: 用户设计里"扫码后定什么书/世界观高低/配角/大纲敲定") =====
// 这些是"完成该阶段后, 必须用户确认才能进入下一阶段"的门。门的问题会注入 orchestrator,
// 用户确认 (advance 意图) 时把答案带进下一阶段的工具参数。
export const GATED_PHASES = new Set<number>([1, 3, 4]);

export const GATE_QUESTIONS: Record<number, string> = {
  // 完成阶段1(扫榜)后, 进入阶段2前: 定写什么
  1: "📌 [阶段1完成] 扫榜数据已就绪。请先确认三件事再进阶段2: ①要写什么类型/题材? (仙侠/都市/科幻/…) ②对标哪部作品? ③差异化方向/核心钩子? 三项都明确后才进阶段2拆书解构。",
  // 完成阶段3(角色架构)后, 进入阶段4前: 世界观锚点 (按类型动态生成, 见 buildWorldviewQuestion)
  // 4: "📌 [阶段3完成] 角色架构已建立。请确认世界观: ①高低定位? ②主角外貌/性格细节补充? ③是否增加配角? (跟主 agent 讨论后确认)。确认后进入阶段4大纲。",
  // 完成阶段4(大纲)后, 进入阶段5前: 大纲敲定
  4: "📌 [阶段4完成] 全书大纲已生成。请确认大纲是否敲定? 确认后进入阶段5正文写作 (质检员36维全审将在此后强制进行)。",
};

/** 按项目类型 (genre) 动态生成世界观锚点问题。
 *  修真/武侠/异能/奇幻类 → 问"高武 or 低武"; 其他类 → 问该类型的对应世界观锚点。
 *  这就是用户设计里"根据前端选的类型, 世界观是高低步还是具体的都要补充"。 */
export function buildWorldviewQuestion(genre: string): string {
  const g = (genre || "").trim();
  // 修真体系类: 高武/低武 二分
  if (/仙侠|玄幻|武侠|异能|奇幻/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「" + (g || "修真") + "」类型): ①高武 (修为无上限, 飞天遁地, 毁天灭地) 还是低武 (隐于人间, 凡人为本, 以技制敌)? ②修炼境界多少层? ③主角外貌/性格细节补充? ④是否增加配角? (跟主 agent 讨论后确认)。确认后进入阶段4大纲。";
  }
  // 都市: 纯现实 vs 都市异能
  if (/都市/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「都市」类型): ①纯都市现实 (无超自然元素) 还是都市+异能 (隐藏力量/系统/重生)? ②时代背景 (现代/民国/未来)? ③主角身份/外貌细节? ④是否增加配角? 确认后进入阶段4大纲。";
  }
  // 科幻: 硬科幻 vs 软科幻
  if (/科幻/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「科幻」类型): ①硬科幻 (科技严谨, 太空/近未来) 还是软科幻 (高概念/无限流/赛博)? ②科技水平 (近未来/远未来/星际)? ③主角身份? ④是否增加配角? 确认后进入阶段4大纲。";
  }
  // 悬疑/恐怖: 现实向 vs 灵异向
  if (/悬疑|恐怖/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「悬疑/恐怖」类型): ①现实向 (无超自然, 人心悬疑) 还是灵异向 (鬼怪/民俗/克苏鲁)? ②时间线 (现代/民国/古代)? ③主角身份? ④是否增加配角? 确认后进入阶段4大纲。";
  }
  // 言情/纯爱: 古代 vs 现代
  if (/言情|纯爱/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「言情/纯爱」类型): ①古代背景 (宫斗/宅斗/江湖) 还是现代背景 (职场/校园)? ②是否有超自然/重生/穿越元素? ③主角外貌/性格细节? ④是否增加配角 (对手/闺蜜/情敌)? 确认后进入阶段4大纲。";
  }
  // 历史: 真实朝代 vs 架空
  if (/历史/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「历史」类型): ①真实朝代 (哪个朝代) 还是架空历史 (类唐/类宋)? ②主角身份 (皇子/将军/书生/商人)? ③时代主线 (争霸/改革/复仇)? ④是否增加配角? 确认后进入阶段4大纲。";
  }
  // 末世: 写实生存 vs 末世+系统
  if (/末世/.test(g)) {
    return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「末世」类型): ①写实生存 (低武, 资源争夺) 还是末世+系统 (高概念, 金手指)? ②末日类型 (丧尸/极寒/病毒/星际战争)? ③主角身份? ④是否增加配角? 确认后进入阶段4大纲。";
  }
  // 军事/游戏/二次元 及默认: 通用世界观锚点
  return "📌 [阶段3完成] 角色架构已建立。请确认世界观 (「" + (g || "未定类型") + "」类型): ①世界观核心锚点 (时代/地点/规则/力量体系)? ②是否有超自然/金手指? ③主角身份/外貌细节? ④是否增加配角? 确认后进入阶段4大纲。";
}

/** 给定刚完成的阶段 + 项目类型, 返回进入下一阶段时需要问用户的问题 (null = 无门, 可自动推进)。 */
export function gateQuestionAfter(completedPhase: number, genre?: string): string | null {
  if (completedPhase === 3) return buildWorldviewQuestion(genre || "");
  if (GATED_PHASES.has(completedPhase)) return GATE_QUESTIONS[completedPhase] || null;
  return null;
}

// ===== 工具到阶段的映射 =====
export const TOOL_PHASE_MAP: Record<string, Phase> = {
  "scan_bestseller": 1,
  "analyze_novel": 2,
  "deconstruct": 2,
  "generate_outline": 4,
  "manage_outline": 4,
  "continue_writing": 5,
  "ghostwrite": 5,
  "polish": 5,
  "review_chapter": 6,
  "quality_check": 7,
  "audit_novel": 7,
  "detect_ai": 7,
  "full_audit": 7,
};

// ===== 检查工具是否在当前阶段允许执行 =====
export function isToolAllowedInPhase(
  toolName: string,
  currentPhase: Phase,
  reviewResult?: string
): { allowed: boolean; reason?: string } {
  // 查询类工具始终允许
  const alwaysAllowed = ["query_project", "delegate_to_agent", "list_files", "read_file"];
  if (alwaysAllowed.includes(toolName)) {
    return { allowed: true };
  }

  const requiredPhase = TOOL_PHASE_MAP[toolName];
  if (requiredPhase === undefined) {
    return { allowed: true }; // 未映射的工具允许执行
  }

  // 审查不通过时，允许主笔工具（打回重写）
  if (currentPhase === 7 && reviewResult === "rejected") {
    const revisionTools = ["continue_writing", "ghostwrite", "polish"];
    if (revisionTools.includes(toolName)) {
      return { allowed: true, reason: "审查打回，允许重写" };
    }
  }

  if (currentPhase < requiredPhase) {
    return {
      allowed: false,
      reason: `工具 ${toolName} 需要阶段${requiredPhase}(${PHASES[requiredPhase as Phase]?.name || ""})，当前阶段${currentPhase}(${PHASES[currentPhase].name})不允许执行`,
    };
  }

  return { allowed: true };
}
