#!/usr/bin/env bash
# AutoHarness 진입 래퍼 — 대상 저장소 scripts/agent_harness.sh 로 설치된다.
#
# 사용법:
#   bash scripts/agent_harness.sh --task <id>      # run 서브커맨드로 위임 (기본)
#   bash scripts/agent_harness.sh status           # 엔진 서브커맨드는 그대로 통과
#
# 첫 인자가 엔진 서브커맨드면 그대로, 아니면 run 으로 exec 한다. (eval 금지)
# 종료 코드는 엔진 계약을 그대로 전달한다: 0=통과, 1=검증 실패, 2=사용법/설정 오류,
# 3=진행 가능 작업 없음, 4=한도 도달(blocked).

set -u

# 자기 위치 기준으로 같은 폴더의 harness_engine.py 를 찾는다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$SCRIPT_DIR/harness_engine.py"

if [ ! -f "$ENGINE" ]; then
    echo "[agent_harness] 엔진을 찾을 수 없습니다: $ENGINE (harness_init 이 사본을 설치했는지 확인)" >&2
    exit 2
fi

# 파이썬 선택: 환경변수 > OS별 우선순위(Windows 계열=python 먼저 — python3 은 스토어 스텁일
# 수 있다 / 그 외=python3 먼저). 후보는 실제 실행 검증(-c import sys)을 통과해야 채택한다.
PY=""
if [ -n "${AUTOHARNESS_PYTHON:-}" ]; then
    PY="$AUTOHARNESS_PYTHON"
else
    case "$(uname -s 2>/dev/null)" in
        MINGW*|MSYS*|CYGWIN*) CANDIDATES="python python3" ;;
        *)                    CANDIDATES="python3 python" ;;
    esac
    for c in $CANDIDATES; do
        if command -v "$c" >/dev/null 2>&1 && "$c" -c "import sys" >/dev/null 2>&1; then
            PY="$c"
            break
        fi
    done
fi
if [ -z "$PY" ]; then
    echo "[agent_harness] python 을 찾을 수 없습니다 (AUTOHARNESS_PYTHON 환경변수로 지정 가능)" >&2
    exit 2
fi

case "${1:-}" in
    detect|init|add-task|set-task|next|run|render|brief|status|heartbeat|sync-commit|model-recommend|selftest)
        # 엔진 서브커맨드 — 그대로 통과
        exec "$PY" "$ENGINE" "$@"
        ;;
    *)
        # 그 외(--task <id> 등) — run 서브커맨드로 위임
        exec "$PY" "$ENGINE" run "$@"
        ;;
esac
