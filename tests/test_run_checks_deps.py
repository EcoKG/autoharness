# -*- coding: utf-8 -*-
"""검증 파이프라인의 도구 부재 진단 회귀.

도구가 없어서 못 도는 것과 코드가 틀려서 실패하는 것은 **처방이 정반대다** — 전자는
`bun install`, 후자는 코드 수정. 한데 뭉치면 새로 클론한 사람이 원인을 알 수 없다.

실측(2026-08-11): 이 저장소를 새 계정에서 열자 `bun run typecheck` 가
`bun: command not found: tsc` 로 실패했다. tsc 는 devDependency 인데 README 는
"bun install 은 필요 없습니다"라고 단언하고 있었고, 출력은 "daemon typecheck 실패
(exit 1)" 한 줄이라 검증이 왜 통과 불능인지 알 방법이 없었다.

여기서 고정하는 것은 양방향이다:
  미탐 — 의존성이 없는데 통과처럼 넘어가기, 도구 부재를 타입 오류로 보고하기
  오탐 — 판정할 수 없는 상태(package.json 을 못 읽음)를 근거로 "없다"고 단정하기
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import run_checks  # noqa: E402


def write_json(path, data):
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


class DaemonDevDepsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-deps-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def pkg(self, dev):
        write_json(os.path.join(self.dir, "package.json"), {"name": "d", "devDependencies": dev})

    def installed(self, *names):
        for name in names:
            os.makedirs(os.path.join(self.dir, "node_modules", *name.split("/")))

    def test_missing_dev_dep_is_reported(self):
        self.pkg({"typescript": "^5"})
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), ["typescript"])

    def test_installed_dev_dep_is_not_reported(self):
        self.pkg({"typescript": "^5"})
        self.installed("typescript")
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), [])

    def test_scoped_package_resolves_to_nested_directory(self):
        # @types/bun 은 node_modules/@types/bun 이다 — 이름 그대로 찾으면 영영 못 찾는다
        self.pkg({"@types/bun": "latest"})
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), ["@types/bun"])
        self.installed("@types/bun")
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), [])

    def test_partial_install_reports_only_the_missing_ones(self):
        self.pkg({"typescript": "^5", "@types/bun": "latest"})
        self.installed("typescript")
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), ["@types/bun"])

    def test_no_dev_dependencies_is_not_a_finding(self):
        self.pkg({})
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), [])

    def test_unreadable_package_json_is_not_a_finding(self):
        """판정 불가를 '없음'으로 단정하지 않는다 — 오탐이 곧 거짓 실패다."""
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), [])  # 파일 자체가 없음
        with io.open(os.path.join(self.dir, "package.json"), "w", encoding="utf-8") as fh:
            fh.write("{깨진 JSON")
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), [])

    def test_dev_dependencies_of_wrong_type_is_not_a_finding(self):
        write_json(os.path.join(self.dir, "package.json"), {"devDependencies": ["typescript"]})
        self.assertEqual(run_checks.daemon_missing_dev_deps(self.dir), [])


class DiagnosticTextTest(unittest.TestCase):
    def test_fix_hint_names_the_command_to_run(self):
        self.assertIn("bun install", run_checks.DEPS_FIX_HINT)

    def test_tool_absence_marker_matches_bun_output(self):
        # bun 이 실제로 뱉는 문구다 — 바뀌면 안전망이 조용히 꺼진다
        self.assertIn("tsc", run_checks.TSC_MISSING_MARK)
        self.assertIn(run_checks.TSC_MISSING_MARK, "bun: command not found: tsc")


class RealRepoTest(unittest.TestCase):
    def test_this_repo_declares_typescript_as_dev_dependency(self):
        """README 의 '빌드/검증' 구분이 실제 package.json 과 어긋나지 않게 고정한다."""
        daemon = os.path.join(REPO, "daemon")
        if not os.path.isdir(daemon):
            self.skipTest("daemon/ 없음 — v1 전용 체크아웃")
        with io.open(os.path.join(daemon, "package.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertIn("typescript", data.get("devDependencies", {}))
        self.assertIn("tsc", data["scripts"]["typecheck"])


class ReadmeTest(unittest.TestCase):
    def test_readme_does_not_claim_bun_install_is_unnecessary_outright(self):
        """실측으로 틀린 것이 확인된 단언이 되살아나지 않게 한다."""
        with io.open(os.path.join(REPO, "README.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("`bun install` 은 필요 없습니다 —", text)
        self.assertIn("cd daemon && bun install", text)


if __name__ == "__main__":
    unittest.main()
