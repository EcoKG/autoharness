# -*- coding: utf-8 -*-
"""로컬 설정 경계 — **훅 배선은 저장소가 아니라 기계에 속한다.**

훅 명령에는 설치 시점의 절대 EXE 경로가 박힌다. Claude Code 는 훅 명령의 `~`·`%VAR%` 를
풀어 주지 않고, 상대 경로는 훅이 현재 작업 디렉토리에서 실행되므로 하위 폴더에서 게이트가
사라진다(daemon/DESIGN.md 5.1). 절대 경로가 유일한 선택지다.

그런데 `.claude/settings.json` 을 git 이 추적하면 그 절대 경로가 저장소를 따라 다닌다.
실측(2026-08-11): 이 저장소의 커밋된 설정이 다른 계정(ruinp)의 경로를 가리켜 커밋 게이트·
금지 명령 차단·SHA 동기화·Stop 게이트가 전부 무효였다. 고쳐서 커밋하면 이번엔 이 계정의
경로가 커밋돼 다음 사람에게 같은 일이 일어난다 — 그래서 추적하지 않는다.

참조를 잃지 않도록 예시 파일을 둔다. 예시는 **실재하지 않는 자리표시자**여야 한다 —
진짜 경로가 들어가면 예시가 곧 같은 문제가 된다.
"""

import io
import json
import os
import subprocess
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(".claude", "settings.json")
EXAMPLE = os.path.join(".claude", "settings.example.json")


def git(*args):
    r = subprocess.run(["git"] + list(args), cwd=REPO, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "")


def read(rel):
    with io.open(os.path.join(REPO, rel), encoding="utf-8") as fh:
        return fh.read()


class TrackingBoundaryTest(unittest.TestCase):
    def test_real_settings_is_not_tracked(self):
        code, out = git("ls-files", "--error-unmatch", SETTINGS)
        self.assertNotEqual(code, 0,
                            ".claude/settings.json 이 다시 추적 대상이 됐습니다 — "
                            "기계 고유 절대경로가 커밋됩니다")

    def test_real_settings_is_ignored(self):
        code, _ = git("check-ignore", "-q", SETTINGS)
        self.assertEqual(code, 0, ".claude/settings.json 이 .gitignore 에 없습니다")

    def test_gitignore_records_why(self):
        """규칙만 있고 이유가 없으면 다음 사람이 되돌린다."""
        text = read(".gitignore")
        self.assertIn(".claude/settings.json", text)
        self.assertIn("절대", text)

    def test_the_example_is_tracked(self):
        code, _ = git("ls-files", "--error-unmatch", EXAMPLE)
        self.assertEqual(code, 0, "예시 파일이 추적되지 않으면 참조가 사라집니다")


class ExampleContentTest(unittest.TestCase):
    def setUp(self):
        self.text = read(EXAMPLE)
        self.data = json.loads(self.text)

    def test_example_is_valid_json(self):
        self.assertIn("hooks", self.data)

    def test_example_declares_itself_an_example(self):
        self.assertIn("_comment", self.data)
        self.assertIn("예시", " ".join(self.data["_comment"]))

    def test_example_uses_a_placeholder_not_a_real_path(self):
        """진짜 경로가 들어가면 예시가 곧 같은 문제가 된다."""
        self.assertIn("<설치된-EXE-경로>", self.text)
        for leak in ("C:\\Users\\", "C:/Users/", "/home/", "/Users/"):
            self.assertNotIn(leak, self.text, "예시에 실제 홈 경로가 들어 있습니다: %s" % leak)

    def test_example_covers_all_four_hooks(self):
        events = set(self.data["hooks"].keys())
        self.assertEqual(events, {"SessionStart", "PreToolUse", "PostToolUse", "Stop"})

    def test_example_pins_the_repository(self):
        """--repo 가 없으면 엔진이 cwd 를 저장소로 삼아 게이트가 조용히 통과한다."""
        commands = [h["command"]
                    for entries in self.data["hooks"].values()
                    for entry in entries for h in entry["hooks"]]
        self.assertEqual(len(commands), 4)
        for cmd in commands:
            self.assertIn("--repo", cmd)
            self.assertIn("${CLAUDE_PROJECT_DIR}", cmd)

    def test_example_covers_both_command_tools(self):
        """matcher 가 한쪽만 덮으면 다른 도구로 게이트가 통째로 우회된다."""
        for event in ("PreToolUse", "PostToolUse"):
            matcher = self.data["hooks"][event][0]["matcher"]
            self.assertIn("Bash", matcher)
            self.assertIn("PowerShell", matcher)

    def test_example_explains_the_reason_not_just_the_shape(self):
        joined = " ".join(self.data["_comment"])
        self.assertIn("broken_path", joined)
        self.assertIn("install", joined)


class RecoveryPathTest(unittest.TestCase):
    """새로 클론한 사람이 무엇을 해야 하는지 문서가 말하는가."""

    def test_readme_and_claude_md_name_the_repair_command(self):
        for name in ("README.md", "CLAUDE.md"):
            self.assertIn("install --repo", read(name),
                          "%s 에 복구 명령이 없습니다" % name)

    def test_example_is_not_deployed_to_the_installed_copy(self):
        import sys
        scripts = os.path.join(REPO, "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import deploy_manifest as man
        self.assertIsNotNone(man.forbidden_reason(EXAMPLE.replace("\\", "/")))


if __name__ == "__main__":
    unittest.main()
