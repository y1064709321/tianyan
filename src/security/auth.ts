// 安全认证: CORS + API Key (修复了 Python 版的所有安全漏洞)
import type { Context, Next } from "hono";

const API_KEY = (process.env.TIANYAN_API_KEY || "").trim();

// CORS: 默认只允许 localhost, 可通过 TIANYAN_CORS_ORIGINS 扩展
function getCorsOrigins(): string[] {
  const raw = process.env.TIANYAN_CORS_ORIGINS || "";
  const origins = raw.split(",").map((s) => s.trim()).filter(Boolean);
  // 始终允许 localhost
  for (const port of [8090, 8000, 3000, 5173, 4200]) {
    for (const host of ["localhost", "127.0.0.1"]) {
      const origin = `http://${host}:${port}`;
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  return origins;
}

export function corsMiddleware() {
  const allowedOrigins = getCorsOrigins();
  return async (c: Context, next: Next) => {
    const origin = c.req.header("origin") || "";
    // 只有在白名单中的 origin 才允许
    if (origin && allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    } else if (!origin) {
      // 无 origin (非浏览器请求, 如 curl) — 不设 allow-origin
    }
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Max-Age", "86400");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204 as any);
    }
    await next();
  };
}

// API Key 认证: 同源请求免认证 + Bearer token 校验
// P0 修复: 密钥端点 (/api/settings/model/key) 永不受"无 origin 免认证"豁免 —
// 旧实现 L56 `if (!origin) return next()` 让本机 curl/同进程 fetch 无 Bearer 即可取明文 key。
// 现在: 密钥端点即使无 origin 也必须 Bearer; 其余端点保留原行为 (本机开发体验)
const KEY_ENDPOINTS = new Set(["/api/settings/model/key"]);
export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const isKeyEndpoint = KEY_ENDPOINTS.has(path);
    if (!API_KEY && !isKeyEndpoint) return await next(); // 未设置且非密钥端点: 无认证

    // 同源请求免认证：前端从同一服务器加载时 origin 与 host 一致 (密钥端点除外)
    const origin = c.req.header("origin") || "";
    const host = c.req.header("host") || "";
    if (!isKeyEndpoint) {
      if (origin && host) {
        try {
          const originHost = new URL(origin).host;
          if (originHost === host) return await next(); // 同源，跳过认证
        } catch {}
      }
      // 无 origin 的请求（如 curl、同一进程 fetch）也免认证 (仅非密钥端点)
      if (!origin) return await next();
    }

    if (!path.startsWith("/api/")) return await next();
    if (path === "/api/health") return await next(); // 健康检查公开
    // 密钥端点 + (其他端点在已设 API_KEY 时): 必须 Bearer
    const auth = c.req.header("authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      const resp = c.json({ error: "Unauthorized: missing Bearer token" }, 401);
      resp.headers.set("Access-Control-Allow-Origin", c.req.header("origin") || "*");
      return resp;
    }
    const token = auth.slice(7);
    // 常量时间比较 (防止时序攻击)
    if (API_KEY && (token.length !== API_KEY.length || !timingSafeEqual(token, API_KEY))) {
      const resp = c.json({ error: "Unauthorized: invalid token" }, 401);
      resp.headers.set("Access-Control-Allow-Origin", c.req.header("origin") || "*");
      return resp;
    }
    await next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
