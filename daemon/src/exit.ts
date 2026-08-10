/**
 * 종료 코드 계약 — daemon/DESIGN.md 4절. **숫자를 바꾸지 말 것.**
 *
 * 상위 에이전트가 이 숫자로 분기한다(0=커밋 후 다음 작업, 1=자가 수정 반복,
 * 2=중단·보고, 3=작업 없음, 4=해당 작업 봉인). 의미를 바꾸면 자율 주행이 통째로 어긋난다.
 *
 * 별도 모듈인 이유: 러너·훅이 진입점(main.ts)을 import 하지 않게 하기 위해서다.
 * 훅 모드의 시작 시간이 계약이라 의존을 얕게 유지해야 한다.
 */
export const EXIT = {
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  NO_TASK: 3,
  BLOCKED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
