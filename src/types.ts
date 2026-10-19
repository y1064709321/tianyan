// ===== 天衍 (Tianyan) TypeScript 核心类型定义 =====

// ----- 配置 -----
export interface ModelConfig {
  model: string;
  apiKey?: string;
  apiBase?: string;
  temperature: number;
  maxTokens: number;
}


// ----- Agent 配置 -----
export interface AgentConfig {
  /** 最大委派深度 (总编→X→Y，最多几层) */
  maxDepth: number;
  /** 单个 agent 最大轮次 */
  maxTurns: number;
  /** 单个 agent 最大步数 */
  maxSteps: number;
  /** 模型档位: high/mid/low */
  modelTier: ModelTier;
  /** 是否只读 */
  readonly: boolean;
}

/** Agent 标准配置 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxDepth: 2,
  maxTurns: 6,
  maxSteps: 8,
  modelTier: "mid",
  readonly: false,
};
export type WorkflowMode = "state_machine" | "crewai" | "autonomous";

export interface Settings {
  dataDir: string;
  dbPath: string;
  uploadDir: string;
  defaultModel: ModelConfig;
  models: ModelConfig[];
  maxSteps: number;
  runMaxTokens: number;
  runMaxCost: number;
  loopDetectCount: number;
  runMaxDuration: number;    // 秒
  sseHeartbeatInterval: number; // 秒
  chunkSize: number;
  chunkOverlap: number;
  retrieveK: number;
  serverHost: string;
  serverPort: number;
  proxy?: string;
  workflowMode: WorkflowMode;  // 默认状态机模式，需要时切多agent协作
  agents: Record<string, Partial<AgentConfig>>;
  /** 档位→模型 映射: 未配置档位时落回 defaultModel (向后兼容) */
  modelTiers?: import("./types.js").ModelTierMap;
  /** 模型上下文窗口 (tokens)。默认 128000 — 超过比例阈值自动压缩早期对话 */
  contextWindow?: number;
  /** 触发自动压缩的阈值比例 (占 contextWindow), 默认 0.75 */
  contextCompactRatio?: number;
  /** 压缩后保留最近对话的比例 (占 contextWindow), 默认 0.35 */
  contextKeepRatio?: number;
}

// ----- Agent -----
export type AgentName =
  | "orchestrator"
  | "story-architect"
  | "narrative-writer"
  | "character-designer"
  | "consistency-checker"
  | "story-explorer"
  | "presenter";

export type ModelTier = "high" | "mid" | "low";
export type SandboxMode = "read-write" | "read-only";

/** 档位→模型 映射 (前端可配"哪档用哪个模型", 对齐 Codex model_providers 用户可配思路) */
export interface ModelTierMap {
  high?: string; // 高(旗舰)档 → 模型名
  mid?: string;  // 中(均衡)档 → 模型名
  low?: string;  // 低(轻量)档 → 模型名
}

export interface AgentMeta {
  name: AgentName;
  label: string;
  role: string;
  icon: string;
  phase: string;
  modelTier: ModelTier;
  sandbox: SandboxMode;
  tools: string[];
}

export interface AgentPrompt {
  system: string;
  tools: string[];
}

// ----- 工具 -----
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolResult {
  [key: string]: unknown;
  error?: string;
}

export type ToolHandler = (
  pid: string,
  args: Record<string, unknown>,
) => Promise<ToolResult | string>;

// ----- 记忆 -----
export type MemoryCategory =
  | "character" | "plot" | "style" | "preference"
  | "world" | "lesson" | "context" | "decision" | "feedback";

export type MemorySource = "user" | "agent" | "auto";
export type MemoryTier = "short" | "long";

export interface SessionMemory {
  id: string;
  projectId: string;
  sessionId: string;
  category: string;
  topic: string;
  content: string;
  source: MemorySource;
  relevance: number;
  createdAt: number;
  expiresAt: number;
}

export interface LongTermMemory {
  id: string;
  projectId: string;
  category: string;
  topic: string;
  content: string;
  source: MemorySource;
  priority: number;       // 1-10
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryConflict {
  id: string;
  projectId: string;
  oldMemoryId: string;
  newMemoryId: string;
  resolution: "superseded" | "merged" | "kept_both" | "kept_old";
  reason: string;
  createdAt: number;
}

// ----- 数据模型 -----
export interface Project {
  id: string;
  name: string;
  genre: string;
  premise: string;
  style: string;
  audience: string;
  meta: string;
  currentPhase: number;
  createdAt: number;
}

export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  idx: number;
  outline: string;
  content: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface Element {
  id: string;
  projectId: string;
  kind: "character" | "location" | "lore" | "timeline";
  name: string;
  detail: string;
  createdAt: number;
}

export interface Chunk {
  id: string;
  projectId: string;
  source: string;
  idx: number;
  text: string;
  embedding?: string;
  createdAt: number;
}

export interface Message {
  id: string;
  projectId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  createdAt: number;
}

export interface Run {
  id: string;
  projectId: string;
  userInput: string;
  agentName: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
}

export interface CharacterProfile {
  id: string;
  projectId: string;
  name: string;
  role?: string;
  personality?: string;
  speechStyle?: string;
  behaviorLogic?: string;
  motivation?: string;
  arc?: string;
  growthState?: string;
  createdAt: number;
  updatedAt: number;
}

// ----- SSE 事件 -----
export type SSEEvent =
  | { type: "start"; agent: AgentName; input: string; runId?: string }
  | { type: "think_start"; agent: AgentName; round: number }
  | { type: "think_token"; agent: AgentName; text: string }
  | { type: "think_end"; agent: AgentName; feasible: boolean; reason: string; plan: string[]; missing: string }
  | { type: "answer_start"; agent: AgentName }
  | { type: "answer_end"; agent: AgentName }
  | { type: "step"; agent: AgentName; tool: string; args: Record<string, unknown>; thinking?: string }
  | { type: "delegate"; from: AgentName; to: AgentName; task: string; depth: number }
  | { type: "delegate_done"; from: AgentName; to: AgentName; task: string; result: string; durationMs: number }
  | { type: "sub_agent_start"; agent: AgentName; task: string; depth: number }
  | { type: "sub_agent_done"; agent: AgentName; result: string; durationMs: number }
  | { type: "sub_answer"; agent: AgentName; text: string }
  | { type: "sub_think"; agent: AgentName; text: string }
  | { type: "sub_agent_error"; agent: AgentName; error: string }
  | { type: "observation"; agent: AgentName; tool: string; result: string }
  | { type: "token"; agent: AgentName; content: string }
  | { type: "done"; agent: AgentName; steps: number; stats: Record<string, unknown>; runId: string }
  | { type: "error"; message: string }
  | { type: "heartbeat"; ts: number; runId: string }
  | { type: "sandbox_validate"; agent: AgentName; tool: string; passed: boolean; issues: string[] }
  | { type: "forced_revision"; agent: AgentName; score: number; review: string; chapterId: string; reason: string; phase?: number }
  | { type: "review_passed"; agent: AgentName; score: number; newPhase: number; chapterId: string; qcPassed?: boolean; note?: string }
  | { type: "phase_advanced"; agent: AgentName; from: number; to: number }
  | { type: "usage"; agent: AgentName; usage: { promptTokens: number; cachedTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } }
  | { type: "cache_stats"; agent: AgentName; promptTokens: number; cachedTokens: number; rate: number; calls: number }
  // ===== autonomous 模式新增事件 =====
  // 主 Agent 的规划决策(让前端看见"它为什么做这个决定")
  | { type: "planner_decision"; agent: AgentName; intent: string; route: string; reason: string; steps: string[] }
  // 弧线调整结果
  | { type: "arc_adjusted"; agent: AgentName; from: number; to: number; reason: string }
  // ===== 主 agent 询问门禁 (P1) =====
  | { type: "gate_question"; agent: AgentName; phase: number; nextPhase: number; question: string }
  | { type: "gate_cleared"; agent: AgentName; phase: number }
  // ===== 模型识别 (档位→模型 闭环) =====
  | { type: "model_picked"; agent: AgentName; tier: string; model: string }
  // ===== LLM 断线自动重连提示 (前端转圈条) =====
  | { type: "llm_reconnecting"; agent: AgentName; attempt: number; max: number; interval_s: number }
  | { type: "llm_reconnect_ok"; agent: AgentName }
  // 聊天里新建了项目 (前端据此刷新项目列表; run 结束后再切过去, 避免打断当前流)
  | { type: "project_created"; agent: AgentName; id: string; name: string };

// ----- LLM -----
export interface LLMResponse {
  content: string;
  reasoningContent?: string;
  model?: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;       // prefix cache 命中 token 数
    cacheReadTokens?: number;    // Anthropic 专属: cache 读取
    cacheCreationTokens?: number; // Anthropic 专属: cache 写入
  };
}

// ----- 工作流阶段 -----
export interface WorkflowPhase {
  phase: number;
  name: string;
  agent?: AgentName;
  agents?: AgentName[];
  description: string;
  loop?: "reject" | "next-chapter";
}

// ----- autonomous 模式: 规划层产物 -----
/** 感知层理解出的用户意图 */
export type PlannerIntent = "create_project" | "advance" | "execute_phase" | "run_full_pipeline" | "revise" | "query_status" | "chat";

/** 主 Agent 的一次决策: 为什么选这条路 + 接下来几步 */
export interface PlannerDecision {
  intent: PlannerIntent;
  /** 决策一句话理由(给前端展示) */
  reason: string;
  /** 计划执行的工具/步骤(摘要) */
  steps: string[];
  /** 决定委派给哪个子 agent(空 = orchestrator 自办) */
  targetAgent: AgentName | "";
  /** 目标阶段(执行用) */
  targetPhase: number;
}

/** 全书弧线快照(每章完成后更新) */
export interface ArcSnapshot {
  chapterIdx: number;
  /** 当前累计爽点密度(每1000字爽点数) */
  density: number;
  /** 是否被总编/质检打回过 */
  rejected: boolean;
  /** 时间戳 */
  ts: number;
}
