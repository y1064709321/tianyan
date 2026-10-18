/**
 * 停止按钮端到端回归 —— 真起服务 + mock LLM, 验证:
 *   POST /api/runs/:runId/cancel → runner 协作式退出 → GET /api/runs/:runId 变成 cancelled
 *
 * 为什么要跑真服务: 单元测只能证明 runCancel 模块对, 证明不了
 * 「HTTP 路由接上了 / runner 检查点真的生效 / run 状态真的落库」。
 * 停止按钮这事的成败全在这条链路上 —— 光断前端连接而后端还在烧 token 是最典型的假停止。
 *
 * 用法: node scripts/test-cancel-e2e.cjs   (需先 tsc; 约 30s)
 */
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? " | " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? " | " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ===== mock LLM: 流式慢慢吐, 让 run 有足够时间停在 running 状态 =====
function startMockLlm() {
  return new Promise(async (res) => {
    const server = http.createServer((req, r) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", async () => {
        let stream = false;
        try { stream = !!JSON.parse(b || "{}").stream; } catch {}
        if (!stream) {
          r.writeHead(200, { "Content-Type": "application/json" });
          r.end(JSON.stringify({ choices: [{ message: { content: "好的。" } }], usage: { total_tokens: 1 } }));
          return;
        }
        r.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // 30 个 chunk × 400ms ≈ 12s, 足够前端点停止
        for (let i = 0; i < 30; i++) {
          await sleep(400);
          try {
            r.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "字" } }] })}\n\n`);
          } catch { return; }
        }
        try { r.write("data: [DONE]\n\n"); r.end(); } catch {}
      });
    });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    res({ server, base: `http://127.0.0.1:${port}/v1` });
  });
}

async function waitHttp(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tianyan-e2e-"));
  const dataDir = path.join(tmp, "data").replace(/\\/g, "/");
  fs.mkdirSync(dataDir, { recursive: true });

  const mock = await startMockLlm();
  console.log("== 停止按钮端到端 ==");
  console.log("  mock LLM: " + mock.base);

  const port = await freePort();
  // 注意: Windows 路径一律单引号 —— 双引号 + 反斜杠会触发 YAML 非法转义 (\U),
  // parse 失败后旧代码静默返回 {} → 全部配置重置 (这个坑踩过, 别再手拼双引号路径)
  const cfg = [
    `data_dir: '${dataDir}'`,
    `server_host: 127.0.0.1`,
    `server_port: ${port}`,
    `default_model:`,
    `  model: openai/mock-e2e`,
    `  api_key: 'sk-mock'`,
    `  api_base: '${mock.base}'`,
    `  temperature: 0.7`,
    `  max_tokens: 512`,
    `models:`,
    `  - model: openai/mock-e2e`,
    `    api_key: 'sk-mock'`,
    `    api_base: '${mock.base}'`,
    ``,
  ].join("\n");
  const cfgPath = path.join(tmp, "config.yaml");
  fs.writeFileSync(cfgPath, cfg, "utf-8");

  const child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
    env: { ...process.env, TIANYAN_CONFIG: cfgPath, TIANYAN_DATA_DIR: dataDir, TIANYAN_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d.toString()));
  child.stderr.on("data", (d) => (bootLog += d.toString()));

  const BASE = `http://127.0.0.1:${port}`;
  const up = await waitHttp(BASE + "/api/projects");
  ok(up, "服务已启动", up ? BASE : bootLog.slice(-400));
  if (!up) { child.kill(); mock.server.close(); process.exit(1); }

  try {
    // 1) 建项目
    const pr = await fetch(BASE + "/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-cancel", genre: "玄幻", premise: "测试停止按钮" }),
    });
    const pj = await pr.json();
    ok(!!pj.id, "创建测试项目", pj.id);

    // 2) 发一条指令, 读 SSE 直到拿到 runId (不 await 整个流, 让它继续跑)
    const chatRes = await fetch(`${BASE}/api/projects/${pj.id}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ input: "帮我写第一章", agent: "orchestrator" }),
    });
    ok(chatRes.ok, "/chat 返回 200");

    const reader = chatRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "", runId = null;
    const drain = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
      } catch {}
    })();
    const t0 = Date.now();
    while (!runId && Date.now() - t0 < 20000) {
      await sleep(100);
      const m = buf.match(/"type":"start"[^}]*"runId":"([^"]+)"/) || buf.match(/"runId":"([^"]+)"/);
      if (m) runId = m[1];
    }
    ok(!!runId, "从 SSE start 事件拿到 runId", runId || buf.slice(0, 200));

    // 3) 取消前必须是 running (否则这条测试没意义)
    const st0 = await (await fetch(`${BASE}/api/runs/${runId}`)).json();
    ok(st0.status === "running", "取消前 run 状态 = running", "实际: " + st0.status);

    // 4) 点停止
    const cr = await fetch(`${BASE}/api/runs/${runId}/cancel`, { method: "POST" });
    const cj = await cr.json();
    ok(cj && cj.cancelled === true, "POST /cancel 返回 cancelled:true", JSON.stringify(cj));

    // 5) run 必须在合理时间内变成 cancelled (runner 检查点真的生效)
    let st1 = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 25000) {
      st1 = await (await fetch(`${BASE}/api/runs/${runId}`)).json();
      if (st1.status !== "running") break;
      await sleep(500);
    }
    ok(st1 && st1.status === "cancelled", "取消后 run 状态 = cancelled",
      "实际: " + (st1 && st1.status) + " / 用时 " + (Date.now() - t1) + "ms");

    // 6) 再点一次: 已结束, 不能报错 (前端会收到 alreadyFinished)
    const cr2 = await fetch(`${BASE}/api/runs/${runId}/cancel`, { method: "POST" });
    const cj2 = await cr2.json();
    ok(cj2 && cj2.alreadyFinished === true, "重复取消 → alreadyFinished, 不报错", JSON.stringify(cj2));

    // 7) 不存在的 run: 404 (前端不能把 404 当成功)
    const cr3 = await fetch(`${BASE}/api/runs/不存在的run/cancel`, { method: "POST" });
    ok(cr3.status === 404, "不存在的 run → 404", "HTTP " + cr3.status);

    await drain;
  } finally {
    child.kill();
    mock.server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
