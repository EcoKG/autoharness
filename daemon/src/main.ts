/**
 * AutoHarness v2 진입점 — 하나의 EXE 를 argv 로 모드 분기한다.
 *
 * 훅 모드는 매 Bash 호출마다 도는 단발 실행이라 **시작 시간이 계약**이다
 * (daemon/DESIGN.md 3절: p95 150ms). 그래서 이 파일 최상단에서는 무거운 모듈을
 * import 하지 않는다 — 각 모드가 필요한 것만 동적으로 불러온다. 정적 import 를
 * 추가하면 훅을 포함한 **모든** 모드의 시작 비용이 된다.
 */

import { EXIT } from "./exit.ts";
import { VERSION } from "./version.ts";

export { EXIT };

export const MODES = [
  "daemon",
  "mcp",
  "hook-prebash",
  "hook-postbash",
  "hook-stop",
  "brief",
  "run",
  "next",
  "status",
  "render",
  "detect",
  "init",
  "add-task",
  "set-task",
  "set-config",
  "heartbeat",
  "sync-commit",
  "model-recommend",
  "selftest",
  "install",
  "version",
] as const;

export type Mode = (typeof MODES)[number];

export function isMode(value: string | undefined): value is Mode {
  return value !== undefined && (MODES as readonly string[]).includes(value);
}

// 버전은 src/version.ts 하나가 정한다 — 재수출로 기존 사용처를 그대로 둔다
export { VERSION } from "./version.ts";

function usage(): string {
  return [
    `autoharness ${VERSION}`,
    "",
    "사용법: autoharness <모드> [옵션]",
    "",
    "모드:",
    ...MODES.map((m) => `  ${m}`),
    "",
    "종료 코드: 0=통과 1=검증 실패 2=사용법/설정 오류 3=진행 가능 작업 없음 4=한도 도달",
  ].join("\n");
}

function installUsage(): string {
  return [
    "사용법: autoharness install [옵션]",
    "",
    "  --dry-run            무엇을 할지만 보여 주고 아무것도 바꾸지 않는다",
    "  --status             현재 설치 상태를 조회한다",
    "  --exe <경로>         설치할 실행 파일(개발 실행에서는 반드시 지정)",
    "  --skill <경로>       스킬 문서 원본 디렉토리",
    "  --autostart          로그온 자동 시작까지 등록한다(기본은 등록하지 않음)",
    "  --keep               기존 런타임 상태를 보존한다(기본값)",
    "  --reset              기존 런타임 상태(레지스트리·로그·토큰)를 지우고 새로 시작한다",
    "  --uninstall          자동 시작·MCP 등록을 되돌린다(장부는 건드리지 않음)",
    "  --migrate <저장소>   그 저장소의 훅 배선을 v1 에서 v2 로 교체한다",
    "  --rollback <저장소> --backup <파일>   교체를 되돌린다",
    "",
    "이전 버전(v1) 의 잔재는 선택과 무관하게 언제나 정리한다 — 부를 코드가 없는 파일이다.",
    "설치는 부작용이 있는 명령이다 — 알 수 없는 옵션은 실행하지 않고 거부한다.",
  ].join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];

  if (mode === undefined || mode === "--help" || mode === "-h") {
    console.log(usage());
    return mode === undefined ? EXIT.USAGE : EXIT.OK;
  }

  if (!isMode(mode)) {
    console.error(`[autoharness] 알 수 없는 모드입니다: ${mode}`);
    console.error(usage());
    return EXIT.USAGE;
  }

  if (mode === "version") {
    console.log(VERSION);
    return EXIT.OK;
  }

  const rest = argv.slice(1);
  switch (mode) {
    case "init":
    case "add-task":
    case "set-task":
    case "set-config":
    case "next":
    case "status":
    case "render":
    case "heartbeat":
    case "detect":
    case "model-recommend":
    case "sync-commit":
    case "run": {
      const cli = await import("./cli.ts");
      const flags = cli.parseFlags(rest);
      const handlers = {
        init: cli.cmdInit,
        "add-task": cli.cmdAddTask,
        "set-task": cli.cmdSetTask,
        "set-config": cli.cmdSetConfig,
        next: cli.cmdNext,
        status: cli.cmdStatus,
        render: cli.cmdRender,
        heartbeat: cli.cmdHeartbeat,
        detect: cli.cmdDetect,
        "model-recommend": cli.cmdModelRecommend,
        "sync-commit": cli.cmdSyncCommit,
        run: cli.cmdRun,
      } as const;
      return handlers[mode](flags);
    }
    case "mcp": {
      const { serve } = await import("./mcp/protocol.ts");
      return serve();
    }
    case "daemon": {
      const cli = await import("./cli.ts");
      const flags = cli.parseFlags(rest);
      const { ensureRegistry, runDaemon } = await import("./daemon/daemon.ts");
      await ensureRegistry();
      const controller = new AbortController();
      // 콘솔에서 Ctrl+C 로 내릴 수 있어야 한다 — 잠금을 남기고 죽으면 다음 기동이 막힌다
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => controller.abort());
      }
      const interval = Number(flags["interval"]);
      const result = await runDaemon({
        // 값이 없거나 말이 안 되면 기본 간격을 쓴다 — 0 이나 NaN 으로 바쁜 루프를 만들지 않는다
        intervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : undefined,
        signal: controller.signal,
      });
      return result.acquired ? EXIT.OK : EXIT.USAGE;
    }
    case "selftest": {
      const { cmdSelftest } = await import("./core/selftest.ts");
      return cmdSelftest();
    }
    case "hook-prebash":
    case "hook-postbash":
    case "hook-stop":
    case "brief": {
      const cli = await import("./cli.ts");
      const repo = (cli.parseFlags(rest)["repo"] as string | undefined) ?? ".";
      const hooks = await import("./hooks/hooks.ts");
      if (mode === "hook-prebash") return hooks.hookPreBash(repo);
      if (mode === "hook-postbash") return hooks.hookPostBash(repo);
      if (mode === "hook-stop") return hooks.hookStop(repo);
      return hooks.cmdBrief(repo);
    }
    default:
      break;
  }

  if (mode === "install") {
    const cli = await import("./cli.ts");
    const flags = cli.parseFlags(rest);

    // **부작용 명령은 의도하지 않은 실행이 기본값이면 안 된다.** 종전에는 인식하지 못한
    // 플래그가 전부 '기본 설치 실행' 으로 흘러, `install --help` 같은 조회 의도의 명령이
    // EXE 복사·스킬 복사·MCP 재등록을 수행했다(실측). 오타 플래그도 같은 경로를 탔다.
    const INSTALL_FLAGS = new Set([
      "help", "h", "dry-run", "status", "uninstall", "autostart", "skill", "exe",
      "migrate", "rollback", "backup", "reset", "keep",
    ]);
    if (flags["help"] === true || flags["h"] === true) {
      console.log(installUsage());
      return EXIT.OK;
    }
    const unknown = Object.keys(flags).filter((k) => !INSTALL_FLAGS.has(k));
    if (unknown.length > 0) {
      console.error(`[autoharness] 알 수 없는 install 옵션입니다: ${unknown.join(", ")}`);
      console.error(installUsage());
      return EXIT.USAGE;
    }

    // 보존과 초기화를 **동시에** 시킬 수는 없다. 하나를 골라 실행하면 다른 하나는
    // 되돌릴 수 없으므로, 모순된 지시는 짐작하지 않고 거부한다.
    if (flags["reset"] === true && flags["keep"] === true) {
      console.error("[autoharness] --reset 과 --keep 을 함께 줄 수 없습니다 — 하나만 고르십시오.");
      return EXIT.USAGE;
    }

    const { install, installStatus, uninstall } = await import("./install/install.ts");
    const dryRun = flags["dry-run"] === true;
    if (flags["status"] === true) {
      console.log(JSON.stringify(await installStatus(), null, 2));
      return EXIT.OK;
    }
    if (typeof flags["migrate"] === "string") {
      const { migrateRepo, rollbackInstructions } = await import("./install/migrate.ts");
      const report = await migrateRepo(flags["migrate"], { dryRun });
      console.log(JSON.stringify({ ...report, rollback: rollbackInstructions(report) }, null, 2));
      return report.ok ? EXIT.OK : EXIT.USAGE;
    }
    if (typeof flags["rollback"] === "string" && typeof flags["backup"] === "string") {
      const { rollbackRepo } = await import("./install/migrate.ts");
      const r = await rollbackRepo(flags["rollback"], flags["backup"]);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? EXIT.OK : EXIT.USAGE;
    }
    const result =
      flags["uninstall"] === true
        ? await uninstall({ dryRun })
        : await install({
            dryRun,
            autostart: flags["autostart"] === true,
            // 기본은 보존이다 — `--reset` 을 명시했을 때만 지운다
            reset: flags["reset"] === true,
            skillSource: typeof flags["skill"] === "string" ? flags["skill"] : undefined,
            // `bun run` 으로 실행하면 process.execPath 가 bun.exe 다 — 개발 실행에서는
            // 빌드된 EXE 를 명시해야 런타임을 복사하는 사고가 나지 않는다
            sourceExe: typeof flags["exe"] === "string" ? flags["exe"] : undefined,
          });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? EXIT.OK : EXIT.USAGE;
  }

  // 아직 이식되지 않은 모드 — 후속 작업(daemon/DESIGN.md 3절 표)에서 채운다.
  // "미구현" 을 성공으로 보고하지 않는다: 설정 오류와 같은 등급인 2 로 끝낸다.
  console.error(`[autoharness] 아직 구현되지 않은 모드입니다: ${mode}`);
  return EXIT.USAGE;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
