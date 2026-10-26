/**
 * 모델을 고르는 계산. 이 파일에는 LLM이 없다. 같은 입력이면 항상 같은 답이 나온다.
 *
 * 순서가 중요하다.
 *   1) 후보마다 이번 요청의 금액을 계산한다
 *   2) 조건에 안 맞는 후보를 먼저 떨어뜨린다 (하드 필터)
 *   3) 살아남은 후보끼리만 점수를 낸다
 *   4) 총점과 고정된 동점 규칙으로 1등을 정한다
 * 필터를 점수보다 먼저 거는 이유는, 못 쓸 후보가 점수의 기준선을 흔들지 않게 하기 위해서다.
 *
 * 세 점수는 각각 한 출처에서 오고, 모두 후보 중 가장 나쁜 값 0점·가장 좋은 값 100점으로 편다.
 *   가격 점수 = (log 최고 금액 − log 내 금액) ÷ (log 최고 − log 최저) × 100   (OpenRouter 판매 단가)
 *   속도 점수 = (log 최장 시간 − log 내 시간) ÷ (log 최장 − log 최단) × 100   (AA 72시간 중앙값)
 *   성능 점수 = (내 ECI − 최저 ECI) ÷ (최고 − 최저) × 100                    (Epoch ECI)
 * 가격과 시간은 후보끼리 수십~수백 배 차이 나서 로그로 편다. 그러면 2배 싼 것은 어느 가격대에서든 같은
 * 만큼 점수가 오르고, 아주 싼 모델 하나가 나머지를 0점 가까이로 누르거나(비율 방식) 아주 비싼 모델 하나에
 * 나머지가 끌려가는(직선 방식) 일이 줄어든다.
 * ECI 는 여러 벤치마크를 난이도까지 고려해 합친 지수라 0 이 "능력 없음"이 아니고 차이 자체가 의미를
 * 가지므로 그대로 편다. 후보가 하나뿐이거나 값이 모두 같으면 100점이다.
 */

import { loadCatalog, loadSnapshot, pairEntries } from "./benchmark";
import {
  PRIORITY_WEIGHTS,
  type BenchmarkSnapshot,
  type Decision,
  type PurchaseRequest,
  type RejectedCandidate,
  type ScoredCandidate,
} from "./types";

export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

/** 소수점 문자열을 오차 없이 다루기 위해 정수와 자릿수로 쪼갠다. */
function parseDecimal(text: string): { value: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`숫자 형식이 아닙니다: ${text}`);
  }
  const [whole, fraction = ""] = text.split(".");
  return {
    value: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function scaleTo(number: { value: bigint; scale: number }, scale: number): bigint {
  if (scale < number.scale) throw new Error("자릿수를 줄일 수 없습니다");
  return number.value * 10n ** BigInt(scale - number.scale);
}

/**
 * 이번 요청에 낼 금액(토큰 최소 단위 개수).
 *
 *   금액 = 올림(입력토큰 × 입력단가 + 최대출력토큰 × 출력단가)
 *
 * 출력이 실제로 얼마나 나올지는 만들기 전에 알 수 없으므로 **한도**로 계산한다.
 * 그래서 파는 쪽과 사는 쪽이 실행 전에 같은 금액을 얻을 수 있다.
 */
export function amountUnits(args: {
  inputTokens: number;
  maxOutputTokens: number;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
}): number {
  const input = parseDecimal(args.inputPricePerMillion);
  const output = parseDecimal(args.outputPricePerMillion);
  const scale = Math.max(input.scale, output.scale);
  const total =
    BigInt(args.inputTokens) * scaleTo(input, scale) +
    BigInt(args.maxOutputTokens) * scaleTo(output, scale);
  const divisor = 10n ** BigInt(scale);
  const ceiled = (total + divisor - 1n) / divisor;
  return Number(ceiled);
}

/** 글자 수로 입력 토큰을 어림잡는다. 토크나이저는 모델마다 달라 양쪽 값이 어긋나므로 쓰지 않는다. */
export function estimateInputTokens(prompt: string): number {
  const bytes = Buffer.byteLength(prompt, "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}

/** ECI 를 후보 중 최저 0점·최고 100점으로 편다. */
export function eciScore(eci: number, minEci: number, maxEci: number): number {
  return maxEci === minEci ? 100 : ((eci - minEci) / (maxEci - minEci)) * 100;
}

/** 작을수록 좋은 값(금액·시간)을 로그로 바꿔 후보 중 최대 0점·최소 100점으로 편다. */
export function logLowerIsBetterScore(value: number, min: number, max: number): number {
  return max === min ? 100 : ((Math.log(max) - Math.log(value)) / (Math.log(max) - Math.log(min))) * 100;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export class SelectionError extends Error {}

export function decide(
  request: Omit<PurchaseRequest, "requestId" | "userId">,
  source: { snapshot: BenchmarkSnapshot; hash: string } = loadSnapshot(),
): Decision {
  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new SelectionError("최대 출력 토큰은 1 이상의 정수여야 합니다");
  }
  if (!Number.isInteger(request.budgetUnits) || request.budgetUnits < 0) {
    throw new SelectionError("예산은 0 이상의 정수여야 합니다");
  }
  if (request.prompt.trim() === "") {
    throw new SelectionError("요청 내용이 비어 있습니다");
  }

  const catalog = loadCatalog();
  const { snapshot, hash: snapshotHash } = source;
  const paired = pairEntries(catalog, snapshot);
  const inputTokens = estimateInputTokens(request.prompt);
  const required = (request.requiredCapabilities ?? []).map((item) => item.trim().toLowerCase());

  // 1) 금액 계산
  const priced = paired.map(({ entry, metrics }) => {
    const units = amountUnits({
      inputTokens,
      maxOutputTokens,
      inputPricePerMillion: metrics.inputPricePerMillion,
      outputPricePerMillion: metrics.outputPricePerMillion,
    });
    if (units <= 0) {
      throw new SelectionError(`${entry.key}: 계산된 금액이 0이라 결제할 수 없습니다`);
    }
    const eci = Number(metrics.eci);
    if (!Number.isFinite(eci)) {
      // 한 출처라도 비면 기본값으로 메우지 않고 멈춘다. 빈칸을 채우면 점수가 조작된다.
      throw new SelectionError(`${entry.key}: Epoch ECI 가 없어 성능 점수를 만들 수 없습니다`);
    }
    return {
      entry,
      amountUnits: units,
      completionMs: Number(metrics.medianEndToEndSeconds) * 1000,
      eci,
      eciCiLow: Number(metrics.eciCiLow),
      eciCiHigh: Number(metrics.eciCiHigh),
      aaModelName: metrics.aaModelName,
    };
  });

  // 2) 하드 필터 — 떨어진 후보도 이유와 함께 남긴다
  const eligible: typeof priced = [];
  const rejected: RejectedCandidate[] = [];
  for (const candidate of priced) {
    const reasons: string[] = [];
    const has = candidate.entry.capabilities.map((item) => item.toLowerCase());
    const missing = required.filter((item) => !has.includes(item));
    if (missing.length > 0) reasons.push(`필요 기능 없음: ${missing.join(", ")}`);
    if (reasons.length > 0) {
      rejected.push({
        key: candidate.entry.key,
        displayName: candidate.entry.displayName,
        amountUnits: candidate.amountUnits,
        reasons,
      });
      continue;
    }
    eligible.push(candidate);
  }
  if (eligible.length === 0) {
    throw new SelectionError("조건을 통과한 후보가 하나도 없습니다");
  }

  // 3) 점수 — 기준값은 살아남은 후보에서만 뽑는다
  const minAmountUnits = Math.min(...eligible.map((item) => item.amountUnits));
  const maxAmountUnits = Math.max(...eligible.map((item) => item.amountUnits));
  const minCompletionMs = Math.min(...eligible.map((item) => item.completionMs));
  const maxCompletionMs = Math.max(...eligible.map((item) => item.completionMs));
  const minEci = Math.min(...eligible.map((item) => item.eci));
  const maxEci = Math.max(...eligible.map((item) => item.eci));
  const weights = PRIORITY_WEIGHTS[request.priority];

  const scored = eligible.map((candidate) => {
    const priceScore = round(logLowerIsBetterScore(candidate.amountUnits, minAmountUnits, maxAmountUnits));
    const timeScore = round(logLowerIsBetterScore(candidate.completionMs, minCompletionMs, maxCompletionMs));
    const intelligenceScore = round(eciScore(candidate.eci, minEci, maxEci));
    const totalScore = round(
      (priceScore * weights.price +
        timeScore * weights.time +
        intelligenceScore * weights.intelligence) /
        100,
    );
    return {
      key: candidate.entry.key,
      displayName: candidate.entry.displayName,
      providerId: candidate.entry.providerId,
      providerModelId: candidate.entry.providerModelId,
      recipient: candidate.entry.recipient,
      amountUnits: candidate.amountUnits,
      completionMs: candidate.completionMs,
      eci: candidate.eci,
      eciCiLow: candidate.eciCiLow,
      eciCiHigh: candidate.eciCiHigh,
      aaModelName: candidate.aaModelName,
      priceScore,
      timeScore,
      intelligenceScore,
      totalScore,
      rank: 0,
    } satisfies ScoredCandidate;
  });

  // 4) 순위 — 총점이 같으면 금액, 완료시간, Provider 이름, 모델 id 순. 무작위는 없다.
  scored.sort((left, right) => {
    if (left.totalScore !== right.totalScore) return right.totalScore - left.totalScore;
    if (left.amountUnits !== right.amountUnits) return left.amountUnits - right.amountUnits;
    if (left.completionMs !== right.completionMs) return left.completionMs - right.completionMs;
    if (left.providerId !== right.providerId) return left.providerId < right.providerId ? -1 : 1;
    return left.providerModelId < right.providerModelId ? -1 : 1;
  });
  scored.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });

  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash,
    snapshotCapturedAt: snapshot.capturedAt,
    catalogVersion: catalog.catalogVersion,
    priority: request.priority,
    weights,
    estimatedInputTokens: inputTokens,
    maxOutputTokens,
    budgetUnits: request.budgetUnits,
    references: { minAmountUnits, maxAmountUnits, minCompletionMs, maxCompletionMs, minEci, maxEci },
    performanceSources: {
      performance: "Epoch Capabilities Index (95% 신뢰구간)",
      price: "OpenRouter 판매 단가",
      speed: "Artificial Analysis 끝까지 걸린 시간, 최근 72시간 중앙값",
      combine: "가격·속도는 로그로, 성능(ECI)은 그대로 후보 중 가장 나쁜 값 0점·가장 좋은 값 100점으로 폄",
    },
    candidates: scored,
    rejected,
    winner: scored[0]!,
  };
}
