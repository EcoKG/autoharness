/**
 * 콘솔 로깅 회귀.
 *
 * v1 의 워치독이 몇 주간 죽어 있었는데 아무도 몰랐던 이유가 "로그가 아예 없었다" 였으므로,
 * 여기서 고정하는 것은 **로그가 실제로 남는다**는 사실 자체다: 파일·구독자·링 버퍼 세 곳에
 * 줄 단위로, 즉시. 그리고 상한을 넘으면 잘리지 않고 회전한다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsoleLog, LOG_LEVELS, formatHuman, type LogRecord } from "../src/daemon/log.ts";

let dir = "";
let logPath = "";
let log: ConsoleLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ah-log-"));
  logPath = join(dir, "logs", "daemon.log");
  log = new ConsoleLog({ path: logPath, toStdout: false });
});
afterEach(async () => {
  await log.close();
  await rm(dir, { recursive: true, force: true });
});

async function lines(path = logPath): Promise<LogRecord[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogRecord);
}

describe("한 줄씩 남는다", () => {
  test("파일에 JSON 라인으로 기록된다", async () => {
    log.info("proj", "tick", "판단 완료");
    await log.flush();
    const rows = await lines();
    expect(rows.length).toBe(1);
    expect(rows[0]!.project).toBe("proj");
    expect(rows[0]!.action).toBe("tick");
    expect(rows[0]!.level).toBe("info");
    expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("여러 줄이 순서대로, 섞이지 않고 쌓인다", async () => {
    for (let i = 0; i < 50; i++) log.info("p", "tick", `${i}`);
    await log.flush();
    const rows = await lines();
    expect(rows.length).toBe(50);
    expect(rows.map((r) => r.detail)).toEqual(Array.from({ length: 50 }, (_, i) => `${i}`));
  });

  test("네 레벨 모두 기록된다", async () => {
    log.debug("p", "a", "d");
    log.info("p", "a", "i");
    log.warn("p", "a", "w");
    log.error("p", "a", "e");
    await log.flush();
    expect((await lines()).map((r) => r.level)).toEqual([...LOG_LEVELS]);
  });

  test("프로젝트가 없으면 데몬 전역으로 표시한다", async () => {
    log.info("", "boot", "시작");
    await log.flush();
    expect((await lines())[0]!.project).toBe("-");
  });

  test("사람이 읽는 형식은 v1 과 같은 4칸이다", () => {
    const line = formatHuman({
      ts: "2026-08-10T00:00:00.000Z", level: "info", project: "p", action: "launch", detail: "pid=1",
    });
    expect(line).toBe("2026-08-10T00:00:00.000Z | p | launch | pid=1");
  });

  test("info 가 아닌 레벨은 사람 형식에 드러난다", () => {
    const line = formatHuman({
      ts: "T", level: "error", project: "p", action: "a", detail: "터졌다",
    });
    expect(line).toContain("[error]");
  });
});

describe("실시간 구독", () => {
  test("구독자는 파일 IO 를 기다리지 않고 즉시 받는다", () => {
    const seen: LogRecord[] = [];
    log.subscribe((r) => void seen.push(r));
    log.info("p", "tick", "지금");
    expect(seen.length).toBe(1); // await 없이 이미 도착했다
    expect(seen[0]!.detail).toBe("지금");
  });

  test("구독 해지가 동작한다", () => {
    const seen: LogRecord[] = [];
    const off = log.subscribe((r) => void seen.push(r));
    log.info("p", "a", "1");
    off();
    log.info("p", "a", "2");
    expect(seen.map((r) => r.detail)).toEqual(["1"]);
  });

  test("깨진 구독자가 데몬을 막지 않는다", async () => {
    log.subscribe(() => {
      throw new Error("느린 클라이언트가 터졌다");
    });
    const seen: LogRecord[] = [];
    log.subscribe((r) => void seen.push(r));
    expect(() => log.info("p", "a", "계속")).not.toThrow();
    await log.flush();
    expect(seen.length).toBe(1);
    expect((await lines()).length).toBe(1); // 파일에도 정상적으로 남았다
  });

  test("최근 줄을 되돌려 준다 — 새로 붙은 화면이 비어 있지 않게", () => {
    for (let i = 0; i < 10; i++) log.info("p", "a", `${i}`);
    expect(log.recent(3).map((r) => r.detail)).toEqual(["7", "8", "9"]);
    expect(log.recent(100).length).toBe(10);
  });

  test("링 버퍼는 상한을 넘지 않는다 — 장시간 동작에서 메모리가 늘지 않는다", () => {
    const small = new ConsoleLog({ path: join(dir, "ring.log"), toStdout: false, ringSize: 5 });
    for (let i = 0; i < 100; i++) small.info("p", "a", `${i}`);
    expect(small.recent(1000).length).toBe(5);
    expect(small.recent(1000)[0]!.detail).toBe("95");
  });
});

describe("회전", () => {
  test("상한을 넘으면 .1 로 밀고 새 파일을 연다", async () => {
    const rotating = new ConsoleLog({ path: join(dir, "rot.log"), toStdout: false, maxBytes: 400 });
    try {
      for (let i = 0; i < 20; i++) rotating.info("p", "tick", `줄 ${i} ${"x".repeat(30)}`);
      await rotating.flush();
      expect(await Bun.file(rotating.backupPath).exists()).toBe(true);
      const current = await stat(rotating.filePath);
      expect(current.size).toBeLessThanOrEqual(400);
    } finally {
      await rotating.close();
    }
  });

  test("회전해도 줄이 반쪽으로 잘리지 않는다 — 전부 파싱 가능하다", async () => {
    const rotating = new ConsoleLog({ path: join(dir, "rot2.log"), toStdout: false, maxBytes: 300 });
    try {
      for (let i = 0; i < 30; i++) rotating.info("p", "tick", `줄 ${i}`);
      await rotating.flush();
      const current = await lines(rotating.filePath);
      const backup = await lines(rotating.backupPath);
      expect(current.length).toBeGreaterThan(0);
      expect(backup.length).toBeGreaterThan(0);
      for (const r of [...current, ...backup]) expect(typeof r.ts).toBe("string");
    } finally {
      await rotating.close();
    }
  });

  test("이미 있던 백업은 덮어쓴다 — 무한히 쌓이지 않는다", async () => {
    const path = join(dir, "rot3.log");
    const rotating = new ConsoleLog({ path, toStdout: false, maxBytes: 200 });
    try {
      await writeFile(`${path}.1`, "이전 백업\n", "utf8");
      for (let i = 0; i < 30; i++) rotating.info("p", "tick", `줄 ${i}`);
      await rotating.flush();
      const backup = await readFile(`${path}.1`, "utf8");
      expect(backup).not.toContain("이전 백업");
      expect(await Bun.file(`${path}.2`).exists()).toBe(false);
    } finally {
      await rotating.close();
    }
  });

  test("기존 파일에 이어 쓰면서 크기를 이어 센다", async () => {
    const path = join(dir, "append.log");
    const first = new ConsoleLog({ path, toStdout: false });
    first.info("p", "a", "첫 줄");
    await first.close();

    const second = new ConsoleLog({ path, toStdout: false });
    second.info("p", "a", "둘째 줄");
    await second.close();
    expect((await lines(path)).map((r) => r.detail)).toEqual(["첫 줄", "둘째 줄"]);
  });
});

describe("실패해도 데몬을 막지 않는다", () => {
  test("경로를 못 쓰더라도 로그 호출이 던지지 않는다", async () => {
    // 파일 자리에 디렉토리를 두어 열기 실패를 만든다
    const bad = new ConsoleLog({ path: join(dir, "as-dir"), toStdout: false });
    await Bun.write(join(dir, "as-dir", "keep"), "x");
    try {
      expect(() => bad.info("p", "a", "그래도 진행")).not.toThrow();
      await bad.flush();
      expect(bad.recent(10).length).toBe(1); // 메모리·구독자 경로는 살아 있다
    } finally {
      await bad.close();
    }
  });

  test("close 이후에는 파일에 더 쓰지 않는다", async () => {
    const path = join(dir, "closed.log");
    const l = new ConsoleLog({ path, toStdout: false });
    l.info("p", "a", "전");
    await l.close();
    l.info("p", "a", "후");
    await l.flush();
    expect((await lines(path)).map((r) => r.detail)).toEqual(["전"]);
  });
});
