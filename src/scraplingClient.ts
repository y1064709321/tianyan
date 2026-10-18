// scraplingClient.ts — Node 侧调用 Scrapling Python 侧车
// 设计: spawn 子进程 (python3 scrapling/server.py --once), stdin 传 JSON, stdout 收 JSON.
// 无 Python/scrapling 时自动降级为 Node 纯 fetch (与 browserService.ts fetch-only 层对齐).
import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SERVER_PY = join(ROOT, "scrapling", "server.py");

// Scrapling 包所在目录 (pip install --target 装的):
// Windows: .venv-scrapling/Lib/site-packages ; POSIX: .venv-scrapling/lib/python3.x/site-packages
// 之所以用 --target 而不是 venv 里的 python: venv 的 pyvenv.cfg 在含非 ASCII 路径的机器上会被
// Python 以 ANSI 编码读取失败 (报错 "failed to open pyvenv.cfg"), 整个 venv 变废。
// 现在统一用能跑的 python + PYTHONPATH 指到包目录, 不依赖 venv 解释器本身。
function scraplingSiteDirs(): string[] {
  const venv = join(ROOT, ".venv-scrapling");
  const win = join(venv, "Lib", "site-packages");
  const dirs = [win];
  const libDir = join(venv, "lib");
  if (!process.platform.startsWith("win") && existsSync(libDir)) {
    try {
      for (const d of readdirSync(libDir)) {
        const sp = join(libDir, d, "site-packages");
        if (existsSync(sp)) dirs.push(sp);
      }
    } catch { /* ignore */ }
  }
  return dirs.filter(existsSync);
}

export type ScraplingAction = "search" | "fetch" | "ranking" | "browser";

export interface ScraplingResult<T = Record<string, unknown>> {
  ok: boolean;
  source: "scrapling" | "fetch-fallback" | "unavailable";
  data?: T;
  error?: string;
}

let pyCache: string | null | undefined;
function findPython(): string | null {
  if (pyCache !== undefined) return pyCache;
  pyCache = null;
  // 0. 环境变量优先 (机器上有多个 python / venv 解释器坏掉时的逃生口)
  const envPy = process.env.TIANYAN_SCRAPLING_PY;
  if (envPy) {
    try {
      execSync(`"${envPy}" --version`, { timeout: 5000, stdio: "pipe" });
      pyCache = envPy;
      return pyCache;
    } catch { /* 回退到自动查找 */ }
  }
  // 1. 系统 python3/python
  for (const cmd of ["python3", "python"]) {
    try {
      execSync(`${cmd} --version`, { timeout: 5000, stdio: "pipe" });
      pyCache = cmd;
      break;
    } catch { /* next */ }
  }
  // 2. 项目内 venv (scripts/install-scrapling.js 建的 .venv-scrapling)
  if (!pyCache) {
    const venvExe =
      process.platform === "win32" ? join(ROOT, ".venv-scrapling", "Scripts", "python.exe")
      : join(ROOT, ".venv-scrapling", "bin", "python3");
    try {
      execSync(`"${venvExe}" --version`, { timeout: 5000, stdio: "pipe" });
      pyCache = venvExe;
    } catch { /* no venv */ }
  }
  return pyCache;
}

/** 检查 python 版本; 无法探测(如 venv 里的)时乐观放行, 失败由 spawn 超时兜底. */
function pyVersionOk(py: string): boolean {
  try {
    const out = execSync(`"${py}" -c "import sys; print('%d.%d' % sys.version_info[:2])"`, {
      timeout: 5000, stdio: "pipe",
    }).toString().trim();
    const m = out.match(/^(\d+)\.(\d+)/);
    if (!m) return true;
    const major = Number(m[1]), minor = Number(m[2]);
    return major > 3 || (major === 3 && minor >= 10);
  } catch {
    return true; // 探测失败不放行也不拦截, 交给实际调用 (版本不对时 import 报错 → 超时降级)
  }
}

/** 调用 Scrapling 侧车一次. */
export function callScrapling<T = Record<string, unknown>>(
  action: ScraplingAction,
  body: Record<string, unknown>,
  timeoutMs = 60000,
): Promise<ScraplingResult<T>> {
  return new Promise((resolve) => {
    if (!existsSync(SERVER_PY)) {
      resolve({ ok: false, source: "unavailable", error: "scrapling/server.py 不存在 (未随 npm 包分发?)" });
      return;
    }
    const py = findPython();
    if (!py || !pyVersionOk(py)) {
      fetchFallback<T>(action, body, timeoutMs).then((r) =>
        resolve({ ok: r !== null, source: "fetch-fallback", data: r ?? undefined, error: r === null ? "fetch 失败" : undefined }),
      );
      return;
    }
    // PYTHONPATH: 让"能跑的 python"找到 --target 安装的 scrapling
    const siteDirs = scraplingSiteDirs();
    const extra = [process.env.PYTHONPATH, ...siteDirs].filter(Boolean).join(delimiter);
    const child = spawn(py, [SERVER_PY, "--once"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: extra ? { ...process.env, PYTHONPATH: extra } : process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, source: "scrapling", error: `scrapling 超时 (${timeoutMs}ms): ${stderr.slice(0, 200)}` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").pop() || "";
      let parsed: T | null = null;
      try { parsed = JSON.parse(line) as T; } catch { /* ignore */ }
      if (code === 0 && parsed) resolve({ ok: true, source: "scrapling", data: parsed });
      else resolve({ ok: false, source: "scrapling", error: line || `exit ${code}: ${stderr.slice(0, 200)}` });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, source: "scrapling", error: String(e.message) }); });
    child.stdin.write(JSON.stringify({ action, ...body }));
    child.stdin.end();
  });
}

/** 无 Python 时的 Node 纯 fetch 兜底. */
async function fetchFallback<T>(action: ScraplingAction, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const get = async (url: string) =>
    (await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(timeoutMs) })).text();
  try {
    if (action === "search") {
      const q = String(body.query || "");
      const html = await get("https://cn.bing.com/search?q=" + encodeURIComponent(q) + "&mkt=zh-CN&setlang=zh-Hans");
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      for (const m of html.matchAll(/<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi)) {
        const block = m[0];
        const hm = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (hm) results.push({ title: strip(hm[2]).slice(0, 200), url: hm[1], snippet: pm ? strip(pm[1]).slice(0, 300) : "" });
        if (results.length >= Number(body.maxResults || 10)) break;
      }
      return { query: q, engine: "bing", results, count: results.length, source: "fetch-fallback" } as T;
    }
    const url = String(body.url || "");
    const html = await get(url);
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const content = stripAll(html).slice(0, Number(body.maxChars || 12000));
    return { url, finalUrl: url, title: tm ? tm[1].trim() : "", content, chars: content.length, links: [], source: "fetch-fallback" } as T;
  } catch {
    return null;
  }
}

function strip(s: string): string { return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }
function stripAll(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
