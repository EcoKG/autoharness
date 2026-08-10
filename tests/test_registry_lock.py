# -*- coding: utf-8 -*-
"""레지스트리 쓰기의 프로세스 간 잠금 회귀.

실측된 결함: registry_load() → 수정 → registry_save() 사이에 상호 배제가 없어, 두 프로세스가
겹치면 A읽기 → B읽기 → B쓰기 → A쓰기 순서에서 B 의 갱신이 사라진다. 저장 직전 재읽기는 창을
좁힐 뿐 없애지 못한다. 쓰기 주체는 최소 셋이다 — 워치독, 세션마다 뜨는 MCP 서버, 그리고
마이그레이션 기간의 v2 데몬. 전부 별개 프로세스라 같은 프로세스 안의 순서 보장은 무의미하다.
잃는 것이 pause 나 프로젝트 등록이면 사용자가 한 조작이 조용히 되돌아간다.

여기서 고정하는 계약:
  ① 잠금은 배타적이고, 예외가 나도 반드시 풀린다
  ② 죽은 잠금(오래된 mtime)은 탈취한다 — 크래시 하나가 영영 막지 않는다
  ③ 획득 실패는 조용히 통과시키지 않고 LockTimeout 을 올린다
  ④ **여러 프로세스가 동시에 써도 갱신이 사라지지 않는다**(이 파일의 본론)
  ⑤ 잠금 파일 규약이 v2 TypeScript 구현과 같다 — 공존해도 서로를 덮지 않는다
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng   # noqa: E402
import harness_mcp as mcp      # noqa: E402


class FileLockTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-lock-")
        self.path = os.path.join(self.dir, "x.lock")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_lock_is_exclusive_and_released(self):
        with eng.file_lock(self.path):
            self.assertTrue(os.path.exists(self.path))
        self.assertFalse(os.path.exists(self.path))

    def test_lock_released_on_exception(self):
        with self.assertRaises(ValueError):
            with eng.file_lock(self.path):
                raise ValueError("안에서 터짐")
        self.assertFalse(os.path.exists(self.path))

    def test_holder_is_recorded(self):
        with eng.file_lock(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        self.assertEqual(payload["pid"], os.getpid())
        self.assertIn("at", payload)

    def test_timeout_raises_instead_of_passing_through(self):
        # 조용히 통과시키면 잠금이 없는 것만 못하다 — 있다고 믿게 만드니 더 나쁘다
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "at": eng.now_iso()}, f)
        started = time.time()
        with self.assertRaises(eng.LockTimeout):
            with eng.file_lock(self.path, timeout=0.2):
                pass
        self.assertGreaterEqual(time.time() - started, 0.15)
        self.assertTrue(os.path.exists(self.path))   # 남의 잠금을 지우지 않았다

    def test_stale_lock_is_stolen(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "at": eng.now_iso()}, f)
        old = time.time() - 60
        os.utime(self.path, (old, old))
        with eng.file_lock(self.path, timeout=1.0, stale=30):
            pass   # 탈취 성공 — 여기 도달한 것 자체가 검증이다

    def test_threads_are_serialized(self):
        inside = {"now": 0, "max": 0}
        guard = threading.Lock()

        def worker():
            with eng.file_lock(self.path, timeout=5):
                with guard:
                    inside["now"] += 1
                    inside["max"] = max(inside["max"], inside["now"])
                time.sleep(0.01)
                with guard:
                    inside["now"] -= 1

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(inside["max"], 1)


CHILD = textwrap.dedent("""
    import os, sys
    sys.path.insert(0, %(bin)r)
    import harness_mcp as mcp
    mcp.REGISTRY_PATH = %(registry)r
    mcp.REGISTRY_LOCK_PATH = %(lock)r
    tag = sys.argv[1]
    for i in range(5):
        mcp.registry_upsert("%%s-%%d" %% (tag, i), os.path.join(%(base)r, "%%s-%%d" %% (tag, i)),
                            "claude-opus-5", [])
""")


class ConcurrentWriteTest(unittest.TestCase):
    """④ 본론 — 별개 프로세스들이 동시에 써도 하나도 사라지지 않는가."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-lockcc-")
        self.registry = os.path.join(self.dir, "registry.json")
        self.lock = os.path.join(self.dir, "registry.lock")
        eng.atomic_write_json(self.registry, mcp.default_registry())
        self.script = os.path.join(self.dir, "child.py")
        with open(self.script, "w", encoding="utf-8") as f:
            f.write(CHILD % {"bin": BIN, "registry": self.registry,
                             "lock": self.lock, "base": self.dir})

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_no_lost_updates_across_processes(self):
        procs = [subprocess.Popen([sys.executable, self.script, tag],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                 for tag in ("a", "b", "c", "d")]
        for p in procs:
            out, err = p.communicate(timeout=120)
            self.assertEqual(p.returncode, 0, err.decode("utf-8", "replace"))

        with open(self.registry, "r", encoding="utf-8") as f:
            reg = json.load(f)
        ids = sorted(p["id"] for p in reg["projects"])
        self.assertEqual(len(ids), 20, "갱신이 사라졌습니다: %r" % ids)
        self.assertEqual(len(set(ids)), 20)

    def test_lock_file_does_not_linger(self):
        subprocess.check_call([sys.executable, self.script, "solo"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertFalse(os.path.exists(self.lock))


class InteropTest(unittest.TestCase):
    """⑤ v2 와 같은 규약인가 — 공존 기간에 서로를 덮지 않으려면 하나여야 한다."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-lockio-")
        self.path = os.path.join(self.dir, "registry.lock")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_lock_path_sits_next_to_registry(self):
        self.assertEqual(os.path.dirname(mcp.REGISTRY_LOCK_PATH),
                         os.path.dirname(mcp.REGISTRY_PATH))
        self.assertEqual(os.path.basename(mcp.REGISTRY_LOCK_PATH), "registry.lock")

    def test_v2_style_lock_is_respected(self):
        # v2 가 쓰는 것과 같은 모양(pid + at)을 v1 이 그대로 존중해야 한다
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "at": "2026-08-10T00:00:00.000Z"}, f)
        with self.assertRaises(eng.LockTimeout):
            with eng.file_lock(self.path, timeout=0.2):
                pass

    def test_payload_shape_matches_v2(self):
        with eng.file_lock(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        self.assertEqual(sorted(payload), ["at", "pid"])
        self.assertIsInstance(payload["pid"], int)


class MutationSitesTest(unittest.TestCase):
    """레지스트리를 고치는 경로가 실제로 잠금을 쓰는가 — 한 곳만 빠져도 구멍이다."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-locksite-")
        self.registry = os.path.join(self.dir, "registry.json")
        self.lock = os.path.join(self.dir, "registry.lock")
        self._saved = (mcp.REGISTRY_PATH, mcp.REGISTRY_LOCK_PATH)
        mcp.REGISTRY_PATH, mcp.REGISTRY_LOCK_PATH = self.registry, self.lock
        eng.atomic_write_json(self.registry, mcp.default_registry())

    def tearDown(self):
        mcp.REGISTRY_PATH, mcp.REGISTRY_LOCK_PATH = self._saved
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_upsert_blocks_while_locked(self):
        with open(self.lock, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "at": eng.now_iso()}, f)
        try:
            saved = eng.REGISTRY_LOCK_TIMEOUT_SEC
            eng.REGISTRY_LOCK_TIMEOUT_SEC = 0.2
            with self.assertRaises(mcp.ToolError):
                mcp.registry_upsert("p", self.dir, "claude-opus-5", [])
        finally:
            eng.REGISTRY_LOCK_TIMEOUT_SEC = saved
            os.remove(self.lock)

    def test_upsert_succeeds_and_releases(self):
        entry = mcp.registry_upsert("p", self.dir, "claude-opus-5", [])
        self.assertEqual(entry["status"], "active")
        self.assertFalse(os.path.exists(self.lock))


if __name__ == "__main__":
    unittest.main()
