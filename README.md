# AutoHarness — 자율 주행 마이그레이션 하네스

AutoHarness 는 "자율 주행 마이그레이션 하네스 구축" 절차(스택 실측 → 하네스 구축 → 모델 선택 →
자가검증 → 자율 주행)를 **어느 저장소에서든 재사용 가능한 패키지**로 만든 것입니다.
개인 스킬 + 사용자 스코프 MCP 서버 + 워치독, 셋이 결합된 하나의 패키지입니다.

- **무개입 주행**: 주행 중 사용자에게 질문하지 않습니다. Stop 훅 게이트가 세션을 붙잡아 루프를
  유지하고, 세션이 죽으면 워치독이 헤드리스로 재기동합니다.
- **사용량 초과 방어**: 사용량 한도로 세션이 죽어도 영구 포기하지 않고 지수 백오프 후 자동 부활합니다.
- **모델 선택**: 추천은 휴리스틱 도구가 내고, **결정은 사용자**가 init 시점에 직접 내립니다.

## 아키텍처

```
사용자 ── /autoharness ──▶ 개인 스킬 (~/.claude/skills/autoharness/SKILL.md)
                              │  절차 지휘: init / resume / status / pause
                              ▼
                           MCP 서버 "autoharness" (bin/harness_mcp.py, user 스코프)
                              │  장부·러너·레지스트리·워치독 관리 도구 14종
                              │  (엔진 harness_engine.py 를 import 하여 수행)
                              ▼
     대상 저장소 ◀── 엔진 사본 설치: scripts/harness_engine.py + scripts/agent_harness.sh
        │              .claude/agent_tracker.json(장부) · 훅 4종(settings.json 병합)
        │
        └── 하트비트 ──▶ 레지스트리 (~/.claude/autoharness/registry.json)
                              ▲
                              │ 15분마다 판독 (작업 스케줄러 AutoHarnessWatchdog)
                           워치독 (bin/harness_watchdog.py)
                              └─ 죽은 세션을 claude -p 헤드리스로 재기동 (CLAUDE_AUTOHARNESS=1)
```

## 설치

### Linux / WSL — 원라인 설치

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash
```

워치독(cron, 15분 간격)까지 한 번에:

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash -s -- --watchdog
```

- WSL 은 cron 데몬이 꺼져 있을 수 있습니다 — `sudo service cron start` 또는 `/etc/wsl.conf` 에
  `[boot] systemd=true` 를 설정해야 자동 부활이 동작합니다(설치기가 감지해 안내합니다).
- 제거: `bash ~/.claude/skills/autoharness/install.sh --uninstall`

### Windows — 이 폴더(체크아웃)에서 한 줄 실행

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

- 스킬·코드가 `%USERPROFILE%\.claude\skills\autoharness\` 로 복사됩니다(기존 설치는 `.bak-<시각>` 백업).
- MCP 서버가 사용자 스코프 `autoharness` 로 등록되고, `claude mcp list` 로 확인 결과가 표시됩니다.
- 워치독(세션 자동 부활)은 별도 등록입니다:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog          # 15분 간격
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog -IntervalMinutes 10
```

## 사용 흐름

1. 대상 저장소에서 새 Claude Code 세션을 열고 `/autoharness init` 을 실행합니다.
   - 스택 실측(`harness_detect`)과 실제 테스트 1회 실행으로 명령을 검증합니다.
2. 모델을 선택합니다 — **추천은 도구, 결정은 사용자**입니다.
   - `model_recommend` 휴리스틱이 `claude-fable-5` / `claude-opus-5` 중 하나를 근거와 함께
     추천하고, 사용자가 질문 창(AskUserQuestion)에서 최종 결정합니다.
   - 결정된 모델은 장부·레지스트리에 기록되며, 워치독도 그 모델로 재기동합니다.
3. 하네스가 구축되고(장부·훅·엔진 사본·CLAUDE.md), 마이그레이션 계획이 작업 단위로 장부에
   적재된 뒤, `selftest` 자가검증(7종)과 워치독 등록까지 자동으로 이어집니다.
4. 자율 주행: 세션이 "코드 수정 → `bash scripts/agent_harness.sh --task <id>` → 종료 코드 분기 →
   커밋" 루프를 반복합니다. Stop 훅이 진행 가능한 작업이 남아 있는 한 세션을 놓아주지 않습니다.
5. 세션이 죽으면(사용량 초과 포함) 워치독이 15분 주기 판독에서 감지해 자동 부활시킵니다.
   상태 확인은 `/autoharness status`, 진행 현황은 대상 저장소의 `PROGRESS.md` 를 보시면 됩니다.

## 사용량 초과 방어 동작

워치독이 재기동 직후 90초 안에 세션이 죽고 출력에 사용량 패턴(`usage limit`, `rate limit`,
`limit reached`, `429`, `overloaded`, `quota`, `credit balance`)이 보이면 **limit** 으로 분류합니다.

- **limit**: 지수 백오프 **30 → 60 → 120 → 240 → 360분** 후 재시도합니다(이후에도 360분 간격
  반복). **영구 포기는 없습니다** — 한도가 풀리면 자동으로 다시 달립니다.
- **error**(사용량 외 비정상 종료): 15 → 30 → 60분 백오프로 재시도하되, **5회 연속** 실패하면
  설정성 오류로 보고 `status=error` 로 정지합니다(사람 확인 필요, 사유는 watchdog.log 에 기록).
- 90초 생존 또는 정상 종료(rc=0)면 카운터가 리셋되고 세션은 분리되어 계속 달립니다.

## 종료 코드 표 (`harness run` / `agent_harness.sh`)

| 코드 | 의미 | 에이전트 행동 |
|---|---|---|
| 0 | 검증 통과 (task → done) | 커밋 후 다음 작업 |
| 1 | 검증 실패 (attempts+1, last_error 기록) | 자가 치유 계속 |
| 2 | 사용법/설정 오류 | 중단·보고 |
| 3 | 진행 가능한 작업 없음 | 중단·보고 |
| 4 | max_attempts 도달 (task → blocked) | 해당 작업 봉인 — 남은 작업이 있으면 계속, 없으면 보고 (사람 판단 필요) |

※ `run` 은 이미 blocked 인 작업을 지정했거나 blocked 만 남은 상태에서도 4 를 반환합니다
(같은 상태에서 `next` 는 3). 두 경우 모두 사람 판단이 필요한 상태라는 뜻입니다.

## 대상 저장소에 생기는 파일

| 경로 | 역할 |
|---|---|
| `.claude/agent_tracker.json` | 상태 장부 — **진실의 원천** (손 편집 비권장) |
| `.claude/agent_tracker.example.json` | 장부 스키마 예시 |
| `.claude/harness-logs/` | 작업별 빌드·테스트 전체 로그 |
| `.claude/harness-state.json` | 러너·Stop 훅 내부 상태(직전 실행, 진전 가드) |
| `.claude/harness-heartbeat.json` | 하트비트 — 워치독의 이중 기동 방지 근거 |
| `.claude/HARNESS_PAUSED` | 존재하면 일시정지 (플래그 파일) |
| `.claude/settings.json` | 훅 4종·권한이 **병합**됩니다 (원본은 `.bak-<시각>` 백업) |
| `scripts/harness_engine.py` | 엔진 사본 — 훅·러너가 호출 (단독 동작, stdlib만) |
| `scripts/agent_harness.sh` | 진입 래퍼 — `bash scripts/agent_harness.sh --task <id>` |
| `PROGRESS.md` | 장부에서 자동 렌더되는 진행 현황 (직접 수정 금지) |
| `CLAUDE.md` | 하네스 규칙 골격 병합 (기존 파일은 백업 후 병합) |

## 훅이 강제하는 규칙

CLAUDE.md 는 강제층이 아니므로, "특정 시점 무조건 실행" 규칙은 전부 훅으로 구현되어 있습니다.

| 훅 | 강제하는 규칙 |
|---|---|
| SessionStart | 세션 시작·compact 직후 장부 요약을 컨텍스트에 주입해 진행을 복구합니다 |
| PreToolUse(Bash) | `git push`·`--force`·`reset --hard`·`clean -f` 차단, **커밋 게이트**(하네스 검증 통과 없이는 `git commit` 차단) |
| PostToolUse(Bash) | `git commit` 직후 done 작업에 커밋 SHA 자동 기록 + 하트비트 |
| Stop | 자율 주행 게이트 — 남은 작업이 있으면 세션 종료를 막고 다음 작업을 지시. 대화형 세션(`CLAUDE_AUTOHARNESS` 미설정)·일시정지·무진전 3회 초과 시에는 개입하지 않습니다 |

## 일시정지 · 재개 · 제거

- **일시정지**: `/autoharness pause` (또는 MCP `harness_pause`) — `.claude/HARNESS_PAUSED` 플래그가
  생성되고 레지스트리가 `paused` 로 바뀌어 워치독이 건드리지 않습니다.
- **재개**: `/autoharness resume-project` (또는 MCP `harness_resume_project`) — 플래그 제거,
  `active` 복귀, 백오프 카운터 리셋.
- **제거**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

  스케줄러 작업·MCP 등록·스킬 폴더가 제거됩니다. 런타임 상태(`%USERPROFILE%\.claude\autoharness\`)는
  **보존**되므로, 재설치하시면 프로젝트 상태가 그대로 이어집니다. 대상 저장소 안의 생성물은
  저장소별로 직접 정리하시면 됩니다.

## 문제 해결

1. **워치독이 무엇을 했는지 보고 싶을 때** — 로그를 확인하십시오.
   - `%USERPROFILE%\.claude\autoharness\logs\watchdog.log` (판단·기동·백오프가 한 줄씩 기록됩니다)
   - 세션별 출력: `%USERPROFILE%\.claude\autoharness\logs\<프로젝트>-<시각>.log`
2. **워치독 작업이 등록되어 있는지 확인** —
   `schtasks /Query /TN AutoHarnessWatchdog /V /FO LIST`
   (없다면 `install.ps1 -Watchdog` 로 다시 등록하시면 됩니다)
3. **MCP 서버가 안 잡힐 때** — `claude mcp list` 에서 `autoharness` 줄을 확인하십시오.
   등록 전이거나 실패한 환경에서는 스킬이 폴백으로 `python scripts/harness_engine.py ...` 를
   직접 실행하므로 주행 자체는 계속됩니다.
4. **세션이 계속 안 뜰 때** — 레지스트리(`~/.claude/autoharness/registry.json`)의 프로젝트
   `status` 를 확인하십시오. `error`(설정성 오류 5연속)·`needs_human`(blocked 작업 존재)은
   사람 확인 후 `/autoharness resume-project` 로 재개하시면 됩니다.
5. **일시 점검이 필요할 때** — `/autoharness pause` 후 작업하고, 끝나면 resume-project 하십시오.
   워치독 자체를 멈추려면 `schtasks /Delete /TN AutoHarnessWatchdog /F` 를 실행하시면 됩니다.
6. **auto 모드 분류기가 `harness_init` 을 차단할 때** — settings.json 훅 주입과 권한 우회
   등록은 분류기가 막도록 설계된 패턴이라 정상 동작입니다. 에이전트가 엔진 init(장부 생성)까지
   진행한 뒤, 나머지(사본 보완·훅 병합·레지스트리 등록)는 **직접 터미널에서** 한 줄로 마무리하십시오:

   ```bash
   python3 ~/.claude/skills/autoharness/bin/harness_mcp.py finish-init --repo <저장소경로> --permission-mode bypass
   ```

   또는 해당 세션의 권한 모드를 auto 에서 default/acceptEdits 로 바꾸면(Shift+Tab) 차단 대신
   승인 프롬프트를 받게 됩니다.
