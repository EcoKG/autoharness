/**
 * 잔재 정리 — **v1 제거는 묻지 않고, v2 상태는 고른다.**
 *
 * 두 가지는 성격이 완전히 다르다. 파이썬 구현(v1)이 남긴 것은 부를 코드가 사라진
 * 죽은 파일이다 — 물어볼 여지가 없으므로 설치할 때마다 조용히 걷어낸다. 반면 v2 의
 * 런타임 상태(레지스트리·로그·토큰)는 **사용자의 진행 이력**이라, 지울지 남길지는
 * 사람이 정한다. 기본은 보존이다: 물어보지 않은 파괴는 하지 않는다.
 *
 * 종전에는 이 정리가 install.sh 와 install.ps1 **양쪽에** 손으로 쓰여 있었다. 같은
 * 규칙을 두 언어로 두 번 쓰면 갈라진다는 것을 이 저장소는 이미 세 번 확인했다
 * (배포 목록·설치 자산·문서 명령). 그래서 규칙은 여기 하나뿐이고 설치 스크립트는
 * EXE 를 부르기만 한다.
 *
 * **되는 척하지 않는다.** 항목마다 지웠는지·없었는지·못 지웠는지를 구분해 남기고,
 * 못 지운 것이 있어도 설치를 중단시키지 않는다 — 정리는 설치의 전제가 아니다.
 */
import { copyFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteJson } from "../core/atomic.ts";
import { isRecord, loadJson } from "../core/load.ts";
import { repoPaths, userPaths } from "../core/paths.ts";
import { loadRegistryChecked } from "../core/registry.ts";
import { nowIso } from "../core/schema.ts";
import { mergeSettings } from "./settings.ts";
import { realRunner, type CommandRunner } from "./autostart.ts";

/** 무엇을 했는가 — "지웠다" 와 "없었다" 와 "못 지웠다" 는 각각 다른 사실이다. */
export type CleanupAction = "removed" | "absent" | "failed" | "planned";

export interface CleanupEntry {
  target: string;
  action: CleanupAction;
  detail: string;
}

export interface CleanupReport {
  dryRun: boolean;
  entries: CleanupEntry[];
  removed: number;
  failed: number;
}

function toReport(dryRun: boolean, entries: CleanupEntry[]): CleanupReport {
  return {
    dryRun,
    entries,
    removed: entries.filter((e) => e.action === "removed").length,
    failed: entries.filter((e) => e.action === "failed").length,
  };
}

/** 한 줄 요약 — 설치 결과의 step detail 로 그대로 나간다. */
export function summarize(report: CleanupReport, nothing: string): string {
  if (report.dryRun) {
    const planned = report.entries.filter((e) => e.action === "planned");
    return planned.length === 0
      ? `(dry-run) ${nothing}`
      : `(dry-run) ${planned.length}건을 지웁니다: ${planned.map((e) => e.target).join(", ")}`;
  }
  const parts: string[] = [];
  if (report.removed > 0) {
    parts.push(
      `${report.removed}건 정리: ` +
        report.entries.filter((e) => e.action === "removed").map((e) => e.target).join(", "),
    );
  }
  if (report.failed > 0) {
    parts.push(
      `${report.failed}건 실패 — ` +
        report.entries.filter((e) => e.action === "failed").map((e) => `${e.target}(${e.detail})`).join("; "),
    );
  }
  return parts.length > 0 ? parts.join(" / ") : nothing;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 지운다 — **없는 것을 지웠다고 하지 않는다.**
 *
 * `rm({force:true})` 는 부재도 성공으로 치므로, 존재를 먼저 확인해야 "정리했다" 는 보고가
 * 실제 삭제를 뜻하게 된다. 이 구분이 없으면 매 설치가 "5건 정리" 를 보고하면서 실은
 * 아무것도 지우지 않는다.
 */
async function removePath(path: string, dryRun: boolean, label = path): Promise<CleanupEntry> {
  if (!(await exists(path))) return { target: label, action: "absent", detail: "없음" };
  if (dryRun) return { target: label, action: "planned", detail: `(dry-run) 지웁니다: ${path}` };
  try {
    await rm(path, { recursive: true, force: true });
    return { target: label, action: "removed", detail: path };
  } catch (err) {
    return {
      target: label,
      action: "failed",
      detail: `지우지 못했습니다(${String(err)}) — 직접 지우십시오: ${path}`,
    };
  }
}

// ---------------------------------------------------------------- v1 잔재

/** v1 워치독의 cron 항목을 알아보는 표식 — v1 설치기가 심던 명령줄 그대로다. */
export const V1_CRON_MARK = "harness_watchdog.py";

/**
 * v1 워치독의 스케줄러 작업 이름.
 *
 * **v2 의 `AutoHarnessDaemon` 과 다른 이름이어야 한다.** 같은 이름을 지웠다가는 정리가
 * 사용자의 자동 시작을 꺼 버린다 — 설치할 때마다 자동 시작이 사라지는데 아무도 그것을
 * 정리 탓이라고 생각하지 못한다. autostart.ts 의 TASK_NAME 과 대조하는 회귀가 있다.
 */
export const V1_TASK_NAME = "AutoHarnessWatchdog";

/**
 * v1 이 계정에 남긴 파일들.
 *
 * `templates/agent_harness.sh` 가 목록에 있는 이유: 설치는 파일을 **덮어쓸 뿐 지우지
 * 않는다.** v3 가 더 이상 배포하지 않는 파일은 옛 설치본에 그대로 남아, 부트스트랩
 * 프롬프트가 사라진 절차를 가리키던 실측 사고와 같은 부류의 함정이 된다.
 */
export function v1Leftovers(env: NodeJS.ProcessEnv = process.env): string[] {
  const p = userPaths(env);
  return [
    join(p.skillDir, "bin"), // 파이썬 엔진·MCP·워치독과 __pycache__
    join(p.skillDir, "templates", "agent_harness.sh"),
    join(p.runtimeDir, "watchdog.lock"),
    join(p.logs, "watchdog.log"),
    join(p.logs, "cron.log"),
  ];
}

/** v1 훅 명령을 알아보는 표식 — 이 이름들을 부르는 훅은 이제 실행될 코드가 없다. */
export const V1_HOOK_MARKERS: readonly string[] = [
  "harness_engine.py",
  "harness_mcp.py",
  "harness_watchdog.py",
  "agent_harness.sh",
];

export function isV1HookCommand(command: string): boolean {
  return V1_HOOK_MARKERS.some((marker) => command.includes(marker));
}

/**
 * 설정 트리에서 v1 훅 **항목만** 걷어낸다(파일은 만지지 않는 순수 변환).
 *
 * 사용자가 직접 넣은 훅은 그대로 둔다 — 정리 대상은 v1 이 심은 것뿐이다. 훅이 하나도
 * 남지 않은 항목은 통째로 버린다: matcher 만 남은 빈 껍데기는 배선이 아니라 쓰레기다.
 *
 * 입력 객체를 그 자리에서 고친다(호출자가 곧바로 저장하므로 사본을 만들 이유가 없다).
 */
export function stripV1Hooks(settings: unknown): { settings: unknown; removed: string[] } {
  const removed: string[] = [];
  if (!isRecord(settings)) return { settings, removed };
  const hooks = settings["hooks"];
  if (!isRecord(hooks)) return { settings, removed };

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry["hooks"])) {
        kept.push(entry);
        continue;
      }
      const keptHooks = (entry["hooks"] as unknown[]).filter((h) => {
        const command = isRecord(h) && typeof h["command"] === "string" ? h["command"] : "";
        if (command !== "" && isV1HookCommand(command)) {
          removed.push(`${event}: ${command}`);
          return false;
        }
        return true;
      });
      if (keptHooks.length === 0) continue;
      entry["hooks"] = keptHooks;
      kept.push(entry);
    }
    (hooks as Record<string, unknown>)[event] = kept;
  }
  return { settings, removed };
}

export interface WiringPurgeOptions {
  exePath: string;
  dryRun?: boolean;
}

/**
 * 저장소 하나의 v1 배선을 v2 로 갈아끼운다.
 *
 * v3.0.0 이 "사람 손이 필요한 유일한 지점" 으로 남겨 둔 자리다. 남겨 두면 게이트 4종이
 * 조용히 무효인 채로 계속 주행한다 — 훅이 없는 것이 아니라 **있는데 죽어 있는** 상태라
 * 진단조차 `not_registered` 로 나온다. 설치는 EXE 위치를 아는 유일한 순간이므로 여기서
 * 고친다.
 *
 * 되돌릴 수 있게 원본을 먼저 백업한다. 장부는 읽지도 쓰지도 않는다.
 */
export async function purgeV1Wiring(repo: string, options: WiringPurgeOptions): Promise<CleanupEntry> {
  const dryRun = options.dryRun === true;
  const path = join(repoPaths(repo).claudeDir, "settings.json");
  const label = `${repo} 훅 배선`;

  const loaded = await loadJson<Record<string, unknown>>(path);
  if (loaded.state === "missing") return { target: label, action: "absent", detail: "설정 없음" };
  if (loaded.state !== "ok" || !isRecord(loaded.value)) {
    return {
      target: label,
      action: "failed",
      detail: `설정이 파손돼 손대지 않았습니다: ${path} (${loaded.error ?? "형식 오류"})`,
    };
  }

  const { settings, removed } = stripV1Hooks(loaded.value);
  if (removed.length === 0) return { target: label, action: "absent", detail: "v1 배선 없음" };
  if (dryRun) {
    return {
      target: label,
      action: "planned",
      detail: `(dry-run) v1 훅 ${removed.length}건을 지우고 v2 배선을 심습니다: ${path}`,
    };
  }

  try {
    const backup = `${path}.bak-v1-${nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
    await copyFile(path, backup);
    await atomicWriteJson(path, settings);
    const merge = await mergeSettings(repo, { exePath: options.exePath });
    return {
      target: label,
      action: "removed",
      detail:
        `v1 훅 ${removed.length}건 제거 → v2 배선 ${merge.merged_hooks.length}건 설치 ` +
        `(원본 백업: ${backup})`,
    };
  } catch (err) {
    return { target: label, action: "failed", detail: `배선 교체 실패: ${String(err)}` };
  }
}

/** 레지스트리에 등록된 저장소 경로 — 정리 대상은 사용자가 등록한 것뿐이다. */
export async function registeredRepos(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const r = await loadRegistryChecked(env);
  return r.registry.projects.map((p) => p.repo).filter((repo) => typeof repo === "string" && repo !== "");
}

async function purgeCron(runner: CommandRunner, dryRun: boolean): Promise<CleanupEntry> {
  const label = `cron(${V1_CRON_MARK})`;
  let listing: string;
  try {
    const r = await runner(["crontab", "-l"]);
    // crontab 이 없거나(명령 부재) 항목이 없으면 exit != 0 이다 — 둘 다 지울 것이 없다
    if (r.code !== 0) return { target: label, action: "absent", detail: "cron 항목 없음" };
    listing = r.stdout;
  } catch {
    return { target: label, action: "absent", detail: "crontab 명령 없음" };
  }

  const lines = listing.split("\n");
  if (!lines.some((line) => line.includes(V1_CRON_MARK))) {
    return { target: label, action: "absent", detail: "cron 항목 없음" };
  }
  if (dryRun) return { target: label, action: "planned", detail: "(dry-run) 워치독 cron 항목을 지웁니다" };

  const kept = lines.filter((line) => !line.includes(V1_CRON_MARK));
  const tmp = join(tmpdir(), `autoharness-cron-${process.pid}-${kept.length}.txt`);
  try {
    await writeFile(tmp, `${kept.join("\n").replace(/\n+$/, "")}\n`, "utf8");
    const r = await runner(["crontab", tmp]);
    if (r.code !== 0) {
      return {
        target: label,
        action: "failed",
        detail: `crontab 갱신 실패(exit ${r.code}) — 'crontab -e' 로 ${V1_CRON_MARK} 줄을 직접 지우십시오`,
      };
    }
    return { target: label, action: "removed", detail: "워치독 cron 항목을 지웠습니다" };
  } catch (err) {
    return { target: label, action: "failed", detail: `cron 정리 실패: ${String(err)}` };
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function purgeScheduledTask(runner: CommandRunner, dryRun: boolean): Promise<CleanupEntry> {
  const label = `스케줄러 작업(${V1_TASK_NAME})`;
  try {
    const q = await runner(["schtasks", "/Query", "/TN", V1_TASK_NAME]);
    if (q.code !== 0) return { target: label, action: "absent", detail: "작업 없음" };
  } catch {
    return { target: label, action: "absent", detail: "schtasks 조회 불가" };
  }
  if (dryRun) return { target: label, action: "planned", detail: "(dry-run) 워치독 작업을 지웁니다" };
  try {
    const r = await runner(["schtasks", "/Delete", "/TN", V1_TASK_NAME, "/F"]);
    if (r.code !== 0) {
      return {
        target: label,
        action: "failed",
        detail: `삭제 실패(exit ${r.code}) — 직접 지우십시오: schtasks /Delete /TN ${V1_TASK_NAME} /F`,
      };
    }
    return { target: label, action: "removed", detail: "워치독 스케줄러 작업을 지웠습니다" };
  } catch (err) {
    return { target: label, action: "failed", detail: `삭제 실패: ${String(err)}` };
  }
}

export interface PurgeOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
  /** 저장소 배선을 다시 쓸 때 박아 넣을 실행 파일. 없으면 배선은 손대지 않는다. */
  exePath?: string;
  /** 정리할 저장소 목록. 없으면 레지스트리에 등록된 것을 쓴다. */
  repos?: readonly string[];
}

/**
 * v1 잔재를 걷어낸다 — **묻지 않는다**(사용자 요구).
 *
 * 지우는 것은 v1 이 만든 것뿐이다: 파이썬 자산, 워치독 등록(cron/스케줄러), 워치독이
 * 남긴 잠금·로그, 그리고 저장소의 죽은 v1 훅 배선. v2 의 런타임 상태는 여기서 절대
 * 건드리지 않는다 — 그쪽은 사람이 고른다(resetV2).
 */
export async function purgeV1(options: PurgeOptions = {}): Promise<CleanupReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? realRunner;
  const dryRun = options.dryRun === true;
  const entries: CleanupEntry[] = [];

  for (const path of v1Leftovers(env)) entries.push(await removePath(path, dryRun));

  entries.push(
    platform === "win32" ? await purgeScheduledTask(runner, dryRun) : await purgeCron(runner, dryRun),
  );

  if (options.exePath) {
    const repos = options.repos ?? (await registeredRepos(env));
    for (const repo of repos) {
      entries.push(await purgeV1Wiring(repo, { exePath: options.exePath, dryRun }));
    }
  }

  return toReport(dryRun, entries);
}

// ---------------------------------------------------------------- v2 상태 초기화

/**
 * 초기화가 지우는 것 — **열거된 것만 지운다.**
 *
 * 런타임 디렉토리를 통째로 지우지 않는 이유가 둘 있다. 첫째, 그 안에 지금 실행 중인
 * `bin/autoharness` 가 산다 — 설치 도중 자기 자신을 지우게 된다. 둘째, 목록이 코드에
 * 적혀 있어야 무엇이 사라지는지 사람이 읽고 확인할 수 있다(테스트도 이 목록을 본다).
 *
 * 저장소 안의 장부(.claude/agent_tracker.json)는 여기 없다. 그것은 계정 상태가 아니라
 * 사용자의 저장소 안에 있는 작업 이력이고, 설치기가 지울 물건이 아니다.
 */
export function v2StateTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const p = userPaths(env);
  return [p.registry, p.registryLock, p.lock, p.daemonInfo, p.webToken, p.logs];
}

/** 지울 상태가 있는가 — 설치기가 "고르시겠습니까" 를 띄울지 판단하는 근거. */
export async function hasV2State(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const path of v2StateTargets(env)) if (await exists(path)) return true;
  return false;
}

/** 파손 대피본(registry.json.corrupt-…) 도 초기화 대상이다 — 남겨 두면 영영 쌓인다. */
async function corruptBackups(env: NodeJS.ProcessEnv): Promise<string[]> {
  const p = userPaths(env);
  try {
    const names = await readdir(p.runtimeDir);
    return names.filter((n) => n.startsWith("registry.json.corrupt-")).map((n) => join(p.runtimeDir, n));
  } catch {
    return [];
  }
}

export interface ResetOptions {
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}

/**
 * v2 런타임 상태를 지운다 — **사람이 고른 경우에만 불린다.**
 *
 * 실행 파일은 건드리지 않는다. 초기화 후 설치가 이어지므로 EXE 는 제자리에 있어야 하고,
 * 애초에 지금 이 코드가 그 파일에서 돌고 있다.
 */
export async function resetV2(options: ResetOptions = {}): Promise<CleanupReport> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const binDir = join(userPaths(env).runtimeDir, "bin");
  const entries: CleanupEntry[] = [];

  const targets = [...v2StateTargets(env), ...(await corruptBackups(env))];
  for (const path of targets) {
    // 방어선 — 목록이 잘못 늘어나도 실행 파일은 지우지 않는다
    if (path === binDir || path.startsWith(`${binDir}/`) || path.startsWith(`${binDir}\\`)) {
      entries.push({ target: path, action: "absent", detail: "실행 파일 자리는 초기화 대상이 아닙니다" });
      continue;
    }
    entries.push(await removePath(path, dryRun));
  }
  return toReport(dryRun, entries);
}
