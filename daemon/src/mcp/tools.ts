/**
 * MCP 도구 14종 — **이름과 입출력은 외부 계약이다**(daemon/DESIGN.md 4절).
 *
 * 이름을 바꾸면 이미 설치된 스킬 문서·사용자 습관이 전부 어긋난다. 그래서 v2 로 오면서
 * 내부 구현이 통째로 바뀐 도구(`watchdog_*`)도 **이름은 그대로 둔다** — 의미만 바뀐다
 * (OS 스케줄러 등록 → 데몬 로그온 자동 시작).
 *
 * 핸들러는 예외를 던져도 된다. 서버가 잡아 `isError` 응답으로 바꾸므로 프로토콜 루프는
 * 죽지 않는다. 다만 **미구현을 성공으로 보고하지는 않는다**: 아직 substrate 가 없는 도구는
 * ToolError 로 그 사실을 밝힌다.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";

import { EXIT } from "../exit.ts";
import { detect } from "../core/detect.ts";
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
  setTaskStatus,
  statusCounts,
  writeHeartbeat,
} from "../core/ledger.ts";
import { ALLOWED_MODELS, modelRecommend } from "../core/model.ts";
import { repoPaths, userPaths } from "../core/paths.ts";
import {
  findProject,
  loadRegistryChecked,
  mutateRegistry,
  reactivateIfCompleted,
  upsertProject,
} from "../core/registry.ts";
import { noEligibleExit, runTask } from "../core/runner.ts";
import { isTaskStatus, nowIso } from "../core/schema.ts";
import { hookWiringStatus } from "../hooks/wiring.ts";
import { mergeSettings } from "../install/settings.ts";

export class ToolError extends Error {}

export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs) => Promise<unknown>;

function requireStr(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`필수 인자 누락: ${key}`);
  return v;
}

function optStr(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function optInt(args: ToolArgs, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 장부를 요구하는 도구의 공통 진입 — 부재와 파손을 구분해 알린다. */
async function requireTracker(repo: string) {
  const r = await loadTracker(repo);
  if (r.state === "missing") {
    throw new ToolError(`장부가 없습니다: ${repoPaths(repo).tracker} — 먼저 harness_init 을 실행하십시오.`);
  }
  if (r.state === "corrupt" || !r.tracker) {
    throw new ToolError(`장부가 파손됐습니다: ${repoPaths(repo).tracker} (${r.error ?? "원인 불명"})`);
  }
  return r.tracker;
}

const PERMISSION_ARGS: Record<string, string[]> = {
  bypass: ["--permission-mode", "bypassPermissions"],
  acceptEdits: ["--permission-mode", "acceptEdits"],
};

export const toolHarnessDetect: ToolHandler = async (a) => detect(requireStr(a, "repo_path"));

export const toolHarnessInit: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  const model = optStr(a, "model") ?? "claude-opus-5";
  if (!ALLOWED_MODELS.includes(model)) {
    throw new ToolError(`model 은 ${ALLOWED_MODELS.join(" | ")} 중 하나여야 합니다`);
  }
  const permissionMode = optStr(a, "permission_mode") ?? "bypass";
  const permissionArgs = PERMISSION_ARGS[permissionMode];
  if (!permissionArgs) throw new ToolError("permission_mode 는 bypass | acceptEdits 중 하나여야 합니다");

  const existing = await loadTracker(repo);
  if (existing.state === "ok") {
    throw new ToolError(
      `이미 장부가 있습니다: ${repoPaths(repo).tracker} — 재초기화는 진행 상태를 파괴합니다. ` +
        "새 목표를 줄 때는 task_add + resume 경로를 쓰십시오.",
    );
  }

  const tracker = createTracker({
    project: requireStr(a, "project"),
    objective: requireStr(a, "objective"),
    source: requireStr(a, "source_stack"),
    target: requireStr(a, "target_stack"),
    test: requireStr(a, "test_cmd"),
    build: optStr(a, "build_cmd") ?? null,
    lint: optStr(a, "lint_cmd") ?? null,
    model,
    maxAttempts: optInt(a, "max_attempts", 5),
  });

  const paths = repoPaths(repo);
  await mkdir(paths.logs, { recursive: true });
  await saveTracker(repo, tracker);
  await writeFile(paths.example, `${JSON.stringify(tracker, null, 2)}\n`, "utf8");
  await renderSafe(repo, tracker);
  const settings = await mergeSettings(repo);
  const entry = await mutateRegistry((reg) =>
    upsertProject(reg, { id: tracker.project, repo, model, permissionArgs }),
  );

  return { ok: true, tracker: paths.tracker, settings, registry_entry: entry };
};

export const toolHarnessStatus: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  const tracker = await requireTracker(repo);
  const hb = await Bun.file(repoPaths(repo).heartbeat).json().catch(() => null);
  const reg = await loadRegistryChecked();
  return {
    project: tracker.project,
    model: tracker.model,
    objective: tracker.objective,
    counts: statusCounts(tracker),
    next: eligibleNext(tracker),
    deadlocked: deadlockedPending(tracker).map((t) => t.id),
    heartbeat: hb,
    hooks: await hookWiringStatus(repo, tracker),
    paused: await Bun.file(repoPaths(repo).pausedFlag).exists(),
    registry_state: reg.state,
    registry_entry: findProject(reg.registry, repo) ?? null,
  };
};

export const toolHarnessRun: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  const tracker = await requireTracker(repo);
  const wanted = optStr(a, "task_id");
  const customCmd = optStr(a, "cmd") ?? null;

  const task = wanted ? findTask(tracker, wanted) : (eligibleNext(tracker) ?? undefined);
  if (wanted && !task) throw new ToolError(`작업 없음: ${wanted}`);
  if (!task) {
    const r = noEligibleExit(tracker);
    return { exit_code: r.exitCode, message: r.message, task: null };
  }
  if (wanted && task.status === "blocked") {
    return {
      exit_code: EXIT.BLOCKED,
      message: `HARNESS RESULT task=${task.id} exit=4 (이미 blocked — 사람 판단 필요)`,
      task,
    };
  }

  const outcome = await runTask(repo, tracker, task, { customCmd });
  return {
    exit_code: outcome.exitCode,
    message: outcome.message,
    summary: outcome.summary,
    task: findTask(tracker, task.id) ?? task,
  };
};

export const toolTaskAdd: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  const tracker = await requireTracker(repo);
  const rawDeps = a["deps"];
  const task = newTask(requireStr(a, "id"), requireStr(a, "title"), {
    path: optStr(a, "path") ?? null,
    deps: Array.isArray(rawDeps) ? rawDeps.map(String) : [],
    priority: optInt(a, "priority", 100),
    testCmd: optStr(a, "test_cmd") ?? null,
  });
  const r = addTask(tracker, task);
  if (!r.ok) throw new ToolError(r.reason);
  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  // 할 일이 생겼으면 완료로 봉인된 프로젝트를 되살린다 — 그러지 않으면 영영 안 뜬다
  const reactivated = await reactivateRegistrySafely(repo);
  return { ok: true, id: task.id, reactivated };
};

/**
 * 재활성화는 **부수 효과**다 — 레지스트리가 파손됐다고 작업 추가까지 실패시키지 않는다.
 * 다만 조용히 넘기지도 않는다: 결과에 사유를 실어 사람이 볼 수 있게 한다.
 */
async function reactivateRegistrySafely(repo: string): Promise<boolean | string> {
  try {
    return await mutateRegistry((reg) => reactivateIfCompleted(reg, repo));
  } catch (err) {
    return `레지스트리 갱신 실패(작업은 추가됨): ${String(err)}`;
  }
}

export const toolTaskSet: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  const tracker = await requireTracker(repo);
  const id = requireStr(a, "id");
  const task = findTask(tracker, id);
  if (!task) throw new ToolError(`작업 없음: ${id}`);

  const status = optStr(a, "status");
  if (status !== undefined) {
    if (!isTaskStatus(status)) throw new ToolError(`알 수 없는 상태: ${status}`);
    const r = setTaskStatus(task, status);
    if (!r.ok) throw new ToolError(r.reason);
  }
  const note = optStr(a, "note");
  if (note !== undefined) task.last_error = note;
  const testCmd = a["test_cmd"];
  if (typeof testCmd === "string") task.test_cmd = testCmd === "" ? null : testCmd;

  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  // pending 으로 되돌린 것도 '할 일이 생김'이다 — MCP 경로에만 재활성화가 걸려 있던 비대칭을 없앤다
  const reactivated = eligibleNext(tracker) ? await reactivateRegistrySafely(repo) : false;
  return { ok: true, id, status: task.status, reactivated };
};

export const toolHarnessPause: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  await mkdir(repoPaths(repo).claudeDir, { recursive: true });
  await writeFile(repoPaths(repo).pausedFlag, "", "utf8");
  const changed = await mutateRegistry((reg) => {
    const entry = findProject(reg, repo);
    if (!entry) return false;
    entry.status = "paused";
    entry.updated_at = nowIso();
    return true;
  });
  return { ok: true, paused: true, flag: repoPaths(repo).pausedFlag, registry_updated: changed };
};

export const toolHarnessResumeProject: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  await rm(repoPaths(repo).pausedFlag, { force: true });
  const changed = await mutateRegistry((reg) => {
    const entry = findProject(reg, repo);
    if (!entry) return false;
    entry.status = "active";
    entry.consecutive_errors = 0;
    entry.limit_hits = 0;
    entry.next_retry_at = null;
    entry.updated_at = nowIso();
    return true;
  });
  return { ok: true, paused: false, registry_updated: changed };
};

export const toolModelRecommend: ToolHandler = async (a) =>
  modelRecommend({
    repo: optStr(a, "repo_path") ?? null,
    source: optStr(a, "source_stack") ?? null,
    target: optStr(a, "target_stack") ?? null,
    notes: optStr(a, "notes") ?? null,
  });

export const toolModelSet: ToolHandler = async (a) => {
  const repo = requireStr(a, "repo_path");
  const model = requireStr(a, "model");
  if (!ALLOWED_MODELS.includes(model)) {
    throw new ToolError(`model 은 ${ALLOWED_MODELS.join(" | ")} 중 하나여야 합니다`);
  }
  const tracker = await requireTracker(repo);
  tracker.model = model;
  await saveTracker(repo, tracker);
  await renderSafe(repo, tracker);
  const changed = await mutateRegistry((reg) => {
    const entry = findProject(reg, repo);
    if (!entry) return false;
    entry.model = model;
    entry.updated_at = nowIso();
    return true;
  });
  return { ok: true, model, registry_updated: changed };
};

export const toolHeartbeat: ToolHandler = async (a) => {
  await writeHeartbeat(requireStr(a, "repo_path"), "mcp");
  return { ok: true };
};

/**
 * v2 에서 `watchdog_install` 은 **데몬 로그온 자동 시작 등록**을 뜻한다(도구 이름은 계약이라 유지).
 * OS 등록과 데몬 모드는 후속 작업(ts-install-autostart, ts-scheduler)이 만든다 — 그전까지
 * 성공을 흉내 내지 않고 상태를 그대로 밝힌다.
 */
export const toolWatchdogInstall: ToolHandler = async (a) => {
  const interval = optInt(a, "interval_minutes", 15);
  if (interval < 1 || interval > 1439) {
    throw new ToolError(`interval_minutes 는 1~1439 사이여야 합니다: ${interval}`);
  }
  const { installedExePath } = await import("../install/install.ts");
  const { registerAutostart } = await import("../install/autostart.ts");
  const exePath = installedExePath();
  const r = await registerAutostart({ exePath });
  if (!r.ok) throw new ToolError(`${r.mechanism}: ${r.detail}`);
  // tick 간격은 이제 OS 가 아니라 데몬이 쥔다 — 레지스트리에 남겨 데몬이 읽게 한다
  await mutateRegistry((reg) => {
    reg.settings.watchdog_installed_at = nowIso();
    reg.settings.watchdog_interval_minutes = interval;
  });
  return { ok: true, mechanism: r.mechanism, exe: exePath, interval_minutes: interval, detail: r.detail };
};

export const toolWatchdogUninstall: ToolHandler = async () => {
  const { unregisterAutostart } = await import("../install/autostart.ts");
  const r = await unregisterAutostart();
  return { ok: r.ok, mechanism: r.mechanism, detail: r.detail };
};

/**
 * 워치독(데몬) 상태 — **등록 여부와 실제 실행 이력을 분리해 본다.**
 * v1 이 "등록됨(Ready)"만 보고하다 몇 주째 죽은 워치독을 정상이라 말한 자리다.
 */
export const toolWatchdogStatus: ToolHandler = async () => {
  const paths = userPaths();
  const reg = await loadRegistryChecked();
  const lastTick = reg.registry.last_tick ?? null;
  const logFile = Bun.file(paths.daemonLog);
  const logExists = await logFile.exists();
  const tail = logExists ? (await logFile.text()).split("\n").filter(Boolean).slice(-20) : [];
  const neverLaunched = reg.registry.projects.every((p) => !p.last_launch?.ts);

  const warnings: string[] = [];
  if (reg.state === "corrupt") {
    warnings.push(`레지스트리가 파손됐습니다: ${paths.registry} (${reg.error ?? "원인 불명"})`);
  }
  if (!lastTick && !logExists) {
    warnings.push(
      "데몬이 한 번도 tick 을 돌린 흔적이 없습니다 — 등록만 되고 실행되지 않는 상태일 수 " +
        "있습니다(v1 에서 실제로 몇 주간 그랬습니다).",
    );
  }
  if (neverLaunched && reg.registry.projects.length > 0) {
    warnings.push("등록된 프로젝트 전부 last_launch 가 비어 있습니다 — 한 번도 기동된 적이 없습니다.");
  }

  return {
    registry_state: reg.state,
    registry_path: paths.registry,
    last_tick: lastTick,
    daemon_log: logExists ? paths.daemonLog : null,
    log_tail: tail,
    projects: reg.registry.projects.map((p) => ({
      id: p.id, repo: p.repo, status: p.status, model: p.model,
      consecutive_errors: p.consecutive_errors, limit_hits: p.limit_hits,
      next_retry_at: p.next_retry_at, last_launch: p.last_launch,
    })),
    warnings,
  };
};

export const HANDLERS: Record<string, ToolHandler> = {
  harness_detect: toolHarnessDetect,
  harness_init: toolHarnessInit,
  harness_status: toolHarnessStatus,
  harness_run: toolHarnessRun,
  task_add: toolTaskAdd,
  task_set: toolTaskSet,
  harness_pause: toolHarnessPause,
  harness_resume_project: toolHarnessResumeProject,
  model_recommend: toolModelRecommend,
  model_set: toolModelSet,
  heartbeat: toolHeartbeat,
  watchdog_install: toolWatchdogInstall,
  watchdog_uninstall: toolWatchdogUninstall,
  watchdog_status: toolWatchdogStatus,
};
