/**
 * 저장소 마이그레이션 회귀 — **장부 불변이 제1 원칙이다.**
 *
 * 대상은 이미 주행 중인 저장소다. 장부에는 수십 건의 완료 이력과 커밋 SHA 가 들어 있고
 * 잃으면 되돌릴 방법이 없다. 그래서 여기서 가장 강하게 고정하는 것은 "훅만 바뀌고
 * 장부는 한 바이트도 안 바뀐다" 이다.
 *
 * 그 다음이 공존 안전성이다. 이행 도중 v1 훅과 v2 훅이 동시에 걸려 있어도 장부가 깨지지
 * 않아야 한 번에 끝내지 않아도 되고, 그래야 롤백이 현실적인 선택지가 된다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTracker, loadTracker, newTask, saveTracker } from "../src/core/ledger.ts";
import { repoPaths } from "../src/core/paths.ts";
import { REPO_PIN_FLAG, hookWiringStatus } from "../src/hooks/wiring.ts";
import { migrateRepo, rollbackInstructions, rollbackRepo } from "../src/install/migrate.ts";
import { hookCommandPathIsDead, mergeSettings } from "../src/install/settings.ts";

let repo = "";
let home = "";
let env: NodeJS.ProcessEnv = {};
const EXE = process.platform === "win32" ? "C:/tools/autoharness.exe" : "/usr/local/bin/autoharness";

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ah-mig-"));
  home = await mkdtemp(join(tmpdir(), "ah-mighome-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  await mkdir(repoPaths(repo).claudeDir, { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const V1_ENGINE = 'python "${CLAUDE_PROJECT_DIR}/scripts/harness_engine.py"';

/** 실제 주행 중인 저장소의 모습 — v1 훅 4종 + 진행 이력이 든 장부. */
async function seedV1Repo(opts: { matcher?: string; pinned?: boolean } = {}): Promise<string> {
  const matcher = opts.matcher ?? "Bash";
  const pin = opts.pinned ? ` ${REPO_PIN_FLAG}` : "";
  const cmd = (op: string) => `${V1_ENGINE} ${op}${pin}`;
  await writeFile(
    join(repoPaths(repo).claudeDir, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: cmd("brief") }] }],
          PreToolUse: [{ matcher, hooks: [{ type: "command", command: cmd("hook-prebash") }] }],
          PostToolUse: [{ matcher, hooks: [{ type: "command", command: cmd("hook-postbash") }] }],
          Stop: [{ hooks: [{ type: "command", command: cmd("hook-stop") }] }],
        },
        permissions: { allow: ["Bash(기존 규칙:*)"] },
      },
      null,
      2,
    ),
    "utf8",
  );

  const t = createTracker({ project: "주행중", objective: "o", source: "A", target: "B", test: "exit 0" });
  t.tasks = [
    { ...newTask("done1", "완료된 작업"), status: "done", commit: "abc1234", attempts: 2 },
    { ...newTask("done2", "또 완료"), status: "done", commit: "def5678" },
    newTask("todo", "남은 작업"),
  ];
  await saveTracker(repo, t);
  return readFile(repoPaths(repo).tracker, "utf8");
}

describe("장부 불변", () => {
  test("마이그레이션이 장부를 한 바이트도 바꾸지 않는다", async () => {
    const before = await seedV1Repo();
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.ledgerIntact).toBe(true);
    expect(await readFile(repoPaths(repo).tracker, "utf8")).toBe(before);
  });

  test("완료 이력과 커밋 SHA 가 그대로 남는다", async () => {
    await seedV1Repo();
    await migrateRepo(repo, { exePath: EXE, env });
    const { tracker } = await loadTracker(repo);
    expect(tracker!.tasks.length).toBe(3);
    expect(tracker!.tasks.filter((t) => t.status === "done").length).toBe(2);
    expect(tracker!.tasks.find((t) => t.id === "done1")!.commit).toBe("abc1234");
    expect(tracker!.tasks.find((t) => t.id === "done1")!.attempts).toBe(2);
  });

  test("보고서가 장부 규모를 함께 알린다 — 무엇을 지켰는지 보이게", async () => {
    await seedV1Repo();
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.ledgerTasks).toBe(3);
  });
});

describe("훅 배선 교체", () => {
  test("v1 훅이 전부 v2 EXE 로 바뀐다", async () => {
    await seedV1Repo();
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.ok).toBe(true);
    expect(report.before.every((h) => h.legacy)).toBe(true);
    expect(report.after.some((h) => h.legacy)).toBe(false);
    expect(report.after.every((h) => h.command.includes(EXE))).toBe(true);
  });

  test("matcher 커버리지도 함께 최신화된다", async () => {
    await seedV1Repo({ matcher: "Bash" });
    await migrateRepo(repo, { exePath: EXE, env });
    const wiring = await hookWiringStatus(repo);
    expect(wiring.uncovered_tools).toEqual([]);
  });

  test("--repo 를 못 박는다 — 하위 디렉토리에서 게이트가 사라지지 않게", async () => {
    await seedV1Repo();
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.after.every((h) => !h.repoUnpinned)).toBe(true);
    expect(report.after.every((h) => h.command.includes("--repo"))).toBe(true);
  });

  test("훅 4종이 모두 남는다 — 부분 등록으로 후퇴하지 않는다", async () => {
    await seedV1Repo();
    await migrateRepo(repo, { exePath: EXE, env });
    const wiring = await hookWiringStatus(repo);
    expect(wiring.missing_hooks).toEqual([]);
  });

  test("기존 권한 규칙을 지운다거나 하지 않는다", async () => {
    await seedV1Repo();
    await migrateRepo(repo, { exePath: EXE, env });
    const settings = JSON.parse(
      await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8"),
    ) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain("Bash(기존 규칙:*)");
  });

  test("이미 v2 면 할 일이 없다고 알린다", async () => {
    await seedV1Repo();
    await migrateRepo(repo, { exePath: EXE, env });
    const again = await migrateRepo(repo, { exePath: EXE, env });
    expect(again.ok).toBe(true);
    expect(again.notes.join(" ")).toContain("이미 v2");
  });

  test("훅이 없는 저장소는 조용히 넘기지 않고 사유를 남긴다", async () => {
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.notes.join(" ")).toContain("등록돼 있지 않");
  });
});

describe("dry-run 과 롤백", () => {
  test("dry-run 은 아무것도 바꾸지 않고 계획만 알린다", async () => {
    const before = await seedV1Repo();
    const settingsBefore = await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8");
    const report = await migrateRepo(repo, { exePath: EXE, env, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.backup).toBeNull();
    expect(await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8")).toBe(settingsBefore);
    expect(await readFile(repoPaths(repo).tracker, "utf8")).toBe(before);
    expect(report.notes.join(" ")).toContain("(dry-run)");
  });

  test("백업을 남기고 그 경로를 결과에 싣는다", async () => {
    await seedV1Repo();
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.backup).toBeTruthy();
    expect(await Bun.file(report.backup!).exists()).toBe(true);
  });

  test("롤백이 원래 배선을 되돌린다", async () => {
    await seedV1Repo();
    const original = await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8");
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8")).not.toBe(original);

    const r = await rollbackRepo(repo, report.backup!);
    expect(r.ok).toBe(true);
    expect(await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8")).toBe(original);
  });

  test("롤백 절차가 값으로 전달된다 — 문서를 찾아 헤매지 않게", async () => {
    await seedV1Repo();
    const report = await migrateRepo(repo, { exePath: EXE, env });
    const steps = rollbackInstructions(report);
    expect(steps.join("\n")).toContain(report.backup!);
    expect(steps.join("\n")).toContain("장부는 건드리지 않았으므로");
  });

  test("백업이 없으면 되돌릴 것이 없다고 알린다", async () => {
    const report = await migrateRepo(repo, { exePath: EXE, env, dryRun: true });
    expect(rollbackInstructions(report).join(" ")).toContain("되돌릴 것이 없");
  });

  test("없는 백업으로 롤백하면 실패를 알린다", async () => {
    const r = await rollbackRepo(repo, join(repo, "없는백업.json"));
    expect(r.ok).toBe(false);
  });
});

describe("v1·v2 공존", () => {
  test("v1 훅과 v2 훅이 섞여 있어도 장부가 깨지지 않는다", async () => {
    // 이행 도중의 실제 모습: PreToolUse 만 v2 로 바뀌고 나머지는 v1 인 상태
    const before = await seedV1Repo();
    await writeFile(
      join(repoPaths(repo).claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash|PowerShell",
            hooks: [{ type: "command", command: `"${EXE}" hook-prebash ${REPO_PIN_FLAG}` }],
          }],
          Stop: [{ hooks: [{ type: "command", command: `${V1_ENGINE} hook-stop` }] }],
        },
      }, null, 2),
      "utf8",
    );

    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.ledgerIntact).toBe(true);
    expect(await readFile(repoPaths(repo).tracker, "utf8")).toBe(before);
    // 섞인 상태에서도 진단은 두 훅을 모두 하네스 훅으로 인식한다
    const wiring = await hookWiringStatus(repo);
    expect(wiring.registered.length).toBeGreaterThanOrEqual(2);
  });

  test("공존 상태를 마이그레이션하면 v1 쪽만 바뀐다", async () => {
    await seedV1Repo();
    await writeFile(
      join(repoPaths(repo).claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash|PowerShell",
            hooks: [{ type: "command", command: `"${EXE}" hook-prebash ${REPO_PIN_FLAG}` }],
          }],
          Stop: [{ hooks: [{ type: "command", command: `${V1_ENGINE} hook-stop` }] }],
        },
      }, null, 2),
      "utf8",
    );
    const report = await migrateRepo(repo, { exePath: EXE, env });
    expect(report.after.every((h) => !h.legacy)).toBe(true);
    expect(report.after.every((h) => h.command.includes(EXE))).toBe(true);
  });
});

/**
 * 훅 명령에는 설치 시점의 절대 EXE 경로가 박히는데 `.claude/settings.json` 은 저장소를
 * 따라 다닌다 — 다른 계정·다른 기계로 옮기면 그 경로가 사라진다. 실측(2026-08-11):
 * 이 저장소가 `C:\Users\ruinp\...\autoharness.exe` 를 부르는 채로 다른 계정에 있었고,
 * 게이트 4종이 전부 무효였는데 진단은 그것을 '한 번도 발화 안 함'으로만 말했다.
 *
 * 살아 있는 쪽 대조군은 **basename 이 autoharness 인 실존 파일**이어야 한다.
 * `process.execPath` 는 bun 을 가리켜 하네스 훅으로 인식조차 되지 않으므로 대조가 안 된다.
 */
describe("죽은 절대 경로 복구", () => {
  const DEAD_EXE = join(tmpdir(), "ah-없는폴더", "autoharness.exe");
  let liveExe = "";

  beforeEach(async () => {
    liveExe = join(repo, "bin", "autoharness.exe");
    await mkdir(join(repo, "bin"), { recursive: true });
    await writeFile(liveExe, "", "utf8");
  });

  /** 훅 4종을 주어진 실행 파일로 심는다(설치가 만드는 모양 그대로). */
  async function seedRepoWith(exe: string): Promise<void> {
    const cmd = (op: string) => `"${exe}" ${op} ${REPO_PIN_FLAG}`;
    const matcher = "Bash|PowerShell";
    await writeFile(
      join(repoPaths(repo).claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: cmd("brief") }] }],
          PreToolUse: [{ matcher, hooks: [{ type: "command", command: cmd("hook-prebash") }] }],
          PostToolUse: [{ matcher, hooks: [{ type: "command", command: cmd("hook-postbash") }] }],
          Stop: [{ hooks: [{ type: "command", command: cmd("hook-stop") }] }],
        },
      }, null, 2),
      "utf8",
    );
    const t = createTracker({ project: "p", objective: "o", source: "A", target: "B", test: "exit 0" });
    t.tasks = [newTask("todo", "남은 작업")];
    await saveTracker(repo, t);
  }

  /** settings.json 안의 훅 명령 전부 — 경로 이스케이프에 기대지 않고 값으로 본다. */
  async function hookCommands(): Promise<string[]> {
    const raw = JSON.parse(
      await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    return Object.values(raw.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((h) => h.command)),
    );
  }

  test("진단이 broken_path 로 드러낸다 — inactive 로 뭉개지 않는다", async () => {
    await seedRepoWith(DEAD_EXE);
    const wiring = await hookWiringStatus(repo);
    expect(wiring.state).toBe("broken_path");
    expect(wiring.dead_engine_hooks.length).toBe(4); // 훅 명령 4종 전부가 죽은 경로다
    expect(wiring.warning).toContain("실존하지 않는 실행 파일");
  });

  test("설치가 죽은 경로를 현재 실행 파일로 다시 쓴다", async () => {
    await seedRepoWith(DEAD_EXE);
    const result = await mergeSettings(repo, { exePath: liveExe });
    const commands = await hookCommands();
    expect(commands.length).toBe(4);
    expect(commands.every((c) => !c.includes("없는폴더"))).toBe(true);
    expect(commands.every((c) => c.includes(liveExe))).toBe(true);
    expect(result.migrated_hooks.length).toBe(4);
    expect((await hookWiringStatus(repo)).dead_engine_hooks).toEqual([]);
    expect((await hookWiringStatus(repo)).state).not.toBe("broken_path");
  });

  test("다시 쓰기 전에 기존 설정을 백업한다", async () => {
    await seedRepoWith(DEAD_EXE);
    const before = await readFile(join(repoPaths(repo).claudeDir, "settings.json"), "utf8");
    const result = await mergeSettings(repo, { exePath: liveExe });
    expect(result.backup).not.toBeNull();
    expect(await readFile(result.backup!, "utf8")).toBe(before);
  });

  test("살아 있는 경로는 건드리지 않는다 (오탐 금지)", async () => {
    await seedRepoWith(liveExe);
    const before = await hookCommands();
    const result = await mergeSettings(repo, { exePath: liveExe });
    expect(result.migrated_hooks).toEqual([]);
    expect(result.skipped_hooks.length).toBe(4);
    expect(await hookCommands()).toEqual(before);
  });

  test("--repo 고정은 죽은 경로를 고치면서도 유지된다", async () => {
    await seedRepoWith(DEAD_EXE);
    await mergeSettings(repo, { exePath: liveExe });
    expect((await hookCommands()).every((c) => c.includes("--repo"))).toBe(true);
    expect((await hookWiringStatus(repo)).repo_unpinned_hooks).toEqual([]);
  });

  test("hookCommandPathIsDead 는 확인 불가 형태를 죽었다고 하지 않는다", async () => {
    expect(await hookCommandPathIsDead(`"${DEAD_EXE}" hook-stop`, repo)).toBe(true);
    expect(await hookCommandPathIsDead(`"${liveExe}" hook-stop`, repo)).toBe(false);
    expect(await hookCommandPathIsDead("autoharness hook-stop", repo)).toBe(false); // PATH 해석
    expect(await hookCommandPathIsDead("git status", repo)).toBe(false); // 하네스 훅이 아니다
  });
});
