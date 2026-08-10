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
  blockers,
  setConfig,
  updateTaskPlan,
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

/**
 * 되돌리기가 시도 횟수를 지운다는 사실을 **말해야 한다.**
 *
 * pending 으로 되돌리면 attempts 가 0 이 된다(v1 과 같은 규칙이라 바꾸지 않는다). 그런데
 * attempts 야말로 "이 작업이 몇 번 실패했는가" 의 유일한 단서다. 말없이 지우면 봉인 직전이던
 * 작업이 새 작업처럼 보이고, 사람은 같은 실패를 다시 다섯 번 겪는다.
 */
describe("되돌리기와 시도 횟수", () => {
  test("지운 횟수를 결과에 담는다", () => {
    const t = { ...newTask("t", "작업"), status: "blocked" as const, attempts: 4 };
    const r = setTaskStatus(t, "pending");
    expect(r.ok).toBe(true);
    expect(r.ok && r.attemptsCleared).toBe(4);
    expect(t.attempts).toBe(0); // 규칙 자체는 그대로다
  });

  test("지울 것이 없으면 담지 않는다 — 없는 경고를 만들지 않는다", () => {
    const t = { ...newTask("t", "작업"), status: "blocked" as const, attempts: 0 };
    const r = setTaskStatus(t, "pending");
    expect(r.ok && r.attemptsCleared).toBeUndefined();
  });

  test("blocked 로 보낼 때는 시도 횟수를 건드리지 않는다", () => {
    const t = { ...newTask("t", "작업"), status: "failed" as const, attempts: 3 };
    const r = setTaskStatus(t, "blocked");
    expect(t.attempts).toBe(3);
    expect(r.ok && r.attemptsCleared).toBeUndefined();
  });
});

/**
 * 막힌 곳 판정은 **서버(장부 모듈)에서만** 한다.
 *
 * deadlockedPending 은 '누가' 막혔는지만 알려 주고 '왜' 는 말하지 않는다. 화면에서 그 이유를
 * 다시 계산하게 두면 두 곳이 갈라지고, 갈라진 화면이 "정상" 이라 말하는 순간이 v1 이 죽은
 * 방식이다. 그래서 사유까지 여기서 만든다.
 */
describe("막힌 곳 요약", () => {
  function tracker(): ReturnType<typeof createTracker> {
    return createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  }

  test("봉인된 작업을 사유와 함께 짚는다", () => {
    const t = tracker();
    t.tasks = [{ ...newTask("a", "작업 A"), status: "blocked", last_error: "첫 줄\n둘째 줄" }];
    const b = blockers(t);
    expect(b.length).toBe(1);
    expect(b[0]!.kind).toBe("blocked");
    expect(b[0]!.reason).toContain("첫 줄");
    expect(b[0]!.reason).not.toContain("둘째 줄"); // 요약에 전문을 쏟지 않는다
  });

  test("한도 임박을 미리 알린다", () => {
    const t = tracker();
    t.max_attempts = 5;
    t.tasks = [{ ...newTask("a", "작업"), status: "failed", attempts: 4 }];
    const b = blockers(t);
    expect(b[0]!.kind).toBe("attempts");
    expect(b[0]!.reason).toContain("4/5");
  });

  test("교착은 원인 의존을 이름으로 짚는다 — '교착' 세 글자로는 손을 못 댄다", () => {
    const t = tracker();
    t.tasks = [
      { ...newTask("a", "작업 A"), status: "blocked" },
      { ...newTask("b", "작업 B", { deps: ["a"] }), status: "pending" },
    ];
    const b = blockers(t).filter((x) => x.kind === "deadlock");
    expect(b.length).toBe(1);
    expect(b[0]!.id).toBe("b");
    expect(b[0]!.reason).toContain("a(봉인됨)");
  });

  test("장부에 없는 의존도 이름으로 드러낸다", () => {
    const t = tracker();
    t.tasks = [{ ...newTask("b", "작업 B", { deps: ["유령"] }), status: "pending" }];
    const b = blockers(t).filter((x) => x.kind === "deadlock");
    expect(b[0]!.reason).toContain("유령(장부에 없음)");
  });

  test("막힌 것이 없으면 빈 목록이다 — 없는 경고를 만들지 않는다", () => {
    const t = tracker();
    t.tasks = [newTask("a", "작업"), { ...newTask("b", "다른 작업"), status: "done" }];
    expect(blockers(t).length).toBe(0);
  });
});

/**
 * 우선순위·의존을 나중에 바꾼다.
 *
 * 종전에는 둘 다 작업을 추가할 때만 정할 수 있었다. 자동화 제어 도구에서 "무엇을 먼저
 * 할지" 를 나중에 못 바꾸는 것은 큰 구멍이다 — 장부를 손으로 고치는 길밖에 없었고 그것은
 * 규칙상 금지돼 있다.
 */
describe("작업 계획 변경", () => {
  function t3(): ReturnType<typeof createTracker> {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    t.tasks = [newTask("a", "A"), newTask("b", "B"), newTask("c", "C")];
    return t;
  }

  test("우선순위를 바꾸면 선택 순서가 따라온다", () => {
    const t = t3();
    expect(eligibleNext(t)!.id).toBe("a"); // 같은 우선순위면 id 순
    const r = updateTaskPlan(t, findTask(t, "c")!, { priority: 1 });
    expect(r.ok).toBe(true);
    expect(eligibleNext(t)!.id).toBe("c");
  });

  test("의존을 나중에 걸 수 있다", () => {
    const t = t3();
    updateTaskPlan(t, findTask(t, "a")!, { deps: ["b"] });
    expect(findTask(t, "a")!.deps).toEqual(["b"]);
    expect(eligibleNext(t)!.id).toBe("b"); // a 는 b 가 끝나야 한다
  });

  test("빈 배열로 의존을 푼다", () => {
    const t = t3();
    updateTaskPlan(t, findTask(t, "a")!, { deps: ["b"] });
    updateTaskPlan(t, findTask(t, "a")!, { deps: [] });
    expect(findTask(t, "a")!.deps).toEqual([]);
  });

  test("자기 자신 의존을 거부한다", () => {
    const t = t3();
    const r = updateTaskPlan(t, findTask(t, "a")!, { deps: ["a"] });
    expect(r.ok).toBe(false);
  });

  test("없는 작업 의존을 거부한다", () => {
    const t = t3();
    const r = updateTaskPlan(t, findTask(t, "a")!, { deps: ["유령"] });
    expect(r.ok).toBe(false);
  });

  /**
   * 여기가 핵심이다 — addTask 는 새 작업만 보므로 순환을 만들 수 없지만, 나중에 바꾸는
   * 경로는 기존 그래프에 고리를 만들 수 있다. 이 검증을 빠뜨리면 교착이 조용히 생긴다.
   */
  test("순환을 만들면 거부하고 원래대로 되돌린다", () => {
    const t = t3();
    updateTaskPlan(t, findTask(t, "b")!, { deps: ["a"] });
    const r = updateTaskPlan(t, findTask(t, "a")!, { deps: ["b"] });
    expect(r.ok).toBe(false);
    expect(findTask(t, "a")!.deps).toEqual([]); // 실패했으면 흔적을 남기지 않는다
  });

  test("긴 사슬의 순환도 잡는다", () => {
    const t = t3();
    updateTaskPlan(t, findTask(t, "b")!, { deps: ["a"] });
    updateTaskPlan(t, findTask(t, "c")!, { deps: ["b"] });
    const r = updateTaskPlan(t, findTask(t, "a")!, { deps: ["c"] });
    expect(r.ok).toBe(false);
  });

  test("숫자가 아닌 우선순위를 거부한다", () => {
    const t = t3();
    expect(updateTaskPlan(t, findTask(t, "a")!, { priority: Number.NaN }).ok).toBe(false);
  });
});

/**
 * 검증 명령·한도 변경.
 *
 * init 때 정해진 뒤로 바꿀 방법이 없었다. 검증 명령은 자동화의 **통과 기준**인데 그것을 못
 * 바꾸면 도구가 자기 규칙에 갇힌다. 장부를 손으로 고치는 것은 규칙상 금지다.
 */
describe("설정 변경", () => {
  function t(): ReturnType<typeof createTracker> {
    return createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  }

  test("검증 명령을 바꾼다", () => {
    const tr = t();
    const r = setConfig(tr, { test: "npm test" });
    expect(r.ok).toBe(true);
    expect(tr.commands.test).toBe("npm test");
    expect(r.changed).toContain("test");
  });

  test("빈 검증 명령을 거부한다 — 검증 없는 주행은 done 을 아무렇게나 만든다", () => {
    const tr = t();
    expect(setConfig(tr, { test: "" }).ok).toBe(false);
    expect(setConfig(tr, { test: "   " }).ok).toBe(false);
    expect(tr.commands.test).toBe("exit 0"); // 원래 값이 살아 있다
  });

  test("build·lint 는 빈 문자열로 해제된다", () => {
    const tr = t();
    setConfig(tr, { build: "make" });
    expect(tr.commands.build).toBe("make");
    setConfig(tr, { build: "" });
    expect(tr.commands.build).toBeNull();
  });

  test("시도 한도를 바꾼다", () => {
    const tr = t();
    expect(setConfig(tr, { maxAttempts: 3 }).ok).toBe(true);
    expect(tr.max_attempts).toBe(3);
  });

  test("말이 안 되는 한도를 거부한다", () => {
    const tr = t();
    expect(setConfig(tr, { maxAttempts: 0 }).ok).toBe(false);
    expect(setConfig(tr, { maxAttempts: 2.5 }).ok).toBe(false);
    expect(setConfig(tr, { timeoutSec: -1 }).ok).toBe(false);
  });

  test("바꿀 것이 없으면 성공이라 하지 않는다", () => {
    expect(setConfig(t(), {}).ok).toBe(false);
  });

  test("한도를 줄이면 선택 규칙이 즉시 따라온다", () => {
    // 설정이 판정에 실제로 반영되는지 — 값만 바뀌고 동작이 그대로면 의미가 없다
    const tr = t();
    tr.tasks = [{ ...newTask("a", "A"), status: "failed", attempts: 3 }];
    expect(eligibleNext(tr)!.id).toBe("a"); // 기본 한도 5 에서는 재시도 대상
    setConfig(tr, { maxAttempts: 3 });
    expect(eligibleNext(tr)).toBeNull(); // 한도에 닿아 더는 고르지 않는다
  });
});
