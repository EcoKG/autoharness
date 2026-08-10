/**
 * 레지스트리 — 계정 단위 프로젝트 목록(daemon/DESIGN.md 4절 계약).
 *
 * **파손은 조용히 덮지 않는다.** v1 은 파손된 레지스트리를 기본값으로 대체한 뒤 저장해
 * 등록된 프로젝트를 전부 지웠고, 그러면서 성공을 보고했다. 여기서는 쓰기 경로가 파손을
 * 만나면 원본을 대피시키고 **멈춘다** — 데이터 손실보다 실패가 낫다.
 *
 * **통째 되쓰기도 하지 않는다.** 주기 시작에 읽은 사본을 끝에 통째로 저장하면 그 사이에
 * 다른 주체(MCP 도구)가 기록한 변경이 사라진다. `mutateRegistry` 는 저장 직전에 다시 읽어
 * 필요한 부분만 고친다.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { atomicWriteJson } from "./atomic.ts";
import { withFileLock, type FileLockOptions } from "./filelock.ts";
import { loadJson, type LoadState } from "./load.ts";
import { userPaths } from "./paths.ts";
import { isRegistry, nowIso, type Registry, type RegistryProject } from "./schema.ts";

export class RegistryError extends Error {}

export function defaultRegistry(): Registry {
  return {
    schema_version: 1,
    settings: {
      stale_minutes: 30,
      probe_sec: 90,
      max_consecutive_errors: 5,
      limit_backoff_minutes: [30, 60, 120, 240, 360],
      error_backoff_minutes: [15, 30, 60],
    },
    projects: [],
  };
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return userPaths(env).registry;
}

export interface RegistryLoad {
  state: LoadState;
  registry: Registry;
  error: string | null;
}

/** 읽기 경로 — 부재는 기본값으로, 파손은 상태로 알린다(진단이 구분해 보고해야 한다). */
export async function loadRegistryChecked(env: NodeJS.ProcessEnv = process.env): Promise<RegistryLoad> {
  const r = await loadJson<Registry>(registryPath(env), isRegistry);
  if (r.state === "missing") return { state: "missing", registry: defaultRegistry(), error: null };
  if (r.state === "corrupt" || !r.value) {
    return { state: "corrupt", registry: defaultRegistry(), error: r.error };
  }
  const base = defaultRegistry();
  const reg = r.value;
  reg.schema_version ??= 1;
  if (typeof reg.settings !== "object" || reg.settings === null) reg.settings = base.settings;
  if (!Array.isArray(reg.projects)) reg.projects = [];
  return { state: "ok", registry: reg, error: null };
}

async function backupCorrupt(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = registryPath(env);
  const backup = `${path}.corrupt-${nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  try {
    await copyFile(path, backup);
    return backup;
  } catch {
    return null;
  }
}

/** 쓰기 경로 — 파손이면 대피시킨 뒤 던진다. 등록 프로젝트 전멸을 막는 것이 우선이다. */
export async function loadRegistryForWrite(env: NodeJS.ProcessEnv = process.env): Promise<Registry> {
  const r = await loadRegistryChecked(env);
  if (r.state === "corrupt") {
    const backup = await backupCorrupt(env);
    throw new RegistryError(
      `레지스트리가 파손됐습니다: ${registryPath(env)} — 덮어쓰지 않고 중단합니다(등록된 ` +
        `프로젝트가 지워지는 것을 막기 위함). 원본 사본: ${backup ?? "(대피 실패)"}. ` +
        "내용을 고치거나 파일을 지운 뒤 다시 시도하십시오.",
    );
  }
  return r.registry;
}

export async function saveRegistry(reg: Registry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = registryPath(env);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, reg);
}

/**
 * 읽기→수정→쓰기를 하나로 묶는다.
 *
 * **프로세스 간 잠금 안에서 수행한다.** 저장 직전 재읽기만으로는 A읽기 → B읽기 → B쓰기 →
 * A쓰기 순서를 막지 못한다 — 창이 좁아질 뿐이다. 쓰기 주체가 상주 데몬과 세션마다 뜨는
 * MCP 서버로 **별개 프로세스**이므로, 같은 프로세스 안의 직렬화로는 부족하다.
 * 잠금을 못 얻으면 쓰기를 건너뛰지 않고 던진다 — 조용한 갱신 소실보다 시끄러운 실패가 낫다.
 */
export async function mutateRegistry<T>(
  mutate: (reg: Registry) => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  /** 대기 상한 — 지연 예산이 빡빡한 호출자(훅)는 낮춰 잡을 수 있다. */
  lockOptions?: FileLockOptions,
): Promise<T> {
  return withFileLock(
    userPaths(env).registryLock,
    async () => {
      const reg = await loadRegistryForWrite(env);
      const result = await mutate(reg);
      await saveRegistry(reg, env);
      return result;
    },
    lockOptions,
  );
}

/** 경로 비교는 정규화 후에 한다 — 대소문자·상대 경로 차이로 같은 저장소를 놓치지 않는다. */
export function sameRepo(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function findProject(reg: Registry, repo: string): RegistryProject | undefined {
  return reg.projects.find((p) => sameRepo(p.repo ?? "", repo));
}

export interface UpsertInput {
  id: string;
  repo: string;
  model: string;
  permissionArgs: string[];
}

/** init 용 upsert — 재초기화하면 카운터·백오프를 리셋하고 active 로 되돌린다. */
export function upsertProject(reg: Registry, input: UpsertInput): RegistryProject {
  const repoAbs = resolve(input.repo);
  const existing = findProject(reg, repoAbs);
  const now = nowIso();
  if (!existing) {
    const entry: RegistryProject = {
      id: input.id,
      repo: repoAbs,
      model: input.model,
      permission_args: input.permissionArgs,
      status: "active",
      consecutive_errors: 0,
      limit_hits: 0,
      next_retry_at: null,
      last_launch: { ts: null, result: null, log: null },
      created_at: now,
      updated_at: now,
    };
    reg.projects.push(entry);
    return entry;
  }
  existing.id = input.id;
  existing.repo = repoAbs;
  existing.model = input.model;
  existing.permission_args = input.permissionArgs;
  existing.status = "active";
  existing.consecutive_errors = 0;
  existing.limit_hits = 0;
  existing.next_retry_at = null;
  existing.updated_at = now;
  existing.last_launch ??= { ts: null, result: null, log: null };
  existing.created_at ??= now;
  return existing;
}

/**
 * 작업이 새로 생긴 프로젝트를 되살린다.
 *
 * `completed` 는 종점이 아니다 — 장부에 할 일이 생기면 다시 돌아야 한다. 반대로
 * `paused`(사용자 의사)·`needs_human`·`error`(진단 필요)는 건드리지 않는다: 그것들은
 * 사람이 명시적으로 풀어야 하는 상태다.
 */
export function reactivateIfCompleted(reg: Registry, repo: string): boolean {
  const entry = findProject(reg, repo);
  if (!entry || entry.status !== "completed") return false;
  entry.status = "active";
  entry.consecutive_errors = 0;
  entry.limit_hits = 0;
  entry.next_retry_at = null;
  entry.updated_at = nowIso();
  return true;
}
