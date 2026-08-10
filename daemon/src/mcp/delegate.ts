/**
 * 데몬 위임 — 떠 있으면 로컬 HTTP 로 넘기고, 없으면 이 프로세스에서 직접 수행한다.
 *
 * 왜 위임하는가: 데몬은 스케줄러·콘솔을 들고 있으므로 도구 호출을 그쪽에서 처리하면
 * 웹 콘솔이 같은 사건을 실시간으로 볼 수 있고, 레지스트리 쓰기 주체가 하나로 모인다.
 *
 * 왜 폴백이 필수인가: MCP 서버는 Claude Code 세션 수명이라 **데몬 없이도 반드시 동작해야
 * 한다**. 위임 실패가 도구 실패가 되면 데몬을 안 띄운 사용자는 도구를 통째로 잃는다.
 *
 * 계약: 두 경로의 결과는 같아야 한다. 그래서 위임 응답도 인프로세스 핸들러와 **같은 모양**
 * (도구 반환값 그대로)이어야 하며, 다르면 폴백으로 내려간다 — 조용히 다른 값을 쓰지 않는다.
 */
import { loadJson } from "../core/load.ts";
import { userPaths } from "../core/paths.ts";
import { DELEGATABLE_TOOLS, HANDLERS, ToolError, type ToolArgs } from "./tools.ts";

/** 진단은 stderr 로만 — stdout 은 JSON-RPC 프레이밍 전용이다. */
function logStderr(message: string): void {
  process.stderr.write(`[autoharness-mcp] ${message}\n`);
}

/** 데몬이 남기는 접속 정보. 데몬 쪽(ts-web-api)이 이 모양을 지켜야 위임이 성립한다. */
export interface DaemonInfo {
  port: number;
  token: string;
  pid?: number;
  started_at?: string;
}

/** 위임 시도의 상한. 죽은 포트를 붙들고 매 호출을 늦추지 않는다. */
export const DELEGATE_TIMEOUT_MS = 1500;

function isDaemonInfo(v: unknown): v is DaemonInfo {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as DaemonInfo).port === "number" &&
    typeof (v as DaemonInfo).token === "string"
  );
}

export async function readDaemonInfo(env: NodeJS.ProcessEnv = process.env): Promise<DaemonInfo | null> {
  const r = await loadJson<DaemonInfo>(userPaths(env).daemonInfo, isDaemonInfo);
  return r.state === "ok" ? r.value : null;
}

export function delegateUrl(info: DaemonInfo): string {
  // 127.0.0.1 고정 — 데몬은 loopback 밖으로 나가지 않는다(daemon/DESIGN.md 6.3)
  return `http://127.0.0.1:${info.port}/api/mcp/call`;
}

export interface DelegateOutcome {
  ok: boolean;
  result?: unknown;
  reason?: string;
}

/** 데몬에 한 번 시도한다. 실패 이유는 삼키지 않고 돌려준다 — 폴백이 침묵하지 않도록. */
export async function tryDelegate(
  name: string,
  args: ToolArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DelegateOutcome> {
  const info = await readDaemonInfo(env);
  if (!info) return { ok: false, reason: "데몬 접속 정보 없음" };
  try {
    const res = await fetch(delegateUrl(info), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `데몬 응답 ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
    if (body && body.ok === false && typeof body.error === "string") {
      // 데몬이 도구 오류를 그대로 전달한 것 — 폴백해도 같은 오류가 난다
      throw new ToolError(body.error);
    }
    if (!body || !("result" in body)) return { ok: false, reason: "데몬 응답 형식 불일치" };
    return { ok: true, result: body.result };
  } catch (err) {
    if (err instanceof ToolError) throw err;
    return { ok: false, reason: `데몬 호출 실패: ${String(err)}` };
  }
}

/**
 * 도구 1건을 실행한다 — 위임 우선, 실패 시 인프로세스.
 * `AUTOHARNESS_NO_DELEGATE=1` 이면 위임을 건너뛴다(교차 검증에서 두 경로를 갈라 보기 위함).
 */
export async function callToolWithFallback(
  name: string,
  args: ToolArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`알 수 없는 도구입니다: ${name}`);

  // 위임 표면 밖의 도구는 아예 시도하지 않는다 — 왕복만 낭비하고 403 을 받는다.
  // 기능은 줄지 않는다: 여기서 곧장 인프로세스로 수행한다(그것이 폴백의 존재 이유다).
  if (env["AUTOHARNESS_NO_DELEGATE"] !== "1" && DELEGATABLE_TOOLS.has(name)) {
    const outcome = await tryDelegate(name, args, env);
    if (outcome.ok) return outcome.result;
    if (outcome.reason && outcome.reason !== "데몬 접속 정보 없음") {
      logStderr(`위임 실패 — 인프로세스로 처리합니다: ${outcome.reason}`);
    }
  }
  return handler(args);
}
