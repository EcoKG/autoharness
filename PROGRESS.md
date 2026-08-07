# PROGRESS — autoharness

> 자동 생성 파일입니다(`.claude/agent_tracker.json` 렌더링). 직접 수정하지 마세요.

- 목표: 결함 탐색·개선으로 프로젝트 고도화 — 매 작업 검증(컴파일→selftest→단위테스트) 통과 시 실행 중 설치본에 즉시 반영
- 이식: Python 3.9 stdlib (CLI 엔진 + MCP 서버 + 워치독, Windows/WSL) → 동일 스택 — 결함 수정·테스트 확충·신뢰성/운영성 고도화
- 모델: claude-fable-5 / 갱신: 2026-08-07T03:03:01.939781+00:00

## 현황: done 13 / 15  (in_progress 0, failed 0, blocked 0, pending 2)

| ID | 제목 | 상태 | 시도 | 커밋 | 비고 |
|---|---|---|---|---|---|
| skill-mode-routing | 스킬 모드 라우팅 결함 수정 — 모드 표가 메커니즘 어휘("하네스 구축")로만 매칭해 결과 서술형 요청("검증하고 문제 있으면 수정", "master 승격 가능한지 확인")이 어느 모드에도 안 걸리고, 매칭 실패 시 폴백 조항이 없어 에이전트가 장부·커밋 게이트·훅 없이 맨손 작업으로 빠짐(실사용 실측). ① 모드 표를 의도 기반으로 재작성(결과 서술형 트리거 추가, 장부 유무로 init↔task_add+resume 분기) ② 폴백 조항 명문화(맨손 다단계 작업 금지) ③ frontmatter description 에도 결과 서술형 트리거 반영 ④ 엔진에 build_parser() 추출 후 tests/test_skill_contract.py 로 계약 회귀 검증(4모드·종료코드표↔엔진 상수·폴백 조항·폴백 표↔실제 CLI 표면 일치) | ✅ done | 1/5 | - | - |
| tests-engine-hooks | 엔진 훅 단위 테스트 구축 — hook-prebash(금지 명령 차단·커밋 게이트)·hook-stop(6단계 게이트·진전 가드)·hook-postbash(SHA 동기화)를 stdin JSON 실측으로 검증하는 tests/test_engine_hooks.py 작성. 임시 샌드박스 저장소 사용, 실제 저장소·사용자 상태 오염 금지 | ✅ done | 0/5 | - | - |
| docs-skill-routing-sync | 라우팅 계약 문서 반영 — DESIGN.md §11(스킬 절)에 모드 판정 원칙·폴백 규칙을 계약으로 명시하고, README 사용 흐름에 "하네스가 이미 있는 저장소에 새 목표를 줄 때는 init 재실행이 아니라 task_add + resume" 경로를 추가 | ⏳ pending | 0/5 | - | - |
| fix-add-task-self-dep | add-task 자기/순환 의존 결함 수정 — cmd_add_task 의 `d != a.id` 조건이 자기 의존을 오히려 허용해 영구 교착 작업이 생김. 자기 의존·순환 의존을 add-task 시점에 거부하고, next/brief/status 가 '충족 불가능한 pending(교착)'을 구분해 알리도록 개선 + tests/ 회귀 테스트 | ✅ done | 0/5 | - | - |
| fix-sync-commit-guard | sync_commit 오귀속 방지 — git commit 이 실패해 HEAD 가 변하지 않은 경우(예: nothing to commit)에도 직전 커밋 SHA 를 최신 done 작업에 기록하는 결함. hook-postbash/sync_commit 에서 HEAD 변화(또는 커밋 성공)를 검증한 뒤에만 기록하도록 수정 + 회귀 테스트 | ✅ done | 0/5 | - | - |
| refresh-loop-engine-routing | 주행용 엔진 사본 재갱신 — build_parser() 추출이 반영된 bin/harness_engine.py 를 scripts/harness_engine.py 로 복사하고 status/next/brief 동작 확인(개발 원본과 주행 사본의 드리프트 해소) | ⏳ pending | 0/5 | - | - |
| fix-model-recommend-lang | model_recommend 언어 전환 오탐 수정 — 스택명이 비ASCII(한글 등)면 lang() 이 빈 문자열을 반환해 '언어 간 이식(+3)' 이 잘못 가산됨(이번 init 에서 실측). 한쪽 언어 토큰이 비어 있으면 가산하지 않도록 수정 + 회귀 테스트 | ✅ done | 0/5 | - | - |
| fix-atomic-replace-retry | OneDrive/백신 잠금 내성 — atomic_write_json/atomic_write_text 의 os.replace 가 클라우드 동기화·바이러스 검사로 일시적 PermissionError 를 맞을 수 있음(이 저장소 자체가 OneDrive 안에 있음). 짧은 지수 재시도(0.1→0.2→0.4→0.8초, 총 5회) 후 실패 처리하도록 보강 + 회귀 테스트 | ✅ done | 0/5 | - | - |
| fix-heartbeat-long-stage | 장시간 스테이지 중 하트비트 공백 해소 — run 의 단일 스테이지가 stale_minutes(30분)에 근접하면(timeout_sec 기본 1800초) 워치독이 세션 사망으로 오판해 이중 기동할 수 있음. run_stage 실행 중 주기적(5분) 하트비트 갱신(데몬 스레드) 추가 + 회귀 테스트 | ✅ done | 0/5 | - | - |
| fix-task-add-reactivation | completed 프로젝트 재활성화 — 주행 완료 후(레지스트리 status=completed) 장부에 새 작업을 추가해도 워치독이 영영 재기동하지 않음. MCP task_add 성공 시 completed 항목을 active 로 되돌리고 백오프 카운터를 리셋하도록 수정(paused/needs_human/error 는 그대로 둠) + 회귀 테스트 | ✅ done | 0/5 | - | - |
| add-per-task-test-cmd | 사장된 task.test_cmd 활성화 — 장부 스키마에 존재하고 러너가 이미 읽지만(task.test_cmd 우선) 설정 수단이 전무함. add-task/set-task CLI 인자와 MCP task_add/task_set 입력으로 노출 + DESIGN §4/§6 표 갱신 + 회귀 테스트 | ✅ done | 0/5 | - | - |
| tests-watchdog | 워치독 단위 테스트 구축 — is_usage_limited(429 문맥 오탐 포함)·backoff_pick·pid_alive·잠금 획득/사망 pid 탈취·handle_project 판단 순서(임시 --registry 오버라이드 + --dry-run)를 검증하는 tests/test_watchdog.py 작성. 실제 스케줄러 등록·claude 기동·실 레지스트리 접근 금지 | ✅ done | 0/5 | - | - |
| tests-mcp-protocol | MCP 프로토콜 단위 테스트 구축 — bin/harness_mcp.py 를 서브프로세스 stdio 파이프로 띄워 initialize/ping/tools/list(14종)/미지 메서드(-32601)/tools/call(harness_detect) 왕복을 실측하는 tests/test_mcp_protocol.py 작성. 사용자 레지스트리·설치본 오염 금지(읽기 전용 도구만 호출) | ✅ done | 0/5 | - | - |
| docs-consistency | 문서 정합화 — selftest '7종/15항목' 표기 통일(DESIGN §4·§13, install.sh 메시지 기준), 이번 라운드 수정·신규 기능(자기 의존 거부, SHA 오귀속 방지, 재시도, 작업별 test_cmd, completed 재활성화, 하트비트 보강)을 DESIGN.md·README.md·skill/SKILL.md 에 반영하고 종료 코드·경로 계약 교차 검증 | ✅ done | 0/5 | - | - |
| refresh-loop-engine | 주행용 엔진 사본 갱신 — 모든 개선·테스트·문서 작업 완료 후 개선된 bin/harness_engine.py 를 scripts/harness_engine.py 로 복사하고 status/next/brief 동작을 확인. 이후 라운드부터 주행 루프도 개선판으로 구동된다 | ✅ done | 0/5 | - | - |
