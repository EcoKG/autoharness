# -*- coding: utf-8 -*-
"""훅의 대상 저장소 고정 회귀 테스트.

실측된 결함: 훅 명령이 `--repo` 를 주지 않아 엔진이 **현재 작업 디렉토리**를 저장소로
삼았다. 같은 hook-prebash 에 같은 페이로드(진행 중 작업 + `git commit`)를 먹였을 때
저장소 루트는 exit 2(차단), 하위 디렉토리는 exit 0(통과)였고, 하위 디렉토리에는
harness-heartbeat.json·harness-hooks-seen.json·harness-state.json 이 새로 생겼다.

이것은 hook-path-cwd-independence 가 고친 것과 **다른 축**이다. 그 작업은 엔진 파일의
경로만 못 박았고 대상 저장소 인자는 그대로 뒀다 — 경로가 절대여도 저장소가 cwd 를 따라
흔들리면 하위 디렉토리에서 커밋 게이트·Stop 게이트가 조용히 사라진다.

여기서 고정하는 계약:
  ① 신규 설치의 훅은 대상 저장소를 못 박는다
  ② 기존 설치(--repo 없음)는 병합 시 마이그레이션되고, 재실행해도 중복되지 않는다
  ③ 진단이 저장소 미고정 훅을 드러낸다 — 고정된 저장소는 경고 대상이 아니다(오탐 금지)
  ④ 고정된 훅은 하위 디렉토리에서도 루트와 똑같이 게이트가 걸린다(실측 동등성)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng   # noqa: E402
import harness_mcp as mcp      # noqa: E402

ENGINE_FILE = os.path.join(BIN, "harness_engine.py")


def hook_item(command, matcher=None):
    item = {"hooks": [{"type": "command", "command": command}]}
    if matcher is not None:
        item["matcher"] = matcher
    return item


class HookDefinitionTest(unittest.TestCase):
    """① 정의 자체 — 신규 설치가 저장소를 못 박는가."""

    def test_all_hook_defs_pin_the_repo(self):
        for event, _matcher, command in mcp.HOOK_DEFS:
            self.assertFalse(mcp.repo_unpinned_hook_command(command),
                             "%s 훅이 대상 저장소를 지정하지 않습니다: %r" % (event, command))
            self.assertIn('--repo "${CLAUDE_PROJECT_DIR}"', command)

    def test_hook_defs_still_rooted_and_op_bearing(self):
        # 저장소 인자를 붙이면서 종전 계약(절대 경로·op 식별)을 깨뜨리지 않았는지 본다
        for _event, _matcher, command in mcp.HOOK_DEFS:
            self.assertFalse(mcp.cwd_dependent_hook_command(command), command)
            self.assertIsNotNone(mcp.hook_op_in_command(command), command)

    def test_op_lookup_survives_trailing_arguments(self):
        # 종전 구현은 command.split()[-1] 로 op 를 뽑아 뒤에 인자가 붙으면 곧바로 깨졌다
        cmd = 'python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" hook-prebash --repo "${CLAUDE_PROJECT_DIR}"'
        self.assertEqual(mcp.hook_op_in_command(cmd), "hook-prebash")
        self.assertIsNone(mcp.hook_op_in_command("python foo.py --repo ."))


class UnpinnedDetectionTest(unittest.TestCase):
    """판정 경계 — 오탐과 미탐 양쪽."""

    def test_missing_repo_is_unpinned(self):
        for cmd in ('python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" hook-prebash',
                    "python scripts/harness_engine.py brief",
                    "python /abs/path/harness_engine.py hook-stop"):
            self.assertTrue(eng.hook_command_is_repo_unpinned(cmd), cmd)

    def test_present_repo_is_pinned(self):
        for cmd in ('python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" hook-stop --repo "${CLAUDE_PROJECT_DIR}"',
                    "python scripts/harness_engine.py brief --repo /some/repo"):
            self.assertFalse(eng.hook_command_is_repo_unpinned(cmd), cmd)

    def test_non_harness_commands_are_not_flagged(self):
        # 하네스와 무관한 훅을 등록한 저장소는 경고 대상이 아니다(오탐 금지)
        for cmd in ("npm run lint", "python tools/other.py --check", ""):
            self.assertFalse(eng.hook_command_is_repo_unpinned(cmd), cmd)

    def test_two_axes_are_independent(self):
        # 경로는 절대인데 저장소가 안 박힌 경우 — 종전 진단이 통째로 놓치던 자리
        cmd = 'python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" hook-prebash'
        self.assertFalse(mcp.cwd_dependent_hook_command(cmd))
        self.assertTrue(eng.hook_command_is_repo_unpinned(cmd))


class MergeMigrationTest(unittest.TestCase):
    """② 기존 설치 마이그레이션."""

    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-repopin-")
        os.makedirs(os.path.join(self.sandbox, ".claude"))

    def tearDown(self):
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def settings_path(self):
        return os.path.join(self.sandbox, ".claude", "settings.json")

    def write(self, settings):
        with open(self.settings_path(), "w", encoding="utf-8") as f:
            json.dump(settings, f)

    def entries(self, event):
        with open(self.settings_path(), "r", encoding="utf-8") as f:
            return json.load(f)["hooks"][event]

    def unpinned(self):
        """경로는 이미 고정됐으나 저장소는 안 박힌 상태 — 직전 마이그레이션 이후의 실제 모습."""
        engine = '"${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py"'
        self.write({"hooks": {
            "PreToolUse": [hook_item("python %s hook-prebash" % engine, "Bash|PowerShell")],
            "Stop": [hook_item("python %s hook-stop" % engine)],
        }})

    def test_migration_pins_the_repo(self):
        self.unpinned()
        result = mcp.merge_settings(self.sandbox)
        self.assertIn("PreToolUse", result["migrated_hooks"])
        self.assertIn("Stop", result["migrated_hooks"])
        for event in ("PreToolUse", "Stop"):
            command = self.entries(event)[0]["hooks"][0]["command"]
            self.assertFalse(eng.hook_command_is_repo_unpinned(command), command)

    def test_migration_backs_up_the_original(self):
        self.unpinned()
        result = mcp.merge_settings(self.sandbox)
        self.assertIsNotNone(result["backup"])
        self.assertTrue(os.path.exists(result["backup"]))

    def test_migration_is_idempotent(self):
        self.unpinned()
        mcp.merge_settings(self.sandbox)
        first = self.entries("PreToolUse")[0]["hooks"][0]["command"]
        result = mcp.merge_settings(self.sandbox)
        second = self.entries("PreToolUse")[0]["hooks"][0]["command"]
        self.assertEqual(first, second)
        self.assertEqual(second.count("--repo"), 1)
        self.assertIn("PreToolUse", result["skipped_hooks"])
        self.assertEqual(len(self.entries("PreToolUse")), 1)

    def test_relative_path_and_missing_repo_are_fixed_together(self):
        # 두 축이 동시에 틀린 가장 오래된 설치 형태
        self.write({"hooks": {
            "PreToolUse": [hook_item("python scripts/harness_engine.py hook-prebash", "Bash")],
        }})
        mcp.merge_settings(self.sandbox)
        command = self.entries("PreToolUse")[0]["hooks"][0]["command"]
        self.assertFalse(mcp.cwd_dependent_hook_command(command), command)
        self.assertFalse(eng.hook_command_is_repo_unpinned(command), command)
        self.assertEqual(self.entries("PreToolUse")[0]["matcher"], "Bash|PowerShell")

    def test_fresh_install_needs_no_migration(self):
        result = mcp.merge_settings(self.sandbox)
        self.assertEqual(result["migrated_hooks"], [])
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["repo_unpinned_hooks"], [])


class DiagnosisTest(unittest.TestCase):
    """③ 진단이 드러내는가 — 그리고 정상 저장소에 잡음을 더하지 않는가."""

    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-repopin-diag-")
        os.makedirs(os.path.join(self.sandbox, ".claude"))

    def tearDown(self):
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def write(self, settings):
        with open(os.path.join(self.sandbox, ".claude", "settings.json"), "w", encoding="utf-8") as f:
            json.dump(settings, f)

    def test_unpinned_hooks_are_reported(self):
        engine = '"${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py"'
        self.write({"hooks": {
            "PreToolUse": [hook_item("python %s hook-prebash" % engine, "Bash|PowerShell")],
            "Stop": [hook_item("python %s hook-stop" % engine)],
        }})
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(len(info["repo_unpinned_hooks"]), 2)
        self.assertIn("--repo", info["warning"])

    def test_pinned_hooks_are_not_reported(self):
        self.write({"hooks": {
            "PreToolUse": [hook_item(
                'python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" hook-prebash '
                '--repo "${CLAUDE_PROJECT_DIR}"', "Bash|PowerShell")],
        }})
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["repo_unpinned_hooks"], [])

    def test_repo_without_hooks_is_silent(self):
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["repo_unpinned_hooks"], [])
        self.assertIsNone(info["warning"])


class SubdirectoryGateEquivalenceTest(unittest.TestCase):
    """④ 실측 동등성 — 결함의 본체. 저장소를 못 박으면 하위 디렉토리에서도 게이트가 산다."""

    PAYLOAD = json.dumps({
        "session_id": "probe", "hook_event_name": "PreToolUse",
        "tool_input": {"command": "git commit -m wip"},
    })

    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-repopin-gate-")
        os.makedirs(os.path.join(self.sandbox, ".claude"))
        self.sub = os.path.join(self.sandbox, "sub", "deeper")
        os.makedirs(self.sub)
        tracker = {
            "schema_version": 1, "project": "probe", "objective": "o",
            "source_stack": "s", "target_stack": "t", "model": "claude-opus-5",
            "commands": {"build": None, "test": "exit 0", "lint": None, "timeout_sec": 60},
            "max_attempts": 5, "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "tasks": [{
                "id": "t1", "title": "진행 중 작업", "path": None, "deps": [], "priority": 100,
                "status": "in_progress", "attempts": 0, "last_error": None,
                "last_log_file": None, "commit": None,
                "started_at": "2026-01-01T00:00:00+00:00", "finished_at": None, "test_cmd": None,
            }],
        }
        eng.atomic_write_json(eng.rp(self.sandbox)["tracker"], tracker)

    def tearDown(self):
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def prebash(self, cwd, repo_arg):
        argv = [sys.executable, ENGINE_FILE, "hook-prebash"]
        if repo_arg is not None:
            argv += ["--repo", repo_arg]
        env = dict(os.environ, CLAUDE_AUTOHARNESS="1")
        return subprocess.run(argv, cwd=cwd, env=env, input=self.PAYLOAD,
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace").returncode

    def test_gate_blocks_at_repo_root(self):
        self.assertEqual(self.prebash(self.sandbox, None), 2)

    def test_unpinned_hook_loses_the_gate_in_a_subdirectory(self):
        # 결함의 재현 — 저장소를 못 박지 않으면 하위 디렉토리에서 통과한다
        self.assertEqual(self.prebash(self.sub, None), 0)

    def test_pinned_hook_keeps_the_gate_in_a_subdirectory(self):
        # 수정의 효과 — ${CLAUDE_PROJECT_DIR} 가 치환된 형태와 같다
        self.assertEqual(self.prebash(self.sub, self.sandbox), 2)

    def test_pinned_hook_does_not_scatter_state(self):
        self.prebash(self.sub, self.sandbox)
        self.assertFalse(os.path.isdir(os.path.join(self.sub, ".claude")),
                         "하위 디렉토리에 하네스 상태가 새로 생겼습니다")
        self.assertTrue(os.path.exists(eng.rp(self.sandbox)["heartbeat"]))


if __name__ == "__main__":
    unittest.main()
