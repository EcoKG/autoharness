/**
 * v1(Python) ↔ v2(TypeScript) 대조 — daemon/DESIGN.md 7.3 교차 검증의 도구.
 *
 * 같은 장부를 두 구현에 먹여 답이 같은지 본다. 지금은 선택 규칙·교착 판정·종료 코드를
 * 덮고, ts-cross-validation 작업에서 run/status 와 속성 기반 무작위 장부로 넓힌다.
 *
 * 실행: bun run scripts/parity.ts   (불일치가 있으면 exit 1)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { deadlockedPending, eligibleNext } from "../src/core/ledger.ts";
import type { Task, Tracker } from "../src/core/schema.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const ENGINE = join(REPO, "bin", "harness_engine.py");
const PYTHON = process.env["AUTOHARNESS_PYTHON"] ?? "python";

function task(spec: Partial<Task> & { id: string }): Task {
  return {
    id: spec.id,
    title: spec.title ?? spec.id,
    path: null,
    deps: spec.deps ?? [],
    priority: spec.priority ?? 100,
    status: spec.status ?? "pending",
    attempts: spec.attempts ?? 0,
    last_error: null,
    last_log_file: null,
    commit: null,
    started_at: null,
    finished_at: null,
    test_cmd: null,
  };
}

function tracker(tasks: Task[]): Tracker {
  return {
    schema_version: 1,
    project: "parity",
    objective: "o",
    source_stack: "A",
    target_stack: "B",
    model: "claude-opus-5",
    commands: { build: null, test: "echo ok", lint: null, timeout_sec: 1800 },
    max_attempts: 5,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tasks,
  };
}

const CASES: Array<{ name: string; tasks: Task[] }> = [
  { name: "in_progress 최우선", tasks: [task({ id: "a", priority: 1 }), task({ id: "b", status: "in_progress", priority: 99 })] },
  { name: "failed 재시도", tasks: [task({ id: "a", priority: 1 }), task({ id: "b", status: "failed", attempts: 2, priority: 99 })] },
  { name: "failed 한도 도달", tasks: [task({ id: "a", priority: 50 }), task({ id: "b", status: "failed", attempts: 5 })] },
  { name: "deps 게이팅", tasks: [task({ id: "core" }), task({ id: "top", deps: ["core"], priority: 1 })] },
  { name: "deps 해제", tasks: [task({ id: "core", status: "done" }), task({ id: "top", deps: ["core"], priority: 1 })] },
  { name: "동률 id 순", tasks: [task({ id: "b", priority: 10 }), task({ id: "a", priority: 10 })] },
  { name: "전부 done", tasks: [task({ id: "a", status: "done" })] },
  { name: "blocked 만", tasks: [task({ id: "a", status: "blocked" })] },
  { name: "빈 장부", tasks: [] },
  { name: "교착: 미존재 의존", tasks: [task({ id: "a", deps: ["없음"] })] },
  { name: "교착: 순환", tasks: [task({ id: "a", deps: ["b"] }), task({ id: "b", deps: ["a"] })] },
  { name: "교착: blocked 의존", tasks: [task({ id: "s", status: "blocked" }), task({ id: "a", deps: ["s"] })] },
  {
    name: "혼합",
    tasks: [
      task({ id: "d1", status: "done" }),
      task({ id: "f1", status: "failed", attempts: 1, priority: 20 }),
      task({ id: "p1", priority: 5 }),
      task({ id: "x", deps: ["ghost"] }),
    ],
  },
];

let mismatches = 0;
for (const c of CASES) {
  const t = tracker(c.tasks);
  const sandbox = mkdtempSync(join(tmpdir(), "ah-parity-"));
  try {
    mkdirSync(join(sandbox, ".claude"), { recursive: true });
    writeFileSync(join(sandbox, ".claude", "agent_tracker.json"), JSON.stringify(t, null, 2), "utf8");

    const r = spawnSync(PYTHON, [ENGINE, "next", "--repo", sandbox], { encoding: "utf8" });
    const py = JSON.parse(r.stdout || "{}") as { next?: { id: string } | null; deadlocked?: string[] };
    const pyNext = py.next?.id ?? null;
    const pyDead = (py.deadlocked ?? []).slice().sort();

    const tsNext = eligibleNext(t)?.id ?? null;
    const tsDead = deadlockedPending(t)
      .map((x) => x.id)
      .sort();

    const nextOk = pyNext === tsNext;
    const deadOk = JSON.stringify(pyDead) === JSON.stringify(tsDead);
    // 종료 코드 계약: 진행 가능 작업이 없으면 3, 있으면 0
    const exitOk = r.status === (tsNext === null ? 3 : 0);
    if (!nextOk || !deadOk || !exitOk) mismatches++;

    console.log(
      `  ${nextOk && deadOk && exitOk ? "일치  " : "불일치"} ${c.name.padEnd(18)} ` +
        `next py=${String(pyNext)} ts=${String(tsNext)} | dead py=[${pyDead}] ts=[${tsDead}] | exit=${r.status}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\n대조 ${CASES.length}건 — 불일치 ${mismatches}건`);
process.exit(mismatches === 0 ? 0 : 1);
