/**
 * selftest 계약 테스트 — v1 과 같은 7종 15항목인지, 그리고 부작용이 격리되는지.
 *
 * selftest 자체가 검증 도구이므로 "항목이 조용히 줄어드는 것" 을 막는 것이 요지다.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { runSelftest } from "../src/core/selftest.ts";

describe("selftest", () => {
  test("15항목 전부 PASS 하고 항목 수가 줄지 않는다", async () => {
    const { checks, allOk } = await runSelftest();
    expect(checks).toHaveLength(15);
    expect(allOk).toBe(true);
  }, 120_000);

  test("v1 과 같은 검증 범주를 덮는다", async () => {
    const { checks } = await runSelftest();
    const names = checks.map((c) => c.name);
    // 7종: 초기화 / 실패 경로 / 성공 경로 / 한도 / 의존성 게이팅 / 렌더 / 정리
    for (const prefix of ["1-", "2-", "3-", "4-", "5-", "6-", "7-"]) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
    expect(names).toContain("4-limit-codes");
    expect(names).toContain("4-no-eligible-exit3");
  }, 120_000);

  test("임시 디렉토리를 남기지 않는다", async () => {
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith("autoharness-selftest-"));
    await runSelftest();
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith("autoharness-selftest-"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  }, 120_000);
});
