---
name: autoharness
description: 자율 마이그레이션 하네스 구축(init)·재개(resume)·상태(status)·일시정지/프로젝트 재개(pause/resume-project). 사용자가 "하네스", "autoharness", 자율 주행 마이그레이션/이식 구축·재개·상태 확인·일시정지를 언급하거나, 헤드리스 부트스트랩(CLAUDE_AUTOHARNESS=1)으로 재개 지시를 받을 때 사용한다.
---

# AutoHarness — 자율 마이그레이션 하네스

이 스킬은 4개 모드로 동작한다. 요청에서 모드를 판별하라:

| 요청 신호 | 모드 |
|---|---|
| "하네스 구축/설치/세팅", 새 저장소에 자율 주행 시작 | **init** |
| 헤드리스 부트스트랩 재개, "이어서 진행", CLAUDE_AUTOHARNESS=1 환경 | **resume** |
| "상태", "어디까지 됐어", "진행 상황" | **status** |
| "멈춰/일시정지" · "(일시정지 해제하고) 다시 돌려" | **pause / resume-project** |

공통 원칙:
- **진실 원천은 장부** `.claude/agent_tracker.json` 이다. 대화 기억·PROGRESS.md 와 다르면 장부가 맞다.
- 장부의 `done` 마킹은 엔진(run 성공)만 한다. 손으로 장부를 편집하지 말라. 상태 조작은
  `task_set`(pending/blocked 만 허용)으로만 한다. PROGRESS.md 는 렌더 산출물 — 직접 수정 금지.
- MCP 도구가 보이면 MCP 를 쓰고, 안 보이면 아래 [폴백 표](#mcp-미등록-환경-폴백)의 직접 실행을 쓴다.

## 종료 코드 계약 (`run` / `bash scripts/agent_harness.sh`) — 절대 기준

| 코드 | 의미 | 에이전트 행동 |
|---|---|---|
| 0 | 검증 통과 (task→done) | 커밋 후 다음 작업 |
| 1 | 검증 실패 (attempts+1, last_error 기록) | 오류 요약을 읽고 자가 수정 → 재실행 반복 |
| 2 | 사용법/설정 오류 | 중단·보고 |
| 3 | 진행 가능한 작업 없음 | 중단·보고 |
| 4 | max_attempts 도달 (task→blocked) | 해당 작업 봉인. **다른 진행 가능 작업이 있으면 계속**, 없으면 중단·보고 |

※ `run` 은 ①이미 blocked 인 작업을 지정했을 때 ②blocked 만 남고 진행 가능 작업이 없을 때도
4 를 반환한다(같은 상태에서 `next` 는 3). 행동은 동일: 남은 작업 있으면 계속, 없으면 보고.

---

## 모드 1: init — 하네스 구축

대상 저장소 루트를 확정한 뒤 아래 절차를 **순서대로** 수행한다.

### ① 실측 (추측 금지)
1. `mcp__autoharness__harness_detect` 를 `repo_path`=저장소 절대경로로 호출한다.
2. 결과의 `suggested_commands` 중 실제 테스트 명령을 **1회 직접 실행**한다(Bash). 출력과 종료
   코드를 확보한다.
3. **실측 표를 보고의 첫머리에 먼저 출력**한다: 빌드 도구 / 멀티모듈 / 테스트 디렉토리 유무 /
   린트 설정 / git 상태(branch, dirty) / 테스트 1회 실행 결과(명령·종료 코드·요약).
4. **중단 조건**: 테스트가 전무(`tests_present`=false 이고 실행할 테스트 명령이 없음)하거나
   실행한 테스트가 전부 실패하면 **여기서 중단하고 보고**한다 — 검증 기준이 없으면 자가 치유
   루프가 성립하지 않는다. 테스트 정비가 선행 과제임을 명시한다.

### ② 모델 선택 (추천은 도구, 결정은 사용자)
1. `mcp__autoharness__model_recommend` 를 호출한다(repo_path, source/target, 특이사항 notes).
2. 결과를 **AskUserQuestion** 으로 제시한다:
   - 선택지는 정확히 두 모델: `claude-opus-5`, `claude-fable-5`.
   - **추천안을 첫 번째 옵션**으로 놓고 라벨에 `" (Recommended)"` 를 붙인다.
   - 각 옵션 설명에 `comparison` 문구와 `rationale`(점수 근거)을 요약해 담는다.
3. 사용자가 고른 모델을 이후 단계에 사용한다. 임의로 대신 결정하지 않는다.

### ③ 하네스 설치
`mcp__autoharness__harness_init` 를 호출한다 — repo_path, project, objective, source_stack,
target_stack, test_cmd(①에서 실측 검증된 명령), build_cmd/lint_cmd(있으면), model(②의 결정),
`permission_mode` 는 **기본 `"bypass"`** (사용자가 명시적으로 보수 운용을 원하면 `"acceptEdits"`).
이 호출이 장부·예시·로그 디렉토리 생성, `scripts/harness_engine.py` 사본·`scripts/agent_harness.sh`
설치, `.claude/settings.json` 훅 4종·권한 병합(원본 `.bak-<ts>` 백업), 레지스트리 등록까지 수행한다.

**권한 분류기 차단 시(auto mode)**: 이 호출(또는 훅 병합 스크립트)이 분류기에 거부되면 —
훅 주입·권한 우회 등록은 분류기가 막도록 설계된 패턴이라 정상 동작이다 — 다음으로 대체한다:
① 폴백 표의 엔진 init 으로 장부를 만들고 ② **사용자에게 아래 한 줄 실행을 요청**한다
(엔진·래퍼 사본 보완 + 훅 병합 + 레지스트리 등록. init 은 대화형 단계라 이 요청은 질문 금지
조항에 해당하지 않는다). 실행 후 `harness_status` 폴백으로 완료를 확인하고 계속 진행한다.

```bash
python3 ~/.claude/skills/autoharness/bin/harness_mcp.py finish-init --repo . --permission-mode bypass
```

(Windows Git Bash: `python "$HOME/.claude/skills/autoharness/bin/harness_mcp.py" finish-init --repo . --permission-mode bypass`)

### ④ CLAUDE.md 작성
1. 골격은 스킬 폴더의 `templates/CLAUDE.md.tmpl`
   (`%USERPROFILE%\.claude\skills\autoharness\templates\CLAUDE.md.tmpl`)을 쓴다.
2. `{{PROJECT}} {{OBJECTIVE}} {{SOURCE_STACK}} {{TARGET_STACK}} {{BUILD_CMD}} {{TEST_CMD}}
   {{LINT_CMD}}` 를 실측·결정값으로 치환한다. **실측하지 못한 값은 `<확인 필요>` 로 남긴다.**
3. 기존 CLAUDE.md 가 있으면 `CLAUDE.md.bak-<ts>` 로 백업한 뒤 기존 내용과 **병합**한다
   (기존 프로젝트 규칙 보존 + 하네스 절 추가).
4. 최종 파일은 **200줄 미만**을 유지한다.

### ⑤ 마이그레이션 계획 적재
소스 코드를 분석해 작업을 분해하고, 각 작업을 `mcp__autoharness__task_add` 로 장부에 넣는다.
- 필수: id(짧고 안정적), title. 권장: path(스코프 테스트용 상대경로), **deps**(선행 작업 id 들 —
  코어→상위 계층 순), **priority**(낮을수록 먼저; 10 단위 간격 권장). 작업 전용 검증이
  필요하면 **test_cmd**(전역 test 대신 실행, `{path}` 치환, `""` 로 해제).
- 의존 대상은 먼저 추가돼 있어야 한다(엔진이 미존재·자기·순환 의존을 거부한다). 이미 장부에
  있는 교착 pending 은 next/brief/status 가 `deadlocked` 로 알린다 — 발견 시 의존을 정리한다.

### ⑥ 자가 검증
대상 저장소에서 `python scripts/harness_engine.py selftest` 를 실행한다. 7종 15항목(장부
초기화/실패 경로 exit1+attempts/성공 경로 exit0+done/한도 exit4+blocked/의존성 게이팅/
PROGRESS.md 렌더/더미 정리)이 전부 PASS 인지 확인하고 **출력 전문을 보고에 첨부**한다.
FAIL 이 있으면 중단·보고.

### ⑦ 워치독 등록
`mcp__autoharness__watchdog_install` 를 호출한다(interval_minutes 기본 15). 세션이 죽어도
(사용량 초과 포함) 스케줄러가 자동 부활시킨다.

### ⑧ 최종 보고 (형식 고정)
1. **실측 표** (①의 표)
2. **생성·수정 파일 표** (경로 / 신규·수정·백업 여부)
3. **훅으로 옮긴 규칙** (커밋 게이트, 금지 명령 차단, SessionStart 요약, Stop 게이트 — CLAUDE.md
   가 아니라 훅이 강제함을 명시)
4. **검증 로그** (⑥ selftest 출력 전문)
5. **사람 판단 필요 항목** (`<확인 필요>` 목록, 테스트 공백 영역 등)
6. **다음 세션 시작 한 줄 명령**: `claude "autoharness resume"` (또는 워치독 자동 기동 대기)

---

## 모드 2: resume — 자율 주행 재개

**장부가 진실 원천이다.** 세션 시작 직후와 compaction 직후에는 반드시 장부부터 읽는다.
(SessionStart 훅이 `brief` 요약을 주입하지만, 판단은 장부 원본 기준.)

1. `mcp__autoharness__heartbeat` (폴백: `python scripts/harness_engine.py heartbeat`) 실행.
2. 루프 — 작업 단위로 반복:
   1. **다음 작업 선택**: `python scripts/harness_engine.py next` (의존성 게이팅·우선순위는
      엔진이 판정한다 — 직접 고르지 말라). exit 3 이면 루프 종료 → 요약 보고.
   2. **코드 수정**: 작업 title/path/`last_error` 를 근거로 구현·수정한다. `last_error` 가 있으면
      그 오류를 우선 해결한다. 긴 로그는 `last_log_file` 경로의 파일을 부분적으로만 읽는다.
   3. **검증**: `bash scripts/agent_harness.sh --task <id>` 실행.
   4. **종료 코드 분기** (위 계약 표):
      - **0** → `git add` 후 `git commit`(커밋 게이트는 훅이 자동 확인, SHA 는 훅이 장부에 자동
        기록) → 다음 작업으로.
      - **1** → 출력의 오류 요약을 읽고 코드를 고쳐 3단계 재실행. (시도 횟수는 장부가 센다 —
        직접 세지 말 것.)
      - **2** → 설정 오류 — 중단·보고. **3** → 진행 가능 작업 없음 — 루프 종료·요약 보고.
      - **4** → 해당 작업은 엔진이 blocked 로 봉인했다(사람 판단 필요 항목으로 남는다).
        **1단계로 돌아가 다음 작업을 확인**하고, 진행 가능 작업이 더 없으면(exit 3) 요약 보고
        후 종료한다 — blocked 하나 때문에 전체 주행을 멈추지 않는다.
   5. **작업당 장부 즉시 기록**: run 이 장부를 자동 갱신하므로 결과를 미루거나 몰아서 처리하지
      않는다. 사람 경계에 해당해 건너뛸 때만 `task_set --status blocked --note "<사유>"` 를
      즉시 기록한다.
3. **검증 무결성 (위반 금지)**:
   - 테스트를 약화시켜 통과시키는 모든 행위 금지: 단정문(assert) 삭제, `skip`/`xfail`/`@Disabled`
     추가, 광범위 try/catch(예외 삼킴)로 실패 은폐, 기대값을 실제 출력으로 하드코딩.
   - 실패를 성공으로 마킹 금지 — done 은 오직 run exit 0 으로만 만들어진다.
   - 테스트 자체의 버그를 고치는 것은 허용하되, 커밋 메시지에 사유를 명시한다.
4. **사람 경계 (다음은 자율 결정 금지 — blocked + note 기록 후 다음 작업으로)**:
   - 시도 5회 한도 도달(엔진이 자동 blocked 처리)
   - DB 스키마 변경 · 데이터 마이그레이션
   - 공개 API 시그니처(외부 계약) 변경
   - 인증·권한(보안) 로직 변경
   - 라이선스가 다른 새 의존성 도입
   - 순환 의존 해소를 위한 대규모 구조 변경
   - 테스트가 전무한 영역의 동작 변경(검증 불능)
5. **사용자 질문 금지**: 자율 주행 중에는 AskUserQuestion 등 어떤 질문도 하지 않는다. 판단이
   막히면 blocked+note 로 기록하고 진행한다. 더 할 일이 없으면 진행 요약을 출력하고 종료한다
   (Stop 훅과 워치독이 이후를 관리한다 — 훅의 재개 지시에는 따르고, 종료 허용 시 조용히 끝낸다).

---

## 모드 3: status — 상태 확인

1. `mcp__autoharness__harness_status` (repo_path) 호출 — 장부 카운트·다음 작업·하트비트·paused.
2. `mcp__autoharness__watchdog_status` 호출 — 스케줄러 작업 상태·레지스트리·watchdog.log tail.
3. 두 결과를 합쳐 요약 보고: done n/총, in_progress/failed/blocked, 다음 작업, 하트비트 신선도,
   일시정지 여부, 워치독 등록·최근 기동 결과, 사람 판단 필요 항목(blocked 목록과 note).

## 모드 4: pause / resume-project — 일시정지 토글

- **pause**: `mcp__autoharness__harness_pause` (repo_path) — `.claude/HARNESS_PAUSED` 플래그
  생성 + 레지스트리 status=paused. 워치독·Stop 게이트가 즉시 비활성화됨을 사용자에게 확인해 준다.
- **resume-project**: `mcp__autoharness__harness_resume_project` (repo_path) — 플래그 제거 +
  status=active + 백오프 카운터 리셋. 다음 워치독 주기(≤15분)에 자동 재기동됨을 안내한다.

---

## MCP 미등록 환경 폴백

`mcp__autoharness__*` 도구가 보이지 않으면(등록 전/실패) 대상 저장소 루트에서 아래를 직접 실행한다.
init 전이라 `scripts/harness_engine.py` 사본이 없으면
`python "%USERPROFILE%\.claude\skills\autoharness\bin\harness_engine.py"` 로 대체한다.

| MCP 도구 | 폴백 (저장소 루트에서) |
|---|---|
| `mcp__autoharness__harness_detect` | `python scripts/harness_engine.py detect --repo .` |
| `mcp__autoharness__harness_init` | `python scripts/harness_engine.py init --repo . --project N --objective O --source S --target T --test CMD [--build C] [--lint C] [--model M]` ※ 이후 사본·훅 병합·레지스트리는 `python3 <스킬폴더>/bin/harness_mcp.py finish-init --repo .` 한 줄로 마무리(분류기 차단 시 사용자 실행 요청) |
| `mcp__autoharness__harness_status` | `python scripts/harness_engine.py status --repo .` |
| `mcp__autoharness__harness_run` | `python scripts/harness_engine.py run --repo . [--task I] [--cmd C]` 또는 `bash scripts/agent_harness.sh --task I` |
| `mcp__autoharness__task_add` | `python scripts/harness_engine.py add-task --repo . --id I --title T [--path P] [--deps a,b] [--priority 100] [--test-cmd CMD]` |
| `mcp__autoharness__task_set` | `python scripts/harness_engine.py set-task --repo . --id I [--status pending\|blocked] [--note ...] [--test-cmd CMD]` |
| `mcp__autoharness__harness_pause` | `.claude/HARNESS_PAUSED` 빈 파일 생성 (워치독·Stop 게이트가 플래그를 존중한다. 레지스트리 status 는 active 로 남으므로 완전 정지는 MCP 경로 권장) |
| `mcp__autoharness__harness_resume_project` | `.claude/HARNESS_PAUSED` 파일 삭제 (레지스트리 백오프 리셋은 안 됨) |
| `mcp__autoharness__model_recommend` | `python scripts/harness_engine.py model-recommend --repo . [--source S] [--target T] [--notes ...]` |
| `mcp__autoharness__model_set` | 장부 `model` 필드를 두 허용값 중 하나로 수정(레지스트리는 수동 갱신 필요) |
| `mcp__autoharness__heartbeat` | `python scripts/harness_engine.py heartbeat --repo .` |
| `mcp__autoharness__watchdog_install` | `powershell -File "%USERPROFILE%\.claude\skills\autoharness\install.ps1" -Watchdog` |
| `mcp__autoharness__watchdog_uninstall` | `schtasks /Delete /TN AutoHarnessWatchdog /F` |
| `mcp__autoharness__watchdog_status` | `schtasks /Query /TN AutoHarnessWatchdog` + `%USERPROFILE%\.claude\autoharness\logs\watchdog.log` tail |

보조 서브커맨드(폴백 전용): `next`(exit 0/3), `render`, `brief`, `sync-commit`, `selftest`.
