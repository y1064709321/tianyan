// 天衍 (Tianyan) — TypeScript 重写版入口
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { corsMiddleware, authMiddleware } from "./security/auth.js";
import { loadSettings, getSettings, updateModelConfig, removeModelConfig, updateAgentConfig, updateGlobalSettings, getAgentConfigs, PROVIDER_PRESETS } from "./config.js";
import { initLogger, logInfo, logWarn, logError, capLooseLogs } from "./logger.js";
import * as store from "./store.js";
import { initDb, createProject, getProject, listProjects, deleteProject, stats } from "./store.js";
import * as memory from "./memory/index.js";
import { executeCode } from "./security/sandbox.js";
import { chat, testConnection, friendlyError } from "./llm.js";
import { runAgentLoop } from "./agents/runner.js";
import { detectIntent, executeWorkflow, getProjectProgress } from "./perception/engine.js";
import { plan as plannerPlan } from "./planner.js";
import { setArcTarget } from "./arc.js";
import type { Phase } from "./workflow.js";
import { BUILTIN_SKILLS, isBuiltinEnabled, setBuiltinEnabled, listCustomSkills, addCustomSkill, removeCustomSkill, setCustomSkillEnabled, getAgentSkillPrompts } from "./skills.js";
import { getMeta, isValid, isReadonly, AGENT_TOOLS, getMaxDelegateDepth, DEFAULT_AGENT, AGENT_META, getAgentPrompt, WORKFLOW_PHASES } from "./agents/index.js";
import type { SSEEvent, AgentName } from "./types.js";
import { cancelRun, clearRunCancel } from "./runCancel.js";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

loadSettings();
initDb();
initLogger(getSettings().dataDir); // 后台日志 -> {dataDir}/tianyan.log (100MB 上限自动轮转)
capLooseLogs(); // 启动时给无上限重定向日志 (server.log/run.log 等) 设 50MB 截断上限

const app = new Hono();
const s = getSettings();
app.use("*", corsMiddleware());
app.use("*", authMiddleware());

// ===== 健康检查 =====
app.get("/api/health", (c) => c.json({ status: "ok", version: "0.1.0-ts" }));

// ===== 配置 =====
app.get("/api/config", (c) => {
  const safeModels = s.models.map((m) => ({ ...m, apiKey: undefined, api_key: undefined, api_key_set: !!m.apiKey }));
  const safeDefault = { ...s.defaultModel, apiKey: undefined, api_key: undefined, api_key_set: !!s.defaultModel.apiKey };
  const hasKey = !!s.defaultModel.apiKey;
  return c.json({ defaultModel: safeDefault, models: safeModels, providers: PROVIDER_PRESETS, ready: hasKey, default: s.defaultModel.model });
});
app.get("/api/config/models", (c) => {
  const safeModels = s.models.map((m) => ({ ...m, apiKey: undefined, api_key: undefined, api_key_set: !!m.apiKey }));
  return c.json({ models: safeModels, providers: PROVIDER_PRESETS });
});
app.put("/api/config/model", async (c) => {
  const body = await c.req.json<{ model: string }>();
  if (body.model) {
    s.defaultModel.model = body.model;
    const found = s.models.find((m) => m.model === body.model);
    if (found) s.defaultModel = found;
  }
  return c.json({ ok: true, defaultModel: s.defaultModel });
});
app.post("/api/config/test-connection", async (c) => {
  let body: { model?: string; api_key?: string; api_base?: string } = {};
  try { body = await c.req.json(); } catch { /* 空body用默认配置 */ }
  const s = getSettings();
  const modelName = body.model || s.defaultModel.model;
  return c.json(await testConnection({
    model: modelName,
    apiKey: body.api_key || s.defaultModel.apiKey,
    apiBase: body.api_base || s.defaultModel.apiBase,
    temperature: 0.8,
    maxTokens: 100,
  }));
});

// ===== 设置 =====
app.get("/api/settings", (c) => {
  // 脱敏: 不暴露 apiKey 明文, 只标记是否已设置
  const safeModels = s.models.map((m) => ({
    ...m,
    // 统一 snake_case 字段给前端 (ModelConfig 内部用 camelCase, 前端面板读 snake_case)
    max_tokens: m.maxTokens || 4096,
    temperature: m.temperature ?? 0.8,
    apiKey: undefined,
    api_key: undefined,
    api_key_set: !!m.apiKey,
    ready: !!m.apiKey,
    api_base: (m as any).apiBase || (m as any).api_base || "",
  }));
  const safeDefault = { ...s.defaultModel, apiKey: undefined, api_key: undefined, ready: !!s.defaultModel.apiKey, api_key_set: !!s.defaultModel.apiKey };
  const current = s.defaultModel.model;
  return c.json({
    default: current, ready: !!s.defaultModel.apiKey,
    defaultModel: safeDefault,
    models: safeModels.map((m) => ({ ...m, is_default: m.model === current })),
    providers: PROVIDER_PRESETS,
    maxSteps: s.maxSteps, max_steps: s.maxSteps,
    runMaxTokens: s.runMaxTokens, run_max_tokens: s.runMaxTokens,
    runMaxCost: s.runMaxCost, run_max_cost: s.runMaxCost,
    loopDetectCount: s.loopDetectCount, loop_detect_count: s.loopDetectCount,
    runMaxDuration: s.runMaxDuration, run_max_duration: s.runMaxDuration,
    sseHeartbeatInterval: s.sseHeartbeatInterval,
    chunkSize: s.chunkSize, chunk_size: s.chunkSize,
    chunkOverlap: s.chunkOverlap, chunk_overlap: s.chunkOverlap,
    retrieveK: s.retrieveK, retrieve_k: s.retrieveK,
    proxy: s.proxy, serverPort: s.serverPort,
    agents: getAgentConfigs(),
  });
});
// 前端日志上报通道 (2026-10-02 用户要求: 前端"不渲染了"查不到原因, 因为 console 只在浏览器, 发不回后端):
// 前端 window.onerror / console.error 拦截后 POST 到这里, 写进 tianyan.log, 下次前端断渲染直接看日志。
// 只接收+记日志, 不入库、不回显内容 (避免成为敏感数据中转)。
app.post("/api/client-log", async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const level = typeof body?.level === "string" ? body.level : "info";
    const msg = typeof body?.msg === "string" ? body.msg.slice(0, 500) : "(empty)";
    const ctx = body?.ctx ? JSON.stringify(body.ctx).slice(0, 300) : "";
    logWarn(`[client-log] ${level}: ${msg} ${ctx}`.slice(0, 900));
    return c.json({ ok: true });
  } catch (e) {
    logError(`[client-log] 处理失败: ${(e as Error).message?.slice(0, 100)}`);
    return c.json({ ok: false }, 500);
  }
});
app.get("/api/settings/model/key", (c) => {
  const model = c.req.query("model");
  if (!model) return c.json({ error: "missing model" }, 400);
  const s = getSettings();
  const m = s.models.find((x) => x.model === model);
  // P0 修复: 永不明文回传 API key (旧实现 return { api_key: m.apiKey } 是明文泄漏向量)。
  // 只回 "是否已设置 + 前缀" 供 UI 判断; 前端 (app.js L3321) 本来就只用 api_key_set, 不消费明文 key
  return c.json({ api_key_set: !!m?.apiKey, api_key_prefix: m?.apiKey ? m.apiKey.slice(0, 8) + "…" : "" });
});
app.put("/api/settings/model", async (c) => {
  const body = await c.req.json<{ model: string; api_key?: string; api_base?: string; temperature?: number; max_tokens?: number }>();
  updateModelConfig(body.model, { apiKey: body.api_key, apiBase: body.api_base, temperature: body.temperature, maxTokens: body.max_tokens });
  return c.json({ ok: true });
});
app.delete("/api/settings/model", async (c) => {
  const body = await c.req.json<{ model: string }>();
  removeModelConfig(body.model);
  return c.json({ ok: true });
});

// ===== 服务端"获取所有模型" (对齐 Hermes model_metadata.py: GET {base}/v1/models) =====
// ?model=xx 用该已配模型的 apiBase+apiKey 探测; 或 ?base=xx&key=xx 显式; force=1 强制刷新缓存
import { discoverModels, getProviderModelFallback } from "./llm.js";
app.get("/api/models/discover", async (c) => {
  const model = c.req.query("model") || undefined;
  const base = c.req.query("base") || undefined;
  const key = c.req.query("key") || undefined;
  const provider = c.req.query("provider") || undefined;
  const force = c.req.query("force") === "1";
  const r = await discoverModels({ model, base, key, provider, forceRefresh: force });
  // 拉取失败时回退该 provider 上次成功清单 (前端"拉取"永远有东西可选, 不空白)
  const fallback = r.models.length === 0 && provider ? getProviderModelFallback(provider) : [];
  const models = r.models.length > 0 ? r.models : fallback;
  // 脱敏: 不把 key 回显
  return c.json({
    ok: models.length > 0, provider: r.provider, base: r.base, source: r.source,
    count: models.length, models, error: models.length === 0 ? r.error : undefined,
  });
});
app.put("/api/settings/agent", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  try {
    // 全局参数
    updateGlobalSettings({
      maxSteps: body.max_steps !== undefined ? Number(body.max_steps) : undefined,
      chunkSize: body.chunk_size !== undefined ? Number(body.chunk_size) : undefined,
      retrieveK: body.retrieve_k !== undefined ? Number(body.retrieve_k) : undefined,
      runMaxTokens: body.run_max_tokens !== undefined ? Number(body.run_max_tokens) : undefined,
      runMaxCost: body.run_max_cost !== undefined ? Number(body.run_max_cost) : undefined,
      runMaxDuration: body.run_max_duration !== undefined ? Number(body.run_max_duration) : undefined,
      loopDetectCount: body.loop_detect_count !== undefined ? Number(body.loop_detect_count) : undefined,
    });
    // 每个 Agent 的参数
    const agentBodies = body.agents;
    if (agentBodies && typeof agentBodies === "object") {
      for (const [name, cfg] of Object.entries(agentBodies as Record<string, Record<string, unknown>>)) {
        updateAgentConfig(name, {
          maxDepth: cfg.max_depth !== undefined ? Number(cfg.max_depth) : undefined,
          maxTurns: cfg.max_turns !== undefined ? Number(cfg.max_turns) : undefined,
          maxSteps: cfg.max_steps !== undefined ? Number(cfg.max_steps) : undefined,
          modelTier: cfg.model_tier !== undefined ? String(cfg.model_tier) : undefined,
          readonly: cfg.readonly !== undefined ? Boolean(cfg.readonly) : undefined,
        });
      }
    }
    return c.json({ ok: true, settings: getAgentConfigs() });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

// ===== 模型档位映射 (tier → 模型): 前端可配"哪档用哪个模型", 识别闭环 =====
import { getModelTierMap, setModelTierMap, pickModelForAgent } from "./config.js";
app.get("/api/settings/tier-model", (c) => {
  const s = getSettings();
  // 每个 agent 当前 tier + 实际会解析到的模型 (给前端预览"识别结果")
  const preview: Record<string, { tier: string; model: string }> = {};
  for (const an of Object.keys(s.agents)) {
    const m = pickModelForAgent(an as any);
    preview[an] = { tier: s.agents[an]?.modelTier || "mid", model: m.model };
  }
  return c.json({ tiers: getModelTierMap(), preview, availableModels: s.models.map((m) => m.model) });
});
app.put("/api/settings/tier-model", async (c) => {
  const body = await c.req.json<{ high?: string; mid?: string; low?: string }>();
  const map: Record<string, string> = {};
  if (body.high) map.high = body.high;
  if (body.mid) map.mid = body.mid;
  if (body.low) map.low = body.low;
  setModelTierMap(map as any);
  return c.json({ ok: true, tiers: getModelTierMap() });
});

// ===== 项目管理 =====
app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name: string; genre?: string; premise?: string; style?: string; audience?: string; chapters?: string[] }>();
  const id = createProject(body.name, body.genre, body.premise, body.style, body.audience);
  // 批量创建章节 (如果提供了章节列表)
  const chapters = body.chapters || [];
  const createdChapters = chapters.map((title, idx) => {
    const cid = store.addChapter(id, title, idx);
    return { id: cid, title, idx, status: "draft" };
  });
  return c.json({ id, ...body, chapters: createdChapters });
});
app.get("/api/projects", (c) => c.json(listProjects()));
app.get("/api/projects/:pid", (c) => {
  const p = getProject(c.req.param("pid"));
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json({
    ...p,
    chapters: store.listChapters(p.id),
    elements: store.listElements(p.id),
    stats: stats(p.id),
  });
});
app.delete("/api/projects/:pid", (c) => {
  deleteProject(c.req.param("pid"));
  return c.json({ ok: true });
});

// ===== 章节管理 =====
app.get("/api/chapters/:cid", (c) => {
  const ch = store.getChapter(c.req.param("cid"));
  if (!ch) return c.json({ error: "not found" }, 404);
  return c.json(ch);
});
app.get("/api/projects/:pid/chapters", (c) => c.json(store.listChapters(c.req.param("pid"))));
app.post("/api/projects/:pid/chapters", async (c) => {
  const body = await c.req.json<{ title: string; idx?: number; outline?: string; content?: string }>();
  const id = store.addChapter(c.req.param("pid"), body.title, body.idx ?? 0, body.outline, body.content);
  return c.json({ id, ...body });
});
app.put("/api/chapters/:cid", async (c) => {
  const body = await c.req.json<{ title?: string; outline?: string; content?: string; status?: string }>();
  store.updateChapter(c.req.param("cid"), body);
  return c.json({ ok: true });
});
app.delete("/api/chapters/:cid", (c) => {
  store.deleteChapter(c.req.param("cid"));
  return c.json({ ok: true });
});

// ===== 元素管理 =====
app.get("/api/projects/:pid/elements", (c) => c.json(store.listElements(c.req.param("pid"))));
app.post("/api/projects/:pid/elements", async (c) => {
  const body = await c.req.json<{ kind: string; name: string; detail: string }>();
  const id = store.addElement(c.req.param("pid"), body.kind, body.name, body.detail);
  return c.json({ id, kind: body.kind, name: body.name, detail: body.detail });
});
app.delete("/api/elements/:eid", (c) => {
  store.deleteElement(c.req.param("eid"));
  return c.json({ ok: true });
});

// ===== 消息管理 =====
app.get("/api/projects/:pid/messages", (c) => c.json(store.listMessages(c.req.param("pid"))));
app.delete("/api/projects/:pid/messages", (c) => {
  const count = store.deleteMessages(c.req.param("pid"));
  return c.json({ ok: true, deleted: count });
});
// 人工触发清理历史乱码消息 (启动时不再自动删, 避免误删/丢数据)
app.post("/api/admin/clean-garbled", (c) => {
  const deleted = store.cleanGarbledMessages();
  return c.json({ ok: true, deleted });
});

// ===== Runs =====
app.get("/api/projects/:pid/runs", (c) => c.json(store.listRuns(c.req.param("pid"))));
app.get("/api/runs/:runId", (c) => {
  const run = store.getRun(c.req.param("runId"));
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json(run);
});
app.delete("/api/runs/:runId", (c) => {
  store.deleteRun(c.req.param("runId"));
  return c.json({ ok: true });
});

/**
 * 停止正在执行的 run。
 * 前端点「停止」时调这个 —— 光是断开 SSE 没用, 后端那个 run 还会继续跑完(继续烧 token)。
 * 这里标记后, runner 主循环 / 流式 chunk 循环会协作式退出并 finishRun(status="cancelled")。
 */
app.post("/api/runs/:runId/cancel", (c) => {
  const runId = c.req.param("runId");
  const run = store.getRun(runId);
  if (!run) return c.json({ error: "run 不存在" }, 404);
  if (run.status !== "running") {
    return c.json({ ok: true, alreadyFinished: true, status: run.status });
  }
  cancelRun(runId);
  logInfo(`[停止] 用户取消 run=${runId} pid=${run.projectId}`);
  return c.json({ ok: true, cancelled: true });
});

// ===== Metrics =====
app.get("/api/projects/:pid/metrics", (c) => {
  const db = store.getDb();
  const pid = c.req.param("pid");
  const totalChapters = (db.prepare("SELECT COUNT(*) as cnt FROM chapters WHERE project_id=?").get(pid) as any).cnt;
  const completedChapters = (db.prepare("SELECT COUNT(*) as cnt FROM chapters WHERE project_id=? AND status='done'").get(pid) as any).cnt;
  const writingChapters = (db.prepare("SELECT COUNT(*) as cnt FROM chapters WHERE project_id=? AND status='writing'").get(pid) as any).cnt;
  const totalChars = (db.prepare("SELECT COALESCE(SUM(LENGTH(content)),0) as cnt FROM chapters WHERE project_id=?").get(pid) as any).cnt;
  return c.json({ totalChapters, completedChapters, totalChars, writingChapters });
});

// ===== Sources / 搜索 =====
app.get("/api/projects/:pid/sources", (c) => c.json(store.listChunks(c.req.param("pid"))));
app.get("/api/projects/:pid/search", (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json([]);
  return c.json(store.searchMessages(c.req.param("pid"), q));
});

// ===== Upload =====
app.post("/api/projects/:pid/upload", async (c) => {
  const pid = c.req.param("pid");
  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    const results: Array<{ name: string; chunks: number; size: number }> = [];
    for (const file of files) {
      const text = await file.text();
      const chunkSize = s.chunkSize;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
      }
      for (let i = 0; i < chunks.length; i++) {
        store.addChunk(pid, file.name, i, chunks[i]!);
      }
      results.push({ name: file.name, chunks: chunks.length, size: file.size });
    }
    return c.json({ ok: true, files: results });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// ===== Export =====
app.get("/api/projects/:pid/export", (c) => {
  const fmt = c.req.query("fmt") || "txt";
  const data = store.getExportData(c.req.param("pid"), fmt);
  if (fmt === "json") return c.json(data);
  return new Response((data as { text: string }).text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// ===== 记忆 API =====
app.get("/api/projects/:pid/memories/short", (c) => {
  const sid = c.req.query("session_id") || "default";
  return c.json(memory.getSessionMemories(c.req.param("pid"), sid));
});
app.get("/api/projects/:pid/memories/long", (c) => {
  return c.json(memory.getLongTermMemories(c.req.param("pid")));
});
app.post("/api/projects/:pid/memories/short", async (c) => {
  const body = await c.req.json<{ session_id?: string; category: string; topic: string; content: string }>();
  const sid = body.session_id || "default";
  const id = memory.saveSessionMemory(c.req.param("pid"), sid, body.category, body.topic, body.content, "user");
  return c.json({ ok: true, id });
});
app.post("/api/projects/:pid/memories/long", async (c) => {
  const body = await c.req.json<{ category: string; topic: string; content: string; priority?: number }>();
  const id = memory.saveLongTermMemory(c.req.param("pid"), body.category, body.topic, body.content, "user", body.priority || 5);
  return c.json({ ok: true, id });
});
app.get("/api/projects/:pid/memory", (c) => {
  const longMems = memory.getLongTermMemories(c.req.param("pid"));
  const context = memory.getMemoryContext(c.req.param("pid"));
  return c.json({ longTerm: longMems, context });
});
app.get("/api/projects/:pid/memory/search", (c) => {
  const q = c.req.query("q") || "";
  return c.json(memory.searchLongTermMemories(c.req.param("pid"), q));
});

// ===== 计划/审批/检查点 (占位) =====
app.get("/api/projects/:pid/plan", (c) => c.json({ plan: [] }));
app.post("/api/projects/:pid/plan", async (c) => c.json({ ok: true }));
app.get("/api/projects/:pid/approvals", (c) => c.json([]));
app.post("/api/approvals/:requestId/approve", async (c) => c.json({ ok: true }));
app.post("/api/approvals/:requestId/reject", (async (c) => c.json({ ok: true })));
app.get("/api/projects/:pid/checkpoints", (c) => c.json([]));
app.get("/api/projects/:pid/checkpoints/latest", (c) => c.json(null));
app.get("/api/launcher/restart", (c) => c.json({ ok: true, message: "TS版不支持热重启" }));
app.get("/launcher", (c) => c.json({ ok: true }));

// ===== Agent 运行 (SSE) =====

// 路线A (2026-09-28): 快路径决策思考 — 真实模型生成, 绝不合成假思考
// 用户原则: LLM 就是大脑 (负责思考 + 决定用哪些工具), 前端只是把它的真实思考映射渲染出来。
// 快路径以前硬编码 "调用 X 工具..." 字符串冒充思考 → 现在改成真调一次轻量模型生成真实决策理由。
// 模型调用失败/限流时: 诚实标注 "⚡快路径·未生成推理", 不编造。
async function fastPathDecision(userInput: string, targetAgentLabel: string, toolName: string): Promise<{ reason: string; thinking: string }> {
  try {
    const resp = await chat([
      { role: "system", content: "你是天衍主 agent 总编。用户输入触发了快路径工具委派, 请写出你的真实决策: 第一行以\"决策:\"开头, 说明委派给谁、用哪个工具、为什么(30字内); 第二行补充一句推理。不要写代码, 不要超过两行。" },
      { role: "user", content: `用户输入: ${userInput.slice(0, 200)}\n(快路径已判定: 委派 ${targetAgentLabel} 运行 ${toolName} 工具)` },
    ], undefined, { temperature: 0.3, maxTokens: 150 });
    const text = (resp.content || "").trim();
    if (text) {
      const lines = text.split("\n").filter((l: string) => l.trim());
      const first = lines[0]?.startsWith("决策:") ? lines[0].replace(/^决策[:：]\s*/, "") : `委派 ${targetAgentLabel} 运行 ${toolName} 工具`;
      const rest = lines.slice(1).join("\n") || "";
      return { reason: first.slice(0, 100), thinking: rest || first };
    }
  } catch (e) {
    logWarn(`[快路径决策] 模型推理调用失败: ${(e as Error).message?.slice(0, 80)} → 诚实标注, 不合成假思考`);
  }
  return { reason: `⚡快路径 · 委派 ${targetAgentLabel} 运行 ${toolName} (模型推理未生成, 代码确定性路由)`, thinking: "" };
}

// 路线A+ (2026-09-28): 快路径模型自主选工具 — "模型=大脑" 原则的完整落地
// 用户原则: LLM 负责思考 + 决定用哪些工具执行程序; 前端只映射渲染, 绝不拿假字符串冒充思考。
// 快路径以前硬编码 "scan_bestseller 工具..." 冒充思考且工具由代码定 → 现在:
//   1. 把目标 agent 的工具 schema (native tool_calls) 挂给模型
//   2. 模型真实推理 (reasoningContent) + 自主选工具 + 填参数
//   3. 思考链 = 模型真实 reasoning + "我决定调用 X 工具, 参数 Y, 因为 Z"
//   4. 模型没选工具/调用失败 → 诚实标注 "⚡ 快路径·模型未选择工具", 回退确定性 dispatchTool 兜底
async function fastPathToolDecision(
  userInput: string,
  targetAgent: string,
  targetAgentLabel: string,
  fallbackToolName: string,
): Promise<{ reason: string; thinking: string; toolName: string; toolArgs: Record<string, unknown>; modelPicked: boolean }> {
  try {
    const { getToolDefinitions } = await import("./agents/runner.js");
    const tools = getToolDefinitions(targetAgent);
    if (tools.length === 0) throw new Error("工具 schema 为空");
    const resp = await chat([
      { role: "system", content: `你是天衍的${targetAgentLabel}, 负责用工具完成用户任务。请根据用户输入, 从可用工具里选出最合适的一个并填好参数 (用 function calling)。先想清楚: 用户要什么、哪个工具能做、参数怎么填。` },
      { role: "user", content: `用户输入: ${userInput.slice(0, 300)}` },
    ], undefined, { temperature: 0.2, maxTokens: 300, tools });

    const picked = resp.toolCalls?.[0];
    const reasoning = resp.reasoningContent?.trim() || resp.content?.trim() || "";

    if (picked) {
      // 模型自主选了工具 — 真实大脑决策
      const args = (picked.arguments || {}) as Record<string, unknown>;
      const thinkingChain = [reasoning, `→ 决定调用工具 ${picked.name}, 参数: ${JSON.stringify(args)}`].filter(Boolean).join("\n");
      return {
        reason: `${targetAgentLabel} 选定工具 ${picked.name}`,
        thinking: thinkingChain || `调用 ${picked.name}`,
        toolName: picked.name,
        toolArgs: args,
        modelPicked: true,
      };
    }
    // 模型没发 tool_calls (只回了正文) — 诚实标注, 回退确定性工具
    logWarn(`[快路径A+] 模型未选工具 (只回正文 ${reasoning.slice(0, 60)}...), 回退确定性 ${fallbackToolName}`);
    return {
      reason: `⚡ ${targetAgentLabel} 模型未选择工具, 代码确定性路由 ${fallbackToolName}`,
      thinking: reasoning ? reasoning + "\n→ (模型未发工具调用, 回退确定性工具 " + fallbackToolName + ")" : "⚡ 快路径: 模型决策推理未生成, 代码确定性路由 " + fallbackToolName,
      toolName: fallbackToolName,
      toolArgs: {},
      modelPicked: false,
    };
  } catch (e) {
    logWarn(`[快路径A+] 模型选工具失败: ${(e as Error).message?.slice(0, 80)} → 诚实标注, 回退确定性 ${fallbackToolName}`);
    return {
      reason: `⚡ 快路径: 模型选工具失败 (${(e as Error).message?.slice(0, 30) || "API 不可用"}), 代码确定性路由 ${fallbackToolName}`,
      thinking: "",
      toolName: fallbackToolName,
      toolArgs: {},
      modelPicked: false,
    };
  }
}

/**
 * B-1 总编委派决策: "派给谁"由总编模型判断 (不是代码写死)。
 * 总编读用户输入 + 候选专家清单, 选目标 agent 并下达任务 (OpenCode task 工具同构:
 * 委派本身就是模型的一次工具调用决策)。失败/没选 → 诚实标注, 回退确定性路由 (防卡死, 非 100% 放飞)。
 */
async function fastPathDelegationDecision(
  userInput: string,
  candidates: Array<{ agent: string; label: string; duty: string }>,
  fallbackAgent: string,
): Promise<{ agent: string; task: string; reason: string; thinking: string; modelPicked: boolean }> {
  try {
    const resp = await Promise.race([
      chat([
        { role: "system", content: "你是总编。你手下有若干专家, 各自负责领域如下:\n" +
          candidates.map((c) => `- ${c.label}(${c.agent}): ${c.duty}`).join("\n") +
          "\n根据用户输入, 判断该委派给哪个专家, 并给这个专家下达一个明确的执行任务 (含目标/范围/产出要求)。用 function calling 输出: delegate(agent=专家名, task=下达的任务)。" },
        { role: "user", content: `用户输入: ${userInput.slice(0, 300)}` },
      ], undefined, {
        temperature: 0.2, maxTokens: 300,
        tools: [{ type: "function" as const, function: { name: "delegate", description: "委派任务给专家", parameters: { type: "object", properties: { agent: { type: "string", description: "专家 agent 名" }, task: { type: "string", description: "下达给专家的任务" } }, required: ["agent", "task"] } } }],
      }) as Promise<any>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("委派决策超时 20s")), 20000)),
    ]);
    const picked = resp?.toolCalls?.[0];
    if (picked && candidates.some((c) => c.agent === picked.name || c.agent === String(picked.arguments?.agent))) {
      const target = candidates.find((c) => c.agent === String(picked.arguments?.agent)) || candidates.find((c) => c.agent === picked.name)!;
      const task = String(picked.arguments?.task || picked.name || target.duty);
      const reasoning = resp?.reasoningContent?.trim() || resp?.content?.trim() || "";
      return {
        agent: target.agent, task,
        reason: `总编判断委派 ${target.label} (模型决策)`,
        thinking: [reasoning, `→ 决定委派 ${target.label}, 下达任务: ${task.slice(0, 120)}`].filter(Boolean).join("\n"),
        modelPicked: true,
      };
    }
    // 模型只回正文 / 选了清单外的 agent → 诚实标注, 回退确定性路由
    const reasoning = resp?.reasoningContent?.trim() || resp?.content?.trim() || "";
    logWarn(`[快路径B-1] 总编委派决策无效 (未选工具或选了未知专家), 回退确定性 ${fallbackAgent}`);
    return { agent: fallbackAgent, task: "", reason: `⚡ 总编模型未有效决策 (${reasoning.slice(0, 40) || "API 不可用"}), 代码确定性路由 ${fallbackAgent}`, thinking: reasoning ? reasoning + "\n→ (总编未选专家, 回退确定性路由 " + fallbackAgent + ")" : "", modelPicked: false };
  } catch (e) {
    logWarn(`[快路径B-1] 委派决策失败: ${(e as Error).message?.slice(0, 60)} → 回退确定性 ${fallbackAgent}`);
    return { agent: fallbackAgent, task: "", reason: `⚡ 快路径: 总编委派决策不可用 (${(e as Error).message?.slice(0, 30)}), 代码确定性路由 ${fallbackAgent}`, thinking: "", modelPicked: false };
  }
}

/**
 * B-2 快路径专家自跑 (对齐 OpenCode: 子 agent 跑自己的 loop, 思考/工具/正文都出自它自己的模型):
 * 1) 专家自己跑 runAgentLoop (它自己的 system + 它自己的 AGENT_TOOLS) → 真思考+真工具选择+正文
 * 2) 确定性核心工具代跑并行竞态: LLM 不稳 (429/TLS) 时 15s 点用代跑结果快出, 不傻等
 * 3) 产出 (LLM 汇报或代跑结果) 交 B-3 总编终审, 终审通过才出门
 * @returns 最终交付给 sub_answer 的内容 (终审背书版或总编修订版)
 */
async function runFastPathExpert(
  pid: string, runId: string, agent: string, task: string, userInput: string,
  coreTool: string, coreArgs: Record<string, unknown>, intentLabel: string,
  send: (evt: SSEEvent) => void,
): Promise<{ content: string; approved: boolean }> {
  const { dispatchTool, finalReviewDeliverable, finalReviewWithRework } = await import("./agents/runner.js");
  const { getAgentPrompt, AGENT_TOOLS } = await import("./agents/index.js");
  const { getAgentSkillPrompts } = await import("./skills.js");
  const proj = store.getProject(pid);
  // 专家自己的上下文 (它自己的脑子: 自己的 system + 自己的工具清单)
  const subSkillPrompts = getAgentSkillPrompts(agent as AgentName);
  const subSkillBlock = subSkillPrompts.length ? "\n\n" + subSkillPrompts.join("\n\n") : "";
  const subMsgs: Array<{ role: string; content: string }> = [
    { role: "system", content: getAgentPrompt(agent as AgentName) + subSkillBlock + "\n\n可用工具: " + AGENT_TOOLS[agent as AgentName].join(", ") + "\n调用工具时使用 function calling (native tool_calls)。先用工具拿真实数据, 再基于真实数据汇报, 严禁编造。" },
  ];
  if (proj) subMsgs.push({ role: "system", content: `项目: ${proj.name} | 类型: ${proj.genre} | 文风: ${proj.style}\n核心设定: ${proj.premise}` });
  subMsgs.push({ role: "user", content: `任务 (总编下达): ${task || intentLabel}\n用户原文: ${userInput.slice(0, 300)}\n\n请执行你的工具拿真实数据, 然后汇报。` });
  // 专家自己的 loop 先跑 (它自己决定调什么工具 — 主 Agent 派活, 专家自己干活, 代码不抢着代跑)
  // 悬挂修复: 15s race 后主流程已拿 deliverable 继续, 但子 agent runAgentLoop (depth=1) 在后台
  // 悬挂修复: 15s race 后主流程已拿 deliverable 继续, 但子 agent runAgentLoop (depth=1) 在后台
  // 继续 emit 到同一 send 闭包 → done 之后又泄漏事件 + SSE 不关。用 subSendGate.canceled 标志,
  // 主流程收尾 (finalReview 前) 时置 canceled=true, 子 loop 后续 emit 全被吞, 不再悬挂。
  const { runAgentLoop } = await import("./agents/runner.js");
  const subT0 = Date.now();
  const subSendGate = { canceled: false };
  // 记录专家到底调没调工具 — 光有文本不够: 实测 agnes 会只回一句"我来执行扫榜任务"就收尾,
  // 旧逻辑 llmResult 非空就算成功 → 交付一句空话, 长任务第 1 步就 done 了。
  const subToolsUsed = new Set<string>();
  const subSend: typeof send = (evt) => {
    if (subSendGate.canceled) return; // 主流程已收尾, 吞掉子 loop 后续事件 (修悬挂)
    const t = (evt as { tool?: string }).tool;
    if ((evt.type === "step" || evt.type === "observation") && t) subToolsUsed.add(t);
    send(evt);
  };
  const loopPromise = runAgentLoop({ pid, agentName: agent as AgentName, messages: subMsgs, depth: 1, runId, delegationLog: [], emit: subSend });
  // 旧值 15s 对"调工具 + 基于结果写汇报"的多回合任务根本不够 (往往第 1 回合才刚说完话就到点),
  // 放宽到 60s。再放宽到 90s 是因为: 这个 race 的另一端也包括**核心工具代跑**,
  // 而扫榜现在多了真实浏览器层 (破 WAF 那一层), 8 平台串行+并发压下来实测要 60~70s,
  // 60s 预算会把它硬切掉 → 专家"没交付" → 降级到 web_search 搜出一堆不相关的东西。
  const EXPERT_LLM_BUDGET_MS = Number(process.env.TIANYAN_EXPERT_LLM_BUDGET_MS) || 90_000;
  const timeoutPromise = new Promise<string>((resolve) => setTimeout(() => resolve(""), EXPERT_LLM_BUDGET_MS));
  const llmResult = await Promise.race([loopPromise, timeoutPromise]);
  const expertText = llmResult.trim();
  // 【够不够格check】: 有文本 + 真的用过工具, 才算专家自跑成功。
  // chat 类任务没有 coreTool, 此时只要非空就用它的文本。
  const expertDelivered = expertText.length > 0 && (subToolsUsed.size > 0 || !coreTool);
  // 确定性核心工具代跑 — 【仅降级补齐】: 专家超时 / 没出结果 / 只出空话没真调工具 才由代码层跑,
  // 保证"扫榜就是真扫榜"的底线。正常情况下工具由专家自己调, 代码不抢活。
  let toolResult = "";
  if (!expertDelivered && coreTool) {
    try {
      toolResult = await dispatchTool(pid, coreTool, coreArgs, agent as AgentName);
      logInfo(`[快路径B-2] ${agent} 专家未交付真实数据${expertText ? " (只回了 "+expertText.length+" 字空话)" : " (超时)"}, 核心工具 ${coreTool} 代跑成功 ${toolResult.length} 字`);
    } catch (e) {
      toolResult = `${intentLabel}失败: ${(e as Error).message?.slice(0, 120)}`;
      logWarn(`[快路径B-2] ${agent} 核心工具 ${coreTool} 代跑失败: ${(e as Error).message?.slice(0, 100)}`);
    }
  }
  let deliverable: string;
  if (expertDelivered) {
    deliverable = "【专家汇报 (它自己的推理 + 它自己调的工具)】\n" + expertText;
    logInfo(`[快路径B-2] ${agent} 自跑loop出结果 ${expertText.length} 字 (${Date.now() - subT0}ms, 工具: ${[...subToolsUsed].join(",") || "-"})`);
  } else if (toolResult) {
    deliverable = "【工具真实执行结果 (专家未调用工具, 代码层代跑补齐)】\n" + toolResult;
  } else if (expertText) {
    // 没有 coreTool 可代跑 (纯对话), 专家文本照样交付
    deliverable = "【专家汇报】\n" + expertText;
  } else {
    deliverable = toolResult
      ? "【工具真实执行结果 (专家 LLM 超时, 代码层代跑)】\n" + toolResult
      : "⚠️ 该任务执行失败 (LLM 不可用且工具代跑失败), 无结果可交付。";
    logInfo(`[快路径B-2] ${agent} LLM ${EXPERT_LLM_BUDGET_MS / 1000}s 内未出结果, 降级代跑核心工具 (${Date.now() - subT0}ms)`);
  }
  // 主流程已拿到 deliverable, 子 loop 后台 emit 从此被吞 (防悬挂)
  subSendGate.canceled = true;
  // B-3 总编终审 + 返修闭环: 打回 → 带着修改指令让同一专家重跑一轮 → 再终审 (最多 1 轮)。
  // 以前打回后裁决意见只附在文本末尾, 从未送回专家, run 直接结束 —— 用户看到"审完了没下文"。
  const reworkOnce = async (feedback: string): Promise<string> => {
    subSendGate.canceled = false; // 返修轮事件要放行
    try {
      const retryMsgs: Array<{ role: string; content: string }> = [...subMsgs];
      if (expertText) retryMsgs.push({ role: "assistant", content: expertText.slice(0, 2000) });
      retryMsgs.push({ role: "user", content: `【总编终审打回 · 返修指令】\n${feedback}\n\n这次必须真的调用你的工具产出完整成果 (任务: ${intentLabel})。严禁只回启动语, 严禁复述计划。` });
      logInfo(`[终审返修] ${agent} 带修改指令重跑 (${intentLabel})`);
      const retryText = await Promise.race([
        runAgentLoop({ pid, agentName: agent as AgentName, messages: retryMsgs, depth: 1, runId, delegationLog: [], emit: subSend }),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), EXPERT_LLM_BUDGET_MS)),
      ]);
      if (!retryText.trim()) return "";
      // 真实工具数据 (若有) 保留打底, 返修汇报接在后面
      return toolResult ? "【工具真实执行结果】\n" + toolResult + "\n\n【返修汇报】\n" + retryText : "【返修汇报】\n" + retryText;
    } finally {
      subSendGate.canceled = true;
    }
  };
  const final = await finalReviewWithRework(pid, runId, agent as AgentName, intentLabel, deliverable, send, reworkOnce, 1);
  return {
    content: final.approved ? final.content : final.content + "\n\n[终审裁决: " + final.verdict.slice(0, 150) + "]",
    approved: final.approved,
  };
}

// 共享 SSE 执行函数 (chat 和 run 共用)
function buildSseStream(pid: string, userInput: string, agentName: AgentName, sessionId?: string) {
  const sid = sessionId || randomBytes(6).toString("hex");
  const proj = getProject(pid);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      // SSE 事件全部落库 (run_events, type="sse"), 跳过 heartbeat —— 断线重连/历史回放靠它完整重建, 不再重跑任务
      const send = (evt: SSEEvent) => {
        if (evt.type !== "heartbeat") {
          try { store.addRunEvent(runId, "sse", { output: JSON.stringify(evt) }); } catch { /* 持久化失败不影响推送 */ }
        }
        if (!closed) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)); } catch { closed = true; } }
      };
      // 谁负责发 done: early-return 分支自己填好 payload, 由统一的收尾环节发出,
      // 这样任何退出路径 (含 early return) 都保证有且只有一个 done。
      let pendingDone: Record<string, unknown> | null = null;
      let doneSent = false;
      const finalSend = (evt: SSEEvent) => { if (evt.type === "done") doneSent = true; send(evt); };
      store.addMessage(pid, "user", userInput);
      const runId = store.createRun(pid, userInput, agentName);
      send({ type: "start", agent: agentName, input: userInput.slice(0, 200), runId });
      const sseKeepalive = setInterval(() => send({ type: "heartbeat", ts: Date.now(), runId }), 8000);

      try {
        // ===== 感知引擎：确定性路由，不依赖 LLM =====
        // getProject 返回 DB 原始行 (current_phase), 需要映射为 currentPhase
        const projForIntent = proj ? { id: proj.id, name: proj.name, genre: proj.genre, premise: (proj as any).premise || "", currentPhase: (proj as any).current_phase ?? 1 } : null;
        const workflowMode = getSettings().workflowMode || "state_machine";

        // ===== autonomous 模式: 感知→规划→执行 (主 Agent 决策权) =====
        if (workflowMode === "autonomous" && !projForIntent) {
          // 无项目 → 规划器决定创建 + 生成弧线目标
          // 路线A: 创建项目快路径的思考也改真实模型生成 (诚实标注, 不合成假分析)
          const createDec = await fastPathDecision(userInput, "总编(创建项目)", "parseProjectInput");
          send({ type: "think_start", agent: agentName, round: 1 });
          send({ type: "think_token", agent: agentName, text: createDec.thinking || "⚡ 创建项目快路径: 模型决策推理未生成 (API 不可用), 确定性解析用户描述并创建新项目。" });
          send({ type: "think_end", agent: agentName, feasible: true, reason: createDec.thinking ? "模型决策推理" : "创建项目确定性路由", plan: [], missing: "" });

          const projData = parseProjectInput(userInput);
          const newPid = store.createProject(projData.name, projData.genre, projData.premise, projData.style, projData.audience);
          const summary = `✅ 已创建项目「${projData.name}」\n类型: ${projData.genre} | 设定: ${projData.premise}\n\n项目ID: ${newPid}\n\n📋 项目已创建，正在启动 Phase 1: 扫榜调研...`;
          send({ type: "planner_decision", agent: agentName, intent: "create_project", route: "create_project → Phase 1", reason: "检测到新项目创建意图", steps: ["parseProjectInput", "createProject", "setArcTarget", "Phase 1"] });
          send({ type: "answer_start", agent: agentName });
          emitTextAsTokens(send, agentName, summary);
          send({ type: "answer_end", agent: agentName });
          store.addMessage(newPid, "assistant", summary);

          // 生成全书弧线目标 (LLM 一次, 供后续 adjust_arc 对齐)
          try {
            await generateArcTargetForProject(newPid, projData, send, agentName);
          } catch { /* 弧线目标生成失败不阻塞 */ }

          // 自动触发 Phase 1 工作流
          try {
            const result1 = await executeWorkflow(newPid, 1 as Phase, userInput, send);
            send({ type: "answer_start", agent: agentName });
            emitTextAsTokens(send, agentName, result1);
            send({ type: "answer_end", agent: agentName });
            store.addMessage(newPid, "assistant", result1);
          } catch (e) {
            send({ type: "error", message: "Phase 1 启动失败: " + (e as Error).message });
          }
          return;
        }

          // ===== autonomous 模式: 有项目 → 规划器路由(仍遵守 7 步铁律) =====
          if (workflowMode === "autonomous") {
            // ===== 扫榜/搜索意图前置: 跳过总编 LLM 判断, 直接进子 agent 强制委派 =====
            // 429 限流时总编 LLM 会卡 56s 重试; 扫榜/搜索走确定性快路径 3s 内出卡片
            // P3 修复: 用户要求"跑完整流程" (含全流程/跑完整/从头跑 等信号) 时【不】走快路径,
            // 否则会扫完榜就 done 收尾 (扫榜快路径发 done+return, 流程停在第1步), 应进规划器
            // run_full_pipeline 意图 → orchestrator 自主连续推进 7 步。
            const fullPipelineRe = /全流程|跑完整|完整.*流程|从头.*跑|从头.*流程|跑完|一路跑|自动.*跑/i;
            const isFullPipelineRequest = fullPipelineRe.test(userInput);
            const scanRe = /扫榜|扫.*榜|榜单|畅销榜/i;
            const searchRe = /搜索|搜一下|搜榜|找资料|查资料|联网搜|资料员/i;
            if (scanRe.test(userInput) && !isFullPipelineRequest) {
              // B-1 委派决策: 扫榜靠 scan_bestseller (写入工具), story-explorer 是只读 agent
              // (permissions.ts 硬拒), 派给它必然报"只读不能调用写入工具"→ 空交付 → 终审打回
              // → 白白多跑一轮 25s。这是权限约束不是风格偏好, 候选清单里不再提供资料员。
              logInfo("[意图前置] 检测到扫榜, 快路径: 委派 (候选限有 scan_bestseller 权限的 agent)");
              const scanDec = await fastPathDelegationDecision(userInput, [
                { agent: "story-architect", label: "架构师", duty: "扫榜调研/拆书解构/大纲 (有 scan_bestseller 写入权限)" },
              ], "story-architect");
              send({ type: "planner_decision", agent: "orchestrator", intent: "scan_bestseller_fast", route: `扫榜 → ${scanDec.agent}`, reason: scanDec.reason, steps: ["scan_detect", "orchestrator_picks_expert", "expert_own_loop", "orchestrator_final_review"] });
              // 总编的委派决策思考 (折叠显示)
              const scanTask = scanDec.task || "扫榜: 抓取平台真实榜单数据并归纳趋势";
              send({ type: "delegate", from: "orchestrator", to: scanDec.agent as AgentName, task: scanTask, depth: 1 });
              const t0p = Date.now();
              send({ type: "sub_agent_start", agent: scanDec.agent as AgentName, task: scanTask, depth: 1 });
              store.addMessage(pid, "assistant", JSON.stringify({ agent: scanDec.agent, task: scanTask }), { toolName: "sub_agent_start", toolCallId: scanDec.agent });
              // B-2 专家自跑 loop (思考/工具/正文都出自专家自己) + B-3 总编终审, 产出终审背书版
              // 核心工具恒定 = scan_bestseller: "扫榜"的语义就是抓榜单, 派给谁只影响"报告怎么写"。
              // 旧逻辑跟专家走 (资料员 → web_search), 于是把整句"扫榜：抓取番茄小说…"拿去当搜索词,
              // Bing 搜出"扫雷游戏/扫帚"这种垃圾, 还被当成成果交付 → 用户眼里就是"长任务跑了等于没跑"。
              // 题材清洗: 项目 genre 形如 "东方仙侠 / 第一人称", 整串塞给榜单接口会被当成奇怪的
              // 题材词导致召回跑偏 (实测抓回来一堆都市赘婿)。只取斜杠前的主题材。
              const scanGenre = ((store.getProject(pid)?.genre as string) || "仙侠").split(/[\/、,，]/)[0].trim() || "仙侠";
              const scanCoreTool = "scan_bestseller";
              const scanCoreArgs = { genre: scanGenre, platform: "番茄小说" };
              const r1 = await runFastPathExpert(pid, runId, scanDec.agent, scanTask, userInput, scanCoreTool, scanCoreArgs, "扫榜", send);
              let expertUsed = scanDec.agent as AgentName;
              let scanDeliverable = r1.content;
              // 终审打回 → 再补救一次 (旧逻辑直接把被打回的内容当成果发 done, 长任务停在第 1 步)。
              // 备选走 story-explorer + web_search: 它是只读 agent 拿不到 scan_bestseller,
              // 但联网检索能补出行业报告/榜单文章, 总比交不出东西强。
              if (!r1.approved) {
                const alt = "story-explorer" as AgentName;
                const scanFallbackQuery = `${scanGenre}小说排行榜 热门 题材 趋势`;
                logInfo(`[意图前置] 扫榜交付被终审打回, 换 ${alt} (web_search 降级) 再跑一次`);
                send({ type: "delegate", from: "orchestrator", to: alt, task: scanTask, depth: 1 });
                send({ type: "sub_agent_start", agent: alt, task: scanTask, depth: 1 });
                const r2 = await runFastPathExpert(pid, runId, alt, scanTask, userInput, "web_search", { query: scanFallbackQuery, max_results: 10 }, "扫榜(降级检索)", send);
                if (r2.approved || r2.content.length > scanDeliverable.length) { scanDeliverable = r2.content; expertUsed = alt; }
              }
              const subDur = Date.now() - t0p;
              finalSend({ type: "sub_answer", agent: expertUsed, text: scanDeliverable });
              finalSend({ type: "sub_agent_done", agent: expertUsed, result: scanDeliverable, durationMs: subDur });
              store.addMessage(pid, "assistant", scanDeliverable, { toolName: "sub_answer", toolCallId: expertUsed });
              store.addMessage(pid, "assistant", JSON.stringify({ agent: expertUsed, result: scanDeliverable.slice(0, 800), durationMs: subDur, early: true }), { toolName: "sub_agent_done", toolCallId: expertUsed });
              pendingDone = { agent: "orchestrator", steps: 1, stats: {} };
              return;
            }
            if (searchRe.test(userInput) && !isFullPipelineRequest) {
              // B-1 总编判断派给谁 (模型决策, 失败回退确定性 story-explorer)
              logInfo("[意图前置] 检测到搜索, 快路径: 总编模型决策委派");
              const searchDec = await fastPathDelegationDecision(userInput, [
                { agent: "story-explorer", label: "资料员", duty: "联网搜索/资料检索" },
                { agent: "story-architect", label: "架构师", duty: "扫榜调研/拆书解构/大纲" },
              ], "story-explorer");
              send({ type: "planner_decision", agent: "orchestrator", intent: "web_search_fast", route: `搜索 → ${searchDec.agent}`, reason: searchDec.reason, steps: ["search_detect", "orchestrator_picks_expert", "expert_own_loop", "orchestrator_final_review"] });
              const searchTask = searchDec.task || `搜索/资料: 联网检索并整理 (用户想搜: ${userInput.slice(0, 60)})`;
              send({ type: "delegate", from: "orchestrator", to: searchDec.agent as AgentName, task: searchTask, depth: 1 });
              const t0s = Date.now();
              send({ type: "sub_agent_start", agent: searchDec.agent as AgentName, task: searchTask, depth: 1 });
              store.addMessage(pid, "assistant", JSON.stringify({ agent: searchDec.agent, task: searchTask }), { toolName: "sub_agent_start", toolCallId: searchDec.agent });
              // B-2 专家自跑 loop + B-3 总编终审
              // 同理: 搜索意图用干净关键词, 不要把"搜索：后面的整句"原样丢给搜索引擎
              const cleanSearchQuery = (
                userInput
                  .replace(/^(搜索|搜一下|搜搜|搜榜|查资料|找资料|联网搜|资料员)\s*[：:，,]?\s*/i, "")
                  .slice(0, 120) || userInput.slice(0, 60)
              ).trim();
              const searchCoreTool = searchDec.agent === "story-architect" ? "scan_bestseller" : "web_search";
              const searchCoreArgs = searchDec.agent === "story-architect"
                ? { genre: (store.getProject(pid)?.genre as string) || "仙侠", platform: "番茄小说" }
                : { query: cleanSearchQuery, max_results: 10 };
              const sr = await runFastPathExpert(pid, runId, searchDec.agent, searchTask, userInput, searchCoreTool, searchCoreArgs, "搜索/资料", send);
              const searchDeliverable = sr.content;
              const searchExpert = searchDec.agent as AgentName;
              const subDur = Date.now() - t0s;
              send({ type: "sub_answer", agent: searchExpert, text: searchDeliverable });
              send({ type: "sub_agent_done", agent: searchExpert, result: searchDeliverable, durationMs: subDur });
              store.addMessage(pid, "assistant", searchDeliverable, { toolName: "sub_answer", toolCallId: searchExpert });
              store.addMessage(pid, "assistant", JSON.stringify({ agent: searchExpert, result: searchDeliverable.slice(0, 800), durationMs: subDur, early: true, approved: sr.approved }), { toolName: "sub_agent_done", toolCallId: searchExpert });
              pendingDone = { agent: "orchestrator", steps: 1, stats: {} };
              return;
            }

            const p = await plannerPlan({ pid: proj!.id, userInput, agent: agentName });
            send({ type: "planner_decision", agent: agentName, intent: p.decision.intent, route: `Phase ${p.decision.targetPhase}`, reason: p.decision.reason, steps: p.decision.steps });

            // 记忆钩子: 用户创作指令自动进长期记忆 (跨天/跨轮不丢)
            try { captureUserCreativeMemories(pid, userInput); } catch { /* 记忆保存失败不影响主流程 */ }

            // 把规划上下文注入 orchestrator 的系统消息(节拍器 + 路线图), 让主 Agent 自主执行
            const plannerCtx = p.contextBlock;
            const messages = buildChatMessages(pid, sid, agentName, userInput);
            messages.push({ role: "system", content: plannerCtx });

            await runAgentLoop({
              pid, agentName, messages, depth: 0, runId,
              delegationLog: [], emit: send, sharedSteps: { value: 0 },
            });
            return;
          }

        // ===== 非 autonomous 模式: 沿用原有 detectIntent 路由 =====
        const intent = detectIntent(userInput, projForIntent);

        switch (intent.type) {
          case "new_project": {
            // 新建项目
            send({ type: "think_start", agent: "orchestrator", round: 1 });
            send({ type: "think_token", agent: "orchestrator", text: "检测到创建项目意图，解析用户描述...\n" });
            send({ type: "think_end", agent: "orchestrator", feasible: true, reason: "解析完成", plan: [], missing: "" });

            const projData = parseProjectInput(userInput);
            const newPid = store.createProject(projData.name, projData.genre, projData.premise, projData.style, projData.audience);
            const summary = `✅ 已创建项目「${projData.name}」\n类型: ${projData.genre} | 设定: ${projData.premise}\n\n项目ID: ${newPid}\n\n📋 项目已创建，正在启动 Phase 1: 扫榜调研...`;
            send({ type: "answer_start", agent: agentName });
            emitTextAsTokens(send, agentName, summary);
            send({ type: "answer_end", agent: agentName });
            // 生成全书弧线目标 (LLM 一次, autonomous 模式对齐)
            try {
              await generateArcTargetForProject(newPid, projData, send, agentName);
            } catch { /* 弧线目标生成失败不阻塞 */ }
            // 自动触发 Phase 1 工作流（orchestrator 中心化委派）
            try {
              const result1 = await executeWorkflow(newPid, 1 as any, userInput, send);
              send({ type: "answer_start", agent: agentName });
              emitTextAsTokens(send, agentName, result1);
              send({ type: "answer_end", agent: agentName });
              store.addMessage(newPid, "assistant", result1);
            } catch (e) {
              send({ type: "error", message: "Phase 1 启动失败: " + (e as Error).message });
            }
            break;
          }

          case "status": {
            // 进度查询
            const progress = getProjectProgress(pid);
            send({ type: "answer_start", agent: agentName });
            emitTextAsTokens(send, agentName, progress);
            send({ type: "answer_end", agent: agentName });
            break;
          }

          case "workflow": {
            // 创作工作流 → 引擎确定性路由
            // P1 门禁: 若有待确认门(上一阶段门控问题), 用用户输入作为门答案, 执行门目标阶段
            const pending = store.peekPendingGate(pid);
            if (pending) {
              const gatePhase = pending.targetPhase;
              store.takePendingGate(pid);
              try { store.updateProjectPhase(pid, gatePhase); } catch { /* ignore */ }
              send({ type: "gate_cleared", agent: agentName, phase: gatePhase });
              const result = await executeWorkflow(pid, gatePhase as any, userInput, send);
              send({ type: "answer_start", agent: agentName });
              emitTextAsTokens(send, agentName, result);
              send({ type: "answer_end", agent: agentName });
              store.addMessage(pid, "assistant", result);
              break;
            }
            const result = await executeWorkflow(pid, intent.phase, userInput, send);
            send({ type: "answer_start", agent: agentName });
            emitTextAsTokens(send, agentName, result);
            send({ type: "answer_end", agent: agentName });
            store.addMessage(pid, "assistant", result);
            break;
          }

          case "advance": {
            // 用户确认 → 推进到下一阶段并执行
            if (!getProject(pid)) {
              send({ type: "error", message: "项目不存在" });
              break;
            }
            // P1 门禁: 先检查是否有待确认门; 有则执行门目标阶段(用户输入=门答案/确认)
            const pending = store.peekPendingGate(pid);
            if (pending) {
              const gatePhase = pending.targetPhase;
              store.takePendingGate(pid);
              try { store.updateProjectPhase(pid, gatePhase); } catch { /* ignore */ }
              send({ type: "gate_cleared", agent: agentName, phase: gatePhase });
              const result = await executeWorkflow(pid, gatePhase as any, userInput, send);
              send({ type: "answer_start", agent: agentName });
              emitTextAsTokens(send, agentName, result);
              send({ type: "answer_end", agent: agentName });
              store.addMessage(pid, "assistant", result);
              break;
            }
            const state = store.getProjectState(pid);
            const result = await executeWorkflow(pid, state.currentPhase, userInput, send);
            send({ type: "answer_start", agent: agentName });
            emitTextAsTokens(send, agentName, result);
            send({ type: "answer_end", agent: agentName });
            store.addMessage(pid, "assistant", result);
            break;
          }

          case "chat":
          default: {
            // 普通聊天 → 降级到 LLM（模型无关兜底）
            // 记忆钩子: 检测用户消息里的创作指令 → 自动存长期记忆 (保证跨天/跨轮不丢)
            try { captureUserCreativeMemories(pid, userInput); } catch { /* 记忆保存失败不影响主流程 */ }
            const messages = buildChatMessages(pid, sid, agentName, userInput);
            await runAgentLoop({ pid, agentName, messages, depth: 0, runId, delegationLog: [], emit: send, sharedSteps: { value: 0 } });
            break;
          }
        }
      } catch (e) {
        finalSend({ type: "error", message: friendlyError(e as Error, s.defaultModel) });
      } finally {
        // 【关键】SSE 收尾必须在 finally 里, 不能只写在函数末尾:
        // 扫榜/搜索/创建项目等快路径分支都是 early return, 原先绕过末尾的 close,
        // 结果 controller 永不关闭 → HTTP 响应体不结束 → 前端一直转圈/像"连不上",
        // 而且 8s 心跳定时器泄漏。finally 对所有 return 路径一视同仁地兜住,
        // 并保证每条路径恰好收到一个 done。
        clearInterval(sseKeepalive);
        if (!doneSent) {
          const payload = pendingDone || { agent: agentName, steps: 0, stats: stats(pid) };
          try { send({ type: "done", ...payload, runId } as SSEEvent); } catch { /* 流异常已关 */ }
        }
        // run 走完了就清掉取消标记 —— 用户可能点过停止后 run 才收尾,
        // 不清理的话这个 runId 会在内存里白占 6 小时
        clearRunCancel(runId);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return stream;
}

// ===== 感知引擎辅助函数 =====

// 把文本拆分成前端打字机友好的 token 事件
function emitTextAsTokens(send: (evt: SSEEvent) => void, agent: AgentName, text: string) {
  // 按段落/句子拆分，避免一次发太长导致前端卡顿
  const chunks = text.match(/[^\n]+\n?|\n/g) || [text];
  for (const chunk of chunks) {
    send({ type: "token", agent, content: chunk });
  }
  send({ type: "token", agent, content: "\n" });
}

// 从用户输入解析项目信息
function parseProjectInput(input: string): { name: string; genre: string; premise: string; style: string; audience: string } {
  const genreMatch = input.match(/(仙侠|都市|悬疑|玄幻|科幻|言情|历史|武侠|末世|异能|恐怖|奇幻|军事|游戏|二次元|纯爱)/);
  const styleMatch = input.match(/(轻松|热血|硬核|搞笑|黑暗|温暖|冷酷|正剧|虐心|爽文|白金|黄金|大神)/);
  const audienceMatch = input.match(/(男频|女频|双男主|双女主)/);

  // 尝试从输入中提取核心设定 (通常在 "关于" / "讲述了" / 前面)
  let premise = input;
  const premisePatterns = [
    /(?:关于|讲述了?|是关于|写一本关于?)\s*(.{5,60}?)(?:[，。,.]|的|小说)/,
    /(.{5,50}?)(?:小说|的故事|的小说)/,
  ];
  for (const pat of premisePatterns) {
    const m = input.match(pat);
    if (m) { premise = m[1].trim(); break; }
  }

  // 项目名：从设定推断或用时间戳
  const nameMatch = input.match(/(?:叫|名[字为叫]?是?|标题[是为]?|名字[是]?)\s*["""]?([^""",。，\n]{2,20})["""]?/);
  const name = nameMatch ? nameMatch[1] : `${genreMatch?.[1] || "小说"}创作-${Date.now().toString(36)}`;

  return {
    name,
    genre: genreMatch?.[1] || "都市",
    premise: premise.slice(0, 200),
    style: styleMatch?.[1] || "轻松",
    audience: audienceMatch?.[1] || "男频",
  };
}

// 项目创建时生成全书弧线目标(LLM 一次, autonomous 模式的"宏观节拍器"基准)
async function generateArcTargetForProject(
  pid: string,
  projData: { name: string; genre: string; premise: string; style: string; audience: string },
  send: (evt: import("./types.js").SSEEvent) => void,
  agentName: import("./types.js").AgentName,
): Promise<void> {
  const sysPrompt = `你是小说节奏设计师。根据项目信息设计全书弧线目标。
输出纯 JSON: {"target_chapters":数字,"target_density":数字(每1000字爽点数,1-3),"peak_chapter":数字,"arc_plan":"起承转合的一句话弧线计划"}
- target_chapters: 网文新书合理篇幅(15~30 章)
- target_density: 爽点密度目标(爽文=2~3, 正剧=1~1.5, 虐文=0.5~1)
- peak_chapter: 全书大高潮章节号(通常 70~90% 位置)
- arc_plan: 一段话描述 起(铺垫)→承(发展)→转(反转)→合(高潮+回收) 的节奏设计`;
  const userPrompt = `项目名: ${projData.name}
类型: ${projData.genre}
受众: ${projData.audience}
文风: ${projData.style}
核心设定: ${projData.premise}
请设计全书弧线目标。`;
  const resp = await chat([
    { role: "system", content: sysPrompt },
    { role: "user", content: userPrompt },
  ]);
  const m = resp.content.match(/\{[\s\S]*\}/);
  let generated = false;
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      const targetChapters = Math.max(5, Math.min(50, Number(parsed.target_chapters) || 20));
      const targetDensity = Math.max(0.5, Math.min(4, Number(parsed.target_density) || 1.5));
      const peakChapter = Math.max(1, Math.min(targetChapters, Number(parsed.peak_chapter) || Math.round(targetChapters * 0.8)));
      const arcPlan = String(parsed.arc_plan || "起承转合: 铺垫→发展→反转→高潮回收");
      setArcTarget(pid, { targetChapters, targetDensity, peakChapter, arcPlan });
      generated = true;
      send({ type: "arc_adjusted", agent: agentName, from: 0, to: targetDensity, reason: `全书弧线目标已生成: ${targetChapters}章 / 密度${targetDensity}/1000字 / 高潮第${peakChapter}章` });
      send({ type: "observation", agent: agentName, tool: "arc_target(auto)", result: JSON.stringify({ targetChapters, targetDensity, peakChapter, arcPlan: arcPlan.slice(0, 200) }) });
    } catch { /* JSON 解析失败用默认值 */ }
  }
  // LLM 失败时回退默认弧线目标
  if (!generated) {
    setArcTarget(pid, { targetChapters: 20, targetDensity: 1.5, peakChapter: 15, arcPlan: "默认弧线: 起承转合 15~30 章" });
  }
}

// 构建聊天消息（含项目上下文、记忆、历史）
// ===== 记忆钩子: 用户消息里的创作指令 → 自动存长期记忆 =====
// 场景: 用户今天说"把主角的动机改成复仇", 两天后说"再加一条伏笔, 剑上有名字",
//       中间隔了几十轮对话 — 两个点都滑出 40 条窗口后, 只有长期记忆库还能保证它们不丢。
// 确定性检测 (不依赖 LLM 自觉): 命中创作指令关键词的用户消息 → 存长期记忆。
// 冲突由 saveLongTermMemory 的 resolveConflict 处理: 同主题不冲突 → kept_both/merged。
const CREATIVE_DIRECTIVE_PATTERN = /(设定|要求|必须|不能|不要|改成|改为|换成|加入|加上|删掉|删除|去掉|伏笔|伏线|反转|高潮|大纲|剧情|主线|支线|结局|节奏|文风|风格|主角|女主|男主|反派|配角|角色|性格|动机|世界观|功法|境界|宗门|家族|时代|背景|基调|爽点|泪点|金手指|对标|参考)/;

function captureUserCreativeMemories(pid: string, userInput: string): void {
  const text = userInput.trim();
  if (!text || text.length < 6) return; // 太短的闲聊不存
  if (!CREATIVE_DIRECTIVE_PATTERN.test(text)) return; // 没命中创作指令特征, 不存
  // 分类: 粗粒度 (角色/剧情/风格/世界观/偏好)
  let category = "preference";
  if (/主角|女主|男主|反派|配角|角色|性格|动机/.test(text)) category = "character";
  else if (/伏笔|伏线|反转|高潮|剧情|主线|支线|结局|大纲|节奏/.test(text)) category = "plot";
  else if (/文风|风格|基调|爽点|泪点|搞笑|黑暗|温暖|热血/.test(text)) category = "style";
  else if (/世界观|功法|境界|宗门|家族|时代|背景/.test(text)) category = "world";
  const topic = "用户指令-" + text.slice(0, 20);
  // source=user (优先级最高, 10): 用户明确说过的点, 永远优先于 agent 自动记忆
  memory.saveLongTermMemory(pid, category, topic, text.slice(0, 500), "user", 7);
}

function buildChatMessages(pid: string, sid: string, agentName: AgentName, userInput: string): Array<{ role: string; content: string }> {
  const proj = getProject(pid);
  const memoryCtx = memory.getMemoryContext(pid);
  const sessionMems = memory.getSessionMemories(pid, sid);
  // 相关性检索: 当前用户输入提到的点, 把长期记忆里相关的旧点捞回来
  // (保证"过两天提的另一个点"跟"旧点"不冲突时, 两边都能被看到)
  const relevantMems = memory.searchLongTermMemories(pid, userInput, 10);
  const relatedBlock = relevantMems.length
    ? "【相关记忆 (与本次对话相关)】\n" + relevantMems.map((m) => `- [${m.category}/${m.topic}] ${m.content.slice(0, 200)}`).join("\n")
    : "";
  const messages: Array<{ role: string; content: string }> = [];

  if (proj) {
    const genreLockSse = proj.genre ? `【风格锁定】本项目类型为「${proj.genre}」, 全程禁止偏离。` : "";
    messages.push({ role: "system", content: `当前项目: ${proj.name}\n类型: ${proj.genre}\n文风: ${proj.style}\n设定: ${proj.premise}\n${genreLockSse}` });
  }
  if (memoryCtx) messages.push({ role: "system", content: `【长期记忆】\n${memoryCtx}` });
  if (relatedBlock) messages.push({ role: "system", content: relatedBlock });
  if (sessionMems.length) {
    messages.push({ role: "system", content: `【短期记忆】\n${sessionMems.map((m) => `- [${m.category}] ${m.topic}: ${m.content}`).join("\n")}` });
  }

  const skillPrompts = getAgentSkillPrompts(agentName);
  const skillBlock = skillPrompts.length ? "\n\n" + skillPrompts.join("\n\n") : "";
  messages.push({ role: "system", content: getAgentPrompt(agentName) + skillBlock + "\n可用工具: " + AGENT_TOOLS[agentName].join(", ") + "\n需要调用工具时输出 JSON: {\"tool\": \"工具名\", \"args\": {...}}\n否则直接回复。" });

  const histMsgs = store.listMessages(pid, 40);
  for (const m of histMsgs) {
    const _toolName = (m as unknown as { tool_name?: string }).tool_name;
    // 过滤空 content (历史里可能残留 content="" 的行, agnes 校验会 400: "message content cannot be empty")
    if ((m.role === "user" || m.role === "assistant") && !_toolName && (m.content || "").trim().length > 0) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: "user", content: userInput });
  return messages;
}

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", Connection: "keep-alive" } as const;

app.post("/api/projects/:pid/chat", async (c) => {
  const pid = c.req.param("pid");
  // 项目必须存在
  if (!getProject(pid)) return c.json({ error: "项目不存在" }, 404);
  let body: { input: string; agent?: string; sessionId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是有效 JSON" }, 400);
  }
  const { input: userInput, sessionId } = body;
  const agentName = (body.agent || DEFAULT_AGENT) as AgentName;
  if (!userInput) return c.json({ error: "缺少 input" }, 400);
  if (!isValid(agentName)) return c.json({ error: `无效 agent: ${agentName}` }, 400);
  const stream = buildSseStream(pid, userInput, agentName, sessionId);
  return new Response(stream, { headers: SSE_HEADERS });
});

// ===== Run Resume (断点续传) =====
// 重连时: 如果 run 已完成, 直接回放事件; 如果还在运行, 返回 running 状态让前端等待
app.get("/api/projects/:pid/runs/:runId/resume", async (c) => {
  const pid = c.req.param("pid");
  const runId = c.req.param("runId");
  const afterSeq = Number(c.req.query("afterSeq") || "0");
  if (!getProject(pid)) return c.json({ error: "项目不存在" }, 404);
  const run = store.getRun(runId);
  if (!run) return c.json({ error: "run 不存在" }, 404);
  if ((run as any).project_id !== pid) return c.json({ error: "run 不属于该项目" }, 403);

  // 如果还在运行, 返回 running 状态
  if (run.status === "running") {
    return c.json({ status: "running", runId, message: "run 仍在执行中, 请继续等待" });
  }

  // run 已完成或出错: 回放所有事件
  const events = store.getRunEvents(runId, afterSeq);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const evt of events) {
        try {
          const parsed = JSON.parse(evt.output || "{}");
          // 只回放 SSE 事件类型 (排除 tool_call 等内部事件)
          if (parsed && parsed.type) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
          }
        } catch { /* skip */ }
      }
      controller.enqueue(encoder.encode(`data: {"type":"done","agent":"replay","steps":0,"stats":{},"runId":"${runId}"}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

// ===== Run 列表/事件查询 =====
app.get("/api/projects/:pid/runs/:runId/events", async (c) => {
  const pid = c.req.param("pid");
  const runId = c.req.param("runId");
  const afterSeq = Number(c.req.query("afterSeq") || "0");
  if (!getProject(pid)) return c.json({ error: "项目不存在" }, 404);
  const events = store.getRunEvents(runId, afterSeq);
  return c.json(events);
});

// ===== Agent 运行 (通用) =====
app.post("/api/run", async (c) => {
  let body: { pid: string; input: string; agent?: string; sessionId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是有效 JSON" }, 400);
  }
  const { pid, input: userInput, sessionId } = body;
  const agentName = (body.agent || DEFAULT_AGENT) as AgentName;
  if (!pid) return c.json({ error: "缺少 pid" }, 400);
  if (!getProject(pid)) return c.json({ error: "项目不存在" }, 404);
  if (!userInput) return c.json({ error: "缺少 input" }, 400);
  if (!isValid(agentName)) return c.json({ error: `无效 agent: ${agentName}` }, 400);
  const stream = buildSseStream(pid, userInput, agentName, sessionId);
  return new Response(stream, { headers: SSE_HEADERS });
});

// ===== 模型配置 =====
app.get("/api/models", (c) => c.json({ defaultModel: s.defaultModel, models: s.models, providers: PROVIDER_PRESETS }));
app.post("/api/models", async (c) => {
  const body = await c.req.json<{ model: string; api_key?: string; api_base?: string; temperature?: number; max_tokens?: number }>();
  updateModelConfig(body.model, { apiKey: body.api_key, apiBase: body.api_base, temperature: body.temperature, maxTokens: body.max_tokens });
  return c.json({ ok: true });
});
app.delete("/api/models/:model", (c) => { removeModelConfig(decodeURIComponent(c.req.param("model"))); return c.json({ ok: true }); });
app.post("/api/models/test", async (c) => {
  const body = await c.req.json<{ model: string; api_key?: string; api_base?: string }>();
  return c.json(await testConnection({ model: body.model, apiKey: body.api_key, apiBase: body.api_base, temperature: 0.8, maxTokens: 100 }));
});

// ===== 沙箱 =====
app.post("/api/sandbox/run", async (c) => {
  const body = await c.req.json<{ code: string; timeout?: number }>();
  return c.json(await executeCode(body.code, body.timeout));
});

// ===== Agent 列表 =====
app.get("/api/agents", (c) => c.json({
  agents: AGENT_META,
  default: DEFAULT_AGENT,
  max_delegate_depth: getMaxDelegateDepth,
  workflow_phases: WORKFLOW_PHASES,
  readonly_agents: ["consistency-checker", "story-explorer", "presenter"],
}));

// ===== 技能列表 (真实持久化) =====
app.get("/api/skills", (c) => {
  const s = getSettings();
  return c.json({
    skills: BUILTIN_SKILLS.map((b) => ({
      name: b.name, label: b.label, category: b.category,
      description: b.description, enabled: isBuiltinEnabled(b.name),
      custom: false,
    })),
    custom: listCustomSkills(),
    model: s.defaultModel.model,
  });
});
app.post("/api/skills/:name/toggle", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({ enabled: undefined }));
  // 内置 vs 自定义
  const isBuiltin = BUILTIN_SKILLS.some((b) => b.name === name);
  const enabled = body.enabled !== undefined ? body.enabled : !(isBuiltin ? isBuiltinEnabled(name) : listCustomSkills().find((s) => s.name === name)?.enabled);
  if (isBuiltin) {
    setBuiltinEnabled(name, enabled);
  } else {
    const r = setCustomSkillEnabled(name, enabled);
    if (!r.ok) return c.json(r, 400);
  }
  return c.json({ ok: true, skill: name, enabled });
});
app.post("/api/skills/custom", async (c) => {
  const body = await c.req.json<{ name: string; label: string; icon?: string; description?: string; prompt: string; agents: string[] }>();
  const r = addCustomSkill(body.name, body.label, body.icon || "", body.description || "", body.prompt, body.agents || []);
  if (!r.ok) return c.json(r, 400);
  return c.json({ ok: true, name: body.name });
});
app.delete("/api/skills/custom/:name", (c) => c.json(removeCustomSkill(c.req.param("name"))));

// ===== 静态前端 =====
// web 目录: 兼容 Node 18 (无 import.meta.dirname) 和 Node 20+
import { fileURLToPath } from "node:url";
const _curDir = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
const webDir = join(_curDir, "..", "web");
const APP_VERSION = "0.2.0";
const NO_CACHE = { "Cache-Control": "no-cache, no-store, must-revalidate" };
const serveHtml = (c: any, file: string) => {
  try {
    const html = readFileSync(join(webDir, file), "utf-8").replace(/__VERSION__/g, APP_VERSION);
    return c.html(html, 200, NO_CACHE);
  } catch { return c.text("天衍 - web/ 目录未找到", 404); }
};
const serveFile = (c: any, file: string, contentType: string) => {
  try { return c.text(readFileSync(join(webDir, file), "utf-8"), 200, { "Content-Type": contentType, ...NO_CACHE }); }
  catch { return c.text("", 404); }
};
const serveFileHtml = (c: any, file: string) => {
  try { return c.html(readFileSync(join(webDir, file), "utf-8"), 200, NO_CACHE); }
  catch { return c.text("", 404); }
};
if (existsSync(webDir)) {
  app.get("/", (c) => serveHtml(c, "index.html"));
  app.get("/index.html", (c) => serveHtml(c, "index.html"));
  // /static/ 前缀路由
  app.use("/static/style.css", async (c) => serveFile(c, "style.css", "text/css"));
  app.use("/static/app.js", async (c) => serveFile(c, "app.js", "application/javascript"));
  app.use("/static/novel-card.html", async (c) => serveFileHtml(c, "novel-card.html"));
  // 兼容无前缀路由
  app.use("/style.css", async (c) => serveFile(c, "style.css", "text/css"));
  app.use("/app.js", async (c) => serveFile(c, "app.js", "application/javascript"));
  app.use("/novel-card.html", async (c) => serveFileHtml(c, "novel-card.html"));
  // 预览页面
  app.use("/preview", async (c) => serveFileHtml(c, "preview.html"));
  app.use("/preview.html", async (c) => serveFileHtml(c, "preview.html"));
  app.use("/static/preview.html", async (c) => serveFileHtml(c, "preview.html"));
  // 浏览器截图产物
  app.get("/screenshots/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return c.text("bad request", 400);
    const fp = join(s.dataDir, "screenshots", file);
    if (!existsSync(fp)) return c.text("not found", 404);
    return c.body(readFileSync(fp), 200, { "Content-Type": "image/png", ...NO_CACHE });
  });
  app.get("/exports/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9._一-龥-]+$/.test(file)) return c.text("bad request", 400);
    const fp = join(s.dataDir, "exports", file);
    if (!existsSync(fp)) return c.text("not found", 404);
    const isJson = file.endsWith(".json");
    return new Response(readFileSync(fp, "utf-8"), {
      headers: {
        "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file)}"`,
        ...NO_CACHE,
      },
    });
  });
}

// ===== 启动 =====
const port = s.serverPort;
const BLUE = "\x1b[36m";
const RESET = "\x1b[0m";
const blue = (t: string) => `${BLUE}${t}${RESET}`;
console.log(`\n`);
console.log(`${blue("  ╔══════════════════════════════╗")}`);
console.log(`${blue("  ║")}                            ${blue("║")}`);
console.log(`${blue("  ║")}      ${blue("【  天  衍  】")}        ${blue("║")}`);
console.log(`${blue("  ║")}                            ${blue("║")}`);
console.log(`${blue("  ╚══════════════════════════════╝")}`);
console.log(`${blue(`  地址: http://localhost:${port}`)}`);
console.log(`${blue(`  模型: ${s.defaultModel.model}`)}`);
console.log(`${blue(`  数据: ${s.dataDir}`)}`);
console.log(`${blue(`  版本: v0.1.0`)}`);
console.log(`\n`);
serve({ fetch: app.fetch, port }, async () => {
  console.log(`${blue("  ✓ 服务已启动")}`);
  // 乱码消息清理改为人工触发 (POST /api/admin/clean-garbled):
  // 启动自动删数据是"重新进入旧会话就丢"的隐患之一 — 脏数据保留, 想清再手动调接口
  // 自动拉起内嵌浏览器服务 (模拟真人), 搜索/扫榜 agent 可直接调用; 起不来自动降级
  try {
    const { startBrowserService, browserServiceBackend, BROWSER_SVC_BASE } = await import("./browserService.js");
    const bs = await startBrowserService();
    const bsTag = bs.reused ? "复用外部" : "内嵌";
    console.log(`${blue("  浏览器服务: " + BROWSER_SVC_BASE + " (backend=" + bs.backend + ", " + bsTag + ")")}`);
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 60) || "unknown";
    console.log(`${blue("  浏览器服务: 不可用 (" + msg + "), 搜索/扫榜走 fetch 降级")}`);
  }
});
