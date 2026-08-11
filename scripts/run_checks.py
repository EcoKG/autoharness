#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoHarness 자기 검증 파이프라인 — 하네스 test_cmd 진입점.

**테스트를 줄이지 않고 배치만 바꾼다.** 실행하는 집합도 통과 기준도 종전과 같다.

구조(3단계):
  ⓪ 게이트 (직렬, 빠름) — py_compile 전량 + daemon devDependency 확인.
     실패하면 여기서 끝낸다. 컴파일이 깨진 채로 샤드를 돌리면 전부 같은 오류를 뱉어
     진짜 원인이 출력에 묻힌다.
  ① 검증 단위 (병렬) — selftest / tests 모듈 하나씩 / daemon typecheck /
     daemon 테스트 파일 하나씩. 서로 독립이므로 동시에 돈다.
  ② deploy (직렬, 마지막) — 앞 단계를 전부 통과한 코드만 실행 중 설치본에 반영한다.

왜 직렬이 느렸나(실측 2026-08-11, 16코어):
  compile 0.2s / selftest 2.2s / unittest 54.9s(21모듈 443건) /
  typecheck 2.2s / bun test 64.1s(24파일 610건) / deploy 0.2s = 약 124초.
  느린 원인은 알고리즘이 아니라 배치였다 — 파이썬 계열과 daemon 계열은 서로 독립인데
  순차로 돌고, 모듈·파일도 한 프로세스에서 줄섰다(느린 모듈은 훅 검증용 서브프로세스
  기동 비용이다). 최장 불가분 단위는 session-stream.test.ts 23.2s 와
  test_engine_hooks.py 15.0s 이므로 이론 하한은 약 25초다.

**집합 동일성이 이 파일의 안전장치다.** 샤드로 나누는 순간 "빠뜨렸는데 통과"가 가능해지고,
그것은 조용한 커버리지 축소 — 이 프로젝트가 반복해서 당한 실패 유형이다. 그래서 매 실행마다
계획한 단위 집합과 실제로 돈 테스트 수를 발견 집합과 대조하고, 어긋나면 통과가 아니라
실패로 처리한다(verify_coverage).
"""

import argparse
import io
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed

for _s in (sys.stdout, sys.stderr):
    try:
        # line_buffering: 서브프로세스 출력과 단계 배너의 순서가 섞이지 않게 한다
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS_DIR = os.path.join(REPO, "tests")
DAEMON_DIR = os.path.join(REPO, "daemon")
TIMING_CACHE = os.path.join(REPO, ".claude", "checks-timing.json")

UNIT_TIMEOUT_SEC = 600
DEPLOY_TIMEOUT_SEC = 120

TSC_MISSING_MARK = "command not found: tsc"
DEPS_FIX_HINT = ("해결: cd daemon && bun install  "
                 "— 빌드에는 devDependency 가 필요 없지만(런타임 의존성 0) "
                 "타입 검사는 tsc 를 쓰므로 필요합니다")

RAN_PY_RE = re.compile(r"^Ran (\d+) tests? in ", re.M)
RAN_BUN_RE = re.compile(r"Ran (\d+) tests? across (\d+) files?")

# bun 의 기본 테스트 파일 규칙. 여기서 벗어나면 우리가 계획한 집합과 bun 이 보는 집합이
# 어긋나므로, 실제로 도는 것보다 적게 계획해도 아무도 모른다.
BUN_TEST_SUFFIXES = tuple(
    "%s.%s" % (stem, ext)
    for stem in (".test", "_test", ".spec", "_spec")
    for ext in ("ts", "tsx", "js", "jsx", "mts", "cts")
)
BUN_SKIP_DIRS = {"node_modules", "dist", ".git", "coverage"}


# --------------------------------------------------------------------------- 단위

class Unit(object):
    """병렬로 돌릴 수 있는 검증 하나. 이름은 실패 보고에서 사람이 보는 식별자다."""

    __slots__ = ("name", "group", "argv", "cwd", "rc", "output", "seconds")

    def __init__(self, name, group, argv, cwd):
        self.name = name
        self.group = group
        self.argv = argv
        self.cwd = cwd
        self.rc = None
        self.output = ""
        self.seconds = 0.0

    @property
    def ok(self):
        return self.rc == 0


def unit_env():
    """자식이 UTF-8 로 말하게 못 박는다.

    출력을 캡처하는 순간 인코딩이 계약이 된다. 콘솔로 흘려보낼 때는 터미널이 알아서
    풀었지만, 캡처는 우리가 골라야 한다. 윈도우 파이썬은 기본이 cp949 라 실패 메시지의
    한글이 통째로 깨졌다(실측: 하네스가 부른 실행에서 단정문 메시지가 '???' 로 나왔다).
    실패 원인을 읽을 수 없으면 이 파일이 목표한 '즉시 식별'이 성립하지 않는다."""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def run_unit(unit):
    """단위 하나 실행 — 예외·타임아웃도 실패로 적어 남긴다(삼키지 않는다)."""
    started = time.time()
    try:
        r = subprocess.run(unit.argv, cwd=unit.cwd, timeout=UNIT_TIMEOUT_SEC, env=unit_env(),
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        unit.rc = r.returncode
        unit.output = (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        unit.rc = 124
        unit.output = "[checks] %d초를 초과해 중단했습니다: %s" % (UNIT_TIMEOUT_SEC, " ".join(unit.argv))
    except Exception as e:  # 워커가 죽어도 결과가 은폐되지 않게 한다
        unit.rc = 125
        unit.output = "[checks] 실행할 수 없습니다 (%s): %s" % (e, " ".join(unit.argv))
    unit.seconds = time.time() - started
    return unit


# --------------------------------------------------------------------------- 발견

def discover_python_tests():
    """직렬 발견 집합 — **실행하지 않고** 모듈 이름과 테스트 수만 센다.

    반환: (모듈 집합, 테스트 수, 임포트 실패 목록). 임포트 실패를 조용히 넘기면
    깨진 모듈이 발견 집합에서 빠져 '집합 일치'가 거짓으로 성립한다."""
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=TESTS_DIR, top_level_dir=REPO)
    modules, broken, count = set(), [], 0

    def walk(s):
        nonlocal count
        for item in s:
            if isinstance(item, unittest.TestSuite):
                walk(item)
                continue
            count += 1
            if type(item).__name__ == "_FailedTest":
                broken.append(item.id())
            else:
                modules.add(type(item).__module__)

    walk(suite)
    return modules, count, broken


def discover_bun_tests(daemon_dir):
    """bun 이 보는 테스트 파일 집합(daemon 기준 상대 경로, 정렬)."""
    found = []
    for root, dirs, files in os.walk(daemon_dir):
        dirs[:] = sorted(d for d in dirs if d not in BUN_SKIP_DIRS)
        for name in sorted(files):
            if name.endswith(BUN_TEST_SUFFIXES):
                rel = os.path.relpath(os.path.join(root, name), daemon_dir)
                found.append(rel.replace("\\", "/"))
    return sorted(found)


# --------------------------------------------------------------------------- 게이트

def gate_compile():
    targets = []
    for sub in ("bin", "scripts", "tests"):
        d = os.path.join(REPO, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".py"):
                targets.append(os.path.join(d, name))
    for path in targets:
        try:
            py_compile.compile(path, doraise=True)
        except py_compile.PyCompileError as e:
            print("[checks][ERROR] 컴파일 실패: %s\n%s" % (path, e))
            return False
    print("[checks] 컴파일 검사 통과: %d개 파일" % len(targets))
    return True


def _find_bun():
    """bun 실행 파일 — PATH 에 없으면 기본 설치 위치(~/.bun/bin)도 본다.

    설치 직후 셸에서는 PATH 가 아직 갱신되지 않아 PATH 조회만으로는 못 찾는다."""
    found = shutil.which("bun")
    if found:
        return found
    candidate = os.path.join(os.path.expanduser("~"), ".bun", "bin",
                             "bun.exe" if os.name == "nt" else "bun")
    return candidate if os.path.exists(candidate) else None


def daemon_missing_dev_deps(daemon_dir):
    """package.json 이 요구하는 devDependency 중 node_modules 에 없는 것(정렬).

    도구 부재와 실제 타입 오류는 처방이 정반대다 — 전자는 `bun install`, 후자는 코드 수정.
    한데 뭉치면 새로 클론한 사람이 원인을 알 수 없다(실측: 2026-08-11, tsc 부재로 검증
    자체가 통과 불능인데 출력은 "daemon typecheck 실패 (exit 1)" 한 줄뿐이었다).

    **판정 불가면 빈 목록을 돌려준다**(오탐 금지) — package.json 을 못 읽는 것을 근거로
    "의존성이 없다"고 단정하지 않는다."""
    pkg = os.path.join(daemon_dir, "package.json")
    try:
        with io.open(pkg, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    dev = data.get("devDependencies")
    if not isinstance(dev, dict) or not dev:
        return []
    node_modules = os.path.join(daemon_dir, "node_modules")
    return sorted(name for name in dev
                  if not os.path.isdir(os.path.join(node_modules, *name.split("/"))))


def gate_daemon_deps(daemon_dir):
    """v2 검증을 시작할 수 있는 상태인가. (진행 가능 여부, bun 경로) 를 돌려준다."""
    if not os.path.isdir(os.path.join(daemon_dir, "src")):
        print("[checks] daemon/src 없음 — v2 검증 단계 건너뜀")
        return True, None
    bun = _find_bun()
    if not bun:
        print("[checks][ERROR] daemon/src 가 있는데 bun 을 찾을 수 없습니다. "
              "https://bun.sh 설치 후 다시 실행하십시오 (건너뛰면 v2 코드가 무검증으로 통과합니다)")
        return False, None
    missing = daemon_missing_dev_deps(daemon_dir)
    if missing:
        print("[checks][ERROR] daemon devDependency 미설치: %s" % ", ".join(missing))
        print("[checks][ERROR] %s" % DEPS_FIX_HINT)
        return False, None
    return True, bun


# --------------------------------------------------------------------------- 계획

def plan_units(bun):
    """실행할 단위 목록 + 대조에 쓸 발견 정보."""
    modules, py_count, broken = discover_python_tests()
    if broken:
        print("[checks][ERROR] 테스트 모듈 임포트 실패 %d건: %s" % (len(broken), ", ".join(broken)))
        return None, None

    units = [Unit("selftest", "python", [sys.executable,
                                         os.path.join(REPO, "bin", "harness_engine.py"),
                                         "selftest"], REPO)]
    for mod in sorted(modules):
        units.append(Unit(mod, "python", [sys.executable, "-m", "unittest", mod], REPO))

    bun_files = []
    if bun:
        bun_files = discover_bun_tests(DAEMON_DIR)
        units.append(Unit("daemon:typecheck", "daemon", [bun, "run", "typecheck"], DAEMON_DIR))
        for f in bun_files:
            units.append(Unit("daemon:" + f, "daemon", [bun, "test", f], DAEMON_DIR))

    plan = {"modules": modules, "py_count": py_count, "bun_files": bun_files}
    return units, plan


def load_timings():
    try:
        with io.open(TIMING_CACHE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}  # 캐시는 최적화일 뿐이다 — 없거나 깨져도 검증에는 영향이 없다


def save_timings(units):
    data = load_timings()
    for u in units:
        if u.rc is not None:
            data[u.name] = round(u.seconds, 2)
    try:
        os.makedirs(os.path.dirname(TIMING_CACHE), exist_ok=True)
        tmp = TIMING_CACHE + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, sort_keys=True, indent=1)
        os.replace(tmp, TIMING_CACHE)
    except OSError:
        pass  # 다음 실행의 정렬이 조금 나빠질 뿐이다


def order_units(units, timings):
    """긴 것부터 시작한다(LPT) — 최장 단위가 마지막에 시작하면 그만큼 전체가 늘어난다.

    처음 실행에는 근거가 없으므로 계획 순서 그대로 둔다. 한 번 돌고 나면 캐시가 쌓여
    다음부터 최장 단위가 먼저 출발한다."""
    return sorted(units, key=lambda u: -timings.get(u.name, 0.0))


# --------------------------------------------------------------------------- 실행

def default_jobs():
    cpus = os.cpu_count() or 4
    return max(2, min(12, cpus - 2))


def run_parallel(units, jobs):
    """단위를 병렬 실행하고 **실패는 끝날 때마다 즉시** 알린다.

    실패해도 나머지를 취소하지 않는다 — 병렬 총시간이 최장 단위에 묶여 있으므로,
    끝까지 돌려 실패를 한 번에 다 보여 주는 편이 자가 수정 왕복을 줄인다."""
    done = 0
    total = len(units)
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        # as_completed: 제출 순서가 아니라 **끝난 순서**로 받는다. 제출 순서로 받으면
        # 앞선 긴 단위가 끝날 때까지 뒤쪽 실패가 화면에 안 나온다.
        futures = [pool.submit(run_unit, u) for u in units]
        for future in as_completed(futures):
            unit = future.result()
            done += 1
            mark = "ok  " if unit.ok else "FAIL"
            print("[checks][%s] %2d/%d %-34s %5.1fs" % (mark, done, total, unit.name, unit.seconds))
            if not unit.ok:
                print("        ↳ 실패 단위: %s (exit %s)" % (" ".join(unit.argv), unit.rc))
    return units


def report_failures(units):
    """실패한 단위만, 단위별로 묶어서 출력한다 — 병렬 출력이 섞여 원인을 못 찾으면
    속도 이득이 자가 수정 라운드에서 그대로 상쇄된다."""
    failed = [u for u in units if not u.ok]
    if not failed:
        return
    print("\n[checks][ERROR] 실패 단위 %d개: %s" % (len(failed), ", ".join(u.name for u in failed)))
    for u in failed:
        print("\n===== 실패 상세: %s (exit %s) =====" % (u.name, u.rc))
        print("$ %s   [cwd=%s]" % (" ".join(u.argv), os.path.relpath(u.cwd, REPO) or "."))
        print(u.output.strip())


# --------------------------------------------------------------------------- 집합 대조

def verify_coverage(units, plan):
    """샤드가 발견 집합을 그대로 덮었는가. 어긋나면 **통과가 아니라 실패다.**

    나눠서 돌리는 방식의 고유 위험은 '빠뜨렸는데 초록'이다. 그래서 세 가지를 본다:
      ① 계획한 모듈·파일 집합 == 발견 집합
      ② 실제로 돈 파이썬 테스트 수의 합 == 발견 단계에서 센 수
      ③ 단위마다 결과 줄이 실제로 있었는가(0건은 조용한 누락 신호다)
    """
    problems = []

    py_units = [u for u in units if u.group == "python" and u.name != "selftest"]
    planned_modules = set(u.name for u in py_units)
    if planned_modules != plan["modules"]:
        problems.append("파이썬 모듈 집합 불일치 — 계획에만: %s / 발견에만: %s"
                        % (sorted(planned_modules - plan["modules"]) or "없음",
                           sorted(plan["modules"] - planned_modules) or "없음"))

    ran = 0
    for u in py_units:
        counts = RAN_PY_RE.findall(u.output)
        if not counts:
            problems.append("%s: 실행 결과 줄('Ran N tests')이 없습니다 — 정말 돌았는지 확인 필요" % u.name)
            continue
        n = sum(int(c) for c in counts)
        if n == 0:
            problems.append("%s: 0건 실행 — 모듈이 비었거나 수집에 실패했습니다" % u.name)
        ran += n
    if ran != plan["py_count"]:
        problems.append("파이썬 테스트 수 불일치 — 발견 %d건, 실행 %d건" % (plan["py_count"], ran))

    bun_units = [u for u in units if u.group == "daemon" and u.name != "daemon:typecheck"]
    planned_files = sorted(u.name[len("daemon:"):] for u in bun_units)
    if planned_files != sorted(plan["bun_files"]):
        problems.append("daemon 테스트 파일 집합 불일치 — 계획 %d개, 발견 %d개"
                        % (len(planned_files), len(plan["bun_files"])))
    bun_ran, bun_files_seen = 0, 0
    for u in bun_units:
        m = RAN_BUN_RE.search(u.output)
        if not m:
            problems.append("%s: 실행 결과 줄('Ran N tests across M files')이 없습니다" % u.name)
            continue
        n, files = int(m.group(1)), int(m.group(2))
        if n == 0:
            problems.append("%s: 0건 실행 — 파일이 비었거나 수집에 실패했습니다" % u.name)
        if files != 1:
            problems.append("%s: 파일 %d개를 돌았습니다(1개여야 합니다)" % (u.name, files))
        bun_ran += n
        bun_files_seen += files

    print("[checks] 집합 대조: 파이썬 %d모듈 %d건 / daemon %d파일 %d건"
          % (len(py_units), ran, bun_files_seen, bun_ran))
    if problems:
        print("[checks][ERROR] 집합 대조 실패 — 나눠 돌리면서 무언가를 빠뜨렸습니다:")
        for p in problems:
            print("  - %s" % p)
        return False
    return True


# --------------------------------------------------------------------------- 배포

def stage_deploy():
    deploy = os.path.join(REPO, "scripts", "deploy_live.py")
    try:
        r = subprocess.run([sys.executable, deploy], cwd=REPO, timeout=DEPLOY_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        print("[checks][ERROR] deploy 가 %d초를 초과했습니다" % DEPLOY_TIMEOUT_SEC)
        return False
    if r.returncode != 0:
        print("[checks][ERROR] 설치본 동기화 실패 (exit %d)" % r.returncode)
        return False
    return True


# --------------------------------------------------------------------------- 진입점

def main():
    ap = argparse.ArgumentParser(prog="run_checks", description="AutoHarness 자기 검증 파이프라인")
    ap.add_argument("--no-deploy", action="store_true", help="설치본 동기화(마지막 단계) 생략")
    ap.add_argument("--jobs", type=int, default=None,
                    help="동시 실행 워커 수 (기본: CPU 기반 자동 산정)")
    ap.add_argument("--serial", action="store_true",
                    help="같은 단위를 하나씩 실행한다(--jobs 1 과 같다). 병렬이 의심될 때 대조용")
    a = ap.parse_args()

    started = time.time()

    print("\n===== checks: gate =====")
    if not gate_compile():
        print("[checks][ERROR] 단계 실패: compile")
        return 1
    daemon_ok, bun = gate_daemon_deps(DAEMON_DIR)
    if not daemon_ok:
        print("[checks][ERROR] 단계 실패: daemon 준비")
        return 1

    units, plan = plan_units(bun)
    if units is None:
        print("[checks][ERROR] 단계 실패: 테스트 발견")
        return 1

    jobs = 1 if a.serial else (a.jobs if a.jobs and a.jobs > 0 else default_jobs())
    units = order_units(units, load_timings())
    print("\n===== checks: units (%d개, 워커 %d) =====" % (len(units), jobs))
    run_parallel(units, jobs)
    save_timings(units)

    print("\n===== checks: coverage =====")
    covered = verify_coverage(units, plan)
    report_failures(units)

    failed = [u for u in units if not u.ok]
    if failed or not covered:
        print("\n[checks][ERROR] 단계 실패: units (%.1f초)" % (time.time() - started))
        return 1

    if not a.no_deploy:
        print("\n===== checks: deploy =====")
        if not stage_deploy():
            print("[checks][ERROR] 단계 실패: deploy")
            return 1

    print("\n[checks] 전체 통과 — 단위 %d개, %.1f초 (워커 %d)"
          % (len(units), time.time() - started, jobs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
