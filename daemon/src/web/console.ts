/**
 * WebSocket 콘솔 스트림 — **구독은 읽기 전용이다.**
 *
 * 스트림과 제어를 섞지 않는다. 명령은 REST(POST + 토큰 헤더)로만 받는다. 이유는 CSRF 다:
 * WebSocket 은 동일 출처 정책의 보호를 받지 않아 다른 페이지가 연결을 열 수 있다. 토큰으로
 * 막지만, 설령 토큰이 새더라도 **소켓으로는 아무것도 실행되지 않는다**는 성질을 남겨 두는
 * 편이 안전하다(방어를 한 겹에만 걸지 않는다).
 *
 * 느린 클라이언트가 데몬을 막지 않아야 한다. 소켓 버퍼가 한계를 넘으면 그 클라이언트에게
 * 보내기를 **건너뛰고 몇 줄을 흘렸는지 센다**. 계속 밀리면 연결을 끊는다 — 한 화면 때문에
 * 자율 주행이 느려지는 것이 최악이다.
 */
import type { LogRecord } from "../daemon/log.ts";

/** 이 이상 쌓이면 그 클라이언트는 따라오지 못하는 것으로 본다. */
export const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;
/** 연속으로 이만큼 흘리면 연결을 끊는다. */
export const MAX_CONSECUTIVE_DROPS = 200;
/** 새 연결에 밀어 주는 과거 줄 수 — 화면이 비어 있지 않게. */
export const BACKLOG_LINES = 200;

export interface ConsoleSocket {
  send: (data: string) => number | void;
  close: (code?: number, reason?: string) => void;
  getBufferedAmount?: () => number;
}

export interface ConsoleClientStats {
  sent: number;
  dropped: number;
  consecutiveDrops: number;
  closed: boolean;
}

/**
 * 소켓 하나의 상태를 들고 있는 얇은 래퍼.
 * 데몬 쪽에서 보면 "보내되, 못 따라오면 버린다" 는 규칙 하나로 보인다.
 */
export class ConsoleClient {
  readonly stats: ConsoleClientStats = { sent: 0, dropped: 0, consecutiveDrops: 0, closed: false };

  constructor(
    private readonly socket: ConsoleSocket,
    private readonly limitBytes = BACKPRESSURE_LIMIT_BYTES,
    private readonly maxDrops = MAX_CONSECUTIVE_DROPS,
  ) {}

  private buffered(): number {
    try {
      return this.socket.getBufferedAmount?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /** 한 줄 전송. 보냈으면 true, 백프레셔로 버렸으면 false. */
  push(record: LogRecord): boolean {
    if (this.stats.closed) return false;
    if (this.buffered() > this.limitBytes) {
      this.stats.dropped += 1;
      this.stats.consecutiveDrops += 1;
      if (this.stats.consecutiveDrops >= this.maxDrops) {
        // 계속 못 따라온다 — 데몬을 붙들지 않도록 놓아 준다
        this.close(1013, "클라이언트가 스트림을 따라오지 못합니다");
      }
      return false;
    }
    try {
      this.socket.send(JSON.stringify({ type: "log", record }));
      this.stats.sent += 1;
      this.stats.consecutiveDrops = 0;
      return true;
    } catch {
      this.close(1011, "전송 실패");
      return false;
    }
  }

  /** 흘린 줄이 있었다면 사용자에게 알린다 — 조용히 빠뜨리지 않는다. */
  notifyDropsIfAny(): void {
    if (this.stats.dropped === 0 || this.stats.closed) return;
    try {
      this.socket.send(JSON.stringify({ type: "dropped", count: this.stats.dropped }));
    } catch {
      /* 알림 실패는 무시 — 이미 끊긴 소켓이다 */
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.stats.closed) return;
    this.stats.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      /* 이미 닫혔다 */
    }
  }
}

/** 연결된 콘솔 클라이언트 집합. 로그 구독 하나를 여럿에게 나눠 준다. */
export class ConsoleHub {
  private clients = new Set<ConsoleClient>();

  get size(): number {
    return this.clients.size;
  }

  add(client: ConsoleClient): void {
    this.clients.add(client);
  }

  remove(client: ConsoleClient): void {
    this.clients.delete(client);
  }

  /** 모든 클라이언트에 한 줄씩. 한 클라이언트의 실패가 나머지를 막지 않는다. */
  broadcast(record: LogRecord): void {
    for (const client of [...this.clients]) {
      client.push(record);
      if (client.stats.closed) this.clients.delete(client);
    }
  }

  closeAll(): void {
    for (const client of [...this.clients]) client.close(1001, "서버 종료");
    this.clients.clear();
  }
}

/** 클라이언트가 소켓으로 뭔가 보내면 돌려줄 응답 — 여기서는 아무것도 실행하지 않는다. */
export const READ_ONLY_NOTICE = JSON.stringify({
  type: "error",
  error:
    "이 스트림은 읽기 전용입니다. 명령은 REST(POST /api/…)로 보내십시오 — " +
    "스트림과 제어를 섞지 않습니다.",
});

/** 새 연결에 밀어 줄 초기 메시지들. */
export function backlogMessages(recent: readonly LogRecord[]): string[] {
  return [
    JSON.stringify({ type: "hello", backlog: recent.length, read_only: true }),
    ...recent.map((record) => JSON.stringify({ type: "log", record })),
  ];
}
