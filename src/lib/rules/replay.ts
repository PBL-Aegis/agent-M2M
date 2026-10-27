/**
 * 재전송·연타 막기. 체인에서는 contracts/src/rules/ReplayRule.sol 이 같은 일을 다시 한다.
 *
 *   replay       요청 번호당 결제는 1번. 같은 요청 번호가 다시 오면 요청 직후에 막는다(기록 없이 409).
 *   replay-rate  한 사용자가 창(기본 60초) 안에 결제를 너무 많이(기본 5건 초과) 하면 송금 직전에 막는다.
 *                사용자가 없는 요청은 한 사용자로 묶어 센다. 체인에서는 구매자 지갑 하나가 사용자 한 명이다.
 */

import { AuditBlockedError, BEFORE_PAYMENT_CHECKS, ON_REQUEST_CHECKS } from "../audit";
import { claimRequestId, countInWindow } from "./replay-store";

// 숫자는 코드에 박지 않고 설정값으로 둔다. 체인(ReplayRule.sol)의 기본값과 같게 둔다.
export const MAX_PAYMENTS_PER_WINDOW = Number(process.env.AUDIT_REPLAY_MAX_PAYMENTS ?? "5");
export const WINDOW_SECONDS = Number(process.env.AUDIT_REPLAY_WINDOW_SECONDS ?? "60");
if (!Number.isInteger(MAX_PAYMENTS_PER_WINDOW) || MAX_PAYMENTS_PER_WINDOW < 1) {
  throw new Error("AUDIT_REPLAY_MAX_PAYMENTS 는 1 이상의 정수여야 합니다 (예: 5)");
}
if (!Number.isInteger(WINDOW_SECONDS) || WINDOW_SECONDS < 1) {
  throw new Error("AUDIT_REPLAY_WINDOW_SECONDS 는 1 이상의 정수(초)여야 합니다 (예: 60)");
}

/** 사용자가 없는 요청을 묶어 셀 때 쓰는 이름. */
const ANONYMOUS = "(사용자 없음)";

ON_REQUEST_CHECKS.push(async (ctx) => {
  const { requestId } = ctx.request;
  if (!(await claimRequestId(requestId, ctx.purchaseId))) {
    throw new AuditBlockedError("replay", `이미 쓴 요청 번호라 다시 결제하지 않습니다(요청 번호당 1번): ${requestId}`);
  }
});

BEFORE_PAYMENT_CHECKS.push(async (ctx) => {
  const user = ctx.request.userId ?? ANONYMOUS;
  const count = await countInWindow(user, Date.now(), WINDOW_SECONDS * 1000);
  if (count > MAX_PAYMENTS_PER_WINDOW) {
    throw new AuditBlockedError(
      "replay-rate",
      `${WINDOW_SECONDS}초 안에 결제 ${MAX_PAYMENTS_PER_WINDOW}건을 넘었습니다(${count}번째): ${user}`,
    );
  }
});
