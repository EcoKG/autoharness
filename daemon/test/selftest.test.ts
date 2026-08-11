/**
 * selftest 계약 테스트 — v1 과 같은 7종 15항목인지, 그리고 부작용이 격리되는지.
 *
 * selftest 자체가 검증 도구이므로 "항목이 조용히 줄어드는 것" 을 막는 것이 요지다.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
    // **개수가 아니라 그 경로를 본다.** 같은 접두사를 v1 파이썬 selftest 도 쓰므로,
    // 개수 세기는 둘이 동시에 돌면 남의 진행 중 디렉토리를 내 누수로 오판하고(실측:
    // 검증 파이프라인 병렬화 직후 재현), 반대로 내가 흘려도 남이 치우면 통과한다.
    const { sandbox } = await runSelftest();
    expect(sandbox).toContain("autoharness-selftest-");
    expect(existsSync(sandbox)).toBe(false);
  }, 120_000);

  test("샌드박스는 tmpdir 아래에만 만든다 — 저장소를 오염시키지 않는다", async () => {
    const { sandbox } = await runSelftest();
    expect(sandbox.startsWith(tmpdir())).toBe(true);
  }, 120_000);
});
