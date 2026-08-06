#!/usr/bin/env bash
# AutoHarness 설치기 — Linux / WSL 용.
#
# 원라인 설치 (curl 파이프):
#   curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash
# 워치독(cron)까지:
#   curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash -s -- --watchdog
# 체크아웃에서 실행:
#   bash install.sh [--watchdog] [--uninstall]
#
# 환경변수: AUTOHARNESS_BRANCH(기본 main), AUTOHARNESS_INTERVAL(cron 간격 분, 기본 15)

set -euo pipefail

REPO_OWNER="${AUTOHARNESS_REPO_OWNER:-EcoKG}"
REPO_NAME="${AUTOHARNESS_REPO_NAME:-autoharness}"
BRANCH="${AUTOHARNESS_BRANCH:-main}"
INTERVAL="${AUTOHARNESS_INTERVAL:-15}"
DST="$HOME/.claude/skills/autoharness"
RUNTIME="$HOME/.claude/autoharness"
CRON_MARK="harness_watchdog.py"

MODE="install"
DO_WATCHDOG=0
for a in "$@"; do
    case "$a" in
        --watchdog)  DO_WATCHDOG=1 ;;
        --uninstall) MODE="uninstall" ;;
        *) echo "[autoharness] 알 수 없는 인자: $a (사용: --watchdog | --uninstall)" >&2; exit 2 ;;
    esac
done

step() { echo "[autoharness] $*"; }

find_python() {
    for c in python3 python; do
        if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys; assert sys.version_info >= (3, 8)" >/dev/null 2>&1; then
            command -v "$c"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------- 제거
if [ "$MODE" = "uninstall" ]; then
    if crontab -l 2>/dev/null | grep -q "$CRON_MARK"; then
        crontab -l 2>/dev/null | grep -v "$CRON_MARK" | crontab - || true
        step "cron 워치독 항목 제거 완료"
    else
        step "cron 워치독 항목 없음 (건너뜀)"
    fi
    if command -v claude >/dev/null 2>&1; then
        claude mcp remove --scope user autoharness >/dev/null 2>&1 || true
        step "MCP 등록 제거 시도: autoharness (없으면 무시)"
    fi
    if [ -d "$DST" ]; then
        rm -rf "$DST"
        step "스킬 폴더 제거 완료: $DST"
    fi
    step "런타임 상태는 보존됩니다: $RUNTIME (registry.json·로그 유지 — 재설치 시 이어짐)"
    exit 0
fi

# ---------------------------------------------------------------- 설치
PY="$(find_python)" || { step "python3(3.8+)를 찾을 수 없습니다. 설치 후 다시 실행하십시오."; exit 1; }
step "python: $PY"

# 원본 확보: 체크아웃(skill/SKILL.md 존재)이면 그 폴더를, 설치본에서 실행 중이면 설치 단계를
# 건너뛰고(워치독 전용), 그 외(curl 파이프)는 GitHub 타르볼을 받는다.
SRC=""
SKIP_INSTALL=0
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/skill/SKILL.md" ] && [ -f "$SELF_DIR/bin/harness_engine.py" ]; then
    SRC="$SELF_DIR"
    step "설치 원본: 로컬 체크아웃 ($SRC)"
elif [ -n "$SELF_DIR" ] && [ "$SELF_DIR" = "$DST" ] && [ -f "$DST/bin/harness_watchdog.py" ]; then
    SKIP_INSTALL=1
    step "설치본에서 실행 중 — 파일 설치 단계는 건너뜁니다 (워치독/점검 전용)"
else
    command -v curl >/dev/null 2>&1 || { step "curl 이 필요합니다."; exit 1; }
    command -v tar  >/dev/null 2>&1 || { step "tar 가 필요합니다."; exit 1; }
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    step "GitHub 에서 내려받는 중: $REPO_OWNER/$REPO_NAME@$BRANCH"
    curl -fsSL "https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/$BRANCH.tar.gz" \
        | tar xz -C "$TMP"
    SRC="$TMP/$REPO_NAME-$BRANCH"
    [ -f "$SRC/bin/harness_engine.py" ] || { step "다운로드 결과가 불완전합니다: $SRC"; exit 1; }
fi

MCP_STATE="기존 설치 유지(변경 없음)"
if [ "$SKIP_INSTALL" = "0" ]; then

# 필수 구성 검증 — 반쪽 설치 방지
for f in bin/harness_engine.py bin/harness_mcp.py bin/harness_watchdog.py skill/SKILL.md templates/agent_harness.sh; do
    [ -f "$SRC/$f" ] || { step "원본에 $f 가 없어 중단합니다."; exit 1; }
done

# 기존 설치 백업(통째로 이동)
if [ -d "$DST" ]; then
    BAK="$DST.bak-$(date -u +%Y%m%d%H%M%S)"
    mv "$DST" "$BAK"
    step "기존 설치를 백업했습니다: $BAK"
fi

mkdir -p "$DST/bin" "$DST/templates" "$RUNTIME/logs"
cp "$SRC/skill/SKILL.md" "$DST/SKILL.md"
cp "$SRC"/bin/*.py "$DST/bin/"
cp "$SRC"/templates/* "$DST/templates/"
cp "$SRC/install.sh" "$DST/install.sh" 2>/dev/null || true
cp "$SRC/install.ps1" "$DST/install.ps1" 2>/dev/null || true
for doc in README.md DESIGN.md; do
    [ -f "$SRC/$doc" ] && cp "$SRC/$doc" "$DST/$doc"
done
chmod +x "$DST/install.sh" 2>/dev/null || true
step "스킬 설치 완료: $DST"
step "런타임 디렉토리 준비: $RUNTIME"

# MCP 등록
MCP_STATE="건너뜀 (claude CLI 미발견 — 설치 후 'claude mcp add --scope user autoharness -- $PY $DST/bin/harness_mcp.py' 를 직접 실행하십시오)"
if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user autoharness >/dev/null 2>&1 || true
    if claude mcp add --scope user autoharness -- "$PY" "$DST/bin/harness_mcp.py" >/dev/null 2>&1; then
        LINE="$(claude mcp list 2>/dev/null | grep -i autoharness | head -n 1 || true)"
        if [ -n "$LINE" ]; then MCP_STATE="등록 확인 — $LINE"; else MCP_STATE="add 성공 ('claude mcp list' 로 확인 가능)"; fi
    else
        MCP_STATE="실패 — 'claude mcp add --scope user autoharness -- $PY $DST/bin/harness_mcp.py' 를 직접 실행해 보십시오"
    fi
fi
step "MCP 등록: $MCP_STATE"

# 설치 자가 검증 — 엔진 selftest (임시 샌드박스에서 돌고 스스로 정리한다)
if "$PY" "$DST/bin/harness_engine.py" selftest >/dev/null 2>&1; then
    step "엔진 selftest: 통과 (15/15)"
else
    step "경고: 엔진 selftest 실패 — '$PY $DST/bin/harness_engine.py selftest' 로 직접 확인하십시오"
fi

fi  # SKIP_INSTALL

# ---------------------------------------------------------------- 워치독 (cron)
if [ "$DO_WATCHDOG" = "1" ]; then
    command -v crontab >/dev/null 2>&1 || { step "crontab 이 없습니다 (cron 패키지 설치 필요)."; exit 1; }
    mkdir -p "$RUNTIME/logs"
    case "$INTERVAL" in ''|*[!0-9]*) step "AUTOHARNESS_INTERVAL 은 분 단위 정수여야 합니다: $INTERVAL"; exit 1 ;; esac
    CRON_LINE="*/$INTERVAL * * * * PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin $PY $DST/bin/harness_watchdog.py >> $RUNTIME/logs/cron.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v "$CRON_MARK" || true; echo "$CRON_LINE" ) | crontab -
    step "cron 워치독 등록 완료 (${INTERVAL}분 간격)"
    if ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1; then
        step "주의: cron 데몬이 실행 중이 아닙니다. WSL 에서는 'sudo service cron start' 를 실행하거나"
        step "      /etc/wsl.conf 에 [boot] systemd=true 를 설정해 cron 을 켜야 자동 부활이 동작합니다."
    fi
fi

cat <<SUMMARY

==================================================
 AutoHarness 설치 요약 (Linux/WSL)
--------------------------------------------------
 스킬/코드   : $DST
 런타임 상태 : $RUNTIME
 python      : $PY
 MCP 등록    : $MCP_STATE
 워치독 cron : $([ "$DO_WATCHDOG" = "1" ] && echo "등록됨 (${INTERVAL}분)" || echo "미등록 — 'bash $DST/install.sh --watchdog' 로 등록")
--------------------------------------------------
 다음 단계
  1. 새 Claude Code 세션을 열고 /autoharness 로 시작하십시오.
  2. 제거: bash $DST/install.sh --uninstall
==================================================
SUMMARY
