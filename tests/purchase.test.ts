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

const store = await import("../src/lib/store");
const audit = await import("../src/lib/audit");
const provider = await import("../src/lib/provider");
const { runPurchase } = await import("../src/lib/purchase");

afterAll(async () => {
  await store.dropTestDatabase();
  await store.closeStore();
});

beforeEach(() => {
  audit.ON_REQUEST_CHECKS.length = 0;
  audit.BEFORE_PAYMENT_CHECKS.length = 0;
  audit.AFTER_PAYMENT_CHECKS.length = 0;
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
    expect(saved?.payment?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
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
    expect(saved?.payment?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("요청 직후 규칙이 이전 기록을 돌려주면 새로 처리하지 않고 그 기록을 돌려준다", async () => {
    const first = await runPurchase({ ...input, requestId: "req-again" });
    audit.ON_REQUEST_CHECKS.push(async (ctx) =>
      ctx.request.requestId === "req-again" ? ((await store.getPurchase(first.id)) ?? undefined) : undefined,
    );
    const before = (await store.listPurchases(500)).length;
    const again = await runPurchase({ ...input, requestId: "req-again" });
    expect(again.id).toBe(first.id);
    expect((await store.listPurchases(500)).length).toBe(before);
  });

  it("요청 직후 규칙이 막으면 기록 없이 AuditBlockedError 가 나간다", async () => {
    audit.ON_REQUEST_CHECKS.push(async () => {
      throw new audit.AuditBlockedError("test-request", "처리 중입니다");
    });
    const before = (await store.listPurchases(500)).length;
    await expect(runPurchase(input)).rejects.toBeInstanceOf(audit.AuditBlockedError);
    expect((await store.listPurchases(500)).length).toBe(before);
  });

  it("결제 후 규칙은 확정된 기록을 받고, 실패해도 결과를 바꾸지 않고 알림만 남긴다", async () => {
    const seen: string[] = [];
    audit.BEFORE_PAYMENT_CHECKS.push(async () => {
      throw new audit.AuditBlockedError("test-rule", "막음");
    });
    audit.AFTER_PAYMENT_CHECKS.push(async (_ctx, record) => {
      seen.push(`${record.status}:${record.failureStage}`);
    });
    audit.AFTER_PAYMENT_CHECKS.push(async () => {
      throw new Error("되돌리기 실패");
    });
    const record = await runPurchase(input);
    expect(seen).toEqual(["FAILED:before-send"]);
    expect((await store.getPurchase(record.id))?.status).toBe("FAILED");
    const alerts = await store.listAlerts();
    expect(alerts.find((alert) => alert.purchaseId === record.id && alert.rule === "after-payment")?.message).toContain(
      "되돌리기 실패",
    );
  });

  it("송금 직전 규칙이 막으면 단계·요청 번호와 함께 차단 알림이 자동으로 남는다", async () => {
    audit.BEFORE_PAYMENT_CHECKS.push(async () => {
      throw new audit.AuditBlockedError("limit-test", "한도 초과");
    });
    const record = await runPurchase({ ...input, requestId: "req-block", userId: "user-b" });
    const alerts = await store.listAlertsForPurchase(record.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      rule: "limit-test",
      message: "한도 초과",
      blocked: true,
      stage: "before-payment",
      requestId: "req-block",
      userId: "user-b",
    });
    expect((await store.existingPurchaseIds([record.id, "no-such-id"])).has(record.id)).toBe(true);
  });

  it("요청 직후 규칙이 막으면 구매 기록 없이 차단 알림만 남는다", async () => {
    audit.ON_REQUEST_CHECKS.push(async () => {
      throw new audit.AuditBlockedError("replay-test", "처리 중인 요청");
    });
    const before = await store.countAlerts();
    await expect(runPurchase({ ...input, requestId: "req-early" })).rejects.toBeInstanceOf(audit.AuditBlockedError);
    const alert = (await store.listAlerts()).find((item) => item.requestId === "req-early")!;
    expect(alert).toMatchObject({ rule: "replay-test", blocked: true, stage: "on-request" });
    expect((await store.existingPurchaseIds([alert.purchaseId])).size).toBe(0);
    const after = await store.countAlerts();
    expect(after.blocked).toBe(before.blocked + 1);
    expect(after.warnings).toBe(before.warnings);
  });

  it("ctx.alert 로 남긴 알림은 막지 않는 경고로 센다", async () => {
    audit.BEFORE_PAYMENT_CHECKS.push(async (ctx) => {
      await ctx.alert("near-limit", "한도의 80% 이상");
    });
    const before = await store.countAlerts();
    const record = await runPurchase(input);
    expect(record.status).toBe("SETTLED");
    expect(await store.listAlertsForPurchase(record.id)).toMatchObject([
      { rule: "near-limit", blocked: false, stage: "before-payment" },
    ]);
    expect((await store.countAlerts()).warnings).toBe(before.warnings + 1);
  });
});
