# -*- coding: utf-8 -*-
"""훅 배선 비활성 감지 회귀 테스트.

세션 프로젝트 루트가 저장소 밖이면 저장소 `.claude/settings.json` 이 로드되지 않아
훅 4종이 조용히 죽는다 — 커밋 게이트·금지 명령 차단·Stop 게이트가 전부 무력인데
주행은 정상처럼 보인다. 여기서 고정하는 계약:

  ① 판정 근거는 '발화 마커'다 — 하트비트 source=hook 은 사람이 손으로도 남길 수 있어
     근거가 못 된다. 실제 훅 호출(런타임이 채우는 session_id 등 보유)만 마커를 남긴다.
  ② 훅을 등록하지 않은 저장소(수동 운용)는 경고 대상이 아니다 — 오탐 금지.
  ③ run 은 stderr 경고만 하고 주행을 막지 않는다(fail-open).
  ④ status(JSON hooks 필드)·brief(경고 줄)에 상태가 드러난다.

모든 부작용은 tempfile.mkdtemp 샌드박스에 격리된다.
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

# 실제 훅 호출 페이로드 — Claude Code 런타임이 session_id/hook_event_name 을 채운다
REAL_PAYLOAD = {"session_id": "abc-123", "hook_event_name": "PreToolUse",
                "transcript_path": "/tmp/t.jsonl", "tool_input": {"command": "git status"}}
# 사람이 손으로 흉내 낸 호출 — 런타임 필드가 없다
FAKE_PAYLOAD = {"tool_input": {"command": "git status"}}


class WiringTestBase(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-wiring-")
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

    def engine(self, *args, **kw):
        stdin = kw.pop("stdin", "")
        autoharness = kw.pop("autoharness", None)
        assert not kw, kw
        env = os.environ.copy()
        env.pop("CLAUDE_AUTOHARNESS", None)
        if autoharness is not None:
            env["CLAUDE_AUTOHARNESS"] = autoharness
        return subprocess.run([PY, ENGINE] + list(args) + ["--repo", self.sandbox],
                              input=stdin, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env=env, timeout=120)

    def hook(self, op, payload, autoharness=None):
        return self.engine(op, stdin=json.dumps(payload, ensure_ascii=False),
                           autoharness=autoharness)

    def init_tracker(self, task_ids=("t1",)):
        r = self.engine("init", "--project", "wiringtest", "--objective", "배선 감지",
                        "--source", "A", "--target", "B", "--test", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stderr)
        for tid in task_ids:
            r = self.engine("add-task", "--id", tid, "--title", tid + " 작업")
            self.assertEqual(r.returncode, 0, r.stderr)

    def write_settings(self, name="settings.json", commands=None):
        """하네스 훅이 등록된 settings 파일을 만든다."""
        if commands is None:
            commands = ["python scripts/harness_engine.py hook-prebash",
                        "python scripts/harness_engine.py hook-postbash",
                        "python scripts/harness_engine.py hook-stop"]
        events = {"PreToolUse": [], "PostToolUse": [], "Stop": []}
        keys = list(events)
        for i, cmd in enumerate(commands):
            events[keys[i % len(keys)]].append(
                {"hooks": [{"type": "command", "command": cmd}]})
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        eng.atomic_write_json(os.path.join(self.paths["claude_dir"], name), {"hooks": events})

    def wiring(self):
        return eng.hook_wiring_status(self.sandbox)


class PayloadGenuinenessTest(WiringTestBase):
    """① 마커는 실제 훅 호출에만 남는다 — 손으로 흉내 낸 호출은 기록되지 않는다."""

    def test_real_payload_writes_marker(self):
        self.init_tracker()
        r = self.hook("hook-prebash", REAL_PAYLOAD)
        self.assertEqual(r.returncode, 0, r.stderr)
        seen = eng.load_json(self.paths["hooks_seen"])
        self.assertIsInstance(seen, dict)
        self.assertIn("hook-prebash", seen)
        self.assertTrue(seen["hook-prebash"]["ts"])
        self.assertEqual(seen["hook-prebash"]["session_id"], "abc-123")

    def test_manual_payload_writes_no_marker(self):
        # 사람이 stdin 을 직접 먹인 호출 — 하트비트는 남지만 마커는 남으면 안 된다
        self.init_tracker()
        r = self.hook("hook-prebash", FAKE_PAYLOAD)
        self.assertEqual(r.returncode, 0, r.stderr)
        hb = eng.load_json(self.paths["heartbeat"])
        self.assertEqual(hb.get("source"), "hook")   # 하트비트는 근거가 못 된다
        self.assertFalse(os.path.exists(self.paths["hooks_seen"]))

    def test_manual_payload_does_not_mask_inactive_state(self):
        """수동 실행으로 배선 끊긴 저장소가 '정상'으로 오판되지 않는다(적재 후 실측된 허점)."""
        self.init_tracker()
        self.write_settings()
        self.hook("hook-prebash", FAKE_PAYLOAD)
        self.assertEqual(self.wiring()["state"], eng.WIRING_INACTIVE)

    def test_all_three_hooks_record_markers(self):
        self.init_tracker()
        for op, event in (("hook-prebash", "PreToolUse"), ("hook-postbash", "PostToolUse"),
                          ("hook-stop", "Stop")):
            payload = dict(REAL_PAYLOAD, hook_event_name=event)
            r = self.hook(op, payload, autoharness="0")
            self.assertEqual(r.returncode, 0, r.stderr)
        seen = eng.load_json(self.paths["hooks_seen"])
        self.assertEqual(sorted(seen), sorted(eng.MARKER_HOOK_OPS))

    def test_genuineness_accepts_any_runtime_key(self):
        for key in eng.HOOK_RUNTIME_KEYS:
            self.assertTrue(eng.hook_payload_is_genuine({key: "v"}), key)
        for bad in ({}, {"session_id": ""}, {"session_id": None}, {"tool_input": {}}, None, []):
            self.assertFalse(eng.hook_payload_is_genuine(bad), repr(bad))


class FalsePositiveBoundaryTest(WiringTestBase):
    """② 오탐 금지 — 훅을 등록하지 않은 저장소는 경고 대상이 아니다."""

    def test_no_settings_is_not_registered(self):
        self.init_tracker()
        info = self.wiring()
        self.assertEqual(info["state"], eng.WIRING_NOT_REGISTERED)
        self.assertIsNone(info["warning"])

    def test_unrelated_hooks_are_not_registered(self):
        self.init_tracker()
        self.write_settings(commands=["echo hello", "npm run lint"])
        info = self.wiring()
        self.assertEqual(info["state"], eng.WIRING_NOT_REGISTERED)
        self.assertIsNone(info["warning"])

    def test_session_start_only_is_not_a_warn_target(self):
        # SessionStart(brief)는 stdin 을 읽지 않아 마커를 남길 수 없다 — 영구 경고를 만들면 안 된다
        self.init_tracker()
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        eng.atomic_write_json(
            os.path.join(self.paths["claude_dir"], "settings.json"),
            {"hooks": {"SessionStart": [{"hooks": [
                {"type": "command", "command": "python scripts/harness_engine.py brief"}]}]}})
        self.assertEqual(self.wiring()["state"], eng.WIRING_NOT_REGISTERED)

    def test_registered_and_fired_is_active(self):
        self.init_tracker()
        self.write_settings()
        self.hook("hook-prebash", REAL_PAYLOAD)
        info = self.wiring()
        self.assertEqual(info["state"], eng.WIRING_ACTIVE)
        self.assertIsNone(info["warning"])
        self.assertEqual(info["fired"], ["hook-prebash"])
        self.assertTrue(info["last_fire"])

    def test_registered_without_fire_is_inactive(self):
        self.init_tracker()
        self.write_settings()
        info = self.wiring()
        self.assertEqual(info["state"], eng.WIRING_INACTIVE)
        self.assertTrue(info["warning"])
        self.assertEqual(info["fired"], [])
        self.assertEqual(sorted(info["registered"]), sorted(eng.MARKER_HOOK_OPS))

    def test_settings_local_json_also_counts(self):
        # 훅을 settings.local.json 에만 등록한 저장소도 감지 대상이다
        self.init_tracker()
        self.write_settings(name="settings.local.json")
        self.assertEqual(self.wiring()["state"], eng.WIRING_INACTIVE)

    def test_malformed_settings_does_not_crash(self):
        self.init_tracker()
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        with open(os.path.join(self.paths["claude_dir"], "settings.json"), "w",
                  encoding="utf-8") as f:
            f.write("{ this is not json")
        self.assertEqual(self.wiring()["state"], eng.WIRING_NOT_REGISTERED)

    def test_malformed_marker_file_is_treated_as_no_fire(self):
        self.init_tracker()
        self.write_settings()
        with open(self.paths["hooks_seen"], "w", encoding="utf-8") as f:
            f.write("[]")   # dict 가 아님
        self.assertEqual(self.wiring()["state"], eng.WIRING_INACTIVE)

    def test_unknown_marker_key_does_not_count_as_fire(self):
        self.init_tracker()
        self.write_settings()
        eng.atomic_write_json(self.paths["hooks_seen"], {"hook-bogus": {"ts": "2026-01-01"}})
        self.assertEqual(self.wiring()["state"], eng.WIRING_INACTIVE)


class DiagnosisGapTest(WiringTestBase):
    """진단의 사각 2건 — 설정 파손을 미등록으로 오판, 부분 등록을 정상으로 보고(적대 검증)."""

    def write_raw_settings(self, text, name="settings.json"):
        os.makedirs(self.paths["claude_dir"], exist_ok=True)
        with open(os.path.join(self.paths["claude_dir"], name), "w", encoding="utf-8") as f:
            f.write(text)

    def test_settings_states_distinguish_missing_and_corrupt(self):
        self.init_tracker()
        self.assertEqual(eng.settings_states(self.sandbox)["settings.json"], "missing")
        self.write_raw_settings("{ 잘린 JSON")
        self.assertEqual(eng.settings_states(self.sandbox)["settings.json"], "corrupt")
        self.write_settings()
        self.assertEqual(eng.settings_states(self.sandbox)["settings.json"], "ok")

    def test_corrupt_settings_is_warned_not_silently_unregistered(self):
        """파손이면 훅이 전부 죽은 상태인데 종전에는 '수동 운용' 으로 조용히 넘어갔다."""
        self.init_tracker()
        self.write_raw_settings("{ 잘린 JSON")
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["settings_states"]["settings.json"], "corrupt")
        self.assertTrue(info["warning"])
        self.assertIn("파손", info["warning"])

    def test_partial_registration_is_warned(self):
        """훅 일부만 등록된 상태 — 나머지 게이트는 없는데 active 로 보고됐다."""
        self.init_tracker()
        self.write_settings(commands=["python scripts/harness_engine.py hook-prebash"])
        self.hook("hook-prebash", REAL_PAYLOAD)          # 등록된 것은 발화 → active
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["state"], eng.WIRING_ACTIVE)
        self.assertIn("hook-postbash", info["missing_hooks"])
        self.assertIn("hook-stop", info["missing_hooks"])
        self.assertTrue(info["warning"])
        self.assertIn("일부만", info["warning"])

    def test_full_registration_has_no_partial_warning(self):
        self.init_tracker()
        self.write_settings()
        self.hook("hook-prebash", REAL_PAYLOAD)
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["missing_hooks"], [])
        self.assertIsNone(info["warning"])

    def test_unregistered_repo_gets_no_partial_warning(self):
        """오탐 금지 — 훅을 아예 안 쓰는 저장소는 '일부만 등록' 이 아니다."""
        self.init_tracker()
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["state"], eng.WIRING_NOT_REGISTERED)
        self.assertIsNone(info["warning"])


class SecondarySignalTest(WiringTestBase):
    """보조 신호 — done 인데 커밋 SHA 가 비어 있으면 PostToolUse 미발화의 흔적이다."""

    def test_counts_done_without_commit(self):
        self.init_tracker()
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.write_settings()
        info = self.wiring()
        self.assertEqual(info["done_total"], 1)
        self.assertEqual(info["done_without_commit"], 1)
        self.assertIn("PostToolUse 미발화 흔적", info["warning"])

    def test_no_secondary_note_when_commits_recorded(self):
        self.init_tracker()
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        tracker = eng.load_json(self.paths["tracker"])
        eng.find_task(tracker, "t1")["commit"] = "deadbee"
        eng.atomic_write_json(self.paths["tracker"], tracker)
        self.write_settings()
        info = self.wiring()
        self.assertEqual(info["done_without_commit"], 0)
        self.assertNotIn("PostToolUse 미발화 흔적", info["warning"])


class OutputIntegrationTest(WiringTestBase):
    """③④ run 은 경고만 하고 막지 않는다 / status·brief 에 상태가 드러난다."""

    def test_run_warns_but_still_passes(self):
        self.init_tracker()
        self.write_settings()
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)   # 주행을 막지 않는다
        self.assertIn("훅 배선 비활성 의심", r.stderr)
        self.assertEqual(eng.find_task(eng.load_json(self.paths["tracker"]), "t1")["status"],
                         "done")

    def test_run_silent_when_hooks_active(self):
        self.init_tracker()
        self.write_settings()
        self.hook("hook-prebash", REAL_PAYLOAD)
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("훅 배선 비활성 의심", r.stderr)

    def test_run_silent_when_hooks_not_registered(self):
        self.init_tracker()
        r = self.engine("run", "--task", "t1", "--cmd", OK_CMD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("훅 배선 비활성 의심", r.stderr)

    def test_status_exposes_hooks_field(self):
        self.init_tracker()
        self.write_settings()
        r = self.engine("status")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertIn("hooks", data)
        self.assertEqual(data["hooks"]["state"], eng.WIRING_INACTIVE)
        self.assertEqual(sorted(data["hooks"]["registered"]), sorted(eng.MARKER_HOOK_OPS))
        self.assertTrue(data["hooks"]["warning"])

    def test_status_hooks_field_when_active(self):
        self.init_tracker()
        self.write_settings()
        self.hook("hook-stop", dict(REAL_PAYLOAD, hook_event_name="Stop"), autoharness="0")
        data = json.loads(self.engine("status").stdout)
        self.assertEqual(data["hooks"]["state"], eng.WIRING_ACTIVE)
        self.assertIsNone(data["hooks"]["warning"])

    def test_brief_warns_only_when_inactive(self):
        self.init_tracker()
        self.write_settings()
        r = self.engine("brief")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("훅 배선 비활성 의심", r.stdout)
        # 발화 후에는 잡음을 남기지 않는다
        self.hook("hook-prebash", REAL_PAYLOAD)
        r = self.engine("brief")
        self.assertNotIn("훅 배선 비활성 의심", r.stdout)

    def test_brief_silent_when_not_registered(self):
        self.init_tracker()
        r = self.engine("brief")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("훅 배선 비활성 의심", r.stdout)

    def test_warning_names_repo_root(self):
        self.init_tracker()
        self.write_settings()
        self.assertIn(os.path.abspath(self.sandbox), self.wiring()["warning"])


class StopGateStillWorksTest(WiringTestBase):
    """마커 기록이 hook-stop 의 기존 계약(block 판정)을 깨지 않는다."""

    def test_stop_still_blocks_with_real_payload(self):
        self.init_tracker()
        r = self.hook("hook-stop", dict(REAL_PAYLOAD, hook_event_name="Stop"), autoharness="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout).get("decision"), "block")
        self.assertIn("hook-stop", eng.load_json(self.paths["hooks_seen"]))

    def test_stop_fail_open_on_malformed_stdin(self):
        self.init_tracker()
        r = self.engine("hook-stop", stdin="not json", autoharness="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(self.paths["hooks_seen"]))


if __name__ == "__main__":
    unittest.main()
