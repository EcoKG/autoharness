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
  /** 실패했지만 설치를 못 쓰게 만들지는 않는 단계들 — 눈에 띄게 남긴다. */
  warnings: string[];
}

/**
 * 설치 성패를 가르는 단계들.
 *
 * 자동 시작은 여기 없다. systemd 가 없는 호스트(WSL 이 흔하다)에서 등록 실패는 정상이고,
 * 그때도 EXE·스킬·MCP 는 다 깔려서 **바로 쓸 수 있는 설치**다. 그런데 종전에는 어느 단계든
 * 실패하면 ok=false 였고, 원라인이 그 자리에서 중단해 확인 명령과 PATH 안내가 통째로
 * 사라졌다 — 다 깔린 것을 두고 사용자는 설치가 실패했다고 읽는다.
 *
 * 되는 척은 여전히 안 한다: 그 단계의 state 는 failed 로 남고 warnings 에도 실린다.
 */
export const REQUIRED_STEPS = new Set(["exe", "skill", "mcp"]);

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

/**
 * 이 파일이 **정말 우리 EXE 인가** — 실행해서 버전을 확인한다.
 *
 * 왜 행동으로 보는가: 파일명·크기 같은 간접 신호는 속는다. 실측 사고가 그 증거다 —
 * `bun run ... install` 로 설치하면 `process.execPath` 가 **bun.exe** 여서, 런타임을
 * `autoharness.exe` 라는 이름으로 복사해 놓고 성공을 보고했다. 그 결과 MCP 가
 * "Script not found" 로 즉시 죽어 도구 14종이 통째로 사라졌는데 설치는 ok 였다.
 *
 * 이름이 맞고 크기도 비슷했지만 동작이 달랐다. 그래서 동작을 본다.
 */
export async function looksLikeOurExe(
  path: string,
  runner?: CommandRunner,
): Promise<{ ok: boolean; detail: string }> {
  if (!(await isFile(path))) return { ok: false, detail: `파일이 없습니다: ${path}` };
  try {
    const exec = runner ?? (await import("./autostart.ts")).realRunner;
    const r = await exec([path, "version"]);
    const out = `${r.stdout}${r.stderr}`.trim();
    if (r.code !== 0) return { ok: false, detail: `version 실행 실패(exit ${r.code}): ${out.slice(0, 200)}` };
    if (!/^\d+\.\d+\.\d+/.test(out)) {
      return {
        ok: false,
        detail:
          `우리 실행 파일이 아닙니다 — version 응답: ${JSON.stringify(out.slice(0, 120))}. ` +
          "(`bun run` 으로 설치하면 process.execPath 가 bun.exe 라 런타임이 복사됩니다. " +
          "`bun run build` 후 `--exe dist/autoharness.exe` 로 지정하십시오.)",
      };
    }
    return { ok: true, detail: `버전 ${out} 확인` };
  } catch (err) {
    return { ok: false, detail: `확인 실패: ${String(err)}` };
  }
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

/**
 * MCP 등록 성공 문구.
 *
 * "등록했습니다" 는 **눈앞의 세션에서는 아직 참이 아니다.** 등록은 설정 파일에 쓰이고
 * 도구는 다음에 시작하는 세션부터 로드된다. 그래서 열어 둔 세션으로 돌아간 사용자는
 * 도구도 스킬도 찾지 못하고 설치가 실패했다고 읽는다 — rc 파일에 PATH 를 넣고 바로
 * command not found 를 보는 것과 정확히 같은 부류다.
 *
 * v1 설치기 둘(install.ps1·install.sh)에는 이 안내가 있는데 v2 에만 없었다. v2 원라인은
 * 설치 함수 끝에서 그대로 종료하므로 공용 마무리 안내에 닿지도 않는다.
 */
export const MCP_REGISTERED_DETAIL =
  "사용자 스코프에 autoharness 를 등록했습니다. " +
  "도구는 새로 시작하는 Claude Code 세션부터 보입니다 — 열려 있는 세션은 재시작하십시오.";

/**
 * 붙여넣으면 **그대로 실행되는** 명령 문자열로 만든다.
 *
 * 종전에는 수동 등록 안내가 첫 토큰(`claude`)을 잘라 냈다. 안내가 "claude CLI 를 찾지
 * 못했습니다" 로 시작하니 읽으면 뜻은 통하지만, 복사해 붙여넣으면 `mcp: command not found`
 * 다. 이 분기는 claude 가 없을 때만 타므로 **등록 방법을 알려 주는 유일한 출구**인데 그
 * 한 줄이 실행 불가였다.
 *
 * 경로에 공백이 있으면 토큰이 쪼개진다 — Windows 사용자명에 공백은 흔하다. 실제 실행은
 * 배열로 하므로 무해하지만, 사람이 붙여넣는 순간 깨진다.
 *
 * 안내와 dry-run 이 같은 함수를 쓰게 해서 둘이 다시 갈라지지 않게 한다.
 */
export function shellCommand(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

/**
 * 실행 중인 파일은 덮어쓸 수 없다 — Windows 는 EBUSY/EPERM, 리눅스는 ETXTBSY 로 거절한다.
 *
 * 이건 드문 사고가 아니라 **갱신의 기본 경로**다. 설치해서 쓰다가 새 버전을 올리려는 순간,
 * 그 순간에 데몬과 MCP 서버가 바로 그 파일을 잡고 있다. 원문(`EBUSY: resource busy`)만
 * 던지면 무엇을 멈춰야 하는지 알 수 없어 갱신이 거기서 멈춘다.
 */
export function updateBlockedHint(err: unknown, platform: NodeJS.Platform): string | null {
  const code = (err as { code?: string } | null)?.code;
  if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES" && code !== "ETXTBSY") return null;
  const stop =
    platform === "win32"
      ? 'powershell -Command "Get-Process autoharness -ErrorAction SilentlyContinue | Stop-Process -Force"'
      : "pkill -f 'autoharness daemon'";
  return (
    `설치본이 실행 중이라 덮어쓸 수 없습니다(${code}). 데몬·MCP 서버를 멈춘 뒤 다시 실행하십시오:\n` +
    `  ${stop}\n` +
    "  멈춘 뒤 install 을 다시 실행하면 데몬은 다음 기동에서 새 버전으로 올라옵니다."
  );
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const platform = options.platform ?? process.platform;
  const source = options.sourceExe ?? process.execPath;
  const target = installedExePath(env);
  const steps: Step[] = [];

  // 1. EXE 배치 — **원본이 우리 것인지 먼저 확인한다**(런타임을 복사하는 사고 방지)
  const sourceCheck = await looksLikeOurExe(source, options.runner);
  if (!(await isFile(source))) {
    steps.push(step("exe", "failed", `설치할 실행 파일이 없습니다: ${source}`));
  } else if (!sourceCheck.ok) {
    steps.push(step("exe", "failed", sourceCheck.detail));
  } else if (source === target) {
    steps.push(step("exe", "skipped", "이미 설치 위치에서 실행 중입니다."));
  } else if (dryRun) {
    steps.push(step("exe", "ok", `(dry-run) ${source} → ${target} (${sourceCheck.detail})`));
  } else {
    try {
      await mkdir(join(userPaths(env).runtimeDir, "bin"), { recursive: true });
      await copyFile(source, target);
      steps.push(step("exe", "ok", `${basename(source)} → ${target}`));
    } catch (err) {
      // 잠금이면 조치 방법까지 말한다 — 그 외에는 사유를 그대로 보여 준다
      const hint = updateBlockedHint(err, platform);
      steps.push(step("exe", "failed", hint ?? `복사 실패: ${String(err)}`));
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
      step("mcp", "skipped", `claude CLI 를 찾지 못했습니다 — 수동 등록: ${shellCommand(mcpArgs)}`),
    );
  } else if (dryRun) {
    steps.push(step("mcp", "ok", `(dry-run) ${shellCommand(mcpArgs)}`));
  } else {
    try {
      const exec = runner ?? (await import("./autostart.ts")).realRunner;
      // 같은 이름이 이미 있으면 add 가 실패하므로 먼저 지운다(멱등)
      await exec(["claude", "mcp", "remove", "--scope", "user", "autoharness"]).catch(() => null);
      const r = await exec(mcpArgs);
      steps.push(
        r.code === 0
          ? step("mcp", "ok", MCP_REGISTERED_DETAIL)
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
      exePath: target, runner: options.runner, platform, dryRun, env,
    });
    steps.push(step("autostart", r.ok ? "ok" : "failed", `${r.mechanism}: ${r.detail}`));
  }

  const failed = steps.filter((s) => s.state === "failed");
  return {
    ok: !failed.some((s) => REQUIRED_STEPS.has(s.name)),
    dryRun,
    exePath: target,
    steps,
    warnings: failed.filter((s) => !REQUIRED_STEPS.has(s.name)).map((s) => `${s.name}: ${s.detail}`),
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

  // **env 를 반드시 전달한다.** 넘기지 않으면 startupFolderPath 가 process.env 를 보고
  // **실제 사용자 시작프로그램 폴더**를 가리킨다 — 격리된 테스트가 사용자의 자동 시작을
  // 조용히 해제하던 실측 사고의 원인이었다.
  const auto = await unregisterAutostart({
    runner: options.runner, platform: options.platform ?? process.platform, dryRun, env,
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
  return { ok: true, dryRun, exePath: installedExePath(env), steps, warnings: [] };
}

/** 설치 상태 조회 — 무엇이 실제로 걸려 있는가. */
export async function installStatus(options: UninstallOptions = {}) {
  const env = options.env ?? process.env;
  const exe = installedExePath(env);
  // 파일이 있다고 설치된 것이 아니다 — 실행해서 우리 것인지 본다(런타임이 놓여 있던 실측 사고)
  const check = await looksLikeOurExe(exe, options.runner);
  return {
    exe_path: exe,
    exe_installed: check.ok,
    exe_present: await isFile(exe),
    exe_check: check.detail,
    skill_dir: userPaths(env).skillDir,
    skill_installed: await isDir(userPaths(env).skillDir),
    autostart: await autostartStatus({
      runner: options.runner, platform: options.platform ?? process.platform, env,
    }),
  };
}
