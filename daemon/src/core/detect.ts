/**
 * 스택 실측 — **추측하지 않고 파일을 본다.**
 *
 * init 이 제안하는 명령은 여기서 나오지만, 제안은 제안일 뿐이다: 스킬은 이 결과의 명령을
 * 실제로 한 번 돌려 본 뒤에야 장부에 넣는다. 그래서 이 모듈의 책임은 "무엇이 있는가"를
 * 정확히 보고하는 것이지 "무엇이 동작하는가"를 단언하는 것이 아니다.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadJson } from "./load.ts";
import { repoPaths } from "./paths.ts";

export interface StageSuggestion {
  build: string | null;
  test: string | null;
  test_scoped: string | null;
  lint: string | null;
}

export interface GitInfo {
  is_repo: boolean;
  branch: string | null;
  dirty_files: number;
  last_commit: string | null;
}

export interface DetectResult {
  repo: string;
  build_tools: string[];
  multimodule: string[];
  test_dirs: string[];
  tests_present: boolean;
  lint_configs: string[];
  existing_agent_configs: string[];
  suggested_commands: Record<string, StageSuggestion>;
  git: GitInfo;
}

const READ_CAP = 200_000;

const TEST_DIRS = ["src/test", "test", "tests", "__tests__", "spec", "src/androidTest"];
const LINT_CONFIGS = [
  ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs",
  "eslint.config.js", "eslint.config.mjs", "checkstyle.xml", ".golangci.yml",
  ".rubocop.yml", "ruff.toml", ".editorconfig",
];
const AGENT_CONFIGS = ["CLAUDE.md", ".claude", "AGENTS.md", ".cursorrules"];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readCapped(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).slice(0, READ_CAP);
  } catch {
    return "";
  }
}

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!).filter(Boolean);
}

export async function detect(repo: string): Promise<DetectResult> {
  const root = repoPaths(repo).repo;
  if (!(await isDir(root))) throw new Error(`저장소 경로가 없습니다: ${root}`);

  const ex = (...p: string[]) => exists(join(root, ...p));
  const buildTools: string[] = [];
  const multimodule: string[] = [];
  const suggestions: Record<string, StageSuggestion> = {};

  if (await ex("pom.xml")) {
    buildTools.push("maven");
    const pom = await readCapped(join(root, "pom.xml"));
    multimodule.push(...matchAll(pom, /<module>([^<]+)<\/module>/g));
    suggestions["maven"] = {
      build: "mvn -B -q compile",
      test: "mvn -B verify",
      test_scoped: "mvn -B verify -pl {path} -am",
      lint: pom.includes("checkstyle")
        ? "mvn -B checkstyle:check"
        : pom.includes("spotless")
          ? "mvn -B spotless:check"
          : null,
    };
  }
  if ((await ex("build.gradle")) || (await ex("build.gradle.kts"))) {
    buildTools.push("gradle");
    const settings =
      (await readCapped(join(root, "settings.gradle"))) +
      (await readCapped(join(root, "settings.gradle.kts")));
    multimodule.push(...matchAll(settings, /include\s*[(\s]['"]([^'"]+)['"]/g));
    const gw = (await ex("gradlew")) ? "gradlew" : "gradle";
    suggestions["gradle"] = {
      build: `${gw} build -x test`,
      test: `${gw} test`,
      test_scoped: `${gw} {path}:test`,
      lint: null,
    };
  }
  if (await ex("package.json")) {
    buildTools.push("node");
    const pkgLoad = await loadJson<Record<string, unknown>>(join(root, "package.json"));
    const pkg = pkgLoad.state === "ok" && pkgLoad.value ? pkgLoad.value : {};
    const scripts = (pkg["scripts"] ?? {}) as Record<string, unknown>;
    const ws = pkg["workspaces"];
    if (Array.isArray(ws)) multimodule.push(...ws.map(String));
    else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
      multimodule.push(...((ws as { packages: unknown[] }).packages.map(String)));
    }
    suggestions["node"] = {
      build: "build" in scripts ? "npm run build" : null,
      test: "test" in scripts ? "npm test" : null,
      test_scoped: JSON.stringify(pkg).includes("jest") ? "npx jest {path}" : null,
      lint: "lint" in scripts ? "npm run lint" : null,
    };
  }
  if ((await ex("pyproject.toml")) || (await ex("setup.py"))) {
    buildTools.push("python");
    const py = await readCapped(join(root, "pyproject.toml"));
    suggestions["python"] = {
      build: null,
      test: "python -m pytest -x -q",
      test_scoped: "python -m pytest -x -q {path}",
      lint: py.includes("ruff") ? "python -m ruff check ." : null,
    };
  }
  if (await ex("go.mod")) {
    buildTools.push("go");
    suggestions["go"] = {
      build: "go build ./...", test: "go test ./...",
      test_scoped: "go test ./{path}/...", lint: null,
    };
  }
  if (await ex("Gemfile")) {
    buildTools.push("ruby");
    suggestions["ruby"] = {
      build: null, test: "bundle exec rspec",
      test_scoped: "bundle exec rspec {path}", lint: null,
    };
  }
  if (await ex("Cargo.toml")) {
    buildTools.push("rust");
    suggestions["rust"] = {
      build: "cargo build", test: "cargo test",
      test_scoped: "cargo test -p {path}", lint: "cargo clippy -- -D warnings",
    };
  }
  if (await ex("bun.lockb") || (await ex("bunfig.toml"))) {
    // v2 자신이 Bun 프로젝트다 — 실측 대상에서 스스로를 빠뜨리지 않는다
    if (!buildTools.includes("bun")) buildTools.push("bun");
    suggestions["bun"] = {
      build: "bun run build", test: "bun test",
      test_scoped: "bun test {path}", lint: "bun run typecheck",
    };
  }

  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    entries = [];
  }
  if (entries.some((e) => e.endsWith(".sln") || e.endsWith(".csproj"))) {
    buildTools.push("dotnet");
    suggestions["dotnet"] = {
      build: "dotnet build", test: "dotnet test",
      test_scoped: "dotnet test {path}", lint: null,
    };
  }

  const testDirs: string[] = [];
  for (const d of TEST_DIRS) if (await isDir(join(root, ...d.split("/")))) testDirs.push(d);
  const lintConfigs: string[] = [];
  for (const f of LINT_CONFIGS) if (await ex(f)) lintConfigs.push(f);
  const agentConfigs: string[] = [];
  for (const f of AGENT_CONFIGS) if (await ex(f)) agentConfigs.push(f);

  return {
    repo: root,
    build_tools: buildTools,
    multimodule,
    test_dirs: testDirs,
    tests_present: testDirs.length > 0,
    lint_configs: lintConfigs,
    existing_agent_configs: agentConfigs,
    suggested_commands: suggestions,
    git: {
      is_repo: (await git(root, ["rev-parse", "--is-inside-work-tree"])) === "true",
      branch: await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty_files: ((await git(root, ["status", "--porcelain"])) ?? "").split("\n").filter(Boolean).length,
      last_commit: await git(root, ["log", "-1", "--oneline"]),
    },
  };
}

const CODE_EXTS = [
  ".java", ".kt", ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rb", ".rs",
  ".cs", ".cpp", ".c", ".h", ".scala", ".groovy", ".php", ".swift",
];
const SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "build", "dist", "out", "vendor",
  ".venv", "venv", "bin", "obj", ".idea", ".gradle", "__pycache__",
]);

/** 코드 규모 추정 — 정확한 계수가 아니라 모델 추천의 구간 판정용이다(1줄 ≈ 35바이트 가정). */
export async function estimateLoc(repo: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let items: import("node:fs").Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) await walk(full);
      } else if (CODE_EXTS.some((e) => item.name.endsWith(e))) {
        try {
          total += (await stat(full)).size;
        } catch {
          /* 접근 불가 파일은 추정에서 뺀다 — 실패가 전체를 멈추지 않는다 */
        }
      }
    }
  };
  await walk(repoPaths(repo).repo);
  return Math.floor(total / 35);
}
