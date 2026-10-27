/**
 * 기록. 구매 한 건에 대해 요청·후보·점수·탈락 사유·금액·거래번호·결과를 남긴다.
 *
 * MongoDB 컬렉션 하나(purchases)에 저장한다. 화면은 DB에 직접 붙지 않고 이 모듈의 함수만 쓴다.
 * 구매 기록은 결제 직전에 PROCESSING 으로 저장하고, 끝나면 그 문서의 상태와 결과만 고친다.
 * 결정 근거(decision)는 처음 저장한 뒤로 고치지 않는다.
 *
 * 문서를 JSON 문자열로 뭉쳐 넣지 않고 그대로 넣는 이유는, 나중에 "같은 수신자에게 반복 결제",
 * "시간대별 묶기" 같은 질의를 DB에서 바로 돌리기 위해서다. 구매 번호를 `_id` 로 쓰므로
 * 같은 번호를 두 번 저장하려 하면 DB가 거부한다.
 *
 * 구매 때 새로 받아 온 벤치마크 스냅샷은 snapshots 컬렉션에 해시를 `_id` 로 쌓는다.
 * 결정 기록에는 해시만 남으므로, 그 해시로 "그때 본 숫자"를 다시 찾을 수 있다.
 *
 * 감사 규칙이 남긴 알림은 alerts 컬렉션에 덧붙인다.
 */

import { MongoClient, type Collection, type Db } from "mongodb";

import type { AuditAlert, BenchmarkSnapshot, PurchaseRecord } from "./types";

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.MONGODB_DB ?? "agent_m2m";
const COLLECTION = "purchases";
const SNAPSHOTS = "snapshots";
const ALERTS = "alerts";

/** `_id` 에 구매 번호가 들어간 저장 형태. */
type PurchaseDocument = Omit<PurchaseRecord, "id"> & { _id: string };

/** `_id` 에 스냅샷 해시가 들어간 저장 형태. */
type SnapshotDocument = { _id: string; capturedAt: string; snapshot: BenchmarkSnapshot };

/** `_id` 에 알림 번호가 들어간 저장 형태. */
type AlertDocument = Omit<AuditAlert, "id"> & { _id: string };

/** 결제가 끝난 뒤 바꿀 수 있는 칸. */
export type PurchaseOutcome = Pick<
  PurchaseRecord,
  "status" | "payment" | "resultText" | "failureReason" | "failureStage"
>;

let client: MongoClient | null = null;
let ready: Promise<Db> | null = null;

async function connect(): Promise<Db> {
  const connected = new MongoClient(URI);
  await connected.connect();
  client = connected;
  const db: Db = connected.db(DB_NAME);
  // 최근 순 조회가 기본이라 정렬 기준에 색인을 둔다.
  await db.collection<PurchaseDocument>(COLLECTION).createIndex({ createdAt: -1 });
  await db.collection<SnapshotDocument>(SNAPSHOTS).createIndex({ capturedAt: -1 });
  await db.collection<AlertDocument>(ALERTS).createIndex({ createdAt: -1 });
  return db;
}

async function purchases(): Promise<Collection<PurchaseDocument>> {
  ready ??= connect();
  return (await ready).collection<PurchaseDocument>(COLLECTION);
}

async function snapshots(): Promise<Collection<SnapshotDocument>> {
  ready ??= connect();
  return (await ready).collection<SnapshotDocument>(SNAPSHOTS);
}

async function alerts(): Promise<Collection<AlertDocument>> {
  ready ??= connect();
  return (await ready).collection<AlertDocument>(ALERTS);
}

function toRecord(document: PurchaseDocument): PurchaseRecord {
  const { _id, ...rest } = document;
  return { id: _id, ...rest };
}

export async function savePurchase(record: PurchaseRecord): Promise<void> {
  const { id, ...rest } = record;
  await (await purchases()).insertOne({ _id: id, ...rest });
}

/** 결제 결과를 기록에 적고 바꾼 시각을 돌려준다. 결정 근거는 건드리지 않는다. */
export async function updatePurchase(id: string, outcome: PurchaseOutcome): Promise<string> {
  const updatedAt = new Date().toISOString();
  const result = await (await purchases()).updateOne({ _id: id }, { $set: { ...outcome, updatedAt } });
  if (result.matchedCount === 0) throw new Error(`구매 기록이 없습니다: ${id}`);
  return updatedAt;
}

export async function saveAlert(alert: AuditAlert): Promise<void> {
  const { id, ...rest } = alert;
  await (await alerts()).insertOne({ _id: id, ...rest });
}

export async function listAlerts(limit = 50): Promise<AuditAlert[]> {
  const documents = await (await alerts()).find({}, { sort: { createdAt: -1, _id: -1 }, limit }).toArray();
  return documents.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
}

/** 구매 한 건에 달린 알림. 오래된 것부터. */
export async function listAlertsForPurchase(purchaseId: string): Promise<AuditAlert[]> {
  const documents = await (await alerts()).find({ purchaseId }, { sort: { createdAt: 1, _id: 1 } }).toArray();
  return documents.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
}

/** 전체 알림을 차단과 경고로 나눠 센다. blocked 칸이 없는 옛 알림은 경고로 센다. */
export async function countAlerts(): Promise<{ blocked: number; warnings: number }> {
  const collection = await alerts();
  const [blocked, total] = await Promise.all([
    collection.countDocuments({ blocked: true }),
    collection.countDocuments({}),
  ]);
  return { blocked, warnings: total - blocked };
}

/** 주어진 구매 번호 중 실제 기록이 있는 것. 요청 직후에 막힌 알림은 기록이 없어 링크를 달지 않는다. */
export async function existingPurchaseIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const documents = await (await purchases()).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  return new Set(documents.map((document) => document._id));
}

export async function listPurchases(limit = 50): Promise<PurchaseRecord[]> {
  const documents = await (await purchases())
    .find({}, { sort: { createdAt: -1, _id: -1 }, limit })
    .toArray();
  return documents.map(toRecord);
}

export async function getPurchase(id: string): Promise<PurchaseRecord | null> {
  const document = await (await purchases()).findOne({ _id: id });
  return document === null ? null : toRecord(document);
}

/** 같은 구매 번호로 결제가 두 번 일어나지 않게 하는 확인. */
export async function purchaseExists(id: string): Promise<boolean> {
  return (await (await purchases()).countDocuments({ _id: id }, { limit: 1 })) > 0;
}

/** 같은 해시가 이미 있으면 그대로 둔다(덧붙이기만). */
export async function saveSnapshot(hash: string, snapshot: BenchmarkSnapshot): Promise<void> {
  await (await snapshots()).updateOne(
    { _id: hash },
    { $setOnInsert: { capturedAt: snapshot.capturedAt, snapshot } },
    { upsert: true },
  );
}

/** 가장 최근에 받아 온 스냅샷. 아직 한 번도 받지 않았으면 null. */
export async function latestSnapshot(): Promise<{ snapshot: BenchmarkSnapshot; hash: string } | null> {
  const document = await (await snapshots()).findOne({}, { sort: { capturedAt: -1 } });
  return document === null ? null : { snapshot: document.snapshot, hash: document._id };
}

/** 테스트가 쓰고 버리는 데이터베이스를 지울 때 쓴다. 이름이 테스트용일 때만 지운다. */
export async function dropTestDatabase(): Promise<void> {
  if (!DB_NAME.startsWith("agent_m2m_test")) {
    throw new Error(`테스트 데이터베이스가 아닙니다: ${DB_NAME}`);
  }
  await purchases();
  await client?.db(DB_NAME).dropDatabase();
}

/** 테스트가 연결을 정리할 때 쓴다. 앱 실행 중에는 부르지 않는다. */
export async function closeStore(): Promise<void> {
  const open = client;
  client = null;
  ready = null;
  await open?.close();
}
