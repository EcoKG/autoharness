/**
 * 장부·레지스트리 스키마 — daemon/DESIGN.md 4절의 "바뀌지 않는 계약".
 *
 * 이 모양은 대상 저장소·v1 Python 구현과 공유하는 **외부 계약**이다. 필드를 빼거나
 * 이름을 바꾸면 v1 로 만든 장부를 v2 가 못 읽고, 교차 검증도 성립하지 않는다.
 */
import { isRecord } from "./load.ts";

export const TASK_STATUSES = ["pending", "in_progress", "done", "failed", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  path: string | null;
  deps: string[];
  priority: number;
  status: TaskStatus;
  attempts: number;
  last_error: string | null;
  last_log_file: string | null;
  commit: string | null;
  started_at: string | null;
  finished_at: string | null;
  test_cmd: string | null;
}

export interface Commands {
  build: string | null;
  test: string;
  lint: string | null;
  timeout_sec: number;
}

export interface Tracker {
  schema_version: number;
  project: string;
  objective: string;
  source_stack: string;
  target_stack: string;
  model: string;
  commands: Commands;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  tasks: Task[];
}

export const PROJECT_STATUSES = [
  "active",
  "paused",
  "completed",
  "needs_human",
  "error",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface LastLaunch {
  ts: string | null;
  result: string | null;
  log: string | null;
}

export interface RegistryProject {
  id: string;
  repo: string;
  model: string;
  permission_args: string[];
  status: ProjectStatus;
  consecutive_errors: number;
  limit_hits: number;
  next_retry_at: string | null;
  last_launch: LastLaunch;
  created_at: string;
  updated_at: string;
  needs_attention?: string;
}

export interface RegistrySettings {
  stale_minutes: number;
  probe_sec: number;
  max_consecutive_errors: number;
  limit_backoff_minutes: number[];
  error_backoff_minutes: number[];
  watchdog_installed_at?: string;
  watchdog_interval_minutes?: number;
}

export interface Registry {
  schema_version: number;
  settings: RegistrySettings;
  last_tick?: string | null;
  projects: RegistryProject[];
}

/**
 * 장부인가 — **최소 조건만 본다.**
 *
 * 엄격하게 굴면 v1 이 만든 정상 장부를 파손으로 오판한다(필드가 늘어날 수 있다).
 * 반대로 너무 느슨하면 파손을 정상으로 본다. 기준은 "이후 코드가 안전하게 다룰 수
 * 있는가" — tasks 가 배열이면 나머지는 기본값으로 메울 수 있다.
 */
export function isTracker(value: unknown): value is Tracker {
  return isRecord(value) && Array.isArray(value["tasks"]);
}

export function isRegistry(value: unknown): value is Registry {
  return isRecord(value) && Array.isArray(value["projects"]);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

/** ISO8601 UTC — v1 과 같은 형식이어야 장부를 오갈 때 정렬·비교가 어긋나지 않는다. */
export function nowIso(): string {
  return new Date().toISOString();
}
