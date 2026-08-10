#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoHarness 워치독 — 스케줄러가 15분마다 실행하는 1회성 스크립트(데몬 아님).

레지스트리(%USERPROFILE%\\.claude\\autoharness\\registry.json)에 등록된 프로젝트를 순회하며
DESIGN.md §10 의 판단 순서(상태→백오프→장부→진행 가능 작업→하트비트→기동)를 그대로 수행한다.

플래그:
  --dry-run        판단만 stdout 에 출력하고 기동·레지스트리 수정을 하지 않는다
  --status         레지스트리 요약을 출력한다
  --registry PATH  레지스트리 경로 오버라이드(테스트용). 런타임 디렉토리는 이 파일의 폴더가 된다
  --probe-sec N    프로브 시간 오버라이드(기본은 settings.probe_sec=90)

사용량 초과(limit)는 지수 백오프로 재시도할 뿐 절대 영구 포기하지 않는다.
설정 오류성 실패(error)만 max_consecutive_errors(기본 5)회 연속 시 status=error 로 정지한다.
"""

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 엔진 재사용: 같은 디렉토리의 harness_engine 을 import 한다 (서브프로세스 아님)
SELF_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SELF_DIR)
import harness_engine as eng  # noqa: E402

DEFAULT_REGISTRY = os.path.join(
    os.environ.get("USERPROFILE") or os.path.expanduser("~"),
    ".claude", "autoharness", "registry.json")
CLAUDE_FALLBACK = os.path.join(os.path.expanduser("~"), ".local", "bin",
                               "claude.exe" if os.name == "nt" else "claude")
BOOTSTRAP_TEMPLATE = os.path.normpath(os.path.join(SELF_DIR, "..", "templates", "bootstrap_prompt.txt"))

LOCK_STALE_SEC = 30 * 60          # 잠금 mtime 이 30분 넘으면 죽은 잠금으로 보고 탈취
LOG_MAX_BYTES = 1024 * 1024       # watchdog.log 1MB 초과 시 뒤 절반만 남기고 절사
CREATE_NO_WINDOW = 0x08000000     # 헤드리스 기동(콘솔 창 금지)
STILL_ACTIVE = 259                # GetExitCodeProcess 의 "아직 실행 중"
PROCESS_QUERY_LIMITED = 0x1000    # PROCESS_QUERY_LIMITED_INFORMATION
POLL_INTERVAL_SEC = 5
LIMIT_NOTICE_HITS = 5      # 사용량 초과 분류가 이만큼 연속되면 오분류 의심 신호를 남긴다

# 사용량 초과 패턴(대소문자 무시). rc!=0 인 조기 종료에서만 검사한다(rc=0 은 무조건 ok).
# 429 는 독립 토큰만으로는 오탐("collected 429 items")이 있어 API 오류 문맥이 인접할 때만
# 매칭한다. rate_limit_error 류 언더스코어 표기도 rate.?limit 로 잡는다.
# `overloaded`·`quota` 가 맨몸이던 것을 정밀화한다. 429 만 문맥 조건을 갖고 나머지는 맨몸이라
# 정상 실패 로그(테스트 이름·소스 인용)에 우연히 걸려 오분류가 났다(적대 검증에서 확인).
# 다만 문맥을 무조건 요구하면 진짜 과부하를 놓쳐 error 경로로 빠지고 5회 뒤 정지하므로,
# 미탐이 오탐보다 비싸다. 그래서 단어 경계와 동사 한정으로 좁힌다:
#   `\boverloaded\b`      → "server is overloaded" 는 잡고 `test_overloaded_queue` 는 거른다
#                            (밑줄은 word 문자라 식별자 안에서는 경계가 생기지 않는다)
#   `quota exceeded|…`    → "quota management"·"disk quota check" 오탐 제거
#   문맥 결합형            → JSON 의 `overloaded_error`·`api_error: quota` 등을 잡는다
USAGE_RE = re.compile(
    r"(usage.?limit|rate.?limit|limit reached|too many requests|"
    r"credit balance|out of (extra )?usage|"
    r"\boverloaded\b|quota\s+(exceeded|exhausted|reached)|"
    r"(api.?error|status|code|http)\D{0,12}(429|overloaded|quota)|"
    r"(429|overloaded|quota)\D{0,12}(api.?error|_error))", re.IGNORECASE)

# 템플릿 부재 시 사용할 내장 부트스트랩 프롬프트
BUILTIN_BOOTSTRAP = (
    "당신은 AutoHarness 자율 주행 세션입니다. 사용자에게 질문하지 말고 아래 절차만 반복하십시오.\n"
    "1. .claude/agent_tracker.json 장부를 읽고 현재 상태를 파악합니다.\n"
    "2. python scripts/harness_engine.py next --repo . 로 다음 작업을 확인합니다.\n"
    "3. 해당 작업을 구현·수정한 뒤 bash scripts/agent_harness.sh --task <id> 를 실행합니다.\n"
    "4. 종료 코드 분기: 0=검증 통과 — 커밋 후 다음 작업 계속 / 1=검증 실패 — 오류 요약을 읽고 자가 수정 후 재실행 / "
    "2=설정 오류 — 중단·보고 / 3=진행 가능 작업 없음 — 세션 종료 / "
    "4=한도 도달(해당 작업 blocked) — 남은 작업이 있으면 다음 작업 계속, 없으면 요약 후 종료.\n"
    "5. 테스트 약화·삭제 금지, git push 금지, 사용자 질문 금지. 진실의 원천은 장부와 종료 코드입니다.\n")


def default_settings():
    """DESIGN §7 의 기본 settings (호출마다 새 객체)."""
    return {
        "stale_minutes": 30,
        "probe_sec": 90,
        "max_consecutive_errors": 5,
        "limit_backoff_minutes": [30, 60, 120, 240, 360],
        "error_backoff_minutes": [15, 30, 60],
    }


# ---------------------------------------------------------------- 공통 유틸

def parse_iso(s):
    """ISO 문자열 → aware UTC datetime. 실패 시 None."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_after(minutes):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def backoff_pick(seq, nth):
    """nth(1부터) 번째 백오프 분값 — 끝을 넘으면 마지막 값 고정."""
    if not seq:
        return 30
    return seq[min(max(nth, 1) - 1, len(seq) - 1)]


def read_tail(path, cap=4096):
    """로그 파일 마지막 cap 바이트를 읽어 문자열로 돌려준다."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - cap))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def is_usage_limited(text):
    return bool(USAGE_RE.search(text or ""))


# ---------------------------------------------------------------- pid 생존 확인 (os.kill 금지)

def pid_alive(pid):
    """Windows 에서 pid 생존 여부. 절대 os.kill 을 쓰지 않는다(프로세스를 죽인다).

    1차: OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetExitCodeProcess == STILL_ACTIVE.
         핸들을 못 얻어도 GetLastError()==5(접근 거부)면 살아 있는 것으로 간주.
    2차(폴백): tasklist /FI "PID eq n" 출력에 pid 가 있는지.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        # POSIX: 신호 0 은 전달 없이 존재·권한만 검사한다 (os.kill 금지는 Windows 한정 규칙)
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False
    try:
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED, False, pid)
        if handle:
            try:
                code = ctypes.c_ulong(0)
                ok = k32.GetExitCodeProcess(handle, ctypes.byref(code))
                if ok:
                    return code.value == STILL_ACTIVE
            finally:
                k32.CloseHandle(handle)
        else:
            if k32.GetLastError() == 5:  # ERROR_ACCESS_DENIED — 존재하지만 권한 없음
                return True
            return False
    except Exception:
        pass
    # 폴백: tasklist
    try:
        r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=15)
        return (" %d " % pid) in (" " + (r.stdout or "").replace("\r", " ").replace("\n", " ") + " ")
    except Exception:
        return False


# ---------------------------------------------------------------- 단일 인스턴스 잠금

def lock_path(runtime_dir):
    return os.path.join(runtime_dir, "watchdog.lock")


def acquire_lock(runtime_dir, log):
    """잠금 획득. 실패(다른 인스턴스 생존)면 False."""
    path = lock_path(runtime_dir)
    if os.path.exists(path):
        try:
            age = time.time() - os.path.getmtime(path)
        except OSError:
            age = 0
        if age > LOCK_STALE_SEC:
            log("-", "lock", "잠금 mtime %d초 경과(>30분) — 죽은 잠금 탈취" % int(age))
        else:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    old_pid = f.read().strip()
            except OSError:
                old_pid = ""
            if old_pid and pid_alive(old_pid):
                log("-", "lock", "다른 워치독 인스턴스 실행 중(pid=%s) — 즉시 종료" % old_pid)
                return False
            log("-", "lock", "잠금의 pid=%s 사망 확인 — 잠금 탈취" % (old_pid or "?"))
    os.makedirs(runtime_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    return True


def release_lock(runtime_dir):
    try:
        os.remove(lock_path(runtime_dir))
    except OSError:
        pass


# ---------------------------------------------------------------- 로그

def make_logger(runtime_dir, dry_run):
    """'ISO시각 | 프로젝트 | 판단 | 상세' 한 줄 기록기. --dry-run 은 로그 대신 stdout."""
    log_file = os.path.join(runtime_dir, "logs", "watchdog.log")

    def log(project, decision, detail):
        line = "%s | %s | %s | %s" % (eng.now_iso(), project, decision, detail)
        if dry_run:
            print(line)
            return
        try:
            os.makedirs(os.path.dirname(log_file), exist_ok=True)
            # 1MB 초과 시 뒤 절반만 남기고 절사
            try:
                if os.path.exists(log_file) and os.path.getsize(log_file) > LOG_MAX_BYTES:
                    with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                        data = f.read()
                    half = data[len(data) // 2:]
                    nl = half.find("\n")
                    if nl >= 0:
                        half = half[nl + 1:]
                    eng.atomic_write_text(log_file, half)
            except OSError:
                pass
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            # 로그 실패가 워치독 본연의 일을 막으면 안 된다
            sys.stderr.write("[watchdog] 로그 기록 실패: " + line + "\n")

    return log


# ---------------------------------------------------------------- 레지스트리

def load_or_create_registry(path):
    """레지스트리 로드. 없으면 DESIGN §7 기본 settings 로 빈 파일 생성. 파손이면 None."""
    reg = eng.load_json(path)
    if reg is None:
        if os.path.exists(path):
            return None  # 존재하지만 파싱 실패 — 덮어쓰지 않는다(fail-loud)
        reg = {"schema_version": 1, "settings": default_settings(), "projects": []}
        eng.atomic_write_json(path, reg)
    return reg


def merged_settings(reg):
    s = default_settings()
    s.update(reg.get("settings") or {})
    return s


# ---------------------------------------------------------------- 기동 재료

def find_claude():
    """claude 실행 파일 해석 — .bat/.cmd 심은 cmd 재해석으로 프롬프트의 따옴표·<> 가 깨지므로
    .exe 를 우선한다 (npm 심 환경 이식성)."""
    cand = shutil.which("claude")
    if cand and cand.lower().endswith((".bat", ".cmd")):
        exe = shutil.which("claude.exe")
        if exe:
            return exe
        if os.path.exists(CLAUDE_FALLBACK):
            return CLAUDE_FALLBACK
    return cand or CLAUDE_FALLBACK


def bootstrap_prompt():
    """templates/bootstrap_prompt.txt 우선, 없으면 내장 기본문."""
    try:
        with open(BOOTSTRAP_TEMPLATE, "r", encoding="utf-8") as f:
            text = f.read().strip()
            if text:
                return text
    except OSError:
        pass
    return BUILTIN_BOOTSTRAP


def probe_process(proc, probe_sec):
    """probe_sec 초 동안 5초 간격 폴링. 조기 종료면 rc, 생존이면 None."""
    deadline = time.time() + max(1, int(probe_sec))
    while time.time() < deadline:
        rc = proc.poll()
        if rc is not None:
            return rc
        time.sleep(min(POLL_INTERVAL_SEC, max(0.2, deadline - time.time())))
    return proc.poll()


# ---------------------------------------------------------------- 프로젝트별 판단·행동

def mark_error(proj, settings, reason, dry_run, log):
    """error 집계: consecutive_errors++, error_backoff 적용, 한도 도달 시 status=error 정지."""
    name = proj.get("id") or "?"
    ce_next = int(proj.get("consecutive_errors") or 0) + 1
    max_err = int(settings.get("max_consecutive_errors") or 5)
    mins = backoff_pick(settings.get("error_backoff_minutes") or [15, 30, 60], ce_next)
    if dry_run:
        log(name, "error", "(dry-run) %s — 예상: consecutive_errors %d→%d, %d분 백오프%s"
            % (reason, ce_next - 1, ce_next, mins,
               ", status=error 정지" if ce_next >= max_err else ""))
        return False
    proj["consecutive_errors"] = ce_next
    proj["next_retry_at"] = iso_after(mins)
    proj["updated_at"] = eng.now_iso()
    if ce_next >= max_err:
        proj["status"] = "error"
        log(name, "error", "%s — 연속 오류 %d회(한도 %d) → status=error 정지. 사람 확인 필요"
            % (reason, ce_next, max_err))
    else:
        log(name, "error", "%s — 연속 오류 %d/%d, %d분 후 재시도" % (reason, ce_next, max_err, mins))
    return True


def launch_project(proj, settings, runtime_dir, probe_sec, log, nxt):
    """claude 헤드리스 기동 + 프로브. 레지스트리 변경 여부를 돌려준다."""
    name = proj.get("id") or "?"
    model = proj.get("model") or "claude-opus-5"
    repo = proj.get("repo") or "."
    logs_dir = os.path.join(runtime_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    launch_log = os.path.join(logs_dir, "%s-%s.log" % (name, ts))

    cmd = [find_claude(), "-p", bootstrap_prompt(), "--model", model]
    cmd += list(proj.get("permission_args") or [])
    env = dict(os.environ)
    env["CLAUDE_AUTOHARNESS"] = "1"   # hook-stop 게이트가 이 변수로 헤드리스 세션을 식별한다
    flags = CREATE_NO_WINDOW if os.name == "nt" else 0

    fh = None
    try:
        fh = open(launch_log, "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen(cmd, cwd=repo, env=env, stdout=fh,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                creationflags=flags)
    except Exception as e:
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass
        mark_error(proj, settings, "기동 실패: %r" % (e,), False, log)
        proj["last_launch"] = {"ts": eng.now_iso(), "result": "error", "log": launch_log}
        return True

    log(name, "launch", "pid=%d model=%s 다음 작업=%s log=%s" % (proc.pid, model, nxt["id"], launch_log))
    rc = probe_process(proc, probe_sec)
    try:
        fh.close()   # 자식은 핸들 사본을 이미 물려받았으므로 계속 쓸 수 있다
    except OSError:
        pass

    if rc is None:
        # 프로브 생존 → ok: 카운터 전부 리셋, 분리(자식은 계속 산다)
        proj["consecutive_errors"] = 0
        proj["limit_hits"] = 0
        proj["next_retry_at"] = None
        proj["last_launch"] = {"ts": eng.now_iso(), "result": "ok", "log": launch_log}
        proj["updated_at"] = eng.now_iso()
        log(name, "ok", "프로브 %d초 생존 — 세션 분리(계속 실행)" % int(probe_sec))
        return True

    if rc == 0:
        # 조기 정상 종료 → ok. limit 패턴 검사보다 반드시 먼저 — 정상 세션 출력 속
        # '429'·'quota' 류 우연 문자열이 백오프를 잘못 세우는 오탐을 막는다.
        proj["consecutive_errors"] = 0
        proj["limit_hits"] = 0
        proj["next_retry_at"] = None
        proj["last_launch"] = {"ts": eng.now_iso(), "result": "ok", "log": launch_log}
        proj["updated_at"] = eng.now_iso()
        log(name, "ok", "조기 정상 종료(rc=0)")
        return True

    tail = read_tail(launch_log)
    if is_usage_limited(tail):
        # limit: 지수 백오프로 재시도. status 는 active 유지 — 절대 영구 포기 없음
        hits = int(proj.get("limit_hits") or 0) + 1
        mins = backoff_pick(settings.get("limit_backoff_minutes") or [30, 60, 120, 240, 360], hits)
        proj["limit_hits"] = hits
        proj["next_retry_at"] = iso_after(mins)
        proj["last_launch"] = {"ts": eng.now_iso(), "result": "limit", "log": launch_log}
        proj["updated_at"] = eng.now_iso()
        # 영구 포기는 없다(status 는 active 유지). 다만 한도가 계속 이어지면 사용량 초과가
        # 아니라 오분류일 수 있으므로 사람이 볼 수 있게 신호를 남긴다 — 종전에는 상한도
        # 신호도 없어 오분류 상태가 360분 간격으로 영원히 반복됐다(error 분기는 5회로
        # 정지하는 것과 대조적인 비일관).
        notice = int(settings.get("limit_notice_hits") or LIMIT_NOTICE_HITS)
        warn = ""
        if hits >= notice:
            proj["needs_attention"] = (
                "사용량 초과 분류가 %d회 연속입니다 — 실제 한도가 아니라 오분류일 수 있습니다. "
                "%s 로그를 확인하십시오." % (hits, launch_log))
            warn = " ⚠ %d회 연속 — 오분류 가능성, 로그 확인 권장" % hits
        elif "needs_attention" in proj:
            del proj["needs_attention"]
        log(name, "limit", "사용량 초과 감지(rc=%s) — limit_hits=%d, %d분 후 재시도(영구 포기 없음)%s"
            % (rc, hits, mins, warn))
        return True

    mark_error(proj, settings, "조기 비정상 종료(rc=%s) log=%s" % (rc, launch_log), False, log)
    proj["last_launch"] = {"ts": eng.now_iso(), "result": "error", "log": launch_log}
    return True


def handle_project(proj, settings, runtime_dir, probe_sec, dry_run, log):
    """DESIGN §10 판단 순서(고정). 레지스트리 변경 여부를 돌려준다."""
    name = proj.get("id") or "?"
    now = datetime.now(timezone.utc)

    # 1. status ≠ active → 스킵. 단 completed 는 종점이 아니다(DESIGN §7) — 장부에 진행
    #    가능한 작업이 생겼으면 여기서 되살린다. 재활성화가 MCP task_add 에만 걸려 있어,
    #    엔진 CLI add-task(SKILL 폴백 경로)나 손편집으로 작업을 넣으면 레지스트리가
    #    completed 로 남아 워치독이 영영 기동하지 않던 비대칭을 없앤다.
    status = proj.get("status")
    if status == "completed":
        revived = eng.load_json(eng.rp(proj.get("repo") or "")["tracker"])
        if isinstance(revived, dict) and eng.eligible_next(revived) is not None:
            if dry_run:
                log(name, "skip", "(dry-run) completed 인데 진행 가능 작업 있음 — 재활성화 대상")
                return False
            proj["status"] = "active"
            proj["consecutive_errors"] = 0
            proj["limit_hits"] = 0
            proj["next_retry_at"] = None
            proj["updated_at"] = eng.now_iso()
            log(name, "active", "completed → active 재활성화(장부에 진행 가능 작업 확인)")
            status = "active"
    if status != "active":
        log(name, "skip", "status=%s — 기동 대상 아님" % status)
        return False

    # 2. next_retry_at 이 미래 → 스킵 (백오프 중)
    nra = parse_iso(proj.get("next_retry_at"))
    if nra is not None and nra > now:
        log(name, "skip", "백오프 중 — next_retry_at=%s" % proj.get("next_retry_at"))
        return False

    # 2.5 저장소의 HARNESS_PAUSED 플래그 → 스킵
    #     (MCP 없이 플래그 파일만 만든 폴백 일시정지도 워치독이 존중해야 한다)
    paths = eng.rp(proj.get("repo") or "")
    if os.path.exists(paths["paused_flag"]):
        log(name, "skip", "HARNESS_PAUSED 플래그 존재 — 일시정지 상태")
        return False

    # 3. 장부 부재/파손 → 오류 집계
    tracker = eng.load_json(paths["tracker"])
    if not isinstance(tracker, dict) or not isinstance(tracker.get("tasks"), list):
        return mark_error(proj, settings, "장부 부재/파손: %s" % paths["tracker"], dry_run, log)

    # 4. 진행 가능 작업 없음 → completed / needs_human 기록 후 스킵
    nxt = eng.eligible_next(tracker)
    if nxt is None:
        counts = eng.status_counts(tracker)
        tasks = tracker.get("tasks") or []
        # ① 작업이 아직 적재되지 않은 상태(init 직후 빈 장부)를 '완료'로 마감하면 안 된다.
        #    init 과 첫 task_add 사이에 틱이 한 번만 돌아도 프로젝트가 봉인돼, 이후 작업을
        #    넣어도 워치독이 status!=active 로 스킵해 다시는 기동하지 않는다(실측).
        if not tasks:
            log(name, "skip", "장부에 작업이 아직 없음 — 적재 대기(완료 전이하지 않음)")
            return False
        # ② 교착 pending(의존이 미존재·순환이라 영영 실행 불가)은 '완료'가 아니라 사람 판단이다.
        #    엔진은 next/brief/status 에서 1급 개념으로 다루는데 종점 판정만 이를 보지 않았다.
        dead = eng.deadlocked_pending(tracker)
        if counts.get("blocked") or dead:
            reasons = []
            if counts.get("blocked"):
                reasons.append("blocked %d건" % counts["blocked"])
            if dead:
                reasons.append("교착 pending %d건(%s)"
                               % (len(dead), ", ".join(t["id"] for t in dead[:3])))
            new_status, detail = "needs_human", " / ".join(reasons) + " — 사람 판단 필요"
        else:
            new_status, detail = "completed", "진행 가능 작업 없음(done %d건) — 완료 전이" % counts.get("done", 0)
        if dry_run:
            log(name, new_status, "(dry-run) " + detail)
            return False
        proj["status"] = new_status
        proj["updated_at"] = eng.now_iso()
        log(name, new_status, detail)
        return True

    # 5. 하트비트가 stale_minutes 이내 → 스킵 (세션 생존 — 이중 기동 방지)
    hb = eng.load_json(paths["heartbeat"]) or {}
    hb_ts = parse_iso(hb.get("ts"))
    stale_min = int(settings.get("stale_minutes") or 30)
    if hb_ts is not None and (now - hb_ts) < timedelta(minutes=stale_min):
        log(name, "skip", "하트비트 신선(%s, 기준 %d분) — 세션 생존 추정" % (hb.get("ts"), stale_min))
        return False

    # 6. 기동
    if dry_run:
        log(name, "launch", "(dry-run) 기동 대상 — 다음 작업=%s model=%s" % (nxt["id"], proj.get("model")))
        return False
    return launch_project(proj, settings, runtime_dir, probe_sec, log, nxt)


# ---------------------------------------------------------------- --status

def print_status(reg, registry_path, runtime_dir):
    s = merged_settings(reg)
    projects = reg.get("projects") or []
    print("[AutoHarness 워치독 상태]")
    print("registry: %s" % registry_path)
    print("settings: stale=%s분 probe=%s초 max_err=%s limit_backoff=%s error_backoff=%s"
          % (s["stale_minutes"], s["probe_sec"], s["max_consecutive_errors"],
             s["limit_backoff_minutes"], s["error_backoff_minutes"]))
    print("projects: %d개" % len(projects))
    for p in projects:
        ll = p.get("last_launch") or {}
        print(" - %s | status=%s | model=%s | 연속오류=%s | limit_hits=%s | next_retry_at=%s | last=%s(%s)"
              % (p.get("id"), p.get("status"), p.get("model"),
                 p.get("consecutive_errors", 0), p.get("limit_hits", 0),
                 p.get("next_retry_at"), ll.get("result"), ll.get("ts")))
    log_file = os.path.join(runtime_dir, "logs", "watchdog.log")
    tail = read_tail(log_file, 1024)
    if tail:
        print("watchdog.log 최근:")
        for ln in tail.strip().splitlines()[-5:]:
            print("  " + ln)


# ------------------------------------------------- 레지스트리 저장 (갱신 소실 방지)

def project_key(proj):
    return os.path.normcase(os.path.abspath(proj.get("repo") or ""))


def save_registry_merged(registry_path, reg, touched, log):
    """저장 직전 디스크를 다시 읽어, **이번 주기에 실제로 바꾼 프로젝트만** 병합해 쓴다.

    재읽기와 쓰기는 **프로세스 간 잠금 안에서** 한다. 재읽기만으로는 A읽기→B읽기→B쓰기→
    A쓰기 순서를 막지 못하고 창이 좁아질 뿐인데, 쓰기 주체가 워치독·MCP 서버로 별개
    프로세스라 같은 프로세스 안의 순서 보장으로는 부족하다. 잠금 파일 규약은 v2 구현과
    공유한다. 잠금을 못 얻으면 이번 주기 저장을 건너뛰고 로그로 드러낸다 — 남의 갱신을
    덮는 것보다 이번 주기 결과를 잃는 편이 낫다(다음 주기에 다시 판단한다).

    주기 시작에 읽은 메모리 사본을 통째로 되쓰면, 주기 도중 MCP 가 기록한 변경
    (task_add 재활성화·pause·model_set·설치 스탬프)이 조용히 되돌려진다. completed
    프로젝트에 작업을 넣어도 다음 주기가 completed 로 되돌리면 자동 부활이 영구 무효가
    되는 경로였다."""
    lock_path = os.path.join(os.path.dirname(registry_path), "registry.lock")
    try:
        with eng.file_lock(lock_path):
            disk = eng.load_json(registry_path)
            if not isinstance(disk, dict) or not isinstance(disk.get("projects"), list):
                eng.atomic_write_json(registry_path, reg)   # 디스크가 이상하면 메모리본을 쓴다
                return
            by_key = {}
            for p in disk["projects"]:
                by_key.setdefault(project_key(p), p)
            added = 0
            for p in reg.get("projects") or []:
                key = project_key(p)
                if key not in touched:
                    continue                     # 안 만진 프로젝트는 디스크 값을 그대로 둔다
                target = by_key.get(key)
                if target is None:
                    disk["projects"].append(p)   # 주기 중 새로 등록됐다가 사라진 경우는 없다
                    added += 1
                    continue
                for field in WATCHDOG_OWNED_FIELDS:
                    if field in p:
                        target[field] = p[field]
            disk["last_tick"] = reg.get("last_tick")
            eng.atomic_write_json(registry_path, disk)
            if added:
                log("-", "info", "레지스트리 병합 저장 — 신규 항목 %d건" % added)
    except eng.LockTimeout as e:
        # 조용히 덮지 않는다. 이번 주기 결과를 버리고 다음 주기에 다시 판단한다.
        log("-", "warn", "레지스트리 잠금 획득 실패 — 이번 주기 저장을 건너뜁니다: %s" % e)


# 워치독이 소유하는 필드 — 이 필드만 되쓴다
WATCHDOG_OWNED_FIELDS = ("status", "consecutive_errors", "limit_hits",
                         "next_retry_at", "last_launch", "updated_at")


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(prog="harness_watchdog",
                                 description="AutoHarness 워치독 (1회 실행)")
    ap.add_argument("--dry-run", action="store_true", help="판단만 출력, 기동·레지스트리 수정 없음")
    ap.add_argument("--status", action="store_true", help="레지스트리 요약 출력")
    ap.add_argument("--registry", default=DEFAULT_REGISTRY, help="레지스트리 경로 오버라이드(테스트용)")
    ap.add_argument("--probe-sec", dest="probe_sec", type=int, default=None, help="프로브 시간 오버라이드")
    a = ap.parse_args(argv)

    registry_path = os.path.abspath(a.registry)
    runtime_dir = os.path.dirname(registry_path)

    reg = load_or_create_registry(registry_path)
    if reg is None:
        sys.stderr.write("[watchdog] 레지스트리 파손(파싱 실패): %s — 덮어쓰지 않고 종료합니다\n" % registry_path)
        return 2

    if a.status:
        print_status(reg, registry_path, runtime_dir)
        return 0

    settings = merged_settings(reg)
    probe_sec = a.probe_sec if a.probe_sec is not None else int(settings.get("probe_sec") or 90)
    log = make_logger(runtime_dir, a.dry_run)
    projects = reg.get("projects") or []

    if a.dry_run:
        # 판단만 stdout 출력 — 잠금·기동·레지스트리 쓰기 전부 없음
        if not projects:
            log("-", "idle", "등록된 프로젝트 없음")
        for proj in projects:
            handle_project(proj, settings, runtime_dir, probe_sec, True, log)
        return 0

    # 단일 인스턴스 잠금 (기존 잠금: mtime 30분 초과 → 탈취 / pid 생존 → 즉시 종료)
    if not acquire_lock(runtime_dir, log):
        return 0
    try:
        if not projects:
            log("-", "idle", "등록된 프로젝트 없음")
        touched = set()
        for proj in projects:
            try:
                if handle_project(proj, settings, runtime_dir, probe_sec, False, log):
                    touched.add(project_key(proj))
            except Exception as e:
                # 한 프로젝트의 예외가 다른 프로젝트 처리를 막으면 안 된다. 다만 로그만
                # 남기고 넘어가면 매 주기 같은 예외가 나도 영원히 재시도하며 status=error
                # 로 정지하지 않는다 — 다른 실패 경로가 5회로 정지하는 것과 어긋난다.
                try:
                    mark_error(proj, settings, "워치독 내부 예외: %r" % (e,), False, log)
                    touched.add(project_key(proj))
                except Exception as inner:
                    log(proj.get("id") or "?", "error",
                        "워치독 내부 예외(집계 실패): %r / %r" % (e, inner))
        # 기동 여부와 무관하게 '이번 주기가 실제로 돌았다'를 남긴다 — last_launch 는
        # skip/completed 주기에는 갱신되지 않아 '한 번도 기동 안 됨'과 '워치독이 아예
        # 안 돎'을 구분하지 못한다. 그 구분이 진단(watchdog_status)의 판정 근거다.
        reg["last_tick"] = eng.now_iso()
        save_registry_merged(registry_path, reg, touched, log)
    finally:
        release_lock(runtime_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
