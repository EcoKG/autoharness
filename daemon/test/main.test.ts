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

  /**
   * 버전은 한 곳에서만 정해진다(src/version.ts).
   *
   * 여기가 갈라지면 조용히 틀린다: 설치기의 원본 검증은 `<exe> version` 출력이 semver 로
   * 보이는지로 우리 것을 판별하고, MCP 는 serverInfo 로 버전을 보고하며, 릴리스 스크립트는
   * package.json 이 아니라 코드의 VERSION 으로 태그 이름을 만든다. 셋이 어긋나면
   * "릴리스 태그는 2.0.0 인데 바이너리는 2.0.0-dev 라고 답하는" 상태가 된다.
   */
  test("버전이 semver 형식이다 — 설치기의 원본 검증이 이 형식에 걸려 있다", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  test("package.json 과 코드의 버전이 같다", async () => {
    const pkg = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version?: string };
    expect(pkg.version).toBe(VERSION);
  });

  test("MCP 가 보고하는 버전이 실행 파일 버전과 같다", async () => {
    const { SERVER_VERSION } = await import("../src/mcp/protocol.ts");
    expect(SERVER_VERSION).toBe(VERSION);
  });
});
