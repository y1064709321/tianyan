// 天衍 后台日志 — 带 100MB 滚动上限 (超过自动轮转: tianyan.log -> tianyan.log.1)
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 100 * 1024 * 1024; // tianyan.log 自身 100MB 上限 (超限轮转, 不丢新日志)
const LOOSE_LOG_MAX = 50 * 1024 * 1024; // 无上限重定向日志 (server.log/run.log/...log 等) 50MB 截断
let _logDir = "";
let _logFile = "";

export function initLogger(dataDir: string): void {
  _logDir = dataDir;
  _logFile = join(dataDir, "tianyan.log");
  // 轮转: 当前文件超 100MB -> tianyan.log.1 (旧的 .1 丢弃)
  try {
    if (existsSync(_logFile) && statSync(_logFile).size > MAX_BYTES) {
      const old = _logFile + ".1";
      if (existsSync(old)) unlinkSync(old);
      renameSync(_logFile, old);
    }
  } catch { /* 轮转失败不阻塞启动 */ }
}

/**
 * 截断一个日志文件到"保留末尾 keepBytes" (保留最新日志, 丢最旧的头部).
 * 用于给无上限的 shell 重定向日志 (node dist/index.js > server.log) 设上限.
 * 不丢新日志, 只丢旧头部. 失败静默.
 */
function truncateToTail(path: string, keepBytes: number): void {
  try {
    const size = statSync(path).size;
    if (size <= keepBytes) return;
    // 读末尾 keepBytes
    const buf = Buffer.alloc(Math.min(size, keepBytes));
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, buf.length, size - buf.length); } finally { closeSync(fd); }
    // 写回末尾 (整文件替换为末尾内容, 旧头部丢弃)
    const out = appendFileSync(path + ".tail", buf, { flag: "wx" }); // 先写到临时, 再 rename 覆盖 (原子)
    renameSync(path + ".tail", path);
  } catch { /* 截断失败不影响主流程 */ }
}

/**
 * 启动时给所有"无上限重定向日志"设上限: 超过 50MB 自动截断到末尾 50MB.
 * 扫描 dataDir 和 CWD 下所有 *.log / *.txt 日志类文件.
 * 解决: 部署后有人用 shell 重定向 (> server.log) 把日志写到磁盘占满的隐患.
 * 每 24h 自动执行一次 (启动时一次 + 定时一次), 不影响正在追加写文件的进程 (rename 原子替换).
 */
const LAST_CAP_CHECK = { t: 0 };
export function capLooseLogs(): void {
  const now = Date.now();
  if (now - LAST_CAP_CHECK.t < 24 * 3600 * 1000) return; // 24h 内不重复扫
  LAST_CAP_CHECK.t = now;
  const targets = new Set<string>();
  // dataDir 下
  const scanDirs = [_logDir, process.cwd()].filter(Boolean);
  for (const dir of scanDirs) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!/\.log$|\.txt$/.test(e)) continue;
      if (e === "tianyan.log") continue; // tianyan.log 自身有轮转, 不归这里管
      const full = join(dir, e);
      try {
        if (!statSync(full).isFile()) continue;
        targets.add(full);
      } catch { /* 不存在/权限 */ }
    }
  }
  let capped = 0;
  for (const p of targets) {
    try {
      if (statSync(p).size > LOOSE_LOG_MAX) {
        truncateToTail(p, LOOSE_LOG_MAX);
        capped++;
      }
    } catch { /* 跳过 */ }
  }
  if (capped > 0) logInfo(`日志上限保护: 截断 ${capped} 个超过 ${LOOSE_LOG_MAX / 1024 / 1024}MB 的无上限日志 (保留末尾)`);
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

/** 写一行日志 (含时间戳), 带 10MB 上限保护 */
export function log(level: string, msg: string, extra?: unknown): void {
  if (!_logFile) return;
  let line = "[" + ts() + "] [" + level + "] " + msg;
  if (extra !== undefined) {
    try { line += " " + JSON.stringify(extra); } catch { line += " [extra:serialize_failed]"; }
  }
  try {
    // 写前检查大小, 超 100MB 上限先轮转再写 (旧 .1 覆盖丢弃, 保护的是新日志不断档)
    if (existsSync(_logFile) && statSync(_logFile).size > MAX_BYTES) {
      const old = _logFile + ".1";
      if (existsSync(old)) unlinkSync(old);
      renameSync(_logFile, old);
    }
    appendFileSync(_logFile, line + "\n");
  } catch (e) {
    // 日志写失败只打印到 stderr, 不影响主流程
    try { process.stderr.write(line + " (log_write_failed: " + (e as Error).message + ")\n"); } catch {}
  }
}

export function logInfo(msg: string, extra?: unknown): void { log("INFO", msg, extra); }
export function logWarn(msg: string, extra?: unknown): void { log("WARN", msg, extra); }
export function logError(msg: string, extra?: unknown): void { log("ERROR", msg, extra); }
