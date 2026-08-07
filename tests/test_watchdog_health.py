# -*- coding: utf-8 -*-
"""워치독 '등록만 되고 실행 안 됨' 감지 회귀 테스트.

실측된 결함: 작업 스케줄러에 Ready 로 등록돼 있어도 매 기동이 0x800710E0(요청 거부)로
반려되면 자동 부활 보장은 무효인데, watchdog_status 는 '등록됨(Ready)'만 보고해 정상처럼
보였다. 여기서 고정하는 계약:

  ① 등록 여부와 '실제 실행 이력'을 분리 판정한다 — 등록됨 + (로그 부재 또는 마지막 기록이
     기대 주기의 3배 이상 경과) → stale 경고.
  ② LastTaskResult 가 0 이 아니면 코드·16진 표기·해석 문구를 함께 보고한다.
     단 0x41303(한 번도 실행 안 됨) 등 정보성 코드는 실패로 취급하지 않는다.
  ③ 전 프로젝트 last_launch 가 null 인 상태를 신호로 제시하되, skip/completed 주기에는
     last_launch 가 갱신되지 않으므로 last_tick 과 함께 해석한다.
  ④ 오탐 경계: 설치 직후 아직 주기가 안 온 경우는 경고 대상이 아니다.

스케줄러·레지스트리는 전부 가짜 입력으로 주입한다 — 실제 스케줄러·사용자 레지스트리·
실행 중 설치본은 건드리지 않는다.
"""

import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_mcp as mcp  # noqa: E402

# 이 PC 에서 실측된 schtasks /V /FO LIST 출력 형태 (Last Result 는 부호 있는 10진수)
SCHTASKS_LIST = """
Folder: \\
HostName:                             DESKTOP
TaskName:                             \\AutoHarnessWatchdog
Next Run Time:                        2026-08-07 오후 12:53:03
Status:                               Ready
Logon Mode:                           Interactive only
Last Run Time:                        2026-08-07 오후 12:41:27
Last Result:                          {last_result}
Task To Run:                          pythonw.exe harness_watchdog.py
Scheduled Task State:                 Enabled
"""


# 같은 명령의 한국어 Windows 출력 — schtasks 는 콘솔 UI 언어로 라벨을 지역화한다.
# 이 저장소에서 실측: 영문 라벨만 보면 마지막 결과(0x800710E0)가 통째로 안 읽힌다.
SCHTASKS_LIST_KO = """
폴더: \\
호스트 이름:                       LEET
작업 이름:                         \\AutoHarnessWatchdog
다음 실행 시간:                    2026-08-07 오후 12:53:03
상태:                              준비
로그온 모드:                       대화형만
마지막 실행 시간:                  2026-08-07 오후 12:41:27
마지막 결과:                       {last_result}
실행할 작업:                       pythonw.exe harness_watchdog.py
예약된 작업 상태:                  사용
"""


def query(exit_code=0, last_result="0", template=SCHTASKS_LIST):
    return {"exit_code": exit_code,
            "stdout": template.format(last_result=last_result) if exit_code == 0 else "",
            "stderr": "" if exit_code == 0 else "ERROR: 지정된 작업 이름을 찾을 수 없습니다."}


def registry(projects=None, installed_at=None, last_tick=None):
    reg = {"schema_version": 1, "settings": {}, "projects": projects or []}
    if installed_at is not None:
        reg["settings"]["watchdog_installed_at"] = installed_at
    if last_tick is not None:
        reg["last_tick"] = last_tick
    return reg


def project(pid, last_launch_ts=None):
    return {"id": pid, "repo": "C:/repo/" + pid, "status": "active",
            "last_launch": {"ts": last_launch_ts, "result": None, "log": None}}


class AgeStub(object):
    """'설치 후 경과 분'·'마지막 tick 경과 분'을 테스트가 직접 주입한다(시계 의존 제거)."""

    def __init__(self, mapping):
        self.mapping = mapping

    def __call__(self, ts):
        return self.mapping.get(ts)


class HealthTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ah-wdhealth-")
        self.log = os.path.join(self.tmp, "watchdog.log")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_log(self, age_minutes=0.0):
        with open(self.log, "w", encoding="utf-8") as f:
            f.write("2026-08-07T03:35:37+00:00 | autoharness | skip | 하트비트 신선\n")
        if age_minutes:
            old = os.path.getmtime(self.log) - age_minutes * 60
            os.utime(self.log, (old, old))

    def health(self, q=None, reg=None, interval=15, ages=None):
        return mcp.watchdog_health(
            q if q is not None else query(), reg if reg is not None else registry(),
            self.log, interval_minutes=interval,
            now_minutes_since=AgeStub(ages or {}))


class ResultCodeInterpretationTest(unittest.TestCase):
    """② LastTaskResult 해석 — 부호 있는 10진수도 부호 없는 16진수로 정규화한다."""

    def test_refused_code_from_signed_decimal(self):
        # 실측값: -2147020576 == 0x800710E0
        r = mcp.interpret_sched_result("-2147020576")
        self.assertEqual(r["hex"], "0x800710E0")
        self.assertFalse(r["benign"])
        self.assertIn("거부", r["meaning"])

    def test_success_code(self):
        r = mcp.interpret_sched_result("0")
        self.assertEqual(r["code"], 0)
        self.assertTrue(r["benign"])

    def test_never_run_code_is_benign(self):
        r = mcp.interpret_sched_result(str(0x41303))
        self.assertTrue(r["benign"])
        self.assertIn("한 번도 실행", r["meaning"])

    def test_running_code_is_benign(self):
        self.assertTrue(mcp.interpret_sched_result(str(0x41301))["benign"])

    def test_hex_input_accepted(self):
        self.assertEqual(mcp.interpret_sched_result("0x800710E0")["code"], 0x800710E0)

    def test_unknown_code_is_not_benign(self):
        r = mcp.interpret_sched_result("12345")
        self.assertFalse(r["benign"])
        self.assertIn("알려지지 않은", r["meaning"])

    def test_unparsable_returns_none(self):
        for bad in (None, "", "   ", "N/A"):
            self.assertIsNone(mcp.interpret_sched_result(bad), repr(bad))


class SchtasksParseTest(unittest.TestCase):
    """LIST 출력 파싱 — 값에 콜론(시각)이 있어도 첫 콜론에서만 자른다."""

    def test_parses_expected_fields(self):
        f = mcp._parse_schtasks_list(SCHTASKS_LIST.format(last_result="0"))
        self.assertEqual(f["status"], "Ready")
        self.assertEqual(f["state"], "Enabled")
        self.assertEqual(f["last_result"], "0")
        self.assertEqual(f["last_run_time"], "2026-08-07 오후 12:41:27")

    def test_parses_korean_locale_output(self):
        # 실측 결함: 한국어 Windows 에서 영문 라벨만 보면 마지막 결과가 안 읽혀
        # 0x800710E0 반려가 진단에서 통째로 사라진다
        f = mcp._parse_schtasks_list(SCHTASKS_LIST_KO.format(last_result="-2147020576"))
        self.assertEqual(f["last_result"], "-2147020576")
        self.assertEqual(f["status"], "준비")
        self.assertEqual(f["state"], "사용")
        self.assertEqual(f["last_run_time"], "2026-08-07 오후 12:41:27")

    def test_unparsable_output_yields_none_fields(self):
        f = mcp._parse_schtasks_list("전혀 다른 로케일의 출력")
        self.assertIsNone(f["last_result"])
        self.assertIsNone(f["status"])


class IsoDurationTest(unittest.TestCase):
    def test_parses_minutes_and_hours(self):
        self.assertEqual(mcp.parse_iso_duration_minutes("PT15M"), 15)
        self.assertEqual(mcp.parse_iso_duration_minutes("PT1H"), 60)
        self.assertEqual(mcp.parse_iso_duration_minutes("PT1H30M"), 90)

    def test_rejects_garbage(self):
        for bad in (None, "", "15분", "PT"):
            self.assertIsNone(mcp.parse_iso_duration_minutes(bad), repr(bad))


class RegistrationVsExecutionTest(HealthTestBase):
    """① 등록 여부와 실제 실행 이력을 분리한다."""

    def test_not_registered(self):
        h = self.health(q=query(exit_code=1))
        self.assertEqual(h["state"], "not_registered")
        self.assertFalse(h["registered"])
        self.assertEqual(h["warnings"], [])

    def test_registered_and_recent_log_is_healthy(self):
        self.write_log(age_minutes=2)
        h = self.health()
        self.assertEqual(h["state"], "healthy")
        self.assertEqual(h["warnings"], [])

    def test_registered_without_any_execution_trace_warns(self):
        # 로그 파일 부재 + tick 기록 없음 = 등록만 되고 한 번도 실행 안 됨
        h = self.health()
        self.assertEqual(h["state"], "stale")
        self.assertTrue(h["warnings"])
        self.assertIn("실행 흔적이 전혀 없습니다", h["warnings"][0])

    def test_stale_log_beyond_three_intervals_warns(self):
        self.write_log(age_minutes=46)      # 15분 × 3 = 45분 초과
        h = self.health(interval=15)
        self.assertEqual(h["state"], "stale")
        self.assertIn("기대 주기", h["warnings"][0])
        self.assertEqual(h["stale_threshold_minutes"], 45)

    def test_log_just_under_threshold_is_healthy(self):
        self.write_log(age_minutes=44)
        self.assertEqual(self.health(interval=15)["state"], "healthy")

    def test_threshold_follows_registered_interval(self):
        self.write_log(age_minutes=100)
        self.assertEqual(self.health(interval=60)["state"], "healthy")   # 60×3=180분 이내
        self.assertEqual(self.health(interval=15)["state"], "stale")

    def test_nonzero_result_warns_even_when_log_is_fresh(self):
        # 실측 상황: 로그는 최근인데 마지막 기동은 반려됨 — 반드시 드러나야 한다
        self.write_log(age_minutes=1)
        h = self.health(q=query(last_result="-2147020576"))
        self.assertEqual(h["state"], "healthy")          # 실행 흔적 자체는 최근
        self.assertTrue(any("0x800710E0" in w for w in h["warnings"]))
        self.assertEqual(h["last_result"]["hex"], "0x800710E0")

    def test_benign_result_does_not_warn(self):
        self.write_log(age_minutes=1)
        h = self.health(q=query(last_result=str(0x41301)))
        self.assertEqual(h["warnings"], [])

    def test_korean_locale_result_still_warns(self):
        # 로케일이 달라도 반려 코드는 진단에 드러나야 한다(실측 결함의 회귀 고정)
        self.write_log(age_minutes=1)
        h = self.health(q=query(last_result="-2147020576", template=SCHTASKS_LIST_KO))
        self.assertEqual(h["last_result"]["hex"], "0x800710E0")
        self.assertTrue(any("0x800710E0" in w for w in h["warnings"]))


class GraceWindowTest(HealthTestBase):
    """④ 오탐 경계 — 설치 직후 아직 주기가 안 온 경우는 경고 대상이 아니다."""

    def test_fresh_install_is_not_warned(self):
        h = self.health(reg=registry(installed_at="INSTALL"),
                        interval=15, ages={"INSTALL": 5.0})   # 45분 유예 안
        self.assertEqual(h["state"], "grace")
        self.assertEqual(h["warnings"], [])

    def test_install_older_than_grace_is_evaluated(self):
        h = self.health(reg=registry(installed_at="INSTALL"),
                        interval=15, ages={"INSTALL": 60.0})
        self.assertEqual(h["state"], "stale")

    def test_grace_still_reports_failed_result_code(self):
        # 유예 중이라도 스케줄러가 명시적 실패를 보고했으면 숨기지 않는다
        h = self.health(q=query(last_result="-2147020576"),
                        reg=registry(installed_at="INSTALL"),
                        interval=15, ages={"INSTALL": 5.0})
        self.assertEqual(h["state"], "grace")
        self.assertTrue(any("0x800710E0" in w for w in h["warnings"]))

    def test_missing_install_stamp_falls_back_to_log_evidence(self):
        # 구버전 설치본에는 설치 시각이 없다 — 유예 없이 실행 흔적으로만 판정한다
        self.write_log(age_minutes=1)
        self.assertEqual(self.health(reg=registry())["state"], "healthy")

    def test_recent_tick_without_log_file_is_not_stale(self):
        # 로그가 지워졌어도 last_tick 이 최근이면 워치독은 돌고 있다
        h = self.health(reg=registry(last_tick="TICK"), ages={"TICK": 3.0})
        self.assertEqual(h["state"], "healthy")


class NeverLaunchedSignalTest(HealthTestBase):
    """③ 전 프로젝트 last_launch=null 신호 — last_tick 과 함께 해석한다."""

    def test_all_null_without_tick_reads_as_watchdog_never_ran(self):
        reg = registry(projects=[project("a"), project("b")])
        h = self.health(reg=reg)
        sig = h["never_launched"]
        self.assertEqual(sig["projects"], ["a", "b"])
        self.assertIn("워치독 미실행이 의심", sig["note"])

    def test_all_null_with_tick_reads_as_skipped_not_dead(self):
        # 실측된 오탐 원인: skip/completed 주기는 last_launch 를 갱신하지 않는다
        reg = registry(projects=[project("a"), project("b")], last_tick="TICK")
        h = self.health(reg=reg, ages={"TICK": 2.0})
        sig = h["never_launched"]
        self.assertIn("기동 조건이 매번 스킵", sig["note"])
        self.assertNotIn("워치독 미실행이 의심", sig["note"])

    def test_no_signal_when_some_project_launched(self):
        reg = registry(projects=[project("a", "2026-08-07T03:00:00+00:00"), project("b")])
        self.assertIsNone(self.health(reg=reg)["never_launched"])

    def test_no_signal_without_projects(self):
        self.assertIsNone(self.health(reg=registry())["never_launched"])


class WatchdogTickStampTest(unittest.TestCase):
    """워치독이 매 주기마다 last_tick 을 남긴다 — 기동이 없었어도 남아야 한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ah-wdtick-")
        self.registry_path = os.path.join(self.tmp, "registry.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_watchdog(self, argv):
        import harness_watchdog as wd
        return wd.main(argv)

    def test_tick_recorded_with_no_projects(self):
        import harness_engine as eng
        self.assertEqual(self.run_watchdog(["--registry", self.registry_path]), 0)
        reg = eng.load_json(self.registry_path)
        self.assertTrue(reg.get("last_tick"), "기동 대상이 없어도 tick 은 남아야 한다")

    def test_dry_run_does_not_record_tick(self):
        import harness_engine as eng
        self.assertEqual(
            self.run_watchdog(["--registry", self.registry_path, "--dry-run"]), 0)
        reg = eng.load_json(self.registry_path)
        self.assertIsNone((reg or {}).get("last_tick"))


if __name__ == "__main__":
    unittest.main()
