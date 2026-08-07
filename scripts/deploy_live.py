#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""개발 사본 → 실행 중 설치본(%USERPROFILE%/.claude/skills/autoharness) 동기화.

install.ps1 전체 재설치와 달리 파일 복사만 수행한다 — MCP 등록·스케줄러 작업은
건드리지 않으므로, 통과한 변경이 다음 프로세스 기동(새 세션·다음 워치독 주기)부터
즉시 반영된다. 매핑은 install.ps1/install.sh 와 동일하다:
skill/SKILL.md → SKILL.md, bin/* → bin/, templates/* → templates/,
DESIGN.md·README.md·install.ps1·install.sh → 루트.

쓰기는 임시 파일 + os.replace 로 원자적 — 복사 도중 워치독·새 세션이 반쪽 파일을
읽는 일을 막는다. 종료 코드: 0=성공, 1=일부 복사 실패, 2=설치본 부재.
"""

import hashlib
import os
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
DST = os.path.join(os.path.expanduser("~"), ".claude", "skills", "autoharness")

# (개발 사본 상대경로, 설치본 상대경로) — 존재하지 않는 원본은 건너뛴다(install.sh 등 OS별 선택 파일)
ROOT_MAPPING = [
    ("skill/SKILL.md", "SKILL.md"),
    ("DESIGN.md", "DESIGN.md"),
    ("README.md", "README.md"),
    ("install.ps1", "install.ps1"),
    ("install.sh", "install.sh"),
]


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
            out.write(s.read())
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


def main():
    if not os.path.isfile(os.path.join(REPO, "bin", "harness_engine.py")):
        print("[deploy][ERROR] 개발 사본이 올바르지 않습니다: %s" % REPO)
        return 2
    if not os.path.isdir(DST):
        print("[deploy][ERROR] 설치본이 없습니다: %s — install.ps1 로 최초 설치가 선행돼야 합니다" % DST)
        return 2

    pairs = list(ROOT_MAPPING)
    for sub in ("bin", "templates"):
        srcdir = os.path.join(REPO, sub)
        if not os.path.isdir(srcdir):
            continue
        for name in sorted(os.listdir(srcdir)):
            if name == "__pycache__" or name.endswith(".pyc"):
                continue
            if os.path.isfile(os.path.join(srcdir, name)):
                pairs.append((sub + "/" + name, sub + "/" + name))

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
    print("[deploy] 실행 중 설치본 동기화 완료: %s" % DST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
