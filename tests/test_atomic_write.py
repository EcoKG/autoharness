# -*- coding: utf-8 -*-
"""원자적 쓰기 재시도 회귀 테스트 — OneDrive 동기화·백신 잠금 내성.

os.replace 가 일시적 PermissionError 를 맞으면 지수 백오프(0.1→0.2→0.4→0.8초,
총 5회 시도)로 재시도하고, 영구 잠금이면 마지막 예외를 그대로 던진다.
대기는 time.sleep 모킹으로 계측한다 — 실제 지연 없이 백오프 수열을 검증한다.
"""

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402

EXPECTED_BACKOFF = [eng.REPLACE_BACKOFF_SEC * (2 ** i) for i in range(eng.REPLACE_RETRIES - 1)]


class AtomicWriteRetryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ah-atomictest-")
        self.path = os.path.join(self.dir, "out.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def flaky_replace(self, fail_times, exc=PermissionError):
        """처음 fail_times 번은 exc 를 던지고 이후 실제 os.replace 로 위임."""
        real_replace = os.replace
        state = {"left": fail_times}

        def _replace(src, dst):
            if state["left"] > 0:
                state["left"] -= 1
                raise exc("동기화/백신이 파일을 잠금")
            return real_replace(src, dst)
        return _replace

    def test_survives_transient_lock(self):
        sleeps = []
        with mock.patch.object(eng.os, "replace", side_effect=self.flaky_replace(2)), \
                mock.patch.object(eng.time, "sleep", side_effect=sleeps.append):
            eng.atomic_write_json(self.path, {"k": "값"})
        self.assertEqual(eng.load_json(self.path), {"k": "값"})
        self.assertEqual(sleeps, EXPECTED_BACKOFF[:2])

    def test_exhausted_retries_raise_and_clean_tmp(self):
        sleeps = []
        with mock.patch.object(eng.os, "replace", side_effect=self.flaky_replace(10)), \
                mock.patch.object(eng.time, "sleep", side_effect=sleeps.append):
            with self.assertRaises(PermissionError):
                eng.atomic_write_text(self.path, "내용")
        self.assertEqual(sleeps, EXPECTED_BACKOFF)  # 총 5회 시도, 4회 대기
        self.assertFalse(os.path.exists(self.path))
        # finally 블록이 임시 파일을 치워야 한다
        leftovers = [f for f in os.listdir(self.dir) if f.startswith(".ah-")]
        self.assertEqual(leftovers, [])

    def test_non_permission_oserror_not_retried(self):
        sleeps = []
        with mock.patch.object(eng.os, "replace",
                               side_effect=self.flaky_replace(1, exc=FileNotFoundError)), \
                mock.patch.object(eng.time, "sleep", side_effect=sleeps.append):
            with self.assertRaises(FileNotFoundError):
                eng.atomic_write_json(self.path, {})
        self.assertEqual(sleeps, [])

    def test_normal_write_unaffected(self):
        eng.atomic_write_text(self.path, "한 줄\n")
        with open(self.path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), "한 줄\n")


if __name__ == "__main__":
    unittest.main()
