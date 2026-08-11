# -*- coding: utf-8 -*-
"""v2 EXE 배포 회귀 — **검증 통과분이 실행 중 설치본에 실제로 도달하는가.**

이 저장소의 목표는 "매 작업 검증 통과 시 실행 중 설치본에 즉시 반영" 인데, v2
마이그레이션 이후 절반만 지켜지고 있었다. deploy_live 는 v1 자산만 복사했고, 정작
훅·MCP·제어판을 실행하는 ~/.claude/autoharness/bin/autoharness.exe 는 아무도 갱신하지
않았다. 실측(2026-08-11): 배선 진단을 고쳐 검증을 통과시킨 직후에도 status 는 여전히
구버전 판정을 냈다.

여기서 고정하는 것:
  ① 변경 판정이 빌드 결과를 좌우하는 입력을 빠짐없이 본다 — 빠뜨리면 "안 바뀐 줄 알고"
     옛 EXE 를 그대로 둔다
  ② 실패를 삼키지 않는다 — bun 부재·빌드 실패는 조용히 건너뛰지 않는다
  ③ 다만 EXE 잠김(데몬 실행 중)은 코드 결함이 아니라 환경 상태다 — 알리되 검증을
     실패로 만들지 않고, 스탬프를 남기지 않아 다음 실행이 다시 시도한다

**실제 런타임 디렉토리는 건드리지 않는다**(CLAUDE.md 6절) — 모든 경로를 임시 폴더로
갈아끼운다.
"""

import io
import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import deploy_live  # noqa: E402


def write(path, text=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


class SourceHashTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ah-daemon-")
        self.addCleanup(shutil.rmtree, self.d, True)
        write(os.path.join(self.d, "src", "main.ts"), "export const a = 1;\n")
        write(os.path.join(self.d, "package.json"), '{"name":"d"}')
        write(os.path.join(self.d, "tsconfig.json"), "{}")
        write(os.path.join(self.d, "scripts", "build.ts"), "// build\n")

    def hash(self):
        return deploy_live.daemon_source_hash(self.d)

    def test_stable_when_nothing_changes(self):
        self.assertEqual(self.hash(), self.hash())

    def test_source_change_changes_the_hash(self):
        before = self.hash()
        write(os.path.join(self.d, "src", "main.ts"), "export const a = 2;\n")
        self.assertNotEqual(before, self.hash())

    def test_new_source_file_changes_the_hash(self):
        before = self.hash()
        write(os.path.join(self.d, "src", "extra.ts"), "export const b = 1;\n")
        self.assertNotEqual(before, self.hash())

    def test_rename_changes_the_hash(self):
        """내용 합만 보면 이름만 바뀐 경우를 놓친다 — 경로도 해시에 넣는다."""
        before = self.hash()
        os.rename(os.path.join(self.d, "src", "main.ts"), os.path.join(self.d, "src", "other.ts"))
        self.assertNotEqual(before, self.hash())

    def test_build_inputs_are_included(self):
        """빌드 스크립트·tsconfig·package.json 이 바뀌면 산출물이 달라진다."""
        for rel in (("package.json",), ("tsconfig.json",), ("scripts", "build.ts")):
            before = self.hash()
            write(os.path.join(self.d, *rel), '{"changed": %d}' % len(rel))
            self.assertNotEqual(before, self.hash(), "%s 변화가 해시에 반영되지 않았습니다" % (rel,))

    def test_node_modules_is_ignored(self):
        before = self.hash()
        write(os.path.join(self.d, "src", "node_modules", "pkg", "index.ts"), "x")
        self.assertEqual(before, self.hash())

    def test_empty_directory_is_undecidable_not_a_hash(self):
        empty = tempfile.mkdtemp(prefix="ah-empty-")
        self.addCleanup(shutil.rmtree, empty, True)
        self.assertIsNone(deploy_live.daemon_source_hash(empty))


class StampTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ah-stamp-")
        self.addCleanup(shutil.rmtree, self.d, True)
        self.path = os.path.join(self.d, ".autoharness-src.sha256")

    def test_missing_stamp_reads_as_none(self):
        self.assertIsNone(deploy_live.read_stamp(self.path))

    def test_empty_stamp_reads_as_none(self):
        write(self.path, "  \n")
        self.assertIsNone(deploy_live.read_stamp(self.path))

    def test_round_trip(self):
        deploy_live.write_stamp("abc123", self.path)
        self.assertEqual(deploy_live.read_stamp(self.path), "abc123")


class LockClassificationTest(unittest.TestCase):
    def test_permission_error_is_a_lock(self):
        self.assertTrue(deploy_live.is_locked(PermissionError(13, "denied")))

    def test_windows_sharing_violation_is_a_lock(self):
        err = OSError(13, "used by another process")
        err.winerror = 32
        self.assertTrue(deploy_live.is_locked(err))

    def test_other_oserror_is_not_a_lock(self):
        """디스크 부족 같은 것을 잠금으로 오분류하면 실패가 조용히 넘어간다."""
        err = OSError(28, "No space left on device")
        self.assertFalse(deploy_live.is_locked(err))


class DeployV2SkipTest(unittest.TestCase):
    """건너뛰는 경우와 실패하는 경우를 가른다 — 둘을 뭉개면 반영 누락이 성공처럼 보인다."""

    def setUp(self):
        self.saved = {name: getattr(deploy_live, name)
                      for name in ("DAEMON", "RUNTIME_BIN", "INSTALLED_EXE", "SRC_STAMP")}
        self.d = tempfile.mkdtemp(prefix="ah-dep-")
        self.addCleanup(shutil.rmtree, self.d, True)
        self.addCleanup(lambda: [setattr(deploy_live, k, v) for k, v in self.saved.items()])
        deploy_live.DAEMON = os.path.join(self.d, "daemon")
        deploy_live.RUNTIME_BIN = os.path.join(self.d, "runtime", "bin")
        deploy_live.INSTALLED_EXE = os.path.join(deploy_live.RUNTIME_BIN, deploy_live.EXE_NAME)
        deploy_live.SRC_STAMP = os.path.join(deploy_live.RUNTIME_BIN, ".autoharness-src.sha256")

    def test_no_daemon_src_is_a_skip_not_a_failure(self):
        rc, notes = deploy_live.deploy_v2_exe()
        self.assertEqual(rc, 0)
        self.assertIn("건너뜀", " ".join(notes))

    def test_no_v2_installation_is_a_skip_not_a_failure(self):
        """v1 만 쓰는 사용자를 실패로 만들지 않는다."""
        write(os.path.join(deploy_live.DAEMON, "src", "main.ts"), "x")
        rc, notes = deploy_live.deploy_v2_exe()
        self.assertEqual(rc, 0)
        self.assertIn("v2 설치본 없음", " ".join(notes))

    def test_unchanged_source_skips_the_build(self):
        write(os.path.join(deploy_live.DAEMON, "src", "main.ts"), "x")
        os.makedirs(deploy_live.RUNTIME_BIN)
        write(deploy_live.INSTALLED_EXE, "EXE")
        deploy_live.write_stamp(deploy_live.daemon_source_hash(deploy_live.DAEMON),
                                deploy_live.SRC_STAMP)
        rc, notes = deploy_live.deploy_v2_exe()
        self.assertEqual(rc, 0)
        self.assertIn("변화 없음", " ".join(notes))

    def test_missing_exe_forces_a_build_even_if_stamp_matches(self):
        """스탬프만 믿으면 EXE 가 지워진 환경에서 영영 복구되지 않는다."""
        write(os.path.join(deploy_live.DAEMON, "src", "main.ts"), "x")
        os.makedirs(deploy_live.RUNTIME_BIN)
        deploy_live.write_stamp(deploy_live.daemon_source_hash(deploy_live.DAEMON),
                                deploy_live.SRC_STAMP)
        saved = deploy_live.find_bun
        deploy_live.find_bun = lambda: None
        self.addCleanup(setattr, deploy_live, "find_bun", saved)
        rc, notes = deploy_live.deploy_v2_exe()
        self.assertEqual(rc, 1)  # 건너뛰지 않고 빌드를 시도했다가 bun 부재로 실패
        self.assertIn("bun", " ".join(notes))

    def test_missing_bun_is_a_failure_not_a_silent_skip(self):
        write(os.path.join(deploy_live.DAEMON, "src", "main.ts"), "x")
        os.makedirs(deploy_live.RUNTIME_BIN)
        write(deploy_live.INSTALLED_EXE, "EXE")
        saved = deploy_live.find_bun
        deploy_live.find_bun = lambda: None
        self.addCleanup(setattr, deploy_live, "find_bun", saved)
        rc, notes = deploy_live.deploy_v2_exe()
        self.assertEqual(rc, 1)
        self.assertIn("ERROR", " ".join(notes))


class ContractTest(unittest.TestCase):
    def setUp(self):
        with io.open(os.path.join(SCRIPTS, "deploy_live.py"), encoding="utf-8") as fh:
            self.source = fh.read()

    def test_flags_exist(self):
        self.assertIn("--no-v2", self.source)
        self.assertIn("--force-v2", self.source)

    def test_skill_assets_still_deploy_first(self):
        """스킬 자산이 EXE 단계보다 먼저다 — 실패해도 v1 경로는 최신이 된다."""
        self.assertLess(self.source.index("스킬 자산 동기화 완료"),
                        self.source.index("rc, notes = deploy_v2_exe"))

    def test_large_file_copy_is_chunked(self):
        """94MiB 를 통째로 메모리에 올리지 않는다."""
        self.assertIn("copyfileobj", self.source)


if __name__ == "__main__":
    unittest.main()
