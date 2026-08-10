# AutoHarness 데몬 (TypeScript) — 설계 계약 v2

> 이 문서는 구현·검증 에이전트가 공유하는 **단일 계약**이다. 여기 정의된 경로, CLI 표면,
> 스키마, 종료 코드, 도구 이름, HTTP 표면은 임의로 바꾸지 않는다. 변경이 필요하면 이 문서를
> 먼저 고친다. 상위 계약인 루트 `DESIGN.md`(v1, Python)와 충돌하면 **이 문서가 우선**한다.

## 0. 왜 다시 만드는가 — 해결하려는 문제

v1 의 자동 부활은 **OS 스케줄러에 의존**한다(Windows 작업 스케줄러 / cron). 실측 결과 이
의존이 깨질 수 있음이 드러났다:

- 개발 PC 에서 `LEeT\Startlyn` 계정의 **시간 트리거 작업 전체**가 `0x800710E0` 으로 큐에만
  쌓이고 실행되지 않는다. 마이크로소프트 자기 작업도 동일하고, `cmd /c echo` 짜리 최소
  작업도 같다 — **작업 정의 문제가 아니다.**
- 배터리 조건 해제·전면 재등록·완전 삭제 후 재생성·큐 인스턴스 정리·**재부팅**까지 전부
  무효였다. 반면 **로그온 트리거 작업은 정상**이다.
- 결과: 워치독이 설치(2026-08-06) 이후 **단 한 번도 실행되지 않았다.** 두 프로젝트에서
  "세션이 죽어도 자동 부활" 보장이 내내 무효였는데 상태 조회는 "등록됨(Ready)"만 보고했다.

**결론: 스케줄링을 OS 에서 회수해 우리 프로세스 안에 둔다.** 기동은 이 PC 에서 실증된
로그온 트리거만 쓰고, 그 뒤로는 상주 데몬이 자기 시계로 돈다.

## 1. 결정 사항 (사용자 확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 스케줄러 수명 | **상주 데몬 EXE**, 로그온 자동 시작 | MCP stdio 는 세션과 함께 죽어 부활 주체가 될 수 없다 |
| 코드 배치 | 같은 저장소 `daemon/` | 이력·문서·이슈 일원화, 기존 하네스로 이 마이그레이션 자체를 주행 |
| Python 엔진 | **전부 TypeScript 재구현** | 단일 스택 |
| 런타임·패키징 | **Bun** (`bun build --compile`) | 단일 EXE, 웹서버·WS 내장, 의존성 최소 |

## 2. 아키텍처

```
로그온 트리거 ──▶ autoharness.exe daemon        (상주, 사용자 세션)
                     │
                     ├─ Scheduler   : 자기 시계로 N분마다 tick (OS 스케줄러 미사용)
                     ├─ Supervisor  : 프로젝트별 판단 → claude -p 헤드리스 기동 → 백오프
                     ├─ Registry    : ~/.claude/autoharness/registry.json
                     ├─ Console     : stdout + 회전 로그 파일
                     └─ Web(127.0.0.1) : REST + WebSocket — 상태 조회·제어·콘솔 스트림·명령 전송
                              ▲
                              │ HTTP(loopback + 토큰)
   Claude Code ──stdio──▶ autoharness.exe mcp   (세션 수명, 얇은 클라이언트)
   Claude Code ──exec──▶ autoharness.exe hook-* (수백 ms 단발)
                              │
                     대상 저장소 .claude/agent_tracker.json (장부 = 진실 원천)
```

**하나의 EXE, argv 로 모드 분기.** 훅은 대상 저장소마다 실행돼야 하므로 배포 단위가 하나여야
설치가 단순하다(v1 이 엔진 파일 하나로 자족했던 이유와 같다).

## 3. 실행 모드 (CLI 표면)

| 모드 | 역할 | 종료 코드 |
|---|---|---|
| `daemon [--port N] [--interval N] [--no-web]` | 상주. 스케줄러·웹·콘솔 | 0/2 |
| `mcp` | MCP stdio 서버. 데몬에 위임, 데몬 부재 시 인프로세스 폴백 | 0/2 |
| `hook-prebash` · `hook-postbash` · `hook-stop` · `brief` | 훅. stdin=훅 JSON | v1 계약 그대로 |
| `run [--task I] [--cmd C]` | 검증 실행 | **0/1/2/3/4 — 절대 변경 금지** |
| `next` · `status` · `render` · `add-task` · `set-task` · `heartbeat` · `sync-commit` · `detect` · `model-recommend` · `selftest` | v1 엔진 CLI 대응 | v1 그대로 |
| `install [--autostart] [--repo P]` | 설치·로그온 등록·훅 병합 | 0/2 |

**훅 모드는 시작 시간이 계약이다**: p95 **150ms 이내**. 초과하면 매 Bash 호출이 체감된다.
Bun 단일 EXE 의 콜드 스타트를 실측해 이 예산을 지키는지 확인하고, 못 지키면 훅만 데몬에
위임하는 경로(로컬 소켓)를 추가한다.

### 3.1 패키징 실측 (2026-08-10, Windows 11 / Bun 1.3.14)

| 항목 | 실측값 | 계약 | 판정 |
|---|---|---|---|
| EXE 크기 | 94.1 MiB | (없음) | Bun 런타임을 통째로 담는 구조라 대부분이 런타임이다 |
| 빌드 시간 | 0.4초 | (없음) | `--compile` 은 선빌드된 런타임에 번들을 덧붙인다 |
| 훅 콜드 스타트 p50 | 71.4ms | — | `hook-prebash` + stdin + 장부 적재 상태 |
| **훅 콜드 스타트 p95** | **75.3ms** | **< 150ms** | **예산 이내** — 훅 위임 경로(로컬 소켓)는 불필요 |
| 훅 콜드 스타트 p99 | 77.3ms | — | 최소 64.5ms / 최대 77.5ms |

측정 대상은 `version` 이 아니라 **실제 훅 경로**다(`hook-prebash`: stdin 파싱 → 장부·설정
읽기 → 명령 판정). 재현: `bun run build && bun run bench:startup`.
argv 모드 21종은 `bun run verify:exe` 가 EXE 로 직접 실행해 종료 코드를 확인한다.

## 4. 바뀌지 않는 계약 (외부와의 약속)

이것들은 **대상 저장소·Claude Code·기존 문서와의 계약**이라 재구현에서도 동일해야 한다.

1. **종료 코드** `0`=통과 `1`=검증 실패 `2`=사용법/설정 오류 `3`=진행 가능 작업 없음
   `4`=한도 도달(blocked). `run` 은 blocked 지정·blocked 만 남은 경우에도 4.
2. **장부 스키마** `.claude/agent_tracker.json` — v1 §5 그대로(schema_version 1 유지).
   `PROGRESS.md` 는 렌더 산출물.
3. **레지스트리 스키마** `~/.claude/autoharness/registry.json` — v1 §7 그대로
   (`last_tick`·`settings.watchdog_installed_at` 포함).
4. **MCP 도구 14종의 이름과 입출력** — `harness_detect` `harness_init` `harness_status`
   `harness_run` `task_add` `task_set` `harness_pause` `harness_resume_project`
   `model_recommend` `model_set` `heartbeat` `watchdog_install` `watchdog_uninstall`
   `watchdog_status`.
5. **훅 결정 프로토콜** — 헤드리스(`CLAUDE_AUTOHARNESS=1`)·일시정지 구분, `deny`=exit 2+stderr,
   `ask`=exit 0 + `hookSpecificOutput.permissionDecision`. 명령 판정은 토큰 기반(v1 §4).
6. **설치 위치** `~/.claude/skills/autoharness/` — 스킬 문서 위치는 유지.

## 5. 바뀌는 계약 (마이그레이션 필요)

| 항목 | v1 | v2 | 영향 |
|---|---|---|---|
| 훅 명령 | `python scripts/harness_engine.py hook-prebash` | `<EXE> hook-prebash --repo "${CLAUDE_PROJECT_DIR}"` | 대상 저장소 `settings.json` 갱신 필요. 엔진 경로와 **대상 저장소를 둘 다** 못 박는다 — `--repo` 를 생략하면 cwd 가 저장소가 돼 하위 디렉토리에서 게이트가 조용히 사라진다(v1 실측) |
| 저장소 내 엔진 사본 | `scripts/harness_engine.py` | 없음(전역 EXE 참조) | 저장소가 가벼워지지만 EXE 설치에 의존 |
| 워치독 | OS 스케줄러 등록 | 데몬 내부 스케줄러 | `watchdog_install` 은 **로그온 자동 시작 등록**으로 의미가 바뀐다(도구 이름은 유지) |

**마이그레이션은 파괴적이면 안 된다**: 이미 주행 중인 두 프로젝트(`autoharness`,
`LieDetectorOCR`)의 장부·진행 상태를 보존한 채 훅 배선만 교체한다. v1 훅과 v2 훅이 잠시
공존해도 장부가 깨지지 않아야 한다(같은 스키마·같은 원자적 쓰기).

### 5.1 마이그레이션 절차와 롤백

**제1 원칙: 장부 불변.** 마이그레이션은 `.claude/settings.json` 하나만 바꾼다. 장부는
읽기만 하며, 전후 바이트가 다르면 실패로 보고한다(`ledgerIntact: false`).

절차:

1. `autoharness install --migrate <저장소> --dry-run` — 무엇이 바뀔지 먼저 본다.
   현재 훅 목록(v1 여부·matcher·`--repo` 유무)과 계획, 장부 작업 수가 나온다.
2. `autoharness install --migrate <저장소>` — 설정을 백업(`settings.json.bak-<ts>`)한 뒤
   v1 훅을 `<EXE> <op> --repo "${CLAUDE_PROJECT_DIR}"` 로 바꾸고, matcher 를 `Bash|PowerShell`
   로 넓히고, 빠진 `--repo` 를 채운다. 백업 경로는 결과에 실려 나온다.
3. 결과의 `ok` 가 참인지, `after` 에 `legacy: true` 나 `repoUnpinned: true` 가 남지 않았는지 본다.

**롤백**은 설정 파일 하나를 되돌리는 것으로 끝난다 — 장부를 건드리지 않았기 때문이다:

```
autoharness install --rollback <저장소> --backup <settings.json.bak-…>
```

**한 번에 끝내지 않아도 된다.** v1 훅과 v2 훅이 섞여 있어도 안전하다: 둘은 같은 장부 스키마를
읽고 같은 원자적 쓰기를 하며, 레지스트리는 같은 잠금 파일 규약(`registry.lock`)을 공유한다.

## 6. 데몬 상세

### 6.1 스케줄러
- 자기 시계로 `interval`(기본 15분) 주기 tick. **OS 스케줄러 미사용.**
- 매 tick 마다 레지스트리 전 프로젝트를 v1 §10 판단 순서 그대로 평가한다
  (status→백오프→PAUSED→장부→진행 가능 작업→하트비트→기동).
- tick 끝에 `last_tick` 기록. 저장은 **read-modify-write 병합**(v1 에서 고친 갱신 소실 방지).
- 단일 인스턴스: 잠금 파일(pid+mtime). 이미 살아 있으면 새 데몬은 즉시 종료.
- 시계 점프(절전 복귀·시간 변경) 방어: `setInterval` 이 아니라 **다음 실행 시각 기준 재계산**.

### 6.2 세션 기동 (v1 의미 보존)
- `claude -p <bootstrap> --model <model> <permission_args>`, cwd=repo, `CLAUDE_AUTOHARNESS=1`.
- probe 90초 생존 또는 rc=0 → ok(카운터 리셋·분리). 조기 비정상 종료 + 사용량 패턴 → limit
  (지수 백오프 30→60→120→240→360분, **영구 포기 없음**, 연속 초과 시 `needs_attention`).
  그 외 → error(15→30→60분, 5회 연속 시 `status=error` 정지).

### 6.3 웹 UI — **보안이 기능의 일부다**
명령 전송이 가능하다는 것은 곧 로컬 RCE 표면이라는 뜻이다. 다음은 타협 불가:
- **`127.0.0.1` 에만 바인드.** 외부 인터페이스 바인드 옵션을 만들지 않는다.
- **토큰 필수.** 기동 시 생성해 `~/.claude/autoharness/web-token`(권한 축소)에 저장하고,
  모든 REST·WS 요청에 요구한다. 토큰 없는 요청은 401.
- **CSRF 방어**: 상태 변경은 `POST`+토큰 헤더만 허용(쿠키 인증 안 씀).
- 콘솔 명령 전송은 **화이트리스트된 동작**만 노출한다(임의 셸 실행 금지):
  프로젝트 pause/resume, 작업 pending/blocked 전환, 즉시 tick, 세션 기동, 로그 조회.

REST(초안): `GET /api/status` `GET /api/projects` `GET /api/projects/:id/tasks`
`POST /api/projects/:id/pause|resume|tick|launch` `POST /api/tasks/:id/state` `GET /api/logs`
WS: `/ws/console` — 콘솔 라인 실시간 스트림(구독 전용).

## 7. 검증 기준 (합격선)

1. **기존 350건과 등가인 테스트가 TypeScript 로 존재하고 전부 통과.** 테스트는 v1 의 회귀
   의도를 그대로 옮긴다 — 특히 적대 검증으로 얻은 것들:
   토큰 기반 명령 판정(인용부호 안 언급·줄 연속·래퍼 우회·판정 불가 게이트),
   게이트 컨텍스트 판정(헤드리스/대화형/일시정지), 훅 matcher 커버리지,
   레지스트리 쓰기 무결성(파손 대피·갱신 소실 방지), 워치독 상태 전이 3갈래,
   사용량 분류 오탐/미탐, 조용한 실패 3종, 배선 진단 사각.
2. `selftest` 가 v1 과 동일한 7종 15항목을 검증하고 전부 PASS.
3. **교차 검증**: 같은 장부·같은 입력에 대해 v1 Python 과 v2 TS 의 `next`·`status`·`run`
   종료 코드와 장부 변화가 일치한다(마이그레이션 안전성의 실측 근거).

   **교차 검증 실측 (2026-08-10): 358건 대조, 불일치 0건.**

   | 대조 축 | 건수 | 결과 |
   |---|---|---|
   | 선택 규칙·교착 판정·종료 코드(next) | 13 | 일치 |
   | 명령 판정(deny·commit 게이트) | 40 | 일치 |
   | 무작위 장부 속성 기반(next·교착·카운트) | 300 | 일치 |
   | run 종료 코드와 장부 변화(0/1/3/4) | 5 | 일치 |

   무작위 장부는 시드(`PARITY_SEED`)로 재현한다 — 불일치가 나오면 같은 장부를 다시 만들 수
   있어야 판정이 가능하다. 재현: `bun run parity`(전량) / 축소본은 테스트가 매번 돌린다.
4. EXE 가 실제로 빌드되고, 훅 모드 콜드 스타트 p95 < 150ms 실측.
5. 데몬이 **OS 스케줄러 없이** 24시간 이상 tick 을 유지하고 `last_tick` 이 계속 갱신됨을 실측.

## 8. 사람 판단이 필요한 경계 (자율 결정 금지)

- 이 문서의 계약(§4) 변경
- 대상 저장소의 기존 장부를 파괴하는 마이그레이션
- 웹 UI 를 loopback 밖으로 노출하거나 토큰을 없애는 변경
- 임의 셸 명령을 웹에서 실행 가능하게 만드는 것
- v1 Python 자산의 삭제 — 교차 검증(§7.3)이 끝나기 전에는 지우지 않는다
