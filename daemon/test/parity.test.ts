/**
 * v1 회귀 의도 이식 — **커버리지 감사에서 드러난 공백을 메운다.**
 *
 * v1 tests/ 의 파일별 의도를 v2 테스트에 대조한 결과 네 곳이 비어 있었다. 다른 의도들은
 * 이미 각 모듈의 테스트가 덮고 있으므로(명령 판정 → command.test, 게이트 → hooks.test,
 * matcher·배선 → wiring.test, 레지스트리 무결성·잠금 → mcp/filelock.test, 워치독 전이·
 * 사용량 분류 → supervisor.test, 조용한 실패 → core/ledger.test) 여기서는 **빠진 것만**
 * 다룬다. 중복 이식은 유지 비용만 늘린다.
 *
 * 메우는 공백:
 *   ① 모델 추천 — 비ASCII 스택명 오탐(v1 test_model_recommend)
 *   ② 스택 실측 — detect 직접 검증(v1 이 init 경로로만 덮던 자리)
 *   ③ 하트비트 펌프 — 장시간 스테이지 중 갱신(v1 test_heartbeat_pump)
 *   ④ 데몬 건강 진단 — 실행 흔적의 '나이'(v1 test_watchdog_health 의 핵심 의도)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detect, estimateLoc } from "../src/core/detect.ts";
import { createTracker, findTask, newTask, saveTracker } from "../src/core/ledger.ts";
import {
  ALLOWED_MODELS,
  FABLE_THRESHOLD,
  MODEL_FABLE,
  MODEL_OPUS,
  languageToken,
  modelRecommend,
} from "../src/core/model.ts";
import { repoPaths, userPaths } from "../src/core/paths.ts";
import { defaultRegistry, saveRegistry } from "../src/core/registry.ts";
import { runTask } from "../src/core/runner.ts";
import { HANDLERS } from "../src/mcp/tools.ts";

let dir = "";
let home = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-par-"));
  home = await mkdtemp(join(tmpdir(), "ah-parhome-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  process.env["AUTOHARNESS_HOME"] = home;
  process.env["AUTOHARNESS_NO_DELEGATE"] = "1";
  await mkdir(repoPaths(dir).claudeDir, { recursive: true });
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
});
afterEach(async () => {
  delete process.env["AUTOHARNESS_HOME"];
  delete process.env["AUTOHARNESS_NO_DELEGATE"];
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * v2 테스트 파일이 조용히 사라지지 않게 한다.
 *
 * 여기 있던 것은 v1↔v2 등가 매핑표였다. v1 테스트가 사라졌으니 대조할 원본이 없어져
 * 표 자체는 의미를 잃었지만, **표가 지키던 성질**은 그대로 필요하다: 리팩터링이나 정리
 * 도중 테스트 파일 하나가 통째로 없어져도 아무도 모르는 상태를 막는 것이다.
 * run_checks 의 집합 대조는 이것을 못 잡는다 — 계획과 발견을 둘 다 파일 시스템에서
 * 얻으므로 파일이 지워지면 양쪽이 함께 줄어든다.
 *
 * 그래서 목록을 명시한다. 추가는 자유롭고, **제거는 이 목록을 함께 고쳐야** 한다 —
 * 그 한 줄이 "정말 지울 것인가" 를 묻는 자리다.
 */
const REQUIRED_V2_TESTS: readonly string[] = [
  "bootstrap.test.ts",
  "command.test.ts",
  "console-ws.test.ts",
  "core.test.ts",
  "cross-validation.test.ts",
  "daemon.test.ts",
  "filelock.test.ts",
  "hooks.test.ts",
  "install.test.ts",
  "ledger.test.ts",
  "log.test.ts",
  "main.test.ts",
  "mcp.test.ts",
  "migrate.test.ts",
  "packaging.test.ts",
  "parity.test.ts",
  "runner.test.ts",
  "scheduler.test.ts",
  "selftest.test.ts",
  "session-stream.test.ts",
  "soak.test.ts",
  "supervisor.test.ts",
  "ui.test.ts",
  "web.test.ts",
  "wiring.test.ts",
];

describe("v2 테스트 집합", () => {
  test("있어야 할 테스트 파일이 전부 있다", async () => {
    const { readdir } = await import("node:fs/promises");
    const present = new Set(await readdir(import.meta.dir));
    const missing = REQUIRED_V2_TESTS.filter((f) => !present.has(f));
    expect(missing, `사라진 테스트 파일: ${missing.join(", ")}`).toEqual([]);
  });

  test("목록이 실제 파일과 어긋나지 않는다 — 새로 만든 것도 등재한다", async () => {
    const { readdir } = await import("node:fs/promises");
    const actual = (await readdir(import.meta.dir)).filter((f) => f.endsWith(".test.ts")).sort();
    expect(actual).toEqual([...REQUIRED_V2_TESTS].sort());
  });
});

describe("① 모델 추천 — 비ASCII 오탐 (v1 test_model_recommend)", () => {
  test("한글 스택명은 언어 토큰이 비어 '언어 간 이식' 가산을 받지 않는다", async () => {
    // v1 실측 결함: lang() 이 비ASCII 에서 빈 문자열을 반환해 같은 언어 안의 작업까지
    // +3 을 받고 최상위 모델로 몰렸다. 이 저장소 자신의 init 에서 발견됐다.
    const r = await modelRecommend({
      source: "Python 3.9 stdlib (CLI 엔진)",
      target: "동일 스택 — 결함 수정·테스트 확충",
    });
    expect(r.rationale.join(" ")).not.toContain("언어 간 이식");
    expect(r.score).toBe(0);
    expect(r.recommended).toBe(MODEL_OPUS);
  });

  test("양쪽 다 ASCII 이고 언어가 다르면 가산한다", async () => {
    const r = await modelRecommend({ source: "Java 8 + Spring", target: "Kotlin + Spring Boot 3" });
    expect(r.rationale.join(" ")).toContain("언어 간 이식");
    expect(r.score).toBe(3);
  });

  test("같은 언어면 가산하지 않는다", async () => {
    const r = await modelRecommend({ source: "Python 2.7", target: "Python 3.12" });
    expect(r.score).toBe(0);
  });

  test("언어 토큰 추출 경계", () => {
    expect(languageToken("Java 8 + Spring")).toBe("java");
    expect(languageToken("C#/.NET 8")).toBe("c#");
    expect(languageToken("  Kotlin")).toBe("kotlin");
    expect(languageToken("동일 스택")).toBe("");
    expect(languageToken("")).toBe("");
    expect(languageToken(null)).toBe("");
    expect(languageToken(undefined)).toBe("");
  });

  test("메모가 있으면 가산하고 근거에 남긴다", async () => {
    const r = await modelRecommend({ notes: "요구가 모호합니다" });
    expect(r.score).toBe(2);
    expect(r.rationale.join(" ")).toContain("모호");
  });

  test("임계를 넘으면 최상위 추론 모델을 권한다", async () => {
    const r = await modelRecommend({
      source: "Java", target: "Kotlin", notes: "사양이 모호하고 테스트가 없습니다",
    });
    expect(r.score).toBeGreaterThanOrEqual(FABLE_THRESHOLD);
    expect(r.recommended).toBe(MODEL_FABLE);
  });

  test("근거 없이 추천하지 않고, 결정은 사용자 몫이다", async () => {
    const r = await modelRecommend({});
    expect(r.rationale.length).toBeGreaterThan(0);
    expect(r.decision).toBe("user");
    expect(Object.keys(r.comparison).sort()).toEqual([...ALLOWED_MODELS].sort());
  });

  test("없는 저장소 경로를 줘도 죽지 않는다", async () => {
    const r = await modelRecommend({ repo: join(dir, "없는폴더"), source: "Java", target: "Kotlin" });
    expect(r.score).toBe(3); // 실측은 못 했지만 인자 기반 판단은 살아 있다
  });
});

describe("② 스택 실측 (v1 detect)", () => {
  test("빌드 도구를 파일 존재로 판정한다", async () => {
    await writeFile(join(dir, "pom.xml"), "<project><module>core</module><module>web</module></project>", "utf8");
    const r = await detect(dir);
    expect(r.build_tools).toContain("maven");
    expect(r.multimodule).toEqual(["core", "web"]);
    expect(r.suggested_commands["maven"]!.test).toBe("mvn -B verify");
  });

  test("린트 설정이 있으면 린트 명령을 제안한다", async () => {
    await writeFile(join(dir, "pom.xml"), "<project>checkstyle</project>", "utf8");
    expect((await detect(dir)).suggested_commands["maven"]!.lint).toBe("mvn -B checkstyle:check");
  });

  test("package.json 의 스크립트 유무를 반영한다", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "x" } }), "utf8");
    const s = (await detect(dir)).suggested_commands["node"]!;
    expect(s.lint).toBe("npm run lint");
    expect(s.test).toBeNull(); // 없는 스크립트를 있다고 하지 않는다
    expect(s.build).toBeNull();
  });

  test("테스트 디렉토리 유무가 tests_present 로 드러난다", async () => {
    expect((await detect(dir)).tests_present).toBe(false);
    await mkdir(join(dir, "tests"), { recursive: true });
    const r = await detect(dir);
    expect(r.tests_present).toBe(true);
    expect(r.test_dirs).toContain("tests");
  });

  test("에이전트 설정 존재를 보고한다 — 재초기화 판단의 근거다", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "지침", "utf8");
    expect((await detect(dir)).existing_agent_configs).toContain("CLAUDE.md");
  });

  test("git 저장소가 아니면 그렇게 보고한다", async () => {
    const r = await detect(dir);
    expect(r.git.is_repo).toBe(false);
    expect(r.git.dirty_files).toBe(0);
  });

  test("없는 경로는 던진다 — 빈 결과로 위장하지 않는다", async () => {
    await expect(detect(join(dir, "없는폴더"))).rejects.toThrow();
  });

  test("LOC 추정이 코드 파일만 센다", async () => {
    await writeFile(join(dir, "a.ts"), "x".repeat(3500), "utf8");
    await writeFile(join(dir, "b.png"), "y".repeat(100000), "utf8");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "big.ts"), "z".repeat(1_000_000), "utf8");
    const loc = await estimateLoc(dir);
    expect(loc).toBeGreaterThan(50); // a.ts 만 반영
    expect(loc).toBeLessThan(200); // 이미지·node_modules 는 제외
  });
});

describe("③ 하트비트 펌프 (v1 test_heartbeat_pump)", () => {
  async function setup(testCmd: string) {
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: testCmd });
    t.tasks = [newTask("t1", "작업")];
    await saveTracker(dir, t);
    return t;
  }

  async function heartbeatTs(): Promise<string | null> {
    const hb = await Bun.file(repoPaths(dir).heartbeat).json().catch(() => null);
    return (hb as { ts?: string } | null)?.ts ?? null;
  }

  test("장시간 스테이지 중에도 하트비트가 갱신된다", async () => {
    // v1 결함: 단일 스테이지가 stale_minutes 에 근접하면 워치독이 세션 사망으로 오판해
    // 이중 기동했다. 펌프가 없으면 이 테스트에서 ts 가 시작값 그대로 남는다.
    const t = await setup(process.platform === "win32" ? "ping -n 3 127.0.0.1 >NUL" : "sleep 2");
    const before = await heartbeatTs();
    await runTask(dir, t, findTask(t, "t1")!, { pumpMs: 150 });
    const after = await heartbeatTs();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  }, 60_000);

  test("펌프가 실행 후 정리된다 — 핸들이 쌓이지 않는다", async () => {
    const t = await setup("exit 0");
    await runTask(dir, t, findTask(t, "t1")!, { pumpMs: 50 });
    const settled = await heartbeatTs();
    await Bun.sleep(250); // 펌프가 살아 있다면 이 사이에 ts 가 또 바뀐다
    expect(await heartbeatTs()).toBe(settled);
  }, 30_000);

  test("스테이지가 실패해도 펌프를 정리한다", async () => {
    const t = await setup("exit 1");
    await runTask(dir, t, findTask(t, "t1")!, { pumpMs: 50 });
    const settled = await heartbeatTs();
    await Bun.sleep(250);
    expect(await heartbeatTs()).toBe(settled);
  }, 30_000);
});

describe("④ 데몬 건강 진단 — 실행 흔적의 나이 (v1 test_watchdog_health)", () => {
  test("한 번도 돈 적이 없으면 경고한다", async () => {
    await saveRegistry(defaultRegistry(), env);
    const r = (await HANDLERS["watchdog_status"]!({})) as { warnings: string[]; last_tick: string | null };
    expect(r.last_tick).toBeNull();
    expect(r.warnings.join(" ")).toContain("한 번도");
  });

  test("등록된 프로젝트가 전부 미기동이면 그 신호를 따로 남긴다", async () => {
    const reg = defaultRegistry();
    reg.last_tick = new Date().toISOString();
    reg.projects.push({
      id: "a", repo: dir, model: "claude-opus-5", permission_args: [],
      status: "active", consecutive_errors: 0, limit_hits: 0, next_retry_at: null,
      last_launch: { ts: null, result: null, log: null },
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    await saveRegistry(reg, env);
    const r = (await HANDLERS["watchdog_status"]!({})) as { warnings: string[] };
    expect(r.warnings.join(" ")).toContain("한 번도 기동된 적이 없습니다");
  });

  test("기동 이력이 있으면 미기동 경고를 내지 않는다", async () => {
    const reg = defaultRegistry();
    reg.last_tick = new Date().toISOString();
    reg.projects.push({
      id: "a", repo: dir, model: "claude-opus-5", permission_args: [],
      status: "active", consecutive_errors: 0, limit_hits: 0, next_retry_at: null,
      last_launch: { ts: new Date().toISOString(), result: "ok", log: "x.log" },
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    await saveRegistry(reg, env);
    const r = (await HANDLERS["watchdog_status"]!({})) as { warnings: string[] };
    expect(r.warnings.join(" ")).not.toContain("한 번도 기동된 적이 없습니다");
  });

  test("레지스트리 파손을 건강함으로 보고하지 않는다", async () => {
    await writeFile(userPaths(env).registry, "{ 깨진", "utf8");
    const r = (await HANDLERS["watchdog_status"]!({})) as { warnings: string[]; registry_state: string };
    expect(r.registry_state).toBe("corrupt");
    expect(r.warnings.join(" ")).toContain("파손");
  });

  test("프로젝트 요약에 백오프·오류 카운터가 실린다 — 왜 안 도는지 보이게", async () => {
    const reg = defaultRegistry();
    reg.projects.push({
      id: "a", repo: dir, model: "claude-opus-5", permission_args: [],
      status: "error", consecutive_errors: 5, limit_hits: 2,
      next_retry_at: "2026-12-31T00:00:00Z",
      last_launch: { ts: "2026-01-01T00:00:00Z", result: "error", log: "x.log" },
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    await saveRegistry(reg, env);
    const r = (await HANDLERS["watchdog_status"]!({})) as {
      projects: { status: string; consecutive_errors: number; limit_hits: number; next_retry_at: string }[];
    };
    expect(r.projects[0]!.status).toBe("error");
    expect(r.projects[0]!.consecutive_errors).toBe(5);
    expect(r.projects[0]!.limit_hits).toBe(2);
    expect(r.projects[0]!.next_retry_at).toBe("2026-12-31T00:00:00Z");
  });
});
