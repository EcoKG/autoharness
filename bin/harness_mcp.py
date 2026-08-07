#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoHarness MCP stdio 서버 — 개행 구분 JSON-RPC 2.0 (stdlib 만 사용).

DESIGN.md §6 이 계약의 정본이다.
- initialize / ping / tools/list / tools/call 만 처리, notification(id 없음)은 무응답.
- 미지 request 는 JSON-RPC error -32601.
- 도구는 14개. 성공은 {"content":[{"type":"text","text":<결과 JSON pretty>}]},
  실패는 여기에 "isError": true. 도구 핸들러의 어떤 예외도 서버를 죽이지 않는다.
- 엔진(bin/harness_engine.py)은 import 해서 in-process 로 호출한다.
  단 harness_run 만은 대상 저장소의 scripts/harness_engine.py 사본을 서브프로세스로
  실행해 실제 종료 코드(0/1/2/3/4)를 그대로 받는다.
"""

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

# 콘솔 cp949 방어 — 엔진과 동일 패턴 (stdin 은 MCP 프레임 수신용으로 추가)
for _s in (sys.stdout, sys.stderr, sys.stdin):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

BIN_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BIN_DIR)
import harness_engine as eng  # noqa: E402  (번들 엔진 — 계약의 실체)

SERVER_NAME = "autoharness"
SERVER_VERSION = "1.0.0"
PROTOCOL_DEFAULT = "2025-06-18"
TASK_NAME = "AutoHarnessWatchdog"

ENGINE_SRC = os.path.join(BIN_DIR, "harness_engine.py")
WATCHDOG_SRC = os.path.join(BIN_DIR, "harness_watchdog.py")
TEMPLATES_DIR = os.path.abspath(os.path.join(BIN_DIR, "..", "templates"))
RUNTIME_DIR = os.path.join(os.path.expanduser("~"), ".claude", "autoharness")
REGISTRY_PATH = os.path.join(RUNTIME_DIR, "registry.json")
WATCHDOG_LOG = os.path.join(RUNTIME_DIR, "logs", "watchdog.log")

STDOUT_CAP = 30000          # harness_run 응답에 담는 stdout 상한(문자)
STDERR_CAP = 4000

PERMISSION_ARGS = {
    "bypass": ["--dangerously-skip-permissions"],
    "acceptEdits": ["--permission-mode", "acceptEdits"],
}

# 템플릿이 없을 때 쓰는 내장 폴백 래퍼 (LF 로 기록해야 bash 가 먹는다)
FALLBACK_WRAPPER = """#!/usr/bin/env bash
# AutoHarness 진입 래퍼(내장 폴백) — 같은 폴더의 harness_engine.py run 으로 위임한다.
# 종료 코드 계약: 0=통과, 1=검증 실패, 2=사용법/설정 오류, 3=작업 없음, 4=한도 도달
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$SCRIPT_DIR/harness_engine.py"
if [ ! -f "$ENGINE" ]; then
    echo "[agent_harness] 엔진을 찾을 수 없습니다: $ENGINE" >&2
    exit 2
fi
PY="${AUTOHARNESS_PYTHON:-}"
if [ -z "$PY" ]; then
    if command -v python >/dev/null 2>&1; then PY=python
    elif command -v python3 >/dev/null 2>&1; then PY=python3
    else echo "[agent_harness] python 을 찾을 수 없습니다" >&2; exit 2; fi
fi
case "${1:-}" in
    detect|init|add-task|set-task|next|run|render|brief|status|heartbeat|sync-commit|model-recommend|selftest)
        exec "$PY" "$ENGINE" "$@" ;;
    *)
        exec "$PY" "$ENGINE" run "$@" ;;
esac
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def log(msg):
    """서버 진단 로그 — 프로토콜 채널(stdout)을 오염시키지 않도록 stderr 전용."""
    try:
        sys.stderr.write("[harness_mcp] %s\n" % msg)
        sys.stderr.flush()
    except Exception:
        pass


class ToolError(Exception):
    """도구 수준의 예상된 실패 — isError 응답으로 변환된다."""


# ---------------------------------------------------------------- 엔진 호출 헬퍼

def run_engine_argv(argv):
    """엔진 CLI 를 in-process 로 실행하고 (exit_code, stdout, stderr) 를 돌려준다.

    init/add-task/set-task/next/status/sync-commit/heartbeat 등이 이 경로를 쓴다.
    """
    buf_out, buf_err = io.StringIO(), io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            eng.main(list(argv))
    except SystemExit as e:
        if e.code is None:
            code = 0
        elif isinstance(e.code, int):
            code = e.code
        else:
            code = 1
    return code, buf_out.getvalue(), buf_err.getvalue()


def call_direct(fn, *args, **kwargs):
    """엔진 함수를 직접 호출한다. die()(SystemExit) 는 ToolError 로 승격."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stderr(buf):
            return fn(*args, **kwargs)
    except SystemExit as e:
        msg = buf.getvalue().strip()
        raise ToolError(msg or ("엔진 중단 (exit=%s)" % e.code))


def safe_json(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def require(args, key):
    v = args.get(key)
    if v is None or (isinstance(v, str) and not v.strip()):
        raise ToolError("필수 인자 누락: %s" % key)
    return v


def rel(path, base):
    try:
        return os.path.relpath(path, base).replace("\\", "/")
    except ValueError:
        return path


def write_text_lf(path, text):
    """bash 스크립트용 — Windows 에서도 LF 개행을 보장한다."""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# ---------------------------------------------------------------- 레지스트리 (§7)

def default_registry():
    return {
        "schema_version": 1,
        "settings": {"stale_minutes": 30, "probe_sec": 90, "max_consecutive_errors": 5,
                     "limit_backoff_minutes": [30, 60, 120, 240, 360],
                     "error_backoff_minutes": [15, 30, 60]},
        "projects": [],
    }


def registry_load():
    reg = eng.load_json(REGISTRY_PATH)
    if not isinstance(reg, dict):
        reg = default_registry()
    base = default_registry()
    reg.setdefault("schema_version", 1)
    if not isinstance(reg.get("settings"), dict):
        reg["settings"] = base["settings"]
    if not isinstance(reg.get("projects"), list):
        reg["projects"] = []
    return reg


def registry_save(reg):
    eng.atomic_write_json(REGISTRY_PATH, reg)


def registry_find(reg, repo):
    key = os.path.normcase(os.path.abspath(repo))
    for p in reg["projects"]:
        if os.path.normcase(os.path.abspath(p.get("repo") or "")) == key:
            return p
    return None


def registry_upsert(project_id, repo, model, permission_args):
    """harness_init 용 upsert — 재초기화 시 카운터·백오프를 리셋하고 active 로 되돌린다."""
    reg = registry_load()
    repo_abs = os.path.abspath(repo)
    entry = registry_find(reg, repo_abs)
    if entry is None:
        entry = {
            "id": project_id, "repo": repo_abs, "model": model,
            "permission_args": permission_args,
            "status": "active", "consecutive_errors": 0, "limit_hits": 0,
            "next_retry_at": None,
            "last_launch": {"ts": None, "result": None, "log": None},
            "created_at": now_iso(), "updated_at": now_iso(),
        }
        reg["projects"].append(entry)
    else:
        entry.update({"id": project_id, "repo": repo_abs, "model": model,
                      "permission_args": permission_args, "status": "active",
                      "consecutive_errors": 0, "limit_hits": 0, "next_retry_at": None,
                      "updated_at": now_iso()})
        entry.setdefault("last_launch", {"ts": None, "result": None, "log": None})
        entry.setdefault("created_at", now_iso())
    registry_save(reg)
    return entry


# ---------------------------------------------------------------- settings.json 병합

# 훅 인터프리터: Windows 는 python, Linux/WSL 은 python3 (python 별칭이 없는 배포판이 많다)
HOOK_PY = "python" if os.name == "nt" else "python3"

# 명령을 실행하는 도구 전부. matcher 가 "Bash" 뿐이면 다른 실행 도구로 게이트가 통째로
# 우회된다(실측: PowerShell 경로로 원격 반영·커밋 게이트가 무검사 통과). 훅 계약상
# matcher 는 `|` 로 구분한 정확 일치 목록을 받는다.
COMMAND_TOOL_MATCHER = "Bash|PowerShell"

HOOK_DEFS = [
    ("SessionStart", None, HOOK_PY + " scripts/harness_engine.py brief"),
    ("PreToolUse", COMMAND_TOOL_MATCHER, HOOK_PY + " scripts/harness_engine.py hook-prebash"),
    ("PostToolUse", COMMAND_TOOL_MATCHER, HOOK_PY + " scripts/harness_engine.py hook-postbash"),
    ("Stop", None, HOOK_PY + " scripts/harness_engine.py hook-stop"),
]

PERMISSION_ALLOW = [
    "Bash(bash scripts/agent_harness.sh:*)",
    "Bash(" + HOOK_PY + " scripts/harness_engine.py:*)",
]


def _is_harness_hook_item(item, op):
    """settings 의 훅 항목이 이 하네스의 <op> 훅인가 — 항목 단위 판정."""
    if not isinstance(item, dict):
        return False
    for h in item.get("hooks") or []:
        if not isinstance(h, dict):
            continue
        cmd = h.get("command")
        if isinstance(cmd, str) and "harness_engine" in cmd and op in cmd.split():
            return True
    return False


def merge_settings(repo):
    """<repo>/.claude/settings.json 에 훅 4종 + permissions.allow 2건을 추가 병합한다.

    기존 파일은 settings.json.bak-<UTCts> 로 백업. 이미 harness_engine.py 를 담은
    훅 항목이 있는 이벤트에는 추가하지 않는다(중복 방지).
    """
    claude_dir = os.path.join(repo, ".claude")
    os.makedirs(claude_dir, exist_ok=True)
    settings_path = os.path.join(claude_dir, "settings.json")

    backup_path = None
    settings = {}
    if os.path.exists(settings_path):
        backup_path = settings_path + ".bak-" + utc_stamp()
        shutil.copyfile(settings_path, backup_path)
        loaded = eng.load_json(settings_path)
        if isinstance(loaded, dict):
            settings = loaded
        else:
            log("기존 settings.json 이 유효한 JSON 객체가 아님 — 백업 후 새로 구성: " + settings_path)

    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks

    merged_events, skipped_events, migrated_events = [], [], []
    for event, matcher, command in HOOK_DEFS:
        op = command.split()[-1]
        entries = hooks.get(event)
        if not isinstance(entries, list):
            entries = []
            hooks[event] = entries
        # 항목 단위로 본다. 이벤트 전체를 json.dumps 해서 harness_engine 포함 여부만 보면
        # matcher 가 낡아도 '이미 있음'으로 건너뛰어, 기존 설치가 영영 갱신되지 않는다.
        existing = [e for e in entries if _is_harness_hook_item(e, op)]
        if existing:
            changed = False
            for item in existing:
                if matcher and item.get("matcher") != matcher:
                    item["matcher"] = matcher     # 커버리지 확대 마이그레이션
                    changed = True
            (migrated_events if changed else skipped_events).append(event)
            continue
        item = {"hooks": [{"type": "command", "command": command}]}
        if matcher:
            item = {"matcher": matcher, "hooks": [{"type": "command", "command": command}]}
        entries.append(item)
        merged_events.append(event)

    permissions = settings.get("permissions")
    if not isinstance(permissions, dict):
        permissions = {}
        settings["permissions"] = permissions
    allow = permissions.get("allow")
    if not isinstance(allow, list):
        allow = []
        permissions["allow"] = allow
    added_permissions = []
    for rule in PERMISSION_ALLOW:
        if rule not in allow:
            allow.append(rule)
            added_permissions.append(rule)

    eng.atomic_write_json(settings_path, settings)
    return {"path": settings_path, "backup": backup_path,
            "merged_hooks": merged_events, "skipped_hooks": skipped_events,
            "migrated_hooks": migrated_events, "matcher": COMMAND_TOOL_MATCHER,
            "added_permissions": added_permissions}


# ---------------------------------------------------------------- 도구 핸들러 14종

def tool_harness_detect(a):
    repo = os.path.abspath(require(a, "repo_path"))
    return call_direct(eng.detect, repo)


def tool_harness_init(a):
    repo = os.path.abspath(require(a, "repo_path"))
    if not os.path.isdir(repo):
        raise ToolError("저장소 경로가 없습니다: " + repo)
    project = str(require(a, "project"))
    objective = str(require(a, "objective"))
    source = str(require(a, "source_stack"))
    target = str(require(a, "target_stack"))
    test_cmd = str(require(a, "test_cmd"))
    perm_mode = a.get("permission_mode") or "bypass"
    if perm_mode not in PERMISSION_ARGS:
        raise ToolError('permission_mode 는 "bypass" 또는 "acceptEdits" 만 허용됩니다: %r' % perm_mode)

    # ① 엔진 init — 장부/예시/로그 디렉토리 생성
    argv = ["init", "--repo", repo, "--project", project, "--objective", objective,
            "--source", source, "--target", target, "--test", test_cmd]
    if a.get("build_cmd"):
        argv += ["--build", str(a["build_cmd"])]
    if a.get("lint_cmd"):
        argv += ["--lint", str(a["lint_cmd"])]
    if a.get("model"):
        argv += ["--model", str(a["model"])]
    if a.get("max_attempts") is not None:
        argv += ["--max-attempts", str(int(a["max_attempts"]))]
    code, out, err = run_engine_argv(argv)
    if code != 0:
        raise ToolError("엔진 init 실패 (exit %d): %s" % (code, (err or out).strip()))
    init_result = safe_json(out) or {"raw": out.strip()}

    created = [rel(eng.rp(repo)["tracker"], repo), rel(eng.rp(repo)["example"], repo),
               rel(eng.rp(repo)["logs"], repo) + "/"]

    # ② 자기 옆의 엔진을 저장소로 복사 (단독 동작 사본)
    if not os.path.exists(ENGINE_SRC):
        raise ToolError("번들 엔진을 찾을 수 없습니다: " + ENGINE_SRC)
    scripts_dir = os.path.join(repo, "scripts")
    os.makedirs(scripts_dir, exist_ok=True)
    engine_dst = os.path.join(scripts_dir, "harness_engine.py")
    shutil.copyfile(ENGINE_SRC, engine_dst)
    created.append(rel(engine_dst, repo))

    # ③ 진입 래퍼 설치 (템플릿 우선, 없으면 내장 폴백)
    wrapper_dst = os.path.join(scripts_dir, "agent_harness.sh")
    wrapper_tmpl = os.path.join(TEMPLATES_DIR, "agent_harness.sh")
    if os.path.exists(wrapper_tmpl):
        shutil.copyfile(wrapper_tmpl, wrapper_dst)
        wrapper_source = wrapper_tmpl
    else:
        write_text_lf(wrapper_dst, FALLBACK_WRAPPER)
        wrapper_source = "(내장 폴백 문자열)"
    created.append(rel(wrapper_dst, repo))

    # ④ .claude/settings.json 병합 (훅 4종 + permissions.allow 2건, 백업 포함)
    settings_summary = merge_settings(repo)

    # ⑤ 레지스트리 upsert
    tracker = eng.load_json(eng.rp(repo)["tracker"]) or {}
    model = tracker.get("model") or eng.MODEL_OPUS
    entry = registry_upsert(project, repo, model, PERMISSION_ARGS[perm_mode])

    # ⑥ 수행 내역 요약
    return {
        "ok": True,
        "repo": repo,
        "engine_init": init_result,
        "created": created,
        "wrapper_source": wrapper_source,
        "settings": settings_summary,
        "registry": {"path": REGISTRY_PATH, "project": entry},
        "next_step": "task_add 로 작업을 적재한 뒤 bash scripts/agent_harness.sh --task <id> 로 검증하십시오.",
    }


def tool_harness_status(a):
    repo = os.path.abspath(require(a, "repo_path"))
    code, out, err = run_engine_argv(["status", "--repo", repo])
    if code != 0:
        raise ToolError("status 실패 (exit %d): %s" % (code, (err or out).strip()))
    status = safe_json(out) or {"raw": out.strip()}
    reg = registry_load()
    status["registry"] = registry_find(reg, repo)
    status["tracker_path"] = eng.rp(repo)["tracker"]
    return status


def tool_harness_run(a):
    """대상 저장소의 엔진 사본을 서브프로세스로 실행 — 실제 종료 코드를 그대로 받는다."""
    repo = os.path.abspath(require(a, "repo_path"))
    if not os.path.isdir(repo):
        raise ToolError("저장소 경로가 없습니다: " + repo)
    engine_copy = os.path.join(repo, "scripts", "harness_engine.py")
    engine_path = engine_copy if os.path.exists(engine_copy) else ENGINE_SRC  # 사본 없으면 번들 폴백
    tracker = eng.load_json(eng.rp(repo)["tracker"]) or {}
    timeout = int((tracker.get("commands") or {}).get("timeout_sec") or 1800) + 120  # 여유 120초

    cmdline = [sys.executable, engine_path, "run", "--repo", repo]
    task_id = a.get("task_id")
    if task_id:
        cmdline += ["--task", str(task_id)]
    if a.get("cmd"):
        cmdline += ["--cmd", str(a["cmd"])]
    try:
        r = subprocess.run(cmdline, cwd=repo, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ToolError("run 이 %d초 제한(timeout_sec+120)을 초과했습니다" % timeout)
    except OSError as e:
        raise ToolError("엔진 서브프로세스 실행 실패: %s" % e)

    stdout = r.stdout or ""
    m = re.search(r"task=(\S+)", stdout)
    found_id = str(task_id) if task_id else (m.group(1) if m else None)
    updated = eng.load_json(eng.rp(repo)["tracker"]) or {}
    task = eng.find_task(updated, found_id) if (found_id and isinstance(updated.get("tasks"), list)) else None
    summary = ""
    for ln in stdout.splitlines():
        if ln.startswith("HARNESS RESULT"):
            summary = ln
            break
    if not summary:
        tail = [ln for ln in stdout.splitlines() if ln.strip()]
        summary = tail[-1] if tail else (r.stderr or "").strip()[:400]

    return {"exit_code": r.returncode, "engine": engine_path, "summary": summary,
            "stdout": stdout[-STDOUT_CAP:], "stderr": (r.stderr or "")[-STDERR_CAP:],
            "task": task}


def registry_reactivate_if_completed(repo):
    """completed 프로젝트에 새 작업이 들어오면 다시 워치독 기동 대상(active)으로 되돌린다.

    completed 만 대상이다 — paused(사용자 의사)·needs_human(사람 판단 대기)·
    error(진단 필요)는 새 작업 추가만으로 자동 재개하지 않는다.
    되돌릴 때는 백오프 카운터(consecutive_errors·limit_hits·next_retry_at)도 리셋한다.
    """
    reg = registry_load()
    entry = registry_find(reg, repo)
    if entry is None or entry.get("status") != "completed":
        return None
    entry.update({"status": "active", "consecutive_errors": 0, "limit_hits": 0,
                  "next_retry_at": None, "updated_at": now_iso()})
    registry_save(reg)
    return entry


def tool_task_add(a):
    repo = os.path.abspath(require(a, "repo_path"))
    deps = a.get("deps")
    if isinstance(deps, list):
        deps = ",".join(str(d) for d in deps)
    argv = ["add-task", "--repo", repo, "--id", str(require(a, "id")),
            "--title", str(require(a, "title"))]
    if a.get("path"):
        argv += ["--path", str(a["path"])]
    if deps:
        argv += ["--deps", str(deps)]
    if a.get("priority") is not None:
        argv += ["--priority", str(int(a["priority"]))]
    if a.get("test_cmd"):
        argv += ["--test-cmd", str(a["test_cmd"])]
    code, out, err = run_engine_argv(argv)
    if code != 0:
        raise ToolError("add-task 실패 (exit %d): %s" % (code, (err or out).strip()))
    result = safe_json(out) or {"ok": True, "raw": out.strip()}
    # 주행 완료(completed) 후의 작업 추가 — 워치독이 다시 집게 재활성화한다
    reactivated = registry_reactivate_if_completed(repo)
    if reactivated is not None:
        result["registry_reactivated"] = True
    return result


def tool_task_set(a):
    repo = os.path.abspath(require(a, "repo_path"))
    argv = ["set-task", "--repo", repo, "--id", str(require(a, "id"))]
    if a.get("status"):
        argv += ["--status", str(a["status"])]   # 엔진이 pending/blocked 만 허용
    if a.get("note"):
        argv += ["--note", str(a["note"])]
    if a.get("test_cmd") is not None:
        argv += ["--test-cmd", str(a["test_cmd"])]  # 빈 문자열이면 해제(전역 test 복귀)
    code, out, err = run_engine_argv(argv)
    if code != 0:
        raise ToolError("set-task 실패 (exit %d): %s" % (code, (err or out).strip()))
    return safe_json(out) or {"ok": True, "raw": out.strip()}


def tool_harness_pause(a):
    repo = os.path.abspath(require(a, "repo_path"))
    if not os.path.isdir(repo):
        raise ToolError("저장소 경로가 없습니다: " + repo)
    flag = eng.rp(repo)["paused_flag"]
    write_text_lf(flag, "paused at %s\n" % now_iso())
    reg = registry_load()
    entry = registry_find(reg, repo)
    if entry is not None:
        entry["status"] = "paused"
        entry["updated_at"] = now_iso()
        registry_save(reg)
    return {"ok": True, "flag": flag,
            "registry": entry if entry is not None else "레지스트리에 등록되지 않은 프로젝트입니다"}


def tool_harness_resume_project(a):
    repo = os.path.abspath(require(a, "repo_path"))
    flag = eng.rp(repo)["paused_flag"]
    removed = False
    if os.path.exists(flag):
        try:
            os.remove(flag)
            removed = True
        except OSError as e:
            raise ToolError("PAUSED 플래그 제거 실패: %s" % e)
    reg = registry_load()
    entry = registry_find(reg, repo)
    if entry is not None:
        entry.update({"status": "active", "consecutive_errors": 0, "limit_hits": 0,
                      "next_retry_at": None, "updated_at": now_iso()})
        registry_save(reg)
    return {"ok": True, "flag_removed": removed,
            "registry": entry if entry is not None else "레지스트리에 등록되지 않은 프로젝트입니다"}


def tool_model_recommend(a):
    repo = a.get("repo_path")
    if repo:
        repo = os.path.abspath(repo)
    return call_direct(eng.model_recommend, repo, a.get("source_stack"),
                       a.get("target_stack"), a.get("notes"))


def tool_model_set(a):
    repo = os.path.abspath(require(a, "repo_path"))
    model = str(require(a, "model"))
    if model not in eng.ALLOWED_MODELS:
        raise ToolError("model 은 %s 중 하나여야 합니다: %r" % (list(eng.ALLOWED_MODELS), model))
    updated = {"tracker": False, "registry": False}
    tracker = eng.load_json(eng.rp(repo)["tracker"])
    if isinstance(tracker, dict):
        tracker["model"] = model
        eng.save_tracker(repo, tracker)
        eng.render(repo)
        updated["tracker"] = True
    reg = registry_load()
    entry = registry_find(reg, repo)
    if entry is not None:
        entry["model"] = model
        entry["updated_at"] = now_iso()
        registry_save(reg)
        updated["registry"] = True
    if not (updated["tracker"] or updated["registry"]):
        raise ToolError("장부도 레지스트리 항목도 없습니다 — 먼저 harness_init 을 실행하십시오: " + repo)
    return {"ok": True, "model": model, "updated": updated}


def tool_heartbeat(a):
    repo = os.path.abspath(require(a, "repo_path"))
    code, out, err = run_engine_argv(["heartbeat", "--repo", repo])
    if code != 0:
        raise ToolError("heartbeat 실패 (exit %d): %s" % (code, (err or out).strip()))
    return {"ok": True, "heartbeat": eng.load_json(eng.rp(repo)["heartbeat"])}


def _schtasks(*args):
    try:
        r = subprocess.run(["schtasks"] + list(args), capture_output=True,
                           text=True, errors="replace", timeout=60)
    except FileNotFoundError:
        raise ToolError("schtasks 를 찾을 수 없습니다 — 이 도구는 Windows 작업 스케줄러 전용입니다. "
                        "WSL/Linux 에서는 `bash install.sh --watchdog` 로 cron 등록을 사용하십시오.")
    except subprocess.TimeoutExpired:
        raise ToolError("schtasks 가 60초 안에 응답하지 않았습니다")
    return {"exit_code": r.returncode, "stdout": (r.stdout or "").strip(),
            "stderr": (r.stderr or "").strip()}


def tool_watchdog_install(a):
    interval = int(a.get("interval_minutes") or 15)
    if interval < 1 or interval > 1439:
        raise ToolError("interval_minutes 는 1~1439 사이여야 합니다: %d" % interval)
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    runner = pythonw if os.path.exists(pythonw) else sys.executable  # 콘솔 창 방지 우선
    tr = '"%s" "%s"' % (runner, WATCHDOG_SRC)
    create = _schtasks("/Create", "/TN", TASK_NAME, "/SC", "MINUTE",
                       "/MO", str(interval), "/F", "/TR", tr)
    query = _schtasks("/Query", "/TN", TASK_NAME)
    if create["exit_code"] == 0:
        # 설치 시각 기록 — watchdog_status 가 '설치 직후 아직 주기 미도래'를 경고에서
        # 제외하는 유예 판정의 기준이다(오탐 금지).
        reg = registry_load()
        reg["settings"]["watchdog_installed_at"] = now_iso()
        reg["settings"]["watchdog_interval_minutes"] = interval
        registry_save(reg)
    note = None
    if not os.path.exists(WATCHDOG_SRC):
        note = "harness_watchdog.py 가 아직 없습니다: %s — 파일이 생기면 다음 주기부터 동작합니다" % WATCHDOG_SRC
    return {"ok": create["exit_code"] == 0 and query["exit_code"] == 0,
            "task_name": TASK_NAME, "interval_minutes": interval,
            "runner": runner, "script": WATCHDOG_SRC,
            "create": create, "query": query, "note": note}


def tool_watchdog_uninstall(a):
    delete = _schtasks("/Delete", "/TN", TASK_NAME, "/F")
    return {"ok": delete["exit_code"] == 0, "task_name": TASK_NAME, "delete": delete}


# ------------------------------------------------- 워치독 '등록만 되고 실행 안 됨' 감지
#
# 스케줄러에 Ready 로 등록돼 있어도 매 기동이 반려되면(0x800710E0 등) 자동 부활 보장은
# 무효인데, 등록 여부만 보고하면 정상처럼 보인다. 그래서 '등록'과 '실제 실행 이력'을
# 분리해 보고하고, 마지막 실행 결과 코드를 해석해 함께 내놓는다.

STALE_INTERVAL_MULTIPLIER = 3     # 기대 주기의 몇 배까지를 정상으로 볼지 (경고·유예 공통)
DEFAULT_INTERVAL_MINUTES = 15
SCHED_NEVER_RUN = 0x41303         # 스케줄러가 보고하는 '작업이 한 번도 실행된 적 없음'

# 흔한 작업 스케줄러 결과 코드 — 0 이 아니어도 실패가 아닌 정보성 값이 있다
SCHED_RESULT_MEANINGS = {
    0x0: ("정상 종료", True),
    0x1: ("일반 오류(잘못된 함수) — 실행 대상이 즉시 실패했을 수 있음", False),
    0x41300: ("작업 준비됨 — 아직 실행 전", True),
    0x41301: ("작업이 현재 실행 중", True),
    0x41302: ("작업이 비활성 상태", False),
    0x41303: ("작업이 한 번도 실행된 적 없음", True),
    0x41304: ("예약된 실행 시간이 남아 있지 않음", False),
    0x41306: ("사용자/시스템이 작업을 종료함", False),
    0x8004131F: ("이미 실행 중인 인스턴스가 있어 새 인스턴스가 거부됨(MultipleInstancesPolicy)", False),
    0x80070002: ("지정된 파일을 찾을 수 없음 — 실행 대상 경로 확인 필요", False),
    0x800710E0: ("운영자 또는 관리자가 요청을 거부함 — 전원·인스턴스 정책 등 실행 조건에 막혀 "
                 "기동되지 않음", False),
}

# schtasks /V /FO LIST 필드 라벨. schtasks 는 콘솔 UI 언어로 출력을 지역화하므로 영문만
# 보면 한국어 Windows 에서 파싱이 통째로 실패한다 — 실측으로 확인된 결함이라 로케일별
# 라벨을 모두 등록한다. 그래도 못 읽으면 필드는 null 로 두고 경고하지 않는다(오탐 금지).
_SCHED_FIELDS = {
    "status": ("Status", "상태"),
    "last_run_time": ("Last Run Time", "마지막 실행 시간"),
    "last_result": ("Last Result", "마지막 결과"),
    "next_run_time": ("Next Run Time", "다음 실행 시간"),
    "state": ("Scheduled Task State", "예약된 작업 상태"),
}


def _parse_schtasks_list(stdout):
    """`Field: value` 라인을 dict 로. 같은 이름이 여러 번 나오면 첫 값을 쓴다."""
    fields = {}
    for line in (stdout or "").splitlines():
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        name, value = name.strip(), value.strip()
        if name and name not in fields:
            fields[name] = value
    out = {}
    for key, labels in _SCHED_FIELDS.items():
        out[key] = next((fields[l] for l in labels if fields.get(l)), None)
    return out


def _as_unsigned32(n):
    return n + 0x100000000 if n < 0 else n


def interpret_sched_result(raw):
    """LastTaskResult 해석 — (코드, 16진 표기, 뜻, 정상 여부). 파싱 불가면 None."""
    if raw is None or str(raw).strip() == "":
        return None
    try:
        text = str(raw).strip()
        code = int(text, 16) if text.lower().startswith("0x") else int(text)
    except ValueError:
        return None
    code = _as_unsigned32(code)
    meaning, benign = SCHED_RESULT_MEANINGS.get(code, ("알려지지 않은 결과 코드", False))
    return {"code": code, "hex": "0x%X" % code, "meaning": meaning, "benign": benign}


_ISO_DURATION_RE = re.compile(r"P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?", re.IGNORECASE)


def parse_iso_duration_minutes(text):
    m = _ISO_DURATION_RE.search(text or "")
    if not m:
        return None
    days, hours, minutes = (int(g or 0) for g in m.groups())
    total = days * 1440 + hours * 60 + minutes
    return total or None


def scheduler_interval_minutes():
    """등록된 반복 주기(분). XML 조회 실패 시 None."""
    try:
        xml = _schtasks("/Query", "/TN", TASK_NAME, "/XML")
    except ToolError:
        return None
    if xml["exit_code"] != 0:
        return None
    m = re.search(r"<Interval>([^<]+)</Interval>", xml["stdout"] or "")
    return parse_iso_duration_minutes(m.group(1)) if m else None


def _log_age_minutes(path):
    """watchdog.log 의 마지막 기록으로부터 경과 분. 파일이 없으면 None."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    return max(0.0, (time.time() - mtime) / 60.0)


def _minutes_since_iso(ts):
    parsed = parse_iso_ts(ts)
    if parsed is None:
        return None
    delta = datetime.now(timezone.utc) - parsed
    return max(0.0, delta.total_seconds() / 60.0)


def parse_iso_ts(ts):
    if not ts:
        return None
    try:
        parsed = datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def watchdog_health(query, reg, log_path, interval_minutes=None, now_minutes_since=None):
    """등록 여부와 '실제 실행 이력'을 분리 판정한다 — 경고 전용, 아무것도 막지 않는다.

    state: not_registered / grace(설치 직후 아직 주기 미도래) / stale(경고) / healthy
    """
    registered = query.get("exit_code") == 0
    fields = _parse_schtasks_list(query.get("stdout")) if registered else {}
    result = interpret_sched_result(fields.get("last_result"))
    interval = interval_minutes or DEFAULT_INTERVAL_MINUTES
    threshold = interval * STALE_INTERVAL_MULTIPLIER

    age = _log_age_minutes(log_path)
    settings = reg.get("settings") or {}
    since_install = (now_minutes_since or _minutes_since_iso)(settings.get("watchdog_installed_at"))
    last_tick = reg.get("last_tick")
    since_tick = (now_minutes_since or _minutes_since_iso)(last_tick)

    projects = reg.get("projects") or []
    never_launched = [p.get("id") for p in projects if not (p.get("last_launch") or {}).get("ts")]

    # 스케줄러가 직접 알려주는 '아직 한 번도 실행 안 됨' — 설치 스탬프가 없는 환경
    # (install.ps1 -Watchdog / install.sh --watchdog 로 등록했거나 구버전 설치본)의
    # 유예 근거로 쓴다. 스탬프에만 의존하면 그 경로 사용자가 전부 오탐을 맞는다.
    never_ran_per_scheduler = bool(result and result["code"] == SCHED_NEVER_RUN)

    warnings = []
    if not registered:
        state = "not_registered"
    elif since_install is not None and since_install < threshold:
        # 설치 직후 아직 주기가 안 온 경우 — 경고 대상 아님(오탐 금지)
        state = "grace"
    elif since_install is None and never_ran_per_scheduler and age is None and since_tick is None:
        # 설치 시각을 모르지만 스케줄러가 '미실행'을 보고 — 첫 주기 전으로 본다.
        # 이 유예는 영구화될 수 있으나(트리거 오설정 등) 그 경우 결과 코드가 미실행이
        # 아닌 실패 코드로 바뀌므로 아래 결과 코드 경고가 결함을 잡는다.
        state = "grace"
    elif age is None and since_tick is None:
        state = "stale"
        warnings.append(
            "워치독이 등록돼 있으나 실행 흔적이 전혀 없습니다(로그 파일 부재: %s). "
            "스케줄러가 매 기동을 반려하면 등록 상태는 Ready 로 남아 정상처럼 보입니다 — "
            "자동 부활 보장이 무효인 상태입니다." % log_path)
    elif age is not None and age >= threshold:
        state = "stale"
        warnings.append(
            "워치독 마지막 실행이 %.0f분 전입니다 — 기대 주기 %d분의 %d배(%d분)를 넘겼습니다. "
            "스케줄러가 기동을 반려하고 있는지 확인하십시오."
            % (age, interval, STALE_INTERVAL_MULTIPLIER, threshold))
    else:
        state = "healthy"

    if result and not result["benign"]:
        warnings.append("스케줄러 마지막 실행 결과가 %s 입니다 — %s"
                        % (result["hex"], result["meaning"]))

    # 보조 신호: 전 프로젝트 last_launch 가 null. 단, skip/completed 주기에는 last_launch 가
    # 갱신되지 않으므로 이것만으로는 '워치독 미실행'의 근거가 못 된다 — last_tick 과 함께 본다.
    never_launched_signal = None
    if projects and len(never_launched) == len(projects):
        never_launched_signal = {
            "projects": never_launched,
            "note": ("등록된 %d개 프로젝트 전부 last_launch 가 비어 있습니다(헤드리스 세션이 "
                     "한 번도 기동되지 않음). 워치독 주기 자체는 %s"
                     % (len(projects),
                        ("돌고 있습니다(last_tick=%s) — 기동 조건이 매번 스킵된 것입니다."
                         % last_tick) if last_tick else
                        "돈 기록이 없습니다(last_tick 없음) — 워치독 미실행이 의심됩니다.")),
        }

    return {"state": state, "registered": registered, "warnings": warnings,
            "scheduler_fields": fields, "last_result": result,
            "interval_minutes": interval,
            "interval_source": "scheduler" if interval_minutes else "default",
            "stale_threshold_minutes": threshold,
            "log_age_minutes": None if age is None else round(age, 1),
            "minutes_since_install": None if since_install is None else round(since_install, 1),
            "last_tick": last_tick,
            "minutes_since_tick": None if since_tick is None else round(since_tick, 1),
            "never_launched": never_launched_signal}


def tool_watchdog_status(a):
    query = _schtasks("/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST")
    reg = registry_load()
    projects = [{"id": p.get("id"), "repo": p.get("repo"), "status": p.get("status"),
                 "model": p.get("model"), "consecutive_errors": p.get("consecutive_errors"),
                 "limit_hits": p.get("limit_hits"), "next_retry_at": p.get("next_retry_at"),
                 "last_launch": p.get("last_launch")} for p in reg["projects"]]
    log_tail = []
    try:
        with open(WATCHDOG_LOG, "r", encoding="utf-8", errors="replace") as f:
            log_tail = f.read().splitlines()[-20:]
    except OSError:
        pass
    health = watchdog_health(query, reg, WATCHDOG_LOG,
                             interval_minutes=scheduler_interval_minutes() if query["exit_code"] == 0
                             else None)
    return {"task_name": TASK_NAME, "scheduler": query, "health": health,
            "registry": {"path": REGISTRY_PATH, "settings": reg.get("settings"),
                         "last_tick": reg.get("last_tick"), "projects": projects},
            "watchdog_log": {"path": WATCHDOG_LOG, "tail": log_tail}}


HANDLERS = {
    "harness_detect": tool_harness_detect,
    "harness_init": tool_harness_init,
    "harness_status": tool_harness_status,
    "harness_run": tool_harness_run,
    "task_add": tool_task_add,
    "task_set": tool_task_set,
    "harness_pause": tool_harness_pause,
    "harness_resume_project": tool_harness_resume_project,
    "model_recommend": tool_model_recommend,
    "model_set": tool_model_set,
    "heartbeat": tool_heartbeat,
    "watchdog_install": tool_watchdog_install,
    "watchdog_uninstall": tool_watchdog_uninstall,
    "watchdog_status": tool_watchdog_status,
}


# ---------------------------------------------------------------- tools/list 정의

def _obj(props, required):
    return {"type": "object", "properties": props, "required": required}


_REPO = {"type": "string", "description": "대상 저장소 절대 경로"}

TOOLS = [
    {"name": "harness_detect",
     "description": "저장소 스택 실측 — 빌드 도구/멀티모듈/테스트 디렉토리/린트 설정/git 상태와 제안 명령을 반환합니다.",
     "inputSchema": _obj({"repo_path": _REPO}, ["repo_path"])},
    {"name": "harness_init",
     "description": "하네스 초기화 — 장부/예시/로그 생성, 엔진 사본·래퍼 설치, .claude/settings.json 훅·권한 병합(백업 포함), 레지스트리 등록까지 일괄 수행합니다.",
     "inputSchema": _obj({
         "repo_path": _REPO,
         "project": {"type": "string", "description": "프로젝트 이름(레지스트리 id)"},
         "objective": {"type": "string", "description": "이번 작업의 목적"},
         "source_stack": {"type": "string", "description": "원본 스택 (예: Java 8 + Spring)"},
         "target_stack": {"type": "string", "description": "목표 스택 (예: Kotlin + Spring Boot 3)"},
         "test_cmd": {"type": "string", "description": "검증 테스트 명령 ({path} 치환 가능)"},
         "build_cmd": {"type": "string", "description": "빌드 명령(선택)"},
         "lint_cmd": {"type": "string", "description": "린트 명령(선택)"},
         "model": {"type": "string", "enum": [eng.MODEL_OPUS, eng.MODEL_FABLE],
                   "description": "주행 모델(선택, 기본 claude-opus-5)"},
         "max_attempts": {"type": "integer", "description": "작업당 시도 한도(기본 5)"},
         "permission_mode": {"type": "string", "enum": ["bypass", "acceptEdits"],
                             "description": "워치독 재기동 권한 모드(기본 bypass)"},
     }, ["repo_path", "project", "objective", "source_stack", "target_stack", "test_cmd"])},
    {"name": "harness_status",
     "description": "장부·하트비트·레지스트리 요약 — 진행 현황과 다음 작업을 반환합니다.",
     "inputSchema": _obj({"repo_path": _REPO}, ["repo_path"])},
    {"name": "harness_run",
     "description": "러너 실행 — 저장소의 scripts/harness_engine.py 사본을 서브프로세스로 실행해 build→test→lint 를 돌리고 실제 종료 코드(0/1/2/3/4)와 갱신된 작업을 반환합니다.",
     "inputSchema": _obj({
         "repo_path": _REPO,
         "task_id": {"type": "string", "description": "실행할 작업 id(생략 시 next 선택 규칙)"},
         "cmd": {"type": "string", "description": "표준 스테이지 대신 실행할 단일 명령(선택)"},
     }, ["repo_path"])},
    {"name": "task_add",
     "description": "장부에 작업 추가 — 의존성(deps)은 이미 존재하는 작업 id 여야 합니다.",
     "inputSchema": _obj({
         "repo_path": _REPO,
         "id": {"type": "string", "description": "작업 id"},
         "title": {"type": "string", "description": "작업 제목"},
         "path": {"type": "string", "description": "모듈/디렉토리 상대 경로 — 명령의 {path} 치환에 사용(선택)"},
         "deps": {"type": "array", "items": {"type": "string"},
                  "description": "선행 작업 id 목록(선택)"},
         "priority": {"type": "integer", "description": "우선순위 — 낮을수록 먼저(기본 100)"},
         "test_cmd": {"type": "string",
                      "description": "이 작업 전용 test 명령 — 전역 commands.test 대신 실행, {path} 치환 지원(선택)"},
     }, ["repo_path", "id", "title"])},
    {"name": "task_set",
     "description": "작업 상태의 제한적 조작 — pending/blocked 만 허용됩니다(done 은 harness_run 성공으로만 기록).",
     "inputSchema": _obj({
         "repo_path": _REPO,
         "id": {"type": "string", "description": "작업 id"},
         "status": {"type": "string", "enum": ["pending", "blocked"],
                    "description": "설정할 상태(선택)"},
         "note": {"type": "string", "description": "last_error 로 기록할 메모(선택)"},
         "test_cmd": {"type": "string",
                      "description": "작업 전용 test 명령 설정 — 빈 문자열이면 해제(전역 test 복귀, 선택)"},
     }, ["repo_path", "id"])},
    {"name": "harness_pause",
     "description": "자율 주행 일시정지 — .claude/HARNESS_PAUSED 플래그 생성 + 레지스트리 status=paused.",
     "inputSchema": _obj({"repo_path": _REPO}, ["repo_path"])},
    {"name": "harness_resume_project",
     "description": "자율 주행 재개 — PAUSED 플래그 제거 + 레지스트리 status=active + 백오프 카운터 리셋.",
     "inputSchema": _obj({"repo_path": _REPO}, ["repo_path"])},
    {"name": "model_recommend",
     "description": "모델 추천 휴리스틱 — 점수·근거·비교를 반환합니다. 결정은 사용자가 내립니다(decision=user).",
     "inputSchema": _obj({
         "repo_path": {"type": "string", "description": "실측에 쓸 저장소 경로(선택)"},
         "source_stack": {"type": "string", "description": "원본 스택(선택)"},
         "target_stack": {"type": "string", "description": "목표 스택(선택)"},
         "notes": {"type": "string", "description": "요구 모호성/특이사항 메모(선택, 있으면 +2점)"},
     }, [])},
    {"name": "model_set",
     "description": "주행 모델 갱신 — 장부와 레지스트리 양쪽에 기록합니다. 두 값만 허용됩니다.",
     "inputSchema": _obj({
         "repo_path": _REPO,
         "model": {"type": "string", "enum": [eng.MODEL_OPUS, eng.MODEL_FABLE],
                   "description": "설정할 모델"},
     }, ["repo_path", "model"])},
    {"name": "heartbeat",
     "description": "하트비트 갱신 — 워치독의 이중 기동 방지 신호(.claude/harness-heartbeat.json).",
     "inputSchema": _obj({"repo_path": _REPO}, ["repo_path"])},
    {"name": "watchdog_install",
     "description": "워치독 설치 — Windows 작업 스케줄러에 AutoHarnessWatchdog 사용자 작업을 등록합니다(/F 갱신).",
     "inputSchema": _obj({
         "interval_minutes": {"type": "integer", "description": "실행 간격(분, 기본 15)"},
     }, [])},
    {"name": "watchdog_uninstall",
     "description": "워치독 제거 — 스케줄러에서 AutoHarnessWatchdog 작업을 삭제합니다.",
     "inputSchema": _obj({}, [])},
    {"name": "watchdog_status",
     "description": "워치독 상태 — 스케줄러 상세 조회 + 레지스트리 요약 + watchdog.log 마지막 20줄. "
                    "등록 여부와 '실제 실행 이력'을 분리한 health 진단(마지막 결과 코드 해석, "
                    "실행 흔적 경과, 한 번도 기동되지 않은 프로젝트 신호)을 함께 돌려줍니다.",
     "inputSchema": _obj({}, [])},
]

assert len(TOOLS) == 14 and set(t["name"] for t in TOOLS) == set(HANDLERS), "도구 정의/핸들러 불일치"


# ---------------------------------------------------------------- JSON-RPC 처리

def send(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        # 클라이언트가 끊김 — 조용히 종료
        sys.exit(0)


def rpc_result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def rpc_error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def err_content(message):
    return {"content": [{"type": "text", "text": message}], "isError": True}


def tool_call_result(msg_id, name, arguments):
    """도구 디스패치 — 어떤 예외도 서버를 죽이지 않고 isError 응답으로 변환한다."""
    handler = HANDLERS.get(name)
    if handler is None:
        return rpc_result(msg_id, err_content("알 수 없는 도구입니다: %r" % name))
    try:
        result = handler(arguments if isinstance(arguments, dict) else {})
        text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
        return rpc_result(msg_id, {"content": [{"type": "text", "text": text}]})
    except ToolError as e:
        return rpc_result(msg_id, err_content(str(e)))
    except SystemExit as e:
        return rpc_result(msg_id, err_content("엔진이 예기치 않게 중단되었습니다 (exit=%s)" % e.code))
    except Exception as e:
        log("도구 실행 중 예외:\n" + traceback.format_exc())  # 전체 트레이스백은 stderr 로만
        return rpc_result(msg_id, err_content("도구 실행 중 예외: %s: %s" % (type(e).__name__, e)))


def handle_message(msg):
    """요청 1건을 처리하고 응답 객체(또는 무응답 None)를 돌려준다."""
    if not isinstance(msg, dict):
        log("객체가 아닌 메시지 무시: %s" % type(msg).__name__)
        return None
    method = msg.get("method")
    if method is None:
        return None  # 클라이언트 측 응답 등 — 무시
    if "id" not in msg or msg.get("id") is None:
        return None  # notification — 무응답
    msg_id = msg["id"]
    params = msg.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    if method == "initialize":
        return rpc_result(msg_id, {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL_DEFAULT,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method == "ping":
        return rpc_result(msg_id, {})
    if method == "tools/list":
        return rpc_result(msg_id, {"tools": TOOLS})
    if method == "tools/call":
        return tool_call_result(msg_id, params.get("name"), params.get("arguments") or {})
    return rpc_error(msg_id, -32601, "Method not found: %s" % method)


def serve():
    log("AutoHarness MCP 서버 시작 (pid=%d, engine=%s)" % (os.getpid(), ENGINE_SRC))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as e:
            log("JSON 파싱 실패 — 해당 줄 무시: %s" % e)
            continue
        try:
            resp = handle_message(msg)
        except Exception:
            log("메시지 처리 중 내부 예외:\n" + traceback.format_exc())
            mid = msg.get("id") if isinstance(msg, dict) else None
            resp = rpc_error(mid, -32603, "internal error") if mid is not None else None
        if resp is not None:
            send(resp)
    log("stdin 종료 — 서버를 내립니다")


def cli_finish_init(argv):
    """CLI 모드: 권한 분류기(auto mode)가 harness_init 을 차단한 환경에서, 사용자가 터미널에서
    직접 실행해 남은 설치 절차를 마무리한다 — 엔진·래퍼 사본 보완 + settings.json 훅 병합 +
    레지스트리 등록. (엔진 init 으로 장부가 이미 만들어져 있어야 한다.)

    사용: python3 harness_mcp.py finish-init [--repo .] [--project N]
          [--permission-mode bypass|acceptEdits] [--model claude-...-5]
    """
    import argparse
    ap = argparse.ArgumentParser(prog="harness_mcp.py finish-init")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--project", default=None)
    ap.add_argument("--permission-mode", dest="permission_mode",
                    choices=sorted(PERMISSION_ARGS.keys()), default="bypass")
    ap.add_argument("--model", default=None)
    a = ap.parse_args(argv)

    repo = os.path.abspath(a.repo)
    tracker = eng.load_json(eng.rp(repo)["tracker"])
    if not isinstance(tracker, dict):
        sys.stderr.write("[finish-init] 장부가 없습니다: %s\n"
                         "먼저 엔진 init 을 실행하십시오: python3 scripts/harness_engine.py init ... "
                         "(또는 스킬 폴더의 bin/harness_engine.py)\n" % eng.rp(repo)["tracker"])
        sys.exit(2)

    model = a.model or tracker.get("model") or eng.MODEL_OPUS
    if model not in eng.ALLOWED_MODELS:
        sys.stderr.write("[finish-init] model 은 %s 중 하나여야 합니다\n" % (eng.ALLOWED_MODELS,))
        sys.exit(2)
    project = a.project or tracker.get("project") or os.path.basename(repo)

    done = {"repo": repo, "project": project, "model": model}

    # ① 엔진·래퍼 사본 보완 (이미 있으면 최신으로 덮어씀 — 단독 동작 사본)
    scripts_dir = os.path.join(repo, "scripts")
    os.makedirs(scripts_dir, exist_ok=True)
    engine_dst = os.path.join(scripts_dir, "harness_engine.py")
    shutil.copyfile(ENGINE_SRC, engine_dst)
    wrapper_dst = os.path.join(scripts_dir, "agent_harness.sh")
    wrapper_tmpl = os.path.join(TEMPLATES_DIR, "agent_harness.sh")
    if os.path.exists(wrapper_tmpl):
        shutil.copyfile(wrapper_tmpl, wrapper_dst)
    else:
        write_text_lf(wrapper_dst, FALLBACK_WRAPPER)
    try:
        os.chmod(wrapper_dst, 0o755)
    except OSError:
        pass
    done["scripts"] = [rel(engine_dst, repo), rel(wrapper_dst, repo)]

    # ② settings.json 훅 4종 + permissions.allow 병합 (원본은 .bak-<ts> 백업)
    done["settings"] = merge_settings(repo)

    # ③ 레지스트리 등록 (워치독이 이 항목을 보고 자동 부활시킨다)
    done["registry"] = {"path": REGISTRY_PATH,
                        "project": registry_upsert(project, repo, model,
                                                   PERMISSION_ARGS[a.permission_mode])}

    done["next_steps"] = [
        "워치독 미등록이면: Windows `install.ps1 -Watchdog` / WSL `bash ~/.claude/skills/autoharness/install.sh --watchdog`",
        "검증: python3 scripts/harness_engine.py status --repo " + repo,
    ]
    print(json.dumps(done, ensure_ascii=False, indent=2))


def cli_stamp_watchdog_install(argv):
    """설치 스크립트(install.ps1 -Watchdog / install.sh --watchdog)가 워치독 등록에
    성공한 직후 호출한다 — 레지스트리에 설치 시각·주기를 남겨 watchdog_status 의 유예
    판정이 MCP 경로와 동일하게 동작하게 한다.

    사용: python3 harness_mcp.py stamp-watchdog-install [--interval-minutes 15]

    스탬프가 없으면 설치 직후에도 stale 경고가 떠 오탐이 된다. 실패해도 설치 자체를
    깨뜨리면 안 되므로 어떤 예외에서도 0 으로 끝난다(fail-open).
    """
    import argparse   # CLI 전용 — MCP 서버 기동 경로에서는 임포트하지 않는다
    ap = argparse.ArgumentParser(prog="harness_mcp.py stamp-watchdog-install")
    ap.add_argument("--interval-minutes", dest="interval_minutes", type=int, default=15)
    a = ap.parse_args(argv)
    try:
        reg = registry_load()
        reg["settings"]["watchdog_installed_at"] = now_iso()
        reg["settings"]["watchdog_interval_minutes"] = max(1, a.interval_minutes)
        registry_save(reg)
        print(json.dumps({"ok": True, "registry": REGISTRY_PATH,
                          "watchdog_installed_at": reg["settings"]["watchdog_installed_at"],
                          "watchdog_interval_minutes": reg["settings"]["watchdog_interval_minutes"]},
                         ensure_ascii=False))
    except Exception as e:
        sys.stderr.write("[stamp-watchdog-install] 기록 실패(설치는 계속): %r\n" % (e,))


CLI_COMMANDS = {
    "finish-init": cli_finish_init,
    "stamp-watchdog-install": cli_stamp_watchdog_install,
}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in CLI_COMMANDS:
        CLI_COMMANDS[sys.argv[1]](sys.argv[2:])
    elif len(sys.argv) > 1:
        sys.stderr.write("알 수 없는 인자입니다. MCP 서버는 인자 없이 실행되며, "
                         "CLI 는 %s 만 지원합니다.\n" % ", ".join(sorted(CLI_COMMANDS)))
        sys.exit(2)
    else:
        serve()
