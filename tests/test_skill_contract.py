# -*- coding: utf-8 -*-
"""스킬 문서 계약 회귀 테스트 — skill/SKILL.md 가 코드·운영 계약과 어긋나지 않는지 검사.

원 결함(실사용 실측): 모드 표가 메커니즘 어휘("하네스 구축")로만 매칭해, 결과를 서술한
요청("검증하고 문제가 있으면 수정", "master 승격 가능한지 확인")이 어느 모드에도 걸리지
않았다. 게다가 매칭 실패 시 폴백 조항이 없어 에이전트가 장부·커밋 게이트·훅 없이 맨손
작업으로 빠졌다 — 스킬을 부른 의미가 사라지는 조용한 실패다.

여기서 고정하는 계약:
  ① frontmatter·모드 표가 결과 서술형 요청을 트리거로 포함한다
  ② 모드 판정 원칙에 장부 기반 폴백과 맨손 주행 금지가 명시돼 있다
  ③ 종료 코드 표가 실제 계약(daemon/src/exit.ts)과 일치한다
  ④ 폴백 표의 서브커맨드·옵션이 실제 CLI 표면(main.ts 의 MODES·INSTALL_FLAGS)과 일치하고,
     내부 모드를 제외한 모든 서브커맨드가 문서에 등장한다 (문서 드리프트 차단)
"""

import io
import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_TS = os.path.join(REPO, "daemon", "src", "main.ts")

SKILL_PATH = os.path.join(REPO, "skill", "SKILL.md")

# 훅은 settings.json 이 부르는 내부 표면이라 스킬 문서에 등장하지 않아도 된다
# 스킬이 안내할 대상이 아닌 모드 — 훅은 Claude Code 가 부르고, daemon·mcp 는 런타임이
# 스스로 띄우며, version 은 진단용이다. 에이전트가 절차 중에 칠 일이 없다.
INTERNAL_SUBCOMMANDS = {"hook-prebash", "hook-postbash", "hook-stop",
                        "daemon", "mcp", "version"}

# 하네스 호출 한 줄에서 서브커맨드를 뽑는다. **같은 줄만** 보고, CLI 호출이 아닌 두 형태는
# 걸러 낸다 — `/autoharness resume`(스킬 슬래시 커맨드)과 `claude "autoharness resume"`
# (claude 에게 주는 자연어 프롬프트). 셋을 뭉치면 없는 서브커맨드라며 헛되이 실패한다.
_Q = "\"'`"
ENGINE_CALL_RE = re.compile(
    r"([^\s" + _Q + r"]*(?:\$AH|autoharness(?:\.exe)?))[" + _Q + r"]?[ \t]+([a-z][a-z0-9-]*)")


def documented_calls(text):
    out = []
    for m in ENGINE_CALL_RE.finditer(text):
        exe, word = m.group(1), m.group(2)
        if exe == "/autoharness":
            continue
        before = text[max(0, m.start() - 12):m.start()]
        if re.search(r"""claude\s+["']$""", before):
            continue
        out.append(word)
    return out


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


def cli_modes():
    """v2 CLI 표면의 단일 출처 — main.ts 의 MODES 배열.

    종전에는 v1 엔진의 build_parser() 를 import 해서 얻었다. 그 엔진이 사라졌으므로
    이제 실제 표면인 TypeScript 선언을 읽는다. **문서가 아니라 코드에서 얻는다**는
    성질은 그대로다 — 그것이 이 테스트의 존재 이유다."""
    with io.open(MAIN_TS, encoding="utf-8") as fh:
        src = fh.read()
    block = src[src.index("export const MODES = ["):]
    block = block[:block.index("] as const;")]
    return set(re.findall(r'"([a-z][a-z-]*)"', block))


def install_flags():
    """install 이 받아들이는 옵션 — 미지 옵션은 거부되므로 이 집합이 곧 계약이다."""
    with io.open(MAIN_TS, encoding="utf-8") as fh:
        src = fh.read()
    block = src[src.index("const INSTALL_FLAGS = new Set(["):]
    block = block[:block.index("]);")]
    return set("--" + f for f in re.findall(r'"([a-z][a-z-]*)"', block))


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

    # 문서 주장 ↔ **실제 차단 동작**의 대조는 그 함수가 사는 곳으로 옮겼다:
    # daemon/test/command.test.ts 가 SKILL.md 를 읽어 denyReason 을 직접 호출한다.
    # 파이썬에서는 TS 함수를 부를 수 없어 소스 문자열만 훑게 되는데, 그것은 "차단된다"가
    # 아니라 "차단 규칙이 적혀 있다" 밖에 확인하지 못한다 — 약한 단정으로 바꾸느니
    # 진짜로 부를 수 있는 자리로 옮기는 편이 맞다.


def exit_constants():
    """v2 종료 코드 계약의 단일 출처 — daemon/src/exit.ts.

    종전에는 v1 엔진의 상수를 import 했다. 엔진이 사라졌으므로 실제 계약이 선언된
    곳에서 읽는다. **문서가 아니라 코드에서 얻는다**는 성질은 그대로다."""
    with io.open(os.path.join(REPO, "daemon", "src", "exit.ts"), encoding="utf-8") as fh:
        src = fh.read()
    block = src[src.index("export const EXIT = {"):]
    block = block[:block.index("} as const;")]
    return {name: int(num) for name, num in re.findall(r"(\w+):\s*(\d+)", block)}


class ExitCodeTableTest(unittest.TestCase):
    def test_table_codes_match_engine_constants(self):
        text = read_skill()
        section = section_of(text, "## 종료 코드 계약")
        self.assertTrue(section, "종료 코드 계약 절이 없습니다")
        codes = {int(m) for m in re.findall(r"^\|\s*([0-4])\s*\|", section, re.MULTILINE)}
        self.assertEqual(codes, {0, 1, 2, 3, 4}, "종료 코드 표가 불완전합니다: %s" % sorted(codes))
        exits = exit_constants()
        self.assertEqual(exits, {"OK": 0, "FAIL": 1, "USAGE": 2, "NO_TASK": 3, "BLOCKED": 4},
                         "종료 코드 계약이 바뀌었습니다: %s" % exits)


class SkillDesignModeSyncTest(unittest.TestCase):
    """SKILL.md 모드 표 ↔ DESIGN §11 모드 목록 교차 검증.

    실측 드리프트: ops 모드를 SKILL 에 추가했을 때 DESIGN 은 "본문 모드 4개" 로 남아
    있었다. 사람이 두 문서를 눈으로 맞추는 방식은 반복해서 실패하므로 기계로 대조한다.
    """

    DESIGN_PATH = os.path.join(REPO, "DESIGN.md")
    BOLD_MODE_RE = re.compile(r"\*\*([a-z][a-z-]*)\*\*")

    def skill_modes(self):
        text = read_skill()
        start = text.find("| 요청 신호 | 모드 |")
        self.assertGreater(start, 0, "SKILL.md 에 모드 표가 없습니다")
        modes = set()
        for line in text[start:].splitlines()[1:]:
            if not line.startswith("|"):
                break
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            modes.update(self.BOLD_MODE_RE.findall(cells[-1]))
        return modes

    def design_modes(self):
        with open(self.DESIGN_PATH, "r", encoding="utf-8") as f:
            text = f.read().replace("\r\n", "\n")
        start = text.find("## 11. 스킬")
        self.assertGreater(start, 0, "DESIGN 에 스킬 절이 없습니다")
        section = text[start:text.find("## 12.", start)]
        anchor = section.find("본문 모드")
        self.assertGreater(anchor, 0, "DESIGN 스킬 절에 모드 목록이 없습니다")
        return set(re.findall(r"^- \*\*([a-z][a-z-]*)\*\*", section[anchor:], re.MULTILINE))

    def test_mode_sets_match(self):
        skill, design = self.skill_modes(), self.design_modes()
        self.assertTrue(skill, "SKILL 모드 추출 실패")
        self.assertEqual(
            skill, design,
            "SKILL 과 DESIGN 의 모드 목록이 다릅니다 — SKILL 전용=%s, DESIGN 전용=%s"
            % (sorted(skill - design), sorted(design - skill)))

    def test_expected_modes_are_covered(self):
        self.assertEqual(
            self.skill_modes(),
            {"init", "resume", "status", "pause", "resume-project", "ops"})

    def test_design_no_longer_claims_four_modes(self):
        with open(self.DESIGN_PATH, "r", encoding="utf-8") as f:
            self.assertNotIn("본문 모드 4개", f.read())


class CliSurfaceSyncTest(unittest.TestCase):
    """스킬 문서에 적힌 하네스 호출이 실제 CLI 표면과 일치하는지 — 문서 드리프트 차단."""

    def setUp(self):
        self.text = read_skill()
        self.modes = cli_modes()

    def documented_subcommands(self):
        return set(documented_calls(self.text))

    def test_documented_subcommands_all_exist(self):
        unknown = sorted(self.documented_subcommands() - self.modes)
        self.assertEqual(unknown, [], "문서에 있으나 CLI 에 없는 서브커맨드: %s" % unknown)

    def test_the_extraction_actually_found_something(self):
        """정규식이 아무것도 못 잡으면 위 단정이 공허해진다 — 먼저 못 박는다."""
        self.assertGreater(len(self.documented_subcommands()), 5)
        self.assertIn("run", self.modes)

    def test_every_public_subcommand_is_documented(self):
        public = self.modes - INTERNAL_SUBCOMMANDS
        documented = self.documented_subcommands()
        for name in sorted(public):
            if name in documented or re.search(r"`%s`" % re.escape(name), self.text):
                continue
            self.fail("공개 서브커맨드가 스킬 문서에 없습니다: %s" % name)

    def test_documented_install_flags_exist(self):
        """install 은 부작용 명령이라 미지 옵션을 거부한다 — 틀린 옵션 안내는 곧 실행 불가다."""
        valid = install_flags()
        checked = 0
        for line in self.text.splitlines():
            m = re.search(
                r"(?:\$AH|autoharness(?:\.exe)?)[" + _Q + r"]?[ \t]+install[ \t]", line)
            if not m:
                continue
            for flag in re.findall(r"(--[a-z][a-z0-9-]*)", line[m.end():]):
                self.assertIn(flag, valid, "install 에 없는 옵션이 문서에 있습니다: %s" % flag)
                checked += 1
        self.assertGreater(checked, 0, "install 옵션 검사 표본이 없습니다(정규식 확인 필요)")

    def test_per_task_test_cmd_documented_in_fallback_table(self):
        self.assertIn("--test-cmd", self.text)


class V2OnlySurfaceTest(unittest.TestCase):
    """스킬 문서가 **v2 표면만** 안내하는지.

    전에는 반대 계약이었다 — v1 과 v2 가 공존하니 어느 쪽이 깔렸는지 먼저 판별하라는
    것이었고, 그 판별을 빠뜨려 v2 사용자에게 없는 파일을 실행하라고 시킨 적이 있다.
    v1 을 제거한 지금은 같은 위험이 방향만 바꿔 남는다: 문서에 v1 명령이 되살아나면
    이번엔 **모든** 사용자가 없는 파일을 부르게 된다.
    """

    def setUp(self):
        self.text = read_skill()

    def test_no_v1_commands_remain(self):
        for dead in ("harness_engine.py", "harness_mcp.py", "harness_watchdog.py",
                     "agent_harness.sh"):
            self.assertNotIn(dead, self.text, "제거된 v1 명령이 문서에 남아 있습니다: %s" % dead)

    def test_no_implementation_choice_is_offered(self):
        """구현이 하나뿐인데 고르라고 하면 없는 갈래를 찾게 된다."""
        self.assertNotIn("v1 인가 v2 인가", self.text)
        self.assertNotIn("두 구현이 공존", self.text)

    def test_fallback_names_the_installed_executable(self):
        section = self.text[self.text.find("## MCP 미등록 환경 폴백"):]
        self.assertIn(".claude/autoharness/bin/autoharness", section)
        self.assertIn("$AH", section)

    def test_loop_steps_use_the_v2_surface(self):
        """루프 본문(작업 선택·검증)이 실제로 실행 가능한 명령을 말해야 한다."""
        idx = self.text.find("**다음 작업 선택**")
        self.assertGreater(idx, 0)
        body = self.text[idx:idx + 400]
        self.assertIn("next --repo", body)
        self.assertIn("run --repo", body)

    def test_autostart_is_not_described_as_an_os_scheduler_job(self):
        """v2 는 데몬이 자기 시계로 돈다 — 주기 작업을 OS 에 걸지 않는다."""
        section = self.text[self.text.find("## MCP 미등록 환경 폴백"):]
        self.assertNotIn("schtasks", section)
        self.assertIn("install --autostart", section)


if __name__ == "__main__":
    unittest.main()
