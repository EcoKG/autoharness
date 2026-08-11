/**
 * 기존 저장소 마이그레이션 — **훅 배선만 바꾸고 진행 상태는 건드리지 않는다.**
 *
 * 이미 주행 중인 저장소가 대상이다. 장부에는 수십 건의 완료 이력과 커밋 SHA 가 들어 있고,
 * 그것을 잃으면 되돌릴 방법이 없다. 그래서 이 모듈의 제1 원칙은 **장부 불변**이다:
 * 마이그레이션 전후로 장부 바이트가 같아야 하고, 다르면 실패로 보고한다.
 *
 * v1 훅과 v2 훅이 잠시 공존해도 안전하다 — 둘은 같은 스키마를 읽고 같은 원자적 쓰기를 하며,
 * 레지스트리는 같은 잠금 규약을 공유한다. 그래서 이행을 한 번에 끝낼 필요가 없다.
 *
 * 되돌리기가 항상 가능해야 한다. 설정은 백업한 뒤에만 바꾸고, 백업 경로를 결과에 실어
 * 롤백 절차가 문서가 아니라 값으로 전달되게 한다.
 */
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadTracker } from "../core/ledger.ts";
import { isRecord, loadJson } from "../core/load.ts";
import { repoPaths } from "../core/paths.ts";
import { engineTokenIn, hookCommandIsRepoUnpinned, hookWiringStatus, pathIsRooted } from "../hooks/wiring.ts";
import {
  COMMAND_TOOL_MATCHER,
  hookCommandPathIsDead,
  isLegacyEngineCommand,
  mergeSettings,
} from "./settings.ts";
import { installedExePath } from "./install.ts";

export interface HookSnapshot {
  event: string;
  command: string;
  matcher: string;
  legacy: boolean;
  repoUnpinned: boolean;
  cwdDependent: boolean;
  /**
   * 가리키는 실행 파일이 실존하지 않는다 — **경로가 고정돼 있는 것과는 다른 조건이다.**
   * `cwdDependent` 는 "어디서 실행하느냐에 따라 달라지는가" 를 보고, 이쪽은 "그 파일이
   * 실제로 있는가" 를 본다. 이것을 교체 사유에서 빠뜨려 진단(broken_path)만 있고 복구는
   * 동작하지 않는 상태였다(실측 2026-08-11).
   */
  deadPath: boolean;
}

export interface MigrateReport {
  repo: string;
  ok: boolean;
  dryRun: boolean;
  /** 장부가 그대로인가 — 이 값이 false 면 무엇을 했든 실패다. */
  ledgerIntact: boolean;
  ledgerTasks: number;
  backup: string | null;
  before: HookSnapshot[];
  after: HookSnapshot[];
  migrated: string[];
  notes: string[];
}

async function snapshotOf(settings: unknown, repo: string): Promise<HookSnapshot[]> {
  const out: HookSnapshot[] = [];
  if (!isRecord(settings)) return out;
  const hooks = settings["hooks"];
  if (!isRecord(hooks)) return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const matcher = typeof entry["matcher"] === "string" ? entry["matcher"] : "";
      for (const h of (entry["hooks"] as unknown[]) ?? []) {
        if (!isRecord(h) || typeof h["command"] !== "string") continue;
        const command = h["command"];
        const token = engineTokenIn(command);
        out.push({
          event,
          command,
          matcher,
          legacy: isLegacyEngineCommand(command),
          repoUnpinned: hookCommandIsRepoUnpinned(command),
          cwdDependent: token !== null && !pathIsRooted(token),
          deadPath: await hookCommandPathIsDead(command, repo),
        });
      }
    }
  }
  return out;
}

async function readSettingsRaw(repo: string): Promise<unknown> {
  const r = await loadJson<unknown>(join(repoPaths(repo).claudeDir, "settings.json"));
  return r.state === "ok" ? r.value : null;
}

/** 장부 원본 바이트 — 마이그레이션이 건드리지 않았음을 바이트 단위로 확인한다. */
async function ledgerBytes(repo: string): Promise<string | null> {
  try {
    return await readFile(repoPaths(repo).tracker, "utf8");
  } catch {
    return null;
  }
}

export interface MigrateOptions {
  exePath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function migrateRepo(repo: string, options: MigrateOptions = {}): Promise<MigrateReport> {
  const env = options.env ?? process.env;
  const exePath = options.exePath ?? installedExePath(env);
  const dryRun = options.dryRun === true;
  const notes: string[] = [];

  const before = await snapshotOf(await readSettingsRaw(repo), repo);
  const ledgerBefore = await ledgerBytes(repo);
  const { tracker } = await loadTracker(repo);
  const taskCount = tracker?.tasks.length ?? 0;

  if (before.length === 0) {
    notes.push("훅이 등록돼 있지 않습니다 — 마이그레이션할 배선이 없습니다.");
  }
  // 죽은 경로도 교체 사유다 — 이것을 빠뜨려 "이미 v2 배선입니다" 라고 답하면서 게이트
  // 4종이 무효인 상태를 그대로 두었다(실측 2026-08-11).
  const needsWork = before.filter(
    (h) => h.legacy || h.repoUnpinned || h.cwdDependent || h.deadPath,
  );
  if (before.length > 0 && needsWork.length === 0) {
    notes.push("이미 v2 배선입니다 — 바꿀 것이 없습니다.");
  }

  if (dryRun) {
    return {
      repo, ok: true, dryRun: true,
      ledgerIntact: true, ledgerTasks: taskCount, backup: null,
      before, after: before,
      migrated: needsWork.map((h) => h.event),
      notes: [
        ...notes,
        `(dry-run) v1 훅 ${before.filter((h) => h.legacy).length}건과 ` +
          `실행 파일이 없는 훅 ${before.filter((h) => h.deadPath).length}건을 ${exePath} 로 교체하고, ` +
          `matcher 를 ${COMMAND_TOOL_MATCHER} 로 넓히고, --repo 를 못 박습니다.`,
      ],
    };
  }

  const merge = await mergeSettings(repo, { exePath, replaceLegacy: true });
  const after = await snapshotOf(await readSettingsRaw(repo), repo);
  const ledgerAfter = await ledgerBytes(repo);

  // 제1 원칙 — 장부는 한 바이트도 달라지면 안 된다
  const ledgerIntact = ledgerBefore === ledgerAfter;
  if (!ledgerIntact) {
    notes.push(
      "장부가 변했습니다 — 마이그레이션은 진행 상태를 건드리면 안 됩니다. " +
        `설정 백업(${merge.backup ?? "없음"})으로 되돌리고 원인을 확인하십시오.`,
    );
  }

  const stillLegacy = after.filter((h) => h.legacy);
  if (stillLegacy.length > 0) {
    notes.push(`v1 훅이 ${stillLegacy.length}건 남았습니다: ${stillLegacy.map((h) => h.event).join(", ")}`);
  }
  const stillUnpinned = after.filter((h) => h.repoUnpinned);
  if (stillUnpinned.length > 0) {
    notes.push(`--repo 가 없는 훅이 ${stillUnpinned.length}건 남았습니다.`);
  }
  const stillDead = after.filter((h) => h.deadPath);
  if (stillDead.length > 0) {
    notes.push(
      `실행 파일이 없는 훅이 ${stillDead.length}건 남았습니다: ${stillDead.map((h) => h.event).join(", ")}`,
    );
  }

  const wiring = await hookWiringStatus(repo, tracker);
  if (wiring.uncovered_tools.length > 0) {
    notes.push(`matcher 가 덮지 못하는 도구: ${wiring.uncovered_tools.join(", ")}`);
  }

  return {
    repo,
    ok: ledgerIntact && stillLegacy.length === 0 && stillUnpinned.length === 0 &&
      stillDead.length === 0,
    dryRun: false,
    ledgerIntact,
    ledgerTasks: taskCount,
    backup: merge.backup,
    before,
    after,
    migrated: [...merge.migrated_hooks, ...merge.merged_hooks],
    notes,
  };
}

/**
 * 롤백 — 백업 설정을 제자리로 되돌린다.
 *
 * 장부는 애초에 건드리지 않으므로 되돌릴 것이 없다. 그래서 롤백은 설정 파일 하나를
 * 복원하는 것으로 끝난다 — 이것이 "훅 배선만 바꾼다" 원칙의 실질적 이득이다.
 */
export async function rollbackRepo(repo: string, backup: string): Promise<{ ok: boolean; detail: string }> {
  const target = join(repoPaths(repo).claudeDir, "settings.json");
  try {
    await copyFile(backup, target);
    return { ok: true, detail: `${backup} → ${target} 로 복원했습니다.` };
  } catch (err) {
    return { ok: false, detail: `복원 실패: ${String(err)}` };
  }
}

/** 사람이 읽는 롤백 절차 — 보고서에 그대로 실어 준다. */
export function rollbackInstructions(report: MigrateReport): string[] {
  if (!report.backup) {
    return ["백업이 없습니다(변경 사항 없음) — 되돌릴 것이 없습니다."];
  }
  return [
    `1. 설정 복원: ${report.backup} 를 ${join(repoPaths(report.repo).claudeDir, "settings.json")} 로 덮어씁니다.`,
    "2. 장부는 건드리지 않았으므로 복원할 것이 없습니다(진행 상태 그대로).",
    "3. 복원 후 하네스 상태 확인: v1 은 `python scripts/harness_engine.py status --repo .`,",
    "   v2 는 `autoharness status --repo .` — hooks.state 가 active 인지 봅니다.",
  ];
}
