/**
 * 릴리스 빌드 — 플랫폼별 바이너리를 한 번에 만들고 압축·체크섬까지 붙인다.
 *
 * v1 은 파이썬 소스라 `curl | bash` 한 줄로 끝났다. v2 는 컴파일 바이너리라 그 경험을
 * 되찾으려면 **미리 만들어 둔 산출물**이 있어야 한다. Bun 의 교차 컴파일이 그것을 한
 * 기계에서 가능하게 한다 — 실측: Windows 에서 만든 linux-x64 바이너리가 WSL 에서
 * 그대로 동작한다(version·selftest 15/15·MCP 14종).
 *
 * 압축하는 이유: 90MiB → 34MiB. 설치 한 줄이 받아야 할 양이 3분의 1로 준다.
 * 체크섬을 붙이는 이유: 설치기가 **받은 것이 우리가 만든 것인지** 확인할 수 있어야 한다.
 * 확인 수단 없이 받은 바이너리를 실행 위치에 놓는 설치기는 만들지 않는다.
 */
import { $ } from "bun";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { VERSION } from "../src/version.ts";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "dist", "release");

/**
 * 배포 대상.
 *
 * `asset` 은 설치기가 `uname` 결과로 조립할 이름과 정확히 같아야 한다 — 여기 이름과
 * install.sh 의 판정이 어긋나면 "릴리스는 있는데 받지 못하는" 조용한 실패가 된다.
 */
export const TARGETS = [
  { target: "bun-linux-x64", asset: "autoharness-linux-x64" },
  { target: "bun-linux-arm64", asset: "autoharness-linux-arm64" },
  { target: "bun-darwin-arm64", asset: "autoharness-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "autoharness-darwin-x64" },
  { target: "bun-windows-x64", asset: "autoharness-windows-x64.exe" },
] as const;

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return hash.digest("hex");
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function main(): Promise<number> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const entry = join(ROOT, "src", "main.ts");
  const rows: string[] = [];
  const sums: string[] = [];
  let failed = 0;

  console.log(`[release] 버전 ${VERSION} — 타깃 ${TARGETS.length}종`);

  for (const { target, asset } of TARGETS) {
    const raw = join(OUT_DIR, asset);
    const started = performance.now();
    try {
      await $`bun build --compile --target=${target} ${entry} --outfile ${raw}`.quiet();
    } catch (err) {
      console.error(`  FAIL ${asset.padEnd(30)} 빌드 실패: ${String(err).slice(0, 160)}`);
      failed += 1;
      continue;
    }
    const elapsed = performance.now() - started;

    // gzip 은 설치기가 gunzip 한 줄로 풀 수 있고 어디에나 있다 — 의존성을 늘리지 않는다
    const gz = `${raw}.gz`;
    await $`gzip -9 -c ${raw} > ${gz}`.quiet();

    const rawSize = await sizeOf(raw);
    const gzSize = await sizeOf(gz);
    const digest = await sha256(gz);
    sums.push(`${digest}  ${asset}.gz`);
    rows.push(
      `  OK   ${asset.padEnd(30)} ${mib(rawSize).padStart(9)} → ${mib(gzSize).padStart(9)}` +
        `  ${(elapsed / 1000).toFixed(1)}초`,
    );
    // 압축본만 배포한다 — 원본까지 올리면 릴리스가 두 배가 되고 받는 쪽은 어차피 하나만 쓴다
    await rm(raw, { force: true });
  }

  for (const r of rows) console.log(r);

  const checksums = join(OUT_DIR, "SHA256SUMS");
  await writeFile(checksums, `${sums.join("\n")}\n`, "utf8");
  console.log(`[release] 산출물: ${OUT_DIR}`);
  console.log(`[release] 체크섬: ${checksums}`);

  if (failed > 0) {
    console.error(`[release] ${failed}종 실패 — 릴리스를 올리지 마십시오.`);
    return 1;
  }

  console.log("");
  console.log("다음 단계(사람 승인 필요 — 공개 배포입니다):");
  console.log(`  gh release create v${VERSION} ${OUT_DIR}/*.gz ${checksums} --title "v${VERSION}" --notes "..."`);
  return 0;
}

process.exitCode = await main();
