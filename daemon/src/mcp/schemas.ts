/**
 * `tools/list` 가 내보내는 도구 정의 14종 — 이름·인자 이름은 **외부 계약**이다.
 * 문구는 다듬어도 되지만 키를 바꾸면 이미 쓰이는 호출이 깨진다.
 */
import { ALLOWED_MODELS } from "../core/model.ts";
import { HANDLERS } from "./tools.ts";

interface JsonSchema {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const obj = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
});

const REPO = { type: "string", description: "대상 저장소 절대 경로" };

export const TOOLS: ToolDefinition[] = [
  {
    name: "harness_detect",
    description:
      "저장소 스택 실측 — 빌드 도구/멀티모듈/테스트 디렉토리/린트 설정/git 상태와 제안 명령을 반환합니다.",
    inputSchema: obj({ repo_path: REPO }, ["repo_path"]),
  },
  {
    name: "harness_init",
    description:
      "하네스 초기화 — 장부/예시/로그 생성, .claude/settings.json 훅·권한 병합(백업 포함), 레지스트리 등록까지 일괄 수행합니다.",
    inputSchema: obj(
      {
        repo_path: REPO,
        project: { type: "string", description: "프로젝트 이름(레지스트리 id)" },
        objective: { type: "string", description: "이번 작업의 목적" },
        source_stack: { type: "string", description: "원본 스택 (예: Java 8 + Spring)" },
        target_stack: { type: "string", description: "목표 스택 (예: Kotlin + Spring Boot 3)" },
        test_cmd: { type: "string", description: "검증 테스트 명령 ({path} 치환 가능)" },
        build_cmd: { type: "string", description: "빌드 명령(선택)" },
        lint_cmd: { type: "string", description: "린트 명령(선택)" },
        model: { type: "string", enum: [...ALLOWED_MODELS], description: "주행 모델(선택, 기본 claude-opus-5)" },
        max_attempts: { type: "integer", description: "작업당 시도 한도(기본 5)" },
        permission_mode: {
          type: "string",
          enum: ["bypass", "acceptEdits"],
          description: "재기동 세션의 권한 모드(기본 bypass)",
        },
      },
      ["repo_path", "project", "objective", "source_stack", "target_stack", "test_cmd"],
    ),
  },
  {
    name: "harness_status",
    description: "장부·하트비트·훅 배선·레지스트리 요약 — 진행 현황과 다음 작업을 반환합니다.",
    inputSchema: obj({ repo_path: REPO }, ["repo_path"]),
  },
  {
    name: "harness_run",
    description:
      "러너 실행 — build→test→lint 를 돌리고 실제 종료 코드(0/1/2/3/4)와 갱신된 작업을 반환합니다.",
    inputSchema: obj(
      {
        repo_path: REPO,
        task_id: { type: "string", description: "실행할 작업 id(생략 시 next 선택 규칙)" },
        cmd: { type: "string", description: "표준 스테이지 대신 실행할 단일 명령(선택)" },
      },
      ["repo_path"],
    ),
  },
  {
    name: "task_add",
    description: "장부에 작업 추가 — 의존성(deps)은 이미 존재하는 작업 id 여야 합니다.",
    inputSchema: obj(
      {
        repo_path: REPO,
        id: { type: "string", description: "작업 id" },
        title: { type: "string", description: "작업 제목" },
        path: { type: "string", description: "모듈/디렉토리 상대 경로 — 명령의 {path} 치환에 사용(선택)" },
        deps: { type: "array", items: { type: "string" }, description: "선행 작업 id 목록(선택)" },
        priority: { type: "integer", description: "우선순위 — 낮을수록 먼저(기본 100)" },
        test_cmd: {
          type: "string",
          description: "이 작업 전용 test 명령 — 전역 commands.test 대신 실행, {path} 치환 지원(선택)",
        },
      },
      ["repo_path", "id", "title"],
    ),
  },
  {
    name: "task_set",
    description:
      "작업 상태의 제한적 조작 — pending/blocked 만 허용됩니다(done 은 harness_run 성공으로만 기록).",
    inputSchema: obj(
      {
        repo_path: REPO,
        id: { type: "string", description: "작업 id" },
        status: { type: "string", enum: ["pending", "blocked"], description: "설정할 상태(선택)" },
        note: { type: "string", description: "last_error 로 기록할 메모(선택)" },
        test_cmd: {
          type: "string",
          description: "작업 전용 test 명령 설정 — 빈 문자열이면 해제(전역 test 복귀, 선택)",
        },
        // 종전에는 둘 다 작업을 추가할 때만 정할 수 있었다. "무엇을 먼저 할지" 를 나중에
        // 못 바꾸면 장부를 손으로 고치는 길밖에 없는데 그것은 규칙상 금지돼 있다.
        priority: {
          type: "number",
          description: "우선순위 변경 — 낮을수록 먼저(선택)",
        },
        deps: {
          type: "array",
          items: { type: "string" },
          description:
            "선행 작업 목록 교체 — 빈 배열이면 의존 해제. 자기 의존·미존재·순환은 거부됩니다(선택)",
        },
      },
      ["repo_path", "id"],
    ),
  },
  {
    name: "harness_pause",
    description: "자율 주행 일시정지 — .claude/HARNESS_PAUSED 플래그 생성 + 레지스트리 status=paused.",
    inputSchema: obj({ repo_path: REPO }, ["repo_path"]),
  },
  {
    name: "harness_resume_project",
    description: "자율 주행 재개 — PAUSED 플래그 제거 + 레지스트리 status=active + 백오프 카운터 리셋.",
    inputSchema: obj({ repo_path: REPO }, ["repo_path"]),
  },
  {
    name: "model_recommend",
    description: "모델 추천 휴리스틱 — 점수·근거·비교를 반환합니다. 결정은 사용자가 내립니다(decision=user).",
    inputSchema: obj(
      {
        repo_path: { type: "string", description: "실측에 쓸 저장소 경로(선택)" },
        source_stack: { type: "string", description: "원본 스택(선택)" },
        target_stack: { type: "string", description: "목표 스택(선택)" },
        notes: { type: "string", description: "요구 모호성/특이사항 메모(선택, 있으면 +2점)" },
      },
      [],
    ),
  },
  {
    name: "model_set",
    description: "주행 모델 갱신 — 장부와 레지스트리 양쪽에 기록합니다. 두 값만 허용됩니다.",
    inputSchema: obj(
      { repo_path: REPO, model: { type: "string", enum: [...ALLOWED_MODELS], description: "설정할 모델" } },
      ["repo_path", "model"],
    ),
  },
  {
    name: "heartbeat",
    description: "하트비트 갱신 — 데몬의 이중 기동 방지 신호(.claude/harness-heartbeat.json).",
    inputSchema: obj({ repo_path: REPO }, ["repo_path"]),
  },
  {
    name: "watchdog_install",
    description:
      "자동 시작 등록 — v2 에서는 OS 스케줄러가 아니라 **데몬의 로그온 자동 시작**을 등록합니다(도구 이름은 계약이라 유지).",
    inputSchema: obj({ interval_minutes: { type: "integer", description: "tick 간격(분, 기본 15)" } }, []),
  },
  {
    name: "watchdog_uninstall",
    description: "자동 시작 해제 — 로그온 자동 시작 등록을 제거합니다.",
    inputSchema: obj({}, []),
  },
  {
    name: "watchdog_status",
    description:
      "데몬 상태 — 등록 여부와 '실제 실행 이력'을 분리해 보고합니다(마지막 tick, 로그 tail, 프로젝트별 기동 이력, 경고).",
    inputSchema: obj({}, []),
  },
];

/** 정의와 핸들러가 어긋나면 tools/list 는 있는데 호출이 실패한다 — 로드 시점에 잡는다. */
export function assertToolsConsistent(): void {
  const defined = TOOLS.map((t) => t.name).sort();
  const handled = Object.keys(HANDLERS).sort();
  if (defined.length !== 14 || JSON.stringify(defined) !== JSON.stringify(handled)) {
    throw new Error(`도구 정의/핸들러 불일치: 정의=${defined.join(",")} 핸들러=${handled.join(",")}`);
  }
}
