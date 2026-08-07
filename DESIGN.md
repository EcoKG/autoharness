# AutoHarness 설계 계약 (v1)

> 이 문서는 빌더·검증 에이전트가 공유하는 **단일 계약**이다. 여기 정의된 파일 경로, CLI 표면,
> 스키마, 종료 코드, 도구 이름은 임의로 바꾸지 않는다. 변경이 필요하면 이 문서를 먼저 고친다.

## 1. 목적

Claude Code 프롬프트로만 존재하던 "자율 주행 마이그레이션 하네스 구축" 절차를
**어느 저장소에서든 재사용 가능한 패키지**로 만든다. 구성은 셋이 결합된 하나의 패키지다.

1. **개인 스킬** `autoharness` — 절차(실측→구축→모델 선택→검증→자율 주행)를 코드화한 지휘 문서
2. **사용자 스코프 MCP 서버** `autoharness` — 상태 장부·러너·레지스트리·워치독 관리를 결정적으로 수행
3. **워치독** — Windows 작업 스케줄러 등록 스크립트. 세션이 죽어도(사용량 초과 포함) 자동 부활

필수 요구사항:
- **무개입**: 주행 중 사용자 질문 금지. Stop 훅 게이트 + 헤드리스 재기동으로 루프 유지
- **사용량 초과 방어**: 빠른 실패를 사용량 초과로 분류하면 지수 백오프(30→60→120→240→360분)로
  재시도. 절대 영구 포기하지 않는다(자동 부활). 설정 오류성 실패는 5회 연속 시 `error`로 정지(방어)
- **모델 선택**: `claude-opus-5` vs `claude-fable-5`. 추천은 휴리스틱이 내고 **결정은 사용자**가
  init 시 AskUserQuestion 으로 내린다. 워치독은 레지스트리에 기록된 모델로 재기동한다

## 2. 경로 계약

| 구분 | 경로 |
|---|---|
| 개발 사본(이 폴더) | `...\Claude Harnes\autoharness\` |
| 설치 위치(스킬+코드) | `%USERPROFILE%\.claude\skills\autoharness\` (SKILL.md, bin\, templates\) |
| 런타임 상태 | `%USERPROFILE%\.claude\autoharness\` (registry.json, logs\, watchdog.lock) |
| 대상 저장소 내 생성물 | `.claude/agent_tracker.json`, `.claude/agent_tracker.example.json`, `.claude/harness-logs/`, `.claude/harness-state.json`, `.claude/harness-heartbeat.json`, `.claude/HARNESS_PAUSED`(플래그), `scripts/harness_engine.py`(엔진 사본), `scripts/agent_harness.sh`, `PROGRESS.md` |
| Python | 3.8+ (stdlib만 사용; Windows 는 `python`, Linux/WSL 은 `python3`) |
| claude CLI | `%USERPROFILE%\.local\bin\claude.exe` 또는 PATH (2.1.183 실측; `-p`, `--model`, `--permission-mode`, `--dangerously-skip-permissions` 확인됨. `--max-turns` 미확인 → 사용 금지) |

개발 사본 파일 목록:

```
autoharness/
  DESIGN.md                      ← 이 문서
  README.md                      ← 사용자용 안내 (설치/사용/제거/구조)
  install.ps1                    ← 설치·등록·제거 스크립트
  bin/harness_engine.py          ← 엔진 (상태 장부·러너·훅·자가검증) — 완성됨, 계약의 기준
  bin/harness_mcp.py             ← MCP stdio 서버 (엔진 import)
  bin/harness_watchdog.py        ← 워치독 (스케줄러가 15분마다 1회 실행)
  skill/SKILL.md                 ← 개인 스킬 본문
  templates/agent_harness.sh     ← 대상 저장소용 진입 래퍼
  templates/CLAUDE.md.tmpl       ← 대상 저장소 CLAUDE.md 골격 (<확인 필요> 플레이스홀더 포함)
  templates/bootstrap_prompt.txt ← 워치독이 claude -p 에 넘기는 재개 프롬프트
```

## 3. 공통 구현 규칙 (모든 Python 파일)

- Python 3.9 호환, **stdlib 만** 사용. 파일 첫 부분에서 `sys.stdout/stderr` 를
  `reconfigure(encoding="utf-8", errors="replace")` 하고 **`sys.stdin` 도 반드시 포함**한다
  (훅 stdin 이 cp949 로 디코드되면 한글 명령이 surrogate 로 오염되어 차단 로직이 fail-open
  으로 뒤집힌다 — 적대 검증에서 실측된 critical). 모든 `open()` 에 `encoding="utf-8"`.
  자식 프로세스 출력 디코드는 utf-8 → 로케일 코드페이지 → utf-8 replace 순 폴백.
- JSON 쓰기는 전부 **원자적**: 같은 디렉토리에 `.tmp` 작성 → `os.replace`. replace 가
  일시적 `PermissionError`(OneDrive 동기화·백신 잠금)를 맞으면 지수 백오프
  0.1→0.2→0.4→0.8초, 총 5회 시도 후 실패 처리한다(다른 OSError 는 즉시 전파).
- 훅 서브커맨드는 **fail-open**: 내부 예외 시 exit 0 (일반 작업을 깨지 않는다). 러너·MCP는 fail-loud.
- 타임스탬프는 `datetime.now(timezone.utc).isoformat()`.

## 4. 엔진 CLI 표면 (`python scripts/harness_engine.py <cmd>`) — 구현 완료 기준

`bin/harness_engine.py` 가 이미 작성되어 있으며 **이 파일이 계약의 실체다**. 다른 컴포넌트는
이 CLI/함수 표면에 맞춘다.

| 커맨드 | 역할 | 종료 코드 |
|---|---|---|
| `detect [--repo P]` | 스택 실측 JSON 출력 | 0/2 |
| `init --repo P --project N --objective O --source S --target T --test CMD [--build CMD] [--lint CMD] [--model M] [--max-attempts 5]` | 장부·예시·로그 디렉토리 생성 | 0/2 |
| `add-task --id I --title T [--path P] [--deps a,b] [--priority 100] [--test-cmd CMD]` | 작업 추가 (자기/순환/미존재 의존 거부) | 0/2 |
| `set-task --id I [--status pending\|blocked] [--note ...] [--test-cmd CMD]` | 제한적 상태 조작 (`done` 설정 불가). `--test-cmd ""` 는 작업 전용 test 해제 | 0/2 |
| `next` | 의존성 게이팅 통과한 다음 작업 JSON(교착 pending 은 `deadlocked` 로 병기) | 0/3 |
| `run [--task I] [--cmd C]` | build→test→lint 실행, 로그·요약·장부 갱신, PROGRESS.md 재렌더. 스테이지 실행 중 5분 주기 하트비트 자동 갱신 | 0/1/2/3/4 |
| `sync-commit` | commit 없는 최신 done 작업에 HEAD SHA 기록 | 0 |
| `render` | PROGRESS.md 재렌더 | 0 |
| `brief` | 15줄 이하 상태 요약(SessionStart 훅용) — 교착 pending 이 있으면 경고 줄 추가 | 0 |
| `status` | 장부 요약 JSON(`deadlocked` 목록 포함) | 0/2 |
| `heartbeat` | 하트비트 갱신 | 0 |
| `model-recommend [--source S] [--target T] [--notes ...]` | 모델 추천 JSON | 0 |
| `hook-prebash` | stdin=훅 JSON. 금지 명령 차단(exit 2+stderr), 커밋 게이트, 하트비트 | 0/2 |
| `hook-postbash` | stdin=훅 JSON. `git commit` 후 sync-commit, 하트비트 | 0 |
| `hook-stop` | stdin=훅 JSON. 자율 주행 게이트(아래 §8) | 0 |
| `selftest` | 7종 15항목 자가 검증을 임시 샌드박스에서 실행, PASS/FAIL 출력 | 0/1 |

**run 의 종료 코드 계약** (상위 에이전트 분기 신호 — 절대 변경 금지):

| 코드 | 의미 | 에이전트 행동 |
|---|---|---|
| 0 | 검증 통과 (task→done) | 커밋 후 다음 작업 |
| 1 | 검증 실패 (attempts+1, last_error 기록) | 자가 치유 계속 |
| 2 | 사용법/설정 오류 | 중단·보고 |
| 3 | 진행 가능한 작업 없음 | 중단·보고 |
| 4 | max_attempts 도달 (task→blocked) | 해당 작업 봉인 — 남은 작업 있으면 계속, 없으면 중단·보고 |

※ `run` 은 ①이미 blocked 인 작업 지정 ②blocked 만 남고 진행 가능 작업이 없는 상태에서도 4 를
반환한다(같은 상태에서 `next` 는 3). 세 문서(SKILL/tmpl/README)도 동일 문구를 유지한다.

로그: 전체 출력은 `.claude/harness-logs/<task>-<UTC ts>.log`(같은 초 재실행 시 `-N` 접미로
이전 로그 보존). stdout 요약은 에러 패턴 라인 최대 60줄 × 400자(패턴 없으면 tail 30줄).
`last_error` 는 4000자 상한. 금지 명령·commit 탐지 정규식은 전부 IGNORECASE 이며 `git clean`
은 플래그 재배치(`-d -f`)·`--force` 표기까지 차단한다.

## 5. 장부 스키마 (`.claude/agent_tracker.json`)

```json
{
  "schema_version": 1,
  "project": "이름", "objective": "이번 작업 목적",
  "source_stack": "...", "target_stack": "...",
  "model": "claude-opus-5 | claude-fable-5",
  "commands": {"build": "명령|null", "test": "명령", "lint": "명령|null", "timeout_sec": 1800},
  "max_attempts": 5,
  "created_at": "ISO", "updated_at": "ISO",
  "tasks": [{
    "id": "t1", "title": "...", "path": "상대경로|null", "deps": [], "priority": 100,
    "status": "pending|in_progress|done|failed|blocked",
    "attempts": 0, "last_error": null, "last_log_file": null, "commit": null,
    "started_at": null, "finished_at": null, "test_cmd": null
  }]
}
```

- 명령 문자열 안의 `{path}` 는 task.path 로 치환된다. task.test_cmd 가 있으면 test 를 대체
  (설정: `add-task/set-task --test-cmd`, MCP `task_add/task_set` 의 `test_cmd`. `""` 로 해제).
- 선택 규칙(`next`): ① `in_progress` ② attempts<max 인 `failed` ③ deps 전부 `done` 인
  `pending` — 각 그룹 내 priority 낮은 값 우선, 그다음 id 순.
- `add-task` 는 자기 의존·순환 의존·미존재 의존을 거부한다(exit 2). 손편집 등으로 이미
  들어간 교착 pending(의존이 미존재·blocked·순환이라 영영 실행 불가)은 `next`/`brief`/
  `status` 가 `deadlocked` 로 구분해 알린다 — 종료 코드 계약은 그대로다(next 는 여전히 0/3).
- `PROGRESS.md` 는 장부에서 렌더되는 산출물이다. 손 편집 금지 문구를 머리에 박는다.

## 6. MCP 서버 (`bin/harness_mcp.py`)

- **개행 구분 JSON-RPC 2.0 stdio**. 외부 SDK 금지(stdlib). 잘못된 줄에도 크래시 금지(stderr 로그).
- `initialize` → `{"protocolVersion": <요청 값 그대로>, "capabilities": {"tools": {"listChanged": false}}, "serverInfo": {"name": "autoharness", "version": "1.0.0"}}`
- `notifications/initialized`·기타 notification(id 없음) → 무응답. `ping` → `{}`.
- `tools/list` → 아래 14개. `tools/call` → 결과를 `{"content":[{"type":"text","text":"<JSON pretty>"}]}` 로,
  실패는 `"isError": true` + 메시지. 미지 메서드 → JSON-RPC error -32601.
- 엔진은 `bin/harness_engine.py` 를 import 해서 함수로 호출한다(서브프로세스 아님).
  단 `harness_run` 만은 대상 저장소의 `scripts/harness_engine.py` 사본을 **서브프로세스로** 실행해
  종료 코드를 그대로 받는다(사본과 원본의 드리프트 허용).

| 도구 | 입력(required*) | 동작 |
|---|---|---|
| `harness_detect` | repo_path* | 스택 실측 결과 반환 |
| `harness_init` | repo_path*, project*, objective*, source_stack*, target_stack*, test_cmd*, build_cmd, lint_cmd, model, max_attempts, permission_mode("bypass"\|"acceptEdits") | 장부/예시/로그 생성 + 엔진 사본·래퍼 설치 + settings.json 훅·권한 병합(원본 `.bak-<ts>` 백업) + 레지스트리 등록 |
| `harness_status` | repo_path* | 장부·하트비트·레지스트리 요약 |
| `harness_run` | repo_path*, task_id, cmd | 러너 실행, `{exit_code, summary, task}` 반환 |
| `task_add` | repo_path*, id*, title*, path, deps, priority, test_cmd | 작업 추가 (completed 프로젝트면 레지스트리 active 복귀+백오프 리셋) |
| `task_set` | repo_path*, id*, status, note, test_cmd("" 로 해제) | pending/blocked 만 허용 |
| `harness_pause` | repo_path* | PAUSED 플래그 생성 + 레지스트리 paused |
| `harness_resume_project` | repo_path* | 플래그 제거 + active + 백오프 리셋 |
| `model_recommend` | repo_path, source_stack, target_stack, notes | 추천+근거 (§9 휴리스틱) |
| `model_set` | repo_path*, model* | 장부·레지스트리 모델 갱신 (두 값만 허용) |
| `heartbeat` | repo_path* | 하트비트 갱신 |
| `watchdog_install` | interval_minutes(기본 15) | schtasks 사용자 작업 `AutoHarnessWatchdog` 생성(/F 갱신) |
| `watchdog_uninstall` | — | schtasks 삭제 |
| `watchdog_status` | — | schtasks 조회 + 레지스트리 + watchdog.log tail |

`harness_init` 의 settings 병합: 기존 `.claude/settings.json` 을 로드해 `hooks` 4종(§8)과
`permissions.allow` 항목(`Bash(bash scripts/agent_harness.sh:*)`, `Bash(python scripts/harness_engine.py:*)`)을
**추가 병합**한다. 이미 `harness_engine.py` 를 담은 훅 항목이 있으면 중복 추가하지 않는다.

## 7. 레지스트리 (`%USERPROFILE%\.claude\autoharness\registry.json`)

```json
{
  "schema_version": 1,
  "settings": {"stale_minutes": 30, "probe_sec": 90, "max_consecutive_errors": 5,
               "limit_backoff_minutes": [30,60,120,240,360], "error_backoff_minutes": [15,30,60]},
  "projects": [{
    "id": "프로젝트명", "repo": "절대경로", "model": "claude-...-5",
    "permission_args": ["--dangerously-skip-permissions"],
    "status": "active|paused|completed|needs_human|error",
    "consecutive_errors": 0, "limit_hits": 0, "next_retry_at": null,
    "last_launch": {"ts": null, "result": null, "log": null},
    "created_at": "ISO", "updated_at": "ISO"
  }]
}
```

status 전이 규칙: `completed` 는 종점이 아니다 — MCP `task_add` 로 새 작업이 들어오면
active 로 복귀하고 백오프 카운터(consecutive_errors·limit_hits·next_retry_at)가 리셋된다.
`paused`(사용자 의사)·`needs_human`(사람 판단 대기)·`error`(진단 필요)는 작업 추가만으로
자동 재개하지 않는다 — `harness_resume_project` 가 명시적 복귀 수단이다.

## 8. 훅 계약 (대상 저장소 `.claude/settings.json` 에 병합)

CLAUDE.md 는 강제층이 아니므로 "특정 시점 무조건 실행" 규칙은 전부 훅으로 구현한다.
훅 명령은 **상대 경로**(`python scripts/harness_engine.py ...`, cwd=프로젝트 루트 전제)로 쓴다.

| 훅 | 명령 | 강제하는 규칙 |
|---|---|---|
| SessionStart | `... brief` | 세션 시작·compact 직후 장부 요약을 컨텍스트에 주입(진행 복구) |
| PreToolUse(Bash) | `... hook-prebash` | ① `git push`/`--force`/`reset --hard`/`clean -fd` 차단(exit 2) ② **커밋 게이트**: 직전 harness run 성공 없이 `git commit` 차단 ③ 커밋 허용 시 직전 HEAD 를 1회용 마커(`head_before_commit`)로 상태 파일에 기록 |
| PostToolUse(Bash) | `... hook-postbash` | `git commit` 직후 done 작업에 SHA 자동 기록 + 하트비트. **오귀속 방지**: prebash 마커와 대조해 HEAD 가 실제로 변한 경우에만 기록(nothing to commit 등 실패 커밋이 직전 SHA 를 가로채지 않는다). 마커 부재 시(수동 sync-commit·부분 설치)는 종전대로 기록 |
| Stop | `... hook-stop` | 자율 주행 게이트(아래) + 하트비트 |

**hook-stop 로직** (fail-open):
1. 하트비트 갱신(항상).
2. `CLAUDE_AUTOHARNESS` 환경변수가 `"1"` 이 아니면 exit 0 — 대화형 세션을 납치하지 않는다.
   (워치독이 헤드리스 세션에만 이 변수를 심는다.)
3. `.claude/HARNESS_PAUSED` 존재 → exit 0.
4. 진행 가능한 작업 없음(next=∅) → exit 0 (세션 종료 허용; 이후는 워치독 소관).
5. **진전 가드**: 장부 파일 해시가 직전 블록 때와 같으면 `stop_blocks++`, 다르면 1로 리셋.
   `stop_blocks >= 3` 이면 exit 0 (제자리걸음 — 토큰 방어를 위해 세션을 놓아주고 워치독에 맡긴다).
6. 그 외 → stdout 에 `{"decision":"block","reason":"다음 작업 <id> <title> 진행 지시…"}` 출력, exit 0.

## 9. 모델 추천 휴리스틱 (추천은 도구가, 결정은 사용자가)

점수 합산: 언어 간 이식(+3) / 테스트 부재·빈약(+2) / 모듈 5개 초과(+1) / LOC>10만(+1) /
LOC>30만(+1) / 요구 모호성 메모(+2). **합 ≥ 4 → `claude-fable-5`, 미만 → `claude-opus-5`**.

반환: `{"recommended": "...", "score": n, "rationale": [근거들], "decision": "user",
"comparison": {"claude-fable-5": "최상위 추론 — 교차 스택·모호한 사양·테스트 공백에 강함",
"claude-opus-5": "패턴형 대량 루프에 비용·속도 유리, /fast 지원"}}`.
스킬은 이 결과를 AskUserQuestion 으로 제시한다(추천안을 첫 옵션 + "(Recommended)").

## 10. 워치독 (`bin/harness_watchdog.py`)

스케줄러가 15분마다 실행하는 **1회성** 스크립트(데몬 아님). 플래그: `--dry-run`(판단만 출력,
기동 없음), `--status`. 단일 인스턴스 잠금: `watchdog.lock`(pid 기록, 살아 있으면 즉시 종료,
죽은 pid 면 탈취). 로그: `%USERPROFILE%\.claude\autoharness\logs\watchdog.log`(1MB 초과 시 절반 절사).

프로젝트별 판단(순서 고정):
1. status ≠ active → 스킵 (paused/completed/needs_human/error).
2. `next_retry_at` 이 미래 → 스킵 (백오프 중).
2.5. 저장소에 `.claude/HARNESS_PAUSED` 플래그 존재 → 스킵 (MCP 없이 플래그만 만든 폴백
   일시정지도 존중한다).
3. 장부 읽기 실패/부재 → error 처리(연속 오류 집계).
4. 진행 가능 작업 없음: 전부 done → `completed`. blocked 존재 → `needs_human`. → 스킵.
5. 하트비트가 `stale_minutes` 이내 → 스킵 (세션 살아 있음 — 이중 기동 방지). run 이
   스테이지 실행 중 5분 주기로 하트비트를 갱신하므로(엔진 HeartbeatPump) timeout_sec
   상한(기본 1800초)까지 걸리는 장시간 검증도 사망으로 오판하지 않는다.
6. **기동**: `claude -p <bootstrap_prompt> --model <model> <permission_args...>`,
   cwd=repo, env 에 `CLAUDE_AUTOHARNESS=1` 추가, stdout+stderr → `logs/<project>-<ts>.log`.
   `probe_sec`(90초) 동안 5초 간격 폴링. **분류 우선순위 고정**:
   - ① 90초 생존 **또는 조기 정상 종료(rc=0)** → **ok**: `consecutive_errors`·`limit_hits`
     모두 0 리셋, `next_retry_at=null`, 핸들 닫고 분리(detach). rc=0 을 패턴 검사보다 먼저
     본다 — 정상 출력 속 `429`/`quota` 류 우연 문자열 오탐 방지.
   - ② 조기 비정상 종료 & 로그 tail 에 사용량 패턴(대소문자 무시: `usage.?limit`,
     `rate.?limit`, `limit reached`, `too many requests`, `overloaded`, `\bquota\b`,
     `credit balance`, `out of (extra )?usage`, 그리고 `429` 는 api error/status/code/http
     문맥 인접 시에만 — "collected 429 items" 오탐 방지) → **limit**: `limit_hits++`,
     `next_retry_at = now + limit_backoff[min(limit_hits-1, 끝)]`. 영구 포기 없음.
   - ③ 그 외 조기 비정상 종료 → **error**: `consecutive_errors++`,
     `next_retry_at = now + error_backoff[...]`. `>= max_consecutive_errors` 면 status=error
     (사람 확인 필요 — watchdog.log 에 사유 기록).
   claude 실행 파일 해석은 `.exe` 를 우선한다(.bat/.cmd 심은 cmd 재해석으로 프롬프트 인용이
   깨진다): which 결과가 .bat/.cmd 면 claude.exe → 고정 폴백 경로 순으로 대체.
7. 모든 판단·행동을 watchdog.log 한 줄씩 기록.

## 11. 스킬 (`skill/SKILL.md`)

frontmatter `name: autoharness`, description 은 트리거 문구 포함(하네스, autoharness, 자율
마이그레이션 구축/재개/상태/일시정지, headless bootstrap) — **여기에 결과 서술형 트리거
(검증·수정·이식·고도화 등)를 반드시 포함한다**. description 이 메커니즘 어휘만 담으면 결과로
말한 요청에서 스킬이 아예 뜨지 않는다.

### 모드 판정 계약 (실사용 결함에서 도출 — 위반 시 스킬이 무력화된다)

사용자는 대개 *메커니즘*("하네스를 깔아줘")이 아니라 *결과*("검증하고 문제 있으면 수정",
"master 승격 가능한지 확인")로 말한다. 모드 표의 따옴표 문구는 **예시일 뿐 매칭 조건이 아니다**.

1. 저장소를 상대로 한 **다단계 작업 요청은 전부 이 스킬의 대상**이다(이식·리팩터링·결함
   검증 및 수정·테스트 확충·릴리스/승격 준비·고도화).
2. 어느 모드도 확실하지 않으면 **장부(`.claude/agent_tracker.json`) 존재로 판정**한다 —
   있으면 `task_add` 로 적재 후 **resume**, 없으면 **init**. 장부가 있는데 init 을 재실행하면
   진행 상태가 소실되므로 금지.
3. 단발성 질의·코드 설명·파일 한 곳 수정은 대상이 아니다(스킬 없이 직접 처리).
4. **모드 불일치를 이유로 장부·검증 게이트·훅 없이 맨손으로 다단계 작업을 수행하는 것을
   금지**한다 — 커밋 게이트·금지 명령 차단·테스트 약화 금지·Stop 게이트·워치독이 전부
   무력화되는 조용한 실패다.

이 계약은 `tests/test_skill_contract.py` 가 회귀 검사한다(모드 4종·종료 코드 표↔엔진 상수·
폴백 조항·폴백 표↔실제 CLI 표면 일치). 엔진은 `build_parser()` 로 CLI 표면을 노출해 문서
드리프트를 기계적으로 잡는다.

본문 모드 4개:

- **init**: ① `harness_detect` + 실제 테스트 명령 1회 실행(실측 표 출력, 테스트 부재 시 중단·보고)
  ② `model_recommend` → AskUserQuestion(사용자 결정) ③ `harness_init` ④ CLAUDE.md 를
  `templates/CLAUDE.md.tmpl` 기반으로 작성(200줄 미만, 기존 파일은 병합+백업) ⑤ 마이그레이션
  계획을 task_add 로 장부에 적재 ⑥ `selftest` 로 7종 15항목 검증(출력 첨부) ⑦ `watchdog_install`
  ⑧ 보고(실측 표/생성 파일 표/훅 이관 목록/검증 로그/사람 판단 필요 항목/다음 세션 시작 명령)
- **resume**: 장부 읽기 → heartbeat → 루프(다음 작업 구현 → `bash scripts/agent_harness.sh
  --task <id>` → 종료 코드 분기표 → 커밋 → 반복). 검증 무결성 조항(테스트 약화 금지 등),
  사람 경계 조항을 본문에 명시. 질문 금지.
- **status**: `harness_status` + `watchdog_status` 요약.
- **pause / resume-project**: 플래그 토글.

스킬 본문에 MCP 도구 전체 이름(`mcp__autoharness__harness_detect` 등)을 명시한다.
MCP 서버가 안 잡히는 환경(등록 전)을 위한 폴백: `python scripts/harness_engine.py ...` 직접 실행.

## 12. install.ps1

- `-Install`(기본): 스킬 폴더로 복사(기존은 `.bak-<ts>` 백업 후 교체, **install.ps1 자신도
  복사** — 설치본에서 -Watchdog/-Uninstall 재실행 가능해야 한다), 런타임 디렉토리 생성,
  `claude mcp remove -s user autoharness`(실패 무시) → `claude mcp add -s user autoharness --
  <python절대경로> <bin\harness_mcp.py 절대경로>`, 결과 검증 출력.
- `-Watchdog`: **ScheduledTasks cmdlet(Register-ScheduledTask)** 로 등록(15분 간격, pythonw).
  schtasks `/TR` 은 PS 5.1 네이티브 인자 전달에서 내부 따옴표가 소실되어 공백 경로가 조각나므로
  install.ps1 에서는 금지(MCP 쪽 subprocess 리스트 전달은 안전하므로 schtasks 허용).
- `-Uninstall`: schtask 삭제 + mcp remove + 스킬 폴더 제거(런타임 상태는 보존).
- PowerShell 5.1 호환(`&&` 금지, 삼항 금지).

## 13. 검증 계약 (적대적 검증 에이전트용)

전부 **실행으로 증명**한다. 샌드박스는 스크래치패드 아래에 만들고 실제 레지스트리/스케줄러를
건드리는 검증은 dry-run 또는 임시 이름을 쓴다.

1. selftest 7종 15항목(장부 초기화/실패 경로 exit1+attempts/성공 경로 exit0+done/한도
   exit4+blocked/의존성 게이팅/PROGRESS.md 렌더/더미 정리) 통과
2. MCP 핸드셰이크: initialize→initialized→tools/list→tools/call(harness_detect)→미지 메서드
   -32601 을 파이프로 실측
3. 훅 3종: hook-prebash 차단/허용/커밋 게이트, hook-stop 게이트 6단계(env 미설정 통과·PAUSED
   통과·진전 가드), hook-postbash SHA 동기화 — stdin JSON 을 먹여 실측
4. 워치독: --dry-run 판단 경로(백오프/하트비트 신선/completed 전이), 사용량 패턴 분류 단위 검증
5. 한글 경로·cp949 콘솔에서 출력 깨짐 없음 (chcp 949 상태에서 brief/run 실행)
6. 문서 정합: SKILL.md·CLAUDE.md.tmpl·README 가 이 계약의 이름/경로/종료 코드와 일치
