/**
 * 진입점 계약 테스트.
 *
 * 여기서 고정하는 것은 v1 이 실측으로 얻은 계약이다:
 *  - 종료 코드 숫자는 절대 기준이다(daemon/DESIGN.md 4절)
 *  - 미구현 모드를 성공으로 보고하지 않는다 — 조용한 실패는 이 프로젝트가 반복해서
 *    당한 결함이라 처음부터 막는다
 */
import { describe, expect, test } from "bun:test";
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

  test("미구현 모드를 0 으로 보고하지 않는다", async () => {
    // 조용한 실패 방지 — 구현되기 전에는 성공처럼 보이면 안 된다.
    // 구현이 진행되면 이 목록은 줄어든다(계약은 그대로: 미구현은 0 이 아니다).
    // stdin 을 읽는 모드(훅 3종·mcp)는 여기서 부르지 않는다 — 입력을 기다려 테스트가 멈춘다.
    for (const mode of ["daemon", "install"]) {
      expect(await main([mode]), mode).not.toBe(EXIT.OK);
    }
  });

  test("버전 문자열이 비어 있지 않다", () => {
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
