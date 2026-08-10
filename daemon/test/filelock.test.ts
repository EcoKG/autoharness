/**
 * 프로세스 간 잠금 회귀 — **갱신 소실이 실제로 사라지는가.**
 *
 * 이 파일의 핵심은 마지막 describe 다: 진짜로 여러 프로세스를 띄워 같은 레지스트리에
 * 동시에 쓰고, 아무 갱신도 사라지지 않음을 센다. 잠금 없이 같은 부하를 주면 갱신이
 * 사라지므로(설계상 그럴 수밖에 없다) 이 테스트가 잠금의 존재 이유를 증명한다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCK_STALE_MS,
  LockTimeoutError,
  inspectLock,
  isContendedError,
  withFileLock,
  writeLockFor,
} from "../src/core/filelock.ts";
import { userPaths } from "../src/core/paths.ts";
import {
  defaultRegistry,
  loadRegistryChecked,
  mutateRegistry,
  saveRegistry,
  upsertProject,
} from "../src/core/registry.ts";

let home = "";
let lockPath = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ah-lk-"));
  env = { ...process.env, AUTOHARNESS_HOME: home };
  lockPath = join(home, "test.lock");
  await mkdir(userPaths(env).runtimeDir, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("배타성", () => {
  test("잠금 안에서만 실행되고 끝나면 파일이 사라진다", async () => {
    const r = await withFileLock(lockPath, async () => {
      expect(await Bun.file(lockPath).exists()).toBe(true);
      return 42;
    });
    expect(r).toBe(42);
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("예외가 나도 잠금을 반드시 푼다", async () => {
    await expect(
      withFileLock(lockPath, () => {
        throw new Error("안에서 터짐");
      }),
    ).rejects.toThrow("안에서 터짐");
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("같은 프로세스의 동시 호출도 직렬화된다", async () => {
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(lockPath, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await Bun.sleep(5);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1); // 한 번에 하나만 안에 있었다
  });

  test("보유자 정보를 남긴다 — 누가 붙들고 있는지 진단할 수 있어야 한다", async () => {
    await withFileLock(lockPath, async () => {
      const holder = await inspectLock(lockPath);
      expect(holder?.pid).toBe(process.pid);
      expect(typeof holder?.at).toBe("string");
    });
  });
});

describe("죽은 잠금 처리", () => {
  test("죽은 pid 의 잠금은 탈취한다 — 크래시 하나가 영영 막지 않는다", async () => {
    await writeLockFor(lockPath, 2 ** 30);
    const r = await withFileLock(lockPath, () => "잡았다", { timeoutMs: 2000 });
    expect(r).toBe("잡았다");
  });

  test("오래된 잠금은 pid 가 살아 있어도 탈취한다", async () => {
    await writeLockFor(lockPath, process.pid);
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    await utimes(lockPath, old, old);
    expect(await withFileLock(lockPath, () => "잡았다", { timeoutMs: 2000 })).toBe("잡았다");
  });

  test("살아 있는 잠금은 상한까지 기다린 뒤 던진다 — 조용히 통과시키지 않는다", async () => {
    await writeLockFor(lockPath, process.pid); // 이 프로세스는 살아 있다
    const started = Date.now();
    await expect(withFileLock(lockPath, () => 1, { timeoutMs: 150 })).rejects.toThrow(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    // 남의 잠금을 지우지 않았다
    expect(await Bun.file(lockPath).exists()).toBe(true);
  });

  test("경합 오류를 하드 오류와 구분한다 — 윈도우는 EEXIST 만 주지 않는다", () => {
    // 실측 재현: 같은 프로세스에서 동시에 갱신하다 EPERM 으로 죽었다. Windows 는
    // 삭제 대기 중인 파일에 EPERM/EACCES 를, 공유 위반에 EBUSY 를 준다 — 전부 재시도 대상이다.
    for (const code of ["EEXIST", "EPERM", "EACCES", "EBUSY"]) {
      expect(isContendedError(Object.assign(new Error(code), { code })), code).toBe(true);
    }
    for (const code of ["ENOENT", "ENOSPC", "EROFS"]) {
      expect(isContendedError(Object.assign(new Error(code), { code })), code).toBe(false);
    }
    expect(isContendedError(new Error("코드 없음"))).toBe(false);
  });

  test("경합이 잦아도 결국 전부 잠금을 얻는다", async () => {
    // 위 분류가 틀리면 여기서 EPERM 이 그대로 튀어나와 실패한다
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withFileLock(lockPath, () => i, { timeoutMs: 10_000 }),
      ),
    );
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  }, 30_000);

  test("깨진 잠금 파일은 살아 있는 것으로 보지 않는다", async () => {
    await writeFile(lockPath, "JSON 아님", "utf8");
    // 보유자를 못 읽으면 나이로만 판정한다 — 방금 만든 것이므로 상한까지 기다린다
    await expect(withFileLock(lockPath, () => 1, { timeoutMs: 120 })).rejects.toThrow(LockTimeoutError);
  });
});

describe("레지스트리가 잠금을 쓴다", () => {
  test("mutateRegistry 는 잠금 안에서 돈다", async () => {
    await saveRegistry(defaultRegistry(), env);
    let sawLock = false;
    await mutateRegistry(async (reg) => {
      sawLock = await Bun.file(userPaths(env).registryLock).exists();
      reg.last_tick = "표시";
    }, env);
    expect(sawLock).toBe(true);
    expect(await Bun.file(userPaths(env).registryLock).exists()).toBe(false);
    expect((await loadRegistryChecked(env)).registry.last_tick).toBe("표시");
  });

  test("같은 프로세스의 동시 갱신이 서로를 덮지 않는다", async () => {
    await saveRegistry(defaultRegistry(), env);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutateRegistry((reg) => {
          upsertProject(reg, {
            id: `p${i}`, repo: join(home, `r${i}`), model: "claude-opus-5", permissionArgs: [],
          });
        }, env),
      ),
    );
    const reg = (await loadRegistryChecked(env)).registry;
    expect(reg.projects.length).toBe(10);
  });

  test("v1 과 같은 잠금 파일을 쓴다 — 마이그레이션 중 공존해도 서로를 덮지 않는다", () => {
    expect(userPaths(env).registryLock).toBe(join(userPaths(env).runtimeDir, "registry.lock"));
  });
});

/**
 * 진짜 계약 — 별개 프로세스들이 동시에 쓴다.
 * 이것이 통과해야 "갱신 소실이 없다" 고 말할 수 있다. 프로세스가 다르면 프라미스 직렬화도
 * 저장 직전 재읽기도 소용없기 때문이다.
 */
describe("프로세스 간 동시 쓰기", () => {
  /**
   * 실제 호출자처럼 행동한다: 잠금 대기가 상한을 넘으면 **다시 시도한다**.
   * 시끄러운 실패(LockTimeout)는 설계된 동작이므로 그것을 실패로 세면 안 되고, 반대로
   * 그 때문에 갱신을 포기해도 안 된다. 잠금이 깨졌다면 여기서 갱신이 사라져 테스트가 죽는다.
   */
  const WRITER = `
const home = process.argv[2];
const id = process.argv[3];
process.env.AUTOHARNESS_HOME = home;
const { mutateRegistry, upsertProject } = await import(process.argv[4]);
for (let i = 0; i < 5; i++) {
  for (let attempt = 0; ; attempt++) {
    try {
      await mutateRegistry((reg) => {
        upsertProject(reg, { id: id + "-" + i, repo: home + "/" + id + "-" + i,
                             model: "claude-opus-5", permissionArgs: [] });
      }, process.env);
      break;
    } catch (err) {
      if (attempt >= 20 || !String(err).includes("잠금")) throw err;
      await Bun.sleep(20 + attempt * 10);
    }
  }
}
`;

  test("여러 프로세스가 25건을 넣어도 하나도 사라지지 않는다", async () => {
    await saveRegistry(defaultRegistry(), env);
    const script = join(home, "writer.mjs");
    await writeFile(script, WRITER, "utf8");
    const registryModule = Bun.pathToFileURL(
      join(import.meta.dir, "..", "src", "core", "registry.ts"),
    ).href;

    const procs = ["a", "b", "c", "d", "e"].map((id) =>
      Bun.spawn([process.execPath, "run", script, home, id, registryModule], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, AUTOHARNESS_HOME: home },
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    for (const [i, code] of codes.entries()) {
      if (code !== 0) throw new Error(`writer ${i} 실패: ${await new Response(procs[i]!.stderr).text()}`);
    }

    const reg = (await loadRegistryChecked(env)).registry;
    expect(reg.projects.length).toBe(25); // 5 프로세스 × 5건 — 하나도 잃지 않았다
    const ids = new Set(reg.projects.map((p) => p.id));
    expect(ids.size).toBe(25);
  }, 60_000);

  test("잠금 파일이 뒤에 남지 않는다", async () => {
    expect(await Bun.file(userPaths(env).registryLock).exists()).toBe(false);
  });
});

describe("v1 파이썬 구현과의 상호 운용", () => {
  test("파이썬이 쥔 잠금을 v2 가 존중한다", async () => {
    // v1 이 쓰는 것과 같은 모양의 잠금 파일(pid + at)을 만들어 둔다
    await writeLockFor(userPaths(env).registryLock, process.pid);
    try {
      await expect(
        mutateRegistry(() => {}, env, { timeoutMs: 150 }),
      ).rejects.toThrow(LockTimeoutError);
    } finally {
      await rm(userPaths(env).registryLock, { force: true });
    }
  });

  test("잠금 파일 형식이 v1 이 읽는 모양이다", async () => {
    await withFileLock(lockPath, async () => {
      const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; at: string };
      expect(typeof raw.pid).toBe("number");
      expect(Date.parse(raw.at)).toBeGreaterThan(0);
      expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(0);
    });
  });
});
