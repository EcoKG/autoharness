/**
 * 러너 계약 테스트 — 종료 코드가 핵심이다.
 *
 * v1 selftest 가 검증하던 경로를 그대로 덮는다: 실패 경로(exit 1 + attempts 증가 +
 * last_error 기록), 성공 경로(exit 0 + done), 한도 경로(exit 4 + blocked).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../src/exit.ts";
import { createTracker, findTask, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths } from "../src/core/paths.ts";
import { noEligibleExit, nextLogPath, planStages, runTask, substitutePath } from "../src/core/runner.ts";
import { summarize, SUMMARY_MAX_LINES, SUMMARY_TAIL_LINES } from "../src/core/summarize.ts";
import type { Tracker } from "../src/core/schema.ts";

let dir = "";
const OK_CMD = "exit 0";
const FAIL_CMD = "echo 'AssertionError: 실패' >&2; exit 1";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-runner-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(test_cmd = OK_CMD): Promise<Tracker> {
  const t = createTracker({
    project: "p", objective: "o", source: "A", target: "B", test: test_cmd,
  });
  t.tasks = [newTask("t1", "작업")];
  await saveTracker(dir, t);
  return t;
}

describe("종료 코드 계약", () => {
  test("성공 경로 — exit 0 이고 done", async () => {
    const t = await setup(OK_CMD);
    const r = await runTask(dir, t, findTask(t, "t1")!);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(findTask(t, "t1")!.status).toBe("done");
    expect(findTask(t, "t1")!.finished_at).not.toBeNull();
    expect(r.message).toContain("exit=0");
  });

  test("실패 경로 — exit 1, attempts 증가, last_error 기록", async () => {
    const t = await setup(FAIL_CMD);
    const r = await runTask(dir, t, findTask(t, "t1")!);
    expect(r.exitCode).toBe(EXIT.FAIL);
    const task = findTask(t, "t1")!;
    expect(task.status).toBe("failed");
    expect(task.attempts).toBe(1);
    expect(task.last_error).toContain("stage=test");
    expect(task.last_error).toContain("AssertionError");
  });

  test("한도 경로 — 5회째에 exit 4 이고 blocked", async () => {
    const t = await setup(FAIL_CMD);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await runTask(dir, t, findTask(t, "t1")!)).exitCode);
    }
    expect(codes).toEqual([EXIT.FAIL, EXIT.FAIL, EXIT.FAIL, EXIT.FAIL, EXIT.BLOCKED]);
    expect(findTask(t, "t1")!.status).toBe("blocked");
    expect(findTask(t, "t1")!.attempts).toBe(5);
  });

  test("test 명령이 없으면 설정 오류(2)", async () => {
    const t = await setup("");
    t.commands.test = "";
    const r = await runTask(dir, t, findTask(t, "t1")!);
    expect(r.exitCode).toBe(EXIT.USAGE);
  });

  test("진행 가능 작업 없음 — blocked 유무로 3 과 4 를 가른다", async () => {
    const t = await setup();
    findTask(t, "t1")!.status = "done";
    expect(noEligibleExit(t).exitCode).toBe(EXIT.NO_TASK);
    findTask(t, "t1")!.status = "blocked";
    expect(noEligibleExit(t).exitCode).toBe(EXIT.BLOCKED);
  });

  test("로그 파일이 기록되고 장부가 상대 경로로 가리킨다", async () => {
    const t = await setup(OK_CMD);
    const r = await runTask(dir, t, findTask(t, "t1")!);
    expect(r.logFile).toStartWith(".claude/harness-logs/");
    expect(await Bun.file(join(dir, r.logFile!)).exists()).toBe(true);
  });

  test("PROGRESS.md 가 갱신된다", async () => {
    const t = await setup(OK_CMD);
    await runTask(dir, t, findTask(t, "t1")!);
    expect(await Bun.file(repoPaths(dir).progress).text()).toContain("✅ done");
  });
});

describe("스테이지 구성", () => {
  test("build → test → lint 순서", () => {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "T" });
    t.commands.build = "B";
    t.commands.lint = "L";
    const plan = planStages(t, newTask("a", "제목"));
    expect("stages" in plan && plan.stages.map((s) => s.name)).toEqual(["build", "test", "lint"]);
  });

  test("작업 전용 test_cmd 가 전역 test 를 대체한다", () => {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "전역" });
    const plan = planStages(t, { ...newTask("a", "제목"), test_cmd: "전용" });
    expect("stages" in plan && plan.stages[0]!.command).toBe("전용");
  });

  test("빈 test_cmd 는 해제 — 전역으로 복귀", () => {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "전역" });
    const plan = planStages(t, { ...newTask("a", "제목"), test_cmd: "" });
    expect("stages" in plan && plan.stages[0]!.command).toBe("전역");
  });

  test("--cmd 는 단일 custom 스테이지로 대체한다", () => {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "T" });
    const plan = planStages(t, newTask("a", "제목"), "직접명령");
    expect("stages" in plan && plan.stages).toEqual([{ name: "custom", command: "직접명령" }]);
  });

  test("{path} 치환", () => {
    expect(substitutePath("pytest {path}", "src/mod")).toBe("pytest src/mod");
    expect(substitutePath("pytest {path}", null)).toBe("pytest ");
  });
});

describe("로그 파일명 — 같은 초 재실행에도 이전 시도를 보존한다", () => {
  test("충돌하면 접미가 붙는다", async () => {
    const logs = join(dir, "logs");
    await Bun.write(join(logs, "x.txt"), "");
    const at = new Date("2026-01-01T00:00:00.000Z");
    const first = await nextLogPath(logs, "t1", at);
    await Bun.write(first, "");
    const second = await nextLogPath(logs, "t1", at);
    expect(second).not.toBe(first);
    expect(second).toContain("-1.log");
  });
});

describe("오류 요약 — 강한 신호 우선", () => {
  test("잡음에 밀려 진짜 오류가 사라지지 않는다", () => {
    const noise = Array.from({ length: 70 }, (_, i) => `Downloading error-prone-${i}.jar`).join("\n");
    const out = summarize(`${noise}\nTraceback (most recent call last):\nAssertionError: 기대와 다름`);
    expect(out[0]).toContain("Traceback");
    expect(out.some((l) => l.includes("AssertionError"))).toBe(true);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_LINES);
  });

  test("여유가 있으면 약한 매칭도 포함한다", () => {
    const out = summarize("Downloading error-prone.jar\nAssertionError: 실패");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("AssertionError");
  });

  test("오류 줄이 없으면 tail 로 폴백한다", () => {
    const out = summarize(Array.from({ length: 50 }, (_, i) => `정상 ${i}`).join("\n"));
    expect(out).toHaveLength(SUMMARY_TAIL_LINES);
    expect(out.at(-1)).toBe("정상 49");
  });

  test("빈 줄은 버린다", () => {
    expect(summarize("\n\n   \n")).toEqual([]);
  });
});
