/**
 * 러너 — build→test→lint 를 돌리고 장부를 갱신한다.
 *
 * **종료 코드 0/1/2/3/4 는 절대 기준이다**(daemon/DESIGN.md 4절). 상위 에이전트가 이
 * 숫자로 분기하므로 의미를 바꾸면 자율 주행이 통째로 어긋난다.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { relative, join } from "node:path";

import { EXIT } from "../exit.ts";
import { renderSafe, saveTracker, statusCounts, writeHeartbeat, DEFAULT_MAX_ATTEMPTS } from "./ledger.ts";
import { repoPaths } from "./paths.ts";
import { LAST_ERROR_CAP, summarize } from "./summarize.ts";
import { nowIso, type Task, type Tracker } from "./schema.ts";

/** 스테이지 실행 중 하트비트 갱신 주기 — 워치독이 stale(30분)로 오판해 이중 기동하는 것을 막는다. */
export const HEARTBEAT_PUMP_MS = 5 * 60 * 1000;

export interface StageResult {
  name: string;
  command: string;
  exitCode: number;
  output: string;
}

export interface RunOutcome {
  exitCode: number;
  taskId: string | null;
  message: string;
  logFile: string | null;
  failedStage: string | null;
  summary: string[];
}

/** `{path}` 치환 — v1 과 동일. task.path 가 없으면 빈 문자열로 바꾼다. */
export function substitutePath(command: string, taskPath: string | null): string {
  return command.replace(/\{path\}/g, taskPath ?? "");
}

/**
 * 실행할 스테이지 목록을 만든다.
 * task.test_cmd 가 있으면 전역 test 를 대체한다(빈 문자열이면 해제 → 전역 복귀).
 */
export function planStages(
  tracker: Tracker,
  task: Task,
  customCmd?: string | null,
): { stages: Array<{ name: string; command: string }> } | { error: string } {
  if (customCmd) return { stages: [{ name: "custom", command: customCmd }] };

  const cmds = tracker.commands ?? { build: null, test: "", lint: null, timeout_sec: 1800 };
  const stages: Array<{ name: string; command: string }> = [];
  if (cmds.build) stages.push({ name: "build", command: substitutePath(cmds.build, task.path) });

  const testCmd = task.test_cmd || cmds.test;
  if (!testCmd) return { error: "test 명령이 없습니다 (tracker.commands.test)" };
  stages.push({ name: "test", command: substitutePath(testCmd, task.path) });

  if (cmds.lint) stages.push({ name: "lint", command: substitutePath(cmds.lint, task.path) });
  return { stages };
}

/** 같은 초에 재실행해도 이전 시도 로그를 보존하는 파일명 — v1 규칙과 동일. */
export async function nextLogPath(logsDir: string, taskId: string, at: Date = new Date()): Promise<string> {
  const ts = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  let candidate = join(logsDir, `${taskId}-${ts}.log`);
  let n = 1;
  while (await Bun.file(candidate).exists()) {
    candidate = join(logsDir, `${taskId}-${ts}-${n}.log`);
    n += 1;
  }
  return candidate;
}

/** 한 스테이지 실행 — 출력은 그대로 로그에 쌓고 요약용으로도 돌려준다. */
export async function runStage(
  repo: string,
  stage: { name: string; command: string },
  logPath: string,
  timeoutSec: number,
): Promise<StageResult> {
  await appendFile(logPath, `\n===== stage: ${stage.name} =====\n$ ${stage.command}\n`, "utf8");

  const proc = Bun.spawn(["bash", "-lc", stage.command], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), Math.max(1, timeoutSec) * 1000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const output = stdout + stderr;
  await appendFile(logPath, `${output}\n[exit ${exitCode}]\n`, "utf8");
  return { name: stage.name, command: stage.command, exitCode, output };
}

/**
 * 작업 하나를 실행하고 장부를 갱신한다.
 *
 * 반환하는 exitCode 가 계약이다:
 *   0 통과(done) / 1 검증 실패(attempts+1) / 2 설정 오류 / 4 한도 도달(blocked)
 * (3 은 '진행 가능 작업 없음' 이라 호출자가 작업 선택 단계에서 낸다.)
 */
export async function runTask(
  repo: string,
  tracker: Tracker,
  task: Task,
  /** `pumpMs` 는 테스트가 하트비트 주기를 줄여 실측하기 위한 것이다(기본은 계약값). */
  opts: { customCmd?: string | null; pumpMs?: number } = {},
): Promise<RunOutcome> {
  const paths = repoPaths(repo);
  const maxAtt = tracker.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  const plan = planStages(tracker, task, opts.customCmd);
  if ("error" in plan) {
    return {
      exitCode: EXIT.USAGE,
      taskId: task.id,
      message: plan.error,
      logFile: null,
      failedStage: null,
      summary: [],
    };
  }

  if ((task.status === "pending" || task.status === "failed") && !task.started_at) {
    task.started_at = nowIso();
  }
  task.status = "in_progress";
  await saveTracker(repo, tracker);
  await writeHeartbeat(repo, "run");

  await mkdir(paths.logs, { recursive: true });
  const logPath = await nextLogPath(paths.logs, task.id);
  await writeFile(logPath, `task=${task.id} title=${task.title} time=${nowIso()}\n`, "utf8");
  const relLog = relative(paths.repo, logPath).replace(/\\/g, "/");

  // 장시간 스테이지 중에도 하트비트를 갱신한다 — 없으면 워치독이 죽은 세션으로 오판한다
  const pump = setInterval(() => void writeHeartbeat(repo, "run"), opts.pumpMs ?? HEARTBEAT_PUMP_MS);

  let failed: StageResult | null = null;
  try {
    for (const stage of plan.stages) {
      const result = await runStage(repo, stage, logPath, tracker.commands?.timeout_sec ?? 1800);
      if (result.exitCode !== 0) {
        failed = result;
        break;
      }
    }
  } finally {
    clearInterval(pump);
  }

  task.last_log_file = relLog;

  if (!failed) {
    task.status = "done";
    task.finished_at = nowIso();
    task.last_error = null;
    await saveTracker(repo, tracker);
    await renderSafe(repo, tracker);
    return {
      exitCode: EXIT.OK,
      taskId: task.id,
      message: `HARNESS RESULT task=${task.id} exit=0 통과 (다음: 커밋 후 다음 작업) log=${relLog}`,
      logFile: relLog,
      failedStage: null,
      summary: [],
    };
  }

  task.attempts += 1;
  const summary = summarize(failed.output);
  task.last_error = `stage=${failed.name}\n${summary.join("\n")}`.slice(0, LAST_ERROR_CAP);

  if (task.attempts >= maxAtt) {
    task.status = "blocked";
    await saveTracker(repo, tracker);
    await renderSafe(repo, tracker);
    return {
      exitCode: EXIT.BLOCKED,
      taskId: task.id,
      message:
        `HARNESS RESULT task=${task.id} exit=4 시도 한도 도달(${task.attempts}/${maxAtt}) — ` +
        `작업 봉인(blocked). 남은 작업이 있으면 다음 작업 계속, 없으면 보고 log=${relLog}`,
      logFile: relLog,
      failedStage: failed.name,
      summary,
    };
  }

  task.status = "failed";
  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  return {
    exitCode: EXIT.FAIL,
    taskId: task.id,
    message:
      `HARNESS RESULT task=${task.id} exit=1 stage=${failed.name} 실패 ` +
      `attempts=${task.attempts}/${maxAtt} log=${relLog}`,
    logFile: relLog,
    failedStage: failed.name,
    summary,
  };
}

/** blocked 만 남은 상태와 아예 없는 상태를 가른다 — v1 의 run 종료 코드 규칙. */
export function noEligibleExit(tracker: Tracker): { exitCode: number; message: string } {
  const counts = statusCounts(tracker);
  if (counts.blocked > 0) {
    return {
      exitCode: EXIT.BLOCKED,
      message: `HARNESS RESULT exit=4 진행 가능 작업 없음 (blocked=${counts.blocked} — 사람 판단 필요)`,
    };
  }
  return {
    exitCode: EXIT.NO_TASK,
    message: `HARNESS RESULT exit=3 진행 가능 작업 없음 ${JSON.stringify(counts)}`,
  };
}
