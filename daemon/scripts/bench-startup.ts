/**
 * 훅 모드 콜드 스타트 실측.
 *
 * 훅은 매 Bash 호출마다 도는 단발 실행이라 시작 시간이 곧 체감이다.
 * daemon/DESIGN.md 3절이 정한 예산은 **p95 150ms**. 이 스크립트는 그 수치를
 * 측정만 하고 판정은 사람이 읽을 수 있게 출력한다 — 예산 초과를 조용히 넘기지 않는다.
 */
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXE = join(ROOT, "dist", process.platform === "win32" ? "autoharness.exe" : "autoharness");
const BUDGET_P95_MS = 150;
const RUNS = Number(process.env["BENCH_RUNS"] ?? 100);

try {
  await stat(EXE);
} catch {
  console.error(`[bench] EXE 가 없습니다: ${EXE} — 먼저 'bun run build' 를 실행하십시오.`);
  process.exit(2);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/**
 * **실제 훅 경로를 잰다.** `version` 은 아무것도 읽지 않아 실측치가 낙관적으로 나온다.
 * 매 Bash 호출마다 실제로 도는 것은 hook-prebash 이고, 그것은 stdin 을 읽고 장부·설정을
 * 열고 명령을 판정한다 — 예산이 걸린 대상은 그 전체다.
 */
const repo = await mkdtemp(join(tmpdir(), "ah-bench-"));
const home = await mkdtemp(join(tmpdir(), "ah-benchhome-"));
await mkdir(join(repo, ".claude"), { recursive: true });
const benchEnv = { ...process.env, AUTOHARNESS_HOME: home, AUTOHARNESS_NO_DELEGATE: "1" };
const payload = JSON.stringify({
  session_id: "bench",
  hook_event_name: "PreToolUse",
  tool_input: { command: "git status" },
});

// 장부가 있는 상태를 재는 것이 현실이다 — 부재 상태는 이른 반환이라 더 빠르다
await Bun.spawn([EXE, "init", "--repo", repo, "--project", "bench", "--objective", "o",
                 "--source", "A", "--target", "B", "--test", "exit 0"],
                { env: benchEnv, stdout: "ignore", stderr: "ignore" }).exited;
await Bun.spawn([EXE, "add-task", "--repo", repo, "--id", "t1", "--title", "작업"],
                { env: benchEnv, stdout: "ignore", stderr: "ignore" }).exited;

const samples: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  const proc = Bun.spawn([EXE, "hook-prebash", "--repo", repo], {
    env: benchEnv, stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  proc.stdin.write(payload);
  await proc.stdin.end();
  await proc.exited;
  samples.push(performance.now() - started);
}

await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

samples.sort((a, b) => a - b);
const p50 = percentile(samples, 50);
const p95 = percentile(samples, 95);
const p99 = percentile(samples, 99);
const withinBudget = p95 < BUDGET_P95_MS;

console.log(`[bench] 대상      : hook-prebash (매 Bash 호출마다 도는 경로)`);
console.log(`[bench] 실행 횟수 : ${RUNS}`);
console.log(`[bench] p50       : ${p50.toFixed(1)}ms`);
console.log(`[bench] p95       : ${p95.toFixed(1)}ms  (예산 ${BUDGET_P95_MS}ms)`);
console.log(`[bench] p99       : ${p99.toFixed(1)}ms`);
console.log(`[bench] 최소/최대 : ${samples[0]!.toFixed(1)}ms / ${samples.at(-1)!.toFixed(1)}ms`);
console.log(`[bench] 판정      : ${withinBudget ? "예산 이내" : "예산 초과 — 훅 위임 경로 검토 필요"}`);

// 측정 스크립트가 예산 판정으로 빌드를 깨뜨리지는 않는다. 판정은 사람이 읽고 결정한다.
process.exit(0);
