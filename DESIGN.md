# AutoHarness 설계 계약

> 이 문서는 빌더·검증 에이전트가 공유하는 **단일 계약**이다. 여기 정의된 파일 경로, CLI 표면,
> 스키마, 종료 코드, 도구 이름은 임의로 바꾸지 않는다. 변경이 필요하면 이 문서를 먼저 고친다.

## 1. 목적

Claude Code 프롬프트로만 존재하던 "자율 주행 마이그레이션 하네스 구축" 절차를
**어느 저장소에서든 재사용 가능한 패키지**로 만든다. 구성은 셋이 결합된 하나의 패키지다.

1. **개인 스킬** `autoharness` — 절차(실측→구축→모델 선택→검증→자율 주행)를 코드화한 지휘 문서
2. **사용자 스코프 MCP 서버** `autoharness` — 상태 장부·러너·레지스트리 관리를 결정적으로 수행
3. **상주 데몬** — 자기 시계로 주기를 돌며, 세션이 죽어도(사용량 초과 포함) 자동 부활시킨다

필수 요구사항:
- **무개입**: 주행 중 사용자 질문 금지. Stop 훅 게이트 + 헤드리스 재기동으로 루프 유지
- **사용량 초과 방어**: 빠른 실패를 사용량 초과로 분류하면 지수 백오프(30→60→120→240→360분)로
  재시도. 절대 영구 포기하지 않는다(자동 부활). 설정 오류성 실패는 5회 연속 시 `error`로 정지(방어)
- **모델 선택**: `claude-opus-5` vs `claude-fable-5`. 추천은 휴리스틱이 내고 **결정은 사용자**가
  init 시 AskUserQuestion 으로 내린다. 데몬은 레지스트리에 기록된 모델로 재기동한다

## 2. 경로 계약

| 구분 | 경로 |
|---|---|
| 개발 사본(이 폴더) | `...\Claude Harnes\autoharness\` |
| 설치 위치(스킬+코드) | `%USERPROFILE%\.claude\skills\autoharness\` (SKILL.md, bin\, templates\) |
| 런타임 상태 | `%USERPROFILE%\.claude\autoharness\` (registry.json, logs\, watchdog.lock) |
| 대상 저장소 내 생성물 | `.claude/agent_tracker.json`, `.claude/agent_tracker.example.json`, `.claude/harness-logs/`, `.claude/harness-state.json`, `.claude/harness-heartbeat.json`, `.claude/harness-hooks-seen.json`(훅 발화 마커), `.claude/HARNESS_PAUSED`(플래그), `PROGRESS.md` |
| claude CLI | `%USERPROFILE%\.local\bin\claude.exe` 또는 PATH (2.1.183 실측; `-p`, `--model`, `--permission-mode`, `--dangerously-skip-permissions` 확인됨. `--max-turns` 미확인 → 사용 금지) |

개발 사본 파일 목록:

```
autoharness/
  DESIGN.md                      ← 이 문서 (구현 무관 계약)
  README.md                      ← 사용자용 안내
  install.ps1 / install.sh       ← 설치기 (바이너리만 내려놓고 나머지는 EXE 에 위임)
  daemon/                        ← 구현 (TypeScript, 단일 EXE 로 컴파일)
    DESIGN.md                    ← 구현 계약
  skill/SKILL.md                 ← 개인 스킬 본문
  scripts/                       ← 이 저장소 전용 도구(검증 파이프라인·배포 명세)
  templates/CLAUDE.md.tmpl       ← 대상 저장소 CLAUDE.md 골격
  templates/bootstrap_prompt.txt ← 데몬이 claude -p 에 넘기는 재개 프롬프트
```

## 3. 구현 계약

구현은 TypeScript 단일 실행 파일 하나다. 실행 모드·종료 코드·원자적 쓰기·훅 시작 시간
예산 같은 구현 계약은 **`daemon/DESIGN.md`** 가 정한다 — 이 문서와 충돌하면 그쪽이 우선한다.

이 문서가 정하는 것은 구현과 무관한 계약이다: 경로, 장부·레지스트리 스키마, 훅 규약,
모델 추천 휴리스틱, 스킬 절차, 설치·배포 경계, 검증 기준.

## 4. 장부 스키마 (`.claude/agent_tracker.json`)

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

## 5. MCP 서버 (`<EXE> mcp`)

- **개행 구분 JSON-RPC 2.0 stdio**. 외부 SDK 금지(stdlib). 잘못된 줄에도 크래시 금지(stderr 로그).
- `initialize` → `{"protocolVersion": <요청 값 그대로>, "capabilities": {"tools": {"listChanged": false}}, "serverInfo": {"name": "autoharness", "version": "1.0.0"}}`
- `notifications/initialized`·기타 notification(id 없음) → 무응답. `ping` → `{}`.
- `tools/list` → 아래 14개. `tools/call` → 결과를 `{"content":[{"type":"text","text":"<JSON pretty>"}]}` 로,
  실패는 `"isError": true` + 메시지. 미지 메서드 → JSON-RPC error -32601.
- 데몬이 떠 있으면 웹 API 로 위임하고, 없으면 인프로세스로 처리한다(daemon/DESIGN.md 2절).

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
| `watchdog_status` | — | schtasks 조회 + 레지스트리 + watchdog.log tail + `health` 진단(§10) |

`harness_init` 의 settings 병합: 기존 `.claude/settings.json` 을 로드해 `hooks` 4종(§7)과
`permissions.allow` 항목(`Bash("<EXE>" run:*)`, `Bash("<EXE>" next:*)`)을 **추가 병합**한다.
이미 같은 훅이 있으면 중복 추가하지 않고, 낡은 것은 항목 단위로 고쳐 쓴다(§11).

## 6. 레지스트리 (`%USERPROFILE%\.claude\autoharness\registry.json`)

```json
{
  "schema_version": 1,
  "settings": {"stale_minutes": 30, "probe_sec": 90, "max_consecutive_errors": 5,
               "limit_backoff_minutes": [30,60,120,240,360], "error_backoff_minutes": [15,30,60],
               "watchdog_installed_at": "ISO", "watchdog_interval_minutes": 15},
  "last_tick": "ISO",
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

**쓰기 무결성 계약**(적대 검증에서 실측된 결함 2건):

- **파손은 부재와 다르다.** 쓰기 경로(`registry_load`)는 파손된 registry.json 을 기본값으로
  대체하지 않는다 — `.corrupt-<ts>` 로 대피시킨 뒤 중단한다. 종전에는 둘 다 기본값으로
  대체돼, 파손 상태에서 무언가를 등록하면 이어지는 저장이 **등록된 프로젝트를 전부 지웠고**
  성공 보고까지 나갔다. 읽기 전용 진단(`harness_status`·`watchdog_status`)은 파손 상태에서도
  답하되 `registry_state`(ok|missing|corrupt)를 함께 보고한다.
- **워치독은 통째로 되쓰지 않는다.** 주기 끝 저장은 디스크를 다시 읽어 **이번 주기에 실제로
  바꾼 프로젝트의 소유 필드만**(`status`·`consecutive_errors`·`limit_hits`·`next_retry_at`·
  `last_launch`·`updated_at`) 병합한다. 종전에는 주기 시작의 메모리 사본을 통째로 저장해,
  주기 도중 MCP 가 기록한 변경(task_add 재활성화·pause·model_set·설치 스탬프)이 조용히
  되돌려졌다 — completed 프로젝트에 작업을 넣어도 다음 주기가 되돌리면 자동 부활이 영구
  무효가 되는 경로였다.

`last_tick` 은 워치독이 **한 주기라도 실제로 돌았다**는 증거로, 기동 여부와 무관하게 매
실행(dry-run 제외) 끝에 기록된다. `last_launch` 는 헤드리스 세션을 실제로 띄웠을 때만
갱신되므로 skip/completed 주기에는 null 로 남는다 — 둘을 섞으면 "워치독이 죽었다"와
"띄울 일이 없었다"를 구분하지 못한다. `settings.watchdog_installed_at` 은 설치 직후
유예 판정(아래 §10)의 기준이다.

status 전이 규칙: `completed` 는 종점이 아니다 — MCP `task_add` 로 새 작업이 들어오면
active 로 복귀하고 백오프 카운터(consecutive_errors·limit_hits·next_retry_at)가 리셋된다.
`paused`(사용자 의사)·`needs_human`(사람 판단 대기)·`error`(진단 필요)는 작업 추가만으로
자동 재개하지 않는다 — `harness_resume_project` 가 명시적 복귀 수단이다.

## 7. 훅 계약 (대상 저장소 `.claude/settings.json` 에 병합)

CLAUDE.md 는 강제층이 아니므로 "특정 시점 무조건 실행" 규칙은 전부 훅으로 구현한다.
훅 명령은 엔진을 **`${CLAUDE_PROJECT_DIR}` 로 뿌리내려** 쓴다
(`"<설치된 EXE>" <op> --repo "${CLAUDE_PROJECT_DIR}"`). 훅 핸들러는 프로젝트 루트가
아니라 **현재 작업 디렉토리에서 실행**되므로(공식 훅 문서), 상대 경로로 쓰면 하위 디렉토리로
이동하는 순간 게이트 4종이 전부 죽는다 — 실측으로 확인된 결함이다. `merge_settings` 는 기존
저장소의 상대 경로 훅을 감지해 마이그레이션하고, 배선 진단은 `cwd_dependent_hooks` 로 알린다.

경로를 뿌리내리는 것만으로는 부족하다 — **대상 저장소도 함께 못 박는다**
(`... <op> --repo "${CLAUDE_PROJECT_DIR}"`). `--repo` 기본값이 `.` 이라 생략하면 엔진이 현재 작업
디렉토리를 저장소로 삼는다. 실측: 같은 `hook-prebash` 에 같은 페이로드를 먹였을 때 저장소
루트는 exit 2(차단), 하위 디렉토리는 exit 0(통과)였고 하위에 `.claude/` 가 새로 생겼다 — 커밋
게이트와 Stop 게이트가 cwd 하나로 사라지고, 발화 마커·하트비트도 그리로 흩어져 배선 진단이
발화를 보지 못한다. 경로 고정과는 **독립된 축**이며, 진단은 `repo_unpinned_hooks` 로 알린다.

| 훅 | 명령 | 강제하는 규칙 |
|---|---|---|
| SessionStart | `... brief` | 세션 시작·compact 직후 장부 요약을 컨텍스트에 주입(진행 복구) |
| PreToolUse(`Bash\|PowerShell`) | `... hook-prebash` | ① 금지 명령 게이트(`push`/`--force`/`reset --hard`/`clean -f`) ② **커밋 게이트**: 직전 harness run 성공 없이 `git commit` ③ 커밋이 일어날 수 있는 경로에서 직전 HEAD 를 1회용 마커(`head_before_commit`)로 기록. ①②의 **처리 방식은 컨텍스트가 정한다**(아래) |
| PostToolUse(`Bash\|PowerShell`) | `... hook-postbash` | `git commit` 직후 done 작업에 SHA 자동 기록 + 하트비트. **오귀속 방지**: prebash 마커와 대조해 HEAD 가 실제로 변한 경우에만 기록(nothing to commit 등 실패 커밋이 직전 SHA 를 가로채지 않는다). 마커 부재 시(수동 sync-commit·부분 설치)는 종전대로 기록 |
| Stop | `... hook-stop` | 자율 주행 게이트(아래) + 하트비트 |

**게이트 처리 방식은 컨텍스트가 정한다** (`gate_decision`) — 금지 명령 게이트와 커밋 게이트가
**같은 판정 함수**를 쓴다:

| 컨텍스트 | 처리 | 근거 |
|---|---|---|
| 헤드리스 (`CLAUDE_AUTOHARNESS=1`) | `deny` — exit 2 + stderr | 물어볼 사람이 없다 |
| 대화형 | `ask` — exit 0 + `permissionDecision:"ask"` | 사람이 승인·거부를 결정한다 |
| `HARNESS_PAUSED` 존재 | `ask` | 일시정지 = 사람이 직접 운전 중 |

위험 모델은 "**사람이 없을 때** 에이전트가 되돌릴 수 없는 일을 하는 것"이다. 종전 구현은 이를
무조건 exit 2 로 막아 사람이 눈앞에서 지시한 경우까지 덮었고, 사용자가 승인해도 실행이
불가능했다. `hook-stop` 은 처음부터 `CLAUDE_AUTOHARNESS` 로 헤드리스를 식별했으므로 같은
파일 안에서 기준이 갈렸던 것이다 — 이제 `is_headless_session()` 하나로 통일한다.

`ask` 는 Claude Code 훅 계약의 `hookSpecificOutput.permissionDecision` 값이며,
`allow`/`deny`/`ask`/`defer` 중 하나다. deny 는 stdout 을 쓰지 않고 ask 는 stderr 를 쓰지 않는다.

**hook-stop 로직** (fail-open):
1. 하트비트 갱신(항상).
2. `CLAUDE_AUTOHARNESS` 환경변수가 `"1"` 이 아니면 exit 0 — 대화형 세션을 납치하지 않는다.
   (워치독이 헤드리스 세션에만 이 변수를 심는다.)
3. `.claude/HARNESS_PAUSED` 존재 → exit 0.
4. 진행 가능한 작업 없음(next=∅) → exit 0 (세션 종료 허용; 이후는 워치독 소관).
5. **진전 가드**: 장부 파일 해시가 직전 블록 때와 같으면 `stop_blocks++`, 다르면 1로 리셋.
   `stop_blocks >= 3` 이면 exit 0 (제자리걸음 — 토큰 방어를 위해 세션을 놓아주고 워치독에 맡긴다).
6. 그 외 → stdout 에 `{"decision":"block","reason":"다음 작업 <id> <title> 진행 지시…"}` 출력, exit 0.

**훅 배선 비활성 감지** (경고 전용 — 주행을 막지 않는다):

세션 프로젝트 루트가 저장소 밖(상위 폴더)이면 저장소 `.claude/settings.json` 이 로드되지 않아
훅 4종이 전부 조용히 죽는다. 커밋 게이트·금지 명령 차단·Stop 게이트가 모두 무력인데 주행은
정상처럼 보이는 **조용한 실패**라, 엔진이 스스로 드러낸다.

- **발화 마커**: `hook-prebash`/`hook-postbash`/`hook-stop` 은 stdin 페이로드에 Claude Code
  런타임 필드(`session_id`·`hook_event_name`·`transcript_path`)가 있을 때만
  `.claude/harness-hooks-seen.json` 에 `{op: {ts, event, session_id}}` 를 남긴다.
  **하트비트의 `source=="hook"` 은 판정 근거가 될 수 없다** — 사람이 손으로 stdin 을 먹여도
  같은 기록이 남아 배선이 끊긴 저장소를 정상으로 오판한다(실측 확인된 허점).
- **판정**(`hook_wiring_status`): 저장소 설정(`settings.json` + `settings.local.json`)에
  마커를 남길 수 있는 하네스 훅이 등록돼 있는가 × 훅이 가리키는 실행 파일이 실재하는가 ×
  마커가 하나라도 있는가 → `not_registered`(수동 운용 — **경고 대상 아님**) /
  `broken_path`(경고) / `active` / `inactive`(경고).
  SessionStart(`brief`)는 stdin 을 읽지 않으므로 등록 집계에서 제외한다 — 영구 오탐 방지.
- **`broken_path`**(v2, daemon/DESIGN.md 5.2 절): 훅 명령에는 설치 시점의 절대 경로가 박히는데
  `.claude/settings.json` 은 저장소를 따라 다닌다. 다른 계정·기계로 옮기면 그 경로가 사라져
  게이트 4종이 통째로 죽는다(실측 2026-08-11). 이때 `inactive` 로 뭉개면 **처방이 틀린다** —
  "저장소 루트에서 실행하십시오"는 없는 파일에 아무 소용이 없다. 그래서 별도 상태로 가르고,
  이 상태는 **과거 발화 기록을 이긴다**(예전에 돌았어도 지금 없는 파일은 못 부른다).
  확인할 수 없는 형태(PATH 로 푸는 이름, `~`·`%VAR%`, cwd 상대 경로)는 죽었다고 단정하지
  않는다 — 오탐 금지.
- **보조 신호**: `done` 인데 커밋 SHA 가 비어 있는 작업 수(PostToolUse 미발화의 흔적)를 함께
  보고한다. 판정 자체는 마커만으로 내린다.
- **출력**: `run` 시작 시 stderr 경고 1줄(종료 코드·주행에는 영향 없음), `status` 의 `hooks`
  필드(`dead_engine_hooks` 포함), `brief` 는 경고 상태일 때만 경고 줄(정상·미등록 저장소에는
  잡음을 더하지 않는다).
- **복구**: `autoharness install --migrate <저장소>` 가 죽은 절대 경로를 현재 실행 파일로 다시
  쓴다(기존 설정은 백업).

## 8. 모델 추천 휴리스틱 (추천은 도구가, 결정은 사용자가)

점수 합산: 언어 간 이식(+3) / 테스트 부재·빈약(+2) / 모듈 5개 초과(+1) / LOC>10만(+1) /
LOC>30만(+1) / 요구 모호성 메모(+2). **합 ≥ 4 → `claude-fable-5`, 미만 → `claude-opus-5`**.

반환: `{"recommended": "...", "score": n, "rationale": [근거들], "decision": "user",
"comparison": {"claude-fable-5": "최상위 추론 — 교차 스택·모호한 사양·테스트 공백에 강함",
"claude-opus-5": "패턴형 대량 루프에 비용·속도 유리, /fast 지원"}}`.
스킬은 이 결과를 AskUserQuestion 으로 제시한다(추천안을 첫 옵션 + "(Recommended)").

## 9. 자동 부활 (상주 데몬)

스케줄러가 15분마다 실행하는 **1회성** 스크립트(데몬 아님). 플래그: `--dry-run`(판단만 출력,
기동 없음), `--status`. 단일 인스턴스 잠금: `watchdog.lock`(pid 기록, 살아 있으면 즉시 종료,
죽은 pid 면 탈취). 로그: `%USERPROFILE%\.claude\autoharness\logs\watchdog.log`(1MB 초과 시 절반 절사).

프로젝트별 판단(순서 고정):
1. status ≠ active → 스킵 (paused/completed/needs_human/error).
2. `next_retry_at` 이 미래 → 스킵 (백오프 중).
2.5. 저장소에 `.claude/HARNESS_PAUSED` 플래그 존재 → 스킵 (MCP 없이 플래그만 만든 폴백
   일시정지도 존중한다).
3. 장부 읽기 실패/부재 → error 처리(연속 오류 집계).
4. 진행 가능 작업 없음 — **세 상태를 구분한다**(뭉개면 자동 부활이 조용히 무효가 된다):
   - **장부에 작업이 아예 없음**(init 직후) → 전이하지 않고 스킵. `completed` 로 봉인하면
     이후 작업을 적재해도 1단계에서 `status!=active` 로 스킵돼 다시는 기동하지 않는다.
   - **blocked 또는 교착 pending 존재** → `needs_human`. 교착 pending 은 엔진이
     `next`/`brief`/`status` 에서 1급 개념으로 다루므로 종점 판정도 같은 기준을 쓴다.
   - **그 외(전부 done)** → `completed`.
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
8. 주기 끝에 레지스트리 `last_tick` 을 갱신한다(기동 여부 무관, `--dry-run` 제외).

**'등록만 되고 실행 안 됨' 감지** (`watchdog_status` 의 `health` — 경고 전용):

작업이 `Ready` 로 등록돼 있어도 스케줄러가 매 기동을 반려하면(실측: `0x800710E0` 요청 거부)
자동 부활 보장은 무효인데, 등록 여부만 보고하면 정상처럼 보인다. 그래서 **등록**과 **실제
실행 이력**을 분리해 판정한다.

| state | 조건 | 경고 |
|---|---|---|
| `not_registered` | schtasks 조회 실패 | 없음 |
| `grace` | 설치 후 경과 < 주기×3, **또는** 설치 스탬프가 없고 스케줄러가 `0x41303`(미실행)을 보고하며 실행 흔적도 없음 | 없음(오탐 금지) |
| `stale` | 실행 흔적이 전혀 없거나(로그 부재 + `last_tick` 없음), 실행 흔적이 주기×3 경과 | 있음 |
| `healthy` | 그 외 | 없음 |

- **결과 코드 해석**: `LastTaskResult` 를 부호 없는 16진수로 정규화해 뜻과 함께 보고한다
  (`0x800710E0` 요청 거부, `0x8004131F` 인스턴스 중복, `0x80070002` 경로 없음 등).
  `0x41300/0x41301/0x41303`(준비됨·실행 중·미실행)은 정보성이라 실패로 세지 않는다.
  실패 코드는 `grace` 중에도 숨기지 않는다.
- **실행 흔적의 정의**: watchdog.log 의 나이와 레지스트리 `last_tick` 의 나이 중 **더 최근인
  값**이다(`evidence_age_minutes`). 임계를 로그에만 걸면 로그 파일이 사라진 환경에서 마지막
  틱이 며칠 전이어도 healthy 로 보고된다 — 이 모듈이 존재하는 이유인 상태를 정확히 그
  자리에서 놓친다. 보조 신호의 서술도 tick 나이를 보고 "돌고 있습니다"와 "멈춰 있습니다"를
  가른다(오래된 tick 을 생존 근거로 쓰지 않는다).
- **주기 출처**: 등록된 작업 XML 의 `<Interval>` 을 파싱한다(실패 시 기본 15분).
- **보조 신호**: 전 프로젝트 `last_launch=null` 이면 함께 제시하되, `last_tick` 유무로
  "워치독 미실행 의심"과 "기동 조건이 매번 스킵됨"을 구분해 서술한다 — 이 구분이 없으면
  정상 운용 중인 저장소를 죽은 것으로 오판한다(실측된 오탐).
- 로케일 차이로 schtasks 출력 파싱이 실패하면 필드는 null 로 두고 **경고하지 않는다**.
- **설치 스탬프**: 워치독 등록 경로는 셋이다 — MCP `watchdog_install`, `install.ps1 -Watchdog`,
  `install.sh --watchdog`. 셋 모두 등록 **성공 직후** `settings.watchdog_installed_at` 과
  `watchdog_interval_minutes` 를 기록한다(설치 스크립트는
  설치 시각·주기를 레지스트리에 기록한다). 기록은
  fail-open — 실패해도 설치를 중단하지 않는다. 등록 **전에** 스탬프를 찍으면 등록 실패가
  유예에 가려지므로 순서를 뒤집지 않는다(테스트로 고정).
- **스탬프 없는 기존 설치**는 `0x41303` 유예로 구제한다. 다만 트리거 오설정 등으로 그 상태가
  영구화되면 결과 코드가 미실행이 아닌 실패 코드로 바뀌므로 결과 코드 경고가 결함을 잡는다 —
  실제 반려(`0x800710E0`)는 스탬프 유무와 무관하게 언제나 경고한다.

## 10. 스킬 (`skill/SKILL.md`)

frontmatter `name: autoharness`, description 은 트리거 문구 포함(하네스, autoharness, 자율
마이그레이션 구축/재개/상태/일시정지, headless bootstrap) — **여기에 결과 서술형 트리거
(검증·수정·이식·고도화 등)를 반드시 포함한다**. description 이 메커니즘 어휘만 담으면 결과로
말한 요청에서 스킬이 아예 뜨지 않는다.

### 모드 판정 계약 (실사용 결함에서 도출 — 위반 시 스킬이 무력화된다)

사용자는 대개 *메커니즘*("하네스를 깔아줘")이 아니라 *결과*("검증하고 문제 있으면 수정",
"master 승격 가능한지 확인")로 말한다. 모드 표의 따옴표 문구는 **예시일 뿐 매칭 조건이 아니다**.

**평가 순서 고정: 대상화(1) → direct 제외(2) → 폴백(3).** direct 를 먼저 걸러야 폴백이 단발
작업까지 삼키지 않는다.

1. 저장소를 상대로 한 **다단계 작업 요청은 전부 이 스킬의 대상**이다(이식·리팩터링·결함
   검증 및 수정·테스트 확충·릴리스/승격 준비·고도화).
2. **direct(모드 없음)**: 단발성 질의·코드 설명·파일 한 곳 수정은 대상이 아니다(스킬 없이 직접
   처리). 이는 정식 결과이며 4번이 금지하는 "맨손"이 아니다. 착수 전 단계 수를 알 수 없는
   요청(버그·CI 복구)은 조사 후 범위가 커지면 승격한다.
3. 어느 모드도 확실하지 않고 direct 도 아니면 **장부(`.claude/agent_tracker.json`) 존재로
   판정**한다 — 있으면 `task_add` 로 적재 후 **resume**, 없으면 **init**. 장부가 있는데 init 을
   재실행하면 진행 상태가 소실되므로 금지.
4. **모드 불일치를 이유로 장부·검증 게이트·훅 없이 맨손으로 다단계 작업을 수행하는 것을
   금지**한다 — 커밋 게이트·금지 명령 차단·테스트 약화 금지·Stop 게이트·워치독이 전부
   무력화되는 조용한 실패다. 여기서 "맨손"은 *다단계인 줄 알면서* 게이트 없이 진행하는 경우다.
5. **폴백의 비대칭(안전)**: 폴백으로 도달한 resume 은 즉시 실행하되, **폴백으로 도달한 init 은
   고지·동의 후 실행**한다. init 은 훅 4종·권한 우회(`bypass`)·워치독 스케줄러를 설치하는
   비가역 환경 변경이라, 라우팅을 넓힌 대가로 읽기성 요청이 폴백에 떨어질 위험이 생겼다.
   명시적 하네스 구축 요청에는 고지가 필요 없다.
6. **모호 발화 해소**: "다시 돌려/재개" 는 `HARNESS_PAUSED` 존재로 resume-project ↔ resume 을
   가른다. 진단성 질의("왜 멈췄어", "뭐가 blocked 야")는 읽기 전용이므로 status 다.
7. **대상 저장소 절대경로를 먼저 확정**한다 — 현재 cwd 의 장부를 대상 장부로 오독하면 엉뚱한
   저장소를 주행한다.
8. **배포 한계선**: 이 스킬은 배포 가능 상태까지의 **검증과 로컬 커밋**만 한다. `git push`·
   태그 푸시는 훅이 차단하므로 작업에 넣지 않고 "사람 판단 필요 항목"에 남긴다.

이 계약은 `tests/test_skill_contract.py` 가 회귀 검사한다(모드 목록·종료 코드 표↔엔진 상수·
폴백 조항·안전 규칙·폴백 표↔실제 CLI 표면 일치·SKILL↔DESIGN 모드 목록 일치). 엔진은
`build_parser()` 로 CLI 표면을 노출해 문서 드리프트를 기계적으로 잡는다.

본문 모드(아래 목록은 SKILL.md 모드 표와 **일치해야 한다** — 테스트가 대조한다):

- **init**: ⓪ **장부 실존 확인(생략 금지)** — 있으면 중단하고 resume 으로 전환 ① `harness_detect`
  + 실제 테스트 명령 1회 실행(실측 표 출력, 테스트 부재 시 중단·보고)
  ② `model_recommend` → AskUserQuestion(사용자 결정) ③ `harness_init` ④ CLAUDE.md 를
  `templates/CLAUDE.md.tmpl` 기반으로 작성(200줄 미만, 기존 파일은 병합+백업) ⑤ 마이그레이션
  계획을 task_add 로 장부에 적재 ⑥ `selftest` 로 7종 15항목 검증(출력 첨부) ⑦ `watchdog_install`
  ⑧ 보고(실측 표/생성 파일 표/훅 이관 목록/검증 로그/사람 판단 필요 항목/다음 세션 시작 명령)
- **resume**: 대상 저장소 확정 → **0단계: 신규 결과 요청이면 `task_add` 로 적재**(생략하면 첫
  `next` 가 exit 3 을 내 "할 일 없음"으로 오보고된다) → 장부 읽기 → heartbeat → 루프(다음 작업
  구현 → `<EXE> run --repo . --task <id>` → 종료 코드 분기표 → 커밋 → 반복).
  검증 무결성 조항(테스트 약화 금지 등), 사람 경계 조항을 본문에 명시. 질문 금지.
- **status**: `harness_status` + `watchdog_status` 요약. 진단성 질의도 여기로 온다(읽기 전용).
- **pause**: `HARNESS_PAUSED` 플래그 생성 + 레지스트리 paused.
- **resume-project**: 플래그 제거 + active 복귀 + 백오프 리셋.
- **ops**: `watchdog_uninstall`·`model_set`·`task_set` 만 수행하는 운영 조작. 제거·모델 변경·
  작업 상태 전환 요청이 폴백을 타고 resume 으로 뒤집히는 정반대 오분기를 막는 행이다.

스킬 본문에 MCP 도구 전체 이름(`mcp__autoharness__harness_detect` 등)을 명시한다.
MCP 서버가 안 잡히는 환경(등록 전)을 위한 폴백: 설치된 실행 파일을 직접 호출.

## 11. 설치·배포 경계

### 12.0 배포 명세는 한 곳이다 (`scripts/deploy_manifest.py`)

"무엇을 설치본에 넣는가" 의 답은 **한 파일**에만 있다. 종전에는 세 구현(install.ps1 /
install.sh / deploy_live.py)이 각각 답했고 답이 달랐다 — install.ps1 이 `bin\*` 를 재귀
복사해 `__pycache__` 를 설치본에 넣고, install.sh 는 install.ps1 만 배포하고 자기는 빼는
식이었다(실측 2026-08-11).

명세는 **허용과 금지를 모두** 적는다. 허용 목록만 두면 새 파일이 조용히 빠지고(설치본이
낡는다), 금지 목록만 두면 새 부산물이 조용히 들어간다(사용자 계정이 이 저장소의 상태를
물려받는다). 금지 쪽이 더 위험하다.

- **배포 대상**: 루트 문서·설치기 5종 / `bin/*.py` / `templates/` 의 파일. 하위 디렉토리는
  재귀하지 않는다 — 전부 부산물이다.
- **금지 대상**: 장부·`PROGRESS.md`·`settings.json`·검증 캐시·`CLAUDE.md`·빌드 산출물
  (`dist`·`node_modules`·`__pycache__`·`*.pyc`·`*.bun-build`)·로그·백업.
- **오탐 금지**: `templates/CLAUDE.md.tmpl`·`templates/bootstrap_prompt.txt` 처럼 확장자만 보고
  거르면 안 되는 것이 있다. 금지 판정은 명시 목록만으로 한다.
- 제외한 항목은 사유와 함께 출력한다(조용히 빼지 않는다). 설치본에 **이미 들어가 있는**
  금지 항목도 검출해 보고하되 **지우지는 않는다** — 사용자 계정의 파일을 배포 스크립트가
  임의로 지우지 않는다.

세 구현이 어긋나면 `tests/test_installer_parity.py` 가 실패한다. 이 테스트는 설치
스크립트를 **실행하지 않고** 소스에서 복사 대상을 읽어 대조한다(실행하면 실제 사용자
설치본을 덮어쓴다).

### 12.1 기계에 속하는 것

`.claude/settings.json` 은 저장소가 아니라 **기계**에 속한다. 훅 명령에 설치 시점의 절대
EXE 경로가 박히기 때문이다(§8 `broken_path`). 저장소에 커밋하지 않고 `.gitignore` 에 넣으며,
참조용으로 `.claude/settings.example.json`(자리표시자 경로)만 추적한다. 클론 후 복구는
`autoharness install --migrate <저장소>` 한 번이다.

### 12.2 install.ps1

- `-Install`(기본): 스킬 폴더로 복사(기존은 `.bak-<ts>` 백업 후 교체, **install.ps1 자신도
  복사** — 설치본에서 -Watchdog/-Uninstall 재실행 가능해야 한다. install.sh 도 함께 둔다 —
  Windows 로 설치한 계정에서 WSL 재설치를 설치본만으로 할 수 있어야 한다), 런타임 디렉토리 생성,
  `claude mcp remove -s user autoharness`(실패 무시) → `claude mcp add -s user autoharness --
  <EXE 절대경로> mcp`, 결과 검증 출력.
- `-Watchdog`: **ScheduledTasks cmdlet(Register-ScheduledTask)** 로 등록(15분 간격, pythonw).
  schtasks `/TR` 은 PS 5.1 네이티브 인자 전달에서 내부 따옴표가 소실되어 공백 경로가 조각나므로
  install.ps1 에서는 금지(MCP 쪽 subprocess 리스트 전달은 안전하므로 schtasks 허용).
- `-Uninstall`: schtask 삭제 + mcp remove + 스킬 폴더 제거(런타임 상태는 보존).
- PowerShell 5.1 호환(`&&` 금지, 삼항 금지).

## 12. 검증 계약 (적대적 검증 에이전트용)

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
