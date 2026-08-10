/**
 * 모델 추천 휴리스틱 — **추천은 도구가, 결정은 사용자가.**
 *
 * 반환값의 `decision: "user"` 는 장식이 아니다: 스킬은 이 결과를 AskUserQuestion 으로
 * 제시하고 사용자의 선택을 쓴다. 점수는 근거를 동반해야 하며, 근거 없는 가산은 넣지 않는다.
 */
import { detect, estimateLoc } from "./detect.ts";
import { loadTracker } from "./ledger.ts";

export const MODEL_FABLE = "claude-fable-5";
export const MODEL_OPUS = "claude-opus-5";
export const ALLOWED_MODELS: readonly string[] = [MODEL_OPUS, MODEL_FABLE];

/** 이 점수 이상이면 최상위 추론 모델을 권한다. */
export const FABLE_THRESHOLD = 4;

export interface ModelRecommendation {
  recommended: string;
  score: number;
  rationale: string[];
  decision: "user";
  comparison: Record<string, string>;
}

/**
 * 스택 문자열에서 언어 토큰을 뽑는다.
 *
 * 비ASCII 스택명(한글 등)은 토큰이 비어 판정 불능이다 — 그때 '언어 간 이식'으로 가산하면
 * 같은 언어 안의 작업까지 최상위 모델로 몰린다(v1 이 실측으로 잡은 오탐).
 */
export function languageToken(stack: string | null | undefined): string {
  const m = /^[A-Za-z#+.]+/.exec((stack ?? "").trim());
  return m ? m[0].toLowerCase() : "";
}

export interface RecommendInput {
  repo?: string | null;
  source?: string | null;
  target?: string | null;
  notes?: string | null;
}

export async function modelRecommend(input: RecommendInput = {}): Promise<ModelRecommendation> {
  const rationale: string[] = [];
  let score = 0;

  let source = input.source ?? null;
  let target = input.target ?? null;
  let det: Awaited<ReturnType<typeof detect>> | null = null;

  if (input.repo) {
    try {
      det = await detect(input.repo);
    } catch {
      det = null; // 경로가 없으면 실측 없이 인자만으로 판단한다
    }
    if (det) {
      const { tracker } = await loadTracker(input.repo);
      if (tracker) {
        source = source ?? tracker.source_stack;
        target = target ?? tracker.target_stack;
      }
    }
  }

  const srcLang = languageToken(source);
  const tgtLang = languageToken(target);
  if (source && target && srcLang && tgtLang && srcLang !== tgtLang) {
    score += 3;
    rationale.push(`언어 간 이식(${source} → ${target}): 구조 재설계 판단이 많음 (+3)`);
  }
  if (det) {
    if (!det.tests_present) {
      score += 2;
      rationale.push("테스트 디렉토리 미발견: 검증 기준을 스스로 세워야 함 (+2)");
    }
    if (det.multimodule.length > 5) {
      score += 1;
      rationale.push(`모듈 ${det.multimodule.length}개 멀티모듈: 순환·경계 판단 필요 (+1)`);
    }
    const loc = await estimateLoc(input.repo!);
    if (loc > 300_000) {
      score += 2;
      rationale.push(`추정 LOC ${loc.toLocaleString("en-US")}: 대규모 (+2)`);
    } else if (loc > 100_000) {
      score += 1;
      rationale.push(`추정 LOC ${loc.toLocaleString("en-US")}: 중규모 이상 (+1)`);
    }
  }
  if (input.notes) {
    score += 2;
    rationale.push(`요구 모호성/특이사항 메모 있음 (+2): ${input.notes.slice(0, 120)}`);
  }
  if (rationale.length === 0) rationale.push("복잡도 신호 없음 — 패턴형 작업으로 판단");

  return {
    recommended: score >= FABLE_THRESHOLD ? MODEL_FABLE : MODEL_OPUS,
    score,
    rationale,
    decision: "user",
    comparison: {
      [MODEL_FABLE]:
        "최상위 추론 — 교차 스택 이식·모호한 사양·테스트 공백·아키텍처 재설계에 강함",
      [MODEL_OPUS]:
        "패턴형 대량 루프에 비용·속도 유리, /fast(fast mode) 지원 — 기계적 이식·강한 테스트 존재 시 적합",
    },
  };
}
