/**
 * POST /api/purchase — 요청 한 건을 받아 선택·결제·확인·결과·기록까지 돌린다.
 *
 * 입력은 여기서 모양만 검사한다(문자열인지, 금액 형식인지, 네 우선순위 중 하나인지).
 * 예산(budget)은 사람이 적는 값이라 AEGIS 로 받고(예: "0.5"), 여기서 최소 단위(units)로 바꾼다.
 * 우선순위는 빼도 된다. 빼면 로컬 Qwen 이 요청 문장을 보고 정한다.
 * requestId·userId 도 빼도 된다. requestId 를 빼면 서버가 새로 만든다.
 * 예산 부족 같은 판단은 select.ts 가 하고, 그 결과는 400 이 아니라 기록으로 남는다.
 */

import { NextResponse } from "next/server";

import { AuditBlockedError } from "@/lib/audit";
import { parseAegis } from "@/lib/format";
import { PriorityInferenceError } from "@/lib/priority-llm";
import { runPurchase } from "@/lib/purchase";
import { SelectionError } from "@/lib/select";
import { PRIORITIES, type Priority, type PurchaseInput } from "@/lib/types";

// DB 를 읽고 쓰는 라우트는 정적으로 캐시되면 안 된다.
export const dynamic = "force-dynamic";

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** 요청 본문을 PurchaseInput 으로 바꾼다. 틀린 부분이 있으면 한국어 메시지를 돌려준다. */
function parseBody(body: unknown): PurchaseInput | string {
  if (typeof body !== "object" || body === null) return "요청 본문이 JSON 객체가 아닙니다";
  const input = body as Record<string, unknown>;

  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") return "prompt 는 비어 있지 않은 문자열이어야 합니다";

  if (input.budgetUnits !== undefined) return "budgetUnits 대신 budget 에 AEGIS 금액을 보내세요 (예: \"0.5\")";
  const budgetUnits = parseAegis(input.budget);
  if (budgetUnits === null) return "budget 은 0 이상의 AEGIS 금액이어야 합니다 (예: \"0.5\", 소수점 6자리까지)";

  const request: PurchaseInput = { prompt, budgetUnits };

  for (const field of ["requestId", "userId"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") return `${field} 는 비어 있지 않은 문자열이거나 비어 있어야 합니다`;
    request[field] = value.trim();
  }

  const priority = input.priority;
  if (priority !== undefined) {
    if (typeof priority !== "string" || !PRIORITIES.includes(priority as Priority)) {
      return `priority 는 ${PRIORITIES.join(", ")} 중 하나이거나 비어 있어야 합니다`;
    }
    request.priority = priority as Priority;
  }

  if (input.maxOutputTokens !== undefined) {
    const value = input.maxOutputTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return "maxOutputTokens 는 1 이상의 정수여야 합니다";
    }
    request.maxOutputTokens = value;
  }

  if (input.requiredCapabilities !== undefined) {
    const value = input.requiredCapabilities;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return "requiredCapabilities 는 문자열 배열이어야 합니다";
    }
    request.requiredCapabilities = (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
  }

  return request;
}

export async function POST(httpRequest: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await httpRequest.json();
  } catch {
    return bad("요청 본문을 JSON 으로 읽을 수 없습니다");
  }

  const parsed = parseBody(body);
  if (typeof parsed === "string") return bad(parsed);

  try {
    const record = await runPurchase(parsed);
    return NextResponse.json(record);
  } catch (error) {
    // 선택 단계에서 막힌 경우(후보 없음 등)는 결제 전이므로 기록 없이 400 으로 알린다.
    if (error instanceof SelectionError) return bad(error.message);
    // 요청 직후 감사 규칙이 막은 경우. 모델을 고르기 전이라 기록 없이 409 로 알린다.
    if (error instanceof AuditBlockedError) {
      return NextResponse.json({ error: error.message, rule: error.rule }, { status: 409 });
    }
    // 우선순위 추론이 안 되면 결제 전이다. 기본값으로 메우지 않고 멈춘다.
    if (error instanceof PriorityInferenceError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
