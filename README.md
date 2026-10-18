# 天衍 (Tianyan)
> 注：本代码同时以 **AGPL-3.0** 和 **GPL-3.0** 双许可发布，用户可任选其一 (AGPL 见 `LICENSE`，GPL 见 `LICENSE_GNU_3`)。
# 本仓库无法正常匿名访问，正查找原因，优先访问gitee仓库
一个多Agent协同的**天衍**(Web 界面)。7 个 agent 协同,按 7 步流水线完成从扫榜调研到定稿交付的完整长篇创作闭环,内置「毒舌总编」审稿机制与质检打回循环。

**7 个 Agent 协同**，按强制流水线完成从扫榜调研到定稿交付的完整长篇创作闭环，内置「毒舌总编」审稿机制、36 维质检打回循环(含第 36 维原创度检测)、真实浏览器扫榜。

> 🖥️ **本地直接产出，无需上线环境**：天衍是本地运行的创作工具，启动后在本机直接生成小说内容（章节、大纲、设定），不需要部署到服务器/云端，也不需要 Docker。所有数据存本地 SQLite。

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)
![Hono](https://img.shields.io/badge/Hono-4-green)
![npm](https://img.shields.io/badge/npm-install-blue)
![No Docker](https://img.shields.io/badge/📦-无需Docker-绿色)
[![Python](https://img.shields.io/badge/Python-3.10--3.13-ffd43b?logo=python&logoColor=white)](https://www.python.org/downloads/)
[![自定义协议](https://img.shields.io/badge/📄-自定义协议-0052d9)](USER_AGREEMENT.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--3.0-blueviolet)](https://www.gnu.org/licenses/agpl-3.0.html)
[![License: GPL v3](https://img.shields.io/badge/License-GPL--3.0-red)](https://www.gnu.org/licenses/gpl-3.0.html)
[![Scrapling: BSD-3-Clause](https://img.shields.io/badge/抓取引擎-Scrapling-BSD--3-2ea44f)](https://github.com/D4Vinci/Scrapling)

---

## ✨ 核心特性

### 7 步强制创作流水线

| 步骤 | 名称 | 负责 Agent | 说明 |
|------|------|-----------|------|
| 1 | 扫榜调研 | 📐 story-architect | 真实浏览器抓取 起点三江/往期三江/番茄/晋江/飞卢/书旗 畅销榜数据 |
| 2 | 拆书解构 | 📐 story-architect | 分析对标作品的钩子/节奏/人设/文风 |
| 3 | 角色架构 | 👤 character-designer | 建立角色档案(外貌/性格/金手指/弧光)、世界观设定 |
| 4 | 大纲搭建 | 📐 story-architect | 全书大纲 → 卷纲 → 细纲，设计钩子密度与情绪曲线 |
| 5 | 正文写作 | ✍️ narrative-writer | 正文写作 + 去 AI 味，系统自动触发审查 |
| 6 | 总编终审 | 🎯 orchestrator | 毒舌评分(1-10)，<7 打回重写，通过才放行 |
| 7 | 导出交付 | 🎯 orchestrator | 导出最终 `.txt` 文件 |

### 多 Agent 协同

| Agent | 职责 | 阶段 |
|-------|------|------|
| 🎯 orchestrator (总编) | 调度中枢 + 毒舌审稿 | 全阶段 |
| 📐 story-architect (架构师) | 扫榜/拆书/选题/世界观/大纲 | 1-4 |
| ✍️ narrative-writer (主笔) | 正文写作/润色/改写/去 AI 味 | 5 |
| 👤 character-designer (角色师) | 角色档案/对话/人设弧线 | 2-3 |
| 🔍 consistency-checker (质检员) | 36 维全维度审计(逐维度打分 S1-S4, 含原创度) | 7 |
| 📊 story-explorer (资料员) | 风格缓存/上下文加载 | 5 |
| 📋 presenter (监制) | 整合定稿/交付报告 | 8 |

### 真实浏览器扫榜

使用开源 **Scrapling** (BSD-3-Clause) 作为抓取引擎，绕过反爬检测，真实抓取小说平台数据。
Scrapling 通过 Python 侧车调用，无 Python 环境时自动降级为零依赖 DOM 模拟 / 纯 fetch，任何平台不崩。

| 平台 | 支持榜单 | 状态 |
|------|---------|------|
| 起点中文网 | 畅销榜 / 月票榜 / 人气榜 / 三江推荐 / 往期三江 | ✅ |
| 起点女生网 | 畅销榜 / 月票榜 / 人气榜 / 新书榜 | ✅ |
| 番茄小说 | **分类榜（默认，按题材自动选分类）/ 分类新书榜 / 金番作家榜 / 巅峰榜**，另有 阅读榜 / 新书榜 / 热度榜 | ✅ |
| 晋江文学城 | 月票榜 / 收藏榜 / 点击榜 / 推荐榜 / VIP 榜 | ✅ |
| 飞卢小说网 | 排行榜 / 月票榜 / 收藏榜 / 点击榜 | ⚠️ 风控严格，常失败 |
| 书旗小说 | 点击榜 (男频) | ✅ |
| QQ阅读 | 热门榜 | ⚠️ 风控严格，常失败 |

> 榜单数据源会随站点改版失效，请以实际扫榜结果为准；抓取失败的平台会在报告里明确标注，不会静默丢弃。

### 其他亮点

- **毒舌审稿机制**：每章评分 1-10，<7 自动打回重写
- **36 维质检**：角色一致性/物资战力/伏笔逻辑/文风表达/结构节奏/大纲偏离共 35 维 + 第 36 维原创度(相似/照抄检测)逐维度审计(S1-S4)，<7 或 S1 直接打回。
  36 维全部有确定性规则兜底(单一数据源 `src/agents/audit-dimensions.ts`)：LLM 漏审的维度由代码层补审，两层都没审的维度会如实标记为「未审」而不会当作通过。强规则命中 S1 一票否决，启发式规则(weak)最多判 CONCERNS，避免误报卡死创作
- **短期+长期记忆**：Agent 跨轮次保持上下文
- **内置 111 位作家语料库**：支持风格匹配与仿写
- **Web 预览界面**：实时查看进度、思考链、对话历史

---

## 💻 系统支持

| 系统 | 架构 | 一键启动 | 状态 | 说明 |
|------|------|---------|------|------|
| **Windows 10/11** | x64 / arm64 | `tianyan.bat` 或 `start.bat` | ✅ 完整支持 | 需要 Node.js ≥ 18；Win7/8 需自行安装 curl |
| **macOS** (Intel) | x64 | `bash tianyan.sh` | ✅ 完整支持 | 需要 Node.js ≥ 18；首次运行自动装依赖 |
| **macOS** (Apple Silicon) | arm64 | `bash tianyan.sh` | ✅ 完整支持 | M1/M2/M3 通过 Rosetta/arm64 原生运行 |
| **Linux** | x64 / arm64 | `bash tianyan.sh` | ✅ 完整支持 | 含 Ubuntu / Debian / CentOS 等发行版 |
| **沙箱/容器** | 任意 | `bash tianyan.sh` | ✅ 支持 | 无浏览器时自动降级（`--no-browser`） |

> 全部平台共用同一套 TypeScript 代码，无平台分支。三平台差异仅在一键启动脚本：
> - `tianyan.sh` — Linux / macOS
> - `tianyan.bat` — Windows（`start.bat` 为入口，含 Git Bash 兼容）
> - `na` / `na.bat` — 管理命令（start/stop/restart/status/log/url）

### 沙箱环境（无图形界面）

```bash
# 任何系统都可以用（无需浏览器）
bash tianyan.sh           # 或 Windows: tianyan.bat
# 启动后手动访问终端显示的地址: http://localhost:xxxx
```

> 沙箱内自动打开浏览器失败时，会打印可访问的地址，直接用浏览器或通过端口转发访问即可。
> 未装依赖时自动切换镜像源安装：npmmirror → 华为云 → 腾讯云 → 清华 → 官方。

### 平台兼容性说明

| 依赖 | Windows | macOS | Linux | 备注 |
|------|---------|-------|-------|------|
| Node.js ≥ 18 | ✅ | ✅ | ✅ | `import.meta.dirname` 已在代码中做 Node 18 兼容回退 |
| better-sqlite3 | ✅ 预编译 | ✅ 预编译 | ✅ 预编译 | 无预编译时自动 node-gyp 编译 |
| Playwright | ✅ | ✅ | ✅ | 仅扫榜抓取需要，缺失则降级 |
| curl | ✅ Win10+ 自带 | ✅ 系统自带 | ✅ 系统自带 | Win7/8 缺失时自动回退原生 fetch |

---

## 🚀 快速开始

### 前置要求

- **Node.js ≥ 18** ([下载](https://nodejs.org))
- **Python 3.10+** (可选，Scrapling 抓取侧车需要；版本上限 3.13。缺 Python 或低于 3.10 时抓取自动降级 dom-sim/纯 fetch)

### 一键启动（推荐）

```bash
git clone https://github.com/l1064709321/tianyan.git
cd tianyan

# Linux / macOS
bash tianyan.sh

# Windows
tianyan.bat
```

> 首次运行自动：安装依赖 → 编译 → 交互式引导 → 自动打开浏览器。
> **默认无内置密钥**：可在引导界面直接输入，也可跳过后在网页界面配置。

### npm 全局安装

```bash
npm install -g tianyan
tianyan                        # 交互式引导启动 (推荐)
tianyan --port 8080            # 指定端口
tianyan --api-key sk-xxx       # 指定密钥
tianyan --model deepseek-flash  # 指定模型
tianyan --no-browser           # 不自动打开浏览器
tianyan --help                 # 查看全部参数
```

### 手动启动

```bash
npm install && npm run build
node bin/tianyan.js
```

---

## ⚙️ 配置

**默认无内置密钥**，首次使用须先配置，任选一种：

1. **CLI 引导**：启动时选「不跳过」，按提示输入 API Key
2. **前端**：启动后跳过配置，在「模型配置」界面直接填写保存
3. **CLI 参数**：`tianyan --api-key sk-xxx`

配置文件位置：`~/.tianyan/config.yaml`

```yaml
default_model:
  model: "deepseek/deepseek-flash"
  api_key: ""                    # 填入你的密钥 (前端可配置)
  api_base: "https://api.deepseek.com/v1"
  temperature: 0.8
  max_tokens: 4096

max_steps: 16
server_port: 8000
```

支持的模型提供商（通过前端「模型配置」界面添加，2026-10-17 逐家核实）：
- **国内**: DeepSeek / 阿里云通义千问 / 智谱 GLM / 月之暗面 Kimi / 火山引擎豆包
- **国内**: 百度文心 / 小米 MiMo / 华为盘古 / 硅基流动 / 百川智能 / 阶跃星辰 / 腾讯混元
- **海外**: OpenAI / Anthropic Claude / Google Gemini / xAI Grok / Mistral AI
- **聚合**: OpenRouter / Together AI / Fireworks AI / Agnes AI
- **本地**: Ollama

> 零一万物公共 API 已于 2026-09-03 停止服务，预设已移除。

---

## 📁 项目结构

```
tianyan/
├── src/                    # TypeScript 源码
│   ├── index.ts            # Hono HTTP 服务 + API 路由
│   ├── agents/             # Agent 配置、工具定义、ReAct 循环
│   │   ├── index.ts        # 7 个 Agent 定义 + 提示词
│   │   └── runner.ts       # Agent 运行引擎 (44 工具调度)
│   ├── browser.ts          # 抓取层 (Scrapling 侧车 / 降级 dom-sim / 纯 fetch)
│   ├── llm.ts              # LLM 接口 (OpenAI 兼容)
│   ├── store.ts            # SQLite 持久化
│   ├── workflow.ts         # 状态机阶段管控
│   └── skills.ts           # 技能系统 (Python 桥接)
├── web/                    # 前端 (原生 HTML/CSS/JS)
│   ├── index.html          # 主界面
│   ├── app.js              # 前端逻辑
│   └── style.css           # 样式
├── app/                    # Python 技能 (AI味检测/审计等)
├── config.example.yaml     # 配置模板 (无内置密钥)
├── tianyan.sh              # Linux/macOS 一键启动
├── tianyan.bat             # Windows 一键启动
└── package.json
```

---

## 🔧 可用工具 (44 个)

| 分类 | 工具 | 说明 |
|------|------|------|
| 项目 | query_project | 查询项目状态/章节/元素 |
| 扫榜 | scan_bestseller | 真实浏览器抓取平台榜单 |
| 拆书 | analyze_novel | 拆解对标作品结构 |
| 大纲 | generate_outline | 生成大纲 + 自动创建章节骨架 |
| 大纲 | manage_outline | 查询/更新章节大纲 |
| 角色 | manage_character | 创建/查询角色档案 |
| 世界观 | manage_world | 管理地点/势力/规则/时间线 |
| 写作 | continue_writing | 续写正文 |
| 写作 | ghostwrite | 指定风格代笔 |
| 审核 | review_chapter | 毒舌评分审稿 |
| 质检 | quality_check | 36 维质检 (含原创度) |
| AI检测 | detect_ai | 检测 AI 味浓度 |
| 搜索 | web_search / browser_search | 联网搜索 |
| 抓取 | web_fetch / browser_fetch | 抓取网页正文 |
| 导出 | export_project_data | 导出 txt/json |
| 委派 | delegate_to_agent | Agent 间任务委派 |
| ... | (共 44 个) | |

---

## 📋 工作流模式

| 模式 | 说明 |
|------|------|
| **状态机** (默认) | 严格阶段门禁：扫榜 → 拆书 → 角色 → 大纲 → 写作 → 审核 → 导出，不可跳步 |
| CrewAI | 灵活协作：跳过阶段门禁，适合快速迭代 |

通过 `switch_workflow_mode` 工具或前端界面切换。

---

## 📜 License

- 代码：[GNU AGPL v3](LICENSE)
- 协议：见 [USER_AGREEMENT.md](USER_AGREEMENT.md)

## 🧩 第三方组件声明 (Third-Party Notices / 标识)

> 本项目抓取层引用了一个开源组件，按 BSD-3-Clause 协议使用。正式归属声明见随包发布的 [`NOTICE`](NOTICE) 文件。

| 组件 | 协议 | 版权 | 用途 |
|------|------|------|------|
| **Scrapling** | [BSD-3-Clause](https://opensource.org/licenses/BSD-3-Clause) | Copyright (c) 2024 Karim shoair | 抓取/搜索/扫榜引擎 (curl_cffi TLS 指纹 + 可选 Camoufox 浏览器层) |

### 抓取层 — 接入 Scrapling (BSD-3-Clause)

本项目抓取/搜索/扫榜已切换到开源 [Scrapling](https://github.com/D4Vinci/Scrapling) (BSD 3-Clause, Copyright 2024 Karim shoair):
- `scrapling/server.py` — Python 侧车, Node 通过子进程调用 (stdin/stdout JSON 协议)
- `src/scraplingClient.ts` — Node 侧调用器; `src/browserService.ts` / `src/browser.ts` 已改用 Scrapling
- 三层降级: Scrapling(curl_cffi 指纹) → 零依赖 DOM 模拟 → 纯 fetch, 任何平台不崩
- 一键安装: `bash install.sh` (或 npm install 自动触发 `scripts/install-scrapling.js` 建 Python venv 装 scrapling)
- 跳过 Scrapling: 环境变量 `TIAN_YAN_SKIP_SCRAPLING=1`
- 浏览器层 (Camoufox 真人模拟) 仅桌面有 python3+scrapling 时可用, 手机/Termux 自动走 fetch 层

**Python 版本限制**：Scrapling `requires-python >=3.10`（官方 classifiers 支持 3.10–3.13，3.8/3.9 不支持）。
`scripts/install-scrapling.js` 与 `src/scraplingClient.ts` 均已做版本检查，低于 3.10 或缺 Python 时自动降级，不影响启动。

### 协议合规 (AGPL-3.0 主项目 × BSD-3-Clause 组件)
Scrapling 为 BSD-3-Clause（宽松型，无 copyleft 传染）：合入后组合体仍按天衍的 AGPL-3.0 分发，
只需保留其版权声明（见 `NOTICE` 文件，已随 npm 包 `files` 一起发布）。不需要把 Scrapling 那部分改成 AGPL。

## 🛡️ 抓取合规边界 (免费内容限定)

> 本项目使用开源 [Scrapling](https://github.com/D4Vinci/Scrapling)（BSD-3-Clause, Copyright 2024 Karim shoair）
> 作为抓取/反检测引擎。基于该引擎的抓取行为**严格限定在免费公开内容**：

| 允许 ✅ | 禁止 ❌ |
|--------|--------|
| 各平台**榜单页**（书名/作者/简介/更新状态等公开元数据） | **付费章节正文**（起点 VIP / 番茄付费 / 晋江 VIP 等） |
| **搜索结果页**（公开摘要） | 绕过**付费墙**（VIP 验证 / 会员解锁 / 章节付费） |
| **公开简介页** | 抓取**需登录**的内容 |
| 仅用于**创作对标调研**（学结构/钩子/节奏/人设），不下载存储正文 | 批量爬取正文文本 |

- 抓取侧车代码 `scrapling/server.py` 文件头已写入同一合规边界声明，随代码分发。
- 榜单数据只取条目级公开字段，不深入章节正文；正文不落地、不入库。
- 用户在使用时亦应遵守各平台 robots.txt 与著作权法；天衍不鼓励也不支持抓取付费内容。

## 🐍 Python 环境标签 (Scrapling 抓取侧车)

> 代码中已引用 Scrapling（见 `scrapling/server.py` 与 `src/scraplingClient.ts`），
> 但 Scrapling 是 Python 包，需在**电脑上**配 Python 环境才能启用最强抓取层。本节标明环境要求、依赖、一键安装与启动方式。

### 需要哪些依赖（代码已写清楚）

| 项 | 内容 | 代码位置 |
|----|------|---------|
| **Python** | **3.10 – 3.13**（3.8/3.9 不支持） | `scrapling/requirements.txt` 头注释 + `scripts/install-scrapling.js` 版本检查 |
| **依赖包** | `scrapling[fetchers]>=0.4.15` | `scrapling/requirements.txt` 第 1 行 |
| **依赖说明** | `[fetchers]` 含 `curl_cffi`（TLS 指纹模拟）+ 可选 `Camoufox`（浏览器层） | `scrapling/requirements.txt` |
| **Python 侧车** | `scrapling/server.py`（Node 通过子进程 spawn 调用） | `src/scraplingClient.ts` |

> 依赖清单文件：[`scrapling/requirements.txt`](scrapling/requirements.txt) —— 就一个包 `scrapling[fetchers]`，pip 自动拉它的全部传递依赖，**不用手动列 curl_cffi / Camoufox**。

### ⚙️ 一键启动是怎么启动的（直接下就行，不用手动装）

**直接下代码 → 跑一键启动脚本，Python 依赖会自动装，不用你手动 pip**：

```bash
# 1. 克隆
git clone https://github.com/l1064709321/tianyan.git
cd tianyan

# 2. 一键启动 (Linux/macOS)  或  tianyan.bat (Windows)
bash tianyan.sh
```

**`bash tianyan.sh` 内部自动做的事**（你不用手动执行）：

| 步骤 | 动作 | 缺环境时 |
|------|------|---------|
| 1 | 检查 Node.js ≥ 18 + npm | 缺则报错停 |
| 2 | 检查/安装 TypeScript | 自动多镜像装 |
| 3 | `npm install`（postinstall 自动跑 `node scripts/install-scrapling.js` 装 Python 侧车） | 失败降级不崩 |
| 4 | 编译 TS | — |
| **7.5** | **检测 Python 3.10–3.13：有 → 自动 `node scripts/install-scrapling.js` 建 venv + pip 装 scrapling（1~2 分钟）；无 → 打印 WARN 提示电脑端装 Python** | **降级 fetch 层，不阻断** |
| 8 | 启动 `node bin/tianyan.js`（随机端口 + 自动开浏览器） | — |

**Python 依赖自动安装的具体动作**（`scripts/install-scrapling.js`，一键启动时自动调）：
```
python3 -m venv .venv-scrapling          # 建虚拟环境
.venv-scrapling/bin/pip install -r scrapling/requirements.txt   # 装 scrapling[fetchers]
写 marker 文件 → 幂等 (重复跑不会重装)
```

> **国内 pip 镜像源自动轮换**（哪个通用哪个）：`scripts/install-scrapling.js` 装依赖时自动按
> **清华 → 阿里云 → 华为云 → 腾讯云 → 官方** 顺序逐个试，某源 15s 超时即换下一个，哪个能下通就用哪个，全失败才降级。你不用手动配 pip 源。

> **所以：你电脑上只要装好 Python 3.10–3.13（下面手动装那段），然后直接 `bash tianyan.sh` 一键启动，Python 依赖会自动装好，不用你手动 pip。** 没装 Python 也能启动，只是抓取降级成基础 fetch 层。

### 手动装 Python（电脑上一次性，装完重跑一键启动）

```bash
# Windows: https://www.python.org/downloads/  下载 3.10–3.13, 安装勾选 "Add python.exe to PATH"
# macOS:   brew install python@3.12
# Linux:   系统自带 3.10+ 即可; 不够装 3.12
# 装完验证: python3 --version  (要 3.10–3.13)
# 然后重跑一键启动: bash tianyan.sh   (会自动装 Python 依赖 + 启动)
```

**降级矩阵**（缺环境不影响启动）：

| 环境 | 抓取层 | 反爬强度 |
|------|--------|---------|
| 有 python3 + scrapling | Scrapling (curl_cffi 指纹 + 可选 Camoufox) | 最强 |
| 有 python3, 无 scrapling | 自动 urllib 回退 | 中 |
| 无 python3 (手机/Termux) | 零依赖 DOM 模拟 / 纯 fetch | 基础 |

**实测参考**（2026-10，纯 fetch 降级层，仅访问各平台免费榜单页）：

| 平台 | 免费榜单页 | 纯 fetch 层结果 | 说明 |
|------|-----------|----------------|------|
| 晋江文学城 | 月榜 `topten.php` | ✅ 抓 40 本书名 | 免费公开页，纯 fetch 即可 |
| 番茄小说 | 分类榜 / 金番作家榜 / 巅峰榜 | ✅ JSON API 直连，数据干净 | 三个榜均无需签名；分类榜书名有 PUA 字体混淆，靠 `bookId → /page/{id}` 详情页二次还原 |
| 起点中文网 | 畅销榜 `hotsales` | ⚠️ 202 反爬拦截 | 需 Scrapling curl_cffi 指纹层过验证 |

> 结论：晋江、番茄的分类榜/作家榜/巅峰榜纯 fetch 层即可直抓；起点需启用 Scrapling 最强层（电脑上 python3+scrapling）才能稳定过反爬。
> 所有抓取均限定在各平台**免费公开榜单页**，不涉及付费内容（见上文「抓取合规边界」）。
