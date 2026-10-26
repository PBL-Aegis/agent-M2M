import { describe, expect, it } from "vitest";

import { buildCatalog, buildSnapshot, normalizeName, parseCsv, perMillion } from "../src/lib/benchmark-sources.mjs";

describe("perMillion", () => {
  it("토큰당 단가를 1M 토큰당 단가로 소수점 오차 없이 바꾼다", () => {
    expect(perMillion("0.0000001")).toBe("0.1");
    expect(perMillion("0.000002")).toBe("2");
    expect(perMillion("0.00000025")).toBe("0.25");
    expect(perMillion("0.0000002574")).toBe("0.2574");
  });

  it("0·음수·빈 값은 가격으로 쓰지 않는다", () => {
    expect(perMillion("0")).toBeNull();
    expect(perMillion("-1")).toBeNull();
    expect(perMillion(undefined)).toBeNull();
  });
});

describe("parseCsv", () => {
  it("따옴표 안의 쉼표를 지킨다", () => {
    expect(parseCsv('Model,note\nA,"x, y"\n')).toEqual([{ Model: "A", note: "x, y" }]);
  });
});

const epoch = (name: string, eci = "150") => ({ Model: name, eci, eci_ci_low: "148", eci_ci_high: "152", date: "2026-10-01" });
const listing = (id: string, name: string, prompt = "0.000001") => ({
  id,
  name: `Org: ${name}`,
  pricing: { prompt, completion: "0.000002" },
  supported_parameters: ["reasoning", "tools"],
  architecture: { input_modalities: ["text", "image"] },
});
const aa = (slug: string, name: string, speed: number | null = 100) => ({
  slug,
  name,
  performance: { median_output_tokens_per_second: speed },
});

describe("buildCatalog", () => {
  const recipient = (provider: string) => `0x${provider}`;

  it("세 출처 이름이 기호·대소문자만 다르면 짝짓고, OpenRouter 기능을 옮긴다", () => {
    const catalog = buildCatalog([epoch("Claude Opus 5.5")], [listing("anthropic/claude-opus-5.5", "Claude Opus 5.5")], [aa("claude-opus-5-5", "Claude Opus 5.5")], recipient);
    expect(catalog.entries).toEqual([
      {
        key: "anthropic/claude-opus-5.5",
        providerId: "anthropic",
        providerModelId: "claude-opus-5.5",
        displayName: "Claude Opus 5.5",
        epochModel: "Claude Opus 5.5",
        openRouterId: "anthropic/claude-opus-5.5",
        aaSlugs: ["claude-opus-5-5"],
        recipient: "0xanthropic",
        capabilities: ["reasoning", "tools", "vision"],
      },
    ]);
    expect(normalizeName("Claude Opus 5.5")).toBe(normalizeName("claude-opus-5.5"));
  });

  it("AA 생각 단계가 여러 개면 모두 묶고, 출력 속도는 단계별 평균을 쓴다", () => {
    const epochRows = [epoch("Model A")];
    const listings = [listing("org/model-a", "Model A")];
    const variants = [aa("a-low", "Model A (Low)", 100), aa("a-max", "Model A (Max)", 110), aa("a-off", "Model A (Non-reasoning)", null)];
    const catalog = buildCatalog(epochRows, listings, variants, recipient);
    expect(catalog.entries.map((entry) => [entry.key, entry.aaSlugs])).toEqual([["org/model-a", ["a-low", "a-max"]]]);
    const snapshot = buildSnapshot(catalog, epochRows, listings, variants);
    expect(snapshot.models[0]!.outputTokensPerSecond).toBe("105");
    expect(snapshot.models[0]!.aaModelNames).toEqual(["Model A (Low)", "Model A (Max)"]);
  });

  it("AA 에 이름은 있지만 출력 속도가 없으면 뺀다", () => {
    const catalog = buildCatalog([epoch("Model B")], [listing("org/model-b", "Model B")], [aa("b", "Model B", null)], recipient);
    expect(catalog.entries).toEqual([]);
    expect(catalog.excluded).toEqual([{ name: "Model B", reason: "AA 출력 속도 없음 또는 0" }]);
  });

  it("이름이 다르거나 가격이 0 이면 추측하지 않고 이유와 함께 뺀다", () => {
    const catalog = buildCatalog(
      [epoch("Model C"), epoch("Model D")],
      [listing("org/model-c-pro", "Model C Pro"), listing("org/model-d", "Model D", "0")],
      [aa("c", "Model C"), aa("d", "Model D")],
      recipient,
    );
    expect(catalog.entries).toEqual([]);
    expect(catalog.excluded).toEqual([
      { name: "Model C", reason: "OpenRouter 에 같은 이름 없음" },
      { name: "Model D", reason: "OpenRouter 가격 없음 또는 0" },
    ]);
  });

  it("ECI 가 최소 성능 기준보다 낮으면 이유와 함께 뺀다", () => {
    const catalog = buildCatalog([epoch("Model E", "139.9")], [listing("org/model-e", "Model E")], [aa("e", "Model E")], recipient);
    expect(catalog.entries).toEqual([]);
    expect(catalog.excluded).toEqual([{ name: "Model E", reason: "최소 성능 기준(ECI 140) 미만: 139.9" }]);
  });
});
