/**
 * 대상 저장소 내 하네스 경로 일람 — daemon/DESIGN.md 4절 경로 계약.
 *
 * v1 의 `rp()` 와 같은 이름·같은 위치를 쓴다. 두 구현이 같은 파일을 오가야
 * 교차 검증(§7.3)과 무중단 마이그레이션이 성립한다.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface RepoPaths {
  repo: string;
  claudeDir: string;
  tracker: string;
  example: string;
  logs: string;
  state: string;
  heartbeat: string;
  hooksSeen: string;
  pausedFlag: string;
  progress: string;
}

export function repoPaths(repo: string): RepoPaths {
  const root = isAbsolute(repo) ? repo : resolve(repo);
  const claudeDir = join(root, ".claude");
  return {
    repo: root,
    claudeDir,
    tracker: join(claudeDir, "agent_tracker.json"),
    example: join(claudeDir, "agent_tracker.example.json"),
    logs: join(claudeDir, "harness-logs"),
    state: join(claudeDir, "harness-state.json"),
    heartbeat: join(claudeDir, "harness-heartbeat.json"),
    hooksSeen: join(claudeDir, "harness-hooks-seen.json"),
    pausedFlag: join(claudeDir, "HARNESS_PAUSED"),
    progress: join(root, "PROGRESS.md"),
  };
}

export interface UserPaths {
  home: string;
  claudeDir: string;
  runtimeDir: string;
  registry: string;
  logs: string;
  daemonLog: string;
  webToken: string;
  /** 떠 있는 데몬이 자기 접속 정보를 남기는 자리 — MCP 위임의 발견 수단이다. */
  daemonInfo: string;
  lock: string;
  skillDir: string;
}

/**
 * 계정 단위 런타임 경로 — v1 `~/.claude/autoharness/` 와 같은 자리를 쓴다.
 *
 * `AUTOHARNESS_HOME` 으로 갈아끼울 수 있게 한 것은 **테스트 격리를 위해서다**: 단위 테스트가
 * 실제 레지스트리·설치본을 오염시키면 안 된다(CLAUDE.md 6절).
 */
export function userPaths(env: NodeJS.ProcessEnv = process.env): UserPaths {
  const home = env["AUTOHARNESS_HOME"] || homedir();
  const claudeDir = join(home, ".claude");
  const runtimeDir = join(claudeDir, "autoharness");
  const logs = join(runtimeDir, "logs");
  return {
    home,
    claudeDir,
    runtimeDir,
    registry: join(runtimeDir, "registry.json"),
    logs,
    daemonLog: join(logs, "daemon.log"),
    webToken: join(runtimeDir, "web-token"),
    daemonInfo: join(runtimeDir, "daemon.json"),
    lock: join(runtimeDir, "daemon.lock"),
    skillDir: join(claudeDir, "skills", "autoharness"),
  };
}
