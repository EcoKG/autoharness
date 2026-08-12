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

    def test_v2_flag_is_accepted_but_no_longer_needed(self):
        """구현이 하나뿐이라 기본 동작이다.

        플래그는 계속 받아들이고 무시한다 — 문서·블로그·사내 스크립트에 이미 퍼져 있어
        오류로 죽이면 멀쩡히 쓰던 원라인이 그날부터 실패한다."""
        self.assertIn("--v2)", self.src)
        self.assertNotIn("DO_V2", self.src)

    def test_python_is_not_required_at_all(self):
        """단일 실행 파일이라 파이썬이 필요 없다 — 탐색 코드 자체가 남아 있으면 안 된다."""
        self.assertNotIn("find_python", self.src)


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
        # 이름은 플랫폼마다 다르다(Windows 만 .exe) — 실행해서 확인한다는 계약이 핵심이다
        self.assertIn('"$tmp/$exe_name" version', self.src)
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


class WindowsInstallPathTest(unittest.TestCase):
    """Windows 에도 v2 설치 경로가 있어야 한다.

    실측 결함: 릴리스는 `autoharness-windows-x64.exe.gz` 를 올리는데 **그것을 설치할 방법이
    하나도 없었다.** install.sh 의 플랫폼 판정은 Linux·Darwin 뿐이라 Git Bash(uname -s 가
    `MINGW64_NT-...`)에서 "지원하지 않는 플랫폼" 으로 끝났고, install.ps1 에는 v2 분기가
    아예 없었다. 만들어 올려 놓고 아무도 못 받는 상태였다.
    """

    def setUp(self):
        self.sh = read(INSTALL_SH)
        self.ps1 = read(os.path.join(REPO, "install.ps1"))
        self.release = read(RELEASE_TS)

    def test_bash_recognises_windows_shells(self):
        # Git Bash·MSYS2·Cygwin 전부 Windows 다
        self.assertIn("MINGW*|MSYS*|CYGWIN*", self.sh)

    def test_bash_asset_name_matches_release(self):
        produced = set(re.findall(r'asset:\s*"([^"]+)"', self.release))
        self.assertIn("autoharness-windows-x64.exe", produced)
        self.assertIn("autoharness-windows-${arch}.exe", self.sh)

    def test_installed_name_keeps_exe_suffix(self):
        # 데몬·MCP·훅이 이 경로를 쓴다 — 확장자가 빠지면 설치는 되는데 아무도 못 찾는다
        self.assertIn("installed_exe_name", self.sh)
        self.assertRegex(self.sh, r'CYGWIN\*\)\s*echo "autoharness\.exe"')

    def test_stop_uses_taskkill_on_windows(self):
        # pkill 은 Windows 프로세스를 보지 못한다 — 멈춘 줄 알고 잠금으로 실패한다
        self.assertIn("taskkill", self.sh)
        self.assertIn("stop_running_exe", self.sh)

    def test_powershell_has_v2_path(self):
        self.assertIn("Install-AutoHarnessV2", self.ps1)
        self.assertIn("[switch]$V2", self.ps1)
        self.assertIn("autoharness-windows-x64.exe", self.ps1)

    def test_powershell_verifies_before_installing(self):
        """받은 것을 확인한 뒤에만 설치한다 — 이 경로도 같은 계약이다."""
        self.assertIn("SHA256SUMS", self.ps1)
        self.assertIn("체크섬 불일치", self.ps1)
        self.assertIn("검증 없이 설치하지 않습니다", self.ps1)
        self.assertIn("받은 파일이 실행되지 않습니다", self.ps1)

    def test_powershell_simple_match_is_not_regex_escaped(self):
        """-SimpleMatch 에 Regex::Escape 를 씌우면 영영 매치되지 않는다(실측)."""
        idx = self.ps1.index("-SimpleMatch")
        window = self.ps1[max(0, idx - 200):idx]
        self.assertNotIn("[Regex]::Escape", window)


class UpdateBlockedGuidanceTest(unittest.TestCase):
    """갱신이 잠금으로 막혔을 때 — 원문만 남기지 않고 조치를 말한다.

    README 는 "잠금 때문에 실패하면 설치기가 멈출 대상과 명령을 함께 알려 줍니다" 라고
    약속한다. 그런데 원라인 경로는 cp 실패를 그냥 흘려 맨 `cp: Text file busy` 만 남겼다 —
    EXE 쪽 install 은 안내를 하지만 원라인은 그보다 먼저 막혀 거기까지 가지 못한다.
    """

    def setUp(self):
        self.src = read(INSTALL_SH)

    def test_pkill_covers_mcp_server_too(self):
        # 데몬만 잡으면 같은 파일을 실행 중인 MCP 서버가 남아 그대로 잠긴다
        self.assertIn("(daemon|mcp)", self.src)

    def test_copy_failure_is_not_swallowed(self):
        self.assertIn("설치본이 실행 중이라 덮어쓸 수 없습니다", self.src)
        idx = self.src.index("설치본이 실행 중이라 덮어쓸 수 없습니다")
        self.assertIn("exit 1", self.src[idx:idx + 400], "안내 뒤에 중단이 없습니다")

    def test_guidance_names_what_to_stop(self):
        idx = self.src.index("설치본이 실행 중이라 덮어쓸 수 없습니다")
        tail = self.src[idx:idx + 400]
        self.assertIn("stop_command_hint", tail, "멈출 명령이 제시되지 않았습니다")

    def test_stop_hint_is_platform_correct(self):
        """안내는 그 플랫폼에서 실제로 듣는 명령이어야 한다.

        pkill 은 Windows 프로세스를 보지 못한다 — Git Bash 사용자에게 pkill 을 안내하면
        멈춘 줄 알고 다시 시도했다가 같은 잠금에 또 막힌다.
        """
        idx = self.src.index("stop_command_hint()")
        body = self.src[idx:idx + 400]
        self.assertIn("taskkill", body)
        self.assertIn("pkill", body)


class ChecksumAbortExecutionTest(unittest.TestCase):
    """체크섬 검증 경로는 **실제로 실행해서** 확인한다.

    실측 사고: SHA256SUMS 형식이 조금만 달라도(바이너리 모드 `HASH *name`, 소프트 404 로
    돌아온 HTML 등) grep 이 매치하지 못했고, `set -e` + `pipefail` 아래에서 그 대입문이
    스크립트를 그 자리에서 죽였다. 바로 아래 준비돼 있던 중단 안내는 한 번도 출력되지
    못했다 — 화면은 "내려받는 중" 에서 뚝 끊기고 끝났다.

    존재 검사(assertIn)는 그 문구가 **소스에 있다**는 것만 확인하므로 이 결함을 그대로
    통과시켰다. 그래서 여기서는 file:// 픽스처로 install.sh 를 진짜 돌리고 **출력에 그 문구가
    실제로 나오는지**를 본다. 네트워크는 쓰지 않고, 설치 단계 전에 중단되므로 시스템도
    건드리지 않는다.
    """

    tmp = None
    driver = None
    bash = None
    digest = None

    @classmethod
    def setUpClass(cls):
        import gzip
        import hashlib
        import tempfile

        cls.bash = shutil.which("bash")
        cls.tmp = tempfile.mkdtemp(prefix="ah-sha-")
        rel = os.path.join(cls.tmp, "rel")
        os.makedirs(rel)
        os.makedirs(os.path.join(cls.tmp, "bin"))
        os.makedirs(os.path.join(cls.tmp, "home"))

        payload = gzip.compress(b"not-a-real-binary")
        with open(os.path.join(rel, "autoharness-linux-x64.gz"), "wb") as f:
            f.write(payload)
        cls.digest = hashlib.sha256(payload).hexdigest()

        # uname 을 가로채 리눅스로 보이게 한다 — 플랫폼 판정이 고정돼야 자산 이름이 정해진다
        stub = os.path.join(cls.tmp, "bin", "uname")
        with open(stub, "w", encoding="utf-8", newline="\n") as f:
            f.write('#!/bin/sh\ncase "$1" in -m) echo x86_64;; *) echo Linux;; esac\n')
        os.chmod(stub, 0o755)

        # 경로 변환은 bash 안에서 한다 — Windows 경로를 PATH 에 그대로 넣으면
        # 드라이브 문자의 콜론이 PATH 구분자와 충돌한다
        cls.driver = os.path.join(cls.tmp, "run.sh")
        with open(cls.driver, "w", encoding="utf-8", newline="\n") as f:
            f.write(
                'set -u\n'
                'if command -v cygpath >/dev/null 2>&1; then\n'
                '  TU="$(cygpath -u "$1")"; TW="$(cygpath -m "$1")"\n'
                'else\n'
                '  TU="$1"; TW="$1"\n'
                'fi\n'
                'case "$TW" in /*) BASE="file://$TW/rel" ;; *) BASE="file:///$TW/rel" ;; esac\n'
                'PATH="$TU/bin:$PATH" HOME="$TU/home" AUTOHARNESS_RELEASE_BASE="$BASE" '
                'bash "$2/install.sh" --v2 2>&1\n'
            )

    @classmethod
    def tearDownClass(cls):
        if cls.tmp:
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_with(self, sums_body):
        self.assertIsNotNone(self.bash, "bash 를 찾지 못했습니다 — 설치 경로를 실행할 수 없습니다")
        with open(os.path.join(self.tmp, "rel", "SHA256SUMS"), "w",
                  encoding="utf-8", newline="\n") as f:
            f.write(sums_body)
        r = subprocess.run([self.bash, self.driver, self.tmp, REPO],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
        return r.stdout or ""

    def test_missing_entry_prints_the_abort_notice(self):
        """가장 중요한 회귀 — 침묵 종료가 아니라 안내가 나와야 한다."""
        out = self.run_with("<!DOCTYPE html><html>Not Found</html>\n")
        self.assertIn("체크섬 목록에", out,
                      "형식이 어긋났는데 중단 안내가 나오지 않았습니다(침묵 종료 회귀)")
        self.assertIn("받은 목록 첫 줄", out, "원인을 가릴 단서가 출력되지 않았습니다")

    def test_binary_mode_format_is_accepted(self):
        """`sha256sum -b` 출력(`HASH *name`)도 우리 목록으로 인정한다."""
        out = self.run_with("%s *autoharness-linux-x64.gz\n" % self.digest)
        self.assertIn("체크섬 확인", out)

    def test_standard_format_still_works(self):
        out = self.run_with("%s  autoharness-linux-x64.gz\n" % self.digest)
        self.assertIn("체크섬 확인", out)

    def test_mismatch_still_aborts(self):
        """검증을 느슨하게 만든 것이 아님을 확인한다 — 틀린 해시는 여전히 중단이다."""
        out = self.run_with("%s  autoharness-linux-x64.gz\n" % ("0" * 64))
        self.assertIn("체크섬 불일치", out)


if __name__ == "__main__":
    unittest.main()
