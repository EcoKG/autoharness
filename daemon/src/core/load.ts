/**
 * JSON 로더 — **부재와 파손을 구분한다.**
 *
 * v1 은 둘 다 `None` 으로 뭉갰고, 그것이 게이트를 통째로 무력화한 근인이었다:
 * 장부가 깨지면 커밋 게이트가 "장부 없음(수동 운용)" 으로 보고 조용히 통과했고,
 * settings.json 이 깨지면 "훅 미등록" 으로 판정해 경고 대상에서 빠졌다.
 * 실패의 종류를 잃지 않는 것이 이 모듈의 존재 이유다.
 */
import { readFile } from "node:fs/promises";

export type LoadState = "ok" | "missing" | "corrupt";

export interface LoadResult<T> {
  readonly state: LoadState;
  /** state === "ok" 일 때만 값이 있다. */
  readonly value: T | null;
  /** 파손일 때 원인 — 진단에 그대로 실어 사람이 고칠 수 있게 한다. */
  readonly error: string | null;
}

function missingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * JSON 파일을 읽어 (상태, 값)을 돌려준다.
 *
 * @param validate 모양 검증기. 통과하지 못하면 파손으로 본다 — 파싱은 됐지만 스키마가
 *   아닌 파일(예: 최상위가 배열)을 정상으로 취급하면 이후 코드가 조용히 어긋난다.
 */
export async function loadJson<T>(
  path: string,
  validate?: (value: unknown) => value is T,
): Promise<LoadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (missingFile(err)) return { state: "missing", value: null, error: null };
    return { state: "corrupt", value: null, error: `읽기 실패: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: "corrupt", value: null, error: `JSON 파싱 실패: ${String(err)}` };
  }

  if (validate && !validate(parsed)) {
    return { state: "corrupt", value: null, error: "예상한 모양이 아닙니다" };
  }
  return { state: "ok", value: parsed as T, error: null };
}

/** 최상위가 객체인지 — 스키마 검증의 공통 1차 관문. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
