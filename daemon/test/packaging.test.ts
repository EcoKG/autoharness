/**
 * 패키징 계약 회귀.
 *
 * EXE 자체를 만드는 데는 시간이 걸리므로, 여기서는 **재현 가능성과 커버리지**를 고정한다:
 * 빌드·검증·측정 스크립트가 존재하고, 검증 스크립트가 argv 모드를 하나도 빠뜨리지 않으며,
 * 예산 상수가 계약과 일치하는가. 실제 EXE 실행은 `bun run verify:exe` 가 맡는다
 * (dist 가 있으면 여기서도 한 번 확인한다).
 */
import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { MODES } from "../src/main.ts";

const ROOT = join(import.meta.dir, "..");
const EXE = join(ROOT, "dist", process.platform === "win32" ? "autoharness.exe" : "autoharness");

async function read(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("재현 가능한 빌드", () => {
  test("빌드·검증·측정 스크립트가 package.json 에 있다", async () => {
    const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    for (const name of ["build", "verify:exe", "bench:startup", "typecheck", "test"]) {
      expect(pkg.scripts[name], name).toBeTruthy();
    }
  });

  test("빌드 스크립트가 크기와 시간을 보고한다 — 커지는 것을 조용히 넘기지 않는다", async () => {
    const src = await read("scripts/build.ts");
    expect(src).toContain("--compile");
    expect(src).toContain("크기");
    expect(src).toContain("빌드");
  });
});

describe("모드 커버리지", () => {
  test("검증 스크립트가 모든 argv 모드를 다룬다", async () => {
    const src = await read("scripts/verify-exe.ts");
    for (const mode of MODES) {
      expect(src.includes(`"${mode}"`), `${mode} 가 검증 목록에 없습니다`).toBe(true);
    }
  });

  test("검증 스크립트가 커버리지 누락을 스스로 잡는다", async () => {
    // 목록에 새 모드가 추가됐는데 케이스를 안 넣으면 스크립트가 FAIL 을 내야 한다
    const src = await read("scripts/verify-exe.ts");
    expect(src).toContain("uncovered");
    expect(src).toContain("MODES");
  });

  test("설치 검증은 dry-run 으로만 한다 — 검증이 시스템을 바꾸면 안 된다", async () => {
    const src = await read("scripts/verify-exe.ts");
    expect(src).toContain('"--dry-run"');
    // 자동 시작을 실제로 거는 인자가 검증 경로에 있으면 안 된다
    expect(src).not.toContain('"--autostart"');
  });
});

describe("시작 예산", () => {
  test("예산 상수가 계약(150ms)과 같다", async () => {
    const src = await read("scripts/bench-startup.ts");
    expect(src).toContain("BUDGET_P95_MS = 150");
  });

  test("측정 대상이 실제 훅 경로다 — version 은 낙관적이라 계약을 못 지킨다", async () => {
    const src = await read("scripts/bench-startup.ts");
    expect(src).toContain('"hook-prebash"');
    expect(src).not.toMatch(/Bun\.spawn\(\[EXE, "version"\]/);
  });

  test("측정이 실제 저장소·홈을 오염시키지 않는다", async () => {
    const src = await read("scripts/bench-startup.ts");
    expect(src).toContain("AUTOHARNESS_HOME");
    expect(src).toContain("mkdtemp");
  });

  test("DESIGN 에 실측 수치가 기록돼 있다", async () => {
    const design = await read("DESIGN.md");
    expect(design).toContain("패키징 실측");
    expect(design).toMatch(/p95[^\n]*\|/);
    expect(design).toContain("150ms");
  });
});

describe("실제 EXE (있을 때만)", () => {
  test("EXE 가 있으면 version·selftest 가 동작한다", async () => {
    if (!(await exists(EXE))) {
      // dist 는 빌드 산출물이라 항상 있지는 않다. 없으면 이 검증은 verify:exe 소관이다.
      expect(true).toBe(true);
      return;
    }
    const version = Bun.spawn([EXE, "version"], { stdout: "pipe", stderr: "ignore" });
    expect(await version.exited).toBe(0);
    expect((await new Response(version.stdout).text()).trim()).toBeTruthy();

    const self = Bun.spawn([EXE, "selftest"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(self.stdout).text();
    expect(await self.exited).toBe(0);
    expect(out).toContain("15/15");
  }, 120_000);

  test("EXE 가 있으면 MCP 도구 14종을 stdio 로 돌려준다", async () => {
    if (!(await exists(EXE))) {
      expect(true).toBe(true);
      return;
    }
    const proc = Bun.spawn([EXE, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(out.trim().split("\n")[0]!) as { result: { tools: unknown[] } };
    expect(parsed.result.tools.length).toBe(14);
  }, 120_000);
});

/**
 * **부작용 명령은 의도하지 않은 실행이 기본값이면 안 된다** (적대 검증 medium).
 *
 * 종전에는 인식하지 못한 플래그가 전부 '기본 설치 실행' 으로 흘렀다. `install --help` 로
 * 사용법을 보려던 조작이 EXE 복사·스킬 복사·MCP 재등록을 수행했고(점검 중 실제 발생),
 * 오타 플래그도 같은 경로를 탔다.
 */
describe("install 인자 처리 — 조회 의도가 시스템을 건드리지 않는다", () => {
  test("--help 는 사용법만 내고 성공한다", async () => {
    const { main } = await import("../src/main.ts");
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      expect(await main(["install", "--help"])).toBe(0);
    } finally {
      console.log = original;
    }
    const out = lines.join("\n");
    expect(out).toContain("사용법: autoharness install");
    expect(out).toContain("--dry-run");
    expect(out).toContain("--autostart");
  });

  test("알 수 없는 옵션은 거부하고 설치하지 않는다", async () => {
    const { main } = await import("../src/main.ts");
    const errs: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    try {
      // 오타 플래그가 설치를 수행하면 안 된다 — 종료 코드 2(사용법 오류)여야 한다
      expect(await main(["install", "--autostrat"])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errs.join("\n")).toContain("알 수 없는 install 옵션");
  });

  test("알려진 옵션 목록이 실제 처리 분기를 덮는다", async () => {
    const src = await read("src/main.ts");
    // 처리하는 플래그가 목록에 빠지면 정상 사용이 거부된다 — 양쪽이 맞아야 한다
    for (const flag of ["dry-run", "status", "uninstall", "autostart", "skill", "exe", "migrate", "rollback", "backup"]) {
      expect(src, flag).toContain(`"${flag}"`);
    }
  });
});
