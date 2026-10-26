/**
 * 감사 규칙. 결제 직전에 차례로 돌고, 하나라도 막으면 송금하지 않는다.
 *
 * 규칙은 BEFORE_PAYMENT_CHECKS 에 함수 하나로 등록한다. 막을 때는 AuditBlockedError 를 던지고,
 * 결제는 진행하되 알리기만 할 때는 ctx.alert 를 부른다.
 * 체인에서 다시 막는 검사는 여기가 아니라 contracts/ 의 토큰 컨트랙트에 둔다.
 */

import { randomUUID } from "node:crypto";

import { saveAlert } from "./store";
import type { Decision, PurchaseRequest } from "./types";

export class AuditBlockedError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuditContext {
  purchaseId: string;
  request: PurchaseRequest;
  decision: Decision;
  /** 결제를 막지 않는 알림을 남긴다. */
  alert(rule: string, message: string): Promise<void>;
}

export type AuditCheck = (ctx: AuditContext) => Promise<void>;

/** 결제 직전에 등록 순서대로 돈다. */
export const BEFORE_PAYMENT_CHECKS: AuditCheck[] = [];

export async function runBeforePayment(
  context: Omit<AuditContext, "alert">,
  checks: readonly AuditCheck[] = BEFORE_PAYMENT_CHECKS,
): Promise<void> {
  const ctx: AuditContext = {
    ...context,
    alert: (rule, message) =>
      saveAlert({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        purchaseId: context.purchaseId,
        userId: context.request.userId,
        rule,
        message,
      }),
  };
  for (const check of checks) await check(ctx);
}
