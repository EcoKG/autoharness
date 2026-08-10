/**
 * 단일 페이지 UI 회귀.
 *
 * 이 페이지는 **자율 주행이 멈췄는지 보러 여는 화면**이다. 그래서 두 가지가 계약이다:
 *   ① **오프라인 동작** — 외부 CDN·폰트·스크립트를 부르지 않는다. 네트워크가 죽은 상황에서
 *      뜨지 않는 진단 화면은 없느니만 못하다.
 *   ② **주입 안전** — 화면에 찍히는 값(프로젝트 이름·작업 제목·로그 줄)은 전부 장부와
 *      로그에서 온다. innerHTML 로 붙이면 로그 한 줄이 스크립트가 된다.
 *
 * 그리고 문서 자체는 인증 이전에 서빙된다 — 토큰을 입력할 화면이 토큰을 요구하면 들어갈 수
 * 없기 때문이다. 대신 **데이터는 한 조각도 문서에 담기지 않는다**(전부 인증된 API 로만).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoPaths, userPaths } from "../src/core/paths.ts";
import { createTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { defaultRegistry, mutateRegistry, saveRegistry, upsertProject } from "../src/core/registry.ts";
import { ConsoleLog } from "../src/daemon/log.ts";
import { BIND_HOST, createWebServer, type WebServerHandle } from "../src/web/server.ts";
import { STATIC_ASSETS, UI_HTML } from "../src/web/ui.ts";

let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};
let log: ConsoleLog;
let server: WebServerHandle;
let base = "";
/** 문서에 데이터가 새는지 보려면 페이지 자체의 어휘와 겹치지 않는 값이어야 한다. */
const UNIQUE_ID = "zzz-leak-canary-9f3a";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-ui-"));
  repo = await mkdtemp(join(tmpdir(), "ah-uirepo-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
  await mkdir(repoPaths(repo).claudeDir, { recursive: true });
  const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
  t.tasks = [newTask("t1", "작업")];
  await saveTracker(repo, t);
  await saveRegistry(defaultRegistry(), env);
  await mutateRegistry(
    (reg) => upsertProject(reg, { id: UNIQUE_ID, repo, model: "claude-opus-5", permissionArgs: [] }),
    env,
  );
  log = new ConsoleLog({ path: join(home, "d.log"), toStdout: false });
  server = await createWebServer({ log, env }, 0);
  base = `http://${BIND_HOST}:${server.port}`;
});
afterEach(async () => {
  await server.stop();
  await log.close();
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("오프라인 자족", () => {
  test("외부 출처를 전혀 부르지 않는다", () => {
    // http(s):// 로 시작하는 자원 참조가 있으면 오프라인에서 깨진다
    const external = UI_HTML.match(/(src|href)\s*=\s*["']https?:\/\/[^"']+/gi);
    expect(external).toBeNull();
    expect(UI_HTML).not.toContain("cdn.");
    expect(UI_HTML).not.toContain("googleapis");
    expect(UI_HTML).not.toContain("unpkg");
  });

  test("스타일과 스크립트가 문서 안에 있다", () => {
    expect(UI_HTML).toContain("<style>");
    expect(UI_HTML).toContain("<script>");
    expect(UI_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(UI_HTML).not.toMatch(/<link[^>]+stylesheet/i);
  });

  test("import·동적 로딩이 없다 — 단일 EXE 안에서 그대로 뜬다", () => {
    expect(UI_HTML).not.toContain("import(");
    expect(UI_HTML).not.toContain("importScripts");
  });

  test("한글이 이스케이프인 채로 새어 나가지 않는다", () => {
    // 실측된 함정: 트랜스파일러가 생성 코드에서 비ASCII 를 \uXXXX 로 이스케이프하는데
    // String.raw 는 그것을 해석하지 않아, 화면에 한글 대신 이스케이프가 그대로 찍혔다.
    // 타입 검사도 테스트도 통과하는데 화면만 깨지는 종류라 여기서 못 박는다.
    expect(/[가-힣]/.test(UI_HTML)).toBe(true);
    expect(UI_HTML).not.toContain(String.fromCharCode(92) + "u");
  });
});

describe("주입 안전", () => {
  test("innerHTML·document.write 를 쓰지 않는다", () => {
    expect(UI_HTML).not.toContain("innerHTML");
    expect(UI_HTML).not.toContain("outerHTML");
    expect(UI_HTML).not.toContain("document.write");
    expect(UI_HTML).not.toContain("insertAdjacentHTML");
  });

  test("eval·Function 생성자를 쓰지 않는다", () => {
    expect(UI_HTML).not.toMatch(/\beval\s*\(/);
    expect(UI_HTML).not.toMatch(/new\s+Function\s*\(/);
  });

  test("값은 textContent 로만 찍는다", () => {
    expect(UI_HTML).toContain("textContent");
  });
});

describe("토큰 취급", () => {
  test("sessionStorage 만 쓴다 — 탭을 닫으면 사라진다", () => {
    expect(UI_HTML).toContain("sessionStorage");
    expect(UI_HTML).not.toContain("localStorage");
    expect(UI_HTML).not.toContain("document.cookie");
  });

  test("토큰을 URL 에 싣지 않는다 — WS 는 서브프로토콜로 보낸다", () => {
    expect(UI_HTML).toContain("autoharness.bearer.");
    expect(UI_HTML).not.toContain("?token=");
  });

  test("토큰 입력은 가려진다", () => {
    expect(UI_HTML).toMatch(/id="token"[^>]*type="password"/);
  });
});

describe("서빙", () => {
  test("루트가 UI 를 준다 — 토큰 없이도 화면은 떠야 한다", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("AutoHarness");
  });

  test("문서에는 데이터가 한 조각도 담기지 않는다", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toContain(UNIQUE_ID); // 프로젝트 id 가 새지 않는다
    expect(html).not.toContain(repo);
    expect(html).not.toContain(server.token);
  });

  test("데이터 API 는 여전히 토큰을 요구한다", async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/${UNIQUE_ID}/tasks`)).status).toBe(401);
  });

  test("CSP 로 외부 연결을 막는다", async () => {
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("정적 자원 표에 index 가 있다", () => {
    expect(STATIC_ASSETS["/index.html"]!.type).toContain("text/html");
    expect(STATIC_ASSETS["/index.html"]!.body).toBe(UI_HTML);
  });

  test("없는 정적 경로는 401(인증 먼저) 또는 404", async () => {
    const r = await fetch(`${base}/없는파일.js`);
    expect([401, 404]).toContain(r.status);
  });
});

describe("화면 구성", () => {
  test("요구된 영역이 모두 있다", () => {
    for (const id of ["projects", "detail", "tasks", "console", "token"]) {
      expect(UI_HTML, id).toContain(`id="${id}"`);
    }
  });

  test("제어 버튼 4종이 있다", () => {
    for (const act of ["pause", "resume", "tick", "launch"]) {
      expect(UI_HTML, act).toContain(`data-act="${act}"`);
    }
  });

  test("작업 상태 전환은 pending·blocked 만 제시한다 — done 은 run 성공으로만 생긴다", () => {
    expect(UI_HTML).toContain('"pending"');
    expect(UI_HTML).toContain('"blocked"');
    expect(UI_HTML).not.toMatch(/status:\s*"done"/);
  });

  test("끊기면 재연결한다", () => {
    expect(UI_HTML).toContain("재연결");
    expect(UI_HTML).toContain("connectSocket");
  });
});

/**
 * 토큰 파일 안내 — 플랫폼을 가리지 않는다.
 *
 * 실측 결함: 화면에 POSIX 경로가 문자열로 박혀 있었고 그것을 채우는 코드가 없어,
 * 이 저장소의 주 플랫폼인 Windows 사용자에게는 영영 틀린 안내였다. 정확한 경로를 아는
 * 것은 데몬이므로, 문서에 데이터를 심는 대신 기동 로그로 알린다.
 */
describe("토큰 파일 위치 안내", () => {
  test("두 플랫폼의 경로를 함께 보여 준다", () => {
    expect(UI_HTML).toContain("~/.claude/autoharness/web-token");
    expect(UI_HTML).toContain("%USERPROFILE%");
  });

  test("정확한 경로는 로그에서 찾으라고 알려 준다", () => {
    expect(UI_HTML).toContain("로그에 남깁니다");
  });

  test("문서에 실제 경로를 심지 않는다 — 데이터 0 계약 유지", () => {
    // 서버가 렌더한 값이 아니라 고정 문자열이어야 한다(사용자 홈 이름이 새지 않게)
    expect(UI_HTML).not.toContain(userPaths(process.env).webToken);
  });
});

/**
 * 작업 행 펼치기 — 원인이 이미 와 있는데 버리고 있었다.
 *
 * /api/projects/:id/tasks 는 tracker.tasks 를 통째로 준다. 즉 last_error·last_log_file·
 * deps·test_cmd 가 전부 브라우저까지 도착해 있는데, 표는 id·상태·시도·커밋만 그리고
 * 나머지를 버렸다. "왜 실패했나" 를 보려면 화면을 떠나 로그 파일을 직접 열어야 했다.
 */
describe("작업 상세", () => {
  test("상세를 그리는 코드가 있다", () => {
    expect(UI_HTML).toContain("toggleDetail");
    expect(UI_HTML).toContain("마지막 오류");
    expect(UI_HTML).toContain("의존");
  });

  test("값은 textContent 로만 넣는다 — 오류 문자열이 마크업이 되지 않게", () => {
    // 상세는 장부 문자열을 그대로 그린다. innerHTML 이 한 군데라도 있으면 그 자체가 결함이다
    expect(UI_HTML).not.toContain("innerHTML");
  });

  test("시도는 한도와 함께 보여 준다", () => {
    // "4" 와 "4/5" 는 다른 정보다. 다만 **언제 봉인되는지의 판정 문구는 쓰지 않는다** —
    // 그것은 서버가 정하고 "막힌 곳" 카드가 말한다(규칙이 갈라지지 않게).
    expect(UI_HTML).toContain("maxAttempts");
    expect(UI_HTML).toContain('attemptsCell.className = "err"');
  });

  test("되돌리기 버튼이 시도 횟수 초기화를 미리 알린다", () => {
    expect(UI_HTML).toContain("0 으로 초기화됩니다");
  });

  test("API 가 max_attempts 를 함께 준다 — 없으면 화면이 한도를 알 수 없다", async () => {
    const r = await fetch(`${base}/api/projects/${encodeURIComponent(UNIQUE_ID)}/tasks`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    const body = (await r.json()) as { max_attempts?: number };
    expect(typeof body.max_attempts).toBe("number");
  });
});

/**
 * 훅 배선 카드 — v1 을 무너뜨린 실패 유형을 화면에서 잡는다.
 *
 * v1 은 워치독이 몇 주간 한 번도 돌지 않았는데 상태 조회가 계속 정상이라 보고했다. 훅도
 * 같은 성질이라 등록만 되고 발화하지 않아도 주행은 겉보기에 멀쩡하다. harness_status 가
 * 이미 배선 상태를 통째로 주므로 백엔드를 늘리지 않고 그것만 그린다.
 */
describe("훅 배선 카드", () => {
  test("배선 상태를 그리는 코드가 있다", () => {
    expect(UI_HTML).toContain("renderWiring");
    expect(UI_HTML).toContain("훅 배선");
  });

  test("기존 위임 경로로 harness_status 를 부른다 — 새 API 를 만들지 않는다", () => {
    expect(UI_HTML).toContain("/api/mcp/call");
    expect(UI_HTML).toContain("harness_status");
  });

  test("등록됐는데 발화 없는 상태를 붉게 칠한다 — 조용한 실패의 자리다", () => {
    expect(UI_HTML).toContain("발화 없음");
    expect(UI_HTML).toContain("등록은 됐지만 발화 기록이 없습니다");
  });

  test("미등록은 결함으로 칠하지 않는다 — 수동 운용도 정상이다", () => {
    // 미등록 배지에 error 클래스를 붙이지 않는다는 판단이 코드에 남아 있어야 한다
    expect(UI_HTML).toContain("미등록은 결함이 아니다");
  });

  test("게이트가 풀리는 배선을 경고한다", () => {
    expect(UI_HTML).toContain("repo_unpinned_hooks");
    expect(UI_HTML).toContain("하위 디렉토리에서 게이트가 풀립니다");
  });

  test("harness_status 는 위임 허용 목록에 있다 — 카드가 실제로 데이터를 받을 수 있다", async () => {
    const { DELEGATABLE_TOOLS } = await import("../src/mcp/tools.ts");
    expect(DELEGATABLE_TOOLS.has("harness_status")).toBe(true);
  });
});

/**
 * 막힌 곳 요약 — 판정은 서버, 화면은 그리기만.
 */
describe("막힌 곳 요약 카드", () => {
  test("서버가 준 사유를 그린다", () => {
    expect(UI_HTML).toContain("renderBlockers");
    expect(UI_HTML).toContain("막힌 곳");
  });

  test("화면이 판정을 다시 계산하지 않는다", () => {
    // 서버가 만든 사유를 받아 그리기만 해야 한다. 화면이 사유 문자열을 조립하기 시작하면
    // 그 순간부터 두 곳이 갈라지고, 갈라진 화면이 "정상" 이라 말한다.
    expect(UI_HTML).toContain("r.blockers");
    // 규칙을 설명하는 주석에 이름이 나오는 것은 정상이다 — 금지하는 것은 **호출**이다
    expect(UI_HTML).not.toContain("eligibleNext(");
    expect(UI_HTML).not.toContain("deadlockedPending(");
    for (const serverPhrase of ["봉인됨 —", "다음 실패에 봉인됩니다\"", "장부에 없음)"]) {
      expect(UI_HTML, `사유 조립이 화면으로 새어 나왔습니다: ${serverPhrase}`)
        .not.toContain(serverPhrase);
    }
  });

  test("막힌 것이 없으면 절이 사라진다", () => {
    expect(UI_HTML).toContain('id="blockedBox" hidden');
  });

  test("API 가 사유를 함께 준다", async () => {
    const r = await fetch(`${base}/api/projects/${encodeURIComponent(UNIQUE_ID)}/tasks`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    const body = (await r.json()) as { blockers?: unknown[] };
    expect(Array.isArray(body.blockers)).toBe(true);
  });
});
