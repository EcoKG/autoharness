/**
 * EXE 빌드 — `bun build --compile` 로 단일 실행 파일을 만든다.
 *
 * 산출물 크기와 빌드 시간을 항상 출력한다. 이 수치가 커지면 훅 시작 예산
 * (daemon/DESIGN.md 3절)에 직접 영향을 주므로 눈에 보여야 한다.
 */
import { $ } from "bun";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "dist");
const OUT = join(OUT_DIR, process.platform === "win32" ? "autoharness.exe" : "autoharness");

await mkdir(OUT_DIR, { recursive: true });

const started = performance.now();
await $`bun build --compile ${join(ROOT, "src/main.ts")} --outfile ${OUT}`.quiet();
const elapsedMs = performance.now() - started;

const info = await stat(OUT);
const mib = info.size / (1024 * 1024);

console.log(`[build] 산출물 : ${OUT}`);
console.log(`[build] 크기   : ${mib.toFixed(1)} MiB`);
console.log(`[build] 빌드   : ${(elapsedMs / 1000).toFixed(1)}초`);
