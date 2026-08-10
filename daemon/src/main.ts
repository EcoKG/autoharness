/**
 * AutoHarness v2 진입점 — 하나의 EXE 를 argv 로 모드 분기한다.
 *
 * 훅 모드는 매 Bash 호출마다 도는 단발 실행이라 **시작 시간이 계약**이다
 * (daemon/DESIGN.md 3절: p95 150ms). 그래서 이 파일 최상단에서는 무거운 모듈을
 * import 하지 않는다 — 각 모드가 필요한 것만 동적으로 불러온다. 정적 import 를
 * 추가하면 훅을 포함한 **모든** 모드의 시작 비용이 된다.
 */

import { EXIT } from "./exit.ts";

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

export const VERSION = "2.0.0-dev";

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
    case "next":
    case "status":
    case "render":
    case "heartbeat":
    case "run": {
      const cli = await import("./cli.ts");
      const flags = cli.parseFlags(rest);
      const handlers = {
        init: cli.cmdInit,
        "add-task": cli.cmdAddTask,
        "set-task": cli.cmdSetTask,
        next: cli.cmdNext,
        status: cli.cmdStatus,
        render: cli.cmdRender,
        heartbeat: cli.cmdHeartbeat,
        run: cli.cmdRun,
      } as const;
      return handlers[mode](flags);
    }
    case "selftest": {
      const { cmdSelftest } = await import("./core/selftest.ts");
      return cmdSelftest();
    }
    default:
      break;
  }

  // 아직 이식되지 않은 모드 — 후속 작업(daemon/DESIGN.md 3절 표)에서 채운다.
  // "미구현" 을 성공으로 보고하지 않는다: 설정 오류와 같은 등급인 2 로 끝낸다.
  console.error(`[autoharness] 아직 구현되지 않은 모드입니다: ${mode}`);
  return EXIT.USAGE;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
