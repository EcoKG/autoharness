/**
 * 장부 — **진실 원천**. daemon/DESIGN.md 4절의 바뀌지 않는 계약.
 *
 * 선택 규칙·교착 판정·렌더 형식을 v1 과 **문자 단위로** 맞춘다. 두 구현이 같은 장부를
 * 오가고 교차 검증(§7.3)에서 같은 답을 내야 하기 때문이다. 여기서 임의로 "개선"하면
 * 그 순간 마이그레이션 안전성의 근거가 사라진다.
 */
import { atomicWriteJson, atomicWriteText } from "./atomic.ts";
import { loadJson, type LoadState } from "./load.ts";
import { repoPaths } from "./paths.ts";
import {
  isTracker,
  nowIso,
  type Task,
  type TaskStatus,
  type Tracker,
} from "./schema.ts";

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_PRIORITY = 100;
export const DEFAULT_TIMEOUT_SEC = 1800;

export interface Counts {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  blocked: number;
}

export interface TrackerLoad {
  state: LoadState;
  tracker: Tracker | null;
  error: string | null;
}

/** 장부를 읽는다 — 부재와 파손을 구분한다(게이트가 조용히 사라지지 않게). */
export async function loadTracker(repo: string): Promise<TrackerLoad> {
  const r = await loadJson<Tracker>(repoPaths(repo).tracker, isTracker);
  return { state: r.state, tracker: r.value, error: r.error };
}

export async function saveTracker(repo: string, tracker: Tracker): Promise<void> {
  tracker.updated_at = nowIso();
  await atomicWriteJson(repoPaths(repo).tracker, tracker);
}

export function newTask(
  id: string,
  title: string,
  opts: { path?: string | null; deps?: string[]; priority?: number; testCmd?: string | null } = {},
): Task {
  return {
    id,
    title,
    path: opts.path ?? null,
    deps: opts.deps ?? [],
    priority: opts.priority ?? DEFAULT_PRIORITY,
    status: "pending",
    attempts: 0,
    last_error: null,
    last_log_file: null,
    commit: null,
    started_at: null,
    finished_at: null,
    test_cmd: opts.testCmd ?? null,
  };
}

export function findTask(tracker: Tracker, id: string): Task | undefined {
  return tracker.tasks.find((t) => t.id === id);
}

export function statusCounts(tracker: Tracker): Counts {
  const counts: Counts = { pending: 0, in_progress: 0, done: 0, failed: 0, blocked: 0 };
  for (const t of tracker.tasks) {
    if (t.status in counts) counts[t.status] += 1;
  }
  return counts;
}

/** priority 낮은 값 우선, 같으면 id 순 — v1 의 정렬 키와 동일. */
function pick(candidates: readonly Task[]): Task | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const pa = a.priority ?? DEFAULT_PRIORITY;
    const pb = b.priority ?? DEFAULT_PRIORITY;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

/**
 * 선택 규칙: in_progress → 재시도 가능한 failed → deps 전부 done 인 pending.
 * 그룹 순서가 계약이다 — 뒤집으면 재시도 중인 작업이 밀려 자가 치유가 끊긴다.
 */
export function eligibleNext(tracker: Tracker): Task | null {
  const done = new Set(tracker.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const maxAtt = tracker.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  const cur = pick(tracker.tasks.filter((t) => t.status === "in_progress"));
  if (cur) return cur;
  const retry = pick(tracker.tasks.filter((t) => t.status === "failed" && t.attempts < maxAtt));
  if (retry) return retry;
  return pick(
    tracker.tasks.filter((t) => t.status === "pending" && (t.deps ?? []).every((d) => done.has(d))),
  );
}

/**
 * 충족 불가능한 pending — 의존이 미존재·blocked·순환이라 영영 실행될 수 없는 작업.
 *
 * 고정점 계산: done 이거나, blocked 가 아니면서 의존 전부가 '언젠가 done 가능'인 작업을
 * 반복 확장한다. 확장이 끝난 뒤에도 집합 밖에 남은 pending 이 교착이다.
 */
export function deadlockedPending(tracker: Tracker): Task[] {
  const doable = new Set(tracker.tasks.filter((t) => t.status === "done").map((t) => t.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tracker.tasks) {
      if (doable.has(t.id) || t.status === "blocked") continue;
      if ((t.deps ?? []).every((d) => doable.has(d))) {
        doable.add(t.id);
        changed = true;
      }
    }
  }
  return tracker.tasks.filter((t) => t.status === "pending" && !doable.has(t.id));
}

/** 오류 요약의 첫 줄만 — 요약 상자에 전문을 쏟지 않는다(전문은 작업 상세에 있다). */
function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i);
}

/** 왜 이 작업이 막혀 있는가. */
export interface Blocker {
  id: string;
  title: string;
  /** blocked | attempts | deadlock */
  kind: "blocked" | "attempts" | "deadlock";
  /** 사람이 읽을 사유 — 원인 의존까지 이름으로 짚는다. */
  reason: string;
}

/**
 * 막힌 곳 요약 — **판정은 여기서만 한다.**
 *
 * deadlockedPending 은 '누가' 막혔는지만 알려 주고 '왜' 는 말하지 않는다. 화면에서 그
 * 이유를 다시 계산하게 두면 두 곳이 갈라지고, 갈라진 화면이 "정상" 이라고 말하는 순간이
 * 정확히 v1 이 죽은 방식이다. 그래서 사유까지 서버가 만들어 내려보낸다.
 */
export function blockers(tracker: Tracker): Blocker[] {
  const byId = new Map(tracker.tasks.map((t) => [t.id, t]));
  const maxAtt = tracker.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const out: Blocker[] = [];

  for (const t of tracker.tasks) {
    if (t.status === "blocked") {
      out.push({
        id: t.id,
        title: t.title,
        kind: "blocked",
        reason: t.last_error ? `봉인됨 — ${firstLine(t.last_error)}` : "봉인됨",
      });
    } else if (t.status === "failed" && t.attempts >= maxAtt - 1) {
      out.push({
        id: t.id,
        title: t.title,
        kind: "attempts",
        reason: `시도 ${t.attempts}/${maxAtt} — 다음 실패에 봉인됩니다`,
      });
    }
  }

  for (const t of deadlockedPending(tracker)) {
    // 무엇이 이 작업을 붙잡고 있는지 이름으로 짚는다 — "교착" 세 글자로는 손을 못 댄다
    const causes = (t.deps ?? []).map((d) => {
      const dep = byId.get(d);
      if (!dep) return `${d}(장부에 없음)`;
      if (dep.status === "blocked") return `${d}(봉인됨)`;
      if (dep.id === t.id) return `${d}(자기 자신)`;
      return `${d}(${dep.status})`;
    });
    out.push({
      id: t.id,
      title: t.title,
      kind: "deadlock",
      reason: causes.length ? `대기 중 — ${causes.join(", ")}` : "의존이 없는데도 진행 불가",
    });
  }
  return out;
}

export interface AddTaskError {
  ok: false;
  reason: string;
}
export interface AddTaskOk {
  ok: true;
  task: Task;
  /**
   * pending 으로 되돌리면서 시도 횟수를 지웠는가.
   *
   * 되돌리기는 attempts 를 0 으로 만든다(v1 과 같은 규칙이다). 그런데 attempts 야말로
   * "이 작업이 몇 번이나 실패했는가" 를 말해 주는 **유일한 단서**다. 말없이 지우면
   * 봉인 직전이던 작업이 새 작업처럼 보이고, 사람은 같은 실패를 다시 다섯 번 겪는다.
   * 규칙 자체는 계약이라 바꾸지 않는다 — 대신 지웠다는 사실을 알린다.
   */
  attemptsCleared?: number;
}

/**
 * 작업 추가 — 자기 의존·미존재 의존·순환 의존을 거부한다.
 *
 * 교착을 **만들 수 있는 입력을 애초에 막는다**. 이미 들어간 교착은 deadlockedPending 이
 * 알리지만, 새로 만들지 않는 것이 우선이다.
 */
export function addTask(tracker: Tracker, task: Task): AddTaskOk | AddTaskError {
  if (findTask(tracker, task.id)) return { ok: false, reason: `이미 있는 작업 id: ${task.id}` };
  const deps = task.deps ?? [];
  if (deps.includes(task.id)) return { ok: false, reason: `자기 자신을 의존할 수 없습니다: ${task.id}` };

  const known = new Set(tracker.tasks.map((t) => t.id));
  const missing = deps.filter((d) => !known.has(d));
  if (missing.length > 0) {
    return { ok: false, reason: `미존재 의존: ${missing.join(", ")} (선행 작업을 먼저 추가하십시오)` };
  }
  // 순환 검사: 새 작업을 넣었다고 가정하고 deps 를 따라가 자기에게 돌아오는지 본다
  const byId = new Map(tracker.tasks.map((t) => [t.id, t] as const));
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === task.id) return { ok: false, reason: `순환 의존이 생깁니다: ${task.id}` };
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byId.get(cur)?.deps ?? []));
  }
  tracker.tasks.push(task);
  return { ok: true, task };
}

/** 상태 조작은 pending/blocked 만 — done 은 run 성공으로만 생긴다(검증 무결성). */
export const SETTABLE_STATUSES: readonly TaskStatus[] = ["pending", "blocked"];

export function setTaskStatus(task: Task, status: TaskStatus): AddTaskOk | AddTaskError {
  if (!SETTABLE_STATUSES.includes(status)) {
    return {
      ok: false,
      reason: `set-task 로 지정할 수 없는 상태입니다: ${status} (허용: ${SETTABLE_STATUSES.join(", ")})`,
    };
  }
  task.status = status;
  if (status !== "pending") return { ok: true, task };
  const cleared = task.attempts;
  task.attempts = 0;
  return cleared > 0 ? { ok: true, task, attemptsCleared: cleared } : { ok: true, task };
}

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "⏳",
  in_progress: "🔧",
  done: "✅",
  failed: "❌",
  blocked: "⛔",
};

/** PROGRESS.md 렌더 — v1 과 같은 형식이어야 두 구현이 오갈 때 무의미한 diff 가 없다. */
export function renderProgress(tracker: Tracker, at: string = nowIso()): string {
  const c = statusCounts(tracker);
  const total = tracker.tasks.length;
  const maxAtt = tracker.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const rows = [...tracker.tasks]
    .sort((a, b) => {
      const pa = a.priority ?? DEFAULT_PRIORITY;
      const pb = b.priority ?? DEFAULT_PRIORITY;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((t) => {
      const note = (t.last_error ?? "").replace(/\n/g, " ").slice(0, 80);
      return `| ${t.id} | ${t.title} | ${STATUS_ICON[t.status] ?? ""} ${t.status} | ${t.attempts}/${maxAtt} | ${t.commit || "-"} | ${note || "-"} |`;
    });

  return (
    `# PROGRESS — ${tracker.project ?? ""}\n\n` +
    "> 자동 생성 파일입니다(`.claude/agent_tracker.json` 렌더링). 직접 수정하지 마세요.\n\n" +
    `- 목표: ${tracker.objective ?? ""}\n` +
    `- 이식: ${tracker.source_stack ?? ""} → ${tracker.target_stack ?? ""}\n` +
    `- 모델: ${tracker.model ?? ""} / 갱신: ${at}\n\n` +
    `## 현황: done ${c.done} / ${total}  (in_progress ${c.in_progress}, failed ${c.failed}, blocked ${c.blocked}, pending ${c.pending})\n\n` +
    "| ID | 제목 | 상태 | 시도 | 커밋 | 비고 |\n|---|---|---|---|---|---|\n" +
    `${rows.join("\n")}\n`
  );
}

/**
 * PROGRESS.md 를 쓴다 — **실패가 검증 결과 판정을 뒤집지 않게** 격리한다.
 *
 * PROGRESS.md 는 장부에서 파생된 표시물이다. 그 쓰기가 실패했다고 통과한 검증이 실패로
 * 보고되면 결과가 거짓이 된다(v1 에서 실제로 겪은 결함).
 */
export async function renderSafe(repo: string, tracker: Tracker): Promise<boolean> {
  try {
    await atomicWriteText(repoPaths(repo).progress, renderProgress(tracker));
    return true;
  } catch (err) {
    process.stderr.write(
      `[AutoHarness] PROGRESS.md 렌더 실패(검증 결과에는 영향 없음): ${String(err)}\n`,
    );
    return false;
  }
}

export function createTracker(init: {
  project: string;
  objective: string;
  source: string;
  target: string;
  test: string;
  build?: string | null;
  lint?: string | null;
  model?: string;
  maxAttempts?: number;
  timeoutSec?: number;
}): Tracker {
  const at = nowIso();
  return {
    schema_version: 1,
    project: init.project,
    objective: init.objective,
    source_stack: init.source,
    target_stack: init.target,
    model: init.model ?? "claude-opus-5",
    commands: {
      build: init.build ?? null,
      test: init.test,
      lint: init.lint ?? null,
      timeout_sec: init.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    },
    max_attempts: init.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    created_at: at,
    updated_at: at,
    tasks: [],
  };
}

/** 하트비트 — 실패해도 죽지 않되 **침묵하지 않는다**(워치독의 이중 기동 방지 근거다). */
export async function writeHeartbeat(repo: string, source: string): Promise<void> {
  try {
    await atomicWriteJson(repoPaths(repo).heartbeat, {
      ts: nowIso(),
      pid: process.pid,
      source,
    });
  } catch (err) {
    process.stderr.write(`[AutoHarness] 하트비트 기록 실패(${source}): ${String(err)}\n`);
  }
}
