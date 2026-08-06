# -*- coding: utf-8 -*-
"""completed 프로젝트 재활성화 회귀 테스트 — MCP task_add 의 레지스트리 전이.

원 결함: 주행 완료 후(레지스트리 status=completed) 장부에 새 작업을 추가해도
워치독 기동 대상으로 돌아오지 않아 영영 재기동하지 않았다. task_add 성공 시
completed → active 전이 + 백오프 리셋을 검증한다. paused(사용자 의사)·
needs_human(사람 판단 대기)·error(진단 필요)는 자동 재개하면 안 된다.

REGISTRY_PATH 를 임시 경로로 패치해 실제 사용자 레지스트리를 오염시키지 않는다.
"""

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_mcp as mcp  # noqa: E402


class RegistryReactivationTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-regtest-")
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.repo)
        patcher = mock.patch.object(mcp, "REGISTRY_PATH",
                                    os.path.join(self.dir, "registry.json"))
        patcher.start()
        self.addCleanup(patcher.stop)
        code, out, err = mcp.run_engine_argv(
            ["init", "--repo", self.repo, "--project", "regtest", "--objective", "재활성화 검증",
             "--source", "A", "--target", "B", "--test", "echo ok"])
        self.assertEqual(code, 0, err)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def seed_registry(self, status, consecutive_errors=3, limit_hits=2):
        reg = mcp.default_registry()
        reg["projects"].append({
            "id": "regtest", "repo": os.path.abspath(self.repo), "model": "claude-opus-5",
            "permission_args": [], "status": status,
            "consecutive_errors": consecutive_errors, "limit_hits": limit_hits,
            "next_retry_at": "2026-01-01T00:00:00+00:00",
            "last_launch": {"ts": None, "result": None, "log": None},
            "created_at": mcp.now_iso(), "updated_at": mcp.now_iso()})
        mcp.registry_save(reg)

    def entry(self):
        return mcp.registry_find(mcp.registry_load(), self.repo)

    def add_task(self, tid="t1", **extra):
        args = {"repo_path": self.repo, "id": tid, "title": tid + " 제목"}
        args.update(extra)
        return mcp.tool_task_add(args)

    def test_completed_is_reactivated_with_backoff_reset(self):
        self.seed_registry("completed")
        result = self.add_task()
        self.assertTrue(result.get("registry_reactivated"))
        e = self.entry()
        self.assertEqual(e["status"], "active")
        self.assertEqual(e["consecutive_errors"], 0)
        self.assertEqual(e["limit_hits"], 0)
        self.assertIsNone(e["next_retry_at"])

    def test_paused_needs_human_error_stay_untouched(self):
        for status in ("paused", "needs_human", "error"):
            self.seed_registry(status)
            result = self.add_task("task-" + status)
            self.assertNotIn("registry_reactivated", result, status)
            e = self.entry()
            self.assertEqual(e["status"], status)
            self.assertEqual(e["consecutive_errors"], 3, status)  # 백오프도 보존
            self.assertEqual(e["limit_hits"], 2, status)

    def test_active_counters_are_preserved(self):
        self.seed_registry("active")
        result = self.add_task()
        self.assertNotIn("registry_reactivated", result)
        e = self.entry()
        self.assertEqual(e["status"], "active")
        self.assertEqual(e["consecutive_errors"], 3)

    def test_failed_add_does_not_reactivate(self):
        self.seed_registry("completed")
        with self.assertRaises(mcp.ToolError):
            self.add_task("t-bad", deps=["ghost"])  # 미존재 의존 → 엔진이 거부
        self.assertEqual(self.entry()["status"], "completed")

    def test_unregistered_repo_is_harmless(self):
        result = self.add_task()  # 레지스트리에 항목 없음
        self.assertNotIn("registry_reactivated", result)
        self.assertIsNone(self.entry())


if __name__ == "__main__":
    unittest.main()
