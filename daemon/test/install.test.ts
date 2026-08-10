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
import { VERSION } from "../src/version.ts";
import {
  STARTUP_LAUNCHER,
  TASK_NAME,
  autostartStatus,
  registerAutostart,
  startupFolderPath,
  startupLauncherBody,
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
  MCP_REGISTERED_DETAIL,
  REQUIRED_STEPS,
  shellCommand,
  uninstall,
  updateBlockedHint,
} from "../src/install/install.ts";

let home = "";
let work = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-inst-"));
  work = await mkdtemp(join(tmpdir(), "ah-instsrc-"));
  // **APPDATA 까지 격리한다.** AUTOHARNESS_HOME 만 바꾸면 자동 시작 경로는 여전히
  // 실제 사용자 시작프로그램 폴더를 가리킨다 — 그래서 uninstall 테스트가 사용자의
  // 자동 시작을 실제로 지웠다(실측). 이 한 줄이 그 사고의 최종 방어선이다.
  env = { ...process.env, AUTOHARNESS_HOME: home, APPDATA: work };
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
    const r = await registerAutostart({
      exePath: "C:/x.exe", runner: run, platform: "win32", env: { APPDATA: work },
    });
    expect(r.ok).toBe(true);
    expect(r.mechanism).toBe("schtasks-onlogon");
    expect(run.calls[0]![0]).toBe("schtasks");
  });

  test("스케줄러 등록 실패를 성공으로 보고하지 않는다", async () => {
    // 폴백이 생긴 뒤에도 '스케줄러로 걸렸다' 고 말해서는 안 된다 — 수단을 뭉개지 않는다.
    // (둘 다 실패하는 경우의 ok=false 는 폴백 describe 가 따로 덮는다)
    const run = recorder({ code: 1, stderr: "액세스가 거부되었습니다" });
    const r = await registerAutostart({
      exePath: "C:/x.exe", runner: run, platform: "win32",
      env: { APPDATA: work }, writeUnit: async () => {},
    });
    expect(r.mechanism).not.toBe("schtasks-onlogon");
    expect(r.detail).toContain("거부");
  });

  test("dry-run 은 아무 명령도 실행하지 않고 계획만 돌려준다", async () => {
    const run = recorder();
    const r = await registerAutostart({
      exePath: "C:/x.exe", runner: run, platform: "win32", dryRun: true, env: { APPDATA: work },
    });
    expect(run.calls.length).toBe(0);
    expect(r.commands[0]![0]).toBe("schtasks");
    expect(r.ok).toBe(true);
  });

  test("해제는 멱등하다 — 등록이 없어도 실패로 다루지 않는다", async () => {
    // 없는 것을 지우려 했다고 오류를 내면 재실행이 불가능해진다.
    // 호출이 끝난 뒤 자동 시작이 없으면 성공이다.
    const r = await unregisterAutostart({
      runner: recorder({ code: 1 }), platform: "win32", env: { APPDATA: join(work, "빈곳") },
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("이미 해제된 상태");
  });

  test("자동 시작 경로는 반드시 격리된 env 로만 만진다 (직접 호출)", async () => {
    // 실측 사고: env 를 안 주면 폴백이 **실제 사용자 시작프로그램 폴더**에 쓴다.
    const source = await readFile(join(import.meta.dir, "install.test.ts"), "utf8");
    const calls = source.match(/(registerAutostart|unregisterAutostart|autostartStatus)\(\{[^}]*\}/gs) ?? [];
    const winCalls = calls.filter((c) => c.includes('"win32"'));
    expect(winCalls.length).toBeGreaterThan(5);
    for (const c of winCalls) {
      const isolated = c.includes("env:") || c.includes("writeUnit:");
      expect(isolated, `격리되지 않은 호출: ${c.slice(0, 120)}`).toBe(true);
    }
  });

  test("테스트 env 자체가 APPDATA 까지 격리돼 있다", async () => {
    // env 를 전달해도 그 env 가 실제 APPDATA 를 담고 있으면 아무 소용이 없다.
    expect(env["APPDATA"]).toBe(work);
    expect(startupFolderPath(env).startsWith(work)).toBe(true);
    expect(startupFolderPath(env)).not.toBe(startupFolderPath(process.env));
  });

  test("간접 경로도 env 를 흘려보낸다 — 가드가 직접 호출만 봐서 놓쳤던 자리", async () => {
    // 실측 사고: uninstall(env) 은 격리돼 있었지만 안쪽 unregisterAutostart 에 env 를
    // 전달하지 않아, bun test 를 돌릴 때마다 **사용자의 실제 자동 시작이 해제**됐다.
    const source = await readFile(join(import.meta.dir, "..", "src", "install", "install.ts"), "utf8");
    const inner = source.match(/(registerAutostart|unregisterAutostart|autostartStatus)\(\{[^}]*\}/gs) ?? [];
    expect(inner.length).toBeGreaterThanOrEqual(3);
    for (const c of inner) {
      expect(c.includes("env"), `env 를 전달하지 않는 호출: ${c.slice(0, 140)}`).toBe(true);
    }
  });

  test("uninstall 이 실제 사용자 폴더를 건드리지 않는다", async () => {
    // 격리된 env 를 주면 그 안에서만 지워야 한다. 실제 경로가 대상이 되면 안 된다.
    const launcher = startupFolderPath({ APPDATA: work });
    await mkdir(join(work, "Microsoft/Windows/Start Menu/Programs/Startup"), { recursive: true });
    await writeFile(launcher, "격리된 런처", "utf8");

    const realPath = startupFolderPath(process.env);
    const realExisted = await Bun.file(realPath).exists();

    await uninstall({
      env: { ...env, APPDATA: work }, runner: recorder({ code: 1 }), platform: "win32",
    });

    expect(await Bun.file(launcher).exists()).toBe(false); // 격리본은 지워졌고
    expect(await Bun.file(realPath).exists()).toBe(realExisted); // 실제본은 그대로다
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
    const empty = { APPDATA: join(work, "빈곳") };
    expect(
      (await autostartStatus({ runner: recorder(), platform: "win32", env: empty })).registered,
    ).toBe(true);
    expect(
      (await autostartStatus({ runner: recorder({ code: 1 }), platform: "win32", env: empty })).registered,
    ).toBe(false);
  });
});

/**
 * 실측: 이 PC 에서 `schtasks /Create /SC ONLOGON` 이 `/RU` 유무와 무관하게 "Access is denied"
 * 로 거부되고 `Register-ScheduledTask` 도 같다. 작업 스케줄러 등록에 권한이 필요한 환경이
 * 실재한다. 거기서 자동 시작을 포기하면 **v2 의 자동 부활 보장이 통째로 무효**가 된다 —
 * v1 이 실패한 바로 그 지점이므로, 승격이 필요 없는 폴백이 있어야 한다.
 */
describe("승격 없는 자동 시작 폴백", () => {
  const denied = () => recorder({ code: 1, stderr: "ERROR: Access is denied." });

  test("스케줄러가 거부하면 시작프로그램 폴더로 넘어간다", async () => {
    const written: Array<[string, string]> = [];
    const r = await registerAutostart({
      exePath: "C:/bin/autoharness.exe",
      runner: denied(), platform: "win32", env: { APPDATA: work },
      writeUnit: async (p, b) => void written.push([p, b]),
    });
    expect(r.ok).toBe(true);
    expect(r.mechanism).toBe("startup-folder");
    expect(written[0]![0]).toContain("Startup");
    expect(written[0]![0]).toContain(STARTUP_LAUNCHER);
  });

  test("폴백 사실과 사유를 숨기지 않는다", async () => {
    const r = await registerAutostart({
      exePath: "C:/bin/autoharness.exe",
      runner: denied(), platform: "win32", env: { APPDATA: work },
      writeUnit: async () => {},
    });
    expect(r.detail).toContain("Access is denied");
    expect(r.detail).toContain("시작프로그램");
    expect(r.detail).toContain("지우면 해제");
  });

  test("스케줄러가 되면 폴백을 쓰지 않는다", async () => {
    const written: string[] = [];
    const r = await registerAutostart({
      exePath: "C:/bin/autoharness.exe",
      runner: recorder(), platform: "win32", env: { APPDATA: work },
      writeUnit: async (p) => void written.push(p),
    });
    expect(r.mechanism).toBe("schtasks-onlogon");
    expect(written.length).toBe(0);
  });

  test("경로를 문자열로 이어 붙이지 않는다 — 구분자가 섞이면 재귀 mkdir 이 EEXIST 로 죽는다", () => {
    // 실측: "C:\Users\x\AppData\Roaming/Microsoft/Windows/Start Menu/..." 처럼 섞인 경로에서
    // 이미 있는 디렉토리를 못 알아보고 mkdir 이 EEXIST 를 던져 폴백 등록이 통째로 실패했다.
    const backslash = String.fromCharCode(92);
    const appData = ["C:", "Users", "x", "AppData", "Roaming"].join(backslash);
    const p = startupFolderPath({ APPDATA: appData });
    expect(p).toContain(STARTUP_LAUNCHER);
    if (process.platform === "win32") {
      expect(p).not.toContain("/"); // 플랫폼 구분자로 정규화됐다
    }
  });

  test("APPDATA 가 없어도 사용자 폴더에서 경로를 만든다", () => {
    const p = startupFolderPath({ USERPROFILE: join(work, "user") });
    expect(p).toContain("Startup");
    expect(p).toContain(STARTUP_LAUNCHER);
  });

  test("런처가 콘솔 창을 남기지 않는다", () => {
    const body = startupLauncherBody("C:/Program Files/ah/autoharness.exe");
    expect(body).toContain("@echo off");
    expect(body).toContain("/min");
    expect(body).toContain('"C:/Program Files/ah/autoharness.exe" daemon'); // 공백 경로 보호
    expect(body).toContain("지우면 자동 시작이 해제"); // 사용자가 되돌릴 방법을 파일 안에 남긴다
  });

  test("둘 다 실패하면 성공이라 하지 않는다", async () => {
    const r = await registerAutostart({
      exePath: "C:/bin/autoharness.exe",
      runner: denied(), platform: "win32", env: { APPDATA: work },
      writeUnit: async () => {
        throw new Error("폴더에 쓸 수 없습니다");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.mechanism).toBe("unsupported");
    expect(r.detail).toContain("쓰지 못했습니다");
  });

  test("해제는 두 수단을 모두 정리한다", async () => {
    const launcher = startupFolderPath({ APPDATA: work });
    await mkdir(join(work, "Microsoft/Windows/Start Menu/Programs/Startup"), { recursive: true });
    await writeFile(launcher, "launcher", "utf8");

    const r = await unregisterAutostart({
      runner: denied(), platform: "win32", env: { APPDATA: work },
    });
    expect(r.ok).toBe(true);
    expect(await Bun.file(launcher).exists()).toBe(false); // 런처가 지워졌다
  });

  test("등록이 아예 없으면 제거할 것이 없다고 말한다", async () => {
    const r = await unregisterAutostart({
      runner: denied(), platform: "win32", env: { APPDATA: join(work, "빈곳") },
    });
    expect(r.detail).toContain("제거할 등록이 없습니다");
    expect(r.ok).toBe(true); // 멱등 — 없던 것도 성공이다
  });

  test("상태 조회가 폴백 등록도 찾아낸다", async () => {
    const launcher = startupFolderPath({ APPDATA: work });
    await mkdir(join(work, "Microsoft/Windows/Start Menu/Programs/Startup"), { recursive: true });
    await writeFile(launcher, "launcher", "utf8");

    const s = await autostartStatus({ runner: denied(), platform: "win32", env: { APPDATA: work } });
    expect(s.registered).toBe(true);
    expect(s.mechanism).toBe("startup-folder");
    expect(s.raw).toContain(STARTUP_LAUNCHER);
  });

  test("둘 다 없으면 미등록이다 — 오탐 금지", async () => {
    const s = await autostartStatus({
      runner: denied(), platform: "win32", env: { APPDATA: join(work, "빈곳") },
    });
    expect(s.registered).toBe(false);
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
  const goodRunner = recorder({ stdout: `${VERSION}\n` });
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
    expect(r.detail).toContain(VERSION);
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
  const okRunner = () => recorder({ stdout: `${VERSION}\n` });

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
    await install({ sourceExe: src, env, runner: recorder({ stdout: VERSION }), platform: "win32" });
    const s = await installStatus({ env, runner: recorder({ stdout: VERSION }), platform: "win32" });
    expect(s.exe_installed).toBe(true);
    expect(s.autostart.registered).toBe(true);
  });
});

/**
 * 갱신 경로 — 설치기가 가장 자주 만나는 실패다.
 *
 * 실측: 데몬이 도는 상태에서 새 빌드를 install 하면 EBUSY 로 실패하는데, 종전에는 오류
 * 원문만 나와서 무엇을 멈춰야 하는지 알 수 없었다. 받은 다음 바로 하는 일이 갱신이므로
 * 여기서 막히면 릴리스가 사실상 1회용이 된다.
 */
describe("실행 중 갱신 — 막힌 이유와 조치를 함께 말한다", () => {
  const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

  test("잠금 오류는 멈출 대상과 명령을 알려 준다", () => {
    const hint = updateBlockedHint(busy, "win32");
    expect(hint).not.toBeNull();
    expect(hint).toContain("EBUSY");
    expect(hint).toContain("Stop-Process");
  });

  test("플랫폼에 맞는 명령을 준다 — Windows 명령을 리눅스에 주지 않는다", () => {
    const hint = updateBlockedHint(busy, "linux");
    expect(hint).toContain("pkill");
    expect(hint).not.toContain("Stop-Process");
  });

  test("리눅스의 실행 중 바이너리 오류(ETXTBSY)도 같은 안내를 받는다", () => {
    const err = Object.assign(new Error("ETXTBSY"), { code: "ETXTBSY" });
    expect(updateBlockedHint(err, "linux")).not.toBeNull();
  });

  test("잠금이 아닌 오류를 잠금이라 하지 않는다", () => {
    const err = Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
    expect(updateBlockedHint(err, "win32")).toBeNull();
    expect(updateBlockedHint(new Error("코드 없는 오류"), "win32")).toBeNull();
  });
});

/**
 * 안내 명령은 **붙여넣으면 실행돼야 한다.**
 *
 * 실측 결함: claude CLI 가 없을 때 나오는 수동 등록 안내가 첫 토큰 `claude` 를 잘라
 * `mcp add --scope user ...` 를 출력했다. 이 분기는 claude 가 없을 때만 타므로 등록 방법을
 * 알려 주는 유일한 출구인데, 그 한 줄이 `mcp: command not found` 로 끝났다.
 */
describe("안내 명령 — 그대로 붙여넣어 실행된다", () => {
  test("첫 토큰을 자르지 않는다", () => {
    expect(shellCommand(["claude", "mcp", "add"])).toBe("claude mcp add");
  });

  test("공백 있는 경로를 감싼다 — Windows 사용자명에 공백은 흔하다", () => {
    const out = shellCommand(["claude", "mcp", "add", "--", "C:/Users/John Doe/ah.exe", "mcp"]);
    expect(out).toContain('"C:/Users/John Doe/ah.exe"');
    expect(out.startsWith("claude mcp add")).toBe(true);
  });

  test("따옴표가 든 인자를 깨뜨리지 않는다", () => {
    expect(shellCommand(['a"b'])).toBe('"a\\"b"');
  });

  test("수동 등록 안내와 dry-run 이 같은 명령을 낸다", async () => {
    const src = await mkdtemp(join(tmpdir(), "ah-cmd-"));
    const exe = join(src, "autoharness.exe");
    await writeFile(exe, "x", "utf8");
    const dry = await install({
      sourceExe: exe, env, dryRun: true, runner: recorder({ stdout: VERSION }), platform: "win32",
    });
    const mcpStep = dry.steps.find((s) => s.name === "mcp");
    // dry-run 문구는 "(dry-run) " 접두 뒤에 명령이 온다 — 그 명령이 claude 로 시작해야 한다
    expect(mcpStep?.detail).toContain("claude mcp add --scope user autoharness --");
    await rm(src, { recursive: true, force: true });
  });
});

/**
 * "등록했습니다" 는 눈앞의 세션에서는 아직 참이 아니다 — 그 사실을 말해야 한다.
 *
 * 실측 결함: 등록 성공 문구가 완료형으로 끝나서, 열어 둔 세션으로 돌아간 사용자가 도구도
 * 스킬도 찾지 못하고 설치 실패로 읽었다. v1 설치기 둘에는 이 안내가 있는데 v2 에만 없었고,
 * v2 원라인은 설치 함수 끝에서 종료해 공용 마무리 안내에 닿지도 않는다.
 */
describe("MCP 등록 안내 — 언제부터 보이는지 말한다", () => {
  test("성공 문구가 새 세션부터임을 밝힌다", () => {
    expect(MCP_REGISTERED_DETAIL).toContain("새로 시작하는");
    expect(MCP_REGISTERED_DETAIL).toContain("재시작");
  });

  test("실제 설치 결과에도 그 문구가 실린다", async () => {
    const src = await mkdtemp(join(tmpdir(), "ah-mcpnotice-"));
    const exe = join(src, "autoharness.exe");
    await writeFile(exe, "x", "utf8");
    const r = await install({
      sourceExe: exe, env, runner: recorder({ stdout: VERSION }), platform: "win32",
    });
    const mcp = r.steps.find((s) => s.name === "mcp");
    expect(mcp?.state).toBe("ok");
    expect(mcp?.detail).toContain("새로 시작하는");
    await rm(src, { recursive: true, force: true });
  });
});

/**
 * 자동 시작 실패가 설치 전체를 무효로 만들지 않는다.
 *
 * 실측 상황: systemd 가 없는 호스트(WSL 이 흔하다)에서 `--v2 --autostart` 를 쓰면 EXE·스킬·
 * MCP 는 다 깔리는데 자동 시작만 실패한다. 그런데 종전에는 어느 단계든 실패하면 ok=false 라
 * 원라인이 그 자리에서 중단했고, 확인 명령과 PATH 안내가 통째로 사라졌다. 사용자는 **다
 * 깔린 설치**를 두고 실패했다고 읽는다.
 *
 * 되는 척과는 다르다 — 단계 state 는 failed 로 남고 warnings 에 실린다.
 */
describe("자동 시작 실패는 설치를 무효로 만들지 않는다", () => {
  async function installWithFailingAutostart(): Promise<Awaited<ReturnType<typeof install>>> {
    const src = await mkdtemp(join(tmpdir(), "ah-auto-"));
    const exe = join(src, "autoharness.exe");
    await writeFile(exe, "x", "utf8");
    // 자동 시작만 실패시킨다. 명령별로 갈라야 한다 — 뭉뚱그려 실패시키면 MCP 등록까지
    // 실패해 '필수 단계 실패' 가 되어 검사하려는 상황이 만들어지지 않는다.
    // 리눅스 경로를 쓰는 이유: Windows 는 스케줄러가 막히면 시작프로그램 폴더로 대체돼
    // 자동 시작이 실제로는 성공한다(그 폴백 자체는 정상 동작이다).
    const runner = (async (argv: readonly string[]) => {
      if (argv[0] === "systemctl") return { code: 1, stdout: "", stderr: "systemd 없음" };
      if (argv.includes("version")) return { code: 0, stdout: VERSION, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }) as CommandRunner;
    const r = await install({
      sourceExe: exe, env, runner, platform: "linux", autostart: true,
    });
    await rm(src, { recursive: true, force: true });
    return r;
  }

  test("필수 단계 집합에 자동 시작이 없다", () => {
    expect(REQUIRED_STEPS.has("exe")).toBe(true);
    expect(REQUIRED_STEPS.has("mcp")).toBe(true);
    expect(REQUIRED_STEPS.has("autostart")).toBe(false);
  });

  test("자동 시작만 실패하면 설치는 성공으로 본다", async () => {
    const r = await installWithFailingAutostart();
    expect(r.steps.find((s) => s.name === "exe")?.state).toBe("ok");
    expect(r.ok).toBe(true);
  });

  test("되는 척하지 않는다 — 실패한 단계는 failed 로 남고 warnings 에 실린다", async () => {
    const r = await installWithFailingAutostart();
    const auto = r.steps.find((s) => s.name === "autostart");
    expect(auto?.state).toBe("failed");
    expect(r.warnings.some((w) => w.startsWith("autostart"))).toBe(true);
  });

  test("필수 단계가 실패하면 여전히 실패다", async () => {
    const src = await mkdtemp(join(tmpdir(), "ah-req-"));
    const r = await install({
      sourceExe: join(src, "없는파일.exe"), env, runner: recorder({ stdout: VERSION }),
      platform: "win32",
    });
    expect(r.ok).toBe(false);
    await rm(src, { recursive: true, force: true });
  });
});
