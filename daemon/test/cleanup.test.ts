/**
 * 잔재 정리 회귀 — **지우는 코드는 지우면 안 되는 것을 지웠을 때 가장 비싸다.**
 *
 * 여기서 고정하는 것은 두 축이다:
 *   ① v1 정리가 **v1 것만** 지우는가 — 레지스트리·데몬 로그·설치본 EXE·사용자가 직접
 *      넣은 훅은 살아남아야 한다. 정리가 이것들을 건드리면 사용자는 설치할 때마다
 *      주행 이력을 잃고, 그 원인을 정리 탓이라고 생각하지 못한다.
 *   ② v2 초기화가 **고른 경우에만** 일어나는가 — 기본은 보존이다.
 *
 * 외부 명령(cron·schtasks)은 전부 주입된 러너로 흘려보낸다. 이 테스트는 실제 스케줄러도
 * 실제 crontab 도 건드리지 않는다(CLAUDE.md 6절).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userPaths } from "../src/core/paths.ts";
import { TASK_NAME } from "../src/install/autostart.ts";
import type { CommandResult, CommandRunner } from "../src/install/autostart.ts";
import {
  V1_CRON_MARK,
  V1_HOOK_MARKERS,
  V1_TASK_NAME,
  hasV2State,
  isV1HookCommand,
  purgeV1,
  purgeV1Wiring,
  registeredRepos,
  resetV2,
  stripV1Hooks,
  summarize,
  v1Leftovers,
  v2StateTargets,
} from "../src/install/cleanup.ts";

let home = "";
let work = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-clean-"));
  work = await mkdtemp(join(tmpdir(), "ah-cleanwork-"));
  env = { ...process.env, AUTOHARNESS_HOME: home, APPDATA: work };
  await mkdir(userPaths(env).logs, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

/** 실행된 명령을 기록만 하는 러너 — 실제 시스템은 건드리지 않는다. */
function recorder(
  reply: (argv: readonly string[]) => Partial<CommandResult> = () => ({}),
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    const r = reply(argv);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }) as CommandRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

/** 아무것도 없는 상태로 만드는 러너 — cron 도 스케줄러 작업도 없다. */
const emptySystem = () => recorder(() => ({ code: 1 }));

/**
 * 존재 확인 — **`Bun.file().exists()` 를 쓰지 않는다.**
 *
 * 그쪽은 디렉토리에 대해 언제나 false 다. 정리 대상의 절반이 디렉토리(스킬 bin·logs)라,
 * 그것으로 "지워졌다" 를 확인하면 지우지 않아도 통과한다 — 검증이 없는 것과 같다.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function write(path: string, body = "x"): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

/** v1 이 계정에 남긴 것들을 실제로 만들어 둔다. */
async function seedV1(): Promise<void> {
  const p = userPaths(env);
  await write(join(p.skillDir, "bin", "harness_engine.py"), "# v1");
  await write(join(p.skillDir, "bin", "__pycache__", "harness_engine.pyc"), "bytes");
  await write(join(p.skillDir, "templates", "agent_harness.sh"), "#!/bin/sh");
  await write(join(p.runtimeDir, "watchdog.lock"), "1234");
  await write(join(p.logs, "watchdog.log"), "old");
  await write(join(p.logs, "cron.log"), "old");
}

/** v2 가 쓰는 것들 — 정리가 절대 건드리면 안 되는 자리. */
async function seedV2(): Promise<void> {
  const p = userPaths(env);
  await write(p.registry, JSON.stringify({ schema_version: 1, settings: {}, projects: [] }));
  await write(p.daemonLog, "boot");
  await write(p.webToken, "token");
  await write(join(p.runtimeDir, "bin", "autoharness"), "EXE");
  await write(join(p.skillDir, "SKILL.md"), "문서");
  await write(join(p.skillDir, "templates", "bootstrap_prompt.txt"), "프롬프트");
}

describe("정리 대상의 경계", () => {
  test("v1 목록에 v2 의 상태가 하나도 없다", () => {
    const list = v1Leftovers(env);
    const p = userPaths(env);
    for (const keep of [p.registry, p.registryLock, p.daemonLog, p.logs, p.lock, p.daemonInfo]) {
      expect(list).not.toContain(keep);
    }
  });

  test("v1 워치독 작업 이름이 v2 데몬 작업 이름과 다르다", () => {
    // 같아지는 순간 정리가 사용자의 자동 시작을 꺼 버린다 — 설치할 때마다.
    expect(V1_TASK_NAME).not.toBe(TASK_NAME);
  });

  test("초기화 목록에 실행 파일 자리가 없다", () => {
    // 있으면 설치 도중 자기 자신을 지운다.
    const binDir = join(userPaths(env).runtimeDir, "bin");
    for (const target of v2StateTargets(env)) {
      expect(target === binDir || target.startsWith(`${binDir}\\`) || target.startsWith(`${binDir}/`)).toBe(false);
    }
  });

  test("초기화 목록에 스킬 폴더가 없다 — 설치가 채우는 자리다", () => {
    expect(v2StateTargets(env)).not.toContain(userPaths(env).skillDir);
  });
});

describe("v1 잔재 제거", () => {
  test("v1 파일을 지우고 v2 상태는 남긴다", async () => {
    await seedV1();
    await seedV2();
    const p = userPaths(env);

    const r = await purgeV1({ env, runner: emptySystem(), platform: "linux" });

    expect(r.removed).toBeGreaterThanOrEqual(5);
    expect(r.failed).toBe(0);
    for (const gone of v1Leftovers(env)) expect(await pathExists(gone)).toBe(false);
    // __pycache__ 는 bin 을 통째로 지우면서 함께 사라진다
    expect(await pathExists(join(p.skillDir, "bin", "__pycache__", "harness_engine.pyc"))).toBe(false);

    for (const kept of [p.registry, p.daemonLog, p.webToken, join(p.runtimeDir, "bin", "autoharness"),
      join(p.skillDir, "SKILL.md"), join(p.skillDir, "templates", "bootstrap_prompt.txt")]) {
      expect(await pathExists(kept)).toBe(true);
    }
  });

  test("두 번 실행해도 같은 결과다 — 두 번째는 지울 것이 없다", async () => {
    await seedV1();
    await purgeV1({ env, runner: emptySystem(), platform: "linux" });
    const second = await purgeV1({ env, runner: emptySystem(), platform: "linux" });
    expect(second.removed).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.entries.every((e) => e.action === "absent")).toBe(true);
  });

  test("없는 것을 지웠다고 하지 않는다", async () => {
    const r = await purgeV1({ env, runner: emptySystem(), platform: "linux" });
    expect(r.removed).toBe(0);
    expect(summarize(r, "v1 잔재 없음")).toBe("v1 잔재 없음");
  });

  test("dry-run 은 아무것도 지우지 않는다", async () => {
    await seedV1();
    const r = await purgeV1({ env, runner: emptySystem(), platform: "linux", dryRun: true });
    expect(r.removed).toBe(0);
    expect(r.entries.some((e) => e.action === "planned")).toBe(true);
    for (const path of v1Leftovers(env)) expect(await pathExists(path)).toBe(true);
  });
});

describe("워치독 등록 해제", () => {
  test("cron 에 워치독 줄이 있으면 그 줄만 지운다", async () => {
    const other = "0 3 * * * /usr/bin/backup.sh";
    const mark = `*/15 * * * * python ~/.claude/skills/autoharness/bin/${V1_CRON_MARK} >> /dev/null`;
    let written = "";
    const run = recorder((argv) => {
      if (argv[1] === "-l") return { code: 0, stdout: `${other}\n${mark}\n` };
      return { code: 0 };
    });
    // crontab <파일> 로 넘어간 내용을 그대로 읽어 본다 — 무엇을 남겼는지가 핵심이다
    const spy: CommandRunner = async (argv) => {
      if (argv[0] === "crontab" && argv[1] !== "-l") written = await readFile(argv[1]!, "utf8");
      return run(argv);
    };

    const r = await purgeV1({ env, runner: spy, platform: "linux" });

    expect(written).toContain(other);
    expect(written).not.toContain(V1_CRON_MARK);
    expect(r.entries.some((e) => e.target.includes("cron") && e.action === "removed")).toBe(true);
  });

  test("cron 에 워치독 줄이 없으면 crontab 을 다시 쓰지 않는다", async () => {
    const run = recorder((argv) => (argv[1] === "-l" ? { code: 0, stdout: "0 3 * * * backup\n" } : { code: 0 }));
    await purgeV1({ env, runner: run, platform: "linux" });
    expect(run.calls.filter((c) => c[0] === "crontab" && c[1] !== "-l").length).toBe(0);
  });

  test("crontab 이 없는 시스템에서도 실패하지 않는다", async () => {
    const boom: CommandRunner = async () => {
      throw new Error("crontab: command not found");
    };
    const r = await purgeV1({ env, runner: boom, platform: "linux" });
    expect(r.failed).toBe(0);
  });

  test("Windows 는 v1 작업이 있을 때만 지운다", async () => {
    const present = recorder(() => ({ code: 0 }));
    await purgeV1({ env, runner: present, platform: "win32" });
    expect(present.calls.some((c) => c.includes("/Delete") && c.includes(V1_TASK_NAME))).toBe(true);

    const absent = emptySystem();
    await purgeV1({ env, runner: absent, platform: "win32" });
    expect(absent.calls.some((c) => c.includes("/Delete"))).toBe(false);
  });

  test("Windows 정리는 v2 데몬 작업을 건드리지 않는다", async () => {
    const run = recorder(() => ({ code: 0 }));
    await purgeV1({ env, runner: run, platform: "win32" });
    expect(run.calls.some((c) => c.includes(TASK_NAME))).toBe(false);
  });
});

describe("훅 명령 판별", () => {
  test("v1 명령을 알아본다", () => {
    expect(isV1HookCommand('python "C:/x/bin/harness_engine.py" hook-prebash --repo .')).toBe(true);
    expect(isV1HookCommand("bash scripts/agent_harness.sh --task t")).toBe(true);
  });

  test("v2 명령과 남의 훅은 건드리지 않는다", () => {
    expect(isV1HookCommand('"C:/Users/x/.claude/autoharness/bin/autoharness.exe" hook-prebash --repo .')).toBe(false);
    expect(isV1HookCommand("npm run lint")).toBe(false);
  });

  test("표식이 v1 파일 이름들이다", () => {
    expect(V1_HOOK_MARKERS).toContain("harness_engine.py");
  });
});

describe("설정에서 v1 훅만 걷어낸다", () => {
  test("v1 훅은 지우고 사용자 훅은 남긴다", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "python bin/harness_engine.py hook-prebash" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "npm run guard" }] },
        ],
      },
    };
    const { removed } = stripV1Hooks(settings);
    expect(removed.length).toBe(1);
    expect(settings.hooks.PreToolUse.length).toBe(1);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("npm run guard");
  });

  test("같은 항목 안에 섞여 있으면 v1 것만 뺀다", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "python bin/harness_engine.py hook-stop" },
              { type: "command", command: "echo bye" },
            ],
          },
        ],
      },
    };
    stripV1Hooks(settings);
    expect(settings.hooks.Stop[0]!.hooks.length).toBe(1);
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe("echo bye");
  });

  test("훅이 아닌 설정은 그대로 둔다", () => {
    const settings = { permissions: { allow: ["Bash(ls:*)"] }, model: "opus" };
    const { removed } = stripV1Hooks(settings);
    expect(removed.length).toBe(0);
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);
  });
});

describe("저장소 배선 교체", () => {
  let repo = "";

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ah-repo-"));
    await mkdir(join(repo, ".claude"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const V1_SETTINGS = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "python /old/bin/harness_engine.py hook-prebash --repo ." }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "python /old/bin/harness_engine.py hook-stop --repo ." }] }],
    },
  };

  async function seedRepo(settings: unknown = V1_SETTINGS): Promise<string> {
    const path = join(repo, ".claude", "settings.json");
    await writeFile(path, JSON.stringify(settings, null, 2), "utf8");
    return path;
  }

  test("v1 배선을 지우고 v2 배선을 심는다", async () => {
    const path = await seedRepo();
    const exe = join(home, "bin", "autoharness.exe");

    const entry = await purgeV1Wiring(repo, { exePath: exe });

    expect(entry.action).toBe("removed");
    const after = JSON.parse(await readFile(path, "utf8"));
    const commands = Object.values(after.hooks as Record<string, { hooks: { command: string }[] }[]>)
      .flat()
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.every((c) => !c.includes("harness_engine.py"))).toBe(true);
    expect(commands.some((c) => c.includes(exe))).toBe(true);
    // 게이트 4종이 다 심겼는가 — 하나라도 빠지면 그 경로로 우회된다
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
      expect(Object.keys(after.hooks)).toContain(event);
    }
  });

  test("원본을 백업한 뒤에만 바꾼다", async () => {
    await seedRepo();
    const entry = await purgeV1Wiring(repo, { exePath: join(home, "autoharness") });
    const backup = /원본 백업: (.+)\)/.exec(entry.detail)?.[1];
    expect(backup).toBeTruthy();
    expect(JSON.parse(await readFile(backup!, "utf8")).hooks.Stop[0].hooks[0].command).toContain("harness_engine.py");
  });

  test("장부는 한 바이트도 건드리지 않는다", async () => {
    await seedRepo();
    const tracker = join(repo, ".claude", "agent_tracker.json");
    const body = JSON.stringify({ schema_version: 1, tasks: [{ id: "t", status: "done" }] }, null, 2);
    await writeFile(tracker, body, "utf8");

    await purgeV1Wiring(repo, { exePath: join(home, "autoharness") });

    expect(await readFile(tracker, "utf8")).toBe(body);
  });

  test("v1 배선이 없으면 손대지 않는다", async () => {
    const path = await seedRepo({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm run guard" }] }] } });
    const before = await readFile(path, "utf8");
    const entry = await purgeV1Wiring(repo, { exePath: join(home, "autoharness") });
    expect(entry.action).toBe("absent");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("설정이 파손됐으면 덮어쓰지 않고 실패로 알린다", async () => {
    const path = join(repo, ".claude", "settings.json");
    await writeFile(path, "{ 깨진 JSON", "utf8");
    const entry = await purgeV1Wiring(repo, { exePath: join(home, "autoharness") });
    expect(entry.action).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("{ 깨진 JSON");
  });

  test("설정이 아예 없으면 만들지 않는다 — 등록되지 않은 저장소를 배선하지 않는다", async () => {
    await rm(join(repo, ".claude"), { recursive: true, force: true });
    const entry = await purgeV1Wiring(repo, { exePath: join(home, "autoharness") });
    expect(entry.action).toBe("absent");
    expect(await pathExists(join(repo, ".claude", "settings.json"))).toBe(false);
  });

  test("dry-run 은 파일을 바꾸지 않는다", async () => {
    const path = await seedRepo();
    const before = await readFile(path, "utf8");
    const entry = await purgeV1Wiring(repo, { exePath: join(home, "autoharness"), dryRun: true });
    expect(entry.action).toBe("planned");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("레지스트리에 등록된 저장소를 대상으로 삼는다", async () => {
    await seedRepo();
    await write(
      userPaths(env).registry,
      JSON.stringify({
        schema_version: 1,
        settings: {},
        projects: [{ id: "p", repo, model: "opus", permission_args: [], status: "active" }],
      }),
    );
    expect(await registeredRepos(env)).toEqual([repo]);

    const r = await purgeV1({
      env, runner: emptySystem(), platform: "linux", exePath: join(home, "autoharness"),
    });
    expect(r.entries.some((e) => e.target.includes(repo) && e.action === "removed")).toBe(true);
  });

  test("실행 파일 경로를 모르면 배선에 손대지 않는다", async () => {
    const path = await seedRepo();
    const before = await readFile(path, "utf8");
    await purgeV1({ env, runner: emptySystem(), platform: "linux", repos: [repo] });
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("v2 상태 초기화", () => {
  test("고른 경우에만 지운다 — 레지스트리·로그·토큰", async () => {
    await seedV2();
    const p = userPaths(env);

    const r = await resetV2({ env });

    expect(r.failed).toBe(0);
    for (const gone of [p.registry, p.webToken, p.logs]) {
      expect(await pathExists(gone)).toBe(false);
    }
  });

  test("실행 파일과 스킬 문서는 남는다", async () => {
    await seedV2();
    await resetV2({ env });
    expect(await pathExists(join(userPaths(env).runtimeDir, "bin", "autoharness"))).toBe(true);
    expect(await pathExists(join(userPaths(env).skillDir, "SKILL.md"))).toBe(true);
  });

  test("저장소 장부는 계정 상태가 아니다 — 지우지 않는다", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ah-repo-"));
    const tracker = join(repo, ".claude", "agent_tracker.json");
    await write(tracker, "{}");
    await seedV2();
    await resetV2({ env });
    expect(await pathExists(tracker)).toBe(true);
    await rm(repo, { recursive: true, force: true });
  });

  test("파손 대피본도 함께 치운다", async () => {
    const corrupt = join(userPaths(env).runtimeDir, "registry.json.corrupt-20260101T000000Z");
    await write(corrupt, "{ 깨짐");
    await resetV2({ env });
    expect(await pathExists(corrupt)).toBe(false);
  });

  test("dry-run 은 지우지 않는다", async () => {
    await seedV2();
    const r = await resetV2({ env, dryRun: true });
    expect(r.removed).toBe(0);
    expect(await pathExists(userPaths(env).registry)).toBe(true);
  });

  test("지울 상태가 있는지 알려 준다 — 설치기가 물을지 판단하는 근거", async () => {
    await rm(userPaths(env).logs, { recursive: true, force: true });
    expect(await hasV2State(env)).toBe(false);
    await write(userPaths(env).registry, "{}");
    expect(await hasV2State(env)).toBe(true);
  });
});
