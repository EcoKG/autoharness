/**
 * 데몬 조립 — 잠금 → 스케줄러 → 매 tick 마다 전 프로젝트 판단·기동, 그리고 모든 판단을 기록.
 *
 * v1 워치독과 역할은 같지만 **살아 있는 방식이 다르다**: OS 스케줄러가 우리를 불러 주는
 * 것이 아니라, 우리가 계속 떠서 자기 시계로 돈다. 그래서 이 파일의 관심사는 두 가지다.
 *   ① 한 프로젝트의 예외가 나머지를 멈추지 않게 할 것
 *   ② 모든 판단이 로그에 남게 할 것 — v1 이 몇 주간 죽어 있고도 몰랐던 이유가 이것이다
 */
import { loadRegistryForWrite, mutateRegistry, saveRegistry } from "../core/registry.ts";
import { userPaths } from "../core/paths.ts";
import type { RegistryProject, RegistrySettings } from "../core/schema.ts";
import { ConsoleLog } from "./log.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { DEFAULT_INTERVAL_MINUTES, runScheduler, type SchedulerDeps, type SchedulerStats } from "./scheduler.ts";
import { decideProject, launchProject, realLauncher, type Launcher } from "./supervisor.ts";

export interface DaemonOptions {
  intervalMinutes?: number;
  signal?: AbortSignal;
  maxTicks?: number;
  deps?: SchedulerDeps;
  env?: NodeJS.ProcessEnv;
  log?: ConsoleLog;
  launcher?: Launcher;
  /** 판단만 하고 기동·기록은 하지 않는다 — 진단용. */
  dryRun?: boolean;
}

/**
 * 프로젝트 1건 처리. 레지스트리 항목을 제자리에서 고치고, 변경 여부를 돌려준다.
 * 예외는 호출자가 잡는다 — 여기서 삼키면 어떤 프로젝트가 문제인지 알 수 없다.
 */
export async function tickProject(
  proj: RegistryProject,
  settings: Partial<RegistrySettings>,
  options: DaemonOptions,
): Promise<boolean> {
  const log = options.log;
  const name = proj.id || "?";
  const { decision, reactivated } = await decideProject(proj, { settings });
  if (reactivated) log?.info(name, "active", "completed → active 재활성화(장부에 진행 가능 작업 확인)");

  switch (decision.action) {
    case "skip":
      log?.debug(name, "skip", decision.reason);
      return reactivated;
    case "error": {
      if (options.dryRun) {
        log?.warn(name, "error", `(dry-run) ${decision.reason}`);
        return reactivated;
      }
      const { markError } = await import("./supervisor.ts");
      log?.error(name, "error", markError(proj, settings, decision.reason));
      return true;
    }
    case "transition": {
      if (options.dryRun) {
        log?.info(name, decision.status, `(dry-run) ${decision.detail}`);
        return reactivated;
      }
      proj.status = decision.status;
      proj.updated_at = new Date().toISOString();
      log?.info(name, decision.status, decision.detail);
      return true;
    }
    case "launch": {
      if (options.dryRun) {
        log?.info(name, "launch", `(dry-run) 기동 대상 — ${decision.detail}`);
        return reactivated;
      }
      const outcome = await launchProject(proj, decision.next, {
        settings,
        env: options.env,
        launcher: options.launcher ?? realLauncher(),
      });
      const level = outcome.result === "error" ? "error" : outcome.result === "limit" ? "warn" : "info";
      log?.log(level, name, outcome.result, outcome.message);
      return true;
    }
  }
}

/** tick 1회 — 전 프로젝트를 순회한다. 한 건이 터져도 나머지는 계속한다. */
export async function runTick(options: DaemonOptions): Promise<{ handled: number; failed: number }> {
  const env = options.env ?? process.env;
  const log = options.log;
  let handled = 0;
  let failed = 0;

  const reg = await loadRegistryForWrite(env);
  if (reg.projects.length === 0) {
    log?.debug("-", "tick", "등록된 프로젝트 없음");
    return { handled: 0, failed: 0 };
  }

  let changed = false;
  for (const proj of reg.projects) {
    try {
      if (await tickProject(proj, reg.settings, options)) changed = true;
      handled += 1;
    } catch (err) {
      // 한 프로젝트의 예외가 데몬 전체를 멈추면 나머지가 전부 굶는다.
      // 다만 조용히 넘기지 않는다 — 세지 않으면 매 주기 터지는 프로젝트를 아무도 모른다.
      failed += 1;
      log?.error(proj.id || "?", "exception", `프로젝트 처리 중 예외: ${String(err)}`);
    }
  }

  if (changed && !options.dryRun) {
    // 저장 직전 재읽기 병합 — 이 주기 도중 MCP 가 넣은 변경을 되돌리지 않는다
    await mutateRegistry((fresh) => {
      for (const proj of reg.projects) {
        const target = fresh.projects.find((p) => p.id === proj.id && p.repo === proj.repo);
        if (target) Object.assign(target, proj);
      }
    }, env);
  }
  return { handled, failed };
}

export interface DaemonResult extends SchedulerStats {
  acquired: boolean;
  reason: string;
}

export async function runDaemon(options: DaemonOptions = {}): Promise<DaemonResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? new ConsoleLog({ env });
  const interval = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

  const lock = await acquireLock(env);
  if (!lock.acquired) {
    log.warn("-", "lock", `${lock.reason} — 이 인스턴스는 즉시 종료합니다`);
    await log.flush();
    return { acquired: false, reason: lock.reason, ticks: 0, errors: 0, lastTickAt: null, stoppedBecause: "aborted" };
  }
  log.info("-", "boot", `데몬 시작 pid=${process.pid} interval=${interval}분 registry=${userPaths(env).registry}`);

  try {
    const stats = await runScheduler(
      async (tick) => {
        const r = await runTick({ ...options, env, log });
        log.info("-", "tick", `#${tick} 프로젝트 ${r.handled}건 처리${r.failed ? `, 예외 ${r.failed}건` : ""}`);
      },
      {
        intervalMinutes: interval,
        signal: options.signal,
        maxTicks: options.maxTicks,
        deps: options.deps,
        env,
        onError: (err, tick) => log.error("-", "tick", `tick #${tick} 실패: ${String(err)}`),
      },
    );
    log.info("-", "shutdown", `종료: tick ${stats.ticks}회, 오류 ${stats.errors}회 (${stats.stoppedBecause})`);
    await log.flush();
    return { ...stats, acquired: true, reason: lock.reason };
  } finally {
    await releaseLock(env);
    if (!options.log) await log.close();
  }
}

/** 레지스트리가 아예 없을 때도 데몬은 떠야 한다 — 첫 init 을 기다리는 것이 정상 상태다. */
export async function ensureRegistry(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { defaultRegistry } = await import("../core/registry.ts");
  const { loadRegistryChecked } = await import("../core/registry.ts");
  const r = await loadRegistryChecked(env);
  if (r.state === "missing") await saveRegistry(defaultRegistry(), env);
}
