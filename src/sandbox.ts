// 项目沙箱: 每本小说一个独立数据目录
//
// 注意与 src/security/sandbox.ts 区分: 那个是"代码执行沙箱"(precheckCode/executeCode),
// 负责拦住危险代码; 本文件是"数据沙箱", 负责把每本书的产物隔离开。
//
// 隔离目标:
//   - 每本书的导出文件/抓取缓存/临时产物各归各, 不共用一个目录互相覆盖
//   - 删除项目时整个沙箱目录一并清理, 不留残渣
//
// 不做的事:
//   - 不新建 Node 进程、不分配端口、不动 IPC —— 进程级隔离风险与收益不成正比
//   - 浏览器实例目前是全局共享的(见 realBrowser.ts 的 sharedBrowser), 尚未按 pid 隔离

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logInfo } from "./logger.js";

const SANDBOX_ROOT = join(homedir(), ".tianyan", "sandboxes");

/** 沙箱子目录分类: 每类对应一种产物, 便于按类清理和排查 */
export type SandboxKind = "export" | "cache" | "scrape" | "tmp";

export interface SandboxPaths {
  root: string;
  export: string;
  cache: string;
  scrape: string;
  tmp: string;
}

/** 项目 ID 可能含路径分隔符等字符, 落盘前统一净化, 防止目录穿越 */
function safeId(pid: string): string {
  return String(pid).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

export function sandboxRoot(): string {
  return SANDBOX_ROOT;
}

/** 取某项目的沙箱路径 (不创建) */
export function sandboxPaths(pid: string): SandboxPaths {
  const root = join(SANDBOX_ROOT, safeId(pid));
  return {
    root,
    export: join(root, "export"),
    cache: join(root, "cache"),
    scrape: join(root, "scrape"),
    tmp: join(root, "tmp"),
  };
}

/**
 * 确保沙箱目录存在, 返回路径。
 * 幂等: 已存在直接返回, 不重复 mkdir。
 */
export function ensureSandbox(pid: string): SandboxPaths {
  const p = sandboxPaths(pid);
  for (const dir of [p.root, p.export, p.cache, p.scrape, p.tmp]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (e) {
      logInfo(`[sandbox] 创建目录失败 ${dir}: ${(e as Error).message}`);
    }
  }
  return p;
}

/**
 * 清理某项目的整个沙箱 (删除项目时调用)。
 * 返回是否真的删掉了东西 —— 目录本来就不存在不算失败。
 */
export function purgeSandbox(pid: string): boolean {
  const p = sandboxPaths(pid);
  if (!existsSync(p.root)) return false;
  try {
    rmSync(p.root, { recursive: true, force: true });
    logInfo(`[sandbox] 已清理沙箱: ${p.root}`);
    return true;
  } catch (e) {
    logInfo(`[sandbox] 清理失败 ${p.root}: ${(e as Error).message}`);
    return false;
  }
}

/** 沙箱占用的字节数 (用于前端展示"这本书占了多少空间") */
export function sandboxSize(pid: string): number {
  const p = sandboxPaths(pid);
  if (!existsSync(p.root)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      }
    } catch { /* 单个目录读失败不影响统计 */ }
  };
  walk(p.root);
  return total;
}

/**
 * 清理旧沙箱: 项目已不存在的沙箱目录会被回收, 避免删库后留下孤儿文件。
 * @param alivePids 当前仍存在的项目 ID 列表
 * @returns 清理掉的目录数
 */
export function purgeOrphanSandboxes(alivePids: string[]): number {
  if (!existsSync(SANDBOX_ROOT)) return 0;
  const alive = new Set(alivePids.map(safeId));
  let removed = 0;
  try {
    for (const name of readdirSync(SANDBOX_ROOT)) {
      if (alive.has(name)) continue;
      try {
        rmSync(join(SANDBOX_ROOT, name), { recursive: true, force: true });
        removed++;
        logInfo(`[sandbox] 回收孤儿沙箱: ${name}`);
      } catch { /* 单个失败不影响其余 */ }
    }
  } catch { /* 根目录读失败忽略 */ }
  return removed;
}
