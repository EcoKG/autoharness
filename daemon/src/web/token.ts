/**
 * 웹 토큰 — **없으면 서버를 띄우지 않는다.**
 *
 * 이 데몬은 프로젝트를 일시정지하고 세션을 기동할 수 있다. 즉 명령 전송이 가능하다는 뜻이고,
 * 그것은 곧 로컬 공격 표면이다. loopback 바인드만으로는 부족하다 — 같은 기계에서 도는 아무
 * 프로그램이나(브라우저의 아무 탭 포함) 127.0.0.1 에 요청을 보낼 수 있기 때문이다.
 * 그래서 토큰이 타협 불가 요구사항이다(daemon/DESIGN.md 6.3, 8절의 사람 경계).
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { userPaths } from "../core/paths.ts";

export const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * 토큰을 읽거나, 없으면 만들어 저장한다.
 *
 * 파일 권한을 0600 으로 좁힌다. Windows 에서 `chmod` 는 ACL 을 온전히 반영하지 못하므로
 * (읽기 전용 비트 정도로 매핑된다) 그것만 믿지 않는다 — 진짜 방어선은 토큰이 예측 불가능한
 * 난수라는 점과 loopback 바인드다. 그래도 POSIX 에서 의미가 있으므로 호출한다.
 */
export async function ensureToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = userPaths(env).webToken;
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 20) return existing;
  } catch {
    /* 없거나 못 읽으면 새로 만든다 */
  }
  const token = generateToken();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, "utf8");
  await chmod(path, 0o600).catch(() => {});
  return token;
}

/**
 * 토큰 비교는 **길이가 달라도 던지지 않고**, 같은 길이에서는 상수 시간으로 한다.
 * 타이밍으로 한 글자씩 맞춰 나가는 공격을 막는다.
 */
export function tokenMatches(expected: string, received: string | null | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` 에서 토큰만 꺼낸다. 쿠키는 보지 않는다(CSRF 방어). */
export function bearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1]!.trim() : null;
}
