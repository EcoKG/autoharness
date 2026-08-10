/**
 * CLI 모드 구현 — v1 엔진 서브커맨드 대응.
 *
 * selftest 가 실제 종료 코드를 검증하려면 CLI 가 먼저 있어야 한다(v1 selftest 도
 * 엔진을 서브프로세스로 띄워 종료 코드를 본다). 그래서 이미 이식된 장부·러너 위에
 * 해당 모드를 여기서 배선한다.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";

import { EXIT } from "./exit.ts";
import {
  addTask,
  createTracker,
  deadlockedPending,
  eligibleNext,
  findTask,
  loadTracker,
  newTask,
  renderSafe,
  saveTracker,
  setConfig,
  setTaskStatus,
  updateTaskPlan,
  statusCounts,
  writeHeartbeat,
} from "./core/ledger.ts";
import { repoPaths } from "./core/paths.ts";
import { noEligibleExit, runTask } from "./core/runner.ts";
import { isTaskStatus, type Tracker } from "./core/schema.ts";

export interface Flags {
  readonly [key: string]: string | boolean | undefined;
}

/** `--key value` 와 `--flag` 를 받는 최소 파서. 값이 `--` 로 시작하면 플래그로 본다. */
export function parseFlags(argv: readonly string[]): Flags {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function fail(message: string): number {
  process.stderr.write(`[autoharness] ${message}\n`);
  return EXIT.USAGE;
}

/** 장부를 요구하는 모드의 공통 진입 — 부재와 파손을 구분해 알린다. */
async function requireTracker(repo: string): Promise<Tracker | number> {
  const r = await loadTracker(repo);
  if (r.state === "missing") {
    return fail("장부(.claude/agent_tracker.json)가 없습니다. 먼저 init 을 실행하십시오.");
  }
  if (r.state === "corrupt" || !r.tracker) {
    return fail(`장부가 파손됐습니다: ${r.error ?? "알 수 없는 오류"}`);
  }
  return r.tracker;
}

export async function cmdInit(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const required = ["project", "objective", "source", "target", "test"] as const;
  for (const key of required) {
    if (!str(flags, key)) return fail(`--${key} 가 필요합니다`);
  }
  const existing = await loadTracker(repo);
  if (existing.state === "ok" && !flags["force"]) {
    return fail("이미 장부가 있습니다. 재초기화는 진행 상태를 파괴합니다 (--force 로 강제).");
  }
  const tracker = createTracker({
    project: str(flags, "project")!,
    objective: str(flags, "objective")!,
    source: str(flags, "source")!,
    target: str(flags, "target")!,
    test: str(flags, "test")!,
    build: str(flags, "build") ?? null,
    lint: str(flags, "lint") ?? null,
    model: str(flags, "model") ?? "claude-opus-5",
    maxAttempts: Number(str(flags, "max-attempts") ?? 5),
    timeoutSec: Number(str(flags, "timeout-sec") ?? 1800),
  });
  const paths = repoPaths(repo);
  await mkdir(paths.logs, { recursive: true });
  await saveTracker(repo, tracker);
  await writeFile(paths.example, `${JSON.stringify(tracker, null, 2)}\n`, "utf8");
  await renderSafe(repo, tracker);
  console.log(JSON.stringify({ ok: true, tracker: paths.tracker }, null, 2));
  return EXIT.OK;
}

export async function cmdAddTask(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const id = str(flags, "id");
  const title = str(flags, "title");
  if (!id || !title) return fail("--id 와 --title 이 필요합니다");
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;

  const depsRaw = str(flags, "deps") ?? "";
  const task = newTask(id, title, {
    path: str(flags, "path") ?? null,
    deps: depsRaw ? depsRaw.split(",").map((d) => d.trim()).filter(Boolean) : [],
    priority: Number(str(flags, "priority") ?? 100),
    testCmd: str(flags, "test-cmd") ?? null,
  });
  const r = addTask(tracker, task);
  if (!r.ok) return fail(r.reason);
  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  console.log(JSON.stringify({ ok: true, id }, null, 2));
  return EXIT.OK;
}

export async function cmdSetTask(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const id = str(flags, "id");
  if (!id) return fail("--id 가 필요합니다");
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;
  const task = findTask(tracker, id);
  if (!task) return fail(`작업 없음: ${id}`);

  const status = str(flags, "status");
  if (status !== undefined) {
    if (!isTaskStatus(status)) return fail(`알 수 없는 상태: ${status}`);
    const r = setTaskStatus(task, status);
    if (!r.ok) return fail(r.reason);
    // 시도 횟수를 지웠으면 말한다 — 그 숫자가 "몇 번 실패했는가" 의 유일한 단서다
    if (r.attemptsCleared) {
      console.log(`[주의] ${task.id}: 시도 횟수 ${r.attemptsCleared} → 0 으로 초기화했습니다.`);
    }
  }
  // 우선순위·의존을 나중에 바꾼다 — 인자 추가라 기존 사용법은 그대로다
  const plan: { priority?: number; deps?: string[] } = {};
  const priority = str(flags, "priority");
  if (priority !== undefined) plan.priority = Number(priority);
  const deps = str(flags, "deps");
  if (deps !== undefined) plan.deps = deps === "" ? [] : deps.split(",").map((d) => d.trim()).filter(Boolean);
  if (plan.priority !== undefined || plan.deps !== undefined) {
    const r = updateTaskPlan(tracker, task, plan);
    if (!r.ok) return fail(r.reason);
  }

  const note = str(flags, "note");
  if (note !== undefined) task.last_error = note;
  const testCmd = flags["test-cmd"];
  if (typeof testCmd === "string") task.test_cmd = testCmd === "" ? null : testCmd;

  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  console.log(JSON.stringify(
    { ok: true, id, status: task.status, priority: task.priority, deps: task.deps },
    null,
    2,
  ));
  return EXIT.OK;
}

/**
 * 검증 명령·한도 변경.
 *
 * `--try` 를 주면 **저장하기 전에 그 명령을 한 번 돌려 본다.** 검증 명령을 잘못 넣으면 그
 * 뒤 모든 작업이 실패하는데, 그 사실은 다음 주행에서야 드러난다. 여기서 종료 코드를 보고
 * 저장 여부를 정할 수 있어야 한다.
 */
export async function cmdSetConfig(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;

  const change: Parameters<typeof setConfig>[1] = {};
  const test = str(flags, "test");
  if (test !== undefined) change.test = test;
  const build = str(flags, "build");
  if (build !== undefined) change.build = build;
  const lint = str(flags, "lint");
  if (lint !== undefined) change.lint = lint;
  const timeout = str(flags, "timeout");
  if (timeout !== undefined) change.timeoutSec = Number(timeout);
  const maxAttempts = str(flags, "max-attempts");
  if (maxAttempts !== undefined) change.maxAttempts = Number(maxAttempts);

  // 시험 실행은 저장 전에 한다 — 통과 기준을 깨뜨린 채 저장하지 않기 위해서다
  if (flags["try"] === true && change.test !== undefined) {
    console.log(`[시험 실행] ${change.test}`);
    const proc = Bun.spawn(["bash", "-lc", change.test], { cwd: repo, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      return fail(`시험 실행이 종료 코드 ${code} 로 끝났습니다 — 저장하지 않았습니다.`);
    }
    console.log("[시험 실행] 통과");
  }

  const r = setConfig(tracker, change);
  if (!r.ok) return fail(r.reason ?? "설정을 바꾸지 못했습니다");
  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  console.log(JSON.stringify(
    { ok: true, changed: r.changed, commands: tracker.commands, max_attempts: tracker.max_attempts },
    null,
    2,
  ));
  return EXIT.OK;
}

export async function cmdNext(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;
  const task = eligibleNext(tracker);
  const dead = deadlockedPending(tracker).map((t) => t.id);
  if (!task) {
    const out: Record<string, unknown> = { next: null, counts: statusCounts(tracker) };
    if (dead.length > 0) out["deadlocked"] = dead;
    console.log(JSON.stringify(out, null, 2));
    return EXIT.NO_TASK;
  }
  const out: Record<string, unknown> = { next: task };
  if (dead.length > 0) out["deadlocked"] = dead;
  console.log(JSON.stringify(out, null, 2));
  return EXIT.OK;
}

export async function cmdStatus(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;
  const hb = await Bun.file(repoPaths(repo).heartbeat)
    .json()
    .catch(() => null);
  const { hookWiringStatus } = await import("./hooks/wiring.ts");
  console.log(
    JSON.stringify(
      {
        project: tracker.project,
        model: tracker.model,
        counts: statusCounts(tracker),
        next: eligibleNext(tracker),
        deadlocked: deadlockedPending(tracker).map((t) => t.id),
        heartbeat: hb,
        hooks: await hookWiringStatus(repo, tracker),
        paused: await Bun.file(repoPaths(repo).pausedFlag).exists(),
      },
      null,
      2,
    ),
  );
  return EXIT.OK;
}

export async function cmdDetect(flags: Flags): Promise<number> {
  const { detect } = await import("./core/detect.ts");
  try {
    console.log(JSON.stringify(await detect(str(flags, "repo") ?? "."), null, 2));
    return EXIT.OK;
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
}

export async function cmdModelRecommend(flags: Flags): Promise<number> {
  const { modelRecommend } = await import("./core/model.ts");
  const result = await modelRecommend({
    repo: str(flags, "repo") ?? null,
    source: str(flags, "source") ?? null,
    target: str(flags, "target") ?? null,
    notes: str(flags, "notes") ?? null,
  });
  console.log(JSON.stringify(result, null, 2));
  return EXIT.OK;
}

export async function cmdSyncCommit(flags: Flags): Promise<number> {
  const { syncCommit } = await import("./hooks/hooks.ts");
  const sha = await syncCommit(str(flags, "repo") ?? ".", false);
  console.log(JSON.stringify({ ok: sha !== null, commit: sha }));
  return EXIT.OK;
}

export async function cmdRender(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;
  await renderSafe(repo, tracker);
  console.log("PROGRESS.md 재렌더 완료");
  return EXIT.OK;
}

export async function cmdHeartbeat(flags: Flags): Promise<number> {
  await writeHeartbeat(str(flags, "repo") ?? ".", "manual");
  console.log(JSON.stringify({ ok: true }));
  return EXIT.OK;
}

export async function cmdRun(flags: Flags): Promise<number> {
  const repo = str(flags, "repo") ?? ".";
  const tracker = await requireTracker(repo);
  if (typeof tracker === "number") return tracker;

  // 훅 배선이 끊겼으면 경고만 하고 계속 진행한다(fail-open — 주행을 막지 않는다)
  const { hookWiringStatus } = await import("./hooks/wiring.ts");
  const wiring = await hookWiringStatus(repo, tracker);
  if (wiring.warning) process.stderr.write(`${wiring.warning}\n`);

  const wanted = str(flags, "task");
  const customCmd = str(flags, "cmd") ?? null;
  let task = wanted ? findTask(tracker, wanted) : (eligibleNext(tracker) ?? undefined);

  if (wanted && !task) return fail(`작업 없음: ${wanted}`);
  if (!task) {
    const r = noEligibleExit(tracker);
    console.log(r.message);
    return r.exitCode;
  }
  if (wanted) {
    if (task.status === "blocked") {
      console.log(`HARNESS RESULT task=${task.id} exit=4 (이미 blocked — 사람 판단 필요)`);
      return EXIT.BLOCKED;
    }
    if (task.status === "done" && !customCmd) return fail(`이미 done 인 작업입니다: ${task.id}`);
    if (task.status === "pending") {
      const done = new Set(tracker.tasks.filter((t) => t.status === "done").map((t) => t.id));
      const missing = (task.deps ?? []).filter((d) => !done.has(d));
      if (missing.length > 0) return fail(`선행 작업 미완료: ${task.id} → ${missing.join(", ")}`);
    }
  }

  const outcome = await runTask(repo, tracker, task, { customCmd });
  console.log(outcome.message);
  for (const line of outcome.summary.slice(0, outcome.exitCode === EXIT.BLOCKED ? 10 : undefined)) {
    console.log(`  ${line}`);
  }
  return outcome.exitCode;
}

/** 테스트·selftest 가 임시 저장소를 정리할 때 쓴다. */
export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
