import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// 판매창구 확인만 실패시켜 송금 후 실패를 만든다. 기본은 원래 함수를 그대로 부른다.
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
process.env.MONGODB_DB = `agent_m2m_test_${Date.now()}_replay`;

const store = await import("../src/lib/store");
const audit = await import("../src/lib/audit");
const { buyerBalance } = await import("../src/lib/payment");
const { runPurchase } = await import("../src/lib/purchase");
const { POST } = await import("../src/app/api/purchase/route");
const { REPEAT_COUNT, REPEAT_WINDOW_SECONDS, REQUEST_ID_LEASE_SECONDS, REQUEST_ID_TTL_SECONDS } = await import(
  "../src/lib/rules/replay"
);
const { closeReplayStore, findRequestIdClaim, requestIdIndexes } = await import("../src/lib/rules/replay-store");

afterAll(async () => {
  await store.dropTestDatabase();
  await store.closeStore();
  await closeReplayStore();
});

afterEach(() => {
  verifyFailure.error = null;
  vi.restoreAllMocks();
});

const base = { budgetUnits: 50_000, priority: "price" as const };
/** 테스트마다 다른 문장을 써서 같은 문장 규칙이 다른 테스트로 번지지 않게 한다. */
const input = (name: string) => ({ ...base, prompt: `이 글 요약해 줘 ${name}` });

async function blockedRule(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof audit.AuditBlockedError) return error.rule;
    throw error;
  }
}

function post(body: object) {
  return POST(new Request("http://localhost/api/purchase", { method: "POST", body: JSON.stringify(body) }));
}

async function purchasesOf(requestId: string) {
  return (await store.listPurchases(500)).filter((record) => record.requestId === requestId);
}

/** 시계를 앞으로 돌린다. 서버 규칙이 쓰는 Date.now 만 바꾼다. */
function advanceClock(seconds: number) {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + seconds * 1000);
}

/** 이번 한 번만 송금 전에 실패시킨다. */
async function failBeforeSend<T>(run: () => Promise<T>): Promise<T> {
  audit.BEFORE_PAYMENT_CHECKS.push(async () => {
    throw new audit.AuditBlockedError("test-block", "테스트용 차단");
  });
  try {
    return await run();
  } finally {
    audit.BEFORE_PAYMENT_CHECKS.pop();
  }
}

describe("replay: 같은 요청 번호", () => {
  it("성공한 요청 번호를 다시 보내면 같은 기록을 돌려받고 결제는 1번이다", async () => {
    const request = { ...input("settled"), requestId: "replay-settled", userId: "replay-user-settled" };
    const first = await runPurchase(request);
    expect(first.status).toBe("SETTLED");
    const before = (await buyerBalance()).units!;

    const again = await runPurchase(request);

    expect(again.id).toBe(first.id);
    expect(again.payment?.txHash).toBe(first.payment?.txHash);
    expect(await purchasesOf(request.requestId)).toHaveLength(1);
    expect((await buyerBalance()).units).toBe(before);
    const alerts = (await store.listAlerts(500)).filter((alert) => alert.requestId === request.requestId);
    expect(alerts).toMatchObject([{ rule: "replay", blocked: false, stage: "on-request" }]);
  });

  it("같은 요청 번호가 거의 동시에 두 번 오면 하나만 SETTLED, 나머지는 409 다", async () => {
    const body = { prompt: "이 글 요약해 줘 동시", budget: "0.05", priority: "price", requestId: "replay-race", userId: "replay-user-race" };
    const responses = await Promise.all([post(body), post(body)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const [settled, blocked] = responses[0].status === 200 ? responses : [responses[1], responses[0]];
    expect((await settled.json()).status).toBe("SETTLED");
    expect((await blocked.json()).rule).toBe("replay");
    expect(await purchasesOf(body.requestId)).toHaveLength(1);
  });

  it("막히면 기록 없이 차단 알림만 남는다", async () => {
    verifyFailure.error = new Error("판매창구 확인 실패");
    const request = { ...input("trace"), requestId: "replay-trace", userId: "replay-user-trace" };
    await runPurchase(request);

    expect(await blockedRule(runPurchase(request))).toBe("replay");

    expect(await purchasesOf(request.requestId)).toHaveLength(1);
    const alerts = (await store.listAlerts(500)).filter((alert) => alert.requestId === request.requestId && alert.blocked);
    expect(alerts).toMatchObject([{ rule: "replay", stage: "on-request", userId: request.userId }]);
    expect((await store.existingPurchaseIds([alerts[0].purchaseId])).size).toBe(0);
  });

  it("송금 전에 실패한 요청 번호는 다시 처리한다", async () => {
    const request = { ...input("before-send"), requestId: "replay-before-send", userId: "replay-user-before-send" };
    const failed = await failBeforeSend(() => runPurchase(request));
    expect(failed).toMatchObject({ status: "FAILED", failureStage: "before-send" });

    const again = await runPurchase(request);

    expect(again.status).toBe("SETTLED");
    expect(again.id).not.toBe(failed.id);
  });

  it("송금 전에 실패한 요청 번호를 동시에 다시 보내도 하나만 처리한다", async () => {
    const request = { ...input("retry-race"), requestId: "replay-retry-race", userId: "replay-user-retry-race" };
    await failBeforeSend(() => runPurchase(request));

    const rules = await Promise.all([0, 1].map(() => blockedRule(runPurchase(request))));

    expect(rules.filter((rule) => rule === "replay")).toHaveLength(1);
    expect((await purchasesOf(request.requestId)).filter((record) => record.status === "SETTLED")).toHaveLength(1);
  });

  it("송금 후에 실패한 요청 번호는 409 로 멈춘다", async () => {
    verifyFailure.error = new Error("판매창구 확인 실패");
    const body = { prompt: "이 글 요약해 줘 송금 후", budget: "0.05", priority: "price", requestId: "replay-after-send", userId: "replay-user-after-send" };
    const failed = await (await post(body)).json();
    expect(failed).toMatchObject({ status: "FAILED", failureStage: "after-send" });
    verifyFailure.error = null;

    const again = await post(body);

    expect(again.status).toBe(409);
    expect((await again.json()).rule).toBe("replay");
    expect(await purchasesOf(body.requestId)).toHaveLength(1);
  });

  it("기록 없이 끝난 요청 번호는 잠시 처리 중으로 막고, 그 뒤에는 다시 받는다", async () => {
    const request = { ...input("no-record"), requestId: "replay-no-record", userId: "replay-user-no-record" };
    await expect(runPurchase({ ...request, requiredCapabilities: ["없는 기능"] })).rejects.toThrow();

    expect(await blockedRule(runPurchase(request))).toBe("replay");

    advanceClock(REQUEST_ID_LEASE_SECONDS);
    expect((await runPurchase(request)).status).toBe("SETTLED");
  });

  it("요청 번호는 보관 기간 뒤 지워지도록 남긴다", async () => {
    const request = { ...input("ttl"), requestId: "replay-ttl", userId: "replay-user-ttl" };
    await runPurchase(request);

    const claim = await findRequestIdClaim(request.requestId);
    expect(claim!.expiresAt.getTime() - claim!.claimedAt.getTime()).toBe(REQUEST_ID_TTL_SECONDS * 1000);
    expect(await requestIdIndexes()).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
  });
});

describe("repeat-prompt: 같은 문장 반복", () => {
  const sendTimes = async (count: number, name: string, userId: string) => {
    const rules = [];
    for (let index = 0; index < count; index += 1) {
      rules.push(await blockedRule(runPurchase({ ...input(name), requestId: `${name}-${userId}-${index}`, userId })));
    }
    return rules;
  };

  it("요청 번호가 달라도 창 안에서 횟수에 닿으면 repeat-prompt 로 막힌다", async () => {
    const rules = await sendTimes(REPEAT_COUNT, "repeat", "repeat-user");

    expect(rules.slice(0, -1).every((rule) => rule === null)).toBe(true);
    expect(rules.at(-1)).toBe("repeat-prompt");
    const alerts = (await store.listAlerts(500)).filter((alert) => alert.rule === "repeat-prompt" && alert.userId === "repeat-user");
    expect(alerts).toMatchObject([{ blocked: true, stage: "on-request" }]);
  });

  it("API 로 보내면 409 와 규칙 이름을 돌려준다", async () => {
    const send = (index: number) =>
      post({ prompt: "이 글 요약해 줘 API", budget: "0.05", priority: "price", requestId: `repeat-api-${index}`, userId: "repeat-api-user" });
    for (let index = 0; index < REPEAT_COUNT - 1; index += 1) expect((await send(index)).status).toBe(200);

    const blocked = await send(REPEAT_COUNT);

    expect(blocked.status).toBe(409);
    expect((await blocked.json()).rule).toBe("repeat-prompt");
  });

  it("막힌 요청 번호는 창이 지난 뒤 다시 쓸 수 있다", async () => {
    await sendTimes(REPEAT_COUNT - 1, "repeat-again", "repeat-again-user");
    const request = { ...input("repeat-again"), requestId: "repeat-again-blocked", userId: "repeat-again-user" };
    expect(await blockedRule(runPurchase(request))).toBe("repeat-prompt");

    advanceClock(REPEAT_WINDOW_SECONDS);
    expect((await runPurchase(request)).status).toBe("SETTLED");
  });

  it("사용자와 문장은 따로 센다", async () => {
    const rules = [
      ...(await sendTimes(REPEAT_COUNT - 1, "repeat-apart", "repeat-apart-a")),
      ...(await sendTimes(1, "repeat-apart", "repeat-apart-b")),
      ...(await sendTimes(1, "repeat-apart-other", "repeat-apart-a")),
    ];
    expect(rules).not.toContain("repeat-prompt");
  });

  it("같은 요청 번호의 재전송은 같은 문장으로 세지 않는다", async () => {
    const request = { ...input("repeat-retry"), requestId: "repeat-retry", userId: "repeat-retry-user" };
    const first = await runPurchase(request);
    for (let index = 0; index < REPEAT_COUNT; index += 1) {
      expect((await runPurchase(request)).id).toBe(first.id);
    }
  });
});

describe("체인 규칙과 함께", () => {
  it("60초 결제 횟수는 체인이 막아 송금 전 실패로 남는다", async () => {
    const records = [];
    for (let index = 0; index <= 5; index += 1) {
      records.push(await runPurchase({ ...input(`rate-${index}`), requestId: `replay-rate-${index}`, userId: "replay-user-rate" }));
    }
    expect(records.at(-2)?.status).toBe("SETTLED");
    expect(records.at(-1)).toMatchObject({ status: "FAILED", failureStage: "before-send" });
  });

  it("서버 기록이 사라져도 체인이 같은 요청 번호의 결제를 막는다", async () => {
    const request = { ...input("chain"), requestId: "replay-chain", userId: "replay-user-chain" };
    const first = await runPurchase(request);
    expect(first.status).toBe("SETTLED");
    const balance = (await buyerBalance()).units;
    const { MongoClient } = await import("mongodb");
    const client = await new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017").connect();
    await client.db(process.env.MONGODB_DB).collection("replay_request_ids").deleteOne({ _id: request.requestId } as object);
    await client.close();

    const again = await runPurchase(request);

    expect(again).toMatchObject({ status: "FAILED", failureStage: "before-send" });
    expect((await buyerBalance()).units).toBe(balance);
  });
});
