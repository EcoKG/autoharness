# autoharness — AutoHarness 자율 주행 지침

> AutoHarness init 이 생성한 파일입니다. `<확인 필요>` 는 실측하지 못한 값 — 확인 후 채우십시오.
> 목표: 결함 탐색·개선으로 프로젝트 고도화 — 매 작업 검증 통과 시 실행 중 설치본에 즉시 반영

## 1. 스택 정보

- 이식: Python 3.9 stdlib (CLI 엔진 + MCP 서버 + 워치독, Windows/WSL) → 동일 스택 — 결함 수정·테스트 확충·신뢰성/운영성 고도화
- 빌드: (없음 — 장부 commands.build=null, 테스트만 수행)
- 테스트: `python scripts/run_checks.py` — 3단계다. ⓪게이트(py_compile 전량 + daemon
  devDependency 확인, 직렬) → ①검증 단위 **병렬**(엔진 selftest 15항목 / tests 모듈마다 /
  daemon 타입검사 / daemon 테스트 파일마다) → ②deploy(전 단계 통과 후 단독). 실측 2026-08-11:
  직렬 131초 → 병렬 24초, 같은 집합·같은 판정. `--jobs N`·`--serial` 로 조절한다.
  **매 실행마다 집합 대조를 한다** — 계획한 모듈·파일 집합과 실행한 테스트 수가 발견 집합과
  어긋나면 통과가 아니라 실패다(샤드 누락 = 조용한 커버리지 축소).
- 전제: bun(daemon 검증·빌드)과 `cd daemon && bun install`(타입 검사의 tsc 는 devDependency).
- 린트: (없음)
- 스코프 실행: test_cmd 에 `{path}` 치환 없음 — 항상 전역 검증이다.

## 2. 셀프 호스팅 특이사항 (이 저장소 고유 규칙)

이 저장소는 **AutoHarness 가 자기 자신을 개선**한다. 역할이 다른 두 엔진이 공존한다:

- `bin/harness_engine.py` 등 `bin/` — **개선 대상 원본**. 코드 수정은 여기에만 한다.
- `scripts/harness_engine.py` — **주행용 고정 사본**. 루프 안정성을 위해 개선 중에는
  건드리지 않는다. 갱신은 마지막 작업(refresh-loop-engine)에서만 한다.
- `%USERPROFILE%\.claude\skills\autoharness\` — **실행 중 설치본**. 직접 편집 금지.
  `run_checks.py` 의 마지막 단계(deploy_live)가 검증 통과분만 자동 반영한다.
- `%USERPROFILE%\.claude\autoharness\bin\autoharness.exe` — **v2 실행 중 설치본**. 훅·MCP·
  제어판을 실제로 실행하는 것은 이 EXE 다. deploy_live 가 daemon 소스 해시를 보고 바뀐
  경우에만 다시 빌드해 교체한다. 데몬이 돌고 있으면 잠겨서 교체가 미뤄지는데, 그때는
  검증을 실패시키지 않고 사유만 알린다(데몬 정지 후 다시 검증하면 반영된다).
- `skill/SKILL.md`(개발본)이 설치본 `SKILL.md` 의 원본이다. 문서 수정도 개발본에서만.
- `.claude/settings.json` 은 **추적하지 않는다**(기계 고유 절대경로). 참조는
  `.claude/settings.example.json`. 새 기계에서 클론했으면 한 번 복구한다 —
  `autoharness install --migrate <저장소>`. `status` 의 `hooks.state` 가 `broken_path` 면 이것이다.
- **배포 대상을 늘릴 때는 세 곳이 아니라 한 곳을 고친다** — `scripts/deploy_manifest.py`.
  install.ps1·install.sh 도 같이 고쳐야 하며, 잊으면 `tests/test_installer_parity.py` 가 실패한다.

## 3. 자가 치유 루프

작업 단위 루프 — 항상 이 순서를 지킨다:

1. `python scripts/harness_engine.py next` 로 다음 작업을 받는다(의존성·우선순위는 엔진 판정).
2. 작업 title/path/last_error 를 근거로 코드를 수정한다.
3. `bash scripts/agent_harness.sh --task <id>` 로 검증한다.
4. 종료 코드 분기: **0**=커밋 후 다음 작업 / **1**=오류 요약을 읽고 수정 후 3번 재실행 /
   **2**=설정 오류, 중단·보고 / **3**=진행 가능 작업 없음, 요약 보고 / **4**=해당 작업 blocked —
   남은 작업이 있으면 1번으로 돌아가 계속, 없으면 보고.
- 작업당 최대 **5회**(max_attempts). **시도 카운터는 장부가 센다** — 직접 세거나 초기화하지
  말 것. 5회 도달 시 엔진이 blocked 로 기록한다.

## 4. 컨텍스트 예산

- **세션 시작 직후·compaction 직후에는 장부부터 읽는다**: `.claude/agent_tracker.json` →
  PROGRESS.md 순. (SessionStart 훅이 brief 요약을 주입하지만 판단 근거는 장부 원본이다.)
- **진실 원천은 장부다.** 대화 기억·PROGRESS.md 와 어긋나면 장부가 맞다. PROGRESS.md 는 렌더
  산출물 — 직접 수정 금지.
- 긴 테스트 로그는 `.claude/harness-logs/` 의 파일을 필요한 부분만 읽는다. 전문을
  컨텍스트에 올리지 않는다(요약은 run 출력의 오류 라인으로 충분).

## 5. 완료 기준

- 작업 done = `bash scripts/agent_harness.sh --task <id>` **exit 0**(컴파일+selftest+단위테스트+
  설치본 동기화 전부 통과) 후 **git commit** 까지. 둘 중 하나만으로는 미완이다.
- done 마킹은 엔진(run 성공)만 한다. 손으로 장부를 done 으로 바꾸지 않는다.
- 커밋 SHA 는 PostToolUse 훅이 장부에 자동 기록한다.
- 커밋 메시지는 작업 내용을 서술한다(내부 코드명·작업 id 만 달랑 쓰지 않는다).

## 6. 검증 무결성

테스트를 약화시켜 통과시키는 모든 행위 금지:

- 단정문(assert) 삭제·완화 금지
- `skip` / `xfail` / `@Disabled` 등 건너뛰기 추가 금지
- 광범위 try/catch 로 예외를 삼켜 실패 은폐 금지
- 기대값을 실제 출력으로 하드코딩 금지
- 실패를 성공으로 마킹 금지 — done 은 오직 run exit 0 으로만 생긴다
- 테스트 자체의 버그 수정은 허용 — 단 커밋 메시지에 사유 명시
- 단위 테스트는 임시 샌드박스에서만 부작용을 낸다 — 실제 레지스트리
  (`~/.claude/autoharness/registry.json`)·스케줄러·실행 중 설치본을 테스트가 오염시키지 않는다.

## 7. 사람 경계

아래는 자율 결정 금지. `python scripts/harness_engine.py set-task --id <id> --status blocked
--note "<사유>"` 로 기록하고 다음 작업으로 넘어간다. 사용자에게 질문하지 않는다.

- 시도 5회 한도 도달(엔진 자동 blocked)
- 종료 코드 계약(0/1/2/3/4)·장부 스키마·MCP 도구 이름 등 **DESIGN.md 계약의 변경**
- 공개 CLI 표면(서브커맨드·인자)의 비호환 변경 — 인자 추가는 허용, 제거·의미 변경은 금지
- 설치 경로 계약 변경(스킬 폴더·런타임 디렉토리 구조)
- 새 외부 의존성 도입(stdlib-only 원칙 위반)
- 워치독의 기동·백오프 의미론 변경(재시도 간격 값 조정 포함)
- 테스트가 전무한 영역의 동작 변경: 워치독 기동 경로·MCP JSON-RPC 루프·install.ps1/install.sh —
  해당 영역은 테스트 확충 작업(tests-watchdog, tests-mcp-protocol) 완료 후에만 수정

## 8. 훅이 강제하는 것 (이 문서는 안내층, 강제는 훅 소관)

`.claude/settings.json` 의 훅 4종이 아래 규칙을 **기계적으로 강제**한다. CLAUDE.md 를 고쳐도
우회되지 않는다:

- **커밋 게이트**(PreToolUse): 진행 중 작업의 harness 검증 통과 기록 없이 `git commit` 차단.
- **금지 명령 차단**(PreToolUse): `git push`·`--force` 계열·`reset --hard`·`clean -f` 차단
  — 로컬 커밋만 허용.
- **SessionStart 요약**: 세션 시작·compact 직후 장부 brief 를 컨텍스트에 자동 주입.
- **Stop 게이트**: 헤드리스 세션(CLAUDE_AUTOHARNESS=1)에서 다음 작업이 남아 있으면 종료를
  막고 재개를 지시한다. 훅의 지시에 따르고, 종료가 허용되면 요약 출력 후 조용히 끝낸다.
