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
  platform?: NodeJS.Platform;
  dryRun?: boolean;
  taskName?: string;
  /** systemd 유닛을 쓸 때 파일을 쓰는 주체. 테스트가 갈아끼운다. */
  writeUnit?: (path: string, body: string) => Promise<void>;
  unitDir?: string;
}

export interface AutostartResult {
  ok: boolean;
  mechanism: "schtasks-onlogon" | "systemd-user" | "unsupported";
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
    return {
      ok: r.code === 0,
      mechanism: "schtasks-onlogon",
      commands,
      detail:
        r.code === 0
          ? `로그온 트리거로 등록했습니다: ${options.taskName ?? TASK_NAME}`
          : `등록 실패(exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
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
    const r = await run(runner, windowsUnregisterArgs(options.taskName), dryRun, commands);
    return {
      ok: r.code === 0,
      mechanism: "schtasks-onlogon",
      commands,
      // 없는 작업을 지우려는 것은 실패가 아니다 — 제거는 멱등해야 한다
      detail: r.code === 0 ? "자동 시작 등록을 제거했습니다." : `제거 실패 또는 등록 없음(exit ${r.code})`,
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
  options: Pick<AutostartOptions, "runner" | "platform" | "taskName"> = {},
): Promise<AutostartStatus> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? realRunner;
  if (platform === "win32") {
    const r = await runner(windowsQueryArgs(options.taskName)).catch(() => ({
      code: 1, stdout: "", stderr: "",
    }));
    return { registered: r.code === 0, mechanism: "schtasks-onlogon", raw: (r.stdout || r.stderr).trim() };
  }
  const r = await runner(["systemctl", "--user", "is-enabled", SYSTEMD_UNIT]).catch(() => ({
    code: 1, stdout: "", stderr: "",
  }));
  return { registered: r.code === 0, mechanism: "systemd-user", raw: (r.stdout || r.stderr).trim() };
}
