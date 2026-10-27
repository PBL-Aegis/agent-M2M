import { afterAll, describe, expect, it } from "vitest";

import { increaseChainTime } from "./helpers/chain";

// 실행 중인 로컬 MongoDB에 테스트 전용 데이터베이스를 만들고 끝나면 통째로 지운다.
process.env.MONGODB_DB = `agent_m2m_test_${Date.now()}_replay`;

const store = await import("../src/lib/store");
const audit = await import("../src/lib/audit");
const { runPurchase } = await import("../src/lib/purchase");
const { POST } = await import("../src/app/api/purchase/route");
const { MAX_PAYMENTS_PER_WINDOW, WINDOW_SECONDS } = await import("../src/lib/rules/replay");
const { closeReplayStore } = await import("../src/lib/rules/replay-store");

afterAll(async () => {
  await store.dropTestDatabase();
  await store.closeStore();
  await closeReplayStore();
});

const input = { prompt: "이 글 요약해 줘", budgetUnits: 50_000, priority: "price" as const };

async function blockedRule(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof audit.AuditBlockedError) return error.rule;
    throw error;
  }
}

describe("replay: 요청 번호당 1번", () => {
  it("같은 요청 번호를 다시 보내면 기록 없이 replay 로 막히고 차단 알림이 남는다", async () => {
    await runPurchase({ ...input, requestId: "replay-1", userId: "replay-user-1" });
    const before = (await store.listPurchases(500)).length;

    expect(await blockedRule(runPurchase({ ...input, requestId: "replay-1", userId: "replay-user-1" }))).toBe("replay");

    expect((await store.listPurchases(500)).length).toBe(before);
    const alerts = (await store.listAlerts(500)).filter((alert) => alert.requestId === "replay-1" && alert.blocked);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: "replay", stage: "on-request", userId: "replay-user-1" });
    expect((await store.existingPurchaseIds([alerts[0].purchaseId])).size).toBe(0);
  });

  it("같은 요청 번호가 거의 동시에 두 번 와도 하나만 통과한다", async () => {
    const rules = await Promise.all(
      [0, 1].map(() => blockedRule(runPurchase({ ...input, requestId: "replay-2", userId: "replay-user-2" }))),
    );
    expect(rules.filter((rule) => rule === "replay")).toHaveLength(1);
    expect((await store.listPurchases(500)).filter((record) => record.requestId === "replay-2")).toHaveLength(1);
  });

  it("API 로 다시 보내면 409 와 규칙 이름 replay 를 돌려준다", async () => {
    const body = { prompt: "이 글 요약해 줘", budget: "0.05", priority: "price", requestId: "replay-3", userId: "replay-user-3" };
    const post = () => POST(new Request("http://localhost/api/purchase", { method: "POST", body: JSON.stringify(body) }));
    expect((await post()).status).toBe(200);
    const again = await post();
    expect(again.status).toBe(409);
    expect((await again.json()).rule).toBe("replay");
  });
});

describe("replay-rate: 창 안 결제 횟수", () => {
  it("한 사용자가 창 안에서 상한을 넘겨 결제하면 송금 전에 replay-rate 로 막힌다", async () => {
    const userId = "replay-burst-user";
    const records = [];
    for (let index = 0; index <= MAX_PAYMENTS_PER_WINDOW; index += 1) {
      records.push(await runPurchase({ ...input, requestId: `replay-burst-${index}`, userId }));
    }

    const over = records[MAX_PAYMENTS_PER_WINDOW];
    expect(over.status).toBe("FAILED");
    expect(over.failureStage).toBe("before-send");
    expect(over.payment).toBeNull();
    expect(await store.listAlertsForPurchase(over.id)).toMatchObject([
      { rule: "replay-rate", blocked: true, stage: "before-payment", userId },
    ]);
    // 상한까지는 이 규칙에 막히지 않는다.
    for (const record of records.slice(0, MAX_PAYMENTS_PER_WINDOW)) {
      const rules = (await store.listAlertsForPurchase(record.id)).map((alert) => alert.rule);
      expect(rules).not.toContain("replay-rate");
    }
  });

  it("다른 사용자의 결제는 따로 센다", async () => {
    for (let index = 0; index < MAX_PAYMENTS_PER_WINDOW; index += 1) {
      await runPurchase({ ...input, requestId: `replay-a-${index}`, userId: "replay-user-a" });
    }
    // 체인은 구매자 지갑 하나를 한 사용자로 센다. 서버 규칙만 보려고 체인 창만 넘긴다.
    await increaseChainTime(WINDOW_SECONDS);
    const other = await runPurchase({ ...input, requestId: "replay-b-0", userId: "replay-user-b" });
    const rules = (await store.listAlertsForPurchase(other.id)).map((alert) => alert.rule);
    expect(rules).not.toContain("replay-rate");
  });
});
