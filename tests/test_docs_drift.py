# -*- coding: utf-8 -*-
"""문서-실제 교차 검증 — **문서에만 있는 서술과 코드에만 있는 표면을 기계가 잡는다.**

이 저장소는 같은 종류의 드리프트를 반복해서 겪었다: 스킬 문서가 모드 4개라고 쓰는 동안
코드에는 6개가 있었고, 부트스트랩 프롬프트가 없는 파일을 부르고 있었고, README 는
"bun install 은 필요 없습니다" 라고 단언하는 동안 검증은 그것 없이 통과할 수 없었다.

사람의 기억에 맡기면 조용히 어긋나므로, 여기서 고정하는 것은 **문서가 말하는 표면이 실제
코드에 있는가** 이다. 문장을 통째로 비교하지는 않는다 — 그러면 문서를 다듬을 때마다
테스트가 깨져 결국 단정문이 약해진다.
"""

import io
import os
import re
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import run_checks  # noqa: E402


def read(*parts):
    with io.open(os.path.join(REPO, *parts), encoding="utf-8") as fh:
        return fh.read()


class WiringStateTest(unittest.TestCase):
    """배선 상태를 하나 늘렸는데 문서가 셋만 말하면, 새 상태는 없는 것과 같다."""

    def setUp(self):
        self.wiring = read("daemon", "src", "hooks", "wiring.ts")
        self.design = read("DESIGN.md")

    def code_states(self):
        return set(re.findall(r'export const WIRING_[A-Z_]+ = "([a-z_]+)"', self.wiring))

    def test_code_defines_the_four_states(self):
        self.assertEqual(self.code_states(),
                         {"not_registered", "active", "inactive", "broken_path"})

    def test_design_mentions_every_state_the_code_defines(self):
        for state in self.code_states():
            self.assertIn(state, self.design, "DESIGN.md 가 %s 상태를 말하지 않습니다" % state)

    def test_design_records_the_remedy_for_broken_path(self):
        """상태만 적고 조치를 안 적으면 사용자는 여전히 갇힌다."""
        self.assertIn("install --repo", self.design)


class RunChecksDocsTest(unittest.TestCase):
    """검증 파이프라인의 표면(플래그·단계)이 문서와 어긋나지 않게."""

    def setUp(self):
        self.source = read("scripts", "run_checks.py")
        self.claude = read("CLAUDE.md")
        self.readme = read("README.md")

    def flags(self):
        return set(re.findall(r'ap\.add_argument\("(--[a-z-]+)"', self.source))

    def test_code_exposes_the_documented_flags(self):
        self.assertEqual(self.flags(), {"--no-deploy", "--jobs", "--serial"})

    def test_claude_md_documents_the_tuning_flags(self):
        for flag in ("--jobs", "--serial"):
            self.assertIn(flag, self.claude)

    def test_claude_md_describes_the_three_stages_not_the_old_four(self):
        """옛 서술(컴파일 → selftest → 단위 테스트 → 동기화)이 남으면 에이전트가 틀린 모델로 판단한다."""
        self.assertIn("병렬", self.claude)
        self.assertIn("집합 대조", self.claude)
        self.assertNotIn("컴파일 검사 → 엔진 selftest 15항목 → tests/ 단위 테스트", self.claude)

    def test_readme_documents_the_pipeline_and_its_measurement(self):
        self.assertIn("자체 검증 파이프라인", self.readme)
        self.assertIn("--serial", self.readme)
        self.assertIn("집합", self.readme)

    def test_prerequisites_are_stated_in_both_places(self):
        for text in (self.claude, self.readme):
            self.assertIn("bun install", text)

    def test_deploy_is_still_last(self):
        """문서가 '마지막 단계' 라고 말하는 것이 코드에서도 마지막이어야 한다."""
        self.assertLess(self.source.index("checks: units"), self.source.index("checks: deploy"))
        self.assertIn("마지막", self.claude)


class BootstrapDocsTest(unittest.TestCase):
    def setUp(self):
        self.prompt = read("templates", "bootstrap_prompt.txt")
        self.design = read("daemon", "DESIGN.md")

    def test_prompt_no_longer_names_only_the_v1_path(self):
        """v2 설치본에는 scripts/harness_engine.py 가 없다 — 그것만 지시하면 첫 명령부터 실패한다."""
        self.assertIn("autoharness", self.prompt)
        self.assertIn("harness_engine.py", self.prompt)

    def test_design_documents_the_two_bootstrap_sources(self):
        self.assertIn("BUILTIN_BOOTSTRAP", self.design)
        self.assertIn("bootstrap_prompt.txt", self.design)

    def test_prompt_keeps_integrity_above_speed(self):
        speed_at = self.prompt.index("작업 속도")
        self.assertIn("품질 기준을 덮지 않는", self.prompt[speed_at:])
        self.assertIn("done 은 오직 run 종료 코드 0 으로만 생깁니다", self.prompt)


class DeployDocsTest(unittest.TestCase):
    def test_claude_md_names_the_v2_install_target(self):
        """실행 중 설치본이 두 곳이라는 사실이 안내층에 없으면, 고쳐도 반영이 안 된 줄 모른다."""
        claude = read("CLAUDE.md")
        self.assertIn("autoharness.exe", claude)
        self.assertIn("deploy_live", claude)


class MeasurementHonestyTest(unittest.TestCase):
    """수치를 적었으면 재현 방법도 적는다 — 못 재는 수치는 주장일 뿐이다."""

    def test_readme_states_how_to_reproduce(self):
        readme = read("README.md")
        self.assertIn("재현:", readme)
        self.assertIn("16코어", readme)  # 측정 조건 없이 수치만 남기지 않는다


class UnitPlanningStillMatchesDiscovery(unittest.TestCase):
    """문서가 약속한 '집합 동일성' 이 실제 코드 경로에 존재하는지."""

    def test_verify_coverage_is_wired_into_the_verdict(self):
        source = read("scripts", "run_checks.py")
        self.assertIn("covered = verify_coverage(", source)
        self.assertIn("if failed or not covered:", source)

    def test_discovery_functions_exist(self):
        self.assertTrue(callable(run_checks.discover_python_tests))
        self.assertTrue(callable(run_checks.discover_bun_tests))


if __name__ == "__main__":
    unittest.main()
