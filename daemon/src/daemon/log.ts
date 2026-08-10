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

/**
 * 세션 출력 줄의 action 값.
 *
 * 이 값 하나로 "주행 중인 세션이 뱉은 줄" 과 "데몬이 내린 판단" 을 가른다. 기록하는 쪽
 * (daemon.ts 의 onLine)과 담는 쪽이 같은 상수를 봐야 갈라지지 않는다.
 */
export const SESSION_ACTION = "session";

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

/** 링에 담는 항목 — 순번은 합칠 때만 쓰고 바깥으로 나가지 않는다. */
interface RingEntry {
  seq: number;
  record: LogRecord;
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
  /**
   * 링을 둘로 나눈다 — **세션 출력이 데몬의 판단을 밀어내지 않게.**
   *
   * 세션 한 줄마다 로그가 한 줄 쌓인다. 하나의 링을 같이 쓰면 세션이 도는 몇 초 만에
   * tick·launch·limit·needs_human 같은 판단 줄이 전부 밀려난다. 그래서 아침에 "밤새 무슨
   * 일이 있었나" 를 물으면 세션 잡담만 남아 있었다 — /api/logs 도 WS 백로그도 마찬가지다.
   *
   * 판단 줄은 드물게 쌓이므로 같은 크기의 링으로도 훨씬 긴 시간을 덮는다.
   */
  private sessionRing: RingEntry[] = [];
  private judgmentRing: RingEntry[] = [];
  /**
   * 합칠 때 쓸 순번.
   *
   * 시각(ts)으로 합치면 같은 밀리초에 들어온 줄들의 순서가 뒤집힌다 — 세션 줄은 몰려
   * 들어오므로 흔한 경우다. 기록된 순서를 그대로 복원하려면 시계가 아니라 순번이 필요하다.
   * 바깥으로 나가는 LogRecord 는 건드리지 않는다(전송 형식은 계약이다).
   */
  private seq = 0;
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

  /**
   * 새로 붙은 구독자에게 보여 줄 최근 줄들 — 연결 순간 화면이 비어 있지 않게 한다.
   *
   * 두 링을 시각순으로 합쳐 돌려주므로 보는 쪽 계약은 종전과 같다. 달라진 것은
   * **판단 줄이 세션 출력에 밀려 사라지지 않는다**는 점이다.
   */
  recent(limit = 100): LogRecord[] {
    const n = Math.max(0, limit);
    if (n === 0) return [];
    const merged: RingEntry[] = [];
    let i = 0;
    let j = 0;
    while (i < this.judgmentRing.length || j < this.sessionRing.length) {
      const a = this.judgmentRing[i];
      const b = this.sessionRing[j];
      if (b === undefined || (a !== undefined && a.seq <= b.seq)) {
        merged.push(a!);
        i += 1;
      } else {
        merged.push(b);
        j += 1;
      }
    }
    return merged.slice(-n).map((e) => e.record);
  }

  /** 데몬이 무엇을 판단했는가 — 세션 출력에 섞이지 않은 줄만. */
  recentJudgments(limit = 100): LogRecord[] {
    return this.judgmentRing.slice(-Math.max(0, limit)).map((e) => e.record);
  }

  /** 주행 중인 세션이 뱉은 줄만. */
  recentSession(limit = 100): LogRecord[] {
    return this.sessionRing.slice(-Math.max(0, limit)).map((e) => e.record);
  }

  log(level: LogLevel, project: string, action: string, detail: string): LogRecord {
    const record: LogRecord = { ts: nowIso(), level, project: project || "-", action, detail };

    // 구독자와 stdout 은 동기로 — 실시간 스트림이 파일 IO 를 기다리지 않는다
    if (this.toStdout) process.stdout.write(`${formatHuman(record)}\n`);
    const ring = action === SESSION_ACTION ? this.sessionRing : this.judgmentRing;
    this.seq += 1;
    ring.push({ seq: this.seq, record });
    if (ring.length > this.ringSize) ring.splice(0, ring.length - this.ringSize);
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
