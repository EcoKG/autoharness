#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""개발 사본 → 실행 중 설치본 동기화. **두 곳을 본다.**

install.ps1 전체 재설치와 달리 파일 복사만 수행한다 — MCP 등록·스케줄러 작업은
건드리지 않으므로, 통과한 변경이 다음 프로세스 기동(새 세션·다음 워치독 주기)부터
즉시 반영된다.

① 스킬 자산 → `~/.claude/skills/autoharness/`. 매핑은 install.ps1/install.sh 와 동일:
   skill/SKILL.md → SKILL.md, bin/* → bin/, templates/* → templates/,
   DESIGN.md·README.md·install.ps1·install.sh → 루트.

② v2 EXE → `~/.claude/autoharness/bin/autoharness(.exe)`.
   **v2 마이그레이션 이후 이쪽이 비어 있었다.** 지금 훅·MCP·제어판을 실제로 실행하는
   것은 이 EXE 인데 아무도 갱신하지 않아, daemon/ 을 고치는 모든 작업의 결과가 사람이
   보는 자리에는 도달하지 않았다(실측 2026-08-11: 배선 진단을 고쳐 검증을 통과시킨
   직후에도 status 는 구버전 판정을 냈다). 저장소 목표가 "검증 통과 시 실행 중
   설치본에 즉시 반영" 인데 절반만 지켜지고 있었다.

   매번 94MiB 를 다시 만들지 않는다 — daemon 소스 해시를 설치본 옆에 스탬프로 남겨
   **바뀐 경우에만** 빌드·교체한다.

쓰기는 임시 파일 + os.replace 로 원자적 — 복사 도중 워치독·새 세션이 반쪽 파일을
읽는 일을 막는다. 종료 코드: 0=성공, 1=일부 복사 실패·빌드 실패, 2=설치본 부재.

데몬이 돌고 있으면 윈도우가 EXE 를 잠가 교체가 실패한다. 이것은 코드 결함이 아니라
환경 상태이므로 **사유와 조치를 알리되 검증을 실패로 만들지 않는다**(스탬프를 남기지
않으므로 다음 실행이 다시 시도한다).
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 엔진의 원자적 쓰기 규칙(잠금 재시도)을 그대로 쓴다 — 배포 경로만 다른 규칙을 쓰면
# 같은 일시적 잠금에서 여기만 실패한다.
sys.path.insert(0, os.path.join(REPO, "bin"))
import harness_engine as eng  # noqa: E402

# 무엇을 배포하고 무엇은 절대 배포하지 않는가 — 정의는 여기 한 곳뿐이다.
# 두 번째 목록을 여기에 두지 않는다(그것이 세 구현이 갈라진 원인이다).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deploy_manifest import deploy_pairs, scan_forbidden  # noqa: E402

DST = os.path.join(os.path.expanduser("~"), ".claude", "skills", "autoharness")


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_copy(src, dst):
    d = os.path.dirname(dst)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".deploy-", dir=d)
    try:
        with open(src, "rb") as s, os.fdopen(fd, "wb") as out:
            # 통째로 읽지 않는다 — v2 EXE 는 94MiB 다(스킬 자산은 수십 KB 였다)
            shutil.copyfileobj(s, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        # 엔진과 같은 재시도 규칙을 쓴다 — 이 저장소는 OneDrive 안에 있어 동기화·백신이
        # 잠깐 잠그는 PermissionError 가 실제로 난다. 여기만 raw os.replace 라 같은
        # 일시적 잠금에 설치본 동기화가 실패했다(적대 검증에서 확인).
        eng.replace_with_retry(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# --------------------------------------------------------------------------- v2 EXE

DAEMON = os.path.join(REPO, "daemon")
EXE_NAME = "autoharness.exe" if os.name == "nt" else "autoharness"
RUNTIME_BIN = os.path.join(os.path.expanduser("~"), ".claude", "autoharness", "bin")
INSTALLED_EXE = os.path.join(RUNTIME_BIN, EXE_NAME)
SRC_STAMP = os.path.join(RUNTIME_BIN, ".autoharness-src.sha256")

# 빌드 결과를 좌우하는 것 전부 — 하나라도 빠지면 "안 바뀐 줄 알고" 옛 EXE 를 남긴다
BUILD_INPUT_FILES = ("package.json", "tsconfig.json", os.path.join("scripts", "build.ts"))


def daemon_source_hash(daemon_dir=None):
    """daemon 소스의 내용 해시. 대상이 하나도 없으면 None(= 판정 불가).

    경로를 기본 인자로 묶지 않는다 — 기본값은 정의 시점에 고정돼 호출 시점의 모듈
    상수를 무시한다. 테스트가 임시 폴더로 갈아끼울 수 있어야 실제 런타임 디렉토리를
    건드리지 않고 검증할 수 있다."""
    daemon_dir = daemon_dir or DAEMON
    h = hashlib.sha256()
    seen = 0
    src = os.path.join(daemon_dir, "src")
    files = []
    for root, dirs, names in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d != "node_modules")
        for name in sorted(names):
            files.append(os.path.join(root, name))
    for rel in BUILD_INPUT_FILES:
        files.append(os.path.join(daemon_dir, rel))
    for path in sorted(files):
        if not os.path.isfile(path):
            continue
        h.update(os.path.relpath(path, daemon_dir).replace("\\", "/").encode("utf-8"))
        h.update(b"\0")
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        seen += 1
    return h.hexdigest() if seen else None


def read_stamp(path=None):
    path = path or SRC_STAMP
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def find_bun():
    found = shutil.which("bun")
    if found:
        return found
    candidate = os.path.join(os.path.expanduser("~"), ".bun", "bin",
                             "bun.exe" if os.name == "nt" else "bun")
    return candidate if os.path.exists(candidate) else None


def is_locked(err):
    """대상 EXE 가 실행 중이라 잠긴 경우인가 — 코드 결함이 아니라 환경 상태다.

    윈도우는 실행 중인 파일에 접근 거부(5)나 공유 위반(32)을 낸다. 리눅스·macOS 는
    실행 중이어도 교체되므로 여기 걸릴 일이 거의 없고, 그때의 PermissionError 는
    쓰기 권한 문제라 역시 코드가 아니라 환경 문제다."""
    if isinstance(err, PermissionError):
        return True
    return isinstance(err, OSError) and getattr(err, "winerror", None) in (5, 32)


def deploy_v2_exe(force=False):
    """(종료 코드 기여, 메시지 목록). 종료 코드 기여는 0 아니면 1."""
    notes = []
    if not os.path.isdir(os.path.join(DAEMON, "src")):
        return 0, ["[deploy] daemon/src 없음 — v2 EXE 단계 건너뜀"]
    if not os.path.isdir(RUNTIME_BIN):
        # v2 를 설치한 적이 없는 환경이다. 결함이 아니다.
        return 0, ["[deploy] v2 설치본 없음(%s) — EXE 단계 건너뜀" % RUNTIME_BIN]

    current = daemon_source_hash()
    if current is None:
        return 1, ["[deploy][ERROR] daemon 소스를 읽을 수 없어 변경 여부를 판정할 수 없습니다"]
    if not force and current == read_stamp() and os.path.isfile(INSTALLED_EXE):
        return 0, ["[deploy] v2 EXE 최신 — daemon 소스 변화 없음(빌드 건너뜀)"]

    bun = find_bun()
    if not bun:
        # 조용히 건너뛰면 v2 변경이 영영 반영되지 않는데 아무도 모른다
        return 1, ["[deploy][ERROR] daemon/src 가 바뀌었는데 bun 이 없어 EXE 를 만들 수 없습니다. "
                   "https://bun.sh 설치 후 다시 실행하십시오"]

    try:
        r = subprocess.run([bun, "run", "build"], cwd=DAEMON, timeout=300,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, ["[deploy][ERROR] v2 빌드를 실행할 수 없습니다: %s" % e]
    if r.returncode != 0:
        return 1, ["[deploy][ERROR] v2 빌드 실패 (exit %d)" % r.returncode,
                   ((r.stdout or "") + (r.stderr or "")).strip()[-1500:]]

    built = os.path.join(DAEMON, "dist", EXE_NAME)
    if not os.path.isfile(built):
        return 1, ["[deploy][ERROR] 빌드는 성공했는데 산출물이 없습니다: %s" % built]

    if os.path.isfile(INSTALLED_EXE) and md5(built) == md5(INSTALLED_EXE):
        # 소스는 바뀌었지만 산출물이 같다(주석·문서만 바뀐 경우 등) — 교체할 이유가 없다
        write_stamp(current)
        return 0, ["[deploy] v2 EXE 내용 동일 — 교체 없이 스탬프만 갱신"]

    try:
        atomic_copy(built, INSTALLED_EXE)
    except OSError as e:
        if is_locked(e):
            # 스탬프를 남기지 않는다 — 다음 실행이 다시 시도한다
            return 0, ["[deploy][주의] v2 EXE 가 사용 중이라 교체하지 못했습니다: %s" % INSTALLED_EXE,
                       "            데몬이 실행 중일 수 있습니다. 정지 후 다시 검증하면 반영됩니다.",
                       "            (검증 결과에는 영향 없음 — 코드가 아니라 환경 상태입니다)"]
        return 1, ["[deploy][ERROR] v2 EXE 복사 실패: %s" % e]

    if md5(built) != md5(INSTALLED_EXE):
        return 1, ["[deploy][ERROR] v2 EXE 복사 후 해시 불일치: %s" % INSTALLED_EXE]
    write_stamp(current)
    size = os.path.getsize(INSTALLED_EXE) / (1024.0 * 1024.0)
    return 0, ["[deploy] v2 EXE 갱신: %s (%.1f MiB)" % (INSTALLED_EXE, size)]


def write_stamp(value, path=None):
    path = path or SRC_STAMP
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(value)
    except OSError as e:
        # 스탬프를 못 써도 배포 자체는 성공했다 — 다음 실행이 한 번 더 빌드할 뿐이다
        print("[deploy][주의] 소스 스탬프를 남기지 못했습니다(%s) — 다음 실행에서 다시 빌드합니다" % e)


# --------------------------------------------------------------------------- 진입점

def main():
    ap = argparse.ArgumentParser(prog="deploy_live", description="실행 중 설치본 동기화")
    ap.add_argument("--no-v2", action="store_true", help="v2 EXE 빌드·교체를 생략한다")
    ap.add_argument("--force-v2", action="store_true", help="소스 변화가 없어도 v2 EXE 를 다시 만든다")
    a = ap.parse_args()

    if not os.path.isfile(os.path.join(REPO, "bin", "harness_engine.py")):
        print("[deploy][ERROR] 개발 사본이 올바르지 않습니다: %s" % REPO)
        return 2
    if not os.path.isdir(DST):
        print("[deploy][ERROR] 설치본이 없습니다: %s — install.ps1 로 최초 설치가 선행돼야 합니다" % DST)
        return 2

    pairs, skipped = deploy_pairs(REPO)
    if skipped:
        # 조용히 빼지 않는다 — 무엇이 왜 빠졌는지 보여야 명세가 틀렸을 때 드러난다
        print("[deploy] 배포 대상에서 제외 %d건:" % len(skipped))
        for rel, why in skipped:
            print("         - %s — %s" % (rel, why))

    copied, same, failed = [], [], []
    for rel_src, rel_dst in pairs:
        src = os.path.join(REPO, *rel_src.split("/"))
        dst = os.path.join(DST, *rel_dst.split("/"))
        if not os.path.exists(src):
            continue
        if os.path.exists(dst) and md5(src) == md5(dst):
            same.append(rel_dst)
            continue
        try:
            atomic_copy(src, dst)
            if md5(src) != md5(dst):
                failed.append((rel_dst, "복사 후 해시 불일치"))
            else:
                copied.append(rel_dst)
        except OSError as e:
            failed.append((rel_dst, str(e)))

    print("[deploy] 갱신 %d건: %s" % (len(copied), ", ".join(copied) or "-"))
    print("[deploy] 동일 %d건 (건너뜀)" % len(same))
    if failed:
        for rel_dst, why in failed:
            print("[deploy][ERROR] 복사 실패: %s — %s" % (rel_dst, why))
        return 1
    print("[deploy] 스킬 자산 동기화 완료: %s" % DST)

    # 과거 설치가 남긴 것은 지금 규칙으로 저절로 사라지지 않는다. 알리기만 하고 지우지
    # 않는다 — 사용자 계정의 파일을 배포 스크립트가 임의로 지우지 않는다.
    stale = scan_forbidden(DST)
    if stale:
        print("[deploy][주의] 설치본에 배포 대상이 아닌 항목이 %d건 있습니다(과거 설치의 잔재):"
              % len(stale))
        for rel, why in stale[:10]:
            print("              - %s — %s" % (rel, why))
        if len(stale) > 10:
            print("              … 외 %d건" % (len(stale) - 10))
        print("              지우려면 직접 확인 후 삭제하십시오: %s" % DST)

    if a.no_v2:
        print("[deploy] --no-v2 — EXE 단계 생략")
        return 0
    rc, notes = deploy_v2_exe(force=a.force_v2)
    for line in notes:
        print(line)
    return rc


if __name__ == "__main__":
    sys.exit(main())
