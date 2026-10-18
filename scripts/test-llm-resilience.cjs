/**
 * LLM 连接韧性回归 —— 429 冷却闸门 + 测试连接契约。
 * 用法: node scripts/test-llm-resilience.cjs   (需先 tsc 编译; 耗时约 80s, 主要是等冷却窗口)
 *
 * 为什么要这个脚本: 429 冷却闸门曾经把剩余时间**算反了**
 * (`Date.now() - globalRateLimitUntil`, 应为 `globalRateLimitUntil - Date.now()`),
 * 后果是"冷却期内不等、冷却结束后反而等, 且越晚调用等越久" ——
 * 429 之后 5 分钟再调用会白等 4.5 分钟, 表现就是用户主诉的"回答一次之后模型就连不上、一直转圈"。
 * 这种 bug 靠读代码很难发现, 必须用"实际耗时"来断言。
 */
const http = require("node:http");
const { chat, testConnection, _markGlobalRateLimit, _globalRateLimitState } = require("../dist/llm.js");

let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log((ok ? "PASS" : "FAIL") + " | " + msg); };

// mock LLM: 任何请求都返回一个合法的最小响应, 这样测出来的耗时只来自闸门本身
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + "/v1";
  const CFG = { model: "mock/test-model", apiKey: "sk-test", apiBase: base, temperature: 0.7, maxTokens: 16 };

  console.log("===== ① 测试连接契约 =====");
  const ok = await testConnection({ ...CFG, model: "mock/good" });
  check(ok.ok === true && /连接成功/.test(ok.message), "可达 → ok:true (" + ok.message + ")");
  const bad = await testConnection({ ...CFG, model: "mock/bad", apiBase: "http://127.0.0.1:1/v1" });
  check(bad.ok === false && /连接失败/.test(bad.message), "不可达 → ok:false 且**不抛异常** (前端能正常显示)");

  console.log("\n===== ② 从未限流: 不该有任何等待 =====");
  let t = Date.now();
  await chat([{ role: "user", content: "hi" }], CFG, { maxTokens: 8 });
  const d1 = Date.now() - t;
  check(d1 < 3000, "首次调用 " + d1 + "ms (<3000ms)");

  console.log("\n===== ③ 冷却期内: 必须挂起等待 ~30s =====");
  _markGlobalRateLimit();
  check(_globalRateLimitState().active, "闸门置位, 剩余 " + Math.round(_globalRateLimitState().remainingMs / 1000) + "s");
  t = Date.now();
  await chat([{ role: "user", content: "hi" }], CFG, { maxTokens: 8 });
  const d2 = Date.now() - t;
  check(d2 >= 25_000, "冷却期内调用 " + (d2 / 1000).toFixed(1) + "s (>=25s, 闸门确实拦住了)");

  console.log("\n===== ④ 冷却过期后: 不该再等 (旧代码在此白等, 且越晚等越久) =====");
  await new Promise((r) => setTimeout(r, 45_000));
  check(!_globalRateLimitState().active, "闸门已过期");
  t = Date.now();
  await chat([{ role: "user", content: "hi" }], CFG, { maxTokens: 8 });
  const d3 = Date.now() - t;
  check(d3 < 3000, "过期后调用 " + d3 + "ms (<3000ms; 算反了会在这里等约 45s)");

  console.log(fail === 0 ? "\n全部通过" : "\n失败 " + fail + " 条");
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})();
