/**
 * 단일 인스턴스 잠금 — 데몬이 둘 뜨면 같은 프로젝트에 세션을 두 번 띄운다.
 *
 * 잠금은 **죽은 채로 남는다**(크래시·강제 종료·재부팅). 그래서 존재만으로 막으면 한 번
 * 죽은 뒤 영영 못 뜨는 상태가 된다. 판정은 두 축이다:
 *   ① 잠금이 가리키는 pid 가 살아 있는가 — 살아 있으면 양보한다
 *   ② mtime 이 오래됐는가 — 갱신이 멈춘 잠금은 죽은 것으로 보고 탈취한다
 */
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { userPaths } from "../core/paths.ts";
import { nowIso } from "../core/schema.ts";

/** 이만큼 갱신이 없으면 죽은 잠금으로 본다. tick 간격(기본 15분)의 두 배 이상이어야 한다. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

export interface LockRecord {
  pid: number;
  started_at: string;
}

/**
 * pid 생존 여부.
 *
 * `process.kill(pid, 0)` 은 신호를 보내지 않고 **존재·권한만 검사**한다 — Windows 에서도
 * libuv 가 signum 0 을 존재 확인으로 처리하므로 프로세스를 죽이지 않는다. (파이썬의
 * `os.kill` 은 Windows 에서 TerminateProcess 로 매핑돼 실제로 죽이므로 v1 은 이 함수를
 * 손으로 구현해야 했다. 여기서는 런타임이 안전한 경로를 준다.)
 */
export function pidAlive(pid: unknown): boolean {
  const n = typeof pid === "number" ? pid : Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM = 존재하지만 접근 권한이 없다 → 살아 있다. ESRCH = 없다.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface AcquireResult {
  acquired: boolean;
  /** 실패했다면 누가 쥐고 있는가. 성공했다면 탈취 사유(있을 때). */
  reason: string;
  path: string;
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as LockRecord;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export async function acquireLock(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<AcquireResult> {
  const path = userPaths(env).lock;
  let reason = "새 잠금";

  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  if (mtimeMs !== null) {
    const age = now() - mtimeMs;
    const existing = await readLock(path);
    if (age > LOCK_STALE_MS) {
      reason = `잠금 mtime ${Math.round(age / 60000)}분 경과 — 죽은 잠금 탈취`;
    } else if (existing && pidAlive(existing.pid)) {
      return { acquired: false, reason: `다른 데몬 실행 중(pid=${existing.pid})`, path };
    } else {
      reason = `잠금의 pid=${existing?.pid ?? "?"} 사망 확인 — 잠금 탈취`;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  const record: LockRecord = { pid: process.pid, started_at: nowIso() };
  await writeFile(path, JSON.stringify(record), "utf8");
  return { acquired: true, reason, path };
}

/**
 * 잠금이 살아 있음을 알린다 — mtime 만 밀어 준다.
 * 매 tick 에 부르면, 멈춘 데몬의 잠금은 시간이 지나며 자연히 탈취 가능해진다.
 */
export async function refreshLock(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = userPaths(env).lock;
  try {
    const when = new Date();
    await utimes(path, when, when);
    return true;
  } catch {
    return false;
  }
}

export async function releaseLock(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(userPaths(env).lock, { force: true });
}
