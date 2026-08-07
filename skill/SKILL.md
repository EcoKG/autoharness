---
name: autoharness
description: 자율 주행 하네스로 저장소 작업을 맡는다 — 구축(init)·재개(resume)·상태(status)·일시정지/프로젝트 재개(pause/resume-project). "하네스"·"autoharness" 를 언급할 때뿐 아니라, 저장소에 여러 단계 작업을 자율로 맡기는 결과 서술형 요청(이식·마이그레이션·리팩터링·결함 검증 및 수정·테스트 확충·릴리스/master 승격·배포 준비·프로젝트 고도화)과 헤드리스 부트스트랩(CLAUDE_AUTOHARNESS=1) 재개 지시에도 사용한다.
---

# AutoHarness — 자율 마이그레이션 하네스

이 스킬은 4개 모드로 동작한다. 요청에서 모드를 판별하라:

| 요청 신호 | 모드 |
|---|---|
| "하네스 구축/설치/세팅" · 새 저장소에 자율 주행 시작 | **init** |
| **결과 서술형 다단계 요청** + 대상 저장소에 장부 **없음** | **init** (단, 폴백으로 도달했으면 원칙 5) |
| 헤드리스 부트스트랩 재개 · "이어서 진행" · `CLAUDE_AUTOHARNESS=1` 환경 | **resume** (적재 없이 바로 루프) |
| **결과 서술형 다단계 요청** + 장부 **있음** | `task_add` 로 적재한 **뒤 resume** |
| 상태·진행률 조회, 실패/차단 원인 질의("왜 멈췄어", "뭐가 blocked 야"), 워치독 동작 확인 — **읽기만 하는 요청 전부** | **status** |
| "멈춰/일시정지" | **pause** |
| "다시 돌려/재개" — `HARNESS_PAUSED` 플래그가 **있을 때** (없으면 resume) | **resume-project** |
| 하네스 제거·"그만 돌려"(영구 해제) · 모델 변경 · 특정 작업 blocked↔pending 전환 | **ops** — `watchdog_uninstall`·`model_set`·`task_set` 만 수행하고 **작업 루프는 돌리지 않는다** |

**결과 서술형 다단계 요청**이란 사용자가 *메커니즘*("하네스를 깔아줘")이 아니라 *결과*로 말하는
경우다 — "이 프로젝트도 검증하고 문제가 있으면 수정", "master 로 승격·배포 가능한지 검증",
"테스트를 확충해줘", "이 모듈을 X 로 이식", "리팩터링해서 품질 올려줘". **이런 요청이 이 스킬의
주 대상이다.** 사용자는 대개 메커니즘이 아니라 결과로 말한다.

### 모드 판정 원칙 (표현이 아니라 의도로 판정한다)

**평가 순서 고정: 1 → 2 → 3.** direct(2번)를 먼저 걸러야 폴백이 단발 작업까지 삼키지 않는다.

1. **결과로 말한 요청도 대상이다.** 위 표의 따옴표 문구는 예시일 뿐 매칭 조건이 아니다.
   저장소를 상대로 "여러 단계에 걸쳐 고치고 검증해 달라"는 뜻이면 이 스킬의 대상이다.
2. **direct (모드 없음)** — 단발성 질의·코드 설명·파일 한 곳 수정처럼 검증 루프가 필요 없는
   작업. 스킬 없이 직접 처리한다. **이 경로는 정식 결과이며 4번이 금지하는 "맨손"이 아니다.**
   - 착수 전에 단계 수를 알 수 없는 수정 요청(버그 수정·빌드/CI 복구)은 먼저 원인을 조사한다.
     파일 1~2곳·검증 1회로 끝나면 direct, 3곳 이상이거나 반복 검증이 필요하면 승격한다.
3. **폴백** — 어느 행에도 확신이 안 서고 2번도 아니면 **스킬을 포기하지 말고** 대상 저장소의
   `.claude/agent_tracker.json` 존재로 판정한다: 있으면 `task_add` 로 적재한 뒤 **resume**,
   없으면 **init**. (장부가 있는데 init 을 다시 돌리면 진행 상태가 날아간다.)
4. **금지**: 모드가 안 맞는다는 이유로 장부·검증 게이트·훅 없이 **맨손으로 다단계 작업을
   수행하는 것**. 그러면 커밋 게이트·금지 명령 차단·테스트 약화 금지·Stop 게이트·워치독이
   전부 무력화된다 — 스킬을 부른 의미가 사라지는 조용한 실패다. 여기서 말하는 "맨손"은
   *다단계 결과 요청인 줄 알면서* 게이트 없이 진행하는 것만을 뜻한다(2번 direct 는 무관).
5. **폴백의 비대칭 (안전 규칙)**: 폴백으로 도달한 **resume 은 바로 실행해도 되지만, 폴백으로
   도달한 init 은 즉시 실행하지 않는다.** init 은 훅 4종·권한 우회(`bypass`)·워치독 스케줄러를
   설치하는 **비가역 환경 변경**이다. 명시 요청이 아니라 폴백으로 흘러온 경우에는 "하네스를
   구축해 자율 주행하겠습니다" 한 줄을 고지하고 동의를 받은 뒤 시작한다.
   (사용자가 하네스 구축을 명시적으로 요청했다면 고지 없이 진행한다.)
6. **모호 발화 해소**: "다시 돌려/재개" 는 `.claude/HARNESS_PAUSED` 존재로 갈린다 — 있으면
   **resume-project**(플래그 제거 후 워치독에 위임), 없으면 **resume**(직접 루프 진입).
7. **대상 저장소를 먼저 확정한다.** "이 프로젝트도"·"다른 프로젝트" 처럼 현재 cwd 가 아닐 수
   있으면, 경로를 특정하기 전에는 어떤 도구도 호출하지 않는다. 이후 모든 호출에 절대경로를
   준다 — 현재 cwd 의 장부를 대상 저장소 장부로 오독하면 엉뚱한 저장소를 주행한다.
8. **배포의 한계선**: 이 스킬이 하는 것은 **배포 가능 상태까지의 검증과 로컬 커밋**이다.
   `git push`·태그 푸시·릴리스 발행은 훅이 차단하므로 작업에 넣지 말고 보고의 "사람 판단 필요
   항목"에 남긴다. "배포해줘" 를 **배포 완료로 오보고하지 않는다.**

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

### ⓪ 장부 실존 확인 (생략 금지)
`<대상 저장소>/.claude/agent_tracker.json` 을 직접 읽어 **없음을 확인한 뒤에만** init 을 진행한다.
존재하면 init 을 즉시 중단하고 모드 2(resume)로 전환한다 — 재초기화는 진행 상태를 파괴한다.
폴백으로 이 모드에 도달했다면 판정 원칙 5의 고지를 먼저 수행한다.

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

**먼저 대상 저장소 절대경로를 확정한다**(판정 원칙 7). 현재 cwd 가 아닐 수 있는 요청이면
경로 특정 전에는 어떤 도구도 호출하지 않는다.

0. **신규 결과 요청으로 진입한 경우 — 작업 적재부터 한다.** 요청을 작업 단위로 분해해
   `mcp__autoharness__task_add` 로 장부에 넣는다(입도·id·deps·priority·test_cmd 규칙은 init ⑤절과
   동일). **적재를 건너뛰고 `next` 를 돌리면 exit 3 이 나와 "할 일 없음"으로 오보고된다.**
   (헤드리스 재개·"이어서 진행" 처럼 기존 작업을 잇는 진입이면 이 단계는 건너뛴다.)
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
        단 **신규 결과 요청으로 진입했는데 첫 `next` 가 곧바로 3 이면 정상 종료가 아니라
        0단계(적재) 누락이다** — 요약 보고 대신 0단계로 돌아가 `task_add` 를 수행한다.
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
