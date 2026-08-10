/**
 * JSON-RPC 2.0 stdio 서버 — 개행으로 구분된 한 줄 = 한 메시지.
 *
 * 이 루프의 유일한 책임은 **죽지 않는 것**이다. 잘못된 줄, 객체가 아닌 메시지, 도구 내부
 * 예외 — 어느 것도 서버를 내리면 안 된다. 클라이언트(Claude Code)는 서버가 죽으면 도구를
 * 통째로 잃으므로, 실패는 응답으로 표현하고 진단은 stderr 로만 흘린다(stdout 은 프로토콜
 * 전용이다 — 여기에 로그를 섞으면 프레이밍이 깨진다).
 */
import { callToolWithFallback } from "./delegate.ts";
import { HANDLERS, ToolError, type ToolArgs } from "./tools.ts";
import { TOOLS } from "./schemas.ts";
import { VERSION } from "../version.ts";

export const SERVER_NAME = "autoharness";
/** MCP 가 보고하는 버전 — 실행 파일 버전과 갈라지면 안 되므로 같은 출처를 쓴다. */
export const SERVER_VERSION = VERSION;
export const PROTOCOL_DEFAULT = "2024-11-05";

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export type RpcResponse = Record<string, unknown>;

export function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textContent(text: string): RpcResponse {
  return { content: [{ type: "text", text }] };
}

export function errorContent(message: string): RpcResponse {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function logStderr(message: string): void {
  process.stderr.write(`[autoharness-mcp] ${message}\n`);
}

/**
 * 도구 디스패치 — 어떤 예외도 서버를 죽이지 않고 isError 응답으로 바뀐다.
 * 실행은 데몬 위임을 먼저 시도하고 실패하면 인프로세스로 내려간다(두 경로의 결과는 같다).
 */
export async function callTool(id: unknown, name: unknown, args: unknown): Promise<RpcResponse> {
  if (typeof name !== "string" || !HANDLERS[name]) {
    return rpcResult(id, errorContent(`알 수 없는 도구입니다: ${JSON.stringify(name)}`));
  }
  try {
    const result = await callToolWithFallback(
      name,
      (args && typeof args === "object" ? args : {}) as ToolArgs,
    );
    return rpcResult(id, textContent(JSON.stringify(result, null, 2)));
  } catch (err) {
    if (err instanceof ToolError) return rpcResult(id, errorContent(err.message));
    logStderr(`도구 실행 중 예외: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return rpcResult(
      id,
      errorContent(`도구 실행 중 예외: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`),
    );
  }
}

/**
 * 메시지 1건 처리. 응답이 없으면 `null` 을 돌려준다.
 * notification(id 없음)에 응답하면 클라이언트가 프로토콜 위반으로 본다.
 */
export async function handleMessage(msg: unknown): Promise<RpcResponse | null> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    logStderr(`객체가 아닌 메시지 무시: ${typeof msg}`);
    return null;
  }
  const m = msg as RpcMessage;
  if (m.method === undefined) return null; // 클라이언트 측 응답 등 — 무시
  if (!("id" in m) || m.id === null || m.id === undefined) return null; // notification

  const id = m.id;
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;

  switch (m.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : PROTOCOL_DEFAULT,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, params["name"], params["arguments"] ?? {});
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}

/** 한 줄을 파싱해 처리한다. 파싱 실패는 그 줄만 버린다 — 스트림을 끊지 않는다. */
export async function handleLine(line: string): Promise<RpcResponse | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    logStderr(`JSON 파싱 실패 — 해당 줄 무시: ${String(err)}`);
    return null;
  }
  try {
    return await handleMessage(msg);
  } catch (err) {
    logStderr(`메시지 처리 중 내부 예외: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const id = (msg as RpcMessage | null)?.id;
    return id === null || id === undefined ? null : rpcError(id, INTERNAL_ERROR, "internal error");
  }
}

function send(resp: RpcResponse): void {
  try {
    process.stdout.write(`${JSON.stringify(resp)}\n`);
  } catch {
    // 클라이언트가 파이프를 끊었다 — 조용히 내려간다
    process.exit(0);
  }
}

/** stdin 을 줄 단위로 읽어 처리한다. stdin 이 닫히면 서버를 내린다. */
export async function serve(): Promise<number> {
  const { assertToolsConsistent } = await import("./schemas.ts");
  assertToolsConsistent();
  logStderr(`서버 시작 (pid=${process.pid}, exe=${process.execPath})`);

  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const resp = await handleLine(line);
      if (resp) send(resp);
    }
  }
  // 개행 없이 끝난 마지막 줄도 처리한다 — 클라이언트가 flush 없이 닫는 경우가 있다
  const last = await handleLine(buffer);
  if (last) send(last);
  logStderr("stdin 종료 — 서버를 내립니다");
  return 0;
}
