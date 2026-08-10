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

const total = mismatches + cmdMismatch;
console.log(`\n대조 ${CASES.length + COMMAND_CASES.length}건 — 불일치 ${total}건`);
process.exit(total === 0 ? 0 : 1);
