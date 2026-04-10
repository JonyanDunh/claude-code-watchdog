[English](./README.md) | 中文

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./.claude-plugin/plugin.json)
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
- **让 LLM 判"这轮改没改项目文件"** —— 一次 headless `claude -p --model haiku` 调用说了算。它能看到每个工具调用的完整参数，语义级判断。
- **每个会话各管各的** —— 状态文件按 `TERM_SESSION_ID` 分开存，不同终端 tab 里同时跑多个 watchdog 互不打架。
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

这里的"循环"不是外部的——没有 `while true`、没有 orchestrator 进程。`hooks/stop-hook.sh` 里的 Stop hook 会阻止 Claude Code 的会话退出，并通过 Claude Code 原生的 `{"decision": "block", "reason": ...}` 协议把原始 prompt 作为新的 user turn 再注入回去。

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
| **Haiku 分类器判定** | 一次 headless `claude -p --model haiku` 调用返回 `NO_FILE_CHANGES`。分类器能看到每个工具调用的完整 input，语义级判定当前 turn 有没有直接修改任何项目文件。 |

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

---

## 状态文件

Per-session 状态文件位于 `.claude/watchdog.<TERM_SESSION_ID>.local.json`：

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "term_session_id": "c387e44a-afcd-4c0d-95da-5dc7cd2d8b22",
  "started_at": "2026-04-10T12:00:00Z",
  "prompt": "修复不稳定的认证测试..."
}
```

每个会话有自己独立的文件，用 `TERM_SESSION_ID` 做 key。在不同的终端 tab 里并发跑多个 watchdog 互不冲突。

**查看正在运行的 watchdog：**

```bash
# 列出本项目所有活跃的 per-session 状态文件
ls .claude/watchdog.*.local.json

# 某个具体会话的当前迭代数
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# 完整状态
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**手动杀掉本项目所有 watchdog：**

```bash
rm -f .claude/watchdog.*.local.json
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

Haiku 分类器不是 100% 可靠。一个卡住的 agent 可能反复做无意义修改；一个被绕晕的 agent 可能过早停止编辑。这些情况都应该落到一个硬性上限上。`--max-iterations 20` 是一个合理的默认值。

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

| 要求 | 原因 |
| --- | --- |
| **Claude Code 2.1+** | 使用 Stop hook 体系和 marketplace 插件格式 |
| **`TERM_SESSION_ID`** 环境变量 | 作为 per-session 状态文件的 key。iTerm2、WezTerm、Windows Terminal、大多数现代 Linux 终端都会设置。如果没设：`export TERM_SESSION_ID=$(uuidgen)` 之后再启动 `claude`。 |
| **`jq`** 在 `PATH` 里 | Stop hook 用它解析 transcript JSONL 和状态文件 JSON |
| **`claude` CLI** 在 `PATH` 里 | 用于 headless Haiku 分类调用。必须已经完成认证（OAuth 或 `ANTHROPIC_API_KEY`） |

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
│   ├── hooks.json           # 注册 Stop hook
│   └── stop-hook.sh         # 核心循环逻辑
├── scripts/
│   ├── setup-watchdog.sh    # 创建状态文件
│   └── stop-watchdog.sh     # 删除状态文件
├── .gitattributes           # 强制 LF 行尾（shell 脚本关键）
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # ralph-loop 归属声明
├── README.md                # 英文版
└── README.zh.md             # 本文件
```

---

## 灵感来源

Watchdog 是 Anthropic 官方 [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) 插件的派生作品（Apache License 2.0, © Anthropic, PBC）。原版 `ralph-loop` 使用 `<promise>COMPLETE</promise>` 这种 XML tag 协议让 agent 显式声明完成。

Watchdog 保留了核心机制——一个 Stop hook 重发 prompt——在此之上做了以下改动：

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **退出触发** | headless Haiku 分类器说了算。它能看到每个工具调用的完整参数，语义级判断这一轮有没有直接改过任何项目文件。 | agent 必须在最终文本里吐一个 `<promise>…</promise>` XML tag。tag 里的短语通过 `--completion-promise "…"` 由用户设定（比如 `COMPLETE`、`DONE`），Stop hook 用 grep 做精确匹配。 |
| **退出前置** | 必须调了工具 **且** Haiku 返回 `NO_FILE_CHANGES` | 只要 `<promise>` 文本匹配。**agent 能靠提前吐 tag 来作弊**，ralph-loop 只能靠 prompt 里"不要撒谎"的劝告来约束。 |
| **Agent 可见性** | 完全隐藏（无 systemMessage、无 banner、stderr-only 诊断） | agent 被告知 loop 的存在和 promise 协议 |
| **状态文件作用域** | per-session，按 `TERM_SESSION_ID` 分文件 | 项目级单一状态文件 |
| **状态文件格式** | JSON（用 jq 解析） | Markdown + YAML frontmatter（用 sed/awk/grep 解析） |

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
