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
        self.assertIn("install --migrate", self.design)


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

    def test_prompt_names_the_installed_executable(self):
        """프롬프트가 없는 파일을 부르면 자동 부활한 세션이 첫 명령부터 실패한다 —
        헤드리스라 그 실패는 세션 로그에만 남는다."""
        self.assertIn("autoharness", self.prompt)
        self.assertIn(".claude/autoharness/bin", self.prompt)

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
        self.assertIn("autoharness/bin/autoharness", claude)
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



class DeployBoundaryDocsTest(unittest.TestCase):
    """배포 경계가 문서에 있고, 문서가 말하는 항목이 실제 명세와 어긋나지 않는가.

    문장을 통째로 비교하지 않는다 — 문서를 다듬을 때마다 깨지면 결국 단정문이 약해진다.
    고정하는 것은 **명세가 정한 항목이 문서에 이름으로 등장하는가** 이다."""

    def setUp(self):
        sys.path.insert(0, SCRIPTS)
        import deploy_manifest
        self.man = deploy_manifest
        self.readme = read("README.md")
        self.design = read("DESIGN.md")
        self.claude = read("CLAUDE.md")

    def test_readme_has_a_single_deploy_boundary_section(self):
        self.assertIn("배포 경계", self.readme)
        for heading in ("설치본으로 가는 것", "절대 나가지 않는 것",
                        "기계에 속하는 것", "하지 않는"):
            self.assertIn(heading, self.readme, "배포 경계 절에 '%s' 가 없습니다" % heading)

    def test_readme_names_every_deployed_file(self):
        for _, dst in self.man.DEPLOY_FILES:
            self.assertIn(dst, self.readme, "README 가 배포 대상 %s 를 말하지 않습니다" % dst)

    def test_readme_names_every_deployed_directory(self):
        for _, dst_dir, _ in self.man.DEPLOY_DIRS:
            self.assertIn(dst_dir, self.readme)

    def test_readme_names_the_forbidden_categories(self):
        """금지 목록이 늘었는데 문서가 그대로면, 사람은 옛 경계를 믿는다."""
        for name in ("agent_tracker.json", "settings.json", "PROGRESS.md",
                     "checks-timing.json", "CLAUDE.md", "node_modules", "__pycache__"):
            self.assertIn(name, self.readme, "README 가 금지 항목 %s 를 말하지 않습니다" % name)

    def test_readme_lists_the_actions_the_harness_refuses(self):
        for act in ("git push", "gh ", "reset --hard"):
            self.assertIn(act, self.readme)

    def test_design_records_the_single_source(self):
        self.assertIn("deploy_manifest.py", self.design)
        self.assertIn("test_installer_parity.py", self.design)

    def test_claude_md_tells_the_worker_where_to_edit(self):
        self.assertIn("deploy_manifest.py", self.claude)
        self.assertIn("test_installer_parity.py", self.claude)

    def test_docs_do_not_claim_settings_json_is_tracked(self):
        """실측으로 틀린 것이 확인된 안내가 되살아나지 않게 한다."""
        self.assertNotIn("| `.claude/settings.json` | 훅 4종·권한 (기존 설정과 병합, 백업 생성) | 추적 |",
                         self.readme)
        self.assertIn("settings.example.json", self.readme)

    def test_the_exe_destination_is_documented_separately_from_the_skill_dir(self):
        """스킬 폴더와 런타임 디렉토리는 다른 자리다 — 뭉치면 EXE 가 어디 가는지 알 수 없다."""
        self.assertIn(".claude/autoharness/bin", self.readme)
        self.assertIn(".claude/skills/autoharness", self.readme)


if __name__ == "__main__":
    unittest.main()


class NoV1ResurrectionTest(unittest.TestCase):
    """제거한 v1 이 문서로 되살아나지 않게 한다.

    코드에서 지운 것을 문서가 계속 안내하면, 사용자는 없는 파일을 실행하라는 지시를 받는다 —
    이 프로젝트가 부트스트랩 프롬프트에서 실제로 겪은 실패다. 소스는 이미 사라졌으므로
    남은 위험은 전부 문서 쪽에 있다."""

    DEAD_NAMES = ("harness_engine.py", "harness_mcp.py", "harness_watchdog.py",
                  "agent_harness.sh")
    DOCS = ("README.md", "DESIGN.md", "CLAUDE.md",
            os.path.join("skill", "SKILL.md"),
            os.path.join("templates", "bootstrap_prompt.txt"),
            os.path.join("templates", "CLAUDE.md.tmpl"))

    #: 실행하라고 내미는 형태. 이름을 **언급**하는 것과는 다르다 — 이전 배선이 어떤
    #: 모양이었는지 설명하려면 이름을 적을 수밖에 없고, 그것까지 막으면 이행 안내를
    #: 쓸 수 없다. 금지하는 것은 "이걸 실행하라" 다.
    INVOCATION_RE = re.compile(
        r"""(?:python3?|bash)\s+["']?[^\s`"']*(?:harness_engine\.py|agent_harness\.sh)["']?\s+[a-z-]""")

    def test_no_document_prescribes_a_removed_command(self):
        for rel in self.DOCS:
            if not os.path.isfile(os.path.join(REPO, rel)):
                continue
            m = self.INVOCATION_RE.search(read(rel))
            self.assertIsNone(m, "%s 가 제거된 명령을 실행하라고 안내합니다: %s"
                              % (rel, m.group(0) if m else ""))

    def test_the_guard_would_catch_a_real_resurrection(self):
        """정규식이 아무것도 못 잡으면 위 단정이 공허해진다 — 대표 사례로 확인한다."""
        for sample in ('python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" next',
                       "bash scripts/agent_harness.sh --task t1"):
            self.assertIsNotNone(self.INVOCATION_RE.search(sample), sample)

    def test_the_files_really_are_gone(self):
        """문서만 고치고 파일이 남아 있으면 이 검사는 거짓 안심이다."""
        for rel in ("bin", os.path.join("scripts", "harness_engine.py"),
                    os.path.join("scripts", "agent_harness.sh"),
                    os.path.join("templates", "agent_harness.sh")):
            self.assertFalse(os.path.exists(os.path.join(REPO, rel)),
                             "%s 가 아직 있습니다" % rel)

    def test_readme_states_the_breaking_change(self):
        """v1 배선을 가진 저장소는 자동 복구되지 않는다 — 그 사실이 안내에 있어야 한다."""
        readme = read("README.md")
        self.assertIn("이전 버전", readme)
        self.assertIn("자동으로 복구되지 않습니다", readme)
        self.assertIn("rm .claude/settings.json", readme)

    def test_docs_do_not_offer_an_implementation_choice(self):
        for rel in ("README.md", os.path.join("skill", "SKILL.md")):
            text = read(rel)
            self.assertNotIn("두 구현이 공존", text)
