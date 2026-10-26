import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// store.ts 는 불러올 때 접속 정보를 읽으므로, 환경변수를 먼저 정한 뒤 동적으로 불러온다.
process.env.MONGODB_DB = `agent_m2m_test_${Date.now()}_bench`;
const store = await import("../src/lib/store");
const { loadFreshSnapshot } = await import("../src/lib/benchmark");

const HOUR = 60 * 60 * 1000;
const originalFetch = globalThis.fetch;
const previousDataDir = process.env.AGENT_M2M_DATA_DIR;

// 픽스처를 임시 폴더에 복사해 쓴다. 시작값(benchmark.json)은 픽스처 그대로다.
beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-m2m-bench-"));
  cpSync(path.join(import.meta.dirname, "fixtures"), dir, { recursive: true });
  process.env.AGENT_M2M_DATA_DIR = dir;
  process.env.AA_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  process.env.AGENT_M2M_DATA_DIR = previousDataDir;
  delete process.env.AA_API_KEY;
  await store.dropTestDatabase();
  await store.closeStore();
});

const MODELS = [
  { epoch: "Test Mini", openRouter: "openai/test-mini", aa: "test-mini" },
  { epoch: "Test Haiku", openRouter: "anthropic/test-haiku", aa: "test-haiku" },
  { epoch: "Test Flash", openRouter: "google/test-flash", aa: "test-flash" },
];

/** 세 출처를 흉내 낸다. Epoch 는 CSV, 나머지는 JSON 이다. */
function fakeSources(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://epoch.ai/")) {
      const rows = MODELS.map((model) => `${model.epoch},${model.epoch},150,148,152,2026-10-01,Org,Country,API access,Closed weights,`);
      const header = "Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization,Country (of organization),Model accessibility,Accessibility group,model_versions";
      return new Response([header, ...rows].join("\n"));
    }
    if (url.startsWith("https://openrouter.ai/")) {
      const data = MODELS.map((model) => ({
        id: model.openRouter,
        name: model.epoch,
        pricing: { prompt: "0.000001", completion: "0.000002" },
      }));
      return new Response(JSON.stringify({ data }));
    }
    const data = MODELS.map((model) => ({
      slug: model.aa,
      name: model.epoch,
      performance: { median_output_tokens_per_second: 100 },
    }));
    return new Response(JSON.stringify({ data }));
  });
}

describe("loadFreshSnapshot", () => {
  it("값이 1시간보다 오래되면 실패해도 마지막 값으로 계속하고 사유를 남긴다", async () => {
    globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as typeof fetch;
    const result = await loadFreshSnapshot();
    expect(result.snapshot.snapshotId).toBe("test-fixture-v3");
    expect(result.refreshError).toMatch(/503/);
  });

  it("값이 오래되면 세 출처에서 새로 받아 저장한다", async () => {
    const fetchMock = fakeSources();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await loadFreshSnapshot();
    expect(result.refreshError).toBeNull();
    expect(result.snapshot.models.map((model) => [model.key, model.eci, model.inputPricePerMillion])).toEqual([
      ["openai/test-mini", "150", "1"],
      ["anthropic/test-haiku", "150", "1"],
      ["google/test-flash", "150", "1"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await store.latestSnapshot()).toEqual({ snapshot: result.snapshot, hash: result.hash });
  });

  it("1시간이 지나지 않았으면 다시 받지 않는다", async () => {
    const fetchMock = fakeSources();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const latest = await store.latestSnapshot();
    const result = await loadFreshSnapshot(Date.parse(latest!.snapshot.capturedAt) + HOUR - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.hash).toBe(latest!.hash);
  });
});
