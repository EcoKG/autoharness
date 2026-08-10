# AutoHarness — 자율 주행 하네스

저장소를 맡기면 **여러 단계에 걸쳐 스스로 고치고 검증하는** 하네스입니다. 작업 목록(장부)을
진실의 원천으로 두고, 매 작업마다 실제 테스트를 돌려 통과한 것만 완료로 기록하며, 세션이
죽으면 다시 띄웁니다.

핵심은 **검증 없이는 아무것도 완료되지 않는다**는 것입니다. 완료 표시는 사람이나 에이전트가
아니라 러너의 종료 코드가 만들고, 커밋은 그 통과 기록이 있을 때만 열립니다. 이 규칙은
문서가 아니라 **훅이 기계적으로 강제**합니다.

- **무개입 주행** — 주행 중 질문하지 않습니다. Stop 훅이 세션을 붙잡아 루프를 유지하고,
  세션이 죽으면 상주 데몬이 헤드리스로 다시 띄웁니다.
- **사용량 초과 방어** — 한도로 죽어도 영구 포기하지 않고 지수 백오프 후 부활합니다.
- **모델 선택** — 추천은 도구가 내고 **결정은 사용자**가 합니다.
- **웹 콘솔** — 주행 중인 Claude Code 세션의 출력을 실시간으로 봅니다.

## 두 구현이 공존합니다

| | v1 (Python) | v2 (TypeScript) |
|---|---|---|
| 배포 | `~/.claude/skills/autoharness/bin/*.py` | 단일 EXE 하나 |
| 스케줄링 | OS 스케줄러(작업 스케줄러 / cron) | **상주 데몬이 자기 시계로** |
| 웹 UI | 없음 | 있음(콘솔·제어) |
| 상태 | 안정, 레퍼런스 구현 | 이식 완료, 실사용 검증 중 |

v2 를 만든 이유는 하나입니다. **v1 의 자동 부활이 OS 스케줄러에 의존하는데 그 의존이
깨질 수 있습니다.** 개발 PC 에서 시간 트리거 작업 전체가 `0x800710E0` 으로 큐에만 쌓이고
실행되지 않아, 워치독이 설치 이후 한 번도 돌지 않은 채 상태 조회는 "등록됨(Ready)"만
보고한 일이 있었습니다. 그래서 v2 는 스케줄링을 프로세스 안으로 가져왔습니다.

두 구현은 **같은 장부 스키마·같은 원자적 쓰기·같은 레지스트리 잠금 규약**을 씁니다. 그래서
저장소마다 따로 이행해도 되고, 이행 도중 섞여 있어도 안전합니다.

```
사용자 ── /autoharness ──▶ 스킬 (~/.claude/skills/autoharness/SKILL.md)
                              │  절차 지휘: init / resume / status / pause
                              ▼
                           MCP 서버 "autoharness" (사용자 스코프, 도구 14종)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   v1: harness_mcp.py                v2: <EXE> mcp
        (엔진 import)                  (데몬 위임 + 인프로세스 폴백)
              │                               │
              └───────────────┬───────────────┘
                              ▼
     대상 저장소  .claude/agent_tracker.json (장부) · 훅 4종 (settings.json)
        │
        └── 하트비트 ──▶ 레지스트리 (~/.claude/autoharness/registry.json)
                              ▲
              ┌───────────────┴───────────────┐
   v1: 워치독(스케줄러가 15분마다 호출)   v2: 상주 데몬(자기 시계로 tick, 웹 UI 내장)
              └───────────────┬───────────────┘
                              ▼
              죽은 세션을 claude -p 헤드리스로 재기동 (CLAUDE_AUTOHARNESS=1)
```

---

# 설치

**계정당 한 번**이면 됩니다. 설치 위치가 사용자 홈 아래 한 곳이라 데스크톱 앱·CLI·IDE
확장이 같은 것을 공유합니다.

| 무엇 | 어디에 |
|---|---|
| 스킬 문서 | `~/.claude/skills/autoharness/` |
| v2 실행 파일 | `~/.claude/autoharness/bin/autoharness(.exe)` |
| MCP 등록 | 사용자 스코프 (`claude mcp add --scope user`) |
| 런타임 상태 | `~/.claude/autoharness/` — 제거해도 **보존**됩니다 |

> **표기 규약**: 이 문서의 `autoharness` 는 설치된 실행 파일
> `~/.claude/autoharness/bin/autoharness` — Windows 에서는 `%USERPROFILE%\.claude\autoharness\bin\autoharness.exe` —
> 를 가리킵니다. **설치기는 PATH 를 건드리지 않습니다.** 짧은 이름으로 쓰시려면 그 디렉토리를
> PATH 에 추가하시고, 아니면 전체 경로로 부르십시오.

## 준비물

| 항목 | 요구 | 확인 |
|---|---|---|
| claude CLI | MCP 등록·세션 재기동에 필요 | `claude --version` |
| Python | v1 을 쓰거나 v2 를 빌드하지 않을 때 3.8+ (stdlib 만) | `python --version` |
| Bun | v2 를 직접 빌드할 때만 | `bun --version` |

## v1 설치 (Python — 가장 간단)

WSL / 리눅스 / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash
```

Windows PowerShell — 체크아웃이 필요합니다(`install.ps1` 이 자기 폴더 기준으로 동작합니다):

```powershell
git clone https://github.com/EcoKG/autoharness.git; cd autoharness; .\install.ps1
```

워치독까지 등록하려면 `-Watchdog`(PowerShell) 또는 `--watchdog`(bash)를 붙이십시오.
**curl 파이프에는 인자를 그냥 붙일 수 없습니다** — `bash` 가 먼저 먹습니다:

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash -s -- --watchdog
```

## v2 설치 (단일 EXE)

빌드한 뒤 EXE 스스로 설치합니다.

```bash
cd daemon && bun run build
# 산출물: Windows 는 dist/autoharness.exe, 리눅스·macOS 는 dist/autoharness
./dist/autoharness.exe install --exe "$PWD/dist/autoharness.exe" --skill ../skill --autostart
```

`--exe` 를 반드시 주십시오. `bun run` 으로 실행하면 `process.execPath` 가 **bun 자신**이라
런타임을 복사하게 됩니다. 설치기가 원본을 실행해 버전을 확인하므로 잘못된 원본은 거부되지만,
명시하는 편이 확실합니다.

무엇이 바뀔지 먼저 보려면:

```bash
./dist/autoharness.exe install --dry-run --autostart
```

리눅스·macOS 에서는 위 두 블록의 `./dist/autoharness.exe` 를 `./dist/autoharness` 로 읽으십시오.

### 자동 시작에 대해

`--autostart` 는 **로그온 트리거만** 씁니다(시간 트리거는 위에 적은 이유로 쓰지 않습니다).
작업 스케줄러 등록이 권한으로 거부되는 환경에서는 **시작프로그램 폴더**로 폴백하며, 어느
수단으로 걸렸는지 결과에 그대로 드러납니다. 폴백 산출물은
`시작프로그램\AutoHarnessDaemon.cmd` 이고 **그 파일을 지우면 해제**됩니다.

## 설치 확인

```bash
claude mcp list                    # autoharness ... ✔ Connected
autoharness install --status       # exe/스킬/자동 시작 실제 상태
autoharness selftest               # selftest 통과 (15/15)
```

v1 만 설치했다면 세 번째는 이렇게 확인합니다:

```bash
python ~/.claude/skills/autoharness/bin/harness_engine.py selftest
```

`install --status` 는 **파일 존재가 아니라 동작**으로 판정합니다. 파일이 있는데 우리 것이
아닌 상태(`exe_present: true, exe_installed: false`)를 구분해 보여 줍니다.

---

# 사용법

## 첫 주행 — 하네스 구축

새 Claude Code 세션에서 대상 저장소를 열고:

```
/autoharness 이 저장소를 검증하고 문제가 있으면 고쳐 주십시오
```

메커니즘이 아니라 **결과로 말해도 됩니다.** "테스트를 확충해 줘", "master 로 승격 가능한지
검증해 줘", "이 모듈을 X 로 이식해 줘" 같은 요청이 전부 이 스킬의 대상입니다.

스킬은 스택을 실측하고, 테스트 명령을 **실제로 한 번 돌려 본 뒤**, 모델 추천을 제시해
사용자의 선택을 받고, 훅과 장부를 심고, selftest 로 자가 검증한 뒤 주행을 시작합니다.
테스트가 전무하거나 전부 실패하면 **거기서 멈추고 보고합니다** — 검증 기준이 없으면 자가
치유 루프가 성립하지 않기 때문입니다.

## 이어서 주행

```
/autoharness resume
```

## 이미 하네스가 있는 저장소에 새 목표를 줄 때

`init` 을 다시 돌리지 마십시오 — 진행 상태가 날아갑니다. 그냥 결과로 말하면 스킬이 작업을
장부에 추가한 뒤 이어서 돕니다.

## 일상 명령

```
/autoharness status          진행률·다음 작업·배선 진단·데몬 상태
/autoharness pause           일시정지 (데몬·Stop 게이트 즉시 비활성)
/autoharness 다시 돌려        재개
```

## 웹 콘솔 (v2)

데몬이 로컬 웹 UI 를 함께 띄웁니다. 주소는 `~/.claude/autoharness/daemon.json` 의 `port`,
토큰은 같은 파일 또는 `~/.claude/autoharness/web-token` 에 있습니다.

화면에서 볼 수 있는 것:

- 전체 상태와 프로젝트별 상태·백오프·다음 예정 작업
- 선택한 프로젝트의 장부(작업·상태·시도 횟수·커밋 SHA)
- **주행 중인 Claude Code 세션의 출력** — 데몬의 판단 로그와 구분해 실시간으로 흐릅니다
  (전체 / 세션 출력만 / 데몬 판단만 으로 필터)
- 제어 버튼: 일시정지·재개·즉시 tick·세션 기동, 작업 상태 전환

## v1 → v2 이행

훅 배선만 바꾸고 **장부는 건드리지 않습니다.** 전후 바이트를 비교해 다르면 실패로 보고합니다.

```bash
autoharness install --migrate <저장소> --dry-run   # 계획 먼저
autoharness install --migrate <저장소>             # 실행 (설정은 백업 후 교체)
```

되돌리기는 백업 파일 하나를 복원하는 것으로 끝납니다:

```bash
autoharness install --rollback <저장소> --backup <settings.json.bak-…>
```

**한 번에 끝내지 않아도 됩니다.** 두 구현이 같은 스키마와 같은 잠금 규약을 쓰므로 섞여
있어도 장부가 깨지지 않습니다.

## 배포의 한계선

이 하네스가 하는 것은 **배포 가능 상태까지의 검증과 로컬 커밋**입니다. `git push`·태그
푸시·릴리스 발행은 훅이 차단합니다. 무인 세션에서는 하드 차단(exit 2)이고, 사람이 보고 있는
대화형 세션에서는 승인 창으로 승격됩니다 — 위험 모델이 "사람이 없을 때의 무단 원격 반영"
이기 때문입니다.

---

# 참고

## 종료 코드 (절대 기준)

| 코드 | 의미 | 다음 행동 |
|---|---|---|
| 0 | 검증 통과 (작업 done) | 커밋 후 다음 작업 |
| 1 | 검증 실패 (attempts+1) | 오류를 읽고 자가 수정 후 재실행 |
| 2 | 사용법·설정 오류 | 중단·보고 |
| 3 | 진행 가능한 작업 없음 | 요약 보고 후 종료 |
| 4 | 시도 한도 도달 (작업 blocked) | 남은 작업이 있으면 계속 |

## 훅이 강제하는 것

CLAUDE.md 는 안내층이고, **강제는 훅 소관**입니다. 문서를 고쳐도 우회되지 않습니다.

| 훅 | 강제하는 규칙 |
|---|---|
| SessionStart | 장부 요약을 컨텍스트에 주입(진행 복구) |
| PreToolUse | 금지 명령 차단 + **커밋 게이트** |
| PostToolUse | 커밋 SHA 를 장부에 기록(오귀속 방지) |
| Stop | 남은 작업이 있으면 헤드리스 세션 종료를 막음 |

**커밋 게이트의 통과 기록은 1회용입니다.** 통과한 작업에 커밋 SHA 가 붙는 순간 게이트가
다시 닫힙니다 — 한 번 통과했다고 이후 커밋이 무한히 열리지 않습니다.

**금지 명령 판정은 토큰 기반입니다.** 인용부호 안의 언급(`git log --grep=push`,
커밋 메시지에 든 "push")은 통과하고, 래퍼 우회(`bash -c`, `powershell -Command`)는 재귀
분석으로 잡습니다. 차단 대상은 두 축입니다 — 원격 변경(push, gh 쓰기 동사)과 되돌릴 수 없는
로컬 파괴(`reset --hard`, `clean -f`, `branch -D`, `checkout --`, `stash drop` 등).

**훅은 저장소를 못 박습니다.** 명령에 `--repo "${CLAUDE_PROJECT_DIR}"` 가 들어갑니다. 없으면
하위 디렉토리에서 게이트가 통째로 사라집니다(실측으로 확인된 결함).

## 대상 저장소에 생기는 파일

| 경로 | 내용 | git |
|---|---|---|
| `.claude/agent_tracker.json` | **장부 — 진실의 원천** | 추적 |
| `.claude/settings.json` | 훅 4종·권한 (기존 설정과 병합, 백업 생성) | 추적 |
| `PROGRESS.md` | 장부에서 렌더한 산출물 (직접 수정 금지) | 추적 |
| `.claude/harness-logs/` | 실행 로그 | 무시 |
| `.claude/harness-{state,heartbeat,hooks-seen}.json` | 런타임 상태 | 무시 |
| `CLAUDE.md` | 프로젝트 지침 (기존 내용 보존하며 병합) | 추적 |

v1 은 여기에 `scripts/harness_engine.py` 사본과 `scripts/agent_harness.sh` 를 더 둡니다.
v2 는 전역 EXE 를 참조하므로 저장소에 실행 코드를 두지 않습니다.

## 사용량 초과 방어

세션이 사용량 한도로 죽으면 **영구 포기하지 않습니다.** 30 → 60 → 120 → 240 → 360분
지수 백오프로 재시도하며 `status` 는 `active` 로 남습니다. 다만 이 분류가 연속되면 실제
한도가 아니라 오분류일 수 있으므로 사람이 볼 신호를 남깁니다.

설정 오류성 실패(`error`)는 다르게 다룹니다 — 15 → 30 → 60분 백오프에 **5회 연속이면 정지**
하고 사람을 부릅니다.

## 보안 (v2 웹)

데몬은 프로젝트를 멈추고 세션을 기동할 수 있습니다. 명령을 받을 수 있다는 것은 곧 로컬
공격 표면이므로 다음은 타협하지 않습니다.

- **`127.0.0.1` 에만 바인드** — 외부 인터페이스 옵션을 만들지 않습니다.
- **토큰 필수** — 없거나 틀리면 401. 쿠키 인증을 쓰지 않습니다(CSRF).
- **상태 변경은 POST 만**, `Host` 검사로 DNS 리바인딩 차단, CORS 미개방.
- **화이트리스트된 동작만** — 프로젝트 동작은 pause/resume/tick/launch, 작업 상태는
  pending/blocked 만. `done` 은 웹에서 만들 수 없습니다(러너 성공으로만 생깁니다).
- **임의 셸 실행 경로 없음** — MCP 위임 경로도 노출 도구를 좁히고, 값이 셸로 직행하는
  인자는 거부합니다.
- UI 는 외부 CDN 을 부르지 않습니다(오프라인 동작). 토큰은 sessionStorage 에만 둡니다.

## 실측 수치

| 항목 | 값 |
|---|---|
| 훅 콜드 스타트 p95 | 유휴 시 81~82ms (예산 150ms) — 아래 주석 참고 |
| EXE 크기 / 빌드 | 94.1 MiB / 0.7~0.9초 |
| v1↔v2 교차 검증 | 365건 대조, 불일치 0건 |
| 데몬 드리프트 | 가속 500 tick 편차 0, 실시간 60 tick 평균 간격 정확 |
| 테스트 | v2 530건, v1 397건 (2026-08-10) |

재현: `bun run bench:startup`, `bun run parity`, `bun run verify:exe`, `bun test`

**콜드 스타트는 기기 부하에 민감합니다.** 유휴 상태에서는 p95 81~82ms 로 일관되지만, 다른
작업이 CPU 를 점유한 상태에서 재면 110~180ms 까지 오르며 예산을 넘기기도 합니다. 이 수치를
받아들일 때는 측정 조건을 함께 보십시오 — 단일 값 하나로 판정할 성질이 아닙니다.

## 제거

```bash
autoharness install --uninstall     # 자동 시작·MCP 등록 해제
```

**장부·레지스트리·로그는 남습니다** — 진행 상태를 지우지 않습니다. 완전히 지우려면
`~/.claude/skills/autoharness/`, `~/.claude/autoharness/bin/` 을 직접 삭제하십시오.
대상 저장소의 훅을 되돌리려면 위의 `--rollback` 을 쓰십시오.

---

# 문제 해결

**`/autoharness` 가 안 뜹니다** — 새 세션을 여십시오. 스킬은 세션 시작 시 읽힙니다.

**MCP 가 `Failed to connect` 입니다** — `autoharness install --status` 로 `exe_installed` 를
보십시오. `exe_present: true, exe_installed: false` 면 그 자리에 우리 것이 아닌 파일이
있는 것입니다(대표적으로 `bun run` 으로 설치해 런타임이 복사된 경우). 다시 빌드해
`--exe` 로 지정해 설치하십시오.

**훅이 안 걸립니다** — `status` 의 `hooks.state` 를 보십시오.

| 값 | 뜻 |
|---|---|
| `not_registered` | 훅 미등록(수동 운용) — 경고 대상이 아닙니다 |
| `active` | 등록됐고 실제로 발화한 기록이 있습니다 |
| `inactive` | 등록됐지만 한 번도 발화한 적이 없습니다 — **배선이 끊겼습니다** |

`inactive` 의 가장 흔한 원인은 **세션의 프로젝트 루트가 저장소 밖**인 것입니다. 그러면
저장소의 `.claude/settings.json` 이 로드되지 않아 훅 4종이 조용히 전부 죽습니다. 저장소
루트에서 `claude` 를 실행하십시오.

`settings.json` 이 깨진 경우도 같은 증상인데, 진단이 이 둘을 구분해 알려 줍니다.

**데몬이 도는지 모르겠습니다** — `daemon.log` 의 `tick` 줄과 `/api/status` 의 `pid`·
`uptime_sec` 을 보십시오. 레지스트리의 `last_tick` 은 v1 워치독도 갱신하므로 v2 데몬의
생존 증거로는 약합니다.

**두 감독자가 동시에 돕니다** — v1 워치독과 v2 데몬을 함께 두면 같은 저장소에 세션이 두 번
뜰 수 있습니다. 이행이 끝나면 v1 워치독을 내리십시오:

```bash
schtasks /Delete /TN AutoHarnessWatchdog /F
```

**작업이 blocked 됐습니다** — 시도 5회를 넘겼거나 사람 판단이 필요한 경계에 닿은 것입니다.
`PROGRESS.md` 와 장부의 `last_error` 에 사유가 있습니다. 해결한 뒤 `pending` 으로 되돌리면
다시 주행 대상이 됩니다.
