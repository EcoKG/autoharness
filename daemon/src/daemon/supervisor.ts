/**
 * 프로젝트 판단과 세션 기동 — **판단 순서가 계약이다**(daemon/DESIGN.md 6.2, v1 §10).
 *
 *   status → 백오프 → PAUSED → 장부 → 진행 가능 작업 → 하트비트 → 기동
 *
 * 순서를 바꾸면 조용한 오작동이 난다. 예를 들어 하트비트를 장부보다 먼저 보면 파손된
 * 장부를 가진 프로젝트가 영영 오류로 집계되지 않고, PAUSED 를 백오프보다 먼저 보면
 * 일시정지한 프로젝트의 백오프가 계속 흘러 재개 즉시 몰려 기동한다.
 *
 * 세 가지는 v1 이 실측으로 고친 것이라 그대로 옮긴다:
 *   ① `completed` 는 종점이 아니다 — 장부에 할 일이 생기면 되살린다.
 *   ② **빈 장부를 완료로 봉인하지 않는다** — init 과 첫 task_add 사이에 tick 이 한 번만
 *      돌아도 프로젝트가 봉인돼, 이후 작업을 넣어도 영영 기동되지 않았다.
 *   ③ 교착 pending 은 완료가 아니라 `needs_human` 이다 — 영영 실행 불가인데 성공처럼
 *      마감하면 아무도 모른다.
 */
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { deadlockedPending, eligibleNext, loadTracker, statusCounts } from "../core/ledger.ts";
import { loadJson } from "../core/load.ts";
import { repoPaths, userPaths } from "../core/paths.ts";
import { nowIso, type RegistryProject, type RegistrySettings, type Task } from "../core/schema.ts";

/** 사용량 초과 분류가 이만큼 연속되면 오분류를 의심하고 사람에게 신호를 남긴다. */
export const LIMIT_NOTICE_HITS = 5;
export const DEFAULT_PROBE_SEC = 90;
export const DEFAULT_STALE_MINUTES = 30;
export const LOG_TAIL_BYTES = 4096;

/**
 * 사용량 초과 패턴.
 *
 * **미탐이 오탐보다 비싸다** — 진짜 한도를 놓치면 error 경로로 빠져 5회 뒤 정지하지만,
 * 오탐은 백오프 한 번으로 끝난다. 그래서 문맥을 무조건 요구하지는 않되, 맨몸 단어는
 * 단어 경계와 동사로 좁힌다:
 *   `\boverloaded\b` → "server is overloaded" 는 잡고 `test_overloaded_queue` 는 거른다
 *                      (밑줄은 word 문자라 식별자 안에서는 경계가 생기지 않는다)
 *   `quota (exceeded|…)` → "quota management"·"disk quota check" 오탐 제거
 */
export const USAGE_RE = new RegExp(
  "(usage.?limit|rate.?limit|limit reached|too many requests|" +
    "credit balance|out of (extra )?usage|" +
    "\\boverloaded\\b|quota\\s+(exceeded|exhausted|reached)|" +
    "(api.?error|status|code|http)\\D{0,12}(429|overloaded|quota)|" +
    "(429|overloaded|quota)\\D{0,12}(api.?error|_error))",
  "i",
);

export function isUsageLimited(text: string | null | undefined): boolean {
  return USAGE_RE.test(text ?? "");
}

/** nth(1부터) 번째 백오프 분값 — 끝을 넘으면 마지막 값으로 고정한다(무한 증가 금지). */
export function backoffPick(seq: readonly number[] | undefined, nth: number): number {
  if (!seq || seq.length === 0) return 30;
  return seq[Math.min(Math.max(nth, 1) - 1, seq.length - 1)]!;
}

export function parseIso(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function isoAfter(minutes: number, now: number = Date.now()): string {
  return new Date(now + minutes * 60_000).toISOString();
}

export type Decision =
  | { action: "skip"; reason: string }
  | { action: "error"; reason: string }
  | { action: "transition"; status: "completed" | "needs_human"; detail: string }
  | { action: "launch"; next: Task; detail: string };

export interface DecideOptions {
  now?: number;
  settings?: Partial<RegistrySettings>;
  /**
   * 사람이 웹에서 명시적으로 '지금 기동'을 누른 경우.
   * 백오프와 하트비트 신선도만 건너뛴다 — 일시정지·status·장부 검사는 그대로다.
   * 사람의 다른 의사표시(PAUSED)를 사람의 이번 클릭이 덮게 두지 않는다.
   */
  force?: boolean;
}

/**
 * 이 프로젝트에 지금 무엇을 할 것인가.
 *
 * 부작용은 `reactivate` 뿐이다(completed → active). 나머지는 판단만 하고 돌려준다 —
 * 적용은 호출자가 하므로 판단 순서를 테스트가 직접 확인할 수 있다.
 */
export async function decideProject(
  proj: RegistryProject,
  options: DecideOptions = {},
): Promise<{ decision: Decision; reactivated: boolean }> {
  const now = options.now ?? Date.now();
  const settings = options.settings ?? {};
  const repo = proj.repo || "";
  const paths = repoPaths(repo);
  let reactivated = false;

  // 1. status — completed 는 종점이 아니다. 장부에 할 일이 생겼으면 되살린다.
  let status: string = proj.status;
  if (status === "completed") {
    const { tracker } = await loadTracker(repo);
    if (tracker && eligibleNext(tracker)) {
      proj.status = "active";
      proj.consecutive_errors = 0;
      proj.limit_hits = 0;
      proj.next_retry_at = null;
      proj.updated_at = nowIso();
      status = "active";
      reactivated = true;
    }
  }
  if (status !== "active") {
    return { decision: { action: "skip", reason: `status=${status} — 기동 대상 아님` }, reactivated };
  }

  // 2. 백오프 중이면 쉰다(사람이 직접 누른 경우는 예외)
  const retryAt = parseIso(proj.next_retry_at);
  if (!options.force && retryAt !== null && retryAt > now) {
    return {
      decision: { action: "skip", reason: `백오프 중 — next_retry_at=${proj.next_retry_at}` },
      reactivated,
    };
  }

  // 2.5 저장소의 일시정지 플래그 — MCP 없이 파일만 만든 폴백 일시정지도 존중한다
  if (await Bun.file(paths.pausedFlag).exists()) {
    return { decision: { action: "skip", reason: "HARNESS_PAUSED 플래그 존재 — 일시정지 상태" }, reactivated };
  }

  // 3. 장부 부재/파손 → 오류 집계(둘을 뭉개지 않는다)
  const load = await loadTracker(repo);
  if (load.state !== "ok" || !load.tracker) {
    const why = load.state === "corrupt" ? `파손(${load.error ?? "원인 불명"})` : "부재";
    return { decision: { action: "error", reason: `장부 ${why}: ${paths.tracker}` }, reactivated };
  }
  const tracker = load.tracker;

  // 4. 진행 가능 작업 없음 → 세 갈래로 나뉜다(하나로 뭉개면 프로젝트가 조용히 봉인된다)
  const next = eligibleNext(tracker);
  if (!next) {
    if (tracker.tasks.length === 0) {
      return {
        decision: { action: "skip", reason: "장부에 작업이 아직 없음 — 적재 대기(완료 전이하지 않음)" },
        reactivated,
      };
    }
    const counts = statusCounts(tracker);
    const dead = deadlockedPending(tracker);
    if (counts.blocked > 0 || dead.length > 0) {
      const reasons: string[] = [];
      if (counts.blocked > 0) reasons.push(`blocked ${counts.blocked}건`);
      if (dead.length > 0) {
        reasons.push(`교착 pending ${dead.length}건(${dead.slice(0, 3).map((t) => t.id).join(", ")})`);
      }
      return {
        decision: {
          action: "transition",
          status: "needs_human",
          detail: `${reasons.join(" / ")} — 사람 판단 필요`,
        },
        reactivated,
      };
    }
    return {
      decision: {
        action: "transition",
        status: "completed",
        detail: `진행 가능 작업 없음(done ${counts.done}건) — 완료 전이`,
      },
      reactivated,
    };
  }

  // 5. 하트비트가 신선하면 세션이 살아 있다 — 이중 기동 방지
  const hb = await loadJson<{ ts?: string }>(paths.heartbeat);
  const hbTs = hb.state === "ok" ? parseIso(hb.value?.ts) : null;
  const staleMin = Number(settings.stale_minutes ?? DEFAULT_STALE_MINUTES);
  if (!options.force && hbTs !== null && now - hbTs < staleMin * 60_000) {
    return {
      decision: {
        action: "skip",
        reason: `하트비트 신선(${hb.value?.ts}, 기준 ${staleMin}분) — 세션 생존 추정`,
      },
      reactivated,
    };
  }

  return {
    decision: { action: "launch", next, detail: `다음 작업=${next.id} model=${proj.model}` },
    reactivated,
  };
}

/** error 집계 — 연속 한도에 닿으면 정지한다(limit 과 달리 error 는 사람을 부른다). */
export function markError(
  proj: RegistryProject,
  settings: Partial<RegistrySettings>,
  reason: string,
  now: number = Date.now(),
): string {
  const nextCount = (proj.consecutive_errors ?? 0) + 1;
  const maxErr = Number(settings.max_consecutive_errors ?? 5);
  const mins = backoffPick(settings.error_backoff_minutes ?? [15, 30, 60], nextCount);
  proj.consecutive_errors = nextCount;
  proj.next_retry_at = isoAfter(mins, now);
  proj.updated_at = nowIso();
  if (nextCount >= maxErr) {
    proj.status = "error";
    return `${reason} — 연속 오류 ${nextCount}회(한도 ${maxErr}) → status=error 정지. 사람 확인 필요`;
  }
  return `${reason} — 연속 오류 ${nextCount}/${maxErr}, ${mins}분 후 재시도`;
}

/** 기동 결과 분류 — **우선순위가 계약이다**(아래 classifyLaunch 주석 참고). */
export type LaunchResult = "ok" | "limit" | "error";

export interface LaunchOutcome {
  result: LaunchResult;
  rc: number | null;
  log: string;
  message: string;
}

/**
 * 분류 우선순위: 생존 → rc=0 → 사용량 패턴 → 그 외.
 *
 * rc=0 검사를 사용량 패턴보다 **먼저** 두는 것이 핵심이다. 정상 세션의 출력에도
 * '429'·'quota' 같은 문자열이 우연히 섞이므로(테스트 로그·소스 인용), 순서를 뒤집으면
 * 정상 종료가 사용량 초과로 오분류돼 백오프가 헛돈다.
 */
export function classifyLaunch(rc: number | null, logTail: string): LaunchResult {
  if (rc === null) return "ok"; // 프로브 생존 — 세션이 계속 돈다
  if (rc === 0) return "ok";
  return isUsageLimited(logTail) ? "limit" : "error";
}

export function applyOk(proj: RegistryProject, logPath: string): void {
  proj.consecutive_errors = 0;
  proj.limit_hits = 0;
  proj.next_retry_at = null;
  proj.last_launch = { ts: nowIso(), result: "ok", log: logPath };
  proj.updated_at = nowIso();
  delete proj.needs_attention;
}

/**
 * limit 처리 — **영구 포기는 없다**(status 는 active 로 남는다).
 *
 * 다만 상한도 신호도 없으면 오분류 상태가 360분 간격으로 영원히 반복된다(error 분기가
 * 5회로 정지하는 것과의 비일관). 연속 횟수가 기준을 넘으면 사람이 볼 신호를 남긴다.
 */
export function applyLimit(
  proj: RegistryProject,
  settings: Partial<RegistrySettings> & { limit_notice_hits?: number },
  logPath: string,
  now: number = Date.now(),
): string {
  const hits = (proj.limit_hits ?? 0) + 1;
  const mins = backoffPick(settings.limit_backoff_minutes ?? [30, 60, 120, 240, 360], hits);
  proj.limit_hits = hits;
  proj.next_retry_at = isoAfter(mins, now);
  proj.last_launch = { ts: nowIso(), result: "limit", log: logPath };
  proj.updated_at = nowIso();

  const notice = Number(settings.limit_notice_hits ?? LIMIT_NOTICE_HITS);
  let warn = "";
  if (hits >= notice) {
    proj.needs_attention =
      `사용량 초과 분류가 ${hits}회 연속입니다 — 실제 한도가 아니라 오분류일 수 있습니다. ` +
      `${logPath} 로그를 확인하십시오.`;
    warn = ` ⚠ ${hits}회 연속 — 오분류 가능성, 로그 확인 권장`;
  } else {
    delete proj.needs_attention;
  }
  return `사용량 초과 감지 — limit_hits=${hits}, ${mins}분 후 재시도(영구 포기 없음)${warn}`;
}

/** 헤드리스 세션 기동에 필요한 것만 추상화한다 — 테스트가 실제 claude 를 띄우지 않게. */
export interface LaunchHandle {
  pid: number;
  /** probeSec 안에 종료했으면 rc, 살아 있으면 null. */
  probe: (probeSec: number) => Promise<number | null>;
  readLogTail: () => Promise<string>;
}

export interface LaunchSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  /**
   * 자식이 뱉는 줄을 그대로 흘려보낸다 — **웹 콘솔이 보고 싶은 것은 이것이다.**
   * 데몬 자신의 판단 로그가 아니라 주행 중인 세션이 지금 무엇을 하는지.
   */
  onLine?: (line: string) => void;
}

export interface Launcher {
  (spec: LaunchSpec): Promise<LaunchHandle>;
}

/** 세션 한 줄의 길이 상한 — 한 줄이 화면과 스트림을 통째로 먹지 않게 한다. */
export const SESSION_LINE_CAP = 2000;

export function capLine(line: string, cap = SESSION_LINE_CAP): string {
  return line.length <= cap ? line : `${line.slice(0, cap)}… (${line.length - cap}자 생략)`;
}

const BUILTIN_BOOTSTRAP = [
  "당신은 AutoHarness 자율 주행 세션입니다. 사용자에게 질문하지 말고 아래 절차만 반복하십시오.",
  "1. .claude/agent_tracker.json 장부를 읽고 현재 상태를 파악합니다.",
  "2. 하네스 CLI 의 next 로 다음 작업을 확인합니다.",
  "3. 해당 작업을 구현·수정한 뒤 하네스 CLI 의 run --task <id> 로 검증합니다.",
  "4. 종료 코드 분기: 0=검증 통과 — 커밋 후 다음 작업 계속 / 1=검증 실패 — 오류 요약을 읽고",
  "   자가 수정 후 재실행 / 2=설정 오류 — 중단·보고 / 3=진행 가능 작업 없음 — 세션 종료 /",
  "   4=해당 작업 봉인 — 남은 작업이 있으면 계속, 없으면 종료.",
  "테스트를 약화시켜 통과시키지 마십시오. done 은 오직 run 성공으로만 생깁니다.",
].join("\n");

/** 부트스트랩 프롬프트 — 설치본 템플릿이 있으면 그것을, 없으면 내장문을 쓴다. */
export async function bootstrapPrompt(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = join(userPaths(env).skillDir, "templates", "bootstrap_prompt.txt");
  try {
    const text = (await Bun.file(path).text()).trim();
    if (text) return text;
  } catch {
    /* 템플릿이 없으면 내장문 — 설치 형태에 관계없이 항상 기동할 수 있어야 한다 */
  }
  return BUILTIN_BOOTSTRAP;
}

/**
 * `claude` 실행 파일 해석.
 * `.bat`/`.cmd` 심을 거치면 cmd 가 인자를 재해석해 프롬프트의 따옴표·`<>` 가 깨지므로
 * `.exe` 를 우선한다(npm 심 환경 이식성).
 */
export function findClaude(): string {
  const direct = Bun.which("claude");
  if (direct && /\.(bat|cmd)$/i.test(direct)) {
    const exe = Bun.which("claude.exe");
    if (exe) return exe;
  }
  return direct ?? "claude";
}

export interface LaunchOptions {
  settings?: Partial<RegistrySettings> & { limit_notice_hits?: number };
  launcher: Launcher;
  /** 세션 출력을 받을 곳. 데몬이 콘솔 로그로 연결한다. */
  onLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: number;
  logDir?: string;
}

/** 세션 기동 + 프로브 + 분류 적용. 레지스트리 항목을 제자리에서 고친다. */
export async function launchProject(
  proj: RegistryProject,
  next: Task,
  options: LaunchOptions,
): Promise<LaunchOutcome> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? {};
  const now = options.now ?? Date.now();
  const probeSec = Number(settings.probe_sec ?? DEFAULT_PROBE_SEC);
  const logDir = options.logDir ?? userPaths(env).logs;
  await mkdir(logDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const logPath = join(logDir, `${proj.id}-${stamp}.log`);

  const argv = [
    findClaude(),
    "-p",
    await bootstrapPrompt(env),
    "--model",
    proj.model || "claude-opus-5",
    ...(proj.permission_args ?? []),
  ];
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  childEnv["CLAUDE_AUTOHARNESS"] = "1"; // hook-stop 게이트가 이 변수로 헤드리스를 식별한다

  let handle: LaunchHandle;
  try {
    handle = await options.launcher({
      argv, cwd: proj.repo, env: childEnv, logPath,
      onLine: options.onLine ? (line) => options.onLine!(capLine(line)) : undefined,
    });
  } catch (err) {
    const message = markError(proj, settings, `기동 실패: ${String(err)}`, now);
    proj.last_launch = { ts: nowIso(), result: "error", log: logPath };
    return { result: "error", rc: null, log: logPath, message };
  }

  const rc = await handle.probe(probeSec);
  const result = classifyLaunch(rc, rc === null || rc === 0 ? "" : await handle.readLogTail());

  if (result === "ok") {
    applyOk(proj, logPath);
    const detail = rc === null ? `프로브 ${probeSec}초 생존 — 세션 분리(계속 실행)` : "조기 정상 종료(rc=0)";
    return { result, rc, log: logPath, message: `pid=${handle.pid} 다음 작업=${next.id} ${detail}` };
  }
  if (result === "limit") {
    return { result, rc, log: logPath, message: applyLimit(proj, settings, logPath, now) };
  }
  const message = markError(proj, settings, `조기 비정상 종료(rc=${rc}) log=${logPath}`, now);
  proj.last_launch = { ts: nowIso(), result: "error", log: logPath };
  return { result, rc, log: logPath, message };
}

/** 실제 프로세스를 띄우는 런처 — 데몬이 쓰는 구현. */
export function realLauncher(): Launcher {
  return async ({ argv, cwd, env, logPath, onLine }) => {
    const file = await open(logPath, "w");
    // 줄을 흘려야 하면 파이프로 받아 **파일과 스트림 양쪽에** 쓴다.
    // 아무도 안 보면 파이프를 만들 이유가 없으므로 그때는 곧장 파일로 보낸다.
    const piped = typeof onLine === "function";
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: piped ? "pipe" : file.fd,
      stderr: piped ? "pipe" : file.fd,
      // 자식은 데몬보다 오래 산다 — 프로브 뒤 분리하는 것이 정상 경로다
    });
    let exited: number | null = null;
    proc.exited.then((code) => {
      exited = code;
    });

    if (piped) {
      // 프로브가 끝나 데몬이 세션을 분리해도 **끝까지 읽는다** — 분리는 기다리지
      // 않는다는 뜻이지 출력을 버린다는 뜻이 아니다. 이걸 놓치면 기동 직후 몇 줄만
      // 보이고 정작 주행하는 내용이 사라진다.
      const pump = async (stream: ReadableStream<Uint8Array> | undefined): Promise<void> => {
        if (!stream) return;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of stream) {
          buffer += decoder.decode(chunk, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, "");
            buffer = buffer.slice(idx + 1);
            await file.write(`${line}\n`, null, "utf8").catch(() => {});
            if (line.trim()) onLine!(line);
          }
        }
        if (buffer.trim()) {
          await file.write(buffer, null, "utf8").catch(() => {});
          onLine!(buffer);
        }
      };
      void Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>),
                        pump(proc.stderr as ReadableStream<Uint8Array>)])
        .finally(() => void file.close().catch(() => {}));
    }
    return {
      pid: proc.pid,
      probe: async (probeSec) => {
        const deadline = Date.now() + Math.max(1, probeSec) * 1000;
        while (Date.now() < deadline) {
          if (exited !== null) break;
          await Bun.sleep(Math.min(5000, Math.max(200, deadline - Date.now())));
        }
        if (!piped) await file.close().catch(() => {});
        return exited;
      },
      readLogTail: async () => {
        const text = await Bun.file(logPath).text().catch(() => "");
        return text.slice(-LOG_TAIL_BYTES);
      },
    };
  };
}
