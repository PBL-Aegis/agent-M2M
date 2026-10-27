import { afterAll, describe, expect, it } from "vitest";

import { parseAegis } from "../src/lib/format";

// 실행 중인 로컬 MongoDB에 테스트 전용 데이터베이스를 만들고 끝나면 통째로 지운다.
process.env.MONGODB_DB = `agent_m2m_test_${Date.now()}_api`;
const store = await import("../src/lib/store");
const { POST } = await import("../src/app/api/purchase/route");

afterAll(async () => {
  await store.dropTestDatabase();
  await store.closeStore();
});

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/purchase", { method: "POST", body: JSON.stringify(body) }));
}

describe("parseAegis", () => {
  it("사람이 적은 AEGIS 금액을 소수점 오차 없이 최소 단위로 바꾼다", () => {
    expect(parseAegis("0.5")).toBe(500_000);
    expect(parseAegis(0.1)).toBe(100_000);
    expect(parseAegis("3")).toBe(3_000_000);
    expect(parseAegis("0.000001")).toBe(1);
    expect(parseAegis(" 0.3 ")).toBe(300_000);
  });

  it("음수·글자·소수점 7자리 이상은 받지 않는다", () => {
    expect(parseAegis("-1")).toBeNull();
    expect(parseAegis("abc")).toBeNull();
    expect(parseAegis("0.0000001")).toBeNull();
    expect(parseAegis(undefined)).toBeNull();
  });
});

describe("POST /api/purchase 의 예산", () => {
  it("budget 을 AEGIS 로 받아 기록에는 최소 단위로 남긴다", async () => {
    const response = await post({ prompt: "이 글 요약해 줘", budget: "0.5", priority: "price" });
    expect(response.status).toBe(200);
    const record = await response.json();
    expect(record.status).toBe("SETTLED");
    expect(record.decision.budgetUnits).toBe(500_000);
  });

  it("예전 이름 budgetUnits 로 보내면 budget 을 쓰라고 400 으로 알린다", async () => {
    const response = await post({ prompt: "이 글 요약해 줘", budgetUnits: 500_000, priority: "price" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("budget");
  });

  it("budget 형식이 틀리면 400 이다", async () => {
    const response = await post({ prompt: "이 글 요약해 줘", budget: "많이", priority: "price" });
    expect(response.status).toBe(400);
  });
});
