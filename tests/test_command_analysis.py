# -*- coding: utf-8 -*-
"""토큰 기반 명령 판정 회귀 테스트 — 금지 명령 차단과 커밋 탐지.

종전 구현은 명령 문자열 전체를 정규식으로 훑어 **인용부호 안의 단어까지 명령으로
오인**했다. 실측된 오탐(전부 차단됐던 것):
  git log --grep=push / grep -r "git push" docs/ / echo "git push 하지 마세요"
  git commit -m "push 준비 완료"   ← 허용해야 할 로컬 커밋
심지어 이 결함을 고치는 작업을 장부에 등록하는 명령까지 차단했다.
반대 방향으로는 `bash -c '...'` 처럼 래퍼에 감싼 실제 명령을 놓쳤다.

여기서 고정하는 계약:
  ① 명령 **위치**의 토큰만 판정한다 — 인용부호 안 언급은 무해하다
  ② git **서브커맨드** 기준으로 판정한다 — push 인지 log 인지 구분한다
  ③ 래퍼(bash -c / powershell -Command) 페이로드는 재귀 분석한다
  ④ 파싱 불가는 fail-open — 훅이 주행을 막지 않는다
"""

import os
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402

# 이 테스트 파일 자체가 훅 정규식에 걸리지 않도록 분해 조립할 필요는 없다 —
# 새 판정기는 인용부호 안 문자열을 명령으로 보지 않기 때문이다(그것이 이 테스트의 요지다).
G = "git"


class DenyTest(unittest.TestCase):
    """차단돼야 하는 명령 — 기존 계약 유지 + 래퍼 우회 신규 차단."""

    def assert_denied(self, command):
        self.assertIsNotNone(eng.deny_reason(command), "차단돼야 함: %s" % command)

    def test_blocks_push(self):
        self.assert_denied(G + " push origin main")

    def test_blocks_push_with_korean_branch(self):
        self.assert_denied(G + " push origin 기능-브랜치")

    def test_blocks_force_variants(self):
        for cmd in (G + " push --force", G + " branch --force main",
                    G + " push --force-with-lease origin main",
                    G + " checkout -f main", G + " switch --force other"):
            self.assert_denied(cmd)

    def test_blocks_reset_hard(self):
        self.assert_denied(G + " reset --hard HEAD~1")

    def test_blocks_clean_force(self):
        for cmd in (G + " clean -fd", G + " clean -d -f", G + " clean --force"):
            self.assert_denied(cmd)

    def test_blocks_in_later_segment(self):
        for cmd in ("cd /tmp && " + G + " push", "echo hi; " + G + " push origin main"):
            self.assert_denied(cmd)

    def test_blocks_with_env_assignment_prefix(self):
        self.assert_denied("GIT_SSH_COMMAND=ssh " + G + " push origin main")

    def test_blocks_with_git_global_option(self):
        # -C 는 값을 먹는 전역 옵션 — 건너뛰고 서브커맨드를 찾아야 한다
        self.assert_denied(G + " -C /repo push origin main")
        self.assert_denied(G + " -c user.name=x push")

    def test_blocks_absolute_path_git(self):
        self.assert_denied("/usr/bin/git push origin main")

    def test_blocks_wrapper_evasion(self):
        """종전 정규식이 놓치던 경로 — 래퍼 안의 실제 명령."""
        for cmd in ("bash -c '" + G + " push origin main'",
                    "sh -c \"" + G + " push\"",
                    "powershell -Command \"" + G + " push origin main\"",
                    "pwsh -c '" + G + " reset --hard'"):
            self.assert_denied(cmd)

    def test_reason_is_human_readable(self):
        self.assertIn("금지", eng.deny_reason(G + " push origin main"))


class AllowTest(unittest.TestCase):
    """허용돼야 하는 명령 — 실측된 오탐 4종이 여기 들어 있다."""

    def assert_allowed(self, command):
        self.assertIsNone(eng.deny_reason(command),
                          "허용돼야 함: %s (사유=%s)" % (command, eng.deny_reason(command)))

    def test_allows_read_only_git(self):
        for cmd in (G + " status", G + " log --oneline", G + " remote -v",
                    G + " config --get remote.origin.url", G + " diff HEAD"):
            self.assert_allowed(cmd)

    def test_allows_unrelated_commands(self):
        for cmd in ("ls -la", "echo push", "npm run build"):
            self.assert_allowed(cmd)

    def test_allows_mention_inside_quotes(self):
        """오탐 해소의 핵심 — 인용부호 안 언급은 명령이 아니다."""
        for cmd in ('grep -r "' + G + ' push" docs/',
                    'echo "' + G + ' push 하지 마세요"',
                    G + ' log --grep=push',
                    G + ' log --grep="push origin"'):
            self.assert_allowed(cmd)

    def test_allows_local_commit_mentioning_push(self):
        """허용해야 할 로컬 커밋이 메시지 내용 때문에 막히던 결함."""
        self.assert_allowed(G + ' commit -m "push 준비 완료"')
        self.assert_allowed(G + ' commit -m "원격 반영 전 정리"')

    def test_allows_nondestructive_variants(self):
        for cmd in (G + " reset --soft HEAD~1", G + " reset HEAD~1",
                    G + " clean -n", G + " clean --dry-run",
                    G + " branch new-feature", G + " checkout main"):
            self.assert_allowed(cmd)

    def test_allows_task_registration_command(self):
        """실증된 사례 — 이 결함을 고치는 작업 등록 명령까지 차단됐었다."""
        self.assert_allowed(
            'python scripts/harness_engine.py add-task --id x '
            '--title "' + G + ' push 차단이 오탐을 낸다"')


class FailOpenTest(unittest.TestCase):
    """④ 판정 불가는 주행을 막지 않는다."""

    def test_unbalanced_quotes_fail_open(self):
        self.assertIsNone(eng.deny_reason(G + ' push "미완성 따옴표'))

    def test_empty_and_none(self):
        for cmd in ("", "   ", None):
            self.assertIsNone(eng.deny_reason(cmd))

    def test_deep_wrapper_nesting_terminates(self):
        # 무한 재귀 방어 — 상한을 넘으면 판정을 포기하되 죽지 않는다
        cmd = G + " push"
        for _ in range(eng.WRAPPER_MAX_DEPTH + 3):
            cmd = "bash -c %s" % repr(cmd)
        self.assertIsNone(eng.deny_reason(cmd))   # 상한 초과 → fail-open, 예외 없음


class GitCommitDetectionTest(unittest.TestCase):
    """커밋 게이트의 트리거 판정 — 같은 오탐이 여기에도 있었다."""

    def test_detects_real_commit(self):
        for cmd in (G + ' commit -m "작업"', G + " commit --amend",
                    "cd /repo && " + G + " commit -m x",
                    G + " -C /repo commit -m x"):
            self.assertTrue(eng.invokes_git_commit(cmd), cmd)

    def test_ignores_mention_only(self):
        """`echo "git commit"` 이 커밋 게이트를 켜면 안 된다."""
        for cmd in ('echo "' + G + ' commit"', G + ' log --grep=commit',
                    G + " status", 'grep -r "' + G + ' commit" .'):
            self.assertFalse(eng.invokes_git_commit(cmd), cmd)

    def test_detects_commit_in_wrapper(self):
        self.assertTrue(eng.invokes_git_commit("bash -c '" + G + " commit -m x'"))


class TokenHelperTest(unittest.TestCase):
    """판정을 떠받치는 보조 함수 — 경계 동작을 직접 고정한다."""

    def test_segments_split_on_shell_separators(self):
        self.assertEqual(eng._command_segments("a && b || c; d | e"),
                         ["a", "b", "c", "d", "e"])

    def test_exe_name_normalizes_path_and_extension(self):
        for token, expected in (("/usr/bin/git", "git"), ("C:\\Program Files\\Git\\git.exe", "git"),
                                ("GIT", "git"), ("powershell.exe", "powershell")):
            self.assertEqual(eng._exe_name(token), expected)

    def test_git_subcommand_skips_value_taking_options(self):
        self.assertEqual(eng._git_subcommand(["-C", "/repo", "push", "origin"]),
                         ("push", ["origin"]))
        self.assertEqual(eng._git_subcommand(["--no-pager", "log"]), ("log", []))
        self.assertEqual(eng._git_subcommand(["-c", "a=b", "commit", "-m", "x"]),
                         ("commit", ["-m", "x"]))

    def test_git_subcommand_none_when_absent(self):
        self.assertEqual(eng._git_subcommand([]), (None, []))
        self.assertEqual(eng._git_subcommand(["--version"]), (None, []))

    def test_force_flag_detection(self):
        for rest in (["--force"], ["-f"], ["-fd"], ["-d", "-f"], ["--force-with-lease=origin"]):
            self.assertTrue(eng._has_force_flag(rest), rest)
        for rest in ([], ["-n"], ["--dry-run"], ["-d"], ["--soft"]):
            self.assertFalse(eng._has_force_flag(rest), rest)


if __name__ == "__main__":
    unittest.main()
