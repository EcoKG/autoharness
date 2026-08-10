/**
 * 훅 모드 콜드 스타트 실측.
 *
 * 훅은 매 Bash 호출마다 도는 단발 실행이라 시작 시간이 곧 체감이다.
 * daemon/DESIGN.md 3절이 정한 예산은 **p95 150ms**. 이 스크립트는 그 수치를
 * 측정만 하고 판정은 사람이 읽을 수 있게 출력한다 — 예산 초과를 조용히 넘기지 않는다.
 */
import { stat } from "node:fs/promises";
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

const samples: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  const proc = Bun.spawn([EXE, "version"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  samples.push(performance.now() - started);
}

samples.sort((a, b) => a - b);
const p50 = percentile(samples, 50);
const p95 = percentile(samples, 95);
const p99 = percentile(samples, 99);
const withinBudget = p95 < BUDGET_P95_MS;

console.log(`[bench] 실행 횟수 : ${RUNS}`);
console.log(`[bench] p50       : ${p50.toFixed(1)}ms`);
console.log(`[bench] p95       : ${p95.toFixed(1)}ms  (예산 ${BUDGET_P95_MS}ms)`);
console.log(`[bench] p99       : ${p99.toFixed(1)}ms`);
console.log(`[bench] 최소/최대 : ${samples[0]!.toFixed(1)}ms / ${samples.at(-1)!.toFixed(1)}ms`);
console.log(`[bench] 판정      : ${withinBudget ? "예산 이내" : "예산 초과 — 훅 위임 경로 검토 필요"}`);

// 측정 스크립트가 예산 판정으로 빌드를 깨뜨리지는 않는다. 판정은 사람이 읽고 결정한다.
process.exit(0);
