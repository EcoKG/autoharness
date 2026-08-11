# -*- coding: utf-8 -*-
"""설치 경로 3종이 같은 배포 명세를 따르는가.

같은 질문("무엇을 설치본에 넣는가")에 세 구현이 각각 답하고 있었고, 답이 달랐다
(실측 2026-08-11):

  ① install.ps1 은 `bin\\*` 를 재귀 복사해 __pycache__ 를 넣었고 install.sh 는 `bin/*.py`
     만 복사했다.
  ② install.sh 는 install.ps1·install.sh 를 둘 다 설치본에 넣었지만 install.ps1 은
     install.sh 를 넣지 않았다 — Windows 로 설치한 계정에서는 설치본만 가지고 WSL
     재설치를 할 수 없었다.
  ③ deploy_live 는 또 다른 규칙(파일만, .pyc 제외)을 썼다.

**셸·PowerShell 을 실행하지 않는다.** 설치 스크립트를 돌리면 실제 사용자 설치본을
덮어쓰게 되고, 그것은 단위 테스트가 해서는 안 되는 일이다(CLAUDE.md 6절). 대신 소스에서
복사 대상을 읽어 명세와 대조한다.

이 테스트의 목적은 **배포 대상이 늘 때 세 곳을 모두 고쳐야 한다는 사실을 실패로 드러내는
것**이다. deploy_manifest 에 항목을 추가하고 설치기를 안 고치면 여기서 걸린다.
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

import deploy_manifest as man  # noqa: E402


def read(name):
    with io.open(os.path.join(REPO, name), encoding="utf-8") as fh:
        return fh.read()


class InstallerCoverageTest(unittest.TestCase):
    """명세의 배포 대상이 두 설치기 소스에 모두 나타나는가."""

    def setUp(self):
        self.ps1 = read("install.ps1")
        self.sh = read("install.sh")

    def test_every_manifest_file_is_named_by_both_installers(self):
        for src_rel, dst_rel in man.DEPLOY_FILES:
            for label, source in (("install.ps1", self.ps1), ("install.sh", self.sh)):
                self.assertIn(dst_rel, source,
                              "%s 가 배포 대상 %s 를 복사하지 않습니다" % (label, dst_rel))

    def test_both_installers_ship_the_other_platforms_installer(self):
        """설치본만 가지고 다른 플랫폼에서 재설치할 수 있어야 한다."""
        self.assertIn("install.sh", self.ps1)
        self.assertIn("install.ps1", self.sh)

    def test_every_manifest_directory_is_named_by_both_installers(self):
        for src_dir, dst_dir, _ in man.DEPLOY_DIRS:
            for label, source in (("install.ps1", self.ps1), ("install.sh", self.sh)):
                self.assertIn(dst_dir, source,
                              "%s 가 배포 디렉토리 %s 를 다루지 않습니다" % (label, dst_dir))


class NoRecursiveCopyTest(unittest.TestCase):
    """재귀 복사는 부산물을 통째로 끌고 들어간다 — 이번 라운드가 고친 자리다."""

    def test_ps1_does_not_recurse_into_bin_or_templates(self):
        ps1 = read("install.ps1")
        for pattern in (r'Copy-Item[^\n]*bin\\\*"?\s*\)?[^\n]*-Recurse',
                        r'Copy-Item[^\n]*templates\\\*"?\s*\)?[^\n]*-Recurse'):
            self.assertIsNone(re.search(pattern, ps1),
                              "install.ps1 이 여전히 재귀 복사합니다: %s" % pattern)

    def test_ps1_takes_only_python_from_bin(self):
        self.assertIn(r"bin\*.py", read("install.ps1"))

    def test_sh_takes_only_python_from_bin(self):
        sh = read("install.sh")
        self.assertIn("/bin/*.py", sh)
        self.assertNotIn('cp "$SRC"/bin/* "', sh)

    def test_sh_takes_only_files_from_templates(self):
        """하위 디렉토리를 통째로 복사하지 않는다."""
        sh = read("install.sh")
        self.assertNotIn('cp "$SRC"/templates/* "', sh)
        self.assertIn("-maxdepth 1 -type f", sh)


class ManifestIsTheSingleSourceTest(unittest.TestCase):
    def test_installers_point_at_the_manifest(self):
        """다음 사람이 어디를 고쳐야 하는지 코드가 스스로 말한다."""
        for name in ("install.ps1", "install.sh"):
            self.assertIn("deploy_manifest.py", read(name),
                          "%s 가 명세 위치를 가리키지 않습니다" % name)

    def test_installers_point_at_the_test_that_enforces_it(self):
        for name in ("install.ps1", "install.sh"):
            self.assertIn("test_installer_parity.py", read(name))


class ForbiddenNeverAppearsAsATargetTest(unittest.TestCase):
    """설치기가 금지 항목을 대놓고 복사하고 있지는 않은가."""

    def test_installers_do_not_copy_repo_state(self):
        for name in ("install.ps1", "install.sh"):
            source = read(name)
            for forbidden in ("agent_tracker.json", "PROGRESS.md", "checks-timing.json"):
                self.assertNotIn(forbidden, source,
                                 "%s 가 %s 를 다룹니다" % (name, forbidden))

    def test_installers_do_not_copy_the_repos_own_claude_md(self):
        """배포되는 것은 templates/CLAUDE.md.tmpl 이지 이 저장소의 CLAUDE.md 가 아니다."""
        for name in ("install.ps1", "install.sh"):
            source = read(name)
            self.assertIsNone(re.search(r'["\'/\\]CLAUDE\.md["\'\s]', source),
                              "%s 가 CLAUDE.md 를 직접 복사합니다" % name)


class DeployLiveAgreesTest(unittest.TestCase):
    def test_deploy_live_uses_the_manifest_not_its_own_rules(self):
        source = read(os.path.join("scripts", "deploy_live.py"))
        self.assertIn("from deploy_manifest import", source)
        self.assertNotIn("ROOT_MAPPING", source)

    def test_manifest_destinations_are_flat_or_one_level(self):
        """설치본 구조 계약: 루트 + bin/ + templates/ 뿐이다."""
        pairs, _ = man.deploy_pairs(REPO)
        for _, dst in pairs:
            depth = dst.count("/")
            self.assertLessEqual(depth, 1, "설치본 구조가 깊어졌습니다: %s" % dst)
            if depth == 1:
                self.assertIn(dst.split("/")[0], ("bin", "templates"))


if __name__ == "__main__":
    unittest.main()
