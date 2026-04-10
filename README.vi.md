[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | Tiếng Việt | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **Canh chừng agent. Bắt tận tay khi nó xạo. Xong việc thật sự mới cho nghỉ.**

_Một plugin `Claude Code` nhốt agent vào một vòng lặp tự phản hồi ngay trong cùng một session, và nhất quyết không cho nó thoát ra cho tới khi task thật sự ngừng sinh ra chỉnh sửa file — không có "cờ hoàn thành" nào, cũng chẳng có khe nào để agent lách._

[Bắt đầu nhanh](#bắt-đầu-nhanh) • [Tại sao dùng Watchdog?](#tại-sao-dùng-watchdog) • [Cách hoạt động](#cách-hoạt-động) • [Lệnh](#lệnh) • [Cài đặt](#cài-đặt) • [Nguồn cảm hứng](#nguồn-cảm-hứng)

---

## Người duy trì chính

| Vai trò | Tên | GitHub |
| --- | --- | --- |
| Tác giả & Người duy trì | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## Bắt đầu nhanh

**Bước 1: Cài đặt**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**Bước 2: Kiểm tra**

```bash
/watchdog:help
```

**Bước 3: Khởi động một watchdog**

```bash
/watchdog:start "Fix the flaky auth tests in tests/auth/*.ts. Keep iterating until the whole suite passes." --max-iterations 20
```

Xong. Watchdog sẽ nạp lại prompt của bạn sau mỗi lượt, cho tới khi Claude một trong ba:

- kết thúc một lượt mà không đụng vào file nào, **hoặc**
- chạm trần an toàn `--max-iterations`, **hoặc**
- bạn tự tay chạy `/watchdog:stop`.

Còn lại thì tự động hết. Agent từ đầu tới cuối không hề biết là mình đang nằm trong vòng lặp.

---

## Tại sao dùng Watchdog?

- **Agent không có cửa gian lận** — Không ai nói cho nó biết là đang ở trong loop. Không có `systemMessage`, không có bộ đếm iteration, không có banner khởi động. Nó không thể cắt ngắn bằng cách phun ra một tín hiệu hoàn thành giả.
- **Bắt buộc phải gọi tool để xác minh** — Một lượt chỉ toàn văn ("Em kiểm tra rồi, ổn hết") không bao giờ làm loop thoát. Agent **bắt buộc** phải thật sự gọi một tool thì mới được xét tới chuyện thoát ra.
- **Phát hiện sửa file do LLM phán xử, hiểu đúng ngữ cảnh project** — Một cú gọi headless `claude -p --model haiku` là **trọng tài duy nhất** cho câu hỏi "lượt này có đụng vào file dự án nào không". Nó đọc toàn bộ input của mọi lần gọi tool và đưa ra phán quyết ở cấp độ ngữ nghĩa.
- **Mỗi session cách ly riêng** — File trạng thái đánh khoá theo `TERM_SESSION_ID`, nên chạy cùng lúc nhiều watchdog trên các tab terminal khác nhau cũng không bao giờ giẫm chân nhau.
- **Ẩn theo thiết kế** — Mọi output chẩn đoán đều đi qua stderr. Transcript JSONL không bao giờ để lọt metadata của loop vào context của agent.
- **Apache 2.0** — Phái sinh sạch sẽ từ plugin `ralph-loop` chính chủ của Anthropic, ghi nhận đầy đủ trong [NOTICE](./NOTICE).

---

## Cách hoạt động

Bạn chỉ chạy lệnh **một lần**, phần còn lại Claude Code lo:

```bash
# Bạn chỉ chạy MỘT lần:
/watchdog:start "Mô tả task của bạn" --max-iterations 20

# Rồi Claude Code sẽ tự động:
# 1. Làm task
# 2. Thử thoát
# 3. Stop hook chặn cú thoát đó và nạp lại CÙNG prompt
# 4. Claude tiếp tục lặp trên cùng task, nhìn thấy các chỉnh sửa của chính nó từ lượt trước
# 5. Lặp lại cho tới khi có một lượt kết thúc mà không sửa file dự án nào
#    (hoặc khi chạm --max-iterations)
```

Vòng lặp diễn ra **ngay trong session hiện tại** — không có `while true` bên ngoài, không có tiến trình orchestrator nào cả. Stop hook trong `hooks/stop-hook.sh` chặn cú thoát session bình thường và nhét lại prompt dưới dạng một user turn mới bằng giao thức gốc của Claude Code: `{"decision": "block", "reason": ...}`.

Cái này tạo ra một **vòng lặp phản hồi tự tham chiếu**, trong đó:
- Prompt không bao giờ đổi giữa các iteration
- Thành quả của Claude ở lượt trước nằm lại trong file
- Mỗi iteration đều nhìn thấy các file đã sửa và lịch sử git
- Claude tự cải thiện bằng cách đọc lại chính code mình đã viết

### Điều kiện thoát

Loop thoát khi **cả hai** điều kiện dưới đây cùng đúng cho lượt assistant mới nhất:

| Kiểm tra | Yêu cầu |
| --- | --- |
| **Tiền đề về việc dùng tool** | Lượt đó phải có gọi ít nhất một tool. Lượt thuần văn bản không bao giờ được phép thoát. |
| **Phán quyết của classifier Haiku** | Một cú gọi headless `claude -p --model haiku` trả về `NO_FILE_CHANGES`. Classifier đọc toàn bộ input của mọi lần gọi tool và xét theo ngữ nghĩa xem lượt này có trực tiếp sửa file dự án nào không. |

Chỉ cần một trong hai sai là loop tiếp tục. Các đường thoát khác:

- Đạt `--max-iterations` (trần cứng, luôn được tôn trọng)
- Người dùng chạy `/watchdog:stop` (xoá file trạng thái)
- File trạng thái bị xoá thủ công khỏi ổ đĩa

---

## Lệnh

| Lệnh | Tác dụng | Ví dụ |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | Khởi động một watchdog trong session hiện tại | `/watchdog:start "Refactor services/cache.ts. Iterate until pnpm test:cache passes." --max-iterations 20` |
| `/watchdog:stop` | Huỷ watchdog trong session hiện tại | `/watchdog:stop` |
| `/watchdog:help` | In bản tham chiếu đầy đủ ngay trong Claude Code | `/watchdog:help` |

---

## File trạng thái

Trạng thái theo từng session nằm tại `.claude/watchdog.<TERM_SESSION_ID>.local.json`:

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

Mỗi session có file riêng, đánh khoá bằng `TERM_SESSION_ID`. Chạy nhiều watchdog song song ở các tab terminal khác nhau vẫn hoạt động bình thường mà không đụng nhau.

**Theo dõi các watchdog đang chạy:**

```bash
# Liệt kê mọi file trạng thái per-session đang hoạt động trong project này
ls .claude/watchdog.*.local.json

# Số iteration hiện tại của một session cụ thể
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# Trạng thái đầy đủ
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**Tắt thủ công toàn bộ trong project này:**

```bash
rm -f .claude/watchdog.*.local.json
```

---

## Cài đặt

### Cách chính: cài qua marketplace (khuyến nghị)

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

Kiểm tra bằng `/watchdog:help`.

### Cách thay thế: nạp tạm cho một session

Muốn thử Watchdog mà không đụng tới cấu hình toàn cục? Nạp nó chỉ cho một session duy nhất:

```bash
claude --plugin-dir /absolute/path/to/claude-code-watchdog
```

### Cách thay thế: cài thủ công qua `settings.json`

Dành cho CI/CD, triển khai nội bộ công ty, hoặc dùng offline — clone repo về rồi khai báo thủ công trong `~/.claude/settings.json`:

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

Sau đó chạy `/reload-plugins` trong Claude Code.

---

## Giấu vòng lặp khỏi agent

Theo thiết kế, **agent tuyệt đối không được biết mình đang ở trong loop**. Nếu nó biết, nó sẽ bị cám dỗ cắt ngắn ngay từ lượt đầu bằng cách dựa vào trí nhớ mà tuyên bố "xong rồi". Watchdog ép nó nghiêm theo luật bằng các biện pháp sau:

- **Stop hook không phát ra `systemMessage`** — không có bộ đếm iteration, không có banner trạng thái.
- **Script setup chỉ ghi prompt của người dùng ra stdout** — không có header kiểu "Loop activated, iteration 1", không có output khởi tạo nào để agent thấy.
- **Prompt được nạp lại chính là nội dung gốc + đúng một dòng nhắc xác minh**, viết bằng tiếng Anh thẳng thắn:

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **Mọi thông tin chẩn đoán đều ra stderr (`>&2`)** — Transcript của Claude Code không hút chúng vào làm context của agent.

Dưới góc nhìn của agent, chỉ có đúng một người dùng hỏi đi hỏi lại cùng một câu hỏi, thỉnh thoảng nhét thêm "làm ơn chạy lại check thật sự đi". Nó không thấy Stop hook, không thấy bộ đếm iteration, không thấy metadata loop nào cả. Không biết có vòng lặp tồn tại thì lấy gì mà gian lận.

---

## Thực hành tốt khi viết prompt

### 1. Tiêu chí hoàn thành rõ ràng

Viết prompt sao cho câu "không cần sửa thêm file nào nữa" là một câu trả lời thật sự có thật và có thể kiểm chứng.

❌ Dở: "Dựng một todo API, làm cho tốt vào."

✅ Tốt:

```markdown
Build a REST API for todos in `src/api/todos.ts`.

Requirements:
- All CRUD endpoints working
- Input validation in place
- 80%+ test coverage in `tests/todos.test.ts`
- All tests pass with `pnpm test`
```

### 2. Mục tiêu tăng dần, kiểm chứng được

Loop thoát dựa trên "không có file nào bị sửa". Nếu task của bạn không có trạng thái kết thúc kiểm chứng được, nó sẽ chạy không tải mãi thôi.

✅ Tốt:

```markdown
Refactor `services/cache.ts` to remove the legacy LRU implementation.

Steps:
1. Delete the old LRU class and its tests
2. Update all callers in `src/` to use the new cache API
3. Run `pnpm typecheck && pnpm test:cache` after each change
4. Iterate until both pass without warnings
```

### 3. Cấu trúc tự sửa sai

Dặn agent cách phát hiện thất bại và cách thích nghi.

```markdown
Implement feature X using TDD:
1. Write failing tests in tests/feature-x.test.ts
2. Write minimum code to pass
3. Run `pnpm test:feature-x`
4. If any test fails, read the failure, fix, re-run
5. Refactor only after all tests are green
```

### 4. Luôn đặt `--max-iterations`

Classifier Haiku không phải là thánh. Một agent bị kẹt mà cứ loay hoay sửa linh tinh vô nghĩa, hoặc một agent bị rối rồi ngừng sửa quá sớm, đều cần rơi vào một cú dừng cứng. `--max-iterations 20` là một mặc định hợp lý.

---

## Khi nào nên dùng Watchdog

**Hợp với:**

- Task có tiêu chí thành công rõ ràng, có thể tự động hoá (tests, lints, typechecks)
- Tinh chỉnh lặp đi lặp lại: sửa → test → sửa → test
- Dự án làm từ đầu mà bạn có thể bỏ đi để nó tự chạy
- Rà soát code có hệ thống kèm theo sửa

**Không hợp với:**

- Task cần con người phán đoán hoặc ra quyết định thiết kế
- Thao tác một phát ăn ngay (một lệnh duy nhất, sửa một file duy nhất)
- Bất cứ việc gì mà "xong" là khái niệm chủ quan
- Debug production cần ngữ cảnh từ bên ngoài

---

## Yêu cầu hệ thống

| Yêu cầu | Lý do |
| --- | --- |
| **Claude Code 2.1+** | Dùng hệ thống Stop hook và định dạng plugin marketplace |
| **`bash`** trong `PATH` | Toàn bộ logic của hook và setup đều viết bằng POSIX bash. Windows native (PowerShell / cmd) **không hỗ trợ** — xài WSL2 hoặc Git Bash |
| **`jq`** trong `PATH` | Stop hook dùng để parse transcript JSONL và file trạng thái JSON |
| **`claude` CLI** trong `PATH` | Dùng cho cú gọi phân loại Haiku headless. Phải đã xác thực (OAuth hoặc `ANTHROPIC_API_KEY`) |
| Biến môi trường **`TERM_SESSION_ID`** | Làm khoá cho file trạng thái theo session. Đa số terminal emulator (iTerm2, WezTerm, các terminal Linux hiện đại) đều tự set. Cách khắc phục nếu chưa có: `export TERM_SESSION_ID=$(uuidgen)` trước khi chạy `claude`. |

### Cài dependencies

**macOS (Homebrew):**

```bash
brew install jq
# bash đã có sẵn; muốn xài bash 5.x mới hơn: brew install bash
# claude CLI: coi https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
sudo apt update
sudo apt install -y bash jq uuid-runtime
# claude CLI: coi https://docs.anthropic.com/claude-code
```

**Fedora / RHEL:**

```bash
sudo dnf install -y bash jq util-linux
```

**Arch / Manjaro:**

```bash
sudo pacman -S --needed bash jq util-linux
```

**Windows:**

Windows native (PowerShell / cmd) **không hỗ trợ** — plugin toàn bộ là bash scripts và phần đăng ký Stop hook bắt buộc phải có POSIX shell trong `PATH`. Bạn có hai lựa chọn:

- **WSL2 (khuyến nghị)** — chạy Claude Code bên trong một distro WSL2. Mọi thứ chạy ngon lành luôn.
- **Git Bash (thử nghiệm)** — cài [Git for Windows](https://git-scm.com/download/win) (nó gói sẵn bash), rồi cài thêm `jq` riêng (ví dụ qua [scoop](https://scoop.sh): `scoop install jq`). Bạn cũng sẽ phải tự tay export `TERM_SESSION_ID` trước khi chạy `claude`:
  ```bash
  export TERM_SESSION_ID=$(cat /proc/sys/kernel/random/uuid)
  claude
  ```

### Hỗ trợ nền tảng

| Nền tảng | Trạng thái |
| --- | --- |
| Linux | ✅ Đã test |
| macOS | ✅ Chắc là chạy được (cùng POSIX primitives) |
| WSL2 trên Windows | ✅ Đã test |
| Git Bash trên Windows | ⚠️ Thử nghiệm, phải tự tay setup `TERM_SESSION_ID` |
| Windows native (PowerShell / cmd) | ❌ Không hỗ trợ |

---

## Cấu trúc plugin

Repo này vừa là marketplace vừa là plugin — `marketplace.json` trỏ tới `./`.

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # manifest của marketplace
│   └── plugin.json          # manifest của plugin
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # đăng ký Stop hook
│   └── stop-hook.sh         # logic lõi của vòng lặp
├── scripts/
│   ├── setup-watchdog.sh    # tạo file trạng thái
│   └── stop-watchdog.sh     # xoá file trạng thái
├── .gitattributes           # ép line ending là LF (cực kỳ quan trọng với shell script)
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # ghi nhận nguồn ralph-loop
├── README.md                # file này
└── README.zh.md             # bản dịch tiếng Trung
```

---

## Nguồn cảm hứng

Watchdog là tác phẩm phái sinh từ plugin [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) của Anthropic (Apache License 2.0, © Anthropic, PBC). Bản gốc `ralph-loop` dùng giao thức XML-tag kiểu `<promise>COMPLETE</promise>` để agent chủ động tuyên bố hoàn thành.

Watchdog giữ nguyên cơ chế cốt lõi — một Stop hook nạp lại prompt — và thay đổi những thứ sau ở trên đó:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Điều kiện kích hoạt thoát** | Classifier Haiku headless là **trọng tài duy nhất**. Nó đọc toàn bộ input của mọi lần gọi tool và xét theo ngữ nghĩa xem có file dự án nào bị sửa trực tiếp hay không. | Agent phải phát ra một XML tag `<promise>…</promise>` trong phần text cuối. Chuỗi bên trong tag có thể cấu hình qua `--completion-promise "…"` (ví dụ `COMPLETE`, `DONE`). Stop hook dùng grep khớp chính xác chuỗi đó. |
| **Tiền đề thoát** | Phải có gọi tool **VÀ** Haiku nói `NO_FILE_CHANGES` | Chỉ cần khớp chuỗi `<promise>`. Agent có thể gian lận bằng cách phun tag ra sớm; lá chắn duy nhất của ralph-loop là một prompt nài nỉ agent đừng nói dối. |
| **Mức độ agent thấy được** | Ẩn hoàn toàn (không systemMessage, không banner, chẩn đoán chỉ đi qua stderr) | Agent được cho biết về loop và giao thức promise |
| **Phạm vi trạng thái** | File theo từng session, đánh khoá bằng `TERM_SESSION_ID` | Một file trạng thái duy nhất ở mức project |
| **Định dạng file trạng thái** | JSON (parse bằng jq) | Markdown với YAML frontmatter (parse bằng sed/awk/grep) |

Xem [`NOTICE`](./NOTICE) để biết ghi nhận đầy đủ và danh sách thay đổi chi tiết.

---

## Giấy phép

Apache License 2.0. Xem [`LICENSE`](./LICENSE) và [`NOTICE`](./NOTICE).

Watchdog là tác phẩm phái sinh của `ralph-loop` (© Anthropic, PBC, Apache 2.0). Dự án này **không có liên kết hay được Anthropic bảo trợ dưới bất kỳ hình thức nào**.

---

<div align="center">

**Nguồn cảm hứng:** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**Canh chừng agent. Bắt tận tay khi nó xạo. Xong việc thật sự mới cho nghỉ.**

</div>
