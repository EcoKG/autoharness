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


class RemoteMutationTest(unittest.TestCase):
    """차단 목적은 명령 이름이 아니라 **결과** 다 — gh 는 push 없이도 원격을 바꾼다(high)."""

    def assert_denied(self, command):
        self.assertIsNotNone(eng.deny_reason(command), "차단돼야 함: %s" % command)

    def assert_allowed(self, command):
        self.assertIsNone(eng.deny_reason(command),
                          "허용돼야 함: %s (%s)" % (command, eng.deny_reason(command)))

    def test_blocks_gh_write_actions(self):
        for cmd in ("gh pr create --title x", "gh pr merge 12 --auto",
                    "gh release create v1", "gh repo delete owner/x",
                    "gh workflow run deploy.yml", "gh secret set TOKEN",
                    "gh issue create --title x", "gh gist create f.txt"):
            self.assert_denied(cmd)

    def test_blocks_gh_api_write_methods(self):
        for cmd in ("gh api -X POST /repos/x/y/issues", "gh api --method DELETE /x",
                    "gh api --method=PATCH /x", "gh api -X put /x"):
            self.assert_denied(cmd)

    def test_allows_gh_read_actions(self):
        for cmd in ("gh pr list", "gh pr view 12", "gh release list", "gh repo view",
                    "gh issue list", "gh run view 3", "gh api /repos/x/y",
                    "gh api -X GET /x", "gh pr checks"):
            self.assert_allowed(cmd)

    def test_blocks_subtree_push(self):
        self.assert_denied("git subtree push --prefix=dist origin gh-pages")

    def test_gh_inside_wrapper(self):
        self.assert_denied("bash -c 'gh pr merge 12 --auto'")


class LocalDestructionTest(unittest.TestCase):
    """되돌릴 수 없는 로컬 파괴 — reset --hard 와 동급인 경로들(high)."""

    def assert_denied(self, command):
        self.assertIsNotNone(eng.deny_reason(command), "차단돼야 함: %s" % command)

    def assert_allowed(self, command):
        self.assertIsNone(eng.deny_reason(command),
                          "허용돼야 함: %s (%s)" % (command, eng.deny_reason(command)))

    def test_blocks_branch_force_delete(self):
        self.assert_denied("git branch -D feature")

    def test_allows_safe_branch_delete(self):
        self.assert_allowed("git branch -d merged")
        self.assert_allowed("git branch feature")

    def test_blocks_working_tree_discard(self):
        for cmd in ("git checkout -- .", "git checkout -- src/a.py", "git restore src/"):
            self.assert_denied(cmd)

    def test_allows_staged_restore_and_plain_checkout(self):
        self.assert_allowed("git restore --staged file.txt")
        self.assert_allowed("git checkout main")
        self.assert_allowed("git checkout -b feature")

    def test_blocks_stash_and_reflog_destruction(self):
        for cmd in ("git stash drop", "git stash clear",
                    "git reflog expire --expire=now --all", "git reflog delete x"):
            self.assert_denied(cmd)

    def test_allows_recoverable_stash_and_reflog(self):
        for cmd in ("git stash list", "git stash pop", "git stash", "git reflog"):
            self.assert_allowed(cmd)

    def test_blocks_history_rewrite_and_ref_deletion(self):
        self.assert_denied("git filter-branch --tree-filter x HEAD")
        self.assert_denied("git update-ref -d refs/heads/x")
        self.assert_denied("git worktree remove wt")

    def test_allows_worktree_list(self):
        self.assert_allowed("git worktree list")

    def test_restore_is_not_a_dead_force_rule(self):
        """적대 검증 지적 — restore 에는 --force 가 없어 옛 규칙은 절대 발동하지 않았다."""
        self.assertNotIn("restore", eng.FORCE_SUBCOMMANDS)


class UnparsableTest(unittest.TestCase):
    """④ 판정 불가 처리 — 조용한 통과가 곧 우회 경로였다(적대 검증 high).

    구조 판정이 1차이고, 파싱이 불가능할 때만 키워드 안전망이 작동한다:
      위험 키워드 있음 → 게이트(사람에게 확인)
      위험 키워드 없음 → 통과(정상 작업을 막지 않는다)
    """

    def test_unparsable_with_risk_keyword_is_gated(self):
        self.assertIsNotNone(eng.deny_reason(G + ' push "미완성 따옴표'))

    def test_unparsable_without_risk_keyword_passes(self):
        self.assertIsNone(eng.deny_reason('echo "미완성 따옴표'))
        self.assertIsNone(eng.deny_reason(G + ' status "열린 따옴표'))

    def test_empty_and_none(self):
        for cmd in ("", "   ", None):
            self.assertIsNone(eng.deny_reason(cmd))

    def test_deep_wrapper_nesting_is_gated_not_silently_passed(self):
        # 상한을 넘으면 판정을 포기하되, 위험 키워드가 보이면 통과시키지 않는다
        cmd = G + " push"
        for _ in range(eng.WRAPPER_MAX_DEPTH + 3):
            cmd = "bash -c %s" % repr(cmd)
        self.assertIsNotNone(eng.deny_reason(cmd))

    def test_deep_nesting_without_risk_passes(self):
        cmd = G + " status"
        for _ in range(eng.WRAPPER_MAX_DEPTH + 3):
            cmd = "bash -c %s" % repr(cmd)
        self.assertIsNone(eng.deny_reason(cmd))


class QuoteAwareSplitTest(unittest.TestCase):
    """① 따옴표 안 구분자가 분할점이 되어 정상 명령이 무검사 통과하던 결함(high)."""

    def test_semicolon_inside_commit_message(self):
        cmd = G + ' commit -m "정리; 리팩터링"'
        self.assertIsNone(eng.deny_reason(cmd))
        self.assertTrue(eng.invokes_git_commit(cmd), "커밋 게이트가 켜져야 한다")

    def test_pipe_inside_commit_message(self):
        cmd = G + ' commit -m "A | B 병합"'
        self.assertTrue(eng.invokes_git_commit(cmd))

    def test_newline_inside_commit_message(self):
        cmd = G + ' commit -m "제목\n\n본문 줄"'
        self.assertTrue(eng.invokes_git_commit(cmd))

    def test_quoted_separator_does_not_hide_later_command(self):
        """따옴표 안 세미콜론 때문에 뒤쪽 실제 명령을 놓치면 안 된다."""
        self.assertIsNotNone(eng.deny_reason('echo "a; b" && ' + G + ' push origin main'))


class ContinuationAndPrefixTest(unittest.TestCase):
    """②③ 줄 연속·수식어 접두로 판정을 빠져나가던 결함(high)."""

    def test_backslash_line_continuation(self):
        self.assertIsNotNone(eng.deny_reason(G + " \\\n  push origin main"))
        self.assertIsNotNone(eng.deny_reason(G + " \\\r\n  reset --hard HEAD~1"))

    def test_prefix_with_positional_argument(self):
        self.assertIsNotNone(eng.deny_reason("timeout 30 " + G + " push origin main"))

    def test_prefix_with_value_option(self):
        self.assertIsNotNone(eng.deny_reason("nice -n 10 " + G + " push"))
        self.assertIsNotNone(eng.deny_reason("sudo -u deploy " + G + " push"))

    def test_exec_delegate(self):
        self.assertIsNotNone(eng.deny_reason("xargs " + G + " push"))
        self.assertIsNotNone(eng.deny_reason("xargs -n 1 " + G + " push"))

    def test_powershell_flag_abbreviations(self):
        for flag in ("-Command", "-command", "-Comm", "-co", "-c"):
            self.assertIsNotNone(
                eng.deny_reason('powershell %s "%s push origin main"' % (flag, G)), flag)

    def test_powershell_encoded_command_is_gated(self):
        # base64 는 구조 판정 불가 — 조용히 통과시키지 않는다
        self.assertIsNotNone(
            eng.deny_reason("powershell -EncodedCommand cAB1AHMAaAA= push"))

    def test_prefix_does_not_swallow_real_command(self):
        # 수식어 건너뛰기가 과해서 무관한 명령을 git 으로 오인하면 안 된다
        self.assertIsNone(eng.deny_reason("timeout 30 npm test"))
        self.assertIsNone(eng.deny_reason("nice -n 10 ls -la"))


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

    def test_detects_other_commit_creating_subcommands(self):
        """`commit` 만 보면 검증 없이 이력이 늘고 SHA 도 안 남는다(적대 검증 확인)."""
        for cmd in (G + " revert abc123", G + " cherry-pick abc123",
                    G + " merge feature", G + " am patch.mbox",
                    G + " merge --continue"):
            self.assertTrue(eng.invokes_git_commit(cmd), cmd)

    def test_no_commit_flags_are_respected(self):
        """커밋을 만들지 않는 형태까지 게이트를 켜면 정상 작업이 막힌다."""
        for cmd in (G + " revert --no-commit abc", G + " revert -n abc",
                    G + " cherry-pick -n abc", G + " merge --no-commit feature",
                    G + " merge --abort", G + " cherry-pick --abort",
                    G + " am --skip", G + " am --abort"):
            self.assertFalse(eng.invokes_git_commit(cmd), cmd)

    def test_rebase_is_deliberately_excluded(self):
        """기존 커밋 재생이라 '검증 안 된 새 작업' 이 아니다 — 의도적 제외."""
        for cmd in (G + " rebase main", G + " rebase --continue"):
            self.assertFalse(eng.invokes_git_commit(cmd), cmd)

    def test_read_only_subcommands_do_not_trigger(self):
        for cmd in (G + " log --merges", G + " diff", G + " status", G + " stash list"):
            self.assertFalse(eng.invokes_git_commit(cmd), cmd)


class TokenHelperTest(unittest.TestCase):
    """판정을 떠받치는 보조 함수 — 경계 동작을 직접 고정한다."""

    def test_segments_split_on_shell_separators(self):
        segments, failed = eng._command_segments("a && b || c; d | e")
        self.assertFalse(failed)
        self.assertEqual(segments, [["a"], ["b"], ["c"], ["d"], ["e"]])

    def test_segments_keep_quoted_separators_together(self):
        segments, failed = eng._command_segments('echo "a; b | c" && ls')
        self.assertFalse(failed)
        self.assertEqual(segments, [["echo", "a; b | c"], ["ls"]])

    def test_segments_report_parse_failure(self):
        segments, failed = eng._command_segments('echo "열린 따옴표')
        self.assertTrue(failed)
        self.assertEqual(segments, [])

    def test_fold_continuations(self):
        self.assertEqual(eng._fold_continuations("a \\\nb"), "a  b")
        self.assertEqual(eng._fold_continuations("a \\\r\nb"), "a  b")

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
