import { notFound } from "next/navigation";

import { CandidateTables, PurchaseSummary } from "@/components/DecisionView";
import { getPurchase } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getPurchase(id);
  if (record === null) notFound();

  return (
    <>
      <h1>구매 상세</h1>
      <p className="muted">
        구매 번호 <code>{record.id}</code> · {new Date(record.createdAt).toLocaleString("ko-KR", { hour12: false })}
      </p>

      <h2>요청 내용</h2>
      <pre className="result">{record.prompt}</pre>

      <h2>요약</h2>
      <PurchaseSummary record={record} />
      <CandidateTables record={record} />
    </>
  );
}
