/**
 * Run 取消 —— 用户在前端点「停止」时, 后端必须真的停下来。
 *
 * 为什么需要这个模块: 以前前端没有停止按钮, 用户想中断只能刷新页面。
 * 但**刷新只是断开了 SSE 连接, 后端那个 run 还在跑** —— LLM 继续烧 token、工具继续写库,
 * 用户看到的却是"什么都没发生"。所以取消必须是后端真正感知的状态, 不只是前端断开。
 *
 * 设计:
 * - 内存 Set 存被取消的 runId (runner 主循环/流式读取都在热路径上, 不能每次查 DB)
 * - 带 TTL 自动清理, 防止 Set 无限增长 (用户点了取消但 run 已经结束 / 服务长期运行)
 * - 取消是**协作式**的: runner 在当前 LLM 调用返回后才退出, 不会强杀正在进行的 HTTP 请求。
 *   强杀会让已经写入库的章节处于半截状态, 反而更糟。
 */

const CANCEL_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时, 足够长于任何 run
const cancelled = new Map<string, number>(); // runId -> 取消时刻

/** 标记某个 run 为已取消 */
export function cancelRun(runId: string): void {
  if (!runId) return;
  cancelled.set(runId, Date.now());
  sweep();
}

/** 该 run 是否被用户取消 (runner 在循环里轮询这个) */
export function isRunCancelled(runId: string): boolean {
  if (!runId) return false;
  return cancelled.has(runId);
}

/** run 正常结束后清掉标记, 别让 Set 白占内存 */
export function clearRunCancel(runId: string): void {
  if (!runId) return;
  cancelled.delete(runId);
}

/** 清理过期条目; 也在 cancelRun 时顺带跑一次, 不额外起定时器 */
function sweep(): void {
  const cutoff = Date.now() - CANCEL_TTL_MS;
  for (const [id, ts] of cancelled) {
    if (ts < cutoff) cancelled.delete(id);
  }
  // 兜底: 极端情况下条目数失控 (比如每轮都取消), 砍掉最老的一半
  if (cancelled.size > 500) {
    const sorted = [...cancelled.entries()].sort((a, b) => a[1]! - b[1]!);
    for (let i = 0; i < Math.floor(sorted.length / 2); i++) cancelled.delete(sorted[i]![0]!);
  }
}
