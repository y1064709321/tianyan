// 规划层(感知层) — autonomous 模式的"决策中枢"
//
// 设计: 主 Agent (orchestrator) 拿到用户输入后, 由规划器生成"决策"
//   1. 理解目标: 解析用户意图(创建/推进/执行/修订/查询)
//   2. 生成路线图: 当前阶段 + 数据就绪度 → 该做什么
//   3. 注入执行: 把决策(含弧线信息)拼进 orchestrator 的系统消息, 让它自主执行
//
// 铁律框架不变: 路线图仍遵守 7 步顺序, 规划器只负责"决定这一轮走哪条路 + 注入弧线信息"

import * as store from "./store.js";
import { getProjectState } from "./store.js";
import { getArcTarget } from "./store.js";
import { assessArc } from "./arc.js";
import { chat } from "./llm.js";
import { getSettings } from "./config.js";
import type { PlannerDecision, PlannerIntent, AgentName } from "./types.js";

export interface PlannerContext {
  pid: string;
  userInput: string;
  /** orchestrator 名(固定) */
  agent: AgentName;
}

// ===== 意图识别(确定性) =====

export function detectPlannerIntent(
  input: string,
  project: { id: string; currentPhase: number } | null,
): PlannerIntent {
  const lower = input.toLowerCase().trim();

  if (!project) return "create_project";

  // 全流程信号: 用户要求从头跑完整流程 → 走 run_full_pipeline (最高优先级, 在 create/revise 之前判定)
  if (/全流程|完整.*流程|从头.*跑|跑完整|从头.*创作|自动跑完|一路跑/.test(lower)) {
    return "run_full_pipeline";
  }

  // 修订信号: 含"重写/打回/改一下/重写这章"等
  if (/(重写|打回|改一下|重写这章|重写本章|不通过|修改意见|再改)/.test(lower)) {
    return "revise";
  }
  // 状态查询
  if (/进度|状态|现在到哪|当前阶段|到哪了|进展|看了没|什么情况|完成到/.test(lower)) {
    return "query_status";
  }
  // 确认推进
  if (/^(好|行|可以|确认|继续|下一步|下个|推进|ok|yes|y|嗯|对|是的?|好的?|确认进入|开始下一)$/.test(lower) ||
      /继续下一步|进入下一阶段|开始下一|推进到|确认进入/.test(lower)) {
    return "advance";
  }
  // 创作类 → 执行当前阶段
  if (/写|创作|扫榜|三江|拆书|大纲|角色|审稿|质检|润色|继续写|下一章|新章|正文|仿写|代笔|代写/.test(lower)) {
    return "execute_phase";
  }
  // 默认: 普通对话(交给 orchestrator 自由处理)
  return "chat";
}

// ===== 主入口: 生成规划决策 =====

export interface PlannerPlan {
  decision: PlannerDecision;
  /** 注入 orchestrator 的系统消息(弧线 + 路线图 + 阶段就绪信息) */
  contextBlock: string;
}

export async function plan(ctx: PlannerContext): Promise<PlannerPlan> {
  const { pid, userInput } = ctx;
  const project = store.getProject(pid);

  // 1) 无项目 → 创建项目意图
  if (!project) {
    const decision: PlannerDecision = {
      intent: "create_project",
      reason: "检测到新项目创建意图(项目尚不存在)。",
      steps: ["parseProjectInput(解析用户描述)", "store.createProject", "生成全书弧线目标(LLM)", "autoAdvancePhase → Phase 1 扫榜调研"],
      targetAgent: "",
      targetPhase: 1,
    };
    const contextBlock = buildProjectCreationContext(userInput);
    return { decision, contextBlock };
  }

  // 2) 有项目 → 解析意图
  const intent = detectPlannerIntent(userInput, project);
  const state = getProjectState(pid);
  const arc = assessArc(pid);
  const arcTarget = getArcTarget(pid);

  // 意图对应的目标阶段(仍遵守 7 步铁律, 只决定"现在该走哪一条")
  let targetPhase = state.currentPhase;
  let steps: string[] = [];
  let reason = "";
  let targetAgent: AgentName | "";

  switch (intent) {
    case "advance":
      targetPhase = state.currentPhase;
      reason = `用户确认推进: 当前 Phase ${state.currentPhase} 数据已就绪, 继续执行。`;
      steps = [`执行 Phase ${state.currentPhase}(数据就绪度校验)`, "autoAdvancePhase 推进到下一阶段", "汇报结果并询问是否继续"];
      targetAgent = "";
      break;
    case "run_full_pipeline":
      targetPhase = state.currentPhase;
      reason = `用户要求跑完整流程: 从当前 Phase ${state.currentPhase} 连续推进直到 Phase 8, 门控问题自动按默认选项放行, 不中途等用户确认。`;
      steps = [`连续执行 Phase ${state.currentPhase} → 8 (每阶段委派对应专家 + 质检)`, "autonomous 门控: 收到 gate_question 时用项目默认设定自动回答放行 (不等用户)"];
      targetAgent = "";
      break;
    case "execute_phase":
      targetPhase = state.currentPhase;
      reason = `用户要求创作: 路由到当前 Phase ${state.currentPhase}, 由对应专家执行。`;
      steps = [`query_workflow(确认阶段)`, `delegate_to_agent(委派对应专家执行 Phase ${state.currentPhase})`, "enforceReviewAfterWrite(写作后自动质检)"];
      targetAgent = "";
      break;
    case "revise":
      targetPhase = 5; // 修订统一回 Phase 5 重写
      reason = `用户要求修订: 回退到 Phase 5 按审查意见重写被拒章节。`;
      steps = ["定位被拒章节", "按总编意见 rewrite(replace=true)", "重新走审查链(quality_check + review_chapter)"];
      targetAgent = "narrative-writer";
      break;
    case "query_status":
      targetPhase = state.currentPhase;
      reason = "用户查询进度: 返回项目状态 + 弧线快照 + 下一步建议。";
      steps = ["getProjectProgress", "listArcSnapshots", "输出下一步建议(节拍器)"];
      targetAgent = "";
      break;
    case "chat":
    default:
      targetPhase = state.currentPhase;
      reason = "自由对话: 由 orchestrator 判断(非创作意图, 不强制走流水线)。";
      steps = ["orchestrator 自由应答", "若涉及创作则转 execute_phase"];
      targetAgent = "";
      break;
  }

  const decision: PlannerDecision = { intent, reason, steps, targetAgent, targetPhase };

  // 3) 注入 orchestrator 的弧线上下文(节拍器建议)
  const contextBlock = buildArcContext(state, arc, arcTarget, intent);

  return { decision, contextBlock };
}

// ===== 上下文构造 =====

function buildProjectCreationContext(userInput: string): string {
  return `【规划决策 — 创建项目】
用户输入: ${userInput.slice(0, 200)}
执行: parseProjectInput → createProject → LLM 生成弧线目标 → autoAdvancePhase 到 Phase 1
注意: 创建后必须调用 setArcTarget(目标章数/目标密度/高潮章节/弧线计划) 记录全书弧线目标。`;
}

function buildArcContext(
  state: ReturnType<typeof getProjectState>,
  arc: ReturnType<typeof assessArc>,
  arcTarget: ReturnType<typeof getArcTarget>,
  intent: PlannerIntent,
): string {
  const lines: string[] = [];
  lines.push(`【规划决策 — 当前状态】
当前阶段: Phase ${state.currentPhase}
意图: ${intent}
数据就绪: 角色=${state.hasCharacters} 世界观=${state.hasWorld} 大纲=${state.hasOutline} 正文=${state.hasContent} 章节=${state.hasChapters}`);

  if (arcTarget) {
    lines.push(`【全书弧线目标】
目标章数: ${arcTarget.targetChapters} | 目标爽点密度: ${arcTarget.targetDensity}/1000字 | 全书高潮: 第${arcTarget.peakChapter}章
弧线计划: ${arcTarget.arcPlan.slice(0, 300)}`);
  }

  lines.push(`【节拍器建议(确定性)】
当前爽点密度: ${arc.avgDensity}/1000字 (目标 ${arc.targetDensity}, 偏差 ${arc.densityGap})
进度: ${arc.progressRatio} (已写 ${arc.totalChapters} 章, 目标 ${arc.targetChapters})
被打回章节: ${arc.rejectedCount}
节拍器: ${arc.suggestion} — ${arc.reason}
`);

  // 节拍器建议 → 主 Agent 可调用 adjust_arc 调整
  lines.push(`若节拍器建议 increase_density/slow_down/frontload_peak, 你(orchestrator)可调用 adjust_arc 工具调整后续章节的密度目标; 调整后调用 assess_arc 查看新状态。`);

  // 全流程意图 → 门控自动放行指令 (用户已明确要求跑完整流程, 不等确认)
  if (intent === "run_full_pipeline") {
    lines.push(`【全流程模式 — 门控自动放行】
用户已要求跑完整流程。规则:
1. 连续执行, 每阶段委派对应专家并跑完质检/审稿后【立即】进入下一阶段, 不要中途停下等用户确认。
2. 收到 gate_question (阶段门控确认, 如阶段1完成后的定题材/对标/钩子三问) 时, 不要等用户回复: 直接用项目已有设定 (扫榜报告推荐的题材与对标作品 / 差异化核心钩子) 自动作答并推进到下一阶段。
3. 扫榜/拆书/大纲/角色 由 story-architect 执行; 正文写作 委派 narrative-writer; 审稿/质检 按现有钩子自动触发。
4. 只有全部 8 阶段完成 (Phase 8 终审定稿) 或遇到不可恢复错误时才结束本轮。
5. 每个阶段完成后简短汇报 (1-2句), 然后立即开始下一阶段。`);
  }

  return lines.join("\n");
}
