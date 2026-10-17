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
function checkPythonVersion(py) {
  let out = "";
  try {
    out = execSync(`${py} -c 'import sys; print("%d.%d" % sys.version_info[:2])'`, {
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

const py = findPython();
if (!py) {
  console.log("⚠ 未找到 python3/python — Scrapling 侧车跳过 (抓取自动降级 dom-sim/纯 fetch). 装好 Python (≥3.10) 后重跑: node scripts/install-scrapling.js");
  process.exit(0);
}
const ver = checkPythonVersion(py);
if (ver && !ver.ok) {
  console.log(`⚠ 检测到 Python ${ver.version}, 低于 Scrapling 最低要求 3.10 (requires-python>=3.10, 3.8/3.9 不支持) — 跳过安装, 抓取自动降级 dom-sim/纯 fetch. 升级 Python 到 3.10+ 后重跑本脚本.`);
  process.exit(0);
}

try {
  // 已装好 → 直接返回 (幂等)
  if (existsSync(marker)) {
    console.log("✓ Scrapling 侧车已安装 (marker 存在), 跳过. 重装: rm .venv-scrapling/.scrapling-installed && node scripts/install-scrapling.js");
    process.exit(0);
  }
  mkdirSync(venvDir, { recursive: true });
  console.log("↓ 一键安装 Scrapling 抓取侧车 (python venv + pip, 可能 1~2 分钟)...");
  sh(`${py} -m venv "${venvDir}"`);
  const pip = join(venvDir, process.platform === "win32" ? "Scripts\\pip.exe" : "bin/pip");
  const pipArg = process.platform === "win32" ? `"${pip}"` : `"${pip}"`;
  sh(`${pipArg} install --upgrade pip`, { cwd: root });

  // ── 国内 PyPI 镜像源自动轮换：哪个源能下通就用哪个, 逐个试 ──
  // 顺序: 清华 → 阿里云 → 华为云 → 腾讯云 → 官方 (最后兜底). 某源 15s 超时即换下一个.
  const pipMirrors = [
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
      sh(`${pipArg} install -i "${url}" -r "${reqs}"`, { cwd: root });
      console.log(`  ✓ pip 源 ${name} 安装成功`);
      pipOk = true;
      break;
    } catch (e) {
      console.log(`  ✗ ${name} 失败, 换下一个...`);
    }
  }
  if (!pipOk) {
    throw new Error("所有 pip 镜像源 (清华/阿里云/华为云/腾讯云/官方) 均失败");
  }

  writeFileSync(marker, new Date().toISOString() + "\n");
  console.log("✓ Scrapling 侧车安装完成. 抓取模块自动启用 (curl_cffi 指纹 + Camoufox 浏览器层可选).");
} catch (e) {
  // 不阻断 npm install — 降级说明即可
  console.log("⚠ Scrapling 安装失败 (不阻断启动, 抓取自动降级 dom-sim/纯 fetch): " + String(e.message || e).slice(0, 160));
  console.log("  手动修复: node scripts/install-scrapling.js");
}
process.exit(0);
