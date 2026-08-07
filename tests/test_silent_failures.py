# -*- coding: utf-8 -*-
"""조용한 실패 회귀 테스트 — 실패했는데 성공처럼 보이는 경로들(적대 검증 확인).

이 프로젝트는 같은 이유로 이미 두 건을 고쳤다(훅 배선 비활성, 워치독 미실행). 여기서
고정하는 것은 세 건이다:

  ① 장부 파손이 게이트를 통째로 무력화한다 — 부재와 파손을 같은 None 으로 뭉개면
     장부가 깨졌을 때 커밋 게이트가 '장부 없음(수동 운용)'으로 보고 조용히 통과한다.
  ② 렌더 실패가 검증 실패로 위장한다 — 통과한 검증이 PROGRESS.md 쓰기 실패 때문에
     실패로 보고되면 결과가 거짓이 된다.
  ③ 하트비트 쓰기 실패가 흔적 없이 삼켜진다 — 워치독의 이중 기동 방지 근거가
     사라지는데 알 방법이 없다.
"""

import io
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


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-silent-")
        self.paths = eng.rp(self.sandbox)

    def tearDown(self):
        def onerr(func, path, exc_info):
            try:
                os.chmod(path, stat.S_IWRITE)
                func(path)
            except OSError:
                pass
        shutil.rmtree(self.sandbox, onerror=onerr)
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def engine(self, *args):
        return subprocess.run([PY, ENGINE] + list(args) + ["--repo", self.sandbox],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)

    def init(self, tasks=("t1",)):
        self.engine("init", "--project", "silent", "--objective", "o",
                    "--source", "A", "--target", "B", "--test", OK_CMD)
        for t in tasks:
            self.engine("add-task", "--id", t, "--title", t)

    def corrupt_tracker(self):
        with io.open(self.paths["tracker"], "w", encoding="utf-8") as f:
            f.write('{"tasks": [ 잘린 JSON')

    def block_progress_write(self):
        """PROGRESS.md 자리를 디렉토리로 바꿔 렌더 쓰기를 실패시킨다."""
        path = self.paths["progress"]
        if os.path.isfile(path):
            os.remove(path)
        os.makedirs(path, exist_ok=True)


class TrackerStateTest(Sandbox):
    """① 부재와 파손을 구분한다."""

    def test_missing(self):
        tracker, state = eng.load_tracker_checked(self.sandbox)
        self.assertEqual(state, eng.TRACKER_MISSING)
        self.assertIsNone(tracker)

    def test_ok(self):
        self.init()
        tracker, state = eng.load_tracker_checked(self.sandbox)
        self.assertEqual(state, eng.TRACKER_OK)
        self.assertEqual([t["id"] for t in tracker["tasks"]], ["t1"])

    def test_corrupt_json(self):
        self.init()
        self.corrupt_tracker()
        tracker, state = eng.load_tracker_checked(self.sandbox)
        self.assertEqual(state, eng.TRACKER_CORRUPT)
        self.assertIsNone(tracker)

    def test_wrong_shape_is_corrupt(self):
        self.init()
        eng.atomic_write_json(self.paths["tracker"], {"tasks": "not a list"})
        _t, state = eng.load_tracker_checked(self.sandbox)
        self.assertEqual(state, eng.TRACKER_CORRUPT)


class CommitGateOnCorruptTest(Sandbox):
    """① 장부가 깨지면 커밋 게이트가 조용히 사라지던 결함."""

    def test_corrupt_tracker_gates_commit(self):
        self.init()
        self.corrupt_tracker()
        reason = eng.commit_gate_reason(self.sandbox)
        self.assertIsNotNone(reason, "파손 장부에서 커밋 게이트가 사라졌습니다")
        self.assertIn("파손", reason)

    def test_missing_tracker_still_passes(self):
        """대조군 — 장부가 아예 없는 저장소(수동 운용)는 게이트 대상이 아니다."""
        self.assertIsNone(eng.commit_gate_reason(self.sandbox))

    def test_healthy_tracker_unaffected(self):
        self.init()
        self.assertIsNone(eng.commit_gate_reason(self.sandbox))   # pending 은 active 아님


class RenderIsolationTest(Sandbox):
    """② 렌더 실패가 검증 결과 판정을 뒤집지 않는다."""

    def test_render_safe_swallows_and_reports(self):
        self.init()
        # PROGRESS.md 자리를 디렉토리로 만들어 쓰기를 실패시킨다
        self.block_progress_write()
        self.assertFalse(eng.render_safe(self.sandbox))   # 실패를 True 로 위장하지 않는다

    def test_run_still_reports_success_when_render_fails(self):
        self.init()
        self.block_progress_write()
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0,
                         "렌더 실패가 통과한 검증을 실패로 뒤집었습니다: %s" % r.stderr[-400:])
        tracker = eng.load_json(self.paths["tracker"])
        self.assertEqual(eng.find_task(tracker, "t1")["status"], "done")

    def test_render_failure_is_visible_on_stderr(self):
        self.init()
        self.block_progress_write()
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertIn("렌더 실패", r.stderr)

    def test_render_success_returns_true(self):
        self.init()
        self.assertTrue(eng.render_safe(self.sandbox))


class HeartbeatFailureTest(Sandbox):
    """③ 하트비트 쓰기 실패가 흔적 없이 사라지지 않는다."""

    def test_failure_is_reported_on_stderr(self):
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        os.makedirs(self.paths["heartbeat"], exist_ok=True)   # 파일 자리를 디렉토리로
        r = subprocess.run(
            [PY, "-c",
             "import sys; sys.path.insert(0, %r); import harness_engine as e;"
             "e.write_heartbeat(%r, 'test')" % (BIN, self.sandbox)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(r.returncode, 0, "하트비트 실패가 프로세스를 죽이면 안 됩니다")
        self.assertIn("하트비트 기록 실패", r.stderr)

    def test_success_is_quiet(self):
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        r = subprocess.run(
            [PY, "-c",
             "import sys; sys.path.insert(0, %r); import harness_engine as e;"
             "e.write_heartbeat(%r, 'test')" % (BIN, self.sandbox)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(r.stderr.strip(), "")
        self.assertTrue(os.path.exists(self.paths["heartbeat"]))


class SummaryPriorityTest(unittest.TestCase):
    """진짜 오류가 잡음에 밀려 요약 밖으로 잘려 나가던 결함(적대 검증 확인).

    ERROR_LINE_RE 는 재현율을 위해 넓게 잡혀 있어 무해한 줄도 걸린다. 걸린 순서대로
    상한(60줄)을 채우면 앞쪽 잡음이 자리를 먹어 정작 진짜 오류가 last_error 에서 사라진다.
    정규식을 좁히면 진짜 오류를 놓치므로 우선순위로 해결했다.
    """

    def test_strong_signals_come_first(self):
        noise = "\n".join("Downloading error-prone-%d.jar" % i for i in range(70))
        text = noise + "\nTraceback (most recent call last):\nAssertionError: 기대와 다름\n"
        out = eng.summarize(text)
        self.assertTrue(any("AssertionError" in ln for ln in out),
                        "진짜 오류가 잡음에 밀려 요약에서 사라졌습니다")
        self.assertIn("Traceback", out[0])
        self.assertLessEqual(len(out), eng.SUMMARY_MAX_LINES)

    def test_weak_hits_still_included_when_room_remains(self):
        text = "Downloading error-prone.jar\nAssertionError: 실패\n"
        out = eng.summarize(text)
        self.assertEqual(len(out), 2)
        self.assertIn("AssertionError", out[0])       # 강한 신호가 앞
        self.assertIn("error-prone", out[1])

    def test_falls_back_to_tail_when_no_error_lines(self):
        text = "\n".join("정상 출력 %d" % i for i in range(50))
        out = eng.summarize(text)
        self.assertEqual(len(out), eng.SUMMARY_TAIL_LINES)
        self.assertIn("정상 출력 49", out[-1])

    def test_blank_lines_are_dropped(self):
        self.assertEqual(eng.summarize("\n\n   \n"), [])


if __name__ == "__main__":
    unittest.main()
