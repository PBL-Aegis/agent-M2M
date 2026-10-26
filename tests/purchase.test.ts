import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// 판매창구 확인만 실패시킬 수 있게 감싼다. 기본은 원래 함수를 그대로 부른다.
const verifyFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../src/lib/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/provider")>();
  return {
    ...actual,
    verifyPayment: async (...args: Parameters<typeof actual.verifyPayment>) => {
      if (verifyFailure.error !== null) throw verifyFailure.error;
      return actual.verifyPayment(...args);
    },
  };
});

// 실행 중인 로컬 MongoDB에 테스트 전용 데이터베이스를 만들고 끝나면 통째로 지운다.
process.env.MONGODB_DB = `agent_m2m_test_${Date.now()}_purchase`;
process.env.AEGIS_PAYMENT_MODE = "mock";

const store = await import("../src/lib/store");
const audit = await import("../src/lib/audit");
const provider = await import("../src/lib/provider");
const { runPurchase } = await import("../src/lib/purchase");

afterAll(async () => {
  await store.dropTestDatabase();
  await store.closeStore();
});

beforeEach(() => {
  audit.BEFORE_PAYMENT_CHECKS.length = 0;
  verifyFailure.error = null;
});

const input = { prompt: "이 글 요약해 줘", budgetUnits: 50_000, priority: "price" as const };

describe("runPurchase", () => {
  it("성공하면 요청 번호·사용자와 함께 SETTLED 로 남는다", async () => {
    const record = await runPurchase({ ...input, requestId: "req-1", userId: "user-1" });
    expect(record.status).toBe("SETTLED");
    const saved = await store.getPurchase(record.id);
    expect(saved?.status).toBe("SETTLED");
    expect(saved?.requestId).toBe("req-1");
    expect(saved?.userId).toBe("user-1");
    expect(saved?.payment?.txHash).toBe(`mock:${record.id}`);
    expect(saved?.updatedAt).toBe(record.updatedAt);
  });

  it("요청 번호가 없으면 서버가 만들고 사용자는 null 이다", async () => {
    const record = await runPurchase(input);
    expect(record.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(record.userId).toBeNull();
  });

  it("감사 규칙이 막으면 송금하지 않고 송금 전 실패로 남는다", async () => {
    audit.BEFORE_PAYMENT_CHECKS.push(async (ctx) => {
      await ctx.alert("test-rule", "알림만 남긴다");
      throw new audit.AuditBlockedError("test-rule", "테스트 규칙이 막았습니다");
    });
    const record = await runPurchase({ ...input, userId: "user-2" });
    const saved = await store.getPurchase(record.id);
    expect(saved?.status).toBe("FAILED");
    expect(saved?.failureStage).toBe("before-send");
    expect(saved?.failureReason).toBe("테스트 규칙이 막았습니다");
    expect(saved?.payment).toBeNull();
    const alerts = await store.listAlerts();
    expect(alerts.find((alert) => alert.purchaseId === record.id)).toMatchObject({
      rule: "test-rule",
      userId: "user-2",
    });
  });

  it("송금 뒤 확인에서 실패하면 거래번호를 지우지 않고 송금 후 실패로 남는다", async () => {
    verifyFailure.error = new provider.DeliveryError("확인 실패");
    const record = await runPurchase(input);
    const saved = await store.getPurchase(record.id);
    expect(saved?.status).toBe("FAILED");
    expect(saved?.failureStage).toBe("after-send");
    expect(saved?.payment?.txHash).toBe(`mock:${record.id}`);
  });
});
