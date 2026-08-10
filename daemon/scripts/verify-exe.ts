/**
 * EXE 실측 검증 — **빌드가 됐다는 것과 동작한다는 것은 다르다.**
 *
 * 단일 파일로 컴파일하면 동적 import·정적 자원·stdin 처리가 조용히 어긋날 수 있다.
 * 그래서 argv 모드 하나하나를 실제로 실행해 종료 코드와 출력을 확인한다. 여기서 통과해야
 * "EXE 가 v1 을 대체할 수 있다" 고 말할 수 있다.
 *
 * 격리: 임시 저장소와 임시 AUTOHARNESS_HOME 을 쓴다 — 실제 장부·레지스트리·설치본을
 * 건드리지 않는다(CLAUDE.md 6절).
 */
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODES } from "../src/main.ts";

const ROOT = join(import.meta.dir, "..");
const EXE = join(ROOT, "dist", process.platform === "win32" ? "autoharness.exe" : "autoharness");

try {
  await stat(EXE);
} catch {
  console.error(`[verify] EXE 가 없습니다: ${EXE} — 먼저 'bun run build' 를 실행하십시오.`);
  process.exit(2);
}

const repo = await mkdtemp(join(tmpdir(), "ah-exe-repo-"));
const home = await mkdtemp(join(tmpdir(), "ah-exe-home-"));
await mkdir(join(repo, ".claude"), { recursive: true });
const env = { ...process.env, AUTOHARNESS_HOME: home, AUTOHARNESS_NO_DELEGATE: "1" };

const HOOK_PAYLOAD = JSON.stringify({
  session_id: "verify", hook_event_name: "PreToolUse", tool_input: { command: "git status" },
});

interface Case {
  mode: string;
  args?: string[];
  stdin?: string;
  expect: number;
  contains?: string;
  note?: string;
}

/** 실행 순서에 의미가 있다 — init 이 먼저여야 next·run 이 볼 장부가 생긴다. */
const CASES: Case[] = [
  { mode: "version", expect: 0, contains: "2.0" },
  { mode: "detect", args: ["--repo", repo], expect: 0, contains: "build_tools" },
  { mode: "model-recommend", args: ["--repo", repo], expect: 0, contains: "recommended" },
  {
    mode: "init",
    args: ["--repo", repo, "--project", "exe", "--objective", "검증", "--source", "A",
           "--target", "B", "--test", "exit 0"],
    expect: 0, contains: "ok",
  },
  { mode: "add-task", args: ["--repo", repo, "--id", "t1", "--title", "작업"], expect: 0 },
  { mode: "next", args: ["--repo", repo], expect: 0, contains: "t1" },
  { mode: "status", args: ["--repo", repo], expect: 0, contains: "counts" },
  { mode: "render", args: ["--repo", repo], expect: 0 },
  { mode: "heartbeat", args: ["--repo", repo], expect: 0 },
  { mode: "run", args: ["--repo", repo, "--task", "t1"], expect: 0, contains: "exit=0" },
  { mode: "next", args: ["--repo", repo], expect: 3, note: "할 일이 없으면 3" },
  { mode: "set-task", args: ["--repo", repo, "--id", "t1", "--status", "pending"], expect: 0 },
  { mode: "sync-commit", args: ["--repo", repo], expect: 0 },
  { mode: "brief", args: ["--repo", repo], expect: 0, contains: "AutoHarness" },
  { mode: "hook-prebash", args: ["--repo", repo], stdin: HOOK_PAYLOAD, expect: 0 },
  { mode: "hook-postbash", args: ["--repo", repo], stdin: HOOK_PAYLOAD, expect: 0 },
  { mode: "hook-stop", args: ["--repo", repo], stdin: HOOK_PAYLOAD, expect: 0 },
  { mode: "mcp", stdin: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', expect: 0, contains: '"tools"' },
  { mode: "selftest", expect: 0, contains: "15/15" },
  // 설치는 **반드시 dry-run 으로만** 검증한다 — 검증이 시스템에 영구 설정을 심으면 안 된다
  { mode: "install", args: ["--dry-run"], expect: 0, contains: "dry-run",
    note: "계획만 확인, 시스템 변경 없음" },
  { mode: "install", args: ["--status"], expect: 0, contains: "autostart" },
];

async function runCase(c: Case): Promise<{ ok: boolean; detail: string }> {
  const proc = Bun.spawn([EXE, c.mode, ...(c.args ?? [])], {
    cwd: repo, env, stdin: c.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe",
  });
  if (c.stdin && proc.stdin) {
    proc.stdin.write(c.stdin);
    await proc.stdin.end();
  }
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== c.expect) return { ok: false, detail: `종료 코드 ${code} (기대 ${c.expect})` };
  if (c.contains && !out.includes(c.contains)) {
    return { ok: false, detail: `출력에 ${JSON.stringify(c.contains)} 없음` };
  }
  return { ok: true, detail: `exit=${code}${c.note ? ` — ${c.note}` : ""}` };
}

/** daemon 은 상주 모드라 따로 다룬다: 떠서 잠금을 잡는지 보고 곧바로 내린다. */
async function verifyDaemon(): Promise<{ ok: boolean; detail: string }> {
  const proc = Bun.spawn([EXE, "daemon", "--interval", "60"], {
    cwd: repo, env, stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 15_000;
  const lock = join(home, ".claude", "autoharness", "daemon.lock");
  let up = false;
  while (Date.now() < deadline) {
    if (await Bun.file(lock).exists()) {
      up = true;
      break;
    }
    await Bun.sleep(100);
  }
  proc.kill();
  await proc.exited;
  return up
    ? { ok: true, detail: "기동·잠금 확인 후 종료" }
    : { ok: false, detail: "15초 안에 잠금을 잡지 못함" };
}

let failed = 0;
console.log(`[verify] EXE: ${EXE}`);
for (const c of CASES) {
  const r = await runCase(c);
  console.log(`  ${r.ok ? "PASS" : "FAIL"} ${c.mode.padEnd(16)} ${r.detail}`);
  if (!r.ok) failed += 1;
}
const daemonResult = await verifyDaemon();
console.log(`  ${daemonResult.ok ? "PASS" : "FAIL"} ${"daemon".padEnd(16)} ${daemonResult.detail}`);
if (!daemonResult.ok) failed += 1;

// 모드 표에 있는데 한 번도 실행해 보지 않은 모드가 있으면 그것도 결함이다
const covered = new Set([...CASES.map((c) => c.mode), "daemon"]);
const uncovered = MODES.filter((m) => !covered.has(m));
if (uncovered.length > 0) {
  console.log(`  FAIL ${"커버리지".padEnd(16)} 검증하지 않은 모드: ${uncovered.join(", ")}`);
  failed += 1;
}

await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

console.log(failed === 0 ? `[verify] 전부 통과 (${CASES.length + 1}건)` : `[verify] 실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
