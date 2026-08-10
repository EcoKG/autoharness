/**
 * 자체 스케줄러 — **OS 스케줄러를 쓰지 않는다.**
 *
 * v1 은 Windows 작업 스케줄러에 시간 트리거를 걸었는데, 이 PC 에서는 매 기동이
 * 0x800710E0(요청 거부)으로 반려돼 설치 이후 단 한 번도 실행되지 않았다. 그 사이
 * status 는 "등록됨(Ready)"만 보고했다 — 자동 부활 보장이 내내 무효였는데 아무도 몰랐다.
 * 그래서 v2 는 자기 시계로 돈다.
 *
 * 두 가지 시간 함정을 피한다:
 *   ① **누적 드리프트** — `setInterval(f, N)` 은 f 의 실행 시간이 매 주기 더해져 하루면
 *      수 분씩 밀린다. 그래서 "이전 목표 + 간격"으로 **다음 목표 시각을 재계산**한다.
 *   ② **시계 점프** — 절전 복귀는 시계를 앞으로, 시간 변경은 뒤로 옮긴다. 앞으로 크게
 *      뛰었을 때 밀린 만큼 몰아서 돌면 tick 폭풍이 되고, 뒤로 뛰었을 때 그대로 두면
 *      몇 시간을 기다린다. 양쪽 다 잘라 낸다.
 */
import { mutateRegistry } from "../core/registry.ts";
import { nowIso } from "../core/schema.ts";
import { refreshLock } from "./lock.ts";

export const DEFAULT_INTERVAL_MINUTES = 15;

/**
 * 다음 실행 시각.
 *
 * @param prevTarget 직전에 겨냥했던 시각(실제 실행 시각이 아니다 — 드리프트를 없애는 핵심)
 */
export function nextRunAt(prevTarget: number, now: number, intervalMs: number): number {
  if (!(intervalMs > 0)) throw new Error(`간격은 양수여야 합니다: ${intervalMs}`);
  let next = prevTarget + intervalMs;
  if (next <= now) {
    // 앞으로 점프했거나 tick 이 오래 걸렸다 — 밀린 주기를 몰아서 돌지 않고 다음 슬롯으로 간다
    const missed = Math.floor((now - prevTarget) / intervalMs);
    next = prevTarget + (missed + 1) * intervalMs;
  }
  if (next > now + intervalMs) {
    // 시계가 뒤로 갔다 — 옛 목표를 붙들고 몇 시간 기다리지 않도록 지금 기준으로 다시 잡는다
    next = now + intervalMs;
  }
  return next;
}

export interface SchedulerDeps {
  now: () => number;
  /** 취소 가능한 대기. 타이머를 반드시 정리해 핸들이 쌓이지 않게 한다. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer); // 핸들 누적 방지 — 장시간 무중단 동작이 목표다
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export const realDeps: SchedulerDeps = { now: Date.now, sleep: realSleep };

export interface SchedulerOptions {
  intervalMinutes?: number;
  signal?: AbortSignal;
  /** 테스트·진단용 상한. 지정하면 이만큼 돌고 정상 종료한다. */
  maxTicks?: number;
  deps?: SchedulerDeps;
  env?: NodeJS.ProcessEnv;
  /** tick 마다 레지스트리에 last_tick 을 남길 것인가(테스트에서 끌 수 있다). */
  recordTick?: boolean;
  onError?: (err: unknown, tick: number) => void;
}

export interface SchedulerStats {
  ticks: number;
  errors: number;
  lastTickAt: number | null;
  stoppedBecause: "aborted" | "maxTicks";
}

/**
 * tick 루프. `onTick` 이 던져도 루프는 계속한다 — 한 프로젝트의 예외가 데몬 전체를
 * 내리면 나머지 프로젝트가 전부 멈춘다(v1 이 로그만 남기고 넘어가던 자리를 계승하되,
 * 여기서는 횟수를 세어 드러낸다).
 */
export async function runScheduler(
  onTick: (tick: number) => void | Promise<void>,
  options: SchedulerOptions = {},
): Promise<SchedulerStats> {
  const deps = options.deps ?? realDeps;
  const env = options.env ?? process.env;
  const intervalMs = Math.max(1, Math.round((options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000));
  const signal = options.signal ?? new AbortController().signal;
  const recordTick = options.recordTick !== false;

  let ticks = 0;
  let errors = 0;
  let lastTickAt: number | null = null;
  let stoppedBecause: SchedulerStats["stoppedBecause"] = "aborted";
  // 첫 tick 은 즉시 — 방금 뜬 데몬이 15분을 기다리면 그 사이가 통째로 사각지대다
  let target = deps.now();

  while (!signal.aborted) {
    const wait = target - deps.now();
    if (wait > 0) await deps.sleep(wait, signal);
    if (signal.aborted) break;

    ticks += 1;
    lastTickAt = deps.now();
    try {
      await onTick(ticks);
      if (recordTick) await recordLastTick(env);
      await refreshLock(env);
    } catch (err) {
      errors += 1;
      options.onError?.(err, ticks);
    }

    target = nextRunAt(target, deps.now(), intervalMs);
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
      stoppedBecause = "maxTicks";
      break;
    }
  }
  return { ticks, errors, lastTickAt, stoppedBecause };
}

/**
 * `last_tick` 기록 — **통째 되쓰기가 아니라 병합**이다.
 *
 * v1 은 주기 시작에 읽은 사본을 끝에 통째로 저장해, 그 사이 MCP 가 기록한 변경
 * (task_add 재활성화·pause·model_set)이 조용히 되돌아갔다. 여기서는 저장 직전에 다시 읽고
 * 이 주기가 실제로 만진 필드만 고친다.
 */
export async function recordLastTick(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const ts = nowIso();
  await mutateRegistry((reg) => {
    reg.last_tick = ts;
  }, env);
  return ts;
}
