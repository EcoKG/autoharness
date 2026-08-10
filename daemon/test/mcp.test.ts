/**
 * MCP 계약 테스트 — 서버가 **죽지 않는 것**이 1급 요구사항이다.
 *
 * 클라이언트는 서버가 죽으면 도구를 통째로 잃으므로, 잘못된 줄·객체 아닌 메시지·도구 내부
 * 예외 어느 것도 루프를 내리면 안 된다. 여기서 고정하는 계약:
 *   ① initialize/ping/tools/list/tools/call 왕복
 *   ② notification(id 없음)은 무응답, 미지 메서드는 -32601
 *   ③ 도구 이름 14종과 핸들러가 일치(외부 계약)
 *   ④ harness_run 은 실제 종료 코드(0/1/2/3/4)를 그대로 전달
 *   ⑤ 위임 경로와 인프로세스 경로의 결과가 같다
 *   ⑥ 실제 레지스트리·설치본을 오염시키지 않는다(AUTOHARNESS_HOME 격리)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../src/exit.ts";
import { createTracker, findTask, loadTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths, userPaths } from "../src/core/paths.ts";
import {
  defaultRegistry,
  findProject,
  loadRegistryChecked,
  loadRegistryForWrite,
  mutateRegistry,
  reactivateIfCompleted,
  saveRegistry,
  upsertProject,
} from "../src/core/registry.ts";
import { callToolWithFallback, readDaemonInfo, tryDelegate } from "../src/mcp/delegate.ts";
import { METHOD_NOT_FOUND, handleLine, handleMessage } from "../src/mcp/protocol.ts";
import { TOOLS, assertToolsConsistent } from "../src/mcp/schemas.ts";
import { HANDLERS, ToolError } from "../src/mcp/tools.ts";

let dir = "";
let home = "";
/** 실제 사용자 상태를 건드리지 않는 격리 환경 — CLAUDE.md 6절의 요구사항. */
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-mcp-"));
  home = await mkdtemp(join(tmpdir(), "ah-home-"));
  env = { ...process.env, AUTOHARNESS_HOME: home, AUTOHARNESS_NO_DELEGATE: "1" };
  process.env["AUTOHARNESS_HOME"] = home;
  process.env["AUTOHARNESS_NO_DELEGATE"] = "1";
  await mkdir(repoPaths(dir).claudeDir, { recursive: true });
});
afterEach(async () => {
  delete process.env["AUTOHARNESS_HOME"];
  delete process.env["AUTOHARNESS_NO_DELEGATE"];
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function initTracker(testCmd = "exit 0"): Promise<void> {
  const t = createTracker({
    project: "p", objective: "o", source: "A", target: "B", test: testCmd,
  });
  t.tasks = [newTask("t1", "작업")];
  await saveTracker(dir, t);
}

function rpc(method: string, params?: unknown, id: unknown = 1): string {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== undefined) msg["id"] = id;
  if (params !== undefined) msg["params"] = params;
  return JSON.stringify(msg);
}

/** tools/call 응답에서 도구 반환값(JSON 텍스트)을 꺼낸다. */
function toolPayload(resp: Record<string, unknown> | null): { text: string; isError: boolean } {
  const result = resp?.["result"] as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0]!.text, isError: result.isError === true };
}

describe("JSON-RPC 프로토콜", () => {
  test("initialize 는 서버 정보와 도구 능력을 돌려준다", async () => {
    const resp = await handleLine(rpc("initialize", { protocolVersion: "2024-11-05" }));
    const result = resp?.["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2024-11-05");
    expect((result["serverInfo"] as { name: string }).name).toBe("autoharness");
    expect(result["capabilities"]).toEqual({ tools: { listChanged: false } });
  });

  test("protocolVersion 이 없으면 기본값을 쓴다", async () => {
    const resp = await handleLine(rpc("initialize", {}));
    expect((resp?.["result"] as Record<string, unknown>)["protocolVersion"]).toBeTruthy();
  });

  test("ping 은 빈 결과", async () => {
    expect((await handleLine(rpc("ping")))?.["result"]).toEqual({});
  });

  test("tools/list 는 14종을 돌려준다", async () => {
    const resp = await handleLine(rpc("tools/list"));
    const tools = (resp?.["result"] as { tools: { name: string }[] }).tools;
    expect(tools.length).toBe(14);
    expect(tools.every((t) => typeof t.name === "string")).toBe(true);
  });

  test("notification(id 없음)은 무응답", async () => {
    expect(await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "ping" }))).toBeNull();
    expect(await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: null }))).toBeNull();
  });

  test("미지 메서드는 -32601", async () => {
    const resp = await handleLine(rpc("없는/메서드"));
    expect((resp?.["error"] as { code: number }).code).toBe(METHOD_NOT_FOUND);
  });

  test("잘못된 줄과 빈 줄은 무시하고 죽지 않는다", async () => {
    expect(await handleLine("{ 깨진 JSON")).toBeNull();
    expect(await handleLine("")).toBeNull();
    expect(await handleLine("   ")).toBeNull();
    // 그 다음 정상 메시지가 여전히 처리된다 — 스트림이 끊기지 않았다
    expect((await handleLine(rpc("ping")))?.["result"]).toEqual({});
  });

  test("객체가 아닌 메시지도 죽이지 못한다", async () => {
    expect(await handleLine("[1,2,3]")).toBeNull();
    expect(await handleLine('"문자열"')).toBeNull();
    expect(await handleLine("42")).toBeNull();
  });

  test("method 없는 메시지(클라이언트 응답)는 무시한다", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", id: 7, result: {} })).toBeNull();
  });

  test("알 수 없는 도구는 서버 오류가 아니라 isError 응답이다", async () => {
    const resp = await handleLine(rpc("tools/call", { name: "없는도구", arguments: {} }));
    expect(resp?.["error"]).toBeUndefined();
    expect(toolPayload(resp).isError).toBe(true);
  });

  test("도구가 던진 오류는 isError 로 전달되고 루프는 산다", async () => {
    const resp = await handleLine(rpc("tools/call", { name: "harness_status", arguments: {} }));
    const payload = toolPayload(resp);
    expect(payload.isError).toBe(true);
    expect(payload.text).toContain("repo_path");
    expect((await handleLine(rpc("ping")))?.["result"]).toEqual({});
  });
});

describe("도구 계약", () => {
  test("정의와 핸들러가 일치한다", () => {
    expect(() => assertToolsConsistent()).not.toThrow();
    expect(TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(HANDLERS).sort());
  });

  test("v1 과 같은 14개 이름을 유지한다 (외부 계약)", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "harness_detect", "harness_init", "harness_pause", "harness_resume_project",
        "harness_run", "harness_status", "heartbeat", "model_recommend", "model_set",
        "task_add", "task_set", "watchdog_install", "watchdog_status", "watchdog_uninstall",
      ].sort(),
    );
  });

  test("모든 도구가 inputSchema 를 갖는다", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(Array.isArray(t.inputSchema.required), t.name).toBe(true);
    }
  });
});

describe("도구 동작 — 인프로세스", () => {
  test("harness_detect 는 스택을 실측한다", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x" } }), "utf8");
    const r = (await HANDLERS["harness_detect"]!({ repo_path: dir })) as {
      build_tools: string[]; suggested_commands: Record<string, { test: string | null }>;
    };
    expect(r.build_tools).toContain("node");
    expect(r.suggested_commands["node"]!.test).toBe("npm test");
  });

  test("harness_init 은 장부·설정·레지스트리를 만든다", async () => {
    const r = (await HANDLERS["harness_init"]!({
      repo_path: dir, project: "proj", objective: "obj",
      source_stack: "A", target_stack: "B", test_cmd: "exit 0",
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect((await loadTracker(dir)).state).toBe("ok");
    expect(await Bun.file(join(repoPaths(dir).claudeDir, "settings.json")).exists()).toBe(true);
    const reg = await loadRegistryChecked(env);
    expect(findProject(reg.registry, dir)?.id).toBe("proj");
  });

  test("harness_init 은 기존 장부를 덮지 않는다 — 진행 상태 파괴 방지", async () => {
    await initTracker();
    await expect(
      HANDLERS["harness_init"]!({
        repo_path: dir, project: "p", objective: "o",
        source_stack: "A", target_stack: "B", test_cmd: "exit 0",
      }),
    ).rejects.toThrow(ToolError);
  });

  test("허용되지 않은 모델은 거부한다", async () => {
    await expect(
      HANDLERS["harness_init"]!({
        repo_path: dir, project: "p", objective: "o", source_stack: "A",
        target_stack: "B", test_cmd: "exit 0", model: "gpt-9",
      }),
    ).rejects.toThrow(ToolError);
  });

  test("장부 부재와 파손을 구분해 알린다", async () => {
    await expect(HANDLERS["harness_status"]!({ repo_path: dir })).rejects.toThrow(/없습니다/);
    await writeFile(repoPaths(dir).tracker, "{ 깨진", "utf8");
    await expect(HANDLERS["harness_status"]!({ repo_path: dir })).rejects.toThrow(/파손/);
  });

  test("harness_status 는 배선 진단을 함께 싣는다", async () => {
    await initTracker();
    const r = (await HANDLERS["harness_status"]!({ repo_path: dir })) as {
      counts: { pending: number }; hooks: { state: string }; registry_state: string;
    };
    expect(r.counts.pending).toBe(1);
    expect(r.hooks.state).toBe("not_registered");
    expect(r.registry_state).toBe("missing");
  });

  test("harness_run 은 실제 종료 코드를 그대로 전달한다", async () => {
    await initTracker("exit 0");
    const ok = (await HANDLERS["harness_run"]!({ repo_path: dir, task_id: "t1" })) as { exit_code: number };
    expect(ok.exit_code).toBe(EXIT.OK);
    expect(findTask((await loadTracker(dir)).tracker!, "t1")!.status).toBe("done");
  });

  test("harness_run 은 실패도 그대로 전달한다(1)", async () => {
    await initTracker("exit 1");
    const r = (await HANDLERS["harness_run"]!({ repo_path: dir, task_id: "t1" })) as { exit_code: number };
    expect(r.exit_code).toBe(EXIT.FAIL);
  });

  test("harness_run 은 진행 가능 작업이 없으면 3", async () => {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    await saveTracker(dir, t);
    const r = (await HANDLERS["harness_run"]!({ repo_path: dir })) as { exit_code: number };
    expect(r.exit_code).toBe(EXIT.NO_TASK);
  });

  test("harness_run 은 blocked 작업 지정 시 4", async () => {
    await initTracker();
    const t = (await loadTracker(dir)).tracker!;
    findTask(t, "t1")!.status = "blocked";
    await saveTracker(dir, t);
    const r = (await HANDLERS["harness_run"]!({ repo_path: dir, task_id: "t1" })) as { exit_code: number };
    expect(r.exit_code).toBe(EXIT.BLOCKED);
  });

  test("task_add 는 의존 규칙을 그대로 강제한다", async () => {
    await initTracker();
    await expect(
      HANDLERS["task_add"]!({ repo_path: dir, id: "t2", title: "x", deps: ["없는작업"] }),
    ).rejects.toThrow(ToolError);
    await HANDLERS["task_add"]!({ repo_path: dir, id: "t2", title: "x", deps: ["t1"] });
    expect(findTask((await loadTracker(dir)).tracker!, "t2")).toBeDefined();
  });

  test("task_set 은 pending/blocked 만 허용한다", async () => {
    await initTracker();
    await expect(
      HANDLERS["task_set"]!({ repo_path: dir, id: "t1", status: "done" }),
    ).rejects.toThrow(ToolError);
    await HANDLERS["task_set"]!({ repo_path: dir, id: "t1", status: "blocked", note: "사유" });
    const task = findTask((await loadTracker(dir)).tracker!, "t1")!;
    expect(task.status).toBe("blocked");
    expect(task.last_error).toBe("사유");
  });

  test("pause/resume 는 플래그와 레지스트리를 함께 움직인다", async () => {
    await initTracker();
    await mutateRegistry(
      (reg) => upsertProject(reg, { id: "p", repo: dir, model: "claude-opus-5", permissionArgs: [] }),
      env,
    );
    await HANDLERS["harness_pause"]!({ repo_path: dir });
    expect(await Bun.file(repoPaths(dir).pausedFlag).exists()).toBe(true);
    expect(findProject((await loadRegistryChecked(env)).registry, dir)!.status).toBe("paused");

    await HANDLERS["harness_resume_project"]!({ repo_path: dir });
    expect(await Bun.file(repoPaths(dir).pausedFlag).exists()).toBe(false);
    expect(findProject((await loadRegistryChecked(env)).registry, dir)!.status).toBe("active");
  });

  test("model_set 은 장부와 레지스트리 양쪽을 고친다", async () => {
    await initTracker();
    await mutateRegistry(
      (reg) => upsertProject(reg, { id: "p", repo: dir, model: "claude-opus-5", permissionArgs: [] }),
      env,
    );
    await HANDLERS["model_set"]!({ repo_path: dir, model: "claude-fable-5" });
    expect((await loadTracker(dir)).tracker!.model).toBe("claude-fable-5");
    expect(findProject((await loadRegistryChecked(env)).registry, dir)!.model).toBe("claude-fable-5");
    await expect(HANDLERS["model_set"]!({ repo_path: dir, model: "없는모델" })).rejects.toThrow(ToolError);
  });

  test("heartbeat 는 파일을 남긴다", async () => {
    await HANDLERS["heartbeat"]!({ repo_path: dir });
    expect(await Bun.file(repoPaths(dir).heartbeat).exists()).toBe(true);
  });

  test("model_recommend 는 근거 없는 추천을 하지 않는다", async () => {
    const r = (await HANDLERS["model_recommend"]!({ source_stack: "Java 8", target_stack: "Kotlin" })) as {
      recommended: string; rationale: string[]; decision: string;
    };
    expect(r.decision).toBe("user");
    expect(r.rationale.length).toBeGreaterThan(0);
  });

  test("자동 시작 등록은 말이 안 되는 간격을 거부한다", async () => {
    // 실제 등록 경로는 시스템 스케줄러를 건드리므로 여기서 부르지 않는다 —
    // 러너를 주입해 검증하는 쪽은 install.test.ts 다. 여기서는 그 앞의 인자 검증만 본다.
    await expect(HANDLERS["watchdog_install"]!({ interval_minutes: 0 })).rejects.toThrow(ToolError);
    await expect(HANDLERS["watchdog_install"]!({ interval_minutes: 5000 })).rejects.toThrow(ToolError);
  });

  test("watchdog_status 는 실행 흔적이 없으면 경고한다", async () => {
    const r = (await HANDLERS["watchdog_status"]!({})) as { warnings: string[]; last_tick: string | null };
    expect(r.last_tick).toBeNull();
    expect(r.warnings.join(" ")).toContain("한 번도");
  });
});

describe("레지스트리 무결성", () => {
  test("파손된 레지스트리는 덮지 않고 대피시킨 뒤 멈춘다", async () => {
    await mkdir(userPaths(env).runtimeDir, { recursive: true });
    await writeFile(userPaths(env).registry, "{ 깨진 JSON", "utf8");
    const checked = await loadRegistryChecked(env);
    expect(checked.state).toBe("corrupt");
    await expect(loadRegistryForWrite(env)).rejects.toThrow(/파손/);
    // 원본이 대피본으로 남아야 한다 — 손실 없이 멈춘 것이다
    const files = await Bun.$`ls ${userPaths(env).runtimeDir}`.text().catch(() => "");
    expect(files).toContain("registry.json.corrupt-");
  });

  test("갱신은 저장 직전 재읽기로 병합한다 — 통째 되쓰기로 남의 변경을 지우지 않는다", async () => {
    await mkdir(userPaths(env).runtimeDir, { recursive: true });
    const base = defaultRegistry();
    upsertProject(base, { id: "a", repo: dir, model: "claude-opus-5", permissionArgs: [] });
    await saveRegistry(base, env);

    // 오래된 사본을 든 채로 다른 주체가 새 프로젝트를 넣는다
    const stale = (await loadRegistryChecked(env)).registry;
    const other = join(dir, "other");
    await mutateRegistry(
      (reg) => upsertProject(reg, { id: "b", repo: other, model: "claude-opus-5", permissionArgs: [] }),
      env,
    );
    // 오래된 사본 기준으로 mutate 해도 b 가 살아 있어야 한다
    expect(stale.projects.length).toBe(1);
    await mutateRegistry((reg) => {
      findProject(reg, dir)!.model = "claude-fable-5";
    }, env);

    const final = (await loadRegistryChecked(env)).registry;
    expect(final.projects.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(findProject(final, dir)!.model).toBe("claude-fable-5");
  });

  test("completed 는 종점이 아니다 — 작업이 생기면 되살린다", async () => {
    const reg = defaultRegistry();
    const entry = upsertProject(reg, { id: "a", repo: dir, model: "claude-opus-5", permissionArgs: [] });
    entry.status = "completed";
    expect(reactivateIfCompleted(reg, dir)).toBe(true);
    expect(String(entry.status)).toBe("active"); // String() — 대입 직후 좁혀진 리터럴 타입을 푼다
  });

  test("paused·needs_human·error 는 자동으로 풀지 않는다", async () => {
    for (const status of ["paused", "needs_human", "error"] as const) {
      const reg = defaultRegistry();
      const entry = upsertProject(reg, { id: "a", repo: dir, model: "claude-opus-5", permissionArgs: [] });
      entry.status = status;
      expect(reactivateIfCompleted(reg, dir), status).toBe(false);
      expect(String(entry.status), status).toBe(status);
    }
  });

  test("task_add 는 completed 프로젝트를 되살린다 (CLI·MCP 비대칭 제거)", async () => {
    await initTracker();
    await mutateRegistry((reg) => {
      upsertProject(reg, { id: "p", repo: dir, model: "claude-opus-5", permissionArgs: [] }).status =
        "completed";
    }, env);
    const r = (await HANDLERS["task_add"]!({ repo_path: dir, id: "t9", title: "새 작업" })) as {
      reactivated: boolean | string;
    };
    expect(r.reactivated).toBe(true);
    expect(findProject((await loadRegistryChecked(env)).registry, dir)!.status).toBe("active");
  });

  test("레지스트리 파손이 작업 추가를 실패시키지는 않는다", async () => {
    await initTracker();
    await mkdir(userPaths(env).runtimeDir, { recursive: true });
    await writeFile(userPaths(env).registry, "{ 깨진", "utf8");
    const r = (await HANDLERS["task_add"]!({ repo_path: dir, id: "t9", title: "새 작업" })) as {
      ok: boolean; reactivated: boolean | string;
    };
    expect(r.ok).toBe(true); // 장부는 갱신됐다
    expect(typeof r.reactivated).toBe("string"); // 다만 사유를 밝힌다 — 조용히 넘기지 않는다
    expect(findTask((await loadTracker(dir)).tracker!, "t9")).toBeDefined();
  });
});

describe("데몬 위임과 폴백", () => {
  async function writeDaemonInfo(port: number, token = "tok"): Promise<void> {
    await mkdir(userPaths(env).runtimeDir, { recursive: true });
    await writeFile(userPaths(env).daemonInfo, JSON.stringify({ port, token }), "utf8");
  }

  test("접속 정보가 없으면 위임하지 않는다", async () => {
    expect(await readDaemonInfo(env)).toBeNull();
    const r = await tryDelegate("heartbeat", { repo_path: dir }, env);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("접속 정보 없음");
  });

  test("데몬이 죽어 있어도 도구는 인프로세스로 동작한다", async () => {
    await writeDaemonInfo(1); // 아무도 듣지 않는 포트
    const live = { ...env, AUTOHARNESS_NO_DELEGATE: undefined } as NodeJS.ProcessEnv;
    delete live["AUTOHARNESS_NO_DELEGATE"];
    await callToolWithFallback("heartbeat", { repo_path: dir }, live);
    expect(await Bun.file(repoPaths(dir).heartbeat).exists()).toBe(true);
  });

  test("데몬이 살아 있으면 그 결과를 쓰고, 인프로세스와 같은 모양이다", async () => {
    let received: unknown = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        received = await req.json();
        return Response.json({ ok: true, result: { ok: true, via: "daemon" } });
      },
    });
    try {
      await writeDaemonInfo(server.port!);
      const live = { ...env } as NodeJS.ProcessEnv;
      delete live["AUTOHARNESS_NO_DELEGATE"];
      const r = (await callToolWithFallback("heartbeat", { repo_path: dir }, live)) as {
        ok: boolean; via?: string;
      };
      expect(r.via).toBe("daemon");
      expect(received).toEqual({ name: "heartbeat", arguments: { repo_path: dir } });
      // 위임됐으므로 이 프로세스는 하트비트를 쓰지 않았다 — 두 경로가 겹쳐 실행되지 않는다
      expect(await Bun.file(repoPaths(dir).heartbeat).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("데몬이 오류를 돌려주면 폴백으로 덮지 않는다", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: false, error: "데몬이 거부함" }),
    });
    try {
      await writeDaemonInfo(server.port!);
      const live = { ...env } as NodeJS.ProcessEnv;
      delete live["AUTOHARNESS_NO_DELEGATE"];
      await expect(callToolWithFallback("heartbeat", { repo_path: dir }, live)).rejects.toThrow(
        /데몬이 거부함/,
      );
    } finally {
      server.stop(true);
    }
  });

  test("응답 모양이 다르면 폴백한다 — 조용히 다른 값을 쓰지 않는다", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ 예상밖: true }),
    });
    try {
      await writeDaemonInfo(server.port!);
      const live = { ...env } as NodeJS.ProcessEnv;
      delete live["AUTOHARNESS_NO_DELEGATE"];
      const r = (await callToolWithFallback("heartbeat", { repo_path: dir }, live)) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(await Bun.file(repoPaths(dir).heartbeat).exists()).toBe(true); // 인프로세스가 처리했다
    } finally {
      server.stop(true);
    }
  });

  test("알 수 없는 도구는 위임 이전에 걸러낸다", async () => {
    await expect(callToolWithFallback("없는도구", {}, env)).rejects.toThrow(ToolError);
  });
});

/**
 * 진짜 계약은 프로세스 경계에 있다 — handleLine 이 맞아도 stdio 프레이밍이 틀리면
 * 클라이언트는 아무것도 못 받는다. v1 test_mcp_protocol.py 와 같은 자리를 덮는다.
 */
describe("stdio 왕복 (서브프로세스)", () => {
  async function roundTrip(lines: string[]): Promise<Record<string, unknown>[]> {
    const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "main.ts"), "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, AUTOHARNESS_HOME: home, AUTOHARNESS_NO_DELEGATE: "1" },
    });
    proc.stdin.write(`${lines.join("\n")}\n`);
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test("잡음 섞인 스트림에서도 요청마다 정확히 한 번 응답한다", async () => {
    const responses = await roundTrip([
      rpc("initialize", {}, 1),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), // 무응답
      "이건 JSON 이 아니다", // 무시
      rpc("tools/list", undefined, 2),
      rpc("없는메서드", undefined, 3),
      rpc("tools/call", { name: "model_recommend", arguments: {} }, 4),
    ]);
    expect(responses.map((r) => r["id"])).toEqual([1, 2, 3, 4]);
    expect((responses[1]!["result"] as { tools: unknown[] }).tools.length).toBe(14);
    expect((responses[2]!["error"] as { code: number }).code).toBe(METHOD_NOT_FOUND);
    const payload = JSON.parse(
      (responses[3]!["result"] as { content: { text: string }[] }).content[0]!.text,
    ) as { decision: string };
    expect(payload.decision).toBe("user");
  }, 30_000);

  test("stdin 이 닫히면 서버가 정상 종료한다", async () => {
    const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "main.ts"), "mcp"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { ...process.env, AUTOHARNESS_HOME: home },
    });
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }, 30_000);
});

describe("설치본·사용자 상태 격리", () => {
  test("테스트가 실제 홈이 아니라 격리 경로를 쓴다", () => {
    expect(userPaths(env).registry.startsWith(home)).toBe(true);
  });

  test("harness_init 이 만든 훅은 저장소와 실행 파일을 둘 다 못 박는다", async () => {
    await HANDLERS["harness_init"]!({
      repo_path: dir, project: "p", objective: "o",
      source_stack: "A", target_stack: "B", test_cmd: "exit 0",
    });
    const settings = JSON.parse(
      await readFile(join(repoPaths(dir).claudeDir, "settings.json"), "utf8"),
    ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          expect(h.command).toContain("--repo");
          expect(h.command).toContain("${CLAUDE_PROJECT_DIR}");
        }
      }
    }
    expect(settings.hooks["PreToolUse"]![0]!.matcher).toBe("Bash|PowerShell");
  });
});
