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
import { ConsoleLog, SESSION_ACTION } from "./log.ts";
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
  /** 웹 API 를 띄울 것인가(기본 true). 포트 0 이면 임의 포트. */
  web?: boolean;
  webPort?: number;
  /** 이 프로젝트만 처리한다(웹의 즉시 tick·기동용). */
  onlyProject?: string;
  /** 하트비트·백오프를 건너뛰고 기동한다(웹에서 사람이 명시적으로 누른 경우). */
  forceLaunch?: boolean;
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
  const { decision, reactivated } = await decideProject(proj, {
    settings,
    force: options.forceLaunch,
  });
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
        // 세션이 뱉는 줄을 그대로 콘솔 스트림에 싣는다 — 웹에서 보고 싶은 것은
        // "기동했다" 가 아니라 그 세션이 지금 무엇을 하는지다.
        onLine: (line) => void log?.log("info", name, SESSION_ACTION, line),
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

  const targets = options.onlyProject
    ? reg.projects.filter((p) => p.id === options.onlyProject)
    : reg.projects;
  if (targets.length === 0) {
    log?.debug(options.onlyProject ?? '-', 'tick', '대상 프로젝트 없음');
    return { handled: 0, failed: 0 };
  }

  let changed = false;
  for (const proj of targets) {
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

  let web: { stop: () => Promise<void>; port: number } | null = null;
  if (options.web !== false) {
    try {
      const { createWebServer } = await import("../web/server.ts");
      web = await createWebServer(
        {
          log,
          env,
          // 웹이 노출하는 것은 **화이트리스트된 동작뿐**이다 — 임의 실행 경로를 주지 않는다
          requestTick: async (projectId) => runTick({ ...options, env, log, onlyProject: projectId }),
          requestLaunch: async (projectId) =>
            runTick({ ...options, env, log, onlyProject: projectId, forceLaunch: true }),
        },
        options.webPort ?? 0,
      );
      // 주소와 토큰 파일 위치를 로그에 남긴다.
      //
      // 종전에는 화면에 POSIX 경로가 문자열로 박혀 있어 Windows 사용자에게 영영 틀린
      // 안내였고, 경로를 알려 주는 코드(writeTokenHint)는 어디서도 불리지 않았다.
      // 실제 경로를 아는 것은 여기다 — 문서에 데이터를 심지 않고 로그로 알린다.
      const { writeTokenHint } = await import("../web/server.ts");
      const tokenPath = await writeTokenHint(env);
      log.info("-", "web", `웹 콘솔: http://127.0.0.1:${web.port} — 토큰 파일: ${tokenPath}`);
    } catch (err) {
      // 웹이 못 떠도 스케줄러는 돌아야 한다 — 자동 주행이 UI 때문에 멈추면 본말전도다
      log.error("-", "web", `웹 API 기동 실패(스케줄러는 계속): ${String(err)}`);
    }
  }

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
    await web?.stop().catch(() => {});
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
