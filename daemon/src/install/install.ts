/**
 * 설치 — EXE 배치, 스킬 문서 배치, MCP 등록, 로그온 자동 시작.
 *
 * **되는 척하지 않는다.** 각 단계는 성공·건너뜀·실패를 구분해 보고하고, 하나가 실패해도
 * 나머지를 계속한 뒤 전체 결과에 그 사실을 남긴다. v1 이 "등록됨" 만 보고하다 몇 주간
 * 죽어 있던 것을 몰랐던 이유가 바로 단계별 실상을 감췄기 때문이다.
 *
 * `--dry-run` 은 아무것도 바꾸지 않고 **무엇을 할지**만 돌려준다. 시스템에 영구 설정을
 * 심는 작업이므로, 실행 전에 확인할 수단이 있어야 한다.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { userPaths } from "../core/paths.ts";
import {
  autostartStatus,
  registerAutostart,
  unregisterAutostart,
  type CommandRunner,
  type AutostartResult,
} from "./autostart.ts";

export type StepState = "ok" | "skipped" | "failed";

export interface Step {
  name: string;
  state: StepState;
  detail: string;
}

export interface InstallResult {
  ok: boolean;
  dryRun: boolean;
  exePath: string;
  steps: Step[];
}

export interface InstallOptions {
  /** 설치할 EXE 원본. 기본은 지금 실행 중인 실행 파일이다. */
  sourceExe?: string;
  /** 스킬 문서 원본 디렉토리(저장소의 skill/). 없으면 배치 단계를 건너뛴다. */
  skillSource?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
  /** 로그온 자동 시작까지 걸 것인가. 시스템에 영구 설정을 심으므로 기본은 끈다. */
  autostart?: boolean;
}

function step(name: string, state: StepState, detail: string): Step {
  return { name, state, detail };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 설치본 EXE 자리 — 실행 중인 EXE 를 자기 자신 위에 덮어쓰지 않도록 경로를 비교한다. */
export function installedExePath(env: NodeJS.ProcessEnv = process.env): string {
  const name = process.platform === "win32" ? "autoharness.exe" : "autoharness";
  return join(userPaths(env).runtimeDir, "bin", name);
}

async function copyTree(src: string, dst: string): Promise<number> {
  await mkdir(dst, { recursive: true });
  let count = 0;
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) count += await copyTree(from, to);
    else {
      await copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const platform = options.platform ?? process.platform;
  const source = options.sourceExe ?? process.execPath;
  const target = installedExePath(env);
  const steps: Step[] = [];

  // 1. EXE 배치
  if (!(await isFile(source))) {
    steps.push(step("exe", "failed", `설치할 실행 파일이 없습니다: ${source}`));
  } else if (source === target) {
    steps.push(step("exe", "skipped", "이미 설치 위치에서 실행 중입니다."));
  } else if (dryRun) {
    steps.push(step("exe", "ok", `(dry-run) ${source} → ${target}`));
  } else {
    try {
      await mkdir(join(userPaths(env).runtimeDir, "bin"), { recursive: true });
      await copyFile(source, target);
      steps.push(step("exe", "ok", `${basename(source)} → ${target}`));
    } catch (err) {
      // 실행 중인 파일을 덮어쓰면 Windows 에서 잠금 오류가 난다 — 사유를 그대로 보여 준다
      steps.push(step("exe", "failed", `복사 실패: ${String(err)}`));
    }
  }

  // 2. 스킬 문서 배치
  const skillSrc = options.skillSource;
  const skillDst = userPaths(env).skillDir;
  if (!skillSrc) {
    steps.push(step("skill", "skipped", "스킬 원본 경로가 지정되지 않았습니다."));
  } else if (!(await isDir(skillSrc))) {
    steps.push(step("skill", "failed", `스킬 원본이 없습니다: ${skillSrc}`));
  } else if (dryRun) {
    steps.push(step("skill", "ok", `(dry-run) ${skillSrc} → ${skillDst}`));
  } else {
    try {
      const n = await copyTree(skillSrc, skillDst);
      steps.push(step("skill", "ok", `${n}개 파일 → ${skillDst}`));
    } catch (err) {
      steps.push(step("skill", "failed", `복사 실패: ${String(err)}`));
    }
  }

  // 3. MCP 등록 — claude CLI 가 있을 때만. 없으면 수동 등록 안내로 넘어간다.
  const runner = options.runner;
  const claude = Bun.which("claude");
  const mcpArgs = ["claude", "mcp", "add", "--scope", "user", "autoharness", "--", target, "mcp"];
  if (!claude && !dryRun && !runner) {
    steps.push(
      step("mcp", "skipped", `claude CLI 를 찾지 못했습니다 — 수동 등록: ${mcpArgs.slice(1).join(" ")}`),
    );
  } else if (dryRun) {
    steps.push(step("mcp", "ok", `(dry-run) ${mcpArgs.join(" ")}`));
  } else {
    try {
      const exec = runner ?? (await import("./autostart.ts")).realRunner;
      // 같은 이름이 이미 있으면 add 가 실패하므로 먼저 지운다(멱등)
      await exec(["claude", "mcp", "remove", "--scope", "user", "autoharness"]).catch(() => null);
      const r = await exec(mcpArgs);
      steps.push(
        r.code === 0
          ? step("mcp", "ok", "사용자 스코프에 autoharness 를 등록했습니다.")
          : step("mcp", "failed", `등록 실패(exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`),
      );
    } catch (err) {
      steps.push(step("mcp", "failed", String(err)));
    }
  }

  // 4. 로그온 자동 시작 — **기본은 걸지 않는다.** 시스템에 영구 설정을 심는 일이라
  //    명시적으로 요청받았을 때만 한다.
  if (!options.autostart) {
    steps.push(step("autostart", "skipped", "--autostart 를 주면 로그온 자동 시작을 등록합니다."));
  } else {
    const r: AutostartResult = await registerAutostart({
      exePath: target, runner: options.runner, platform, dryRun,
    });
    steps.push(step("autostart", r.ok ? "ok" : "failed", `${r.mechanism}: ${r.detail}`));
  }

  return {
    ok: steps.every((s) => s.state !== "failed"),
    dryRun,
    exePath: target,
    steps,
  };
}

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
}

/** 제거 — 자동 시작과 MCP 등록을 되돌린다. **장부·레지스트리는 건드리지 않는다.** */
export async function uninstall(options: UninstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const steps: Step[] = [];

  const auto = await unregisterAutostart({
    runner: options.runner, platform: options.platform ?? process.platform, dryRun,
  });
  steps.push(step("autostart", auto.ok ? "ok" : "skipped", auto.detail));

  if (dryRun) {
    steps.push(step("mcp", "ok", "(dry-run) claude mcp remove --scope user autoharness"));
  } else {
    try {
      const exec = options.runner ?? (await import("./autostart.ts")).realRunner;
      const r = await exec(["claude", "mcp", "remove", "--scope", "user", "autoharness"]);
      steps.push(
        step("mcp", r.code === 0 ? "ok" : "skipped", r.code === 0 ? "MCP 등록을 제거했습니다." : "등록 없음"),
      );
    } catch (err) {
      steps.push(step("mcp", "skipped", String(err)));
    }
  }

  steps.push(
    step("data", "skipped", "장부·레지스트리·로그는 남깁니다 — 진행 상태를 지우지 않습니다."),
  );
  return { ok: true, dryRun, exePath: installedExePath(env), steps };
}

/** 설치 상태 조회 — 무엇이 실제로 걸려 있는가. */
export async function installStatus(options: UninstallOptions = {}) {
  const env = options.env ?? process.env;
  const exe = installedExePath(env);
  return {
    exe_path: exe,
    exe_installed: await isFile(exe),
    skill_dir: userPaths(env).skillDir,
    skill_installed: await isDir(userPaths(env).skillDir),
    autostart: await autostartStatus({
      runner: options.runner, platform: options.platform ?? process.platform,
    }),
  };
}
