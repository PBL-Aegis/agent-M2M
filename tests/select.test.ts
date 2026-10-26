import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { amountUnits, decide, eciScore, logHigherIsBetterScore, logLowerIsBetterScore, SelectionError } from "../src/lib/select";

/** 400 입력 토큰이 나오도록 1600 바이트짜리 ASCII 요청을 만든다(4바이트 = 1토큰 어림). */
const PROMPT_400 = "a".repeat(1600);

describe("amountUnits", () => {
  it("입력 400 · 최대 출력 8000 토큰일 때 세 모델의 금액", () => {
    const base = { inputTokens: 400, maxOutputTokens: 8000 };
    expect(amountUnits({ ...base, inputPricePerMillion: "0.4", outputPricePerMillion: "1.6" })).toBe(12960);
    expect(amountUnits({ ...base, inputPricePerMillion: "1", outputPricePerMillion: "5" })).toBe(40400);
    expect(amountUnits({ ...base, inputPricePerMillion: "0.3", outputPricePerMillion: "2.5" })).toBe(20120);
  });
});

describe("decide", () => {
  it("세 후보가 모두 예산 안이면 기본 우선순위는 테스트 Google 을 고른다", () => {
    const decision = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "default" });
    expect(decision.estimatedInputTokens).toBe(400);
    expect(decision.candidates).toHaveLength(3);
    expect(decision.rejected).toHaveLength(0);
    expect(decision.winner.key).toBe("google/test-flash");
    expect(decision.winner.amountUnits).toBe(20120);
    expect(decision.weights).toEqual({ price: 34, time: 33, intelligence: 33 });
  });

  it("가격 우선이면 테스트 OpenAI 를 고른다", () => {
    const decision = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "price" });
    expect(decision.winner.key).toBe("openai/test-mini");
    expect(decision.winner.amountUnits).toBe(12960);
    expect(decision.weights).toEqual({ price: 80, time: 10, intelligence: 10 });
  });

  it("reasoning 기능을 요구하면 테스트 Google 은 사유와 함께 탈락한다", () => {
    const decision = decide({
      prompt: PROMPT_400,
      budgetUnits: 50_000,
      priority: "default",
      requiredCapabilities: ["reasoning"],
    });
    expect(decision.candidates.map((item) => item.key)).not.toContain("google/test-flash");
    const google = decision.rejected.find((item) => item.key === "google/test-flash");
    expect(google).toBeDefined();
    expect(google!.reasons).toEqual(["필요 기능 없음: reasoning"]);
  });

  it("같은 입력이면 항상 같은 결과가 나온다", () => {
    const first = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "speed" });
    const second = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "speed" });
    expect(second).toEqual(first);
  });
});

describe("Epoch ECI 성능 점수", () => {
  it("ECI 는 후보 중 최저 0점·최고 100점으로 편다. 후보가 하나면 100점이다", () => {
    expect(eciScore(160, 140, 160)).toBe(100);
    expect(eciScore(140, 140, 160)).toBe(0);
    expect(eciScore(150, 140, 160)).toBe(50);
    expect(eciScore(150, 150, 150)).toBe(100);
  });

  it("성능 점수에 ECI·신뢰구간·속도를 잰 AA 항목을 남긴다", () => {
    const decision = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "intelligence" });
    const haiku = decision.candidates.find((item) => item.key === "anthropic/test-haiku")!;
    expect(haiku.intelligenceScore).toBe(100);
    expect(haiku.eci).toBe(160);
    expect([haiku.eciCiLow, haiku.eciCiHigh]).toEqual([157, 163]);
    expect(haiku.aaModelNames).toEqual(["Test Haiku"]);
    expect(decision.references.minEci).toBe(140);
    expect(decision.references.maxEci).toBe(160);
    const flash = decision.candidates.find((item) => item.key === "google/test-flash")!;
    expect(flash.intelligenceScore).toBe(50);
  });

  it("ECI 가 빠진 모델이 있으면 기본값으로 메우지 않고 멈춘다", () => {
    const fixtures = path.join(import.meta.dirname, "fixtures");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-m2m-"));
    cpSync(fixtures, dir, { recursive: true });
    const file = path.join(dir, "benchmark.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    delete snapshot.models[0].eci;
    writeFileSync(file, JSON.stringify(snapshot));
    const previous = process.env.AGENT_M2M_DATA_DIR;
    process.env.AGENT_M2M_DATA_DIR = dir;
    try {
      expect(() => decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "default" })).toThrow(
        SelectionError,
      );
    } finally {
      process.env.AGENT_M2M_DATA_DIR = previous;
    }
  });
});

describe("가격·속도 로그 점수", () => {
  it("가장 싼 값 100점, 가장 비싼 값 0점이고, 2배 차이는 어느 구간에서든 같은 점수 차이다", () => {
    expect(logLowerIsBetterScore(1, 1, 8)).toBe(100);
    expect(logLowerIsBetterScore(8, 1, 8)).toBeCloseTo(0, 9);
    const step1 = logLowerIsBetterScore(1, 1, 8) - logLowerIsBetterScore(2, 1, 8);
    const step2 = logLowerIsBetterScore(4, 1, 8) - logLowerIsBetterScore(8, 1, 8);
    expect(step1).toBeCloseTo(step2, 9);
    expect(logLowerIsBetterScore(5, 5, 5)).toBe(100);
  });

  it("가격 우선에서 가장 싼 후보 100점, 가장 비싼 후보 0점, 중간은 로그 위치대로다", () => {
    const decision = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "price" });
    const score = (key: string) => decision.candidates.find((item) => item.key === key)!.priceScore;
    expect(score("openai/test-mini")).toBe(100);
    expect(score("anthropic/test-haiku")).toBe(0);
    expect(score("google/test-flash")).toBeCloseTo(61.31, 1);
  });

  it("출력 속도는 클수록 좋다. 가장 빠른 후보 100점, 가장 느린 후보 0점이다", () => {
    expect(logHigherIsBetterScore(150, 40, 150)).toBe(100);
    expect(logHigherIsBetterScore(40, 40, 150)).toBeCloseTo(0, 9);
    const decision = decide({ prompt: PROMPT_400, budgetUnits: 50_000, priority: "speed" });
    expect(decision.winner.key).toBe("google/test-flash");
    expect(decision.winner.outputTokensPerSecond).toBe(150);
    expect(decision.references.minOutputTokensPerSecond).toBe(40);
    expect(decision.references.maxOutputTokensPerSecond).toBe(150);
  });
});
