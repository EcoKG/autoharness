/**
 * 훅 배선 진단 회귀 — v1 이 실측으로 얻은 오탐·미탐 경계를 그대로 고정한다.
 *
 * 핵심은 두 방향의 오판을 동시에 막는 것이다:
 *   미탐 — 등록만 보고 정상이라 하기, 설정 파손을 '미등록(수동 운용)'으로 보기,
 *          matcher 가 일부 도구만 덮는데 넘어가기, 상대 경로 훅을 정상으로 보기
 *   오탐 — 훅을 쓰지 않는 저장소를 경고 대상으로 삼기
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdRun, cmdStatus } from "../src/cli.ts";
import { EXIT } from "../src/exit.ts";
import { createTracker, findTask, loadTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths } from "../src/core/paths.ts";
import { nowIso } from "../src/core/schema.ts";
import { MARKER_HOOK_OPS } from "../src/hooks/hooks.ts";
import {
  WIRING_ACTIVE,
  WIRING_INACTIVE,
  WIRING_NOT_REGISTERED,
  cwdDependentHooksFrom,
  engineTokenIn,
  hookWiringStatus,
  matcherCovers,
  pathIsRooted,
} from "../src/hooks/wiring.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-wiring-"));
  await mkdir(repoPaths(dir).claudeDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const V1_ENGINE = 'python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py"';
const V2_ENGINE = "autoharness";

/** 하네스 훅 4종을 settings.json 에 심는다. ops 를 줄이면 부분 등록이 된다. */
async function writeSettings(opts: {
  engine?: string;
  matcher?: string;
  ops?: readonly string[];
  name?: string;
  raw?: string;
}): Promise<void> {
  const path = join(repoPaths(dir).claudeDir, opts.name ?? "settings.json");
  if (opts.raw !== undefined) {
    await writeFile(path, opts.raw, "utf8");
    return;
  }
  const engine = opts.engine ?? V1_ENGINE;
  const matcher = opts.matcher ?? "Bash|PowerShell";
  const ops = opts.ops ?? MARKER_HOOK_OPS;
  const entry = (op: string) => ({ matcher, hooks: [{ type: "command", command: `${engine} ${op}` }] });
  const settings: Record<string, unknown> = { hooks: {} };
  const hooks = settings["hooks"] as Record<string, unknown[]>;
  if (ops.includes("hook-prebash")) hooks["PreToolUse"] = [entry("hook-prebash")];
  if (ops.includes("hook-postbash")) hooks["PostToolUse"] = [entry("hook-postbash")];
  if (ops.includes("hook-stop")) {
    hooks["Stop"] = [{ hooks: [{ type: "command", command: `${engine} hook-stop` }] }];
  }
  await writeFile(path, JSON.stringify(settings, null, 2), "utf8");
}

async function markFired(ops: readonly string[] = ["hook-prebash"]): Promise<void> {
  const seen: Record<string, unknown> = {};
  for (const op of ops) seen[op] = { ts: nowIso(), event: "PreToolUse", session_id: "s1" };
  await writeFile(repoPaths(dir).hooksSeen, JSON.stringify(seen), "utf8");
}

async function initTracker(opts: { done?: number; withCommit?: boolean } = {}): Promise<void> {
  const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  t.tasks = Array.from({ length: opts.done ?? 0 }, (_, i) => ({
    ...newTask(`t${i}`, "작업"),
    status: "done" as const,
    commit: opts.withCommit ? "abc1234" : null,
  }));
  await saveTracker(dir, t);
}

describe("배선 상태 3분기", () => {
  test("훅 미등록 저장소는 경고 대상이 아니다 (오탐 금지)", async () => {
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_NOT_REGISTERED);
    expect(info.warning).toBeNull();
    expect(info.registered).toEqual([]);
  });

  test("등록됐으나 발화 기록이 없으면 inactive + 경고", async () => {
    await writeSettings({});
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_INACTIVE);
    expect(info.warning).toContain("배선 비활성 의심");
    expect(info.registered).toEqual([...MARKER_HOOK_OPS].sort());
  });

  test("등록 + 발화 기록이 있으면 active, 경고 없음", async () => {
    await writeSettings({});
    await markFired();
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_ACTIVE);
    expect(info.fired).toEqual(["hook-prebash"]);
    expect(info.last_fire).not.toBeNull();
    expect(info.warning).toBeNull();
  });

  test("발화 마커 파일이 파손돼도 크래시 없이 inactive 로 본다", async () => {
    await writeSettings({});
    await writeFile(repoPaths(dir).hooksSeen, "{ 깨진 JSON", "utf8");
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_INACTIVE);
    expect(info.fired).toEqual([]);
  });

  test("ts 가 없는 마커는 발화로 치지 않는다", async () => {
    await writeSettings({});
    await writeFile(repoPaths(dir).hooksSeen, JSON.stringify({ "hook-prebash": {} }), "utf8");
    expect((await hookWiringStatus(dir)).state).toBe(WIRING_INACTIVE);
  });
});

describe("설정 파손을 미등록으로 오판하지 않는다", () => {
  test("파손이면 corrupt 로 보고하고 경고한다", async () => {
    await writeSettings({ raw: "{ this is not json" });
    const info = await hookWiringStatus(dir);
    expect(info.settings_states["settings.json"]).toBe("corrupt");
    expect(info.warning).toContain("설정 파일이 파손");
  });

  test("부재는 missing 이며 그 자체로는 경고가 아니다", async () => {
    const info = await hookWiringStatus(dir);
    expect(info.settings_states["settings.json"]).toBe("missing");
    expect(info.settings_states["settings.local.json"]).toBe("missing");
    expect(info.warning).toBeNull();
  });

  test("settings.local.json 의 훅도 등록으로 인정한다", async () => {
    await writeSettings({ name: "settings.local.json" });
    expect((await hookWiringStatus(dir)).registered).toEqual([...MARKER_HOOK_OPS].sort());
  });
});

describe("부분 등록", () => {
  test("일부만 등록되면 누락분을 드러내고 경고한다", async () => {
    await writeSettings({ ops: ["hook-prebash"] });
    await markFired();
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_ACTIVE); // 발화는 했다 — 그래도 경고는 나가야 한다
    expect(info.missing_hooks).toEqual(["hook-postbash", "hook-stop"]);
    expect(info.warning).toContain("일부만 등록");
  });

  test("전부 등록되면 누락 경고가 없다", async () => {
    await writeSettings({});
    await markFired();
    expect((await hookWiringStatus(dir)).missing_hooks).toEqual([]);
  });
});

describe("matcher 커버리지", () => {
  test("Bash 만 덮으면 PowerShell 경로로 게이트가 우회된다 — 드러낸다", async () => {
    await writeSettings({ matcher: "Bash" });
    await markFired();
    const info = await hookWiringStatus(dir);
    expect(info.uncovered_tools).toEqual(["PowerShell"]);
    expect(info.warning).toContain("matcher");
  });

  test("Bash|PowerShell 이면 빈틈이 없다", async () => {
    await writeSettings({ matcher: "Bash|PowerShell" });
    await markFired();
    const info = await hookWiringStatus(dir);
    expect(info.uncovered_tools).toEqual([]);
    expect(info.warning).toBeNull();
  });

  test("matcher 가 비어 있으면 어떤 도구도 덮지 못한다", async () => {
    await writeSettings({ matcher: "" });
    await markFired();
    expect((await hookWiringStatus(dir)).uncovered_tools).toEqual(["Bash", "PowerShell"]);
  });

  test("matcherCovers 는 부분 문자열이 아니라 정확 일치다", () => {
    expect(matcherCovers("Bash|PowerShell", "Bash")).toBe(true);
    expect(matcherCovers("Bash, PowerShell", "PowerShell")).toBe(true);
    expect(matcherCovers("BashTool", "Bash")).toBe(false);
    expect(matcherCovers("", "Bash")).toBe(false);
  });

  test("hook-stop 은 도구 무관이라 커버리지 판정에 끼지 않는다", async () => {
    await writeSettings({ ops: ["hook-stop"] });
    await markFired(["hook-stop"]);
    expect((await hookWiringStatus(dir)).uncovered_tools).toEqual([]);
  });
});

describe("cwd 종속 훅 감지", () => {
  test("상대 경로 엔진은 취약으로 잡는다", async () => {
    await writeSettings({ engine: "python scripts/harness_engine.py" });
    await markFired();
    const info = await hookWiringStatus(dir);
    expect(info.cwd_dependent_hooks.length).toBe(3);
    expect(info.warning).toContain("상대 경로");
  });

  test("${CLAUDE_PROJECT_DIR} 와 절대 경로는 취약이 아니다", async () => {
    await writeSettings({});
    await markFired();
    expect((await hookWiringStatus(dir)).cwd_dependent_hooks).toEqual([]);
    await writeSettings({ engine: 'python "C:/tools/scripts/harness_engine.py"' });
    expect((await hookWiringStatus(dir)).cwd_dependent_hooks).toEqual([]);
  });

  test("PATH 로 해석되는 전역 EXE 이름은 cwd 와 무관하다", async () => {
    await writeSettings({ engine: V2_ENGINE });
    await markFired();
    expect((await hookWiringStatus(dir)).cwd_dependent_hooks).toEqual([]);
  });

  test("./autoharness 처럼 구분자가 붙으면 다시 cwd 종속이다", () => {
    expect(pathIsRooted("./autoharness")).toBe(false);
    expect(pathIsRooted("scripts/harness_engine.py")).toBe(false);
    expect(pathIsRooted("harness_engine.py")).toBe(false); // 인터프리터가 cwd 기준으로 연다
    expect(pathIsRooted("autoharness")).toBe(true);
    expect(pathIsRooted("autoharness.exe")).toBe(true);
    expect(pathIsRooted("/usr/local/bin/autoharness")).toBe(true);
    expect(pathIsRooted("~/bin/autoharness")).toBe(true);
    expect(pathIsRooted("D:\\tools\\autoharness.exe")).toBe(true);
    expect(pathIsRooted("")).toBe(false);
  });

  test("훅이 아닌 명령은 취약 목록에 오르지 않는다", () => {
    const files = [
      {
        name: "settings.json",
        state: "ok" as const,
        settings: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "npm run lint" }] }] } },
      },
    ];
    expect(cwdDependentHooksFrom(files)).toEqual([]);
  });
});

describe("v1·v2 엔진 공존 인식", () => {
  test("v2 EXE 훅도 등록으로 인식한다 (마이그레이션 중 공존)", async () => {
    await writeSettings({ engine: "C:/Users/me/.claude/bin/autoharness.exe" });
    const info = await hookWiringStatus(dir);
    expect(info.registered).toEqual([...MARKER_HOOK_OPS].sort());
    expect(info.state).toBe(WIRING_INACTIVE);
  });

  test("engineTokenIn 은 두 엔진을 모두 찾고 무관한 명령은 넘긴다", () => {
    expect(engineTokenIn('python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py" hook-stop')).toBe(
      "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py",
    );
    expect(engineTokenIn("autoharness hook-stop")).toBe("autoharness");
    expect(engineTokenIn('"C:/Program Files/ah/autoharness.exe" hook-stop')).toBe(
      "C:/Program Files/ah/autoharness.exe",
    );
    expect(engineTokenIn("git status")).toBeNull();
  });

  test("엔진을 가리키지 않는 훅은 하네스 훅이 아니다", async () => {
    await writeSettings({ engine: "python scripts/other_tool.py" });
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_NOT_REGISTERED);
    expect(info.warning).toBeNull();
  });
});

describe("보조 신호와 fail-open", () => {
  test("done 전부 커밋 SHA 가 없으면 PostToolUse 미발화 흔적으로 덧붙인다", async () => {
    await writeSettings({});
    await initTracker({ done: 3 });
    const info = await hookWiringStatus(dir);
    expect(info.done_total).toBe(3);
    expect(info.done_without_commit).toBe(3);
    expect(info.warning).toContain("PostToolUse 미발화 흔적");
  });

  test("커밋 SHA 가 기록돼 있으면 보조 신호를 붙이지 않는다", async () => {
    await writeSettings({});
    await initTracker({ done: 3, withCommit: true });
    const info = await hookWiringStatus(dir);
    expect(info.done_without_commit).toBe(0);
    expect(info.warning).not.toContain("PostToolUse 미발화 흔적");
  });

  test("장부가 없어도 진단은 성립한다 — 주행을 막지 않는다", async () => {
    await writeSettings({});
    const info = await hookWiringStatus(dir);
    expect(info.state).toBe(WIRING_INACTIVE);
    expect(info.done_total).toBe(0);
  });
});

/** 진단이 실제 출력 경로에 실려야 사람에게 닿는다 — 계산만 하고 숨기면 없는 것과 같다. */
describe("보고 경로 통합", () => {
  /** stderr 은 process.stderr.write 로, stdout 은 console.log 로 나간다 — 각각 가로챈다. */
  function capture(stream: "stdout" | "stderr"): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    if (stream === "stdout") {
      const original = console.log;
      console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      return { lines, restore: () => void (console.log = original) };
    }
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    return { lines, restore: () => void (process.stderr.write = original) };
  }

  test("status 출력에 hooks 진단 필드가 실린다", async () => {
    await writeSettings({ matcher: "Bash" });
    await initTracker();
    const cap = capture("stdout");
    try {
      expect(await cmdStatus({ repo: dir })).toBe(EXIT.OK);
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.lines.join("\n"));
    expect(parsed.hooks.state).toBe(WIRING_INACTIVE);
    expect(parsed.hooks.uncovered_tools).toEqual(["PowerShell"]);
    expect(parsed.hooks.warning).toContain("배선 비활성 의심");
  });

  test("run 은 경고를 stderr 로 내되 주행을 막지 않는다", async () => {
    await writeSettings({});
    const t = createTracker({
      project: "p", objective: "o", source: "A", target: "B", test: "exit 0",
    });
    t.tasks = [newTask("t1", "작업")];
    await saveTracker(dir, t);

    const cap = capture("stderr");
    try {
      expect(await cmdRun({ repo: dir, task: "t1" })).toBe(EXIT.OK);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("")).toContain("배선 비활성 의심");
    expect(findTask((await loadTracker(dir)).tracker!, "t1")!.status).toBe("done");
  });

  test("brief 는 배선이 끊겼을 때만 경고를 싣는다", async () => {
    await writeSettings({});
    await initTracker();
    const { cmdBrief } = await import("../src/hooks/hooks.ts");

    let cap = capture("stdout");
    try {
      expect(await cmdBrief(dir)).toBe(EXIT.OK);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("\n")).toContain("배선 비활성 의심");

    await markFired(MARKER_HOOK_OPS);
    cap = capture("stdout");
    try {
      await cmdBrief(dir);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("\n")).not.toContain("AutoHarness 경고");
  });

  test("배선이 정상이면 run 이 잡음을 내지 않는다", async () => {
    await writeSettings({});
    await markFired();
    const t = createTracker({
      project: "p", objective: "o", source: "A", target: "B", test: "exit 0",
    });
    t.tasks = [newTask("t1", "작업")];
    await saveTracker(dir, t);

    const cap = capture("stderr");
    try {
      expect(await cmdRun({ repo: dir, task: "t1" })).toBe(EXIT.OK);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("")).not.toContain("AutoHarness 경고");
  });
});
