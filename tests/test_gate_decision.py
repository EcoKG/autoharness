# -*- coding: utf-8 -*-
"""게이트 컨텍스트 판정 회귀 테스트.

해소한 모순: 위험 모델은 "사람이 없을 때 에이전트가 되돌릴 수 없는 일을 하는 것"인데,
종전 구현은 금지 명령을 무조건 exit 2 로 막아 **사람이 눈앞에서 지시한 경우까지** 덮었다.
같은 파일의 hook-stop 은 CLAUDE_AUTOHARNESS 로 헤드리스를 식별해 대화형을 건드리지
않는데 금지 명령 차단만 그 구분이 없었다. 부수적으로 커밋 게이트는 HARNESS_PAUSED 를
존중하는데 금지 명령 차단은 존중하지 않는 비일관도 있었다.

여기서 고정하는 계약 — 두 게이트가 같은 판정 함수를 쓴다:
  헤드리스(CLAUDE_AUTOHARNESS=1) → deny : 물어볼 사람이 없으므로 하드 차단
  대화형                          → ask  : 사용자 승인 창으로 승격
  일시정지 중                     → ask  : 사람이 직접 운전 중이므로 하드 차단하지 않음
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402

ENGINE = os.path.join(BIN, "harness_engine.py")
PY = sys.executable
OK_CMD = '"%s" -c "print(\'ok\')"' % PY
FAIL_CMD = '"%s" -c "import sys; sys.exit(1)"' % PY


class GateSandbox(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-gate-")
        self.paths = eng.rp(self.sandbox)
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        self._saved_env = os.environ.get("CLAUDE_AUTOHARNESS")
        os.environ.pop("CLAUDE_AUTOHARNESS", None)

    def tearDown(self):
        if self._saved_env is None:
            os.environ.pop("CLAUDE_AUTOHARNESS", None)
        else:
            os.environ["CLAUDE_AUTOHARNESS"] = self._saved_env

        def onerr(func, path, exc_info):
            try:
                os.chmod(path, stat.S_IWRITE)
                func(path)
            except OSError:
                pass
        shutil.rmtree(self.sandbox, onerror=onerr)
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def set_headless(self, on):
        if on:
            os.environ["CLAUDE_AUTOHARNESS"] = "1"
        else:
            os.environ.pop("CLAUDE_AUTOHARNESS", None)

    def pause(self):
        with open(self.paths["paused_flag"], "w", encoding="utf-8") as f:
            f.write("")


class DecisionMatrixTest(GateSandbox):
    """판정 함수 자체 — 환경 조합을 직접 넣는다."""

    def test_headless_denies(self):
        self.set_headless(True)
        self.assertEqual(eng.gate_decision(self.sandbox), eng.GATE_DENY)

    def test_interactive_asks(self):
        self.set_headless(False)
        self.assertEqual(eng.gate_decision(self.sandbox), eng.GATE_ASK)

    def test_paused_asks_even_when_headless(self):
        self.set_headless(True)
        self.pause()
        self.assertEqual(eng.gate_decision(self.sandbox), eng.GATE_ASK)

    def test_paused_asks_when_interactive(self):
        self.set_headless(False)
        self.pause()
        self.assertEqual(eng.gate_decision(self.sandbox), eng.GATE_ASK)

    def test_headless_detection_requires_exact_value(self):
        for value, expected in (("1", True), ("0", False), ("true", False), ("", False)):
            os.environ["CLAUDE_AUTOHARNESS"] = value
            self.assertEqual(eng.is_headless_session(), expected, value)
        os.environ.pop("CLAUDE_AUTOHARNESS", None)
        self.assertFalse(eng.is_headless_session())

    def test_stop_gate_uses_same_headless_criterion(self):
        """모순의 근원은 두 게이트가 다른 기준을 쓴 것 — 같은 함수를 보는지 확인한다."""
        with open(os.path.join(BIN, "harness_engine.py"), encoding="utf-8") as f:
            source = f.read()
        # hook-stop 과 gate_decision 이 모두 동일 상수를 참조해야 한다
        self.assertEqual(source.count('os.environ.get("CLAUDE_AUTOHARNESS")'), 2,
                         "헤드리스 식별이 두 곳(hook-stop, is_headless_session) 외에 흩어져 있습니다")


class CommitGateReasonTest(GateSandbox):
    """커밋 게이트가 걸리는 조건 — 사유 문자열이 있으면 게이트, None 이면 통과."""

    def engine(self, *args):
        return subprocess.run([PY, ENGINE] + list(args) + ["--repo", self.sandbox],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)

    def init(self, tasks=("t1",)):
        self.engine("init", "--project", "gate", "--objective", "o",
                    "--source", "A", "--target", "B", "--test", OK_CMD)
        for t in tasks:
            self.engine("add-task", "--id", t, "--title", t)

    def test_no_tracker_no_gate(self):
        self.assertIsNone(eng.commit_gate_reason(self.sandbox))

    def test_no_active_task_no_gate(self):
        self.init()                       # pending 은 active 가 아니다
        self.assertIsNone(eng.commit_gate_reason(self.sandbox))

    def test_failed_task_without_pass_gates(self):
        self.init()
        self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        reason = eng.commit_gate_reason(self.sandbox)
        self.assertIsNotNone(reason)
        self.assertIn("t1", reason)

    def test_passing_run_clears_gate(self):
        self.init()
        self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertIsNone(eng.commit_gate_reason(self.sandbox))

    def test_paused_clears_gate(self):
        self.init()
        self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        self.assertIsNotNone(eng.commit_gate_reason(self.sandbox))
        self.pause()
        self.assertIsNone(eng.commit_gate_reason(self.sandbox))


class EmitShapeTest(unittest.TestCase):
    """ask 출력이 훅 계약(hookSpecificOutput.permissionDecision)을 정확히 따르는지."""

    def emit(self, decision):
        r = subprocess.run(
            [PY, "-c",
             "import sys; sys.path.insert(0, %r); import harness_engine as e;"
             "e.emit_gate(%r, '사유 문자열', 'some command')" % (BIN, decision)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        return r

    def test_ask_shape(self):
        r = self.emit(eng.GATE_ASK)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "PreToolUse")
        self.assertEqual(out["permissionDecision"], "ask")
        self.assertIn("사유 문자열", out["permissionDecisionReason"])

    def test_deny_shape(self):
        r = self.emit(eng.GATE_DENY)
        self.assertEqual(r.returncode, 2)
        self.assertIn("차단", r.stderr)
        self.assertIn("사유 문자열", r.stderr)
        self.assertEqual(r.stdout.strip(), "", "deny 는 stdout 을 쓰지 않는다")


if __name__ == "__main__":
    unittest.main()
