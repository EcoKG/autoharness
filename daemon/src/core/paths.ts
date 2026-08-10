/**
 * 대상 저장소 내 하네스 경로 일람 — daemon/DESIGN.md 4절 경로 계약.
 *
 * v1 의 `rp()` 와 같은 이름·같은 위치를 쓴다. 두 구현이 같은 파일을 오가야
 * 교차 검증(§7.3)과 무중단 마이그레이션이 성립한다.
 */
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
