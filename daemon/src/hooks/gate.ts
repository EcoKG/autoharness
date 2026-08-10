/**
 * 게이트 판정 — **컨텍스트가 처리 방식을 정한다.**
 *
 * 위험 모델은 "사람이 없을 때 에이전트가 되돌릴 수 없는 일을 하는 것"이다. v1 은 이를
 * 무조건 exit 2 로 막아 **사람이 눈앞에서 지시한 경우까지** 덮었고, 사용자가 승인해도
 * 실행이 불가능했다. 이제 두 게이트(금지 명령·커밋)가 같은 판정 함수를 쓴다:
 *
 *   헤드리스(무인)      → deny : 물어볼 사람이 없으므로 하드 차단(exit 2 + stderr)
 *   대화형 / 일시정지    → ask  : 사용자 승인 창으로 승격 — 사람이 결정한다
 */
import { EXIT } from "../exit.ts";
import { loadTracker } from "../core/ledger.ts";
import { repoPaths } from "../core/paths.ts";

export const GATE_DENY = "deny";
export const GATE_ASK = "ask";
export type GateDecision = typeof GATE_DENY | typeof GATE_ASK;

/** 워치독이 띄운 무인 세션인가 — Stop 게이트와 동일한 식별 기준. */
export function isHeadlessSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CLAUDE_AUTOHARNESS"] === "1";
}

export async function isPaused(repo: string): Promise<boolean> {
  return Bun.file(repoPaths(repo).pausedFlag).exists();
}

/** 게이트가 걸렸을 때의 처리 방식 — 사람이 개입할 수 있는 자리인가로 정한다. */
export async function gateDecision(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GateDecision> {
  if (await isPaused(repo)) return GATE_ASK; // 일시정지 = 사람이 직접 운전 중
  return isHeadlessSession(env) ? GATE_DENY : GATE_ASK;
}

/**
 * 게이트 결과를 훅 계약대로 내보낸다.
 * deny 는 stdout 을 쓰지 않고, ask 는 stderr 를 쓰지 않는다.
 */
export function emitGate(decision: GateDecision, reason: string, command = ""): number {
  if (decision === GATE_DENY) {
    process.stderr.write(`[AutoHarness 차단] ${reason}: ${command.slice(0, 200)}\n`);
    return EXIT.USAGE;
  }
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `[AutoHarness] ${reason}`,
      },
    })}\n`,
  );
  return EXIT.OK;
}

/** 커밋 게이트가 걸리는 사유 — 통과면 null. */
export async function commitGateReason(repo: string): Promise<string | null> {
  const { state, tracker, error } = await loadTracker(repo);
  if (state === "corrupt") {
    // 파손을 '장부 없음(수동 운용)'으로 보고 통과시키면 게이트가 조용히 사라진다
    return `장부가 파손돼 검증 상태를 확인할 수 없습니다: ${repoPaths(repo).tracker} (${error ?? "원인 불명"})`;
  }
  if (!tracker || tracker.tasks.length === 0) return null;
  if (await isPaused(repo)) return null; // 일시정지 중에는 게이트를 걸지 않는다

  const active = tracker.tasks.filter((t) => t.status === "in_progress" || t.status === "failed");
  if (active.length === 0) return null;

  const state2 = await Bun.file(repoPaths(repo).state)
    .json()
    .catch(() => null);
  // 통과 기록은 **1회용**이다. `ok` 만 보면 한 번 통과한 뒤로 검증 없는 커밋이 무한히
  // 열린다(적대 검증에서 확인). 그 기록이 가리키는 작업이 실제로 done 이고 아직 커밋
  // SHA 가 붙지 않았을 때만 연다 — postbash 가 SHA 를 기록하는 순간 게이트가 다시 닫힌다.
  const lastRun = state2?.last_run as { ok?: boolean; task?: string } | undefined;
  if (lastRun?.ok && typeof lastRun.task === "string") {
    const ran = tracker.tasks.find((t) => t.id === lastRun.task);
    if (ran && ran.status === "done" && !ran.commit) return null;
  }

  const first = active[0]!;
  return (
    `커밋 게이트: 진행 중 작업(${first.id})의 harness 검증 통과 기록이 없습니다. ` +
    `autoharness run --task ${first.id} 를 먼저 통과시키십시오.`
  );
}
