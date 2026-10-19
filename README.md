# 天衍 (Tianyan)
> 注：本代码同时以 **AGPL-3.0** 和 **GPL-3.0** 双许可发布，用户可任选其一 (AGPL 见 `LICENSE`，GPL 见 `LICENSE_GNU_3`)。
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
| 番茄小说 | **分类榜（默认，按题材自动选分类）/ 分类新书榜 / 金番作家榜 / 巅峰榜**；阅读榜、新书榜是分类榜的别名，热度榜等同巅峰榜 | ✅ |
| 晋江文学城 | 月票榜 / 收藏榜 / 点击榜 / 推荐榜 / VIP 榜 | ✅ |
| 飞卢小说网 | 排行榜 / 月票榜 / 收藏榜 / 点击榜 | ⚠️ 风控严格，常失败 |
| 书旗小说 | 点击榜 (男频) | ✅ |
| QQ阅读 | 热门榜 | ⚠️ 风控严格，常失败 |

> 榜单数据源会随站点改版失效，请以实际扫榜结果为准；抓取失败的平台会在报告里明确标注，不会静默丢弃。

### 其他亮点

- **毒舌审稿机制**：每章评分 1-10，<7 自动打回重写
- **36 维质检**：角色一致性/物资战力/伏笔逻辑/文风表达/结构节奏/大纲偏离共 35 维 + 第 36 维原创度(相似/照抄检测)逐维度审计(S1-S4)，<7 或 S1 直接打回。
  36 维全部有确定性规则兜底(单一数据源 `src/agents/audit-dimensions.ts`)：LLM 漏审的维度由代码层补审，两层都没审的维度会如实标记为「未审」而不会当作通过。强规则命中 S1 一票否决，启发式规则(weak)最多判 CONCERNS，避免误报卡死创作
- **素材库直读**：上传 `txt / md / docx / csv / json` 对标书或参考资料，自动分块入库（docx 走内置 ZIP 解析取正文，不引第三方依赖）；Agent 通过 `read_source` 工具按需分页读原文，杜绝「我看到了附件」式幻觉
- **128k 上下文 + 自动压缩**：窗口默认 128k，用量过 75%（约 96k）触发**滚动摘要压缩** —— 只压上次压缩点之后的新增部分，保留最近 35% 原文，摘要落库 `context_summaries` 记 `upto_id`，长项目不会撑爆上下文，也不重复压缩
- **短期+长期记忆**：Agent 跨轮次保持上下文
- **写作范式语料库**：5 类风格包（传统武侠 / 都市异能 / 史诗奇幻 / 悬疑 / 轻小说）共 11 段高质量范例，配 5 条拆书样本，支持风格匹配与仿写
- **Web 预览界面**：实时查看进度、思考链、对话历史；左侧项目列表常驻，新建项目不会「顶掉」旧项目

---

## 💻 系统支持

| 系统 | 架构 | 一键启动 | 状态 | 说明 |
|------|------|---------|------|------|
| **Windows 10/11** | x64 / arm64 | `tianyan.bat` 或 `start.bat` | ✅ 完整支持 | 需要 Node.js ≥ 18；Win7/8 需自行安装 curl |
| **macOS** (Intel) | x64 | `bash tianyan.sh` | ✅ 完整支持 | 需要 Node.js ≥ 18；首次运行自动装依赖 |
| **macOS** (Apple Silicon) | arm64 | `bash tianyan.sh` | ✅ 完整支持 | M1/M2/M3 原生 arm64 运行，无需 Rosetta |
| **Linux** | x64 / arm64 | `bash tianyan.sh` | ✅ 完整支持 | 含 Ubuntu / Debian / CentOS 等发行版 |
| **沙箱/容器** | 任意 | `bash tianyan.sh` | ✅ 支持 | 无浏览器时自动降级（`--no-browser`） |

### 启动命令对照表

全部平台共用同一套 TypeScript 代码，无平台分支，只是启动脚本不同：

| 用途 | Windows | macOS / Linux |
|------|---------|---------------|
| 一键启动（前台，自动开浏览器） | `tianyan.bat` | `bash tianyan.sh` |
| 快捷入口（等价于上一行） | `start.bat` | `bash start.sh` |
| 后台启动 / 停止 / 重启 | `na.bat start` `stop` `restart` | `bash na start` `stop` `restart` |
| 查看状态 / 实时日志 / 访问地址 | `na.bat status` `log` `url` | `bash na status` `log` `url` |
| 指定端口 | 改 `na.bat` 里的 `PORT` | `bash tianyan.sh --port 8080` |

> **macOS / Linux 用 `bash xxx.sh` 调用不需要执行权限**；想直接 `./tianyan.sh` 的话先 `chmod +x tianyan.sh`。
> `tianyan.sh` 会把额外参数原样透传给 CLI（`--port` / `--api-key` / `--no-browser` 等）。

两个脚本做的事完全一致，都是这 8 步（**环境检测在最前面，缺什么装什么**）：

1. **环境检测与自动安装** —— Node.js (≥22) / npm / Python (3.10–3.13) 依次探测：项目内 `.runtime` → PATH → 各平台常见安装位置。**全都找不到就自动下载安装**（Node 便携版解压到 `.runtime/node/`，Python 走官方安装器 / brew / 包管理器），无需管理员权限
2. 依赖自检 —— 不只看目录在不在，会真去 `require('typescript')` 和 `require('better-sqlite3')`，装了一半也能发现
3. 依赖缺失时按 npmmirror → 华为云 → 腾讯云 → 清华 → 官方 逐个试，**成功即停**，失败会清掉残留再换下一个；全失败**打印真实 npm 报错**
4. 校验 TypeScript 可执行（`node.exe` 绝对路径直调 `typescript/bin/tsc`，不依赖 PATH）
5. 编译 TypeScript —— 失败**打印报错并停下**，不会带着旧 `dist/` 继续跑
6. 安装 Playwright Chromium（失败自动回退系统 Chrome/Edge，再失败降级，不影响启动）
7. 校验 Python 侧车 Scrapling（每次真去 `import scrapling`，包丢了会自动重装）
8. 启动 CLI

> 加 `--no-start` 可以只跑 1–5 步验证环境，不启动服务：`tianyan.bat --no-start` / `bash tianyan.sh --no-start`

> 依赖安装用了 `--ignore-scripts`：`better-sqlite3` 自带各平台预编译 `.node`，跳过 `node-gyp` 本机编译，
> **macOS 上不需要装 Xcode Command Line Tools** 也能跑起来。

> ⚠️ **`.bat` 脚本内不含任何中文**（全部英文输出）。这是刻意的：cmd 在 `chcp 65001` 生效后按字节偏移读取批处理文件，偏移落在多字节 UTF-8 字符中间会导致后续整行错位（表现为 `'efined' is not recognized` 这类怪异报错）。中文提示由 Node 侧输出，不受影响。

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
| better-sqlite3 | ✅ 预编译 | ✅ 预编译 | ✅ 预编译 | 启动脚本用 `--ignore-scripts` 直接取预编译 `.node`，不触发 node-gyp |
| Playwright | ✅ | ✅ | ✅ | 仅扫榜抓取需要，缺失则降级 |
| curl | ✅ Win10+ 自带 | ✅ 系统自带 | ✅ 系统自带 | Win7/8 缺失时自动回退原生 fetch |
| bash 版本 | — | 系统自带 3.2 即可 | 3.2+ | 脚本没用关联数组 / `mapfile` / `readlink -f` 等 4.x 特性 |

---

## 🚀 快速开始

### 前置要求

> **其实什么都不用自己装。** 一键启动脚本会先检测 Node.js / Python / TypeScript，缺什么自动拉取安装。
> 下面这些是脚本会自动帮你搞定的事，列出来是为了让你知道它在后台做什么。

| 环境 | 要求 | 缺失时脚本自动做什么 |
|------|------|---------------------|
| **Node.js** | **≥ 22**（`better-sqlite3@13` 的引擎要求） | 从 npmmirror / 华为云 / nodejs.org 依次下载便携版解压到 `.runtime/node/`，**不需要管理员权限** |
| **npm** | 随 Node 一起 | 若检测到 Node 但不完整（比如只解压了 `node.exe`），自动重装完整便携版 |
| **Python** | 3.10 – 3.13（可选） | Windows 静默安装到当前用户（UAC 弹窗需确认）；macOS 走 `brew`；Linux 在免密 sudo 可用时走包管理器。**装不上只降级抓取，不影响启动** |
| **TypeScript** | 随依赖安装 | 从 5 个 npm 镜像源依次重试，成功即停 |

> ⚠️ 旧版本文档写的是 Node ≥ 18，这是错的：`better-sqlite3@13.0.3` 的 `engines` 字段要求 `>=22`，Node 18 会在原生模块加载时失败。


### 一键启动（推荐）

```bash
git clone https://github.com/y1064709321/tianyan.git
cd tianyan

# macOS / Linux —— 用 bash 调用, 不需要先 chmod
bash tianyan.sh
# 等价写法(需先 chmod +x tianyan.sh):
#   ./tianyan.sh
# 指定端口 / 密钥等, 参数会原样透传给 CLI:
#   bash tianyan.sh --port 8080

# Windows
tianyan.bat
```

> 首次运行自动：**检测 Node.js / npm / Python / TypeScript** → 缺什么装什么 → 装依赖（5 个镜像源轮换）→ 编译 → 装 Playwright / Python 侧车 → 交互式引导 → 自动打开浏览器。
> **默认无内置密钥**：可在引导界面直接输入，也可跳过后在网页界面配置。

### 只装环境、不启动（`--no-start`）

想知道环境到底通没通，又不想真的把服务拉起来，用这个：

```bash
# macOS / Linux
bash tianyan.sh --no-start

# Windows
tianyan.bat --no-start
```

跑完看到这一行就是全通了：

```
+ environment ready (--no-start, not launching)
```

它依次验证：Node.js 版本 → npm → Python → TypeScript 编译器 → 编译产物 `dist/index.js`。任一步失败都会**直接打印真实报错**并停下，不会假装成功。


**macOS 上可能遇到的两种情况**：

| 现象 | 原因 / 处理 |
|------|------------|
| `zsh: command not found: node` | Node 装在了 Homebrew 路径但没进 PATH。脚本会自动去 `/opt/homebrew/bin`、`/usr/local/bin` 等位置找；若仍找不到，`brew install node` 或 `echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc` |
| `permission denied: ./tianyan.sh` | 文件没有执行位。用 `bash tianyan.sh`，或先 `chmod +x tianyan.sh` |

> 首次 `git clone` 后脚本默认没有执行位（Git 只保留仓库里记录的 mode），所以文档统一推荐 `bash tianyan.sh`。

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

# 上下文预算 (128k 窗口, 到 75% 触发自动压缩, 压缩后保留最近 35% 原文)
context_window: 128000
context_compact_ratio: 0.75
context_keep_ratio: 0.35
```

> 这三项目前改 `~/.tianyan/config.yaml` 后重启生效（后端已通过 `/api/settings` 暴露，前端设置面板暂未提供输入框）。
> 小模型（如 32k 窗口的本地模型）把 `context_window` 调成 32000 即可，压缩阈值按比例自动跟随。

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
│   │   └── runner.ts       # Agent 运行引擎 (46 工具调度)
│   ├── context/
│   │   └── compact.ts      # 上下文预算估算 + 滚动摘要压缩
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

## 🔧 可用工具 (46 个)

| 分类 | 工具 | 说明 |
|------|------|------|
| 项目 | query_project | 查询项目状态/章节/元素 |
| 项目 | read_source | 读用户上传的素材库（不传 name 列目录，传 name 分页读正文） |
| 扫榜 | scan_bestseller | 真实浏览器抓取平台榜单 |
| 拆书 | analyze_novel | 拆解对标作品结构 |
| 大纲 | generate_outline | 生成大纲 + 自动创建章节骨架 |
| 大纲 | manage_outline | 查询/更新章节大纲 |
| 角色 | manage_character | 创建/查询角色档案 |
| 世界观 | manage_world | 管理地点/势力/规则/时间线 |
| 设定 | add_element | 逐条写入设定集（character / world / plot / style） |
| 写作 | continue_writing | 续写正文 |
| 写作 | ghostwrite | 指定风格代笔 |
| 审核 | review_chapter | 毒舌评分审稿 |
| 质检 | quality_check | 36 维质检 (含原创度) |
| AI检测 | detect_ai | 检测 AI 味浓度 |
| 搜索 | web_search / browser_search | 联网搜索 |
| 抓取 | web_fetch / browser_fetch | 抓取网页正文 |
| 导出 | export_project_data | 导出 txt/json |
| 委派 | delegate_to_agent | Agent 间任务委派 |
| ... | (共 46 个) | |

> 46 个是 `dispatchTool` 支持的全部能力；其中 26 个以 OpenAI 原生 function calling schema 暴露给模型（`TOOL_SCHEMAS`），其余由委派链路、确定性兜底或内部流程调用。

---

## 📋 工作流模式

| 模式 | 说明 |
|------|------|
| **状态机** (默认) | 严格阶段门禁：扫榜 → 拆书 → 角色 → 大纲 → 写作 → 审核 → 导出，不可跳步 |
| CrewAI | 灵活协作：跳过阶段门禁，适合快速迭代 |

通过 `switch_workflow_mode` 工具或前端界面切换。

---

## 🗓 最近更新 (2026-10-19)

### 🚀 一键启动器重写：从「启动不了」到「自己把环境装好」

这次改动全部集中在**启动脚本本身**，没有改任何业务逻辑。起因是一个真实故障：用户机器上根本没装 Node.js，
但脚本报出来的却是「5 个镜像源全部安装失败」，把所有人带到了网络问题上排查。

#### 加了什么

| 新增能力 | 具体做法 | 解决什么问题 |
|---------|---------|-------------|
| **Node.js 自动检测 + 自动安装** | 依次探测：项目内 `.runtime/node` → `PATH` → `C:\Program Files\nodejs` / `%LOCALAPPDATA%\Programs\nodejs` / fnm / nvm / volta。全都没有就从 **npmmirror → 华为云 → nodejs.org** 下载 v22.23.3 便携版 zip，解压到 `.runtime/node/` | 用户不用预装 Node，**不需要管理员权限**，也不会污染系统 |
| **npm 完整性校验** | 检测到 Node 后单独验证 `npm -v`；只看 `node.exe` 存在不算数（常见于「只解压了 node.exe」的残缺安装） | 残缺安装会被识别并自动重装完整便携版 |
| **Python 自动检测 + 自动安装** | 按 `3.12 → 3.13 → 3.11 → 3.10 → 3` 顺序探测。Windows 下载 `python-3.12.10-amd64.exe` 静默装到当前用户；macOS 走 `brew`；Linux 仅在**免密 sudo** 可用时走 apt/dnf/yum/pacman | 装不上只降级抓取，**不影响启动** |
| **版本门槛修正 18 → 22** | `better-sqlite3@13.0.3` 的 `engines` 要求 `>=22`，旧脚本写的是 `>=18` | 消除 Node 18 上原生模块加载失败的隐患 |
| **TypeScript 就绪校验** | 用 `tsc --version` 真实执行校验，而不是「看 `node_modules` 目录在不在」 | 依赖装了一半时能被发现 |
| **编译门禁改为「新鲜编译成功」** | 先清空判断，再跑 `tsc`；失败直接打印全部报错并 `exit /b 1`。不再用「`dist/index.js` 是否存在」当门禁 | 目录里躺着一个陈旧的 `dist/index.js` 时，旧逻辑会误判为编译通过 |
| **npm 失败打印真实报错** | 5 个镜像全失败时，尾部 `tail -30` 打印 npm 原始错误 + 完整日志路径 | 不再用「全部镜像失败」这种误导性归因掩盖真实原因 |
| **`--no-start` 参数** | 只检测环境、装依赖、编译，不启动服务 | 可以先验证环境层，把「环境问题」和「服务问题」拆开定位 |
| **Playwright 回退系统浏览器** | `src/realBrowser.ts` 新增 `launchBrowser()`：自带 Chromium 不可用时，自动回退 `chrome → msedge → chrome-beta` | 没下完 Chromium 也能用；不再因为一个可选依赖卡住启动 |
| **下载进度可见** | Playwright / npm 的输出不再 `>nul 2>&1`，改为实时显示（npm 用 `Tee-Object` 同时写日志） | 慢速下载时用户能看到「在动」，不会被误判为卡死 |

#### 修掉的 bug（都是真实踩到的）

| Bug | 症状 | 根因 |
|-----|------|------|
| **版本探测把报错当版本号** | 明明没装 Node，脚本却认为装了 | `for /f ... ('"%NODE_EXE%" -v 2^>^&1')` 把 stderr 的 `is not recognized...` 读成了版本号，`if not defined NODE_VER` 永远不会触发。改为**重定向到临时文件再读** |
| **`.bat` 含中文导致整行错位** | `'efined' is not recognized`、`'lNode' is not recognized`、`'下载完成' is not recognized`，行首被吃掉几个字符 | cmd 在 `chcp 65001` 生效后按字节偏移读文件，偏移落在多字节 UTF-8 字符中间时，**后续整段错位**。根治办法：`.bat` 保持**纯 ASCII**，中文输出交给 Node |
| **`tsc.cmd` 依赖 PATH** | `'"node"' is not recognized` 编译失败 | `node_modules\.bin\tsc.cmd` 内部写的是裸 `node`。改为 `node.exe` 绝对路径直调 `typescript/bin/tsc`，**彻底不依赖 PATH** |
| **npm 调用依赖 PATH** | 同上报 `is not recognized` | 同理，优先用 `node.exe + npm-cli.js`，`npm.cmd` 只作兜底 |

#### 效果

改完后在**没装任何环境**的 Windows 机器上实测通过（`verify-output.txt`）：

```
  Node.js    v24.22.0  OK
  npm        11.19.1  OK
  Python     3.13  OK
  TypeScript 5.9.3  OK
  compiling TypeScript...
  + build done
  + environment ready (--no-start, not launching)
  dist\index.js EXISTS
```

**用户视角的变化**：从「下载一堆东西、报一堆错、不知道哪里出问题」，变成「跑一条命令，缺什么它自己装，装完直接启动」。

#### 涉及文件

| 文件 | 改动 |
|------|------|
| `tianyan.bat` | 全文重写：环境检测层 + 纯 ASCII 输出 + node 直调 |
| `tianyan.sh` | 同步对齐：同样的检测链，兼容 macOS 自带 bash 3.2 |
| `install.bat` | 不再 `where node` 查不到就退出，改为复用 `tianyan.bat --no-start` |
| `verify.bat` | 新增：一键验证脚本，结果写入 `verify-output.txt` 并自动打开 |
| `src/realBrowser.ts` | 新增 `launchBrowser()` 系统浏览器回退 |
| `.gitignore` | 新增 `.runtime/`（便携运行时，50MB+，不入库） |

---

## 🗓 最近更新 (2026-10-19 · 二)

### 🏗 项目沙箱 + 共享文笔样本库#### 一、项目沙箱（每本书独立数据目录）

**为什么需要**：之前虽然数据库按 `project_id` 隔离得很干净，但**磁盘上所有书共用一个工作目录**——导出文件、抓取缓存、临时产物混在一起，互相覆盖，删项目也清不干净。

**做了什么**：

| 能力 | 实现 | 效果 |
|------|------|------|
| **按项目分目录** | `~/.tianyan/sandboxes/<pid>/`，内含 `export/ cache/ scrape/ tmp/` 四类子目录 | 每本书的产物各归各，不会互相覆盖 |
| **创建时自动建** | `POST /api/projects` 里调用 `ensureSandbox(id)` | 新项目开箱即有独立空间 |
| **删除时自动清** | `DELETE /api/projects/:pid` 调用 `purgeSandbox(pid)` | 删库同时清文件，不留残渣 |
| **启动时补偿** | 服务启动时为所有已有项目补建目录 | **旧项目自动升级**，无需手动迁移 |
| **孤儿回收** | 启动时 + `POST /api/sandbox/gc` 清理「项目已删但目录还在」的沙箱 | 磁盘不会越用越满 |
| **ID 净化** | `safeId()` 把非 `[a-zA-Z0-9_-]` 字符替换掉 | 防止目录穿越 |
| **占用统计** | `GET /api/projects/:pid/sandbox` 返回路径与字节数 | 能看出哪本书占了多少空间 |
| **手动清理** | `DELETE /api/projects/:pid/sandbox` 只清文件、保留项目和记录 | 空间不足时可单独清缓存 |

> ⚠️ **这是"数据隔离"，不是进程级隔离，也不含浏览器隔离**。所有书仍跑在同一个 Node 进程里——做进程池需要 IPC、端口分配、生命周期管理，改动和风险都不成比例。浏览器实例目前仍是全局共享的（`realBrowser.ts` 的 `sharedBrowser`），尚未按项目隔离。

#### 二、共享文笔样本库（跨书共用）

**为什么需要**：每本书的 `long_term_memories` 是按 `project_id` 隔离的，等于**每本书都要从零学一遍文笔**。写完一本书积累的好句子，下一本用不上。

**做了什么**：

| 设计 | 说明 |
|------|------|
| **独立数据库** | `~/.tianyan/style-samples.db`，与主库分开。原因：删项目时会 `VACUUM` 主库，样本若混在里面可能被连带删除 |
| **不按项目隔离** | 所有书共用一份，这才叫"共享" |
| **实时读取** | `readStyleSamples()` 每次都直接查库、不缓存 → **写入后下一次写作立刻生效** |
| **自动采集** | 每章写完后 `harvestFromChapter()` 抽取特征段落入库（对话密集 / 动作密集），每章最多 2 条防灌爆 |
| **智能召回** | 排序：`题材匹配 > 评分高 > 使用少`，并递增 `used_count` 让样本轮换，避免老片段反复出现 |
| **预算控制** | 单条最多 400 字、总量 2000 字，不会挤爆上下文 |
| **去重** | 同文本重复录入只更新评分与来源，不产生重复行 |

**接入位置**：`continue_writing` 写章时，把召回结果作为「文风参照」注入提示词，并明确要求**学句式节奏、严禁照抄原句**。

**可用接口**：

```
GET    /api/style/samples          列出样本 + 统计
POST   /api/style/samples          手动录入 { text, kind, genre, source, rating }
DELETE /api/style/samples/:sid     删除单条
GET    /api/style/preview?genre=X  预览"写作时实际会注入哪些样本"
```

> `preview` 用的是与写作时**同一个函数**，所以所见即模型所得，便于调参。

#### 三、顺带修掉的一致性隐患

| 文件 | 问题 | 修法 |
|------|------|------|
| `src/agents/runner.ts` | 章摘要与角色状态更新是 fire-and-forget，下一章开写时往往还没入库 → **连续写几章就开始跑偏** | 改为 `await`，落库后再进下一章 |
| `src/perception/engine.ts` | Phase 5 路由指向 `ghostwrite`（简版上下文、无写后闭环） | 切到 `continue_writing`（三层滚动注入 + 写后闭环） |
| `src/perception/engine.ts` | `toolName === "continue_writing" as string;` 是无效语句 | 删除，改为正确的参数分支 |
| `src/perception/engine.ts` | 空章节用 `find()` 而非按 `idx` 排序 | 按 `idx` 升序，严格按大纲顺序推进 |

**涉及文件**：`src/sandbox.ts`（新增）、`src/styleLibrary.ts`（新增）、`src/index.ts`、`src/agents/runner.ts`、`src/perception/engine.ts`

---

## 🗓 历史更新 (2026-10-18)

- **素材上传全链路打通**：上传框支持 `txt / md / docx / csv / json` 多选；`.docx` 用内置 ZIP 解析（EOCD + `zlib.inflateRawSync` 读 `word/document.xml`）抽正文，零第三方依赖；新增 `read_source` 工具与 `GET/DELETE /api/projects/:pid/sources`，Agent 真的能读到正文而不是「假装看到附件」。
- **128k 上下文 + 自动压缩**：新增 `src/context/compact.ts`，用量过 75% 触发滚动摘要，`context_summaries` 表记 `upto_id` 只压增量，压缩过程在思考面板里可见。
- **侧边栏重构**：去掉项目下拉，改成「项目 / 内容」两个常驻分区；项目行带首字印章徽标、章数·字数、相对时间，当前项整行高亮，悬停出现删除，顶部带项目搜索。
- **题材库扩充 + 自定义**：新建项目改为分组标签选择器（主分类单选、题材/主角/情节多选），男频 105 个、女频 74 个标签，支持自定义题材；落库格式 `主分类 / 标签 / 自定义`，与扫榜的 `split(/[\/、,，]/)[0]` 完全兼容。
- **项目信息可编辑**：新增 `PUT /api/projects/:id`；点文件树里的「⚙️ 项目设置」即可改名称/题材/文风/核心设定/频道，题材按落库字符串自动回填到选择器（命中主分类库的当主分类，其余作标签）。
- **Bug 修复**：非流式回退分支丢弃 `tool_calls`（日志显示「模型本轮调用工具」但 `total_steps: 0`）；`.main` 未给 fixed 侧栏让位，导致顶栏压住侧栏品牌区、聊天区左半边被遮。
- **启动脚本对齐**：`tianyan.sh` / `na` 逐段对齐 `tianyan.bat` / `na.bat` —— Node 多路径兜底（Homebrew / MacPorts / nvm / fnm / volta）、依赖真 `require` 校验、5 镜像轮换后清理残留、本地 `tsc` 取代 `npx`（避免下到同名的废弃 `tsc` 包）、编译失败打印报错并停下、Playwright 直接问 `chromium.executablePath()` 判断是否已装、Scrapling 每次真 `import` 校验。新增 `.gitattributes` 固定 `.sh` 为 LF、`.bat` 为 CRLF，避免 macOS 上 `\r: command not found`。

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
git clone https://github.com/y1064709321/tianyan.git
cd tianyan

# 2. 一键启动 (Linux/macOS)  或  tianyan.bat (Windows)
bash tianyan.sh
```

**`bash tianyan.sh` / `tianyan.bat` 内部自动做的事**（你不用手动执行）：

| 步骤 | 动作 | 缺环境时 |
|------|------|---------|
| 1 | 检查 Node.js ≥ **22** | **未安装或版本过低 → 自动下载便携版装到 `.runtime/node/`**（无需管理员权限） |
| 2 | 检查 npm | 有 Node 但缺 npm → 自动重装完整便携版 |
| 3 | 检查 Python 3.10–3.13 | 未安装 → Windows 静默装 / macOS 走 brew / Linux 走包管理器；**装不上只降级，不阻断** |
| 4 | `npm install`（5 镜像轮换，成功即停）+ 校验 TypeScript 可执行 | 失败打印真实 npm 报错并停下 |
| 5 | 编译 TS（`node.exe` 直调 `typescript/bin/tsc`） | 编译失败打印全部报错并停下 |
| 6 | 装 Playwright Chromium（可选） | 失败自动回退系统 Chrome/Edge；都没有则降级 |
| 7 | 跑 `node scripts/install-scrapling.js` 校验/安装 Python 侧车 | 失败降级 fetch 层，不阻断 |
| 8 | 启动 `node bin/tianyan.js`（随机端口 + 自动开浏览器） | — |

**Python 依赖自动安装的具体动作**（`scripts/install-scrapling.js`，一键启动时自动调）：
```
python3 -m venv .venv-scrapling          # 建虚拟环境
.venv-scrapling/bin/pip install -r scrapling/requirements.txt   # 装 scrapling[fetchers]
写 marker 文件 → 幂等 (重复跑不会重装)
```

> **国内 pip 镜像源自动轮换**（哪个通用哪个）：`scripts/install-scrapling.js` 装依赖时自动按
> **清华 → 阿里云 → 华为云 → 腾讯云 → 官方** 顺序逐个试，某源 15s 超时即换下一个，哪个能下通就用哪个，全失败才降级。你不用手动配 pip 源。

> **所以：新机器上直接克隆下来跑一键启动就行——Node.js、Python、TypeScript 都会自动检测并安装。**
> 想先确认环境通不通，用 `--no-start` 只验环境不启动。没装 Python 也能启动，只是抓取降级成基础 fetch 层。

### 手动装 Python（可选，脚本装不上时的兜底）

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
| 番茄小说 | 分类榜 / 金番作家榜 / 巅峰榜 | ✅ JSON API 直连，数据干净 | 三个榜均无需签名；分类榜书名有 PUA 字体混淆，**靠本地字体映射表还原（零请求）**，详情页只做兜底；`rankMold=2` 才是阅读榜、`1` 是新书榜（反直觉，代码里用 `FQ_RANK_*` 常量） |
| 起点中文网 | 畅销榜 `hotsales` | ⚠️ 202 反爬拦截 | 需 Scrapling curl_cffi 指纹层过验证 |

> 结论：晋江、番茄的分类榜/作家榜/巅峰榜纯 fetch 层即可直抓；起点需启用 Scrapling 最强层（电脑上 python3+scrapling）才能稳定过反爬。
> 所有抓取均限定在各平台**免费公开榜单页**，不涉及付费内容（见上文「抓取合规边界」）。

#### 番茄书名的字体混淆与还原

分类榜接口返回的 `bookName` / `author` / `abstract` **不是明文**：一部分汉字被逐字替换成私用区码点（U+E000–U+F8FF），页面靠一个 woff2 子集字体把这些码点画成正确字形。所以**人眼看到的是对的，任何读文本的程序（含 LLM）看到的全是错的**——不解码就直接喂给模型，模型读到的是乱码。

还原链路（`src/agents/fanqie.ts`）：

1. **本地字体映射表（主路径，零请求）** — `src/agents/fanqieFontMap.ts` 由 `scripts/build-fanqie-fontmap.cjs` 生成：抓番茄在用的 woff2 子集，把「同一份思源黑体」和「子集字体」的同一个字分别用 Chromium canvas 渲成位图，按形状相似度（正方形归一化 IoU 为主项 + 宽高比为补丁）配对，产出 284 条码点→汉字。全站共用一个字体文件（hash `dc027189e0ba4cd`），映射固定。
2. **手工校准表** — 字形比对只认形状不认字频，异体/生僻字会以零点几的优势抢先（如「被」的真实字形被生僻「柀」0.322 抢先，「被」掉到 0.412）。`FANQIE_GLYPH_FIX` 只收**外部来源逐字核对过**的条目，宁留 □ 不错字——错字会静默改掉书名且无法发现，漏字还有 □ 和详情页两道防线。
3. **详情页兜底（降级通道）** — 只有书名还有漏网码点才打 `/page/{id}`。

**详情页软限流（实测 2026-10-18）**：`/page/{id}` 短时间请求多了之后返回 **HTTP 200 + 空 body**（不是 429，不报错，就是空），按 IP 挡，换 UA / 带 cookie 均无效。所以详情页必须节流 400ms + 空 body 退避重试 + 连续 3 次熔断 10 分钟，**且书名还原不了也要保留条目**（否则 20 本全丢、名次串位、整榜被当成「抓取失败」）。

**验收与维护**：

```bash
node scripts/build-fanqie-fontmap.cjs   # 重建映射表 (字体换版本时跑，约 20~60s)
node scripts/verify-fanqie-fontmap.cjs  # 拿 25 条真名验收: 当前 25/25, 逐字 100%
node scripts/test-fanqie.cjs            # rankMold 语义 + 题材映射回归
node scripts/truth-book-titles.cjs 1140 10,14,15 2   # 补洞取证: 接口乱码 vs 详情页真名
```

验收标准答案按 **bookId** 索引而非名次——榜单顺序随在读人数变动，按下标配对在列表重排后会大面积误报。答案来源分两种并已在脚本里注明：① 详情页能访问时取 `<title>` 原文；② 详情页被限流时用 web 搜索书名片段交叉核对（官网标题与百度百科/笔趣阁等两个以上来源一致才收）。

