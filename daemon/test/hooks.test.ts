/**
 * 훅 계약 테스트 — 게이트 컨텍스트 판정이 핵심이다.
 *
 * v1 이 해소한 모순을 그대로 고정한다: 헤드리스는 하드 차단, 대화형·일시정지는 승인
 * 요청으로 승격. 두 게이트(금지 명령·커밋)가 같은 규칙을 쓴다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths } from "../src/core/paths.ts";
import {
  GATE_ASK,
  GATE_DENY,
  commitGateReason,
  gateDecision,
  isHeadlessSession,
} from "../src/hooks/gate.ts";
import { HOOK_RUNTIME_KEYS, hookPayloadIsGenuine, recordHookFire } from "../src/hooks/hooks.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-hooks-"));
  await mkdir(repoPaths(dir).claudeDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const headless = { CLAUDE_AUTOHARNESS: "1" } as NodeJS.ProcessEnv;
const interactive = {} as NodeJS.ProcessEnv;

async function pause() {
  await writeFile(repoPaths(dir).pausedFlag, "", "utf8");
}

describe("게이트 판정 행렬", () => {
  test("헤드리스는 deny", async () => {
    expect(await gateDecision(dir, headless)).toBe(GATE_DENY);
  });

  test("대화형은 ask — 사람이 지시했는데 막히면 안 된다", async () => {
    expect(await gateDecision(dir, interactive)).toBe(GATE_ASK);
  });

  test("일시정지는 헤드리스여도 ask — 사람이 직접 운전 중이다", async () => {
    await pause();
    expect(await gateDecision(dir, headless)).toBe(GATE_ASK);
  });

  test("헤드리스 식별은 정확히 '1' 에만 반응한다", () => {
    for (const [value, expected] of [["1", true], ["0", false], ["true", false], ["", false]] as const) {
      expect(isHeadlessSession({ CLAUDE_AUTOHARNESS: value })).toBe(expected);
    }
    expect(isHeadlessSession({})).toBe(false);
  });
});

describe("커밋 게이트 조건", () => {
  async function init(status?: "in_progress" | "failed") {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    t.tasks = [{ ...newTask("t1", "작업"), ...(status ? { status } : {}) }];
    await saveTracker(dir, t);
  }

  test("장부가 없으면 게이트 없음 — 수동 운용 저장소", async () => {
    expect(await commitGateReason(dir)).toBeNull();
  });

  test("진행 중 작업이 없으면 게이트 없음", async () => {
    await init();
    expect(await commitGateReason(dir)).toBeNull();
  });

  test("검증 통과 기록 없는 진행 중 작업이면 게이트", async () => {
    await init("failed");
    const reason = await commitGateReason(dir);
    expect(reason).not.toBeNull();
    expect(reason).toContain("t1");
  });

  test("통과 기록이 있으면 게이트 해제", async () => {
    // 실제 통과 직후 상태로 둔다: 돌린 작업은 done 이 되고 아직 커밋 SHA 가 없다.
    // (기록은 t1 의 통과인데 t1 이 여전히 failed 인 상태는 실제로 생기지 않는다 —
    //  run 이 성공하면 그 작업을 done 으로 바꾸기 때문이다)
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    t.tasks = [
      { ...newTask("t1", "방금 통과"), status: "done" },
      { ...newTask("t2", "남은 작업"), status: "failed", attempts: 1 },
    ];
    await saveTracker(dir, t);
    await writeFile(
      repoPaths(dir).state,
      JSON.stringify({ last_run: { task: "t1", ok: true } }),
      "utf8",
    );
    expect(await commitGateReason(dir)).toBeNull();
  });

  test("일시정지 중에는 게이트를 걸지 않는다", async () => {
    await init("failed");
    await pause();
    expect(await commitGateReason(dir)).toBeNull();
  });

  test("장부 파손은 게이트로 드러낸다 — 조용히 통과시키면 게이트가 사라진다", async () => {
    await writeFile(repoPaths(dir).tracker, "{ 잘린", "utf8");
    const reason = await commitGateReason(dir);
    expect(reason).not.toBeNull();
    expect(reason).toContain("파손");
  });
});

describe("발화 마커 — 사람이 흉내 낸 호출과 구분한다", () => {
  test("런타임 필드가 있으면 진짜", () => {
    for (const key of HOOK_RUNTIME_KEYS) {
      expect(hookPayloadIsGenuine({ [key]: "v" })).toBe(true);
    }
  });

  test("런타임 필드가 없으면 가짜", () => {
    for (const bad of [{}, { session_id: "" }, { tool_input: {} }, null, []]) {
      expect(hookPayloadIsGenuine(bad)).toBe(false);
    }
  });

  test("진짜 호출만 마커를 남긴다", async () => {
    expect(await recordHookFire(dir, "hook-prebash", { tool_input: { command: "x" } })).toBe(false);
    expect(await Bun.file(repoPaths(dir).hooksSeen).exists()).toBe(false);

    expect(await recordHookFire(dir, "hook-prebash", { session_id: "abc" })).toBe(true);
    const seen = await Bun.file(repoPaths(dir).hooksSeen).json();
    expect(seen["hook-prebash"].session_id).toBe("abc");
  });
});

/**
 * 통과 기록은 **1회용**이어야 한다 (적대 검증 high).
 *
 * 종전에는 `last_run.ok` 만 보고 게이트를 열어, 한 번 통과하면 그 뒤로 검증 없는 커밋이
 * 무한히 허용됐다. CLAUDE.md 8절이 "훅이 기계적으로 강제한다" 고 선언한 계약이 그 경로에서
 * 무너진다. 이제 통과 기록이 가리키는 작업이 실제로 done 이고 **아직 커밋 SHA 가 붙지
 * 않았을 때만** 연다 — postbash 가 SHA 를 기록하는 순간 다시 닫힌다.
 */
describe("커밋 게이트 — 통과 기록 소진", () => {
  async function setup() {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    t.tasks = [
      { ...newTask("done1", "통과한 작업"), status: "done" },
      { ...newTask("stuck", "진행 중 작업"), status: "failed", attempts: 1 },
    ];
    await saveTracker(dir, t);
    return t;
  }

  async function setState(state: Record<string, unknown>) {
    await writeFile(repoPaths(dir).state, JSON.stringify(state), "utf8");
  }

  test("방금 통과한 작업의 커밋은 열린다", async () => {
    await setup();
    await setState({ last_run: { task: "done1", ok: true } });
    expect(await commitGateReason(dir)).toBeNull();
  });

  test("그 작업에 커밋 SHA 가 붙으면 다시 닫힌다 — 기록이 소진됐다", async () => {
    const t = await setup();
    t.tasks[0]!.commit = "abc1234";
    await saveTracker(dir, t);
    await setState({ last_run: { task: "done1", ok: true } });
    const reason = await commitGateReason(dir);
    expect(reason).not.toBeNull();
    expect(reason).toContain("stuck");
  });

  test("통과 기록이 가리키는 작업이 done 이 아니면 열리지 않는다", async () => {
    await setup();
    await setState({ last_run: { task: "stuck", ok: true } });
    expect(await commitGateReason(dir)).not.toBeNull();
  });

  test("없는 작업을 가리키는 기록으로는 열리지 않는다", async () => {
    await setup();
    await setState({ last_run: { task: "유령작업", ok: true } });
    expect(await commitGateReason(dir)).not.toBeNull();
  });

  test("task 없는 옛 형식 기록으로는 열리지 않는다", async () => {
    await setup();
    await setState({ last_run: { ok: true } });
    expect(await commitGateReason(dir)).not.toBeNull();
  });

  test("실패 기록으로는 당연히 열리지 않는다", async () => {
    await setup();
    await setState({ last_run: { task: "done1", ok: false } });
    expect(await commitGateReason(dir)).not.toBeNull();
  });
});
