# -*- coding: utf-8 -*-
"""MCP 프로토콜 실측 테스트 — bin/harness_mcp.py 를 서브프로세스 stdio 로 왕복.

개행 구분 JSON-RPC 2.0 계약(DESIGN §6)을 실제 파이프로 검증한다:
initialize 에코 · ping · tools/list 14종 · 미지 메서드 -32601 · tools/call
(harness_detect) · 미지 도구 isError · 잘못된 JSON 줄 무시 후 생존.

오염 금지 준수: 호출하는 도구는 읽기 전용 harness_detect 뿐이고 대상은 임시
샌드박스다 — 사용자 레지스트리·설치본·실 저장소를 건드리지 않는다.
대화 전체를 한 번에 써 넣고 stdin 을 닫는 일괄 왕복이라 데드락이 없다.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(REPO, "bin", "harness_mcp.py")

EXPECTED_TOOLS = {
    "harness_detect", "harness_init", "harness_status", "harness_run",
    "task_add", "task_set", "harness_pause", "harness_resume_project",
    "model_recommend", "model_set", "heartbeat",
    "watchdog_install", "watchdog_uninstall", "watchdog_status",
}


class McpProtocolTest(unittest.TestCase):
    """서버 1회 기동으로 전 대화를 왕복하고, 각 측면을 개별 테스트로 검증한다."""

    @classmethod
    def setUpClass(cls):
        cls.sandbox = tempfile.mkdtemp(prefix="ah-mcptest-")
        with open(os.path.join(cls.sandbox, "pyproject.toml"), "w", encoding="utf-8") as f:
            f.write("[project]\nname = \"mcp-detect-sandbox\"\n")
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2024-11-05", "capabilities": {}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},   # 무응답이어야 한다
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 4, "method": "no/such/method"},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
             "params": {"name": "harness_detect", "arguments": {"repo_path": cls.sandbox}}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call",
             "params": {"name": "ghost_tool", "arguments": {}}},
        ]
        payload = "\n".join(json.dumps(r, ensure_ascii=False) for r in requests)
        payload += "\n이 줄은 JSON 이 아니다 — 무시돼야 한다\n"
        payload += json.dumps({"jsonrpc": "2.0", "id": 7, "method": "ping"}) + "\n"

        proc = subprocess.run(
            [sys.executable, SERVER], input=payload, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=120)
        cls.returncode = proc.returncode
        cls.stderr = proc.stderr
        cls.responses = {}
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)   # 프로토콜 채널에는 JSON 외 오염이 없어야 한다
            cls.responses[msg.get("id")] = msg

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.sandbox, ignore_errors=True)

    def resp(self, msg_id):
        self.assertIn(msg_id, self.responses,
                      "id=%s 응답 없음 (stderr: %s)" % (msg_id, self.stderr[-500:]))
        return self.responses[msg_id]

    def test_server_exits_cleanly_on_stdin_close(self):
        self.assertEqual(self.returncode, 0, self.stderr[-500:])

    def test_response_count_matches_requests_with_id(self):
        # id 있는 요청 7건 → 응답 7건. notification·잘못된 줄은 무응답.
        self.assertEqual(sorted(self.responses.keys()), [1, 2, 3, 4, 5, 6, 7])

    def test_initialize_echoes_protocol_and_names_server(self):
        r = self.resp(1)["result"]
        self.assertEqual(r["protocolVersion"], "2024-11-05")  # 요청 값 그대로 에코
        self.assertEqual(r["serverInfo"]["name"], "autoharness")
        self.assertEqual(r["capabilities"]["tools"], {"listChanged": False})

    def test_ping_returns_empty_object(self):
        self.assertEqual(self.resp(2)["result"], {})

    def test_tools_list_has_exact_14_tools(self):
        tools = self.resp(3)["result"]["tools"]
        names = {t["name"] for t in tools}
        self.assertEqual(names, EXPECTED_TOOLS)
        self.assertEqual(len(tools), 14)
        for t in tools:
            self.assertTrue(t.get("description"), t["name"])
            self.assertEqual(t["inputSchema"].get("type"), "object", t["name"])

    def test_unknown_method_returns_32601(self):
        err = self.resp(4)["error"]
        self.assertEqual(err["code"], -32601)
        self.assertIn("no/such/method", err["message"])

    def test_tools_call_harness_detect_roundtrip(self):
        r = self.resp(5)["result"]
        self.assertNotIn("isError", r)
        self.assertEqual(r["content"][0]["type"], "text")
        detect = json.loads(r["content"][0]["text"])
        self.assertIn("python", detect["build_tools"])   # 샌드박스의 pyproject.toml 실측
        self.assertEqual(os.path.normcase(detect["repo"]), os.path.normcase(self.sandbox))

    def test_unknown_tool_is_error_content_not_crash(self):
        r = self.resp(6)["result"]
        self.assertTrue(r.get("isError"))
        self.assertIn("ghost_tool", r["content"][0]["text"])

    def test_survives_malformed_json_line(self):
        # 잘못된 줄 이후의 ping 이 정상 응답 — 크래시 금지 계약
        self.assertEqual(self.resp(7)["result"], {})


if __name__ == "__main__":
    unittest.main()
