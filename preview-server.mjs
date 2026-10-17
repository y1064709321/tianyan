// 天衍预览服务器 — 静态 web/ + /api/* 反向代理(可选)
// 不依赖 better-sqlite3 / hono, 纯 Node http
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = 8096;
const PROXY_TARGET = process.env.TIANYAN_PROXY_PORT ? Number(process.env.TIANYAN_PROXY_PORT) : 0;
const ABS_WEB = process.cwd() + "/web";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, urlPath) {
  // /static/* → web/* (web/index.html 引用 /static/app.js 和 /static/style.css,
  // 但实际文件在 web/ 下 — 去掉 /static/ 前缀再映射)
  let rawPath = urlPath === "/" ? "/index.html" : urlPath;
  rawPath = rawPath.split("?")[0];
  if (rawPath.startsWith("/static/")) rawPath = rawPath.slice("/static".length); // /static/app.js → /app.js
  let file = rawPath;
  const safe = join(ABS_WEB, file).replace(/\\/g, "/");
  if (!safe.startsWith(ABS_WEB)) { res.writeHead(403); res.end("forbidden"); return; }
  if (!existsSync(safe)) { res.writeHead(404); res.end("not found: " + file); return; }
  const ext = extname(safe);
  const ct = MIME[ext] || "application/octet-stream";
  const body = readFileSync(safe);
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
  res.end(body);
}

function proxy(req, res, targetPort) {
  const opts = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "backend unreachable: " + e.message }));
  });
  req.pipe(proxyReq);
}

function mockApi(req, res, path) {
  const m = path.match(/^\/api\/.*/);
  if (!m) { serveStatic(req, res, path); return; }
  const p = m[0];
  const send = (obj, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };

  if (p === "/api/health") return send({ status: "ok", version: "0.2.0-preview" });
  if (p === "/api/config") return send({ defaultModel: "deepseek/deepseek-flash", models: [], ready: true });
  if (p === "/api/config/models") return send({ models: [] });
  if (p === "/api/settings" || p === "/api/settings/model/key") return send({});
  if (p === "/api/agents") return send({ agents: [], readonlyAgents: [], workflowPhases: [] });
  if (p === "/api/projects") return send([]);
  if (p === "/api/skills") return send({ skills: [] });
  return send({ error: "mock: not implemented " + p }, 404);
}

const server = http.createServer((req, res) => {
  const p = req.url || "/";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (p.startsWith("/api/")) {
    if (PROXY_TARGET > 0) { proxy(req, res, PROXY_TARGET); }
    else { mockApi(req, res, p); }
    return;
  }
  serveStatic(req, res, p);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  天衍预览服务器");
  console.log(`  地址: http://127.0.0.1:${PORT}`);
  console.log(`  web 目录: ${ABS_WEB}`);
  if (PROXY_TARGET > 0) console.log(`  代理 /api/* -> 127.0.0.1:${PROXY_TARGET} (真实后端)`);
  else console.log(`  模式: mock (无真实后端, /api/* 返回默认值)`);
  console.log("\n");
});
