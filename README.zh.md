[English](./README.md) | 中文 | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **盯死 agent，别信它嘴硬，不真干完别想溜。**

_一个 Claude Code 插件：把 agent 按在同一个会话里反复干同一件事，不到活真的干完不松手。没有什么"完成信号"能糊弄过去，agent 想提前溜？没门。_

[快速开始](#快速开始) • [为什么用 Watchdog](#为什么用-watchdog) • [工作原理](#工作原理) • [命令](#命令) • [安装](#安装) • [灵感来源](#灵感来源)

---

## 核心维护者

| 角色 | 姓名 | GitHub |
| --- | --- | --- |
| 创建者 & 维护者 | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## 快速开始

**第一步：安装**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**第二步：验证**

```bash
/watchdog:help
```

**第三步：启动一个 watchdog**

```bash
/watchdog:start "修复 tests/auth/*.ts 里那些不稳定的认证测试。一直迭代直到整个测试套件都通过。" --max-iterations 20
```

就这样。每轮结束后 Watchdog 会把 prompt 原封不动再喂给 Claude，直到下列三件事之一发生：

- 某一轮 Claude 一个文件都没动，**或者**
- 达到 `--max-iterations` 上限，**或者**
- 你手动跑 `/watchdog:stop`。

剩下的全自动，不用你管。**Agent 从头到尾都不知道自己在循环里。**

---

## 为什么用 Watchdog

- **Agent 耍不了滑头** —— 它全程都不知道自己在循环里。没有 `systemMessage`、没有迭代计数、没有启动 banner。想靠嘴上说一句"我搞定了"就溜？根本没这个通道。
- **光动嘴不算数** —— 纯文本 turn（"我已经检查过了，没问题"）永远不会让 loop 退出。这一轮里必须真的调了至少一个工具，才有资格被考虑退出。
- **让 LLM 判"这轮改没改项目文件"** —— 每次 hook 触发，watchdog 都会起一个短命的 **Claude Code 子进程**（`claude -p --model haiku`），只问它一个问题："这一轮有没有改过任何项目文件？"。子进程能看到每个工具调用的完整参数，语义级判断。Haiku 只是它跑的模型而已 —— 重点是这是一个**隔离的、无状态的 Claude Code 进程**，不是什么自定义 API client，所以你现有的 `claude` 认证原封不动就能用。
- **每个会话各管各的** —— 状态文件按父级 Claude Code 进程 ID 分开存，通过进程祖先链自动找。同一个项目目录里并发跑 100 个 watchdog 也不会打架。
- **Agent 看不见循环** —— 所有诊断都走 stderr，transcript 里一点 loop 的痕迹都不会漏给 agent。
- **Apache 2.0** —— 干净地派生自 Anthropic 官方的 `ralph-loop`，完整归属写在 [NOTICE](./NOTICE) 里。

---

## 工作原理

你只需要运行**一次**命令，剩下的 Claude Code 自己搞定：

```bash
# 你只运行一次：
/watchdog:start "你的任务描述" --max-iterations 20

# 然后 Claude Code 会自动：
# 1. 处理任务
# 2. 尝试退出
# 3. Stop hook 拦截退出，把同一个 prompt 重新喂回去
# 4. Claude 在同一个任务上继续迭代，能看到自己上一轮的修改
# 5. 重复，直到某一轮结束时没有修改任何项目文件
#    （或者达到 --max-iterations 上限）
```

这里的"循环"不是外部的——没有 `while true`、没有 orchestrator 进程。`hooks/stop-hook.js` 里的 Stop hook 会阻止 Claude Code 的会话退出，并通过 Claude Code 原生的 `{"decision": "block", "reason": ...}` 协议把原始 prompt 作为新的 user turn 再注入回去。

说白了就是一个**循环自己喂自己**的结构：
- 每轮喂的 prompt 都是同一个
- Claude 上一轮干的活原封不动留在文件里
- 下一轮能看到自己上次改了啥、git 里多了什么
- Claude 就这样读自己写的代码，一步步往前推

### 退出条件

Loop 退出需要当前 turn **同时**满足两个条件：

| 检查项 | 要求 |
| --- | --- |
| **工具调用前置** | 当前 turn 必须至少调用了一个工具。纯文本 turn 永远不退出。 |
| **分类器子进程判定** | 一个短命的 Claude Code 子进程（`claude -p --model haiku`）返回 `NO_FILE_CHANGES`。子进程能看到每个工具调用的完整 input，语义级判定当前 turn 有没有直接修改任何项目文件。 |

任一失败就继续 loop。额外的退出路径：

- `--max-iterations` 到达（硬上限，永远生效）
- 用户运行 `/watchdog:stop`（删除状态文件）
- 状态文件被手动从磁盘删除

---

## 命令

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | 在当前会话启动一个 watchdog | `/watchdog:start "重构 services/cache.ts，迭代到 pnpm test:cache 通过" --max-iterations 20` |
| `/watchdog:stop` | 取消当前会话的 watchdog | `/watchdog:stop` |
| `/watchdog:help` | 在 Claude Code 里打印完整命令参考 | `/watchdog:help` |

### 用文件传长 prompt

如果你的 prompt 里带换行、引号、反引号、`$` 或其它会破坏 slash command `!` 代码块里 shell 参数解析的字符——比如一整段多段落的 Markdown 任务描述——直接用文件传进去：

```bash
/watchdog:start --prompt-file ./tmp/my-task.md --max-iterations 20
```

文件由 Node 直接 `fs.readFileSync` 读取，完全绕开 shell 转义。相对路径基于 Claude Code 当前会话的工作目录解析。UTF-8 BOM 会被自动剥除（Windows 记事本保存的文件不会翻车），CRLF 换行按字节原样保留，首尾空白会被 trim。**不能和内联 `<PROMPT>` 同时使用**，二选一。

支持 Linux/macOS/WSL 的 POSIX 路径（`/home/you/…`、`./tmp/…`）、Windows 绝对路径（`C:\Users\you\…`、`C:/Users/you/…`）以及 UNC 路径（`\\server\share\…`）。`~` 由你的 shell（bash/zsh）展开，Watchdog 自己不处理——在 `cmd.exe` 下请用 `%USERPROFILE%\…` 或绝对路径。带空格的路径需要像传其它 shell 参数一样加引号：`--prompt-file "./my prompts/task.md"`。完整的路径处理说明见 `/watchdog:help`。

### 用 `--exit-confirmations` 要求更严格的收敛

默认情况下，Haiku 第一次返回 `NO_FILE_CHANGES` 循环就退出。如果你想加一道保险，确认 agent 真的收敛了，可以把门槛调高：

```bash
/watchdog:start "重构 services/cache.ts，迭代直到 pnpm test:cache 通过。" --exit-confirmations 3 --max-iterations 20
```

这样循环就要求**连续三轮**都判定干净才能退出。一旦分类器返回 `NO_FILE_CHANGES` 以外的任何结果——`FILE_CHANGES`、`AMBIGUOUS`、分类器失败（`CLI_MISSING` / `CLI_FAILED`）、或者一轮纯文本（没有任何工具调用）——streak 计数器立刻清零。**收敛必须不被打断**才算数。

默认值为 `1`，行为和 1.3.0 之前完全一致。**不能和 `--no-classifier` 同时使用**。

### 用 `--watch-prompt-file` 在循环中热更新 prompt

如果你用 `--prompt-file` 启动了循环，又想在跑的过程中改任务,加上 `--watch-prompt-file`：

```bash
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 30
```

Stop hook 会在每一轮开始时重新读这个 prompt 文件。如果内容相比上一轮变了,新版本会作为下一轮的 user turn**并且** `--exit-confirmations` 的 streak 计数器会被清零（任务都重新定义了，之前累积的收敛次数已经不算数了）。

热更新**永远不会让循环崩溃**：如果文件被删了、变空了、读不出来,hook 会**静默**保留上一份缓存的 prompt 继续往下跑。你可以中途随便改、随便重命名、随便临时移动这个文件,下一轮会用当时能读到的最新版本。

需要先有 `--prompt-file`。**单独传 `--watch-prompt-file` 是错误**。

### 用 `--no-classifier` 完全禁用分类器

如果你想要 ralph-loop 那种风格——不让任何 LLM 判定收敛，全靠你手动停或者 `--max-iterations` 兜底：

```bash
/watchdog:start "一直跑直到我 /watchdog:stop。" --no-classifier --max-iterations 0
```

Stop hook 会**完全跳过** Haiku 调用。退出循环只剩两个途径：`--max-iterations` 和 `/watchdog:stop`。配 `--max-iterations 0` 就是无限循环,除非你手动停。

这个模式下 `claude` CLI 都不需要装（Haiku 子进程根本不会被启动）。可以和 `--prompt-file`、`--watch-prompt-file` 自由组合。**不能和 `--exit-confirmations` 同时用**——既然没人判定收敛,streak 计数器就毫无意义。

---

## 状态文件

Per-session 状态文件位于 `.claude/watchdog.claudepid.<PID>.local.json`，其中 `<PID>` 是通过进程祖先链爬出来的父级 Claude Code 进程 ID。示例：

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "claude_pid": 1119548,
  "started_at": "2026-04-11T12:00:00Z",
  "prompt": "修复不稳定的认证测试..."
}
```

每个 Claude Code 会话都有自己独一份的 PID，所以**同一个项目目录里并发跑 100 个 watchdog 也不会打架**——每个都拿到自己的状态文件，在任何一个里面跑 `/watchdog:stop` 也只会取消那一个会话的 loop。

**查看正在运行的 watchdog：**

```bash
# 列出本项目所有活跃的 per-session 状态文件
ls .claude/watchdog.claudepid.*.local.json

# 用 jq 或 node 看某一个的内容
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/watchdog.claudepid.<PID>.local.json','utf8')))"
```

**手动杀掉本项目所有 watchdog：**

```bash
rm -f .claude/watchdog.claudepid.*.local.json
```

---

## 安装

### 首选：marketplace 安装（推荐）

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

装完用 `/watchdog:help` 验证。

### 备选：单次会话本地加载

想先试用一下又不想动全局配置，只为当前这一次会话临时加载：

```bash
claude --plugin-dir /绝对路径/to/claude-code-watchdog
```

### 备选：手动编辑 `settings.json`

CI/CD 场景、内部部署或离线使用时，clone 仓库之后在 `~/.claude/settings.json` 手动配置：

```json
{
  "extraKnownMarketplaces": {
    "claude-code-watchdog": {
      "source": {
        "source": "directory",
        "path": "/绝对路径/to/claude-code-watchdog"
      }
    }
  },
  "enabledPlugins": {
    "watchdog@claude-code-watchdog": true
  }
}
```

改完在 Claude Code 里跑 `/reload-plugins`。

---

## 对 agent 隐藏循环的存在

这个设计的核心就是：**不能让 agent 知道自己在循环里**。它一旦知道了，立马就会想办法第一轮凭记忆编一句"搞定了"混过去。Watchdog 是这么做的：

- **Stop hook 不输出 `systemMessage` 字段** —— 不显示迭代计数、不显示状态 banner
- **Setup 脚本 stdout 只输出用户的 prompt** —— 没有 "Loop activated, iteration 1" 之类的初始化头部
- **重发的 prompt 就是原文 + 一条简短的英文验证提醒**：

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **所有诊断信息都走 stderr（`>&2`）** —— Claude Code 的 transcript 不会把它们当成 agent context 吸进去

在 agent 眼里，就是同一个用户反复问同一个问题，偶尔加一句"请真的去跑一遍检查"。它看不到 Stop hook、看不到迭代次数、看不到任何循环的痕迹。**连循环存在都不知道，还怎么骗？**

---

## 写 prompt 的最佳实践

### 1. 明确的完成标准

Prompt 要能被"不需要再改任何文件"这个状态真实地、可验证地回答。

❌ 不好："建一个 todo API，做得好点。"

✅ 好：

```markdown
在 `src/api/todos.ts` 里实现 todo 的 REST API。

要求：
- CRUD 端点齐全
- 有输入校验
- `tests/todos.test.ts` 里覆盖率 80% 以上
- `pnpm test` 全部通过
```

### 2. 可验证的、可逐步推进的目标

Loop 的退出条件是"没有文件被修改"。如果你的任务没有可验证的终止状态，它就会空转。

✅ 好：

```markdown
重构 `services/cache.ts`，删掉老的 LRU 实现。

步骤：
1. 删掉老的 LRU class 和它的测试
2. 更新 `src/` 下所有调用方改用新的 cache API
3. 每次修改后跑 `pnpm typecheck && pnpm test:cache`
4. 迭代到两者都无警告通过为止
```

### 3. 自纠错结构

告诉 agent 失败时怎么办、怎么调整。

```markdown
用 TDD 实现功能 X：
1. 在 tests/feature-x.test.ts 里写失败的测试
2. 写最少量的代码让测试通过
3. 跑 `pnpm test:feature-x`
4. 如果有测试失败，读错误信息、修复、再跑一次
5. 全绿之后再重构
```

### 4. 永远设置 `--max-iterations`

分类器子进程不是 100% 可靠。一个卡住的 agent 可能反复做无意义修改；一个被绕晕的 agent 可能过早停止编辑。这些情况都应该落到一个硬性上限上。`--max-iterations 20` 是一个合理的默认值。

---

## 什么时候用 Watchdog

**适合：**

- 有明确、可自动化验证的成功标准（测试、lint、类型检查）
- 迭代式修复：改 → 测 → 改 → 测
- 可以离开电脑的 greenfield 实现
- 系统性审查现有代码并修复问题

**不适合：**

- 需要人类判断或设计决策的任务
- 一次性操作（单个命令、单次文件编辑）
- "完成"主观定义的任务
- 需要外部上下文的生产环境调试

---

## 系统要求

Watchdog 需要 **`claude` 和 `node` 两个都在你的 `PATH` 里** —— `node` 用来跑插件的 hook 和 setup 脚本，`claude` 则是 watchdog 要 spawn 出来（`claude -p --model haiku`）判断每一轮有没有改过项目文件的那个家伙。两个缺一不可。

| 要求 | 原因 |
| --- | --- |
| **Claude Code 2.1+** | 使用 Stop hook 体系和 marketplace 插件格式 |
| **`node`** 18+ 在 `PATH` 里 | 插件的 hook 和 setup 脚本跑在 Node 上 |
| **`claude` CLI** 在 `PATH` 里 | 每次 hook 触发，watchdog 都会 spawn 一个短命的 `claude -p --model haiku` 子进程去分类当前 turn。必须已经完成认证（OAuth 或 `ANTHROPIC_API_KEY`）—— 子进程直接复用你现有的会话凭据。 |

### 安装依赖

如果你是用 `npm install -g @anthropic-ai/claude-code` 装的 Claude Code，`claude` 和 `node` **两个都已经齐活了** —— npm 安装顺手把 `claude` 加进 `PATH`，而 Node.js 本来就是 npm 的运行时，早就在那了。啥都不用再装。

如果你是用别的方式装的 Claude Code（独立二进制、Homebrew、Windows 安装器之类的），`claude` 已经在 `PATH` 里了，但可能得自己单独装一下 Node.js 18+：

**macOS（Homebrew）：**

```bash
brew install node
# claude CLI：见 https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2：**

```bash
# 方法 1：发行版自带包（版本可能低于 18）
sudo apt update && sudo apt install -y nodejs

# 方法 2：NodeSource（当前 LTS）
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

**Fedora / RHEL：**

```bash
sudo dnf install -y nodejs
```

**Arch / Manjaro：**

```bash
sudo pacman -S --needed nodejs
```

**Windows（原生 PowerShell / cmd）：**

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# 或 scoop
scoop install nodejs-lts

# 或者直接去 https://nodejs.org 下安装包
```

### 平台支持

| 平台 | 状态 |
| --- | --- |
| Linux（Node 18 / 20 / 22） | ✅ CI 已测试 |
| macOS（Node 18 / 20 / 22） | ✅ CI 已测试 |
| Windows（Node 18 / 20 / 22） | ✅ CI 已测试 |

---

## 仓库结构

本仓库同时是 marketplace 也是插件本身——`marketplace.json` 的 source 指向 `./`。

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # marketplace 清单
│   └── plugin.json          # 插件清单
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # 注册 Stop hook（调用 node）
│   └── stop-hook.js         # 核心循环逻辑
├── scripts/
│   ├── setup-watchdog.js    # 创建状态文件
│   └── stop-watchdog.js     # 删除状态文件
├── lib/                     # 共享模块（所有入口点复用）
│   ├── constants.js         # 状态文件路径模式、marker token、prompt 模板
│   ├── log.js               # stderr 诊断
│   ├── stdin.js             # 跨平台同步 stdin 读取
│   ├── state.js             # 原子化状态文件生命周期
│   ├── transcript.js        # JSONL 解析器 + 当前 turn 的工具调用提取
│   ├── judge.js             # Claude Code 分类器子进程 + 判定解析
│   └── claude-pid.js        # 进程祖先链爬取
├── test/                    # node:test 单元 + 集成测试
│   ├── fixtures/            # transcript JSONL fixture
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── claude-pid.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   ├── stop-hook.test.js
│   └── stop-hook-haiku.test.js
├── .github/                 # CI workflow（node --test 矩阵、jsonlint、markdownlint）+ issue/PR 模板
├── .gitattributes           # 强制 LF 行尾
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # ralph-loop 归属声明
├── README.md                # 英文版
└── README.{zh,ja,ko,es,vi,pt}.md  # 翻译版本
```

## 灵感来源

Watchdog 是 Anthropic 官方 [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) 插件的派生作品（Apache License 2.0, © Anthropic, PBC）。原版 `ralph-loop` 使用 `<promise>COMPLETE</promise>` 这种 XML tag 协议让 agent 显式声明完成。

Watchdog 保留了核心机制——一个 Stop hook 重发 prompt——在此之上做了以下改动：

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **退出触发** | 一个短命的 Claude Code 子进程（`claude -p --model haiku`）说了算。它能看到每个工具调用的完整参数，语义级判断这一轮有没有直接改过任何项目文件。 | agent 必须在最终文本里吐一个 `<promise>…</promise>` XML tag。tag 里的短语通过 `--completion-promise "…"` 由用户设定（比如 `COMPLETE`、`DONE`），Stop hook 用 grep 做精确匹配。 |
| **退出前置** | 必须调了工具 **且** 分类器子进程返回 `NO_FILE_CHANGES` | 只要 `<promise>` 文本匹配。**agent 能靠提前吐 tag 来作弊**，ralph-loop 只能靠 prompt 里"不要撒谎"的劝告来约束。 |
| **Agent 可见性** | 完全隐藏（无 systemMessage、无 banner、stderr-only 诊断） | agent 被告知 loop 的存在和 promise 协议 |
| **状态文件作用域** | 每个 Claude Code 会话一份 state 文件 —— 同一个项目里想跑多少个并发 watchdog 都行 | 整个项目就一份 state 文件 —— 一个项目同一时间只能跑一个 ralph-loop |
| **状态文件格式** | JSON（用原生 `JSON.parse` 解析） | Markdown + YAML frontmatter（用 sed/awk/grep 解析） |
| **运行时** | Node.js 18+ —— 跨平台（Linux、macOS、原生 Windows） | Bash + jq + POSIX coreutils —— 只能 Unix |
| **prompt 输入方式** | 内联 `$ARGUMENTS`，**或** `--prompt-file <path>` —— 用 Node 的 `fs.readFileSync` 直接读文件，**完全绕开 shell 参数解析**。多段 Markdown 里的换行、引号、反引号、`$` 都能安全传入。UTF-8 BOM 自动剥除，CRLF 按字节原样保留。 | 只能通过 slash command `!` shell block 里的 `$ARGUMENTS` 内联传入。prompt 里出现任何未转义的 `"`、`` ` ``、`$` 或换行,`bash` 解析都会直接 `unexpected EOF` 挂掉。没有文件或 stdin 通道 —— 多段 Markdown 任务描述必须先手动压成一行 shell-safe 的字符串才能用。 |
| **收敛灵活性** | `--exit-confirmations N` 要求**连续 N 轮**干净的 `NO_FILE_CHANGES` 才能退出（默认 1）。`--no-classifier` 完全跳过 Haiku，让循环退化成只能靠 `--max-iterations` 或 `/watchdog:stop` 退出的 ralph-loop 风格。 | 只有一个 `<promise>…</promise>` 标签发射 + grep 的机制，没有任何严格度旋钮 —— agent 要么吐出配置好的 promise 短语，要么不吐。 |
| **prompt 演化** | `--watch-prompt-file` 在每一轮开始时热重读 `--prompt-file`。你可以在循环中途改任务说明，下一轮立刻生效（并且重置收敛 streak，因为任务变了）。文件被删 / 变空 / 读不出来时静默保留上一份缓存 —— 热更新永远不会让循环崩。 | prompt 在 `/ralph-loop "..."` 时刻就被冻结，**改不了**，除非取消重启整个循环。 |

完整归属和修改清单见 [`NOTICE`](./NOTICE)。

---

## 许可证

Apache License 2.0。详见 [`LICENSE`](./LICENSE) 和 [`NOTICE`](./NOTICE)。

Watchdog 是 `ralph-loop`（© Anthropic, PBC, Apache 2.0）的派生作品。**本项目与 Anthropic 没有从属或背书关系**。

---

<div align="center">

**灵感来源：** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**盯死 agent，别信它嘴硬，不真干完别想溜。**

</div>
