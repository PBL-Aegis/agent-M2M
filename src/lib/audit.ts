/**
 * 감사 규칙. 구매 한 건에서 세 번 돈다.
 *
 *   ON_REQUEST_CHECKS     요청이 들어오자마자. 모델을 고르기 전이고 기록도 아직 없다.
 *                         이전 기록을 돌려주면 새로 처리하지 않고 그 기록을 그대로 응답한다.
 *   BEFORE_PAYMENT_CHECKS 모델을 고르고 처리 중 기록을 남긴 뒤, 송금 직전.
 *   AFTER_PAYMENT_CHECKS  결과(성공·실패)를 기록한 뒤. 예약해 둔 한도를 되돌리는 일 등을 한다.
 *
 * 규칙은 배열에 함수 하나로 등록한다. 막을 때는 AuditBlockedError 를 던지고,
 * 결제는 진행하되 알리기만 할 때는 ctx.alert 를 부른다.
 * 체인에서 다시 막는 검사는 여기가 아니라 contracts/src/rules/ 에 둔다.
 * 체인에서는 구매자 지갑 하나를 사용자 한 명으로 본다.
 */

import { randomUUID } from "node:crypto";

import { saveAlert } from "./store";
import type { Decision, PurchaseInput, PurchaseRecord, PurchaseRequest } from "./types";

export class AuditBlockedError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

/** 요청이 막 들어온 때의 요청. 우선순위는 아직 비어 있을 수 있다. */
export type IncomingRequest = Omit<PurchaseInput, "requestId" | "userId"> & Pick<PurchaseRequest, "requestId" | "userId">;

interface Alerting {
  purchaseId: string;
  /** 결제를 막지 않는 알림을 남긴다. */
  alert(rule: string, message: string): Promise<void>;
}

export interface RequestContext extends Alerting {
  request: IncomingRequest;
}

export interface AuditContext extends Alerting {
  request: PurchaseRequest;
  decision: Decision;
}

/** 이전 기록을 돌려주면 새로 처리하지 않는다. */
export type RequestCheck = (ctx: RequestContext) => Promise<PurchaseRecord | void>;
export type AuditCheck = (ctx: AuditContext) => Promise<void>;
/** record 는 상태가 SETTLED 나 FAILED 로 확정된 기록이다. */
export type AfterPaymentCheck = (ctx: AuditContext, record: PurchaseRecord) => Promise<void>;

export const ON_REQUEST_CHECKS: RequestCheck[] = [];
export const BEFORE_PAYMENT_CHECKS: AuditCheck[] = [];
export const AFTER_PAYMENT_CHECKS: AfterPaymentCheck[] = [];

function alerting(purchaseId: string, userId: string | null): Alerting {
  return {
    purchaseId,
    alert: (rule, message) =>
      saveAlert({ id: randomUUID(), createdAt: new Date().toISOString(), purchaseId, userId, rule, message }),
  };
}

/** 등록 순서대로 돌다가 이전 기록을 돌려준 규칙이 있으면 그 기록을 돌려준다. */
export async function runOnRequest(
  context: Omit<RequestContext, "alert">,
  checks: readonly RequestCheck[] = ON_REQUEST_CHECKS,
): Promise<PurchaseRecord | null> {
  const ctx: RequestContext = { ...context, ...alerting(context.purchaseId, context.request.userId) };
  for (const check of checks) {
    const previous = await check(ctx);
    if (previous) return previous;
  }
  return null;
}

export async function runBeforePayment(
  context: Omit<AuditContext, "alert">,
  checks: readonly AuditCheck[] = BEFORE_PAYMENT_CHECKS,
): Promise<void> {
  const ctx: AuditContext = { ...context, ...alerting(context.purchaseId, context.request.userId) };
  for (const check of checks) await check(ctx);
}

/**
 * 결과가 이미 기록된 뒤라 여기서 실패해도 결과를 바꾸지 않는다. 실패는 알림으로 남기고 다음 규칙을 돈다.
 */
export async function runAfterPayment(
  context: Omit<AuditContext, "alert">,
  record: PurchaseRecord,
  checks: readonly AfterPaymentCheck[] = AFTER_PAYMENT_CHECKS,
): Promise<void> {
  const ctx: AuditContext = { ...context, ...alerting(context.purchaseId, context.request.userId) };
  for (const check of checks) {
    try {
      await check(ctx, record);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "알 수 없는 오류";
      await ctx.alert("after-payment", `결제 후 규칙이 실패했습니다: ${reason}`);
    }
  }
}
