# -*- coding: utf-8 -*-
"""엔진 훅 3종 단위 테스트 — hook-prebash / hook-postbash / hook-stop.

훅을 실제 배선 그대로(엔진 서브프로세스 + stdin JSON) 호출해 종료 코드·표준출력·
장부 부작용을 실측 검증한다. 모든 부작용은 tempfile.mkdtemp 샌드박스 저장소에
격리된다 — 실제 저장소·사용자 상태(레지스트리·스케줄러·설치본)는 건드리지 않는다.
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
# 엔진 selftest 와 동일한 인용 패턴(shell=True 에서 공백 경로 안전)
OK_CMD = '"%s" -c "print(\'ok\')"' % PY
FAIL_CMD = '"%s" -c "import sys; sys.exit(1)"' % PY


class HookSandboxTest(unittest.TestCase):
    """샌드박스 저장소 생성/정리와 엔진 서브프로세스 호출 헬퍼."""

    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-hooktest-")
        self.paths = eng.rp(self.sandbox)

    def tearDown(self):
        # git 오브젝트는 읽기 전용이라 Windows rmtree 가 실패할 수 있다 — 쓰기 권한 복구 후 삭제
        def onerr(func, path, exc_info):
            try:
                os.chmod(path, stat.S_IWRITE)
                func(path)
            except OSError:
                pass
        shutil.rmtree(self.sandbox, onerror=onerr)
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def engine(self, *args, **kw):
        """엔진 CLI 호출. stdin=문자열(훅 JSON), autoharness=CLAUDE_AUTOHARNESS 값,
        env_extra=추가 환경변수 dict."""
        stdin = kw.pop("stdin", "")
        autoharness = kw.pop("autoharness", None)
        env_extra = kw.pop("env_extra", None)
        assert not kw, kw
        env = os.environ.copy()
        env.pop("CLAUDE_AUTOHARNESS", None)  # 헤드리스 부모 세션의 값이 새지 않게 항상 명시 제어
        if autoharness is not None:
            env["CLAUDE_AUTOHARNESS"] = autoharness
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [PY, ENGINE] + list(args) + ["--repo", self.sandbox],
            input=stdin, capture_output=True, text=True, encoding="utf-8",
            errors="replace", env=env, timeout=120)

    def hook(self, op, command=None, raw_stdin=None, autoharness=None):
        stdin = raw_stdin if raw_stdin is not None else json.dumps(
            {"tool_input": {"command": command or ""}}, ensure_ascii=False)
        return self.engine(op, stdin=stdin, autoharness=autoharness)

    def init_tracker(self, task_ids=()):
        r = self.engine("init", "--project", "hooktest", "--objective", "훅 검증",
                        "--source", "A", "--target", "B", "--test", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stderr)
        for tid in task_ids:
            r = self.engine("add-task", "--id", tid, "--title", tid + " 작업")
            self.assertEqual(r.returncode, 0, r.stderr)

    def read_tracker(self):
        return eng.load_json(self.paths["tracker"])

    def read_state(self):
        return eng.load_json(self.paths["state"])


class PreBashDenyTest(HookSandboxTest):
    """hook-prebash — 금지 명령 게이트와 fail-open 계약.

    게이트 처리 방식은 컨텍스트가 정한다(의도된 계약 변경):
      헤드리스(CLAUDE_AUTOHARNESS=1) → exit 2 하드 차단
      대화형                          → exit 0 + permissionDecision "ask"(사용자 승인 창)
    """

    def assert_blocked(self, command):
        """무인 세션에서는 종전대로 하드 차단이어야 한다."""
        r = self.hook("hook-prebash", command=command, autoharness="1")
        self.assertEqual(r.returncode, 2, "차단돼야 함: %s (stderr=%s)" % (command, r.stderr))
        self.assertIn("차단", r.stderr)

    def assert_asked(self, command):
        """대화형에서는 승인 요청으로 승격돼야 한다 — 사용자가 승인하면 실행된다."""
        r = self.hook("hook-prebash", command=command)
        self.assertEqual(r.returncode, 0, "승인 요청이어야 함: %s (stderr=%s)" % (command, r.stderr))
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "ask")
        self.assertIn("AutoHarness", out["permissionDecisionReason"])

    def assert_allowed(self, command):
        r = self.hook("hook-prebash", command=command)
        self.assertEqual(r.returncode, 0, "허용돼야 함: %s (stderr=%s)" % (command, r.stderr))
        self.assertEqual(r.stdout.strip(), "", "개입 없이 통과해야 함: %s" % r.stdout)

    def test_blocks_git_push(self):
        self.assert_blocked("git push origin main")

    def test_interactive_push_escalates_to_ask(self):
        """사용자가 지시한 경우까지 막던 모순 — 대화형에서는 승인 창으로 승격된다."""
        self.assert_asked("git push origin main")

    def test_paused_escalates_to_ask_even_when_headless(self):
        """일시정지는 사람이 직접 운전 중이라는 뜻 — 하드 차단하지 않는다."""
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        with open(self.paths["paused_flag"], "w", encoding="utf-8") as f:
            f.write("")
        r = self.hook("hook-prebash", command="git push origin main", autoharness="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_blocks_git_push_korean_text(self):
        # stdin 이 utf-8 로 디코드되지 않으면 한글 명령이 오염돼 fail-open 으로 뒤집힌다
        self.assert_blocked("git push origin 기능-브랜치")

    def test_blocks_force_variants(self):
        for cmd in ("git push --force", "git branch --force main",
                    "git push --force-with-lease origin main"):
            self.assert_blocked(cmd)

    def test_blocks_reset_hard(self):
        self.assert_blocked("git reset --hard HEAD~1")

    def test_blocks_clean_force(self):
        for cmd in ("git clean -fd", "git clean -d -f", "git clean --force"):
            self.assert_blocked(cmd)

    def test_allows_safe_commands(self):
        for cmd in ("git status", "git log --oneline", "ls -la", "echo push"):
            self.assert_allowed(cmd)

    def test_fail_open_on_malformed_stdin(self):
        for raw in ("this is not json", ""):
            r = self.hook("hook-prebash", raw_stdin=raw)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_writes_heartbeat(self):
        self.hook("hook-prebash", command="git status")
        hb = eng.load_json(self.paths["heartbeat"])
        self.assertIsNotNone(hb)
        self.assertEqual(hb.get("source"), "hook")


class PreBashCommitGateTest(HookSandboxTest):
    """hook-prebash — 커밋 게이트: 검증 통과 기록 없는 커밋 차단."""

    def test_blocks_commit_without_passing_run(self):
        """무인 세션 — 검증 통과 기록 없는 커밋은 하드 차단."""
        self.init_tracker(["t1"])
        r = self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        r = self.hook("hook-prebash", command='git commit -m "작업"', autoharness="1")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("커밋 게이트", r.stderr)
        self.assertIn("t1", r.stderr)

    def test_interactive_commit_gate_escalates_to_ask(self):
        """대화형에서는 커밋 게이트도 승인 창으로 승격된다 — 두 게이트가 같은 규칙을 쓴다."""
        self.init_tracker(["t1"])
        self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        r = self.hook("hook-prebash", command='git commit -m "작업"')
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "ask")
        self.assertIn("커밋 게이트", out["permissionDecisionReason"])
        # 승인되면 커밋이 실제로 일어나므로 오귀속 방지 마커가 남아 있어야 한다
        self.assertIn("head_before_commit", self.read_state())

    def test_allows_commit_after_passing_run(self):
        self.init_tracker(["t1"])
        self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        r = self.hook("hook-prebash", command='git commit -m "작업"')
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_allows_commit_when_no_active_task(self):
        self.init_tracker(["t1"])  # pending 은 active(in_progress/failed)가 아니다
        r = self.hook("hook-prebash", command='git commit -m "작업"')
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_paused_flag_bypasses_gate(self):
        self.init_tracker(["t1"])
        self.engine("run", "--task", "t1", "--cmd", FAIL_CMD)
        with open(self.paths["paused_flag"], "w", encoding="utf-8") as f:
            f.write("")
        r = self.hook("hook-prebash", command='git commit -m "작업"')
        self.assertEqual(r.returncode, 0, r.stderr)


class PostBashSyncTest(HookSandboxTest):
    """hook-postbash — git commit 후 커밋 SHA 를 최신 done 작업에 동기화."""

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.sandbox, "-c", "user.name=hooktest",
             "-c", "user.email=hooktest@example.com", "-c", "commit.gpgsign=false"]
            + list(args),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)

    def setUp(self):
        super(PostBashSyncTest, self).setUp()
        self.init_tracker(["t1"])
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for args in (("init", "-q"), ("add", "-A"), ("commit", "-q", "-m", "sandbox commit")):
            r = self.git(*args)
            self.assertEqual(r.returncode, 0, "git %s 실패: %s" % (args, r.stderr))

    def head_sha(self):
        return self.git("rev-parse", "--short", "HEAD").stdout.strip()

    def test_non_commit_command_does_not_sync(self):
        r = self.hook("hook-postbash", command="ls -la")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNone(eng.find_task(self.read_tracker(), "t1")["commit"])

    def test_successful_commit_records_new_head(self):
        # 실제 배선 순서: prebash(마커 기록) → 커밋 성공 → postbash(HEAD 변화 확인 후 기록)
        commit_cmd = 'git commit -m "작업 완료"'
        baseline = self.head_sha()
        r = self.hook("hook-prebash", command=commit_cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.git("commit", "--allow-empty", "-q", "-m", "작업 커밋")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.hook("hook-postbash", command=commit_cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        recorded = eng.find_task(self.read_tracker(), "t1")["commit"]
        self.assertEqual(recorded, self.head_sha())
        self.assertNotEqual(recorded, baseline)

    def test_failed_commit_does_not_misattribute(self):
        # 커밋이 실패해(HEAD 불변, nothing to commit 등) 직전 커밋이 오귀속되면 안 된다
        commit_cmd = 'git commit -m "빈 커밋 시도"'
        r = self.hook("hook-prebash", command=commit_cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.hook("hook-postbash", command=commit_cmd)  # 사이에 새 커밋 없음
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNone(eng.find_task(self.read_tracker(), "t1")["commit"])
        # 마커는 1회용 — 소진돼 있어야 다음 커밋 판정이 오염되지 않는다
        self.assertNotIn("head_before_commit", self.read_state())

    def test_postbash_without_marker_fails_open(self):
        # prebash 없이 postbash 만 오면(수동 sync·부분 설치) 종전대로 기록한다
        r = self.hook("hook-postbash", command='git commit -m "수동 경로"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(eng.find_task(self.read_tracker(), "t1")["commit"], self.head_sha())

    def test_fail_open_on_malformed_stdin(self):
        r = self.hook("hook-postbash", raw_stdin="not json at all")
        self.assertEqual(r.returncode, 0, r.stderr)


class PostBashFirstCommitTest(HookSandboxTest):
    """저장소 최초 커밋(직전 HEAD 없음) 경로 — 마커가 None 이어도 새 커밋은 기록된다."""

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.sandbox, "-c", "user.name=hooktest",
             "-c", "user.email=hooktest@example.com", "-c", "commit.gpgsign=false"]
            + list(args),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)

    def test_first_commit_is_recorded(self):
        self.init_tracker(["t1"])
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.git("init", "-q").returncode, 0)
        commit_cmd = 'git commit -m "최초 커밋"'
        r = self.hook("hook-prebash", command=commit_cmd)  # HEAD 없음 → 마커 None
        self.assertEqual(r.returncode, 0, r.stderr)
        self.git("add", "-A")
        r = self.git("commit", "-q", "-m", "최초 커밋")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.hook("hook-postbash", command=commit_cmd)
        self.assertEqual(r.returncode, 0, r.stderr)
        sha = self.git("rev-parse", "--short", "HEAD").stdout.strip()
        self.assertTrue(sha)
        self.assertEqual(eng.find_task(self.read_tracker(), "t1")["commit"], sha)


class StopGateTest(HookSandboxTest):
    """hook-stop — 6단계 게이트와 진전 없는 정지 가드."""

    def assert_no_block(self, r):
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("decision", r.stdout)

    def assert_block(self, r, task_id):
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data.get("decision"), "block")
        self.assertIn(task_id, data.get("reason", ""))
        return data

    def test_allows_without_autoharness_env(self):
        self.init_tracker(["t1"])
        self.assert_no_block(self.hook("hook-stop"))

    def test_allows_when_paused(self):
        self.init_tracker(["t1"])
        with open(self.paths["paused_flag"], "w", encoding="utf-8") as f:
            f.write("")
        self.assert_no_block(self.hook("hook-stop", autoharness="1"))

    def test_allows_without_tracker(self):
        self.assert_no_block(self.hook("hook-stop", autoharness="1"))

    def test_allows_when_no_eligible_task(self):
        self.init_tracker([])  # 작업 없음 → eligible_next 는 None
        self.assert_no_block(self.hook("hook-stop", autoharness="1"))

    def test_blocks_when_task_remains(self):
        self.init_tracker(["t1"])
        r = self.hook("hook-stop", autoharness="1")
        self.assert_block(r, "t1")
        self.assertEqual(self.read_state().get("stop_blocks"), 1)

    def test_progress_guard_releases_after_limit(self):
        self.init_tracker(["t1"])
        # 장부가 변하지 않는 정지: 한도(STOP_BLOCK_LIMIT)까지는 block, 그다음은 종료 허용
        for i in range(eng.STOP_BLOCK_LIMIT):
            r = self.hook("hook-stop", autoharness="1")
            self.assert_block(r, "t1")
            self.assertEqual(self.read_state().get("stop_blocks"), i + 1)
        r = self.hook("hook-stop", autoharness="1")
        self.assert_no_block(r)
        self.assertIn("진전 없는 정지", r.stderr)
        self.assertEqual(self.read_state().get("stop_blocks"), eng.STOP_BLOCK_LIMIT + 1)

    def test_progress_guard_resets_on_tracker_change(self):
        self.init_tracker(["t1"])
        for _ in range(2):
            self.assert_block(self.hook("hook-stop", autoharness="1"), "t1")
        self.assertEqual(self.read_state().get("stop_blocks"), 2)
        # 장부 변경(add-task) → 해시가 바뀌어 카운터가 1로 리셋되고 다시 block
        r = self.engine("add-task", "--id", "t2", "--title", "추가 작업")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assert_block(self.hook("hook-stop", autoharness="1"), "t1")
        self.assertEqual(self.read_state().get("stop_blocks"), 1)


if __name__ == "__main__":
    unittest.main()
