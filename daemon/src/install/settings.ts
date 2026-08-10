/**
 * 대상 저장소 `.claude/settings.json` 병합 — 훅 4종과 권한을 심는다.
 *
 * 두 가지를 동시에 못 박는다(v1 이 각각 따로 데인 자리다):
 *   ① **엔진 위치** — 훅 핸들러는 프로젝트 루트가 아니라 현재 작업 디렉토리에서 실행된다.
 *      상대 경로면 하위 디렉토리로 들어가는 순간 게이트가 전부 죽는다.
 *   ② **대상 저장소** — `--repo` 를 생략하면 엔진이 cwd 를 저장소로 삼아, 하위 디렉토리에서
 *      커밋 게이트·Stop 게이트가 조용히 통과한다(실측: 루트 exit 2 대 하위 exit 0).
 *
 * 기존 저장소는 **마이그레이션한다**: v1 훅(python + harness_engine.py)을 v2 훅으로 바꾸고,
 * 낡은 matcher 를 넓히고, 빠진 `--repo` 를 채운다. 항목 단위로 판정하므로 matcher 만 낡은
 * 설치가 '이미 있음'으로 영영 건너뛰어지지 않는다.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "../core/atomic.ts";
import { isRecord, loadJson } from "../core/load.ts";
import { repoPaths } from "../core/paths.ts";
import { nowIso } from "../core/schema.ts";
import {
  COMMAND_TOOLS,
  REPO_PIN_FLAG,
  engineTokenIn,
  hookCommandIsRepoUnpinned,
  matcherCovers,
  pathIsRooted,
} from "../hooks/wiring.ts";

/** 명령을 실행하는 도구 전부를 덮는 matcher. 하나라도 빠지면 그 경로로 게이트가 우회된다. */
export const COMMAND_TOOL_MATCHER = COMMAND_TOOLS.join("|");

export const HOOK_EVENTS = [
  { event: "SessionStart", matcher: null, op: "brief" },
  { event: "PreToolUse", matcher: COMMAND_TOOL_MATCHER, op: "hook-prebash" },
  { event: "PostToolUse", matcher: COMMAND_TOOL_MATCHER, op: "hook-postbash" },
  { event: "Stop", matcher: null, op: "hook-stop" },
] as const;

const HOOK_OPS = HOOK_EVENTS.map((h) => h.op) as readonly string[];

/**
 * 훅이 부를 실행 파일 경로.
 *
 * 단일 EXE 로 컴파일되면 `process.execPath` 가 곧 그 EXE 다. 개발 중(bun run)에는
 * 인터프리터를 가리키므로 호출자가 명시적으로 넘길 수 있게 열어 둔다.
 */
export function hookCommandFor(op: string, exePath: string = process.execPath): string {
  return `"${exePath}" ${op} ${REPO_PIN_FLAG}`;
}

export function hookOpInCommand(command: string): string | null {
  for (const token of (command ?? "").split(/\s+/)) if (HOOK_OPS.includes(token)) return token;
  return null;
}

/** 이 항목이 하네스의 <op> 훅인가 — 이벤트 통째가 아니라 **항목 단위**로 본다. */
export function isHarnessHookItem(item: unknown, op: string): boolean {
  if (!isRecord(item)) return false;
  const hooks = item["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => isRecord(h) && typeof h["command"] === "string" &&
      engineTokenIn(h["command"]) !== null && hookOpInCommand(h["command"]) === op,
  );
}

/** v1(파이썬 스크립트) 훅인가 — v2 EXE 훅으로 갈아끼워야 할 대상. */
export function isLegacyEngineCommand(command: string): boolean {
  const token = engineTokenIn(command);
  return token !== null && token.toLowerCase().endsWith(".py");
}

export interface MergeResult {
  path: string;
  backup: string | null;
  merged_hooks: string[];
  migrated_hooks: string[];
  skipped_hooks: string[];
  added_permissions: string[];
  matcher: string;
}

export interface MergeOptions {
  exePath?: string;
  /** v1 훅을 v2 EXE 훅으로 바꿀 것인가. 기존 저장소 마이그레이션에서 켠다. */
  replaceLegacy?: boolean;
}

function permissionAllowRules(exePath: string): string[] {
  return [`Bash("${exePath}" run:*)`, `Bash("${exePath}" next:*)`];
}

export async function mergeSettings(repo: string, opts: MergeOptions = {}): Promise<MergeResult> {
  const exePath = opts.exePath ?? process.execPath;
  const claudeDir = repoPaths(repo).claudeDir;
  await mkdir(claudeDir, { recursive: true });
  const path = join(claudeDir, "settings.json");

  let backup: string | null = null;
  let settings: Record<string, unknown> = {};
  const loaded = await loadJson<Record<string, unknown>>(path);
  if (loaded.state !== "missing") {
    backup = `${path}.bak-${nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
    await copyFile(path, backup);
    if (loaded.state === "ok" && isRecord(loaded.value)) settings = loaded.value;
    // 파손이면 백업만 남기고 새로 구성한다 — 읽지 못하는 파일을 근거로 병합할 수는 없다
  }

  let hooks = settings["hooks"];
  if (!isRecord(hooks)) {
    hooks = {};
    settings["hooks"] = hooks;
  }
  const hookTree = hooks as Record<string, unknown>;

  const merged: string[] = [];
  const migrated: string[] = [];
  const skipped: string[] = [];

  for (const { event, matcher, op } of HOOK_EVENTS) {
    let entries = hookTree[event];
    if (!Array.isArray(entries)) {
      entries = [];
      hookTree[event] = entries;
    }
    const list = entries as unknown[];
    const existing = list.filter((e) => isHarnessHookItem(e, op));

    if (existing.length > 0) {
      let changed = false;
      for (const raw of existing) {
        const item = raw as Record<string, unknown>;
        if (matcher && item["matcher"] !== matcher) {
          item["matcher"] = matcher; // 커버리지 확대 마이그레이션
          changed = true;
        }
        for (const h of (item["hooks"] as unknown[]) ?? []) {
          if (!isRecord(h) || typeof h["command"] !== "string") continue;
          let command = h["command"];
          if (opts.replaceLegacy && isLegacyEngineCommand(command)) {
            command = hookCommandFor(op, exePath);
          } else {
            const token = engineTokenIn(command);
            if (token && !pathIsRooted(token)) command = hookCommandFor(op, exePath);
            if (hookCommandIsRepoUnpinned(command)) command = `${command.trimEnd()} ${REPO_PIN_FLAG}`;
          }
          if (command !== h["command"]) {
            h["command"] = command;
            changed = true;
          }
        }
      }
      (changed ? migrated : skipped).push(event);
      continue;
    }

    const item: Record<string, unknown> = {
      hooks: [{ type: "command", command: hookCommandFor(op, exePath) }],
    };
    if (matcher) item["matcher"] = matcher;
    list.push(item);
    merged.push(event);
  }

  let permissions = settings["permissions"];
  if (!isRecord(permissions)) {
    permissions = {};
    settings["permissions"] = permissions;
  }
  const perms = permissions as Record<string, unknown>;
  let allow = perms["allow"];
  if (!Array.isArray(allow)) {
    allow = [];
    perms["allow"] = allow;
  }
  const allowList = allow as string[];
  const addedPermissions: string[] = [];
  for (const rule of permissionAllowRules(exePath)) {
    if (!allowList.includes(rule)) {
      allowList.push(rule);
      addedPermissions.push(rule);
    }
  }

  await atomicWriteJson(path, settings);
  return {
    path,
    backup,
    merged_hooks: merged,
    migrated_hooks: migrated,
    skipped_hooks: skipped,
    added_permissions: addedPermissions,
    matcher: COMMAND_TOOL_MATCHER,
  };
}

/** matcher 가 실행 도구를 다 덮는지 — 정의 자체를 회귀로 고정하기 위해 노출한다. */
export function matcherCoversAllCommandTools(matcher: string): boolean {
  return COMMAND_TOOLS.every((tool) => matcherCovers(matcher, tool));
}
