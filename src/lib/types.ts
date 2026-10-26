/** 이 프로젝트에서 쓰는 값의 모양만 모아둔 곳. */

/** 요청이 무엇을 중요하게 보는지. 이 네 값이 가중치 한 줄을 고른다. */
export type Priority = "default" | "price" | "speed" | "intelligence";

export const PRIORITIES: readonly Priority[] = [
  "default",
  "price",
  "speed",
  "intelligence",
];

/** 가격·시간·지능에 몇 점씩 줄지. 세 값의 합은 항상 100. */
export interface Weights {
  price: number;
  time: number;
  intelligence: number;
}

/** 우선순위마다 고정된 배점표. 코드 밖에서 바꿀 수 없다. */
export const PRIORITY_WEIGHTS: Record<Priority, Weights> = {
  default: { price: 40, time: 30, intelligence: 30 },
  price: { price: 60, time: 20, intelligence: 20 },
  speed: { price: 20, time: 60, intelligence: 20 },
  intelligence: { price: 20, time: 20, intelligence: 60 },
};

/** 팔고 있는 모델 하나. 수신자 주소는 이 파일이 아니라 data/catalog.json에 적혀 있다. */
export interface CatalogEntry {
  key: string;
  /** 벤치마크를 다시 뜰 때 쓰는 Artificial Analysis 슬러그. */
  aaSlug?: string;
  /** LMArena 리더보드의 정확한 모델 이름. 추측으로 찾지 않고 이 이름으로만 찾는다. */
  arenaModel?: string;
  /** 두 출처가 각각 어느 노력 수준을 쟀는지 사람이 적어 둔 설명. */
  effortPairing?: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  recipient: string;
  capabilities: string[];
}

export interface Catalog {
  catalogVersion: string;
  entries: CatalogEntry[];
}

/** 벤치마크 표의 한 줄. 숫자는 문자열로 둔다(소수점 오차를 만들지 않기 위해). */
export interface BenchmarkModel {
  key: string;
  /** 이 줄이 어느 Artificial Analysis 항목에서 왔는지. */
  aaSlug?: string;
  aaModelName?: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  medianEndToEndSeconds: string;
  intelligenceIndex: string;
  /** LMArena 사람 선호 Elo. 성능 점수의 두 번째 출처다. */
  arenaModel: string;
  arenaRating: string;
  arenaVotes?: number;
}

export interface BenchmarkSnapshot {
  snapshotId: string;
  capturedAt: string;
  source: string;
  sourceUrl?: string;
  arena?: { dataset: string; category: string; publishDate: string };
  note: string;
  models: BenchmarkModel[];
}

/** 사용자가 보낸 요청. */
export interface PurchaseRequest {
  /** 요청을 보낸 프로그램이 붙인 요청 번호. 같은 요청을 다시 보내면 같은 번호가 온다. */
  requestId: string;
  /** 요청한 사용자. 사용자 확인 방식은 아직 정하지 않았다. */
  userId: string | null;
  prompt: string;
  budgetUnits: number;
  priority: Priority;
  maxOutputTokens?: number;
  requiredCapabilities?: string[];
}

/**
 * API 로 들어온 요청. 우선순위가 비어 있으면 로컬 Qwen 이 요청 문장을 보고 채운다.
 * 요청 번호가 비어 있으면 서버가 새로 만들고, 사용자가 비어 있으면 null 로 둔다.
 */
export type PurchaseInput = Omit<PurchaseRequest, "priority" | "requestId" | "userId"> & {
  priority?: Priority;
  requestId?: string;
  userId?: string;
};

/** 결정에 쓰인 우선순위가 어디서 왔는지. */
export type PrioritySource = "request" | "local-llm";

/** 필터에서 떨어진 후보와 그 이유. */
export interface RejectedCandidate {
  key: string;
  displayName: string;
  amountUnits: number;
  reasons: string[];
}

/** 점수까지 매겨진 후보. */
export interface ScoredCandidate {
  key: string;
  displayName: string;
  providerId: string;
  providerModelId: string;
  recipient: string;
  amountUnits: number;
  completionMs: number;
  intelligenceIndex: number;
  arenaModel: string;
  arenaRating: number;
  effortPairing: string;
  priceScore: number;
  timeScore: number;
  /** AA 지능 지수를 후보 안에서 100점 만점으로 바꾼 값. */
  aaScore: number;
  /** Arena Elo를 "1등 후보와 붙었을 때 이길 확률"로 바꿔 100점 만점으로 만든 값. */
  arenaScore: number;
  /** 성능 점수 = (aaScore + arenaScore) / 2. 가중치의 "성능" 칸에 들어간다. */
  intelligenceScore: number;
  totalScore: number;
  rank: number;
}

/** 선택이 끝난 뒤 남는 기록 전체. */
export interface Decision {
  snapshotId: string;
  snapshotHash: string;
  /** 이 결정이 본 숫자를 받아 온 시각. 이 칸이 생기기 전 기록에는 없다. */
  snapshotCapturedAt?: string;
  /** 새 값을 받으려다 실패해 마지막 값으로 고른 경우 그 사유. */
  snapshotRefreshError?: string;
  catalogVersion: string;
  priority: Priority;
  /** 우선순위를 요청이 정했는지 LLM이 추론했는지. 이 칸이 생기기 전 기록에는 없다. */
  prioritySource?: PrioritySource;
  /** LLM이 추론했을 때 쓴 모델 이름. */
  priorityModel?: string;
  weights: Weights;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  budgetUnits: number;
  references: {
    minAmountUnits: number;
    minCompletionMs: number;
    maxIntelligenceIndex: number;
    maxArenaRating: number;
  };
  /** 성능 점수를 만든 출처와 각 출처의 기준 시점. */
  performanceSources: {
    aa: string;
    arena: string;
    arenaPublishDate: string | null;
    combine: string;
  };
  candidates: ScoredCandidate[];
  rejected: RejectedCandidate[];
  winner: ScoredCandidate;
}

export type PaymentMode = "mock" | "live";

export interface PaymentResult {
  mode: PaymentMode;
  txHash: string;
  from: string;
  to: string;
  amountUnits: number;
  tokenAddress: string;
  chainId: number;
  /** 체인에 넘긴 요청 번호(keccak256). 이 칸이 생기기 전 기록에는 없다. */
  requestIdHash?: string;
  /** live일 때만 채워진다. */
  blockNumber?: string;
}

/** PROCESSING 은 결제 직전에 저장되고, 끝나면 SETTLED 나 FAILED 로 바뀐다. */
export type PurchaseStatus = "PROCESSING" | "SETTLED" | "FAILED";

/** 실패가 송금 전인지 후인지. 송금 후 실패는 돈이 나갔을 수 있으므로 다시 결제하면 안 된다. */
export type FailureStage = "before-send" | "after-send";

export interface PurchaseRecord {
  id: string;
  /** 이 칸들이 생기기 전 기록에는 없다. */
  requestId?: string;
  userId?: string | null;
  createdAt: string;
  /** 상태가 마지막으로 바뀐 시각. 이 칸이 생기기 전 기록에는 없다. */
  updatedAt?: string;
  prompt: string;
  status: PurchaseStatus;
  decision: Decision;
  payment: PaymentResult | null;
  resultText: string | null;
  failureReason: string | null;
  /** FAILED 일 때만 채워진다. 이 칸이 생기기 전 기록에는 없다. */
  failureStage?: FailureStage;
}

/** 감사 규칙이 남긴 알림. 결제를 막지 않는 경고도 여기에 쌓인다. */
export interface AuditAlert {
  id: string;
  createdAt: string;
  purchaseId: string;
  userId: string | null;
  /** 알림을 남긴 규칙 이름. */
  rule: string;
  message: string;
}
