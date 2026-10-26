/**
 * 벤치마크 표와 판매 목록을 읽어오는 곳.
 *
 * 표는 고른 순간의 값으로 고정되어야 한다. 그래서 파일을 읽은 뒤 내용 전체의 지문(해시)을
 * 같이 만들어 두고, 결정 기록에 그 지문을 남긴다. 나중에 같은 계산을 다시 해볼 때
 * "그때 본 숫자"가 무엇이었는지 확인할 수 있다.
 *
 * 구매 때는 loadFreshSnapshot 을 쓴다. 가장 최근 값이 1시간보다 오래됐으면 세 출처(Epoch·OpenRouter·AA)에서 새로 받아
 * MongoDB 에 쌓고, 받다가 실패하면 마지막 값으로 계속하면서 실패 사유를 결정 기록에 남긴다.
 * data/benchmark.json 은 한 번도 받지 않았을 때 쓰는 시작값이다.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildSnapshot, fetchAa, fetchEpoch, fetchOpenRouter } from "./benchmark-sources.mjs";
import { latestSnapshot, saveSnapshot } from "./store";
import type { BenchmarkModel, BenchmarkSnapshot, Catalog, CatalogEntry } from "./types";

const MAX_AGE_MS = 60 * 60 * 1000;

// 테스트는 값이 고정된 픽스처 폴더를 가리킨다. 실제 실행은 data/ 를 쓴다.
function dataDir(): string {
  return process.env.AGENT_M2M_DATA_DIR ?? path.join(process.cwd(), "data");
}

function readJson<T>(fileName: string): { value: T; hash: string } {
  const raw = readFileSync(path.join(dataDir(), fileName), "utf8");
  const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return { value: JSON.parse(raw) as T, hash };
}

export function loadSnapshot(): { snapshot: BenchmarkSnapshot; hash: string } {
  const { value, hash } = readJson<BenchmarkSnapshot>("benchmark.json");
  return { snapshot: value, hash };
}

/** data/benchmark.json 과 같은 모양으로 직렬화한 내용의 지문. 파일에서 읽은 해시와 맞아떨어진다. */
export function snapshotHash(snapshot: BenchmarkSnapshot): string {
  const raw = `${JSON.stringify(snapshot, null, 2)}\n`;
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export interface FreshSnapshot {
  snapshot: BenchmarkSnapshot;
  hash: string;
  /** 새로 받으려다 실패했을 때만 채워진다. 이때 snapshot 은 마지막으로 받은 값이다. */
  refreshError: string | null;
}

// 동시에 여러 구매가 들어와도 외부 호출은 한 번만 한다.
let refreshing: Promise<{ snapshot: BenchmarkSnapshot; hash: string }> | null = null;

async function refresh(): Promise<{ snapshot: BenchmarkSnapshot; hash: string }> {
  const key = process.env.AA_API_KEY?.trim();
  if (key === undefined || key === "") throw new Error("AA_API_KEY 가 없습니다");
  const [epochRows, openRouterModels, aaModels] = await Promise.all([fetchEpoch(), fetchOpenRouter(), fetchAa(key)]);
  const snapshot = buildSnapshot(loadCatalog(), epochRows, openRouterModels, aaModels);
  const hash = snapshotHash(snapshot);
  await saveSnapshot(hash, snapshot);
  return { snapshot, hash };
}

export async function loadFreshSnapshot(now = Date.now()): Promise<FreshSnapshot> {
  const current = (await latestSnapshot()) ?? loadSnapshot();
  if (now - Date.parse(current.snapshot.capturedAt) < MAX_AGE_MS) {
    return { ...current, refreshError: null };
  }
  try {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return { ...(await refreshing), refreshError: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "알 수 없는 오류";
    return { ...current, refreshError: reason };
  }
}

export function loadCatalog(): Catalog {
  return readJson<Catalog>("catalog.json").value;
}

/** 카탈로그의 모델과 벤치마크 줄을 키로 짝지어 준다. 짝이 없으면 구매를 멈춘다. */
export function pairEntries(
  catalog: Catalog,
  snapshot: BenchmarkSnapshot,
): { entry: CatalogEntry; metrics: BenchmarkModel }[] {
  return catalog.entries.map((entry) => {
    const metrics = snapshot.models.find((model) => model.key === entry.key);
    if (metrics === undefined) {
      throw new Error(`벤치마크 표에 ${entry.key} 의 숫자가 없습니다`);
    }
    return { entry, metrics };
  });
}
