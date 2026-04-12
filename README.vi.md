[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | Tiếng Việt | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](./.claude-plugin/plugin.json)
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
- **Phát hiện sửa file do LLM phán xử, hiểu đúng ngữ cảnh project** — Mỗi lần hook chạy, watchdog đẻ ra một **subprocess Claude Code** ngắn hạn (`claude -p --model haiku`) và hỏi đúng một câu: "lượt này có đụng vào file dự án nào không?". Subprocess đó thấy toàn bộ input của mọi lần gọi tool và phán xử theo ngữ nghĩa. Haiku chỉ là model — điểm mấu chốt là nó chạy trong một **tiến trình Claude Code độc lập, stateless**, chứ không phải một API client tự chế, nên toàn bộ xác thực `claude` bạn đã có sẵn được xài lại nguyên xi.
- **Cách ly theo từng session** — File trạng thái đánh khoá theo process ID của Claude Code cha, tìm ra bằng cách đi ngược cây tổ tiên của tiến trình. 100 session chạy song song trong cùng một thư mục project cũng không bao giờ giẫm chân nhau.
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

Vòng lặp diễn ra **ngay trong session hiện tại** — không có `while true` bên ngoài, không có tiến trình orchestrator nào cả. Stop hook trong `hooks/stop-hook.js` chặn cú thoát session bình thường và nhét lại prompt dưới dạng một user turn mới bằng giao thức gốc của Claude Code: `{"decision": "block", "reason": ...}`.

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
| **Phán quyết của classifier subprocess** | Một subprocess Claude Code ngắn hạn (`claude -p --model haiku`) trả về `NO_FILE_CHANGES`. Subprocess đó đọc toàn bộ input của mọi lần gọi tool và xét theo ngữ nghĩa xem lượt này có trực tiếp sửa file dự án nào không. |

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

### Prompt dài từ file

Nếu prompt của bạn chứa xuống dòng, dấu ngoặc kép, backtick, `$` hoặc các ký tự khác có thể phá vỡ việc phân tích đối số shell trong khối `!` của slash command — ví dụ một bản mô tả nhiệm vụ Markdown nhiều đoạn — hãy truyền nó dưới dạng file:

```bash
/watchdog:start --prompt-file ./tmp/my-task.md --max-iterations 20
```

File được Node đọc trực tiếp bằng `fs.readFileSync`, hoàn toàn bỏ qua escape của shell. Đường dẫn tương đối được phân giải theo thư mục làm việc hiện tại của session Claude Code. UTF-8 BOM được tự động loại bỏ (file lưu bằng Notepad trên Windows vẫn an toàn), nội dung CRLF được giữ nguyên từng byte, và khoảng trắng đầu/cuối sẽ bị cắt. **Không thể dùng cùng lúc với `<PROMPT>` nội tuyến** — chọn một trong hai.

Hỗ trợ đường dẫn POSIX trên Linux/macOS/WSL (`/home/you/…`, `./tmp/…`), đường dẫn tuyệt đối trên Windows (`C:\Users\you\…`, `C:/Users/you/…`) và đường dẫn UNC (`\\server\share\…`). `~` được shell (bash/zsh) mở rộng chứ không phải Watchdog — trên `cmd.exe` hãy dùng `%USERPROFILE%\…` hoặc đường dẫn tuyệt đối. Đường dẫn có dấu cách phải được đặt trong dấu nháy như mọi tham số shell khác: `--prompt-file "./my prompts/task.md"`. Xem `/watchdog:help` để có tham chiếu đầy đủ về xử lý đường dẫn.

### Hội tụ chặt chẽ hơn với `--exit-confirmations`

Theo mặc định, vòng lặp thoát ngay khi bộ phân loại Haiku trả về kết luận `NO_FILE_CHANGES` đầu tiên. Với những công việc quan trọng cần xác nhận hai-tầng-an-toàn rằng agent thực sự đã hội tụ, hãy nâng tiêu chuẩn lên:

```bash
/watchdog:start "Refactor services/cache.ts. Lặp đến khi pnpm test:cache pass." --exit-confirmations 3 --max-iterations 20
```

Vòng lặp giờ đây sẽ yêu cầu **ba lượt liên tiếp** sạch trước khi thoát. Bộ đếm streak được reset về `0` ngay khi bộ phân loại trả về bất kỳ thứ gì khác `NO_FILE_CHANGES` — bao gồm `FILE_CHANGES`, `AMBIGUOUS`, lỗi của bộ phân loại (`CLI_MISSING` / `CLI_FAILED`), hoặc một lượt chỉ có văn bản (không có lời gọi tool). Sự hội tụ phải **không bị ngắt quãng** mới được tính.

Mặc định là `1`, giống hệt hành vi trước 1.3.0. **Không tương thích với `--no-classifier`**.

### Hot-reload prompt giữa vòng lặp với `--watch-prompt-file`

Nếu bạn đã khởi động vòng lặp bằng `--prompt-file` và muốn tinh chỉnh nhiệm vụ trong khi nó đang chạy, thêm `--watch-prompt-file`:

```bash
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 30
```

Stop hook giờ đây sẽ đọc lại file prompt vào đầu mỗi iteration. Nếu nội dung đã thay đổi so với lượt trước, phiên bản mới sẽ trở thành user turn tiếp theo **và** bộ đếm streak `--exit-confirmations` được reset về `0` (một nhiệm vụ được định nghĩa lại không nên thừa kế độ hội tụ từ nhiệm vụ cũ).

Hot-reload **không bao giờ làm sập vòng lặp**: nếu file bị mất, trống, hoặc không đọc được khi hook kích hoạt, prompt cached được giữ im lặng và vòng lặp tiếp tục. Bạn có thể chỉnh sửa, đổi tên, hoặc tạm thời di chuyển file giữa vòng lặp mà không phá vỡ gì cả — iteration tiếp theo sẽ lấy bất cứ thứ gì file có vào thời điểm đó.

Cần `--prompt-file`. **Truyền `--watch-prompt-file` một mình là lỗi**.

### Tắt bộ phân loại hoàn toàn với `--no-classifier`

Cho các lần chạy kiểu ralph-loop mà bạn không muốn bất kỳ LLM nào đánh giá hội tụ — bạn sẽ dừng vòng lặp thủ công hoặc qua `--max-iterations`:

```bash
/watchdog:start "Cứ lặp cho đến khi tôi /watchdog:stop." --no-classifier
```

Stop hook bỏ qua hoàn toàn lời gọi Haiku. Cách thoát duy nhất trở thành `--max-iterations` và `/watchdog:stop`. **`--max-iterations` là tùy chọn** — nếu bạn bỏ qua nó (như trong ví dụ trên), vòng lặp thực sự không giới hạn và chỉ dừng khi bạn ra lệnh.

CLI `claude` thậm chí không cần thiết trong chế độ này (subprocess Haiku không bao giờ được spawn). Tương thích với `--prompt-file` và `--watch-prompt-file`. **Không tương thích với `--exit-confirmations`** — bộ đếm streak vô nghĩa khi không có bộ phân loại trả về kết luận.

---

## File trạng thái

Trạng thái theo từng session nằm tại `.claude/watchdog.claudepid.<PID>.local.json`, trong đó `<PID>` là process ID của Claude Code cha, tìm ra bằng cách đi ngược cây tổ tiên của tiến trình. Ví dụ:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "claude_pid": 1119548,
  "started_at": "2026-04-11T12:00:00Z",
  "prompt": "Fix the flaky auth tests..."
}
```

Mỗi session Claude Code có một PID riêng biệt, nên **100 watchdog chạy song song trong cùng một thư mục project cũng không bao giờ đụng nhau** — mỗi cái có file trạng thái riêng, và `/watchdog:stop` ở bất kỳ cái nào cũng chỉ huỷ đúng vòng lặp của session đó.

**Theo dõi các watchdog đang chạy:**

```bash
# Liệt kê mọi file trạng thái per-session đang hoạt động trong project này
ls .claude/watchdog.claudepid.*.local.json

# Xem chi tiết qua jq hoặc node
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/watchdog.claudepid.<PID>.local.json','utf8')))"
```

**Tắt thủ công toàn bộ trong project này:**

```bash
rm -f .claude/watchdog.claudepid.*.local.json
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

### 4. Đặt `--max-iterations` cho hầu hết các task

Classifier subprocess không phải là thánh. Một agent bị kẹt mà cứ loay hoay sửa linh tinh vô nghĩa, hoặc một agent bị rối rồi ngừng sửa quá sớm, đều cần rơi vào một cú dừng cứng. `--max-iterations 20` là một mặc định hợp lý cho hầu hết công việc.

**Tuy nhiên flag này là tùy chọn**. Nếu bạn thực sự muốn vòng lặp không giới hạn (ví dụ: một vòng lặp bảo trì chạy lâu mà bạn định dừng thủ công bằng `/watchdog:stop`, hoặc một lần chạy `--no-classifier` mà việc hội tụ do bạn — không phải Haiku — đánh giá), **chỉ cần bỏ flag hoàn toàn**.

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

Watchdog cần **cả `claude` lẫn `node` đều có trong `PATH`** — `node` là thứ chạy hook và setup script của plugin, còn `claude` là cái watchdog đẻ ra (`claude -p --model haiku`) để phán xử xem mỗi lượt có sửa file dự án nào hay không.

| Yêu cầu | Lý do |
| --- | --- |
| **Claude Code 2.1+** | Dùng hệ thống Stop hook và định dạng plugin marketplace |
| **`node`** 18+ trong `PATH` | Runtime cho hook và setup script của plugin |
| **`claude` CLI** trong `PATH` | Mỗi lần hook chạy, watchdog đẻ ra một subprocess `claude -p --model haiku` ngắn hạn để phân loại lượt đó. Phải đã xác thực (OAuth hoặc `ANTHROPIC_API_KEY`) — subprocess xài lại credential session bạn đã có sẵn. |

### Cài dependencies

Nếu bạn cài Claude Code qua `npm install -g @anthropic-ai/claude-code` thì bạn có **cả** `claude` lẫn `node` trong một gói — lệnh npm install nhét `claude` vào `PATH` luôn, còn Node.js chính là runtime của npm nên nó đã nằm sẵn đó rồi. Khỏi phải cài gì thêm.

Nếu bạn cài Claude Code bằng cách khác (binary standalone, Homebrew, installer Windows) thì `claude` đã có sẵn trong `PATH`, nhưng có thể bạn phải cài thêm Node.js 18+ riêng:

**macOS (Homebrew):**

```bash
brew install node
# claude CLI: coi https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
# Cách 1: package của distro (có thể cũ hơn bản 18)
sudo apt update && sudo apt install -y nodejs

# Cách 2: NodeSource (LTS hiện tại)
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

**Windows (PowerShell / cmd nguyên bản):**

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# hoặc scoop
scoop install nodejs-lts

# hoặc tải installer từ https://nodejs.org
```

### Hỗ trợ nền tảng

| Nền tảng | Trạng thái |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ CI đã test |
| macOS (Node 18 / 20 / 22) | ✅ CI đã test |
| Windows (Node 18 / 20 / 22) | ✅ CI đã test |

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
│   ├── hooks.json           # đăng ký Stop hook (gọi node)
│   └── stop-hook.js         # logic lõi của vòng lặp
├── scripts/
│   ├── setup-watchdog.js    # tạo file trạng thái
│   └── stop-watchdog.js     # xoá file trạng thái
├── lib/                     # các module dùng chung (mọi entry point đều xài lại)
│   ├── constants.js         # pattern đường dẫn state, marker tokens, template prompt
│   ├── log.js               # chẩn đoán qua stderr
│   ├── stdin.js             # reader stdin đồng bộ, đa nền tảng
│   ├── state.js             # vòng đời file trạng thái theo kiểu atomic
│   ├── transcript.js        # parser JSONL + trích tool của lượt hiện tại
│   ├── judge.js             # subprocess classifier Claude Code + parser phán quyết
│   └── claude-pid.js        # đi ngược cây tổ tiên tiến trình
├── test/                    # unit + integration test chạy bằng node:test
│   ├── fixtures/            # fixture transcript JSONL
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── claude-pid.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   ├── stop-hook.test.js
│   └── stop-hook-haiku.test.js
├── .github/                 # workflow CI (matrix node --test, jsonlint, markdownlint) + template issue/PR
├── .gitattributes           # ép line ending là LF
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # ghi nhận nguồn ralph-loop
├── README.md                # file này
└── README.{zh,ja,ko,es,vi,pt}.md  # các bản dịch
```

## Nguồn cảm hứng

Watchdog là tác phẩm phái sinh từ plugin [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) của Anthropic (Apache License 2.0, © Anthropic, PBC). Bản gốc `ralph-loop` dùng giao thức XML-tag kiểu `<promise>COMPLETE</promise>` để agent chủ động tuyên bố hoàn thành.

Watchdog giữ nguyên cơ chế cốt lõi — một Stop hook nạp lại prompt — và thay đổi những thứ sau ở trên đó:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Điều kiện kích hoạt thoát** | Một subprocess Claude Code ngắn hạn (`claude -p --model haiku`) là **trọng tài duy nhất**. Nó đọc toàn bộ input của mọi lần gọi tool và xét theo ngữ nghĩa xem có file dự án nào bị sửa trực tiếp hay không. | Agent phải phát ra một XML tag `<promise>…</promise>` trong phần text cuối. Chuỗi bên trong tag có thể cấu hình qua `--completion-promise "…"` (ví dụ `COMPLETE`, `DONE`). Stop hook dùng grep khớp chính xác chuỗi đó. |
| **Tiền đề thoát** | Phải có gọi tool **VÀ** classifier subprocess nói `NO_FILE_CHANGES` | Chỉ cần khớp chuỗi `<promise>`. Agent có thể gian lận bằng cách phun tag ra sớm; lá chắn duy nhất của ralph-loop là một prompt nài nỉ agent đừng nói dối. |
| **Mức độ agent thấy được** | Ẩn hoàn toàn (không systemMessage, không banner, chẩn đoán chỉ đi qua stderr) | Agent được cho biết về loop và giao thức promise |
| **Phạm vi trạng thái** | Mỗi session Claude Code một file trạng thái riêng — cùng một project muốn chạy bao nhiêu watchdog song song cũng được | Cả project chỉ một file trạng thái — cùng một project tại một thời điểm chỉ chạy được MỘT ralph-loop |
| **Định dạng file trạng thái** | JSON (parse bằng `JSON.parse` native) | Markdown với YAML frontmatter (parse bằng sed/awk/grep) |
| **Runtime** | Node.js 18+ — đa nền tảng (Linux, macOS, Windows nguyên bản) | Bash + jq + POSIX coreutils — chỉ chạy trên Unix |
| **Cách truyền prompt** | Inline qua `$ARGUMENTS`, **hoặc** `--prompt-file <path>` — đọc file trực tiếp bằng `fs.readFileSync` của Node, **bỏ qua hoàn toàn việc phân tích đối số shell**. An toàn cho Markdown nhiều đoạn chứa xuống dòng, dấu ngoặc kép, backtick, `$`, v.v. UTF-8 BOM được tự động loại bỏ; CRLF được giữ nguyên từng byte. | Chỉ inline qua `$ARGUMENTS` trong khối shell `!` của slash command. Bất kỳ `"`, `` ` ``, `$` hoặc xuống dòng nào chưa được escape trong prompt đều làm `bash` báo `unexpected EOF`. Không có dự phòng bằng file hay stdin — các mô tả nhiệm vụ Markdown nhiều đoạn phải được ép thành một chuỗi một dòng an toàn với shell trước đã. |
| **Linh hoạt hội tụ** | `--exit-confirmations N` yêu cầu N kết luận `NO_FILE_CHANGES` **liên tiếp** trước khi thoát (mặc định 1). `--no-classifier` bỏ qua Haiku hoàn toàn cho các lần chạy kiểu ralph-loop chỉ thoát qua `--max-iterations` hoặc `/watchdog:stop`. | Một cơ chế phát-tag-rồi-grep `<promise>…</promise>` duy nhất, không có núm điều chỉnh độ chặt chẽ — agent hoặc phát ra cụm từ promise đã cấu hình hoặc không phát. |
| **Tiến hóa prompt** | `--watch-prompt-file` hot-reload `--prompt-file` mỗi iteration. Bạn có thể chỉnh sửa task spec giữa vòng lặp và lượt tiếp theo sẽ lấy nó (và reset streak hội tụ, vì task đã đổi). File mất / trống / không đọc được giữ im lặng prompt cached — hot-reload không bao giờ làm sập vòng lặp. | prompt được cố định tại thời điểm `/ralph-loop "..."` và **không thể** thay đổi mà không hủy và khởi động lại vòng lặp. |

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
