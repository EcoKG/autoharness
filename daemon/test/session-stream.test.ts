/**
 * 세션 출력 스트리밍 회귀 — **웹 콘솔이 보여야 할 것은 데몬 판단이 아니라 세션이다.**
 *
 * 사용자 요청으로 드러난 공백: 지금까지 /ws/console 로 흐른 것은 데몬 자신의 판단
 * (tick·skip·launch)뿐이었고, 정작 보고 싶은 것 — 데몬이 띄운 헤드리스 Claude Code 세션이
 * 지금 무엇을 하는지 — 는 로그 파일로만 들어가 아무 데도 스트림되지 않았다. 즉 웹에서는
 * "기동했다" 만 보이고 그 뒤가 보이지 않았다.
 *
 * 여기서 고정하는 계약:
 *   ① 세션의 stdout·stderr 가 줄 단위로 흘러나온다
 *   ② 파일에도 그대로 남는다 — 스트림이 파일을 대체하지 않는다
 *   ③ 프로브 이후에도 끝까지 읽는다(분리 = 기다리지 않는다는 뜻이지 버린다는 뜻이 아니다)
 *   ④ 긴 줄은 잘라 화면·스트림을 통째로 먹지 않게 한다
 *   ⑤ 세션 로그 조회 경로는 **경로 순회를 차단한다**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths, userPaths } from "../src/core/paths.ts";
import { defaultRegistry, mutateRegistry, saveRegistry, upsertProject } from "../src/core/registry.ts";
import { runTick } from "../src/daemon/daemon.ts";
import { ConsoleLog, type LogRecord } from "../src/daemon/log.ts";
import {
  SESSION_LINE_CAP,
  capLine,
  launchProject,
  realLauncher,
  type LaunchSpec,
} from "../src/daemon/supervisor.ts";
import { BIND_HOST, createWebServer, isSessionLogName, type WebServerHandle } from "../src/web/server.ts";

let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};
let log: ConsoleLog;
let captured: LogRecord[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-ss-"));
  repo = await mkdtemp(join(tmpdir(), "ah-ssrepo-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).logs, { recursive: true });
  await mkdir(repoPaths(repo).claudeDir, { recursive: true });
  captured = [];
  log = new ConsoleLog({ path: join(home, "d.log"), toStdout: false });
  log.subscribe((r) => void captured.push(r));
});
afterEach(async () => {
  await log.close();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

function project(id = "proj") {
  return {
    id, repo, model: "claude-opus-5", permission_args: [] as string[],
    status: "active" as const, consecutive_errors: 0, limit_hits: 0, next_retry_at: null,
    last_launch: { ts: null, result: null, log: null },
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

/** 실제 자식 프로세스를 띄워 출력을 흘리는지 본다 — 가짜 런처로는 배선을 증명할 수 없다. */
function echoScript(lines: readonly string[]): string[] {
  const body = lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n");
  return [process.execPath, "-e", body];
}

describe("세션 출력이 흘러나온다", () => {
  test("자식이 뱉은 줄이 콜백으로 전달된다", async () => {
    const seen: string[] = [];
    const spec: LaunchSpec = {
      argv: echoScript(["첫 줄", "둘째 줄", "셋째 줄"]),
      cwd: repo,
      env: { ...process.env } as Record<string, string>,
      logPath: join(userPaths(env).logs, "proj-20260810T000000Z.log"),
      onLine: (line) => void seen.push(line),
    };
    const handle = await realLauncher()(spec);
    await handle.probe(20);
    await Bun.sleep(300); // 펌프가 남은 줄을 마저 읽는다
    expect(seen).toContain("첫 줄");
    expect(seen).toContain("셋째 줄");
  }, 30_000);

  test("파일에도 그대로 남는다 — 스트림이 파일을 대체하지 않는다", async () => {
    const logPath = join(userPaths(env).logs, "proj-20260810T000001Z.log");
    const handle = await realLauncher()({
      argv: echoScript(["파일에도 남아야 한다"]),
      cwd: repo,
      env: { ...process.env } as Record<string, string>,
      logPath,
      onLine: () => {},
    });
    await handle.probe(20);
    await Bun.sleep(300);
    expect(await readFile(logPath, "utf8")).toContain("파일에도 남아야 한다");
  }, 30_000);

  test("stderr 도 함께 흘린다 — 오류만 안 보이면 진단이 안 된다", async () => {
    const seen: string[] = [];
    const handle = await realLauncher()({
      argv: [process.execPath, "-e", 'console.error("표준 오류 줄");'],
      cwd: repo,
      env: { ...process.env } as Record<string, string>,
      logPath: join(userPaths(env).logs, "proj-20260810T000002Z.log"),
      onLine: (line) => void seen.push(line),
    });
    await handle.probe(20);
    await Bun.sleep(300);
    expect(seen.join("\n")).toContain("표준 오류 줄");
  }, 30_000);

  test("프로브가 끝난 뒤 나온 줄도 놓치지 않는다", async () => {
    // 분리는 '기다리지 않는다' 는 뜻이지 '버린다' 는 뜻이 아니다.
    const seen: string[] = [];
    const handle = await realLauncher()({
      argv: [process.execPath, "-e",
             'console.log("프로브 중"); setTimeout(() => console.log("프로브 이후"), 400);'],
      cwd: repo,
      env: { ...process.env } as Record<string, string>,
      logPath: join(userPaths(env).logs, "proj-20260810T000003Z.log"),
      onLine: (line) => void seen.push(line),
    });
    await handle.probe(1); // 1초만 보고 분리한다
    await Bun.sleep(900);
    expect(seen).toContain("프로브 중");
    expect(seen).toContain("프로브 이후");
  }, 30_000);

  test("아무도 안 보면 파이프를 만들지 않는다 — 파일 경로는 그대로 동작한다", async () => {
    const logPath = join(userPaths(env).logs, "proj-20260810T000004Z.log");
    const handle = await realLauncher()({
      argv: echoScript(["파이프 없이"]),
      cwd: repo,
      env: { ...process.env } as Record<string, string>,
      logPath,
      // onLine 없음
    });
    await handle.probe(20);
    expect(await readFile(logPath, "utf8")).toContain("파이프 없이");
  }, 30_000);
});

describe("긴 줄 자르기", () => {
  test("상한을 넘으면 자르고 생략을 알린다", () => {
    const long = "가".repeat(SESSION_LINE_CAP + 500);
    const capped = capLine(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain("생략");
  });

  test("짧은 줄은 건드리지 않는다", () => {
    expect(capLine("짧다")).toBe("짧다");
  });

  test("기동 경로가 자름을 적용한다", async () => {
    const seen: string[] = [];
    await launchProject(project(), newTask("t1", "작업"), {
      env,
      launcher: async (spec) => {
        spec.onLine?.("나".repeat(SESSION_LINE_CAP + 100));
        return { pid: 1, probe: async () => null, readLogTail: async () => "" };
      },
      onLine: (line) => void seen.push(line),
    });
    expect(seen[0]!.length).toBeLessThan(SESSION_LINE_CAP + 100);
    expect(seen[0]).toContain("생략");
  });
});

describe("데몬이 세션 줄을 콘솔에 싣는다", () => {
  test("action=session 으로 프로젝트와 함께 기록된다", async () => {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    t.tasks = [newTask("t1", "작업")];
    await saveTracker(repo, t);
    await saveRegistry(defaultRegistry(), env);
    await mutateRegistry(
      (reg) => upsertProject(reg, { id: "proj", repo, model: "claude-opus-5", permissionArgs: [] }),
      env,
    );

    await runTick({
      env, log,
      launcher: async (spec) => {
        spec.onLine?.("세션이 말하는 줄");
        return { pid: 7, probe: async () => null, readLogTail: async () => "" };
      },
    });

    const session = captured.filter((r) => r.action === "session");
    expect(session.length).toBe(1);
    expect(session[0]!.project).toBe("proj");
    expect(session[0]!.detail).toBe("세션이 말하는 줄");
    // 데몬 판단 줄도 여전히 흐른다 — 둘 다 보여야 한다
    expect(captured.some((r) => r.action === "ok")).toBe(true);
  });
});

describe("세션 로그 조회 — 경로 순회 차단", () => {
  let server: WebServerHandle;
  let base = "";

  beforeEach(async () => {
    await saveRegistry(defaultRegistry(), env);
    await mutateRegistry(
      (reg) => upsertProject(reg, { id: "proj", repo, model: "claude-opus-5", permissionArgs: [] }),
      env,
    );
    await writeFile(join(userPaths(env).logs, "proj-20260810T010203Z.log"), "세션 본문", "utf8");
    await writeFile(join(userPaths(env).logs, "other-20260810T010203Z.log"), "남의 것", "utf8");
    await writeFile(join(home, "비밀.txt"), "새면 안 되는 내용", "utf8");
    server = await createWebServer({ log, env }, 0);
    base = `http://${BIND_HOST}:${server.port}`;
  });
  afterEach(async () => {
    await server.stop();
  });

  const auth = () => ({ authorization: `Bearer ${server.token}` });

  test("이름 검증이 우리 형식만 통과시킨다", () => {
    expect(isSessionLogName("proj-20260810T010203Z.log", "proj")).toBe(true);
    expect(isSessionLogName("proj-2026.log", "proj")).toBe(false);
    expect(isSessionLogName("other-20260810T010203Z.log", "proj")).toBe(false);
    expect(isSessionLogName("../../비밀.txt", "proj")).toBe(false);
    expect(isSessionLogName("proj-20260810T010203Z.log.exe", "proj")).toBe(false);
    expect(isSessionLogName("..", "proj")).toBe(false);
  });

  test("세션 목록을 돌려준다", async () => {
    const r = await fetch(`${base}/api/projects/proj/sessions`, { headers: auth() });
    const body = (await r.json()) as { sessions: { name: string; size: number }[] };
    expect(body.sessions.map((s) => s.name)).toEqual(["proj-20260810T010203Z.log"]);
    expect(body.sessions[0]!.size).toBeGreaterThan(0);
  });

  test("본문을 읽을 수 있다", async () => {
    const r = await fetch(`${base}/api/projects/proj/sessions/proj-20260810T010203Z.log`, {
      headers: auth(),
    });
    expect(((await r.json()) as { body: string }).body).toContain("세션 본문");
  });

  test("경로 순회를 차단한다", async () => {
    for (const name of ["..%2F..%2F비밀.txt", "%2E%2E%2F비밀.txt", "other-20260810T010203Z.log"]) {
      const r = await fetch(`${base}/api/projects/proj/sessions/${name}`, { headers: auth() });
      expect([400, 404], name).toContain(r.status);
      const text = await r.text();
      expect(text).not.toContain("새면 안 되는 내용");
      expect(text).not.toContain("남의 것");
    }
  });

  test("토큰 없이는 세션 로그를 볼 수 없다", async () => {
    expect((await fetch(`${base}/api/projects/proj/sessions`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/projects/proj/sessions/proj-20260810T010203Z.log`)).status,
    ).toBe(401);
  });
});

describe("UI 가 세션과 데몬 판단을 구분한다", () => {
  test("필터와 구분 표시가 있다", async () => {
    const { UI_HTML } = await import("../src/web/ui.ts");
    expect(UI_HTML).toContain('value="session"');
    expect(UI_HTML).toContain('value="daemon"');
    expect(UI_HTML).toContain("세션 출력만");
    expect(UI_HTML).toContain('record.action === "session"');
    expect(UI_HTML).toContain("Claude Code 세션의 출력");
  });
});
