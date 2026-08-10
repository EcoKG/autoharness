/**
 * 설치·자동 시작 회귀.
 *
 * **시간 트리거를 쓰지 않는다**는 것이 이 모듈의 존재 이유다. 이 PC 에서 시간 트리거 작업
 * 전체가 0x800710E0 으로 반려돼 워치독이 설치 이후 한 번도 실행되지 않았고, 로그온 트리거만
 * 정상이었다(daemon/DESIGN.md 0절). 그래서 등록 인자에 `/SC MINUTE` 이 들어가면 그 자체가
 * 회귀다.
 *
 * 모든 외부 명령은 주입된 러너로 흘려보낸다 — 이 테스트는 실제 스케줄러·MCP 등록·설치본을
 * 건드리지 않는다(CLAUDE.md 6절).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userPaths } from "../src/core/paths.ts";
import {
  TASK_NAME,
  autostartStatus,
  registerAutostart,
  systemdUnit,
  unregisterAutostart,
  windowsRegisterArgs,
  windowsUnregisterArgs,
  type CommandResult,
  type CommandRunner,
} from "../src/install/autostart.ts";
import {
  install,
  installStatus,
  installedExePath,
  looksLikeOurExe,
  uninstall,
} from "../src/install/install.ts";

let home = "";
let work = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-inst-"));
  work = await mkdtemp(join(tmpdir(), "ah-instsrc-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

/** 실행된 명령을 기록만 하는 러너. 실제 시스템은 건드리지 않는다. */
function recorder(result: Partial<CommandResult> = {}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }) as CommandRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("로그온 트리거만 쓴다", () => {
  test("Windows 등록 인자가 ONLOGON 이다", () => {
    const args = windowsRegisterArgs("C:/bin/autoharness.exe");
    expect(args).toContain("/SC");
    expect(args[args.indexOf("/SC") + 1]).toBe("ONLOGON");
  });

  test("시간 트리거를 절대 쓰지 않는다 — 이 PC 에서 반려되는 종류다", () => {
    const args = windowsRegisterArgs("C:/bin/autoharness.exe").join(" ");
    expect(args).not.toContain("MINUTE");
    expect(args).not.toContain("HOURLY");
    expect(args).not.toContain("DAILY");
    expect(args).not.toContain("/MO");
  });

  test("권한을 올리지 않는다 — UAC 승격이 필요하면 무인 설치가 깨진다", () => {
    const args = windowsRegisterArgs("C:/bin/autoharness.exe");
    expect(args[args.indexOf("/RL") + 1]).toBe("LIMITED");
    expect(args).not.toContain("HIGHEST");
  });

  test("EXE 경로를 따옴표로 감싼다 — 공백 있는 경로가 깨지지 않는다", () => {
    const args = windowsRegisterArgs("C:/Program Files/ah/autoharness.exe");
    const tr = args[args.indexOf("/TR") + 1]!;
    expect(tr.startsWith('"')).toBe(true);
    expect(tr).toContain("daemon");
  });

  test("기본 작업 이름이 고정돼 있다", () => {
    expect(windowsRegisterArgs("x")).toContain(TASK_NAME);
    expect(windowsUnregisterArgs()).toContain(TASK_NAME);
  });

  test("systemd 유닛도 로그온 기준이다", () => {
    const unit = systemdUnit("/usr/local/bin/autoharness");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("ExecStart=/usr/local/bin/autoharness daemon");
    expect(unit).not.toContain("OnCalendar"); // systemd 의 시간 트리거도 쓰지 않는다
  });
});

describe("등록·해제", () => {
  test("Windows 등록이 성공을 보고한다", async () => {
    const run = recorder();
    const r = await registerAutostart({ exePath: "C:/x.exe", runner: run, platform: "win32" });
    expect(r.ok).toBe(true);
    expect(r.mechanism).toBe("schtasks-onlogon");
    expect(run.calls[0]![0]).toBe("schtasks");
  });

  test("등록 실패를 성공으로 보고하지 않는다", async () => {
    const run = recorder({ code: 1, stderr: "액세스가 거부되었습니다" });
    const r = await registerAutostart({ exePath: "C:/x.exe", runner: run, platform: "win32" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("거부");
  });

  test("dry-run 은 아무 명령도 실행하지 않고 계획만 돌려준다", async () => {
    const run = recorder();
    const r = await registerAutostart({
      exePath: "C:/x.exe", runner: run, platform: "win32", dryRun: true,
    });
    expect(run.calls.length).toBe(0);
    expect(r.commands[0]![0]).toBe("schtasks");
    expect(r.ok).toBe(true);
  });

  test("해제는 멱등하다 — 등록이 없어도 실패로 다루지 않는다", async () => {
    const r = await unregisterAutostart({
      runner: recorder({ code: 1 }), platform: "win32",
    });
    expect(r.detail).toContain("등록 없음");
  });

  test("systemd 가 없으면 지원하지 않는다고 밝힌다 — 되는 척하지 않는다", async () => {
    const run = recorder({ code: 1 });
    const r = await registerAutostart({ exePath: "/x", runner: run, platform: "linux" });
    expect(r.ok).toBe(false);
    expect(r.mechanism).toBe("unsupported");
    expect(r.detail).toContain("daemon &");
  });

  test("systemd 가 있으면 유닛을 쓰고 enable 한다", async () => {
    const run = recorder();
    const written: string[] = [];
    const r = await registerAutostart({
      exePath: "/usr/local/bin/autoharness",
      runner: run,
      platform: "linux",
      unitDir: join(work, "systemd"),
      writeUnit: async (path, body) => {
        written.push(path);
        await mkdir(join(work, "systemd"), { recursive: true });
        await writeFile(path, body, "utf8");
      },
    });
    expect(r.ok).toBe(true);
    expect(r.mechanism).toBe("systemd-user");
    expect(written[0]).toContain("autoharness-daemon.service");
    expect(run.calls.some((c) => c.includes("enable"))).toBe(true);
  });

  test("상태 조회가 등록 여부를 알린다", async () => {
    expect((await autostartStatus({ runner: recorder(), platform: "win32" })).registered).toBe(true);
    expect(
      (await autostartStatus({ runner: recorder({ code: 1 }), platform: "win32" })).registered,
    ).toBe(false);
  });
});

/**
 * 실측 사고: 사용자 환경에 설치된 autoharness.exe 가 우리 바이너리가 아니라 **Bun 런타임**
 * 이었다. `bun run ... install` 로 설치하면 `process.execPath` 가 bun.exe 이기 때문이다.
 * 이름도 맞고 크기도 비슷했지만 실행하면 "Script not found" 로 죽었고, 그래서 MCP 도구
 * 14종이 통째로 사라졌는데 설치는 ok 를 보고했다 — 조용한 실패의 정확한 표본이다.
 */
describe("원본 검증 — 런타임을 설치하고 성공이라 하지 않는다", () => {
  /** version 에 우리 형식으로 답하는 원본(정상). */
  const goodRunner = recorder({ stdout: "2.0.0-dev\n" });
  /** bun.exe 를 복사했을 때 실제로 나오는 응답. */
  const bunRunner = recorder({ code: 1, stderr: 'error: Script not found "version"' });

  async function candidate(name = "autoharness.exe"): Promise<string> {
    const p = join(work, name);
    await writeFile(p, "바이너리 내용", "utf8");
    return p;
  }

  test("버전에 제대로 답하면 우리 것으로 본다", async () => {
    const r = await looksLikeOurExe(await candidate(), goodRunner);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("2.0.0-dev");
  });

  test("런타임을 복사한 경우를 잡아낸다", async () => {
    const r = await looksLikeOurExe(await candidate(), bunRunner);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Script not found");
  });

  test("이름만 같고 엉뚱한 응답을 내면 거부한다 — 간접 신호로는 속는다", async () => {
    const weird = recorder({ stdout: "Python 3.9.13" });
    const r = await looksLikeOurExe(await candidate(), weird);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("우리 실행 파일이 아닙니다");
  });

  test("없는 파일은 확인 자체가 실패한다", async () => {
    expect((await looksLikeOurExe(join(work, "없음.exe"), goodRunner)).ok).toBe(false);
  });

  test("설치가 잘못된 원본을 복사하지 않는다", async () => {
    const src = await candidate();
    const r = await install({
      sourceExe: src, env, runner: bunRunner, platform: "win32",
    });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.name === "exe")!.state).toBe("failed");
    // 복사 자체가 일어나지 않아야 한다 — 깨진 설치본을 남기지 않는다
    expect(await Bun.file(installedExePath(env)).exists()).toBe(false);
  });

  test("거부 사유가 무엇을 하라는지 알려 준다", async () => {
    const r = await looksLikeOurExe(await candidate(), recorder({ stdout: "엉뚱" }));
    expect(r.detail).toContain("bun run build");
    expect(r.detail).toContain("--exe");
  });

  test("상태 조회가 '파일은 있는데 우리 것이 아님'을 구분한다", async () => {
    const src = await candidate();
    await install({ sourceExe: src, env, runner: goodRunner, platform: "win32" });
    // 설치는 됐지만 이후 그 자리의 파일이 엉뚱해진 상황
    const status = await installStatus({ env, runner: bunRunner, platform: "win32" });
    expect(status.exe_present).toBe(true);
    expect(status.exe_installed).toBe(false); // 존재 != 설치됨
    expect(status.exe_check).toContain("Script not found");
  });
});

describe("설치", () => {
  /** 정상 원본처럼 굴게 하려면 version 응답이 필요하다. */
  const okRunner = () => recorder({ stdout: "2.0.0-dev\n" });

  async function fakeExe(): Promise<string> {
    const p = join(work, "autoharness.exe");
    await writeFile(p, "가짜 실행 파일", "utf8");
    return p;
  }

  test("EXE 를 설치 위치로 복사한다", async () => {
    const src = await fakeExe();
    const r = await install({ sourceExe: src, env, runner: okRunner(), platform: "win32" });
    expect(r.ok).toBe(true);
    expect(await Bun.file(installedExePath(env)).exists()).toBe(true);
    expect(r.steps.find((s) => s.name === "exe")!.state).toBe("ok");
  });

  test("스킬 문서를 배치한다", async () => {
    const src = await fakeExe();
    const skill = join(work, "skill");
    await mkdir(join(skill, "templates"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "문서", "utf8");
    await writeFile(join(skill, "templates", "t.txt"), "템플릿", "utf8");

    const r = await install({ sourceExe: src, skillSource: skill, env, runner: okRunner(), platform: "win32" });
    expect(r.steps.find((s) => s.name === "skill")!.state).toBe("ok");
    expect(await readFile(join(userPaths(env).skillDir, "SKILL.md"), "utf8")).toBe("문서");
    expect(await Bun.file(join(userPaths(env).skillDir, "templates", "t.txt")).exists()).toBe(true);
  });

  test("자동 시작은 기본으로 걸지 않는다 — 영구 설정은 명시 요청에만", async () => {
    const src = await fakeExe();
    const run = okRunner();
    const r = await install({ sourceExe: src, env, runner: run, platform: "win32" });
    expect(r.steps.find((s) => s.name === "autostart")!.state).toBe("skipped");
    expect(run.calls.some((c) => c[0] === "schtasks")).toBe(false);
  });

  test("--autostart 를 주면 등록한다", async () => {
    const src = await fakeExe();
    const run = okRunner();
    const r = await install({
      sourceExe: src, env, runner: run, platform: "win32", autostart: true,
    });
    expect(r.steps.find((s) => s.name === "autostart")!.state).toBe("ok");
    expect(run.calls.some((c) => c[0] === "schtasks" && c.includes("ONLOGON"))).toBe(true);
  });

  test("MCP 등록은 먼저 지우고 다시 넣는다 — 재설치가 실패하지 않게", async () => {
    const src = await fakeExe();
    const run = okRunner();
    await install({ sourceExe: src, env, runner: run, platform: "win32" });
    const mcpCalls = run.calls.filter((c) => c[1] === "mcp");
    expect(mcpCalls[0]).toContain("remove");
    expect(mcpCalls[1]).toContain("add");
    expect(mcpCalls[1]!.at(-1)).toBe("mcp"); // <exe> mcp 로 등록한다
  });

  test("한 단계가 실패해도 나머지를 계속하고 전체를 실패로 보고한다", async () => {
    const r = await install({
      sourceExe: join(work, "없는파일.exe"), env, runner: okRunner(), platform: "win32",
    });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.name === "exe")!.state).toBe("failed");
    expect(r.steps.length).toBeGreaterThanOrEqual(4); // 뒤 단계들도 수행됐다
  });

  test("dry-run 은 아무것도 바꾸지 않는다", async () => {
    const src = await fakeExe();
    const run = okRunner();
    const r = await install({
      sourceExe: src, env, runner: run, platform: "win32", autostart: true, dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    // 부작용 명령은 하나도 없어야 한다. 원본을 확인하는 `version` 은 읽기 전용 탐침이고,
    // dry-run 이 "이 설치가 될지" 를 알려주려면 오히려 실행해야 한다.
    const mutating = run.calls.filter(
      (c) => c[0] === "schtasks" || (c[1] === "mcp" && (c.includes("add") || c.includes("remove"))),
    );
    expect(mutating.length).toBe(0);
    expect(run.calls.every((c) => c.at(-1) === "version")).toBe(true);
    expect(await Bun.file(installedExePath(env)).exists()).toBe(false);
    expect(r.steps.every((s) => s.state !== "failed")).toBe(true);
  });
});

describe("제거", () => {
  test("자동 시작과 MCP 를 되돌리되 진행 상태는 남긴다", async () => {
    const run = recorder();
    const r = await uninstall({ env, runner: run, platform: "win32" });
    expect(r.steps.find((s) => s.name === "autostart")).toBeDefined();
    expect(r.steps.find((s) => s.name === "mcp")).toBeDefined();
    const data = r.steps.find((s) => s.name === "data")!;
    expect(data.state).toBe("skipped");
    expect(data.detail).toContain("장부");
  });

  test("dry-run 제거도 아무 명령을 실행하지 않는다", async () => {
    const run = recorder();
    await uninstall({ env, runner: run, platform: "win32", dryRun: true });
    expect(run.calls.length).toBe(0);
  });
});

describe("상태 조회", () => {
  test("설치되지 않은 상태를 정확히 알린다", async () => {
    const s = await installStatus({ env, runner: recorder({ code: 1 }), platform: "win32" });
    expect(s.exe_installed).toBe(false);
    expect(s.skill_installed).toBe(false);
    expect(s.autostart.registered).toBe(false);
    expect(s.exe_path).toContain("autoharness");
  });

  test("설치 후에는 그것이 드러난다", async () => {
    const src = join(work, "autoharness.exe");
    await writeFile(src, "x", "utf8");
    await install({ sourceExe: src, env, runner: recorder({ stdout: "2.0.0-dev" }), platform: "win32" });
    const s = await installStatus({ env, runner: recorder({ stdout: "2.0.0-dev" }), platform: "win32" });
    expect(s.exe_installed).toBe(true);
    expect(s.autostart.registered).toBe(true);
  });
});
