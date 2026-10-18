/**
 * 终审返修闭环回归 —— 「终审打回 → 同一专家带修改指令重跑 → 再终审」。
 *
 * 为什么要有它: 2026-10-18 用户实测拆书任务 —— 子 agent 只回了句"好, 我来完成..."就一个工具没调,
 * 终审 0/10 写了详细修改指令, 但**指令从未送回专家, run 直接结束**。用户: "拆书完了没有下文了,
 * 后面的任务和工具压根就没有"。修法 = finalReviewWithRework。这里验证:
 *   ① 打回 → rework 被调用且收到修改指令 → 返修稿再过终审 → 出门的是返修版
 *   ② rework 还是交不出东西 → 不死循环, 交原稿+裁决
 *   ③ 一次就过 → rework 根本不该被调用
 *
 * 用法: node scripts/test-rework-loop.cjs   (需先 tsc; mock LLM, 不烧真额度)
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? " | " + extra : "")); }
}

// ===== mock LLM: 按脚本化队列回裁决 =====
const script = []; // 每个元素是一次 chat 的回复 content
let hits = 0;
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    hits++;
    const content = script.length ? script.shift() : "[裁决: 通过] 默认通过";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 1 } }));
  });
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tianyan-rework-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  // 先备好配置再 require —— getSettings 首次调用即读盘缓存
  const cfg = [
    `data_dir: '${path.join(tmp, "data").replace(/\\/g, "/")}'`,
    `server_port: 18999`,
    `default_model:`,
    `  model: openai/mock`,
    `  api_key: 'sk-mock'`,
    `  api_base: '${base}'`,
    `models:`,
    `  - model: openai/mock`,
    `    api_key: 'sk-mock'`,
    `    api_base: '${base}'`,
    ``,
  ].join("\n");
  const cfgPath = path.join(tmp, "config.yaml");
  fs.writeFileSync(cfgPath, cfg, "utf-8");
  process.env.TIANYAN_CONFIG = cfgPath;
  process.env.TIANYAN_DATA_DIR = path.join(tmp, "data");

  let runner;
  try { runner = require("../dist/agents/runner.js"); }
  catch (e) { console.log("跳过: 需先 tsc 编译 (" + e.message + ")"); server.close(); process.exit(0); }

  const events = [];
  const emit = (evt) => events.push(evt);

  console.log("== ① 打回 → 返修 → 通过 ==");
  script.push("[裁决: 打回] 只有启动语, 没有实质拆书内容", "[裁决: 通过] 返修后合格");
  const feedbacks = [];
  const r1 = await runner.finalReviewWithRework(
    "p1", "r1", "story-architect", "拆书《玄鉴仙族》",
    "好, 我来完成玄鉴仙族的拆书解构。", // 空话初稿
    emit,
    async (fb) => { feedbacks.push(fb); return "完整拆解: 核心冲突是..., 人物弧光..., 世界观..., 关键剧情节点..."; },
    1,
  );
  ok(feedbacks.length === 1, "rework 被调用恰好 1 次");
  ok(/打回|只有启动语/.test(feedbacks[0] || ""), "rework 收到的就是终审修改指令", (feedbacks[0] || "").slice(0, 40));
  ok(r1.approved === true, "返修后终审通过");
  ok(r1.reworked === 1, "reworked = 1");
  ok(/核心冲突/.test(r1.content), "出门的是返修版内容, 不是空话初稿");
  ok(events.some((e) => e.tool === "rework"), "emit 了返修事件 (前端能看到'返修中')");

  console.log("== ② 返修也交不出东西 → 不死循环 ==");
  script.push("[裁决: 打回] 还是空话");
  const r2 = await runner.finalReviewWithRework(
    "p1", "r2", "story-architect", "拆书", "空话初稿", emit,
    async () => "", // 返修颗粒无收
    1,
  );
  ok(r2.approved === false, "返修无产出 → 仍不通过");
  ok(r2.reworked === 1, "只返修了 1 轮就停 (不死循环)");
  ok(r2.content === "空话初稿", "交回原稿 (由调用方附裁决)");

  console.log("== ③ 一次就过 → rework 绝不该被调用 ==");
  script.push("[裁决: 通过] 合格");
  let called = 0;
  const r3 = await runner.finalReviewWithRework(
    "p1", "r3", "story-architect", "扫榜", "真实榜单数据...", emit,
    async () => { called++; return "x"; }, 1,
  );
  ok(r3.approved === true && called === 0, "首次通过, rework 0 次调用", "called=" + called);
  ok(r3.reworked === 0, "reworked = 0");

  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败 (mock LLM 共被调 ${hits} 次)`);
  process.exit(fail ? 1 : 0);
})();
