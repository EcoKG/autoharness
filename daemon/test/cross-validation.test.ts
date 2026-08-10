/**
 * v1↔v2 교차 검증 — **마이그레이션 안전성의 실측 근거**(daemon/DESIGN.md 7.3).
 *
 * 두 구현이 같은 장부에 같은 답을 내야 v1 을 내려놓을 수 있다. 여기서는 대조 하네스를
 * 실제로 돌려 불일치가 0인지 본다. 손으로 고른 사례만으로는 우리가 생각한 것만 덮으므로
 * 무작위 장부를 섞고, 시드를 고정해 불일치가 나오면 재현할 수 있게 한다.
 *
 * 전량(300라운드)은 `bun run parity` 가 맡고, 여기서는 매 검증에 얹어도 되는 크기로 돈다 —
 * 회귀를 잡는 데는 충분하고, 전량은 이식 완료 판정 때 한 번 더 돌린다.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function readScript(): Promise<string> {
  return readFile(join(ROOT, "scripts", "parity.ts"), "utf8");
}

describe("대조 하네스가 실제로 일치를 보인다", () => {
  test("축소 라운드로 돌려 불일치가 0이다", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", join(ROOT, "scripts", "parity.ts")],
      {
        cwd: ROOT,
        env: { ...process.env, PARITY_ROUNDS: "40", PARITY_SEED: "20260810", PYTHONIOENCODING: "utf-8" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      // 불일치가 나오면 어느 쪽이 계약에 맞는지 사람이 판정해야 한다 — 출력을 그대로 남긴다
      throw new Error(`대조 불일치(exit ${code}):\n${out}\n${await new Response(proc.stderr).text()}`);
    }
    expect(out).toContain("불일치 0건");
  }, 180_000);
});

describe("대조 범위", () => {
  test("선택 규칙·교착·종료 코드를 대조한다", async () => {
    const src = await readScript();
    expect(src).toContain("eligibleNext");
    expect(src).toContain("deadlockedPending");
    expect(src).toContain("exitOk");
  });

  test("명령 판정을 대조한다 — 게이트가 한쪽만 뚫리면 안 된다", async () => {
    const src = await readScript();
    expect(src).toContain("denyReason");
    expect(src).toContain("invokesGitCommit");
    expect(src).toContain("COMMAND_CASES");
  });

  test("run 의 종료 코드와 장부 변화를 대조한다", async () => {
    const src = await readScript();
    expect(src).toContain("RUN_CASES");
    // 0/1/3/4 네 갈래를 모두 본다(2 는 사용법 오류라 장부 대조 대상이 아니다)
    for (const expected of ["expect: 0", "expect: 1", "expect: 3", "expect: 4"]) {
      expect(src, expected).toContain(expected);
    }
    expect(src).toContain("attempts");
  });

  test("무작위 장부를 쓰되 재현 가능하다", async () => {
    const src = await readScript();
    expect(src).toContain("randomTracker");
    expect(src).toContain("PARITY_SEED");
    // 재현 불가능한 난수는 실패를 다시 볼 수 없게 만든다 — 호출 자체가 없어야 한다
    // (주석에서 이유를 설명하는 것은 무방하므로 호출 형태로 본다)
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });

  test("무작위 장부가 교착도 만든다 — 정상 경로만 대조하면 의미가 얕다", async () => {
    const src = await readScript();
    expect(src).toContain("유령");
    expect(src).toContain("in_progress");
    expect(src).toContain("blocked");
  });

  test("v1 자산을 지우지 않았다 — 교차 검증의 상대가 있어야 한다", async () => {
    // DESIGN 8절 사람 경계: 교차 검증이 끝나기 전에는 v1 Python 자산을 지우지 않는다
    expect(await Bun.file(join(ROOT, "..", "bin", "harness_engine.py")).exists()).toBe(true);
    expect(await Bun.file(join(ROOT, "..", "bin", "harness_mcp.py")).exists()).toBe(true);
  });
});

describe("실측 결과가 문서에 남아 있다", () => {
  test("DESIGN 에 교차 검증 결과가 기록돼 있다", async () => {
    const design = await readFile(join(ROOT, "DESIGN.md"), "utf8");
    expect(design).toContain("교차 검증 실측");
    expect(design).toContain("불일치 0");
  });
});
