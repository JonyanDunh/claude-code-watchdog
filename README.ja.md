[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | 日本語 | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.1.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **agent を見張れ。口だけの「完了」を見抜け。本当に終わるまで逃がすな。**

_`Watchdog` は `Claude Code` のプラグインです。同一セッション内で現在の agent を自己参照ループに閉じ込め、タスクが本当にファイル編集を生まなくなるまで終了させません。「完了フラグ」なんてものはなく、agent がズルして抜け出す隙もありません。_

[クイックスタート](#クイックスタート) • [なぜ Watchdog？](#なぜ-watchdog) • [仕組み](#仕組み) • [コマンド](#コマンド) • [インストール](#インストール) • [インスパイア元](#インスパイア元)

---

## コアメンテナー

| 役割 | 名前 | GitHub |
| --- | --- | --- |
| 作者 & メンテナー | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## クイックスタート

**ステップ 1: インストール**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**ステップ 2: 動作確認**

```bash
/watchdog:help
```

**ステップ 3: watchdog を起動する**

```bash
/watchdog:start "Fix the flaky auth tests in tests/auth/*.ts. Keep iterating until the whole suite passes." --max-iterations 20
```

これだけです。Watchdog は毎ターン終了後にあなたの prompt を再投入し、Claude が以下のいずれかに到達するまでループを続けます。

- どのファイルも変更せずにターンを終えた、**または**
- `--max-iterations` のセーフティ上限に達した、**または**
- 手動で `/watchdog:stop` を実行した。

あとは全部自動です。agent は自分がループの中にいることに最後まで気づきません。

---

## なぜ Watchdog？

- **agent にズルさせない** —— agent は自分がループの中にいることを一切知らされません。`systemMessage` もイテレーションカウンタもセットアップバナーもなし。偽の完了シグナルを吐いてショートカットする、なんて芸当はできません。
- **ツール呼び出しを強制する** —— 純粋なテキストだけのターン（「確認しました、問題ありません」）は絶対にループを終了させません。退出の検討対象になるには、そのターンで**本当に**ツールを一度は呼んでいる必要があります。
- **LLM が判定する、プロジェクト対応のファイル変更検出** —— 「このターンはプロジェクトのファイルを編集したか？」の判断は、ヘッドレスな `claude -p --model haiku` 呼び出しが**唯一**の審判者です。各ツール呼び出しの入力全文を読み、意味レベルで判定します。
- **セッションごとに分離** —— 状態ファイルは `TERM_SESSION_ID` をキーにしているので、複数のターミナルタブで同時に watchdog を走らせても衝突しません。
- **設計段階で agent に隠蔽** —— すべての診断出力は stderr に流れます。JSONL トランスクリプトに loop のメタデータが漏れて agent のコンテキストに混入することはありません。
- **Apache 2.0** —— Anthropic 公式の `ralph-loop` プラグインからクリーンに派生しており、帰属表示は [NOTICE](./NOTICE) にすべて記載しています。

---

## 仕組み

あなたがコマンドを実行するのは**一度だけ**。あとは Claude Code が勝手にやってくれます。

```bash
# You run ONCE:
/watchdog:start "Your task description" --max-iterations 20

# Then Claude Code automatically:
# 1. Works on the task
# 2. Tries to exit
# 3. Stop hook blocks the exit and re-feeds the SAME prompt
# 4. Claude iterates on the same task, seeing its own previous edits
# 5. Repeat until a turn finishes without modifying any project file
#    (or --max-iterations is reached)
```

ループは**現在のセッションの内部**で起こります。外部の `while true` もオーケストレーター的なプロセスも不要です。`hooks/stop-hook.js` の Stop hook が通常のセッション終了をブロックし、Claude Code ネイティブの `{"decision": "block", "reason": ...}` プロトコルを使って prompt を新しいユーザーターンとして再注入します。

これによって作られるのは**自己参照的なフィードバックループ**です。

- prompt はイテレーション間で一切変わらない
- Claude が前回やった作業はファイルとして残り続ける
- 各イテレーションは変更済みのファイルと git 履歴を見る
- Claude は自分の過去の仕事を読んで自律的に改善していく

### 退出条件

ループが終了するのは、最新のアシスタントターンが**次の両方**を満たすときです。

| チェック項目 | 要件 |
| --- | --- |
| **ツール使用の前提条件** | そのターンで最低 1 回はツールを呼んでいること。純テキストだけのターンは絶対に終了しません。 |
| **Haiku 分類器の判定** | ヘッドレスな `claude -p --model haiku` 呼び出しが `NO_FILE_CHANGES` を返すこと。分類器は各ツール呼び出しの入力全文を読み、そのターンがプロジェクトのファイルを直接変更したかどうかを意味レベルで判断します。 |

どちらかが満たされなければループは続きます。それ以外の退出経路は以下の通りです。

- `--max-iterations` に到達（ハード上限、常に尊重される）
- ユーザーが `/watchdog:stop` を実行（状態ファイルを削除）
- 状態ファイルをディスクから手動で削除

---

## コマンド

| コマンド | 効果 | 例 |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | 現在のセッションで watchdog を起動 | `/watchdog:start "Refactor services/cache.ts. Iterate until pnpm test:cache passes." --max-iterations 20` |
| `/watchdog:stop` | 現在のセッションの watchdog をキャンセル | `/watchdog:stop` |
| `/watchdog:help` | Claude Code 内で完全なリファレンスを表示 | `/watchdog:help` |

---

## 状態ファイル

セッション単位の状態は `.claude/watchdog.<TERM_SESSION_ID>.local.json` に保存されます。

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "term_session_id": "c387e44a-afcd-4c0d-95da-5dc7cd2d8b22",
  "started_at": "2026-04-10T12:00:00Z",
  "prompt": "Fix the flaky auth tests..."
}
```

各セッションは `TERM_SESSION_ID` をキーに自分専用のファイルを持ちます。異なるターミナルタブで複数の watchdog を並列に走らせても競合しません。

**動作中の watchdog を確認する：**

```bash
# List all active per-session state files in this project
ls .claude/watchdog.*.local.json

# Current iteration of a specific session
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# Full state
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**このプロジェクトのすべてを手動で止める：**

```bash
rm -f .claude/watchdog.*.local.json
```

---

## インストール

### 推奨: marketplace からインストール

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

`/watchdog:help` で確認してください。

### 代替: 単一セッションのローカルロード

グローバル設定をいじらずに Watchdog を試したい場合、そのセッション限定で読み込めます。

```bash
claude --plugin-dir /absolute/path/to/claude-code-watchdog
```

### 代替: `settings.json` から手動でインストール

CI/CD、社内デプロイ、オフライン利用などのために、リポジトリを clone して `~/.claude/settings.json` に手動で書き込む方法です。

```json
{
  "extraKnownMarketplaces": {
    "claude-code-watchdog": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/claude-code-watchdog"
      }
    }
  },
  "enabledPlugins": {
    "watchdog@claude-code-watchdog": true
  }
}
```

そのあと Claude Code の中で `/reload-plugins` を実行してください。

---

## ループの存在を agent から隠す

設計上の大原則として、**agent は自分がループの中にいることを知ってはいけません**。もし知ってしまったら、最初のターンで記憶を頼りに「完了しました」と宣言してショートカットする誘惑に勝てなくなります。Watchdog はこれを以下の仕組みで強制しています。

- **Stop hook は `systemMessage` を一切出さない** —— イテレーションカウンタもステータスバナーもなし。
- **セットアップスクリプトは stdout にユーザーの prompt だけを書き出す** —— 「Loop activated, iteration 1」のようなヘッダーや、agent が見てしまう初期化出力は一切なし。
- **再投入される prompt は、元のテキスト + ごく短い検証リマインダー 1 行だけ**（英語の原文）：

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **すべての診断は stderr（`>&2`）へ** —— Claude Code のトランスクリプトはこれらを agent のコンテキストとして取り込みません。

agent の視点からは、同じユーザーが同じ質問を何度も繰り返し、ときどき「本当にチェックをもう一度やってください」と付け加えているだけに見えます。Stop hook も、イテレーションカウンタも、ループのメタデータも、一切目に入りません。存在すら知らないものをどうやってごまかせるというのでしょうか。

---

## prompt を書くときのベストプラクティス

### 1. 完了条件を明確に

「もう編集するものがない」が本当に検証可能な答えになるように prompt を書いてください。

❌ 悪い例: 「いい感じの todo API を作って。」

✅ 良い例:

```markdown
Build a REST API for todos in `src/api/todos.ts`.

Requirements:
- All CRUD endpoints working
- Input validation in place
- 80%+ test coverage in `tests/todos.test.ts`
- All tests pass with `pnpm test`
```

### 2. 検証可能で段階的なゴール

ループが終わる条件は「ファイルが変更されていない」ことです。検証可能な終了状態のないタスクを渡すと、ただ空回りするだけです。

✅ 良い例:

```markdown
Refactor `services/cache.ts` to remove the legacy LRU implementation.

Steps:
1. Delete the old LRU class and its tests
2. Update all callers in `src/` to use the new cache API
3. Run `pnpm typecheck && pnpm test:cache` after each change
4. Iterate until both pass without warnings
```

### 3. 自己修正できる構造にする

失敗にどう気づき、どう調整するかまで agent に伝えましょう。

```markdown
Implement feature X using TDD:
1. Write failing tests in tests/feature-x.test.ts
2. Write minimum code to pass
3. Run `pnpm test:feature-x`
4. If any test fails, read the failure, fix, re-run
5. Refactor only after all tests are green
```

### 4. `--max-iterations` は必ず設定する

Haiku 分類器は万能ではありません。意味のない編集を繰り返して詰まった agent や、混乱して早すぎるタイミングで編集を止めてしまった agent は、最終的にハード停止に吸収されるべきです。`--max-iterations 20` は妥当なデフォルトです。

---

## Watchdog を使うべきとき

**向いているケース：**

- 成功条件が明確で自動検証できるタスク（テスト、lint、型チェック）
- 反復的な改善：修正 → テスト → 修正 → テスト
- 放っておいても進められるグリーンフィールドの実装
- 修正付きの体系的なコードレビュー

**向いていないケース：**

- 人間の判断や設計上の意思決定が必要なタスク
- ワンショットの操作（単発のコマンド、単発のファイル編集）
- 「完了」が主観的になるもの
- 外部コンテキストを要するプロダクションのデバッグ

---

## 動作要件

Watchdog 1.1.0 は **Node.js 書き直し版** だ。bash も jq も POSIX coreutils も要らない。必要なのは `node` と `claude` CLI だけ。Linux、macOS、Windows でネイティブに動作する。

| 要件 | 理由 |
| --- | --- |
| **Claude Code 2.1+** | Stop hook システムと marketplace プラグイン形式を利用するため |
| **`node`** 18+ が `PATH` にあること | hook とセットアップのロジックはすべて JavaScript で書かれている。テストスイートで使う `node:test` は Node 18 以上を要求する |
| **`claude` CLI** が `PATH` にあること | ヘッドレスな Haiku 分類呼び出しに使います。認証済み（OAuth または `ANTHROPIC_API_KEY`）である必要があります |
| **`TERM_SESSION_ID`** 環境変数 | セッション単位の状態ファイルのキーになります。iTerm2、WezTerm、最近の Linux 端末の多くは自動で設定します。設定されていない場合の回避策: `claude` を起動する前に `export TERM_SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")` を実行。 |

### 依存関係のインストール

Claude Code を `npm install -g @anthropic-ai/claude-code` でインストール済みなら、`node` はすでに `PATH` にあるので追加インストールは不要。そうでない場合は以下を参照。

**macOS (Homebrew):**

```bash
brew install node
# claude CLI: see https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
# Option 1: distro package (may be older than 18)
sudo apt update && sudo apt install -y nodejs

# Option 2: NodeSource (current LTS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

**Fedora / RHEL:**

```bash
sudo dnf install -y nodejs
```

**Arch / Manjaro:**

```bash
sudo pacman -S --needed nodejs
```

**Windows (ネイティブ PowerShell / cmd):**

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# or scoop
scoop install nodejs-lts

# or download the installer from https://nodejs.org
```

WSL2 も Git Bash も要らない —— Watchdog 1.1.0 はネイティブ Windows で直接動く。

### プラットフォームサポート

| プラットフォーム | ステータス |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ CI でテスト済み |
| macOS (Node 18 / 20 / 22) | ✅ CI でテスト済み |
| Windows (Node 18 / 20 / 22) | ✅ CI でテスト済み（ネイティブ PowerShell / cmd、WSL2 不要） |
| WSL2 on Windows | ✅ 動作（中身は Linux だから） |

---

## プラグイン構成

このリポジトリは marketplace 兼プラグインそのものです —— `marketplace.json` は `./` を指しています。

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # marketplace manifest
│   └── plugin.json          # plugin manifest
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # registers the Stop hook (invokes node)
│   └── stop-hook.js         # the core loop logic
├── scripts/
│   ├── setup-watchdog.js    # creates the state file
│   └── stop-watchdog.js     # removes the state file
├── lib/                     # shared modules (reused by all entry points)
│   ├── constants.js         # state path pattern, marker tokens, prompt templates
│   ├── log.js               # stderr diagnostics
│   ├── stdin.js             # cross-platform sync stdin reader
│   ├── state.js             # atomic state file lifecycle
│   ├── transcript.js        # JSONL parser + current-turn tool extraction
│   └── judge.js             # headless Haiku subprocess + verdict parser
├── test/                    # node:test unit + integration tests
│   ├── fixtures/            # transcript JSONL fixtures
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   └── stop-hook.test.js
├── .github/                 # CI workflow (node --test マトリクス, jsonlint, markdownlint) + issue/PR テンプレート
├── .gitattributes           # forces LF line endings
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # attribution to ralph-loop
├── README.md                # this file
└── README.{zh,ja,ko,es,vi,pt}.md  # translations
```

## テスト

Watchdog 1.1.0 には Node 標準の `node:test` ランナーを使った自動テストが 59 個同梱されています —— 外部依存はゼロ。リポジトリのルートから次のコマンドで実行できます。

**Node 22+:**

```bash
node --test 'test/*.test.js'
```

**Node 18 / 20**（glob サポートは Node 21 からなので、シェルに展開させるかファイルを明示列挙する）:

```bash
node --test test/*.test.js
```

単一ファイルだけを対象にする場合：

```bash
node --test test/transcript.test.js
```

CI は push と pull request ごとに、`ubuntu-latest`、`macos-latest`、`windows-latest` 上で Node 18 / 20 / 22 の全組み合わせでフルスイートを走らせている。

---

## インスパイア元

Watchdog は Anthropic の [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) プラグイン（Apache License 2.0, © Anthropic, PBC）の派生作品です。オリジナルの `ralph-loop` は `<promise>COMPLETE</promise>` という XML タグのプロトコルを使い、agent 自身に完了を宣言させる方式でした。

Watchdog はコアの仕組み（prompt を再投入する Stop hook）は引き継ぎつつ、以下の点を変更しています。

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **退出トリガー** | ヘッドレスな Haiku 分類器が**唯一**の審判者。各ツール呼び出しの入力全文を読み、いずれかのプロジェクトファイルが直接変更されたかどうかを意味レベルで判断する。 | agent が最終テキストに `<promise>…</promise>` XML タグを出さないといけない。タグ内の文言は `--completion-promise "…"` で設定可能（例: `COMPLETE`、`DONE`）。Stop hook は grep で完全一致を取る。 |
| **退出の前提条件** | ツールが呼ばれていること **かつ** Haiku が `NO_FILE_CHANGES` と返すこと | `<promise>` 文字列の一致だけ。agent はタグを先出しすればズルできてしまい、ralph-loop の唯一の防衛手段は「嘘をつかないで」と prompt でお願いすることだけ。 |
| **agent からの可視性** | 完全に隠蔽（systemMessage なし、バナーなし、診断は stderr のみ） | ループと promise プロトコルの存在を agent に告知する |
| **状態のスコープ** | `TERM_SESSION_ID` をキーにしたセッション単位ファイル | プロジェクト単位の単一状態ファイル |
| **状態ファイルの形式** | JSON（ネイティブの `JSON.parse` でパース） | YAML frontmatter 付き Markdown（sed/awk/grep でパース） |
| **ランタイム** | Node.js 18+ —— クロスプラットフォーム（Linux、macOS、ネイティブ Windows） | Bash + jq + POSIX coreutils —— Unix 専用 |

完全な帰属表示と変更一覧は [`NOTICE`](./NOTICE) を参照してください。

---

## ライセンス

Apache License 2.0。詳細は [`LICENSE`](./LICENSE) と [`NOTICE`](./NOTICE) を参照してください。

Watchdog は `ralph-loop`（© Anthropic, PBC, Apache 2.0）の派生作品です。**本プロジェクトは Anthropic と提携関係にも、Anthropic による承認関係にもありません**。

---

<div align="center">

**Inspired by:** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**agent を見張れ。口だけの「完了」を見抜け。本当に終わるまで逃がすな。**

</div>
