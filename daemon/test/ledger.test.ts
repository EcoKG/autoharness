/**
 * 장부 계약 테스트 — v1 의 회귀 의도를 그대로 옮긴다.
 *
 * 선택 규칙과 교착 판정은 **교차 검증(daemon/DESIGN.md 7.3)의 대상**이라 v1 과 답이
 * 같아야 한다. 여기서 편의로 규칙을 바꾸면 마이그레이션 안전성의 근거가 사라진다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_ATTEMPTS,
  addTask,
  createTracker,
  deadlockedPending,
  eligibleNext,
  findTask,
  loadTracker,
  newTask,
  renderProgress,
  renderSafe,
  saveTracker,
  setTaskStatus,
  statusCounts,
  writeHeartbeat,
} from "../src/core/ledger.ts";
import { repoPaths } from "../src/core/paths.ts";
import type { Task, TaskStatus, Tracker } from "../src/core/schema.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-ledger-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tracker(tasks: Partial<Task>[] = []): Tracker {
  const t = createTracker({
    project: "p",
    objective: "o",
    source: "A",
    target: "B",
    test: "echo ok",
  });
  t.tasks = tasks.map((spec, i) => ({ ...newTask(spec.id ?? `t${i}`, spec.title ?? "제목"), ...spec }));
  return t;
}

describe("선택 규칙 — 그룹 순서가 계약이다", () => {
  test("in_progress 가 최우선", () => {
    const t = tracker([
      { id: "a", status: "pending", priority: 1 },
      { id: "b", status: "in_progress", priority: 99 },
    ]);
    expect(eligibleNext(t)?.id).toBe("b");
  });

  test("in_progress 가 없으면 재시도 가능한 failed", () => {
    const t = tracker([
      { id: "a", status: "pending", priority: 1 },
      { id: "b", status: "failed", attempts: 1, priority: 99 },
    ]);
    expect(eligibleNext(t)?.id).toBe("b");
  });

  test("한도에 도달한 failed 는 건너뛴다", () => {
    const t = tracker([
      { id: "a", status: "pending", priority: 50 },
      { id: "b", status: "failed", attempts: DEFAULT_MAX_ATTEMPTS },
    ]);
    expect(eligibleNext(t)?.id).toBe("a");
  });

  test("pending 은 deps 가 전부 done 이어야 한다", () => {
    const t = tracker([
      { id: "core", status: "pending" },
      { id: "top", status: "pending", deps: ["core"], priority: 1 },
    ]);
    expect(eligibleNext(t)?.id).toBe("core");
    findTask(t, "core")!.status = "done";
    expect(eligibleNext(t)?.id).toBe("top");
  });

  test("같은 그룹에서는 priority 낮은 값, 그다음 id 순", () => {
    const t = tracker([
      { id: "b", status: "pending", priority: 10 },
      { id: "a", status: "pending", priority: 10 },
      { id: "c", status: "pending", priority: 5 },
    ]);
    expect(eligibleNext(t)?.id).toBe("c");
    findTask(t, "c")!.status = "done";
    expect(eligibleNext(t)?.id).toBe("a"); // 동률이면 id 순
  });

  test("진행 가능 작업이 없으면 null", () => {
    expect(eligibleNext(tracker([{ id: "a", status: "done" }]))).toBeNull();
    expect(eligibleNext(tracker([{ id: "a", status: "blocked" }]))).toBeNull();
    expect(eligibleNext(tracker())).toBeNull();
  });
});

describe("교착 판정", () => {
  test("미존재 의존은 교착", () => {
    const t = tracker([{ id: "a", status: "pending", deps: ["없음"] }]);
    expect(deadlockedPending(t).map((x) => x.id)).toEqual(["a"]);
  });

  test("순환 의존은 둘 다 교착", () => {
    const t = tracker([
      { id: "a", status: "pending", deps: ["b"] },
      { id: "b", status: "pending", deps: ["a"] },
    ]);
    expect(deadlockedPending(t).map((x) => x.id).sort()).toEqual(["a", "b"]);
  });

  test("blocked 에 의존하면 교착", () => {
    const t = tracker([
      { id: "sealed", status: "blocked" },
      { id: "a", status: "pending", deps: ["sealed"] },
    ]);
    expect(deadlockedPending(t).map((x) => x.id)).toEqual(["a"]);
  });

  test("정상 사슬은 교착이 아니다", () => {
    const t = tracker([
      { id: "a", status: "done" },
      { id: "b", status: "pending", deps: ["a"] },
      { id: "c", status: "pending", deps: ["b"] },
    ]);
    expect(deadlockedPending(t)).toEqual([]);
  });
});

describe("작업 추가 — 교착을 만들 입력을 막는다", () => {
  test("정상 추가", () => {
    const t = tracker();
    expect(addTask(t, newTask("a", "제목")).ok).toBe(true);
    expect(t.tasks).toHaveLength(1);
  });

  test("중복 id 거부", () => {
    const t = tracker([{ id: "a" }]);
    const r = addTask(t, newTask("a", "또"));
    expect(r.ok).toBe(false);
  });

  test("자기 의존 거부", () => {
    const t = tracker();
    const r = addTask(t, newTask("a", "제목", { deps: ["a"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("자기 자신");
  });

  test("미존재 의존 거부", () => {
    const t = tracker();
    const r = addTask(t, newTask("a", "제목", { deps: ["없음"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("미존재");
    expect(t.tasks).toHaveLength(0); // 거부됐으면 들어가지 않아야 한다
  });

  test("순환이 생기는 추가 거부", () => {
    const t = tracker();
    addTask(t, newTask("a", "A"));
    findTask(t, "a")!.deps = ["b"]; // a→b 를 손으로 만들어 두고
    const r = addTask(t, newTask("b", "B", { deps: ["a"] })); // b→a 를 추가하면 순환
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("순환");
  });
});

describe("상태 조작 — done 은 run 성공으로만 생긴다", () => {
  test("pending/blocked 만 허용", () => {
    const t = newTask("a", "제목");
    expect(setTaskStatus(t, "blocked").ok).toBe(true);
    expect(setTaskStatus(t, "pending").ok).toBe(true);
  });

  test("done 지정 거부 — 검증 무결성의 핵심", () => {
    const t = newTask("a", "제목");
    const r = setTaskStatus(t, "done");
    expect(r.ok).toBe(false);
    expect(t.status).not.toBe("done");
  });

  test("in_progress·failed 도 거부", () => {
    for (const s of ["in_progress", "failed"] as TaskStatus[]) {
      expect(setTaskStatus(newTask("a", "제목"), s).ok).toBe(false);
    }
  });

  test("pending 복귀는 시도 횟수를 초기화한다", () => {
    const t = { ...newTask("a", "제목"), status: "blocked" as TaskStatus, attempts: 5 };
    setTaskStatus(t, "pending");
    expect(t.attempts).toBe(0);
  });
});

describe("집계와 렌더", () => {
  test("상태 집계", () => {
    const t = tracker([
      { id: "a", status: "done" },
      { id: "b", status: "done" },
      { id: "c", status: "pending" },
      { id: "d", status: "blocked" },
    ]);
    expect(statusCounts(t)).toEqual({ pending: 1, in_progress: 0, done: 2, failed: 0, blocked: 1 });
  });

  test("렌더 형식이 v1 과 같다", () => {
    const t = tracker([{ id: "a", title: "작업", status: "done", commit: "abc1234" }]);
    const out = renderProgress(t, "2026-01-01T00:00:00.000Z");
    expect(out).toStartWith("# PROGRESS — p\n");
    expect(out).toContain("> 자동 생성 파일입니다");
    expect(out).toContain("## 현황: done 1 / 1  (in_progress 0, failed 0, blocked 0, pending 0)");
    expect(out).toContain("| ID | 제목 | 상태 | 시도 | 커밋 | 비고 |");
    expect(out).toContain("| a | 작업 | ✅ done | 0/5 | abc1234 | - |");
    expect(out).toEndWith("\n");
  });

  test("비고는 개행을 없애고 80자로 자른다", () => {
    const t = tracker([{ id: "a", status: "failed", last_error: `줄1\n줄2${"긴".repeat(200)}` }]);
    const row = renderProgress(t).split("\n").find((l) => l.startsWith("| a |"))!;
    expect(row).not.toContain("줄1\n");
    expect(row).toContain("줄1 줄2");
  });

  test("렌더 실패가 결과 판정을 뒤집지 않는다", async () => {
    // PROGRESS.md 자리를 디렉토리로 만들어 쓰기를 실패시킨다
    await mkdir(repoPaths(dir).progress, { recursive: true });
    expect(await renderSafe(dir, tracker([{ id: "a" }]))).toBe(false); // 실패를 true 로 위장하지 않는다
  });
});

describe("장부 파일 — 부재와 파손 구분", () => {
  test("없으면 missing", async () => {
    const r = await loadTracker(dir);
    expect(r.state).toBe("missing");
  });

  test("정상 저장·읽기 왕복", async () => {
    const t = tracker([{ id: "a" }]);
    await saveTracker(dir, t);
    const r = await loadTracker(dir);
    expect(r.state).toBe("ok");
    expect(r.tracker?.tasks.map((x) => x.id)).toEqual(["a"]);
  });

  test("깨졌으면 corrupt — missing 과 다른 상태여야 한다", async () => {
    await mkdir(repoPaths(dir).claudeDir, { recursive: true });
    await writeFile(repoPaths(dir).tracker, "{ 잘린", "utf8");
    const r = await loadTracker(dir);
    expect(r.state).toBe("corrupt");
    expect(r.tracker).toBeNull();
  });

  test("저장이 updated_at 을 갱신한다", async () => {
    const t = tracker();
    t.updated_at = "2020-01-01T00:00:00.000Z";
    await saveTracker(dir, t);
    expect((await loadTracker(dir)).tracker?.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("하트비트", () => {
  test("기록되고 source 가 남는다", async () => {
    await writeHeartbeat(dir, "test");
    const r = await loadTracker(dir); // 장부는 없어도 하트비트는 따로다
    expect(r.state).toBe("missing");
    const hb = await Bun.file(repoPaths(dir).heartbeat).json();
    expect(hb.source).toBe("test");
    expect(typeof hb.pid).toBe("number");
  });
});
