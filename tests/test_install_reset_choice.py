# -*- coding: utf-8 -*-
"""설치할 때 기존 상태를 보존할지 초기화할지 고르는 경로.

두 가지가 성격이 다르다. **v1 잔재는 묻지 않는다** — 부를 코드가 없는 파일이라
물어볼 여지가 없다. **v2 런타임 상태는 묻는다** — 등록된 프로젝트와 주행 이력이고,
지우면 되돌릴 방법이 없다.

여기서 고정하는 것은 세 가지다:
  ① 기본이 보존인가 — 답을 받지 못한 경우(비대화형·EOF·프롬프트 불가)에도 보존인가.
  ② 원라인 설치(`curl … | bash`)에서 stdin 을 읽지 않는가. stdin 은 **설치 스크립트
     자신**이라 거기서 read 하면 스크립트의 다음 줄을 답으로 먹고, 그 줄은 실행되지
     않는다 — 설치가 조용히 반쯤 되는 최악의 실패다.
  ③ 지우는 주체가 EXE 하나인가 — 셸이 직접 지우기 시작하면 규칙이 또 갈라진다.

설치 스크립트를 **실행하지 않는다**. 실행하면 실제 사용자 설치본을 건드리게 된다
(CLAUDE.md 6절). 소스에서 분기를 읽어 대조한다.
"""

import io
import os
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(name):
    with io.open(os.path.join(REPO, name), encoding="utf-8") as fh:
        return fh.read()


SH = "install.sh"
PS1 = "install.ps1"
MAIN_TS = os.path.join("daemon", "src", "main.ts")
INSTALL_TS = os.path.join("daemon", "src", "install", "install.ts")
CLEANUP_TS = os.path.join("daemon", "src", "install", "cleanup.ts")


class ChoiceIsOfferedTest(unittest.TestCase):
    """두 설치기 모두 선택지를 받는가."""

    def test_bash_accepts_both_flags(self):
        source = read(SH)
        self.assertIn("--reset)", source)
        self.assertIn("--keep)", source)

    def test_powershell_accepts_both_switches(self):
        source = read(PS1)
        self.assertIn("[switch]$Reset", source)
        self.assertIn("[switch]$Keep", source)

    def test_exe_accepts_both_flags(self):
        source = read(MAIN_TS)
        self.assertIn('"reset", "keep"', source)
        self.assertIn("--reset", source)
        self.assertIn("--keep", source)

    def test_contradiction_is_refused_everywhere(self):
        """하나를 실행하면 다른 하나는 되돌릴 수 없다 — 짐작하지 않는다."""
        for name in (SH, PS1, MAIN_TS):
            self.assertIn("함께 줄 수 없습니다", read(name),
                          "%s 가 모순된 지시를 거부하지 않습니다" % name)


class DefaultIsKeepTest(unittest.TestCase):
    """답을 받지 못했을 때 무엇을 하는가 — 파괴가 기본값이면 안 된다."""

    def test_bash_defaults_to_keep_when_unset(self):
        # 값이 비어 있으면 keep 으로 굳어져 EXE 에 넘어간다
        self.assertIn('args+=("--${RESET_CHOICE:-keep}")', read(SH))

    def test_bash_keeps_when_there_is_no_tty(self):
        source = read(SH)
        self.assertIn("[ ! -r /dev/tty ]", source)
        block = source[source.index("ask_reset_choice() {"):source.index('\n}', source.index("ask_reset_choice() {"))]
        self.assertIn('RESET_CHOICE="keep"', block)
        self.assertNotIn('RESET_CHOICE="reset"\n    fi', block)

    def test_powershell_keeps_when_input_is_redirected(self):
        source = read(PS1)
        self.assertIn("[Console]::IsInputRedirected", source)
        block = source[source.index("function Resolve-ResetChoice"):source.index("# --------", source.index("function Resolve-ResetChoice"))]
        # 리디렉션 분기와 프롬프트 실패 분기 둘 다 보존으로 떨어진다
        self.assertGreaterEqual(block.count('return "keep"'), 3)

    def test_powershell_falls_back_to_keep_if_prompt_fails(self):
        source = read(PS1)
        self.assertIn("catch { return \"keep\" }", source)

    def test_exe_only_resets_when_told(self):
        source = read(INSTALL_TS)
        self.assertIn("if (options.reset)", source)
        self.assertIn('reset: flags["reset"] === true', read(MAIN_TS))


class PromptDoesNotEatTheScriptTest(unittest.TestCase):
    """`curl … | bash` 에서 stdin 은 설치 스크립트 자신이다."""

    def test_bash_reads_from_the_terminal_not_stdin(self):
        source = read(SH)
        self.assertIn("read -r answer < /dev/tty", source)
        # stdin 에서 읽는 read 가 하나도 없어야 한다
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith("read ") or stripped.startswith("read\t"):
                self.assertIn("/dev/tty", stripped, "stdin 에서 읽습니다: %s" % stripped)

    def test_bash_prompt_writes_to_the_terminal(self):
        self.assertIn("> /dev/tty", read(SH))


class OnlyTheExeDeletesTest(unittest.TestCase):
    """지우는 코드는 한 곳에만 있어야 한다."""

    def test_scripts_do_not_delete_runtime_state_themselves(self):
        """지우는 명령이 런타임 경로를 가리키면 안 된다.

        스킬 폴더(rm -rf "$DST")는 대상이 아니다 — 그쪽은 설치가 다시 채운다."""
        for name, runtime_var, delete_markers in (
            (SH, "$RUNTIME", ("rm -rf", "rm -f", "rm ")),
            (PS1, "$RuntimeDir", ("Remove-Item",)),
        ):
            for line in read(name).splitlines():
                if runtime_var not in line:
                    continue
                for marker in delete_markers:
                    self.assertFalse(
                        marker in line,
                        "%s 가 런타임 상태를 직접 지웁니다: %s" % (name, line.strip()),
                    )

    def test_scripts_pass_the_choice_to_the_exe(self):
        self.assertIn('args+=("--${RESET_CHOICE:-keep}")', read(SH))
        self.assertIn('$args += ("--" + $ResetChoice)', read(PS1))

    def test_reset_is_implemented_once(self):
        self.assertIn("export async function resetV2", read(CLEANUP_TS))
        self.assertIn("resetV2", read(INSTALL_TS))


class V1CleanupIsNotAChoiceTest(unittest.TestCase):
    """v1 정리는 선택지가 아니다 — 사용자 요구."""

    def test_cleanup_runs_before_and_outside_the_reset_branch(self):
        source = read(INSTALL_TS)
        purge = source.index("await purgeV1(")
        branch = source.index("if (options.reset)")
        self.assertLess(purge, branch, "v1 정리가 초기화 선택에 딸려 갑니다")

    def test_the_prompt_never_mentions_v1(self):
        """묻는 화면에 v1 이야기가 섞이면 사용자가 v1 정리도 거절할 수 있다고 읽는다."""
        for name, marker, end in ((SH, "ask_reset_choice() {", "\n}"),
                                  (PS1, "function Resolve-ResetChoice", "\n}")):
            source = read(name)
            start = source.index(marker)
            body = source[start:source.index(end, start)]
            self.assertFalse("v1" in body, "%s 의 선택 화면이 v1 을 언급합니다" % name)

    def test_scripts_say_v1_cleanup_is_not_a_choice(self):
        """다음 사람이 '왜 v1 은 안 묻지' 로 헤매지 않게 코드가 스스로 말한다."""
        for name in (SH, PS1):
            self.assertIn("선택지가 아니", read(name))


class PromptTellsTheTruthTest(unittest.TestCase):
    """안내가 약속하는 것과 실제로 지우는 것이 같은가."""

    def test_prompt_names_what_disappears(self):
        for name in (SH, PS1):
            source = read(name)
            self.assertIn("레지스트리·로그·토큰을 지우고", source)

    def test_prompt_says_the_repo_ledger_survives(self):
        for name in (SH, PS1):
            self.assertIn("agent_tracker.json", read(name).replace("\\", "/"))

    def test_reset_really_spares_the_repo_ledger(self):
        """약속을 코드가 지키는가 — 초기화 대상은 계정 경로뿐이다."""
        source = read(CLEANUP_TS)
        start = source.index("export function v2StateTargets")
        block = source[start:source.index("\n}", start)]
        self.assertNotIn("repoPaths", block)
        self.assertNotIn("tracker", block)

    def test_reset_targets_are_what_the_prompt_says(self):
        source = read(CLEANUP_TS)
        start = source.index("export function v2StateTargets")
        block = source[start:source.index("\n}", start)]
        for named in ("registry", "logs", "webToken"):
            self.assertIn(named, block)


if __name__ == "__main__":
    unittest.main()
