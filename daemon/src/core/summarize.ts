/**
 * 오류 요약 — **강한 신호를 먼저 채운다.**
 *
 * 에러 패턴 정규식은 재현율을 위해 넓게 잡혀 있어 `Downloading error-prone-2.0.jar`
 * 같은 무해한 줄도 걸린다(v1 실측). 걸린 순서대로 상한을 채우면 앞쪽 잡음이 자리를
 * 먹어 정작 Traceback·AssertionError 가 밖으로 밀려나고 last_error 에서 잘린다.
 * 정규식을 좁히면 진짜 오류를 놓치므로, 재현율은 두고 **우선순위**로 해결한다.
 */

export const SUMMARY_MAX_LINES = 60;
export const SUMMARY_LINE_CAP = 400;
export const SUMMARY_TAIL_LINES = 30;
export const LAST_ERROR_CAP = 4000;

/** 넓은 그물 — 오류일 가능성이 있는 줄(재현율 우선). */
export const ERROR_LINE_RE =
  /(\[ERROR\]|\bERROR\b|Caused by|FAILED|FAIL[:\s]|error TS\d+|error\[|\berror[:\s]|Exception\b|Traceback|AssertionError|npm ERR!|BUILD FAILURE|CompilationError|cannot find symbol|No such file|ModuleNotFoundError|SyntaxError|panic:|undefined reference|\bE\s{3}|✗|✖)/i;

/** 진짜 실패를 가리키는 강한 신호 — 요약 상한을 이 줄들이 먼저 차지한다. */
export const STRONG_ERROR_RE =
  /(\[ERROR\]|Traceback|AssertionError|BUILD FAILURE|FAILED|npm ERR!|Caused by|error TS\d+|error\[|CompilationError|cannot find symbol|ModuleNotFoundError|SyntaxError|panic:|undefined reference|✗|✖)/i;

export function summarize(text: string): string[] {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((ln) => ln.trim().slice(0, SUMMARY_LINE_CAP))
    .filter((ln) => ln.length > 0);

  const strong: string[] = [];
  const weak: string[] = [];
  for (const ln of lines) {
    if (!ERROR_LINE_RE.test(ln)) continue;
    (STRONG_ERROR_RE.test(ln) ? strong : weak).push(ln);
  }
  const hits = [...strong, ...weak];
  if (hits.length > 0) return hits.slice(0, SUMMARY_MAX_LINES);
  return lines.slice(-SUMMARY_TAIL_LINES);
}
