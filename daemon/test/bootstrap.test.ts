/**
 * 부트스트랩 프롬프트 회귀 — **데몬이 띄운 세션이 첫 명령부터 실패하면 아무도 못 본다.**
 *
 * 실측(2026-08-11): templates/bootstrap_prompt.txt 가 `python scripts/harness_engine.py next`
 * 와 `bash scripts/agent_harness.sh` 를 지시하고 있었다. v2 로 설치된 저장소에는 그 파일들이
 * 없다(daemon/DESIGN.md 5절 — 저장소 내 엔진 사본을 두지 않고 전역 EXE 를 참조한다).
 * 헤드리스라 오류는 세션 로그에만 남고, 워치독은 "기동했다"고만 보고한다.
 *
 * 두 축을 고정한다:
 *   ① 프롬프트가 지시하는 CLI 표면이 **실제 표면과 일치**하는가
 *   ② 템플릿과 내장 폴백문이 **같은 절차를 지시**하는가 — 어긋나면 설치 형태에 따라
 *      세션이 다르게 움직이는데 그 차이는 보이지 않는다
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODES } from "../src/main.ts";
import { BUILTIN_BOOTSTRAP, bootstrapPrompt } from "../src/daemon/supervisor.ts";

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "bootstrap_prompt.txt");

async function templateText(): Promise<string> {
  return (await Bun.file(TEMPLATE).text()).trim();
}

/** 프롬프트가 이름을 대는 하네스 서브커맨드 — 전부 실제 모드여야 한다. */
const REFERENCED_MODES = ["heartbeat", "next", "run", "set-task"] as const;

describe("지시하는 CLI 표면이 실재한다", () => {
  test("이름을 댄 서브커맨드가 전부 실제 모드다", () => {
    for (const mode of REFERENCED_MODES) {
      expect(MODES as readonly string[]).toContain(mode);
    }
  });

  test("템플릿과 내장문 모두 그 서브커맨드를 지시한다", async () => {
    const texts = [await templateText(), BUILTIN_BOOTSTRAP];
    for (const text of texts) {
      for (const mode of REFERENCED_MODES) expect(text).toContain(mode);
      expect(text).toContain("run --task");
    }
  });

  test("제거된 파이썬 경로를 지시하지 않는다", async () => {
    // 이것이 이 테스트의 원래 결함이었다: 프롬프트가 없는 파일을 부르라고 시켰다.
    // 구현이 하나뿐인 지금은 그 이름이 등장할 이유가 없다.
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).toContain("autoharness");
      expect(text).not.toContain("harness_engine.py");
      expect(text).not.toContain("agent_harness.sh");
    }
  });

  test("저장소를 못 박도록 지시한다 — --repo 없이 부르면 cwd 가 저장소가 된다", async () => {
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).toContain("--repo");
    }
  });
});

describe("템플릿과 내장 폴백문이 같은 절차를 지시한다", () => {
  test("종료 코드 5갈래가 양쪽에 다 있다", async () => {
    // 두 문서의 표기 폭(`0 = ` / `0=`)이 달라도 같은 계약이면 통과해야 한다 —
    // 여기서 고정하려는 것은 서식이 아니라 다섯 갈래가 다 있다는 사실이다.
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      const flat = text.replace(/\s*=\s*/g, "=");
      for (const code of ["0", "1", "2", "3", "4"]) expect(flat).toContain(`${code}=`);
      expect(text).toContain("blocked");
      expect(text).toContain("진행 가능 작업 없음");
      expect(text).toContain("설정 오류");
    }
  });

  test("검증 무결성 조항이 양쪽에 그대로 있다", async () => {
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).toContain("단정문");
      expect(text).toContain("skip");
      expect(text).toContain("하드코딩");
      expect(text).toContain("done 은 오직 run 종료 코드 0 으로만 생깁니다");
    }
  });

  test("질문 금지와 사람 경계 기록 방법이 양쪽에 있다", async () => {
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).toContain("질문");
      expect(text).toContain("--status blocked");
    }
  });

  test("시도 횟수를 직접 세지 말라고 한다 — 장부가 센다", async () => {
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).toContain("시도 횟수는 장부가");
    }
  });
});

describe("속도 지시가 품질 기준을 덮지 않는다", () => {
  test("속도 항목이 있다", async () => {
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).toContain("작업 속도");
      expect(text).toContain("last_log_file");
    }
  });

  test("템플릿은 속도가 무결성을 덮지 않음을 명시한다", async () => {
    const text = await templateText();
    expect(text).toContain("품질 기준을 덮지 않는");
    expect(text).toContain("검증을 건너뛰거나");
  });

  test("검증을 생략하라는 지시는 없다", async () => {
    for (const text of [await templateText(), BUILTIN_BOOTSTRAP]) {
      expect(text).not.toContain("검증을 생략");
      expect(text).not.toContain("테스트를 건너뛰");
    }
  });
});

describe("프롬프트 선택", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ah-boot-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("설치본 템플릿이 있으면 그것을 쓴다", async () => {
    const dir = join(home, ".claude", "skills", "autoharness", "templates");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bootstrap_prompt.txt"), "설치본 문구\n", "utf8");
    expect(await bootstrapPrompt({ AUTOHARNESS_HOME: home })).toBe("설치본 문구");
  });

  test("템플릿이 없으면 내장문으로 떨어진다 — 설치 형태와 무관하게 항상 기동한다", async () => {
    expect(await bootstrapPrompt({ AUTOHARNESS_HOME: home })).toBe(BUILTIN_BOOTSTRAP);
  });

  test("템플릿이 비어 있으면 내장문을 쓴다 — 빈 프롬프트로 세션을 띄우지 않는다", async () => {
    const dir = join(home, ".claude", "skills", "autoharness", "templates");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bootstrap_prompt.txt"), "   \n\n", "utf8");
    expect(await bootstrapPrompt({ AUTOHARNESS_HOME: home })).toBe(BUILTIN_BOOTSTRAP);
  });
});
