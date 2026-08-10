/**
 * v1(Python) ↔ v2(TypeScript) 대조 — daemon/DESIGN.md 7.3 교차 검증의 도구.
 *
 * 같은 장부를 두 구현에 먹여 답이 같은지 본다. 지금은 선택 규칙·교착 판정·종료 코드를
 * 덮고, ts-cross-validation 작업에서 run/status 와 속성 기반 무작위 장부로 넓힌다.
 *
 * 실행: bun run scripts/parity.ts   (불일치가 있으면 exit 1)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { deadlockedPending, eligibleNext, statusCounts } from "../src/core/ledger.ts";
import { denyReason, invokesGitCommit } from "../src/hooks/command.ts";
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

// ── 명령 판정 대조 ────────────────────────────────────────────────────────────
// 훅 게이트의 판정은 두 구현이 반드시 같아야 한다. 다르면 한쪽 저장소만 막히거나
// 한쪽만 뚫린다.
const COMMAND_CASES = [
  "git push origin main",
  "git push origin 기능-브랜치",
  "git push --force",
  "git subtree push --prefix=dist origin gh-pages",
  "gh pr merge 12 --auto",
  "gh api -X POST /repos/x/y/issues",
  "gh pr list",
  "gh api -X GET /x",
  "git reset --hard HEAD~1",
  "git reset --soft HEAD~1",
  "git clean -fd",
  "git clean -n",
  "git branch -D feature",
  "git branch -d merged",
  "git checkout -- .",
  "git checkout main",
  "git restore src/",
  "git restore --staged f.txt",
  "git stash drop",
  "git stash pop",
  "git reflog expire --expire=now --all",
  "git reflog",
  "git worktree remove wt",
  "git worktree list",
  "git status",
  "git log --grep=push",
  'grep -r "git push" docs/',
  'echo "git push 하지 마세요"',
  'git commit -m "push 준비 완료"',
  "bash -c 'git push origin main'",
  "powershell -Command \"git push origin main\"",
  "timeout 30 git push origin main",
  "nice -n 10 git push",
  "xargs -n 1 git push",
  "GIT_SSH_COMMAND=ssh git push origin main",
  "git -C /repo push origin main",
  "cd /tmp && git push",
  'echo "a; b" && git push origin main',
  "timeout 30 npm test",
  "ls -la",
];

const PROBE = `
import sys, json, io
sys.path.insert(0, ${JSON.stringify(join(REPO, "bin"))})
import harness_engine as eng
cmds = json.loads(sys.stdin.read())
print(json.dumps([[bool(eng.deny_reason(c)), bool(eng.invokes_git_commit(c))] for c in cmds]))
`;

const probe = spawnSync(PYTHON, ["-c", PROBE], {
  input: JSON.stringify(COMMAND_CASES),
  encoding: "utf8",
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});
if (probe.status !== 0) {
  console.error(`\n[parity] v1 명령 판정 조회 실패: ${probe.stderr}`);
  process.exit(2);
}
const pyResults = JSON.parse(probe.stdout) as Array<[boolean, boolean]>;

let cmdMismatch = 0;
console.log("\n명령 판정 대조:");
for (const [i, cmd] of COMMAND_CASES.entries()) {
  const [pyDeny, pyCommit] = pyResults[i]!;
  const tsDeny = denyReason(cmd) !== null;
  const tsCommit = invokesGitCommit(cmd);
  const ok = pyDeny === tsDeny && pyCommit === tsCommit;
  if (!ok) {
    cmdMismatch++;
    console.log(
      `  불일치 ${cmd}\n          deny py=${pyDeny} ts=${tsDeny} | commit py=${pyCommit} ts=${tsCommit}`,
    );
  }
}
console.log(`  ${COMMAND_CASES.length}건 중 불일치 ${cmdMismatch}건`);

// -- 속성 기반 무작위 장부 대조 --------------------------------------------
// 손으로 고른 사례는 우리가 생각한 것만 덮는다. 무작위 장부를 같은 연산에 먹여
// 두 구현이 같은 답을 내는지 본다. 시드를 고정해 불일치를 재현할 수 있게 한다.

const SEED = Number(process.env["PARITY_SEED"] ?? 20260810);
const ROUNDS = Number(process.env["PARITY_ROUNDS"] ?? 300);

/** 재현 가능한 난수 — Math.random 을 쓰면 실패를 다시 볼 수 없다. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomTracker(rng: () => number): Tracker {
  const n = 1 + Math.floor(rng() * 8);
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  const statuses = ["pending", "pending", "pending", "done", "failed", "blocked", "in_progress"] as const;
  const tasks = ids.map((id, i) => {
    const status = statuses[Math.floor(rng() * statuses.length)]!;
    // 의존은 존재하는 id 중에서 고르되, 가끔 유령 id 를 섞어 교착을 만든다
    const deps: string[] = [];
    const depCount = Math.floor(rng() * 3);
    for (let d = 0; d < depCount; d++) {
      deps.push(rng() < 0.15 ? "유령" : ids[Math.floor(rng() * ids.length)]!);
    }
    return task({
      id, status, deps,
      priority: Math.floor(rng() * 5) * 10,
      attempts: status === "failed" ? Math.floor(rng() * 7) : 0,
      title: `작업 ${i}`,
    });
  });
  return tracker(tasks);
}

const rng = makeRng(SEED);
const randomTrackers = Array.from({ length: ROUNDS }, () => randomTracker(rng));

// 파이썬을 한 번만 띄워 전부 물어본다 — 300번 spawn 하면 측정이 아니라 인내다
const BATCH_PROBE = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(REPO, "bin"))})
import harness_engine as eng
out = []
for t in json.loads(sys.stdin.read()):
    nxt = eng.eligible_next(t)
    out.append({
        "next": nxt["id"] if nxt else None,
        "deadlocked": sorted(x["id"] for x in eng.deadlocked_pending(t)),
        "counts": eng.status_counts(t),
    })
print(json.dumps(out))
`;

const batch = spawnSync(PYTHON, ["-c", BATCH_PROBE], {
  input: JSON.stringify(randomTrackers),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});
if (batch.status !== 0) {
  console.error(`[parity] v1 일괄 조회 실패: ${batch.stderr}`);
  process.exit(2);
}
const pyBatch = JSON.parse(batch.stdout) as Array<{
  next: string | null;
  deadlocked: string[];
  counts: Record<string, number>;
}>;

let propMismatch = 0;
const firstFailures: string[] = [];
for (const [i, t] of randomTrackers.entries()) {
  const py = pyBatch[i]!;
  const tsNext = eligibleNext(t)?.id ?? null;
  const tsDead = deadlockedPending(t).map((x) => x.id).sort();
  const tsCounts = statusCounts(t);
  const same =
    py.next === tsNext &&
    JSON.stringify(py.deadlocked) === JSON.stringify(tsDead) &&
    (["pending", "in_progress", "done", "failed", "blocked"] as const).every(
      (k) => py.counts[k] === tsCounts[k],
    );
  if (!same) {
    propMismatch++;
    if (firstFailures.length < 3) {
      firstFailures.push(
        `    seed=${SEED} idx=${i} next py=${py.next} ts=${tsNext} | ` +
          `dead py=[${py.deadlocked}] ts=[${tsDead}] | 장부=${JSON.stringify(t.tasks)}`,
      );
    }
  }
}
console.log(`속성 기반 대조(seed=${SEED}): ${ROUNDS}건 중 불일치 ${propMismatch}건`);
for (const f of firstFailures) console.log(f);

// -- 커밋 게이트 대조 -------------------------------------------------------
// 게이트 판정이 두 구현에서 갈리면 한쪽 저장소만 막히거나 한쪽만 뚫린다.
// 통과 기록의 1회용 성질까지 같은 답을 내야 한다.
console.log("커밋 게이트 대조:");

const GATE_CASES: Array<{ name: string; commit: string | null; lastRun: unknown; open: boolean }> = [
  { name: "방금 통과", commit: null, lastRun: { task: "done1", ok: true }, open: true },
  { name: "SHA 기록됨(소진)", commit: "abc1234", lastRun: { task: "done1", ok: true }, open: false },
  { name: "done 아닌 작업 기록", commit: null, lastRun: { task: "stuck", ok: true }, open: false },
  { name: "없는 작업 기록", commit: null, lastRun: { task: "유령", ok: true }, open: false },
  { name: "task 없는 옛 기록", commit: null, lastRun: { ok: true }, open: false },
  { name: "실패 기록", commit: null, lastRun: { task: "done1", ok: false }, open: false },
  { name: "기록 없음", commit: null, lastRun: null, open: false },
];

let gateMismatch = 0;
for (const c of GATE_CASES) {
  const sandbox = mkdtempSync(join(tmpdir(), "ah-gate-"));
  try {
    mkdirSync(join(sandbox, ".claude"), { recursive: true });
    const t = tracker([
      { ...task({ id: "done1" }), status: "done", commit: c.commit },
      { ...task({ id: "stuck" }), status: "failed", attempts: 1 },
    ]);
    writeFileSync(join(sandbox, ".claude", "agent_tracker.json"), JSON.stringify(t, null, 2), "utf8");
    writeFileSync(
      join(sandbox, ".claude", "harness-state.json"),
      JSON.stringify({ last_run: c.lastRun, stop_blocks: 0, tracker_hash: null }),
      "utf8",
    );

    const probe = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(REPO, "bin"))})
import harness_engine as eng
print(json.dumps({"open": eng.commit_gate_reason(sys.argv[1]) is None}))
`;
    const r = spawnSync(PYTHON, ["-c", probe, sandbox], {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const pyOpen = JSON.parse(r.stdout || '{"open":null}').open;

    const tsProbe = spawnSync(
      process.execPath,
      ["run", join(REPO, "daemon", "scripts", "gate-probe.ts"), sandbox],
      { encoding: "utf8" },
    );
    const tsOpen = JSON.parse(tsProbe.stdout || '{"open":null}').open;

    const ok = pyOpen === tsOpen && pyOpen === c.open;
    if (!ok) gateMismatch++;
    console.log(
      `  ${ok ? "일치  " : "불일치"} ${c.name.padEnd(18)} py=${pyOpen} ts=${tsOpen} (기대 ${c.open})`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// -- run 대조 ---------------------------------------------------------------
// 종료 코드 계약과 장부 변화가 같아야 한다. 시각·로그 경로는 매 실행 다르므로
// 계약에 해당하는 필드만 본다(status·attempts·exit).
console.log("run 대조:");
const RUN_CASES: Array<{ name: string; tasks: Task[]; test: string; expect: number }> = [
  { name: "성공 -> done", tasks: [task({ id: "a" })], test: "exit 0", expect: 0 },
  { name: "실패 -> failed", tasks: [task({ id: "a" })], test: "exit 1", expect: 1 },
  { name: "한도 도달", tasks: [task({ id: "a", status: "failed", attempts: 4 })], test: "exit 1", expect: 4 },
  { name: "진행 가능 없음", tasks: [task({ id: "a", status: "done" })], test: "exit 0", expect: 3 },
  { name: "blocked 만", tasks: [task({ id: "a", status: "blocked" })], test: "exit 0", expect: 4 },
];

let runMismatch = 0;
for (const c of RUN_CASES) {
  const base = tracker(c.tasks);
  base.commands.test = c.test;
  const results: Array<{ exit: number; status: string | null; attempts: number | null }> = [];

  for (const impl of ["py", "ts"] as const) {
    const sandbox = mkdtempSync(join(tmpdir(), `ah-run-${impl}-`));
    try {
      mkdirSync(join(sandbox, ".claude"), { recursive: true });
      writeFileSync(join(sandbox, ".claude", "agent_tracker.json"), JSON.stringify(base, null, 2), "utf8");
      const r = impl === "py"
        ? spawnSync(PYTHON, [ENGINE, "run", "--repo", sandbox],
                    { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } })
        : spawnSync(process.execPath, ["run", join(REPO, "daemon", "src", "main.ts"), "run", "--repo", sandbox],
                    { encoding: "utf8" });
      const after = JSON.parse(
        readFileSync(join(sandbox, ".claude", "agent_tracker.json"), "utf8"),
      ) as Tracker;
      const t0 = after.tasks[0] ?? null;
      results.push({ exit: r.status ?? -1, status: t0?.status ?? null, attempts: t0?.attempts ?? null });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  const py = results[0]!;
  const ts = results[1]!;
  const ok = py.exit === ts.exit && py.status === ts.status && py.attempts === ts.attempts && py.exit === c.expect;
  if (!ok) runMismatch++;
  console.log(
    `  ${ok ? "일치  " : "불일치"} ${c.name.padEnd(16)} exit py=${py.exit} ts=${ts.exit} (기대 ${c.expect}) | ` +
      `status py=${py.status} ts=${ts.status} | attempts py=${py.attempts} ts=${ts.attempts}`,
  );
}

const total = mismatches + cmdMismatch + propMismatch + runMismatch + gateMismatch;
console.log(
  `대조 ${CASES.length + COMMAND_CASES.length + ROUNDS + RUN_CASES.length + GATE_CASES.length}건 - 불일치 ${total}건`,
);
process.exit(total === 0 ? 0 : 1);
