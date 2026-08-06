# -*- coding: utf-8 -*-
"""장부 작업 그래프 회귀 테스트 — add-task 의존성 검증과 교착 pending 알림.

원 결함: cmd_add_task 의 `d != a.id` 조건이 자기 의존을 미존재 검사에서 제외해
그대로 통과시켰다 — 자기 의존 작업은 deps 가 영영 충족되지 않는 영구 교착이 된다.
여기서는 자기/순환/미존재 의존의 거부와, 이미 들어간 교착 작업을 next/brief/status
가 구분해 알리는 동작을 실측 검증한다.
"""

import json
import os
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
for _p in (REPO, BIN):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import harness_engine as eng  # noqa: E402
from tests.test_engine_hooks import HookSandboxTest  # noqa: E402


class AddTaskValidationTest(HookSandboxTest):
    """add-task 시점 거부 — 자기 의존·미존재 의존·순환 완성."""

    def test_rejects_self_dependency(self):
        self.init_tracker()
        r = self.engine("add-task", "--id", "t1", "--title", "자기 의존", "--deps", "t1")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("자기 자신", r.stderr)
        self.assertIsNone(eng.find_task(self.read_tracker(), "t1"))

    def test_rejects_self_dependency_among_others(self):
        # 원 결함 재현 형태: 정상 의존과 섞여 있어도 자기 의존은 거부돼야 한다
        self.init_tracker(["t0"])
        r = self.engine("add-task", "--id", "t1", "--title", "혼합 의존", "--deps", "t0,t1")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIsNone(eng.find_task(self.read_tracker(), "t1"))

    def test_rejects_unknown_dependency(self):
        self.init_tracker()
        r = self.engine("add-task", "--id", "t1", "--title", "미존재 의존", "--deps", "ghost")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("존재하지 않는 의존", r.stderr)

    def test_rejects_cycle_completion(self):
        # 손편집으로 t1 이 아직 없는 t2 를 참조하는 상태에서 t2 --deps t1 을 추가하면 순환 완성
        self.init_tracker(["t1"])
        tr = self.read_tracker()
        eng.find_task(tr, "t1")["deps"] = ["t2"]
        eng.atomic_write_json(self.paths["tracker"], tr)
        r = self.engine("add-task", "--id", "t2", "--title", "순환 완성", "--deps", "t1")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("순환", r.stderr)
        self.assertIsNone(eng.find_task(self.read_tracker(), "t2"))


class DeadlockReportTest(HookSandboxTest):
    """이미 장부에 있는 교착 pending 을 next/brief/status 가 구분해 알린다."""

    def setup_blocked_dep(self):
        """t1(blocked) ← t2(pending) 교착 구도."""
        self.init_tracker(["t1"])
        r = self.engine("add-task", "--id", "t2", "--title", "후행 작업", "--deps", "t1")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.engine("set-task", "--id", "t1", "--status", "blocked", "--note", "사람 판단 필요")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_next_reports_deadlock_when_no_task(self):
        self.setup_blocked_dep()
        r = self.engine("next")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        data = json.loads(r.stdout)
        self.assertIsNone(data["next"])
        self.assertEqual(data.get("deadlocked"), ["t2"])

    def test_next_reports_deadlock_alongside_next_task(self):
        self.setup_blocked_dep()
        r = self.engine("add-task", "--id", "t3", "--title", "독립 작업")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.engine("next")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["next"]["id"], "t3")
        self.assertEqual(data.get("deadlocked"), ["t2"])

    def test_brief_reports_deadlock(self):
        self.setup_blocked_dep()
        r = self.engine("brief")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("교착 pending", r.stdout)
        self.assertIn("t2", r.stdout)

    def test_status_reports_deadlock(self):
        self.setup_blocked_dep()
        r = self.engine("status")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout).get("deadlocked"), ["t2"])

    def test_legacy_self_dependency_is_reported(self):
        # 구버전 결함으로 이미 들어간 자기 의존 작업(손편집 재현)도 교착으로 알린다
        self.init_tracker(["t1"])
        tr = self.read_tracker()
        eng.find_task(tr, "t1")["deps"] = ["t1"]
        eng.atomic_write_json(self.paths["tracker"], tr)
        r = self.engine("next")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout).get("deadlocked"), ["t1"])


class DeadlockFunctionTest(unittest.TestCase):
    """deadlocked_pending / deps_reach 순수 함수 검증(서브프로세스 없음)."""

    @staticmethod
    def tracker_of(*tasks):
        return {"max_attempts": 5, "tasks": list(tasks)}

    @staticmethod
    def task(id_, deps=(), status="pending"):
        t = eng.new_task(id_, id_ + " 제목", None, list(deps), 100)
        t["status"] = status
        return t

    def test_retryable_failed_dep_is_not_deadlock(self):
        tr = self.tracker_of(self.task("t1", status="failed"), self.task("t2", deps=["t1"]))
        self.assertEqual(deadlocked_ids(tr), [])

    def test_blocked_dep_chain_is_deadlock(self):
        tr = self.tracker_of(self.task("t1", status="blocked"), self.task("t2", deps=["t1"]),
                             self.task("t3", deps=["t2"]))
        self.assertEqual(deadlocked_ids(tr), ["t2", "t3"])

    def test_cycle_pair_is_deadlock(self):
        tr = self.tracker_of(self.task("t1", deps=["t2"]), self.task("t2", deps=["t1"]))
        self.assertEqual(deadlocked_ids(tr), ["t1", "t2"])

    def test_dangling_dep_is_deadlock(self):
        tr = self.tracker_of(self.task("t2", deps=["ghost"]))
        self.assertEqual(deadlocked_ids(tr), ["t2"])

    def test_done_dep_is_satisfied(self):
        tr = self.tracker_of(self.task("t1", status="done"), self.task("t2", deps=["t1"]))
        self.assertEqual(deadlocked_ids(tr), [])

    def test_deps_reach_transitive(self):
        by_id = {t["id"]: t for t in (self.task("a", deps=["b"]), self.task("b", deps=["c"]),
                                      self.task("c"))}
        self.assertTrue(eng.deps_reach(by_id, ["a"], "c"))
        self.assertFalse(eng.deps_reach(by_id, ["c"], "a"))


def deadlocked_ids(tracker):
    return sorted(t["id"] for t in eng.deadlocked_pending(tracker))


if __name__ == "__main__":
    unittest.main()
