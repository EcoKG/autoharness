/**
 * 로컬 웹 API — **보안이 기능의 일부다**(daemon/DESIGN.md 6.3).
 *
 * 이 서버는 프로젝트를 멈추고 세션을 기동할 수 있다. 명령을 받을 수 있다는 것은 곧 로컬
 * 공격 표면이라는 뜻이므로 다음은 타협하지 않는다:
 *   ① **127.0.0.1 에만 바인드한다.** 외부 인터페이스 옵션을 만들지 않는다.
 *   ② **토큰 필수.** 없거나 틀리면 401. 쿠키 인증을 쓰지 않는다 — 쿠키는 브라우저가
 *      자동으로 실어 보내므로 CSRF 의 재료가 된다. 헤더는 자동으로 붙지 않는다.
 *   ③ **상태 변경은 POST 만.** GET 으로 부작용을 내면 `<img src>` 한 줄로 트리거된다.
 *   ④ **화이트리스트된 동작만.** 임의 셸 실행을 노출하지 않는다 — DESIGN 8절의 사람 경계다.
 *   ⑤ **Host 검사.** DNS 리바인딩으로 외부 도메인이 127.0.0.1 을 가리키게 만들어도,
 *      Host 가 우리 것이 아니면 거부한다.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "../core/atomic.ts";
import { loadTracker, statusCounts, eligibleNext, deadlockedPending, saveTracker, findTask, setTaskStatus, renderSafe } from "../core/ledger.ts";
import { userPaths } from "../core/paths.ts";
import { findProject, loadRegistryChecked, mutateRegistry } from "../core/registry.ts";
import { isTaskStatus, nowIso } from "../core/schema.ts";
import type { ConsoleLog } from "../daemon/log.ts";
import {
  BACKLOG_LINES,
  ConsoleClient,
  ConsoleHub,
  READ_ONLY_NOTICE,
  backlogMessages,
} from "./console.ts";
import {
  DELEGATABLE_TOOLS,
  FORBIDDEN_DELEGATED_ARGS,
  HANDLERS,
  ToolError,
  type ToolArgs,
} from "../mcp/tools.ts";
import { bearerToken, ensureToken, tokenMatches } from "./token.ts";
import { STATIC_ASSETS } from "./ui.ts";

/** 오직 loopback. 이 상수를 설정으로 빼지 않는 것이 설계다. */
export const BIND_HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface WebContext {
  log: ConsoleLog;
  env?: NodeJS.ProcessEnv;
  /** 즉시 tick 요청 — 데몬이 넘겨준다. 없으면 해당 동작은 501. */
  requestTick?: (projectId?: string) => Promise<unknown>;
  /** 즉시 기동 요청 — 데몬이 넘겨준다. */
  requestLaunch?: (projectId: string) => Promise<unknown>;
  staticAssets?: Record<string, { body: string; type: string }>;
}

export interface WebServerHandle {
  port: number;
  token: string;
  stop: () => Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 브라우저의 다른 출처가 응답을 읽지 못하게 한다. CORS 헤더를 **주지 않는 것**이 방어다.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const unauthorized = (): Response =>
  json({ error: "인증이 필요합니다. Authorization: Bearer <token> 헤더를 보내십시오." }, 401);

const SEP = String.fromCharCode(92); // 역슬래시 — 소스에 직접 쓰면 이스케이프가 꼬인다
const SUFFIX = ".log";
const STAMP_RE = /^\d{8}T\d{6}Z$/;

/**
 * 세션 로그 이름 검증 — 데몬이 만드는 형식(`<프로젝트>-<UTC타임스탬프>.log`)만 허용한다.
 * 경로 조각(`..`·구분자)이 끼어들 여지를 문법 수준에서 없앤다.
 */
export function isSessionLogName(name: string, projectId: string): boolean {
  // 사용자 입력으로 정규식을 조립하지 않는다 — 접두사·접미사를 잘라내고 남은 조각만 본다.
  if (name.includes("/") || name.includes(SEP) || name.includes("..")) return false;
  const prefix = `${projectId}-`;
  if (!name.startsWith(prefix) || !name.endsWith(SUFFIX)) return false;
  const stamp = name.slice(prefix.length, name.length - SUFFIX.length);
  return STAMP_RE.test(stamp);
}

/** 요청이 우리 것을 향하고 있는가 — DNS 리바인딩 차단. */
export function hostAllowed(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").trim().toLowerCase();
  return ALLOWED_HOSTS.has(host);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function projectSummary(env: NodeJS.ProcessEnv) {
  const reg = await loadRegistryChecked(env);
  const projects = [];
  for (const p of reg.registry.projects) {
    const { state, tracker } = await loadTracker(p.repo);
    projects.push({
      id: p.id,
      repo: p.repo,
      status: p.status,
      model: p.model,
      consecutive_errors: p.consecutive_errors,
      limit_hits: p.limit_hits,
      next_retry_at: p.next_retry_at,
      last_launch: p.last_launch,
      needs_attention: p.needs_attention ?? null,
      ledger_state: state,
      counts: tracker ? statusCounts(tracker) : null,
      next_task: tracker ? (eligibleNext(tracker)?.id ?? null) : null,
      deadlocked: tracker ? deadlockedPending(tracker).map((t) => t.id) : [],
    });
  }
  return { registry_state: reg.state, last_tick: reg.registry.last_tick ?? null, projects };
}

/**
 * WebSocket 은 브라우저에서 임의 헤더를 붙일 수 없다. 그래서 토큰을 두 경로로 받는다:
 *   ① `Sec-WebSocket-Protocol: autoharness.bearer.<token>` — 권장. URL 에 남지 않는다.
 *   ② `?token=` 질의 문자열 — 폴백(로그·히스토리에 남을 수 있어 차선이다).
 */
export function websocketToken(req: Request, url: URL): string | null {
  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) {
    for (const part of proto.split(",")) {
      const m = /^autoharness\.bearer\.(.+)$/.exec(part.trim());
      if (m) return m[1]!;
    }
  }
  return url.searchParams.get("token");
}

export const WS_SUBPROTOCOL_PREFIX = "autoharness.bearer.";
export const CONSOLE_PATH = "/ws/console";

export async function createWebServer(ctx: WebContext, port = 0): Promise<WebServerHandle> {
  const env = ctx.env ?? process.env;
  const token = await ensureToken(env);
  const paths = userPaths(env);
  const hub = new ConsoleHub();
  const unsubscribe = ctx.log.subscribe((record) => hub.broadcast(record));

  const server = Bun.serve<{ client: ConsoleClient | null }, never>({
    port,
    hostname: BIND_HOST, // 외부 인터페이스 바인드 옵션은 만들지 않는다
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!hostAllowed(req.headers.get("host"))) {
        return json({ error: "허용되지 않은 Host 입니다." }, 403);
      }

      if (url.pathname === CONSOLE_PATH) {
        // WS 도 토큰을 거친다 — 인증 없는 스트림은 로그 유출 경로다
        if (!tokenMatches(token, websocketToken(req, url))) return unauthorized();
        const upgraded = srv.upgrade(req, { data: { client: null } });
        return upgraded ? undefined : json({ error: "업그레이드 실패" }, 400);
      }

      // UI 문서 자체는 토큰 이전에 준다 — 토큰을 입력할 화면이 토큰을 요구하면 들어갈 수가 없다.
      // 이 페이지는 정적 자원일 뿐이고, 데이터는 전부 인증된 API 로만 나간다.
      const assets = ctx.staticAssets ?? STATIC_ASSETS;
      if (req.method === "GET") {
        const asset = assets[url.pathname === "/" ? "/index.html" : url.pathname];
        if (asset) return assetResponse(asset);
      }

      if (!tokenMatches(token, bearerToken(req.headers))) return unauthorized();

      const path = url.pathname;
      const method = req.method.toUpperCase();

      try {
        if (method === "GET") return await handleGet(path, url, ctx, env);
        if (method === "POST") return await handlePost(path, req, ctx, env);
        // 상태 변경 경로를 GET·PUT 등으로 열지 않는다
        return json({ error: `허용되지 않은 메서드입니다: ${method}` }, 405);
      } catch (err) {
        if (err instanceof ToolError) return json({ ok: false, error: err.message }, 400);
        ctx.log.error("-", "web", `요청 처리 중 예외 ${method} ${path}: ${String(err)}`);
        return json({ error: "서버 내부 오류" }, 500);
      }
    },
    websocket: {
      open(ws) {
        const client = new ConsoleClient(ws);
        ws.data.client = client;
        hub.add(client);
        for (const message of backlogMessages(ctx.log.recent(BACKLOG_LINES))) ws.send(message);
        ctx.log.debug("-", "web", `콘솔 구독 연결 (총 ${hub.size}개)`);
      },
      message(ws) {
        // 구독은 읽기 전용이다 — 소켓으로는 아무것도 실행되지 않는다
        ws.send(READ_ONLY_NOTICE);
      },
      close(ws) {
        const client = ws.data.client;
        if (client) {
          client.notifyDropsIfAny();
          hub.remove(client);
        }
        ctx.log.debug("-", "web", `콘솔 구독 해제 (남은 ${hub.size}개)`);
      },
    },
  });

  // 떠 있는 데몬의 접속 정보 — MCP 위임이 이 파일로 데몬을 발견한다
  await mkdir(paths.runtimeDir, { recursive: true });
  await atomicWriteJson(paths.daemonInfo, {
    port: server.port,
    token,
    pid: process.pid,
    started_at: nowIso(),
  });

  ctx.log.info("-", "web", `웹 API 시작 http://${BIND_HOST}:${server.port} (토큰 필수)`);

  return {
    port: server.port!,
    token,
    stop: async () => {
      unsubscribe();
      hub.closeAll();
      server.stop(true);
      await rm(paths.daemonInfo, { force: true });
    },
  };
}

/**
 * 정적 자산 응답 — **헤더를 한 곳에서만 만든다.**
 *
 * 종전에는 자산을 돌려주는 자리가 둘이었고, 뒤쪽(handleGet 말미)에는 nosniff 도 CSP 도
 * 없었다. 지금은 앞쪽 분기에 가려 도달하지 않지만, 경로가 하나 늘거나 순서가 바뀌면
 * 그대로 살아나는 지뢰다. 보안 헤더가 "어느 경로로 나갔느냐" 에 달려 있으면 안 된다.
 */
export function assetResponse(asset: { body: string; type: string }): Response {
  return new Response(asset.body, {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // 외부 자원을 전혀 불러오지 않는 페이지다 — CSP 로 그 사실을 못 박는다
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        + "connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; "
        + "base-uri 'none'; object-src 'none'",
    },
  });
}

async function handleGet(
  path: string,
  url: URL,
  ctx: WebContext,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  if (path === "/api/status") {
    const summary = await projectSummary(env);
    return json({
      ok: true,
      pid: process.pid,
      uptime_sec: Math.round(process.uptime()),
      ...summary,
    });
  }
  if (path === "/api/projects") return json(await projectSummary(env));

  const tasks = /^\/api\/projects\/([^/]+)\/tasks$/.exec(path);
  if (tasks) {
    const id = decodeURIComponent(tasks[1]!);
    const reg = await loadRegistryChecked(env);
    const proj = reg.registry.projects.find((p) => p.id === id);
    if (!proj) return json({ error: `프로젝트 없음: ${id}` }, 404);
    const { state, tracker, error } = await loadTracker(proj.repo);
    if (!tracker) return json({ error: `장부를 읽을 수 없습니다(${state}): ${error ?? ""}` }, 409);
    // max_attempts 는 작업이 아니라 장부의 값이다 — 함께 주지 않으면 화면이 "4/?" 밖에 못 쓴다
    return json({
      id,
      repo: proj.repo,
      counts: statusCounts(tracker),
      max_attempts: tracker.max_attempts,
      tasks: tracker.tasks,
    });
  }

  const sessions = /^\/api\/projects\/([^/]+)\/sessions$/.exec(path);
  if (sessions) {
    const id = decodeURIComponent(sessions[1]!);
    const { readdir, stat } = await import("node:fs/promises");
    const dir = userPaths(env).logs;
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => n.startsWith(`${id}-`) && n.endsWith(".log"));
    } catch {
      names = [];
    }
    const items = [];
    for (const name of names.sort().reverse().slice(0, 50)) {
      const info = await stat(join(dir, name)).catch(() => null);
      items.push({ name, size: info?.size ?? 0, mtime: info?.mtime?.toISOString() ?? null });
    }
    return json({ id, sessions: items });
  }

  const sessionBody = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/.exec(path);
  if (sessionBody) {
    const id = decodeURIComponent(sessionBody[1]!);
    const name = decodeURIComponent(sessionBody[2]!);
    // **경로 순회 차단** — 이름은 우리가 만든 형식만 허용한다. 사용자가 준 문자열로
    // 파일 경로를 조립하는 자리이므로 화이트리스트가 아니면 안 된다.
    if (!isSessionLogName(name, id)) return json({ error: "허용되지 않은 로그 이름입니다." }, 400);
    const file = Bun.file(join(userPaths(env).logs, name));
    if (!(await file.exists())) return json({ error: `없는 로그입니다: ${name}` }, 404);
    const text = await file.text();
    const tail = Math.min(200_000, Math.max(1000, Number(url.searchParams.get("bytes") ?? 100_000)));
    return json({ id, name, truncated: text.length > tail, body: text.slice(-tail) });
  }

  if (path === "/api/logs") {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
    return json({ lines: ctx.log.recent(limit) });
  }

  const asset = ctx.staticAssets?.[path === "/" ? "/index.html" : path];
  if (asset) return assetResponse(asset);
  return json({ error: `없는 경로입니다: ${path}` }, 404);
}

/** 화이트리스트된 동작만. 이 목록 밖의 것은 존재하지 않는다 — 임의 실행 경로를 두지 않는다. */
const PROJECT_ACTIONS = new Set(["pause", "resume", "tick", "launch"]);

async function handlePost(
  path: string,
  req: Request,
  ctx: WebContext,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  const projectAction = /^\/api\/projects\/([^/]+)\/([^/]+)$/.exec(path);
  if (projectAction) {
    const id = decodeURIComponent(projectAction[1]!);
    const action = projectAction[2]!;
    if (!PROJECT_ACTIONS.has(action)) return json({ error: `허용되지 않은 동작: ${action}` }, 404);

    const reg = await loadRegistryChecked(env);
    const proj = reg.registry.projects.find((p) => p.id === id);
    if (!proj) return json({ error: `프로젝트 없음: ${id}` }, 404);

    if (action === "pause" || action === "resume") {
      const tool = action === "pause" ? "harness_pause" : "harness_resume_project";
      const result = await HANDLERS[tool]!({ repo_path: proj.repo });
      ctx.log.info(id, action, `웹 요청으로 ${action}`);
      return json({ ok: true, result });
    }
    if (action === "tick") {
      if (!ctx.requestTick) return json({ error: "이 데몬은 즉시 tick 을 제공하지 않습니다." }, 501);
      ctx.log.info(id, "tick", "웹 요청으로 즉시 tick");
      return json({ ok: true, result: await ctx.requestTick(id) });
    }
    if (!ctx.requestLaunch) return json({ error: "이 데몬은 즉시 기동을 제공하지 않습니다." }, 501);
    ctx.log.info(id, "launch", "웹 요청으로 즉시 기동");
    return json({ ok: true, result: await ctx.requestLaunch(id) });
  }

  const taskState = /^\/api\/tasks\/([^/]+)\/state$/.exec(path);
  if (taskState) {
    const taskId = decodeURIComponent(taskState[1]!);
    const body = await readJsonBody(req);
    const projectId = String(body["project"] ?? "");
    const status = String(body["status"] ?? "");
    const reg = await loadRegistryChecked(env);
    const proj = reg.registry.projects.find((p) => p.id === projectId);
    if (!proj) return json({ error: `프로젝트 없음: ${projectId}` }, 404);
    if (!isTaskStatus(status)) return json({ error: `알 수 없는 상태: ${status}` }, 400);

    const { tracker } = await loadTracker(proj.repo);
    if (!tracker) return json({ error: "장부를 읽을 수 없습니다" }, 409);
    const task = findTask(tracker, taskId);
    if (!task) return json({ error: `작업 없음: ${taskId}` }, 404);
    // done 은 여기서 만들 수 없다 — run 성공으로만 생긴다(장부 규칙을 웹이 우회하지 않는다)
    const r = setTaskStatus(task, status);
    if (!r.ok) return json({ error: r.reason }, 400);
    const attemptsCleared = r.attemptsCleared ?? 0;
    if (typeof body["note"] === "string") task.last_error = body["note"];
    await saveTracker(proj.repo, tracker);
    await renderSafe(proj.repo, tracker);
    // 할 일이 생겼으면 완료로 봉인된 프로젝트를 되살린다
    if (eligibleNext(tracker)) {
      await mutateRegistry((fresh) => {
        const target = findProject(fresh, proj.repo);
        if (target && target.status === "completed") {
          target.status = "active";
          target.updated_at = nowIso();
        }
      }, env).catch(() => {});
    }
    ctx.log.info(
      projectId,
      "task_state",
      attemptsCleared
        ? `${taskId} → ${status} (웹 요청, 시도 ${attemptsCleared} → 0)`
        : `${taskId} → ${status} (웹 요청)`,
    );
    return json({ ok: true, id: taskId, status: task.status, attemptsCleared });
  }

  if (path === "/api/mcp/call") {
    // MCP 서버가 위임해 오는 경로. 도구 이름은 화이트리스트(HANDLERS)로만 해석된다.
    const body = await readJsonBody(req);
    const name = String(body["name"] ?? "");
    const handler = HANDLERS[name];
    if (!handler) return json({ ok: false, error: `알 수 없는 도구입니다: ${name}` }, 404);
    // **위임은 권한 확장이 아니다.** 토큰만 있으면 부를 수 있는 경로이므로 도구를 좁힌다.
    // 여기서 막혀도 MCP 클라이언트는 인프로세스 폴백으로 동작하므로 기능은 줄지 않는다.
    if (!DELEGATABLE_TOOLS.has(name)) {
      ctx.log.warn("-", "mcp", `위임 거부(허용 목록 밖): ${name}`);
      return json(
        {
          ok: false,
          error:
            `이 도구는 원격 위임으로 노출하지 않습니다: ${name}. ` +
            "임의 셸 실행·설치 변경 경로를 HTTP 표면에서 제외한 결과이며, MCP 로는 그대로 쓸 수 있습니다.",
        },
        403,
      );
    }
    const args = (body["arguments"] && typeof body["arguments"] === "object"
      ? body["arguments"]
      : {}) as ToolArgs;
    // 두 번째 방어선 — 허용 도구라도 셸로 직행하는 인자는 받지 않는다
    const forbidden = FORBIDDEN_DELEGATED_ARGS.filter((k) => k in args);
    if (forbidden.length > 0) {
      ctx.log.warn("-", "mcp", `위임 거부(금지 인자 ${forbidden.join(", ")}): ${name}`);
      return json({ ok: false, error: `위임 경로에서 허용되지 않는 인자입니다: ${forbidden.join(", ")}` }, 403);
    }
    try {
      const result = await handler(args);
      ctx.log.debug("-", "mcp", `위임 처리: ${name}`);
      return json({ ok: true, result });
    } catch (err) {
      if (err instanceof ToolError) return json({ ok: false, error: err.message }, 200);
      throw err;
    }
  }

  return json({ error: `없는 경로입니다: ${path}` }, 404);
}

/** 토큰 파일 경로를 알려 준다 — UI 가 사용자에게 안내할 때 쓴다. */
export async function writeTokenHint(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = userPaths(env).webToken;
  await ensureToken(env);
  await writeFile(`${path}.README`, "이 폴더의 web-token 파일 내용을 웹 UI 에 붙여넣으십시오.\n", "utf8").catch(
    () => {},
  );
  return path;
}
