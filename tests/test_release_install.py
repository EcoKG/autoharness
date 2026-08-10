# -*- coding: utf-8 -*-
"""v2 원라인 설치(install.sh --v2) 회귀 테스트.

v1 은 파이썬 소스라 받아서 복사하면 끝이었지만 v2 는 플랫폼별 컴파일 바이너리다. 그래서
릴리스에 미리 만들어 둔 것을 받는데, **받은 것을 확인 없이 실행 위치에 놓는 설치기는
만들지 않는다**는 것이 이 경로의 핵심 계약이다.

실측으로 확인한 것(WSL, 로컬 릴리스 상대):
  · 플랫폼 판정 → 다운로드 → 체크섬 검증 → 설치 → selftest 15/15 통과
  · 체크섬 불일치면 중단하고 아무것도 설치하지 않는다
  · 릴리스가 없으면 중단하고 소스 빌드 경로를 안내한다

여기서는 그 계약이 스크립트에 남아 있는지를 고정한다(실제 네트워크·설치는 하지 않는다).
"""

import os
import re
import shutil
import subprocess
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALL_SH = os.path.join(REPO, "install.sh")
RELEASE_TS = os.path.join(REPO, "daemon", "scripts", "release.ts")


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class ScriptSyntaxTest(unittest.TestCase):
    def test_install_sh_parses(self):
        """문법이 깨지면 원라인 설치가 통째로 죽는다 — 가장 먼저 본다.

        bash 를 PATH 에서 찾는다(Windows 의 Git Bash 포함). 이 저장소의 검증 자체가
        bash 를 쓰므로 없는 환경은 상정하지 않는다 — 없으면 그 사실을 실패로 드러낸다."""
        bash = shutil.which("bash")
        self.assertIsNotNone(bash, "bash 를 찾지 못했습니다 — install.sh 문법을 검사할 수 없습니다")
        r = subprocess.run([bash, "-n", INSTALL_SH], capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        self.assertEqual(r.returncode, 0, r.stderr)


class ArgumentContractTest(unittest.TestCase):
    """인자 계약 — 기존 사용법을 깨지 않으면서 v2 를 더한다."""

    def setUp(self):
        self.src = read(INSTALL_SH)

    def test_v1_flags_still_exist(self):
        # 비호환 변경 금지 — 기존 사용자의 명령이 그대로 동작해야 한다
        self.assertIn("--watchdog)", self.src)
        self.assertIn("--uninstall)", self.src)

    def test_v2_flags_added(self):
        self.assertIn("--v2)", self.src)
        self.assertIn("--autostart)", self.src)

    def test_unknown_flag_is_rejected(self):
        # 알 수 없는 인자를 조용히 무시하면 오타가 다른 동작으로 흘러간다
        self.assertIn("알 수 없는 인자", self.src)
        self.assertRegex(self.src, r"알 수 없는 인자.*exit 2")

    def test_v2_is_opt_in(self):
        """기본 동작은 v1 이어야 한다 — v2 는 명시적 선택이다."""
        self.assertRegex(self.src, r"DO_V2=0")

    def test_python_not_required_for_v2(self):
        """v2 는 단일 실행 파일이라 파이썬이 필요 없다."""
        self.assertRegex(self.src, r'if \[ "\$DO_V2" != "1" \]; then\s*\n\s*PY="\$\(find_python\)"')


class DownloadIntegrityTest(unittest.TestCase):
    """**받은 것을 확인한 뒤에만 설치한다** — 이 경로의 존재 이유."""

    def setUp(self):
        self.src = read(INSTALL_SH)

    def test_checksum_is_fetched_and_compared(self):
        self.assertIn("SHA256SUMS", self.src)
        self.assertIn("체크섬 불일치", self.src)

    def test_missing_checksum_list_aborts(self):
        # 체크섬을 못 받으면 '검증 없이 설치' 가 아니라 중단이어야 한다
        self.assertIn("검증 없이 설치하지 않습니다", self.src)

    def test_download_failure_aborts_with_guidance(self):
        self.assertIn("릴리스 산출물을 받지 못했습니다", self.src)
        self.assertIn("소스에서 빌드하십시오", self.src)

    def test_binary_is_exercised_before_install(self):
        """파일이 받아졌다고 우리 것은 아니다 — 실행해서 확인한다."""
        self.assertIn('"$tmp/autoharness" version', self.src)
        self.assertIn("받은 파일이 실행되지 않습니다", self.src)

    def test_failures_do_not_fall_through(self):
        # 모든 실패 분기가 exit 1 로 끝나는지 — 하나라도 흘러가면 깨진 설치가 남는다
        for marker in ("체크섬 불일치", "릴리스 산출물을 받지 못했습니다",
                       "받은 파일이 실행되지 않습니다", "검증 없이 설치하지 않습니다"):
            idx = self.src.index(marker)
            tail = self.src[idx:idx + 400]
            self.assertIn("exit 1", tail, "%s 뒤에 중단이 없습니다" % marker)


class PlatformDetectionTest(unittest.TestCase):
    """플랫폼 판정 — 여기 이름과 릴리스 산출물 이름이 어긋나면 '릴리스는 있는데 못 받는다'."""

    def setUp(self):
        self.src = read(INSTALL_SH)
        self.release = read(RELEASE_TS)

    def test_arch_normalisation(self):
        self.assertIn("x86_64|amd64)", self.src)
        self.assertIn("aarch64|arm64)", self.src)

    def test_os_mapping(self):
        self.assertIn("autoharness-linux-", self.src)
        self.assertIn("autoharness-darwin-", self.src)

    def test_unsupported_platform_is_explicit(self):
        self.assertIn("지원하지 않는 플랫폼입니다", self.src)

    def test_asset_names_match_release_builder(self):
        """설치기가 조립하는 이름이 릴리스가 만드는 이름 집합에 실제로 있는가."""
        produced = set(re.findall(r'asset:\s*"([^"]+)"', self.release))
        self.assertTrue(produced, "릴리스 스크립트에서 asset 이름을 찾지 못했습니다")
        for expected in ("autoharness-linux-x64", "autoharness-linux-arm64",
                         "autoharness-darwin-arm64", "autoharness-darwin-x64"):
            self.assertIn(expected, produced,
                          "설치기가 받으려는 %s 를 릴리스가 만들지 않습니다" % expected)

    def test_release_publishes_compressed_with_checksums(self):
        # 설치기는 .gz 를 받고 SHA256SUMS 로 검증한다 — 릴리스도 그 형태여야 한다
        self.assertIn("gzip", self.release)
        self.assertIn("SHA256SUMS", self.release)
        self.assertIn("sha256", self.release)

    def test_release_does_not_publish_on_failure(self):
        """일부 타깃이 실패하면 올리지 말라고 말해야 한다 — 반쪽 릴리스가 더 나쁘다."""
        self.assertIn("릴리스를 올리지 마십시오", self.release)


class MirrorOverrideTest(unittest.TestCase):
    def test_release_base_can_be_overridden(self):
        """사내 미러·오프라인 배포·설치 경로 실측에 필요하다."""
        src = read(INSTALL_SH)
        self.assertIn("AUTOHARNESS_RELEASE_BASE", src)



class PathGuidanceTest(unittest.TestCase):
    """설치 뒤 안내 — **그대로 따르면 목적을 이뤄야 한다.**

    실측 사고: rc 파일에 추가하라고만 안내했다. 사용자가 그대로 실행하고 곧바로
    `autoharness` 를 쳤더니 command not found 였다. rc 추가는 다음에 여는 셸부터
    적용되기 때문이다. 안내대로 했는데 안 되면 사용자는 설치가 실패했다고 읽는다.
    """

    def setUp(self):
        self.src = read(INSTALL_SH)

    def test_path_hint_reloads_current_shell(self):
        # 추가와 반영이 한 줄에 함께 있어야 한다 — 둘로 나누면 두 번째를 빠뜨린다
        self.assertRegex(self.src, r">> ~/\.bashrc && \. ~/\.bashrc")

    def test_path_hint_covers_non_bash_shells(self):
        # bash 만 상정하면 zsh·fish 사용자는 엉뚱한 파일을 고치게 된다
        self.assertIn(".zshrc", self.src)
        self.assertIn("fish_add_path", self.src)  # fish 는 export 구문 자체가 다르다

    def test_full_path_fallback_is_offered(self):
        # rc 편집을 강요하지 않는다 — 전체 경로로도 쓸 수 있음을 알린다
        self.assertIn("전체 경로로 쓸 수 있습니다", self.src)

    def test_already_on_path_is_not_told_to_add_again(self):
        self.assertIn("PATH 에 이미 있습니다", self.src)

if __name__ == "__main__":
    unittest.main()
