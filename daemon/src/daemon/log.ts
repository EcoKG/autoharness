/**
 * 콘솔 로깅 — 데몬의 모든 판단·행동이 **한 줄씩** 남는다.
 *
 * v1 의 실패에서 배운 것: 워치독이 몇 주간 한 번도 실행되지 않았는데 아무도 몰랐던 이유는
 * 로그 파일이 아예 없었기 때문이다. 그래서 v2 는 세 곳에 동시에 남긴다.
 *   ① stdout — 사람이 읽는 형식. 데몬을 포그라운드로 띄우면 바로 보인다.
 *   ② 파일 — JSON 라인. 나중에 필터·집계할 수 있어야 한다.
 *   ③ 구독자 — 웹 콘솔의 실시간 스트림 원천(ts-web-console 이 여기에 붙는다).
 *
 * **줄 단위로 즉시 내보낸다.** 버퍼에 모아 두면 실시간 스트림이 실시간이 아니게 되고,
 * 데몬이 죽는 순간 원인을 담은 마지막 줄들이 통째로 사라진다 — 진단이 필요한 바로 그때.
 */
import { mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { userPaths } from "../core/paths.ts";
import { nowIso } from "../core/schema.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB — v1 과 같은 상한
export const DEFAULT_RING_SIZE = 500;

export interface LogRecord {
  ts: string;
  level: LogLevel;
  /** 어느 프로젝트에 대한 판단인가. 데몬 전역이면 "-". */
  project: string;
  /** 행동 종류 — 웹에서 필터 키로 쓴다(tick, launch, skip, error, limit …). */
  action: string;
  detail: string;
}

export type LogSubscriber = (record: LogRecord) => void;

/** 사람이 읽는 한 줄 — v1 watchdog.log 와 같은 모양이라 눈이 옮겨 붙지 않는다. */
export function formatHuman(r: LogRecord): string {
  const level = r.level === "info" ? "" : `[${r.level}] `;
  return `${r.ts} | ${r.project} | ${r.action} | ${level}${r.detail}`;
}

export interface ConsoleLogOptions {
  path?: string;
  maxBytes?: number;
  /** stdout 으로도 낼 것인가. 테스트·MCP stdio 모드에서는 끈다. */
  toStdout?: boolean;
  ringSize?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * 파일 회전 — 상한을 넘으면 `.1` 로 밀고 새 파일을 연다.
 *
 * v1 은 뒤 절반만 남기고 잘랐는데, 그러면 잘린 순간의 경계가 깨진 JSON 이 되어 파싱이
 * 어긋난다. 백업 한 벌을 두는 편이 단순하고 복구도 쉽다.
 */
export class ConsoleLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly toStdout: boolean;
  private readonly ringSize: number;
  private handle: FileHandle | null = null;
  private size = 0;
  private ring: LogRecord[] = [];
  private subscribers = new Set<LogSubscriber>();
  /** 쓰기 직렬화 — 동시 호출이 줄을 섞지 않게 한다. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: ConsoleLogOptions = {}) {
    this.path = options.path ?? userPaths(options.env ?? process.env).daemonLog;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.toStdout = options.toStdout !== false;
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
  }

  get filePath(): string {
    return this.path;
  }

  get backupPath(): string {
    return `${this.path}.1`;
  }

  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => void this.subscribers.delete(fn);
  }

  /** 새로 붙은 구독자에게 보여 줄 최근 줄들 — 연결 순간 화면이 비어 있지 않게 한다. */
  recent(limit = 100): LogRecord[] {
    return this.ring.slice(-Math.max(0, limit));
  }

  log(level: LogLevel, project: string, action: string, detail: string): LogRecord {
    const record: LogRecord = { ts: nowIso(), level, project: project || "-", action, detail };

    // 구독자와 stdout 은 동기로 — 실시간 스트림이 파일 IO 를 기다리지 않는다
    if (this.toStdout) process.stdout.write(`${formatHuman(record)}\n`);
    this.ring.push(record);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const fn of this.subscribers) {
      try {
        fn(record);
      } catch {
        /* 느린·깨진 구독자가 데몬을 막지 않는다 */
      }
    }

    this.queue = this.queue.then(() => this.append(record)).catch(() => {});
    return record;
  }

  debug = (project: string, action: string, detail: string) => this.log("debug", project, action, detail);
  info = (project: string, action: string, detail: string) => this.log("info", project, action, detail);
  warn = (project: string, action: string, detail: string) => this.log("warn", project, action, detail);
  error = (project: string, action: string, detail: string) => this.log("error", project, action, detail);

  /** 큐가 비워질 때까지 기다린다 — 테스트와 종료 경로가 파일을 확실히 보게 한다. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.handle?.close().catch(() => {});
    this.handle = null;
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    await mkdir(dirname(this.path), { recursive: true });
    this.handle = await open(this.path, "a");
    this.size = await stat(this.path).then((s) => s.size).catch(() => 0);
    return this.handle;
  }

  private async append(record: LogRecord): Promise<void> {
    if (this.closed) return;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    let handle = await this.ensureOpen();
    if (this.size + bytes > this.maxBytes) {
      await this.rotate();
      handle = await this.ensureOpen();
    }
    await handle.write(line, null, "utf8"); // 버퍼링 없이 즉시 — 죽는 순간의 마지막 줄을 잃지 않는다
    this.size += bytes;
  }

  private async rotate(): Promise<void> {
    await this.handle?.close().catch(() => {});
    this.handle = null;
    await rm(this.backupPath, { force: true });
    await rename(this.path, this.backupPath).catch(() => {});
    this.size = 0;
  }
}
