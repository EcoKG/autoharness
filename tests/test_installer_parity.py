# -*- coding: utf-8 -*-
"""배포 명세와 실제 설치가 같은 집합을 옮기는가.

같은 질문("무엇을 설치본에 넣는가")에 세 구현이 각각 답하고 답이 달랐다(실측 2026-08-11):
install.ps1 은 bin 을 재귀 복사해 __pycache__ 를 넣고, install.sh 는 install.ps1 을
배포하면서 자기는 빼고, deploy_live 는 또 다른 규칙을 썼다.

**v1 을 제거하면서 구현이 둘로 줄었다.** 설치 스크립트(bash·PowerShell)는 이제 바이너리만
내려놓고 나머지는 EXE 에게 위임한다. 그래서 대조 대상은 scripts/deploy_manifest.py(개발
배포) 와 daemon/src/install/install.ts(사용자 설치) 다.

그 축소 과정에서 실제로 한 번 빠질 뻔했다: 스크립트의 복사 코드를 걷어내자 EXE 는 skill/
만 옮기고 있어 templates/ 가 통째로 사라졌다 — 데몬이 부트스트랩 템플릿을 영영 찾지 못하는
상태다. 이 테스트가 그 자리를 지킨다.

**셸·PowerShell·EXE 를 실행하지 않는다.** 설치 스크립트를 돌리면 실제 사용자 설치본을
덮어쓰게 되고, 그것은 단위 테스트가 해서는 안 되는 일이다(CLAUDE.md 6절). 소스에서 복사
대상을 읽어 대조한다.
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


INSTALL_TS = os.path.join("daemon", "src", "install", "install.ts")


def ts_asset_list(name):
    """install.ts 의 SKILL_ASSET_* 배열 — 사용자 설치가 옮기는 것의 단일 출처."""
    src = read(INSTALL_TS)
    block = src[src.index("export const %s" % name):]
    block = block[:block.index(";")]
    return set(re.findall(r'"([^"]+)"', block))


class ManifestVsInstallerTest(unittest.TestCase):
    """개발 배포(deploy_manifest)와 사용자 설치(install.ts)가 같은 집합을 옮기는가."""

    def test_root_files_match(self):
        manifest = {dst for _, dst in man.DEPLOY_FILES if dst != "SKILL.md"}
        self.assertEqual(manifest, ts_asset_list("SKILL_ASSET_FILES"),
                         "루트 문서·설치기 집합이 어긋납니다")

    def test_skill_md_is_handled_separately(self):
        """SKILL.md 는 이름이 바뀌며 옮겨진다(skill/SKILL.md → SKILL.md)."""
        self.assertIn(("skill/SKILL.md", "SKILL.md"), man.DEPLOY_FILES)
        self.assertIn("--skill", read("install.sh") + read("install.ps1"))

    def test_directories_match(self):
        manifest = {dst for _, dst, _ in man.DEPLOY_DIRS}
        self.assertEqual(manifest, ts_asset_list("SKILL_ASSET_DIRS"))

    def test_templates_is_actually_carried(self):
        """실제로 빠질 뻔한 자리 — 데몬의 부트스트랩 템플릿이 여기 산다."""
        self.assertIn("templates", ts_asset_list("SKILL_ASSET_DIRS"))


class InstallerDelegatesTest(unittest.TestCase):
    """설치 스크립트는 바이너리만 놓고 나머지를 EXE 에 맡긴다 — 규칙을 두 번 쓰지 않는다."""

    def test_scripts_do_not_copy_assets_themselves(self):
        """복사 규칙을 두 곳에 두면 갈라진다 — 스크립트는 원본 경로만 넘긴다.

        정리(cleanup)에서 옛 파이썬 자산을 **지우는** 것은 복사가 아니므로 대상이 아니다."""
        for name, copy_marker in (("install.sh", 'cp "$SRC"/bin'),
                                  ("install.ps1", 'Copy-Item -Path (Join-Path $Src "bin')):
            source = read(name)
            self.assertNotIn(copy_marker, source, "%s 가 아직 자산을 직접 복사합니다" % name)
            self.assertIn("--skill", source, "%s 가 EXE 에 스킬 원본을 넘기지 않습니다" % name)

    def test_scripts_point_at_the_manifest_and_this_test(self):
        for name in ("install.sh", "install.ps1"):
            source = read(name)
            self.assertIn("deploy_manifest.py", source)
            self.assertIn("test_installer_parity.py", source)


CLEANUP_TS = os.path.join("daemon", "src", "install", "cleanup.ts")


class V1LeftoverCleanupTest(unittest.TestCase):
    """설치·갱신 때 이전 버전의 잔재를 정리하는가(사용자 요구).

    **정리 규칙은 EXE 하나가 갖는다.** 종전에는 bash 와 PowerShell 에 같은 규칙이 각각
    쓰여 있었고, 그 둘은 이미 갈라져 있었다: install.ps1 은 v1 작업 이름만 지우고 v2 가
    실제로 등록하는 AutoHarnessDaemon 과 시작프로그램 항목은 그대로 남겼다. 이 저장소가
    같은 종류의 분기(배포 목록·설치 자산·문서 명령)로 세 번 데인 자리다.
    """

    def test_the_rule_lives_in_one_place(self):
        source = read(CLEANUP_TS)
        for marker in ("purgeV1", "V1_TASK_NAME", "V1_CRON_MARK", "v1Leftovers"):
            self.assertIn(marker, source, "정리 규칙에 %s 가 없습니다" % marker)

    def test_install_runs_the_cleanup_unconditionally(self):
        """묻지 않는다 — 부를 코드가 없는 파일이라 물어볼 여지가 없다."""
        source = read(os.path.join("daemon", "src", "install", "install.ts"))
        self.assertIn("purgeV1", source)
        self.assertIn('step("cleanup-v1"', source)

    def test_scripts_do_not_reimplement_the_cleanup(self):
        """셸 쪽에 규칙이 다시 생기면 갈라진다 — 지우는 코드는 EXE 에만 있어야 한다."""
        for name, forbidden in (
            ("install.sh", ("crontab -l", "rm -rf \"$DST/bin\"")),
            ("install.ps1", ("schtasks /Delete", "AutoHarnessWatchdog")),
        ):
            source = read(name)
            for marker in forbidden:
                # assertNotIn 은 실패 시 원본 전체를 쏟아낸다 — 사유만 남긴다
                self.assertFalse(marker in source,
                                 "%s 가 정리를 다시 구현합니다: %s" % (name, marker))

    def test_cleanup_does_not_touch_runtime_state(self):
        """레지스트리·로그·장부는 사용자의 진행 상태다 — v1 정리가 지우지 않는다."""
        source = read(CLEANUP_TS)
        start = source.index("export function v1Leftovers")
        end = source.index("\n}", start)
        targets = source[start:end]
        for keep in ("registry", "agent_tracker", "daemonLog", "webToken"):
            self.assertNotIn(keep, targets, "v1 정리가 런타임 상태를 건드립니다: %s" % keep)

    def test_uninstall_delegates_to_the_exe(self):
        """제거 경로도 같은 규칙을 쓴다 — 두 번 쓰면 또 갈라진다."""
        for name in ("install.sh", "install.ps1"):
            self.assertIn("install --uninstall", read(name).replace('@("install", "--uninstall")',
                                                                    "install --uninstall"))

    def test_deprecated_flags_are_accepted_not_rejected(self):
        """이미 퍼진 원라인이 오류로 죽으면 안 된다 — 받아들이고 안내한다."""
        sh = read("install.sh")
        self.assertIn("--v2)", sh)
        self.assertIn("--watchdog)", sh)
        self.assertIn("더 이상 없습니다", sh)


class ManifestIsTheSingleSourceTest(unittest.TestCase):
    def test_installers_point_at_the_manifest(self):
        """다음 사람이 어디를 고쳐야 하는지 코드가 스스로 말한다."""
        for name in ("install.ps1", "install.sh"):
            self.assertIn("deploy_manifest.py", read(name),
                          "%s 가 명세 위치를 가리키지 않습니다" % name)

    def test_installers_point_at_the_test_that_enforces_it(self):
        for name in ("install.ps1", "install.sh"):
            self.assertIn("test_installer_parity.py", read(name))


MOVING_VERBS = ("cp ", "mv ", "rm ", "rm -", "tar ", "robocopy",
                "Copy-Item", "Move-Item", "Remove-Item", "New-Item")


class ForbiddenNeverAppearsAsATargetTest(unittest.TestCase):
    """설치기가 저장소 상태를 **다루고** 있지는 않은가.

    종전에는 이름이 등장하기만 해도 실패시켰다. 그러다 정반대 이유로 이름을 대야 하는
    자리가 생겼다 — 초기화 안내가 "저장소 안의 장부는 지우지 않습니다" 라고 약속한다.
    약속을 지우는 대신 검사를 좁혔다: 이름이 **옮기거나 지우는 명령과 같은 줄에**
    나오면 실패다. 복사만 막던 것에서 삭제까지 막는 쪽으로 강해졌다.
    """

    def test_installers_do_not_handle_repo_state(self):
        for name in ("install.ps1", "install.sh"):
            for line in read(name).splitlines():
                for forbidden in ("agent_tracker.json", "PROGRESS.md", "checks-timing.json"):
                    if forbidden not in line:
                        continue
                    for verb in MOVING_VERBS:
                        self.assertFalse(verb in line,
                                         "%s 가 %s 를 다룹니다: %s" % (name, forbidden, line.strip()))

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
