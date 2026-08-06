# -*- coding: utf-8 -*-
"""장시간 스테이지 중 하트비트 펌프 회귀 테스트.

단일 스테이지가 timeout_sec(기본 1800초)까지 걸리면 하트비트 공백이 워치독
stale 판정(30분)에 근접해 세션 사망 오판·이중 기동이 날 수 있다 — run 이
스테이지 실행 중 데몬 스레드로 주기 갱신하는지 실측한다.
"""

import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
for _p in (REPO, BIN):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import harness_engine as eng  # noqa: E402
from tests.test_engine_hooks import HookSandboxTest, PY, OK_CMD  # noqa: E402,F401


class HeartbeatPumpUnitTest(unittest.TestCase):
    """HeartbeatPump 스레드 단독 검증(서브프로세스 없음, 짧은 interval)."""

    def setUp(self):
        self.sandbox = tempfile.mkdtemp(prefix="ah-hbtest-")
        self.hb_path = eng.rp(self.sandbox)["heartbeat"]

    def tearDown(self):
        shutil.rmtree(self.sandbox, ignore_errors=True)

    def hb_ts(self):
        hb = eng.load_json(self.hb_path)
        return hb["ts"] if hb else None

    def wait_ts_change(self, prev, deadline_sec=5.0):
        deadline = time.time() + deadline_sec
        while time.time() < deadline:
            cur = self.hb_ts()
            if cur is not None and cur != prev:
                return cur
            time.sleep(0.01)
        self.fail("하트비트가 %s초 안에 갱신되지 않음 (prev=%s)" % (deadline_sec, prev))

    def test_pump_writes_periodically(self):
        with eng.HeartbeatPump(self.sandbox, interval=0.05):
            first = self.wait_ts_change(None)
            second = self.wait_ts_change(first)
        self.assertNotEqual(first, second)
        self.assertEqual(eng.load_json(self.hb_path)["source"], "run")

    def test_pump_stops_on_exit(self):
        pump = eng.HeartbeatPump(self.sandbox, interval=0.05)
        with pump:
            self.wait_ts_change(None)
        self.assertFalse(pump._thread.is_alive())
        snapshot = self.hb_ts()
        time.sleep(0.2)
        self.assertEqual(self.hb_ts(), snapshot)

    def test_interval_env_override(self):
        old = os.environ.get("AUTOHARNESS_HEARTBEAT_PUMP_SEC")
        try:
            os.environ["AUTOHARNESS_HEARTBEAT_PUMP_SEC"] = "0.25"
            self.assertEqual(eng.heartbeat_pump_interval(), 0.25)
            os.environ["AUTOHARNESS_HEARTBEAT_PUMP_SEC"] = "말이 안 되는 값"
            self.assertEqual(eng.heartbeat_pump_interval(), eng.HEARTBEAT_PUMP_SEC)
            del os.environ["AUTOHARNESS_HEARTBEAT_PUMP_SEC"]
            self.assertEqual(eng.heartbeat_pump_interval(), eng.HEARTBEAT_PUMP_SEC)
        finally:
            if old is None:
                os.environ.pop("AUTOHARNESS_HEARTBEAT_PUMP_SEC", None)
            else:
                os.environ["AUTOHARNESS_HEARTBEAT_PUMP_SEC"] = old


class RunHeartbeatIntegrationTest(HookSandboxTest):
    """run 배선 검증 — 느린 스테이지 동안 하트비트가 시작 시점보다 뒤로 전진한다."""

    def test_run_pumps_during_slow_stage(self):
        self.init_tracker(["t1"])
        slow_cmd = '"%s" -c "import time; time.sleep(1.0)"' % PY
        r = self.engine("run", "--task", "t1", "--cmd", slow_cmd,
                        env_extra={"AUTOHARNESS_HEARTBEAT_PUMP_SEC": "0.1"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        hb = eng.load_json(self.paths["heartbeat"])
        self.assertEqual(hb["source"], "run")
        # 로그 머리의 스테이지 시작 시각보다 하트비트가 뒤여야 펌프가 돈 것이다
        task = eng.find_task(eng.load_json(self.paths["tracker"]), "t1")
        with open(os.path.join(self.sandbox, task["last_log_file"]), "r", encoding="utf-8") as f:
            header = f.readline()
        started = datetime.fromisoformat(header.rsplit("time=", 1)[1].strip())
        beat = datetime.fromisoformat(hb["ts"])
        self.assertGreater(beat, started)


if __name__ == "__main__":
    unittest.main()
