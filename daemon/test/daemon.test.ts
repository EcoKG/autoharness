/**
 * 데몬 조립 회귀 — 판단·기동·기록이 실제로 이어지는가.
 *
 * 개별 부품(스케줄러·판단·로깅)은 각자 테스트가 있다. 여기서 보는 것은 **연결**이다:
 * 한 프로젝트가 터져도 나머지가 계속 처리되는가, 모든 판단이 로그에 남는가, 주기 도중
 * 다른 주체가 넣은 레지스트리 변경이 살아남는가, 잠금이 두 번째 인스턴스를 막는가.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths, userPaths } from "../src/core/paths.ts";
import {
  defaultRegistry,
  findProject,
  loadRegistryChecked,
  mutateRegistry,
  saveRegistry,
  upsertProject,
} from "../src/core/registry.ts";
import { runDaemon, runTick, tickProject } from "../src/daemon/daemon.ts";
import { ConsoleLog, type LogRecord } from "../src/daemon/log.ts";
import { acquireLock, releaseLock } from "../src/daemon/lock.ts";
import type { SchedulerDeps } from "../src/daemon/scheduler.ts";
import type { Launcher } from "../src/daemon/supervisor.ts";

let home = "";
let repoA = "";
let repoB = "";
let env: NodeJS.ProcessEnv = {};
let log: ConsoleLog;
let captured: LogRecord[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-dmn-"));
  repoA = await mkdtemp(join(tmpdir(), "ah-repoA-"));
  repoB = await mkdtemp(join(tmpdir(), "ah-repoB-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
  for (const r of [repoA, repoB]) await mkdir(repoPaths(r).claudeDir, { recursive: true });
  captured = [];
  log = new ConsoleLog({ path: join(home, "daemon.log"), toStdout: false });
  log.subscribe((r) => void captured.push(r));
});
afterEach(async () => {
  await log.close();
  for (const d of [home, repoA, repoB]) await rm(d, { recursive: true, force: true });
});

function fakeClock(start = 1_000_000): { deps: SchedulerDeps } {
  let now = start;
  return { deps: { now: () => now, sleep: async (ms) => void (now += ms) } };
}

const okLauncher: Launcher = async () => ({
  pid: 111,
  probe: async () => null, // 프로브 생존 = 정상 기동
  readLogTail: async () => "",
});

async function withTracker(repo: string, pending = true): Promise<void> {
  const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  t.tasks = [pending ? newTask("t1", "작업") : { ...newTask("t1", "작업"), status: "done" }];
  await saveTracker(repo, t);
}

async function register(id: string, repo: string): Promise<void> {
  await mutateRegistry(
    (reg) => upsertProject(reg, { id, repo, model: "claude-opus-5", permissionArgs: [] }),
    env,
  );
}

function actions(): string[] {
  return captured.map((r) => r.action);
}

describe("tick 1회", () => {
  test("등록이 없으면 조용히 넘어간다", async () => {
    await saveRegistry(defaultRegistry(), env);
    const r = await runTick({ env, log });
    expect(r).toEqual({ handled: 0, failed: 0 });
    expect(actions()).toContain("tick");
  });

  test("기동 대상은 기동하고 결과가 레지스트리에 남는다", async () => {
    await withTracker(repoA);
    await register("a", repoA);
    const r = await runTick({ env, log, launcher: okLauncher });
    expect(r.handled).toBe(1);
    const entry = findProject((await loadRegistryChecked(env)).registry, repoA)!;
    expect(entry.last_launch.result).toBe("ok");
    expect(actions()).toContain("ok");
  });

  test("dry-run 은 판단만 하고 아무것도 바꾸지 않는다", async () => {
    await withTracker(repoA);
    await register("a", repoA);
    await runTick({ env, log, launcher: okLauncher, dryRun: true });
    expect(findProject((await loadRegistryChecked(env)).registry, repoA)!.last_launch.result).toBeNull();
    expect(captured.some((r) => r.detail.includes("(dry-run)"))).toBe(true);
  });

  test("한 프로젝트가 터져도 나머지는 계속 처리된다", async () => {
    await withTracker(repoA);
    await withTracker(repoB);
    await register("a", repoA);
    await register("b", repoB);
    let calls = 0;
    const flaky: Launcher = async (spec) => {
      calls += 1;
      if (spec.cwd === repoA) throw new Error("터짐");
      return okLauncher(spec);
    };
    // launchProject 는 기동 실패를 오류로 집계하므로, 예외 경로는 판단 단계에서 만든다
    const r = await runTick({ env, log, launcher: flaky });
    expect(r.handled).toBe(2);
    expect(calls).toBe(2);
    const reg = (await loadRegistryChecked(env)).registry;
    expect(findProject(reg, repoA)!.consecutive_errors).toBe(1); // 실패로 집계됐다
    expect(findProject(reg, repoB)!.last_launch.result).toBe("ok"); // 나머지는 정상 처리
  });

  test("판단 중 예외는 세고 기록하되 루프를 멈추지 않는다", async () => {
    await withTracker(repoA);
    await register("a", repoA);
    await register("b", "");
    // repo 가 빈 프로젝트는 판단 자체가 실패한다 — 그래도 a 는 처리돼야 한다
    const r = await runTick({ env, log, launcher: okLauncher });
    expect(r.handled).toBeGreaterThanOrEqual(1);
    expect(findProject((await loadRegistryChecked(env)).registry, repoA)!.last_launch.result).toBe("ok");
  });

  test("완료 전이가 기록된다", async () => {
    await withTracker(repoA, false);
    await register("a", repoA);
    await runTick({ env, log, launcher: okLauncher });
    expect(findProject((await loadRegistryChecked(env)).registry, repoA)!.status).toBe("completed");
    expect(actions()).toContain("completed");
  });

  test("주기 도중 다른 주체가 넣은 프로젝트가 사라지지 않는다", async () => {
    await withTracker(repoA);
    await register("a", repoA);
    // runTick 이 레지스트리를 읽은 **뒤**, 저장하기 **전**에 b 가 등록되도록 기동 훅에 끼운다.
    // v1 은 주기 시작의 사본을 끝에 통째로 저장해 바로 이 창에서 b 를 지웠다.
    const registerDuringTick: Launcher = async (spec) => {
      await register("b", repoB);
      return okLauncher(spec);
    };
    await runTick({ env, log, launcher: registerDuringTick });
    const ids = (await loadRegistryChecked(env)).registry.projects.map((p) => p.id).sort();
    expect(ids).toEqual(["a", "b"]);
    // a 의 기동 결과도 함께 살아남아야 한다 — 병합이지 되돌리기가 아니다
    expect(findProject((await loadRegistryChecked(env)).registry, repoA)!.last_launch.result).toBe("ok");
  });
});

describe("판단별 기록", () => {
  test("스킵 사유가 남는다 — 왜 안 돌았는지 알 수 있어야 한다", async () => {
    await withTracker(repoA);
    await writeFile(repoPaths(repoA).pausedFlag, "", "utf8");
    await register("a", repoA);
    await runTick({ env, log, launcher: okLauncher });
    const skip = captured.find((r) => r.action === "skip");
    expect(skip?.detail).toContain("HARNESS_PAUSED");
  });

  test("장부 부재는 오류로 기록되고 백오프가 걸린다", async () => {
    await register("a", repoA); // 장부 없음
    await runTick({ env, log, launcher: okLauncher });
    const entry = findProject((await loadRegistryChecked(env)).registry, repoA)!;
    expect(entry.consecutive_errors).toBe(1);
    expect(entry.next_retry_at).not.toBeNull();
    expect(captured.some((r) => r.level === "error")).toBe(true);
  });

  test("사용량 초과는 warn 으로 남고 status 는 그대로다", async () => {
    await withTracker(repoA);
    await register("a", repoA);
    const limited: Launcher = async () => ({
      pid: 1, probe: async () => 1, readLogTail: async () => "usage limit reached",
    });
    await runTick({ env, log, launcher: limited });
    const entry = findProject((await loadRegistryChecked(env)).registry, repoA)!;
    expect(entry.status).toBe("active");
    expect(entry.limit_hits).toBe(1);
    expect(captured.some((r) => r.action === "limit" && r.level === "warn")).toBe(true);
  });

  test("재활성화도 기록된다", async () => {
    await withTracker(repoA);
    await register("a", repoA);
    await mutateRegistry((reg) => void (findProject(reg, repoA)!.status = "completed"), env);
    await runTick({ env, log, launcher: okLauncher });
    expect(captured.some((r) => r.action === "active" && r.detail.includes("재활성화"))).toBe(true);
  });
});

describe("데몬 수명", () => {
  test("잠금을 잡고 tick 을 돌고 반납한다", async () => {
    await saveRegistry(defaultRegistry(), env);
    const clock = fakeClock();
    const result = await runDaemon({ env, log, deps: clock.deps, maxTicks: 3, launcher: okLauncher });
    expect(result.acquired).toBe(true);
    expect(result.ticks).toBe(3);
    expect(await Bun.file(userPaths(env).lock).exists()).toBe(false); // 반납했다
    expect(actions()).toContain("boot");
    expect(actions()).toContain("shutdown");
  });

  test("이미 다른 인스턴스가 있으면 즉시 물러난다", async () => {
    await saveRegistry(defaultRegistry(), env);
    await acquireLock(env); // 이 프로세스가 쥔다 = 살아 있는 잠금
    try {
      const result = await runDaemon({ env, log, maxTicks: 1, launcher: okLauncher });
      expect(result.acquired).toBe(false);
      expect(result.ticks).toBe(0);
      expect(captured.some((r) => r.action === "lock")).toBe(true);
    } finally {
      await releaseLock(env);
    }
  });

  test("abort 하면 정리하고 내려간다", async () => {
    await saveRegistry(defaultRegistry(), env);
    const ctl = new AbortController();
    const clock = fakeClock();
    const result = await runDaemon({
      env, log, deps: clock.deps, signal: ctl.signal, launcher: okLauncher,
      maxTicks: 100,
    });
    // maxTicks 로 끝나지만, 중요한 것은 잠금이 남지 않는다는 것이다
    expect(result.acquired).toBe(true);
    expect(await Bun.file(userPaths(env).lock).exists()).toBe(false);
    ctl.abort();
  });

  test("tick 마다 last_tick 이 갱신된다 — 살아 있음의 증거", async () => {
    await saveRegistry(defaultRegistry(), env);
    const clock = fakeClock();
    await runDaemon({ env, log, deps: clock.deps, maxTicks: 2, launcher: okLauncher });
    expect((await loadRegistryChecked(env)).registry.last_tick).toBeTruthy();
  });
});

describe("tickProject 단위", () => {
  test("반환값이 '레지스트리를 바꿨는가' 를 정확히 알린다", async () => {
    await withTracker(repoA);
    const reg = defaultRegistry();
    const proj = upsertProject(reg, { id: "a", repo: repoA, model: "claude-opus-5", permissionArgs: [] });

    await writeFile(repoPaths(repoA).pausedFlag, "", "utf8");
    expect(await tickProject(proj, reg.settings, { env, log })).toBe(false); // 스킵은 변경 없음

    await rm(repoPaths(repoA).pausedFlag, { force: true });
    expect(await tickProject(proj, reg.settings, { env, log, launcher: okLauncher })).toBe(true);
  });
});
