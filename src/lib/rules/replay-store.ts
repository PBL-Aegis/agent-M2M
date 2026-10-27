/**
 * 재전송·연타 규칙(replay.ts)이 쓰는 저장소. MongoDB 의 두 컬렉션에 "확인"과 "기록"을 명령 하나로 같이 한다.
 *
 *   replay_request_ids  쓴 요청 번호. 요청 번호를 `_id` 로 넣으므로 같은 번호를 두 번 넣으면 DB 가 거부한다.
 *   replay_windows      사용자별 결제 횟수 창. 창 시작 시각과 그 안의 횟수를 문서 하나에서 함께 바꾼다.
 *
 * 서버가 여러 대여도 DB 가 한 번에 하나씩 처리하므로, 거의 동시에 온 요청 둘이 함께 통과하지 않는다.
 */

import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";

const REQUEST_IDS = "replay_request_ids";
const WINDOWS = "replay_windows";
const DUPLICATE_KEY = 11000;

type RequestIdDocument = { _id: string; claimedAt: string; purchaseId: string };
type WindowDocument = { _id: string; windowStart: number; count: number };

let client: MongoClient | null = null;
let ready: Promise<Db> | null = null;

async function connect(): Promise<Db> {
  const connected = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017");
  await connected.connect();
  client = connected;
  return connected.db(process.env.MONGODB_DB ?? "agent_m2m");
}

async function collection<T extends { _id: string }>(name: string): Promise<Collection<T>> {
  ready ??= connect();
  return (await ready).collection<T>(name);
}

/** 요청 번호를 처음 쓰면 true, 이미 쓴 번호면 false. */
export async function claimRequestId(requestId: string, purchaseId: string): Promise<boolean> {
  try {
    await (await collection<RequestIdDocument>(REQUEST_IDS)).insertOne({
      _id: requestId,
      claimedAt: new Date().toISOString(),
      purchaseId,
    });
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) return false;
    throw error;
  }
}

/**
 * 사용자의 결제 한 건을 창에 더하고, 더한 뒤의 창 안 횟수를 돌려준다.
 * 창이 없거나 시작한 지 windowMs 가 지났으면 지금부터 새 창을 연다.
 */
export async function countInWindow(key: string, now: number, windowMs: number): Promise<number> {
  const fresh = { $or: [{ $eq: [{ $type: "$windowStart" }, "missing"] }, { $lte: ["$windowStart", now - windowMs] }] };
  const updated = await (await collection<WindowDocument>(WINDOWS)).findOneAndUpdate(
    { _id: key },
    [
      {
        $set: {
          windowStart: { $cond: [fresh, now, "$windowStart"] },
          count: { $cond: [fresh, 1, { $add: ["$count", 1] }] },
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );
  if (updated === null) throw new Error(`결제 횟수 창을 기록하지 못했습니다: ${key}`);
  return updated.count;
}

/** 테스트가 연결을 정리할 때 쓴다. */
export async function closeReplayStore(): Promise<void> {
  const open = client;
  client = null;
  ready = null;
  await open?.close();
}
