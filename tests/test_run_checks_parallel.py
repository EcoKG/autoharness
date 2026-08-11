# -*- coding: utf-8 -*-
"""검증 파이프라인 병렬화 회귀 — **집합 동일성이 핵심이다.**

나눠서 돌리는 방식의 고유 위험은 '빠뜨렸는데 초록'이다. 테스트를 지우거나 skip 을
넣지 않아도, 샤드 계획이 발견 집합보다 작으면 커버리지가 조용히 줄어들고 아무도 모른다.
이 프로젝트가 반복해서 당한 실패 유형이라 기계가 잡아야 한다.

그래서 여기서 고정하는 것:
  ① 계획한 단위 집합 == 실제 발견 집합 (파이썬 모듈, daemon 테스트 파일 양쪽)
  ② 수가 어긋나거나 결과 줄이 없으면 **통과가 아니라 실패**
  ③ 단위 실행이 예외·타임아웃을 삼키지 않는다
  ④ deploy 는 여전히 마지막이고 단독이다(순서 계약)
"""

import io
import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import run_checks  # noqa: E402


def fake_unit(name, group, output, rc=0):
    u = run_checks.Unit(name, group, ["echo", name], REPO)
    u.rc = rc
    u.output = output
    return u


def py_unit(module, ran, rc=0):
    return fake_unit(module, "python", "Ran %d tests in 0.1s\n\nOK\n" % ran, rc)


def bun_unit(path, ran, files=1, rc=0):
    return fake_unit("daemon:" + path, "daemon",
                     "\n %d pass\n 0 fail\nRan %d tests across %d files. [1ms]\n" % (ran, ran, files), rc)


def plan_of(modules, py_count, files):
    return {"modules": set(modules), "py_count": py_count, "bun_files": list(files)}


class CoverageGuardTest(unittest.TestCase):
    """verify_coverage 는 '나눠 돌리면서 빠뜨렸는가'만 본다 — 통과/실패 판정과 별개 축이다."""

    def setUp(self):
        self.buf = io.StringIO()
        self._out = sys.stdout
        sys.stdout = self.buf
        self.addCleanup(setattr, sys, "stdout", self._out)

    def check(self, units, plan):
        return run_checks.verify_coverage(units, plan)

    def test_matching_sets_pass(self):
        units = [fake_unit("selftest", "python", "PASS"),
                 py_unit("tests.test_a", 10), py_unit("tests.test_b", 5),
                 fake_unit("daemon:typecheck", "daemon", ""),
                 bun_unit("test/x.test.ts", 7)]
        self.assertTrue(self.check(units, plan_of(["tests.test_a", "tests.test_b"], 15,
                                                  ["test/x.test.ts"])))

    def test_dropped_python_module_fails(self):
        """샤드 계획이 발견보다 작다 — 이것이 조용한 커버리지 축소다."""
        units = [py_unit("tests.test_a", 10)]
        ok = self.check(units, plan_of(["tests.test_a", "tests.test_b"], 15, []))
        self.assertFalse(ok)
        self.assertIn("모듈 집합 불일치", self.buf.getvalue())

    def test_extra_python_module_fails(self):
        units = [py_unit("tests.test_a", 10), py_unit("tests.test_ghost", 5)]
        self.assertFalse(self.check(units, plan_of(["tests.test_a"], 10, [])))

    def test_test_count_mismatch_fails(self):
        """모듈은 다 돌았는데 그 안에서 수가 줄었다 — 수집 실패의 신호다."""
        units = [py_unit("tests.test_a", 3)]
        ok = self.check(units, plan_of(["tests.test_a"], 10, []))
        self.assertFalse(ok)
        self.assertIn("테스트 수 불일치", self.buf.getvalue())

    def test_missing_result_line_fails(self):
        """정말 돌았는지 알 수 없는 출력을 통과로 세지 않는다."""
        units = [fake_unit("tests.test_a", "python", "아무 말도 없음")]
        ok = self.check(units, plan_of(["tests.test_a"], 10, []))
        self.assertFalse(ok)
        self.assertIn("실행 결과 줄", self.buf.getvalue())

    def test_zero_tests_in_a_module_fails(self):
        units = [py_unit("tests.test_a", 0)]
        ok = self.check(units, plan_of(["tests.test_a"], 0, []))
        self.assertFalse(ok)
        self.assertIn("0건 실행", self.buf.getvalue())

    def test_dropped_bun_file_fails(self):
        units = [bun_unit("test/x.test.ts", 7)]
        ok = self.check(units, plan_of([], 0, ["test/x.test.ts", "test/y.test.ts"]))
        self.assertFalse(ok)
        self.assertIn("파일 집합 불일치", self.buf.getvalue())

    def test_bun_shard_running_more_than_one_file_fails(self):
        """한 샤드가 여러 파일을 돌면 다른 샤드와 겹쳐 수가 부풀려진다."""
        units = [bun_unit("test/x.test.ts", 7, files=2)]
        ok = self.check(units, plan_of([], 0, ["test/x.test.ts"]))
        self.assertFalse(ok)
        self.assertIn("파일 2개를 돌았습니다", self.buf.getvalue())

    def test_bun_missing_result_line_fails(self):
        units = [fake_unit("daemon:test/x.test.ts", "daemon", "그냥 조용히 끝남")]
        self.assertFalse(self.check(units, plan_of([], 0, ["test/x.test.ts"])))

    def test_selftest_and_typecheck_are_not_counted_as_shards(self):
        """이 둘은 테스트 수를 보고하지 않는다 — 대조 대상에서 빠져야 한다."""
        units = [fake_unit("selftest", "python", "PASS 전부"),
                 fake_unit("daemon:typecheck", "daemon", "$ tsc --noEmit")]
        self.assertTrue(self.check(units, plan_of([], 0, [])))

    def test_multiple_ran_lines_are_summed(self):
        """unittest 가 여러 스위트를 돌리면 Ran 줄이 여러 개 나온다."""
        units = [fake_unit("tests.test_a", "python", "Ran 4 tests in 0.1s\nRan 6 tests in 0.2s\n")]
        self.assertTrue(self.check(units, plan_of(["tests.test_a"], 10, [])))


class UnitExecutionTest(unittest.TestCase):
    def test_failure_is_recorded_not_swallowed(self):
        u = run_checks.Unit("실패", "python", [sys.executable, "-c", "import sys; sys.exit(3)"], REPO)
        run_checks.run_unit(u)
        self.assertEqual(u.rc, 3)
        self.assertFalse(u.ok)

    def test_unlaunchable_command_is_a_failure_with_reason(self):
        """워커가 죽어도 결과가 은폐되지 않는다 — 예외를 통과로 바꾸지 않는다."""
        u = run_checks.Unit("없는명령", "python", ["이런-명령은-없다-12345"], REPO)
        run_checks.run_unit(u)
        self.assertFalse(u.ok)
        self.assertIn("실행할 수 없습니다", u.output)

    def test_timeout_is_a_failure(self):
        original = run_checks.UNIT_TIMEOUT_SEC
        run_checks.UNIT_TIMEOUT_SEC = 1
        self.addCleanup(setattr, run_checks, "UNIT_TIMEOUT_SEC", original)
        u = run_checks.Unit("느림", "python", [sys.executable, "-c", "import time; time.sleep(30)"], REPO)
        run_checks.run_unit(u)
        self.assertEqual(u.rc, 124)
        self.assertIn("초과", u.output)

    def test_output_captures_both_streams(self):
        u = run_checks.Unit("양쪽", "python",
                            [sys.executable, "-c",
                             "import sys; sys.stdout.write('OUT'); sys.stderr.write('ERR')"], REPO)
        run_checks.run_unit(u)
        self.assertIn("OUT", u.output)
        self.assertIn("ERR", u.output)

    def test_non_ascii_output_survives_capture(self):
        """실패 메시지의 한글이 깨지면 '원인 즉시 식별'이 성립하지 않는다.

        실측(2026-08-11): 하네스가 부른 실행에서 자식 파이썬이 cp949 로 말해 단정문
        메시지가 통째로 깨졌다 — 캡처하는 순간 인코딩이 계약이 된다."""
        u = run_checks.Unit("한글", "python",
                            [sys.executable, "-c", "print('실패 원인: 단정문 불일치')"], REPO)
        run_checks.run_unit(u)
        self.assertIn("실패 원인: 단정문 불일치", u.output)

    def test_child_env_pins_utf8(self):
        env = run_checks.unit_env()
        self.assertEqual(env["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(env["PYTHONUTF8"], "1")


class DiscoveryTest(unittest.TestCase):
    def test_python_discovery_finds_this_very_module(self):
        modules, count, broken = run_checks.discover_python_tests()
        self.assertEqual(broken, [])
        self.assertIn("tests.test_run_checks_parallel", modules)
        self.assertGreater(count, len(modules))  # 모듈마다 최소 한 건은 있다

    def test_bun_discovery_matches_the_test_directory(self):
        daemon = os.path.join(REPO, "daemon")
        if not os.path.isdir(daemon):
            self.skipTest("daemon/ 없음")
        files = run_checks.discover_bun_tests(daemon)
        self.assertTrue(files)
        self.assertTrue(all(f.startswith("test/") for f in files))
        self.assertIn("test/wiring.test.ts", files)

    def test_bun_discovery_skips_node_modules(self):
        """의존성 안의 테스트 파일까지 돌면 우리 코드와 무관한 실패가 섞인다."""
        d = tempfile.mkdtemp(prefix="ah-bun-")
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, "node_modules", "pkg"))
        os.makedirs(os.path.join(d, "test"))
        for p in (os.path.join(d, "node_modules", "pkg", "a.test.ts"),
                  os.path.join(d, "test", "b.test.ts"),
                  os.path.join(d, "test", "c.spec.ts"),
                  os.path.join(d, "test", "notatest.ts")):
            with io.open(p, "w", encoding="utf-8") as fh:
                fh.write("")
        self.assertEqual(run_checks.discover_bun_tests(d), ["test/b.test.ts", "test/c.spec.ts"])


class SchedulingTest(unittest.TestCase):
    def test_longest_first_when_timings_are_known(self):
        """최장 단위가 마지막에 출발하면 그만큼 전체가 늘어난다."""
        units = [run_checks.Unit(n, "python", ["echo"], REPO) for n in ("짧음", "김", "중간")]
        ordered = run_checks.order_units(units, {"김": 20.0, "중간": 5.0, "짧음": 0.1})
        self.assertEqual([u.name for u in ordered], ["김", "중간", "짧음"])

    def test_unknown_timings_keep_plan_order(self):
        units = [run_checks.Unit(n, "python", ["echo"], REPO) for n in ("a", "b", "c")]
        self.assertEqual([u.name for u in run_checks.order_units(units, {})], ["a", "b", "c"])

    def test_corrupt_timing_cache_does_not_break_anything(self):
        original = run_checks.TIMING_CACHE
        d = tempfile.mkdtemp(prefix="ah-timing-")
        self.addCleanup(shutil.rmtree, d, True)
        run_checks.TIMING_CACHE = os.path.join(d, "checks-timing.json")
        self.addCleanup(setattr, run_checks, "TIMING_CACHE", original)
        with io.open(run_checks.TIMING_CACHE, "w", encoding="utf-8") as fh:
            fh.write("{깨졌다")
        self.assertEqual(run_checks.load_timings(), {})

    def test_default_jobs_is_at_least_two(self):
        self.assertGreaterEqual(run_checks.default_jobs(), 2)


class ContractTest(unittest.TestCase):
    def test_serial_flag_exists_as_a_fallback(self):
        with io.open(os.path.join(SCRIPTS, "run_checks.py"), encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("--serial", source)
        self.assertIn("--jobs", source)

    def test_deploy_stage_still_exists_and_is_last(self):
        """deploy 는 앞 단계를 전부 통과한 코드만 반영한다 — 순서가 계약이다."""
        with io.open(os.path.join(SCRIPTS, "run_checks.py"), encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("def stage_deploy", source)
        units_at = source.index("checks: units")
        deploy_at = source.index("checks: deploy")
        self.assertLess(units_at, deploy_at)
        # 실패가 하나라도 있으면 deploy 에 닿기 전에 돌아간다
        self.assertLess(source.index("단계 실패: units"), deploy_at)


if __name__ == "__main__":
    unittest.main()
