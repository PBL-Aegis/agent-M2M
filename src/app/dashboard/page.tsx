import Link from "next/link";

import { PurchaseTable } from "@/components/PurchaseTable";
import { aegisText } from "@/lib/format";
import { buyerBalance } from "@/lib/payment";
import { listPurchases } from "@/lib/store";

export const dynamic = "force-dynamic";

// 화면 구성은 PBL-aegis 감사 대시보드의 개요 화면(요약 칸 + 최근 기록)을 따른다.

/** 첫 화면 표에 보여줄 최근 기록 수. 나머지는 전체 기록 화면에서 본다. */
const RECENT_COUNT = 6;

export default async function DashboardPage() {
  const [records, balance] = await Promise.all([listPurchases(), buyerBalance()]);
  const settled = records.filter((record) => record.status === "SETTLED");
  const spentUnits = settled.reduce((sum, record) => sum + record.decision.winner.amountUnits, 0);

  return (
    <div className="auditMain">
      <section className="auditMetrics" aria-label="구매 요약">
        <article>
          <span>구매 에이전트 토큰 잔액</span>
          <strong>{balance.units === null ? "—" : aegisText(balance.units)}</strong>
          {balance.units === null && <small>{balance.status}</small>}
        </article>
        <article>
          <span>정산 완료 거래</span>
          <strong>{settled.length}</strong>
          <small>전체 요청 {records.length}건 중</small>
        </article>
        <article>
          <span>결제 금액 합계</span>
          <strong>{aegisText(spentUnits)}</strong>
          <small>정산 완료 거래 기준</small>
        </article>
      </section>

      <article className="panel">
        <div className="sectionHead">
          <div>
            <p className="eyebrow">RECENT TRANSACTIONS</p>
            <h2>최근 요청·결제 기록</h2>
          </div>
          <Link href="/dashboard/purchases">전체 기록 →</Link>
        </div>
        <PurchaseTable records={records.slice(0, RECENT_COUNT)} />
      </article>
    </div>
  );
}
