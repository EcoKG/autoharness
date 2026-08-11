# -*- coding: utf-8 -*-
"""처방한 명령이 실재하는가 — **없는 명령을 시키면 사용자는 갇힌다.**

실측(2026-08-11): 훅 배선이 죽었을 때(`broken_path`) 경고와 문서가 한목소리로
`autoharness install --repo <저장소>` 를 시켰다. 그런데 `install` 에는 `--repo` 옵션이
없어서, 시킨 대로 친 사용자는 "알 수 없는 install 옵션입니다: repo" 만 받았다. 진단은
정확했고 처방은 실행 불가였다 — 이 조합이 가장 나쁘다. 진단이 틀렸으면 사용자가 의심이라도
하지만, 정확한 진단 뒤의 틀린 처방은 사용자가 자기를 의심하게 만든다.

여기서 고정하는 것은 **문서와 코드가 사용자에게 치라고 내미는 명령의 표면이 실재하는가**
이다. 문구를 고정하지 않는다 — 문장은 다듬어도 되지만, 서브커맨드와 옵션 이름은 실재해야
한다.
"""

import io
import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_TS = os.path.join(REPO, "daemon", "src", "main.ts")

#: 명령을 처방하는 곳 — 문서와, 사용자에게 문자열을 내미는 코드.
PRESCRIBING_FILES = (
    "README.md",
    "DESIGN.md",
    "CLAUDE.md",
    os.path.join("skill", "SKILL.md"),
    os.path.join(".claude", "settings.example.json"),
    os.path.join("daemon", "src", "hooks", "wiring.ts"),
    os.path.join("daemon", "src", "web", "ui.ts"),
    os.path.join("templates", "bootstrap_prompt.txt"),
)

#: 실행 파일 토큰과 그 뒤의 첫 낱말. 전체 경로 형태(`./dist/autoharness.exe run`)도 잡는다.
#: **같은 줄만 본다** — 줄바꿈까지 허용하면 SKILL.md 의 YAML 머리말
#: (`name: autoharness` 다음 줄 `description:`)이 서브커맨드로 읽힌다.
INVOCATION_RE = re.compile(
    r"([^\s\"'`]*autoharness(?:\.exe)?)[`\"']?[ 	]+(--?[a-z-]+|[a-z][a-z-]*)"
)

#: 스킬 슬래시 커맨드 — CLI 서브커맨드가 아니다(`/autoharness resume` 은 스킬 호출이다).
SKILL_INVOCATION = "/autoharness"


def invocations(text):
    """(서브커맨드) 목록 — **CLI 호출만** 남긴다.

    같은 낱말이 세 가지 다른 뜻으로 쓰인다:
      - `autoharness install …`   → CLI 호출 (검사 대상)
      - `/autoharness resume`     → 스킬 슬래시 커맨드 (모드 이름이지 서브커맨드가 아니다)
      - `claude "autoharness resume"` → claude 에게 주는 자연어 프롬프트
    뒤의 둘을 CLI 로 세면 실재하지 않는 서브커맨드라며 헛되이 실패한다."""
    out = []
    for m in INVOCATION_RE.finditer(text):
        exe, word = m.group(1), m.group(2)
        if exe == SKILL_INVOCATION:
            continue
        before = text[max(0, m.start() - 12):m.start()]
        if re.search(r"""claude\s+["']$""", before):
            continue
        out.append(word)
    return out


def read(rel):
    with io.open(os.path.join(REPO, rel), encoding="utf-8") as fh:
        return fh.read()


def cli_modes():
    """main.ts 의 MODES 배열 — CLI 표면의 단일 출처."""
    src = read(os.path.join("daemon", "src", "main.ts"))
    block = src[src.index("export const MODES = ["):]
    block = block[:block.index("] as const;")]
    return set(re.findall(r'"([a-z][a-z-]*)"', block))


def install_flags():
    """install 이 받아들이는 옵션 이름 — 미지 옵션은 거부되므로 이 집합이 곧 계약이다."""
    src = read(os.path.join("daemon", "src", "main.ts"))
    block = src[src.index("const INSTALL_FLAGS = new Set(["):]
    block = block[:block.index("]);")]
    return set(re.findall(r'"([a-z][a-z-]*)"', block))


class SurfaceExtractionTest(unittest.TestCase):
    """추출이 실패하면 이 파일의 다른 단정이 전부 공허해진다 — 먼저 못 박는다."""

    def test_modes_are_found(self):
        modes = cli_modes()
        self.assertIn("install", modes)
        self.assertIn("run", modes)
        self.assertGreater(len(modes), 10)

    def test_install_flags_are_found(self):
        flags = install_flags()
        self.assertIn("migrate", flags)
        self.assertIn("autostart", flags)
        self.assertNotIn("repo", flags, "install 에 --repo 가 생겼다면 이 테스트를 갱신하십시오")


class PrescribedSubcommandTest(unittest.TestCase):
    def test_every_prescribed_subcommand_exists(self):
        modes = cli_modes()
        for rel in PRESCRIBING_FILES:
            path = os.path.join(REPO, rel)
            if not os.path.isfile(path):
                continue
            for token in invocations(read(rel)):
                if token.startswith("-"):
                    continue  # `autoharness --version` 류는 서브커맨드가 아니다
                self.assertIn(token, modes,
                              "%s 가 없는 서브커맨드를 처방합니다: autoharness %s" % (rel, token))


class PrescribedInstallFlagTest(unittest.TestCase):
    """install 은 부작용 명령이라 미지 옵션을 거부한다 — 틀린 옵션 처방은 곧 실행 불가다."""

    INSTALL_RE = re.compile(r"autoharness(?:\.exe)?[`\"']?\s+install\s+((?:--[a-z-]+[^\n`]*?))(?=[`\n]|$)")

    def test_every_prescribed_install_flag_exists(self):
        flags = install_flags()
        for rel in PRESCRIBING_FILES:
            path = os.path.join(REPO, rel)
            if not os.path.isfile(path):
                continue
            for tail in self.INSTALL_RE.findall(read(rel)):
                for opt in re.findall(r"--([a-z-]+)", tail):
                    self.assertIn(opt, flags,
                                  "%s 가 없는 install 옵션을 처방합니다: --%s" % (rel, opt))

    def test_the_dead_option_does_not_come_back(self):
        """실측으로 사용자를 막다른 곳에 보낸 문자열이다.

        **처방형만 본다.** 결함의 내력을 설명하는 주석·문서에는 그 문자열이 나올 수밖에
        없고, 그것까지 막으면 왜 이렇게 됐는지 적을 수 없게 된다 — 기록을 지우는 규칙은
        재발을 막는 게 아니라 이유를 잃게 한다."""
        for rel in PRESCRIBING_FILES:
            path = os.path.join(REPO, rel)
            if not os.path.isfile(path):
                continue
            self.assertNotIn("autoharness install --repo", read(rel),
                             "%s 에 실행 불가 명령이 되살아났습니다" % rel)


class RepairCommandIsSingleSourcedTest(unittest.TestCase):
    """경고문이 명령을 직접 적으면 문서와 갈라진다 — 상수 하나에서 가져온다."""

    def setUp(self):
        self.wiring = read(os.path.join("daemon", "src", "hooks", "wiring.ts"))

    def test_repair_command_constant_exists(self):
        self.assertIn("export const REPAIR_COMMAND", self.wiring)

    def test_repair_command_uses_a_real_surface(self):
        m = re.search(r'export const REPAIR_COMMAND = "([^"]+)"', self.wiring)
        self.assertIsNotNone(m)
        parts = m.group(1).split()
        self.assertIn(parts[0], cli_modes())
        for opt in re.findall(r"--([a-z-]+)", m.group(1)):
            self.assertIn(opt, install_flags())

    def test_the_warning_uses_the_constant(self):
        warn = self.wiring[self.wiring.index("function brokenPathWarning"):]
        self.assertIn("REPAIR_COMMAND", warn[:1200])


if __name__ == "__main__":
    unittest.main()
