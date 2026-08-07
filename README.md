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
                              │ 15분마다 판독 (작업 스케줄러 AutoHarnessWatchdog / cron)
                           워치독 (bin/harness_watchdog.py)
                              └─ 죽은 세션을 claude -p 헤드리스로 재기동 (CLAUDE_AUTOHARNESS=1)
```

---

# 설치

## 먼저 알아 두실 것

**설치는 계정당 한 번이면 됩니다.** 설치 위치가 사용자 홈 아래 한 곳이고, 데스크톱 앱·CLI·
IDE 확장이 **같은 위치를 공유**하기 때문입니다.

| 무엇 | 어디에 |
|---|---|
| 스킬·코드 | `~/.claude/skills/autoharness/` (Windows: `%USERPROFILE%\.claude\skills\autoharness\`) |
| MCP 등록 | 사용자 스코프 (`claude mcp add --scope user`) |
| 런타임 상태 | `~/.claude/autoharness/` (registry.json, logs/) — 제거해도 **보존**됩니다 |

아래 세 절 중 **본인 환경 하나만** 수행하시면 됩니다. 이후 사용법은 전부 동일합니다.

### 준비물 (공통)

| 항목 | 요구 | 확인 명령 |
|---|---|---|
| Python | 3.8 이상 (stdlib 만 사용 — 추가 패키지 없음) | `python --version` / `python3 --version` |
| claude CLI | MCP 자동 등록·워치독 재기동에 필요 | `claude --version` |

claude CLI 가 없어도 스킬·엔진은 설치되지만 MCP 등록이 건너뛰어집니다. 이 경우에도 스킬이
폴백 경로(`python scripts/harness_engine.py ...` 직접 실행)로 동작하므로 주행 자체는 됩니다.

---

## 1. Claude Code 데스크톱 앱 (Windows / macOS)

데스크톱 앱에는 셸이 따로 없으므로, **Code 탭에서 Claude 에게 설치를 맡기는 것**이 가장 간단합니다.

**① 저장소를 받습니다.** (Windows 설치기는 다운로드 기능이 없어 체크아웃이 필요합니다)

```bash
git clone https://github.com/EcoKG/autoharness.git
```

**② 앱에서 그 폴더를 열고, Code 탭에서 이렇게 요청하십시오.**

```
이 폴더의 install.ps1 을 실행해서 AutoHarness 를 설치해줘 (워치독까지)
```

Claude 가 아래 명령을 대신 실행합니다. 직접 터미널에서 실행하셔도 결과는 같습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog
```

**③ 반드시 지켜야 할 두 가지 — 이걸 어기면 안전장치가 조용히 죽습니다.**

- **Code 탭에서 쓰십시오.** 일반 채팅 탭에는 훅 개념이 없어 커밋 게이트·금지 명령 차단·Stop
  게이트가 전부 동작하지 않습니다.
- **저장소 루트를 프로젝트로 여십시오.** 상위 폴더를 열면 저장소의 `.claude/settings.json` 이
  로드되지 않아 훅 4종이 전부 비활성화됩니다. 주행은 정상처럼 보이지만 게이트는 전부 무력인
  상태가 됩니다. 이 상태는 `/autoharness status` 의 `hooks.state` 가 `inactive` 로 알려 줍니다.

> macOS 데스크톱 앱은 아래 **3. WSL / 리눅스** 의 `install.sh` 를 쓰시면 됩니다.
> (macOS 에서의 동작은 실측 검증되지 않았습니다 — cron 기반 워치독은 환경에 따라 조정이 필요할 수 있습니다.)

---

## 2. CLI (Windows 터미널)

터미널에서 직접 실행하는 경로입니다.

```powershell
git clone https://github.com/EcoKG/autoharness.git
cd autoharness
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

워치독(세션 자동 부활)은 **별도 등록**입니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Watchdog -IntervalMinutes 10
```

- 워치독은 **Windows 작업 스케줄러**에 `AutoHarnessWatchdog` 작업으로 등록됩니다(기본 15분 간격).
- 기존 설치가 있으면 `~/.claude/skills/autoharness.bak-<시각>` 으로 백업한 뒤 갱신합니다.
- 업데이트는 `git pull` 후 같은 명령을 다시 실행하시면 됩니다.

---

## 3. WSL / 리눅스

유일하게 **원라인 설치**가 되는 경로입니다(설치기가 GitHub 타르볼을 직접 내려받습니다).

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash
```

워치독(cron, 15분 간격)까지 한 번에:

```bash
curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash -s -- --watchdog
```

체크아웃에서 실행하실 수도 있습니다: `bash install.sh [--watchdog] [--uninstall]`

- 워치독은 **cron** 에 등록됩니다. **WSL 은 cron 데몬이 꺼져 있는 경우가 많습니다** —
  `sudo service cron start` 또는 `/etc/wsl.conf` 에 `[boot] systemd=true` 를 설정해야 자동
  부활이 동작합니다(설치기가 감지해 안내합니다).
- 환경변수로 조정 가능: `AUTOHARNESS_INTERVAL`(cron 간격, 기본 15), `AUTOHARNESS_BRANCH`(기본 main)

---

## 설치 확인 (공통)

세 경로 어느 쪽이든, 아래 셋이 모두 확인되면 설치가 끝난 것입니다.

**① MCP 등록** — 출력에 `autoharness: ... ✔ Connected` 줄이 있어야 합니다.

```bash
claude mcp list
```

**② 엔진 자가검증** — `selftest 통과 (15/15)` 가 나와야 합니다.

Windows:

```powershell
python "$env:USERPROFILE\.claude\skills\autoharness\bin\harness_engine.py" selftest
```

WSL / 리눅스:

```bash
python3 ~/.claude/skills/autoharness/bin/harness_engine.py selftest
```

**③ 스킬 인식** — 새 Claude Code 세션에서 `/autoharness` 가 자동완성에 뜨면 됩니다.

워치독 등록까지 하셨다면 상태를 함께 확인하십시오. 새 Claude Code 세션에서 이렇게 물으시면 됩니다.

```
/autoharness status
```

`hooks` 와 워치독 `health` 진단이 함께 나옵니다. **등록만 되고 실제로는 한 번도 실행되지 않는
상태**(스케줄러가 기동을 반려하는 경우)도 여기서 결과 코드와 함께 드러납니다.

---

# 공통 사용법

설치가 끝나면 환경에 관계없이 사용법은 같습니다.

## 첫 주행 — 하네스 구축

대상 저장소에서 새 Claude Code 세션을 열고 요청하십시오.

```
/autoharness init
```

1. **스택 실측** — `harness_detect` 가 빌드 도구·테스트 디렉토리·린트 설정을 훑고, 실제 테스트를
   **1회 실행해** 명령을 검증합니다. 테스트가 전무하거나 전부 실패하면 여기서 중단하고 보고합니다
   (검증 기준이 없으면 자가 치유 루프가 성립하지 않기 때문입니다).
2. **모델 선택** — 추천은 도구가, **결정은 사용자**가 합니다. `model_recommend` 휴리스틱이
   `claude-fable-5` / `claude-opus-5` 중 하나를 근거와 함께 제시하고, 질문 창에서 최종 선택하십시오.
   결정된 모델은 장부·레지스트리에 기록되며 워치독도 그 모델로 재기동합니다.
3. **하네스 구축** — 장부·훅 4종·엔진 사본·CLAUDE.md 가 설치되고, 작업 계획이 장부에 적재됩니다.
4. **자가검증·워치독 등록** — `selftest` 7종 15항목이 전부 PASS 해야 다음으로 넘어갑니다.

## 자율 주행

이후 세션은 **"코드 수정 → `bash scripts/agent_harness.sh --task <id>` → 종료 코드 분기 → 커밋"**
루프를 반복합니다. 진행 가능한 작업이 남아 있는 한 Stop 훅이 세션을 놓아주지 않고, 세션이
죽으면(사용량 초과 포함) 워치독이 15분 주기 판독에서 감지해 자동 부활시킵니다.

이어서 하실 때는 이렇게만 말씀하시면 됩니다.

```
/autoharness resume
```

## 이미 하네스가 있는 저장소에 새 목표를 줄 때

**init 을 다시 돌리지 마십시오** — 장부가 초기화되어 진행 상태가 사라집니다. 새 작업을
`task_add` 로 적재한 뒤 resume 하는 것이 정규 경로이고, `/autoharness <하고 싶은 일>` 로
말씀하시면 스킬이 장부 유무를 보고 알아서 이 경로를 택합니다.

요청은 메커니즘이 아니라 **결과로 말하셔도 됩니다** — "검증하고 문제 있으면 수정해줘",
"master 로 승격 가능한지 확인해줘", "테스트 확충해줘" 같은 요청도 전부 자율 주행 대상입니다.
주행이 이미 완료(`completed`)된 프로젝트라면 작업 추가만으로 워치독이 다시 살아납니다.

## 일상 명령

| 하고 싶은 것 | 명령 |
|---|---|
| 진행 상황 확인 | `/autoharness status` (또는 대상 저장소의 `PROGRESS.md`) |
| 주행 재개 | `/autoharness resume` |
| 잠시 멈춤 | `/autoharness pause` — 플래그 생성, 워치독·Stop 게이트 즉시 비활성 |
| 멈춘 것 다시 돌리기 | `/autoharness resume-project` — 플래그 제거, 백오프 리셋 |
| 특정 작업 재시도 | `/autoharness` 로 "작업 `<id>` 를 pending 으로 되돌려줘" |

## 배포의 한계선

이 하네스가 하는 것은 **배포 가능 상태까지의 검증과 로컬 커밋**입니다. `git push`·태그 푸시·
릴리스 발행은 훅이 차단하므로 **사람이 직접 하셔야 합니다.** "배포해줘" 라고 하셔도 로컬
커밋까지만 진행되고, 남은 것은 보고서의 "사람 판단 필요 항목"에 남습니다.

---

# 참고

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

## 훅이 강제하는 규칙

CLAUDE.md 는 강제층이 아니므로, "특정 시점 무조건 실행" 규칙은 전부 훅으로 구현되어 있습니다.

| 훅 | 강제하는 규칙 |
|---|---|
| SessionStart | 세션 시작·compact 직후 장부 요약을 컨텍스트에 주입해 진행을 복구합니다 |
| PreToolUse(`Bash\|PowerShell`) | `git push`·`--force`·`reset --hard`·`clean -f` 차단, **커밋 게이트**(하네스 검증 통과 없이는 `git commit` 차단) |
| PostToolUse(`Bash\|PowerShell`) | `git commit` 직후 done 작업에 커밋 SHA 자동 기록 + 하트비트. 커밋이 실제로 새 커밋을 만든 경우에만 기록합니다(nothing to commit 오귀속 방지) |
| Stop | 자율 주행 게이트 — 남은 작업이 있으면 세션 종료를 막고 다음 작업을 지시. 대화형 세션(`CLAUDE_AUTOHARNESS` 미설정)·일시정지·무진전 3회 초과 시에는 개입하지 않습니다 |

**훅은 저장소 `.claude/settings.json` 이 로드될 때만 동작합니다.** 프로젝트 루트가 저장소 밖이면
훅 4종이 전부 조용히 비활성화되므로, 엔진이 이를 감지해 `run` 시작 시 경고하고
`status`/`brief` 에 `hooks.state = inactive` 로 표시합니다.

## 대상 저장소에 생기는 파일

| 경로 | 역할 |
|---|---|
| `.claude/agent_tracker.json` | 상태 장부 — **진실의 원천** (손 편집 비권장) |
| `.claude/agent_tracker.example.json` | 장부 스키마 예시 |
| `.claude/harness-logs/` | 작업별 빌드·테스트 전체 로그 |
| `.claude/harness-state.json` | 러너·Stop 훅 내부 상태(직전 실행, 진전 가드) |
| `.claude/harness-heartbeat.json` | 하트비트 — 워치독의 이중 기동 방지 근거 (검증 실행 중 5분 주기 자동 갱신) |
| `.claude/harness-hooks-seen.json` | 훅 발화 마커 — 배선이 살아 있는지 판정하는 근거 |
| `.claude/HARNESS_PAUSED` | 존재하면 일시정지 (플래그 파일) |
| `.claude/settings.json` | 훅 4종·권한이 **병합**됩니다 (원본은 `.bak-<시각>` 백업) |
| `scripts/harness_engine.py` | 엔진 사본 — 훅·러너가 호출 (단독 동작, stdlib만) |
| `scripts/agent_harness.sh` | 진입 래퍼 — `bash scripts/agent_harness.sh --task <id>` |
| `PROGRESS.md` | 장부에서 자동 렌더되는 진행 현황 (직접 수정 금지) |
| `CLAUDE.md` | 하네스 규칙 골격 병합 (기존 파일은 백업 후 병합) |

## 사용량 초과 방어 동작

워치독이 재기동 직후 90초 안에 세션이 죽고 출력에 사용량 패턴(`usage limit`, `rate limit`,
`limit reached`, `overloaded`, `quota`, `credit balance`, 그리고 `429` 는 API 오류 문맥에
인접할 때만 — "collected 429 items" 같은 우연 문자열 오탐 방지)이 보이면 **limit** 으로 분류합니다.

- **limit**: 지수 백오프 **30 → 60 → 120 → 240 → 360분** 후 재시도합니다(이후에도 360분 간격
  반복). **영구 포기는 없습니다** — 한도가 풀리면 자동으로 다시 달립니다.
- **error**(사용량 외 비정상 종료): 15 → 30 → 60분 백오프로 재시도하되, **5회 연속** 실패하면
  설정성 오류로 보고 `status=error` 로 정지합니다(사람 확인 필요, 사유는 watchdog.log 에 기록).
- 90초 생존 또는 정상 종료(rc=0)면 카운터가 리셋되고 세션은 분리되어 계속 달립니다.

## 제거

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

```bash
bash ~/.claude/skills/autoharness/install.sh --uninstall
```

스케줄러 작업(또는 cron 항목)·MCP 등록·스킬 폴더가 제거됩니다. 런타임 상태
(`~/.claude/autoharness/`)는 **보존**되므로 재설치하시면 프로젝트 상태가 그대로 이어집니다.
대상 저장소 안의 생성물은 저장소별로 직접 정리하시면 됩니다.

---

# 문제 해결

**1. 훅이 동작하지 않는 것 같을 때**

`/autoharness status` 의 `hooks.state` 를 보십시오.

| 값 | 뜻 | 조치 |
|---|---|---|
| `active` | 정상 — 실제 발화 기록이 있음 | — |
| `inactive` | 등록됐지만 한 번도 발화하지 않음 | **프로젝트 루트가 저장소 루트인지** 확인. 데스크톱 앱이면 Code 탭인지 확인 |
| `not_registered` | 훅 미등록(수동 운용) | 정상 — 경고 대상이 아닙니다 |

**2. 워치독이 무엇을 했는지 보고 싶을 때**

- `~/.claude/autoharness/logs/watchdog.log` — 판단·기동·백오프가 한 줄씩 기록됩니다
- 세션별 출력: `~/.claude/autoharness/logs/<프로젝트>-<시각>.log`

**3. 워치독이 등록만 되고 실행이 안 될 때**

`/autoharness status` 의 워치독 `health` 가 스케줄러 마지막 결과 코드를 해석해 보고합니다
(`0x800710E0` 요청 거부, `0x8004131F` 인스턴스 중복, `0x80070002` 경로 없음 등).
`state` 가 `stale` 이면 등록은 돼 있으나 실제로 돌지 않는 상태입니다.

```powershell
schtasks /Query /TN AutoHarnessWatchdog /V /FO LIST
```

**4. MCP 서버가 안 잡힐 때**

`claude mcp list` 에서 `autoharness` 줄을 확인하십시오. 등록 전이거나 실패한 환경에서는
스킬이 폴백으로 `python scripts/harness_engine.py ...` 를 직접 실행하므로 주행은 계속됩니다.

**5. 세션이 계속 안 뜰 때**

레지스트리(`~/.claude/autoharness/registry.json`)의 프로젝트 `status` 를 확인하십시오.
`error`(설정성 오류 5연속)·`needs_human`(blocked 작업 존재)은 사람 확인 후
`/autoharness resume-project` 로 재개하시면 됩니다. `completed` 는 새 작업을 `task_add` 로
추가하는 것만으로 자동 재활성화됩니다(백오프 리셋 포함).

**6. auto 모드 분류기가 `harness_init` 을 차단할 때**

settings.json 훅 주입과 권한 우회 등록은 분류기가 막도록 설계된 패턴이라 정상 동작입니다.
에이전트가 엔진 init(장부 생성)까지 진행한 뒤, 나머지(사본 보완·훅 병합·레지스트리 등록)는
**직접 터미널에서** 한 줄로 마무리하십시오.

```bash
python3 ~/.claude/skills/autoharness/bin/harness_mcp.py finish-init --repo <저장소경로> --permission-mode bypass
```

또는 해당 세션의 권한 모드를 auto 에서 default/acceptEdits 로 바꾸면(Shift+Tab) 차단 대신
승인 프롬프트를 받게 됩니다.
