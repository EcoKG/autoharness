/**
 * 훅 배선 진단 — **등록돼 있다는 사실만으로 "정상"이라고 말하지 않는다.**
 *
 * 세션 프로젝트 루트가 저장소 밖(상위 폴더)이면 저장소의 `.claude/settings.json` 이
 * 로드되지 않아 훅이 전부 조용히 죽는다. 커밋 게이트·금지 명령 차단·Stop 게이트가
 * 모두 무력인데 주행은 정상처럼 보인다 — v1 이 실측으로 확인한 상태다.
 *
 * 판정 근거는 **발화 마커**다. 하트비트의 `source=hook` 은 근거가 못 된다 — 사람이 손으로
 * stdin 을 먹여도 같은 기록이 남아 끊긴 저장소를 정상으로 오판한다. 실제 훅 호출에만 있는
 * Claude Code 런타임 필드를 본 뒤에 마커를 남긴다(hooks.ts `recordHookFire`).
 *
 * 이 모듈이 드러내는 것은 다섯 가지이며, v1 이 각각을 놓쳐 본 적이 있다:
 *   1. 등록됐는데 한 번도 발화하지 않음(inactive)
 *   2. matcher 가 일부 실행 도구만 덮어 나머지 경로로 게이트가 통째로 우회됨
 *   3. 훅 4종 중 일부만 등록됨(부분 등록) — 나머지 규칙은 존재하지 않는 상태
 *   4. settings.json 파손 — 이것을 '미등록(수동 운용)'으로 오판하면 오탐 금지 규칙에
 *      가려져 게이트가 전부 죽은 상태가 경고에서 빠진다
 *   5. 훅 명령이 **실존하지 않는 실행 파일**을 가리킴(broken_path) — 훅 명령에는 설치
 *      시점의 절대 EXE 경로가 박히는데, 그 파일은 계정·기계가 바뀌면 사라진다. 그런데
 *      `.claude/settings.json` 은 저장소를 따라 다니므로 클론·계정 이전마다 재발한다.
 *      실측(2026-08-11, 이 저장소): 훅 4종이 `C:\Users\ruinp\...\autoharness.exe` 를
 *      부르는데 현재 계정에 그 경로가 없어 게이트가 전부 무효였다. 이때 `inactive` 로
 *      뭉개면 **처방이 틀린다** — 화면은 "저장소 루트에서 claude 를 실행하십시오"라고
 *      말하지만 루트에서 실행해도 없는 파일은 여전히 없다.
 *
 * **경고만 하고 주행은 막지 않는다**(fail-open). 훅을 쓰지 않는 저장소는 경고 대상이
 * 아니다 — 수동 운용은 결함이 아니다(오탐 금지).
 */
import { join } from "node:path";

import { loadTracker } from "../core/ledger.ts";
import { isRecord, loadJson, type LoadState } from "../core/load.ts";
import { repoPaths } from "../core/paths.ts";
import type { Tracker } from "../core/schema.ts";
import { exeName } from "./command.ts";
import { MARKER_HOOK_OPS } from "./hooks.ts";

export const WIRING_NOT_REGISTERED = "not_registered"; // 훅 미등록(수동 운용) — 경고 대상 아님
export const WIRING_ACTIVE = "active"; // 등록 + 실제 발화 기록 있음
export const WIRING_INACTIVE = "inactive"; // 등록됐으나 한 번도 발화한 적 없음 — 경고
export const WIRING_BROKEN_PATH = "broken_path"; // 등록됐으나 실행 파일이 실존하지 않음 — 경고
export type WiringState =
  | typeof WIRING_NOT_REGISTERED
  | typeof WIRING_ACTIVE
  | typeof WIRING_INACTIVE
  | typeof WIRING_BROKEN_PATH;

/** matcher 로 도구 범위가 정해지는 훅(hook-stop 은 Stop 이벤트라 도구 무관) */
export const MATCHER_SCOPED_OPS: readonly string[] = ["hook-prebash", "hook-postbash"];
/** 명령을 실행하는 도구 — 이 중 matcher 에서 빠진 것이 있으면 게이트가 우회된다 */
export const COMMAND_TOOLS: readonly string[] = ["Bash", "PowerShell"];
export const SETTINGS_FILES: readonly string[] = ["settings.json", "settings.local.json"];

/**
 * 훅 명령이 가리키는 하네스 엔진의 basename.
 *
 * v1(`harness_engine.py`)과 v2(EXE)는 마이그레이션 중 **공존한다**(daemon/DESIGN.md 5절).
 * 한쪽만 알아보면 이행 도중의 저장소를 '미등록'으로 오판해 경고가 사라진다.
 */
export const ENGINE_BASENAMES: readonly string[] = ["harness_engine.py", "autoharness"];

/**
 * 훅 명령이 대상 저장소를 못 박는 방법 — 설치 경로가 훅 명령 끝에 붙여야 하는 인자.
 *
 * 엔진 '경로'를 고정하는 것과는 다른 축이다. `--repo` 가 없으면 엔진의 기본값이 `.` 이라
 * **현재 작업 디렉토리**가 저장소가 된다. 실측: 같은 훅에 같은 페이로드를 먹였을 때 루트는
 * exit 2(차단), 하위 디렉토리는 exit 0(통과)였고 하위에 `.claude/` 가 새로 생겼다 —
 * 커밋 게이트와 Stop 게이트가 cwd 하나로 사라지고 발화 마커·하트비트도 그리로 흩어진다.
 */
export const REPO_PIN_FLAG = '--repo "${CLAUDE_PROJECT_DIR}"';

/** 인터프리터가 cwd 기준으로 여는 스크립트 — 이름만 써도 PATH 로 해석되지 않는다. */
const SCRIPT_EXT_RE = /\.(py|js|ts|mjs|cjs|sh)$/i;
const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;

export interface WiringInfo {
  readonly state: WiringState;
  /** 등록된 마커 훅 op(정렬) */
  readonly registered: string[];
  /** 실제로 발화한 적이 있는 op(정렬) */
  readonly fired: string[];
  readonly last_fire: string | null;
  readonly matchers: Record<string, string>;
  readonly uncovered_tools: string[];
  readonly settings_states: Record<string, LoadState>;
  readonly missing_hooks: string[];
  readonly cwd_dependent_hooks: string[];
  readonly repo_unpinned_hooks: string[];
  /** 실존하지 않는 실행 파일을 가리키는 훅 명령(정렬) — 확인 가능한 경로만 센다. */
  readonly dead_engine_hooks: string[];
  readonly done_total: number;
  readonly done_without_commit: number;
  readonly warning: string | null;
}

/** 따옴표를 존중하는 최소 토큰화 — 공백이 든 경로를 한 토큰으로 유지한다. */
export function commandTokens(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(TOKEN_RE)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** 훅 명령 안에서 엔진을 가리키는 경로 토큰. 없으면 null. */
export function engineTokenIn(command: string): string | null {
  for (const token of commandTokens(command)) {
    if (ENGINE_BASENAMES.includes(exeName(token))) return token;
  }
  return null;
}

/**
 * 이 경로가 cwd 와 무관하게 해석되는가 — 어디서 실행돼도 같은 파일을 가리키는가.
 *
 * 훅 핸들러는 프로젝트 루트가 아니라 **현재 작업 디렉토리에서 실행된다**(공식 훅 문서).
 * 상대 경로로 쓰면 하위 디렉토리로 들어가는 순간 게이트가 전부 죽는다.
 */
export function pathIsRooted(path: string): boolean {
  if (!path) return false;
  if (path.includes("CLAUDE_PROJECT_DIR")) return true; // 플레이스홀더 — 루트로 치환된다
  if (/^[/\\~]/.test(path)) return true; // POSIX 절대 경로·홈
  if (path.length > 1 && path[1] === ":") return true; // C:/... 윈도우 절대 경로
  if (/[/\\]/.test(path)) return false; // 구분자가 있는 상대 경로 — cwd 종속
  // 이름만 있는 실행 파일은 PATH 로 해석돼 cwd 와 무관하다(v2 의 전역 EXE 참조).
  // 스크립트는 인터프리터가 cwd 기준으로 열므로 예외가 아니다.
  return !SCRIPT_EXT_RE.test(path);
}

/** matcher 문자열이 해당 도구를 덮는가 — 정확 일치 목록(`|`·`,` 구분) 기준. */
export function matcherCovers(matcher: string, tool: string): boolean {
  if (!matcher) return false;
  return matcher
    .split(/[|,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .includes(tool);
}

interface HookCommand {
  readonly event: string;
  readonly command: string;
  readonly matcher: string;
}

/** settings 의 hooks 트리를 방어적으로 훑어 (이벤트, 명령, matcher) 를 내놓는다. */
export function* iterHookCommands(settings: unknown): Generator<HookCommand> {
  if (!isRecord(settings)) return;
  const hooks = settings["hooks"];
  if (!isRecord(hooks)) return;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const items = entry["hooks"];
      if (!Array.isArray(items)) continue;
      const matcher = typeof entry["matcher"] === "string" ? entry["matcher"] : "";
      for (const item of items) {
        if (isRecord(item) && typeof item["command"] === "string") {
          yield { event, command: item["command"], matcher };
        }
      }
    }
  }
}

interface SettingsFile {
  readonly name: string;
  readonly state: LoadState;
  readonly settings: unknown;
}

async function readSettings(repo: string): Promise<SettingsFile[]> {
  const dir = repoPaths(repo).claudeDir;
  const out: SettingsFile[] = [];
  for (const name of SETTINGS_FILES) {
    const r = await loadJson<unknown>(join(dir, name));
    out.push({ name, state: r.state, settings: r.value });
  }
  return out;
}

/** 등록된 하네스 훅 op → 그 훅이 걸린 matcher 문자열(없으면 ""). */
export function hookMatchersFrom(files: readonly SettingsFile[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const file of files) {
    for (const { command, matcher } of iterHookCommands(file.settings)) {
      if (!engineTokenIn(command)) continue;
      const tokens = commandTokens(command);
      for (const op of MARKER_HOOK_OPS) {
        if (tokens.includes(op) && !(op in found)) found[op] = matcher;
      }
    }
  }
  return found;
}

/** 엔진을 상대 경로로 가리켜 cwd 에 종속되는 훅 명령 목록(정렬). */
export function cwdDependentHooksFrom(files: readonly SettingsFile[]): string[] {
  const weak = new Set<string>();
  for (const file of files) {
    for (const { command } of iterHookCommands(file.settings)) {
      const token = engineTokenIn(command);
      if (token && !pathIsRooted(token)) weak.add(command.trim());
    }
  }
  return [...weak].sort();
}

/**
 * 훅 명령의 엔진 토큰을 **존재를 확인할 수 있는** 파일 경로로 푼다. 못 풀면 null.
 *
 * 확인 대상은 cwd 와 무관하게 한 파일로 고정되는 경로뿐이다 — 절대 경로와
 * `${CLAUDE_PROJECT_DIR}` 로 시작하는 경로(저장소 루트로 치환하면 고정된다).
 *
 * **못 푸는 것을 죽었다고 단정하지 않는다**(오탐 금지). 이름만 쓴 실행 파일(`autoharness`)은
 * PATH 로 해석되는데 훅이 도는 환경의 PATH 는 진단 시점의 PATH 와 다를 수 있고, `~`·`%VAR%`
 * 는 셸이 푸는 것이라 진단이 흉내 내면 틀린다. 구분자가 있는 상대 경로는 이미
 * `cwd_dependent_hooks` 가 다루므로 여기서 또 세지 않는다.
 */
export function resolvableEnginePath(token: string, repo: string): string | null {
  if (!token) return null;
  const expanded = token
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, repo)
    .replace(/\$CLAUDE_PROJECT_DIR/g, repo);
  if (expanded.includes("${") || expanded.includes("%") || expanded.startsWith("~")) return null;
  const isAbsolute = /^[/\\]/.test(expanded) || (expanded.length > 1 && expanded[1] === ":");
  return isAbsolute ? expanded : null;
}

/** 확인 가능한 경로인데 그 파일이 없는 훅 명령 목록(정렬). */
export async function deadEngineHooksFrom(
  files: readonly SettingsFile[],
  repo: string,
): Promise<string[]> {
  const dead = new Set<string>();
  for (const file of files) {
    for (const { command } of iterHookCommands(file.settings)) {
      const token = engineTokenIn(command);
      if (!token) continue;
      const path = resolvableEnginePath(token, repo);
      if (!path) continue;
      if (!(await Bun.file(path).exists())) dead.add(command.trim());
    }
  }
  return [...dead].sort();
}

/** 훅 명령이 대상 저장소를 cwd 에 맡기는가 — `--repo` 가 없으면 엔진이 cwd 를 저장소로 본다. */
export function hookCommandIsRepoUnpinned(command: string): boolean {
  if (!command || !engineTokenIn(command)) return false;
  return !command.split(/\s+/).includes("--repo");
}

/** 대상 저장소를 못 박지 않은 훅 명령 목록(정렬). */
export function repoUnpinnedHooksFrom(files: readonly SettingsFile[]): string[] {
  const weak = new Set<string>();
  for (const file of files) {
    for (const { command } of iterHookCommands(file.settings)) {
      if (hookCommandIsRepoUnpinned(command)) weak.add(command.trim());
    }
  }
  return [...weak].sort();
}

/**
 * 훅 배선 상태 판정.
 *
 * @param tracker 이미 읽어 둔 장부(있으면 재읽기를 피한다). 보조 신호에만 쓰인다.
 */
export async function hookWiringStatus(repo: string, tracker?: Tracker | null): Promise<WiringInfo> {
  const files = await readSettings(repo);
  const matchers = hookMatchersFrom(files);
  const registered = Object.keys(matchers).sort();

  const seenLoad = await loadJson<Record<string, unknown>>(repoPaths(repo).hooksSeen);
  const seen = seenLoad.state === "ok" && isRecord(seenLoad.value) ? seenLoad.value : {};
  const fireTimes = new Map<string, string>();
  for (const op of MARKER_HOOK_OPS) {
    const rec = seen[op];
    if (isRecord(rec) && typeof rec["ts"] === "string" && rec["ts"]) fireTimes.set(op, rec["ts"]);
  }
  const fired = [...fireTimes.keys()].sort();
  const lastFire = fired.length > 0 ? [...fireTimes.values()].sort().at(-1)! : null;

  const resolved = tracker ?? (await loadTracker(repo)).tracker;
  const done = (resolved?.tasks ?? []).filter((t) => t.status === "done");
  const noCommit = done.filter((t) => !t.commit);

  // 죽은 경로는 **과거 발화 기록을 이긴다** — 예전에 발화했더라도 지금 없는 파일은 못 부른다.
  const deadHooks = await deadEngineHooksFrom(files, repo);

  let state: WiringState;
  if (registered.length === 0) state = WIRING_NOT_REGISTERED;
  else if (deadHooks.length > 0) state = WIRING_BROKEN_PATH;
  else if (fired.length > 0) state = WIRING_ACTIVE;
  else state = WIRING_INACTIVE;

  // matcher 커버리지 — matcher 가 "Bash" 뿐이면 다른 실행 도구로 게이트가 통째로 우회된다(실측).
  const uncovered = COMMAND_TOOLS.filter((tool) =>
    Object.entries(matchers).some(
      ([op, m]) => MATCHER_SCOPED_OPS.includes(op) && !matcherCovers(m, tool),
    ),
  ).sort();

  const settingsStates: Record<string, LoadState> = {};
  for (const f of files) settingsStates[f.name] = f.state;
  const corrupt = files.filter((f) => f.state === "corrupt").map((f) => f.name).sort();
  const missing = MARKER_HOOK_OPS.filter((op) => !(op in matchers));
  const weakHooks = cwdDependentHooksFrom(files);
  const unpinnedHooks = repoUnpinnedHooksFrom(files);

  const info = {
    state,
    registered,
    fired,
    last_fire: lastFire,
    matchers,
    uncovered_tools: uncovered,
    settings_states: settingsStates,
    missing_hooks: [...missing],
    cwd_dependent_hooks: weakHooks,
    repo_unpinned_hooks: unpinnedHooks,
    dead_engine_hooks: deadHooks,
    done_total: done.length,
    done_without_commit: noCommit.length,
    warning: null as string | null,
  } satisfies WiringInfo;

  const warnings: string[] = [];
  if (corrupt.length > 0) {
    warnings.push(
      `[AutoHarness 경고] 설정 파일이 파손됐습니다(${corrupt.join(", ")}) — Claude Code 가 읽지 ` +
        "못하면 훅이 전부 비활성화됩니다. '미등록(수동 운용)'으로 보이지만 실제로는 게이트가 " +
        "없는 상태일 수 있습니다.",
    );
  }
  if (registered.length > 0 && missing.length > 0) {
    warnings.push(
      `[AutoHarness 경고] 하네스 훅이 일부만 등록돼 있습니다 — 누락: ${missing.join(", ")}. ` +
        "등록되지 않은 훅이 강제하던 규칙은 동작하지 않습니다.",
    );
  }
  if (uncovered.length > 0) {
    warnings.push(
      `[AutoHarness 경고] 훅 matcher 가 실행 도구를 다 덮지 않습니다 — 누락: ${uncovered.join(", ")}. ` +
        "덮이지 않은 도구로 명령을 실행하면 금지 명령 차단과 커밋 게이트가 통째로 우회됩니다.",
    );
  }
  if (weakHooks.length > 0) {
    warnings.push(
      `[AutoHarness 경고] 훅 ${weakHooks.length}건이 엔진을 상대 경로로 가리킵니다 — 훅은 프로젝트 ` +
        "루트가 아니라 현재 작업 디렉토리에서 실행되므로, 하위 디렉토리로 이동하면 게이트가 전부 " +
        "죽습니다. `${CLAUDE_PROJECT_DIR}` 나 절대 경로로 바꾸십시오.",
    );
  }
  if (unpinnedHooks.length > 0) {
    warnings.push(
      `[AutoHarness 경고] 훅 ${unpinnedHooks.length}건이 대상 저장소를 지정하지 않습니다(--repo 없음) — ` +
        "엔진이 현재 작업 디렉토리를 저장소로 삼으므로, 하위 디렉토리에서 명령을 실행하면 장부를 " +
        `찾지 못해 커밋 게이트와 Stop 게이트가 조용히 통과합니다. 훅 명령 끝에 \`${REPO_PIN_FLAG}\` 를 붙이십시오.`,
    );
  }
  if (state === WIRING_BROKEN_PATH) warnings.unshift(brokenPathWarning(info));
  if (state === WIRING_INACTIVE) warnings.unshift(inactiveWarning(repo, info));

  return { ...info, warning: warnings.length > 0 ? warnings.join("\n") : null };
}

/**
 * inactive 와 처방이 다르다 — 여기서 "저장소 루트에서 실행하십시오"는 아무 도움이 안 된다.
 * 없는 파일은 어디서 실행해도 없다. 고치는 방법은 훅 명령의 경로를 다시 쓰는 것뿐이다.
 */
function brokenPathWarning(info: WiringInfo): string {
  return (
    "[AutoHarness 경고] 훅이 실존하지 않는 실행 파일을 가리킵니다 — " +
    `${info.dead_engine_hooks.length}건: ${info.dead_engine_hooks.join(" / ")}. ` +
    "커밋 게이트·금지 명령 차단·SHA 동기화·Stop 게이트가 전부 무효입니다. 훅 명령에는 설치 " +
    "시점의 절대 경로가 박히는데 .claude/settings.json 은 저장소를 따라 다니므로, 다른 계정·" +
    "다른 기계로 옮기면 이 상태가 됩니다. `autoharness install --repo <저장소>` 로 훅 경로를 " +
    "현재 실행 파일로 다시 쓰십시오(기존 설정은 백업됩니다). (경고일 뿐 주행은 계속합니다)"
  );
}

function inactiveWarning(repo: string, info: WiringInfo): string {
  // 보조 신호: done 인데 commit 이 비어 있음 = PostToolUse 미발화의 흔적
  const extra =
    info.done_total > 0 && info.done_without_commit === info.done_total
      ? ` 보조 신호: done ${info.done_total}건 전부 커밋 SHA 기록 없음(PostToolUse 미발화 흔적).`
      : "";
  return (
    `[AutoHarness 경고] 훅 배선 비활성 의심 — 저장소 설정에 하네스 훅(${info.registered.join(", ")})이 ` +
    "등록돼 있으나 실제 발화 기록이 한 번도 없습니다. 세션 프로젝트 루트가 저장소 밖이면 " +
    ".claude/settings.json 이 로드되지 않아 커밋 게이트·금지 명령 차단·Stop 게이트가 모두 " +
    `무력화됩니다 — 저장소 루트(${repoPaths(repo).repo})에서 claude 를 실행하십시오.${extra} ` +
    "(경고일 뿐 주행은 계속합니다)"
  );
}
