/**
 * 세 출처에서 값을 떠서 판매 목록(catalog)과 스냅샷을 만든다.
 * 앱(구매 시 자동 갱신)과 scripts/capture-benchmark.mjs 가 같이 쓴다.
 *
 *   Epoch AI       — 성능. Epoch Capabilities Index(ECI)와 95% 신뢰구간. 여러 벤치마크를 난이도까지
 *                    고려해 통계적으로 합친 지수다. 키 없이 받는다.
 *   OpenRouter     — 가격. 실제로 파는 1M 토큰당 입력·출력 단가. 키 없이 받는다.
 *   Artificial Analysis — 속도. 하루 여러 번 잰 끝까지 걸린 시간의 최근 72시간 중앙값. AA_API_KEY 가 필요하다.
 *
 * 판매 목록은 사람이 이름을 적지 않고 buildCatalog 가 만든다. 짝짓기는 추측하지 않는다.
 *   - 세 출처의 모델 이름에서 기호를 빼고 소문자로 바꾼 값이 정확히 같을 때만 짝짓는다.
 *   - AA 는 같은 모델을 생각 단계별로 따로 잰다. 단계가 하나뿐이거나 Default 로 표시된 단계가
 *     하나일 때만 쓰고, 여러 단계 중 무엇을 팔지 정해지지 않은 모델은 뺀다.
 *   - 값이 비거나 0 인 모델도 뺀다. 빈칸을 기본값으로 채우지 않는다.
 *   - ECI 가 MIN_ECI 보다 낮은 모델은 팔지 않는다(판매 최소 품질 기준). 운영 판단으로 정한 값이다.
 * 뺀 모델은 이유와 함께 catalog.excluded 에 남긴다.
 *
 * 판매 목록은 capture 스크립트를 돌려 사람이 확인하고 커밋할 때만 바뀐다. 자동 갱신은 목록에 있는
 * 모델의 숫자만 새로 받고, 한 출처라도 값이 없으면 스냅샷을 만들지 않고 멈춘다.
 */

export const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
export const EPOCH_ECI_URL = "https://epoch.ai/data/eci_scores.csv";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
/** 판매 최소 품질 기준. 이보다 ECI 가 낮은 모델은 판매 목록에 넣지 않는다. */
export const MIN_ECI = 140;

function at(object, dotted) {
  return dotted.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object);
}

/** 이름 비교용. 기호와 공백을 빼고 소문자로. "Claude Opus 5.5" 와 "claude-opus-5.5" 가 같아진다. */
export function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 0 보다 큰 소수점 문자열인지. 숫자는 문자열로 둬서 소수점 오차를 만들지 않는다. */
function positiveDecimal(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  return /[1-9]/.test(text) ? text : null;
}

/** 토큰 1개당 단가(문자열)를 1M 토큰당 단가로. 소수점만 여섯 자리 옮긴다. */
export function perMillion(perToken) {
  const text = positiveDecimal(perToken);
  if (text === null) return null;
  const [whole, fraction = ""] = text.split(".");
  const digits = `${whole}${fraction.padEnd(6, "0")}`;
  const point = whole.length + 6;
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  const rest = digits.slice(point).replace(/0+$/, "");
  return rest === "" ? integer : `${integer}.${rest}`;
}

/** 따옴표 안의 쉼표·줄바꿈을 지키는 작은 CSV 읽기. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((item) => item.some((cell) => cell !== ""));
  return body.map((cells) => Object.fromEntries(header.map((name, column) => [name, cells[column] ?? ""])));
}

export async function fetchAa(key) {
  const response = await fetch(AA_URL, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`AA API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length === 0) throw new Error("AA 응답에 모델 목록이 없습니다");
  return data;
}

export async function fetchEpoch() {
  const response = await fetch(EPOCH_ECI_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Epoch ECI ${response.status}`);
  const rows = parseCsv(await response.text());
  if (rows.length === 0 || !("eci" in rows[0])) throw new Error("Epoch 응답에 ECI 표가 없습니다");
  return rows;
}

export async function fetchOpenRouter() {
  const response = await fetch(OPENROUTER_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
  const body = await response.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length === 0) throw new Error("OpenRouter 응답에 모델 목록이 없습니다");
  return data;
}

/** OpenRouter 이름 "Anthropic: Claude Opus 5" 에서 회사 이름을 뗀다. */
function openRouterName(model) {
  return String(model.name ?? model.id).split(": ").slice(-1)[0];
}

/** ":free", ":batch" 처럼 같은 모델의 다른 판매 방식은 빼고 기본 판매만 본다. */
function isBaseListing(model) {
  return typeof model.id === "string" && !model.id.includes(":");
}

/** AA 이름 "Claude Haiku 5.5 (High)" 에서 단계 표시를 뗀다. */
function aaBaseName(model) {
  return String(model.name ?? "").replace(/\s*\(.*?\)/g, "").trim();
}

function capabilitiesOf(model) {
  const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
  const inputs = Array.isArray(model.architecture?.input_modalities) ? model.architecture.input_modalities : [];
  const result = [];
  if (parameters.includes("reasoning")) result.push("reasoning");
  if (parameters.includes("tools")) result.push("tools");
  if (inputs.includes("image")) result.push("vision");
  return result;
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/**
 * 세 출처를 짝지어 판매 목록을 만든다. recipientOf(providerId) 는 회사별 판매자 주소를 돌려준다.
 * ECI 가 높은 순서로 적는다.
 */
export function buildCatalog(epochRows, openRouterModels, aaModels, recipientOf, now = new Date()) {
  const openRouter = groupBy(openRouterModels.filter(isBaseListing), (model) => normalizeName(openRouterName(model)));
  const aa = groupBy(aaModels, (model) => normalizeName(aaBaseName(model)));
  const entries = [];
  const excluded = [];

  const ranked = [...epochRows].sort((left, right) => Number(right.eci) - Number(left.eci));
  for (const row of ranked) {
    const name = row.Model;
    const key = normalizeName(name);
    const skip = (reason) => excluded.push({ name, reason });

    if (positiveDecimal(row.eci) === null) {
      skip("Epoch ECI 값 없음");
      continue;
    }
    if (Number(row.eci) < MIN_ECI) {
      skip(`최소 성능 기준(ECI ${MIN_ECI}) 미만: ${row.eci}`);
      continue;
    }
    const listings = openRouter.get(key) ?? [];
    if (listings.length === 0) {
      skip("OpenRouter 에 같은 이름 없음");
      continue;
    }
    if (listings.length > 1) {
      skip(`OpenRouter 에 같은 이름이 여러 개: ${listings.map((item) => item.id).join(", ")}`);
      continue;
    }
    const listing = listings[0];
    const input = perMillion(at(listing, "pricing.prompt"));
    const output = perMillion(at(listing, "pricing.completion"));
    if (input === null || output === null) {
      skip("OpenRouter 가격 없음 또는 0");
      continue;
    }
    const variants = aa.get(key) ?? [];
    if (variants.length === 0) {
      skip("Artificial Analysis 에 같은 이름 없음");
      continue;
    }
    const defaults = variants.filter((item) => /default/i.test(String(item.name)));
    const picked = variants.length === 1 ? variants[0] : defaults.length === 1 ? defaults[0] : null;
    if (picked === null) {
      skip(`AA 생각 단계가 여러 개라 팔 단계 미정: ${variants.map((item) => item.name).join(", ")}`);
      continue;
    }
    if (positiveDecimal(at(picked, "performance.median_end_to_end_response_time_seconds")) === null) {
      skip("AA 응답시간 없음 또는 0");
      continue;
    }

    const [providerId, providerModelId] = listing.id.split("/");
    entries.push({
      key: listing.id,
      providerId,
      providerModelId,
      displayName: name,
      epochModel: name,
      openRouterId: listing.id,
      aaSlug: String(picked.slug),
      recipient: recipientOf(providerId),
      capabilities: capabilitiesOf(listing),
    });
  }

  return {
    catalogVersion: `agent-m2m-${now.toISOString().slice(0, 10)}`,
    matching:
      `ECI ${MIN_ECI} 이상이고, Epoch·OpenRouter·AA 이름(기호 제거, 소문자)이 정확히 같고, ` +
      "AA 생각 단계가 하나이거나 Default 단계가 하나인 모델만",
    entries,
    excluded,
  };
}

/** 판매 목록의 모델마다 세 출처의 값을 짝지어 스냅샷을 만든다. 하나라도 없으면 멈춘다. */
export function buildSnapshot(catalog, epochRows, openRouterModels, aaModels, now = new Date()) {
  const models = catalog.entries.map((entry) => {
    const epoch = epochRows.find((row) => row.Model === entry.epochModel);
    if (epoch === undefined) throw new Error(`Epoch 에 ${entry.epochModel} 가 없습니다`);
    const listing = openRouterModels.find((model) => model.id === entry.openRouterId);
    if (listing === undefined) throw new Error(`OpenRouter 에 ${entry.openRouterId} 가 없습니다`);
    const aa = aaModels.find((model) => model.slug === entry.aaSlug);
    if (aa === undefined) throw new Error(`AA 에 슬러그 ${entry.aaSlug} 가 없습니다`);

    const values = {
      eci: positiveDecimal(epoch.eci),
      eciCiLow: positiveDecimal(epoch.eci_ci_low),
      eciCiHigh: positiveDecimal(epoch.eci_ci_high),
      inputPricePerMillion: perMillion(at(listing, "pricing.prompt")),
      outputPricePerMillion: perMillion(at(listing, "pricing.completion")),
      medianEndToEndSeconds: positiveDecimal(at(aa, "performance.median_end_to_end_response_time_seconds")),
    };
    const missing = Object.entries(values).filter(([, value]) => value === null).map(([name]) => name);
    if (missing.length > 0) throw new Error(`${entry.key}: 값이 없습니다 (${missing.join(", ")})`);

    return {
      key: entry.key,
      epochModel: entry.epochModel,
      epochDate: epoch.date,
      ...values,
      openRouterId: entry.openRouterId,
      aaSlug: entry.aaSlug,
      aaModelName: String(aa.name ?? entry.aaSlug),
    };
  });

  const iso = now.toISOString();
  return {
    snapshotId: `epoch-openrouter-aa-${iso.slice(0, 16)}`,
    capturedAt: iso,
    source: "epoch.ai + openrouter.ai + artificialanalysis.ai",
    sources: { epoch: EPOCH_ECI_URL, openRouter: OPENROUTER_URL, aa: AA_URL },
    note:
      "성능은 Epoch Capabilities Index(95% 신뢰구간 포함), 가격은 OpenRouter 판매 단가, " +
      "속도는 Artificial Analysis 가 잰 끝까지 걸린 시간의 최근 72시간 중앙값입니다.",
    models,
  };
}
