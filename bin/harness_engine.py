#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoHarness engine — 상태 장부·러너·훅·자가검증.

대상 저장소에는 scripts/harness_engine.py 로 복사되어 단독 동작한다(stdlib만 사용).
종료 코드 계약: 0=통과, 1=검증 실패, 2=사용법/설정 오류, 3=진행 가능 작업 없음, 4=한도 도달(blocked).
"""

import argparse
import contextlib
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
try:
    # 훅 stdin(JSON)이 ANSI 코드페이지로 디코드되면 한글 명령이 surrogate 로 오염되어
    # 차단 로직이 fail-open 으로 뒤집힌다 — stdin 도 반드시 utf-8 로 맞춘다.
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_NO_TASK, EXIT_BLOCKED = 0, 1, 2, 3, 4
SUMMARY_MAX_LINES = 60
SUMMARY_LINE_CAP = 400
SUMMARY_TAIL_LINES = 30
LAST_ERROR_CAP = 4000
STOP_BLOCK_LIMIT = 3

ERROR_LINE_RE = re.compile(
    r"(\[ERROR\]|\bERROR\b|Caused by|FAILED|FAIL[:\s]|error TS\d+|error\[|"
    r"\berror[:\s]|Exception\b|Traceback|AssertionError|npm ERR!|BUILD FAILURE|"
    r"CompilationError|cannot find symbol|No such file|ModuleNotFoundError|"
    r"SyntaxError|panic:|undefined reference|\bE\s{3}|✗|✖)",
    re.IGNORECASE,
)

# 진짜 실패를 가리키는 강한 신호 — 요약 상한을 이 줄들이 먼저 차지한다
STRONG_ERROR_RE = re.compile(
    r"(\[ERROR\]|Traceback|AssertionError|BUILD FAILURE|FAILED|npm ERR!|"
    r"Caused by|error TS\d+|error\[|CompilationError|cannot find symbol|"
    r"ModuleNotFoundError|SyntaxError|panic:|undefined reference|✗|✖)",
    re.IGNORECASE)

MODEL_FABLE = "claude-fable-5"
MODEL_OPUS = "claude-opus-5"
ALLOWED_MODELS = (MODEL_OPUS, MODEL_FABLE)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- 경로/입출력

def rp(repo):
    """대상 저장소 내 하네스 경로 일람."""
    repo = os.path.abspath(repo)
    dc = os.path.join(repo, ".claude")
    return {
        "repo": repo,
        "claude_dir": dc,
        "tracker": os.path.join(dc, "agent_tracker.json"),
        "example": os.path.join(dc, "agent_tracker.example.json"),
        "logs": os.path.join(dc, "harness-logs"),
        "state": os.path.join(dc, "harness-state.json"),
        "heartbeat": os.path.join(dc, "harness-heartbeat.json"),
        "hooks_seen": os.path.join(dc, "harness-hooks-seen.json"),
        "paused_flag": os.path.join(dc, "HARNESS_PAUSED"),
        "progress": os.path.join(repo, "PROGRESS.md"),
    }


REPLACE_RETRIES = 5          # os.replace 총 시도 횟수
REPLACE_BACKOFF_SEC = 0.1    # 첫 대기 — 이후 0.2→0.4→0.8초로 지수 증가


REGISTRY_LOCK_STALE_SEC = 30    # 레지스트리 쓰기는 밀리초 단위 — 이보다 오래면 죽은 잠금이다
REGISTRY_LOCK_TIMEOUT_SEC = 5   # 훅·MCP 응답이 잠금 때문에 붙들리지 않도록 상한을 둔다


class LockTimeout(Exception):
    pass


@contextlib.contextmanager
def file_lock(path, timeout=REGISTRY_LOCK_TIMEOUT_SEC, stale=REGISTRY_LOCK_STALE_SEC):
    """프로세스 간 배타 잠금 — v2 TypeScript 구현과 **같은 파일·같은 규약**을 쓴다.

    레지스트리의 쓰기 주체는 최소 둘이다(상주 데몬/워치독과 세션마다 뜨는 MCP 서버). 저장
    직전 재읽기만으로는 A읽기→B읽기→B쓰기→A쓰기 순서를 막지 못한다 — 창이 좁아질 뿐이다.
    잃는 것이 pause 나 프로젝트 등록이면 사용자가 한 조작이 조용히 되돌아간다.

    획득 실패는 조용히 통과시키지 않고 LockTimeout 을 올린다 — 잠금이 있는 척하며 그냥 쓰면
    잠금이 없는 것만 못하다. 죽은 잠금(mtime 이 stale 초 경과)은 탈취한다."""
    deadline = time.time() + timeout
    delay = 0.005
    fd = None
    while True:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(path)
            except OSError:
                age = 0
            if age > stale:
                try:
                    os.remove(path)      # 죽은 잠금 탈취 — 다음 회차에 정상 경로로 잡는다
                except OSError:
                    pass
                continue
            if time.time() >= deadline:
                raise LockTimeout(
                    "잠금을 %s초 안에 얻지 못했습니다: %s — 쓰기를 건너뛰지 않고 중단합니다"
                    "(갱신 소실 방지)." % (timeout, path))
            time.sleep(delay)
            delay = min(0.05, delay * 2)
    try:
        try:
            os.write(fd, json.dumps({"pid": os.getpid(), "at": now_iso()}).encode("utf-8"))
        finally:
            os.close(fd)
            fd = None
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.remove(path)
        except OSError:
            pass


def replace_with_retry(src, dst):
    """os.replace — OneDrive 동기화·백신 검사가 잡은 일시적 잠금(PermissionError)을
    지수 백오프로 재시도한다. 다른 OSError 는 즉시, 마지막 시도 실패는 그대로 던진다."""
    for i in range(REPLACE_RETRIES):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == REPLACE_RETRIES - 1:
                raise
            time.sleep(REPLACE_BACKOFF_SEC * (2 ** i))


def atomic_write_json(path, obj):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ah-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        replace_with_retry(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def atomic_write_text(path, text):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ah-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        replace_with_retry(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


TRACKER_OK, TRACKER_MISSING, TRACKER_CORRUPT = "ok", "missing", "corrupt"


def load_tracker_checked(repo):
    """(장부, 상태) — 상태는 ok|missing|corrupt.

    **부재와 파손을 구분한다.** 둘 다 None 으로 뭉개면 장부가 깨졌을 때 커밋 게이트도
    Stop 게이트도 '장부 없음(수동 운용)'으로 보고 조용히 통과한다 — 게이트가 통째로
    무력해지는데 아무 신호도 없다(적대 검증에서 확인)."""
    path = rp(repo)["tracker"]
    if not os.path.exists(path):
        return None, TRACKER_MISSING
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None, TRACKER_CORRUPT
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        return None, TRACKER_CORRUPT
    return data, TRACKER_OK


def load_tracker(repo, required=True):
    t, _state = load_tracker_checked(repo)
    if t is None and required:
        die("장부(.claude/agent_tracker.json)가 없거나 파손됐습니다. 먼저 init 을 실행하십시오.")
    return t


def save_tracker(repo, tracker):
    tracker["updated_at"] = now_iso()
    atomic_write_json(rp(repo)["tracker"], tracker)


def load_state(repo):
    return load_json(rp(repo)["state"], {"last_run": None, "stop_blocks": 0, "tracker_hash": None})


def save_state(repo, state):
    atomic_write_json(rp(repo)["state"], state)


def die(msg, code=EXIT_USAGE):
    sys.stderr.write("[autoharness] " + msg + "\n")
    sys.exit(code)


def write_heartbeat(repo, source):
    try:
        atomic_write_json(rp(repo)["heartbeat"], {"ts": now_iso(), "pid": os.getpid(), "source": source})
    except Exception as e:
        # 삼키되 조용히는 아니다 — 하트비트가 안 써지면 워치독의 이중 기동 방지 근거가
        # 사라지는데, 종전에는 아무 흔적도 남지 않아 알 방법이 없었다.
        sys.stderr.write("[AutoHarness] 하트비트 기록 실패(%s): %r\n" % (source, e))


# ------------------------------------------------------- 훅 배선 감지 (경고 전용)
#
# 세션 프로젝트 루트가 저장소 밖(상위 폴더)이면 저장소의 .claude/settings.json 이
# 로드되지 않아 훅 4종이 전부 조용히 비활성화된다 — 커밋 게이트·금지 명령 차단·
# Stop 게이트가 모두 무력인데 주행은 정상처럼 보인다. 아래 판정은 그 상태를 드러낸다.
#
# 판정은 '발화 마커' 기준이다. 하트비트의 source=="hook" 은 근거가 될 수 없다 —
# 사람이 손으로 stdin 을 먹여도(echo JSON | harness_engine.py hook-prebash) 같은
# 기록이 남아 배선이 끊긴 저장소를 정상으로 오판한다. 실제 훅 호출에는 Claude Code
# 런타임이 채우는 필드(session_id 등)가 있으므로 그때만 마커를 남긴다.

WIRING_NOT_REGISTERED = "not_registered"   # 훅 미등록(수동 운용) — 경고 대상 아님
WIRING_ACTIVE = "active"                   # 등록 + 실제 발화 기록 있음
WIRING_INACTIVE = "inactive"               # 등록됐으나 한 번도 발화한 적 없음 — 경고

# Claude Code 가 훅 stdin 페이로드에 채우는 필드 — 사람이 흉내 낸 호출에는 없다
HOOK_RUNTIME_KEYS = ("session_id", "hook_event_name", "transcript_path")
# 발화 마커를 남기는 훅 op — SessionStart(brief)는 stdin 을 읽지 않으므로 제외한다
MARKER_HOOK_OPS = ("hook-prebash", "hook-postbash", "hook-stop")
# matcher 로 도구 범위가 정해지는 훅(hook-stop 은 Stop 이벤트라 도구 무관)
MATCHER_SCOPED_OPS = ("hook-prebash", "hook-postbash")
# 명령을 실행하는 도구 — 이 중 matcher 에서 빠진 것이 있으면 게이트가 우회된다
COMMAND_TOOLS = ("Bash", "PowerShell")
SETTINGS_FILES = ("settings.json", "settings.local.json")


def hook_payload_is_genuine(data):
    """훅 페이로드가 Claude Code 런타임에서 온 것인가 — 런타임 전용 필드 유무로 본다."""
    if not isinstance(data, dict):
        return False
    for k in HOOK_RUNTIME_KEYS:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return True
    return False


def record_hook_fire(repo, op, data):
    """실제 훅 호출일 때만 `.claude/harness-hooks-seen.json` 에 발화 시각을 남긴다.

    반환값은 기록 여부(bool). 어떤 실패도 훅을 죽이지 않는다(fail-open)."""
    if not hook_payload_is_genuine(data):
        return False
    try:
        path = rp(repo)["hooks_seen"]
        seen = load_json(path, {})
        if not isinstance(seen, dict):
            seen = {}
        seen[op] = {"ts": now_iso(), "event": data.get("hook_event_name"),
                    "session_id": data.get("session_id")}
        atomic_write_json(path, seen)
        return True
    except Exception:
        return False


def _iter_hook_commands(settings):
    """settings 의 hooks 트리를 방어적으로 훑어 (이벤트, 명령, matcher) 를 내놓는다."""
    hooks = settings.get("hooks") if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        return
    for event, entries in hooks.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            items = entry.get("hooks")
            if not isinstance(items, list):
                continue
            matcher = entry.get("matcher")
            for item in items:
                if isinstance(item, dict) and isinstance(item.get("command"), str):
                    yield event, item["command"], (matcher if isinstance(matcher, str) else "")


def registered_marker_hooks(repo):
    """저장소 설정에 등록된 하네스 훅 중 발화 마커를 남길 수 있는 op 목록(정렬).

    비어 있으면 이 저장소는 훅을 쓰지 않는 수동 운용 — 경고 대상이 아니다(오탐 금지)."""
    return sorted(registered_hook_matchers(repo))


def settings_states(repo):
    """설정 파일별 상태 — ok|missing|corrupt.

    load_json 은 파일 부재(OSError)와 JSON 파손(ValueError)을 같은 None 으로 뭉갠다.
    그대로 쓰면 settings.json 이 깨졌을 때 '훅 미등록(수동 운용)'으로 판정해 경고 대상에서
    빠진다 — 실제로는 훅이 전부 죽은 상태인데 오탐 금지 규칙에 가려진다(적대 검증에서 확인)."""
    states = {}
    for name in SETTINGS_FILES:
        path = os.path.join(rp(repo)["claude_dir"], name)
        if not os.path.exists(path):
            states[name] = "missing"
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                json.load(f)
            states[name] = "ok"
        except (OSError, ValueError):
            states[name] = "corrupt"
    return states


def registered_hook_matchers(repo):
    """등록된 하네스 훅 op → 그 훅이 걸린 matcher 문자열(없으면 "")."""
    found = {}
    for name in SETTINGS_FILES:
        settings = load_json(os.path.join(rp(repo)["claude_dir"], name))
        for _event, command, matcher in _iter_hook_commands(settings):
            if "harness_engine" not in command:
                continue
            for op in MARKER_HOOK_OPS:
                if op in command:
                    found.setdefault(op, matcher or "")
    return found


# 훅 명령 안에서 엔진을 가리키는 경로 토큰(따옴표로 감싼 것 우선)
ENGINE_PATH_RE = re.compile(r'"([^"]*harness_engine\.py)"|(\S*harness_engine\.py)')


def engine_path_in_command(command):
    """훅 명령이 가리키는 엔진 경로 토큰. 없으면 None."""
    m = ENGINE_PATH_RE.search(command or "")
    if not m:
        return None
    return m.group(1) or m.group(2)


def path_is_rooted(path):
    """이 경로가 cwd 와 무관하게 해석되는가 — 즉 어디서 실행돼도 같은 파일을 가리키는가."""
    if not path:
        return False
    if "CLAUDE_PROJECT_DIR" in path:
        return True                      # 플레이스홀더 — 프로젝트 루트로 치환된다
    if path.startswith(("/", "\\", "~")):
        return True                      # POSIX 절대 경로·홈
    return len(path) > 1 and path[1] == ":"   # C:/... 윈도우 절대 경로


def hook_command_is_repo_unpinned(command):
    """훅 명령이 대상 저장소를 cwd 에 맡기는가 — `--repo` 가 없으면 엔진이 cwd 를 저장소로 삼는다.

    엔진 '경로'를 고정하는 것과는 다른 축이다. 경로가 절대여도 저장소가 흔들리면 하위
    디렉토리에서 장부를 못 찾아 커밋 게이트와 Stop 게이트가 조용히 통과한다 — 실측으로
    루트 exit 2(차단) 대 하위 exit 0(통과) 차이를 확인했다."""
    if not command or not engine_path_in_command(command):
        return False
    return "--repo" not in command.split()


def repo_unpinned_hooks(repo):
    """대상 저장소를 못 박지 않은 훅 명령 목록(정렬)."""
    weak = set()
    for name in SETTINGS_FILES:
        settings = load_json(os.path.join(rp(repo)["claude_dir"], name))
        for _event, command, _matcher in _iter_hook_commands(settings):
            if hook_command_is_repo_unpinned(command):
                weak.add(command.strip())
    return sorted(weak)


def cwd_dependent_hooks(repo):
    """엔진을 상대 경로로 가리켜 cwd 에 종속되는 훅 명령 목록(정렬).

    훅은 프로젝트 루트가 아니라 **현재 작업 디렉토리에서 실행된다**(공식 훅 문서).
    상대 경로로 쓰면 하위 디렉토리로 이동하는 순간 게이트 4종이 전부 죽는다 — 실측으로
    확인된 결함이다. `${CLAUDE_PROJECT_DIR}` 나 절대 경로면 안전하다."""
    weak = set()
    for name in SETTINGS_FILES:
        settings = load_json(os.path.join(rp(repo)["claude_dir"], name))
        for _event, command, _matcher in _iter_hook_commands(settings):
            path = engine_path_in_command(command)
            if path and not path_is_rooted(path):
                weak.add(command.strip())
    return sorted(weak)


def matcher_covers(matcher, tool):
    """matcher 문자열이 해당 도구를 덮는가 — 정확 일치 목록(`|`·`,` 구분) 기준."""
    if not matcher:
        return False
    parts = [p.strip() for p in re.split(r"[|,]", matcher) if p.strip()]
    return tool in parts


def hook_wiring_status(repo, tracker=None):
    """훅 배선 상태 판정 — 경고만 하고 주행은 막지 않는다."""
    registered = registered_marker_hooks(repo)
    seen = load_json(rp(repo)["hooks_seen"], {})
    if not isinstance(seen, dict):
        seen = {}
    fired = sorted(k for k, v in seen.items()
                   if k in MARKER_HOOK_OPS and isinstance(v, dict) and v.get("ts"))
    last_fire = max((seen[k].get("ts") or "") for k in fired) if fired else None

    if tracker is None:
        tracker = load_tracker(repo, required=False)
    tasks = (tracker or {}).get("tasks") or []
    done = [t for t in tasks if isinstance(t, dict) and t.get("status") == "done"]
    no_commit = [t for t in done if not t.get("commit")]

    if not registered:
        state = WIRING_NOT_REGISTERED
    elif fired:
        state = WIRING_ACTIVE
    else:
        state = WIRING_INACTIVE

    # matcher 커버리지 — 명령 실행 도구 중 게이트가 걸리지 않는 것이 있으면 드러낸다.
    # matcher 가 "Bash" 뿐이면 다른 실행 도구로 게이트가 통째로 우회된다(실측).
    matchers = registered_hook_matchers(repo)
    uncovered = sorted({tool for tool in COMMAND_TOOLS
                        for op, m in matchers.items()
                        if op in MATCHER_SCOPED_OPS and not matcher_covers(m, tool)})

    # 설정 파손을 '미등록'으로 오판하지 않는다 — 파손이면 훅이 전부 죽은 상태다
    states = settings_states(repo)
    corrupt_files = sorted(n for n, s in states.items() if s == "corrupt")
    # 부분 등록: 일부만 걸려 있으면 나머지 게이트는 없는 상태인데 종전에는 드러나지 않았다
    missing_ops = [op for op in MARKER_HOOK_OPS if op not in registered]

    # cwd 종속 훅: 등록돼 있어도 하위 디렉토리에서는 죽는다 — 등록 여부만 보면 안 보인다
    weak_hooks = cwd_dependent_hooks(repo)
    # 저장소 미고정 훅: 경로가 절대여도 --repo 가 없으면 대상 저장소가 cwd 를 따라 흔들린다
    unpinned_hooks = repo_unpinned_hooks(repo)

    info = {"state": state, "registered": registered, "fired": fired, "last_fire": last_fire,
            "matchers": matchers, "uncovered_tools": uncovered,
            "settings_states": states, "missing_hooks": missing_ops,
            "cwd_dependent_hooks": weak_hooks, "repo_unpinned_hooks": unpinned_hooks,
            "done_total": len(done), "done_without_commit": len(no_commit), "warning": None}

    extra_warnings = []
    if corrupt_files:
        extra_warnings.append(
            "[AutoHarness 경고] 설정 파일이 파손됐습니다(%s) — Claude Code 가 읽지 못하면 훅이 "
            "전부 비활성화됩니다. '미등록(수동 운용)'으로 보이지만 실제로는 게이트가 없는 "
            "상태일 수 있습니다." % ", ".join(corrupt_files))
    if registered and missing_ops:
        extra_warnings.append(
            "[AutoHarness 경고] 하네스 훅이 일부만 등록돼 있습니다 — 누락: %s. 등록되지 않은 "
            "훅이 강제하던 규칙은 동작하지 않습니다." % ", ".join(missing_ops))
    if weak_hooks:
        extra_warnings.append(
            "[AutoHarness 경고] 훅 %d건이 엔진을 상대 경로로 가리킵니다 — 훅은 프로젝트 루트가 "
            "아니라 현재 작업 디렉토리에서 실행되므로, 하위 디렉토리로 이동하면 게이트가 전부 "
            "죽습니다. `${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py` 로 바꾸십시오." % len(weak_hooks))
    if unpinned_hooks:
        extra_warnings.append(
            "[AutoHarness 경고] 훅 %d건이 대상 저장소를 지정하지 않습니다(--repo 없음) — 엔진이 "
            "현재 작업 디렉토리를 저장소로 삼으므로, 하위 디렉토리에서 명령을 실행하면 장부를 "
            "찾지 못해 커밋 게이트와 Stop 게이트가 조용히 통과합니다. 훅 명령 끝에 "
            "`--repo \"${CLAUDE_PROJECT_DIR}\"` 를 붙이십시오." % len(unpinned_hooks))

    if state == WIRING_INACTIVE:
        extra_warnings.insert(0, _wiring_warning(repo, info))
    if extra_warnings:
        info["warning"] = "\n".join(extra_warnings)
    return info


def _wiring_warning(repo, info):
    # 보조 신호: done 인데 commit 이 비어 있음 = PostToolUse 미발화의 흔적
    extra = ""
    if info["done_total"] and info["done_without_commit"] == info["done_total"]:
        extra = (" 보조 신호: done %d건 전부 커밋 SHA 기록 없음(PostToolUse 미발화 흔적)."
                 % info["done_total"])
    return ("[AutoHarness 경고] 훅 배선 비활성 의심 — 저장소 설정에 하네스 훅(%s)이 등록돼 "
            "있으나 실제 발화 기록이 한 번도 없습니다. 세션 프로젝트 루트가 저장소 밖이면 "
            ".claude/settings.json 이 로드되지 않아 커밋 게이트·금지 명령 차단·Stop 게이트가 "
            "모두 무력화됩니다 — 저장소 루트(%s)에서 claude 를 실행하십시오.%s "
            "(경고일 뿐 주행은 계속합니다)"
            % (", ".join(info["registered"]), rp(repo)["repo"], extra))


# ---------------------------------------------------------------- 스택 실측

def _read(path, cap=200_000):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(cap)
    except OSError:
        return ""


def _git(repo, *args):
    try:
        r = subprocess.run(["git"] + list(args), cwd=repo, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=30)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def detect(repo):
    repo = os.path.abspath(repo)
    if not os.path.isdir(repo):
        die("저장소 경로가 없습니다: " + repo)
    ex = lambda *p: os.path.exists(os.path.join(repo, *p))
    build_tools, suggestions, multimodule = [], {}, []

    if ex("pom.xml"):
        build_tools.append("maven")
        pom = _read(os.path.join(repo, "pom.xml"))
        multimodule += re.findall(r"<module>([^<]+)</module>", pom)
        suggestions["maven"] = {"build": "mvn -B -q compile", "test": "mvn -B verify",
                                "test_scoped": "mvn -B verify -pl {path} -am",
                                "lint": "mvn -B checkstyle:check" if "checkstyle" in pom else
                                        ("mvn -B spotless:check" if "spotless" in pom else None)}
    if ex("build.gradle") or ex("build.gradle.kts"):
        build_tools.append("gradle")
        settings = _read(os.path.join(repo, "settings.gradle")) + _read(os.path.join(repo, "settings.gradle.kts"))
        multimodule += re.findall(r"include\s*[\(\s]['\"]([^'\"]+)['\"]", settings)
        suggestions["gradle"] = {"build": "gradlew build -x test" if ex("gradlew") else "gradle build -x test",
                                 "test": ("gradlew" if ex("gradlew") else "gradle") + " test",
                                 "test_scoped": ("gradlew" if ex("gradlew") else "gradle") + " {path}:test",
                                 "lint": None}
    if ex("package.json"):
        build_tools.append("node")
        pkg = load_json(os.path.join(repo, "package.json"), {})
        scripts = pkg.get("scripts", {})
        ws = pkg.get("workspaces")
        if ws:
            multimodule += ws if isinstance(ws, list) else ws.get("packages", [])
        suggestions["node"] = {"build": "npm run build" if "build" in scripts else None,
                               "test": "npm test" if "test" in scripts else None,
                               "test_scoped": "npx jest {path}" if "jest" in json.dumps(pkg) else None,
                               "lint": "npm run lint" if "lint" in scripts else None}
    if ex("pyproject.toml") or ex("setup.py"):
        build_tools.append("python")
        py = _read(os.path.join(repo, "pyproject.toml"))
        suggestions["python"] = {"build": None, "test": "python -m pytest -x -q",
                                 "test_scoped": "python -m pytest -x -q {path}",
                                 "lint": "python -m ruff check ." if "ruff" in py else None}
    if ex("go.mod"):
        build_tools.append("go")
        suggestions["go"] = {"build": "go build ./...", "test": "go test ./...",
                             "test_scoped": "go test ./{path}/...", "lint": None}
    if ex("Gemfile"):
        build_tools.append("ruby")
        suggestions["ruby"] = {"build": None, "test": "bundle exec rspec", "test_scoped": "bundle exec rspec {path}", "lint": None}
    if ex("Cargo.toml"):
        build_tools.append("rust")
        suggestions["rust"] = {"build": "cargo build", "test": "cargo test", "test_scoped": "cargo test -p {path}", "lint": "cargo clippy -- -D warnings"}
    try:
        entries = os.listdir(repo)
    except OSError:
        entries = []
    if any(e.endswith(".sln") or e.endswith(".csproj") for e in entries):
        build_tools.append("dotnet")
        suggestions["dotnet"] = {"build": "dotnet build", "test": "dotnet test", "test_scoped": "dotnet test {path}", "lint": None}

    test_dirs = [d for d in ("src/test", "test", "tests", "__tests__", "spec", "src/androidTest")
                 if os.path.isdir(os.path.join(repo, *d.split("/")))]
    lint_configs = [f for f in (".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs",
                                "eslint.config.js", "eslint.config.mjs", "checkstyle.xml", ".golangci.yml",
                                ".rubocop.yml", "ruff.toml", ".editorconfig") if ex(f)]
    agent_configs = [f for f in ("CLAUDE.md", ".claude", "AGENTS.md", ".cursorrules") if ex(f)]

    return {
        "repo": repo,
        "build_tools": build_tools,
        "multimodule": multimodule,
        "test_dirs": test_dirs,
        "tests_present": bool(test_dirs),
        "lint_configs": lint_configs,
        "existing_agent_configs": agent_configs,
        "suggested_commands": suggestions,
        "git": {
            "is_repo": _git(repo, "rev-parse", "--is-inside-work-tree") == "true",
            "branch": _git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
            "dirty_files": len((_git(repo, "status", "--porcelain") or "").splitlines()),
            "last_commit": _git(repo, "log", "-1", "--oneline"),
        },
    }


# ---------------------------------------------------------------- 장부 조작

def new_task(id_, title, path=None, deps=None, priority=100, test_cmd=None):
    return {"id": id_, "title": title, "path": path, "deps": deps or [], "priority": priority,
            "status": "pending", "attempts": 0, "last_error": None, "last_log_file": None,
            "commit": None, "started_at": None, "finished_at": None, "test_cmd": test_cmd or None}


def cmd_init(a):
    p = rp(a.repo)
    if os.path.exists(p["tracker"]) and not a.force:
        die("장부가 이미 있습니다: " + p["tracker"] + " (--force 로 재초기화)")
    if a.model and a.model not in ALLOWED_MODELS:
        die("model 은 %s 중 하나여야 합니다" % (ALLOWED_MODELS,))
    os.makedirs(p["logs"], exist_ok=True)
    tracker = {
        "schema_version": 1, "project": a.project, "objective": a.objective,
        "source_stack": a.source, "target_stack": a.target,
        "model": a.model or MODEL_OPUS,
        "commands": {"build": a.build, "test": a.test, "lint": a.lint,
                     "timeout_sec": a.timeout_sec},
        "max_attempts": a.max_attempts, "created_at": now_iso(), "updated_at": now_iso(),
        "tasks": [],
    }
    save_tracker(a.repo, tracker)
    example = dict(tracker)
    example["tasks"] = [dict(new_task("mod-core", "core 모듈 서비스 계층 이식", "core", [], 10),
                             status="done", attempts=2, commit="0123abc",
                             last_log_file=".claude/harness-logs/mod-core-20260101T000000Z.log",
                             started_at="2026-01-01T00:00:00+00:00", finished_at="2026-01-01T01:00:00+00:00"),
                        dict(new_task("mod-api", "api 모듈 컨트롤러 이식", "api", ["mod-core"], 20),
                             last_error="[ERROR] cannot find symbol: UserDto (…최대 4000자)", attempts=1,
                             status="failed")]
    atomic_write_json(p["example"], example)
    save_state(a.repo, {"last_run": None, "stop_blocks": 0, "tracker_hash": None})
    render(a.repo)
    print(json.dumps({"ok": True, "tracker": p["tracker"], "example": p["example"], "logs": p["logs"]},
                     ensure_ascii=False))


def deps_reach(tasks_by_id, start_ids, target_id):
    """deps 그래프를 따라 start_ids 에서 target_id 에 닿는지 검사(순환 탐지용)."""
    seen, stack = set(), list(start_ids)
    while stack:
        cur = stack.pop()
        if cur == target_id:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        t = tasks_by_id.get(cur)
        if t:
            stack.extend(t.get("deps", []))
    return False


def cmd_add_task(a):
    tracker = load_tracker(a.repo)
    if any(t["id"] == a.id for t in tracker["tasks"]):
        die("이미 존재하는 작업 id: " + a.id)
    deps = [d.strip() for d in (a.deps or "").split(",") if d.strip()]
    if a.id in deps:
        die("자기 자신에 의존할 수 없습니다: %s (영구 교착 작업이 됩니다)" % a.id)
    known = {t["id"] for t in tracker["tasks"]}
    unknown = [d for d in deps if d not in known]
    if unknown:
        die("존재하지 않는 의존 id: %s (선행 작업을 먼저 add-task 하십시오)" % unknown)
    by_id = {t["id"]: t for t in tracker["tasks"]}
    if deps_reach(by_id, deps, a.id):
        # 손편집 등으로 기존 작업이 이 id 를 이미 참조하는 경우 — 추가하면 순환이 완성된다
        die("순환 의존이 생깁니다: 기존 작업이 %s 를 (간접) 의존하고 있습니다" % a.id)
    tracker["tasks"].append(new_task(a.id, a.title, a.path, deps, a.priority, a.test_cmd))
    save_tracker(a.repo, tracker)
    render(a.repo)
    print(json.dumps({"ok": True, "id": a.id}, ensure_ascii=False))


def cmd_set_task(a):
    tracker = load_tracker(a.repo)
    task = find_task(tracker, a.id)
    if task is None:
        die("작업 없음: " + a.id)
    if a.status:
        if a.status not in ("pending", "blocked"):
            die("set-task 로는 pending/blocked 만 설정할 수 있습니다. done 은 run 성공으로만 기록됩니다.")
        task["status"] = a.status
        if a.status == "pending":
            task["attempts"] = 0
            task["last_error"] = None
    if a.note:
        task["last_error"] = a.note[:LAST_ERROR_CAP]
    if a.test_cmd is not None:
        task["test_cmd"] = a.test_cmd or None  # 빈 문자열이면 해제 → 전역 test 로 복귀
    save_tracker(a.repo, tracker)
    render(a.repo)
    print(json.dumps({"ok": True, "task": task}, ensure_ascii=False))


def find_task(tracker, id_):
    for t in tracker["tasks"]:
        if t["id"] == id_:
            return t
    return None


def eligible_next(tracker):
    """선택 규칙: in_progress → 재시도 가능한 failed → deps 전부 done 인 pending."""
    done = {t["id"] for t in tracker["tasks"] if t["status"] == "done"}
    max_att = tracker.get("max_attempts", 5)

    def pick(cands):
        return sorted(cands, key=lambda t: (t.get("priority", 100), t["id"]))[0] if cands else None

    cur = pick([t for t in tracker["tasks"] if t["status"] == "in_progress"])
    if cur:
        return cur
    retry = pick([t for t in tracker["tasks"] if t["status"] == "failed" and t["attempts"] < max_att])
    if retry:
        return retry
    fresh = pick([t for t in tracker["tasks"] if t["status"] == "pending"
                  and all(d in done for d in t.get("deps", []))])
    return fresh


def deadlocked_pending(tracker):
    """충족 불가능한 pending — 의존이 미존재·blocked·순환이라 영영 실행될 수 없는 작업.

    고정점 계산: done 이거나, blocked 가 아니면서 의존 전부가 '언젠가 done 가능'인
    작업을 반복 확장한다. 확장이 끝난 뒤에도 집합 밖에 남은 pending 이 교착이다.
    """
    doable = {t["id"] for t in tracker["tasks"] if t["status"] == "done"}
    changed = True
    while changed:
        changed = False
        for t in tracker["tasks"]:
            if t["id"] in doable or t["status"] == "blocked":
                continue
            if all(d in doable for d in t.get("deps", [])):
                doable.add(t["id"])
                changed = True
    return [t for t in tracker["tasks"] if t["status"] == "pending" and t["id"] not in doable]


def cmd_next(a):
    tracker = load_tracker(a.repo)
    t = eligible_next(tracker)
    dead = [d["id"] for d in deadlocked_pending(tracker)]
    if t is None:
        counts = status_counts(tracker)
        out = {"next": None, "counts": counts}
        if dead:
            out["deadlocked"] = dead
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(EXIT_NO_TASK)
    out = {"next": t}
    if dead:
        out["deadlocked"] = dead
    print(json.dumps(out, ensure_ascii=False, indent=2))


def status_counts(tracker):
    c = {"pending": 0, "in_progress": 0, "done": 0, "failed": 0, "blocked": 0}
    for t in tracker["tasks"]:
        c[t["status"]] = c.get(t["status"], 0) + 1
    return c


# ---------------------------------------------------------------- 러너

def summarize(text):
    """오류 요약 — **강한 신호를 먼저 채운다.**

    ERROR_LINE_RE 는 재현율을 위해 넓게 잡혀 있어 `Downloading error-prone-2.0.jar` 같은
    무해한 줄도 걸린다(실측). 걸린 순서대로 60줄을 채우면 앞쪽 잡음이 상한을 먹어 정작
    진짜 오류가 밖으로 밀려나고 last_error 에서 잘린다(적대 검증에서 확인). 정규식을
    좁히면 진짜 오류를 놓치므로, 재현율은 두고 **우선순위**로 해결한다."""
    lines = [ln.strip()[:SUMMARY_LINE_CAP] for ln in text.splitlines() if ln.strip()]
    strong, weak = [], []
    for ln in lines:
        if not ERROR_LINE_RE.search(ln):
            continue
        (strong if STRONG_ERROR_RE.search(ln) else weak).append(ln)
    hits = strong + weak
    if hits:
        return hits[:SUMMARY_MAX_LINES]
    return lines[-SUMMARY_TAIL_LINES:]


def decode_output(b):
    """자식 출력 디코드: utf-8 → 로케일 코드페이지(cp949 등) → utf-8 replace 순 폴백.
    한국어 Windows 의 javac/maven 류가 내보내는 cp949 오류 원문을 보존한다."""
    if not b:
        return ""
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        import locale
        try:
            return b.decode(locale.getpreferredencoding(False))
        except (UnicodeDecodeError, LookupError):
            return b.decode("utf-8", errors="replace")


HEARTBEAT_PUMP_SEC = 300  # 장시간 스테이지 중 주기 갱신 — 워치독 stale(30분) 오판·이중 기동 방지


class HeartbeatPump:
    """run 스테이지 실행 중 주기적으로 하트비트를 갱신하는 데몬 스레드.

    단일 스테이지가 timeout_sec(기본 1800초)까지 걸리면 하트비트 공백이
    워치독 stale 판정(30분)에 근접한다 — 스테이지가 살아 있는 동안 interval 마다
    갱신해 세션 사망 오판을 막는다. write_heartbeat 은 예외를 삼키므로 안전하다.
    """

    def __init__(self, repo, interval=HEARTBEAT_PUMP_SEC, source="run"):
        self.repo, self.interval, self.source = repo, interval, source
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def _loop(self):
        while not self._stop.wait(self.interval):
            write_heartbeat(self.repo, self.source)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)
        return False


def heartbeat_pump_interval():
    """환경변수 AUTOHARNESS_HEARTBEAT_PUMP_SEC 로 재정의 가능(테스트·특수 운영)."""
    try:
        return float(os.environ.get("AUTOHARNESS_HEARTBEAT_PUMP_SEC", "") or HEARTBEAT_PUMP_SEC)
    except ValueError:
        return HEARTBEAT_PUMP_SEC


def run_stage(repo, name, cmd, log_f, timeout):
    log_f.write("\n===== stage: %s =====\n$ %s\n" % (name, cmd))
    log_f.flush()
    try:
        r = subprocess.run(cmd, shell=True, cwd=repo, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=timeout)
        out = decode_output(r.stdout or b"")
        log_f.write(out)
        log_f.flush()
        return r.returncode, out
    except subprocess.TimeoutExpired:
        msg = "[ERROR] 명령이 %d초 제한을 초과했습니다: %s" % (timeout, cmd)
        log_f.write(msg + "\n")
        return 124, msg


def cmd_run(a):
    p = rp(a.repo)
    tracker = load_tracker(a.repo)
    max_att = tracker.get("max_attempts", 5)

    # 훅 배선이 끊겼으면 경고만 하고 계속 진행한다(fail-open — 주행을 막지 않는다)
    wiring = hook_wiring_status(a.repo, tracker)
    if wiring["warning"]:
        sys.stderr.write(wiring["warning"] + "\n")

    if a.task:
        task = find_task(tracker, a.task)
        if task is None:
            die("작업 없음: " + a.task)
        if task["status"] == "blocked":
            print("HARNESS RESULT task=%s exit=4 (이미 blocked — 사람 판단 필요)" % task["id"])
            sys.exit(EXIT_BLOCKED)
        if task["status"] == "done" and not a.cmd:
            die("이미 done 인 작업입니다: " + task["id"])
        if task["status"] == "pending":
            done = {t["id"] for t in tracker["tasks"] if t["status"] == "done"}
            missing = [d for d in task.get("deps", []) if d not in done]
            if missing:
                die("선행 작업 미완료: %s → %s" % (task["id"], missing))
    else:
        task = eligible_next(tracker)
        if task is None:
            counts = status_counts(tracker)
            if counts["blocked"]:
                print("HARNESS RESULT exit=4 진행 가능 작업 없음 (blocked=%d — 사람 판단 필요)" % counts["blocked"])
                sys.exit(EXIT_BLOCKED)
            print("HARNESS RESULT exit=3 진행 가능 작업 없음 %s" % json.dumps(counts))
            sys.exit(EXIT_NO_TASK)

    if task["status"] in ("pending", "failed") and not task["started_at"]:
        task["started_at"] = now_iso()
    task["status"] = "in_progress"
    save_tracker(a.repo, tracker)

    state = load_state(a.repo)
    state["last_run"] = {"task": task["id"], "ok": False, "ts": now_iso()}
    save_state(a.repo, state)
    write_heartbeat(a.repo, "run")

    cmds = tracker.get("commands", {})
    timeout = int(cmds.get("timeout_sec") or 1800)
    path_sub = task.get("path") or ""

    def sub(c):
        return c.replace("{path}", path_sub) if c else None

    if a.cmd:
        stages = [("custom", a.cmd)]
    else:
        stages = []
        if cmds.get("build"):
            stages.append(("build", sub(cmds["build"])))
        test_cmd = task.get("test_cmd") or cmds.get("test")
        if not test_cmd:
            die("test 명령이 없습니다 (tracker.commands.test)")
        stages.append(("test", sub(test_cmd)))
        if cmds.get("lint"):
            stages.append(("lint", sub(cmds["lint"])))

    os.makedirs(p["logs"], exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = os.path.join(p["logs"], "%s-%s.log" % (task["id"], ts))
    n = 1
    while os.path.exists(log_path):  # 같은 초 재실행 시 이전 시도 로그 보존
        log_path = os.path.join(p["logs"], "%s-%s-%d.log" % (task["id"], ts, n))
        n += 1
    rel_log = os.path.relpath(log_path, p["repo"]).replace("\\", "/")

    failed_stage, fail_out = None, ""
    with open(log_path, "w", encoding="utf-8", errors="replace") as log_f:
        log_f.write("task=%s title=%s time=%s\n" % (task["id"], task["title"], now_iso()))
        with HeartbeatPump(a.repo, interval=heartbeat_pump_interval()):
            for name, cmd in stages:
                rc, out = run_stage(p["repo"], name, cmd, log_f, timeout)
                if rc != 0:
                    failed_stage, fail_out = name, out
                    break

    tracker = load_tracker(a.repo)          # 스테이지 실행 중 외부 변경 방어: 재로드 후 갱신
    task = find_task(tracker, task["id"])
    task["last_log_file"] = rel_log

    if failed_stage is None:
        task["status"] = "done"
        task["finished_at"] = now_iso()
        task["last_error"] = None
        save_tracker(a.repo, tracker)
        state = load_state(a.repo)
        state["last_run"] = {"task": task["id"], "ok": True, "ts": now_iso()}
        save_state(a.repo, state)
        render_safe(a.repo)
        print("HARNESS RESULT task=%s exit=0 통과 (다음: 커밋 후 다음 작업) log=%s" % (task["id"], rel_log))
        sys.exit(EXIT_OK)

    task["attempts"] = int(task.get("attempts", 0)) + 1
    summary_lines = summarize(fail_out)
    task["last_error"] = ("stage=%s\n" % failed_stage + "\n".join(summary_lines))[:LAST_ERROR_CAP]

    if task["attempts"] >= max_att:
        task["status"] = "blocked"
        save_tracker(a.repo, tracker)
        render_safe(a.repo)
        print("HARNESS RESULT task=%s exit=4 시도 한도 도달(%d/%d) — 작업 봉인(blocked). "
              "남은 작업이 있으면 다음 작업 계속, 없으면 보고 log=%s"
              % (task["id"], task["attempts"], max_att, rel_log))
        for ln in summary_lines[:10]:
            print("  " + ln)
        sys.exit(EXIT_BLOCKED)

    task["status"] = "failed"
    save_tracker(a.repo, tracker)
    render(a.repo)
    print("HARNESS RESULT task=%s exit=1 stage=%s 실패 attempts=%d/%d log=%s"
          % (task["id"], failed_stage, task["attempts"], max_att, rel_log))
    for ln in summary_lines:
        print("  " + ln)
    sys.exit(EXIT_FAIL)


# ---------------------------------------------------------------- 렌더/요약

def render(repo):
    tracker = load_tracker(repo, required=False)
    if tracker is None:
        return
    c = status_counts(tracker)
    total = len(tracker["tasks"])
    icon = {"pending": "⏳", "in_progress": "🔧", "done": "✅", "failed": "❌", "blocked": "⛔"}
    rows = []
    for t in sorted(tracker["tasks"], key=lambda t: (t.get("priority", 100), t["id"])):
        note = (t.get("last_error") or "").replace("\n", " ")[:80]
        rows.append("| %s | %s | %s %s | %d/%d | %s | %s |" % (
            t["id"], t["title"], icon.get(t["status"], ""), t["status"],
            t.get("attempts", 0), tracker.get("max_attempts", 5), t.get("commit") or "-", note or "-"))
    text = (
        "# PROGRESS — %s\n\n" % tracker.get("project", "")
        + "> 자동 생성 파일입니다(`.claude/agent_tracker.json` 렌더링). 직접 수정하지 마세요.\n\n"
        + "- 목표: %s\n" % tracker.get("objective", "")
        + "- 이식: %s → %s\n" % (tracker.get("source_stack", ""), tracker.get("target_stack", ""))
        + "- 모델: %s / 갱신: %s\n\n" % (tracker.get("model", ""), now_iso())
        + "## 현황: done %d / %d  (in_progress %d, failed %d, blocked %d, pending %d)\n\n"
        % (c["done"], total, c["in_progress"], c["failed"], c["blocked"], c["pending"])
        + "| ID | 제목 | 상태 | 시도 | 커밋 | 비고 |\n|---|---|---|---|---|---|\n"
        + "\n".join(rows) + "\n"
    )
    atomic_write_text(rp(repo)["progress"], text)


def render_safe(repo):
    """run 의 마무리 렌더 — 실패가 **검증 결과 판정을 뒤집지 않게** 격리한다.

    PROGRESS.md 는 장부에서 파생된 표시물이다. 그 쓰기가 실패했다고 통과한 검증이
    실패로 보고되면(예외가 전파돼 비정상 종료) 결과가 거짓이 된다."""
    try:
        render(repo)
        return True
    except Exception as e:
        sys.stderr.write("[AutoHarness] PROGRESS.md 렌더 실패(검증 결과에는 영향 없음): %r\n" % (e,))
        return False


def cmd_render(a):
    render(a.repo)
    print("PROGRESS.md 재렌더 완료")


def cmd_brief(a):
    tracker = load_tracker(a.repo, required=False)
    if tracker is None:
        return
    c = status_counts(tracker)
    nxt = eligible_next(tracker)
    dead = deadlocked_pending(tracker)
    print("[AutoHarness] project=%s model=%s" % (tracker.get("project"), tracker.get("model")))
    print("목표: %s" % tracker.get("objective", ""))
    print("현황: done %d/%d, in_progress %d, failed %d, blocked %d, pending %d"
          % (c["done"], len(tracker["tasks"]), c["in_progress"], c["failed"], c["blocked"], c["pending"]))
    # 배선이 끊겼을 때만 알린다 — 정상·미등록 저장소에 잡음을 더하지 않는다(brief 는 15줄 이하)
    wiring = hook_wiring_status(a.repo, tracker)
    if wiring["warning"]:
        print(wiring["warning"])
    if dead:
        print("교착 pending %d건(의존이 미존재·blocked·순환 — 영영 실행 불가): %s"
              % (len(dead), ", ".join(t["id"] for t in dead)))
    if nxt:
        print("다음 작업: %s — %s (attempts %d/%d)"
              % (nxt["id"], nxt["title"], nxt.get("attempts", 0), tracker.get("max_attempts", 5)))
        if nxt.get("last_error"):
            print("직전 오류: " + nxt["last_error"].replace("\n", " ")[:200])
    else:
        print("진행 가능한 작업 없음 (완료 또는 blocked — PROGRESS.md 확인)")
    print("규칙: 진실 원천=.claude/agent_tracker.json, 수정 후 bash scripts/agent_harness.sh --task <id>,"
          " 커밋 전 통과 필수, 테스트 약화 금지")


def cmd_status(a):
    tracker = load_tracker(a.repo)
    hb = load_json(rp(a.repo)["heartbeat"])
    print(json.dumps({"project": tracker.get("project"), "model": tracker.get("model"),
                      "counts": status_counts(tracker), "next": eligible_next(tracker),
                      "deadlocked": [t["id"] for t in deadlocked_pending(tracker)],
                      "heartbeat": hb, "hooks": hook_wiring_status(a.repo, tracker),
                      "paused": os.path.exists(rp(a.repo)["paused_flag"])},
                     ensure_ascii=False, indent=2))


def cmd_heartbeat(a):
    write_heartbeat(a.repo, "manual")
    print(json.dumps({"ok": True}, ensure_ascii=False))


def sync_commit(repo, require_new_head=False):
    """최신 done 작업에 HEAD SHA 를 기록.

    require_new_head=True(hook-postbash 경로): hook-prebash 가 커밋 직전에 남긴
    1회용 마커(head_before_commit)와 현재 HEAD 를 대조해, 커밋이 실패해 HEAD 가
    변하지 않았으면(nothing to commit 등) 직전 커밋을 오귀속하지 않는다.
    마커가 없으면(수동 sync-commit·부분 설치) 종전대로 기록한다(fail-open).
    """
    tracker = load_tracker(repo, required=False)
    if tracker is None:
        return None
    sha = _git(repo, "rev-parse", "--short", "HEAD")
    if not sha:
        return None  # HEAD 없음 — 커밋 미생성. 마커는 다음 시도를 위해 남긴다
    if require_new_head:
        state = load_state(repo)
        if "head_before_commit" in state:
            prev = state.pop("head_before_commit")
            save_state(repo, state)  # 마커는 1회용 — 소진해 재사용 오귀속을 막는다
            if sha == prev:
                return None  # 커밋 명령이 새 커밋을 만들지 못함 — 기록하지 않는다
    cands = [t for t in tracker["tasks"] if t["status"] == "done" and not t.get("commit")]
    if not cands:
        return None
    cands.sort(key=lambda t: t.get("finished_at") or "", reverse=True)
    cands[0]["commit"] = sha
    save_tracker(repo, tracker)
    render(repo)
    return {"task": cands[0]["id"], "commit": sha}


def cmd_sync_commit(a):
    r = sync_commit(a.repo)
    print(json.dumps({"synced": r}, ensure_ascii=False))


# ---------------------------------------------------------------- 모델 추천

def model_recommend(repo=None, source=None, target=None, notes=None):
    rationale, score = [], 0
    det = None
    if repo and os.path.isdir(repo):
        det = detect(repo)
        tracker = load_tracker(repo, required=False)
        if tracker:
            source = source or tracker.get("source_stack")
            target = target or tracker.get("target_stack")

    def lang(s):
        m = re.match(r"[A-Za-z#+.]+", (s or "").strip())
        return m.group(0).lower() if m else ""

    src_lang, tgt_lang = lang(source), lang(target)
    # 비ASCII 스택명(한글 등)은 언어 토큰이 비어 판정 불능 — 양쪽 토큰이 있을 때만 가산
    if source and target and src_lang and tgt_lang and src_lang != tgt_lang:
        score += 3
        rationale.append("언어 간 이식(%s → %s): 구조 재설계 판단이 많음 (+3)" % (source, target))
    if det is not None:
        if not det["tests_present"]:
            score += 2
            rationale.append("테스트 디렉토리 미발견: 검증 기준을 스스로 세워야 함 (+2)")
        if len(det["multimodule"]) > 5:
            score += 1
            rationale.append("모듈 %d개 멀티모듈: 순환·경계 판단 필요 (+1)" % len(det["multimodule"]))
        loc = estimate_loc(repo)
        if loc > 300_000:
            score += 2
            rationale.append("추정 LOC %s: 대규모 (+2)" % format(loc, ","))
        elif loc > 100_000:
            score += 1
            rationale.append("추정 LOC %s: 중규모 이상 (+1)" % format(loc, ","))
    if notes:
        score += 2
        rationale.append("요구 모호성/특이사항 메모 있음 (+2): " + notes[:120])
    recommended = MODEL_FABLE if score >= 4 else MODEL_OPUS
    if not rationale:
        rationale.append("복잡도 신호 없음 — 패턴형 작업으로 판단")
    return {
        "recommended": recommended, "score": score, "rationale": rationale, "decision": "user",
        "comparison": {
            MODEL_FABLE: "최상위 추론 — 교차 스택 이식·모호한 사양·테스트 공백·아키텍처 재설계에 강함",
            MODEL_OPUS: "패턴형 대량 루프에 비용·속도 유리, /fast(fast mode) 지원 — 기계적 이식·강한 테스트 존재 시 적합",
        },
    }


CODE_EXTS = (".java", ".kt", ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rb", ".rs",
             ".cs", ".cpp", ".c", ".h", ".scala", ".groovy", ".php", ".swift")
SKIP_DIRS = {".git", "node_modules", "target", "build", "dist", "out", "vendor",
             ".venv", "venv", "bin", "obj", ".idea", ".gradle", "__pycache__"}


def estimate_loc(repo):
    total = 0
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith(CODE_EXTS):
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    return total // 35  # 코드 1줄 평균 ~35바이트 가정한 추정치


def cmd_model_recommend(a):
    print(json.dumps(model_recommend(a.repo, a.source, a.target, a.notes), ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- 훅 (fail-open)

def read_hook_input():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


# ------------------------------------------------------- 명령 판정 (토큰 기반)
#
# 명령 문자열 전체를 정규식으로 훑으면 인용부호 안의 단어까지 명령으로 오인한다.
# 실측된 오탐: `git log --grep=push`, `grep -r "git push" docs/`,
# `git commit -m "push 준비 완료"`(허용해야 할 로컬 커밋), `echo "git push 하지 마세요"`.
# 반대로 `bash -c '...'` 같은 래퍼 안의 실제 명령은 구조를 모르므로 놓쳤다.
#
# 그래서 셸 구분자로 세그먼트를 나누고 shlex 로 토큰화한 뒤, **첫 토큰이 무엇이고
# git 서브커맨드가 무엇인가**로 판정한다. 인용은 shlex 가 존중하므로 문자열 안의
# 단어는 애초에 명령 위치에 오지 않는다.

ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# 값을 하나 더 먹는 git 전역 옵션 — 인자까지 건너뛰어야 서브커맨드를 정확히 찾는다
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                       "--exec-path", "--super-prefix"}
# 인자를 먹지 않는 수식어
NEUTRAL_PREFIXES = {"env", "command", "nohup", "builtin", "exec", "time", "stdbuf"}
# 인자를 N개 먹는 수식어 — 인자 수를 모르면 실제 명령 위치를 놓친다
PREFIX_ARITY = {"timeout": 1, "sudo": 0, "nice": 0, "ionice": 0, "doas": 0}
# 값을 먹는 수식어 옵션(`nice -n 10 git …`, `sudo -u user git …`)
PREFIX_OPTS_WITH_VALUE = {"-n", "-u", "-g", "-k", "--user", "--group"}
POSIX_SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "ash"}
PWSH_SHELLS = {"powershell", "pwsh"}
# 뒤따르는 토큰이 실제 실행 대상인 수식어
EXEC_DELEGATES = {"xargs"}
SHELL_OPERATORS = ("&&", "||", ";", "|", "\n", "&")
WRAPPER_MAX_DEPTH = 3          # 래퍼 재귀 상한 — 무한 중첩 방어
# --force 로 파괴적이 되는 서브커맨드. `restore` 는 --force 옵션 자체가 없어 제외한다
# (적대 검증에서 '절대 발동하지 않는 죽은 규칙'으로 지적됨 — restore 는 아래 별도 규칙).
FORCE_SUBCOMMANDS = {"branch", "checkout", "switch"}

# 원격 상태를 바꾸는 gh 동작 — `git push` 없이도 원격을 바꿀 수 있으므로 함께 막는다.
# 그룹별 쓰기 동사만 열거한다(list/view/status/diff/download 등 읽기는 통과).
GH_WRITE_ACTIONS = {
    "pr": {"create", "merge", "close", "reopen", "edit", "ready", "review", "comment"},
    "release": {"create", "delete", "edit", "upload"},
    "repo": {"create", "delete", "edit", "rename", "archive", "sync"},
    "issue": {"create", "close", "reopen", "edit", "comment", "delete", "transfer"},
    "workflow": {"run", "enable", "disable"},
    "secret": {"set", "delete"},
    "variable": {"set", "delete"},
    "gist": {"create", "delete", "edit"},
    "cache": {"delete"},
    "label": {"create", "delete", "edit"},
}
GH_WRITE_METHODS = {"post", "put", "patch", "delete"}
# 로컬 이력·작업물을 되돌릴 수 없게 파괴하는 git 동작
HISTORY_DESTRUCTIVE = {
    ("stash", "drop"), ("stash", "clear"),
    ("reflog", "expire"), ("reflog", "delete"),
    ("worktree", "remove"),
}
# 판정 불가(파싱 실패) 세그먼트에만 쓰는 안전망 키워드 — 구조 판정의 대체가 아니라 보조다.
# 이게 없으면 파싱 실패가 곧 '무검사 통과'가 되어 fail-open 이 우회 경로가 된다.
UNPARSED_RISK_RE = re.compile(
    r"\b(push|--force|--force-with-lease|reset\s+--hard|clean\s+-[A-Za-z]*f|"
    r"filter-branch|reflog\s+expire)\b", re.IGNORECASE)

LINE_CONTINUATION_RE = re.compile(r"\\\r?\n")


def _fold_continuations(command):
    """역슬래시 줄바꿈을 접는다 — `git \\<개행> push` 가 두 조각으로 갈라지는 것을 막는다."""
    return LINE_CONTINUATION_RE.sub(" ", command or "")


def _split_on_operators(tokens):
    groups, current = [], []
    for t in tokens:
        if t in SHELL_OPERATORS:
            if current:
                groups.append(current)
            current = []
        else:
            current.append(t)
    if current:
        groups.append(current)
    return groups


def _command_segments(command):
    """따옴표를 존중해 토큰화한 뒤 연산자에서 끊는다.

    문자열을 먼저 정규식으로 자르면 따옴표·heredoc 안의 `;`·`|`·개행이 분할점이 되어
    정상 명령이 스스로 파싱 불능이 된다(실측: 여러 줄 커밋 메시지가 통째로 무검사 통과).
    반환: (세그먼트 토큰 목록, 파싱 실패 여부)."""
    text = _fold_continuations(command)
    if not text.strip():
        return [], False
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return [], True          # 따옴표 불균형 등 — 호출자가 안전망으로 처리한다
    return _split_on_operators(tokens), False


def _strip_neutral_prefix(tokens):
    """선행 환경변수 대입·수식어를 인자 수까지 고려해 걷어낸다."""
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if ENV_ASSIGN_RE.match(t):
            i += 1
            continue
        name = _exe_name(t)
        if name in NEUTRAL_PREFIXES:
            i += 1
            continue
        if name in PREFIX_ARITY:
            i += 1
            # 수식어 자신의 옵션(값을 먹는 것 포함)을 건너뛴다
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 2 if tokens[i] in PREFIX_OPTS_WITH_VALUE else 1
            i += PREFIX_ARITY[name]      # timeout 의 duration 처럼 위치 인자
            continue
        if name in EXEC_DELEGATES:
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 2 if tokens[i] in ("-n", "-P", "-I", "-L", "-d") else 1
            continue
        break
    return tokens[i:]


def _exe_name(token):
    name = os.path.basename(token.replace("\\", "/")).lower()
    return name[:-4] if name.endswith(".exe") else name


def _git_subcommand(args):
    """git 뒤 전역 옵션을 건너뛰고 (서브커맨드, 나머지 인자)를 돌려준다."""
    i = 0
    while i < len(args):
        a = args[i]
        if a in GIT_OPTS_WITH_VALUE:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        return a, args[i + 1:]
    return None, []


def _has_force_flag(rest):
    for a in rest:
        if a == "--force" or a.startswith("--force-with-lease"):
            return True
        if re.match(r"^-[A-Za-z]*f[A-Za-z]*$", a):   # -f · 결합 플래그(-fd) · 재배치(-d -f)
            return True
    return False


def _is_pwsh_command_flag(token):
    """PowerShell 은 접두사 축약을 허용한다 — -c · -co · … · -command 전부 같은 뜻."""
    t = token.lower()
    if not t.startswith("-"):
        return False
    body = t[1:]
    return bool(body) and "command".startswith(body)


def _wrapper_payload(tokens, posix):
    """래퍼(`bash -c` / `powershell -Command`)가 실행할 페이로드 문자열.

    반환: (페이로드, 판정불가여부). -EncodedCommand 는 디코드하지 않고 판정 불가로 둔다."""
    for i, t in enumerate(tokens):
        low = t.lower()
        if posix:
            if low == "-c" and i + 1 < len(tokens):
                return tokens[i + 1], False
        else:
            if low.startswith("-encodedcommand") or low == "-e" or low == "-enc":
                return None, True          # base64 — 구조 판정 불가
            if _is_pwsh_command_flag(t) and i + 1 < len(tokens):
                return tokens[i + 1], False
    return None, False


def _walk_git_invocations(command, depth=0):
    """명령 안에서 실제로 실행되는 git 호출을 (서브커맨드, 나머지 인자)로 내놓는다.

    반환하는 항목 중 ("<unparsed>", [원문]) 은 '구조 판정 불가' 신호다.
    래퍼(`bash -c "…"`)는 페이로드를 재귀 분석한다 — 래퍼로 감싸 우회하는 것을 막는다."""
    if depth > WRAPPER_MAX_DEPTH:
        yield UNPARSED, [command or ""]
        return
    segments, failed = _command_segments(command)
    if failed:
        yield UNPARSED, [command or ""]
        return
    for tokens in segments:
        tokens = _strip_neutral_prefix(tokens)
        if not tokens:
            continue
        exe = _exe_name(tokens[0])
        if exe in POSIX_SHELLS or exe in PWSH_SHELLS:
            payload, opaque = _wrapper_payload(tokens, exe in POSIX_SHELLS)
            if opaque:
                yield UNPARSED, [command or ""]
            elif payload:
                for item in _walk_git_invocations(payload, depth + 1):
                    yield item
            continue
        if exe not in ("git", "gh"):
            continue
        sub, rest = _git_subcommand(tokens[1:])
        if sub is not None:
            yield (exe + ":" + sub) if exe == "gh" else sub, rest


UNPARSED = "<unparsed>"


def _first_positional(rest):
    for a in rest:
        if not a.startswith("-"):
            return a
    return None


def _gh_deny_reason(group, rest):
    """gh 는 push 없이도 원격을 바꾼다 — 그룹별 쓰기 동사를 막는다."""
    if group == "api":
        for i, a in enumerate(rest):
            low = a.lower()
            if low in ("-x", "--method") and i + 1 < len(rest):
                if rest[i + 1].lower() in GH_WRITE_METHODS:
                    return "gh api 쓰기 요청 금지 — 원격 상태를 바꿉니다"
            if low.startswith("--method="):
                if low.split("=", 1)[1] in GH_WRITE_METHODS:
                    return "gh api 쓰기 요청 금지 — 원격 상태를 바꿉니다"
        return None
    action = _first_positional(rest)
    if action and action in GH_WRITE_ACTIONS.get(group, ()):
        return "원격 변경 금지 — gh %s %s 는 원격 상태를 바꿉니다" % (group, action)
    return None


def _git_deny_reason(sub, rest):
    if sub == "push":
        return "원격 반영(push) 금지 — 로컬 커밋만 허용됩니다"
    if sub == "subtree" and "push" in rest:
        return "원격 반영(subtree push) 금지 — 로컬 커밋만 허용됩니다"
    if sub == "reset" and "--hard" in rest:
        return "git reset --hard 금지"
    if sub == "clean" and _has_force_flag(rest):
        return "git clean 강제 삭제 금지"
    if sub in FORCE_SUBCOMMANDS and _has_force_flag(rest):
        return "git --force 계열 금지"
    if sub == "branch" and any(a == "-D" for a in rest):
        return "git branch -D 금지 — 병합되지 않은 브랜치가 사라집니다"
    if sub == "checkout" and "--" in rest:
        return "git checkout -- 금지 — 커밋되지 않은 작업물이 사라집니다"
    if sub == "restore" and "--staged" not in rest:
        return "git restore 금지 — 커밋되지 않은 작업물이 사라집니다"
    if (sub, _first_positional(rest)) in HISTORY_DESTRUCTIVE:
        return "git %s %s 금지 — 되돌릴 수 없습니다" % (sub, _first_positional(rest))
    if sub == "filter-branch":
        return "git filter-branch 금지 — 이력을 되돌릴 수 없게 재작성합니다"
    if sub == "update-ref" and "-d" in rest:
        return "git update-ref -d 금지 — 참조가 사라집니다"
    return None


def deny_reason(command):
    """차단 사유 문자열, 없으면 None.

    구조 판정이 1차다. 파싱이 불가능한 경우에만 키워드 안전망을 쓴다 — 파싱 실패를
    그냥 통과시키면 fail-open 이 곧 우회 경로가 된다(적대 검증에서 실측된 결함).

    막으려는 것은 명령 이름이 아니라 **결과** 둘이다: 원격 상태 변경과 되돌릴 수 없는
    로컬 파괴. 그래서 git 서브커맨드뿐 아니라 gh 쓰기 동사도 함께 본다."""
    for sub, rest in _walk_git_invocations(command):
        if sub == UNPARSED:
            if UNPARSED_RISK_RE.search(rest[0] if rest else ""):
                return ("명령 구조를 해석할 수 없는데 위험 키워드가 보입니다 — 확인이 필요합니다")
            continue
        reason = (_gh_deny_reason(sub[3:], rest) if sub.startswith("gh:")
                  else _git_deny_reason(sub, rest))
        if reason:
            return reason
    return None


# 커밋을 만드는 서브커맨드 → 그 서브커맨드에서 '커밋 안 함'을 뜻하는 플래그.
# `commit` 만 보면 revert·merge·cherry-pick 으로 검증 없이 이력이 늘고, postbash 의
# sync_commit 도 돌지 않아 커밋 SHA 가 장부에 남지 않는다(적대 검증에서 확인).
# `rebase` 는 제외한다 — 기존 커밋을 재생하는 것이라 '검증 안 된 새 작업'이 아니고,
# 충돌 해소 중 --continue 가 잦아 게이트가 주행을 방해한다.
COMMIT_CREATING = {
    "commit": (),
    "revert": ("--no-commit", "-n", "--abort", "--quit"),
    "cherry-pick": ("--no-commit", "-n", "--abort", "--quit"),
    "merge": ("--no-commit", "--abort", "--quit"),
    "am": ("--abort", "--skip", "--quit"),
}


def invokes_git_commit(command):
    """명령이 실제로 커밋을 만드는가 — 커밋 게이트·SHA 기록 판정용.

    문자열 매칭이면 `echo "git commit"` 같은 언급까지 게이트를 켜 버린다."""
    for sub, rest in _walk_git_invocations(command):
        if sub not in COMMIT_CREATING:
            continue
        if any(flag in rest for flag in COMMIT_CREATING[sub]):
            continue                     # 이 호출은 커밋을 만들지 않는다
        return True
    return False


# ------------------------------------------------- 게이트 판정 (컨텍스트 인지)
#
# 위험 모델은 "사람이 없을 때 에이전트가 되돌릴 수 없는 일을 하는 것"이다. 그런데
# 종전 구현은 금지 명령을 무조건 exit 2 로 막아, **사람이 눈앞에서 지시한 경우까지**
# 덮었다 — 사용자가 승인해도 실행이 불가능했다. 같은 파일의 hook-stop 은
# CLAUDE_AUTOHARNESS 로 헤드리스를 식별해 대화형을 건드리지 않는데 여기만 달랐다.
#
# 그래서 두 게이트(금지 명령·커밋)가 같은 판정 함수를 쓰게 통일한다:
#   헤드리스(무인)          → deny  : 물어볼 사람이 없으므로 하드 차단
#   대화형 / 일시정지 중     → ask   : 사용자 승인 창으로 승격 — 사람이 결정한다
#
# ask 는 Claude Code 훅 계약의 hookSpecificOutput.permissionDecision 값이다.

GATE_DENY = "deny"
GATE_ASK = "ask"


def is_headless_session():
    """워치독이 띄운 무인 세션인가 — hook-stop 과 동일한 식별 기준."""
    return os.environ.get("CLAUDE_AUTOHARNESS") == "1"


def gate_decision(repo):
    """게이트가 걸렸을 때의 처리 방식 — 사람이 개입할 수 있는 자리인가로 정한다."""
    if os.path.exists(rp(repo)["paused_flag"]):
        return GATE_ASK          # 일시정지 = 사람이 직접 운전 중
    return GATE_DENY if is_headless_session() else GATE_ASK


def emit_gate(decision, reason, command=""):
    """게이트 결과를 훅 계약대로 내보내고 종료한다."""
    if decision == GATE_DENY:
        sys.stderr.write("[AutoHarness 차단] %s: %s\n" % (reason, command[:200]))
        sys.exit(2)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "[AutoHarness] " + reason,
    }}, ensure_ascii=False))
    sys.exit(0)


def commit_gate_reason(repo):
    """커밋 게이트가 걸리는 사유 — 통과면 None."""
    tracker, state = load_tracker_checked(repo)
    if state == TRACKER_CORRUPT:
        # 파손을 '장부 없음(수동 운용)'으로 보고 통과시키면 게이트가 조용히 사라진다
        return ("장부가 파손돼 검증 상태를 확인할 수 없습니다: %s — 복구 후 커밋하십시오."
                % rp(repo)["tracker"])
    if not tracker or not tracker.get("tasks"):
        return None
    if os.path.exists(rp(repo)["paused_flag"]):
        return None                      # 일시정지 중에는 게이트를 걸지 않는다
    active = [t for t in tracker["tasks"] if t["status"] in ("in_progress", "failed")]
    if not active:
        return None
    if ((load_state(repo).get("last_run")) or {}).get("ok"):
        return None
    return ("커밋 게이트: 진행 중 작업(%s)의 harness 검증 통과 기록이 없습니다. "
            "bash scripts/agent_harness.sh --task %s 를 먼저 통과시키십시오."
            % (active[0]["id"], active[0]["id"]))


def cmd_hook_prebash(a):
    try:
        data = read_hook_input()
        command = (data.get("tool_input") or {}).get("command", "") or ""
        write_heartbeat(a.repo, "hook")
        record_hook_fire(a.repo, "hook-prebash", data)
        decision = gate_decision(a.repo)

        reason = deny_reason(command)
        if reason:
            emit_gate(decision, reason, command)

        if invokes_git_commit(command):
            gate = commit_gate_reason(a.repo)
            # 커밋이 실제로 일어날 수 있는 경로에서는 직전 HEAD 를 1회용 마커로 남긴다
            # (postbash 가 '새 커밋 생성'을 검증한다). 하드 차단이면 커밋이 없으므로 생략.
            if not (gate and decision == GATE_DENY):
                state = load_state(a.repo)
                state["head_before_commit"] = _git(a.repo, "rev-parse", "--short", "HEAD")
                save_state(a.repo, state)
            if gate:
                emit_gate(decision, gate, command)
        sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)  # fail-open


def cmd_hook_postbash(a):
    try:
        data = read_hook_input()
        command = (data.get("tool_input") or {}).get("command", "") or ""
        write_heartbeat(a.repo, "hook")
        record_hook_fire(a.repo, "hook-postbash", data)
        if invokes_git_commit(command):
            sync_commit(a.repo, require_new_head=True)
    except Exception:
        pass
    sys.exit(0)


def cmd_hook_stop(a):
    try:
        write_heartbeat(a.repo, "hook")
        record_hook_fire(a.repo, "hook-stop", read_hook_input())
        if os.environ.get("CLAUDE_AUTOHARNESS") != "1":
            sys.exit(0)
        if os.path.exists(rp(a.repo)["paused_flag"]):
            sys.exit(0)
        tracker = load_tracker(a.repo, required=False)
        if not tracker:
            sys.exit(0)
        nxt = eligible_next(tracker)
        if nxt is None:
            sys.exit(0)  # 더 할 일 없음 — 세션 종료 허용(이후는 워치독 소관)
        state = load_state(a.repo)
        h = hashlib.sha256()
        with open(rp(a.repo)["tracker"], "rb") as f:
            h.update(f.read())
        cur_hash = h.hexdigest()
        if state.get("tracker_hash") == cur_hash:
            state["stop_blocks"] = int(state.get("stop_blocks", 0)) + 1
        else:
            state["stop_blocks"] = 1
            state["tracker_hash"] = cur_hash
        save_state(a.repo, state)
        if state["stop_blocks"] > STOP_BLOCK_LIMIT:
            sys.stderr.write("[AutoHarness] 진전 없는 정지 %d회 — 토큰 방어를 위해 세션을 종료합니다. "
                             "워치독이 백오프 후 재기동합니다.\n" % state["stop_blocks"])
            sys.exit(0)
        reason = ("AutoHarness 자율 주행 중입니다. 다음 작업 '%s — %s'(attempts %d/%d)을(를) 계속 진행하십시오. "
                  "절차: 코드 수정 → bash scripts/agent_harness.sh --task %s → 종료 코드 분기"
                  "(0=커밋 후 다음 작업, 1=자가 수정 반복, 4=해당 작업 봉인 — 남은 작업 계속). "
                  "테스트 약화 금지, 사용자 질문 금지."
                  % (nxt["id"], nxt["title"], nxt.get("attempts", 0), tracker.get("max_attempts", 5), nxt["id"]))
        print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
        sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)  # fail-open


# ---------------------------------------------------------------- 자가 검증

def cmd_selftest(a):
    import io
    results = []
    sandbox = tempfile.mkdtemp(prefix="autoharness-selftest-")
    ok_py = os.path.join(sandbox, "ok.py")
    fail_py = os.path.join(sandbox, "fail.py")
    with open(ok_py, "w", encoding="utf-8") as f:
        f.write("print('all tests passed')\n")
    with open(fail_py, "w", encoding="utf-8") as f:
        f.write("import sys\nsys.stderr.write('ERROR: intentional failure\\n')\nsys.exit(1)\n")
    py = '"%s"' % sys.executable

    def check(name, cond, detail=""):
        results.append((name, bool(cond), detail))

    def run_cli(*args):
        """엔진을 서브프로세스로 호출해 실제 종료 코드를 검증한다."""
        r = subprocess.run([sys.executable, os.path.abspath(__file__)] + list(args),
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           cwd=sandbox, timeout=120)
        return r

    try:
        # 1. 장부 초기화 + 더미 작업 2건(의존 관계)
        r = run_cli("init", "--repo", sandbox, "--project", "selftest", "--objective", "자가검증",
                    "--source", "A", "--target", "B", "--test", py + ' "%s"' % ok_py)
        check("1-init", r.returncode == 0, r.stderr)
        r1 = run_cli("add-task", "--repo", sandbox, "--id", "t1", "--title", "선행 작업", "--priority", "10")
        r2 = run_cli("add-task", "--repo", sandbox, "--id", "t2", "--title", "후행 작업",
                     "--deps", "t1", "--priority", "20")
        check("1-add-tasks", r1.returncode == 0 and r2.returncode == 0, r1.stderr + r2.stderr)

        # 5(선행). 의존성 게이팅: t1 이 done 이 아니므로 next 는 t1 이어야 한다
        r = run_cli("next", "--repo", sandbox)
        check("5-dep-gating-before", r.returncode == 0 and '"id": "t1"' in r.stdout, r.stdout[:200])

        # 2. 실패 경로: exit 1, attempts=1, last_error 기록
        r = run_cli("run", "--repo", sandbox, "--task", "t1", "--cmd", py + ' "%s"' % fail_py)
        tr = load_json(rp(sandbox)["tracker"])
        t1 = find_task(tr, "t1")
        check("2-fail-exit1", r.returncode == 1, "exit=%d" % r.returncode)
        check("2-fail-attempts", t1["attempts"] == 1, "attempts=%s" % t1["attempts"])
        check("2-fail-last-error", t1["last_error"] and "ERROR" in t1["last_error"],
              str(t1["last_error"])[:120])
        check("2-fail-log-file", t1["last_log_file"] and
              os.path.exists(os.path.join(sandbox, t1["last_log_file"])), str(t1["last_log_file"]))

        # 3. 성공 경로: exit 0, status=done
        r = run_cli("run", "--repo", sandbox, "--task", "t1", "--cmd", py + ' "%s"' % ok_py)
        tr = load_json(rp(sandbox)["tracker"])
        t1 = find_task(tr, "t1")
        check("3-success-exit0", r.returncode == 0, "exit=%d" % r.returncode)
        check("3-success-done", t1["status"] == "done", t1["status"])

        # 5(후행). 게이팅 해제: 이제 next 는 t2
        r = run_cli("next", "--repo", sandbox)
        check("5-dep-gating-after", r.returncode == 0 and '"id": "t2"' in r.stdout, r.stdout[:200])

        # 4. 한도 경로: 5회 연속 실패 → 마지막이 exit 4 + blocked
        codes = []
        for _ in range(5):
            r = run_cli("run", "--repo", sandbox, "--task", "t2", "--cmd", py + ' "%s"' % fail_py)
            codes.append(r.returncode)
        tr = load_json(rp(sandbox)["tracker"])
        t2 = find_task(tr, "t2")
        check("4-limit-codes", codes == [1, 1, 1, 1, 4], str(codes))
        check("4-limit-blocked", t2["status"] == "blocked" and t2["attempts"] == 5,
              "%s/%s" % (t2["status"], t2["attempts"]))
        r = run_cli("next", "--repo", sandbox)
        check("4-no-eligible-exit3", r.returncode == 3, "exit=%d" % r.returncode)

        # 6. PROGRESS.md 렌더
        prog = rp(sandbox)["progress"]
        txt = _read(prog)
        check("6-progress-render", "t1" in txt and "t2" in txt and "blocked" in txt, prog)

    finally:
        # 7. 더미 데이터 정리 — 샌드박스 전체 삭제
        shutil.rmtree(sandbox, ignore_errors=True)
        results.append(("7-cleanup", not os.path.exists(sandbox), sandbox))

    all_ok = all(ok for _, ok, _ in results)
    for name, ok, detail in results:
        print("%s %s%s" % ("PASS" if ok else "FAIL", name, ("" if ok else " — " + str(detail))))
    print("selftest %s (%d/%d)" % ("통과" if all_ok else "실패",
                                   sum(1 for _, ok, _ in results if ok), len(results)))
    sys.exit(0 if all_ok else 1)


# ---------------------------------------------------------------- main

def build_parser():
    """CLI 표면을 구성해 돌려준다 — main 과 문서 정합 테스트가 같은 정의를 본다.

    SKILL.md 폴백 표가 실제 서브커맨드·옵션과 어긋나면 테스트가 잡아낸다."""
    ap = argparse.ArgumentParser(prog="harness_engine", description="AutoHarness engine")
    sub = ap.add_subparsers(dest="op")

    def common(sp):
        sp.add_argument("--repo", default=".")

    sp = sub.add_parser("detect"); common(sp)
    sp = sub.add_parser("init"); common(sp)
    sp.add_argument("--project", required=True); sp.add_argument("--objective", required=True)
    sp.add_argument("--source", required=True); sp.add_argument("--target", required=True)
    sp.add_argument("--test", required=True); sp.add_argument("--build", default=None)
    sp.add_argument("--lint", default=None); sp.add_argument("--model", default=None)
    sp.add_argument("--max-attempts", dest="max_attempts", type=int, default=5)
    sp.add_argument("--timeout-sec", dest="timeout_sec", type=int, default=1800)
    sp.add_argument("--force", action="store_true")
    sp = sub.add_parser("add-task"); common(sp)
    sp.add_argument("--id", required=True); sp.add_argument("--title", required=True)
    sp.add_argument("--path", default=None); sp.add_argument("--deps", default="")
    sp.add_argument("--priority", type=int, default=100)
    sp.add_argument("--test-cmd", dest="test_cmd", default=None,
                    help="이 작업 전용 test 명령 — 전역 commands.test 대신 실행({path} 치환 지원)")
    sp = sub.add_parser("set-task"); common(sp)
    sp.add_argument("--id", required=True); sp.add_argument("--status", default=None)
    sp.add_argument("--note", default=None)
    sp.add_argument("--test-cmd", dest="test_cmd", default=None,
                    help="작업 전용 test 명령 설정 (빈 문자열이면 해제 → 전역 test 복귀)")
    sp = sub.add_parser("next"); common(sp)
    sp = sub.add_parser("run"); common(sp)
    sp.add_argument("--task", default=None); sp.add_argument("--cmd", default=None)
    sp = sub.add_parser("render"); common(sp)
    sp = sub.add_parser("brief"); common(sp)
    sp = sub.add_parser("status"); common(sp)
    sp = sub.add_parser("heartbeat"); common(sp)
    sp = sub.add_parser("sync-commit"); common(sp)
    sp = sub.add_parser("model-recommend"); common(sp)
    sp.add_argument("--source", default=None); sp.add_argument("--target", default=None)
    sp.add_argument("--notes", default=None)
    sp = sub.add_parser("hook-prebash"); common(sp)
    sp = sub.add_parser("hook-postbash"); common(sp)
    sp = sub.add_parser("hook-stop"); common(sp)
    sp = sub.add_parser("selftest"); common(sp)
    return ap


def main(argv=None):
    ap = build_parser()
    a = ap.parse_args(argv)
    if not a.op:
        ap.print_help()
        sys.exit(EXIT_USAGE)
    handlers = {
        "detect": lambda: print(json.dumps(detect(a.repo), ensure_ascii=False, indent=2)),
        "init": lambda: cmd_init(a), "add-task": lambda: cmd_add_task(a),
        "set-task": lambda: cmd_set_task(a), "next": lambda: cmd_next(a),
        "run": lambda: cmd_run(a), "render": lambda: cmd_render(a),
        "brief": lambda: cmd_brief(a), "status": lambda: cmd_status(a),
        "heartbeat": lambda: cmd_heartbeat(a), "sync-commit": lambda: cmd_sync_commit(a),
        "model-recommend": lambda: cmd_model_recommend(a),
        "hook-prebash": lambda: cmd_hook_prebash(a), "hook-postbash": lambda: cmd_hook_postbash(a),
        "hook-stop": lambda: cmd_hook_stop(a), "selftest": lambda: cmd_selftest(a),
    }
    handlers[a.op]()


if __name__ == "__main__":
    main()
