/**
 * 자가 검증 — v1 과 동일한 7종 15항목을 임시 샌드박스에서 실행한다.
 *
 * **실제 종료 코드를 본다.** 라이브러리 함수를 직접 부르면 CLI 배선이 깨져도 통과하므로,
 * v1 과 마찬가지로 자기 자신을 서브프로세스로 띄워 검증한다.
 *
 * 부작용은 임시 디렉토리에만 남긴다 — 실제 저장소·레지스트리·설치본을 건드리지 않는다.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../exit.ts";
import { repoPaths } from "./paths.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** 자기 자신을 어떻게 다시 부를지 — EXE 로 컴파일됐으면 그 파일, 아니면 bun 으로 소스. */
function selfInvocation(): string[] {
  const exePath = process.execPath;
  const isCompiled = !/(^|[\\/])(bun|bun\.exe|node|node\.exe)$/i.test(exePath);
  return isCompiled ? [exePath] : [exePath, "run", join(import.meta.dir, "..", "main.ts")];
}

async function invoke(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...selfInvocation(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

export async function runSelftest(): Promise<{ checks: Check[]; allOk: boolean }> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const sandbox = await mkdtemp(join(tmpdir(), "autoharness-selftest-"));
  const OK_CMD = "exit 0";
  const FAIL_CMD = "echo 'ERROR: intentional failure' >&2; exit 1";

  try {
    // 1. 장부 초기화 + 더미 작업 2건(의존 관계)
    let r = await invoke(["init", "--repo", sandbox, "--project", "selftest", "--objective", "자가검증",
      "--source", "A", "--target", "B", "--test", OK_CMD]);
    add("1-init", r.code === EXIT.OK, r.stderr);

    const r1 = await invoke(["add-task", "--repo", sandbox, "--id", "t1", "--title", "선행 작업", "--priority", "10"]);
    const r2 = await invoke(["add-task", "--repo", sandbox, "--id", "t2", "--title", "후행 작업",
      "--deps", "t1", "--priority", "20"]);
    add("1-add-tasks", r1.code === EXIT.OK && r2.code === EXIT.OK, r1.stderr + r2.stderr);

    // 5(선행). 의존성 게이팅: t1 이 done 이 아니므로 next 는 t1
    r = await invoke(["next", "--repo", sandbox]);
    add("5-dep-gating-before", r.code === EXIT.OK && r.stdout.includes('"id": "t1"'), r.stdout.slice(0, 200));

    // 2. 실패 경로: exit 1, attempts=1, last_error 기록, 로그 파일 존재
    r = await invoke(["run", "--repo", sandbox, "--task", "t1", "--cmd", FAIL_CMD]);
    let tracker = await Bun.file(repoPaths(sandbox).tracker).json();
    let t1 = tracker.tasks.find((t: { id: string }) => t.id === "t1");
    add("2-fail-exit1", r.code === EXIT.FAIL, `exit=${r.code}`);
    add("2-fail-attempts", t1.attempts === 1, `attempts=${t1.attempts}`);
    add("2-fail-last-error", Boolean(t1.last_error) && String(t1.last_error).includes("ERROR"),
      String(t1.last_error).slice(0, 120));
    add("2-fail-log-file",
      Boolean(t1.last_log_file) && (await Bun.file(join(sandbox, t1.last_log_file)).exists()),
      String(t1.last_log_file));

    // 3. 성공 경로: exit 0, status=done
    r = await invoke(["run", "--repo", sandbox, "--task", "t1", "--cmd", OK_CMD]);
    tracker = await Bun.file(repoPaths(sandbox).tracker).json();
    t1 = tracker.tasks.find((t: { id: string }) => t.id === "t1");
    add("3-success-exit0", r.code === EXIT.OK, `exit=${r.code}`);
    add("3-success-done", t1.status === "done", t1.status);

    // 5(후행). 게이팅 해제: 이제 next 는 t2
    r = await invoke(["next", "--repo", sandbox]);
    add("5-dep-gating-after", r.code === EXIT.OK && r.stdout.includes('"id": "t2"'), r.stdout.slice(0, 200));

    // 4. 한도 경로: 5회 연속 실패 → 마지막이 exit 4 + blocked
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await invoke(["run", "--repo", sandbox, "--task", "t2", "--cmd", FAIL_CMD])).code);
    }
    tracker = await Bun.file(repoPaths(sandbox).tracker).json();
    const t2 = tracker.tasks.find((t: { id: string }) => t.id === "t2");
    add("4-limit-codes", JSON.stringify(codes) === JSON.stringify([1, 1, 1, 1, 4]), String(codes));
    add("4-limit-blocked", t2.status === "blocked" && t2.attempts === 5, `${t2.status}/${t2.attempts}`);
    r = await invoke(["next", "--repo", sandbox]);
    add("4-no-eligible-exit3", r.code === EXIT.NO_TASK, `exit=${r.code}`);

    // 6. PROGRESS.md 렌더
    const progress = await Bun.file(repoPaths(sandbox).progress).text().catch(() => "");
    add("6-progress-render",
      progress.includes("t1") && progress.includes("t2") && progress.includes("blocked"),
      repoPaths(sandbox).progress);
  } finally {
    // 7. 더미 데이터 정리 — 샌드박스 전체 삭제
    await rm(sandbox, { recursive: true, force: true });
    add("7-cleanup", !(await Bun.file(repoPaths(sandbox).tracker).exists()), sandbox);
  }

  return { checks, allOk: checks.every((c) => c.ok) };
}

export async function cmdSelftest(): Promise<number> {
  const { checks, allOk } = await runSelftest();
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  console.log(`selftest ${allOk ? "통과" : "실패"} (${passed}/${checks.length})`);
  return allOk ? EXIT.OK : EXIT.FAIL;
}
