/** 교차 검증용 최소 탐침 — v2 커밋 게이트가 열리는지만 답한다. */
import { commitGateReason } from "../src/hooks/gate.ts";

const repo = process.argv[2]!;
console.log(JSON.stringify({ open: (await commitGateReason(repo)) === null }));
