# -*- coding: utf-8 -*-
"""model_recommend 언어 전환 판정 회귀 테스트.

원 결함: 스택명이 비ASCII(한글 등)면 lang() 이 빈 문자열을 반환하는데, 조건이
lang(source) 만 검사해 '언어 간 이식(+3)' 이 오가산됐다(셀프 호스팅 init 에서 실측
— source 'Python 3.9 stdlib …' vs target '동일 스택 — …' 조합이 +3 을 받았다).
"""

import os
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "bin")
if BIN not in sys.path:
    sys.path.insert(0, BIN)

import harness_engine as eng  # noqa: E402


def cross_lang_added(result):
    return any("언어 간 이식" in r for r in result["rationale"])


class ModelRecommendLangTest(unittest.TestCase):
    def test_no_bonus_when_target_token_empty(self):
        # 실측 재현 조합: source 는 ASCII 시작, target 은 한글 시작
        res = eng.model_recommend(source="Python 3.9 stdlib (CLI 엔진)",
                                  target="동일 스택 — 결함 수정·고도화")
        self.assertFalse(cross_lang_added(res), res["rationale"])
        self.assertEqual(res["score"], 0)

    def test_no_bonus_when_source_token_empty(self):
        res = eng.model_recommend(source="한글 스택명", target="Kotlin 2.0")
        self.assertFalse(cross_lang_added(res), res["rationale"])
        self.assertEqual(res["score"], 0)

    def test_no_bonus_when_both_tokens_empty(self):
        res = eng.model_recommend(source="한글 원본", target="한글 대상")
        self.assertFalse(cross_lang_added(res), res["rationale"])

    def test_no_bonus_for_same_language(self):
        res = eng.model_recommend(source="Java 8 / Spring", target="Java 17 / Spring Boot 3")
        self.assertFalse(cross_lang_added(res), res["rationale"])

    def test_bonus_for_real_cross_language(self):
        res = eng.model_recommend(source="Java 8", target="Kotlin 2.0")
        self.assertTrue(cross_lang_added(res), res["rationale"])
        self.assertEqual(res["score"], 3)

    def test_recommendation_contract_shape(self):
        res = eng.model_recommend(source="Java 8", target="Kotlin 2.0")
        self.assertIn(res["recommended"], eng.ALLOWED_MODELS)
        self.assertEqual(res["decision"], "user")
        self.assertTrue(res["rationale"])


if __name__ == "__main__":
    unittest.main()
