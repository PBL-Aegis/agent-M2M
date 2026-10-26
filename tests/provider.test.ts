import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "0x2222222222222222222222222222222222222222";
const BUYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0xF00E8e0ecEF3B405250242F932849edB409497a0";

// 체인 대신 미리 만든 거래 영수증을 돌려준다.
const chain = vi.hoisted(() => ({ logs: [] as { address: string; data: Hex; topics: Hex[] }[] }));
vi.mock("../src/lib/payment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/payment")>();
  return {
    ...actual,
    publicClient: () => ({ getTransactionReceipt: async () => ({ status: "success", logs: chain.logs }) }),
  };
});

const { AEGIS_ABI, requestIdHash } = await import("../src/lib/payment");
const { DeliveryError, verifyPayment } = await import("../src/lib/provider");

function paidLog(requestId: string, amount: bigint) {
  const topics = encodeEventTopics({
    abi: AEGIS_ABI,
    eventName: "Paid",
    args: { requestId: requestIdHash(requestId), from: BUYER, to: RECIPIENT },
  });
  const data = encodeAbiParameters([{ type: "uint256" }], [amount]);
  return { address: TOKEN, data, topics: topics as Hex[] };
}

const payment = {
  mode: "live" as const,
  txHash: "0xabc",
  from: BUYER,
  to: getAddress(RECIPIENT),
  amountUnits: 9_600,
  tokenAddress: TOKEN,
  chainId: 84532,
};
const winner = { recipient: RECIPIENT, amountUnits: 9_600 } as Parameters<typeof verifyPayment>[1];

describe("verifyPayment (live)", () => {
  beforeEach(() => {
    chain.logs = [];
  });

  it("요청 번호·수신자·금액이 맞는 Paid 기록이 있으면 통과한다", async () => {
    chain.logs = [paidLog("req-1", 9_600n)];
    await expect(verifyPayment(payment, winner, "req-1")).resolves.toBeUndefined();
  });

  it("다른 요청 번호의 결제면 거절한다", async () => {
    chain.logs = [paidLog("req-other", 9_600n)];
    await expect(verifyPayment(payment, winner, "req-1")).rejects.toBeInstanceOf(DeliveryError);
  });

  it("금액이 다르면 거절한다", async () => {
    chain.logs = [paidLog("req-1", 1n)];
    await expect(verifyPayment(payment, winner, "req-1")).rejects.toBeInstanceOf(DeliveryError);
  });
});
