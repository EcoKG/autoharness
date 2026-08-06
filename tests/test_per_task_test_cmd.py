# -*- coding: utf-8 -*-
"""작업별 test_cmd 회귀 테스트 — 사장돼 있던 스키마 필드의 활성화.

task.test_cmd 는 러너가 이미 전역 commands.test 보다 우선해 읽지만 설정 수단이
없었다. add-task/set-task CLI 인자와 MCP task_add/task_set 입력 노출을 검증한다.
전역 test 를 실패 명령으로 두고 작업 전용 명령으로 통과시키는 방식으로
'작업 명령이 실제로 쓰였음'을 증명한다.
"""

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
for _p in (REPO, BIN):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import harness_engine as eng  # noqa: E402
import harness_mcp as mcp  # noqa: E402
from tests.test_engine_hooks import HookSandboxTest, OK_CMD, FAIL_CMD, PY  # noqa: E402


class PerTaskTestCmdCliTest(HookSandboxTest):
    def init_with_global(self, test_cmd):
        r = self.engine("init", "--project", "ttc", "--objective", "작업별 test_cmd 검증",
                        "--source", "A", "--target", "B", "--test", test_cmd)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_add_task_stores_and_run_prefers_task_cmd(self):
        self.init_with_global(FAIL_CMD)  # 전역 test 는 실패 명령
        r = self.engine("add-task", "--id", "t1", "--title", "작업 전용 명령", "--test-cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(eng.find_task(self.read_tracker(), "t1")["test_cmd"], OK_CMD)
        r = self.engine("run", "--task", "t1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)  # 작업 명령이 쓰였음이 증명된다

    def test_path_substitution_in_task_cmd(self):
        self.init_with_global(FAIL_CMD)
        probe = '"%s" -c "import sys; sys.exit(0 if \'{path}\' == \'modA\' else 1)"' % PY
        r = self.engine("add-task", "--id", "t1", "--title", "치환 검증",
                        "--path", "modA", "--test-cmd", probe)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.engine("run", "--task", "t1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_set_task_sets_then_clears(self):
        self.init_with_global(FAIL_CMD)
        r = self.engine("add-task", "--id", "t1", "--title", "나중 설정")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.engine("run", "--task", "t1")
        self.assertEqual(r.returncode, 1, r.stdout)  # 전역 실패 명령 사용 확인
        r = self.engine("set-task", "--id", "t1", "--test-cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(eng.find_task(self.read_tracker(), "t1")["test_cmd"], OK_CMD)
        r = self.engine("run", "--task", "t1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        r = self.engine("set-task", "--id", "t1", "--test-cmd", "")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNone(eng.find_task(self.read_tracker(), "t1")["test_cmd"])

    def test_pending_reset_preserves_test_cmd(self):
        self.init_with_global(OK_CMD)
        self.engine("add-task", "--id", "t1", "--title", "보존 검증", "--test-cmd", OK_CMD)
        r = self.engine("set-task", "--id", "t1", "--status", "pending")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(eng.find_task(self.read_tracker(), "t1")["test_cmd"], OK_CMD)


class PerTaskTestCmdMcpTest(unittest.TestCase):
    """MCP task_add/task_set 입력 노출 — 임시 레지스트리로 사용자 상태 격리."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-ttcmcp-")
        self.repo = os.path.join(self.dir, "repo")
        os.makedirs(self.repo)
        patcher = mock.patch.object(mcp, "REGISTRY_PATH",
                                    os.path.join(self.dir, "registry.json"))
        patcher.start()
        self.addCleanup(patcher.stop)
        code, out, err = mcp.run_engine_argv(
            ["init", "--repo", self.repo, "--project", "ttcmcp", "--objective", "검증",
             "--source", "A", "--target", "B", "--test", "echo ok"])
        self.assertEqual(code, 0, err)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def task(self, tid):
        return eng.find_task(eng.load_json(eng.rp(self.repo)["tracker"]), tid)

    def test_task_add_and_set_roundtrip(self):
        mcp.tool_task_add({"repo_path": self.repo, "id": "t1", "title": "MCP 작업",
                           "test_cmd": OK_CMD})
        self.assertEqual(self.task("t1")["test_cmd"], OK_CMD)
        mcp.tool_task_set({"repo_path": self.repo, "id": "t1", "test_cmd": FAIL_CMD})
        self.assertEqual(self.task("t1")["test_cmd"], FAIL_CMD)
        mcp.tool_task_set({"repo_path": self.repo, "id": "t1", "test_cmd": ""})
        self.assertIsNone(self.task("t1")["test_cmd"])


if __name__ == "__main__":
    unittest.main()
