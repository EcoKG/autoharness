/**
 * 명령 판정 회귀 — v1 이 적대 검증으로 얻은 사례를 그대로 옮긴다.
 *
 * 특히 두 방향을 모두 고정한다: 오탐(정상 작업을 막으면 사람이 게이트를 꺼 버린다)과
 * 미탐(파싱 실패·래퍼·줄 연속으로 게이트를 빠져나가는 경로).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  UNPARSED,
  commandSegments,
  denyReason,
  exeName,
  foldContinuations,
  gitSubcommand,
  hasForceFlag,
  invokesGitCommit,
  stripNeutralPrefix,
  walkInvocations,
} from "../src/hooks/command.ts";

const G = "git";
const denied = (cmd: string) => expect(denyReason(cmd), cmd).not.toBeNull();
const allowed = (cmd: string) => expect(denyReason(cmd), cmd).toBeNull();

describe("차단 — 원격 상태 변경", () => {
  test("git push 계열", () => {
    for (const c of [`${G} push origin main`, `${G} push origin 기능-브랜치`,
      `${G} push --force`, `${G} push --force-with-lease origin main`,
      `${G} subtree push --prefix=dist origin gh-pages`]) denied(c);
  });

  test("gh 쓰기 동사 — push 없이도 원격은 바뀐다", () => {
    for (const c of ["gh pr create --title x", "gh pr merge 12 --auto", "gh release create v1",
      "gh repo delete owner/x", "gh workflow run deploy.yml", "gh secret set TOKEN",
      "gh issue create --title x", "gh gist create f.txt"]) denied(c);
  });

  test("gh api 쓰기 메서드", () => {
    for (const c of ["gh api -X POST /repos/x/y/issues", "gh api --method DELETE /x",
      "gh api --method=PATCH /x", "gh api -X put /x"]) denied(c);
  });
});

describe("차단 — 되돌릴 수 없는 로컬 파괴", () => {
  test("작업물·이력 파괴", () => {
    for (const c of [`${G} reset --hard HEAD~1`, `${G} clean -fd`, `${G} clean -d -f`,
      `${G} clean --force`, `${G} branch -D feature`, `${G} branch --force main`,
      `${G} checkout -f main`, `${G} checkout -- .`, `${G} restore src/`,
      `${G} stash drop`, `${G} stash clear`, `${G} reflog expire --expire=now --all`,
      `${G} filter-branch --tree-filter x HEAD`, `${G} update-ref -d refs/heads/x`,
      `${G} worktree remove wt`]) denied(c);
  });
});

describe("허용 — 오탐이 정상 작업을 막으면 사람이 게이트를 끈다", () => {
  test("읽기 전용 git·gh", () => {
    for (const c of [`${G} status`, `${G} log --oneline`, `${G} remote -v`, `${G} diff HEAD`,
      `${G} reflog`, `${G} stash list`, `${G} stash pop`, `${G} worktree list`,
      "gh pr list", "gh pr view 12", "gh release list", "gh api /repos/x/y",
      "gh api -X GET /x", "gh pr checks"]) allowed(c);
  });

  test("인용부호 안 언급은 명령이 아니다", () => {
    for (const c of [`grep -r "${G} push" docs/`, `echo "${G} push 하지 마세요"`,
      `${G} log --grep=push`, `${G} log --grep="push origin"`]) allowed(c);
  });

  test("메시지에 위험 단어가 든 로컬 커밋", () => {
    allowed(`${G} commit -m "push 준비 완료"`);
    allowed(`${G} commit -m "원격 반영 전 정리"`);
  });

  test("비파괴 변형", () => {
    for (const c of [`${G} reset --soft HEAD~1`, `${G} restore --staged file.txt`,
      `${G} branch -d merged`, `${G} branch feature`, `${G} checkout main`,
      `${G} clean -n`, `${G} clean --dry-run`]) allowed(c);
  });

  test("무관한 명령", () => {
    for (const c of ["ls -la", "echo push", "npm run build"]) allowed(c);
  });
});

describe("우회 경로 — v1 정규식이 놓치던 것들", () => {
  test("래퍼 안의 실제 명령", () => {
    for (const c of [`bash -c '${G} push origin main'`, `sh -c "${G} push"`,
      `powershell -Command "${G} push origin main"`, `pwsh -c '${G} reset --hard'`]) denied(c);
  });

  test("PowerShell 플래그 접두사 축약", () => {
    for (const flag of ["-Command", "-command", "-Comm", "-co", "-c"]) {
      denied(`powershell ${flag} "${G} push origin main"`);
    }
  });

  test("EncodedCommand 는 판정 불가로 게이트", () => {
    denied("powershell -EncodedCommand cAB1AHMAaAA= push");
  });

  test("역슬래시 줄바꿈", () => {
    denied(`${G} \\\n  push origin main`);
    denied(`${G} \\\r\n  reset --hard HEAD~1`);
  });

  test("수식어 접두 — 인자 수를 알아야 명령 위치를 찾는다", () => {
    for (const c of [`timeout 30 ${G} push origin main`, `nice -n 10 ${G} push`,
      `sudo -u deploy ${G} push`, `xargs ${G} push`, `xargs -n 1 ${G} push`,
      `GIT_SSH_COMMAND=ssh ${G} push origin main`]) denied(c);
  });

  test("수식어 건너뛰기가 과해서 무관한 명령을 git 으로 오인하지 않는다", () => {
    allowed("timeout 30 npm test");
    allowed("nice -n 10 ls -la");
  });

  test("git 전역 옵션 뒤 서브커맨드", () => {
    denied(`${G} -C /repo push origin main`);
    denied(`${G} -c user.name=x push`);
    denied("/usr/bin/git push origin main");
  });

  test("세그먼트 뒤쪽·따옴표 안 구분자", () => {
    denied(`cd /tmp && ${G} push`);
    denied(`echo "a; b" && ${G} push origin main`);
  });
});

describe("판정 불가 — fail-open 이 곧 우회 경로였다", () => {
  test("위험 키워드가 있으면 게이트", () => {
    expect(denyReason(`${G} push "미완성 따옴표`)).not.toBeNull();
  });

  test("위험 키워드가 없으면 통과 — 정상 작업을 막지 않는다", () => {
    allowed('echo "미완성 따옴표');
    allowed(`${G} status "열린 따옴표`);
  });

  test("래퍼 깊이 상한을 넘으면 판정을 포기하되 죽지 않는다", () => {
    // 상한 초과 depth 로 직접 호출해 가드가 UNPARSED 를 내는지 본다.
    // (문자열로 6단 중첩을 만들면 셸 인용 규칙상 유효한 명령이 아니라 가드를 검증할 수 없다)
    const invs = [...walkInvocations(`${G} push`, 99)];
    expect(invs).toHaveLength(1);
    expect(invs[0]?.exe).toBe(UNPARSED);
  });

  test("2단 중첩 래퍼는 정상적으로 잡는다", () => {
    denied(`bash -c "sh -c 'git push origin main'"`);
  });

  test("빈 입력", () => {
    for (const c of ["", "   "]) allowed(c);
  });
});

describe("커밋 트리거 — commit 만이 커밋을 만들지 않는다", () => {
  test("커밋을 만드는 서브커맨드", () => {
    for (const c of [`${G} commit -m "작업"`, `${G} commit --amend`, `${G} revert abc`,
      `${G} cherry-pick abc`, `${G} merge feature`, `${G} am patch.mbox`,
      `${G} merge --continue`, `cd /r && ${G} commit -m x`, `${G} -C /r commit -m x`,
      `bash -c '${G} commit -m x'`]) {
      expect(invokesGitCommit(c), c).toBe(true);
    }
  });

  test("커밋을 만들지 않는 형태는 제외", () => {
    for (const c of [`${G} revert --no-commit abc`, `${G} revert -n abc`,
      `${G} cherry-pick -n abc`, `${G} merge --no-commit feature`, `${G} merge --abort`,
      `${G} cherry-pick --abort`, `${G} am --skip`, `${G} am --abort`,
      `${G} rebase main`, `${G} rebase --continue`]) {
      expect(invokesGitCommit(c), c).toBe(false);
    }
  });

  test("언급만으로 트리거되지 않는다", () => {
    for (const c of [`echo "${G} commit"`, `${G} log --grep=commit`, `${G} status`,
      `grep -r "${G} commit" .`]) {
      expect(invokesGitCommit(c), c).toBe(false);
    }
  });
});

describe("보조 함수 경계", () => {
  test("연산자 분할 — 따옴표 안은 분할점이 아니다", () => {
    expect(commandSegments("a && b || c; d | e").segments).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    expect(commandSegments('echo "a; b | c" && ls').segments).toEqual([["echo", "a; b | c"], ["ls"]]);
  });

  test("따옴표 불균형은 파싱 실패로 보고한다", () => {
    const r = commandSegments('echo "열린 따옴표');
    expect(r.failed).toBe(true);
    expect(r.segments).toEqual([]);
  });

  test("여러 줄 커밋 메시지가 파싱 불능이 되지 않는다", () => {
    const cmd = `${G} commit -m "제목\n\n본문; 그리고 | 파이프"`;
    expect(commandSegments(cmd).failed).toBe(false);
    expect(invokesGitCommit(cmd)).toBe(true);
  });

  test("줄 연속 접기", () => {
    expect(foldContinuations("a \\\nb")).toBe("a  b");
    expect(foldContinuations("a \\\r\nb")).toBe("a  b");
  });

  test("실행 파일 이름 정규화", () => {
    expect(exeName("/usr/bin/git")).toBe("git");
    expect(exeName("C:\\Program Files\\Git\\git.exe")).toBe("git");
    expect(exeName("GIT")).toBe("git");
    expect(exeName("powershell.exe")).toBe("powershell");
  });

  test("git 서브커맨드 추출", () => {
    expect(gitSubcommand(["-C", "/repo", "push", "origin"])).toEqual({ sub: "push", rest: ["origin"] });
    expect(gitSubcommand(["--no-pager", "log"])).toEqual({ sub: "log", rest: [] });
    expect(gitSubcommand(["--version"])).toEqual({ sub: null, rest: [] });
  });

  test("force 플래그 인식", () => {
    for (const rest of [["--force"], ["-f"], ["-fd"], ["-d", "-f"], ["--force-with-lease=origin"]]) {
      expect(hasForceFlag(rest), String(rest)).toBe(true);
    }
    for (const rest of [[], ["-n"], ["--dry-run"], ["-d"], ["--soft"]]) {
      expect(hasForceFlag(rest), String(rest)).toBe(false);
    }
  });

  test("수식어 제거", () => {
    expect(stripNeutralPrefix(["FOO=1", "env", "git", "push"])).toEqual(["git", "push"]);
    expect(stripNeutralPrefix(["timeout", "30", "git", "push"])).toEqual(["git", "push"]);
  });

  test("walkInvocations 가 판정 불가를 명시한다", () => {
    const invs = [...walkInvocations('echo "열린')];
    expect(invs[0]?.exe).toBe(UNPARSED);
  });
});

/**
 * 문서 주장 ↔ **실제 차단 동작** 대조.
 *
 * 이 검사는 원래 파이썬 쪽(tests/test_skill_contract.py)에 있었고 v1 엔진의 deny_reason 을
 * 직접 불렀다. v1 을 제거하면서 옮겨 왔다 — 파이썬에서는 TS 함수를 부를 수 없어 소스
 * 문자열만 훑게 되는데, 그것은 "차단된다"가 아니라 "차단 규칙이 적혀 있다" 밖에 확인하지
 * 못한다. 약한 단정으로 바꾸느니 진짜로 부를 수 있는 자리로 옮기는 편이 맞다.
 */
describe("스킬 문서의 배포 한계선이 실제 판정과 일치한다", () => {
  const SKILL = join(import.meta.dir, "..", "..", "skill", "SKILL.md");

  test("문서가 차단된다고 적은 것을 실제로 차단한다", async () => {
    const text = await Bun.file(SKILL).text();
    expect(text).toContain("git push");
    expect(denyReason("git push origin main")).not.toBeNull();
  });

  test("문서가 허용한다고 적은 로컬 커밋은 통과한다", async () => {
    const text = await Bun.file(SKILL).text();
    expect(text).toContain("로컬 커밋");
    expect(denyReason('git commit -m "작업 완료"')).toBeNull();
  });

  test("한계선 문구가 사라지면 이 대조도 의미를 잃는다 — 문구 존재를 함께 고정한다", async () => {
    const text = await Bun.file(SKILL).text();
    expect(text).toContain("배포의 한계선");
  });
});
