# -*- coding: utf-8 -*-
"""워치독 단위 테스트 — 판단 로직을 실측하되 부작용은 완전 격리.

검증 대상: is_usage_limited(429 문맥 오탐 방지 포함) · backoff_pick · pid_alive ·
단일 인스턴스 잠금(획득/생존 pid 거부/사망 pid·stale 탈취) · handle_project 판단
순서(§10) · main 의 --registry 오버라이드 + --dry-run 경로.

금지 사항 준수: 실제 스케줄러 등록 없음, claude 기동 없음(기동 경로는 dry-run 만),
실 레지스트리(~/.claude/autoharness/registry.json) 접근 없음(항상 임시 --registry).
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402
import harness_watchdog as wd  # noqa: E402


class UsageLimitPatternTest(unittest.TestCase):
    def test_detects_usage_limit_phrases(self):
        for text in ("Usage limit reached for this session",
                     "usage_limit: try again later",
                     "rate limit exceeded",
                     "rate_limit_error",
                     "Too Many Requests",
                     "the server is overloaded",
                     "monthly quota exhausted",
                     "Your credit balance is too low",
                     "you are out of extra usage",
                     "API Error 429",
                     "api_error: 429",
                     "status: 429",
                     "HTTP 429 returned",
                     "error code 429"):
            self.assertTrue(wd.is_usage_limited(text), text)

    def test_bare_429_is_not_a_limit(self):
        # 문맥 없는 429 는 오탐이다 — pytest 의 "collected 429 items" 실측 사례
        for text in ("collected 429 items",
                     "429 tests passed",
                     "finished in 429ms",
                     "commit 4290abc pushed"):
            self.assertFalse(wd.is_usage_limited(text), text)

    def test_identifier_occurrences_are_not_limits(self):
        """`overloaded`·`quota` 가 맨몸이라 테스트 이름·모듈명에 걸리던 오분류(적대 검증)."""
        for text in ("test_overloaded_queue ... ok",
                     "FAILED tests/test_quota.py::test_overloaded",
                     "quota management module loaded",
                     "disk quota check passed",
                     "AssertionError: expected 429 got 200 in fixture"):
            self.assertFalse(wd.is_usage_limited(text), text)

    def test_real_overload_and_quota_still_detected(self):
        """오탐을 줄이려다 진짜 과부하를 놓치면 error 경로로 빠져 5회 뒤 정지한다 — 미탐이 더 비싸다."""
        for text in ('{"type":"error","error":{"type":"overloaded_error"}}',
                     "the server is overloaded",
                     "monthly quota exhausted",
                     "quota exceeded for this org",
                     "api_error: quota exceeded"):
            self.assertTrue(wd.is_usage_limited(text), text)

    def test_empty_and_none_are_false(self):
        self.assertFalse(wd.is_usage_limited(""))
        self.assertFalse(wd.is_usage_limited(None))


class LimitEscalationTest(unittest.TestCase):
    """limit 분기는 영구 포기하지 않지만, 계속 이어지면 오분류 신호를 남겨야 한다.

    종전에는 상한도 신호도 없어, 오분류된 상태가 360분 간격으로 영원히 반복되며 사람에게
    아무것도 알리지 않았다 — error 분기가 5회로 정지하는 것과 대조되는 비일관이었다."""

    def test_notice_threshold_exists(self):
        self.assertGreaterEqual(wd.LIMIT_NOTICE_HITS, 2)

    def test_attention_flag_set_after_repeated_limits(self):
        proj = {"id": "p", "limit_hits": wd.LIMIT_NOTICE_HITS}
        # 임계 이상이면 needs_attention 이 붙는다(launch_project 의 limit 분기와 동일 조건)
        self.assertGreaterEqual(proj["limit_hits"], wd.LIMIT_NOTICE_HITS)

    def test_status_stays_active_on_limit(self):
        """영구 포기 없음 원칙 — 신호는 남기되 status 는 건드리지 않는다."""
        import inspect
        src = inspect.getsource(wd.launch_project)
        limit_block = src.split("is_usage_limited")[1].split("mark_error")[0]
        self.assertNotIn('proj["status"]', limit_block,
                         "limit 분기가 status 를 바꾸면 영구 포기 없음 원칙이 깨집니다")
        self.assertIn("needs_attention", limit_block)


class BackoffPickTest(unittest.TestCase):
    def test_sequence_walk_and_clamp(self):
        seq = [30, 60, 120, 240, 360]
        self.assertEqual(wd.backoff_pick(seq, 1), 30)
        self.assertEqual(wd.backoff_pick(seq, 2), 60)
        self.assertEqual(wd.backoff_pick(seq, 5), 360)
        self.assertEqual(wd.backoff_pick(seq, 6), 360)    # 끝 넘으면 마지막 고정
        self.assertEqual(wd.backoff_pick(seq, 100), 360)

    def test_nth_floor_and_empty_seq(self):
        self.assertEqual(wd.backoff_pick([15, 30], 0), 15)   # nth 하한 1
        self.assertEqual(wd.backoff_pick([15, 30], -3), 15)
        self.assertEqual(wd.backoff_pick([], 1), 30)         # 빈 수열 기본값


class PidAliveTest(unittest.TestCase):
    def test_own_pid_is_alive(self):
        self.assertTrue(wd.pid_alive(os.getpid()))

    def test_live_child_then_dead_child(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.assertTrue(wd.pid_alive(child.pid))
        finally:
            child.terminate()
            child.wait(timeout=15)
        self.assertFalse(wd.pid_alive(child.pid))

    def test_invalid_inputs_are_false(self):
        for bad in (None, "", "abc", -1, 0):
            self.assertFalse(wd.pid_alive(bad), repr(bad))


class WatchdogLockTest(unittest.TestCase):
    def setUp(self):
        self.runtime = tempfile.mkdtemp(prefix="ah-wdlock-")
        self.msgs = []
        self.log = lambda p, d, det: self.msgs.append((p, d, det))

    def tearDown(self):
        shutil.rmtree(self.runtime, ignore_errors=True)

    def lock_file(self):
        return wd.lock_path(self.runtime)

    def test_acquire_fresh_and_release(self):
        self.assertTrue(wd.acquire_lock(self.runtime, self.log))
        with open(self.lock_file(), "r", encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), str(os.getpid()))
        wd.release_lock(self.runtime)
        self.assertFalse(os.path.exists(self.lock_file()))

    def test_live_pid_lock_is_respected(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            os.makedirs(self.runtime, exist_ok=True)
            with open(self.lock_file(), "w", encoding="utf-8") as f:
                f.write(str(child.pid))
            self.assertFalse(wd.acquire_lock(self.runtime, self.log))
            self.assertTrue(any(d == "lock" and "실행 중" in det for _, d, det in self.msgs))
        finally:
            child.terminate()
            child.wait(timeout=15)

    def test_dead_pid_lock_is_taken_over(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait(timeout=15)
        os.makedirs(self.runtime, exist_ok=True)
        with open(self.lock_file(), "w", encoding="utf-8") as f:
            f.write(str(child.pid))
        self.assertTrue(wd.acquire_lock(self.runtime, self.log))
        with open(self.lock_file(), "r", encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), str(os.getpid()))
        self.assertTrue(any(d == "lock" and "사망" in det for _, d, det in self.msgs))

    def test_stale_mtime_lock_is_taken_over_even_if_pid_alive(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            os.makedirs(self.runtime, exist_ok=True)
            with open(self.lock_file(), "w", encoding="utf-8") as f:
                f.write(str(child.pid))
            old = time.time() - (wd.LOCK_STALE_SEC + 60)
            os.utime(self.lock_file(), (old, old))
            self.assertTrue(wd.acquire_lock(self.runtime, self.log))
            self.assertTrue(any(d == "lock" and "탈취" in det for _, d, det in self.msgs))
        finally:
            child.terminate()
            child.wait(timeout=15)


class HandleProjectTest(unittest.TestCase):
    """DESIGN §10 판단 순서 — 기동이 일어날 수 있는 6단계는 dry-run 으로만 확인한다."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-wdproj-")
        self.runtime = os.path.join(self.dir, "runtime")
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.runtime)
        os.makedirs(self.repo)
        self.settings = wd.default_settings()
        self.msgs = []
        self.log = lambda p, d, det: self.msgs.append((p, d, det))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def project(self, **over):
        proj = {"id": "p1", "repo": self.repo, "model": "claude-opus-5",
                "permission_args": [], "status": "active", "consecutive_errors": 0,
                "limit_hits": 0, "next_retry_at": None,
                "last_launch": {"ts": None, "result": None, "log": None},
                "created_at": eng.now_iso(), "updated_at": eng.now_iso()}
        proj.update(over)
        return proj

    def write_tracker(self, tasks):
        tracker = {"schema_version": 1, "project": "p1", "max_attempts": 5,
                   "commands": {"test": "echo ok"}, "tasks": tasks}
        eng.atomic_write_json(eng.rp(self.repo)["tracker"], tracker)

    def handle(self, proj, dry_run=True):
        return wd.handle_project(proj, self.settings, self.runtime, 1, dry_run, self.log)

    def decisions(self):
        return [d for _, d, _ in self.msgs]

    def test_step1_non_active_is_skipped(self):
        for status in ("paused", "needs_human", "error", "completed"):
            self.msgs.clear()
            proj = self.project(status=status)
            self.assertFalse(self.handle(proj, dry_run=False))
            self.assertEqual(self.decisions(), ["skip"], status)

    def test_step2_future_backoff_is_skipped(self):
        future = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        proj = self.project(next_retry_at=future)
        self.assertFalse(self.handle(proj, dry_run=False))
        self.assertIn("백오프", self.msgs[0][2])

    def test_step2_5_paused_flag_is_skipped(self):
        self.write_tracker([eng.new_task("t1", "작업")])
        flag = eng.rp(self.repo)["paused_flag"]
        os.makedirs(os.path.dirname(flag), exist_ok=True)
        with open(flag, "w", encoding="utf-8") as f:
            f.write("")
        proj = self.project()
        self.assertFalse(self.handle(proj, dry_run=False))
        self.assertIn("HARNESS_PAUSED", self.msgs[0][2])

    def test_step3_missing_tracker_counts_error(self):
        proj = self.project(consecutive_errors=0)
        # dry-run: 판단만, 카운터 불변
        self.assertFalse(self.handle(proj, dry_run=True))
        self.assertEqual(proj["consecutive_errors"], 0)
        self.assertIn("(dry-run)", self.msgs[0][2])
        # 실행: consecutive_errors 증가 + 백오프 예약, active 유지(한도 미만)
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["consecutive_errors"], 1)
        self.assertIsNotNone(proj["next_retry_at"])
        self.assertEqual(proj["status"], "active")

    def test_step3_error_limit_stops_project(self):
        proj = self.project(consecutive_errors=self.settings["max_consecutive_errors"] - 1)
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "error")

    def test_step4_no_task_transitions_completed(self):
        self.write_tracker([dict(eng.new_task("t1", "완료 작업"), status="done")])
        proj = self.project()
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "completed")

    def test_step4_blocked_transitions_needs_human(self):
        self.write_tracker([dict(eng.new_task("t1", "봉인 작업"), status="blocked")])
        proj = self.project()
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "needs_human")

    def test_step1_completed_revives_when_work_appears(self):
        """DESIGN 7 절이 'completed 는 종점이 아니다' 라고 못박았는데 워치독만 이를 몰랐다.

        재활성화가 MCP task_add 에만 걸려 있어, 엔진 CLI(SKILL 폴백 경로)나 손편집으로
        작업을 넣으면 레지스트리가 completed 로 남아 영영 기동하지 않았다."""
        self.write_tracker([eng.new_task("t1", "새 작업")])
        proj = self.project(status="completed")
        self.handle(proj, dry_run=False)
        self.assertEqual(proj["status"], "active")
        self.assertIn("재활성화", self.msgs[0][2])

    def test_step1_completed_stays_when_no_work(self):
        """대조군 — 진행 가능 작업이 없으면 되살리지 않는다."""
        self.write_tracker([dict(eng.new_task("t1", "완료"), status="done")])
        proj = self.project(status="completed")
        self.assertFalse(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "completed")

    def test_step1_other_statuses_are_not_revived(self):
        """paused·needs_human·error 는 작업 추가만으로 자동 재개하지 않는다(DESIGN 7 절)."""
        self.write_tracker([eng.new_task("t1", "새 작업")])
        for status in ("paused", "needs_human", "error"):
            proj = self.project(status=status)
            self.assertFalse(self.handle(proj, dry_run=False))
            self.assertEqual(proj["status"], status)

    def test_step1_dry_run_does_not_revive(self):
        self.write_tracker([eng.new_task("t1", "새 작업")])
        proj = self.project(status="completed")
        self.assertFalse(self.handle(proj, dry_run=True))
        self.assertEqual(proj["status"], "completed")
        self.assertIn("(dry-run)", self.msgs[0][2])

    def test_step4_empty_tracker_does_not_complete(self):
        """init 직후 빈 장부를 '완료' 로 봉인하면 이후 작업을 넣어도 영영 안 뜬다(실측 결함)."""
        self.write_tracker([])
        proj = self.project()
        self.assertFalse(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "active", "빈 장부가 completed 로 봉인됐습니다")
        self.assertIn("적재 대기", self.msgs[0][2])

    def test_step4_deadlocked_pending_is_needs_human(self):
        """엔진이 1급 개념으로 다루는 교착 pending 을 종점 판정도 봐야 한다."""
        self.write_tracker([dict(eng.new_task("t1", "교착 작업"), deps=["없는작업"])])
        proj = self.project()
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "needs_human")
        self.assertIn("교착", self.msgs[0][2])

    def test_step4_deadlock_with_done_still_needs_human(self):
        self.write_tracker([
            dict(eng.new_task("t1", "완료"), status="done"),
            dict(eng.new_task("t2", "교착"), deps=["없는작업"]),
        ])
        proj = self.project()
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "needs_human")

    def test_step4_all_done_still_completes(self):
        """대조군 — 진짜 완료는 종전대로 completed 다."""
        self.write_tracker([dict(eng.new_task("t1", "완료"), status="done")])
        proj = self.project()
        self.assertTrue(self.handle(proj, dry_run=False))
        self.assertEqual(proj["status"], "completed")

    def test_step5_fresh_heartbeat_is_skipped(self):
        self.write_tracker([eng.new_task("t1", "작업")])
        eng.write_heartbeat(self.repo, "test")  # 현재 시각 — 신선
        proj = self.project()
        self.assertFalse(self.handle(proj, dry_run=False))
        self.assertIn("하트비트 신선", self.msgs[0][2])

    def test_step6_launch_target_reported_in_dry_run(self):
        self.write_tracker([eng.new_task("t1", "작업")])
        stale = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        eng.atomic_write_json(eng.rp(self.repo)["heartbeat"], {"ts": stale, "pid": 0, "source": "test"})
        proj = self.project()
        self.assertFalse(self.handle(proj, dry_run=True))   # dry-run 은 기동하지 않는다
        self.assertEqual(self.msgs[-1][1], "launch")
        self.assertIn("(dry-run)", self.msgs[-1][2])
        self.assertIn("t1", self.msgs[-1][2])


class WatchdogMainTest(unittest.TestCase):
    """main — 임시 --registry 오버라이드 + --dry-run/--status/파손 경로."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-wdmain-")
        self.registry = os.path.join(self.dir, "runtime", "registry.json")
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.repo)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def seed(self, projects):
        eng.atomic_write_json(self.registry, {
            "schema_version": 1, "settings": wd.default_settings(), "projects": projects})

    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = wd.main(list(args) + ["--registry", self.registry])
        return rc, out.getvalue(), err.getvalue()

    def test_dry_run_reports_without_side_effects(self):
        tracker = {"schema_version": 1, "project": "p", "max_attempts": 5,
                   "commands": {"test": "echo ok"}, "tasks": [eng.new_task("t1", "작업")]}
        eng.atomic_write_json(eng.rp(self.repo)["tracker"], tracker)
        self.seed([
            {"id": "stopped", "repo": self.repo, "model": "claude-opus-5", "status": "paused",
             "permission_args": [], "consecutive_errors": 0, "limit_hits": 0, "next_retry_at": None},
            {"id": "runnable", "repo": self.repo, "model": "claude-opus-5", "status": "active",
             "permission_args": [], "consecutive_errors": 0, "limit_hits": 0, "next_retry_at": None},
        ])
        with open(self.registry, "rb") as f:
            before = f.read()
        rc, out, err = self.run_main("--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertIn("skip", out)
        self.assertIn("(dry-run) 기동 대상", out)
        with open(self.registry, "rb") as f:
            self.assertEqual(f.read(), before)  # dry-run 은 레지스트리를 쓰지 않는다
        self.assertFalse(os.path.exists(wd.lock_path(os.path.dirname(self.registry))))

    def test_missing_registry_is_created_with_defaults(self):
        rc, out, err = self.run_main("--dry-run")
        self.assertEqual(rc, 0, err)
        reg = eng.load_json(self.registry)
        self.assertEqual(reg["projects"], [])
        self.assertEqual(reg["settings"]["stale_minutes"], 30)

    def test_corrupted_registry_fails_loud_without_overwrite(self):
        os.makedirs(os.path.dirname(self.registry), exist_ok=True)
        with open(self.registry, "w", encoding="utf-8") as f:
            f.write("{ 이건 JSON 이 아니다")
        rc, out, err = self.run_main("--dry-run")
        self.assertEqual(rc, 2)
        self.assertIn("파손", err)
        with open(self.registry, "r", encoding="utf-8") as f:
            self.assertIn("이건 JSON 이 아니다", f.read())  # 덮어쓰지 않았다

    def test_status_prints_summary(self):
        self.seed([{"id": "p1", "repo": self.repo, "model": "claude-fable-5", "status": "active",
                    "permission_args": [], "consecutive_errors": 1, "limit_hits": 2,
                    "next_retry_at": None, "last_launch": {"ts": None, "result": None, "log": None}}])
        rc, out, err = self.run_main("--status")
        self.assertEqual(rc, 0, err)
        self.assertIn("p1", out)
        self.assertIn("status=active", out)


if __name__ == "__main__":
    unittest.main()
