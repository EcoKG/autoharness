/**
 * 토큰 기반 명령 판정 — v1 이 적대 검증으로 다듬은 결과를 그대로 옮긴다.
 *
 * 문자열 전체를 정규식으로 훑으면 인용부호 안 단어까지 명령으로 오인한다. 실측 오탐:
 * `git log --grep=push`, `grep -r "git push" docs/`, 그리고 **허용해야 할**
 * `git commit -m "push 준비 완료"`. 그래서 따옴표를 존중해 토큰화한 뒤 **첫 토큰이
 * 무엇이고 서브커맨드가 무엇인가**로 판정한다.
 *
 * 반대 방향도 중요하다. 파싱 실패를 그냥 통과시키면 **fail-open 이 곧 우회 경로**가
 * 된다 — 따옴표 하나만 어긋나도 게이트가 사라진다. 구조 판정이 1차이고, 판정 불가일
 * 때만 키워드 안전망이 작동한다.
 */

export const WRAPPER_MAX_DEPTH = 3;

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 값을 하나 더 먹는 git 전역 옵션 — 인자까지 건너뛰어야 서브커맨드를 정확히 찾는다 */
const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
]);
/** 인자를 먹지 않는 수식어 */
const NEUTRAL_PREFIXES = new Set(["env", "command", "nohup", "builtin", "exec", "time", "stdbuf"]);
/** 인자를 N개 먹는 수식어 — 인자 수를 모르면 실제 명령 위치를 놓친다 */
const PREFIX_ARITY: Record<string, number> = { timeout: 1, sudo: 0, nice: 0, ionice: 0, doas: 0 };
const PREFIX_OPTS_WITH_VALUE = new Set(["-n", "-u", "-g", "-k", "--user", "--group"]);
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const PWSH_SHELLS = new Set(["powershell", "pwsh"]);
const EXEC_DELEGATES = new Set(["xargs"]);
const XARGS_OPTS_WITH_VALUE = new Set(["-n", "-P", "-I", "-L", "-d"]);

const FORCE_SUBCOMMANDS = new Set(["branch", "checkout", "switch"]);

/** 원격 상태를 바꾸는 gh 동작 — `git push` 없이도 원격은 바뀐다 */
const GH_WRITE_ACTIONS: Record<string, Set<string>> = {
  pr: new Set(["create", "merge", "close", "reopen", "edit", "ready", "review", "comment"]),
  release: new Set(["create", "delete", "edit", "upload"]),
  repo: new Set(["create", "delete", "edit", "rename", "archive", "sync"]),
  issue: new Set(["create", "close", "reopen", "edit", "comment", "delete", "transfer"]),
  workflow: new Set(["run", "enable", "disable"]),
  secret: new Set(["set", "delete"]),
  variable: new Set(["set", "delete"]),
  gist: new Set(["create", "delete", "edit"]),
  cache: new Set(["delete"]),
  label: new Set(["create", "delete", "edit"]),
};
const GH_WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);
/** 되돌릴 수 없는 로컬 파괴 (서브커맨드, 첫 위치인자) */
const HISTORY_DESTRUCTIVE = new Set([
  "stash:drop", "stash:clear", "reflog:expire", "reflog:delete", "worktree:remove",
]);

/** 판정 불가 세그먼트에만 쓰는 안전망 — 구조 판정의 대체가 아니라 보조다 */
const UNPARSED_RISK_RE =
  /\b(push|--force|--force-with-lease|reset\s+--hard|clean\s+-[A-Za-z]*f|filter-branch|reflog\s+expire)\b/i;

const LINE_CONTINUATION_RE = /\\\r?\n/g;
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "\n", "&"]);

export const UNPARSED = "<unparsed>";

/** 역슬래시 줄바꿈을 접는다 — `git \<개행> push` 가 두 조각으로 갈라지는 것을 막는다 */
export function foldContinuations(command: string): string {
  return (command ?? "").replace(LINE_CONTINUATION_RE, " ");
}

/**
 * 따옴표를 존중하는 토큰화 + 연산자 분할.
 *
 * 문자열을 먼저 구분자로 자르면 따옴표·heredoc 안의 `;`·`|`·개행이 분할점이 되어
 * 정상 명령이 스스로 파싱 불능이 된다(실측: 여러 줄 커밋 메시지가 무검사 통과).
 */
export function commandSegments(command: string): { segments: string[][]; failed: boolean } {
  const text = foldContinuations(command);
  if (!text.trim()) return { segments: [], failed: false };

  const tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;

  const flush = () => {
    if (hasCurrent) {
      tokens.push(current);
      current = "";
      hasCurrent = false;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        i += 1;
        current += text[i];
        hasCurrent = true;
      } else {
        current += ch;
        hasCurrent = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      i += 1;
      current += text[i];
      hasCurrent = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flush();
      continue;
    }
    // 연산자는 독립 토큰으로 — 따옴표 밖에서만 분할점이 된다
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flush();
      tokens.push(two);
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      flush();
      tokens.push(ch);
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  if (quote) return { segments: [], failed: true }; // 따옴표 불균형
  flush();

  const segments: string[][] = [];
  let group: string[] = [];
  for (const t of tokens) {
    if (SHELL_OPERATORS.has(t)) {
      if (group.length > 0) segments.push(group);
      group = [];
    } else {
      group.push(t);
    }
  }
  if (group.length > 0) segments.push(group);
  return { segments, failed: false };
}

export function exeName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  const lower = base.toLowerCase();
  return lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
}

/** 선행 환경변수 대입·수식어를 인자 수까지 고려해 걷어낸다 */
export function stripNeutralPrefix(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (ENV_ASSIGN_RE.test(token)) {
      i += 1;
      continue;
    }
    const name = exeName(token);
    if (NEUTRAL_PREFIXES.has(name)) {
      i += 1;
      continue;
    }
    if (name in PREFIX_ARITY) {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += PREFIX_OPTS_WITH_VALUE.has(tokens[i]!) ? 2 : 1;
      }
      i += PREFIX_ARITY[name]!;
      continue;
    }
    if (EXEC_DELEGATES.has(name)) {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += XARGS_OPTS_WITH_VALUE.has(tokens[i]!) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** git 뒤 전역 옵션을 건너뛰고 실제 서브커맨드를 찾는다 */
export function gitSubcommand(args: readonly string[]): { sub: string | null; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (GIT_OPTS_WITH_VALUE.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i += 1;
      continue;
    }
    return { sub: a, rest: args.slice(i + 1) };
  }
  return { sub: null, rest: [] };
}

export function hasForceFlag(rest: readonly string[]): boolean {
  return rest.some(
    (a) => a === "--force" || a.startsWith("--force-with-lease") || /^-[A-Za-z]*f[A-Za-z]*$/.test(a),
  );
}

/** PowerShell 은 접두사 축약을 허용한다 — -c · -co · … · -command 전부 같은 뜻 */
function isPwshCommandFlag(token: string): boolean {
  const t = token.toLowerCase();
  if (!t.startsWith("-")) return false;
  const body = t.slice(1);
  return body.length > 0 && "command".startsWith(body);
}

function wrapperPayload(
  tokens: readonly string[],
  posix: boolean,
): { payload: string | null; opaque: boolean } {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const low = t.toLowerCase();
    if (posix) {
      if (low === "-c" && i + 1 < tokens.length) return { payload: tokens[i + 1]!, opaque: false };
    } else {
      if (low.startsWith("-encodedcommand") || low === "-e" || low === "-enc") {
        return { payload: null, opaque: true }; // base64 — 구조 판정 불가
      }
      if (isPwshCommandFlag(t) && i + 1 < tokens.length) {
        return { payload: tokens[i + 1]!, opaque: false };
      }
    }
  }
  return { payload: null, opaque: false };
}

export interface Invocation {
  exe: "git" | "gh" | typeof UNPARSED;
  sub: string;
  rest: string[];
  raw?: string;
}

/** 명령 안에서 실제로 실행되는 git/gh 호출을 훑는다. 래퍼는 재귀 분석한다. */
export function* walkInvocations(command: string, depth = 0): Generator<Invocation> {
  if (depth > WRAPPER_MAX_DEPTH) {
    yield { exe: UNPARSED, sub: UNPARSED, rest: [], raw: command };
    return;
  }
  const { segments, failed } = commandSegments(command);
  if (failed) {
    yield { exe: UNPARSED, sub: UNPARSED, rest: [], raw: command };
    return;
  }
  for (const raw of segments) {
    const tokens = stripNeutralPrefix(raw);
    if (tokens.length === 0) continue;
    const exe = exeName(tokens[0]!);
    if (POSIX_SHELLS.has(exe) || PWSH_SHELLS.has(exe)) {
      const { payload, opaque } = wrapperPayload(tokens, POSIX_SHELLS.has(exe));
      if (opaque) yield { exe: UNPARSED, sub: UNPARSED, rest: [], raw: command };
      else if (payload) yield* walkInvocations(payload, depth + 1);
      continue;
    }
    if (exe !== "git" && exe !== "gh") continue;
    const { sub, rest } = gitSubcommand(tokens.slice(1));
    if (sub !== null) yield { exe, sub, rest };
  }
}

function firstPositional(rest: readonly string[]): string | null {
  return rest.find((a) => !a.startsWith("-")) ?? null;
}

function ghDenyReason(group: string, rest: readonly string[]): string | null {
  if (group === "api") {
    for (let i = 0; i < rest.length; i++) {
      const low = rest[i]!.toLowerCase();
      if ((low === "-x" || low === "--method") && i + 1 < rest.length) {
        if (GH_WRITE_METHODS.has(rest[i + 1]!.toLowerCase())) {
          return "gh api 쓰기 요청 금지 — 원격 상태를 바꿉니다";
        }
      }
      if (low.startsWith("--method=") && GH_WRITE_METHODS.has(low.split("=", 2)[1]!)) {
        return "gh api 쓰기 요청 금지 — 원격 상태를 바꿉니다";
      }
    }
    return null;
  }
  const action = firstPositional(rest);
  if (action && GH_WRITE_ACTIONS[group]?.has(action)) {
    return `원격 변경 금지 — gh ${group} ${action} 는 원격 상태를 바꿉니다`;
  }
  return null;
}

function gitDenyReason(sub: string, rest: readonly string[]): string | null {
  if (sub === "push") return "원격 반영(push) 금지 — 로컬 커밋만 허용됩니다";
  if (sub === "subtree" && rest.includes("push")) {
    return "원격 반영(subtree push) 금지 — 로컬 커밋만 허용됩니다";
  }
  if (sub === "reset" && rest.includes("--hard")) return "git reset --hard 금지";
  if (sub === "clean" && hasForceFlag(rest)) return "git clean 강제 삭제 금지";
  if (FORCE_SUBCOMMANDS.has(sub) && hasForceFlag(rest)) return "git --force 계열 금지";
  if (sub === "branch" && rest.includes("-D")) {
    return "git branch -D 금지 — 병합되지 않은 브랜치가 사라집니다";
  }
  if (sub === "checkout" && rest.includes("--")) {
    return "git checkout -- 금지 — 커밋되지 않은 작업물이 사라집니다";
  }
  if (sub === "restore" && !rest.includes("--staged")) {
    return "git restore 금지 — 커밋되지 않은 작업물이 사라집니다";
  }
  const pos = firstPositional(rest);
  if (pos && HISTORY_DESTRUCTIVE.has(`${sub}:${pos}`)) {
    return `git ${sub} ${pos} 금지 — 되돌릴 수 없습니다`;
  }
  if (sub === "filter-branch") return "git filter-branch 금지 — 이력을 되돌릴 수 없게 재작성합니다";
  if (sub === "update-ref" && rest.includes("-d")) return "git update-ref -d 금지 — 참조가 사라집니다";
  return null;
}

/**
 * 차단 사유 문자열, 없으면 null.
 *
 * 막으려는 것은 명령 이름이 아니라 **결과** 둘이다: 원격 상태 변경과 되돌릴 수 없는
 * 로컬 파괴. 구조 판정이 1차이고, 파싱 불가일 때만 키워드 안전망을 쓴다.
 */
export function denyReason(command: string): string | null {
  for (const inv of walkInvocations(command)) {
    if (inv.exe === UNPARSED) {
      if (UNPARSED_RISK_RE.test(inv.raw ?? "")) {
        return "명령 구조를 해석할 수 없는데 위험 키워드가 보입니다 — 확인이 필요합니다";
      }
      continue;
    }
    const reason = inv.exe === "gh" ? ghDenyReason(inv.sub, inv.rest) : gitDenyReason(inv.sub, inv.rest);
    if (reason) return reason;
  }
  return null;
}

/**
 * 커밋을 만드는 서브커맨드 → 그 서브커맨드에서 '커밋 안 함'을 뜻하는 플래그.
 * `commit` 만 보면 revert·merge·cherry-pick 으로 검증 없이 이력이 늘고 SHA 도 안 남는다.
 * `rebase` 는 의도적 제외 — 기존 커밋 재생이라 '검증 안 된 새 작업'이 아니다.
 */
const COMMIT_CREATING: Record<string, readonly string[]> = {
  commit: [],
  revert: ["--no-commit", "-n", "--abort", "--quit"],
  "cherry-pick": ["--no-commit", "-n", "--abort", "--quit"],
  merge: ["--no-commit", "--abort", "--quit"],
  am: ["--abort", "--skip", "--quit"],
};

export function invokesGitCommit(command: string): boolean {
  for (const inv of walkInvocations(command)) {
    if (inv.exe !== "git") continue;
    const negatives = COMMIT_CREATING[inv.sub];
    if (!negatives) continue;
    if (negatives.some((f) => inv.rest.includes(f))) continue;
    return true;
  }
  return false;
}
