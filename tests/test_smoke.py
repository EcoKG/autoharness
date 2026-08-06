# -*- coding: utf-8 -*-
"""배선 확인용 스모크 테스트 — 본 스위트는 자율 주행 작업(tests-*)이 확충한다."""

import os
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402


class SmokeTest(unittest.TestCase):
    def test_exit_code_contract(self):
        self.assertEqual(
            (eng.EXIT_OK, eng.EXIT_FAIL, eng.EXIT_USAGE, eng.EXIT_NO_TASK, eng.EXIT_BLOCKED),
            (0, 1, 2, 3, 4))

    def test_allowed_models(self):
        self.assertEqual(set(eng.ALLOWED_MODELS), {"claude-opus-5", "claude-fable-5"})

    def test_new_task_schema(self):
        t = eng.new_task("x", "제목", "p", ["a"], 5)
        for key in ("id", "title", "path", "deps", "priority", "status", "attempts",
                    "last_error", "last_log_file", "commit", "started_at", "finished_at",
                    "test_cmd"):
            self.assertIn(key, t)
        self.assertEqual(t["status"], "pending")
        self.assertEqual(t["attempts"], 0)


if __name__ == "__main__":
    unittest.main()
