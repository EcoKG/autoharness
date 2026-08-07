# -*- coding: utf-8 -*-
"""훅 matcher 커버리지 회귀 테스트.

실측된 결함: PreToolUse/PostToolUse 가 `matcher: "Bash"` 로만 등록돼, Bash 가 아닌 명령
실행 도구(PowerShell)로 들어온 명령은 훅이 **호출조차 되지 않았다**. 같은 구멍으로
금지 명령 게이트와 커밋 게이트가 동시에 무력화된다 — 실제로 이 저장소에서 원격 반영이
그 경로로 통과했다.

부수 결함: merge_settings 의 중복 방지가 이벤트 전체를 json.dumps 해서 harness_engine
포함 여부만 봤다. 그러면 matcher 가 낡아도 '이미 있음'으로 건너뛰어 **기존 설치는 영영
갱신되지 않는다**.

여기서 고정하는 계약:
  ① 신규 설치는 명령 실행 도구 전부를 덮는 matcher 로 등록된다
  ② 기존 설치(matcher 가 낡은 것)는 병합 시 마이그레이션된다
  ③ 이미 최신이면 건드리지 않는다(무의미한 백업·쓰기 방지)
  ④ 진단이 커버리지에서 빠진 도구를 드러낸다
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng   # noqa: E402
import harness_mcp as mcp      # noqa: E402


def hook_item(command, matcher=None):
    item = {"hooks": [{"type": "command", "command": command}]}
    if matcher is not None:
        item["matcher"] = matcher
    return item


class MatcherDefinitionTest(unittest.TestCase):
    """① 정의 자체 — 명령 실행 도구를 전부 덮는가."""

    def test_command_hooks_cover_all_command_tools(self):
        for event, matcher, command in mcp.HOOK_DEFS:
            if event not in ("PreToolUse", "PostToolUse"):
                continue
            for tool in eng.COMMAND_TOOLS:
                self.assertTrue(eng.matcher_covers(matcher, tool),
                                "%s 훅이 %s 를 덮지 않습니다 (matcher=%r, cmd=%r)"
                                % (event, tool, matcher, command))

    def test_non_tool_hooks_have_no_matcher(self):
        for event, matcher, _cmd in mcp.HOOK_DEFS:
            if event in ("SessionStart", "Stop"):
                self.assertIsNone(matcher, "%s 는 도구 무관 이벤트입니다" % event)

    def test_matcher_covers_parsing(self):
        self.assertTrue(eng.matcher_covers("Bash|PowerShell", "Bash"))
        self.assertTrue(eng.matcher_covers("Bash|PowerShell", "PowerShell"))
        self.assertTrue(eng.matcher_covers("Bash, PowerShell", "PowerShell"))
        self.assertFalse(eng.matcher_covers("Bash", "PowerShell"))
        self.assertFalse(eng.matcher_covers("", "Bash"))
        self.assertFalse(eng.matcher_covers(None, "Bash"))
        # 부분 문자열이 아니라 정확 일치여야 한다
        self.assertFalse(eng.matcher_covers("BashOutput", "Bash"))


class MergeSettingsSandbox(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-matcher-")
        self.claude = os.path.join(self.sandbox, ".claude")
        os.makedirs(self.claude, exist_ok=True)
        self.settings_path = os.path.join(self.claude, "settings.json")

    def tearDown(self):
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def write(self, obj):
        eng.atomic_write_json(self.settings_path, obj)

    def read(self):
        return eng.load_json(self.settings_path)

    def entries(self, event):
        return (self.read().get("hooks") or {}).get(event) or []


class FreshInstallTest(MergeSettingsSandbox):
    """① 신규 설치."""

    def test_installs_with_full_matcher(self):
        result = mcp.merge_settings(self.sandbox)
        self.assertIn("PreToolUse", result["merged_hooks"])
        for event in ("PreToolUse", "PostToolUse"):
            item = self.entries(event)[0]
            for tool in eng.COMMAND_TOOLS:
                self.assertTrue(eng.matcher_covers(item.get("matcher"), tool),
                                "%s: %s 미포함" % (event, tool))


class MigrationTest(MergeSettingsSandbox):
    """② 기존 설치 마이그레이션 — 종전 로직은 이걸 영영 못 했다."""

    def install_legacy(self):
        """구버전이 남긴 상태: matcher 가 Bash 뿐."""
        self.write({"hooks": {
            "PreToolUse": [hook_item("python scripts/harness_engine.py hook-prebash", "Bash")],
            "PostToolUse": [hook_item("python scripts/harness_engine.py hook-postbash", "Bash")],
            "Stop": [hook_item("python scripts/harness_engine.py hook-stop")],
            "SessionStart": [hook_item("python scripts/harness_engine.py brief")],
        }})

    def test_legacy_matcher_is_migrated(self):
        self.install_legacy()
        result = mcp.merge_settings(self.sandbox)
        self.assertIn("PreToolUse", result["migrated_hooks"])
        self.assertIn("PostToolUse", result["migrated_hooks"])
        for event in ("PreToolUse", "PostToolUse"):
            item = self.entries(event)[0]
            self.assertTrue(eng.matcher_covers(item.get("matcher"), "PowerShell"), event)

    def test_migration_does_not_duplicate_entries(self):
        self.install_legacy()
        mcp.merge_settings(self.sandbox)
        self.assertEqual(len(self.entries("PreToolUse")), 1)
        mcp.merge_settings(self.sandbox)          # 두 번 돌려도 늘지 않는다
        self.assertEqual(len(self.entries("PreToolUse")), 1)

    def test_migration_preserves_other_hooks(self):
        self.write({"hooks": {
            "PreToolUse": [
                hook_item("echo 사용자훅", "Edit"),
                hook_item("python scripts/harness_engine.py hook-prebash", "Bash"),
            ],
        }})
        mcp.merge_settings(self.sandbox)
        entries = self.entries("PreToolUse")
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["matcher"], "Edit")        # 사용자 훅은 그대로
        self.assertTrue(eng.matcher_covers(entries[1]["matcher"], "PowerShell"))

    def test_up_to_date_install_is_skipped_not_migrated(self):
        """③ 이미 최신이면 손대지 않는다."""
        mcp.merge_settings(self.sandbox)          # 최신으로 설치
        result = mcp.merge_settings(self.sandbox)
        self.assertIn("PreToolUse", result["skipped_hooks"])
        self.assertEqual(result["migrated_hooks"], [])

    def test_backup_is_made_when_file_exists(self):
        self.install_legacy()
        result = mcp.merge_settings(self.sandbox)
        self.assertTrue(result["backup"] and os.path.exists(result["backup"]),
                        "기존 파일을 백업해야 합니다")


class HarnessItemDetectionTest(unittest.TestCase):
    """항목 단위 판정 — 종전의 이벤트 통째 json.dumps 방식이 낳은 결함의 근원."""

    def test_matches_own_op_only(self):
        item = hook_item("python scripts/harness_engine.py hook-prebash", "Bash")
        self.assertTrue(mcp._is_harness_hook_item(item, "hook-prebash"))
        self.assertFalse(mcp._is_harness_hook_item(item, "hook-postbash"))

    def test_ignores_unrelated_hooks(self):
        self.assertFalse(mcp._is_harness_hook_item(hook_item("echo hi", "Bash"), "hook-prebash"))
        self.assertFalse(mcp._is_harness_hook_item(hook_item("npm test"), "brief"))

    def test_defensive_against_malformed(self):
        for bad in (None, [], {}, {"hooks": "nope"}, {"hooks": [None, 3]}):
            self.assertFalse(mcp._is_harness_hook_item(bad, "hook-prebash"), repr(bad))


class CoverageDiagnosisTest(MergeSettingsSandbox):
    """④ 진단이 커버리지 구멍을 드러내는가."""

    def test_reports_uncovered_tool(self):
        self.write({"hooks": {
            "PreToolUse": [hook_item("python scripts/harness_engine.py hook-prebash", "Bash")],
            "PostToolUse": [hook_item("python scripts/harness_engine.py hook-postbash", "Bash")],
        }})
        info = eng.hook_wiring_status(self.sandbox)
        self.assertIn("PowerShell", info["uncovered_tools"])
        self.assertNotIn("Bash", info["uncovered_tools"])

    def test_full_coverage_reports_nothing_uncovered(self):
        mcp.merge_settings(self.sandbox)
        info = eng.hook_wiring_status(self.sandbox)
        self.assertEqual(info["uncovered_tools"], [])

    def test_matchers_are_reported_per_op(self):
        mcp.merge_settings(self.sandbox)
        info = eng.hook_wiring_status(self.sandbox)
        self.assertTrue(eng.matcher_covers(info["matchers"]["hook-prebash"], "PowerShell"))
        # Stop 훅은 도구 무관이라 matcher 가 없다
        self.assertEqual(info["matchers"].get("hook-stop"), "")

    def test_status_json_exposes_coverage(self):
        mcp.merge_settings(self.sandbox)
        eng.atomic_write_json(eng.rp(self.sandbox)["tracker"],
                              {"project": "x", "tasks": [], "max_attempts": 5})
        info = eng.hook_wiring_status(self.sandbox)
        self.assertIn("uncovered_tools", info)
        self.assertIn("matchers", info)
        json.dumps(info, ensure_ascii=False)   # 직렬화 가능해야 status 출력에 실린다


if __name__ == "__main__":
    unittest.main()
