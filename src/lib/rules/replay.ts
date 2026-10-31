/**
 * 재시도·재전송 막기. 체인에서는 contracts/src/rules/ReplayRule.sol 이 요청 번호를 다시 막는다.
 * 짧은 시간 결제 횟수는 체인에서만 막는다(같은 파일).
 *
 *   replay         요청 번호당 결제는 1번. 같은 번호가 다시 오면 첫 요청의 상태에 따라 처리한다.
 *                    처리 중(PROCESSING)        409
 *                    성공(SETTLED)              새로 결제하지 않고 이전 기록을 돌려줌
 *                    송금 전 실패(before-send)  다시 처리
 *                    송금 후 실패(after-send)   이중 결제 위험이 있어 멈추고 사용자 확인(409)
 *   repeat-prompt  한 사용자가 같은 문장을 창(기본 60초) 안에 기본 3번 보내면, 요청 번호가 달라도 멈추고 사용자 확인(409).
 *                  사용자가 없는 요청은 한 사용자로 묶어 센다.
 */

import { createHash } from "node:crypto";

import { AuditBlockedError, ON_REQUEST_CHECKS, type RequestContext } from "../audit";
import { getPurchase } from "../store";
import type { PurchaseRecord } from "../types";
import { claimRequestId, countPromptInWindow, releaseRequestId, retakeRequestId } from "./replay-store";

function positiveInteger(name: string, fallback: string): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 는 1 이상의 정수여야 합니다 (예: ${fallback})`);
  return value;
}

// 숫자는 코드에 박지 않고 설정값으로 둔다.
export const REQUEST_ID_TTL_SECONDS = positiveInteger("AUDIT_REQUEST_ID_TTL_SECONDS", "86400");
/** 기록 없이 이 시간이 지난 요청 번호는 버려진 것으로 본다. 우선순위 추론이 끝날 시간보다 길어야 한다. */
export const REQUEST_ID_LEASE_SECONDS = positiveInteger("AUDIT_REQUEST_ID_LEASE_SECONDS", "120");
export const REPEAT_COUNT = positiveInteger("AUDIT_REPEAT_COUNT", "3");
export const REPEAT_WINDOW_SECONDS = positiveInteger("AUDIT_REPEAT_WINDOW_SECONDS", "60");

/** 사용자가 없는 요청을 묶어 셀 때 쓰는 이름. */
const ANONYMOUS = "(사용자 없음)";

function processing(requestId: string): AuditBlockedError {
  return new AuditBlockedError("replay", `같은 요청 번호가 아직 처리 중입니다: ${requestId}`);
}

async function checkRepeat(ctx: RequestContext): Promise<void> {
  const { requestId, userId, prompt } = ctx.request;
  const user = userId ?? ANONYMOUS;
  const hash = createHash("sha256").update(prompt.trim()).digest("hex");
  const count = await countPromptInWindow(`${user}:${hash}`, Date.now(), REPEAT_WINDOW_SECONDS * 1000);
  if (count < REPEAT_COUNT) return;

  // 처리하지 않은 요청이니 번호를 묶어 두지 않는다.
  await releaseRequestId(requestId, ctx.purchaseId);
  throw new AuditBlockedError(
    "repeat-prompt",
    `같은 문장이 ${REPEAT_WINDOW_SECONDS}초 안에 ${count}번 들어와 멈췄습니다. 사용자 확인이 필요합니다: ${user}`,
  );
}

/** 이미 쓴 요청 번호가 다시 왔을 때. 이전 기록을 돌려주거나, 다시 처리해도 되면 아무것도 돌려주지 않는다. */
async function checkClaimed(ctx: RequestContext, fromPurchaseId: string, claimedAt: Date, now: number) {
  const { requestId } = ctx.request;
  const previous: PurchaseRecord | null = await getPurchase(fromPurchaseId);

  if (previous === null) {
    // 기록을 남기기 전이다. 아직 선택 중이거나, 기록 없이 끝난 요청(400·503, 서버 중단)이다.
    if (now - claimedAt.getTime() < REQUEST_ID_LEASE_SECONDS * 1000) throw processing(requestId);
  } else if (previous.status === "PROCESSING") {
    throw processing(requestId);
  } else if (previous.status === "SETTLED") {
    await ctx.alert("replay", `같은 요청 번호가 다시 와서 결제하지 않고 이전 기록을 돌려줍니다: ${requestId}`);
    return previous;
  } else if (previous.failureStage === "after-send") {
    throw new AuditBlockedError(
      "replay",
      `송금 후 실패한 요청 번호라 이중 결제 위험이 있습니다. 사용자 확인이 필요합니다: ${requestId}`,
    );
  }

  // 여기까지 왔으면 돈이 나가지 않았다. 동시에 다시 보낸 요청 중 하나만 처리한다.
  const retaken = await retakeRequestId(
    requestId,
    fromPurchaseId,
    ctx.purchaseId,
    now,
    REQUEST_ID_TTL_SECONDS * 1000,
  );
  if (!retaken) throw processing(requestId);
}

ON_REQUEST_CHECKS.push(async (ctx) => {
  const now = Date.now();
  const claim = await claimRequestId(ctx.request.requestId, ctx.purchaseId, now, REQUEST_ID_TTL_SECONDS * 1000);
  if (claim === null) return checkRepeat(ctx);
  return checkClaimed(ctx, claim.purchaseId, claim.claimedAt, now);
});
