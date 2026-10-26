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

  it("승인 변수 없이 live 를 요청해도 mock 으로 남는다", () => {
    process.env.AEGIS_PAYMENT_MODE = "live";
    process.env.AEGIS_REAL_PAYMENT_APPROVED = "no";
    expect(paymentConfig().mode).toBe("mock");
  });
});
