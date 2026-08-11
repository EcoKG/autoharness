#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoHarness 자기 검증 파이프라인 — 하네스 test_cmd 진입점.

단계(순서 고정, 하나라도 실패하면 즉시 exit 1):
  ① compile  — bin/·scripts/·tests/ 전체 py_compile
  ② selftest — bin/harness_engine.py 내장 selftest (개발 중인 엔진 원본을 검증)
  ③ unittest — tests/ 단위 테스트 (unittest discover; tests/ 없으면 건너뜀)
  ④ daemon   — v2 TypeScript 타입 검사 + bun test (daemon/src 없으면 건너뜀)
  ⑤ deploy   — scripts/deploy_live.py 로 실행 중 설치본 동기화 (--no-deploy 로 생략)

⑤ 가 마지막인 이유: 앞 단계를 전부 통과한 코드만 실행 중 설치본에 반영돼야 한다.
주행 루프 자체는 scripts/harness_engine.py(고정 사본)로 돌므로, 여기서 검증하는
bin/ 원본이 일시적으로 깨져도 루프는 멈추지 않는다.
"""

import argparse
import io
import json
import os
import py_compile
import shutil
import subprocess
import sys
import unittest

for _s in (sys.stdout, sys.stderr):
    try:
        # line_buffering: 서브프로세스(selftest·deploy) 출력과 단계 배너의 순서가 섞이지 않게 한다
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def stage_compile():
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


def stage_selftest():
    engine = os.path.join(REPO, "bin", "harness_engine.py")
    try:
        r = subprocess.run([sys.executable, engine, "selftest"], cwd=REPO, timeout=300)
    except subprocess.TimeoutExpired:
        print("[checks][ERROR] selftest 가 300초를 초과했습니다")
        return False
    if r.returncode != 0:
        print("[checks][ERROR] 엔진 selftest 실패 (exit %d)" % r.returncode)
        return False
    return True


def stage_unittests():
    tests_dir = os.path.join(REPO, "tests")
    if not os.path.isdir(tests_dir):
        print("[checks] tests/ 없음 — 단위 테스트 단계 건너뜀")
        return True
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=tests_dir, top_level_dir=REPO)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    print("[checks] 단위 테스트: run=%d failures=%d errors=%d skipped=%d"
          % (result.testsRun, len(result.failures), len(result.errors), len(result.skipped)))
    if not result.wasSuccessful():
        print("[checks][ERROR] 단위 테스트 실패")
        return False
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


TSC_MISSING_MARK = "command not found: tsc"
DEPS_FIX_HINT = ("해결: cd daemon && bun install  "
                 "— 빌드에는 devDependency 가 필요 없지만(런타임 의존성 0) "
                 "타입 검사는 tsc 를 쓰므로 필요합니다")


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


def stage_daemon():
    """v2 TypeScript 데몬 검증 — 타입 검사 + 단위 테스트.

    daemon/ 이 없으면(마이그레이션 착수 전) 건너뛴다. 그러나 **daemon/src 가 있는데
    bun 이 없으면 실패로 처리한다** — 검증할 코드가 있는데 조용히 건너뛰면 통과처럼
    보이는 조용한 실패가 된다(이 프로젝트가 반복해서 당한 결함이다)."""
    daemon_dir = os.path.join(REPO, "daemon")
    if not os.path.isdir(os.path.join(daemon_dir, "src")):
        print("[checks] daemon/src 없음 — v2 검증 단계 건너뜀")
        return True
    bun = _find_bun()
    if not bun:
        print("[checks][ERROR] daemon/src 가 있는데 bun 을 찾을 수 없습니다. "
              "https://bun.sh 설치 후 다시 실행하십시오 (건너뛰면 v2 코드가 무검증으로 통과합니다)")
        return False

    missing = daemon_missing_dev_deps(daemon_dir)
    if missing:
        print("[checks][ERROR] daemon devDependency 미설치: %s" % ", ".join(missing))
        print("[checks][ERROR] %s" % DEPS_FIX_HINT)
        return False

    for label, argv in (("typecheck", [bun, "run", "typecheck"]),
                        ("bun test", [bun, "test"])):
        try:
            # 출력은 그대로 흘리되 도구 부재 신호를 보기 위해 손에도 쥔다.
            r = subprocess.run(argv, cwd=daemon_dir, timeout=600, capture_output=True,
                               text=True, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            print("[checks][ERROR] daemon %s 가 600초를 초과했습니다" % label)
            return False
        output = (r.stdout or "") + (r.stderr or "")
        sys.stdout.write(output)
        if r.returncode != 0:
            # node_modules 가 있어도 깨져 있으면 위 사전 검사를 통과한다 — 그때의 안전망
            if TSC_MISSING_MARK in output:
                print("[checks][ERROR] daemon %s 실패 — tsc 를 찾을 수 없습니다"
                      "(타입 오류가 아니라 도구 부재입니다)" % label)
                print("[checks][ERROR] %s" % DEPS_FIX_HINT)
            else:
                print("[checks][ERROR] daemon %s 실패 (exit %d)" % (label, r.returncode))
            return False
    return True


def stage_deploy():
    deploy = os.path.join(REPO, "scripts", "deploy_live.py")
    try:
        r = subprocess.run([sys.executable, deploy], cwd=REPO, timeout=120)
    except subprocess.TimeoutExpired:
        print("[checks][ERROR] deploy 가 120초를 초과했습니다")
        return False
    if r.returncode != 0:
        print("[checks][ERROR] 설치본 동기화 실패 (exit %d)" % r.returncode)
        return False
    return True


def main():
    ap = argparse.ArgumentParser(prog="run_checks", description="AutoHarness 자기 검증 파이프라인")
    ap.add_argument("--no-deploy", action="store_true", help="설치본 동기화(④) 생략")
    a = ap.parse_args()

    stages = [("compile", stage_compile), ("selftest", stage_selftest),
              ("unittest", stage_unittests), ("daemon", stage_daemon)]
    if not a.no_deploy:
        stages.append(("deploy", stage_deploy))

    for name, fn in stages:
        print("\n===== checks: %s =====" % name)
        if not fn():
            print("[checks][ERROR] 단계 실패: %s" % name)
            return 1
    print("\n[checks] 전체 통과 (%s)" % ", ".join(n for n, _ in stages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
