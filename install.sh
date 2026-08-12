#!/usr/bin/env bash
# AutoHarness 설치기 — Linux / WSL / Git Bash 용.
#
# 릴리스에서 플랫폼에 맞는 단일 실행 파일을 받아 설치합니다.
#
# 원라인 설치:
#   curl -fsSL https://raw.githubusercontent.com/EcoKG/autoharness/main/install.sh | bash
#   (로그온 자동 시작까지: ... | bash -s -- --autostart)
# 체크아웃에서 실행:
#   bash install.sh [--autostart] [--uninstall]
#
# 배포 목록은 scripts/deploy_manifest.py 가 정합니다 — install.ps1 과 같은 집합을 다뤄야
# 하며, 어긋나면 tests/test_installer_parity.py 가 실패합니다.
#
# 환경변수: AUTOHARNESS_BRANCH(기본 main), AUTOHARNESS_VERSION(릴리스 태그, 기본 latest),
#           AUTOHARNESS_RELEASE_BASE(산출물 기점 URL — 미러·오프라인 배포용)

set -euo pipefail

REPO_OWNER="${AUTOHARNESS_REPO_OWNER:-EcoKG}"
REPO_NAME="${AUTOHARNESS_REPO_NAME:-autoharness}"
BRANCH="${AUTOHARNESS_BRANCH:-main}"
INTERVAL="${AUTOHARNESS_INTERVAL:-15}"
DST="$HOME/.claude/skills/autoharness"
RUNTIME="$HOME/.claude/autoharness"
CRON_MARK="harness_watchdog.py"

MODE="install"
DEPRECATED_WATCHDOG=0
DO_AUTOSTART=0
for a in "$@"; do
    case "$a" in
        # v1 워치독은 사라졌다(데몬이 자기 시계로 돈다). 옛 명령을 그대로 친 사용자를
        # 오류로 세우지 않고, 무엇으로 바뀌었는지 알려 준다.
        --watchdog)  DEPRECATED_WATCHDOG=1 ;;
        --uninstall) MODE="uninstall" ;;
        # 구현이 하나뿐이라 기본 동작이다. 문서·스크립트에 이미 퍼져 있어 계속 받아들인다.
        --v2)        : ;;
        --autostart) DO_AUTOSTART=1 ;;
        *) echo "[autoharness] 알 수 없는 인자: $a (사용: --autostart | --uninstall)" >&2; exit 2 ;;
    esac
done

step() { echo "[autoharness] $*"; }

if [ "$DEPRECATED_WATCHDOG" = "1" ]; then
    step "--watchdog 은 더 이상 없습니다 — 데몬이 자기 시계로 돌기 때문입니다."
    step "  로그온 자동 시작을 원하시면 --autostart 를 쓰십시오."
fi

# ---------------------------------------------------------------- v1 잔재 정리
#
# 이전 버전은 파이썬 엔진·MCP 서버·워치독을 계정에 깔았다. 그것들은 이제 부를 코드가
# 없으므로 남겨 두면 죽은 파일과 매 15분 실패하는 cron 항목만 된다.
#
# **무엇을 지우는지 알리고 지운다.** 실패해도 설치를 중단시키지 않는다 — 정리는 부가
# 작업이지 설치의 전제가 아니다. 런타임 상태(레지스트리·로그·장부)는 건드리지 않는다.
cleanup_v1() {
    if crontab -l 2>/dev/null | grep -q "$CRON_MARK"; then
        step "이전 워치독 cron 항목을 제거합니다 (데몬이 자기 시계로 돕니다)"
        crontab -l 2>/dev/null | grep -v "$CRON_MARK" | crontab - 2>/dev/null             || step "  제거 실패 — 'crontab -e' 로 직접 지우십시오 ($CRON_MARK 줄)"
    fi
    if ls "$DST"/bin/*.py >/dev/null 2>&1; then
        step "이전 파이썬 자산을 제거합니다: $DST/bin"
        rm -rf "$DST/bin" 2>/dev/null || step "  제거 실패 — 직접 지우십시오: $DST/bin"
    fi
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
        # Git Bash·MSYS2·Cygwin 은 Windows 다. 이걸 빼 두면 **릴리스에 바이너리가 있는데도
        # "지원하지 않는 플랫폼" 으로 끝난다** — 실제로 그 상태였다(uname -s 는
        # MINGW64_NT-10.0-26200 처럼 나온다). 자산 이름에 .exe 가 붙는 것도 여기뿐이다.
        MINGW*|MSYS*|CYGWIN*) echo "autoharness-windows-${arch}.exe" ;;
        *) echo "" ; return 1 ;;
    esac
}

# 설치될 실행 파일 이름 — Windows 만 확장자가 붙는다.
# 데몬·MCP·훅이 이 경로를 그대로 쓰므로 플랫폼 규약(paths.ts 의 installedExePath)과
# 어긋나면 설치는 되는데 아무것도 그것을 찾지 못한다.
# 실행 중인 설치본을 멈춘다 — 플랫폼마다 수단이 다르다.
# pkill 은 Windows 프로세스를 보지 못하므로 Git Bash 에서는 아무것도 멈추지 않고
# "멈췄다" 는 착각만 남긴다. 그 상태로 cp 를 하면 잠금으로 실패한다.
stop_running_exe() {
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*)
            taskkill //F //IM "$(basename "$1")" >/dev/null 2>&1 || true
            ;;
        *)
            pkill -f "$1 (daemon|mcp)" 2>/dev/null || true
            ;;
    esac
}

# 사용자에게 알려 줄 정지 명령 — 붙여넣어 그대로 실행되어야 한다
stop_command_hint() {
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) echo "taskkill /F /IM autoharness.exe" ;;
        *) echo "pkill -f 'autoharness daemon'" ;;
    esac
}

installed_exe_name() {
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) echo "autoharness.exe" ;;
        *) echo "autoharness" ;;
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

    # 설치 이름은 플랫폼 규약을 따른다 — Windows 만 .exe 가 붙는다
    exe_name="$(installed_exe_name)"
    gunzip -c "$tmp/${asset}.gz" > "$tmp/$exe_name"
    chmod +x "$tmp/$exe_name"

    # 받은 바이너리가 실제로 우리 것인지 한 번 더 — 동작으로 확인한다
    if ! "$tmp/$exe_name" version >/dev/null 2>&1; then
        step "받은 파일이 실행되지 않습니다 — 중단합니다."
        exit 1
    fi
    step "버전: $("$tmp/$exe_name" version)"

    bin_dir="$RUNTIME/bin"
    mkdir -p "$bin_dir"
    exe="$bin_dir/$exe_name"
    # 실행 중이면 교체가 막힐 수 있다 — 먼저 내려 둔다.
    # 데몬만 잡으면 부족하다: 같은 파일을 MCP 서버도 실행하고 있어(모드만 다름) 그쪽이
    # 남아 있으면 그대로 잠긴다.
    # Windows 에서는 pkill 이 Windows 프로세스를 보지 못한다 — taskkill 을 써야 한다.
    if [ -f "$exe" ]; then
        stop_running_exe "$exe"
        sleep 1
    fi
    # 실패를 그냥 흘리면 맨 `cp: Text file busy` 만 남는다 — 무엇을 멈춰야 하는지 말한다.
    # (EXE 쪽 install 은 이미 같은 안내를 하는데, 원라인은 여기서 먼저 막혀 거기까지 못 간다)
    if ! cp "$tmp/$exe_name" "$exe"; then
        step "설치본이 실행 중이라 덮어쓸 수 없습니다. 데몬·MCP 서버를 멈춘 뒤 다시 실행하십시오:"
        step "  $(stop_command_hint)"
        step "  멈춘 뒤 같은 명령을 다시 실행하면 됩니다."
        exit 1
    fi
    chmod +x "$exe"
    step "설치: $exe"

    # 나머지(스킬 배치·MCP 등록·자동 시작)는 EXE 자신이 안다 — 여기서 중복 구현하지 않는다
    local args=(install --exe "$exe")
    [ -d "$SRC/skill" ] && args+=(--skill "$SRC/skill")
    [ "$DO_AUTOSTART" = "1" ] && args+=(--autostart)
    "$exe" "${args[@]}" || {
        step "설치 단계에서 문제가 있었습니다 — 위 출력의 steps 를 확인하십시오."
        # 실패해도 무엇이 됐는지 볼 수 있어야 한다 — 이 한 줄까지 잃으면 손에 아무것도 없다
        step "확인:  $exe install --status"
        exit 1
    }

    step ""
    # v2 는 여기서 종료하므로 아래 공용 마무리 안내(SUMMARY)에 닿지 않는다 — 그래서
    # "다음에 무엇을 하라" 를 여기서 직접 말한다. 종전에는 v1 만 이 안내를 받았다.
    step "다음: 새 Claude Code 세션을 열고 대상 저장소에서 /autoharness 로 시작하십시오."
    step "      (MCP 도구와 스킬은 새로 시작하는 세션부터 보입니다 — 열려 있는 세션은 재시작)"
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
# 단일 실행 파일이라 파이썬이 필요 없다.

# 원본 확보: 체크아웃(skill/SKILL.md 존재)이면 그 폴더를, 설치본에서 실행 중이면 설치 단계를
# 건너뛰고(워치독 전용), 그 외(curl 파이프)는 GitHub 타르볼을 받는다.
SRC=""
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/skill/SKILL.md" ]; then
    SRC="$SELF_DIR"
    step "설치 원본: 로컬 체크아웃 ($SRC)"
else
    command -v curl >/dev/null 2>&1 || { step "curl 이 필요합니다."; exit 1; }
    command -v tar  >/dev/null 2>&1 || { step "tar 가 필요합니다."; exit 1; }
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    step "GitHub 에서 내려받는 중: $REPO_OWNER/$REPO_NAME@$BRANCH"
    curl -fsSL "https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/$BRANCH.tar.gz" \
        | tar xz -C "$TMP"
    SRC="$TMP/$REPO_NAME-$BRANCH"
    [ -f "$SRC/skill/SKILL.md" ] || { step "다운로드 결과가 불완전합니다: $SRC"; exit 1; }
fi

cleanup_v1
install_v2
