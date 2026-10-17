// LLM 统一接入层 — Node 原生 fetch, 支持所有 OpenAI 兼容 API
// 不再依赖 Python 子进程, 零延迟启动, 内置连接池
import { getSettings } from "./config.js";
import type { ModelConfig, ToolCall, ToolDefinition } from "./types.js";
import type { LLMResponse } from "./types.js";
import { logInfo, logWarn } from "./logger.js";

const LLM_TIMEOUT_MS = 90_000;          // 非流式: 连接 + 完整响应
const LLM_STREAM_TOTAL_MS = 300_000;    // 流式总预算: 长 reasoning 生成 (2000+ token) 需 3-5min
const LLM_STREAM_IDLE_MS = 90_000;      // 流式 idle 看门狗: 连接建立后 90s 无数据才断 (对齐 DSH idleWatchdog)
// agnes curl 连通性缓存: 探测一次后记住结果 (curl 被 TLS 阻断的环境不用反复探测)
let _curlReachableCache: boolean | null = null;

// 已知 provider 前缀
const KNOWN_PROVIDERS = new Set([
  "openai", "azure", "anthropic", "gemini", "vertex_ai", "mistral",
  "deepseek", "dashscope", "zai", "zhipu", "glm", "moonshot", "ollama",
  "siliconflow", "openrouter", "together_ai", "fireworks_ai", "xai",
  "volcengine", "ark", "baidu", "ernie", "qianfan", "huawei", "xiaomi",
  "huggingface", "bedrock", "ai21", "cohere", "perplexity", "vllm",
  "agnes",
]);

const MODEL_HEURISTICS: [string, string][] = [
  ["gpt", "openai"], ["o1-", "openai"], ["o3-", "openai"], ["o4-", "openai"],
  ["claude", "anthropic"], ["gemini", "gemini"], ["deepseek", "deepseek"],
  ["glm-", "zai"], ["qwen", "dashscope"], ["qwq", "dashscope"],
  ["kimi", "moonshot"], ["doubao", "volcengine"], ["ernie", "baidu"],
  ["mimo", "xiaomi"], ["pangu", "huawei"], ["grok", "xai"],
  ["mistral", "mistral"], ["codestral", "mistral"],
  ["agnes-", "agnes"],
];

// Provider 默认 API base URL (补全所有厂商, 对齐 config.ts PROVIDER_PRESETS 的 apiBase)
// discover 探测 /v1/models 时按 provider 查这里, 不再用 openai 兜底带偏
const PROVIDER_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zai: "https://open.bigmodel.cn/api/paas/v4",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  moonshot: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  openrouter: "https://openrouter.ai/api/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
  ark: "https://ark.cn-beijing.volces.com/api/v3",
  baidu: "https://qianfan.baidubce.com/v2",
  ernie: "https://qianfan.baidubce.com/v2",
  qianfan: "https://qianfan.baidubce.com/v2",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  ollama: "http://localhost:11434/v1",
  together_ai: "https://api.together.xyz/v1",
  fireworks_ai: "https://api.fireworks.ai/inference/v1",
  yi: "https://api.lingyiwanwu.com/v1",
  baichuan: "https://api.baichuan-ai.com/v1",
  stepfun: "https://api.stepfun.com/v1",
  hunyuan: "https://api.hunyuan.cloud.tencent.com/v1",
  huawei: "https://api.modelarts-maas.com/v2",
  xiaomi: "https://api.xiaomimimo.com/v1",
  agnes: "https://apihub.agnes-ai.com/v1",
  azure: "https://api.openai.com/v1",
  vertex_ai: "https://generativelanguage.googleapis.com/v1beta",
};

function normalizeModel(model: string, apiBase?: string): { provider: string; model: string } {
  const parts = model.split("/");
  if (parts.length >= 2 && KNOWN_PROVIDERS.has(parts[0]!.toLowerCase())) {
    return { provider: parts[0]!, model: parts.slice(1).join("/") };
  }
  if (apiBase) {
    // 有自定义 apiBase, 当作 openai 兼容
    return { provider: "openai", model };
  }
  const lower = model.toLowerCase();
  for (const [prefix, provider] of MODEL_HEURISTICS) {
    if (lower.startsWith(prefix)) {
      return { provider, model };
    }
  }
  return { provider: "openai", model };
}

function resolveBaseUrl(cfg: ModelConfig): string {
  if (cfg.apiBase) return cfg.apiBase.replace(/\/$/, "");
  const { provider } = normalizeModel(cfg.model);
  const base = PROVIDER_BASES[provider];
  if (base) return base;
  // 降级: 用 openai base
  return PROVIDER_BASES.openai!;
}

// 全局 fetch agent (连接池) — Node 22 原生 fetch 已自带连接池,无需额外 Agent
// 保留接口兼容但简化实现

// 构建 OpenAI 兼容请求体
// — Prefix Cache 统一优化: 所有 provider 保持消息前缀稳定,自动命中
// — Anthropic 特化: system 消息加 cache_control 标记 (Anthropic 需显式开启缓存)
function applyAnthropicCacheControl(cfg: ModelConfig, body: Record<string, unknown>): void {
  const { provider } = normalizeModel(cfg.model);
  if (provider !== "anthropic") return;
  const msgs = body.messages as Array<Record<string, unknown>>;
  if (!msgs || msgs.length === 0) return;
  // 所有 system 消息标记 cache_control (system 前缀最稳定, 缓存收益最大)
  // 并标记最后一个 assistant 之前的消息, 实现多轮对话历史缓存
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "system") {
      m.cache_control = { type: "ephemeral" };
    }
  }
  // 倒数第二个消息标记 (对话历史缓存锚点)
  if (msgs.length >= 2) {
    const lastIdx = msgs.length - 1;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (msgs[i].role !== "system") {
        (msgs[i] as Record<string, unknown>).cache_control = { type: "ephemeral" };
        break;
      }
    }
  }
}

function buildRequest(
  cfg: ModelConfig,
  messages: Array<{ role: string; content: string }>,
  opts: {
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    stop?: string[];
    tools?: ToolDefinition[];
  } = {},
): Record<string, unknown> {
  const { model } = normalizeModel(cfg.model);
  // 防御性过滤: 丢弃空 content 消息 (历史残留/工具调用产生的空行)
  // agnes 等 provider 对空 content 严格校验 (400: "message content cannot be empty"),
  // 这里统一在发请求前清洗, 所有 provider 受益
  const cleanMessages = messages.filter((m) => {
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) return true; // 带 tool_calls 的 assistant 消息保留 (content 可空)
    return (m.content || "").length > 0 || m.role === "system";
  }).map((m) => ({ ...m }));
  const body: Record<string, unknown> = {
    model,
    messages: cleanMessages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: opts.stream ?? false,
  };
  if (opts.stop) body.stop = opts.stop;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  // 流式请求时加 stream_options 让 API 返回 usage (含 prefix cache 命中数)
  if (opts.stream) {
    body.stream_options = { include_usage: true };
  }
  // Anthropic 专属: 显式 cache_control 标记
  applyAnthropicCacheControl(cfg, body);
  return body;
}

// 全局 HTTP 调用 (带重试)
async function callApi(
  cfg: ModelConfig,
  body: Record<string, unknown>,
  opts: { stream?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  const baseUrl = resolveBaseUrl(cfg);
  const url = `${baseUrl}/chat/completions`;
  const timeout = opts.timeoutMs || LLM_TIMEOUT_MS;

  // 统一走原生 fetch (Node 22 自带连接池, 所有 provider 包括 agnes)
  // 旧版 agnes 走 curl 子进程 — 在 Android 上 TLS 阻断 (code=77), 每次请求多 2-12s 探测开销
  // 且 curl 流式中途断开时 readline 拿到 0 行 → 误触发"0 chunk 可重试" → 空转 5 次
  // 现在: fetch 直连 agnes 实测 HTTP 200 + 33 chunk / 1.9s, 连接完全可用
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    } as RequestInit);
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// 解析 OpenAI 标准响应 (支持原生 tool_calls)
function parseResponse(data: Record<string, unknown>): LLMResponse {
  const choices = data.choices as Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }> | undefined;
  const msg = choices?.[0]?.message;
  const content = msg?.content || "";
  // reasoning_content: 模型把回答放进思考通道 (agnes 等推理模型常见), 非流式也要提取
  // 前端 "思考过程" 面板在 content 为空但 reasoning_content 有值时仍能显示
  const reasoningContent: string | undefined = (msg as unknown as { reasoning_content?: string })?.reasoning_content || undefined;
  const toolCalls: ToolCall[] | undefined = msg?.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
  }));
  const usage = data.usage as {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined;
  return {
    content,
    reasoningContent,
    model: data.model as string,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage ? {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      // OpenAI 兼容: prompt_tokens_details.cached_tokens
      cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
      // Anthropic 专属: cache_read_input_tokens / cache_creation_input_tokens
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    } : undefined,
  };
}

// 重试逻辑 (指数退避, 429 尊重 Retry-After)
async function callWithRetry(
  cfg: ModelConfig,
  body: Record<string, unknown>,
  maxRetries = 2,
): Promise<LLMResponse> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await callApi(cfg, body);
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        return parseResponse(data);
      }
      // 429 限流: 标记全局冷却闸门 (60s), 尊重 Retry-After (若 > 0)
      if (resp.status === 429) {
        _markGlobalRateLimit();
        const retryAfter = resp.headers.get("retry-after");
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (attempt + 1) * 2000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // 5xx 服务器错误: 重试
      if (resp.status >= 500 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    } catch (e) {
      lastError = e as Error;
      const isNetwork = /(ECONNRESET|EPIPE|ECONNREFUSED|timeout|fetch|network|socket|aborted)/i.test((e as Error).message);
      if (attempt < maxRetries) {
        // 网络错误用指数退避, 其他错误用线性退避
        const delay = isNetwork ? Math.min(2000 * Math.pow(2, attempt), 10000) : (attempt + 1) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError || new Error("LLM 调用失败");
}

// ===== 公开 API =====

// 全局 run 级 429 冷却闸门: 任一调用撞 429 后置位 60s,
// 期间 chat/stream/callWithRetry 自动挂起等待 — 多 agent 并发时防全链路互相撞限流
// (实测免费档 ~15s 窗口 4 次, 60s 冷却可完整跨过窗口)
let globalRateLimitUntil = 0;
export function _globalRateLimitState() {
  return { active: Date.now() < globalRateLimitUntil, remainingMs: Math.max(0, globalRateLimitUntil - Date.now()) };
}
export function _markGlobalRateLimit() {
  globalRateLimitUntil = Math.max(globalRateLimitUntil, Date.now() + 30_000);
}

export async function chat(
  messages: Array<{ role: string; content: string }>,
  cfg?: ModelConfig,
  opts: { temperature?: number; maxTokens?: number; tools?: ToolDefinition[] } = {},
): Promise<LLMResponse> {
  const model = cfg || getSettings().defaultModel;
  const body = buildRequest(model, messages, opts);
  return callWithRetry(model, body);
}

// 流式: 返回 AsyncGenerator<string>
// THINK_PREFIX: 用于分离 LLM 思考内容和回答内容
export const THINK_PREFIX = "::THINK::";

// 流式 chunk 的 usage 字段类型 (OpenAI 兼容 + Anthropic 特化)
interface ChunkUsage {
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}
// TOOLCALL_PREFIX: 标记流式结束时的原生 tool_calls (JSON)
export const TOOLCALL_PREFIX = "::TOOLCALLS::";
export const USAGE_PREFIX = "::USAGE::";

export async function* stream(
  messages: Array<{ role: string; content: string }>,
  cfg?: ModelConfig,
  opts: { temperature?: number; maxTokens?: number; stop?: string[]; tools?: ToolDefinition[] } = {},
): AsyncGenerator<string> {
  // 全局 429 冷却闸门: 前一个调用刚撞 429 时, 本次先挂起等待 (多 agent 并发防互相撞限流)
  {
    const rem = Date.now() - globalRateLimitUntil;
    if (rem > 0) {
      await new Promise((r) => setTimeout(r, rem));
    }
  }
  const model = cfg || getSettings().defaultModel;
  const body = buildRequest(model, messages, { ...opts, stream: true });
  // ===== 诊断日志 (定位大上下文下 0-chunk / 快失败的真因): 每次调用记 消息数+字节数, 结果记 chunk 数+首 chunk 延迟+异常 =====
  const msgCount = messages.length;
  const msgBytes = JSON.stringify(messages).length;
  const streamT0 = Date.now();
  let streamFirstChunkAt = 0;
  // ===== 对齐 DSH (dsh-llm-deepseek) 直连设计: 所有 provider (含 agnes) 统一原生 fetch + 原生 ReadableStream SSE =====
  // 旧版 agnes 专属 curl 子进程通道已移除:
  //   - Android 上 curl TLS 阻断 (code=77), 每次 stream 多 2-12s 探测开销
  //   - curl 流式中途断开时 readline 拿到 0 行 → 误触发 runner "0 chunk 可重试" → 空转 5 次全失败
  //   - 实测 fetch 直连 agnes: HTTP 200 + 33 chunk / 1.9s, 连接完全可用
  // 流式: 总预算 300s (长 reasoning 需 3-5min, 90s 一刀切会中途 abort 触发 0-chunk 空转)
  const resp = await callApi(model, body, { stream: true, timeoutMs: LLM_STREAM_TOTAL_MS }).catch((e) => {
    logWarn("[流式异常] 消息数="+msgCount+" 字节="+(msgBytes/1024).toFixed(1)+"KB 耗时="+(Date.now()-streamT0)+"ms fetch失败: "+(e instanceof Error ? e.message : String(e)));
    throw e;
  });
  if (!resp.ok) {
    if (resp.status === 429) _markGlobalRateLimit();
    const errText = await resp.text().catch(() => "");
    logWarn("[流式异常] 消息数="+msgCount+" 字节="+(msgBytes/1024).toFixed(1)+"KB HTTP "+resp.status+": "+errText.slice(0,200));
    throw new Error(`LLM 流式调用失败: HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }
  if (!resp.body) {
    throw new Error("LLM 流式响应无 body");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 流式 tool_calls 分片累加器
  const fetchTcIndex: Record<number, { id: string; name: string; arguments: string }> = {};
  // idle 看门狗 (对齐 DSH idleWatchdog): 连接建立后 90s 无任何数据 → 主动断连, 可重试
  // 旧实现只有 callApi 总超时 (90s) 一刀切, 长 reasoning 阶段不出 content 就被 abort
  let lastDataAt = Date.now();
  let totalChunks = 0;
  let sawStreamUsage = false;  // 流式响应里是否已捕获过 usage (供末尾兜底估算判断)

  try {
    while (true) {
      // 读前 idle 检查: 距上次数据超 90s → 放弃, 抛可重试错 (runner 侧识别 "未收到数据/超时" 重试)
      const idleMs = Date.now() - lastDataAt;
      if (idleMs > LLM_STREAM_IDLE_MS && totalChunks > 0) {
        throw new Error(`fetch 流式: 连接建立后 ${Math.round(idleMs / 1000)}s 无数据 (idle 看门狗), 已收到 ${totalChunks} chunk 后断连`);
      }
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("fetch 流式: reader.read 超时 (单块读取 >10min)")), 600000),
        ),
      ]);
      if (done) break;
      if (!streamFirstChunkAt) streamFirstChunkAt = Date.now() - streamT0;
      lastDataAt = Date.now();
      totalChunks++;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as Record<string, unknown>;
          const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> | undefined;
          const thinking = choices?.[0]?.delta?.reasoning_content;
          const content = choices?.[0]?.delta?.content;
          // 流式 tool_calls 分片累积 (与 curl 分支对齐): 否则委派/工具调用永不生效
          for (const tcd of (choices?.[0]?.delta?.tool_calls || [])) {
            const idx = tcd.index ?? 0;
            const entry = fetchTcIndex[idx] || { id: "", name: "", arguments: "" };
            if (tcd.id) entry.id = tcd.id;
            if (tcd.function?.name) entry.name += tcd.function.name;
            if (tcd.function?.arguments) entry.arguments += tcd.function.arguments;
            fetchTcIndex[idx] = entry;
          }
          if (thinking) yield THINK_PREFIX + thinking;
          if (content) yield content;
          // 捕获 usage (部分 API 在最后一个 chunk 中包含)
          const chunkUsage: ChunkUsage | undefined = (chunk as { usage?: ChunkUsage }).usage;
          if (chunkUsage) {
            sawStreamUsage = true;
            yield USAGE_PREFIX + JSON.stringify({
              prompt_tokens: chunkUsage.prompt_tokens || 0,
              completion_tokens: chunkUsage.completion_tokens || 0,
              total_tokens: chunkUsage.total_tokens || 0,
              promptTokens: chunkUsage.prompt_tokens || 0,
              completionTokens: chunkUsage.completion_tokens || 0,
              cachedTokens: chunkUsage.prompt_tokens_details?.cached_tokens || 0,
              cacheReadTokens: chunkUsage.cache_read_input_tokens || 0,
              cacheCreationTokens: chunkUsage.cache_creation_input_tokens || 0,
            });
          }
        } catch { /* skip malformed chunks */ }
      }
    }
    // 流式 usage 兜底: 部分 provider 不在 stream 里回 usage (即使 include_usage),
    // 此时估算 token (字符数/4), 保证 runs.total_tokens 非 0
    if (!sawStreamUsage && totalChunks > 0) {
      const estTotal = Math.max(1, Math.round(msgBytes / 4));
      yield USAGE_PREFIX + JSON.stringify({
        prompt_tokens: 0,
        completion_tokens: estTotal,
        total_tokens: estTotal,
        promptTokens: 0,
        completionTokens: estTotal,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimated: true,
      });
    }
  } finally {
    reader.releaseLock();
  }
  // 0 chunk 才视为 "连接断开" 可重试; 有 chunk 就正常结束 (避免 Cloudflare 断连导致无谓 retry)
  logInfo("[流式完成] 消息数="+msgCount+" 请求字节="+(msgBytes/1024).toFixed(1)+"KB chunk="+totalChunks
    +" 首chunk延迟="+(streamFirstChunkAt||"-")+"ms 总耗时="+(Date.now()-streamT0)+"ms");
  if (totalChunks === 0) {
    const idleMs = Date.now() - lastDataAt;
    logWarn("[流式0chunk] 消息数="+msgCount+" 字节="+(msgBytes/1024).toFixed(1)+"KB 空闲="+idleMs+"ms → 抛可重试错");
    throw new Error("fetch 流式: 连接建立后未收到任何数据 (可能 Cloudflare TLS 阻断), " + idleMs + "ms 空闲");
  }
  // 末尾输出累积的 tool_calls (如果有)
  const fetchFinalTcs = Object.values(fetchTcIndex).filter((t) => t.name);
  if (fetchFinalTcs.length > 0) {
    yield TOOLCALL_PREFIX + JSON.stringify(fetchFinalTcs.map((t) => ({ id: t.id || `call_${Date.now()}`, name: t.name, arguments: t.arguments })));
  }
}

// 测试连接
export async function testConnection(cfg: ModelConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await chat([{ role: "user", content: "hi" }], cfg, { maxTokens: 1 });
    return { ok: true, message: `连接成功! 模型: ${resp.model || cfg.model}` };
  } catch (e) {
    return { ok: false, message: `连接失败: ${(e as Error).message}` };
  }
}

// 友好错误提示
export function friendlyError(e: Error, cfg: ModelConfig): string {
  const msg = e.message.toLowerCase();
  const { provider } = normalizeModel(cfg.model);
  if (/(401|403|invalid api key|unauthorized|forbidden)/.test(msg)) {
    return `API Key 无效或权限不足。请检查 ${provider} 的 API Key。`;
  }
  if (/(429|rate limit|quota|too many requests)/.test(msg)) {
    return `请求频率超限或配额用完。请稍后重试。`;
  }
  if (/(404|model_not_found|not found|does not exist)/.test(msg)) {
    return `模型不存在: ${cfg.model}。请检查模型名拼写。`;
  }
  if (/(connection|timeout|timed out|refused|unreachable|proxy|ssl|certificate)/.test(msg)) {
    const s = getSettings();
    const hint = s.proxy ? `当前代理: ${s.proxy}` : "推荐用 DeepSeek/通义等国内模型, 无需代理";
    return `网络连接失败, 无法访问 ${provider} API。${hint}`;
  }
  return e.message;
}

// 获取 provider 列表 (供前端)
import { PROVIDER_PRESETS } from "./config.js";
export function getProviders(): Array<{ provider: string; label: string; models: string[]; env: string; apiBase: string }> {
  return PROVIDER_PRESETS;
}

// ===== 服务端"获取所有模型" — 对齐 Hermes model_metadata.py L1616/985: GET {base}/v1/models =====
// 向 provider 的 /v1/models 端点探测, 拿回该 key/endpoint 实际可用的模型清单。
// 带 5 分钟内存缓存 (对齐 Hermes _ENDPOINT_MODEL_CACHE_TTL=300, 防重复探测)。
const _endpointModelCache: Map<string, { at: number; models: string[] }> = new Map();
const ENDPOINT_MODEL_CACHE_TTL = 300_000; // 5 分钟

// ===== "拉取失败 → 回退预设清单" 的持久回退 (对齐 Hermes L1020 注释:
// "declared models survive a failed discovery — some endpoints have no /models route")
// 存每个 provider 最近一次成功拉取的全量模型, 发现失败时前端直接拿这个, 永不空白
const _providerModelFallback = new Map<string, string[]>();
export function getProviderModelFallback(provider: string): string[] {
  return _providerModelFallback.get(provider.toLowerCase()) || [];
}

export interface DiscoveredModels {
  provider: string;
  base: string;
  models: string[];               // 模型 id 清单
  raw: Record<string, unknown>[];  // 原始 data[] (含 context_length/pricing 等可选字段)
  source: "live" | "cache";
  error?: string;
}

/** 从指定 base+key 拉取所有可用模型 (OpenAI 兼容 /v1/models; Anthropic 特化)。
 *  model=传某已配模型 (取其 apiBase/apiKey 探测); 或显式传 base+key。 */
export async function discoverModels(opts: {
  model?: string;          // 已配置模型名 (用它的 apiBase+apiKey)
  base?: string;          // 显式 base
  key?: string;           // 显式 key
  provider?: string;      // 显式 provider (anthropic 走特化端点)
  forceRefresh?: boolean;
}): Promise<DiscoveredModels> {
  // 解析探测目标: 显式 base/key 优先, 否则用 model 配置的
  let base = opts.base || "";
  let key = opts.key || "";
  let provider = (opts.provider || "").toLowerCase();
  // 只传 provider (前端"拉取"走这条): 从该 provider 已配模型取 key + base (agnes 等必须有 key 才通)
  // ★ 只认 provider 匹配的模型, 绝不 fallback 到 defaultModel (否则 agnes 的 key 会被错配给 deepseek)
  if (!key && provider) {
    const s = getSettings();
    const sModels = s.models || [];
    const mMatch = sModels.find((x) => normalizeModel(x.model, x.apiBase).provider === provider && x.apiKey)
      || sModels.find((x) => x.model.toLowerCase().startsWith(provider + "/"));
    if (mMatch) {
      key = mMatch.apiKey || key;
      if (!base) base = mMatch.apiBase || "";
    }
    // 再兜底环境变量 (AGNES_API_KEY / DEEPSEEK_API_KEY 等, 各厂商各 key)
    if (!key) {
      const preset = PROVIDER_PRESETS.find((p) => p.provider === provider);
      if (preset?.env) key = process.env[preset.env] || "";
    }
  }
  if (opts.model || (!base && !provider)) {
    const s = getSettings();
    const m = opts.model ? s.models.find((x) => x.model === opts.model) : s.defaultModel;
    if (m) {
      base = m.apiBase || base;
      key = m.apiKey || key;
      if (!provider) {
        provider = normalizeModel(m.model, m.apiBase).provider;
        if (!base) base = resolveBaseUrl(m);
      }
    }
  }
  // 每个厂商都有自己 base: 按 provider 查 PROVIDER_PRESETS (含 agnes 等全部 20+ 家), 再用 PROVIDER_BASES 兜底, 绝不落到 openai
  if (!base && provider) {
    base = PROVIDER_BASES[provider] || "";
  }
  if (!base) base = PROVIDER_BASES.openai!;
  base = base.replace(/\/$/, "");

  // 内存缓存 (key: base+key指纹+provider)
  const cacheKey = `${base}|${key ? key.slice(0, 12) + key.length : "nokey"}|${provider}`;
  const hit = _endpointModelCache.get(cacheKey);
  if (!opts.forceRefresh && hit && Date.now() - hit.at < ENDPOINT_MODEL_CACHE_TTL) {
    return { provider, base, models: hit.models, raw: [], source: "cache" };
  }

  // Anthropic 特化: /v1/models 需 x-api-key + anthropic-version 头, 且 base 要去 /v1
  const isAnthropic = provider === "anthropic";
  const headers: Record<string, string> = { "User-Agent": "tianyan-model-discover" };
  if (isAnthropic) {
    const anthBase = base.replace(/\/v1$/, "");
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    base = anthBase;
  } else if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  // 探测路径 (对齐 Hermes L1037-1038: 双候选 base±/v1, 哪个通走哪个, 都不通才报错):
  //  - Ollama: /api/tags (body {models:[{name}]})
  //  - Anthropic: /v1/models (x-api-key 头)
  //  - OpenAI 兼容: {base}/models, 失败再试 {base去/或加/v1}/models
  let urls: string[] = [];
  let ollamaMode = false;
  if (provider === "ollama" || /:11434/.test(base) || base.includes("ollama")) {
    urls = [`${base.replace(/\/v1$/, "")}/api/tags`];
    ollamaMode = true;
  } else if (isAnthropic) {
    urls = [`${base}/v1/models?limit=1000`];
  } else {
    // 双候选: base 带 /v1 则原样 + 去 /v1; 不带则 +/v1 (Hermes L1037 同款)
    const alt = base.endsWith("/v1") ? base.slice(0, -3) : `${base}/v1`;
    urls = [`${base}/models`, `${alt}/models`];
    if (urls[1] === urls[0]) urls = [urls[0]];
  }

  let lastError = "";
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} @ ${url}`;
        // 401/403 = key 问题, 换个路径也没用, 直接停 (对齐 Hermes L1059)
        if (resp.status === 401 || resp.status === 403) break;
        continue; // 404 等: 试下一个候选路径
      }
      const body: any = await resp.json();
      let raw: Record<string, unknown>[] = [];
      if (ollamaMode) {
        raw = (body.models || []).map((m: any) => ({ id: m.name, ...m }));
      } else {
        raw = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
      }
      const models = raw
        .map((m) => String(m.id ?? m.name ?? m.model ?? ""))
        .filter((id) => id.length > 0);
      _endpointModelCache.set(cacheKey, { at: Date.now(), models });
      if (models.length > 0 && provider) _providerModelFallback.set(provider, models); // 成功才回写持久回退
      return { provider, base: url, models, raw, source: "live" };
    } catch (e) {
      lastError = `${(e as Error).message} @ ${url}`;
    }
  }
  // 拉取失败: 回退到该 provider 上次成功拉取的全量清单 (对齐 Hermes "declared models survive a failed discovery")
  const fallback = provider ? _providerModelFallback.get(provider) || [] : [];
  if (fallback.length > 0) {
    return { provider, base, models: fallback, raw: [], source: "cache", error: lastError || "fallback" };
  }
  return { provider, base, models: [], raw: [], source: "live", error: lastError };
}

// chatStream: stream的别名，兼容agent loop调用
export const chatStream = stream;

