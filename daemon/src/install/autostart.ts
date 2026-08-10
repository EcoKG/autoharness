/**
 * 로그온 자동 시작 등록 — **시간 트리거는 쓰지 않는다.**
 *
 * 이 PC 에서 시간 트리거 작업 전체가 `0x800710E0`(요청 거부)으로 큐에만 쌓이고 실행되지
 * 않았다. 마이크로소프트 자기 작업도, `cmd /c echo` 짜리 최소 작업도 같았다 — 작업 정의
 * 문제가 아니다. 배터리 조건 해제·재등록·재부팅 전부 무효였고, **로그온 트리거만 정상**이었다
 * (daemon/DESIGN.md 0절). 그래서 기동은 로그온 트리거 하나만 쓰고, 그 뒤로는 상주 데몬이
 * 자기 시계로 돈다.
 *
 * 모든 외부 명령은 주입 가능한 러너를 거친다 — 테스트가 실제 스케줄러를 건드리지 않는다.
 */
export const TASK_NAME = "AutoHarnessDaemon";
export const SYSTEMD_UNIT = "autoharness-daemon.service";
export const STARTUP_LAUNCHER = "AutoHarnessDaemon.cmd";

/**
 * 시작프로그램 폴더 경로 — **승격이 필요 없는 로그온 자동 시작 수단.**
 *
 * 실측: 이 PC 에서 `schtasks /Create /SC ONLOGON` 이 `/RU` 유무와 무관하게 "Access is
 * denied" 로 거부되고 PowerShell `Register-ScheduledTask` 도 같다. 작업 스케줄러 등록에
 * 권한이 필요한 환경이 실재한다는 뜻이다. 그 환경에서 자동 시작을 포기하면 v2 의 자동
 * 부활 보장이 통째로 무효가 된다 — v1 이 실패한 바로 그 지점이므로 폴백이 필수다.
 *
 * 이 폴더는 사용자가 눈으로 확인하고 지울 수 있다는 점에서 레지스트리 Run 키보다 낫다.
 */
export function startupFolderPath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env["APPDATA"] ?? `${env["USERPROFILE"] ?? ""}/AppData/Roaming`;
  return `${appData}/Microsoft/Windows/Start Menu/Programs/Startup/${STARTUP_LAUNCHER}`;
}

/**
 * 시작프로그램 런처 내용.
 * `start "" /min` 으로 띄우고 즉시 반환한다 — 로그온마다 콘솔 창이 남아 있으면 안 된다.
 */
export function startupLauncherBody(exePath: string): string {
  return [
    "@echo off",
    "rem AutoHarness 데몬 로그온 자동 시작 (작업 스케줄러 등록이 권한으로 거부될 때의 폴백)",
    "rem 이 파일을 지우면 자동 시작이 해제됩니다.",
    `start "" /min "${exePath}" daemon`,
    "",
  ].join("\r\n");
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

export const realRunner: CommandRunner = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
};

/**
 * Windows 등록 인자.
 *
 * `/SC ONLOGON` 만 쓴다(`/SC MINUTE` 금지 — 위 실측). `/RL LIMITED` 로 권한을 올리지 않는다:
 * 자동 주행 데몬이 관리자로 뜰 이유가 없고, 올리면 UAC 승격이 필요해 무인 설치가 깨진다.
 */
export function windowsRegisterArgs(exePath: string, taskName = TASK_NAME): string[] {
  return [
    "schtasks", "/Create", "/TN", taskName, "/SC", "ONLOGON",
    "/TR", `"${exePath}" daemon`, "/RL", "LIMITED", "/F",
  ];
}

export function windowsUnregisterArgs(taskName = TASK_NAME): string[] {
  return ["schtasks", "/Delete", "/TN", taskName, "/F"];
}

export function windowsQueryArgs(taskName = TASK_NAME): string[] {
  return ["schtasks", "/Query", "/TN", taskName, "/FO", "LIST"];
}

/** systemd --user 유닛 본문 — `default.target` 은 사용자 로그온 시 활성화된다. */
export function systemdUnit(exePath: string): string {
  return [
    "[Unit]",
    "Description=AutoHarness daemon (자율 주행 스케줄러)",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exePath} daemon`,
    "Restart=on-failure",
    "RestartSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface AutostartOptions {
  exePath: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
  taskName?: string;
  /** systemd 유닛을 쓸 때 파일을 쓰는 주체. 테스트가 갈아끼운다. */
  writeUnit?: (path: string, body: string) => Promise<void>;
  unitDir?: string;
}

export interface AutostartResult {
  ok: boolean;
  mechanism: "schtasks-onlogon" | "startup-folder" | "systemd-user" | "unsupported";
  commands: string[][];
  detail: string;
}

async function run(
  runner: CommandRunner,
  argv: string[],
  dryRun: boolean,
  commands: string[][],
): Promise<CommandResult> {
  commands.push(argv);
  if (dryRun) return { code: 0, stdout: "(dry-run)", stderr: "" };
  return runner(argv);
}

export async function registerAutostart(options: AutostartOptions): Promise<AutostartResult> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? realRunner;
  const dryRun = options.dryRun === true;
  const commands: string[][] = [];

  if (platform === "win32") {
    const r = await run(runner, windowsRegisterArgs(options.exePath, options.taskName), dryRun, commands);
    if (r.code === 0) {
      return {
        ok: true,
        mechanism: "schtasks-onlogon",
        commands,
        detail: `로그온 트리거로 등록했습니다: ${options.taskName ?? TASK_NAME}`,
      };
    }

    // 스케줄러 등록이 권한으로 거부되는 환경이 실재한다(실측). 자동 시작을 포기하면
    // 자동 부활 보장이 통째로 무효가 되므로, 승격이 필요 없는 수단으로 넘어간다.
    const reason = (r.stderr || r.stdout).trim().slice(0, 200);
    const launcher = startupFolderPath(options.env ?? process.env);
    commands.push(["write", launcher]);
    if (!dryRun) {
      try {
        await (options.writeUnit ?? defaultWriteUnit)(launcher, startupLauncherBody(options.exePath));
      } catch (err) {
        return {
          ok: false,
          mechanism: "unsupported",
          commands,
          detail:
            `스케줄러 등록이 거부됐고(${reason}) 시작프로그램 폴더에도 쓰지 못했습니다: ${String(err)}`,
        };
      }
    }
    return {
      ok: true,
      mechanism: "startup-folder",
      commands,
      detail:
        `스케줄러 등록이 거부돼(${reason}) 시작프로그램 폴더로 등록했습니다: ${launcher} ` +
        "(승격 불필요, 이 파일을 지우면 해제됩니다)",
    };
  }

  // POSIX: systemd --user 가 있으면 그것을, 없으면 **지원하지 않는다고 밝힌다**.
  // 되는 척하고 아무 데도 등록하지 않으면 v1 이 겪은 '등록됐는데 안 도는' 상태의 재판이다.
  const probe = await runner(["systemctl", "--user", "--version"]).catch(() => ({
    code: 1, stdout: "", stderr: "systemctl 없음",
  }));
  if (probe.code !== 0) {
    return {
      ok: false,
      mechanism: "unsupported",
      commands,
      detail:
        "이 환경에서는 자동 시작을 등록할 수단을 찾지 못했습니다(systemd --user 없음). " +
        `로그인 스크립트에 \`${options.exePath} daemon &\` 을 직접 추가하십시오.`,
    };
  }

  const dir = options.unitDir ?? `${process.env["HOME"] ?? "~"}/.config/systemd/user`;
  const path = `${dir}/${SYSTEMD_UNIT}`;
  commands.push(["write", path]);
  if (!dryRun) await (options.writeUnit ?? defaultWriteUnit)(path, systemdUnit(options.exePath));
  const reload = await run(runner, ["systemctl", "--user", "daemon-reload"], dryRun, commands);
  const enable = await run(runner, ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT], dryRun, commands);
  const ok = reload.code === 0 && enable.code === 0;
  return {
    ok,
    mechanism: "systemd-user",
    commands,
    detail: ok
      ? `systemd --user 유닛을 등록·기동했습니다: ${path}`
      : `등록 실패: ${(enable.stderr || reload.stderr).trim().slice(0, 300)}`,
  };
}

async function defaultWriteUnit(path: string, body: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

export async function unregisterAutostart(
  options: Omit<AutostartOptions, "exePath"> & { exePath?: string } = {},
): Promise<AutostartResult> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? realRunner;
  const dryRun = options.dryRun === true;
  const commands: string[][] = [];

  if (platform === "win32") {
    // 두 수단을 모두 정리한다 — 어느 쪽으로 걸렸는지 몰라도 해제는 확실해야 한다(멱등)
    const r = await run(runner, windowsUnregisterArgs(options.taskName), dryRun, commands);
    const launcher = startupFolderPath(options.env ?? process.env);
    let removedLauncher = false;
    commands.push(["remove", launcher]);
    if (!dryRun) {
      // `force: true` 는 파일이 없어도 성공하므로 그것만 보면 "제거했다" 고 잘못 보고한다.
      // 실제로 있던 것을 지웠을 때만 제거로 센다.
      const existed = await Bun.file(launcher).exists();
      if (existed) {
        const { rm } = await import("node:fs/promises");
        removedLauncher = await rm(launcher, { force: true }).then(() => true).catch(() => false);
      }
    }
    const scheduled = r.code === 0;
    return {
      // **멱등**: 이 호출이 끝난 뒤 자동 시작이 없으면 성공이다. 애초에 없었던 것도
      // 성공이지 실패가 아니다 — 없는 것을 지우려 했다고 오류를 내면 재실행이 불가능해진다.
      ok: true,
      mechanism: scheduled ? "schtasks-onlogon" : "startup-folder",
      commands,
      detail: scheduled
        ? "스케줄러 등록과 시작프로그램 런처를 모두 제거했습니다."
        : removedLauncher
          ? "시작프로그램 런처를 제거했습니다(스케줄러 등록 없음)."
          : "제거할 등록이 없습니다(이미 해제된 상태).",
    };
  }
  const disable = await run(runner, ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], dryRun, commands);
  return {
    ok: disable.code === 0,
    mechanism: "systemd-user",
    commands,
    detail: disable.code === 0 ? "systemd 유닛을 비활성화했습니다." : "제거 실패 또는 등록 없음",
  };
}

export interface AutostartStatus {
  registered: boolean;
  mechanism: AutostartResult["mechanism"];
  raw: string;
}

export async function autostartStatus(
  options: Pick<AutostartOptions, "runner" | "platform" | "taskName" | "env"> = {},
): Promise<AutostartStatus> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? realRunner;
  if (platform === "win32") {
    const r = await runner(windowsQueryArgs(options.taskName)).catch(() => ({
      code: 1, stdout: "", stderr: "",
    }));
    if (r.code === 0) {
      return { registered: true, mechanism: "schtasks-onlogon", raw: (r.stdout || r.stderr).trim() };
    }
    // 스케줄러에 없다고 자동 시작이 없는 것은 아니다 — 폴백 수단도 본다
    const launcher = startupFolderPath(options.env ?? process.env);
    const present = await Bun.file(launcher).exists();
    return {
      registered: present,
      mechanism: present ? "startup-folder" : "schtasks-onlogon",
      raw: present ? launcher : (r.stdout || r.stderr).trim(),
    };
  }
  const r = await runner(["systemctl", "--user", "is-enabled", SYSTEMD_UNIT]).catch(() => ({
    code: 1, stdout: "", stderr: "",
  }));
  return { registered: r.code === 0, mechanism: "systemd-user", raw: (r.stdout || r.stderr).trim() };
}
