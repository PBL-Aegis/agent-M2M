/**
 * 재시도·재전송 규칙(replay.ts)이 쓰는 저장소. MongoDB 의 두 컬렉션에 "확인"과 "기록"을 명령 하나로 같이 한다.
 *
 *   replay_request_ids  쓴 요청 번호. 요청 번호를 `_id` 로 넣으므로 같은 번호를 두 번 넣으면 DB 가 거부한다.
 *   replay_prompts      사용자별 같은 문장 횟수 창. 창 시작 시각과 그 안의 횟수를 문서 하나에서 함께 바꾼다.
 *
 * 두 컬렉션 모두 expiresAt 이 지나면 MongoDB 의 TTL index 가 문서를 지운다(약 1분 간격으로 돈다).
 * 서버가 여러 대여도 DB 가 한 번에 하나씩 처리하므로, 거의 동시에 온 요청 둘이 함께 통과하지 않는다.
 */

import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";

const REQUEST_IDS = "replay_request_ids";
const PROMPTS = "replay_prompts";
const DUPLICATE_KEY = 11000;

/** purchaseId 는 이 요청 번호를 지금 처리하는(마지막으로 처리한) 시도의 구매 번호다. */
export type RequestIdClaim = { _id: string; purchaseId: string; claimedAt: Date; expiresAt: Date };
type PromptWindow = { _id: string; windowStart: number; count: number; expiresAt: Date };

let client: MongoClient | null = null;
let ready: Promise<Db> | null = null;

async function connect(): Promise<Db> {
  const connected = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
  await connected.connect();
  client = connected;
  const db = connected.db(process.env.MONGODB_DB ?? "agent_m2m");
  await db.collection<RequestIdClaim>(REQUEST_IDS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection<PromptWindow>(PROMPTS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return db;
}

async function collection<T extends { _id: string }>(name: string): Promise<Collection<T>> {
  ready ??= connect();
  return (await ready).collection<T>(name);
}

function claimFields(purchaseId: string, now: number, ttlMs: number) {
  return { purchaseId, claimedAt: new Date(now), expiresAt: new Date(now + ttlMs) };
}

/** 요청 번호를 처음 쓰면 null, 이미 있으면 그 기록을 돌려준다. */
export async function claimRequestId(
  requestId: string,
  purchaseId: string,
  now: number,
  ttlMs: number,
): Promise<RequestIdClaim | null> {
  const claims = await collection<RequestIdClaim>(REQUEST_IDS);
  try {
    await claims.insertOne({ _id: requestId, ...claimFields(purchaseId, now, ttlMs) });
    return null;
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== DUPLICATE_KEY) throw error;
  }
  const existing = await claims.findOne({ _id: requestId });
  // 그사이 지워졌으면 아직 누가 처리 중인지 알 수 없다. 이미 있는 것으로 돌려줘 호출한 쪽이 다시 보내게 한다.
  return existing ?? { _id: requestId, ...claimFields(purchaseId, now, ttlMs) };
}

/** 이전 시도(fromPurchaseId)의 요청 번호를 넘겨받는다. 동시에 시도해도 한쪽만 true 를 받는다. */
export async function retakeRequestId(
  requestId: string,
  fromPurchaseId: string,
  purchaseId: string,
  now: number,
  ttlMs: number,
): Promise<boolean> {
  const result = await (await collection<RequestIdClaim>(REQUEST_IDS)).updateOne(
    { _id: requestId, purchaseId: fromPurchaseId },
    { $set: claimFields(purchaseId, now, ttlMs) },
  );
  return result.modifiedCount === 1;
}

/** 처리하지 않기로 한 요청 번호를 내려놓는다. 같은 번호로 다시 보낼 수 있게 된다. */
export async function releaseRequestId(requestId: string, purchaseId: string): Promise<void> {
  await (await collection<RequestIdClaim>(REQUEST_IDS)).deleteOne({ _id: requestId, purchaseId });
}

/**
 * 같은 문장 한 번을 창에 더하고, 더한 뒤의 창 안 횟수를 돌려준다.
 * 창이 없거나 시작한 지 windowMs 가 지났으면 지금부터 새 창을 연다.
 */
export async function countPromptInWindow(key: string, now: number, windowMs: number): Promise<number> {
  const fresh = { $or: [{ $eq: [{ $type: "$windowStart" }, "missing"] }, { $lte: ["$windowStart", now - windowMs] }] };
  const updated = await (await collection<PromptWindow>(PROMPTS)).findOneAndUpdate(
    { _id: key },
    [
      {
        $set: {
          windowStart: { $cond: [fresh, now, "$windowStart"] },
          count: { $cond: [fresh, 1, { $add: ["$count", 1] }] },
          expiresAt: new Date(now + windowMs),
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );
  if (updated === null) throw new Error(`같은 문장 횟수를 기록하지 못했습니다: ${key}`);
  return updated.count;
}

/** 요청 번호 기록을 읽는다. 테스트가 보관 기간을 확인할 때 쓴다. */
export async function findRequestIdClaim(requestId: string): Promise<RequestIdClaim | null> {
  return (await collection<RequestIdClaim>(REQUEST_IDS)).findOne({ _id: requestId });
}

/** 요청 번호 표의 색인 목록. 테스트가 TTL index 를 확인할 때 쓴다. */
export async function requestIdIndexes(): Promise<Array<{ key: object; expireAfterSeconds?: number }>> {
  return (await collection<RequestIdClaim>(REQUEST_IDS)).indexes();
}

/** 테스트가 연결을 정리할 때 쓴다. */
export async function closeReplayStore(): Promise<void> {
  const open = client;
  client = null;
  ready = null;
  await open?.close();
}
