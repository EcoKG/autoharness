/**
 * 웹 API 회귀 — **보안 성질이 1급 검증 대상이다**(daemon/DESIGN.md 6.3·8절).
 *
 * 이 서버는 프로젝트를 멈추고 세션을 기동한다. 즉 명령 표면이므로, 기능이 되는지보다
 * 다음이 무너지지 않는지가 먼저다:
 *   ① 토큰 없으면 401, 틀리면 401 ② loopback 바인드 ③ 상태 변경은 POST 만
 *   ④ 쿠키로는 인증되지 않는다(CSRF) ⑤ Host 검사(DNS 리바인딩) ⑥ 화이트리스트 밖은 404
 *   ⑦ 임의 셸 실행 경로가 없다
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTracker, loadTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths, userPaths } from "../src/core/paths.ts";
import { defaultRegistry, mutateRegistry, saveRegistry, upsertProject } from "../src/core/registry.ts";
import { ConsoleLog } from "../src/daemon/log.ts";
import { BIND_HOST, createWebServer, hostAllowed, type WebServerHandle } from "../src/web/server.ts";
import { bearerToken, generateToken, tokenMatches } from "../src/web/token.ts";

let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};
let log: ConsoleLog;
let server: WebServerHandle;
let base = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-web-"));
  repo = await mkdtemp(join(tmpdir(), "ah-webrepo-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
  await mkdir(repoPaths(repo).claudeDir, { recursive: true });

  const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  t.tasks = [newTask("t1", "작업"), newTask("t2", "다음 작업")];
  await saveTracker(repo, t);
  await saveRegistry(defaultRegistry(), env);
  await mutateRegistry(
    (reg) => upsertProject(reg, { id: "proj", repo, model: "claude-opus-5", permissionArgs: [] }),
    env,
  );

  log = new ConsoleLog({ path: join(home, "d.log"), toStdout: false });
  server = await createWebServer({ log, env, requestTick: async () => ({ ticked: true }) }, 0);
  base = `http://${BIND_HOST}:${server.port}`;
});
afterEach(async () => {
  await server.stop();
  await log.close();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${server.token}`, ...extra };
}

describe("인증", () => {
  test("토큰이 없으면 401", async () => {
    const r = await fetch(`${base}/api/status`);
    expect(r.status).toBe(401);
  });

  test("틀린 토큰은 401", async () => {
    const r = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer wrong-token-value" } });
    expect(r.status).toBe(401);
  });

  test("쿠키로는 인증되지 않는다 — CSRF 재료를 만들지 않는다", async () => {
    const r = await fetch(`${base}/api/status`, { headers: { cookie: `token=${server.token}` } });
    expect(r.status).toBe(401);
  });

  test("Bearer 접두어가 없으면 401", async () => {
    const r = await fetch(`${base}/api/status`, { headers: { authorization: server.token } });
    expect(r.status).toBe(401);
  });

  test("올바른 토큰이면 통과한다", async () => {
    const r = await fetch(`${base}/api/status`, { headers: auth() });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("토큰은 파일에 저장되고 충분히 길다", async () => {
    const saved = (await readFile(userPaths(env).webToken, "utf8")).trim();
    expect(saved).toBe(server.token);
    expect(saved.length).toBeGreaterThanOrEqual(32);
  });

  test("토큰 비교는 길이가 달라도 던지지 않는다", () => {
    expect(tokenMatches("abcd", "abcd")).toBe(true);
    expect(tokenMatches("abcd", "ab")).toBe(false);
    expect(tokenMatches("abcd", null)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });

  test("생성 토큰은 매번 다르다", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  test("Authorization 파싱", () => {
    expect(bearerToken(new Headers({ authorization: "Bearer xyz" }))).toBe("xyz");
    expect(bearerToken(new Headers({ authorization: "bearer  xyz " }))).toBe("xyz");
    expect(bearerToken(new Headers({ authorization: "Basic xyz" }))).toBeNull();
    expect(bearerToken(new Headers())).toBeNull();
  });
});

describe("바인드와 Host", () => {
  test("loopback 에만 바인드한다", () => {
    expect(BIND_HOST).toBe("127.0.0.1");
  });

  test("낯선 Host 는 거부한다 — DNS 리바인딩 차단", async () => {
    const r = await fetch(`${base}/api/status`, {
      headers: auth({ host: "evil.example.com" }),
    });
    expect(r.status).toBe(403);
  });

  test("Host 판정 경계", () => {
    expect(hostAllowed("127.0.0.1:8080")).toBe(true);
    expect(hostAllowed("localhost:1")).toBe(true);
    expect(hostAllowed("LOCALHOST")).toBe(true);
    expect(hostAllowed("192.168.0.5:8080")).toBe(false);
    expect(hostAllowed("attacker.test")).toBe(false);
    expect(hostAllowed(null)).toBe(false);
  });

  test("접속 정보 파일에 포트와 토큰을 남긴다 — MCP 위임의 발견 수단", async () => {
    const info = JSON.parse(await readFile(userPaths(env).daemonInfo, "utf8")) as {
      port: number; token: string; pid: number;
    };
    expect(info.port).toBe(server.port);
    expect(info.token).toBe(server.token);
    expect(info.pid).toBe(process.pid);
  });
});

describe("조회", () => {
  test("GET /api/status", async () => {
    const r = await (await fetch(`${base}/api/status`, { headers: auth() })).json() as {
      projects: { id: string; counts: { pending: number } }[];
    };
    expect(r.projects.length).toBe(1);
    expect(r.projects[0]!.id).toBe("proj");
    expect(r.projects[0]!.counts.pending).toBe(2);
  });

  test("GET /api/projects/:id/tasks", async () => {
    const r = await fetch(`${base}/api/projects/proj/tasks`, { headers: auth() });
    const body = (await r.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("없는 프로젝트는 404", async () => {
    const r = await fetch(`${base}/api/projects/없음/tasks`, { headers: auth() });
    expect(r.status).toBe(404);
  });

  test("GET /api/logs", async () => {
    log.info("proj", "tick", "기록 하나");
    const r = await fetch(`${base}/api/logs?limit=10`, { headers: auth() });
    const body = (await r.json()) as { lines: { detail: string }[] };
    expect(body.lines.some((l) => l.detail === "기록 하나")).toBe(true);
  });

  test("없는 경로는 404", async () => {
    const r = await fetch(`${base}/api/없는것`, { headers: auth() });
    expect(r.status).toBe(404);
  });
});

describe("상태 변경 — POST 만, 화이트리스트만", () => {
  test("GET 으로는 부작용을 낼 수 없다", async () => {
    const r = await fetch(`${base}/api/projects/proj/pause`, { headers: auth() });
    expect(r.status).toBe(404); // GET 라우팅에 없다
    expect(await Bun.file(repoPaths(repo).pausedFlag).exists()).toBe(false);
  });

  test("PUT·DELETE 는 405", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await fetch(`${base}/api/projects/proj/pause`, { method, headers: auth() });
      expect(r.status, method).toBe(405);
    }
  });

  test("pause/resume 이 플래그와 레지스트리를 함께 움직인다", async () => {
    const p = await fetch(`${base}/api/projects/proj/pause`, { method: "POST", headers: auth() });
    expect(p.status).toBe(200);
    expect(await Bun.file(repoPaths(repo).pausedFlag).exists()).toBe(true);

    const r = await fetch(`${base}/api/projects/proj/resume`, { method: "POST", headers: auth() });
    expect(r.status).toBe(200);
    expect(await Bun.file(repoPaths(repo).pausedFlag).exists()).toBe(false);
  });

  test("화이트리스트 밖의 동작은 404 — 임의 실행 경로가 없다", async () => {
    for (const action of ["exec", "shell", "run", "delete", "eval"]) {
      const r = await fetch(`${base}/api/projects/proj/${action}`, { method: "POST", headers: auth() });
      expect(r.status, action).toBe(404);
    }
  });

  test("tick 은 데몬이 제공할 때만 동작한다", async () => {
    const r = await fetch(`${base}/api/projects/proj/tick`, { method: "POST", headers: auth() });
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toMatchObject({ ok: true, result: { ticked: true } });
  });

  test("기동을 제공하지 않는 데몬은 501 — 되는 척하지 않는다", async () => {
    const r = await fetch(`${base}/api/projects/proj/launch`, { method: "POST", headers: auth() });
    expect(r.status).toBe(501);
  });

  test("작업 상태는 pending/blocked 만 허용한다 — done 을 웹에서 만들 수 없다", async () => {
    const done = await fetch(`${base}/api/tasks/t1/state`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ project: "proj", status: "done" }),
    });
    expect(done.status).toBe(400);

    const blocked = await fetch(`${base}/api/tasks/t1/state`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ project: "proj", status: "blocked", note: "사람 판단 필요" }),
    });
    expect(blocked.status).toBe(200);
    const { tracker } = await loadTracker(repo);
    const task = tracker!.tasks.find((t) => t.id === "t1")!;
    expect(task.status).toBe("blocked");
    expect(task.last_error).toBe("사람 판단 필요");
  });

  test("없는 작업·프로젝트는 404", async () => {
    const r1 = await fetch(`${base}/api/tasks/없음/state`, {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ project: "proj", status: "blocked" }),
    });
    expect(r1.status).toBe(404);
    const r2 = await fetch(`${base}/api/tasks/t1/state`, {
      method: "POST", headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ project: "없음", status: "blocked" }),
    });
    expect(r2.status).toBe(404);
  });
});

describe("MCP 위임 엔드포인트", () => {
  test("도구를 대신 실행하고 같은 모양으로 돌려준다", async () => {
    const r = await fetch(`${base}/api/mcp/call`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "heartbeat", arguments: { repo_path: repo } }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toMatchObject({ ok: true, result: { ok: true } });
    expect(await Bun.file(repoPaths(repo).heartbeat).exists()).toBe(true);
  });

  test("알 수 없는 도구는 404 — 이름 화이트리스트 밖은 존재하지 않는다", async () => {
    const r = await fetch(`${base}/api/mcp/call`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "rm -rf /", arguments: {} }),
    });
    expect(r.status).toBe(404);
  });

  test("도구 오류는 ok:false 로 전달한다", async () => {
    const r = await fetch(`${base}/api/mcp/call`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "harness_status", arguments: {} }),
    });
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("repo_path");
  });

  test("토큰 없이는 위임도 불가능하다", async () => {
    const r = await fetch(`${base}/api/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "heartbeat", arguments: { repo_path: repo } }),
    });
    expect(r.status).toBe(401);
  });
});

describe("응답 위생", () => {
  test("CORS 를 열지 않는다 — 다른 출처가 응답을 읽지 못한다", async () => {
    const r = await fetch(`${base}/api/status`, { headers: auth({ origin: "https://evil.test" }) });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("캐시하지 않고 스니핑을 막는다", async () => {
    const r = await fetch(`${base}/api/status`, { headers: auth() });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

/**
 * **위임은 권한 확장이 아니다** — 적대 검증에서 확인된 구멍을 막는다.
 *
 * 파일 머리말이 "임의 셸 실행을 노출하지 않는다" 고 못 박고 프로젝트 동작을 4가지
 * 화이트리스트로 좁혀 놓았는데, 정작 /api/mcp/call 이 도구 전체를 노출했다. 그중
 * harness_run 은 cmd 인자가 셸로 직행하므로 토큰 하나가 곧 원격 코드 실행 키였다.
 */
describe("위임 표면 — 임의 셸 실행 차단", () => {
  const auth2 = () => ({
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  });

  async function call(name: string, args: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${server.port}/api/mcp/call`, {
      method: "POST",
      headers: auth2(),
      body: JSON.stringify({ name, arguments: args }),
    });
  }

  test("harness_run 은 위임으로 노출되지 않는다 — cmd 가 셸로 간다", async () => {
    const r = await call("harness_run", { repo_path: repo, cmd: "echo 침투" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("노출하지 않습니다");
  });

  test("cmd 없이도 harness_run 은 막힌다 — 도구 자체가 표면 밖이다", async () => {
    expect((await call("harness_run", { repo_path: repo })).status).toBe(403);
  });

  test("설치·시스템 변경 도구도 표면 밖이다", async () => {
    for (const name of ["harness_init", "watchdog_install", "watchdog_uninstall"]) {
      expect((await call(name, {})).status, name).toBe(403);
    }
  });

  test("허용 도구는 그대로 동작한다 — 기능을 줄이지 않았다", async () => {
    const r = await call("heartbeat", { repo_path: repo });
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toMatchObject({ ok: true });
  });

  test("허용 도구라도 셸로 가는 인자는 거부한다 — 두 번째 방어선", async () => {
    const r = await call("harness_status", { repo_path: repo, cmd: "echo 침투" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("허용되지 않는 인자");
  });

  test("표면 정의가 위험한 도구를 담고 있지 않다", async () => {
    const { DELEGATABLE_TOOLS } = await import("../src/mcp/tools.ts");
    for (const dangerous of ["harness_run", "harness_init", "watchdog_install", "watchdog_uninstall"]) {
      expect(DELEGATABLE_TOOLS.has(dangerous), dangerous).toBe(false);
    }
    expect(DELEGATABLE_TOOLS.size).toBeGreaterThan(5); // 쓸모없이 좁히지도 않았다
  });
});
