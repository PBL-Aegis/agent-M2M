/**
 * 세 출처(Epoch·OpenRouter·AA)를 떠서 판매 목록과 시작값을 새로 만든다. 수집·짝짓기 로직은
 * src/lib/benchmark-sources.mjs 에 있고, 앱도 구매 때 같은 로직으로 숫자를 갱신한다.
 *
 *   node scripts/capture-benchmark.mjs          data/catalog.json · data/benchmark.json · data/sellers.json 갱신
 *   node scripts/capture-benchmark.mjs --list   저장하지 않고 짝지어진 모델과 뺀 모델만 보여 줌
 *
 * 판매 목록이 바뀌는 곳은 여기뿐이다. 결과를 확인하고 커밋한다.
 * 판매자 주소는 회사별로 하나다. 처음 보는 회사에는 anvil 공개 테스트 계정(2번부터)을 차례로 붙이고,
 * 한 번 붙인 주소는 data/sellers.json 에 남겨 다시 바꾸지 않는다.
 * AA 키는 .env.local 의 AA_API_KEY 에서만 읽고, 저장 파일에는 넣지 않는다.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { mnemonicToAccount } from "viem/accounts";

import { buildCatalog, buildSnapshot, fetchAa, fetchEpoch, fetchOpenRouter } from "../src/lib/benchmark-sources.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const SELLERS_FILE = path.join(DATA, "sellers.json");
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** 0번은 운영자, 1번은 구매자라 판매자는 2번부터 쓴다. */
const FIRST_SELLER_INDEX = 2;

function loadKey() {
  const fromEnv = process.env.AA_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const text = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const line = text.split("\n").find((item) => item.startsWith("AA_API_KEY="));
  if (line === undefined) throw new Error(".env.local 에 AA_API_KEY 가 없습니다");
  const value = line.slice("AA_API_KEY=".length).trim();
  if (value === "") throw new Error("AA_API_KEY 값이 비어 있습니다");
  return value;
}

function loadSellers() {
  if (!existsSync(SELLERS_FILE)) return { note: "", sellers: {} };
  return JSON.parse(readFileSync(SELLERS_FILE, "utf8"));
}

const [epochRows, openRouterModels, aaModels] = await Promise.all([fetchEpoch(), fetchOpenRouter(), fetchAa(loadKey())]);

const sellers = loadSellers();
const used = Object.values(sellers.sellers).map((item) => item.index);
let nextIndex = Math.max(FIRST_SELLER_INDEX - 1, ...used) + 1;
function recipientOf(providerId) {
  if (sellers.sellers[providerId] === undefined) {
    const index = nextIndex;
    nextIndex += 1;
    sellers.sellers[providerId] = { index, address: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).address };
  }
  return sellers.sellers[providerId].address;
}

const catalog = buildCatalog(epochRows, openRouterModels, aaModels, recipientOf);
const snapshot = buildSnapshot(catalog, epochRows, openRouterModels, aaModels);

console.log(`짝지어진 모델 ${catalog.entries.length}개 · 뺀 모델 ${catalog.excluded.length}개 (Epoch ${epochRows.length}개 중)`);
for (const model of snapshot.models) {
  console.log(
    `  ${model.key}: ECI ${model.eci} (${model.eciCiLow}~${model.eciCiHigh}) · ` +
      `$${model.inputPricePerMillion}/${model.outputPricePerMillion} · ${model.medianEndToEndSeconds}초 [${model.aaModelName}]`,
  );
}

if (process.argv.includes("--list")) {
  console.log("\n뺀 모델");
  for (const item of catalog.excluded) console.log(`  ${item.name}: ${item.reason}`);
  process.exit(0);
}

sellers.note =
  "회사별 판매자 주소. anvil 공개 테스트 계정(index)이라 실제 자산이 없다. capture 스크립트가 처음 보는 회사에만 새로 붙인다.";
writeFileSync(SELLERS_FILE, `${JSON.stringify(sellers, null, 2)}\n`);
writeFileSync(path.join(DATA, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(path.join(DATA, "benchmark.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log("\n저장 완료: data/catalog.json · data/benchmark.json · data/sellers.json");
