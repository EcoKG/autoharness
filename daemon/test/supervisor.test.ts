/**
 * 프로젝트 판단·기동 회귀 — **판단 순서와 분류 우선순위가 계약이다.**
 *
 * v1 이 실측으로 고친 세 가지를 여기서 고정한다:
 *   ① completed 는 종점이 아니다 ② 빈 장부를 완료로 봉인하지 않는다
 *   ③ 교착 pending 은 완료가 아니라 needs_human
 * 그리고 사용량 분류의 오탐·미탐 경계를 양쪽에서 못 박는다 — 미탐은 5회 뒤 정지로,
 * 오탐은 헛도는 백오프로 이어진다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths } from "../src/core/paths.ts";
import { nowIso, type RegistryProject, type Task, type Tracker } from "../src/core/schema.ts";
import {
  applyLimit,
  applyOk,
  backoffPick,
  classifyLaunch,
  decideProject,
  isUsageLimited,
  isoAfter,
  launchProject,
  markError,
  parseIso,
  type LaunchHandle,
  type Launcher,
} from "../src/daemon/supervisor.ts";

let dir = "";
let home = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-sup-"));
  home = await mkdtemp(join(tmpdir(), "ah-suphome-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(repoPaths(dir).claudeDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function project(over: Partial<RegistryProject> = {}): RegistryProject {
  return {
    id: "p", repo: dir, model: "claude-opus-5", permission_args: [],
    status: "active", consecutive_errors: 0, limit_hits: 0, next_retry_at: null,
    last_launch: { ts: null, result: null, log: null },
    created_at: nowIso(), updated_at: nowIso(),
    ...over,
  };
}

async function writeTracker(tasks: Task[]): Promise<Tracker> {
  const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  t.tasks = tasks;
  await saveTracker(dir, t);
  return t;
}

const SETTINGS = {
  stale_minutes: 30, probe_sec: 90, max_consecutive_errors: 5,
  limit_backoff_minutes: [30, 60, 120, 240, 360], error_backoff_minutes: [15, 30, 60],
};

describe("판단 순서", () => {
  test("active 가 아니면 스킵한다", async () => {
    for (const status of ["paused", "needs_human", "error"] as const) {
      const { decision } = await decideProject(project({ status }), { settings: SETTINGS });
      expect(decision.action, status).toBe("skip");
    }
  });

  test("completed 는 종점이 아니다 — 할 일이 생기면 되살아나 기동으로 간다", async () => {
    await writeTracker([newTask("t1", "작업")]);
    const proj = project({ status: "completed" });
    const { decision, reactivated } = await decideProject(proj, { settings: SETTINGS });
    expect(reactivated).toBe(true);
    expect(String(proj.status)).toBe("active");
    expect(decision.action).toBe("launch");
  });

  test("completed 인데 할 일이 없으면 그대로 둔다", async () => {
    await writeTracker([{ ...newTask("t1", "작업"), status: "done" }]);
    const proj = project({ status: "completed" });
    const { decision, reactivated } = await decideProject(proj, { settings: SETTINGS });
    expect(reactivated).toBe(false);
    expect(decision.action).toBe("skip");
  });

  test("백오프 중이면 PAUSED 검사보다 먼저 걸러진다", async () => {
    await writeTracker([newTask("t1", "작업")]);
    const proj = project({ next_retry_at: isoAfter(60) });
    const { decision } = await decideProject(proj, { settings: SETTINGS });
    expect(decision.action).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("백오프");
  });

  test("백오프가 지났으면 진행한다", async () => {
    await writeTracker([newTask("t1", "작업")]);
    const proj = project({ next_retry_at: isoAfter(-60) });
    expect((await decideProject(proj, { settings: SETTINGS })).decision.action).toBe("launch");
  });

  test("PAUSED 플래그를 존중한다 — MCP 없이 파일만 만든 경우도", async () => {
    await writeTracker([newTask("t1", "작업")]);
    await writeFile(repoPaths(dir).pausedFlag, "", "utf8");
    const { decision } = await decideProject(project(), { settings: SETTINGS });
    expect(decision.action).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("HARNESS_PAUSED");
  });

  test("장부 부재와 파손 모두 오류로 집계하되 사유를 구분한다", async () => {
    const missing = await decideProject(project(), { settings: SETTINGS });
    expect(missing.decision.action).toBe("error");
    expect((missing.decision as { reason: string }).reason).toContain("부재");

    await writeFile(repoPaths(dir).tracker, "{ 깨진", "utf8");
    const corrupt = await decideProject(project(), { settings: SETTINGS });
    expect(corrupt.decision.action).toBe("error");
    expect((corrupt.decision as { reason: string }).reason).toContain("파손");
  });

  test("하트비트가 신선하면 이중 기동하지 않는다", async () => {
    await writeTracker([newTask("t1", "작업")]);
    await writeFile(repoPaths(dir).heartbeat, JSON.stringify({ ts: nowIso() }), "utf8");
    const { decision } = await decideProject(project(), { settings: SETTINGS });
    expect(decision.action).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("하트비트 신선");
  });

  test("하트비트가 낡았으면 기동한다", async () => {
    await writeTracker([newTask("t1", "작업")]);
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeFile(repoPaths(dir).heartbeat, JSON.stringify({ ts: old }), "utf8");
    expect((await decideProject(project(), { settings: SETTINGS })).decision.action).toBe("launch");
  });

  test("장부 검사가 하트비트보다 먼저다 — 파손 장부가 신선한 하트비트에 가려지지 않는다", async () => {
    await writeFile(repoPaths(dir).tracker, "{ 깨진", "utf8");
    await writeFile(repoPaths(dir).heartbeat, JSON.stringify({ ts: nowIso() }), "utf8");
    expect((await decideProject(project(), { settings: SETTINGS })).decision.action).toBe("error");
  });
});

describe("완료 판정 3갈래", () => {
  test("빈 장부는 완료로 봉인하지 않는다 — 적재 대기다", async () => {
    await writeTracker([]);
    const { decision } = await decideProject(project(), { settings: SETTINGS });
    expect(decision.action).toBe("skip");
    expect((decision as { reason: string }).reason).toContain("적재 대기");
  });

  test("전부 done 이면 completed", async () => {
    await writeTracker([{ ...newTask("t1", "작업"), status: "done" }]);
    const { decision } = await decideProject(project(), { settings: SETTINGS });
    expect(decision.action).toBe("transition");
    expect((decision as { status: string }).status).toBe("completed");
  });

  test("blocked 가 남아 있으면 needs_human", async () => {
    await writeTracker([
      { ...newTask("t1", "작업"), status: "done" },
      { ...newTask("t2", "막힌 작업"), status: "blocked" },
    ]);
    const { decision } = await decideProject(project(), { settings: SETTINGS });
    expect((decision as { status: string }).status).toBe("needs_human");
  });

  test("교착 pending 은 완료가 아니라 needs_human — 영영 실행 불가를 성공으로 마감하지 않는다", async () => {
    await writeTracker([
      { ...newTask("t1", "작업"), status: "done" },
      { ...newTask("t2", "교착"), deps: ["없는작업"] },
    ]);
    const { decision } = await decideProject(project(), { settings: SETTINGS });
    expect(decision.action).toBe("transition");
    expect((decision as { status: string }).status).toBe("needs_human");
    expect((decision as { detail: string }).detail).toContain("교착");
  });
});

describe("사용량 분류 — 미탐 금지", () => {
  test("실제 한도 메시지를 놓치지 않는다", () => {
    for (const text of [
      "Claude usage limit reached",
      "rate limit exceeded, try again later",
      "429 Too Many Requests",
      "Your credit balance is too low",
      "You are out of extra usage",
      "The server is overloaded, please retry",
      "quota exceeded for this organization",
      '{"type":"overloaded_error"}',
      "api_error: quota",
      "HTTP status 429 returned",
    ]) {
      expect(isUsageLimited(text), text).toBe(true);
    }
  });
});

describe("사용량 분류 — 오탐 금지", () => {
  test("식별자·산문 속 우연한 단어는 잡지 않는다", () => {
    for (const text of [
      "def test_overloaded_queue(): pass",
      "disk quota check passed",
      "quota management module loaded",
      "processed 429 files successfully",
      "AssertionError: expected 3 got 4",
      "",
    ]) {
      expect(isUsageLimited(text), text).toBe(false);
    }
  });

  test("rc=0 이면 로그에 한도 문자열이 있어도 ok 다 — 순서가 오탐을 막는다", () => {
    expect(classifyLaunch(0, "usage limit reached")).toBe("ok");
    expect(classifyLaunch(null, "429 too many requests")).toBe("ok");
  });

  test("비정상 종료에서만 한도 판정을 한다", () => {
    expect(classifyLaunch(1, "usage limit reached")).toBe("limit");
    expect(classifyLaunch(1, "그냥 실패했습니다")).toBe("error");
  });
});

describe("백오프와 상태 전이", () => {
  test("백오프는 끝값에서 고정된다 — 무한 증가하지 않는다", () => {
    const seq = [30, 60, 120];
    expect(backoffPick(seq, 1)).toBe(30);
    expect(backoffPick(seq, 3)).toBe(120);
    expect(backoffPick(seq, 99)).toBe(120);
    expect(backoffPick(seq, 0)).toBe(30);
    expect(backoffPick([], 2)).toBe(30);
  });

  test("error 는 한도에 닿으면 정지한다", () => {
    const proj = project();
    for (let i = 1; i < 5; i++) {
      markError(proj, SETTINGS, "실패", Date.now());
      expect(proj.status, `${i}회`).toBe("active");
    }
    const msg = markError(proj, SETTINGS, "실패", Date.now());
    expect(proj.status).toBe("error");
    expect(msg).toContain("정지");
  });

  test("limit 은 영구 포기하지 않는다 — status 는 active 로 남는다", () => {
    const proj = project();
    for (let i = 0; i < 10; i++) applyLimit(proj, SETTINGS, "log.txt", Date.now());
    expect(proj.status).toBe("active");
    expect(proj.limit_hits).toBe(10);
    expect(proj.next_retry_at).not.toBeNull();
  });

  test("limit 이 연속되면 오분류 의심 신호를 남긴다", () => {
    const proj = project();
    for (let i = 0; i < 4; i++) applyLimit(proj, SETTINGS, "log.txt", Date.now());
    expect(proj.needs_attention).toBeUndefined();
    applyLimit(proj, SETTINGS, "log.txt", Date.now());
    expect(proj.needs_attention).toContain("오분류");
  });

  test("성공하면 카운터와 신호가 모두 지워진다", () => {
    const proj = project({ consecutive_errors: 3, limit_hits: 2, next_retry_at: isoAfter(60) });
    proj.needs_attention = "이전 경고";
    applyOk(proj, "log.txt");
    expect(proj.consecutive_errors).toBe(0);
    expect(proj.limit_hits).toBe(0);
    expect(proj.next_retry_at).toBeNull();
    expect(proj.needs_attention).toBeUndefined();
    expect(proj.last_launch.result).toBe("ok");
  });

  test("parseIso 는 쓰레기 값을 null 로 돌린다", () => {
    expect(parseIso("2026-01-01T00:00:00Z")).toBeGreaterThan(0);
    expect(parseIso("아무거나")).toBeNull();
    expect(parseIso(null)).toBeNull();
    expect(parseIso(42)).toBeNull();
  });
});

describe("세션 기동", () => {
  function fakeLauncher(over: {
    rc?: number | null;
    tail?: string;
    fail?: boolean;
    onSpec?: (spec: { argv: string[]; cwd: string; env: Record<string, string> }) => void;
  }): Launcher {
    return async (spec) => {
      over.onSpec?.(spec);
      if (over.fail) throw new Error("실행 파일을 찾을 수 없습니다");
      const handle: LaunchHandle = {
        pid: 4242,
        probe: async () => over.rc ?? null,
        readLogTail: async () => over.tail ?? "",
      };
      return handle;
    };
  }

  test("헤드리스 표식과 모델·권한 인자를 넘긴다", async () => {
    let seen: { argv: string[]; cwd: string; env: Record<string, string> } | null = null;
    const proj = project({ model: "claude-fable-5", permission_args: ["--permission-mode", "bypassPermissions"] });
    await launchProject(proj, newTask("t1", "작업"), {
      settings: SETTINGS, env, launcher: fakeLauncher({ onSpec: (s) => void (seen = s) }),
    });
    expect(seen!.env["CLAUDE_AUTOHARNESS"]).toBe("1");
    expect(seen!.argv).toContain("--model");
    expect(seen!.argv).toContain("claude-fable-5");
    expect(seen!.argv).toContain("bypassPermissions");
    expect(seen!.cwd).toBe(dir);
    expect(seen!.argv[1]).toBe("-p"); // 부트스트랩 프롬프트가 실린다
    expect(seen!.argv[2]!.length).toBeGreaterThan(20);
  });

  test("프로브 생존은 ok — 카운터를 리셋하고 분리한다", async () => {
    const proj = project({ consecutive_errors: 2 });
    const r = await launchProject(proj, newTask("t1", "작업"), {
      settings: SETTINGS, env, launcher: fakeLauncher({ rc: null }),
    });
    expect(r.result).toBe("ok");
    expect(proj.consecutive_errors).toBe(0);
    expect(r.message).toContain("생존");
  });

  test("사용량 초과는 백오프만 걸고 status 를 건드리지 않는다", async () => {
    const proj = project();
    const r = await launchProject(proj, newTask("t1", "작업"), {
      settings: SETTINGS, env, launcher: fakeLauncher({ rc: 1, tail: "usage limit reached" }),
    });
    expect(r.result).toBe("limit");
    expect(proj.status).toBe("active");
    expect(proj.limit_hits).toBe(1);
  });

  test("그 외 비정상 종료는 error 로 집계한다", async () => {
    const proj = project();
    const r = await launchProject(proj, newTask("t1", "작업"), {
      settings: SETTINGS, env, launcher: fakeLauncher({ rc: 3, tail: "Traceback ..." }),
    });
    expect(r.result).toBe("error");
    expect(proj.consecutive_errors).toBe(1);
    expect(proj.last_launch.result).toBe("error");
  });

  test("기동 자체가 실패해도 데몬은 죽지 않고 오류로 집계한다", async () => {
    const proj = project();
    const r = await launchProject(proj, newTask("t1", "작업"), {
      settings: SETTINGS, env, launcher: fakeLauncher({ fail: true }),
    });
    expect(r.result).toBe("error");
    expect(proj.consecutive_errors).toBe(1);
    expect(r.message).toContain("기동 실패");
  });

  test("rc=0 이면 로그를 읽지도 않는다 — 오탐 경로를 아예 밟지 않는다", async () => {
    let readCalls = 0;
    const proj = project();
    const launcher: Launcher = async () => ({
      pid: 1,
      probe: async () => 0,
      readLogTail: async () => {
        readCalls += 1;
        return "usage limit reached";
      },
    });
    const r = await launchProject(proj, newTask("t1", "작업"), { settings: SETTINGS, env, launcher });
    expect(r.result).toBe("ok");
    expect(readCalls).toBe(0);
  });
});
