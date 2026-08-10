/**
 * 핵심 IO 계약 테스트.
 *
 * 여기서 고정하는 것은 v1 이 실측으로 얻은 두 규칙이다:
 *  ① rename 은 일시적 잠금(OneDrive 동기화·백신)에 지수 백오프로 재시도한다
 *  ② 로더는 **부재와 파손을 구분한다** — 둘을 뭉갠 것이 v1 에서 게이트를 통째로
 *     무력화한 근인이었다
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RENAME_RETRIES, atomicWriteJson, atomicWriteText } from "../src/core/atomic.ts";
import { isRecord, loadJson } from "../src/core/load.ts";
import { isRegistry, isTracker, isProjectStatus, isTaskStatus, nowIso } from "../src/core/schema.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-core-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("원자적 쓰기", () => {
  test("텍스트를 쓰고 다시 읽는다", async () => {
    const p = join(dir, "a.txt");
    await atomicWriteText(p, "한글 내용\n");
    expect(await readFile(p, "utf8")).toBe("한글 내용\n");
  });

  test("없는 디렉토리를 만들어 준다", async () => {
    const p = join(dir, "깊은", "경로", "b.json");
    await atomicWriteJson(p, { ok: true });
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ ok: true });
  });

  test("JSON 형식이 v1 과 같다 — 들여쓰기 2, 끝에 개행", async () => {
    const p = join(dir, "c.json");
    await atomicWriteJson(p, { a: 1 });
    expect(await readFile(p, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  test("한글이 이스케이프되지 않는다 — v1 의 ensure_ascii=False 와 같다", async () => {
    const p = join(dir, "d.json");
    await atomicWriteJson(p, { 제목: "값" });
    expect(await readFile(p, "utf8")).toContain("제목");
  });

  test("덮어쓰기 후 임시 파일이 남지 않는다", async () => {
    const p = join(dir, "e.json");
    await atomicWriteJson(p, { v: 1 });
    await atomicWriteJson(p, { v: 2 });
    const left = [...new Bun.Glob(".ah-*.tmp").scanSync(dir)];
    expect(left).toEqual([]);
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ v: 2 });
  });

  test("재시도 횟수가 v1 과 같다", () => {
    expect(RENAME_RETRIES).toBe(5);
  });

  test("쓰기 실패를 삼키지 않는다", async () => {
    // 디렉토리 자리에 파일을 쓰려 하면 실패해야 한다 — 조용히 성공으로 보고하면
    // 이후 판단이 전부 거짓 위에 선다
    const asDir = join(dir, "충돌");
    await mkdir(asDir, { recursive: true });
    await expect(atomicWriteText(asDir, "x")).rejects.toThrow();
  });
});

describe("로더 — 부재와 파손 구분", () => {
  test("없는 파일은 missing", async () => {
    const r = await loadJson(join(dir, "없음.json"));
    expect(r.state).toBe("missing");
    expect(r.value).toBeNull();
    expect(r.error).toBeNull();
  });

  test("정상 파일은 ok", async () => {
    const p = join(dir, "ok.json");
    await atomicWriteJson(p, { a: 1 });
    const r = await loadJson(p);
    expect(r.state).toBe("ok");
    expect(r.value).toEqual({ a: 1 });
  });

  test("깨진 JSON 은 corrupt — 사유를 함께 준다", async () => {
    const p = join(dir, "bad.json");
    await writeFile(p, "{ 잘린 JSON", "utf8");
    const r = await loadJson(p);
    expect(r.state).toBe("corrupt");
    expect(r.value).toBeNull();
    expect(r.error).toContain("파싱");
  });

  test("모양이 다르면 corrupt — 파싱만 되면 통과시키지 않는다", async () => {
    const p = join(dir, "shape.json");
    await atomicWriteJson(p, [1, 2, 3]);
    const r = await loadJson(p, isTracker);
    expect(r.state).toBe("corrupt");
  });

  test("부재와 파손이 서로 다른 상태로 나온다", async () => {
    const missing = await loadJson(join(dir, "x.json"), isTracker);
    const bad = join(dir, "y.json");
    await writeFile(bad, "nope", "utf8");
    const corrupt = await loadJson(bad, isTracker);
    expect(missing.state).not.toBe(corrupt.state);
  });
});

describe("스키마 검증", () => {
  test("isTracker 는 tasks 배열을 요구한다", () => {
    expect(isTracker({ tasks: [] })).toBe(true);
    expect(isTracker({ tasks: {} })).toBe(false);
    expect(isTracker({})).toBe(false);
    expect(isTracker([])).toBe(false);
    expect(isTracker(null)).toBe(false);
  });

  test("isTracker 는 필드가 늘어난 장부를 거부하지 않는다", () => {
    // 너무 엄격하면 v1 이 만든 정상 장부를 파손으로 오판한다
    expect(isTracker({ tasks: [], 미래필드: 1 })).toBe(true);
  });

  test("isRegistry 는 projects 배열을 요구한다", () => {
    expect(isRegistry({ projects: [] })).toBe(true);
    expect(isRegistry({ projects: null })).toBe(false);
  });

  test("상태 값은 v1 목록과 일치한다", () => {
    for (const s of ["pending", "in_progress", "done", "failed", "blocked"]) {
      expect(isTaskStatus(s)).toBe(true);
    }
    expect(isTaskStatus("cancelled")).toBe(false);
    for (const s of ["active", "paused", "completed", "needs_human", "error"]) {
      expect(isProjectStatus(s)).toBe(true);
    }
    expect(isProjectStatus("running")).toBe(false);
  });

  test("isRecord 는 배열과 null 을 거른다", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  test("nowIso 는 ISO8601 UTC 다", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});
