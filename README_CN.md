[English](./README.md) | 中文

# Watchdog 插件

一个 Claude Code 插件：在同一个会话里把当前 agent 困在自指循环中，持续把用户原始 prompt 重新喂给它，直到任务真正收敛（不再修改任何文件）或者达到安全上限。

## Watchdog 是什么？

Watchdog 把 "Ralph" 技术适配到了 Claude Code 插件系统。你只给 Claude 发一次 prompt，之后一个 Stop hook 会拦截每一次自然的 turn 结束，把同一个 prompt 重新喂回去，逼 Claude 在同一个任务上反复迭代，直到它真的不再动任何文件为止。

这里的"循环"不是外部的——没有 bash `while true`、没有外部 orchestrator。插件注册了一个 Stop hook，这个 hook 会阻止会话退出，并把原始 prompt 作为新的用户 turn 再注入回去。

### 核心概念

```text
1. /start "<任务>"                  — 用户只运行一次
2. Claude 开始做这个任务            — 读文件、编辑、写入、跑测试
3. Claude 的这一 turn 结束          — 助手停下
4. Stop hook 触发                   — 检查这一轮里有没有修改任何文件
5a. 有改动                          → 重发 prompt + 验证提醒 → 回到步骤 2
5b. 这一轮什么文件都没改            → 删除状态文件 → 会话正常退出
```

## 快速开始

```bash
/start "修复 tests/auth/*.ts 里那些不稳定的认证测试。一直迭代直到整个测试套件都通过。" --max-iterations 20
```

Claude 会：
- 读 test 文件、诊断失败原因
- 编辑失败的代码
- 再跑一次测试
- 反复迭代修复
- 一旦某一轮完成时没有改动任何文件就自动停止

## 命令

### `/start <PROMPT> [--max-iterations N]`

在当前 Claude Code 会话里启动一个 watchdog。会在 `.claude/watchdog.<TERM_SESSION_ID>.local.json` 写入一份 per-session 状态文件，并把 prompt 作为第一轮的输入 echo 出来。

**选项：**
- `--max-iterations <n>` — 迭代次数硬上限。默认：无限。**强烈建议设置**。

**先决条件：**
- 环境里必须有 `TERM_SESSION_ID`（iTerm2、WezTerm、Windows Terminal、大多数现代 Linux 终端都会设置）。没有的话 setup 脚本会拒绝运行——插件用这个 UUID 作为 per-session 状态文件的 key。

### `/stop`

删除当前会话的状态文件，让下一次 Stop hook 触发时允许会话正常退出。幂等——对一个没有活跃 loop 的会话运行它只会打印一条信息。

### `/help`

打印完整的命令参考和概念总结。

## Stop hook 怎么决定是否退出

Stop hook 让 loop 退出的条件必须**同时满足**以下两点：

1. **当前 turn 确实调用了工具**。纯文本的 turn（agent 说"我已经检查完了，没问题"但一次 tool 都没调）**永远不会**退出 loop——它会重新喂 prompt 并附上一条验证提醒，逼 agent 下一轮真的去调工具。
2. **一个 headless Haiku 分类器判定这一轮没有修改任何文件**。Hook 会把这一轮的 `tool_use` 调用提取成紧凑 JSON（工具名 + 如果是 Bash 就附上命令字符串），交给 `claude -p --model haiku`，让它返回 `FILE_CHANGES` 或者 `NO_FILE_CHANGES`。只有 `NO_FILE_CHANGES` 才会触发退出。

为什么用 LLM 分类器，而不是硬编码一个工具名黑白名单：
- `sed -i`、`awk -i inplace`、`> file`、`mv`、`rm`、`git add` 这类 Bash 命令都会改文件，但硬编码的 `Edit|Write|NotebookEdit` 过滤器完全看不到它们。
- 分类器直接读命令原文，做语义级判断。
- Per-session 正确：只看当前会话的 transcript，同一项目里并发跑多个 watchdog 互不污染。

### 什么情况下 loop 继续

- 当前 turn 里有任何 `Edit`、`Write`、`NotebookEdit`、或者会改文件的 `Bash` 命令
- 纯文本 turn（零 tool 调用）——强制再转一轮，逼 agent 真的去验证
- Haiku 返回了模糊答复或者调用失败（安全兜底：宁可多转不丢工作）
- `--max-iterations` 还没到

### 什么情况下 loop 退出

- 当前 turn **至少调了一次工具**，且 Haiku 返回 `NO_FILE_CHANGES`
- 到达 `--max-iterations`
- 手动运行 `/stop`
- 状态文件被磁盘上其他来源删掉了

## 状态文件

位置：`.claude/watchdog.<TERM_SESSION_ID>.local.json`

示例：
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

每个会话有自己独立的文件，用 `TERM_SESSION_ID` 做 key，所以在不同的终端 tab 里并发跑多个 watchdog 不会冲突。

**查看正在运行的 loop：**
```bash
# 列出所有活跃的 per-session 状态文件
ls .claude/watchdog.*.local.json

# 查看某个具体会话当前的迭代数
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# 查看完整状态
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**手动杀掉本项目里所有 loop：**
```bash
rm -f .claude/watchdog.*.local.json
```

## 对 agent 隐藏循环的存在

按设计，**agent 不能知道自己在一个循环里**。如果它知道，就会想办法偷懒——第一轮就声称完成、用记忆伪造完成信号，而不是真的去验证。

为了强制这一点，插件做了这些：
- Stop hook **不输出** `systemMessage` 字段（不显示迭代计数、不显示状态 banner）。
- setup 脚本 stdout **只输出用户的 prompt**——没有 "Loop activated, iteration 1" 之类的头部。
- 重新喂回去的 prompt 就是原 prompt + 一条英文验证提醒：
  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.
- 所有 hook 诊断信息都走 stderr（`>&2`），不走 stdout，这样 Claude Code 的 transcript 不会把它当 agent context 吸进去。

从 agent 视角看，就像同一个用户在反复问同一个问题，偶尔加一句"请你真的去重新检查一遍"。它没有任何理由怀疑背后有一个 Stop hook 在驱动这种重复。

## 写 prompt 的最佳实践

### 1. 明确的完成标准

Prompt 要能被"不需要再改任何文件"这个状态真实地回答。

❌ 不好："建一个 todo API，做得好点。"

✅ 好："在 `src/api/todos.ts` 里实现 todo 的 REST API。要求：CRUD 端点齐全、有输入校验、`tests/todos.test.ts` 里覆盖率 80% 以上。一直迭代直到所有测试通过、覆盖率达标。"

### 2. 可验证的、可逐步推进的目标

Loop 的退出条件是"没有文件被修改"。如果你的任务没有可验证的终止状态，它就会空转。

✅ 好："重构 `services/cache.ts`，删掉老的 LRU 实现。更新 `src/` 下所有调用方。每次修改后跑 `pnpm typecheck && pnpm test:cache`。迭代到两者都无警告通过为止。"

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

Haiku 分类器不是 100% 可靠。可能遇到一个卡住的 agent 反复做无意义修改，或者一个被绕晕的 agent 过早停止编辑——这些情况都应该落到一个硬性上限上。`--max-iterations 20` 是个合理的默认值。

## 什么时候用 Watchdog

**适合：**
- 有明确、可自动化验证的成功标准（测试、lint、类型检查）
- 迭代式修复：改 → 测 → 改 → 测
- 可以离开电脑的 greenfield 实现
- 审查现有代码并修复问题

**不适合：**
- 需要人类判断或设计决策的任务
- 一次性操作（单个命令、单次文件编辑）
- "完成"主观定义的任务
- 需要外部上下文的生产环境调试

## 局限和已知问题

- **终端不 export `TERM_SESSION_ID`**：有些终端模拟器不设置这个变量。解决办法：`export TERM_SESSION_ID=$(uuidgen)` 之后再启动 `claude`。
- **同一个终端 tab 里开两个 `claude`**：它们会共享同一个 `TERM_SESSION_ID`，互相覆盖状态文件。不同 tab 就好。
- **每次迭代的 Haiku 成本**：每次 Stop hook 触发会花 ~10 秒 + 少量 token，调一次 headless `claude -p --model haiku`。这是 loop 的主要延迟来源。
- **Haiku 依赖 `claude` CLI 在 PATH 里**：Hook 依赖 `claude` CLI 已经安装且完成了认证（OAuth 或 `ANTHROPIC_API_KEY`）。如果不可用，hook 会走 fallback "继续 loop" 路径，避免丢工作。
- **Stop hook 只在 Claude 自然停下时触发**：如果某个 tool 调用搞崩了 hook，状态文件可能会残留。用 `/stop` 清理即可。

## 插件结构

```
watchdog/
├── .claude-plugin/
│   └── plugin.json          # name, version, description
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # 注册 Stop hook
│   └── stop-hook.sh         # 核心循环逻辑（保留 stop-hook 这个名字）
└── scripts/
    ├── setup-watchdog.sh    # 创建状态文件
    └── stop-watchdog.sh     # 删除状态文件
```

## 寻求帮助

在 Claude Code 里运行 `/help` 查看完整命令参考。

## 灵感来源

本插件的灵感来自 Anthropic 官方插件仓库里的 [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)。原版插件用 `<promise>` XML tag 让 agent 显式声明完成状态。

Watchdog 在此基础上做了几个实质改动：

- **用 headless Haiku 分类器替代硬编码的 tool filter**——能识别 `sed -i`、`mv`、`> file` 等 Bash 形式的文件修改
- **退出前置条件：当前 turn 必须至少调用了一个工具**——防止 agent 仅凭文字声称"已完成"来作弊
- **对 agent 隐藏 loop 的存在**——不发 `systemMessage`、setup 脚本不打 banner、诊断信息走 stderr，agent 根本不知道自己在循环里
- **per-session 状态文件**——按 `TERM_SESSION_ID` 分文件，多 terminal tab 并发跑 watchdog 互不干扰
- **re-feed 的 prompt 附加英文验证提醒**——逼 agent 真的去调工具重新检查，而不是基于历史上下文编答案

感谢 ralph-loop 的原作者提供的思路基石。
