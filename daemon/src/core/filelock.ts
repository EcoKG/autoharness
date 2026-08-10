/**
 * 프로세스 간 배타 잠금 — 같은 파일을 여러 프로세스가 고칠 때 갱신 소실을 막는다.
 *
 * 왜 프로세스 간이어야 하는가: 레지스트리의 쓰기 주체는 최소 둘이다. 상주 데몬과, Claude
 * Code 세션마다 뜨는 MCP 서버는 **별개 프로세스**다. 같은 프로세스 안의 프라미스 직렬화나
 * "저장 직전 재읽기" 로는 A읽기 → B읽기 → B쓰기 → A쓰기 순서를 막을 수 없다. 잃는 것이
 * pause 나 프로젝트 등록이면 사용자가 한 조작이 조용히 되돌아간다.
 *
 * 설계 원칙 셋:
 *   ① **획득 실패는 조용히 통과시키지 않는다.** 잠금이 있는 척하고 그냥 쓰면 잠금이 없는
 *      것만 못하다(있다고 믿게 만드니 더 나쁘다). 못 잡으면 던진다.
 *   ② **죽은 잠금은 탈취한다.** 크래시로 남은 잠금 하나가 영영 쓰기를 막으면 안 된다.
 *   ③ **대기에 상한을 둔다.** 훅·MCP 응답이 잠금 때문에 붙들리면 사용자가 체감한다.
 */
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** 이만큼 지난 잠금은 죽은 것으로 본다. 레지스트리 쓰기는 밀리초 단위라 넉넉한 값이다. */
export const LOCK_STALE_MS = 30_000;
/** 잠금 대기 상한 — 넘으면 던진다. */
export const LOCK_TIMEOUT_MS = 5_000;
const RETRY_MIN_MS = 5;
const RETRY_MAX_MS = 50;

export class LockTimeoutError extends Error {}

interface LockPayload {
  pid: number;
  at: string;
}

/** pid 생존 확인 — 신호를 보내지 않고 존재만 본다(daemon/src/daemon/lock.ts 와 같은 규칙). */
function pidAlive(pid: unknown): boolean {
  const n = typeof pid === "number" ? pid : Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function readHolder(path: string): Promise<LockPayload | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockPayload;
  } catch {
    return null;
  }
}

/**
 * "지금은 못 잡았다" 로 볼 오류인가.
 *
 * `EEXIST` 만 볼 수는 없다. Windows 에서는 **삭제 대기 중인 파일**을 열면 `EPERM`/`EACCES`
 * 가 오고, 공유 위반은 `EBUSY` 로 온다 — 잠금을 놓고 다투는 정상 상황인데 코드는 하드
 * 오류로 받는다. 실측: 같은 프로세스에서 10건을 동시에 갱신하다 EPERM 으로 죽었다.
 * 전부 재시도 대상이며, 진짜 권한 문제라면 재시도 끝에 LockTimeout 으로 시끄럽게 드러난다.
 */
export function isContendedError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** 한 번 시도. 잡았으면 true. */
async function tryAcquire(path: string, now: () => number): Promise<boolean> {
  try {
    // wx = O_CREAT|O_EXCL — 원자적이다. 이미 있으면 EEXIST(윈도우에서는 EPERM 도) 로 실패한다.
    const handle = await open(path, "wx");
    try {
      await handle.write(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), null, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (!isContendedError(err)) throw err;
  }

  // 이미 누가 쥐고 있다 — 살아 있는지 본다
  const holder = await readHolder(path);
  let ageMs = 0;
  try {
    ageMs = now() - (await stat(path)).mtimeMs;
  } catch {
    return false; // 방금 사라졌다 — 다음 회차에 다시 시도한다
  }
  const dead = holder !== null && !pidAlive(holder.pid);
  if (dead || ageMs > LOCK_STALE_MS) {
    // 탈취: 지우고 다음 회차에 정상 경로로 다시 잡는다. 지우기 경쟁에서 져도
    // EEXIST 로 돌아올 뿐이라 안전하다.
    await rm(path, { force: true }).catch(() => {});
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface FileLockOptions {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * `fn` 을 배타 잠금 안에서 실행한다. 잠금은 끝나면 반드시 푼다(예외가 나도).
 *
 * 재진입은 지원하지 않는다 — 같은 프로세스가 중첩 호출하면 자기 잠금에 막혀 타임아웃한다.
 * 호출부를 얕게 유지하는 편이 숨은 재진입보다 안전하다.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const timeout = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const deadline = now() + timeout;
  await mkdir(dirname(lockPath), { recursive: true });

  let delay = RETRY_MIN_MS;
  for (;;) {
    if (await tryAcquire(lockPath, now)) break;
    if (now() >= deadline) {
      const holder = await readHolder(lockPath);
      throw new LockTimeoutError(
        `잠금을 ${timeout}ms 안에 얻지 못했습니다: ${lockPath}` +
          (holder ? ` (보유 pid=${holder.pid}, 시각=${holder.at})` : "") +
          " — 쓰기를 건너뛰지 않고 중단합니다(갱신 소실 방지).",
      );
    }
    await sleep(delay);
    delay = Math.min(RETRY_MAX_MS, delay * 2);
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/** 테스트·진단용 — 남은 잠금을 강제로 지운다. */
export async function forceReleaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

/** 잠금 파일 내용을 들여다본다(진단용). 없으면 null. */
export async function inspectLock(lockPath: string): Promise<LockPayload | null> {
  return readHolder(lockPath);
}

export async function writeLockFor(lockPath: string, pid: number, at = new Date().toISOString()): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid, at } satisfies LockPayload), "utf8");
}
