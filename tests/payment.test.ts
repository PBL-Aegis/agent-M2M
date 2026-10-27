import { afterEach, describe, expect, it } from "vitest";

import { AEGIS_ABI, buyerBalance, pay, paymentConfig, publicClient, requestIdHash } from "../src/lib/payment";

// 결제는 npm test 가 띄운 테스트 전용 로컬 체인(tests/setup/local-chain.ts)에 진짜로 보낸다.
const RECIPIENT = "0xF00E8e0ecEF3B405250242F932849edB409497a0";

afterEach(() => {
  process.env.AEGIS_PAYMENT_MODE = "local";
  process.env.AEGIS_REAL_PAYMENT_APPROVED = "no";
});

describe("pay (로컬 체인)", () => {
  it("pay 를 체인에 보내 구매자 잔액이 줄고, 요청 번호가 담긴 Paid 영수증이 남는다", async () => {
    const before = await buyerBalance();
    const result = await pay({ amountUnits: 12_960, recipient: RECIPIENT, purchaseId: "test-1", requestId: "req-1" });
    expect(result.mode).toBe("local");
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.blockNumber).toBeDefined();
    expect(result.requestIdHash).toBe(requestIdHash("req-1"));
    expect((await buyerBalance()).units).toBe(before.units! - 12_960);

    const receipt = await publicClient(paymentConfig()).getTransactionReceipt({ hash: result.txHash as `0x${string}` });
    expect(receipt.status).toBe("success");
    expect(receipt.logs.length).toBeGreaterThan(0);
    expect(AEGIS_ABI.some((item) => item.type === "event" && item.name === "Paid")).toBe(true);
  });

  it("같은 지갑으로 동시에 여러 건 보내도 거래 순번이 겹치지 않고 모두 들어간다", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        pay({ amountUnits: 1_000, recipient: RECIPIENT, purchaseId: `burst-${index}`, requestId: `burst-${index}` }),
      ),
    );
    expect(new Set(results.map((result) => result.txHash)).size).toBe(5);
  });
});

describe("paymentConfig", () => {
  it("승인 변수 없이 live 를 요청하면 Base Sepolia 가 아니라 로컬 체인으로 남는다", () => {
    process.env.AEGIS_PAYMENT_MODE = "live";
    process.env.AEGIS_REAL_PAYMENT_APPROVED = "no";
    expect(paymentConfig().mode).toBe("local");
  });

  it("로컬 체인은 anvil 첫 배포 주소와 공개 테스트 구매자를 쓰고, 주소는 AEGIS_LOCAL_RPC_URL 을 따른다", () => {
    const config = paymentConfig();
    expect(config.mode).toBe("local");
    expect(config.chainId).toBe(31337);
    expect(config.rpcUrl).toBe("http://127.0.0.1:8546");
    expect(config.tokenAddress).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(config.buyerAddress).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("로컬 체인 주소가 이 컴퓨터가 아니면 거절한다", () => {
    const previous = process.env.AEGIS_LOCAL_RPC_URL;
    process.env.AEGIS_LOCAL_RPC_URL = "http://10.0.0.5:8545";
    try {
      expect(() => paymentConfig()).toThrow(/127\.0\.0\.1/);
    } finally {
      process.env.AEGIS_LOCAL_RPC_URL = previous;
    }
  });
});

describe("테스트마다 체인 되돌리기", () => {
  it("앞 테스트에서 쓴 금액은 다음 테스트에 남지 않는다 (1/2: 쓰기)", async () => {
    await pay({ amountUnits: 500_000, recipient: RECIPIENT, purchaseId: "spend", requestId: "spend" });
    expect((await buyerBalance()).units).toBe(999_500_000);
  });

  it("앞 테스트에서 쓴 금액은 다음 테스트에 남지 않는다 (2/2: 확인)", async () => {
    expect((await buyerBalance()).units).toBe(1_000_000_000);
  });
});
