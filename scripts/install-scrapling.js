#!/usr/bin/env node
// 一键安装 Scrapling Python 侧车 (postinstall 钩子, 不阻断 npm install)
// 设计:
//   1. 找 python3/python; 2. 在 .venv-scrapling/ 建虚拟环境; 3. pip install -r scrapling/requirements.txt
//   失败 → 打警告 (抓取自动降级 dom-sim/fetch 层), 退出码仍 0, 不让 npm install 崩.
// 跳过条件: 无 python / TIAN_YAN_SKIP_SCRAPLING=1 / 已装好 (marker 文件)
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = join(root, ".venv-scrapling");
const marker = join(venvDir, ".scrapling-installed");
const reqs = join(root, "scrapling", "requirements.txt");

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", timeout: 300000, ...opts }).toString().trim();
}

function findPython() {
  for (const cmd of ["python3", "python"]) {
    try { sh(`${cmd} --version`); return cmd; } catch { /* next */ }
  }
  return null;
}

// Scrapling 硬限制: requires-python >=3.10 (PyPI metadata, v0.4.15). 3.8/3.9 直接跳过.
// 版本检查用【双引号】包住 -c 参数: Windows 的 cmd.exe 不认单引号, 单引号版会失败并被当成"探测不到版本"。
function checkPythonVersion(py) {
  let out = "";
  try {
    out = execSync(`${py} -c "import sys; print('%d.%d' % sys.version_info[:2])"`, {
      stdio: "pipe", timeout: 5000,
    }).toString().trim();
  } catch { out = ""; }
  const m = out.match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]), minor = Number(m[2]);
  const ok = major > 3 || (major === 3 && minor >= 10);
  return { version: out, ok };
}

if (process.env.TIAN_YAN_SKIP_SCRAPLING === "1") {
  console.log("⏭  TIAN_YAN_SKIP_SCRAPLING=1, 跳过 Scrapling 安装 (抓取走 dom-sim/fetch 层)");
  process.exit(0);
}
if (!existsSync(reqs)) { console.log("⚠ scrapling/requirements.txt 缺失, 跳过"); process.exit(0); }

const { PYTHONPATH, TIANYAN_SCRAPLING_PY, ...cleanEnv } = process.env;
const py = process.env.TIANYAN_SCRAPLING_PY || findPython();
// 包安装目录 (pip --target): Windows → Lib\site-packages; POSIX → lib/python3.x/site-packages
const siteDir = process.platform === "win32"
  ? join(venvDir, "Lib", "site-packages")
  : join(venvDir, "lib", "python", "site-packages");
if (!py) {
  console.log("⚠ 未找到 python3/python — Scrapling 侧车跳过 (抓取自动降级 dom-sim/纯 fetch). 装好 Python (≥3.10) 后重跑: node scripts/install-scrapling.js");
  process.exit(0);
}
const ver = checkPythonVersion(py);
if (ver && !ver.ok) {
  console.log(`⚠ 检测到 Python ${ver.version}, 低于 Scrapling 最低要求 3.10 (requires-python>=3.10, 3.8/3.9 不支持) — 跳过安装, 抓取自动降级 dom-sim/纯 fetch. 升级 Python 到 3.10+ 后重跑本脚本.`);
  process.exit(0);
}

// 真实可用性校验: marker 只能证明"曾经装过", 证明不了"现在还能用" ——
// 目录被清 / --target 半途失败 / python 换了版本, 都会出现 marker 在、包不在的情况,
// 而旧逻辑只认 marker → 一键脚本跳过安装 → 用户看到的就是"抓取压根没启用"。
// 所以统一以 `import scrapling` 为准, marker 只是加速用的提示。
function scraplingImportable(py, dir) {
  // 必须探 symbols, 不能只 import scrapling: 项目根目录自己就有个 scrapling/ 目录
  // (侧车源码), CWD=项目根时它会被当成 namespace package 导入成功 (__file__=None),
  // 于是"包其实没装"也被误判成已装好。
  try {
    execSync(`"${py}" -c "import scrapling, sys; sys.exit(0 if (getattr(scrapling,'__file__',None) and hasattr(scrapling,'Fetcher')) else 1)"`, {
      stdio: "pipe",
      timeout: 30_000,
      env: { ...cleanEnv, PYTHONPATH: [dir, cleanEnv.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":") },
    });
    return true;
  } catch {
    return false;
  }
}

try {
  if (existsSync(marker) && scraplingImportable(py, siteDir)) {
    console.log("✓ Scrapling 侧车已就绪 (import 校验通过), 跳过安装. 强制重装: rm .venv-scrapling/.scrapling-installed");
    process.exit(0);
  }
  if (existsSync(marker)) console.log("! marker 存在但 import scrapling 失败 → 实际未装好, 重新安装…");
  mkdirSync(siteDir, { recursive: true });
  // 注意: 不再用 venv 解释器 (pyvenv.cfg 在含非 ASCII 路径的机器上会被 Python 以 ANSI 编码
  // 读取失败 → 整个 venv 报废)。改为: 能跑的 python + pip install --target, 由
  // src/scraplingClient.ts 通过 PYTHONPATH 指到这个目录。
  console.log("↓ 一键安装 Scrapling 抓取侧车 (pip --target, 可能 1~3 分钟)...");

  // ── 国内 PyPI 镜像源自动轮换：哪个源能下通就用哪个, 逐个试 ──
  // 顺序: 清华 → 阿里云 → 华为云 → 腾讯云 → 官方 (最后兜底). 某源超时即换下一个.
  // 实测本地清华源常被代理 502, 阿里云通得快 → 阿里云排第一再逐个降级.
  const pipMirrors = [
    ["阿里云", "https://mirrors.aliyun.com/pypi/simple/"],
    ["清华", "https://pypi.tuna.tsinghua.edu.cn/simple"],
    ["阿里云", "https://mirrors.aliyun.com/pypi/simple/"],
    ["华为云", "https://repo.huaweicloud.com/repository/pypi/simple/"],
    ["腾讯云", "https://mirrors.cloud.tencent.com/pypi/simple/"],
    ["官方", "https://pypi.org/simple"],
  ];
  let pipOk = false;
  for (const [name, url] of pipMirrors) {
    console.log(`  ⟳ 尝试 pip 源: ${name} (${url}) ...`);
    try {
      sh(`"${py}" -m pip install --target "${siteDir}" -i "${url}" -r "${reqs}"`, { cwd: root, env: cleanEnv, timeout: 600000 });
      console.log(`  ✓ pip 源 ${name} 安装成功 → ${siteDir}`);
      pipOk = true;
      break;
    } catch (e) {
      console.log(`  ✗ ${name} 失败, 换下一个...`);
    }
  }
  if (!pipOk) {
    throw new Error("所有 pip 镜像源 (清华/阿里云/华为云/腾讯云/官方) 均失败");
  }

  // 安装完必须复验: 只有真能 import 才写 marker (避免"装了一半也打上已装标记")
  if (!scraplingImportable(py, siteDir)) {
    throw new Error("pip 报告成功但 import scrapling 仍失败 (--target 目录可能不完整)");
  }
  writeFileSync(marker, new Date().toISOString() + "\n");
  console.log("✓ Scrapling 侧车安装完成并通过 import 校验. 抓取模块自动启用 (curl_cffi 指纹 + Camoufox 浏览器层可选).");
} catch (e) {
  // 不阻断 npm install — 降级说明即可
  console.log("⚠ Scrapling 安装失败 (不阻断启动, 抓取自动降级 dom-sim/纯 fetch): " + String(e.message || e).slice(0, 160));
  console.log("  手动修复: node scripts/install-scrapling.js");
}
process.exit(0);
