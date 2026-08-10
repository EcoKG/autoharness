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
# v2(단일 실행 파일) 설치 — 릴리스에서 플랫폼에 맞는 바이너리를 받습니다:
#   curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash -s -- --v2
#   (자동 시작까지: ... | bash -s -- --v2 --autostart)
#
# 환경변수: AUTOHARNESS_BRANCH(기본 main), AUTOHARNESS_INTERVAL(cron 간격 분, 기본 15),
#           AUTOHARNESS_VERSION(v2 릴리스 태그, 기본 latest),
#           AUTOHARNESS_RELEASE_BASE(v2 산출물 기점 URL — 미러·오프라인 배포용)

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
DO_V2=0
DO_AUTOSTART=0
for a in "$@"; do
    case "$a" in
        --watchdog)  DO_WATCHDOG=1 ;;
        --uninstall) MODE="uninstall" ;;
        --v2)        DO_V2=1 ;;
        --autostart) DO_AUTOSTART=1 ;;
        *) echo "[autoharness] 알 수 없는 인자: $a (사용: --v2 | --autostart | --watchdog | --uninstall)" >&2; exit 2 ;;
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

# ---------------------------------------------------------------- v2 (단일 실행 파일)
#
# v1 은 파이썬 소스라 받아서 복사하면 끝이지만, v2 는 플랫폼별 컴파일 바이너리다.
# 그래서 릴리스에 미리 만들어 둔 것을 받는다. **받은 것이 우리가 만든 것인지 확인한 뒤에만**
# 실행 위치에 놓는다 — 확인 없이 바이너리를 설치하는 경로는 만들지 않는다.

v2_asset_name() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)   arch="x64" ;;
        aarch64|arm64)  arch="arm64" ;;
        *) echo "" ; return 1 ;;
    esac
    case "$os" in
        Linux)  echo "autoharness-linux-${arch}" ;;
        Darwin) echo "autoharness-darwin-${arch}" ;;
        *) echo "" ; return 1 ;;
    esac
}

install_v2() {
    local asset url_base tmp bin_dir exe want got hash_tool
    asset="$(v2_asset_name)" || {
        step "지원하지 않는 플랫폼입니다: $(uname -s)/$(uname -m)"
        step "소스에서 빌드하십시오: git clone ... && cd daemon && bun run build"
        exit 1
    }
    step "플랫폼: $(uname -s)/$(uname -m) → $asset"

    # 기점을 바꿀 수 있게 열어 둔다 — 사내 미러·오프라인 배포·설치 경로 실측에 쓴다
    if [ -n "${AUTOHARNESS_RELEASE_BASE:-}" ]; then
        url_base="$AUTOHARNESS_RELEASE_BASE"
    elif [ "${AUTOHARNESS_VERSION:-latest}" = "latest" ]; then
        url_base="https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download"
    else
        url_base="https://github.com/$REPO_OWNER/$REPO_NAME/releases/download/$AUTOHARNESS_VERSION"
    fi

    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN

    step "내려받는 중: $url_base/${asset}.gz"
    if ! curl -fsSL "$url_base/${asset}.gz" -o "$tmp/${asset}.gz"; then
        step "릴리스 산출물을 받지 못했습니다: $url_base/${asset}.gz"
        step "아직 릴리스가 없다면 소스에서 빌드하십시오:"
        step "  git clone https://github.com/$REPO_OWNER/$REPO_NAME.git && cd $REPO_NAME/daemon"
        step "  bun run build && ./dist/autoharness install --skill ../skill"
        exit 1
    fi

    # 체크섬 검증 — 없거나 어긋나면 중단한다(조용히 설치하지 않는다)
    if curl -fsSL "$url_base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
        # `|| true` 가 없으면 grep 이 못 찾는 순간 pipefail+set -e 로 **여기서 스크립트가
        # 죽는다**. 그러면 바로 아래 준비된 안내가 한 번도 출력되지 못하고, 사용자는
        # "내려받는 중" 에서 뚝 끊긴 화면만 본다(실측 재현). 형식이 조금만 달라도 그렇다.
        # `[ *]` 는 sha256sum 바이너리 모드 출력(`HASH *name`)까지 받아들인다.
        want="$(grep -E "[ *]${asset}\.gz\$" "$tmp/SHA256SUMS" | awk '{print $1}' | head -1 || true)"
        if [ -z "$want" ]; then
            step "체크섬 목록에 ${asset}.gz 가 없습니다 — 중단합니다."
            # 형식 문제인지 내용 문제인지 구분할 단서를 남긴다(소프트 404 로 HTML 이 오는 경우가 있다)
            step "  받은 목록 첫 줄: $(head -1 "$tmp/SHA256SUMS" 2>/dev/null || echo '(비어 있음)')"
            exit 1
        fi
        got=""
        if command -v sha256sum >/dev/null 2>&1; then
            hash_tool="sha256sum"
            got="$(sha256sum "$tmp/${asset}.gz" | awk '{print $1}' || true)"
        elif command -v shasum >/dev/null 2>&1; then
            hash_tool="shasum"
            got="$(shasum -a 256 "$tmp/${asset}.gz" | awk '{print $1}' || true)"
        else
            hash_tool=""
            step "sha256 도구가 없어 검증을 건너뜁니다 (sha256sum 또는 shasum 설치 권장)."
        fi
        # 도구가 있는데 값이 안 나온 것은 '도구 없음'과 다르다 — **검증 불가**이므로 건너뛰지
        # 않고 중단한다. 여기서 조용히 넘어가면 위 `|| true` 가 검증 우회로가 된다.
        if [ -n "$hash_tool" ] && [ -z "$got" ]; then
            step "$hash_tool 로 체크섬을 계산하지 못했습니다 — 검증 없이 설치하지 않습니다. 중단합니다."
            exit 1
        fi
        if [ -n "$got" ] && [ "$got" != "$want" ]; then
            step "체크섬 불일치 — 중단합니다."
            step "  기대: $want"
            step "  실제: $got"
            exit 1
        fi
        [ -n "$got" ] && step "체크섬 확인"
    else
        step "SHA256SUMS 를 받지 못했습니다 — 검증 없이 설치하지 않습니다. 중단합니다."
        exit 1
    fi

    gunzip -c "$tmp/${asset}.gz" > "$tmp/autoharness"
    chmod +x "$tmp/autoharness"

    # 받은 바이너리가 실제로 우리 것인지 한 번 더 — 동작으로 확인한다
    if ! "$tmp/autoharness" version >/dev/null 2>&1; then
        step "받은 파일이 실행되지 않습니다 — 중단합니다."
        exit 1
    fi
    step "버전: $("$tmp/autoharness" version)"

    bin_dir="$RUNTIME/bin"
    mkdir -p "$bin_dir"
    exe="$bin_dir/autoharness"
    # 실행 중이면 교체가 막힐 수 있다 — 먼저 내려 둔다
    if [ -x "$exe" ]; then
        pkill -f "$exe daemon" 2>/dev/null || true
        sleep 1
    fi
    cp "$tmp/autoharness" "$exe"
    chmod +x "$exe"
    step "설치: $exe"

    # 나머지(스킬 배치·MCP 등록·자동 시작)는 EXE 자신이 안다 — 여기서 중복 구현하지 않는다
    local args=(install --exe "$exe")
    [ -d "$SRC/skill" ] && args+=(--skill "$SRC/skill")
    [ "$DO_AUTOSTART" = "1" ] && args+=(--autostart)
    "$exe" "${args[@]}" || {
        step "설치 단계에서 문제가 있었습니다 — 위 출력을 확인하십시오."
        exit 1
    }

    step ""
    step "확인:  $exe install --status"
    step "       $exe selftest"

    # PATH 안내는 **현재 셸에 반영하는 것까지** 말한다.
    #
    # 종전에는 rc 파일에 추가하라고만 했다. 그대로 따른 사용자가 곧바로 `autoharness` 를
    # 쳤더니 command not found 였다(실측) — rc 추가는 다음에 여는 셸부터 적용되기 때문이다.
    # 안내대로 했는데 목적을 못 이루면 사용자는 설치가 실패했다고 읽는다.
    case ":$PATH:" in
        *":$bin_dir:"*)
            step "PATH 에 이미 있습니다 — 새 셸에서 'autoharness' 로 바로 부를 수 있습니다."
            ;;
        *)
            case "${SHELL##*/}" in
                fish)
                    step "PATH 에 넣으려면: fish_add_path $bin_dir"
                    ;;
                zsh)
                    step "PATH 에 넣으려면(현재 셸까지 반영):"
                    step "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.zshrc && . ~/.zshrc"
                    ;;
                *)
                    step "PATH 에 넣으려면(현재 셸까지 반영):"
                    step "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.bashrc && . ~/.bashrc"
                    ;;
            esac
            step "PATH 에 넣지 않아도 전체 경로로 쓸 수 있습니다: $exe"
            ;;
    esac
    exit 0
}

# ---------------------------------------------------------------- 설치
# v2 는 단일 실행 파일이라 파이썬이 필요 없다 — v1 경로에서만 요구한다
PY=""
if [ "$DO_V2" != "1" ]; then
    PY="$(find_python)" || { step "python3(3.8+)를 찾을 수 없습니다. 설치 후 다시 실행하십시오."; exit 1; }
    step "python: $PY"
fi

# 원본 확보: 체크아웃(skill/SKILL.md 존재)이면 그 폴더를, 설치본에서 실행 중이면 설치 단계를
# 건너뛰고(워치독 전용), 그 외(curl 파이프)는 GitHub 타르볼을 받는다.
SRC=""
SKIP_INSTALL=0
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/skill/SKILL.md" ] &&    { [ "$DO_V2" = "1" ] || [ -f "$SELF_DIR/bin/harness_engine.py" ]; }; then
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
    if [ "$DO_V2" = "1" ]; then
        [ -f "$SRC/skill/SKILL.md" ] || { step "다운로드 결과가 불완전합니다: $SRC"; exit 1; }
    else
        [ -f "$SRC/bin/harness_engine.py" ] || { step "다운로드 결과가 불완전합니다: $SRC"; exit 1; }
    fi
fi

# v2 는 여기서 끝난다 — 릴리스 바이너리를 받아 설치하고 종료한다
if [ "$DO_V2" = "1" ]; then
    install_v2
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
    # 설치 시각·주기를 레지스트리에 기록 — watchdog_status 의 유예 판정 기준(오탐 방지).
    # 실패해도 설치를 중단하지 않는다.
    if [ -f "$DST/bin/harness_mcp.py" ]; then
        "$PY" "$DST/bin/harness_mcp.py" stamp-watchdog-install --interval-minutes "$INTERVAL" \
            >/dev/null 2>&1 || step "설치 시각 기록 실패 (설치는 정상 — 진단 유예만 영향)"
    fi
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
