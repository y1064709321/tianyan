// 配置管理: YAML + 环境变量 + 默认值
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ModelConfig, Settings } from "./types.js";

const DEFAULT_MODEL: ModelConfig = {
  // 默认模型: DeepSeek V4.1 Flash (deepseek-flash 为官方现行规范 ID, deepseek-v4-flash 旧别名仍可用)
  model: "deepseek/deepseek-flash",
  temperature: 0.8,
  maxTokens: 4096,
};


// 7 Agent 标准配置
// 轮数上限 (2026-09-30 用户两轮校准):
// 1) "两轮太少" → 对齐 OpenCode: 步数耗尽时 MAX_STEPS_PROMPT 优雅收尾 (模型总结完成/剩余/下一步), 非硬停
// 2) 但写小说各 agent 实际用不了那么多轮 — 只有总编 (多阶段调度: 委派→审稿→打回→再委派) 值得放宽,
//    专家 agent 按"任务量 + 打回余量"定, 多跑只会烧 token/撞429/弱模型改坏好稿。
// 保留 runMaxDuration 总时长兜底 (防无限跑飞); 用户仍可在 settings.agents 覆盖。
const DEFAULT_AGENTS: Record<string, import("./types.js").AgentConfig> = {
  // 总编: 多阶段调度, 唯一需要大预算的 (委派→等结果→审稿→打回→再委派, 一轮循环 6-8 步)
  orchestrator:           { maxDepth: 3, maxTurns: 40, maxSteps: 80, modelTier: "high", readonly: false },
  // 架构师: 扫榜/拆书/大纲 (1 工具 + 归纳 + 2-3 次补抓 ≈ 5-8 步, 含打回余量 12/24)
  "story-architect":     { maxDepth: 2, maxTurns: 12, maxSteps: 24, modelTier: "high", readonly: false },
  // 主笔: 写一章 (1 写 + 1-2 打回重写 + 审稿 ≈ 4-6 步, 含余量 8/16)
  "narrative-writer":    { maxDepth: 1, maxTurns: 8, maxSteps: 16, modelTier: "mid",  readonly: false },
  // 角色/世界观: 列/查/改 1-3 次 ≈ 3-5 步 (含余量 8/16)
  "character-designer":  { maxDepth: 1, maxTurns: 8, maxSteps: 16, modelTier: "mid",  readonly: false },
  // 质检: 36维审 1 次 + 可能复跑 1 次 ≈ 3-5 步 (含余量 8/16)
  "consistency-checker": { maxDepth: 1, maxTurns: 8, maxSteps: 16, modelTier: "mid",  readonly: true },
  // 资料员/汇报: 搜索 1-2 次 + 整理 1 轮 ≈ 3-4 步 (含余量 6/12)
  "story-explorer":      { maxDepth: 1, maxTurns: 6, maxSteps: 12, modelTier: "low",  readonly: true },
  presenter:              { maxDepth: 1, maxTurns: 6, maxSteps: 12, modelTier: "low",  readonly: true },
};
const DEFAULT_SETTINGS: Settings = {
  dataDir: join(homedir(), ".tianyan"),
  dbPath: "",
  uploadDir: "",
  defaultModel: { ...DEFAULT_MODEL },
  models: [],
  maxSteps: 16,
  runMaxTokens: 200_000,
  runMaxCost: 1.0,
  loopDetectCount: 5,
  runMaxDuration: 1200,
  sseHeartbeatInterval: 5.0,
  chunkSize: 2000,
  chunkOverlap: 200,
  retrieveK: 6,
  serverHost: "0.0.0.0",
  serverPort: 8090,
  // 默认 autonomous: 主 Agent 拥有规划决策权(感知→规划→执行), 铁律框架(7步顺序/工具白名单/质量门禁)保持不变
  workflowMode: "autonomous" as const,
  agents: {},
};

let _settings: Settings | null = null;
let _configPath = "";

function loadYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  try {
    return (parseYaml(raw) as Record<string, unknown>) || {};
  } catch {
    // === 逃生网: Windows 路径被写成 double-quoted 标量时, \U / \l 等是非法 YAML 转义,
    //     parse 抛错 → 旧代码静默 return {} → 【全部配置重置】(默认模型/端口/模型池全丢)。
    //     这是"前端显示 Agnes/DeepSeek 不是我配的那个"的根因之一。
    //     这里先按"双引号 Windows 路径 → 单引号(不解析转义)"修复后重试;
    //     仍失败才返回 {}, 并明确打日志 (不再静默吞掉)。
    try {
      const repaired = raw.replace(
        /(:\s*)"((?:[A-Za-z]:)?[^"\n]*\\[^"\n]*)"/g,
        (_m, head: string, val: string) => `${head}'${val}'`,
      );
      const parsed = parseYaml(repaired) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") {
        console.warn(
          `[config] ${path} 存在非法 YAML 转义 (疑似 Windows 路径用了双引号), 已就地修复解析。` +
          ` 建议重启一次让本进程用正确格式回写该文件或改单引号。`,
        );
        return parsed || {};
      }
    } catch { /* 修复失败, 落到下面 */ }
    console.warn(`[config] ${path} 解析失败且无法修复, 本次启动将使用默认配置 (请检查文件内容)`);
    return {};
  }
}

function modelFromDict(d: Record<string, unknown>): ModelConfig {
  return {
    model: String(d.model || DEFAULT_MODEL.model),
    apiKey: (d.api_key as string) || undefined,
    apiBase: (d.api_base as string) || undefined,
    temperature: Number(d.temperature) || DEFAULT_MODEL.temperature,
    maxTokens: Number(d.max_tokens) || DEFAULT_MODEL.maxTokens,
  };
}

export function loadSettings(configPath?: string): Settings {
  const path =
    configPath ||
    process.env.TIANYAN_CONFIG ||
    join(homedir(), ".tianyan", "config.yaml");

  // P2-6 修复: 回退路径改为项目根绝对路径 (bin/ 的上一级), 避免误读 CWD 下同名文件
  const here = dirname(fileURLToPath(import.meta.url));
  const actualPath = existsSync(path) ? path : existsSync(join(here, "config.yaml")) ? join(here, "config.yaml") : path;
  _configPath = actualPath;
  const raw = loadYaml(actualPath);

  const dataDir = String(raw.data_dir || '') || process.env.TIANYAN_DATA_DIR || join(homedir(), ".tianyan");
  mkdirSync(dataDir, { recursive: true });
  const uploadDir = join(dataDir, "uploads");
  mkdirSync(uploadDir, { recursive: true });

  const defaultModel = modelFromDict((raw.default_model as Record<string, unknown>) || {});
  // CLI/环境变量覆盖: TIANYAN_API_KEY / TIANYAN_MODEL (优先级最高, 无需改配置文件)
  const envKey = process.env.TIANYAN_API_KEY || process.env.AGNES_API_KEY || undefined;
  const envModel = process.env.TIANYAN_MODEL || undefined;
  const models = ((raw.models as Record<string, unknown>[]) || []).map(modelFromDict);
  // ★ 默认模型必须同时在 models 列表里。配置文件把 default_model 和 models 分开存,
  //   旧逻辑只在 models 为空时才塞入 default → 一旦 models 非空, defaultModel 就不在列表里,
  //   所有 `s.models.find(id)` 的代码都找不到它 (拿不到 apiBase/apiKey),
  //   于是"一键拉取模型/按 provider 取 key"直接退化到 OpenAI 默认 base → 拉取必然失败。
  if (!models.some((m) => m.model === defaultModel.model)) models.unshift(defaultModel);
  if (envKey) {
    defaultModel.apiKey = envKey;
    for (const m of models) m.apiKey = envKey;
  }
  if (envModel) {
    defaultModel.model = envModel;
    if (!models.some((m) => m.model === envModel)) models.push({ ...defaultModel, model: envModel });
  }

  const proxy = String(raw.proxy || '') || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || undefined;


  // Agent 配置: 从 YAML 读取, 合并默认值
  const rawAgents = (raw.agents as Record<string, Record<string, unknown>>) || {};
  const agents: Record<string, import("./types.js").AgentConfig> = {};
  for (const [name, defaults] of Object.entries(DEFAULT_AGENTS)) {
    const override = rawAgents[name] || {};
    agents[name] = {
      maxDepth: Number(override.max_depth) || defaults.maxDepth,
      maxTurns: Number(override.max_turns) || defaults.maxTurns,
      maxSteps: Number(override.max_steps) || defaults.maxSteps,
      modelTier: (override.model_tier as string) as import("./types.js").ModelTier || defaults.modelTier,
      readonly: override.readonly !== undefined ? Boolean(override.readonly) : defaults.readonly,
    };
  }

  const s: Settings = {
    dataDir,
    dbPath: join(dataDir, "novel.db"),
    uploadDir,
    defaultModel,
    models,
    maxSteps: Number(raw.max_steps) || DEFAULT_SETTINGS.maxSteps,
    runMaxTokens: Number(raw.run_max_tokens) || DEFAULT_SETTINGS.runMaxTokens,
    runMaxCost: Number(raw.run_max_cost) || DEFAULT_SETTINGS.runMaxCost,
    loopDetectCount: Number(raw.loop_detect_count) || DEFAULT_SETTINGS.loopDetectCount,
    runMaxDuration: Number(raw.run_max_duration) || DEFAULT_SETTINGS.runMaxDuration,
    sseHeartbeatInterval: Number(raw.sse_heartbeat_interval) || DEFAULT_SETTINGS.sseHeartbeatInterval,
    chunkSize: Number(raw.chunk_size) || DEFAULT_SETTINGS.chunkSize,
    chunkOverlap: Number(raw.chunk_overlap) || DEFAULT_SETTINGS.chunkOverlap,
    retrieveK: Number(raw.retrieve_k) || DEFAULT_SETTINGS.retrieveK,
    serverHost: (raw.server_host as string) || DEFAULT_SETTINGS.serverHost,
    serverPort: Number(process.env.TIANYAN_PORT) || Number(raw.server_port) || DEFAULT_SETTINGS.serverPort,
    proxy,
    agents,
    workflowMode: (raw.workflow_mode as "state_machine" | "crewai" | "autonomous") || DEFAULT_SETTINGS.workflowMode,
  };

  _settings = s;
  return s;
}

export function getSettings(): Settings {
  if (!_settings) return loadSettings();
  return _settings;
}

export function reloadSettings(): Settings {
  return loadSettings(_configPath || undefined);
}

export function saveSettings(): void {
  const s = getSettings();
  // 用 yaml 库序列化, 不再手拼字符串:
  // 1) 修复双引号 Windows 路径 (data_dir: "C:\Users\...") 产生非法 \U 转义 → 下次启动 YAML 解析
  //    静默失败、全部配置被重置的致命 bug; stringify 会自动选用安全的标量风格
  // 2) 修复 models 列表 slice(1) 丢首条 + length<=1 时整段被吞的问题 (现在全量写出)
  const doc: Record<string, unknown> = {
    data_dir: s.dataDir,
    default_model: {
      model: s.defaultModel.model,
      ...(s.defaultModel.apiKey ? { api_key: s.defaultModel.apiKey } : {}),
      ...(s.defaultModel.apiBase ? { api_base: s.defaultModel.apiBase } : {}),
      temperature: s.defaultModel.temperature,
      max_tokens: s.defaultModel.maxTokens,
    },
  };
  if (s.models.length > 0) {
    // 与 defaultModel 完全相同的条目不重复写
    doc.models = s.models
      .filter((m) => m.model !== s.defaultModel.model)
      .map((m) => ({
        model: m.model,
        ...(m.apiKey ? { api_key: m.apiKey } : {}),
        ...(m.apiBase ? { api_base: m.apiBase } : {}),
        temperature: m.temperature,
        max_tokens: m.maxTokens,
      }));
    if ((doc.models as unknown[]).length === 0) delete doc.models;
  }
  Object.assign(doc, {
    max_steps: s.maxSteps,
    server_port: s.serverPort,
    server_host: s.serverHost,
    run_max_tokens: s.runMaxTokens,
    run_max_cost: s.runMaxCost,
    run_max_duration: s.runMaxDuration,
    loop_detect_count: s.loopDetectCount,
    chunk_size: s.chunkSize,
    chunk_overlap: s.chunkOverlap,
    retrieve_k: s.retrieveK,
    workflow_mode: s.workflowMode,
  });
  if (s.proxy) doc.proxy = s.proxy;
  if (Object.keys(s.agents).length > 0) {
    const agents: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(s.agents)) {
      agents[name] = {
        max_depth: cfg.maxDepth,
        max_turns: cfg.maxTurns,
        max_steps: cfg.maxSteps,
        model_tier: cfg.modelTier,
        readonly: cfg.readonly,
      };
    }
    doc.agents = agents;
  }
  const header = "# 天衍 配置文件 (由系统自动保存, 可手动编辑)\n" +
    "# Agent 参数: max_depth 委派深度 / max_turns 最大轮次 / max_steps 工具轮次 / model_tier 档位(high/mid/low)\n";
  writeFileSync(_configPath, header + stringifyYaml(doc), "utf-8");
  // P1 修复: 配置文件含明文 API key → 写入后 chmod 0600 (仅属主可读写), 降低密钥泄漏面
  try { chmodSync(_configPath, 0o600); } catch { /* 非 POSIX 平台忽略 */ }
}
// 18 家厂商预设 (国内8 + 海外5 + 聚合4 + 本地1)
// 2026-10-17 二次核实: 三路并行对照官方文档/定价页/退役公告逐模型验证;
// 本轮删除: qwq-32b (2026-05-31 下线)、glm-4.5-flash (官方标"即将下线")、
// 腾讯混元旧版全系 (turbos-latest/t1-latest/standard/large/lite 2026-06-26 停调, hy3-preview 2026-08-31 下线)、
// step-2-16k (官方列表已无)、Mistral 退役 5 款 (magistral 双款/devstral 双款/nemo, 2026-07-31 起 404)、
// deepseek-v4-flash-vision-exp (官方文档未列出);
// 修正: doubao-seed-evolving → -latest-version (官方在售 ID), OpenRouter sonnet-5 → sonnet-5.5,
// Together Qwen3-235B → FP8 版 ID (BF16 已并轨);
// 保留待观察: gpt-5/gpt-5-mini (2026-12-11 才移除, 仍可调用)、glm-5/glm-5-turbo、claude-haiku-4-5
// 早前已删: 零一万物整家 (2026-09-03 关停)、kimi-k2.5 (2026-08-31 停服)、
// Claude Sonnet 4/Haiku 3.5、deepseek-chat/reasoner (2026-07-24 退役)、小米 MiMo V2.5 (2026-10-21 下线)
export const PROVIDER_PRESETS: {
  provider: string;
  label: string;
  models: string[];
  env: string;
  apiBase: string;
}[] = [
  // ===== 国内直连 (无需代理) =====
  // ---------- DeepSeek 深度求索 (https://api-docs.deepseek.com/) ----------
  // 2026-10 核实: 现行规范 ID 为 deepseek-flash (V4.1-Flash, 2026-09-10) 与 deepseek-v4-pro (V4-Pro-0813);
  // 旧别名 deepseek-v4-flash 仍可用 (路由到 V4.1-Flash); vision-exp 官方文档未列出, 已移除;
  // V3.1/R1 仅开源权重, API 不再提供; deepseek-chat/reasoner 2026-07-24 退役
  { provider: "deepseek", label: "DeepSeek 深度求索", models: [
    "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
  ], env: "DEEPSEEK_API_KEY", apiBase: "https://api.deepseek.com/v1" },
  // ---------- 阿里云通义千问 DashScope (https://help.aliyun.com/zh/model-studio/models) ----------
  // 2026-10 核实: qwen3.8-max/qwen3.8-flash 为当前旗舰与极速款; qwen3.7/qwen3.6 系列在售;
  // qwq-32b 已于 2026-05-31 下线 (官方公告), 移除
  { provider: "dashscope", label: "阿里云通义千问 (DashScope)", models: [
    "dashscope/qwen3.8-max", "dashscope/qwen3.8-flash",
    "dashscope/qwen3.7-max", "dashscope/qwen3.7-plus",
    "dashscope/qwen3.6-plus", "dashscope/qwen3.6-flash",
  ], env: "DASHSCOPE_API_KEY", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  // ---------- 智谱 GLM (https://docs.bigmodel.cn/api-reference/模型-api/对话补全异步) ----------
  // 2026-10 核实: GLM-5.3 (2026-08 发布, 1M 上下文) 为最新旗舰; glm-4.7-flash 免费;
  // glm-4.5-flash 官方标"即将下线"且已被 4.7-flash 取代, 移除; glm-5/glm-5-turbo 待观察
  { provider: "zai", label: "智谱 GLM (Z.AI)", models: [
    "zai/glm-5.3", "zai/glm-5.3-flash",
    "zai/glm-5.2", "zai/glm-5.1", "zai/glm-5-turbo", "zai/glm-5",
    "zai/glm-4.7", "zai/glm-4.7-flash", "zai/glm-4.6", "zai/glm-4.5-air",
  ], env: "ZAI_API_KEY", apiBase: "https://open.bigmodel.cn/api/paas/v4" },
  // ---------- 月之暗面 Kimi (https://platform.kimi.com/docs/models) ----------
  // 2026-10 核实: 在售 kimi-k3 / k2.7-code(+highspeed) / k2.6; kimi-k2.5 已于 2026-08-31 停服(404), 移除
  { provider: "moonshot", label: "月之暗面 Kimi", models: [
    "moonshot/kimi-k3", "moonshot/kimi-k2.7-code", "moonshot/kimi-k2.7-code-highspeed",
    "moonshot/kimi-k2.6",
  ], env: "MOONSHOT_API_KEY", apiBase: "https://api.moonshot.cn/v1" },
  // ---------- 火山引擎 豆包 Doubao (模型发布公告, 核实至 2026-10-15) ----------
  { provider: "volcengine", label: "火山引擎 豆包 Doubao", models: [
    "volcengine/doubao-seed-2-1-pro-260915", "volcengine/doubao-seed-2-1-lite-260915",
    "volcengine/doubao-seed-evolving-latest-version", "volcengine/doubao-seed-2-1-pro-260628",
    "volcengine/doubao-seed-2-1-turbo-260628", "volcengine/doubao-seed-2-0-pro-260215",
    "volcengine/doubao-seed-2-0-lite-260428", "volcengine/doubao-seed-2-0-mini-260428",
    "volcengine/doubao-seed-2-0-code-preview-260215", "volcengine/doubao-seed-character-260628",
  ], env: "VOLCENGINE_API_KEY", apiBase: "https://ark.cn-beijing.volces.com/api/v3" },
  // ---------- 百度 文心 ERNIE (千帆官方模型列表, 核实至 2026-09) ----------
  // 通过千帆 v2 OpenAI 兼容接口调用, 需用 openai/ 前缀 + 自定义 base
  // 已移除: ernie-4.0 系列 / ernie-speed-pro / ernie-x1 系列 (官方列表已不含; x1.1 官方标注"即将下线")
  { provider: "baidu", label: "百度 文心 ERNIE (千帆)", models: [
    "openai/ernie-5.1", "openai/ernie-5.0", "openai/ernie-5.0-thinking-latest",
    "openai/ernie-4.5-turbo-128k", "openai/ernie-4.5-turbo-32k", "openai/ernie-4.5-turbo-vl",
  ], env: "ERNIE_API_KEY", apiBase: "https://qianfan.baidubce.com/v2" },
  // ---------- 小米 MiMo (官方模型列表, 2026-10 核实: v2.5 系列 2026-10-21 下线, 已换 v2.6) ----------
  { provider: "xiaomi", label: "小米 MiMo", models: [
    "openai/mimo-v2.6-pro", "openai/mimo-v2.6-flash",
  ], env: "XIAOMI_API_KEY", apiBase: "https://api.xiaomimimo.com/v1" },
  // ---------- 华为盘古 MaaS (ModelArts 官方文档, 核实至 2026-09-29) ----------
  { provider: "huawei", label: "华为盘古 MaaS (ModelArts)", models: [
    "openai/openpangu-2.0-pro", "openai/openpangu-2.0-flash",
    "openai/glm-5.3", "openai/glm-5.2", "openai/glm-5.1",
    "openai/kimi-k2.6",
    "openai/deepseek-v4.1-flash", "openai/deepseek-v4-pro", "openai/deepseek-v4-flash",
    "openai/qwen3-32b",
  ], env: "MAAS_API_KEY", apiBase: "https://api.modelarts-maas.com/v2" },
  // ---------- 硅基流动 SiliconFlow (https://siliconflow.cn/models, 2026-10 核实) ----------
  // 国内聚合开源模型: DeepSeek / Qwen / GLM / Kimi / MiniMax 等; V4-Flash 已自动路由到 V4.1
  { provider: "siliconflow", label: "硅基流动 SiliconFlow (聚合)", models: [
    "siliconflow/deepseek-ai/DeepSeek-V4.1-Flash",
    "siliconflow/deepseek-ai/DeepSeek-V4-Pro",
    "siliconflow/deepseek-ai/DeepSeek-V4-Flash",
    "siliconflow/deepseek-ai/DeepSeek-V3.2",
    "siliconflow/zai-org/GLM-5.3", "siliconflow/zai-org/GLM-5.3-Flash", "siliconflow/zai-org/GLM-5.2",
    "siliconflow/moonshotai/Kimi-K3", "siliconflow/moonshotai/Kimi-K2.7-Code", "siliconflow/moonshotai/Kimi-K2.6",
    "siliconflow/Qwen/Qwen3.6-35B-A3B", "siliconflow/Qwen/Qwen3.6-27B", "siliconflow/Qwen/Qwen3.5-35B-A3B",
    "siliconflow/MiniMaxAI/MiniMax-M3",
  ], env: "SILICONFLOW_API_KEY", apiBase: "https://api.siliconflow.cn/v1" },
  // ===== 海外直连 (需代理或国内无法访问) =====
  // ---------- OpenAI (https://platform.openai.com/docs/models) ----------
  // 2026-10 核实: GPT-6 系列 (Astra 9-03 / Sol 9-22 / Luna 9-22 / 6.1 Sol 9-29) 为当前在售;
  // GPT-5.6 全系保留; gpt-5.5-pro / gpt-5.4-mini / gpt-5.4-pro 无官方记录, 已移除
  { provider: "openai", label: "OpenAI", models: [
    "openai/gpt-6.1-sol", "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna",
    "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna",
    "openai/gpt-5.5", "openai/gpt-5.4",
    "openai/gpt-5", "openai/gpt-5-mini",
  ], env: "OPENAI_API_KEY", apiBase: "https://api.openai.com/v1" },
  // ---------- Anthropic Claude (官方模型总览, 2026-10 核实) ----------
  // 在售: Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5 / Haiku 4.5; 上一代 Opus 4.8 / Sonnet 4.6 仍在服务;
  // 已退役: claude-sonnet-4-20250514 / claude-opus-4 / claude-3-5-haiku (2026 年中退役), 已移除
  { provider: "anthropic", label: "Anthropic Claude", models: [
    "anthropic/claude-fable-5-1", "anthropic/claude-opus-5-5", "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5",
    "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6",
  ], env: "ANTHROPIC_API_KEY", apiBase: "https://api.anthropic.com/v1" },
  // ---------- Google Gemini (https://ai.google.dev/gemini-api/docs/models) ----------
  // 2026-10 核实: 3.8 Flash (9-02 GA) 当前主力; 3.5-flash 已于 10-08 弃用, 移除;
  // 3.1 系列只有 pro-preview 与 flash-lite (无 "gemini-3.1-flash", 已移除)
  { provider: "gemini", label: "Google Gemini", models: [
    "gemini/gemini-3.8-flash", "gemini/gemini-3.6-flash",
    "gemini/gemini-3.5-flash-lite", "gemini/gemini-3.1-flash-lite",
    "gemini/gemini-3.1-pro-preview",
  ], env: "GEMINI_API_KEY", apiBase: "https://generativelanguage.googleapis.com/v1beta" },
  // ---------- xAI Grok (https://docs.x.ai/docs/models) ----------
  // 2026-10 核实: grok-4.7 (9-21) 当前旗舰; grok-4-0709 / grok-4.1 系列 / grok-4-fast 已于 5-15 退役, 移除
  { provider: "xai", label: "xAI Grok", models: [
    "xai/grok-4.7", "xai/grok-4.6", "xai/grok-4.5",
    "xai/grok-4.3", "xai/grok-4.20-0309-reasoning", "xai/grok-build-0.1",
  ], env: "XAI_API_KEY", apiBase: "https://api.x.ai/v1" },
  // ---------- Mistral AI (https://docs.mistral.ai/getting-started/models/models_overview/) ----------
  // 2026-10 核实: Large 3 / Medium 3.5 / Small 4 / Ministral 3 为当前代;
  // magistral 双款 / devstral 双款 / mistral-nemo 已于 2026-07-31 退役 (调用 404), 移除
  { provider: "mistral", label: "Mistral AI", models: [
    "mistral/mistral-large-latest",
    "mistral/mistral-medium-latest", "mistral/mistral-small-latest",
    "mistral/codestral-latest",
    "mistral/ministral-14b-latest", "mistral/ministral-8b-latest", "mistral/ministral-3b-latest",
  ], env: "MISTRAL_API_KEY", apiBase: "https://api.mistral.ai/v1" },
  // ===== 聚合平台 (一个 Key 用多家模型) =====
  // ---------- OpenRouter (https://openrouter.ai/models) ----------
  // 2026-10 核实周榜在榜: DeepSeek V4.1 Flash / GLM 5.3(Flash) / Step 5 Preview / MiMo V2.6 Flash /
  // GPT-6 Luna / Claude Opus 5.5 / Hy4 preview 等
  { provider: "openrouter", label: "OpenRouter (全球聚合)", models: [
    "openrouter/deepseek/deepseek-v4.1-flash",
    "openrouter/z-ai/glm-5.3-flash", "openrouter/z-ai/glm-5.3",
    "openrouter/openai/gpt-6-luna", "openrouter/openai/gpt-6.1-sol",
    "openrouter/anthropic/claude-opus-5.5", "openrouter/anthropic/claude-sonnet-5.5",
    "openrouter/google/gemini-3.8-flash", "openrouter/google/gemini-3.1-pro-preview",
    "openrouter/xai/grok-4.7",
    "openrouter/xiaomi/mimo-v2.6-flash",
    "openrouter/qwen/qwen3-max",
    "openrouter/meta-llama/llama-3.3-70b-instruct",
    "openrouter/mistralai/mistral-large",
  ], env: "OPENROUTER_API_KEY", apiBase: "https://openrouter.ai/api/v1" },
  // ---------- Together AI (https://docs.together.ai/docs/inference-models) ----------
  // 2026-10 核实官方 changelog/定价页: 现役 DeepSeek V4 系 / GLM-5.x / Kimi K3 / Qwen3.8 / MiniMax M3;
  // Llama-3.1-405B 已下市, 移除
  { provider: "together_ai", label: "Together AI (聚合)", models: [
    "together_ai/deepseek-ai/DeepSeek-V4-Pro-0813",
    "together_ai/deepseek-ai/DeepSeek-V4.1-Flash",
    "together_ai/zai-org/GLM-5.3", "together_ai/zai-org/GLM-5.3-Flash",
    "together_ai/moonshotai/Kimi-K3",
    "together_ai/Qwen/Qwen3.8-2.4T-A95B",
    "together_ai/MiniMaxAI/MiniMax-M3",
    "together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "together_ai/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8",
    "together_ai/openai/gpt-oss-120b",
  ], env: "TOGETHERAI_API_KEY", apiBase: "https://api.together.xyz/v1" },
  // ---------- Fireworks AI (官方模型清单核实, 2026-10) ----------
  { provider: "fireworks_ai", label: "Fireworks AI (聚合)", models: [
    "fireworks_ai/accounts/fireworks/models/deepseek-v4p1-flash",
    "fireworks_ai/accounts/fireworks/models/deepseek-v4-pro",
    "fireworks_ai/accounts/fireworks/models/glm-5p3-flash",
    "fireworks_ai/accounts/fireworks/models/kimi-k3",
    "fireworks_ai/accounts/fireworks/models/llama-v3p3-70b-instruct",
    "fireworks_ai/accounts/fireworks/models/qwen3-235b-a22b-instruct",
  ], env: "FIREWORKS_API_KEY", apiBase: "https://api.fireworks.ai/inference/v1" },
  // ---------- 零一万物 01.AI ----------
  // 已移除: 公共 API 平台 2026-09-03 24:00 起停止模型体验与 API 调用 (官方公告)
  // ---------- 百川智能 Baichuan (官方定价页, 2026-10 核实) ----------
  { provider: "baichuan", label: "百川智能 Baichuan", models: [
    "baichuan/baichuan4-turbo", "baichuan/baichuan4-air",
    "baichuan/baichuan3-turbo-128k", "baichuan/baichuan3-turbo",
  ], env: "BAICHUAN_API_KEY", apiBase: "https://api.baichuan-ai.com/v1" },
  // ---------- 阶跃星辰 StepFun (https://platform.stepfun.com/) ----------
  // 2026-10 核实: step-5-preview (10-15) 最新; 3.7/3.5 Flash 为在售主力; step-2 系列官方列表已无, 移除
  { provider: "stepfun", label: "阶跃星辰 StepFun", models: [
    "stepfun/step-5-preview", "stepfun/step-3.7-flash", "stepfun/step-3.5-flash",
  ], env: "STEPFUN_API_KEY", apiBase: "https://api.stepfun.com/v1" },
  // ---------- 腾讯混元 Hunyuan (https://cloud.tencent.com/product/hunyuan) ----------
  // 2026-10 核实: 当前在售主力为 hy3 (hy3-preview 2026-08-31 下线并自动切换 hy3);
  // 旧版 turbos-latest/t1-latest/standard/large/lite 2026-06-26 停调 (官方公告), 全部移除
  { provider: "hunyuan", label: "腾讯混元 Hunyuan", models: [
    "hunyuan/hy3", "hunyuan/hy3-thinking",
  ], env: "HUNYUAN_API_KEY", apiBase: "https://api.hunyuan.cloud.tencent.com/v1" },

  // ---------- Agnes AI (官方 wiki, 2026-10 核实: 2.5 Pro 8-01 发布; 3.0-flash 已上定价页) ----------
  { provider: "agnes", label: "Agnes AI", models: [
    "agnes/agnes-2.5-pro", "agnes/agnes-2.5-flash", "agnes/agnes-3.0-flash",
  ], env: "AGNES_API_KEY", apiBase: "https://apihub.agnes-ai.com/v1" },
  // ===== 本地部署 =====
  // ---------- Ollama 本地 (https://ollama.com/library — 2026-10-17 逐条核实) ----------
  { provider: "ollama", label: "Ollama 本地", models: [
    // Qwen 系列 (阿里云通义)
    "ollama/qwen3.8:27b", "ollama/qwen3.8-flash-next",
    "ollama/qwen3.6:35b", "ollama/qwen3.6:27b",
    "ollama/qwen3.5:35b", "ollama/qwen3.5:27b", "ollama/qwen3.5:9b", "ollama/qwen3.5:4b",
    "ollama/qwen3-coder:30b",
    "ollama/qwen3:32b", "ollama/qwen3:14b", "ollama/qwen3:8b", "ollama/qwen3:4b",
    "ollama/qwen2.5:72b", "ollama/qwen2.5:32b", "ollama/qwen2.5:14b", "ollama/qwen2.5:7b",
    "ollama/qwen2.5-coder:32b", "ollama/qwen2.5-coder:14b",
    // DeepSeek 系列
    "ollama/deepseek-v4.1-flash", "ollama/deepseek-v4-pro",
    "ollama/deepseek-v3.1",
    "ollama/deepseek-r1:70b", "ollama/deepseek-r1:32b", "ollama/deepseek-r1:14b", "ollama/deepseek-r1:8b", "ollama/deepseek-r1:7b", "ollama/deepseek-r1:1.5b",
    // Meta Llama 系列
    "ollama/llama4:scout", "ollama/llama4:maverick",
    "ollama/llama3.3:70b", "ollama/llama3.1:8b",
    "ollama/llama3.2:3b", "ollama/llama3.2:1b",
    // Google Gemma 系列
    "ollama/gemma4:31b", "ollama/gemma4:26b", "ollama/gemma4:12b",
    "ollama/gemma3:27b", "ollama/gemma3:12b", "ollama/gemma3:4b",
    // Mistral 系列
    "ollama/mistral-large-3", "ollama/mistral-medium-3.5", "ollama/mistral:7b", "ollama/mistral-nemo", "ollama/mistral-small3.2",
    // Microsoft Phi 系列
    "ollama/phi4:14b", "ollama/phi4-mini:3.8b", "ollama/phi4-reasoning:14b",
    // NVIDIA Nemotron 系列
    "ollama/nemotron-3-ultra", "ollama/nemotron-3-super", "ollama/nemotron-3-nano:30b", "ollama/nemotron-3.5-lightning",
    // 国产模型
    "ollama/glm-5.3", "ollama/glm-5.3-flash", "ollama/glm-5.2", "ollama/glm-4.7-flash",
    "ollama/kimi-k3", "ollama/kimi-k2.7-code", "ollama/kimi-k2.6",
    "ollama/minimax-m3", "ollama/minimax-m2.7",
    "ollama/gpt-oss:120b", "ollama/gpt-oss:20b",
    // 其他
    "ollama/command-a", "ollama/command-r-plus",
    "ollama/codestral:22b", "ollama/devstral-2", "ollama/devstral-small-2",
  ], env: "", apiBase: "http://localhost:11434/v1" },
];

function stripProviderPrefix(model: string): string {
  // agnes/agnes-2.5-flash -> agnes-2.5-flash; openai/gpt-4o -> gpt-4o
  const idx = model.indexOf("/");
  if (idx <= 0) return model;
  const provider = model.slice(0, idx);
  const rest = model.slice(idx + 1);
  // 已知聚合 provider 前缀才剥离, 避免误伤 openrouter/openai/gpt-5.6-sol 这类路径式模型名
  const stripable = new Set(["openai", "anthropic", "gemini", "deepseek", "mistral", "xai", "olan", "agnes", "zai", "zhipu", "glm", "moonshot", "dashscope", "volcengine", "baidu", "ernie", "qianfan", "siliconflow", "openrouter", "together_ai", "fireworks_ai", "yi", "baichuan", "stepfun", "hunyuan"]);
  return stripable.has(provider) ? rest : model;
}

export function updateModelConfig(
  model: string,
  opts: { apiKey?: string; apiBase?: string; temperature?: number; maxTokens?: number },
): void {
  const s = getSettings();
  let target: ModelConfig | undefined = s.models.find((m) => m.model === model);
  const isNew = !target;
  if (isNew) {
    target = { ...DEFAULT_MODEL, model };
    s.models.push(target);
  }
  if (target) {
    // apiKey: 只有明确传入非空值才更新,空字符串/null/undefined不删除已有密钥
    if (opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== "") {
      target.apiKey = opts.apiKey;
    }
    if (opts.apiBase !== undefined) target.apiBase = opts.apiBase || undefined;
    if (opts.temperature !== undefined) target.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) target.maxTokens = opts.maxTokens;
  }
  if (isNew && target && (!s.models.length || !s.models.some((m) => m.model === s.defaultModel.model))) {
    s.defaultModel = target;
  }
  if (target && s.defaultModel.model === model) s.defaultModel = target;

  // 别名同步: agnes/agnes-2.5-flash 与 agnes-2.5-flash 是同一后端模型
  // 用户配置任一别名, 密钥/base/温度同步到另一别名, 避免"配置了却未生效"
  const stripped = stripProviderPrefix(model);
  const defaultStripped = stripProviderPrefix(s.defaultModel.model);
  if (stripped && stripped === defaultStripped && target && s.defaultModel.model !== model) {
    if (opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== "") s.defaultModel.apiKey = opts.apiKey;
    if (opts.apiBase !== undefined) s.defaultModel.apiBase = opts.apiBase || undefined;
    if (opts.temperature !== undefined) s.defaultModel.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) s.defaultModel.maxTokens = opts.maxTokens;
  }
  saveSettings();
}

export function removeModelConfig(model: string): void {
  const s = getSettings();
  s.models = s.models.filter((m) => m.model !== model);
  if (s.defaultModel.model === model) {
    s.defaultModel = s.models[0] || { ...DEFAULT_MODEL };
  }
  saveSettings();
}

// 更新单个 Agent 参数 (合并默认值)
export function updateAgentConfig(
  name: string,
  opts: { maxDepth?: number; maxTurns?: number; maxSteps?: number; modelTier?: string; readonly?: boolean },
): void {
  const s = getSettings();
  const defaults = DEFAULT_AGENTS[name];
  if (!defaults) {
    // 未知 agent: 用默认值作为底
    s.agents[name] = {
      maxDepth: opts.maxDepth ?? 1,
      maxTurns: opts.maxTurns ?? 6,
      maxSteps: opts.maxSteps ?? 10,
      modelTier: (opts.modelTier as import("./types.js").ModelTier) ?? "mid",
      readonly: opts.readonly ?? false,
    };
  } else {
    const cur = s.agents[name] || defaults;
    s.agents[name] = {
      maxDepth: opts.maxDepth ?? cur.maxDepth ?? defaults.maxDepth,
      maxTurns: opts.maxTurns ?? cur.maxTurns ?? defaults.maxTurns,
      maxSteps: opts.maxSteps ?? cur.maxSteps ?? defaults.maxSteps,
      modelTier: (opts.modelTier as import("./types.js").ModelTier) ?? cur.modelTier ?? defaults.modelTier,
      readonly: opts.readonly !== undefined ? opts.readonly : (cur.readonly ?? defaults.readonly),
    };
  }
  saveSettings();
}

// 更新全局 Agent/工作流参数
export function updateGlobalSettings(
  opts: { maxSteps?: number; chunkSize?: number; retrieveK?: number; runMaxTokens?: number; runMaxCost?: number; runMaxDuration?: number; loopDetectCount?: number },
): void {
  const s = getSettings();
  if (opts.maxSteps !== undefined) s.maxSteps = opts.maxSteps;
  if (opts.chunkSize !== undefined) s.chunkSize = opts.chunkSize;
  if (opts.retrieveK !== undefined) s.retrieveK = opts.retrieveK;
  if (opts.runMaxTokens !== undefined) s.runMaxTokens = opts.runMaxTokens;
  if (opts.runMaxCost !== undefined) s.runMaxCost = opts.runMaxCost;
  if (opts.runMaxDuration !== undefined) s.runMaxDuration = opts.runMaxDuration;
  if (opts.loopDetectCount !== undefined) s.loopDetectCount = opts.loopDetectCount;
  saveSettings();
}

// 获取当前 Agent 配置 (含默认值, 供前端渲染)
export function getAgentConfigs(): Record<string, import("./types.js").AgentConfig> {
  const s = getSettings();
  const out: Record<string, import("./types.js").AgentConfig> = {};
  for (const [name, defaults] of Object.entries(DEFAULT_AGENTS)) {
    const cur = s.agents[name] || defaults;
    out[name] = { ...defaults, ...cur };
  }
  return out;
}

/** 按 agent 的 modelTier 解析实际模型 (模型识别的闭环, 对齐 Codex model_providers 用户可配):
 *  优先级: ① modelTiers[tier] 显式映射 → ② defaultModel (向后兼容: 未配映射则全档共用默认模型)
 *  返回 ModelConfig (含该模型的 apiKey/apiBase/temperature/maxTokens), 供 runner 传给 chat/stream。 */
export function pickModelForAgent(agentName: string): import("./types.js").ModelConfig {
  const s = getSettings();
  const tierCfg = getAgentConfigs()[agentName];
  const tier = tierCfg?.modelTier || "mid";
  // ① 档位→模型 映射 (前端可配"哪档用哪个模型")
  const tierModelName = s.modelTiers?.[tier];
  if (tierModelName) {
    const found = s.models.find((m) => m.model === tierModelName) || s.defaultModel;
    if (found) return found;
  }
  // ② 落回 defaultModel (现状行为, 映射未配置时)
  return s.defaultModel;
}

/** 列出当前档位映射配置 (供前端渲染 tier→model 下拉) */
export function getModelTierMap(): import("./types.js").ModelTierMap {
  const s = getSettings();
  return s.modelTiers || {};
}

/** 更新档位映射 (high/mid/low → 模型名), 传 undefined 清除某档映射 */
export function setModelTierMap(tiers: import("./types.js").ModelTierMap): void {
  const s = getSettings();
  s.modelTiers = { ...s.modelTiers, ...tiers };
  saveSettings();
}
