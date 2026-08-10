/**
 * 진입점 계약 테스트.
 *
 * 여기서 고정하는 것은 v1 이 실측으로 얻은 계약이다:
 *  - 종료 코드 숫자는 절대 기준이다(daemon/DESIGN.md 4절)
 *  - 모든 모드가 실제로 디스패치된다 — 조용한 미구현은 이 프로젝트가 반복해서
 *    당한 결함이라 처음부터 막는다
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, MODES, VERSION, isMode, main } from "../src/main.ts";

describe("종료 코드 계약", () => {
  test("숫자가 v1 과 동일하다 — 상위 에이전트의 분기 신호다", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.FAIL).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.NO_TASK).toBe(3);
    expect(EXIT.BLOCKED).toBe(4);
  });
});

describe("모드 목록", () => {
  test("DESIGN.md 3절이 요구하는 모드를 전부 포함한다", () => {
    const declared: readonly string[] = MODES;
    for (const required of [
      "daemon",
      "mcp",
      "hook-prebash",
      "hook-postbash",
      "hook-stop",
      "brief",
      "run",
      "next",
      "status",
      "selftest",
      "install",
    ]) {
      expect(declared).toContain(required);
    }
  });

  test("isMode 는 정확 일치만 받는다", () => {
    expect(isMode("run")).toBe(true);
    expect(isMode("hook-prebash")).toBe(true);
    expect(isMode("runner")).toBe(false);
    expect(isMode("RUN")).toBe(false);
    expect(isMode(undefined)).toBe(false);
    expect(isMode("")).toBe(false);
  });
});

describe("디스패치", () => {
  test("version 은 0 으로 끝난다", async () => {
    expect(await main(["version"])).toBe(EXIT.OK);
  });

  test("--help 는 0, 인자 없음은 2", async () => {
    expect(await main(["--help"])).toBe(EXIT.OK);
    expect(await main([])).toBe(EXIT.USAGE);
  });

  test("알 수 없는 모드는 2", async () => {
    expect(await main(["없는모드"])).toBe(EXIT.USAGE);
  });

  test("모든 모드가 디스패치된다 — 미구현 폴백에 걸리는 모드가 없다", async () => {
    // 종전에는 "미구현 모드는 0 이 아니다" 를 확인했고, 구현이 끝나면서 그 목록이 비었다.
    // 계약은 그대로 살아 있다: 폴백(종료 코드 2)에 걸리는 모드가 하나도 없어야 한다.
    // 실행이 아니라 디스패치 배선으로 확인한다 — stdin 을 기다리거나 상주하는 모드는
    // 여기서 부를 수 없기 때문이다(실제 실행 검증은 `bun run verify:exe` 소관).
    const source = await readFile(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    for (const mode of MODES) {
      const dispatched =
        source.includes(`case "${mode}":`) || source.includes(`mode === "${mode}"`);
      expect(dispatched, `${mode} 가 디스패치되지 않습니다`).toBe(true);
    }
  });

  test("버전 문자열이 비어 있지 않다", () => {
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
