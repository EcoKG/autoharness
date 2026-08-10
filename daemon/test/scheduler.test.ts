/**
 * 스케줄러·잠금 회귀 — v1 이 조용히 실패한 바로 그 지점을 고정한다.
 *
 * v1 은 OS 스케줄러에 시간 트리거를 걸었다가 매 기동이 반려돼 한 번도 실행되지 않았고,
 * 그동안 "등록됨"만 보고했다. v2 는 자기 시계로 돌므로 **시간 자체가 시험 대상**이다:
 * 누적 드리프트, 절전 복귀(앞으로 점프), 시간 변경(뒤로 점프), 그리고 죽은 잠금.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userPaths } from "../src/core/paths.ts";
import {
  defaultRegistry,
  findProject,
  loadRegistryChecked,
  saveRegistry,
  upsertProject,
} from "../src/core/registry.ts";
import { LOCK_STALE_MS, acquireLock, pidAlive, refreshLock, releaseLock } from "../src/daemon/lock.ts";
import {
  DEFAULT_INTERVAL_MINUTES,
  nextRunAt,
  recordLastTick,
  runScheduler,
  type SchedulerDeps,
} from "../src/daemon/scheduler.ts";

let home = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-sched-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const MIN = 60_000;

/** 가짜 시계 — 수백 tick 을 즉시 돌려 드리프트를 실측한다. */
function fakeClock(start = 1_000_000): { deps: SchedulerDeps; at: () => number; slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    at: () => now,
    slept,
    deps: {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    },
  };
}

describe("다음 실행 시각 계산", () => {
  test("정상 진행은 간격만큼 더한다", () => {
    expect(nextRunAt(1000, 1000, 500)).toBe(1500);
  });

  test("tick 이 오래 걸려도 목표는 이전 목표 기준이다 — 드리프트가 쌓이지 않는다", () => {
    // 목표 1000, 실제로는 1490 에 끝남 → 다음은 1500 (1490+500 이 아니다)
    expect(nextRunAt(1000, 1490, 500)).toBe(1500);
  });

  test("절전 복귀로 앞으로 크게 점프하면 밀린 주기를 몰아 돌지 않는다", () => {
    // 목표 1000 인데 깨어 보니 9_999 — 18주기를 몰아 도는 대신 다음 슬롯 하나만
    const next = nextRunAt(1000, 9_999, 500);
    expect(next).toBeGreaterThan(9_999);
    expect(next).toBeLessThanOrEqual(9_999 + 500);
    expect((next - 1000) % 500).toBe(0); // 격자는 유지한다
  });

  test("시계가 뒤로 가도 옛 목표를 붙들고 기다리지 않는다", () => {
    // 목표 100_000 이었는데 시계가 1_000 으로 되돌아감
    expect(nextRunAt(100_000, 1_000, 500)).toBe(1_500);
  });

  test("간격이 0 이하면 거부한다 — 바쁜 루프 방지", () => {
    expect(() => nextRunAt(0, 0, 0)).toThrow();
    expect(() => nextRunAt(0, 0, -5)).toThrow();
  });
});

describe("tick 루프", () => {
  test("첫 tick 은 즉시 돈다 — 방금 뜬 데몬이 15분을 놀지 않는다", async () => {
    const clock = fakeClock();
    let firstAt = -1;
    await runScheduler(
      () => {
        if (firstAt < 0) firstAt = clock.at();
      },
      { deps: clock.deps, maxTicks: 1, recordTick: false, env },
    );
    expect(firstAt).toBe(1_000_000); // 대기 없이 시작 시각에 돌았다
  });

  test("200 tick 을 돌아도 누적 드리프트가 없다", async () => {
    const clock = fakeClock();
    const at: number[] = [];
    await runScheduler(
      () => {
        at.push(clock.at());
        clock.deps.now(); // tick 자체가 시간을 먹는 상황을 흉내 낸다
      },
      { deps: clock.deps, intervalMinutes: 15, maxTicks: 200, recordTick: false, env },
    );
    expect(at.length).toBe(200);
    const expectedSpan = 199 * DEFAULT_INTERVAL_MINUTES * MIN;
    expect(at.at(-1)! - at[0]!).toBe(expectedSpan); // 정확히 격자 위
  });

  test("tick 이 던져도 루프는 계속하고 횟수를 센다", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const stats = await runScheduler(
      (n) => {
        if (n % 2 === 0) throw new Error("일부러 실패");
      },
      {
        deps: clock.deps, maxTicks: 6, recordTick: false, env,
        onError: (_e, n) => void seen.push(n),
      },
    );
    expect(stats.ticks).toBe(6);
    expect(stats.errors).toBe(3);
    expect(seen).toEqual([2, 4, 6]);
    expect(stats.stoppedBecause).toBe("maxTicks");
  });

  test("abort 하면 즉시 멈춘다", async () => {
    const clock = fakeClock();
    const ctl = new AbortController();
    const stats = await runScheduler(
      (n) => {
        if (n === 3) ctl.abort();
      },
      { deps: clock.deps, signal: ctl.signal, recordTick: false, env },
    );
    expect(stats.ticks).toBe(3);
    expect(stats.stoppedBecause).toBe("aborted");
  });

  test("이미 abort 된 신호면 한 번도 돌지 않는다", async () => {
    const clock = fakeClock();
    const ctl = new AbortController();
    ctl.abort();
    let ran = 0;
    const stats = await runScheduler(() => void ran++, {
      deps: clock.deps, signal: ctl.signal, recordTick: false, env,
    });
    expect(ran).toBe(0);
    expect(stats.ticks).toBe(0);
  });

  test("실제 타이머 경로도 동작하고 대기가 끊긴다", async () => {
    const ctl = new AbortController();
    const stats = await runScheduler(() => ctl.abort(), {
      intervalMinutes: 60, signal: ctl.signal, recordTick: false, env,
    });
    expect(stats.ticks).toBe(1); // 첫 tick 즉시 → abort → 60분을 기다리지 않는다
  });
});

describe("last_tick 기록", () => {
  test("tick 끝에 last_tick 이 남는다", async () => {
    const clock = fakeClock();
    await runScheduler(() => {}, { deps: clock.deps, maxTicks: 1, env });
    expect((await loadRegistryChecked(env)).registry.last_tick).toBeTruthy();
  });

  test("주기 도중 다른 주체가 넣은 변경을 되돌리지 않는다", async () => {
    // v1 결함 재현 방지: 주기 시작에 읽은 사본을 끝에 통째로 저장하면 이 프로젝트가 사라졌다
    const base = defaultRegistry();
    upsertProject(base, { id: "a", repo: home, model: "claude-opus-5", permissionArgs: [] });
    await saveRegistry(base, env);

    const clock = fakeClock();
    const other = join(home, "other");
    await runScheduler(
      async () => {
        await import("../src/core/registry.ts").then(({ mutateRegistry }) =>
          mutateRegistry((reg) => {
            upsertProject(reg, { id: "b", repo: other, model: "claude-opus-5", permissionArgs: [] });
          }, env),
        );
      },
      { deps: clock.deps, maxTicks: 1, env },
    );

    const reg = (await loadRegistryChecked(env)).registry;
    expect(reg.projects.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(reg.last_tick).toBeTruthy();
    expect(findProject(reg, home)).toBeDefined();
  });

  test("레지스트리가 파손되면 기록이 조용히 성공하지 않는다", async () => {
    await writeFile(userPaths(env).registry, "{ 깨진", "utf8");
    await expect(recordLastTick(env)).rejects.toThrow(/파손/);
  });
});

describe("단일 인스턴스 잠금", () => {
  test("자기 pid 는 살아 있고, 없는 pid 는 죽어 있다", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive("문자열")).toBe(false);
    expect(pidAlive(undefined)).toBe(false);
  });

  test("생존 확인이 대상 프로세스를 죽이지 않는다", async () => {
    // v1 이 손으로 구현해야 했던 이유가 이것이다(파이썬 os.kill 은 Windows 에서 죽인다)
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
      stdout: "ignore", stderr: "ignore",
    });
    try {
      expect(pidAlive(child.pid)).toBe(true);
      expect(pidAlive(child.pid)).toBe(true); // 두 번 물어도 멀쩡하다
      expect(child.killed).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("잠금을 잡고 놓는다", async () => {
    const r = await acquireLock(env);
    expect(r.acquired).toBe(true);
    expect(await Bun.file(userPaths(env).lock).exists()).toBe(true);
    await releaseLock(env);
    expect(await Bun.file(userPaths(env).lock).exists()).toBe(false);
  });

  test("살아 있는 다른 인스턴스에는 양보한다", async () => {
    await writeFile(
      userPaths(env).lock,
      JSON.stringify({ pid: process.pid, started_at: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const r = await acquireLock(env);
    expect(r.acquired).toBe(false);
    expect(r.reason).toContain("다른 데몬 실행 중");
  });

  test("죽은 pid 의 잠금은 탈취한다 — 한 번 죽고 영영 못 뜨는 상태를 막는다", async () => {
    await writeFile(
      userPaths(env).lock,
      JSON.stringify({ pid: 2 ** 30, started_at: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const r = await acquireLock(env);
    expect(r.acquired).toBe(true);
    expect(r.reason).toContain("사망 확인");
  });

  test("mtime 이 오래되면 pid 가 살아 있어도 탈취한다", async () => {
    const path = userPaths(env).lock;
    await writeFile(path, JSON.stringify({ pid: process.pid, started_at: "x" }), "utf8");
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(path, old, old);
    const r = await acquireLock(env);
    expect(r.acquired).toBe(true);
    expect(r.reason).toContain("죽은 잠금 탈취");
  });

  test("깨진 잠금 파일도 진행을 막지 않는다", async () => {
    await writeFile(userPaths(env).lock, "이건 JSON 이 아니다", "utf8");
    expect((await acquireLock(env)).acquired).toBe(true);
  });

  test("refreshLock 이 mtime 을 민다", async () => {
    await acquireLock(env);
    const path = userPaths(env).lock;
    const old = new Date(Date.now() - 10 * MIN);
    await utimes(path, old, old);
    const before = (await stat(path)).mtimeMs;
    expect(await refreshLock(env)).toBe(true);
    expect((await stat(path)).mtimeMs).toBeGreaterThan(before);
  });

  test("잠금이 없으면 refresh 는 실패를 알린다 — 조용히 성공하지 않는다", async () => {
    await releaseLock(env);
    expect(await refreshLock(env)).toBe(false);
  });
});
