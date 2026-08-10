/**
 * WebSocket 콘솔 회귀 — **스트림과 제어를 섞지 않는다.**
 *
 * 고정하는 계약:
 *   ① WS 도 토큰을 거친다 — 인증 없는 스트림은 로그 유출 경로다
 *   ② 구독은 읽기 전용 — 소켓으로는 아무것도 실행되지 않는다
 *   ③ 연결 즉시 백로그를 밀어 준다(화면이 비어 있지 않게)
 *   ④ 실시간으로 새 줄이 온다
 *   ⑤ **느린 클라이언트가 데몬을 막지 않는다** — 백프레셔로 버리고, 계속 밀리면 끊는다
 *   ⑥ 끊김·재연결이 서버 상태를 망가뜨리지 않는다
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userPaths } from "../src/core/paths.ts";
import { defaultRegistry, saveRegistry } from "../src/core/registry.ts";
import { ConsoleLog, type LogRecord } from "../src/daemon/log.ts";
import {
  BACKPRESSURE_LIMIT_BYTES,
  ConsoleClient,
  ConsoleHub,
  MAX_CONSECUTIVE_DROPS,
  backlogMessages,
  type ConsoleSocket,
} from "../src/web/console.ts";
import {
  BIND_HOST,
  CONSOLE_PATH,
  WS_SUBPROTOCOL_PREFIX,
  createWebServer,
  websocketToken,
  type WebServerHandle,
} from "../src/web/server.ts";

let home = "";
let env: NodeJS.ProcessEnv = {};
let log: ConsoleLog;
let server: WebServerHandle;
let wsBase = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-ws-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
  await saveRegistry(defaultRegistry(), env);
  log = new ConsoleLog({ path: join(home, "d.log"), toStdout: false });
  server = await createWebServer({ log, env }, 0);
  wsBase = `ws://${BIND_HOST}:${server.port}${CONSOLE_PATH}`;
});
afterEach(async () => {
  await server.stop();
  await log.close();
  await rm(home, { recursive: true, force: true });
});

interface Collected {
  socket: WebSocket;
  messages: unknown[];
  waitFor: (predicate: (m: unknown[]) => boolean, ms?: number) => Promise<void>;
  close: () => void;
}

function connect(url: string, protocols?: string | string[]): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    const messages: unknown[] = [];
    socket.addEventListener("message", (ev) => {
      messages.push(JSON.parse(String((ev as MessageEvent).data)));
    });
    socket.addEventListener("error", () => reject(new Error("WS 연결 실패")));
    socket.addEventListener("open", () =>
      resolve({
        socket,
        messages,
        close: () => socket.close(),
        waitFor: async (predicate, ms = 3000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (predicate(messages)) return;
            await Bun.sleep(10);
          }
          throw new Error(`조건 미충족(수신 ${messages.length}건): ${JSON.stringify(messages).slice(0, 300)}`);
        },
      }),
    );
  });
}

const types = (messages: unknown[]): string[] => messages.map((m) => (m as { type: string }).type);

describe("인증", () => {
  test("토큰 없이는 연결되지 않는다", async () => {
    await expect(connect(wsBase)).rejects.toThrow();
  });

  test("틀린 토큰도 거부한다", async () => {
    await expect(connect(`${wsBase}?token=wrong`)).rejects.toThrow();
  });

  test("질의 문자열 토큰으로 연결된다", async () => {
    const c = await connect(`${wsBase}?token=${server.token}`);
    await c.waitFor((m) => types(m).includes("hello"));
    c.close();
  });

  test("서브프로토콜 토큰으로 연결된다 — URL 에 남지 않는 권장 경로", async () => {
    const c = await connect(wsBase, `${WS_SUBPROTOCOL_PREFIX}${server.token}`);
    await c.waitFor((m) => types(m).includes("hello"));
    c.close();
  });

  test("토큰 추출 경계", () => {
    const url = new URL("http://127.0.0.1/ws/console?token=q");
    const withProto = new Request("http://127.0.0.1/ws/console", {
      headers: { "sec-websocket-protocol": "other, autoharness.bearer.abc" },
    });
    expect(websocketToken(withProto, url)).toBe("abc"); // 서브프로토콜이 우선
    expect(websocketToken(new Request("http://127.0.0.1/"), url)).toBe("q");
    expect(websocketToken(new Request("http://127.0.0.1/"), new URL("http://127.0.0.1/"))).toBeNull();
  });
});

describe("스트림", () => {
  test("연결 즉시 백로그를 받는다", async () => {
    log.info("p", "tick", "이전 줄 1");
    log.info("p", "tick", "이전 줄 2");
    const c = await connect(`${wsBase}?token=${server.token}`);
    await c.waitFor((m) => m.filter((x) => (x as { type: string }).type === "log").length >= 2);
    const details = c.messages
      .filter((x) => (x as { type: string }).type === "log")
      .map((x) => (x as { record: LogRecord }).record.detail);
    expect(details).toContain("이전 줄 1");
    expect(details).toContain("이전 줄 2");
    c.close();
  });

  test("hello 는 읽기 전용임을 알린다", async () => {
    const c = await connect(`${wsBase}?token=${server.token}`);
    await c.waitFor((m) => types(m).includes("hello"));
    const hello = c.messages.find((m) => (m as { type: string }).type === "hello") as {
      read_only: boolean;
    };
    expect(hello.read_only).toBe(true);
    c.close();
  });

  test("새 줄이 실시간으로 온다", async () => {
    const c = await connect(`${wsBase}?token=${server.token}`);
    await c.waitFor((m) => types(m).includes("hello"));
    log.warn("proj", "limit", "지금 발생한 줄");
    await c.waitFor((m) =>
      m.some(
        (x) =>
          (x as { type: string }).type === "log" &&
          (x as { record: LogRecord }).record.detail === "지금 발생한 줄",
      ),
    );
    c.close();
  });

  test("두 클라이언트가 같은 줄을 함께 받는다", async () => {
    const a = await connect(`${wsBase}?token=${server.token}`);
    const b = await connect(`${wsBase}?token=${server.token}`);
    await a.waitFor((m) => types(m).includes("hello"));
    await b.waitFor((m) => types(m).includes("hello"));
    log.info("proj", "tick", "둘 다에게");
    const has = (m: unknown[]) =>
      m.some((x) => (x as { record?: LogRecord }).record?.detail === "둘 다에게");
    await a.waitFor(has);
    await b.waitFor(has);
    a.close();
    b.close();
  });
});

describe("읽기 전용", () => {
  test("소켓으로 명령을 보내면 거부 메시지가 돌아온다 — 실행되지 않는다", async () => {
    const c = await connect(`${wsBase}?token=${server.token}`);
    await c.waitFor((m) => types(m).includes("hello"));
    c.socket.send(JSON.stringify({ action: "pause", project: "proj" }));
    await c.waitFor((m) => types(m).includes("error"));
    const err = c.messages.find((m) => (m as { type: string }).type === "error") as { error: string };
    expect(err.error).toContain("읽기 전용");
    expect(err.error).toContain("REST");
    c.close();
  });
});

describe("끊김과 재연결", () => {
  test("끊었다 다시 붙어도 정상 동작한다", async () => {
    const first = await connect(`${wsBase}?token=${server.token}`);
    await first.waitFor((m) => types(m).includes("hello"));
    first.close();
    await Bun.sleep(50);

    log.info("p", "tick", "끊긴 사이의 줄");
    const second = await connect(`${wsBase}?token=${server.token}`);
    await second.waitFor((m) =>
      m.some((x) => (x as { record?: LogRecord }).record?.detail === "끊긴 사이의 줄"),
    );
    second.close();
  });

  test("서버 종료가 연결을 정리한다", async () => {
    const c = await connect(`${wsBase}?token=${server.token}`);
    await c.waitFor((m) => types(m).includes("hello"));
    const closed = new Promise<void>((resolve) => c.socket.addEventListener("close", () => resolve()));
    await server.stop();
    await closed; // 여기 도달하면 정리된 것이다
    // afterEach 의 stop 이 두 번 불려도 문제가 없어야 한다
  });
});

/** 백프레셔는 실제 소켓으로 재현하기 어려우므로 단위로 못 박는다. */
describe("백프레셔 — 느린 클라이언트가 데몬을 막지 않는다", () => {
  function fakeSocket(buffered: () => number): ConsoleSocket & { sent: string[]; closedWith: number[] } {
    const sent: string[] = [];
    const closedWith: number[] = [];
    return {
      sent,
      closedWith,
      send: (data: string) => void sent.push(data),
      close: (code = 1000) => void closedWith.push(code),
      getBufferedAmount: buffered,
    };
  }

  const record: LogRecord = { ts: "T", level: "info", project: "p", action: "a", detail: "d" };

  test("버퍼가 여유로우면 보낸다", () => {
    const socket = fakeSocket(() => 0);
    const client = new ConsoleClient(socket);
    expect(client.push(record)).toBe(true);
    expect(socket.sent.length).toBe(1);
    expect(client.stats.dropped).toBe(0);
  });

  test("버퍼가 한계를 넘으면 버린다 — 데몬은 기다리지 않는다", () => {
    const socket = fakeSocket(() => BACKPRESSURE_LIMIT_BYTES + 1);
    const client = new ConsoleClient(socket);
    expect(client.push(record)).toBe(false);
    expect(socket.sent.length).toBe(0);
    expect(client.stats.dropped).toBe(1);
  });

  test("계속 밀리면 연결을 끊는다", () => {
    const socket = fakeSocket(() => BACKPRESSURE_LIMIT_BYTES + 1);
    const client = new ConsoleClient(socket);
    for (let i = 0; i < MAX_CONSECUTIVE_DROPS; i++) client.push(record);
    expect(client.stats.closed).toBe(true);
    expect(socket.closedWith[0]).toBe(1013);
  });

  test("다시 따라오면 연속 카운터가 풀린다", () => {
    let buffered = BACKPRESSURE_LIMIT_BYTES + 1;
    const client = new ConsoleClient(fakeSocket(() => buffered));
    client.push(record);
    client.push(record);
    expect(client.stats.consecutiveDrops).toBe(2);
    buffered = 0;
    client.push(record);
    expect(client.stats.consecutiveDrops).toBe(0);
  });

  test("흘린 줄이 있으면 끊기 전에 알린다 — 조용히 빠뜨리지 않는다", () => {
    const socket = fakeSocket(() => BACKPRESSURE_LIMIT_BYTES + 1);
    const client = new ConsoleClient(socket);
    client.push(record);
    client.notifyDropsIfAny();
    expect(socket.sent.some((s) => s.includes('"dropped"'))).toBe(true);
  });

  test("전송이 던져도 허브는 계속 돈다", () => {
    const hub = new ConsoleHub();
    const bad = new ConsoleClient({
      send: () => {
        throw new Error("소켓이 죽었다");
      },
      close: () => {},
    });
    const good = fakeSocket(() => 0);
    hub.add(bad);
    hub.add(new ConsoleClient(good));
    hub.broadcast(record);
    expect(good.sent.length).toBe(1); // 나머지는 정상 수신
    expect(hub.size).toBe(1); // 죽은 클라이언트는 정리됐다
  });

  test("백로그 메시지는 hello 로 시작한다", () => {
    const msgs = backlogMessages([record, record]);
    expect(JSON.parse(msgs[0]!)).toMatchObject({ type: "hello", backlog: 2, read_only: true });
    expect(msgs.length).toBe(3);
  });
});
