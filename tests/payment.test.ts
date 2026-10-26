import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pay, paymentConfig, requestIdHash } from "../src/lib/payment";

const RECIPIENT = "0xF00E8e0ecEF3B405250242F932849edB409497a0";

describe("pay (mock)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.AEGIS_PAYMENT_MODE = "mock";
    process.env.AEGIS_REAL_PAYMENT_APPROVED = "no";
    // 네트워크가 호출되면 바로 실패하게 해 둔다.
    globalThis.fetch = vi.fn(() => {
      throw new Error("mock 결제는 네트워크를 호출하면 안 됩니다");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("mock 모드에서는 mock: 거래번호를 돌려주고 네트워크를 건드리지 않는다", async () => {
    const result = await pay({ amountUnits: 12_960, recipient: RECIPIENT, purchaseId: "test-1", requestId: "req-1" });
    expect(result.mode).toBe("mock");
    expect(result.txHash).toBe("mock:test-1");
    expect(result.to).toBe(RECIPIENT);
    expect(result.amountUnits).toBe(12_960);
    expect(result.requestIdHash).toBe(requestIdHash("req-1"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("승인 변수 없이 live 를 요청하면 Base Sepolia 가 아니라 로컬 체인으로 남는다", () => {
    process.env.AEGIS_PAYMENT_MODE = "live";
    process.env.AEGIS_REAL_PAYMENT_APPROVED = "no";
    expect(paymentConfig().mode).toBe("local");
  });

  it("모드를 비우면 로컬 체인이고, anvil 첫 배포 주소와 공개 테스트 구매자를 쓴다", () => {
    delete process.env.AEGIS_PAYMENT_MODE;
    const config = paymentConfig();
    expect(config.mode).toBe("local");
    expect(config.chainId).toBe(31337);
    expect(config.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(config.tokenAddress).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(config.buyerAddress).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });
});
