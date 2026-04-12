[English](./README.md) | [中文](./README.zh.md) | 한국어 | [日本語](./README.ja.md) | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **Agent를 감시하고, 거짓말은 잡아내고, 진짜 끝나기 전엔 절대 놓아주지 않습니다.**

_`Claude Code` 플러그인입니다. 하나의 세션 안에서 현재 agent를 자기 참조 루프에 붙잡아 두고, 파일 수정이 정말로 멎을 때까지 빠져나가지 못하게 합니다. "완료 플래그" 같은 것도, agent가 빠져나갈 편법도 없습니다._

[빠른 시작](#빠른-시작) • [왜 Watchdog인가?](#왜-watchdog인가) • [동작 원리](#동작-원리) • [명령어](#명령어) • [설치](#설치) • [영감을 준 프로젝트](#영감을-준-프로젝트)

---

## 핵심 메인테이너

| 역할 | 이름 | GitHub |
| --- | --- | --- |
| Creator & Maintainer | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## 빠른 시작

**1단계: 설치**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**2단계: 확인**

```bash
/watchdog:help
```

**3단계: watchdog 실행**

```bash
/watchdog:start "tests/auth/*.ts의 불안정한 인증 테스트를 고쳐주세요. 전체 스위트가 통과할 때까지 계속 반복해주세요." --max-iterations 20
```

끝입니다. 매 턴이 끝날 때마다 Watchdog이 같은 prompt를 다시 먹여주고, 아래 중 하나가 일어날 때까지 멈추지 않습니다.

- Claude가 한 턴 안에서 어떤 파일도 수정하지 않거나, **또는**
- `--max-iterations` 안전 상한에 도달하거나, **또는**
- 직접 `/watchdog:stop`을 실행하거나.

나머지는 전부 자동입니다. Agent는 루프가 돌고 있다는 사실조차 모릅니다.

---

## 왜 Watchdog인가?

- **Agent는 속일 수 없습니다** — Agent는 자기가 루프 안에 있다는 사실을 전혀 모릅니다. `systemMessage`도, 반복 카운터도, 시작 배너도 없습니다. 가짜 완료 신호를 뱉어서 빠져나가는 길 자체가 막혀 있습니다.
- **도구 호출을 반드시 강제합니다** — 순수 텍스트 턴("확인했어요, 문제없습니다")으로는 루프가 끝나지 않습니다. Agent는 **반드시** 실제로 도구를 호출해야만 종료 후보가 됩니다.
- **LLM이 판정하는, 프로젝트 인식 기반의 파일 변경 감지** — 매 hook이 발동될 때마다 Watchdog은 짧게 살았다가 사라지는 **Claude Code 서브프로세스**(`claude -p --model haiku`)를 띄워서 단 하나의 질문만 던집니다: "이번 턴이 프로젝트 파일을 수정했는가?". 이 서브프로세스는 각 도구 호출의 전체 입력을 모두 본 뒤 의미 기반으로 판단합니다. Haiku는 모델 이름일 뿐이고, 중요한 것은 이것이 커스텀 API 클라이언트가 아니라 **독립적이고 상태가 없는 Claude Code 프로세스**라는 점입니다. 따라서 이미 설정해 둔 `claude` 인증이 그대로 재사용됩니다.
- **세션별 격리** — 상태 파일은 부모 Claude Code 프로세스 ID를 키로 삼으며, 프로세스 조상 체인을 따라 올라가며 이를 찾아냅니다. 같은 프로젝트 디렉터리에서 100개의 동시 watchdog을 돌려도 서로 충돌하지 않습니다.
- **설계상 숨김 처리** — 모든 진단 출력은 stderr로 나갑니다. JSONL 트랜스크립트에 루프 메타데이터가 흘러 들어가 agent 컨텍스트를 오염시키는 일이 없습니다.
- **Apache 2.0** — Anthropic의 `ralph-loop` 플러그인에서 깔끔하게 파생되었으며, 전체 출처는 [NOTICE](./NOTICE)에 명시되어 있습니다.

---

## 동작 원리

명령어는 **한 번만** 실행하면 되고, 나머지는 `Claude Code`가 알아서 처리합니다.

```bash
# 한 번만 실행하세요:
/watchdog:start "작업 설명" --max-iterations 20

# 그다음 Claude Code가 자동으로:
# 1. 작업을 수행합니다
# 2. 종료하려고 합니다
# 3. Stop hook이 종료를 막고 같은 prompt를 다시 먹여줍니다
# 4. Claude는 이전 수정 내역을 본 상태로 같은 작업을 이어서 진행합니다
# 5. 어떤 프로젝트 파일도 수정하지 않는 턴이 나올 때까지 반복합니다
#    (또는 --max-iterations에 도달할 때까지)
```

이 루프는 **현재 세션 내부에서** 돌아갑니다. 외부 `while true`도, 오케스트레이터 프로세스도 없습니다. `hooks/stop-hook.js`의 `Stop hook`이 일반적인 세션 종료를 막고, `Claude Code`의 네이티브 `{"decision": "block", "reason": ...}` 프로토콜을 이용해 prompt를 새로운 user turn으로 다시 주입합니다.

이를 통해 **자기 참조 피드백 루프**가 만들어집니다.

- Prompt는 반복마다 변하지 않습니다
- Claude의 이전 작업은 파일에 그대로 남아 있습니다
- 매 반복마다 수정된 파일과 git 히스토리가 그대로 보입니다
- Claude는 자기가 이전에 쓴 내용을 읽으면서 스스로 개선해 나갑니다

### 종료 조건

루프는 최신 assistant 턴에 대해 다음 **두 가지가 모두** 참일 때 종료됩니다.

| 검사 항목 | 요구 사항 |
| --- | --- |
| **도구 사용 전제 조건** | 해당 턴에서 최소 하나 이상의 도구를 호출했어야 합니다. 순수 텍스트 턴으로는 절대 종료되지 않습니다. |
| **분류기 서브프로세스 판정** | 짧게 살았다가 사라지는 Claude Code 서브프로세스(`claude -p --model haiku`)가 `NO_FILE_CHANGES`를 반환합니다. 이 서브프로세스는 각 도구 호출의 전체 입력을 읽고, 해당 턴이 프로젝트 파일을 직접 수정했는지 여부를 의미 기반으로 판단합니다. |

둘 중 하나라도 실패하면 루프는 계속됩니다. 추가 종료 경로는 다음과 같습니다.

- `--max-iterations` 도달 (하드 상한, 언제나 존중됩니다)
- 사용자가 `/watchdog:stop` 실행 (상태 파일 삭제)
- 상태 파일을 디스크에서 직접 삭제

---

## 명령어

| 명령어 | 효과 | 예시 |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | 현재 세션에서 watchdog 시작 | `/watchdog:start "services/cache.ts를 리팩터링해주세요. pnpm test:cache가 통과할 때까지 반복해주세요." --max-iterations 20` |
| `/watchdog:stop` | 현재 세션의 watchdog 취소 | `/watchdog:stop` |
| `/watchdog:help` | `Claude Code` 안에서 전체 레퍼런스 출력 | `/watchdog:help` |

### 파일로 긴 prompt 전달하기

prompt 안에 줄바꿈, 따옴표, 백틱, `$` 또는 슬래시 커맨드 `!` 블록 내부의 셸 인자 파싱을 깨뜨릴 만한 문자가 들어있다면 — 예를 들어 여러 단락짜리 Markdown 작업 명세 — 파일로 전달하세요:

```bash
/watchdog:start --prompt-file ./tmp/my-task.md --max-iterations 20
```

파일은 Node가 `fs.readFileSync`로 직접 읽기 때문에 셸 이스케이프를 완전히 우회합니다. 상대 경로는 Claude Code 세션의 현재 작업 디렉터리를 기준으로 해석됩니다. UTF-8 BOM은 자동으로 제거되며(Windows 메모장으로 저장한 파일도 안전), CRLF 내용은 바이트 단위로 보존되고, 앞뒤 공백은 잘립니다. **인라인 `<PROMPT>`와 함께 쓸 수 없습니다** — 둘 중 하나만 고르세요.

Linux/macOS/WSL의 POSIX 경로(`/home/you/…`, `./tmp/…`), Windows 절대 경로(`C:\Users\you\…`, `C:/Users/you/…`), UNC 경로(`\\server\share\…`)를 모두 지원합니다. `~`는 Watchdog이 아니라 셸(bash/zsh)이 확장합니다 — `cmd.exe`에서는 `%USERPROFILE%\…` 또는 절대 경로를 사용하세요. 공백이 들어간 경로는 다른 셸 인자처럼 따옴표로 감싸야 합니다: `--prompt-file "./my prompts/task.md"`. 경로 처리에 대한 전체 레퍼런스는 `/watchdog:help`를 참고하세요.

### `--exit-confirmations`로 더 엄격한 수렴 요구

기본적으로 Haiku 분류기가 처음 `NO_FILE_CHANGES` 판정을 반환하는 순간 루프가 종료됩니다. 정말로 agent가 수렴했다는 안전벨트와 멜빵 같은 이중 확인이 필요한 중요한 작업이라면 기준을 올리세요:

```bash
/watchdog:start "services/cache.ts를 리팩터링. pnpm test:cache가 통과할 때까지 반복." --exit-confirmations 3 --max-iterations 20
```

이제 루프는 종료하기 전에 **연속 3턴**의 깨끗한 판정을 요구합니다. 분류기가 `NO_FILE_CHANGES`가 아닌 어떤 결과 — `FILE_CHANGES`, `AMBIGUOUS`, 분류기 실패(`CLI_MISSING` / `CLI_FAILED`), 또는 도구 호출이 없는 순수 텍스트 턴 — 라도 반환하는 순간 streak 카운터는 `0`으로 리셋됩니다. 수렴은 **끊기지 않아야** 카운트됩니다.

기본값은 `1`이며, 1.3.0 이전 동작과 동일합니다. **`--no-classifier`와 함께 쓸 수 없습니다**.

### `--watch-prompt-file`로 루프 도중 prompt 핫리로드

`--prompt-file`로 루프를 시작했고 실행 중에 작업을 다듬고 싶다면 `--watch-prompt-file`을 추가하세요:

```bash
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 30
```

이제 Stop hook이 매 이터레이션 시작 시점에 prompt 파일을 다시 읽습니다. 이전 턴 이후 내용이 바뀌었다면 새 버전이 다음 user turn이 되고, **그리고** `--exit-confirmations`의 streak 카운터가 `0`으로 리셋됩니다(작업이 재정의된 이상 옛 작업의 수렴을 물려받아서는 안 됩니다).

핫리로드는 **절대로 루프를 깨뜨리지 않습니다**: hook이 발화하는 시점에 파일이 사라졌거나, 비어 있거나, 읽을 수 없으면 캐시된 prompt가 조용히 유지되고 루프는 계속됩니다. 도중에 파일을 편집하거나, 이름을 바꾸거나, 잠시 옮겨도 아무것도 깨지지 않습니다 — 다음 이터레이션이 그 시점의 파일 상태를 가져갑니다.

`--prompt-file`이 필요합니다. **`--watch-prompt-file`을 단독으로 전달하면 에러**입니다.

### `--no-classifier`로 분류기 완전 비활성화

ralph-loop 스타일로 어떤 LLM도 수렴을 판정하지 않도록 — 수동으로 멈추거나 `--max-iterations`로 빠져나가거나 둘 중 하나:

```bash
/watchdog:start "내가 /watchdog:stop할 때까지 계속 반복해." --no-classifier
```

Stop hook이 Haiku 호출을 **완전히 건너뜁니다**. 종료 수단은 `--max-iterations`와 `/watchdog:stop` 두 가지로 줄어듭니다. **`--max-iterations`는 선택입니다** — 위 예시처럼 생략하면 루프는 진짜로 무제한이 되고, 당신이 멈추라고 할 때까지만 돕니다. "무제한"을 의미하기 위해 `--max-iterations 0`을 전달할 **필요가 더 이상 없습니다** — 그냥 플래그를 빼세요. (`0` 형식은 하위 호환을 위해 여전히 허용됩니다.)

이 모드에서는 `claude` CLI조차 필요 없습니다(Haiku 서브프로세스가 절대 생성되지 않습니다). `--prompt-file`, `--watch-prompt-file`과 자유롭게 조합할 수 있습니다. **`--exit-confirmations`와는 함께 쓸 수 없습니다** — 분류기가 판정을 반환하지 않는 이상 streak 카운터는 의미가 없습니다.

---

## 상태 파일

세션별 상태는 `.claude/watchdog.claudepid.<PID>.local.json`에 저장되며, 여기서 `<PID>`는 프로세스 조상 체인을 따라 올라가며 찾아낸 부모 Claude Code 프로세스 ID입니다. 예시:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "claude_pid": 1119548,
  "started_at": "2026-04-11T12:00:00Z",
  "prompt": "불안정한 인증 테스트를 고쳐주세요..."
}
```

모든 Claude Code 세션은 서로 다른 PID를 가지므로, **같은 프로젝트 디렉터리에서 100개의 동시 watchdog을 돌려도 절대 충돌하지 않습니다** — 각자 자기 전용 상태 파일을 갖고, 어느 한 세션에서 `/watchdog:stop`을 실행해도 해당 세션의 루프만 취소됩니다.

**활성 watchdog 확인:**

```bash
# 이 프로젝트에서 활성화된 모든 세션별 상태 파일 목록
ls .claude/watchdog.claudepid.*.local.json

# jq나 node로 하나 살펴보기
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/watchdog.claudepid.<PID>.local.json','utf8')))"
```

**이 프로젝트의 모든 watchdog을 수동으로 종료:**

```bash
rm -f .claude/watchdog.claudepid.*.local.json
```

---

## 설치

### 기본 경로: 마켓플레이스 설치 (권장)

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

설치 후 `/watchdog:help`로 확인해 보세요.

### 대안: 단일 세션 로컬 로드

글로벌 설정을 건드리지 않고 Watchdog을 한 번만 시험해 보고 싶다면, 한 세션만 로드할 수 있습니다.

```bash
claude --plugin-dir /absolute/path/to/claude-code-watchdog
```

### 대안: `settings.json`을 이용한 수동 설치

CI/CD, 사내 배포, 오프라인 사용 등의 환경이라면 저장소를 clone한 뒤 `~/.claude/settings.json`에서 직접 연결하세요.

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

그다음 `Claude Code` 안에서 `/reload-plugins`를 실행하세요.

---

## Agent에게 루프를 숨기기

설계의 핵심은 **agent가 자기가 루프 안에 있다는 사실을 몰라야 한다**는 것입니다. 알게 되면 첫 턴부터 기억에만 의존해 "완료했다"고 주장하며 지름길을 타려 할 겁니다. Watchdog은 이를 다음과 같이 강제합니다.

- **`Stop hook`에서 `systemMessage`를 절대 내보내지 않습니다** — 반복 카운터도, 상태 배너도 없습니다.
- **셋업 스크립트는 stdout에 사용자 prompt만 씁니다** — "Loop activated, iteration 1" 같은 헤더나 agent가 볼 법한 초기화 출력은 전혀 없습니다.
- **다시 먹여주는 prompt는 원문 + 간단한 검증 리마인더 한 줄**이며, 영어로 되어 있습니다.

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **모든 진단은 stderr (`>&2`)로 나갑니다** — `Claude Code`의 트랜스크립트는 이를 agent 컨텍스트로 포착하지 않습니다.

Agent의 입장에서는 같은 사용자가 같은 질문을 반복해서 던지고, 가끔 "제발 진짜로 다시 한번 확인해달라"고 덧붙이는 것처럼 보일 뿐입니다. 눈에 보이는 `Stop hook`도, 반복 카운터도, 루프 메타데이터도 없습니다. 존재조차 모르는 것은 속일 수 없습니다.

---

## Prompt 작성 베스트 프랙티스

### 1. 명확한 완료 기준

"더 이상 수정할 것이 없다"가 실제로 검증 가능한 진짜 답변이 되도록 prompt를 작성하세요.

❌ 나쁨: "todo API를 만들고, 잘 만들어주세요."

✅ 좋음:

```markdown
`src/api/todos.ts`에 todo용 REST API를 구현해주세요.

요구 사항:
- 모든 CRUD 엔드포인트 동작
- 입력 검증 적용
- `tests/todos.test.ts`에서 테스트 커버리지 80% 이상
- `pnpm test` 전체 통과
```

### 2. 점진적이고 검증 가능한 목표

루프는 "파일이 더 이상 수정되지 않음"을 기준으로 종료됩니다. 작업에 검증 가능한 종료 상태가 없으면 루프는 그냥 헛돕니다.

✅ 좋음:

```markdown
`services/cache.ts`를 리팩터링해서 레거시 LRU 구현을 제거해주세요.

단계:
1. 기존 LRU 클래스와 그 테스트 삭제
2. `src/` 아래 모든 호출자를 새 cache API로 전환
3. 변경할 때마다 `pnpm typecheck && pnpm test:cache` 실행
4. 둘 다 경고 없이 통과할 때까지 반복
```

### 3. 자기 수정 구조

Agent가 실패를 어떻게 감지하고 적응해야 하는지 알려주세요.

```markdown
TDD로 기능 X를 구현해주세요:
1. tests/feature-x.test.ts에 실패하는 테스트 작성
2. 테스트를 통과시키는 최소한의 코드 작성
3. `pnpm test:feature-x` 실행
4. 테스트가 실패하면 실패 내용을 읽고 수정한 뒤 다시 실행
5. 모든 테스트가 초록이 된 뒤에만 리팩터링
```

### 4. 대부분의 작업에서는 `--max-iterations`를 설정하세요

분류기 서브프로세스는 완벽하지 않습니다. 의미 없는 편집을 반복하며 멈추지 못하는 agent나, 헷갈려서 너무 일찍 편집을 중단해 버리는 agent는 결국 하드 스톱으로 떨어져야 합니다. 대부분의 작업에는 `--max-iterations 20`이 합리적인 기본값입니다.

**그래도 이 플래그는 선택사항입니다**. 정말로 무제한 루프를 원한다면(예: `/watchdog:stop`으로 수동 중지할 작정인 장기 유지보수 루프, 또는 Haiku가 아닌 본인이 수렴을 판정하는 `--no-classifier` 실행), **그냥 플래그를 빼세요**. `--max-iterations 0`을 전달할 **필요가 없습니다** — 그 형식은 하위 호환을 위해 여전히 허용되지만, "무제한"을 표현하는 자연스러운 방법은 이제 플래그를 빼는 것입니다.

---

## Watchdog을 언제 쓰면 좋은가

**잘 맞는 경우:**

- 명확하고 자동화된 성공 기준이 있는 작업 (테스트, 린트, 타입 체크)
- 반복 개선: 수정 → 테스트 → 수정 → 테스트
- 자리를 비워둬도 되는 그린필드 구현 작업
- 체계적인 코드 리뷰와 수정

**잘 맞지 않는 경우:**

- 사람의 판단이나 설계 결정이 필요한 작업
- 일회성 작업 (명령 하나, 파일 한 번 수정)
- "완료"의 정의가 주관적인 경우
- 외부 컨텍스트가 필요한 프로덕션 디버깅

---

## 요구 사항

Watchdog은 **`claude`와 `node` 둘 다 `PATH`에 있어야 합니다** — `node`는 플러그인의 hook 및 셋업 스크립트를 실행하고, `claude`는 Watchdog이 매 턴 파일 수정 여부를 판정하기 위해 띄우는(`claude -p --model haiku`) 대상입니다.

| 요구 사항 | 이유 |
| --- | --- |
| **Claude Code 2.1+** | Stop hook 시스템과 마켓플레이스 플러그인 포맷을 사용합니다 |
| **`node`** 18+가 `PATH`에 있을 것 | 플러그인의 hook 및 셋업 스크립트 런타임 |
| **`claude` CLI**가 `PATH`에 있을 것 | Watchdog은 매 hook 발동마다 짧게 살았다가 사라지는 `claude -p --model haiku` 서브프로세스를 띄워서 해당 턴을 분류합니다. 인증이 완료되어 있어야 합니다 (OAuth 또는 `ANTHROPIC_API_KEY`) — 이 서브프로세스는 이미 설정해 둔 세션 인증 정보를 그대로 재사용합니다. |

### 의존성 설치

Claude Code를 `npm install -g @anthropic-ai/claude-code`로 설치했다면 `claude`와 `node`가 **한 세트로** 함께 들어옵니다 — npm install 과정에서 `claude`가 `PATH`에 추가되고, Node.js는 npm 자체의 런타임이기 때문에 이미 깔려 있습니다. 추가로 설치할 것은 없습니다.

Claude Code를 다른 방식으로 설치했다면(독립 실행 바이너리, Homebrew, Windows 인스톨러 등) `claude`는 이미 `PATH`에 있겠지만, Node.js 18+를 별도로 설치해야 할 수 있습니다.

**macOS (Homebrew):**

```bash
brew install node
# claude CLI: https://docs.anthropic.com/claude-code 참고
```

**Debian / Ubuntu / WSL2:**

```bash
# 옵션 1: 배포판 패키지 (18보다 오래된 버전일 수 있음)
sudo apt update && sudo apt install -y nodejs

# 옵션 2: NodeSource (최신 LTS)
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

**Windows (네이티브 PowerShell / cmd):**

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# 또는 scoop
scoop install nodejs-lts

# 또는 https://nodejs.org 에서 설치 프로그램 다운로드
```

### 플랫폼 지원

| 플랫폼 | 상태 |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ CI에서 테스트됨 |
| macOS (Node 18 / 20 / 22) | ✅ CI에서 테스트됨 |
| Windows (Node 18 / 20 / 22) | ✅ CI에서 테스트됨 |

---

## 플러그인 구조

이 저장소는 마켓플레이스이자 플러그인 자체입니다. `marketplace.json`이 `./`를 가리킵니다.

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # 마켓플레이스 매니페스트
│   └── plugin.json          # 플러그인 매니페스트
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # Stop hook 등록 (node를 호출)
│   └── stop-hook.js         # 핵심 루프 로직
├── scripts/
│   ├── setup-watchdog.js    # 상태 파일 생성
│   └── stop-watchdog.js     # 상태 파일 삭제
├── lib/                     # 공유 모듈 (모든 진입점에서 재사용)
│   ├── constants.js         # 상태 경로 패턴, 마커 토큰, prompt 템플릿
│   ├── log.js               # stderr 진단 출력
│   ├── stdin.js             # 크로스 플랫폼 동기 stdin 리더
│   ├── state.js             # 원자적 상태 파일 라이프사이클
│   ├── transcript.js        # JSONL 파서 + 현재 턴 도구 추출
│   ├── judge.js             # Claude Code 분류기 서브프로세스 + 판정 파서
│   └── claude-pid.js        # 프로세스 조상 체인 탐색
├── test/                    # node:test 단위 + 통합 테스트
│   ├── fixtures/            # 트랜스크립트 JSONL 픽스처
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── claude-pid.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   ├── stop-hook.test.js
│   └── stop-hook-haiku.test.js
├── .github/                 # CI 워크플로(node --test 매트릭스, jsonlint, markdownlint) + 이슈/PR 템플릿
├── .gitattributes           # LF 줄바꿈 강제
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # ralph-loop 출처 표기
├── README.md                # 영문 원본
└── README.{zh,ja,ko,es,vi,pt}.md  # 번역본
```

## 영감을 준 프로젝트

Watchdog은 Anthropic의 [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) 플러그인(Apache License 2.0, © Anthropic, PBC)의 파생 저작물입니다. 원본 `ralph-loop`은 agent가 직접 완료를 선언하는 `<promise>COMPLETE</promise>` XML 태그 프로토콜을 사용했습니다.

Watchdog은 핵심 메커니즘(prompt를 다시 먹여주는 `Stop hook`)을 유지하면서, 그 위에 다음과 같은 변경을 더했습니다.

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **종료 트리거** | 짧게 살았다가 사라지는 Claude Code 서브프로세스(`claude -p --model haiku`)가 **유일한** 판정자입니다. 각 도구 호출의 전체 입력을 읽고, 이번 턴이 프로젝트 파일을 직접 수정했는지 여부를 의미 기반으로 판단합니다. | Agent는 최종 텍스트에 `<promise>…</promise>` XML 태그를 반드시 출력해야 합니다. 태그 내부 문구는 `--completion-promise "…"`로 설정할 수 있습니다(예: `COMPLETE`, `DONE`). Stop hook은 grep으로 정확한 문자열을 매칭합니다. |
| **종료 전제 조건** | 도구가 호출되었고 **그리고** 분류기 서브프로세스가 `NO_FILE_CHANGES`라고 해야 합니다 | `<promise>` 텍스트 매칭만으로 충분합니다. Agent는 태그를 미리 뱉어서 속일 수 있고, ralph-loop의 유일한 방어는 거짓말하지 말라고 부탁하는 prompt뿐입니다. |
| **Agent 가시성** | 완전히 숨김 (systemMessage 없음, 배너 없음, 진단은 stderr 전용) | Agent에게 루프와 promise 프로토콜의 존재를 알려줍니다 |
| **상태 범위** | Claude Code 세션마다 상태 파일 하나씩 — 같은 프로젝트에서 동시에 원하는 만큼 watchdog을 돌릴 수 있습니다 | 프로젝트당 상태 파일 하나 — 한 프로젝트에서 동시에 돌릴 수 있는 ralph-loop는 하나뿐입니다 |
| **상태 파일 포맷** | JSON (네이티브 `JSON.parse`로 파싱) | YAML frontmatter가 있는 Markdown (sed/awk/grep으로 파싱) |
| **런타임** | Node.js 18+ — 크로스 플랫폼 (Linux, macOS, 네이티브 Windows) | Bash + jq + POSIX coreutils — Unix 전용 |
| **prompt 입력 방식** | `$ARGUMENTS` 인라인, **또는** `--prompt-file <path>` — Node의 `fs.readFileSync`로 파일을 직접 읽어 **셸 인자 파싱을 완전히 우회합니다**. 여러 단락짜리 Markdown에 들어 있는 줄바꿈, 따옴표, 백틱, `$` 같은 문자를 안전하게 전달할 수 있습니다. UTF-8 BOM은 자동으로 제거되고 CRLF는 바이트 단위로 그대로 보존됩니다. | 슬래시 커맨드 `!` 셸 블록 안의 `$ARGUMENTS`를 통한 인라인 입력만 지원합니다. prompt에 이스케이프되지 않은 `"`, `` ` ``, `$` 또는 줄바꿈이 하나라도 있으면 `bash` 파싱이 `unexpected EOF`로 실패합니다. 파일이나 stdin 대체 경로가 없기 때문에, 여러 단락짜리 Markdown 작업 명세는 먼저 셸 안전한 한 줄 문자열로 압축해야 합니다. |
| **수렴 유연성** | `--exit-confirmations N`은 종료 전에 **연속 N번**의 깨끗한 `NO_FILE_CHANGES` 판정을 요구합니다(기본 1). `--no-classifier`는 Haiku를 완전히 건너뛰어 `--max-iterations` 또는 `/watchdog:stop`으로만 종료되는 ralph-loop 스타일 실행을 가능하게 합니다. | `<promise>…</promise>` 태그 발사 + grep 단일 메커니즘만 있으며 조절 가능한 엄격도 노브가 전혀 없습니다 — 에이전트가 설정된 promise 문구를 뱉거나 뱉지 않거나 둘 중 하나입니다. |
| **prompt 진화** | `--watch-prompt-file`은 매 이터레이션마다 `--prompt-file`을 핫리로드합니다. 루프 도중에 작업 명세를 편집할 수 있고 다음 턴이 이를 가져옵니다(작업이 바뀌었으므로 수렴 streak도 리셋됩니다). 파일이 사라지거나 / 비거나 / 읽을 수 없을 때는 캐시된 prompt를 조용히 유지합니다 — 핫리로드는 절대 루프를 깨뜨리지 않습니다. | prompt는 `/ralph-loop "..."` 시점에 고정되며, 루프를 취소하고 재시작하지 않는 이상 변경**할 수 없습니다**. |

전체 출처 표기와 수정 내역 전체는 [`NOTICE`](./NOTICE)를 참고하세요.

---

## 라이선스

Apache License 2.0. 자세한 내용은 [`LICENSE`](./LICENSE)와 [`NOTICE`](./NOTICE)를 참고하세요.

Watchdog은 `ralph-loop`(© Anthropic, PBC, Apache 2.0)의 파생 저작물입니다. 이 프로젝트는 **Anthropic과 제휴하거나 Anthropic의 보증을 받은 프로젝트가 아닙니다**.

---

<div align="center">

**영감을 준 프로젝트:** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**Agent를 감시하고, 거짓말은 잡아내고, 진짜 끝나기 전엔 절대 놓아주지 않습니다.**

</div>
