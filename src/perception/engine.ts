/**
 * 天衍 感知引擎 — 确定性路由 + orchestrator 混合架构
 *
 * 设计原则（借鉴 Claude Code / Codex / OpenCode / Hermes Agent）:
 *   1. 感知层做意图识别和项目创建（确定性，不依赖 LLM）
 *   2. 工作流执行采用确定性路由（阶段→agent→工具），模型无关
 *   3. 审核链路由 orchestrator agent loop 处理（需要 LLM 判断）
 *   4. 状态机作为约束层，防止跳步
 *   5. 子 agent 有自己的思考阶段（Turn Phase 模式）
 *
 * 为什么用确定性路由而非纯 orchestrator 决策:
 *   - agnes/deepseek/qwen 等模型不支持原生 function calling
 *   - 即使支持，LLM 路由可能出错（跳步、选错 agent）
 *   - 确定性路由保证每个阶段都走正确的 agent + 工具
 *   - orchestrator 只在需要判断的环节参与（审稿评分、质检判定）
 *
 * 架构:
 *   用户输入 → detectIntent()
 *     → new_project: 创建项目
 *     → workflow: 确定性路由到 agent + 工具
 *     → advance: 用户确认推进
 *     → chat: 普通对话
 *     → status: 进度查询
 */
import * as store from "../store.js";
import { checkPreconditions, getPhaseInfo, advancePhase, gateQuestionAfter, type Phase } from "../workflow.js";
import { dispatchTool, enforceReviewAfterWrite } from "../agents/runner.js";
import type { AgentName, SSEEvent } from "../types.js";

// ===== 意图类型 =====
export type Intent =
  | { type: "workflow"; phase: Phase; input: string }
  | { type: "advance"; input: string }
  | { type: "status" }
  | { type: "chat"; input: string }
  | { type: "new_project"; input: string }
  | { type: "unknown"; input: string };

// ===== 关键词意图识别（确定性，不依赖 LLM） =====
export function detectIntent(
  input: string,
  project: { id: string; name: string; genre: string; premise: string; currentPhase: number } | null,
): Intent {
  const lower = input.toLowerCase().trim();

  // 项目不存在 → 创建
  if (!project) return { type: "new_project", input };

  // 进度查询
  if (/进度|状态|现在到哪|当前阶段|到哪了|进展|看了没|什么情况|完成到/.test(lower)) {
    return { type: "status" };
  }

  // 用户确认推进（简短肯定词）
  if (/^(好|行|可以|确认|继续|下一步|下个|推进|ok|yes|y|嗯|对|是的?|好的?|确认进入|开始下一)$/.test(lower)) {
    return { type: "advance", input };
  }
  if (/继续下一步|进入下一阶段|开始下一|推进到|确认进入/.test(lower)) {
    return { type: "advance", input };
  }

  // 创作相关关键词 → 工作流
  if (/写|创作|扫榜|三江|拆书|大纲|角色|审稿|质检|润色|继续写|下一章|新章|正文|仿写|代笔|代写/.test(lower)) {
    return { type: "workflow", phase: project.currentPhase as Phase, input };
  }

  // 默认 → 普通聊天
  return { type: "chat", input };
}

// ===== 阶段 → agent + 工具映射 =====
interface PhaseRoute {
  agent: AgentName;
  tool: string;
  taskPrefix: string;
}

const PHASE_ROUTES: Record<number, PhaseRoute> = {
  1: { agent: "story-architect", tool: "scan_bestseller", taskPrefix: "扫榜调研" },
  2: { agent: "story-architect", tool: "analyze_novel", taskPrefix: "拆书解构" },
  3: { agent: "character-designer", tool: "manage_character", taskPrefix: "定文风定位/角色架构" },
  4: { agent: "story-architect", tool: "generate_outline", taskPrefix: "大纲搭建" },
  // 阶段 5 走 continue_writing, 不走 ghostwrite:
  //   continue_writing 才有 buildWritingContext 三层滚动注入 (远章摘要 + 近2章原文 +
  //   角色滚动状态 + 未回收伏笔) 和写后闭环 (摘要入库 + 角色状态更新);
  //   ghostwrite 只有简版上下文且没有写后闭环 —— 连续写几章必然越写越偏、前后矛盾。
  5: { agent: "narrative-writer", tool: "continue_writing", taskPrefix: "正文写作（story-explorer预加载上下文）" },
  // 对齐 workflow.ts PHASES: 阶段 6 初审归审核 agent, 阶段 8 终审归主 Agent
  6: { agent: "consistency-checker", tool: "review_chapter", taskPrefix: "初审质检" },
  7: { agent: "consistency-checker", tool: "quality_check", taskPrefix: "36维质检" },
  8: { agent: "orchestrator", tool: "export_project_data", taskPrefix: "终审定稿" },
};

// ===== 工作流执行器 — 确定性路由 =====
export async function executeWorkflow(
  pid: string,
  phase: Phase,
  userInput: string,
  emit: (evt: SSEEvent) => void,
  /** 仅阶段 5 生效: 一次连续写多少章 (1~10)。每章独立构建上下文, 互不累积。 */
  chapterCount = 1,
): Promise<string> {
  const proj = store.getProject(pid);
  if (!proj) return JSON.stringify({ error: "项目不存在" });

  const state = store.getProjectState(pid);
  const phaseInfo = getPhaseInfo(phase);
  const route = PHASE_ROUTES[phase];
  if (!route) return JSON.stringify({ error: `未知阶段: ${phase}` });

  const agentName = route.agent;
  const toolName = route.tool;

  // ---- 天衍决策思考（seeded by deterministic routing）----
  emit({ type: "think_start", agent: "orchestrator", round: 1 });
  emitThinkToken(emit, "orchestrator", `当前项目「${proj.name}」，类型「${proj.genre}」\n`);
  emitThinkToken(emit, "orchestrator", `处于第${phase}阶段: ${phaseInfo?.name || "未知"}\n`);
  emitThinkToken(emit, "orchestrator", `→ 派发给 @${agentName} 执行「${route.taskPrefix}」\n`);
  emitThinkEnd(emit, "orchestrator", true, `路由到第${phase}阶段`);

  // ---- 根据阶段确定工具参数 ----
  let toolArgs: Record<string, unknown> = {};
  let inputSummary = "";
  const chapters = store.listChapters(pid);

  switch (phase) {
    case 1: {
      toolArgs = { platform: "起点", genre: proj.genre };
      inputSummary = `扫描「${proj.genre}」类型在起点平台的畅销榜数据`;
      break;
    }
    case 2: {
      toolArgs = { text: `分析${proj.genre}类型对标畅销作品，拆解钩子、节奏、人设、文风特征`, genre: proj.genre };
      inputSummary = `拆解「${proj.genre}」类型对标作品`;
      break;
    }
    case 3: {
      toolArgs = { action: "create", name: proj.premise || "主角", personality: "待定", role: "主角" };
      inputSummary = "建立主角角色档案";
      break;
    }
    case 4: {
      toolArgs = { title: proj.name, num_chapters: 10, genre: proj.genre, premise: proj.premise };
      inputSummary = `为「${proj.name}」生成全书大纲`;
      break;
    }
    case 5: {
      // continue_writing 的参数是 { chapter_id, instruction, length, replace }。
      // 空章节用 outline 拼成 instruction 传入, 而不是 ghostwrite 的 outline_text/word_count。
      const lastChapter = chapters[chapters.length - 1];
      if (lastChapter?.content) {
        // 已有正文 → 追加续写最后一章
        toolArgs = { chapter_id: lastChapter.id, instruction: userInput || "续写本段", length: 2000 };
        inputSummary = `续写「${lastChapter.title}」`;
      } else {
        // 尚无正文 → 挑第一个空章节开写 (按 idx 升序, 保证按大纲顺序推进)
        const firstEmpty = chapters.filter(c => !c.content).sort((a, b) => a.idx - b.idx)[0] || lastChapter;
        if (firstEmpty) {
          const outlineText = firstEmpty.outline || userInput || "按照大纲创作";
          toolArgs = {
            chapter_id: firstEmpty.id,
            instruction: `按本章大纲写作：${outlineText}`,
            length: 3000,
          };
          inputSummary = `创作「${firstEmpty.title}」`;
        } else {
          // 一章都没有 → 先建一个空章节作为落点, 否则 continue_writing 会自己造"第一章"
          const newId = store.addChapter(pid, `第1章`, 1, userInput || "", "");
          toolArgs = { chapter_id: newId, instruction: `按大纲写作：${userInput || "第一章"}`, length: 3000 };
          inputSummary = "创作「第1章」";
        }
      }
      break;
    }
    case 6: {
      const lastCh6 = chapters[chapters.length - 1];
      if (lastCh6) {
        toolArgs = { chapter_id: lastCh6.id };
        inputSummary = `审查「${lastCh6.title}」`;
      } else {
        emitThinkEnd(emit, "orchestrator", false, "无可审章节");
        return JSON.stringify({ error: "无章节可审" });
      }
      break;
    }
    case 7: {
      const lastCh7 = chapters[chapters.length - 1];
      if (lastCh7) {
        toolArgs = { chapter_id: lastCh7.id, text: lastCh7.content };
        inputSummary = `36维质检「${lastCh7.title}」`;
      } else {
        emitThinkEnd(emit, "orchestrator", false, "无可质检章节");
        return JSON.stringify({ error: "无章节可质检" });
      }
      break;
    }
    case 8: {
      toolArgs = {};
      inputSummary = "汇总项目数据生成交付报告";
      break;
    }
  }

  emitThinkToken(emit, "orchestrator", `→ 执行工具: ${toolName} (${inputSummary})\n`);

  // ---- 执行工具 ----
  // Phase 5 多 agent 协同: story-explorer 先加载上下文 → narrative-writer 写作
  let result: string = "";
  const t0 = Date.now();
  
  if (phase === 5) {
    // ---- 连续写 N 章 ----
    // 每章都是独立一轮: 重新读章节表 → 重新挑"第一个空章节" → continue_writing 内部
    // 重新 buildWritingContext(滚动注入摘要/近文/角色状态/伏笔) → 写完落库 + 摘要 + 状态。
    // 关键: 绝不把上一章的 toolArgs 或上下文带进下一章, 否则章节越长上下文越脏。
    const totalRounds = Math.max(1, Math.min(10, Math.floor(chapterCount) || 1));
    const written: Array<{ idx: number; title: string; chars: number }> = [];
    const errors: string[] = [];

    for (let round = 1; round <= totalRounds; round++) {
      // 每轮重新取状态, 上一轮写完的章节已入库/摘要已落库
      const chsNow = store.listChapters(pid);
      // 选目标章节: 第一个没正文的 (按 idx); 全都写了就续写最后一章
      const target = chsNow.filter(c => !c.content).sort((a, b) => a.idx - b.idx)[0]
        || chsNow[chsNow.length - 1];

      if (!target) {
        errors.push(`第 ${round} 轮: 项目里没有任何章节, 无法写作 (请先生成大纲)`);
        break;
      }

      // 已写满目标章数就停
      if (written.length > 0 && !chsNow.some(c => !c.content)) break;

      const isAppend = Boolean(target.content);
      const outlineText = target.outline || "";
      const roundArgs = isAppend
        ? { chapter_id: target.id, instruction: userInput || "续写本段", length: 2000 }
        : {
            chapter_id: target.id,
            instruction: outlineText ? `按本章大纲写作：${outlineText}` : (userInput || "按照大纲创作本章正文"),
            length: 3000,
          };

      emit({
        type: "observation", agent: "orchestrator", tool: "chapter_progress",
        result: `【第 ${round}/${totalRounds} 轮】${isAppend ? "续写" : "创作"}「${target.title}」(第${target.idx}章)`,
      });

      // Step 1: story-explorer 加载上下文（只读，为写作准备资料）
      emit({ type: "sub_agent_start", agent: "story-explorer", task: "加载项目上下文、角色状态、伏笔、风格缓存", depth: 1 });
      let contextResult: string;
      try {
        contextResult = await dispatchTool(pid, "load_context", {}, "story-explorer");
      } catch (e) {
        contextResult = JSON.stringify({ error: `上下文加载异常: ${(e as Error).message}` });
      }
      emit({ type: "observation", agent: "story-explorer", tool: "load_context", result: contextResult.slice(0, 2000) });
      emit({ type: "sub_agent_done", agent: "story-explorer", result: "上下文已加载", durationMs: 0 });

      // Step 2: narrative-writer 写作
      emit({ type: "sub_agent_start", agent: "narrative-writer", task: `第${target.idx}章 ${target.title}`, depth: 1 });
      const roundT0 = Date.now();
      let roundResult: string;
      try {
        roundResult = await executePhaseWithAgent(pid, "narrative-writer", toolName, roundArgs, `第${target.idx}章 ${target.title}`, emit);
      } catch (e) {
        roundResult = JSON.stringify({ error: `写作异常: ${(e as Error).message}` });
      }
      emit({ type: "observation", agent: "narrative-writer", tool: toolName, result: roundResult.slice(0, 2000) });
      emit({ type: "sub_agent_done", agent: "narrative-writer", result: roundResult.slice(0, 500), durationMs: Date.now() - roundT0 });

      // 记录本轮结果
      try {
        const parsed = JSON.parse(roundResult) as { error?: string; chars?: number; text?: string };
        if (parsed.error) {
          errors.push(`第${target.idx}章「${target.title}」: ${parsed.error}`);
        } else {
          written.push({ idx: target.idx, title: target.title, chars: Number(parsed.chars) || (parsed.text || "").length });
        }
      } catch {
        written.push({ idx: target.idx, title: target.title, chars: roundResult.length });
      }

      // 最后一轮之外, 给用户一个中断点提示
      if (round < totalRounds && written.length > 0) {
        emit({
          type: "observation", agent: "orchestrator", tool: "chapter_progress",
          result: `已完成 ${written.length}/${totalRounds} 章, 继续下一章...`,
        });
      }
    }

    // 汇总结果 (供后续审核链路与前端展示)
    const summary = {
      chaptersWritten: written.length,
      chapters: written,
      errors,
      requested: totalRounds,
    };
    result = JSON.stringify(summary);
    // 供审核链路使用: 用最后一章的参数
    const lastChForReview = store.listChapters(pid).slice(-1)[0];
    toolArgs = lastChForReview
      ? { chapter_id: lastChForReview.id, instruction: userInput || "", length: 3000 }
      : {};
    emit({ type: "observation", agent: "orchestrator", tool: "chapter_progress", result: `本轮共完成 ${written.length}/${totalRounds} 章` });
  } else {
    // 其他阶段: 直接执行工具（确定性路由）
    emit({ type: "sub_agent_start", agent: agentName, task: inputSummary, depth: 1 });
    try {
      result = await dispatchTool(pid, toolName, toolArgs, agentName);
    } catch (e) {
      result = JSON.stringify({ error: `工具执行异常: ${(e as Error).message}` });
    }
    emit({ type: "observation", agent: agentName, tool: toolName, result: result.slice(0, 2000) });
    emit({ type: "sub_agent_done", agent: agentName, result: result.slice(0, 500), durationMs: Date.now() - t0 });
  }
  const durationMs = Date.now() - t0;

  // ---- 写作完成后自动触发审核链路（36维质检 + 总编评分）----
  let revisionNeeded = false;
  if (phase === 5 && (toolName === "continue_writing" || toolName === "ghostwrite" || toolName === "polish")) {
    try {
      const runId = `engine-${Date.now()}`;
      const projBefore = store.getProjectState(pid).currentPhase;
      await enforceReviewAfterWrite(pid, runId, agentName, toolName, toolArgs, result, [], emit);
      const projAfter = store.getProjectState(pid).currentPhase;
      revisionNeeded = projAfter < projBefore;
    } catch (e) {
      emit({ type: "observation", agent: "orchestrator", tool: "review_error", result: `审核异常: ${(e as Error).message}` });
    }
  }

  // ---- 解析结果 + 后处理 ----
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(result); } catch { /* raw text */ }

  let summary = formatResult(phase, parsed, proj);

  // ---- 审稿打回检查 ----
  if (phase === 6) {
    const score = Number(parsed.score) || 0;
    if (score > 0 && score < 7) {
      summary += "\n\n⚠️ 评分不足 7 分，需要重写。";
      emit({ type: "forced_revision", agent: "orchestrator", score, review: String(parsed.review || ""), chapterId: "", reason: `评分 ${score}/10 < 7` });
      // P2 门禁: 6→5 打回边走 advancePhase 校验 (6 的 allowedNext 是 [7], 打回是状态机特殊边, 校验后落库)
      try {
        const stNow = store.getProjectState(pid);
        const adv = advancePhase(stNow.currentPhase as Phase, 5, stNow as any);
        if (adv.success && adv.newPhase) {
          store.updateProjectPhase(pid, adv.newPhase);
          emit({ type: "phase_advanced", agent: "orchestrator", from: stNow.currentPhase as number, to: 5 });
        } else {
          console.log(`[executeWorkflow] 审稿打回 6→5 被门禁拦截: ${adv.error}`);
        }
      } catch { /* 不阻塞 */ }
      return summary;
    }
  }

  // ---- 质检打回检查 ----
  if (phase === 7) {
    const verdict = String(parsed.verdict || "").toUpperCase();
    if (verdict === "REJECT") {
      summary += "\n\n❌ 质检不通过，需要重写。";
      // P2 门禁: 7→5 是状态机允许的打回边 (7.allowedNext=[5,8]), 强制走 advancePhase 校验
      try {
        const stNow = store.getProjectState(pid);
        const adv = advancePhase(stNow.currentPhase as Phase, 5, stNow as any);
        if (adv.success && adv.newPhase) {
          store.updateProjectPhase(pid, adv.newPhase);
          emit({ type: "phase_advanced", agent: "orchestrator", from: stNow.currentPhase as number, to: 5 });
        } else {
          console.log(`[executeWorkflow] 质检打回 7→5 被门禁拦截: ${adv.error}`);
        }
      } catch { /* 不阻塞 */ }
      return summary;
    }
  }

  // ---- 阶段推进（审核打回时不推进）----
  if (phase < 8 && !revisionNeeded) {
    const nextPhase = (phase + 1) as Phase;
    // P1: 主 agent 询问门禁 — 若刚完成的阶段是门控阶段, 不自动推进, 问用户确认
    // 世界观门 (阶段3) 按项目类型动态生成问题 (高武/低武 vs 都市现实 vs 硬科幻...)
    const gateQ = gateQuestionAfter(phase, proj?.genre);
    if (gateQ) {
      try { store.setPendingGate(pid, nextPhase, gateQ); } catch { /* ignore */ }
      emit({ type: "gate_question", agent: "orchestrator", phase: phase, nextPhase, question: gateQ });
      summary += `\n\n${gateQ}\n（请回复确认或补充细节; 回复"继续"进入第${nextPhase}阶段。）`;
      return summary;
    }
    const nextState = store.getProjectState(pid);
    // P2 门禁: 自动推进强制走 advancePhase 校验 (allowedNext + 前置条件), 不绕过状态机
    const adv = advancePhase(phase, nextPhase, nextState as any);
    if (adv.success && adv.newPhase) {
      try { store.updateProjectPhase(pid, adv.newPhase); } catch { /* ignore */ }
      emit({ type: "phase_advanced", agent: "orchestrator", from: phase, to: nextPhase });
      const nextName = getPhaseInfo(nextPhase)?.name || "";
      summary += `\n\n✅ 已自动推进到第${nextPhase}阶段: ${nextName}。`;
    } else {
      console.log(`[executeWorkflow] 自动推进 ${phase}→${nextPhase} 被门禁拦截: ${adv.error}`);
      summary += `\n\n⏸️ 第${nextPhase}阶段（${getPhaseInfo(nextPhase)?.name}）门禁未放行: ${adv.error}`;
    }
  } else if (revisionNeeded) {
    summary += "\n\n⚠️ 本章审查未通过，已打回重写。请根据编辑意见修改后再次提交。";
  } else {
    summary += "\n\n🎉 全部阶段完成！小说创作流程结束。";
  }

  return summary;
}

// ===== Phase 5 写作: 走 agent loop（有思考过程 + 上下文） =====
async function executePhaseWithAgent(
  pid: string,
  agentName: AgentName,
  toolName: string,
  toolArgs: Record<string, unknown>,
  taskSummary: string,
  emit: (evt: SSEEvent) => void,
): Promise<string> {
  // 对于写作阶段，通过 agent loop 执行（保留思考过程和上下文）
  const proj = store.getProject(pid);
  if (!proj) return JSON.stringify({ error: "项目不存在" });

  const messages: Array<{ role: string; content: string }> = [];
  // 项目上下文
  if (proj) {
    const genreLock = proj.genre ? `【风格锁定】本项目类型为「${proj.genre}」, 全程禁止偏离。` : "";
    messages.push({
      role: "system",
      content: `当前项目: ${proj.name}\n类型: ${proj.genre}\n文风: ${(proj as any).style || ""}\n设定: ${proj.premise}\n${genreLock}`,
    });
  }
  // 角色档案
  const profiles = store.listCharacterProfiles(pid);
  if (profiles.length) {
    messages.push({
      role: "system",
      content: "【角色档案】\n" + profiles.map((p: any) => `- ${p.name}(${p.role || "?"}): ${p.personality || ""}`).join("\n"),
    });
  }
  // 世界观
  const worldEntries = store.listWorldEntries(pid);
  if (worldEntries.length) {
    messages.push({
      role: "system",
      content: "【世界观】\n" + worldEntries.map((w: any) => `- [${w.category}] ${w.name}: ${w.description || ""}`).join("\n"),
    });
  }
  // agent 提示
  const { getAgentPrompt } = await import("../agents/index.js");
  const { AGENT_TOOLS } = await import("../agents/index.js");
  const { getAgentSkillPrompts } = await import("../skills.js");
  const skillPrompts = getAgentSkillPrompts(agentName);
  const skillBlock = skillPrompts.length ? "\n\n" + skillPrompts.join("\n\n") : "";
  messages.push({
    role: "system",
    content: getAgentPrompt(agentName) + skillBlock + "\n\n可用工具: " + AGENT_TOOLS[agentName].join(", ") + "\n调用工具时优先使用 function calling (native tool_calls)。\n如果模型不支持 function calling，输出一行 JSON: {\"tool\": \"工具名\", \"args\": {...}}。\n否则直接回复。",
  });
  // 任务指令
  const toolArgsStr = JSON.stringify(toolArgs);
  messages.push({ role: "user", content: `任务: ${taskSummary}\n工具: ${toolName}\n参数: ${toolArgsStr}\n\n请执行该任务。` });

  // 通过 agent loop 执行（保留思考过程）
  const { runAgentLoop } = await import("../agents/runner.js");
  const runId = `phase5-${Date.now()}`;
  return await runAgentLoop({
    pid,
    agentName,
    messages,
    depth: 0,
    runId,
    delegationLog: [],
    emit,
    sharedSteps: { value: 0 },
  });
}

// ===== 结果格式化 =====
function formatResult(phase: number, parsed: Record<string, unknown>, proj: any): string {
  switch (phase) {
    case 1: {
      const books = (parsed.items || parsed.books || []) as any[];
      const count = parsed.count || books.length || 0;
      let s = `📊 扫榜调研完成: 「${proj.genre}」类型找到 ${count} 本热门作品:\n\n`;
      for (const b of books.slice(0, 5)) {
        const title = b.title || b.name || "未知";
        const author = b.author || "";
        s += `  📕 ${title}${author ? ` (作者: ${author})` : ""}\n`;
      }
      if (parsed.analysis) s += `\n💡 市场分析:\n${String(parsed.analysis).slice(0, 1000)}`;
      return s;
    }
    case 2: {
      const analysis = parsed.analysis || parsed.result || "";
      return `📖 拆书解构完成:\n\n${typeof analysis === "string" ? analysis.slice(0, 1500) : JSON.stringify(analysis).slice(0, 1500)}`;
    }
    case 3: {
      const name = String(parsed.name || '') || String((parsed.character as Record<string,unknown>)?.name || '') || '';
      return `👤 角色档案已创建: ${name || "主角"}。可以继续补充性格、外貌、动机等设定。`;
    }
    case 4: {
      const outline = parsed.outline || parsed.result || "";
      const chapters = parsed.chapters || parsed.chapterTitles || [];
      let s = `📐 大纲搭建完成！「${proj.name}」共 ${Array.isArray(chapters) ? chapters.length : "?"} 章\n\n`;
      if (typeof outline === "string") s += outline.slice(0, 1200);
      return s;
    }
    case 5: {
      const text = parsed.text || parsed.ghostwritten_text || "";
      const chars = parsed.chars || (typeof text === "string" ? text.length : 0);
      const replaced = parsed.replaced ? " (已替换旧内容)" : " (已追加)";
      return `✍️ 正文写作完成，共 ${chars} 字${replaced}。\n\n${typeof text === "string" ? text.slice(0, 800) + (text.length > 800 ? "..." : "") : ""}`;
    }
    case 6: {
      const score = parsed.score ?? "?";
      const review = parsed.review || "";
      const status = parsed.status || "";
      let s = `🎯 毒舌审稿完成\n\n  评分: ${score}/10\n  状态: ${status === "reviewed" ? "通过" : status === "revision_needed" ? "需重写" : status}\n\n`;
      if (typeof review === "string") s += review.slice(0, 1000);
      return s;
    }
    case 7: {
      const overall = parsed.overall_score ?? "?";
      const verdict = parsed.verdict || "?";
      const dims = parsed.dimensions_passed || "?";
      let s = `🔍 36维质检完成\n\n  总分: ${overall}/10\n  判定: ${verdict}\n  维度通过: ${dims}/36\n`;
      const findings = (parsed.findings || []) as Array<Record<string, unknown>>;
      if (findings.length) {
        s += `\n  主要问题:\n`;
        for (const f of findings.slice(0, 5)) {
          s += `    ${f.severity} #${f.dimension_id} ${f.dimension}: ${f.issue || ""}\n`;
        }
      }
      return s;
    }
    case 8: {
      const report = parsed.report || parsed.result || "";
      const stats2 = parsed.stats || {};
      let s = `📦 项目「${proj.name}」定稿完成\n\n`;
      if (typeof report === "string") s += report.slice(0, 1500);
      else s += JSON.stringify(stats2).slice(0, 500);
      return s;
    }
    default:
      return JSON.stringify(parsed).slice(0, 2000);
  }
}

function emitThinkToken(emit: (evt: SSEEvent) => void, agent: AgentName, text: string) {
  emit({ type: "think_token", agent, text });
}

function emitThinkEnd(emit: (evt: SSEEvent) => void, agent: AgentName, feasible: boolean, reason: string) {
  emit({ type: "think_end", agent, feasible, reason, plan: [], missing: "" });
}

// ===== 进度查询 =====
export function getProjectProgress(pid: string): string {
  const proj = store.getProject(pid);
  if (!proj) return "❌ 项目不存在";
  const state = store.getProjectState(pid);
  const chapters = store.listChapters(pid);
  const profiles = store.listCharacterProfiles(pid);
  const world = store.listWorldEntries(pid);

  const phaseNames: Record<number, string> = {
    1: "扫榜调研", 2: "拆书解构", 3: "定文风定位", 4: "大纲搭建",
    5: "正文写作", 6: "初审质检", 7: "打回返修", 8: "终审定稿",
  };

  let s = `📋 项目「${proj.name}」进度\n`;
  s += `类型: ${proj.genre} | 文风: ${(proj as any).style || ""}\n`;
  s += `角色: ${profiles.length}个 | 世界观: ${world.length}条 | 章节: ${chapters.length}章\n\n`;
  s += `当前阶段: Phase ${state.currentPhase} - ${phaseNames[state.currentPhase] || "未知"}\n\n`;

  for (let i = 1; i <= 8; i++) {
    const icon = i < state.currentPhase ? "✅" : i === state.currentPhase ? "🔄" : "⬜";
    s += `  ${icon} Phase ${i}: ${phaseNames[i]}\n`;
  }

  if (state.currentPhase < 8) {
    const nextName = phaseNames[state.currentPhase + 1] || "";
    s += `\n💡 下一步: Phase ${state.currentPhase + 1} - ${nextName}`;
  } else {
    s += `\n🎉 全部完成！`;
  }

  return s;
}
