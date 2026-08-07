# -*- coding: utf-8 -*-
"""스킬 문서 계약 회귀 테스트 — skill/SKILL.md 가 코드·운영 계약과 어긋나지 않는지 검사.

원 결함(실사용 실측): 모드 표가 메커니즘 어휘("하네스 구축")로만 매칭해, 결과를 서술한
요청("검증하고 문제가 있으면 수정", "master 승격 가능한지 확인")이 어느 모드에도 걸리지
않았다. 게다가 매칭 실패 시 폴백 조항이 없어 에이전트가 장부·커밋 게이트·훅 없이 맨손
작업으로 빠졌다 — 스킬을 부른 의미가 사라지는 조용한 실패다.

여기서 고정하는 계약:
  ① frontmatter·모드 표가 결과 서술형 요청을 트리거로 포함한다
  ② 모드 판정 원칙에 장부 기반 폴백과 맨손 주행 금지가 명시돼 있다
  ③ 종료 코드 표가 엔진 상수와 일치한다
  ④ 폴백 표의 서브커맨드·옵션이 실제 CLI 표면(build_parser)과 일치하고, 훅을 제외한
     모든 서브커맨드가 문서에 등장한다 (문서 드리프트 차단)
"""

import argparse
import os
import re
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402

SKILL_PATH = os.path.join(REPO, "skill", "SKILL.md")

# 훅은 settings.json 이 부르는 내부 표면이라 스킬 문서에 등장하지 않아도 된다
INTERNAL_SUBCOMMANDS = {"hook-prebash", "hook-postbash", "hook-stop"}

# 엔진 호출 한 줄에서 서브커맨드를 뽑는다: ... harness_engine.py[" ] <subcmd>
ENGINE_CALL_RE = re.compile(r"harness_engine\.py\"?\s+([a-z][a-z0-9-]*)")


def read_skill():
    with open(SKILL_PATH, "r", encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")   # 개행 정규화 — 구분선 탐색이 CRLF 에 걸리지 않게


def section_of(text, heading):
    """heading 부터 다음 수평 구분선(단독 줄 ---)까지. 표 구분줄 |---|---| 과 혼동하지 않는다."""
    start = text.find(heading)
    if start < 0:
        return ""
    m = re.search(r"\n---+[ \t]*\n", text[start:])
    return text[start:start + m.start()] if m else text[start:]


def parse_frontmatter(text):
    """--- 로 감싼 앞머리를 key: value 로 얕게 파싱(stdlib 만 사용)."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out, key = {}, None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if m:
            key = m.group(1)
            out[key] = m.group(2).strip()
        elif key:                      # 접힌 줄 이어붙이기
            out[key] += " " + line.strip()
    return out


def subparser_map():
    """build_parser() 에서 {서브커맨드: 파서} 를 뽑는다."""
    for action in eng.build_parser()._actions:
        if isinstance(action, argparse._SubParsersAction):
            return dict(action.choices)
    raise AssertionError("엔진 파서에 서브커맨드가 없습니다")


class SkillFileTest(unittest.TestCase):
    def setUp(self):
        self.text = read_skill()

    def test_skill_file_exists_and_is_the_installed_source(self):
        # deploy_live 매핑상 skill/SKILL.md 가 설치본 SKILL.md 의 원본이다
        self.assertTrue(os.path.isfile(SKILL_PATH), SKILL_PATH)
        self.assertIn("# AutoHarness", self.text)

    def test_frontmatter_name_and_outcome_triggers(self):
        fm = parse_frontmatter(self.text)
        self.assertEqual(fm.get("name"), "autoharness")
        desc = fm.get("description", "")
        self.assertTrue(desc, "description 이 비어 있습니다")
        # 메커니즘 어휘만 있으면 결과 서술형 요청에서 스킬이 아예 안 뜬다
        for kw in ("검증", "수정", "이식", "고도화"):
            self.assertIn(kw, desc, "description 에 결과 서술형 트리거 누락: %s" % kw)


class ModeRoutingContractTest(unittest.TestCase):
    def setUp(self):
        self.text = read_skill()

    def test_all_modes_present_in_table(self):
        # pause 와 resume-project 는 한 칸에 묶여 있으면 발화만으로 갈리지 않아 행을 분리했다
        for mode in ("**init**", "**resume**", "**status**", "**pause**",
                     "**resume-project**", "**ops**"):
            self.assertIn(mode, self.text, "모드 표에 누락: %s" % mode)

    def test_outcome_phrased_requests_are_routed(self):
        # 실패했던 실제 요청 형태가 표/설명에 예시로 박혀 있어야 한다
        self.assertIn("결과 서술형", self.text)
        for kw in ("승격", "검증", "테스트"):
            self.assertIn(kw, self.text, "결과 서술형 예시에 누락: %s" % kw)

    def test_routing_principles_section_exists(self):
        self.assertIn("모드 판정 원칙", self.text)

    def principles_section(self):
        """'모드 판정 원칙' 부터 그다음 절('공통 원칙') 직전까지."""
        idx = self.text.find("모드 판정 원칙")
        self.assertGreater(idx, 0, "모드 판정 원칙 절이 없습니다")
        end = self.text.find("공통 원칙", idx)
        return self.text[idx:end if end > idx else len(self.text)]

    def test_fallback_rule_is_ledger_based(self):
        # 판정 애매 시 장부 존재로 init↔resume 를 가르라는 규칙
        section = self.principles_section()
        self.assertIn("agent_tracker.json", section)
        self.assertIn("task_add", section)
        self.assertRegex(section, r"없으면\s*\*\*init\*\*")

    def test_barehanded_multistep_work_is_forbidden(self):
        section = self.principles_section()
        self.assertIn("금지", section)
        self.assertIn("맨손", section)

    def test_reinit_over_existing_ledger_is_warned(self):
        # 장부가 있는데 init 재실행하면 진행 상태가 날아간다는 경고
        self.assertRegex(self.text, r"장부가 있는데 init.*날아간다")


class RoutingHardeningTest(unittest.TestCase):
    """적대 검증(독립 에이전트 10명)이 찾아낸 후속 빈틈에 대한 회귀 고정.

    라우팅을 의도 기반으로 넓히면서 새로 생긴 위험 — 특히 폴백이 무조건 init 으로
    떨어져 훅·권한 우회·워치독이 비가역 설치되는 문제 — 를 문서가 계속 막는지 검사한다.
    """

    def setUp(self):
        self.text = read_skill()

    def test_fallback_init_requires_notice(self):
        # 최대 위험: 확신 없는 폴백이 비가역 환경 변경(훅·bypass·스케줄러)을 설치하는 것
        self.assertRegex(self.text, r"폴백으로\s*\n?\s*도달한 init 은 즉시 실행하지 않는다")
        self.assertIn("비가역", self.text)
        self.assertIn("고지", self.text)

    def test_init_has_ledger_existence_gate(self):
        idx = self.text.find("### ⓪")
        self.assertGreater(idx, 0, "init ⓪ 장부 실존 확인 단계가 없습니다")
        gate = self.text[idx:idx + 400]
        self.assertIn("agent_tracker.json", gate)
        self.assertIn("중단", gate)

    def test_resume_has_task_add_step_zero(self):
        idx = self.text.find("## 모드 2: resume")
        self.assertGreater(idx, 0)
        section = self.text[idx:self.text.find("## 모드 3", idx)]
        self.assertRegex(section, r"0\.\s*\*\*신규 결과 요청")
        self.assertIn("task_add", section)

    def test_exit3_right_after_entry_is_treated_as_missing_load(self):
        # 조용한 실패가 옮겨간 자리: 적재 없이 next → exit 3 → "완료" 오보고
        self.assertRegex(self.text, r"첫 `next` 가 곧바로 3 이면 정상 종료가 아니라")

    def test_direct_path_is_named_and_ordered(self):
        section = self.text[self.text.find("모드 판정 원칙"):]
        self.assertIn("direct", section)
        self.assertRegex(section, r"평가 순서 고정")
        # direct 는 금지된 '맨손'이 아니라는 구분이 명시돼야 한다
        self.assertRegex(section, r"4번이 금지하는 \"맨손\"이 아니다")

    def test_ops_row_exists_for_teardown_requests(self):
        # "그만 돌려"(영구 해제)가 폴백을 타고 resume 으로 뒤집히면 정반대 오분기다
        self.assertIn("**ops**", self.text)
        for tool in ("watchdog_uninstall", "model_set", "task_set"):
            self.assertIn(tool, self.text, "ops 행에 %s 누락" % tool)

    def test_status_row_covers_diagnostic_queries(self):
        self.assertRegex(self.text, r"왜 멈췄어")
        self.assertRegex(self.text, r"읽기만 하는 요청")

    def test_resume_vs_resume_project_disambiguated_by_flag(self):
        section = self.text[self.text.find("모드 판정 원칙"):]
        self.assertIn("HARNESS_PAUSED", section)
        self.assertRegex(section, r"없으면 \*\*resume\*\*")

    def test_target_repo_must_be_resolved_first(self):
        self.assertRegex(self.text, r"대상 저장소를? (절대경로를 )?먼저 확정")
        self.assertRegex(self.text, r"경로를? (특정|확정)하기 전에는 어떤 도구도 호출하지 않는다")

    def test_deploy_boundary_is_stated(self):
        # description 이 "배포 준비"를 트리거로 광고하므로 한계선이 없으면 오보고가 난다
        self.assertRegex(self.text, r"배포 완료로 (\*\*)?오보고하지 않는다")
        self.assertIn("git push", self.text)

    def test_push_is_actually_blocked_by_engine(self):
        # 문서의 한계선 주장이 엔진 차단 규칙과 실제로 일치하는지 대조
        self.assertTrue(any(pat.search("git push origin main") for pat, _ in eng.DENY_PATTERNS),
                        "엔진이 git push 를 차단하지 않는데 문서는 차단된다고 적혀 있습니다")


class ExitCodeTableTest(unittest.TestCase):
    def test_table_codes_match_engine_constants(self):
        text = read_skill()
        section = section_of(text, "## 종료 코드 계약")
        self.assertTrue(section, "종료 코드 계약 절이 없습니다")
        codes = {int(m) for m in re.findall(r"^\|\s*([0-4])\s*\|", section, re.MULTILINE)}
        self.assertEqual(codes, {0, 1, 2, 3, 4}, "종료 코드 표가 불완전합니다: %s" % sorted(codes))
        self.assertEqual(
            (eng.EXIT_OK, eng.EXIT_FAIL, eng.EXIT_USAGE, eng.EXIT_NO_TASK, eng.EXIT_BLOCKED),
            (0, 1, 2, 3, 4))


class CliSurfaceSyncTest(unittest.TestCase):
    """스킬 문서에 적힌 엔진 호출이 실제 CLI 표면과 일치하는지 — 문서 드리프트 차단."""

    def setUp(self):
        self.text = read_skill()
        self.subs = subparser_map()

    def documented_subcommands(self):
        return {m for m in ENGINE_CALL_RE.findall(self.text)}

    def test_documented_subcommands_all_exist(self):
        unknown = sorted(self.documented_subcommands() - set(self.subs))
        self.assertEqual(unknown, [], "문서에 있으나 엔진에 없는 서브커맨드: %s" % unknown)

    def test_every_public_subcommand_is_documented(self):
        public = set(self.subs) - INTERNAL_SUBCOMMANDS
        # 보조 서브커맨드 목록 줄(next/render/brief/sync-commit/selftest)도 문서 등장으로 인정한다
        documented = self.documented_subcommands()
        for name in sorted(public):
            if name in documented or re.search(r"`%s`" % re.escape(name), self.text):
                continue
            self.fail("공개 서브커맨드가 스킬 문서에 없습니다: %s" % name)

    def test_documented_flags_exist_on_their_subcommand(self):
        """폴백 표 각 줄의 `--flag` 가 그 서브커맨드에 실제로 있는지 검사."""
        checked = 0
        for line in self.text.splitlines():
            m = ENGINE_CALL_RE.search(line)
            if not m:
                continue
            name = m.group(1)
            sp = self.subs.get(name)
            if sp is None:
                continue
            valid = {opt for a in sp._actions for opt in a.option_strings}
            for flag in re.findall(r"(--[a-z][a-z0-9-]*)", line[m.end():]):
                self.assertIn(flag, valid,
                              "%s 에 없는 옵션이 문서에 있습니다: %s" % (name, flag))
                checked += 1
        self.assertGreater(checked, 10, "옵션 검사 표본이 너무 적습니다(정규식 확인 필요)")

    def test_per_task_test_cmd_documented_in_fallback_table(self):
        # 이번 라운드에 노출한 옵션이 폴백 표에 반영돼 있어야 한다
        for name in ("add-task", "set-task"):
            self.assertIn("--test-cmd", self.subs[name].format_usage())
        self.assertIn("--test-cmd", self.text)


if __name__ == "__main__":
    unittest.main()
