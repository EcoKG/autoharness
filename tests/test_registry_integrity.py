# -*- coding: utf-8 -*-
"""레지스트리 쓰기 무결성 회귀 테스트 (적대 검증 high 2건).

① 파손 시 조용한 전멸 — MCP 의 registry_load 는 파손된 registry.json 을 조용히 기본값으로
   대체했고, 이어지는 registry_save 가 등록된 프로젝트를 전부 지웠다. ok:true 로 성공
   보고까지 나가 사용자는 알 수 없었다. 워치독은 같은 파일에 대해 파손이면 덮어쓰지 않고
   종료하는데(fail-loud), 두 주체의 규칙이 정면으로 어긋나 있었다.

② 통째 되쓰기로 인한 갱신 소실 — 워치독이 주기 시작에 읽은 메모리 사본을 끝에 통째로
   저장해, 주기 도중 MCP 가 기록한 변경(task_add 재활성화·pause·model_set·설치 스탬프)이
   조용히 되돌려졌다. completed 프로젝트에 작업을 넣어도 다음 주기가 completed 로 되돌리면
   자동 부활이 영구 무효가 되는 경로였다.

모든 부작용은 임시 디렉토리에 격리된다 — 실제 사용자 레지스트리는 건드리지 않는다.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng      # noqa: E402
import harness_mcp as mcp         # noqa: E402
import harness_watchdog as wd     # noqa: E402


def project(pid, repo, status="active", **extra):
    p = {"id": pid, "repo": repo, "model": "claude-opus-5", "status": status,
         "permission_args": [], "consecutive_errors": 0, "limit_hits": 0,
         "next_retry_at": None, "last_launch": {"ts": None, "result": None, "log": None},
         "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-01T00:00:00+00:00"}
    p.update(extra)
    return p


class RegistrySandbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ah-regint-")
        self.path = os.path.join(self.tmp, "registry.json")
        self._saved = mcp.REGISTRY_PATH
        mcp.REGISTRY_PATH = self.path

    def tearDown(self):
        mcp.REGISTRY_PATH = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_raw(self, text):
        with io.open(self.path, "w", encoding="utf-8") as f:
            f.write(text)

    def write_reg(self, reg):
        eng.atomic_write_json(self.path, reg)

    def read_reg(self):
        return eng.load_json(self.path)


class CorruptRegistryTest(RegistrySandbox):
    """① 파손을 부재와 구분하고, 덮어쓰기 대신 중단한다."""

    def test_missing_is_not_corrupt(self):
        reg, state = mcp.registry_load_checked()
        self.assertEqual(state, mcp.REGISTRY_MISSING)
        self.assertEqual(reg["projects"], [])

    def test_valid_is_ok(self):
        self.write_reg({"schema_version": 1, "settings": {}, "projects": [project("a", "C:/a")]})
        reg, state = mcp.registry_load_checked()
        self.assertEqual(state, mcp.REGISTRY_OK)
        self.assertEqual([p["id"] for p in reg["projects"]], ["a"])

    def test_broken_json_is_corrupt(self):
        self.write_raw("{ this is not json")
        reg, state = mcp.registry_load_checked()
        self.assertEqual(state, mcp.REGISTRY_CORRUPT)
        self.assertIsNone(reg)

    def test_non_object_json_is_corrupt(self):
        self.write_raw("[1, 2, 3]")
        _reg, state = mcp.registry_load_checked()
        self.assertEqual(state, mcp.REGISTRY_CORRUPT)

    def test_write_path_refuses_to_wipe(self):
        """핵심 — 파손 상태에서 쓰기 경로가 기존 등록을 지우지 않는다."""
        self.write_raw('{"projects": [{"id": "소중한프로젝트"')   # 잘린 JSON
        with io.open(self.path, encoding="utf-8") as f:
            before = f.read()
        with self.assertRaises(mcp.ToolError) as ctx:
            mcp.registry_load()
        self.assertIn("파손", str(ctx.exception))
        # 원본이 그대로 남아 있어야 한다
        with io.open(self.path, encoding="utf-8") as f:
            self.assertEqual(f.read(), before)

    def test_corrupt_is_backed_up(self):
        self.write_raw("{ 파손 ")
        with self.assertRaises(mcp.ToolError):
            mcp.registry_load()
        backups = [f for f in os.listdir(self.tmp) if ".corrupt-" in f]
        self.assertEqual(len(backups), 1, "파손본을 대피시켜야 합니다: %s" % os.listdir(self.tmp))

    def test_upsert_does_not_wipe_on_corrupt(self):
        """실제 시나리오: 파손 상태에서 새 프로젝트를 init 해도 전멸하지 않는다."""
        self.write_raw("{ 파손 ")
        with self.assertRaises(mcp.ToolError):
            mcp.registry_upsert("새프로젝트", os.path.join(self.tmp, "repo"),
                                "claude-opus-5", [])

    def test_status_tool_reports_corrupt_instead_of_failing(self):
        """진단은 읽기 전용이므로 파손 상태에서도 답해야 한다."""
        self.write_raw("{ 파손 ")
        reg, state = mcp.registry_load_checked()
        self.assertEqual(state, mcp.REGISTRY_CORRUPT)
        self.assertIsNone(reg)   # 호출자가 default 로 대체해 보고한다


class LostUpdateTest(unittest.TestCase):
    """② 주기 도중 MCP 가 기록한 변경이 통째 되쓰기로 사라지지 않는다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ah-lostupd-")
        self.path = os.path.join(self.tmp, "registry.json")
        self.repo_a = os.path.join(self.tmp, "repoA")
        self.repo_b = os.path.join(self.tmp, "repoB")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def logs(self, *a):
        pass

    def test_untouched_project_keeps_disk_value(self):
        """워치독이 안 만진 프로젝트는 디스크 값이 이긴다 — 재활성화 소실 방지."""
        eng.atomic_write_json(self.path, {"schema_version": 1, "settings": {}, "projects": [
            project("a", self.repo_a, status="completed")]})
        memory = eng.load_json(self.path)          # 주기 시작에 읽은 사본
        # 주기 도중 MCP 가 재활성화했다고 가정
        disk = eng.load_json(self.path)
        disk["projects"][0]["status"] = "active"
        eng.atomic_write_json(self.path, disk)
        # 워치독이 이 프로젝트를 만지지 않았으므로 touched 가 비어 있다
        memory["last_tick"] = "2026-08-07T00:00:00+00:00"
        wd.save_registry_merged(self.path, memory, set(), self.logs)
        self.assertEqual(self.read()["projects"][0]["status"], "active",
                         "주기 도중의 재활성화가 되돌려졌습니다")

    def test_touched_project_writes_watchdog_fields(self):
        eng.atomic_write_json(self.path, {"schema_version": 1, "settings": {}, "projects": [
            project("a", self.repo_a, status="active")]})
        memory = eng.load_json(self.path)
        memory["projects"][0]["status"] = "completed"     # 워치독이 전이시켰다
        memory["projects"][0]["consecutive_errors"] = 3
        memory["last_tick"] = "2026-08-07T00:00:00+00:00"
        wd.save_registry_merged(self.path, memory, {wd.project_key(memory["projects"][0])},
                                self.logs)
        got = self.read()["projects"][0]
        self.assertEqual(got["status"], "completed")
        self.assertEqual(got["consecutive_errors"], 3)

    def test_non_owned_fields_are_not_overwritten(self):
        """모델 변경처럼 워치독 소유가 아닌 필드는 디스크 값이 이긴다."""
        eng.atomic_write_json(self.path, {"schema_version": 1, "settings": {}, "projects": [
            project("a", self.repo_a, model="claude-opus-5")]})
        memory = eng.load_json(self.path)
        memory["projects"][0]["status"] = "needs_human"
        disk = eng.load_json(self.path)
        disk["projects"][0]["model"] = "claude-fable-5"    # 주기 도중 model_set
        eng.atomic_write_json(self.path, disk)
        memory["last_tick"] = "T"
        wd.save_registry_merged(self.path, memory, {wd.project_key(memory["projects"][0])},
                                self.logs)
        got = self.read()["projects"][0]
        self.assertEqual(got["model"], "claude-fable-5", "모델 변경이 되돌려졌습니다")
        self.assertEqual(got["status"], "needs_human")     # 워치독 소유 필드는 반영

    def test_settings_written_during_cycle_survive(self):
        """설치 스탬프처럼 최상위 settings 변경도 살아남아야 한다."""
        eng.atomic_write_json(self.path, {"schema_version": 1, "settings": {},
                                          "projects": [project("a", self.repo_a)]})
        memory = eng.load_json(self.path)
        disk = eng.load_json(self.path)
        disk["settings"]["watchdog_installed_at"] = "2026-08-07T12:00:00+00:00"
        eng.atomic_write_json(self.path, disk)
        memory["last_tick"] = "T"
        wd.save_registry_merged(self.path, memory, set(), self.logs)
        self.assertEqual(self.read()["settings"].get("watchdog_installed_at"),
                         "2026-08-07T12:00:00+00:00", "설치 스탬프가 되돌려졌습니다")

    def test_last_tick_is_always_written(self):
        eng.atomic_write_json(self.path, {"schema_version": 1, "settings": {}, "projects": []})
        memory = eng.load_json(self.path)
        memory["last_tick"] = "2026-08-07T09:00:00+00:00"
        wd.save_registry_merged(self.path, memory, set(), self.logs)
        self.assertEqual(self.read()["last_tick"], "2026-08-07T09:00:00+00:00")

    def test_falls_back_to_memory_when_disk_unreadable(self):
        with io.open(self.path, "w", encoding="utf-8") as f:
            f.write("{ 파손 ")
        memory = {"schema_version": 1, "settings": {}, "projects": [project("a", self.repo_a)],
                  "last_tick": "T"}
        wd.save_registry_merged(self.path, memory, set(), self.logs)
        self.assertEqual([p["id"] for p in self.read()["projects"]], ["a"])

    def test_multiple_projects_only_touched_merged(self):
        eng.atomic_write_json(self.path, {"schema_version": 1, "settings": {}, "projects": [
            project("a", self.repo_a, status="active"),
            project("b", self.repo_b, status="completed")]})
        memory = eng.load_json(self.path)
        memory["projects"][0]["status"] = "needs_human"    # 워치독이 만짐
        memory["projects"][1]["status"] = "completed"      # 안 만짐(메모리 그대로)
        disk = eng.load_json(self.path)
        disk["projects"][1]["status"] = "active"           # 주기 도중 재활성화
        eng.atomic_write_json(self.path, disk)
        memory["last_tick"] = "T"
        wd.save_registry_merged(self.path, memory, {wd.project_key(memory["projects"][0])},
                                self.logs)
        got = {p["id"]: p["status"] for p in self.read()["projects"]}
        self.assertEqual(got["a"], "needs_human")
        self.assertEqual(got["b"], "active", "안 만진 프로젝트의 재활성화가 소실됐습니다")

    def read(self):
        return eng.load_json(self.path)


if __name__ == "__main__":
    unittest.main()
