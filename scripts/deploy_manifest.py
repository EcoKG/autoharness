# -*- coding: utf-8 -*-
"""배포 명세 — **무엇이 설치본으로 가고 무엇은 절대 가지 않는가.** 단일 출처.

종전에는 이 질문의 답이 코드 세 곳(install.ps1 / install.sh / deploy_live.py)에 흩어져
있었고, 세 곳이 서로 다르게 답했다(실측 2026-08-11):

  - install.ps1 은 `bin\\*` 를 재귀 복사해 저장소에 실재하는 `bin/__pycache__` 를 그대로
    설치본에 넣었다 — 다른 파이썬 버전의 .pyc 가 사용자 계정에 남는다.
  - install.sh 는 `bin/*.py` 만 복사한다.
  - deploy_live 는 또 다른 규칙(파일만, .pyc 제외)을 썼다.

그리고 **금지 목록은 어디에도 없었다.** 허용 목록만 있으면 새로 추가한 파일이 조용히
빠지고, 금지 목록만 있으면 새로 생긴 쓰레기가 조용히 들어간다. 그래서 둘 다 명시한다.

금지가 더 위험한 쪽이다. 이 저장소의 장부·훅 설정·검증 캐시·빌드 산출물이 설치본에
흘러들면 **사용자 계정 전체가 이 저장소의 상태를 물려받는다** — 남의 프로젝트 진행 이력이
담긴 장부가 홈 디렉토리에 놓이는 것이다.
"""

import os

# --------------------------------------------------------------------------- 배포 대상

#: (개발 사본 상대경로, 설치본 상대경로). 존재하지 않는 원본은 건너뛴다
#: (install.sh 는 Windows 체크아웃에도 있지만, OS별 선택 파일이 늘어날 수 있다).
DEPLOY_FILES = (
    ("skill/SKILL.md", "SKILL.md"),
    ("DESIGN.md", "DESIGN.md"),
    ("README.md", "README.md"),
    ("install.ps1", "install.ps1"),
    ("install.sh", "install.sh"),
)

#: (원본 디렉토리, 설치본 디렉토리, 허용 확장자 또는 None=제한 없음).
#: 재귀하지 않는다 — 하위 디렉토리는 전부 부산물이다(`__pycache__`).
DEPLOY_DIRS = (
    ("bin", "bin", (".py",)),
    ("templates", "templates", None),
)

# --------------------------------------------------------------------------- 금지 대상

#: 어느 깊이에서든 통째로 제외하는 디렉토리·파일 이름.
FORBIDDEN_NAMES = frozenset({
    "__pycache__",   # 다른 파이썬 버전의 바이트코드
    "node_modules",  # daemon 의존성
    "dist",          # bun build 산출물(94MiB)
    ".git",
    ".claude",       # 장부·설정·로그·캐시가 전부 여기 있다
    ".venv", "venv", ".idea", ".vscode",
})

#: 확장자로 거르는 것. **이름 전체가 아니라 끝을 본다.**
FORBIDDEN_SUFFIXES = (
    ".pyc", ".pyo", ".pyd",
    ".bun-build",    # 대상 EXE 가 잠겼을 때 남는 임시 산출물
    ".log",
    ".exe",          # 스킬 폴더는 문서·파이썬 자산 자리다. v2 EXE 는 런타임 디렉토리로 간다
)

#: 정확히 이 이름이면 제외 — 확장자만으로는 걸리지 않는 기계·저장소 고유 상태.
FORBIDDEN_BASENAMES = frozenset({
    "agent_tracker.json",     # 이 저장소의 진행 장부
    "settings.json",          # 기계 고유 절대경로가 든 훅 배선
    "settings.local.json",
    "checks-timing.json",     # 검증 파이프라인 캐시
    "PROGRESS.md",            # 장부 렌더 산출물
    "CLAUDE.md",              # 이 저장소 전용 주행 지침(배포본은 templates/CLAUDE.md.tmpl)
    ".DS_Store", "Thumbs.db",
})

#: 백업 접두사 — `settings.json.bak-<ts>` 류.
FORBIDDEN_PREFIXES = (".deploy-", ".ah-")


def forbidden_reason(rel_path):
    """이 경로가 배포 금지인 이유. 배포해도 되면 None.

    **오탐 금지**: 확장자만 보고 거르지 않는다. `templates/agent_harness.sh` 는 배포
    대상이고, `skill/SKILL.md` 도 마찬가지다. 금지 판정은 위 목록에 명시된 것만이다."""
    parts = [p for p in rel_path.replace("\\", "/").split("/") if p and p != "."]
    if not parts:
        return None
    for part in parts:
        if part in FORBIDDEN_NAMES:
            return "%s 는 배포 대상이 아닙니다(부산물·기계 상태)" % part
    name = parts[-1]
    if name in FORBIDDEN_BASENAMES:
        return "%s 는 이 저장소·이 기계에 속하는 파일입니다" % name
    if name.lower().endswith(FORBIDDEN_SUFFIXES):
        return "%s 확장자는 배포 대상이 아닙니다" % os.path.splitext(name)[1]
    if ".bak-" in name:
        return "백업 파일은 배포 대상이 아닙니다"
    for prefix in FORBIDDEN_PREFIXES:
        if name.startswith(prefix):
            return "%s 로 시작하는 임시 파일은 배포 대상이 아닙니다" % prefix
    return None


def deploy_pairs(repo):
    """실제로 복사할 (원본 상대경로, 설치본 상대경로) 목록과, 금지라서 뺀 항목.

    반환: (pairs, skipped) — skipped 는 (상대경로, 사유). 조용히 빼지 않는다."""
    pairs, skipped = [], []

    def consider(src_rel, dst_rel):
        why = forbidden_reason(src_rel)
        if why:
            skipped.append((src_rel, why))
            return
        if os.path.isfile(os.path.join(repo, *src_rel.split("/"))):
            pairs.append((src_rel, dst_rel))

    for src_rel, dst_rel in DEPLOY_FILES:
        consider(src_rel, dst_rel)

    for src_dir, dst_dir, suffixes in DEPLOY_DIRS:
        abs_dir = os.path.join(repo, src_dir)
        if not os.path.isdir(abs_dir):
            continue
        for name in sorted(os.listdir(abs_dir)):
            if not os.path.isfile(os.path.join(abs_dir, name)):
                # 하위 디렉토리는 재귀하지 않는다 — 전부 부산물이다. 다만 **말은 한다**:
                # 규칙이 조용히 무언가를 삼키고 있지 않다는 것이 보여야 한다.
                why = forbidden_reason(name) or "%s 아래 디렉토리는 배포하지 않습니다" % src_dir
                skipped.append((src_dir + "/" + name + "/", why))
                continue
            if suffixes and not name.endswith(suffixes):
                skipped.append((src_dir + "/" + name,
                                "%s 에는 %s 만 배포합니다" % (src_dir, "/".join(suffixes))))
                continue
            consider(src_dir + "/" + name, dst_dir + "/" + name)

    return pairs, skipped


def scan_forbidden(root):
    """설치본에 **이미 들어가 있는** 금지 항목(정렬).

    과거 설치가 남긴 것은 지금 규칙으로 저절로 사라지지 않는다. 알리기만 하고 지우지는
    않는다 — 사용자 계정의 파일을 배포 스크립트가 임의로 지우지 않는다."""
    found = []
    if not os.path.isdir(root):
        return found
    for cur, dirs, files in os.walk(root):
        rel_dir = os.path.relpath(cur, root).replace("\\", "/")
        for name in sorted(dirs):
            rel = name if rel_dir == "." else rel_dir + "/" + name
            why = forbidden_reason(rel)
            if why:
                found.append((rel + "/", why))
        dirs[:] = sorted(d for d in dirs if not forbidden_reason(d))
        for name in sorted(files):
            rel = name if rel_dir == "." else rel_dir + "/" + name
            why = forbidden_reason(rel)
            if why:
                found.append((rel, why))
    return sorted(found)
