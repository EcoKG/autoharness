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

import { atomicWriteJson } from "../core/atomic.ts";
import { loadTracker, statusCounts, eligibleNext, deadlockedPending, saveTracker, findTask, setTaskStatus, renderSafe } from "../core/ledger.ts";
import { userPaths } from "../core/paths.ts";
import { findProject, loadRegistryChecked, mutateRegistry } from "../core/registry.ts";
import { isTaskStatus, nowIso } from "../core/schema.ts";
import type { ConsoleLog } from "../daemon/log.ts";
import { HANDLERS, ToolError, type ToolArgs } from "../mcp/tools.ts";
import { bearerToken, ensureToken, tokenMatches } from "./token.ts";

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

export async function createWebServer(ctx: WebContext, port = 0): Promise<WebServerHandle> {
  const env = ctx.env ?? process.env;
  const token = await ensureToken(env);
  const paths = userPaths(env);

  const server = Bun.serve({
    port,
    hostname: BIND_HOST, // 외부 인터페이스 바인드 옵션은 만들지 않는다
    async fetch(req) {
      const url = new URL(req.url);
      if (!hostAllowed(req.headers.get("host"))) {
        return json({ error: "허용되지 않은 Host 입니다." }, 403);
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
      server.stop(true);
      await rm(paths.daemonInfo, { force: true });
    },
  };
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
    return json({ id, repo: proj.repo, counts: statusCounts(tracker), tasks: tracker.tasks });
  }

  if (path === "/api/logs") {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
    return json({ lines: ctx.log.recent(limit) });
  }

  const asset = ctx.staticAssets?.[path === "/" ? "/index.html" : path];
  if (asset) {
    return new Response(asset.body, {
      headers: { "content-type": asset.type, "cache-control": "no-store" },
    });
  }
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
    ctx.log.info(projectId, "task_state", `${taskId} → ${status} (웹 요청)`);
    return json({ ok: true, id: taskId, status: task.status });
  }

  if (path === "/api/mcp/call") {
    // MCP 서버가 위임해 오는 경로. 도구 이름은 화이트리스트(HANDLERS)로만 해석된다.
    const body = await readJsonBody(req);
    const name = String(body["name"] ?? "");
    const handler = HANDLERS[name];
    if (!handler) return json({ ok: false, error: `알 수 없는 도구입니다: ${name}` }, 404);
    const args = (body["arguments"] && typeof body["arguments"] === "object"
      ? body["arguments"]
      : {}) as ToolArgs;
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
