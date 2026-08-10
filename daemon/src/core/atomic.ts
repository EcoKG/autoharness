/**
 * 원자적 파일 IO — v1 이 실측으로 얻은 규칙을 그대로 옮긴다.
 *
 * 이 저장소는 OneDrive 안에 있어 동기화·백신이 파일을 잠깐 잠근다. rename 이 그때
 * EPERM/EBUSY 를 맞는데, 재시도 없이 실패로 처리하면 장부 쓰기가 산발적으로 깨진다.
 * v1 은 지수 백오프 5회로 이 문제를 해결했고 같은 규칙을 여기서도 쓴다.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** rename 총 시도 횟수 — 첫 대기 100ms 에서 시작해 2배씩 늘린다(v1 REPLACE_RETRIES) */
export const RENAME_RETRIES = 5;
export const RENAME_BACKOFF_MS = 100;

/** 일시적 잠금으로 볼 오류 코드. 이외의 오류는 재시도하지 않고 그대로 던진다. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * rename 재시도 — 일시적 잠금만 백오프한다.
 *
 * 마지막 시도까지 실패하면 원래 오류를 던진다. 조용히 삼키지 않는다: 장부 쓰기가
 * 실패했는데 성공처럼 보이면 이후 판단이 전부 거짓 위에 선다.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (code === undefined || !TRANSIENT.has(code)) throw err;
      if (attempt === RENAME_RETRIES - 1) throw err;
      await sleep(RENAME_BACKOFF_MS * 2 ** attempt);
    }
  }
}

let tempCounter = 0;

/** 같은 디렉토리에 임시 파일을 쓴 뒤 rename — 부분 기록 상태가 보이지 않게 한다. */
export async function atomicWriteText(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.ah-${process.pid}-${Date.now()}-${tempCounter++}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: "utf8" });
    await renameWithRetry(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** JSON 을 원자적으로 쓴다. v1 과 같은 형식(들여쓰기 2, 끝에 개행)으로 맞춘다. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}
