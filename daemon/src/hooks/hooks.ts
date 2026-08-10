/**
 * 훅 3종 + brief — Claude Code 가 부르는 단발 실행.
 *
 * **fail-open 이되 침묵하지 않는다.** 내부 예외로 일반 작업을 깨뜨리지 않지만, 실패를
 * 흔적 없이 삼키지도 않는다(v1 에서 하트비트 실패가 조용히 사라진 결함).
 */
import { EXIT } from "../exit.ts";
import { atomicWriteJson } from "../core/atomic.ts";
import { loadJson } from "../core/load.ts";
import {
  deadlockedPending,
  eligibleNext,
  loadTracker,
  statusCounts,
  writeHeartbeat,
  DEFAULT_MAX_ATTEMPTS,
} from "../core/ledger.ts";
import { repoPaths } from "../core/paths.ts";
import { nowIso } from "../core/schema.ts";
import { denyReason, invokesGitCommit } from "./command.ts";
import { GATE_DENY, commitGateReason, emitGate, gateDecision, isHeadlessSession, isPaused } from "./gate.ts";

export const STOP_BLOCK_LIMIT = 3;
/** Claude Code 런타임이 훅 stdin 에 채우는 필드 — 사람이 흉내 낸 호출에는 없다 */
export const HOOK_RUNTIME_KEYS = ["session_id", "hook_event_name", "transcript_path"] as const;
export const MARKER_HOOK_OPS = ["hook-prebash", "hook-postbash", "hook-stop"] as const;

export interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
  cwd?: string;
  tool_input?: { command?: string };
}

export async function readHookInput(): Promise<HookPayload> {
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    return raw.trim() ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    return {};
  }
}

/** 훅 페이로드가 Claude Code 런타임에서 온 것인가 — 런타임 전용 필드 유무로 본다. */
export function hookPayloadIsGenuine(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const rec = payload as Record<string, unknown>;
  return HOOK_RUNTIME_KEYS.some((k) => typeof rec[k] === "string" && (rec[k] as string).trim());
}

/**
 * 실제 훅 호출일 때만 발화 마커를 남긴다.
 * 하트비트의 source=hook 은 사람이 손으로도 남길 수 있어 배선 판정의 근거가 못 된다.
 */
export async function recordHookFire(repo: string, op: string, payload: HookPayload): Promise<boolean> {
  if (!hookPayloadIsGenuine(payload)) return false;
  try {
    const path = repoPaths(repo).hooksSeen;
    const prev = await loadJson<Record<string, unknown>>(path);
    const seen = prev.state === "ok" && prev.value ? prev.value : {};
    seen[op] = { ts: nowIso(), event: payload.hook_event_name ?? null, session_id: payload.session_id ?? null };
    await atomicWriteJson(path, seen);
    return true;
  } catch {
    return false;
  }
}

export async function hookPreBash(repo: string): Promise<number> {
  try {
    const payload = await readHookInput();
    const command = payload.tool_input?.command ?? "";
    await writeHeartbeat(repo, "hook");
    await recordHookFire(repo, "hook-prebash", payload);
    const decision = await gateDecision(repo);

    const reason = denyReason(command);
    if (reason) return emitGate(decision, reason, command);

    if (invokesGitCommit(command)) {
      const gate = await commitGateReason(repo);
      // 커밋이 실제로 일어날 수 있는 경로에서는 직전 HEAD 를 1회용 마커로 남긴다
      // (postbash 가 '새 커밋 생성'을 검증한다). 하드 차단이면 커밋이 없으므로 생략.
      if (!(gate && decision === GATE_DENY)) await recordHeadBeforeCommit(repo);
      if (gate) return emitGate(decision, gate, command);
    }
    return EXIT.OK;
  } catch (err) {
    process.stderr.write(`[AutoHarness] hook-prebash 내부 오류(통과 처리): ${String(err)}\n`);
    return EXIT.OK; // fail-open
  }
}

async function gitOutput(repo: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

async function readState(repo: string): Promise<Record<string, unknown>> {
  const r = await loadJson<Record<string, unknown>>(repoPaths(repo).state);
  return r.state === "ok" && r.value ? r.value : {};
}

async function recordHeadBeforeCommit(repo: string): Promise<void> {
  const state = await readState(repo);
  state["head_before_commit"] = await gitOutput(repo, ["rev-parse", "--short", "HEAD"]);
  await atomicWriteJson(repoPaths(repo).state, state);
}

/**
 * 커밋 SHA 를 최신 done 작업에 기록한다.
 * prebash 가 남긴 1회용 마커와 대조해 **커밋이 실제로 새 커밋을 만든 경우에만** 기록한다
 * — nothing to commit 같은 실패가 직전 SHA 를 가로채지 않게 한다.
 */
export async function syncCommit(repo: string, requireNewHead: boolean): Promise<string | null> {
  const { tracker } = await loadTracker(repo);
  if (!tracker) return null;
  const sha = await gitOutput(repo, ["rev-parse", "--short", "HEAD"]);
  if (!sha) return null;

  if (requireNewHead) {
    const state = await readState(repo);
    if ("head_before_commit" in state) {
      const prev = state["head_before_commit"];
      delete state["head_before_commit"]; // 마커는 1회용 — 재사용 오귀속을 막는다
      await atomicWriteJson(repoPaths(repo).state, state);
      if (sha === prev) return null;
    }
  }
  const candidates = tracker.tasks
    .filter((t) => t.status === "done" && !t.commit)
    .sort((a, b) => String(b.finished_at ?? "").localeCompare(String(a.finished_at ?? "")));
  const target = candidates[0];
  if (!target) return null;
  target.commit = sha;
  await atomicWriteJson(repoPaths(repo).tracker, tracker);
  return sha;
}

export async function hookPostBash(repo: string): Promise<number> {
  try {
    const payload = await readHookInput();
    const command = payload.tool_input?.command ?? "";
    await writeHeartbeat(repo, "hook");
    await recordHookFire(repo, "hook-postbash", payload);
    if (invokesGitCommit(command)) await syncCommit(repo, true);
  } catch (err) {
    process.stderr.write(`[AutoHarness] hook-postbash 내부 오류(무시): ${String(err)}\n`);
  }
  return EXIT.OK;
}

/**
 * 자율 주행 게이트 — 진행 가능한 작업이 남아 있으면 세션 종료를 막는다.
 * 진전 가드: 장부가 그대로인 채 반복 정지하면 한도 초과 시 놓아준다(토큰 방어).
 */
export async function hookStop(repo: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    await writeHeartbeat(repo, "hook");
    await recordHookFire(repo, "hook-stop", await readHookInput());
    if (!isHeadlessSession(env)) return EXIT.OK; // 대화형 세션을 납치하지 않는다
    if (await isPaused(repo)) return EXIT.OK;

    const { tracker } = await loadTracker(repo);
    if (!tracker) return EXIT.OK;
    const next = eligibleNext(tracker);
    if (!next) return EXIT.OK; // 더 할 일 없음 — 종료 허용

    const state = await readState(repo);
    const hash = Bun.hash(await Bun.file(repoPaths(repo).tracker).text()).toString(16);
    if (state["tracker_hash"] === hash) {
      state["stop_blocks"] = Number(state["stop_blocks"] ?? 0) + 1;
    } else {
      state["stop_blocks"] = 1;
      state["tracker_hash"] = hash;
    }
    await atomicWriteJson(repoPaths(repo).state, state);

    if (Number(state["stop_blocks"]) > STOP_BLOCK_LIMIT) {
      process.stderr.write(
        `[AutoHarness] 진전 없는 정지 ${state["stop_blocks"]}회 — 토큰 방어를 위해 세션을 종료합니다.\n`,
      );
      return EXIT.OK;
    }
    const maxAtt = tracker.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    process.stdout.write(
      `${JSON.stringify({
        decision: "block",
        reason:
          `AutoHarness 자율 주행 중입니다. 다음 작업 '${next.id} — ${next.title}'` +
          `(attempts ${next.attempts}/${maxAtt})을(를) 계속 진행하십시오. ` +
          "테스트 약화 금지, 사용자 질문 금지.",
      })}\n`,
    );
    return EXIT.OK;
  } catch (err) {
    process.stderr.write(`[AutoHarness] hook-stop 내부 오류(통과 처리): ${String(err)}\n`);
    return EXIT.OK; // fail-open
  }
}

/** SessionStart 훅 — 15줄 이하 상태 요약을 컨텍스트에 주입한다. */
export async function cmdBrief(repo: string): Promise<number> {
  const { state, tracker } = await loadTracker(repo);
  if (state === "corrupt") {
    console.log(`[AutoHarness] 장부가 파손됐습니다: ${repoPaths(repo).tracker}`);
    return EXIT.OK;
  }
  if (!tracker) return EXIT.OK;

  const c = statusCounts(tracker);
  const next = eligibleNext(tracker);
  const dead = deadlockedPending(tracker);
  console.log(`[AutoHarness] project=${tracker.project} model=${tracker.model}`);
  console.log(`목표: ${tracker.objective}`);
  console.log(
    `현황: done ${c.done}/${tracker.tasks.length}, in_progress ${c.in_progress}, ` +
      `failed ${c.failed}, blocked ${c.blocked}, pending ${c.pending}`,
  );
  if (dead.length > 0) {
    console.log(`교착 pending ${dead.length}건: ${dead.map((t) => t.id).join(", ")}`);
  }
  if (next) {
    const maxAtt = tracker.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    console.log(`다음 작업: ${next.id} — ${next.title} (attempts ${next.attempts}/${maxAtt})`);
    if (next.last_error) console.log(`직전 오류: ${next.last_error.replace(/\n/g, " ").slice(0, 200)}`);
  } else {
    console.log("진행 가능한 작업 없음 (완료 또는 blocked — PROGRESS.md 확인)");
  }
  return EXIT.OK;
}
