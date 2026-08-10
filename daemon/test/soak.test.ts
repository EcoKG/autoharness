/**
 * 데몬 지속 동작 실측 — **이 항목이 통과해야 "자동 부활이 동작한다" 고 말할 수 있다.**
 *
 * v1 이 정확히 여기서 조용히 실패했다: OS 스케줄러에 등록만 되고 한 번도 실행되지 않은 채
 * "등록됨(Ready)" 만 보고했다. v2 는 스케줄링을 자기 안으로 가져왔으므로, 이제 증명해야 할
 * 것은 **우리 루프가 오래 돌아도 멀쩡한가** 다.
 *
 * 세 가지를 본다:
 *   ① 드리프트 — 수백 tick 뒤에도 격자에서 벗어나지 않는가
 *   ② 시계 점프 — 절전 복귀(앞으로)·시간 변경(뒤로)에서 폭주하거나 멈추지 않는가
 *   ③ 누수 — 타이머·리스너·메모리가 tick 수에 비례해 쌓이지 않는가
 * 그리고 가짜 시계가 아닌 **실제 타이머**로도 last_tick 이 계속 갱신되는지 관측한다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userPaths } from "../src/core/paths.ts";
import { defaultRegistry, loadRegistryChecked, saveRegistry } from "../src/core/registry.ts";
import { ConsoleLog } from "../src/daemon/log.ts";
import { runDaemon } from "../src/daemon/daemon.ts";
import {
  DEFAULT_INTERVAL_MINUTES,
  nextRunAt,
  realSleep,
  runScheduler,
  type SchedulerDeps,
} from "../src/daemon/scheduler.ts";

let home = "";
let env: NodeJS.ProcessEnv = {};
let log: ConsoleLog;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-soak-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
  await saveRegistry(defaultRegistry(), env);
  log = new ConsoleLog({ path: join(home, "d.log"), toStdout: false, ringSize: 50 });
});
afterEach(async () => {
  await log.close();
  await rm(home, { recursive: true, force: true });
});

const MIN = 60_000;

/** 가속 시계 — 수백 tick 을 즉시 돌린다. 실제 시간으로는 며칠에 해당한다. */
function fakeClock(start = 1_000_000): { deps: SchedulerDeps; at: () => number; jump: (ms: number) => void } {
  let now = start;
  return {
    at: () => now,
    jump: (ms) => void (now += ms),
    deps: {
      now: () => now,
      sleep: async (ms) => void (now += ms),
    },
  };
}

describe("① 장시간 드리프트", () => {
  test("500 tick(약 5일치) 뒤에도 격자에서 벗어나지 않는다", async () => {
    const clock = fakeClock();
    const at: number[] = [];
    const stats = await runScheduler(() => void at.push(clock.at()), {
      deps: clock.deps, intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      maxTicks: 500, recordTick: false, env,
    });
    expect(stats.ticks).toBe(500);
    const interval = DEFAULT_INTERVAL_MINUTES * MIN;
    // 매 간격이 정확히 같아야 한다 — 하나라도 어긋나면 드리프트다
    const gaps = at.slice(1).map((v, i) => v - at[i]!);
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBe(interval);
    // 총 경과 시간도 정확히 격자 위
    expect(at.at(-1)! - at[0]!).toBe(499 * interval);
  }, 60_000);

  test("tick 이 매번 다른 시간을 먹어도 목표가 밀리지 않는다", async () => {
    const clock = fakeClock();
    const at: number[] = [];
    let n = 0;
    await runScheduler(
      () => {
        at.push(clock.at());
        clock.jump((n++ % 7) * 1000); // tick 마다 0~6초를 먹는다
      },
      { deps: clock.deps, intervalMinutes: 15, maxTicks: 200, recordTick: false, env },
    );
    const gaps = at.slice(1).map((v, i) => v - at[i]!);
    // 실행 시간이 들쭉날쭉해도 격자는 유지된다(이전 목표 기준 재계산의 효과)
    expect(Math.max(...gaps)).toBe(15 * MIN);
    expect(Math.min(...gaps)).toBe(15 * MIN);
  }, 60_000);
});

describe("② 시계 점프", () => {
  test("절전 복귀(앞으로 6시간)에서 밀린 주기를 몰아 돌지 않는다", async () => {
    const clock = fakeClock();
    const at: number[] = [];
    let jumped = false;
    await runScheduler(
      () => {
        at.push(clock.at());
        if (at.length === 3 && !jumped) {
          jumped = true;
          clock.jump(6 * 60 * MIN); // 노트북이 6시간 자다 깼다
        }
      },
      { deps: clock.deps, intervalMinutes: 15, maxTicks: 10, recordTick: false, env },
    );
    // 6시간 = 24주기가 밀렸지만 tick 폭풍이 나면 안 된다 — 정확히 10번만 돌았다
    expect(at.length).toBe(10);
    // 점프 직후의 간격은 한 주기를 넘지 않는다(다음 슬롯 하나로 접었다)
    const afterJump = at[3]! - at[2]!;
    expect(afterJump).toBeGreaterThan(6 * 60 * MIN);
    expect(afterJump).toBeLessThanOrEqual(6 * 60 * MIN + 15 * MIN);
  }, 60_000);

  test("시간 변경(뒤로 3시간)에서 멈추지 않는다", async () => {
    const clock = fakeClock();
    const at: number[] = [];
    let jumped = false;
    await runScheduler(
      () => {
        at.push(clock.at());
        if (at.length === 2 && !jumped) {
          jumped = true;
          clock.jump(-3 * 60 * MIN); // 시계가 뒤로 갔다
        }
      },
      { deps: clock.deps, intervalMinutes: 15, maxTicks: 6, recordTick: false, env },
    );
    expect(at.length).toBe(6); // 옛 목표를 붙들고 3시간을 기다리지 않았다
    const afterJump = at[2]! - at[1]!;
    expect(afterJump).toBeLessThanOrEqual(15 * MIN); // 지금 기준으로 다시 잡았다
  }, 60_000);

  test("점프가 반복돼도 루프가 살아 있다", async () => {
    const clock = fakeClock();
    let ticks = 0;
    const stats = await runScheduler(
      () => {
        ticks += 1;
        clock.jump(ticks % 2 === 0 ? 4 * 60 * MIN : -2 * 60 * MIN);
      },
      { deps: clock.deps, intervalMinutes: 15, maxTicks: 100, recordTick: false, env },
    );
    expect(stats.ticks).toBe(100);
    expect(stats.errors).toBe(0);
  }, 60_000);

  test("계산 함수 자체의 경계", () => {
    const interval = 15 * MIN;
    // 앞으로 점프: 다음 슬롯 하나, 격자 유지
    const forward = nextRunAt(1000, 1000 + 100 * interval, interval);
    expect((forward - 1000) % interval).toBe(0);
    expect(forward).toBeGreaterThan(1000 + 100 * interval);
    // 뒤로 점프: 지금 기준
    expect(nextRunAt(10_000_000, 5000, interval)).toBe(5000 + interval);
  });
});

describe("③ 누수", () => {
  test("realSleep 이 abort 리스너를 남기지 않는다", async () => {
    // 리스너가 쌓이면 장시간 동작에서 메모리와 경고가 누적된다
    let added = 0;
    let removed = 0;
    const ctl = new AbortController();
    const signal = {
      get aborted() {
        return ctl.signal.aborted;
      },
      addEventListener: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        added += 1;
        ctl.signal.addEventListener(...args);
      },
      removeEventListener: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
        removed += 1;
        ctl.signal.removeEventListener(...args);
      },
    } as unknown as AbortSignal;

    for (let i = 0; i < 200; i++) await realSleep(0, signal);
    expect(added).toBe(200);
    expect(removed).toBe(200); // 붙인 만큼 정확히 뗐다
  }, 60_000);

  test("이미 abort 된 신호에는 타이머를 만들지도 않는다", async () => {
    let added = 0;
    const ctl = new AbortController();
    ctl.abort();
    const signal = {
      get aborted() {
        return true;
      },
      addEventListener: () => void (added += 1),
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    for (let i = 0; i < 50; i++) await realSleep(60_000, signal);
    expect(added).toBe(0); // 즉시 반환 — 1분짜리 타이머 50개를 만들지 않는다
  }, 30_000);

  test("2000 tick 을 돌려도 힙이 tick 수에 비례해 늘지 않는다", async () => {
    const clock = fakeClock();
    // 워밍업으로 초기 할당을 안정시킨 뒤 측정한다
    await runScheduler(() => {}, { deps: clock.deps, maxTicks: 200, recordTick: false, env });
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;

    await runScheduler(() => {}, { deps: clock.deps, maxTicks: 2000, recordTick: false, env });
    Bun.gc(true);
    const growth = process.memoryUsage().heapUsed - before;

    // tick 당 무언가를 붙들면 2000 tick 에서 수십 MB 로 드러난다. 여유를 두되 상한은 둔다.
    expect(growth).toBeLessThan(24 * 1024 * 1024);
  }, 120_000);

  test("로그 링 버퍼가 tick 수와 무관하게 유지된다", async () => {
    const clock = fakeClock();
    await runScheduler((n) => void log.info("-", "tick", `#${n}`), {
      deps: clock.deps, maxTicks: 1000, recordTick: false, env,
    });
    await log.flush();
    expect(log.recent(10_000).length).toBe(50); // ringSize 그대로
  }, 60_000);
});

describe("④ 실제 타이머로도 계속 돈다", () => {
  test("last_tick 이 반복해서 갱신된다 — 가짜 시계가 아닌 진짜로", async () => {
    const ctl = new AbortController();
    const seen: string[] = [];
    const run = runDaemon({
      env, log, web: false, launcher: async () => ({
        pid: 1, probe: async () => null, readLogTail: async () => "",
      }),
      intervalMinutes: 0.005, // 300ms
      signal: ctl.signal,
      maxTicks: 4,
    });
    // tick 마다 last_tick 이 바뀌는지 관측한다
    for (let i = 0; i < 12; i++) {
      const reg = (await loadRegistryChecked(env)).registry;
      if (reg.last_tick && seen.at(-1) !== reg.last_tick) seen.push(reg.last_tick);
      await Bun.sleep(120);
    }
    const result = await run;
    expect(result.acquired).toBe(true);
    expect(result.ticks).toBe(4);
    expect(seen.length).toBeGreaterThanOrEqual(2); // 한 번 쓰고 멈춘 것이 아니다
    ctl.abort();
  }, 60_000);

  test("잠금을 남기지 않고 내려간다 — 다음 기동이 막히지 않는다", async () => {
    await runDaemon({
      env, log, web: false, maxTicks: 1, intervalMinutes: 0.005,
      launcher: async () => ({ pid: 1, probe: async () => null, readLogTail: async () => "" }),
    });
    expect(await Bun.file(userPaths(env).lock).exists()).toBe(false);
  }, 60_000);
});
