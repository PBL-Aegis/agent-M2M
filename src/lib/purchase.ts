/**
 * 구매 한 건의 전체 흐름.
 *
 *   요청 → 감사(요청 직후) → 모델 선택 → 기록(처리 중) → 감사(송금 직전) → 결제 → 판매창구 확인
 *   → 결과 → 기록(성공·실패) → 감사(결제 후)
 *
 * 실패하면 결과 없이 실패 사유와 송금 전·후 여부를 남긴다. 실패한 건을 자동으로 다시 결제하지 않는다.
 */

import { randomUUID } from "node:crypto";

import { runAfterPayment, runBeforePayment, runOnRequest, type IncomingRequest } from "./audit";
import { loadFreshSnapshot } from "./benchmark";
import { pay, PaymentError, paymentConfig } from "./payment";
import { inferPriority } from "./priority-llm";
import { mockResult, verifyPayment } from "./provider";
import { decide } from "./select";
// 감사 규칙 파일들을 불러와 audit.ts 의 규칙 목록에 등록한다.
import "./rules";
import { purchaseExists, savePurchase, updatePurchase, type PurchaseOutcome } from "./store";
import type { PaymentResult, PurchaseInput, PurchaseRecord, PurchaseRequest } from "./types";

export async function runPurchase(input: PurchaseInput): Promise<PurchaseRecord> {
  const id = randomUUID();
  if (await purchaseExists(id)) throw new Error("구매 번호가 중복되었습니다");

  const incoming: IncomingRequest = {
    ...input,
    requestId: input.requestId ?? randomUUID(),
    userId: input.userId ?? null,
  };

  // 0) 감사(요청 직후) — 이전 기록을 돌려받으면 새로 처리하지 않고 그대로 응답한다.
  const previous = await runOnRequest({ purchaseId: id, request: incoming });
  if (previous !== null) return previous;

  // 우선순위가 없으면 로컬 Qwen 이 요청 문장을 보고 정한다. 실패하면 결제 전에 멈춘다.
  const inferred = incoming.priority === undefined ? await inferPriority(incoming.prompt) : null;
  const request: PurchaseRequest = { ...incoming, priority: inferred?.priority ?? incoming.priority! };

  // 1) 선택 — 여기서 실패하면 결제는 시작조차 하지 않는다.
  const source = await loadFreshSnapshot();
  const decision = decide(request, source);
  if (source.refreshError !== null) decision.snapshotRefreshError = source.refreshError;
  decision.prioritySource = inferred === null ? "request" : "local-llm";
  if (inferred !== null) decision.priorityModel = inferred.model;
  const createdAt = new Date().toISOString();

  // 결제 직전에 처리 중으로 먼저 남긴다. 중간에 멈춰도 기록이 남는다.
  const record: PurchaseRecord = {
    id,
    requestId: request.requestId,
    userId: request.userId,
    createdAt,
    prompt: request.prompt,
    status: "PROCESSING",
    decision,
    payment: null,
    resultText: null,
    failureReason: null,
  };
  await savePurchase(record);

  let payment: PaymentResult | null = null;
  let outcome: PurchaseOutcome;
  try {
    // 2) 감사(송금 직전) — 하나라도 막으면 송금하지 않는다.
    await runBeforePayment({ purchaseId: id, request, decision });

    // 3) 결제
    payment = await pay({
      amountUnits: decision.winner.amountUnits,
      recipient: decision.winner.recipient,
      purchaseId: id,
      requestId: request.requestId,
    });

    // 4) 판매창구가 스스로 확인한 뒤에만 결과를 준다.
    await verifyPayment(payment, decision.winner, request.requestId);
    const resultText = mockResult(request.prompt, decision.winner);
    outcome = { status: "SETTLED", payment, resultText, failureReason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "알 수 없는 오류";
    // 결제 결과를 받았거나 송금 뒤에 실패했으면 돈이 나갔을 수 있다. 거래번호를 지우지 않고 남긴다.
    const sent = payment !== null || (error instanceof PaymentError && error.sent);
    outcome = {
      status: "FAILED",
      payment,
      resultText: null,
      failureReason: reason,
      failureStage: sent ? "after-send" : "before-send",
    };
  }
  const updatedAt = await updatePurchase(id, outcome);
  const settled: PurchaseRecord = { ...record, ...outcome, updatedAt };

  // 5) 감사(결제 후) — 결과는 이미 기록됐다. 예약해 둔 한도를 되돌리는 일 등을 한다.
  await runAfterPayment({ purchaseId: id, request, decision }, settled);
  return settled;
}

export function currentMode(): ReturnType<typeof paymentConfig> {
  return paymentConfig();
}
