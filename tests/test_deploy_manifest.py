# -*- coding: utf-8 -*-
"""배포 명세 회귀 — **허용과 금지 양쪽을 고정한다.**

허용 목록만 두면 새로 추가한 파일이 조용히 빠지고(설치본이 낡는다), 금지 목록만 두면
새로 생긴 부산물이 조용히 들어간다(사용자 계정이 이 저장소의 상태를 물려받는다).

금지가 더 위험한 쪽이다. 이 저장소의 장부·훅 설정·검증 캐시·빌드 산출물이 설치본에
흘러들면 남의 프로젝트 진행 이력이 담긴 파일이 사용자 홈에 놓인다.

오탐도 실패다: `templates/agent_harness.sh` 나 `templates/CLAUDE.md.tmpl` 을 확장자만 보고
거르면 설치본이 반쪽이 된다.
"""

import io
import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import deploy_manifest as man  # noqa: E402


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write("")


class ForbiddenTest(unittest.TestCase):
    def assertBlocked(self, rel, hint=None):
        why = man.forbidden_reason(rel)
        self.assertIsNotNone(why, "%s 가 금지되지 않았습니다" % rel)
        if hint:
            self.assertIn(hint, why)

    def assertAllowed(self, rel):
        self.assertIsNone(man.forbidden_reason(rel), "%s 가 잘못 금지됐습니다(오탐)" % rel)

    def test_repo_state_never_ships(self):
        """남의 프로젝트 진행 이력이 사용자 홈에 놓이면 안 된다."""
        self.assertBlocked(".claude/agent_tracker.json")
        self.assertBlocked("PROGRESS.md")
        self.assertBlocked(".claude/checks-timing.json")

    def test_machine_specific_config_never_ships(self):
        """훅 명령에는 설치 시점의 절대 경로가 박힌다 — 그 파일은 기계에 속한다."""
        self.assertBlocked(".claude/settings.json")
        self.assertBlocked("settings.json")
        self.assertBlocked("settings.local.json")
        self.assertBlocked("anywhere/settings.json.bak-20260811T000000Z", "백업")

    def test_build_artifacts_never_ship(self):
        self.assertBlocked("daemon/dist/autoharness.exe")
        self.assertBlocked("bin/__pycache__/harness_engine.cpython-312.pyc")
        self.assertBlocked("harness_engine.pyc")
        self.assertBlocked("daemon/node_modules/typescript/lib/tsc.js")
        self.assertBlocked("daemon/.abc.bun-build")

    def test_the_exe_goes_to_the_runtime_dir_not_the_skill_dir(self):
        """스킬 폴더는 문서·파이썬 자산 자리다. EXE 는 ~/.claude/autoharness/bin 으로 간다."""
        self.assertBlocked("autoharness.exe")

    def test_this_repos_own_driving_instructions_never_ship(self):
        """배포되는 것은 템플릿이지 이 저장소의 CLAUDE.md 가 아니다."""
        self.assertBlocked("CLAUDE.md")
        self.assertAllowed("templates/CLAUDE.md.tmpl")

    def test_logs_and_junk_never_ship(self):
        self.assertBlocked("logs/watchdog.log")
        self.assertBlocked(".git/config")
        self.assertBlocked("templates/.DS_Store")

    def test_real_deploy_targets_are_not_blocked(self):
        """오탐 금지 — 확장자만 보고 거르면 설치본이 반쪽이 된다."""
        for rel in ("skill/SKILL.md", "DESIGN.md", "README.md", "install.ps1", "install.sh",
                    "bin/harness_engine.py", "bin/harness_mcp.py", "bin/harness_watchdog.py",
                    "templates/agent_harness.sh", "templates/bootstrap_prompt.txt",
                    "templates/CLAUDE.md.tmpl"):
            self.assertAllowed(rel)

    def test_empty_and_dot_paths_are_not_blocked_by_accident(self):
        self.assertIsNone(man.forbidden_reason(""))
        self.assertIsNone(man.forbidden_reason("."))

    def test_windows_separators_are_understood(self):
        self.assertBlocked("bin\\__pycache__\\x.pyc")


class DeployPairsTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ah-man-")
        self.addCleanup(shutil.rmtree, self.d, True)

    def test_real_repo_ships_the_expected_set(self):
        pairs, _ = man.deploy_pairs(REPO)
        dst = set(d for _, d in pairs)
        for expected in ("SKILL.md", "DESIGN.md", "README.md",
                         "bin/harness_engine.py", "bin/harness_mcp.py", "bin/harness_watchdog.py",
                         "templates/agent_harness.sh", "templates/bootstrap_prompt.txt",
                         "templates/CLAUDE.md.tmpl"):
            self.assertIn(expected, dst)

    def test_real_repo_ships_nothing_forbidden(self):
        pairs, _ = man.deploy_pairs(REPO)
        for src, dst in pairs:
            self.assertIsNone(man.forbidden_reason(src), src)
            self.assertIsNone(man.forbidden_reason(dst), dst)

    def test_skill_md_is_renamed_at_the_destination(self):
        pairs, _ = man.deploy_pairs(REPO)
        self.assertIn(("skill/SKILL.md", "SKILL.md"), pairs)

    def test_pycache_is_excluded_and_said_out_loud(self):
        """조용히 빼지 않는다 — 무엇이 왜 빠졌는지 보여야 명세가 틀렸을 때 드러난다."""
        _, skipped = man.deploy_pairs(REPO)
        self.assertTrue(any("__pycache__" in rel for rel, _ in skipped),
                        "실재하는 bin/__pycache__ 가 제외 목록에 없습니다")

    def test_forbidden_file_dropped_into_a_deploy_dir_is_refused(self):
        os.makedirs(os.path.join(self.d, "templates"))
        touch(os.path.join(self.d, "templates", "settings.json"))
        touch(os.path.join(self.d, "templates", "ok.txt"))
        pairs, skipped = man.deploy_pairs(self.d)
        self.assertIn(("templates/ok.txt", "templates/ok.txt"), pairs)
        self.assertNotIn("templates/settings.json", [s for s, _ in pairs])
        self.assertTrue(any(rel == "templates/settings.json" for rel, _ in skipped))

    def test_bin_takes_only_python(self):
        os.makedirs(os.path.join(self.d, "bin"))
        touch(os.path.join(self.d, "bin", "engine.py"))
        touch(os.path.join(self.d, "bin", "notes.txt"))
        pairs, skipped = man.deploy_pairs(self.d)
        self.assertEqual([s for s, _ in pairs], ["bin/engine.py"])
        self.assertTrue(any(rel == "bin/notes.txt" for rel, _ in skipped))

    def test_missing_optional_source_is_simply_absent(self):
        """install.sh 가 없는 체크아웃도 있다 — 없는 원본은 실패가 아니다."""
        pairs, _ = man.deploy_pairs(self.d)
        self.assertEqual(pairs, [])

    def test_subdirectories_are_not_recursed(self):
        os.makedirs(os.path.join(self.d, "templates", "nested"))
        touch(os.path.join(self.d, "templates", "nested", "deep.txt"))
        pairs, skipped = man.deploy_pairs(self.d)
        self.assertEqual(pairs, [])
        self.assertTrue(any("nested" in rel for rel, _ in skipped))


class ScanInstalledTest(unittest.TestCase):
    """과거 설치가 남긴 것은 지금 규칙으로 저절로 사라지지 않는다."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ah-inst-")
        self.addCleanup(shutil.rmtree, self.d, True)

    def test_clean_install_reports_nothing(self):
        touch(os.path.join(self.d, "SKILL.md"))
        touch(os.path.join(self.d, "bin", "harness_engine.py"))
        self.assertEqual(man.scan_forbidden(self.d), [])

    def test_leftover_pycache_is_reported(self):
        touch(os.path.join(self.d, "bin", "__pycache__", "x.cpython-312.pyc"))
        found = [rel for rel, _ in man.scan_forbidden(self.d)]
        self.assertTrue(any("__pycache__" in rel for rel in found), found)

    def test_leftover_ledger_is_reported(self):
        touch(os.path.join(self.d, "agent_tracker.json"))
        self.assertTrue(any(rel == "agent_tracker.json" for rel, _ in man.scan_forbidden(self.d)))

    def test_missing_directory_is_not_an_error(self):
        self.assertEqual(man.scan_forbidden(os.path.join(self.d, "없음")), [])

    def test_scan_does_not_delete_anything(self):
        """알리기만 한다 — 사용자 계정의 파일을 배포 스크립트가 임의로 지우지 않는다."""
        path = os.path.join(self.d, "bin", "__pycache__", "x.pyc")
        touch(path)
        man.scan_forbidden(self.d)
        self.assertTrue(os.path.isfile(path))


class SingleSourceTest(unittest.TestCase):
    def test_deploy_live_derives_from_the_manifest(self):
        """두 번째 목록을 두지 않는다 — 그것이 세 구현이 갈라진 원인이었다."""
        with io.open(os.path.join(SCRIPTS, "deploy_live.py"), encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("from deploy_manifest import", source)
        self.assertNotIn("ROOT_MAPPING = [", source)
        self.assertNotIn('name.endswith(".pyc")', source)


if __name__ == "__main__":
    unittest.main()
